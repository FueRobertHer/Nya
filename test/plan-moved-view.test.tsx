import { afterAll, describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { installDom, trackRoots, click, fakeClock, type FakeElement } from './mini-dom';
import { simulateOnPage } from './plan-on-page';

// D15 on the screens (the tax plan's screens.md): with the switch on (the
// flag 'plan-items-in-fi'), a plan's one-offs and income count in the walk
// to its FI date, on Your path and Home alike. While the change is new
// (lib/flag-read.ts newUntil) Your path's answer says what it moved, and
// Progress what its line now counts, until Got it, which hides both for the
// session (the dashboard keeps it). The walk's words name one-offs and
// income apart from a plan's life events, and the Timeline's words follow
// the switch. Rendered as a person sees it
// (react-dom/client over test/mini-dom.ts); every request is answered here.

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
const { childMovedText } = await import('@/components/plan-moved');
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
const FAR = '9999-12-31';
const PAST = '2000-01-01';

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
    const key = `${init?.method ?? 'GET'} ${url}`;
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
  const seen: string[] = [];
  const all: PlanTabProps = {
    txns: [],
    txnsLoading: false,
    txnNotes: [],
    institutions: [],
    balancesAsOf: null,
    currency: 'USD',
    holdings: [],
    planInWalk: true,
    newUntil: FAR,
    onMovedSeen: () => seen.push('seen'),
    ...props,
  };
  const container = dom.document.createElement('div');
  dom.document.body.appendChild(container);
  const root = createRoot(container as unknown as Element);
  await act(async () => root.render(<PlanTab {...all} />));
  await settle();
  const hero = () => classed(container, 'plan-hero')[0];
  return {
    seen,
    hero,
    /** The answer's information line, D15's, or null. */
    moved: () => classed(hero(), 'notice').map((n) => n.textContent)[0] ?? null,
    howLine: () => classed(hero(), 'plan-answer-lines')[0]?.textContent ?? '',
    progress: () => container.findAll((e) => e.getAttribute('aria-labelledby') === 'plan-progress-title')[0],
    gotIt: async (within: FakeElement) => {
      const b = within.findAll((e) => e.tagName === 'BUTTON' && e.textContent.trim() === 'Got it')[0];
      if (!b) throw new Error('no Got it');
      expect(b.getAttribute('class')).toBe('btn ghost');
      await act(async () => click(b));
      await settle();
    },
    rerender: async (more: Partial<PlanTabProps>) => {
      await act(async () => root.render(<PlanTab {...all} {...more} />));
      await settle();
    },
    unmount: () => act(async () => root.unmount()),
  };
}

describe('Your path while D15 is new', () => {
  test('the answer says what moved it and names the one-off; Got it is said to the dashboard, which hides it', async () => {
    const [off, on] = [fiAt(PLAN, false), fiAt(PLAN, true)];
    expect(on).toBeGreaterThan(off);
    const tab = await render(PLAN);
    expect(tab.hero().textContent).toContain(`Around age ${on}`);
    expect(tab.moved()).toBe(`Note: Your FI date moved from ${off} to ${on}: Roof at 45 now counts in it.Got it`);
    // The walk's words name what moved it.
    expect(tab.howLine()).toContain('a year after inflation, with one-offs and income in their years.');
    await tab.gotIt(tab.hero());
    expect(tab.seen).toEqual(['seen']);
    await tab.rerender({ movedSeen: true });
    expect(tab.moved()).toBeNull();
    expect(tab.hero().textContent).toContain(`Around age ${on}`);
    await tab.unmount();
  });

  test('not after it is new, nor with the switch off, nor where nothing moved', async () => {
    const tab = await render(PLAN, { newUntil: PAST });
    expect(tab.moved()).toBeNull();
    expect(tab.hero().textContent).toContain(`Around age ${fiAt(PLAN, true)}`);
    // Off: the answer and its words are today's.
    await tab.rerender({ planInWalk: false, newUntil: FAR });
    expect(tab.moved()).toBeNull();
    expect(tab.hero().textContent).toContain(`Around age ${fiAt(PLAN, false)}`);
    expect(tab.howLine()).not.toContain('one-offs');
    await tab.unmount();
    // A roof after FI changes nothing before it.
    const late = { ...PLAN, expenses: [{ ...ROOF, atAge: 70 }] };
    expect(fiAt(late, true)).toBe(fiAt(late, false));
    const quiet = await render(late);
    expect(quiet.moved()).toBeNull();
    await quiet.unmount();
  });

  test('two or more are named two at a time, then how many more', async () => {
    const many = { ...PLAN, expenses: [ROOF, { id: 'car', label: 'Car', amount: 40_000, atAge: 43 }, { id: 'boat', label: 'Boat', amount: 30_000, atAge: 44 }] };
    const tab = await render(many);
    expect(tab.moved()).toBe(`Note: Your FI date moved from ${fiAt(many, false)} to ${fiAt(many, true)}: Roof at 45, Car at 43 and 1 more now count in it.Got it`);
    await tab.unmount();
  });

  test('Progress says what its line now counts, under its first line, and Got it hides both', async () => {
    const tab = await render(PLAN, {}, SAVED);
    const card = tab.progress();
    const lines = card.findAll((e) => e.tagName === 'P' || (e.getAttribute('class') ?? '').split(' ').includes('notice')).map((e) => e.textContent);
    expect(lines.slice(0, 2)).toEqual(['Your plan from Jan 1, 2024.', 'Note: Your saved plan’s line now counts Roof at 42.Got it']);
    expect(tab.moved()).not.toBeNull();
    await tab.gotIt(card);
    expect(tab.seen).toEqual(['seen']);
    await tab.rerender({ movedSeen: true });
    expect(classed(tab.progress(), 'notice').map((n) => n.textContent)).toEqual([]);
    expect(tab.moved()).toBeNull();
    // Off, the line is today's and says nothing.
    await tab.rerender({ movedSeen: false, planInWalk: false });
    expect(classed(tab.progress(), 'notice').map((n) => n.textContent)).toEqual([]);
    await tab.unmount();
  });
});

