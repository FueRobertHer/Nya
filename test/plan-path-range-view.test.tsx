import { afterAll, describe, expect, test } from 'bun:test';
import { installDom, trackRoots, click, type, fakeClock, FakeElement } from './mini-dom';
import { simulateOnPage } from './plan-on-page';

// Your path's range (the tax plan's P, D13), rendered in the Plan tab and used
// as a person would (react-dom/client over test/mini-dom.ts): the chart opens
// on Whole path, its switch names the person's own stop age and follows it as
// it changes, the range shown is kept while the tab is drawn again and, handed
// in by the dashboard, across a remount; a copy's stop age names it in the
// copy; once the stop has come there is no switch; and with amounts
// hidden, the chart's summary and Drawdown's start line are masked. Every
// request is answered here, by path; nothing reaches a network.
//
// A rendered element never goes into toEqual or another matcher that diffs
// (test/plan-tab-copies.test.tsx says why).

const dom = installDom();
const realFetch = globalThis.fetch;
afterAll(() => {
  globalThis.fetch = realFetch;
  dom.uninstall();
});

const React = await import('react');
const { act } = React;
// React's client reads what the document supports once, when it loads: it is
// loaded afresh, after this file put a document there.
for (const k of Object.keys(require.cache)) if (/react-dom[\\/](?:client\.js|cjs[\\/]react-dom-client\.)/.test(k)) delete require.cache[k];
const { createRoot } = trackRoots(require('react-dom/client') as typeof import('react-dom/client'));
const { default: PlanTab } = await import('@/components/PlanTab');
const { planPanelId } = await import('@/components/PlanBar');
const { DEFAULT_PLAN } = await import('@/lib/fire/plan');
const { setAmountsHidden, MASK } = await import('@/lib/format');
type PlanTabProps = import('@/components/PlanTab').PlanTabProps;
type PathRange = import('@/lib/fire/path').PathRange;
const { plansListing, copyRow } = await import('./plans-listing');

// FI around 52, a stop at 62 (the person's own, not the mock's 50), and the
// plan to 95.
const PLAN = { ...DEFAULT_PLAN, age: 40, targetAge: 62, spending: 40_000, savings: 30_000, assets: 300_000 };

type Call = { method: string; url: string; body: any };
type Answer = (call: Call) => [number, unknown];

/** Answers by "METHOD /path"; records every call. */
function serve(answers: Record<string, Answer | [number, unknown]>) {
  const calls: Call[] = [];
  (globalThis as any).fetch = async (url: string, init?: RequestInit) => {
    const call = { method: init?.method ?? 'GET', url, body: init?.body ? JSON.parse(String(init.body)) : null };
    calls.push(call);
    const a = answers[`${call.method} ${url}`];
    const [status, body] = typeof a === 'function' ? a(call) : (a ?? [404, { error: 'not here' }]);
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  };
  return calls;
}

/** The plan as saved, saved back as the Household sheet sends it. */
const saved = (plan: Record<string, unknown> = PLAN): Record<string, Answer> => {
  let current: unknown = plan;
  return {
    'GET /api/plan-inputs': () => [200, { plan: current, currency: 'USD' }],
    'PUT /api/fire-plan': (c) => {
      current = c.body.plan;
      return [200, { plan: current, currency: 'USD' }];
    },
  };
};
const pass = fakeClock();
simulateOnPage();
const settle = (ms = 30) => pass(ms);
const classOf = (e: FakeElement) => (e.getAttribute('class') ?? '').split(' ');

