import { afterAll, describe, expect, test } from 'bun:test';
import { installDom, trackRoots, fakeClock, type FakeElement } from './mini-dom';
import { simulateOnPage } from './plan-on-page';

// What a bank paid into a 529 leaves Annual savings on the screens, as a person
// sees it (react-dom/client over test/mini-dom.ts): the Plan's row and its Why, and
// Home's line, which waits for the account's row rather than move a moment later.
// With the flag off nothing more is asked for and nothing moves. Every request is
// answered here, by path.

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
const { default: PlanTab } = await import('@/components/PlanTab');
const { default: FiProgressCard } = await import('@/components/FiProgressCard');
const { createPlanInputsStore } = await import('@/lib/plan-inputs-store');
const { DEFAULT_PLAN } = await import('@/lib/fire/plan');
const { DEFAULT_TAX_FACTS } = await import('@/lib/fire/tax-facts');
const { localDate } = await import('@/lib/local-date');
const { planOf } = await import('@/lib/fire/plan-v2');
const { planFigures } = await import('@/lib/fire/plan-figures');
type PlanFigures = import('@/lib/fire/plan-figures').PlanFigures;
type PlanTabProps = import('@/components/PlanTab').PlanTabProps;
type Txn = import('@/components/MonthBreakdown').Txn;

const pass = fakeClock();
simulateOnPage();
const settle = (ms = 30) => pass(ms);

const daysAgo = (n: number) => {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return localDate(d);
};
let made = 0;
const txn = (over: Partial<Txn>): Txn => ({ transaction_id: `t${++made}`, date: daysAgo(10), name: 'Shop', amount: 100, pending: false, account_name: 'Checking', institution_name: 'Bank', category: 'food and drink', ...over }) as Txn;

// A whole year: $5,000 earned and $2,950 spent each month, $24,600 saved, with
// $250 of it sent to the 529 each month and $3,000 in all.
const PAID = Array.from({ length: 12 }, (_, m) => daysAgo(34 + m * 30));
const YEAR: Txn[] = [
  txn({ date: daysAgo(364), amount: 1 }),
  ...PAID.flatMap((date) => [
    txn({ date, amount: 2_950 }),
    txn({ date, amount: -5_000, name: 'Payroll', category: 'income' }),
    txn({ date, amount: 250, name: 'SCHOLARSHARE 529', category: 'transfer out', subcategory: 'account transfer' }),
  ]),
];

const PLAN = { ...DEFAULT_PLAN, age: 40, targetAge: 55 };
const BROKER = { account_id: 'b', name: 'Brokerage', type: 'investment', subtype: 'brokerage', balance: 300_000, currency: 'USD' };
const COLLEGE = { account_id: 'c', name: 'College', type: 'investment', subtype: '529', balance: 40_000, currency: 'USD' };
const institutions = [{ name: 'Ascensus', item_id: 'i', error: false, staleAsOf: null, staleAsOfAt: null, missing: 0, accounts: [BROKER, COLLEGE] }] as unknown as PlanTabProps['institutions'];
const ROW = { id: 'i:c', contributions_12m: 3_000, contributions_12m_from: daysAgo(364), contributions_12m_partial: false, contributions_12m_rows: PAID.map((date) => ({ date, amount: 250 })), dividends_12m: 0 };

/** Answers the Plan's requests, and records what it asked of /api/plan-inputs. */
function serve(opts: { row?: Record<string, unknown>; facts?: unknown } = {}) {
  const asked: string[] = [];
  const row = opts.row ?? ROW;
  (globalThis as { fetch: unknown }).fetch = async (url: string, init?: RequestInit) => {
    const [path, query = ''] = url.split('?');
    if (path === '/api/plan-inputs') asked.push(query);
    const wanted = new URLSearchParams(query).getAll('plan');
    const answers: Record<string, [number, unknown]> = {
      'GET /api/plan-inputs': [200, { plan: PLAN, currency: 'USD', tax_facts: opts.facts ?? null, plans: wanted.map((id) => (id === 'i:c' ? row : { id, contributions_12m: 0, contributions_12m_rows: [] })) }],
      'GET /api/allocation-settings': [200, { settings: null }],
      'GET /api/saved-plan': [200, { saved: null, problem: null }],
    };
    const [status, body] = answers[`${init?.method ?? 'GET'} ${path}`] ?? [404, { error: 'not here' }];
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  };
  return asked;
}