describe('Your path while D7 is new', () => {
  // 300,000 typed nowhere: the plan measures its assets, and a child's 200,000
  // is out with the switch on.
  const MEASURED: FirePlan = { ...PLAN, assets: null, expenses: [] };
  const BROKER = { account_id: 'b', name: 'Brokerage', type: 'investment', subtype: 'brokerage', balance: 300_000, currency: 'USD' };
  const COLLEGE = { account_id: 'c', name: 'College', type: 'investment', subtype: '529', balance: 200_000, currency: 'USD' };
  const institutions = [{ name: 'Broker', item_id: 'i', accounts: [BROKER, COLLEGE] }] as unknown as PlanTabProps['institutions'];
  const seenChild: string[] = [];
  const child = { institutions, planInWalk: false, newUntil: null, childOut: true, childNewUntil: FAR, onChildMovedSeen: () => seenChild.push('seen') };
  const expected = () => {
    const figures = (assets: number) => planFigures(planOf(MEASURED), { ...NONE, assets }, { count: { planInWalk: false } }) as PlanFigures;
    return { off: Math.round(figures(500_000).view.fiAge as number), on: Math.round(figures(300_000).view.fiAge as number) };
  };

  test('says what leaving them out moved, ages only, and its Got it is its own', async () => {
    const { off, on } = expected();
    expect(on).toBeGreaterThan(off);
    const v = await render(MEASURED, child);
    expect(v.moved()).toContain(`Your FI date moved from ${off} to ${on}: accounts for a child\u2019s education are now left out.`);
    expect(v.moved()).not.toContain('$');
    seenChild.length = 0;
    await v.gotIt(v.hero());
    expect(seenChild).toEqual(['seen']);
    expect(v.seen).toEqual([]);
    await v.rerender({ childMovedSeen: true });
    expect(v.moved()).toBeNull();
    await v.unmount();
  });

  test('not after it is new, nor with the switch off, nor where nothing moved or nothing is out', async () => {
    for (const props of [{ childNewUntil: PAST }, { childOut: false }, { childNewUntil: null }]) {
      const v = await render(MEASURED, { ...child, ...props });
      expect(v.moved()).toBeNull();
      await v.unmount();
    }
    // Your own assets typed: nothing moved.
    const typed = await render({ ...MEASURED, assets: 300_000 }, child);
    expect(typed.moved()).toBeNull();
    await typed.unmount();
    // No child's account held.
    const none = await render(MEASURED, { ...child, institutions: [{ name: 'Broker', item_id: 'i', accounts: [BROKER] }] as unknown as PlanTabProps['institutions'] });
    expect(none.moved()).toBeNull();
    await none.unmount();
  });

  test('the other two forms, by the figures', () => {
    const at = (fiAge: number | null) => ({ view: { fiAge } }) as unknown as PlanFigures;
    expect(childMovedText(at(53.2), at(53.4))).toBeNull();
    expect(childMovedText(at(53), at(54))).toBe('Your FI date moved from 53 to 54: accounts for a child\u2019s education are now left out.');
    expect(childMovedText(at(53), at(null))).toBe('Your FI date was around 53 before accounts for a child\u2019s education were left out.');
    expect(childMovedText(at(null), at(60))).toBe('Your FI date is around 60 now that accounts for a child\u2019s education are left out.');
    expect(childMovedText(at(null), at(null))).toBeNull();
  });

  test('Home’s FI line counts the same accounts as the Plan', async () => {
    serve(MEASURED);
    const container = dom.document.createElement('div');
    dom.document.body.appendChild(container);
    const root = createRoot(container as unknown as Element);
    const home = { txns: [], txnNotes: [], institutions, currency: 'USD', onOpenPlan: () => {} } as unknown as React.ComponentProps<typeof FiProgressCard>;
    await act(async () => root.render(<FiProgressCard {...home} childOut />));
    await settle();
    expect(container.textContent).toContain(`${expected().on}`);
    await act(async () => root.unmount());
  });
});