async function render(answers: Record<string, Answer | [number, unknown]>, over: Partial<PlanTabProps> = {}) {
  const calls = serve({ ...saved(), 'GET /api/allocation-settings': [200, { settings: null }], 'GET /api/plans': plansListing(PLAN), ...answers });
  const container = dom.document.createElement('div');
  dom.document.body.appendChild(container);
  const root = createRoot(container as unknown as Element);
  const props: PlanTabProps = { txns: [], txnsLoading: false, txnNotes: [], institutions: [], balancesAsOf: null, currency: 'USD', holdings: [], ...over };
  await act(async () => root.render(<PlanTab {...props} />));
  await settle();
  const find = (pred: (e: FakeElement) => boolean) => container.findAll(pred)[0] ?? null;
  const panel = (s: 'path' | 'drawdown') => find((e) => e.getAttribute('id') === planPanelId(s))!;
  const svg = () => panel('path').findAll((e) => e.tagName === 'svg' && classOf(e).includes('chart-svg'))[0] ?? null;
  const radios = () => panel('path').findAll((e) => e.getAttribute('role') === 'radio' && classOf(e.parentNode as FakeElement).includes('chart-range-switch'));
  return {
    calls,
    container,
    rerender: (more: Partial<PlanTabProps>) => act(async () => root.render(<PlanTab {...props} {...more} />)),
    unmount: () => act(async () => root.unmount()),
    panel,
    tab: (label: string) => find((e) => e.getAttribute('role') === 'tab' && e.textContent === label),
    /** The switch's options, each with whether it is the one shown. */
    options: () => radios().map((r) => [r.textContent, r.getAttribute('aria-checked')]),
    option: (label: string) => radios().find((r) => r.textContent === label) ?? null,
    /** The chart's ages along its foot, left to right as drawn. */
    ages: () => svg()?.findAll((e) => classOf(e).includes('chart-xlabel')).map((t) => t.textContent) ?? [],
    summary: () => svg()?.getAttribute('aria-label') ?? null,
    /** The lines under the chart. */
    under: () => panel('path').findAll((e) => classOf(e).includes('as-of')).map((e) => e.textContent),
    /** A list row by its title: one of Your figures, or the Plans sheet's. */
    row: (name: string) => find((e) => e.tagName === 'BUTTON' && classOf(e).includes('list-row') && e.findAll((t) => classOf(t).includes('list-row-title'))[0]?.textContent === name),
    dialog: () => find((e) => e.getAttribute('role') === 'dialog' && e.getAttribute('data-open') === 'true'),
    bar: () => find((e) => e.getAttribute('class') === 'plan-bar'),
    notices: (s: 'path' | 'drawdown') => panel(s).findAll((e) => classOf(e).includes('notice')).map((e) => e.textContent),
  };
}
type Tab = Awaited<ReturnType<typeof render>>;

const press = async (el: FakeElement | null) => {
  if (!el) throw new Error('nothing to press');
  await act(async () => click(el));
  await settle();
};
const button = (within: FakeElement, words: string) => within.findAll((e) => e.tagName === 'BUTTON' && e.textContent.trim() === words)[0] ?? null;

/** Types the stop age in the Household sheet and saves it. */
const saveStop = async (tab: Tab, stop: number) => {
  await press(tab.row('Household'));
  const form = tab.dialog()!;
  expect(form.getAttribute('aria-label')).toBe('Household');
  const [, target] = form.findAll((e) => e.tagName === 'INPUT');
  await act(async () => type(target, String(stop)));
  await press(button(form, 'Save'));
  await settle(400);
};

