import { afterAll, describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { installDom, trackRoots, fakeClock, type FakeElement } from './mini-dom';
import { simulateOnPage } from './plan-on-page';

// D15 and D7 on the screens (the tax plan's screens.md), with no switch, since
// their flags' cleanup: a plan's one-offs and income count in the walk to its
// FI date, on Your path, Progress and Home alike, and a child's accounts are
// out of invested assets. Nothing says what either moved: the lines that did
// while the changes were new went with the flags. The walk's words name
// one-offs and income apart from a plan's life events, and the Timeline's say
// where each kind counts. Rendered as a person sees it (react-dom/client over
// test/mini-dom.ts); every request is answered here.

const dom = installDom();
const realFetch = globalThis.fetch;
afterAll(() => {
  globalThis.fetch = realFetch;
  dom.uninstall();
});

const React = await import('react');
const { act } = React;
for (const k of Object.keys(require.cache)) if (/react-dom[\\/](?:client\.js|cjs[\\/]react-dom-client\.)/.test(k)) delete require.cache[k];
const { createRoot } = trackRoots(require('react-dom/client') as typeof import('react-dom/client'));
const { default: PlanTab, FiCard } = await import('@/components/PlanTab');
const { TimelineCard } = await import('@/components/PlanTimeline');
const { default: FiProgressCard } = await import('@/components/FiProgressCard');
const { DEFAULT_PLAN } = await import('@/lib/fire/plan');
const { planOf } = await import('@/lib/fire/plan-v2');
const { planFigures } = await import('@/lib/fire/plan-figures');
const { wholeMoney } = await import('@/components/plan-text');
const { plannedAt } = await import('@/lib/fire/saved-plan');
const { resolveSaved } = await import('@/lib/fire/plan-figures');
const { IN_WALK } = await import('@/lib/fire/compile');
const { timelineProps } = await import('./plan-gen');
type PlanTabProps = import('@/components/PlanTab').PlanTabProps;
type FirePlan = import('@/lib/fire/plan').FirePlan;
type PlanFigures = import('@/lib/fire/plan-figures').PlanFigures;
type FirePlanV2 = import('@/lib/fire/plan-v2').FirePlanV2;

const ROOF = { id: 'roof', label: 'Roof', amount: 100_000, atAge: 45 };
const PLAN: FirePlan = { ...DEFAULT_PLAN, age: 40, targetAge: 55, spending: 40_000, savings: 30_000, assets: 300_000, expenses: [ROOF] };
const NONE = { spending: null, savings: null, assets: null };
const figures = (p: FirePlan, planInWalk: boolean) => planFigures(planOf(p), NONE, { count: { planInWalk } }) as PlanFigures;
const fiAt = (p: FirePlan, planInWalk: boolean) => Math.round(figures(p, planInWalk).view.fiAge as number);

/** The saved plan Progress compares with: the same, saved at 40 on Jan 1,
 *  2024, its roof at 42, and four years recorded since. */
const SAVED = { version: 1, plan: { ...PLAN, expenses: [{ ...ROOF, atAge: 42 }] }, savings: 30_000, currency: 'USD', inflation: 0.03, day: '2024-01-01', savedAt: '2024-01-01T12:00:00.000Z', rev: 'r1' };
const day = (date: string, total: number) => ({ date, total, counted: 1, missing: [], otherCurrencies: {}, unrated: [] });
const HISTORY = {
  currency: 'USD',
  saved_day: '2024-01-01',
  anchor: day('2024-01-01', 300_000),
  latest: day('2026-10-01', 420_000),
  months: [
    { date: '2024-01-31', total: 302_000 },
    { date: '2026-10-01', total: 420_000 },
  ],
  accounts: [{ account_id: 'brk', first: '2024-01-01', last: '2026-10-01', ended: null, label: null }],
  unreadable_days: [],
};

function serve(plan: FirePlan, saved: unknown = null) {
  (globalThis as { fetch: unknown }).fetch = async (url: string, init?: RequestInit) => {
    const key = `${init?.method ?? 'GET'} ${url.split('?')[0]}`;
    const answers: Record<string, [number, unknown]> = {
      'GET /api/plan-inputs': [200, { plan, currency: 'USD' }],
      'GET /api/allocation-settings': [200, { settings: null }],
      'GET /api/saved-plan': [200, { saved, problem: null }],
      'POST /api/invested-history': [200, HISTORY],
    };
    const [status, body] = answers[key] ?? [404, { error: 'not here' }];
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  };
}

const pass = fakeClock();
simulateOnPage();
const settle = (ms = 30) => pass(ms);
const classed = (within: FakeElement, cls: string) => within.findAll((e) => (e.getAttribute('class') ?? '').split(' ').includes(cls));

async function render(plan: FirePlan, props: Partial<PlanTabProps> = {}, saved: unknown = null) {
  serve(plan, saved);
  const all: PlanTabProps = {
    txns: [],
    txnsLoading: false,
    txnNotes: [],
    institutions: [],
    balancesAsOf: null,
    currency: 'USD',
    holdings: [],
    ...props,
  };
  const container = dom.document.createElement('div');
  dom.document.body.appendChild(container);
  const root = createRoot(container as unknown as Element);
  await act(async () => root.render(<PlanTab {...all} />));
  await settle();
  const hero = () => classed(container, 'plan-hero')[0];
  return {
    hero,
    /** The answer's notices: none says what a change moved. */
    notices: () => classed(hero(), 'notice').map((n) => n.textContent),
    howLine: () => classed(hero(), 'plan-answer-lines')[0]?.textContent ?? '',
    progress: () => container.findAll((e) => e.getAttribute('aria-labelledby') === 'plan-progress-title')[0],
    unmount: () => act(async () => root.unmount()),
  };
}

describe('Your path and Progress count one-offs and income (D15)', () => {
  test('the answer counts the one-off and its words say so, and nothing says what it moved', async () => {
    const [before, now] = [fiAt(PLAN, false), fiAt(PLAN, true)];
    expect(now).toBeGreaterThan(before);
    const tab = await render(PLAN);
    expect(tab.hero().textContent).toContain(`Around age ${now}`);
    expect(tab.howLine()).toContain('a year after inflation, with one-offs and income in their years.');
    expect(tab.notices()).toEqual([]);
    expect(tab.hero().textContent).not.toContain('Got it');
    await tab.unmount();
  });

  test('Progress’s line counts the saved plan’s one-off, and says nothing of it', async () => {
    const start = { day: HISTORY.anchor.date, total: HISTORY.anchor.total };
    const compared = HISTORY.months[HISTORY.months.length - 1].date;
    const counted = plannedAt(SAVED, start, compared, resolveSaved(SAVED, start, null, IN_WALK)) as number;
    const without = plannedAt(SAVED, start, compared) as number;
    expect(Math.round(counted)).toBeLessThan(Math.round(without));
    const tab = await render(PLAN, {}, SAVED);
    const card = tab.progress();
    expect(card.textContent).toContain(wholeMoney(counted, 'USD'));
    expect(card.textContent).not.toContain(wholeMoney(without, 'USD'));
    expect(classed(card, 'notice').map((n) => n.textContent)).toEqual([]);
    await tab.unmount();
  });
});

describe('a child’s accounts are out (D7)', () => {
  // 300,000 typed nowhere: the plan measures its assets, and a child's 200,000
  // is out.
  const MEASURED: FirePlan = { ...PLAN, assets: null, expenses: [] };
  const BROKER = { account_id: 'b', name: 'Brokerage', type: 'investment', subtype: 'brokerage', balance: 300_000, currency: 'USD' };
  const COLLEGE = { account_id: 'c', name: 'College', type: 'investment', subtype: '529', balance: 200_000, currency: 'USD' };
  const institutions = [{ name: 'Broker', item_id: 'i', accounts: [BROKER, COLLEGE] }] as unknown as PlanTabProps['institutions'];
  const fiWith = (assets: number) => Math.round((planFigures(planOf(MEASURED), { ...NONE, assets }, { count: IN_WALK }) as PlanFigures).view.fiAge as number);

  test('Your path’s answer leaves the 529 out, and nothing says what that moved', async () => {
    expect(fiWith(300_000)).toBeGreaterThan(fiWith(500_000));
    const v = await render(MEASURED, { institutions });
    expect(v.hero().textContent).toContain(`Around age ${fiWith(300_000)}`);
    expect(v.notices()).toEqual([]);
    await v.unmount();
  });

  test('Home’s FI line counts the same accounts as the Plan', async () => {
    serve(MEASURED);
    const container = dom.document.createElement('div');
    dom.document.body.appendChild(container);
    const root = createRoot(container as unknown as Element);
    const home = { txns: [], txnNotes: [], institutions, currency: 'USD', onOpenPlan: () => {} } as unknown as React.ComponentProps<typeof FiProgressCard>;
    await act(async () => root.render(<FiProgressCard {...home} />));
    await settle();
    expect(container.textContent).toContain(`${fiWith(300_000)}`);
    await act(async () => root.unmount());
  });
});

describe('the Timeline says where each kind counts', () => {
  const card = (p: FirePlan = PLAN) => {
    const html = renderToStaticMarkup(<TimelineCard {...timelineProps(planOf(p), NONE)} />);
    return html.replace(/<[^>]+>/g, ' ').replaceAll('&#x27;', "'").replace(/\s+/g, ' ');
  };

  test('one-offs and income count in the FI date until you reach it, and a one-off before Will it last? counts there only', () => {
    expect(card()).toContain('Your FI date counts costs, windfalls, changes in pay, work that starts before you stop and other money in, until you reach it. Will it last? counts costs, windfalls and income, from 55, where it starts.');
    expect(card()).toContain('Before 55, where Will it last? starts, so it counts in your FI date, not in Will it last?');
    expect(card()).toContain('Counts in your FI date');
    expect(card()).not.toContain('don’t count there yet');
  });

  test('with Will it last? not run, no row says where it has them', () => {
    const p = { ...PLAN, spending: null, expenses: [ROOF, { id: 'late', label: 'Late', amount: 1_000, atAge: 99 }] };
    expect(figures(p, true).engine).toEqual({ missing: 'spending' });
    const text = card(p);
    expect(text).toContain('Roof');
    expect(text).toContain('Late');
    expect(text).not.toContain('Not in the simulation');
    expect(text).not.toContain('After the plan ends');
  });

  test('a version 2 plan’s items of every kind are shown, not counted as more', () => {
    const f = figures(PLAN, true);
    const life = { ...f.plan.items[0], id: 'kid', kind: 'child' as const, label: 'A child', from: { anchor: { at: 'age' as const, age: 46 }, offset: 0 }, until: { years: 18 }, once: null, yearly: 15_000 };
    const html = renderToStaticMarkup(<TimelineCard {...timelineProps({ ...f.plan, items: [...f.plan.items, life] }, NONE)} />);
    expect(html).toContain('A child');
    expect(html).not.toContain('a newer version of Nya');
  });
});

describe('Home and Your path say one answer', () => {
  async function home(plan: FirePlan) {
    serve(plan);
    const container = dom.document.createElement('ul');
    dom.document.body.appendChild(container);
    const root = createRoot(container as unknown as Element);
    await act(async () => root.render(<FiProgressCard txns={[]} txnsLoading={false} txnNotes={[]} institutions={[]} currency="USD" onOpenPlan={() => {}} />));
    await settle();
    const title = classed(container, 'list-row-title')[0]?.textContent ?? '';
    await act(async () => root.unmount());
    return title;
  }

  test('a one-off at 45 moves Home’s FI line as it moves the Plan’s', async () => {
    const before = (n: number) => `${n} year${n === 1 ? '' : 's'} before you stop at 55`;
    expect(fiAt(PLAN, true)).not.toBe(fiAt(PLAN, false));
    expect(await home(PLAN)).toBe(`FI around age ${fiAt(PLAN, true)}, ${before(55 - fiAt(PLAN, true))}`);
  });

  test('a cost the walk can’t pay: no FI date, and why, in the Plan’s words', async () => {
    const big = { ...PLAN, expenses: [{ ...ROOF, amount: 900_000 }] };
    serve(big);
    const container = dom.document.createElement('ul');
    dom.document.body.appendChild(container);
    const root = createRoot(container as unknown as Element);
    await act(async () => root.render(<FiProgressCard txns={[]} txnsLoading={false} txnNotes={[]} institutions={[]} currency="USD" onOpenPlan={() => {}} />));
    await settle();
    expect(classed(container, 'list-row-title')[0]?.textContent).toBe('No FI date');
    expect(container.textContent).toContain('less than the $900,000 it takes from your investments, so there is no FI date');
    await act(async () => root.unmount());
  });
});

describe('the answer’s words', () => {
  const money = (n: number) => wholeMoney(n, 'USD');
  const ASSETS = { total: 300_000, accounts: [], unknown: 0, caveats: [], currency: 'USD', leftOut: [] };
  const answer = (f: PlanFigures, walkFrom?: { items: boolean; events: boolean }) =>
    renderToStaticMarkup(
      <FiCard plan={f.plan} view={f.view} walked={f.walked} walkedSavings={f.walkedSavings} walkFrom={walkFrom} stopWalked={f.walked} unread={[]} assets={ASSETS} currencyNote={null} money={money} />
    )
      .replace(/<[^>]+>/g, ' ')
      .replaceAll('&#x27;', "'")
      .replace(/\s+/g, ' ');

  test('the walk names one-offs and income apart from a plan’s other items, both joined when both', () => {
    const f = figures(PLAN, true);
    expect(answer(f, { items: true, events: false })).toContain('Growing a steady 5% a year after inflation, with one-offs and income in their years.');
    expect(answer(f, { items: true, events: false })).toContain('with one-offs and income in the years they cover.');
    // A plan's other items alone.
    expect(answer(f, { items: false, events: true })).toContain('Growing a steady 5% a year after inflation, with this plan’s items changing what is saved in their years.');
    expect(answer(f, { items: false, events: true })).toContain('with this plan’s items in the years they cover.');
    expect(answer(f, { items: true, events: true })).toContain('Growing a steady 5% a year after inflation, with one-offs, income and this plan’s items in their years.');
  });

  const v2 = (over: Partial<FirePlanV2>) => planFigures({ ...planOf(PLAN), ...over }, NONE, { count: IN_WALK }) as PlanFigures;

  test('stop when I reach FI: one answer for both, or not by 95', () => {
    const f = v2({ stopAtFi: true, targetAge: null });
    expect(f.view.fiAge).not.toBeNull();
    expect(answer(f)).toContain(`Financial independence FI and your stop: around ${Math.round(f.view.fiAge as number)}`);
    const never = v2({ stopAtFi: true, targetAge: null, savings: 0, assets: 1_000, spending: 90_000, items: [] });
    expect(answer(never)).toContain('Financial independence Not by 95');
    // With the roof it can't pay, no date, and why (fiShort), as without the search.
    const short = v2({ stopAtFi: true, targetAge: null, savings: 0, assets: 1_000, spending: 90_000 });
    expect(short.short).not.toBeNull();
    expect([short.view.fiAge, short.view.yearsToFi]).toEqual([null, null]);
  });

  test('your own FI number is the one it reads, the worked-out one beside it, and Barista FI is said not shown', () => {
    const f = v2({ fiNumber: 1_500_000, partTimeIncome: 20_000 });
    expect(f.view.fiNumber).toBe(1_500_000);
    const t = answer(f);
    expect(t).toContain('Your own FI number $1,500,000 · worked out $1,000,000');
    expect(t).toContain('Barista FI Not shown');
    expect(t).toContain('Worked out from your spending, it could sit above your own FI number, so it isn’t shown while you have one.');
  });

  test('Home says the same under stop when I reach FI', async () => {
    const stored = { ...planOf(PLAN), stopAtFi: true, targetAge: null };
    const at = Math.round(v2({ stopAtFi: true, targetAge: null }).view.fiAge as number);
    serve(stored as never);
    const container = dom.document.createElement('ul');
    dom.document.body.appendChild(container);
    const root = createRoot(container as unknown as Element);
    await act(async () => root.render(<FiProgressCard txns={[]} txnsLoading={false} txnNotes={[]} institutions={[]} currency="USD" onOpenPlan={() => {}} />));
    await settle();
    expect(classed(container, 'list-row-title')[0]?.textContent).toBe(`FI and your stop around ${at}`);
    await act(async () => root.unmount());
  });
});