describe('the Timeline follows the switch', () => {
  const card = (planInWalk: boolean, p: FirePlan = PLAN) => {
    const html = renderToStaticMarkup(<TimelineCard {...timelineProps(planOf(p), NONE, { planInWalk })} />);
    return html.replace(/<[^>]+>/g, ' ').replaceAll('&#x27;', "'").replace(/\s+/g, ' ');
  };

  test('on: one-offs and income count in the FI date until you reach it, and a one-off before Will it last? counts there only', () => {
    expect(card(true)).toContain('In your FI date: costs, windfalls, changes in pay, work that starts before you stop, and other money in, until you reach it. In Will it last?: costs, windfalls and income, from 55, where it starts.');
    expect(card(true)).toContain('Before 55, where Will it last? starts, so it counts in your FI date, not in Will it last?');
    expect(card(true)).toContain('Counts in your FI date');
  });

  test('off: a cost and income don’t count there yet, and the row says so by not saying it', () => {
    expect(card(false)).toContain('a cost and income don’t count there yet. In Will it last?: costs, windfalls and income, from 55, where it starts.');
    expect(card(false)).toContain('Before 55, where Will it last? starts, so it isn’t counted anywhere.');
    expect(card(false)).not.toContain('Counts in your FI date');
  });

  test('with Will it last? not run, no row says where it has them', () => {
    const p = { ...PLAN, spending: null, expenses: [ROOF, { id: 'late', label: 'Late', amount: 1_000, atAge: 99 }] };
    for (const on of [true, false]) {
      expect(figures(p, on).engine).toEqual({ missing: 'spending' });
      const text = card(on, p);
      expect(text).toContain('Roof');
      expect(text).toContain('Late');
      expect(text).not.toContain('Not in the simulation');
      expect(text).not.toContain('After the plan ends');
    }
  });

  test('a version 2 plan’s items of every kind are shown, not counted as more', () => {
    const f = figures(PLAN, true);
    const life = { ...f.plan.items[0], id: 'kid', kind: 'child' as const, label: 'A child', from: { anchor: { at: 'age' as const, age: 46 }, offset: 0 }, until: { years: 18 }, once: null, yearly: 15_000 };
    const html = renderToStaticMarkup(<TimelineCard {...timelineProps({ ...f.plan, items: [...f.plan.items, life] }, NONE, { planInWalk: true })} />);
    expect(html).toContain('A child');
    expect(html).not.toContain('a newer version of Nya');
  });
});

describe('Home and Your path say one answer', () => {
  async function home(plan: FirePlan, planInWalk: boolean) {
    serve(plan);
    const container = dom.document.createElement('ul');
    dom.document.body.appendChild(container);
    const root = createRoot(container as unknown as Element);
    await act(async () => root.render(<FiProgressCard txns={[]} txnsLoading={false} txnNotes={[]} institutions={[]} currency="USD" onOpenPlan={() => {}} planInWalk={planInWalk} />));
    await settle();
    const title = classed(container, 'list-row-title')[0]?.textContent ?? '';
    await act(async () => root.unmount());
    return title;
  }

  test('a one-off at 45 moves Home’s FI line as it moves the Plan’s, with the switch on, and not off', async () => {
    const before = (n: number) => `${n} year${n === 1 ? '' : 's'} before you stop at 55`;
    expect(await home(PLAN, true)).toBe(`FI around age ${fiAt(PLAN, true)}, ${before(55 - fiAt(PLAN, true))}`);
    expect(await home(PLAN, false)).toBe(`FI around age ${fiAt(PLAN, false)}, ${before(55 - fiAt(PLAN, false))}`);
  });

  test('a cost the walk can’t pay: no FI date, and why, in the Plan’s words', async () => {
    const big = { ...PLAN, expenses: [{ ...ROOF, amount: 900_000 }] };
    serve(big);
    const container = dom.document.createElement('ul');
    dom.document.body.appendChild(container);
    const root = createRoot(container as unknown as Element);
    await act(async () => root.render(<FiProgressCard txns={[]} txnsLoading={false} txnNotes={[]} institutions={[]} currency="USD" onOpenPlan={() => {}} planInWalk />));
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

  const v2 = (over: Partial<FirePlanV2>) => planFigures({ ...planOf(PLAN), ...over }, NONE, { count: { planInWalk: true } }) as PlanFigures;

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
    await act(async () => root.render(<FiProgressCard txns={[]} txnsLoading={false} txnNotes={[]} institutions={[]} currency="USD" onOpenPlan={() => {}} planInWalk />));
    await settle();
    expect(classed(container, 'list-row-title')[0]?.textContent).toBe(`FI and your stop around ${at}`);
    await act(async () => root.unmount());
  });
});