describe('Your path’s range', () => {
  test('opens on Whole path, to the plan’s end; To 62 is the saving years, and back', async () => {
    const tab = await render({});
    expect(tab.options()).toEqual([
      ['To 62', 'false'],
      ['Whole path', 'true'],
    ]);
    expect(tab.ages()).toEqual(['40', '52', 'stop 62', '95']);
    expect(tab.summary()).toContain(' at 62, then, drawing your spending, about $');
    expect(tab.summary()).toContain(' at 95, at a steady 5% a year after inflation.');
    await press(tab.option('To 62'));
    expect(tab.options()).toEqual([
      ['To 62', 'true'],
      ['Whole path', 'false'],
    ]);
    expect(tab.ages()).not.toContain('95');
    expect(tab.ages().at(-1)).toBe('stop 62');
    expect(tab.summary()).not.toContain('then, drawing your spending');
    await press(tab.option('Whole path'));
    expect(tab.ages().at(-1)).toBe('95');
    await tab.unmount();
  });

  test('a new stop age renames its option, and the range shown stays', async () => {
    const tab = await render({});
    await press(tab.option('To 62'));
    await saveStop(tab, 58);
    expect(tab.options()).toEqual([
      ['To 58', 'true'],
      ['Whole path', 'false'],
    ]);
    expect(tab.ages().at(-1)).toBe('stop 58');
    await press(tab.option('Whole path'));
    await saveStop(tab, 65);
    expect(tab.options()).toEqual([
      ['To 65', 'false'],
      ['Whole path', 'true'],
    ]);
    expect(tab.ages()).toContain('stop 65');
    await tab.unmount();
  });

  test('handed in by the dashboard, the range shown is the dashboard’s, kept across a remount', async () => {
    let range: PathRange = 'whole';
    const ranges: PathRange[] = [];
    const onRange = (r: PathRange) => {
      ranges.push(r);
      range = r;
    };
    const first = await render({}, { range, onRange });
    await press(first.option('To 62'));
    expect(ranges).toEqual(['stop']);
    // Shown as the dashboard has it, once the dashboard draws it again.
    expect(first.options()[0]).toEqual(['To 62', 'false']);
    await first.rerender({ range, onRange });
    expect(first.options()[0]).toEqual(['To 62', 'true']);
    await first.unmount();
    // Another tab and back: the Plan tab is mounted again with the same range.
    const again = await render({}, { range, onRange });
    expect(again.options()).toEqual([
      ['To 62', 'true'],
      ['Whole path', 'false'],
    ]);
    expect(again.ages().at(-1)).toBe('stop 62');
    await again.unmount();
  });

  test('in a copy with its own stop age, the option names that one, and the range shown stays', async () => {
    const tab = await render({ 'GET /api/plans': plansListing(PLAN, [copyRow(PLAN, 'c1', 'Stop at 58', { targetAge: 58 })]) });
    await press(tab.option('To 62'));
    await press(button(tab.container, 'Plans (2)'));
    await press(tab.row('Stop at 58'));
    await press(tab.row('Open it'));
    expect(tab.bar()?.textContent).toContain('Copy: Stop at 58');
    expect(tab.options()).toEqual([
      ['To 58', 'true'],
      ['Whole path', 'false'],
    ]);
    await press(tab.option('Whole path'));
    expect(tab.ages()).toContain('stop 58');
    expect(tab.ages().at(-1)).toBe('95');
    await tab.unmount();
  });

  // A saved stop age is never before your age (lib/fire/plan.ts): the stop
  // today is how it has come.
  test('once the stop has come, the drawdown from today, with no switch', async () => {
    const tab = await render(saved({ ...PLAN, age: 62, assets: 1_200_000 }));
    expect(tab.options()).toEqual([]);
    expect(tab.ages()).toEqual(['62', '95']);
    expect(tab.summary()).toStartWith('Invested assets go from $1,200,000 at 62, drawing your spending, to about $');
    await tab.unmount();
  });

  test('with amounts hidden, the chart’s summary and Drawdown’s start line are masked', async () => {
    const shown = await render({});
    await press(shown.tab('Drawdown'));
    const line = shown.notices('drawdown').find((t) => t.startsWith('Note: Starting from your FI number'))!;
    expect(line).toMatch(/^Note: Starting from your FI number, \$[\d,]+, not the \$[\d,]+ you’d have at 62\.Start from what you'd have at 62$/);
    await shown.unmount();
    setAmountsHidden(true);
    try {
      const tab = await render({});
      const summary = tab.summary()!;
      expect(summary).toContain('at 95');
      expect(summary).not.toMatch(/\d{3},\d{3}/);
      await press(tab.tab('Drawdown'));
      const hidden = tab.notices('drawdown').find((t) => t.startsWith('Note: Starting from your FI number'))!;
      // As drawn, then as read aloud (Masked).
      expect(hidden).toBe(`Note: Starting from your FI number, $${MASK}, not the $${MASK} you’d have at 62.Starting from your FI number, hidden, not the hidden you’d have at 62.Start from what you'd have at 62`);
      await tab.unmount();
    } finally {
      setAmountsHidden(false);
    }
  });
});