const hasClass = (e: FakeElement, cls: string) => (e.getAttribute('class') ?? '').split(' ').includes(cls);

async function plan(props: Partial<PlanTabProps>, opts: Parameters<typeof serve>[0] = {}) {
  const asked = serve(opts);
  const all: PlanTabProps = { txns: YEAR, txnsLoading: false, txnNotes: [], institutions, balancesAsOf: null, currency: 'USD', holdings: [], planInWalk: false, newUntil: null, onMovedSeen: () => {}, ...props };
  const container = dom.document.createElement('div');
  dom.document.body.appendChild(container);
  const root = createRoot(container as unknown as Element);
  await act(async () => root.render(<PlanTab {...all} />));
  await settle();
  const row = container.findAll((e) => hasClass(e, 'list-row') && e.textContent.includes('Annual savings'))[0];
  return { asked, row, text: row?.textContent ?? '', all: () => container.textContent, unmount: () => act(async () => root.unmount()) };
}

describe('the Plan', () => {
  test('with the flag on, what the bank sent leaves Annual savings and its rate', async () => {
    const tab = await plan({ childOut: true });
    expect(tab.text).toContain('$21,599');
    // $5,000 x 12 earned; $21,599 of it saved.
    expect(tab.text).toContain('36% savings rate');
    expect(tab.asked.some((q) => q.includes('plan=i%3Ac'))).toBe(true);
    await tab.unmount();
  });

  test('counted in your plan, it stays in Annual savings', async () => {
    const tab = await plan({ childOut: true }, { facts: { ...DEFAULT_TAX_FACTS, countAnyway: ['c'] } });
    expect(tab.text).toContain('$24,599');
    await tab.unmount();
  });

  test('with the flag off, nothing moves and nothing more is asked for', async () => {
    const tab = await plan({ childOut: false });
    expect(tab.text).toContain('$24,599');
    expect(tab.asked.every((q) => !q.includes('plan='))).toBe(true);
    await tab.unmount();
  });

  test('money that went in with no transfer to match stays out of the sum', async () => {
    const gift = { ...ROW, contributions_12m: 10_000, contributions_12m_rows: [{ date: daysAgo(200), amount: 10_000 }] };
    const tab = await plan({ childOut: true }, { row: gift });
    expect(tab.text).toContain('$24,599');
    expect(tab.all()).toContain('$10,000 went into Ascensus College that no transfer from your bank paid for, so nothing is taken off for it.');
    await tab.unmount();
  });

  test('a transfer pays once: the 529 takes it, and a workplace plan’s row of that amount and day is still added', async () => {
    const toFunds = YEAR.map((t) => (t.category === 'transfer out' ? { ...t, subcategory: 'investment and retirement funds' } : t));
    const K401 = { account_id: 'k', name: '401(k)', type: 'investment', subtype: '401k', balance: 100_000, currency: 'USD' };
    const both = [{ ...institutions[0], accounts: [BROKER, COLLEGE, K401] }] as unknown as PlanTabProps['institutions'];
    const asked = serve();
    const answered = globalThis.fetch;
    (globalThis as { fetch: unknown }).fetch = async (url: string, init?: RequestInit) => {
      const res = await answered(url, init);
      if (!String(url).startsWith('/api/plan-inputs')) return res;
      const body = (await res.json()) as { plans: { id: string }[] };
      const plans = body.plans.map((p) => (p.id === 'i:k' ? { ...ROW, id: 'i:k' } : p));
      return new Response(JSON.stringify({ ...body, plans }), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    const container = dom.document.createElement('div');
    dom.document.body.appendChild(container);
    const root = createRoot(container as unknown as Element);
    const all: PlanTabProps = { txns: toFunds, txnsLoading: false, txnNotes: [], institutions: both, balancesAsOf: null, currency: 'USD', holdings: [], planInWalk: false, newUntil: null, onMovedSeen: () => {}, childOut: true };
    await act(async () => root.render(<PlanTab {...all} />));
    await settle();
    const row = container.findAll((e) => hasClass(e, 'list-row') && e.textContent.includes('Annual savings'))[0];
    // $24,599, with the $3,000 into the 401(k) added and the $3,000 into the 529 off.
    expect(row.textContent).toContain('$24,599');
    expect(asked[0]).toBe('plan=i%3Ak&plan=i%3Ac');
    await act(async () => root.unmount());
  });

  test('what leaving it out moved counts the savings too', async () => {
    const figures = (assets: number, savings: number) => planFigures(planOf(PLAN), { spending: 35_401, savings, assets }, { count: { planInWalk: false } }) as PlanFigures;
    const before = Math.round(figures(340_000, 24_599).view.fiAge as number);
    const now = Math.round(figures(300_000, 21_599).view.fiAge as number);
    // Only the savings, of the two, tells the line's "before" from one that forgot them.
    expect(Math.round(figures(340_000, 21_599).view.fiAge as number)).not.toBe(before);
    const tab = await plan({ childOut: true, childNewUntil: '9999-12-31' });
    expect(tab.all()).toContain(`Your FI date moved from ${before} to ${now}: accounts for a child’s education are now left out.`);
    await tab.unmount();
  });

  test('a row that can’t be had says the figure may be high', async () => {
    const tab = await plan({ childOut: true }, { row: { id: 'i:c', failed: true } });
    expect(tab.text).toContain('$24,599');
    expect(tab.all()).toContain('What went into Ascensus College couldn’t be measured'.replace('’', "'"));
    await tab.unmount();
  });
});

describe('Home', () => {
  const home = (store: ReturnType<typeof createPlanInputsStore>, childOut: boolean) =>
    ({ txns: YEAR, txnsLoading: false, txnNotes: [], institutions, currency: 'USD', onOpenPlan: () => {}, planInputs: store, childOut }) as unknown as React.ComponentProps<typeof FiProgressCard>;

  test('waits for the 529’s row, so the line never shows a rate that moves a moment later', async () => {
    const asked = serve();
    let open: () => void = () => {};
    const held = new Promise<void>((r) => (open = r));
    const answered = globalThis.fetch;
    (globalThis as { fetch: unknown }).fetch = async (url: string, init?: RequestInit) => {
      if (String(url).includes('sync=1')) await held;
      return answered(url, init);
    };
    const pendingFirst = async (url: string) => {
      const res = await (globalThis as unknown as { fetch: (u: string) => Promise<Response> }).fetch(url);
      if (url.includes('sync=1')) return res;
      const body = (await res.json()) as { plans: { id: string }[] };
      return new Response(JSON.stringify({ ...body, plans: body.plans.map((p) => ({ id: p.id, pending: true })) }), { status: 200 });
    };
    const store = createPlanInputsStore({ fetch: pendingFirst });
    const container = dom.document.createElement('div');
    dom.document.body.appendChild(container);
    const root = createRoot(container as unknown as Element);
    await act(async () => root.render(<FiProgressCard {...home(store, true)} />));
    await settle();
    expect(container.textContent).toBe('');
    open();
    await settle();
    expect(container.textContent).toContain('36% savings rate');
    expect(asked.some((q) => q.includes('sync=1') && q.includes('plan=i%3Ac'))).toBe(true);
    await act(async () => root.unmount());
  });

  test('with the flag off, says the rate as it was', async () => {
    serve();
    const store = createPlanInputsStore();
    const container = dom.document.createElement('div');
    dom.document.body.appendChild(container);
    const root = createRoot(container as unknown as Element);
    await act(async () => root.render(<FiProgressCard {...home(store, false)} />));
    await settle();
    expect(container.textContent).toContain('41% savings rate');
    await act(async () => root.unmount());
  });
});
