import { afterAll, describe, expect, test } from 'bun:test';
import { installDom, trackRoots, click, type, fakeClock, FakeElement, FakeNode } from './mini-dom';
import { simulateOnPage } from './plan-on-page';

// Home's FI line and the Plan tab on one copy of the Plan's inputs
// (lib/plan-inputs-store.ts, D16), as a person moves between them
// (react-dom/client over test/mini-dom.ts): the same figures from one
// answer; a save on the Plan shown on Home with nothing asked; a Plan
// opened again while its save is still on its way shows what was saved; and
// a workplace plan linked keeps Home's line hidden until its row is in. What
// each moment costs in requests and Redis commands, against the real
// handlers, is test/plan-inputs-cost.test.tsx's; the store's own timing
// rules are test/plan-inputs-store.test.ts's. Every request is answered
// here, by path; nothing reaches a network.

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
const { default: FiProgressCard } = await import('@/components/FiProgressCard');
const { default: PlanTab } = await import('@/components/PlanTab');
const { DEFAULT_PLAN } = await import('@/lib/fire/plan');
const { localDate } = await import('@/lib/local-date');
const { createPlanInputsStore } = await import('@/lib/plan-inputs-store');
const { plansListing } = await import('./plans-listing');
type Txn = import('@/components/MonthBreakdown').Txn;
type AssetInstitution = import('@/lib/fire/inputs').AssetInstitution;
type PlanInputsStore = import('@/lib/plan-inputs-store').PlanInputsStore;

// mini-dom's window has no scrollBy, and no layout: a switch scrolls nowhere.
(globalThis as unknown as { window: { scrollBy: () => void } }).window.scrollBy = () => {};

const pass = fakeClock();
simulateOnPage();
const settle = (ms = 30) => pass(ms);

const daysAgo = (n: number) => {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return localDate(d);
};
let made = 0;
const txn = (over: Partial<Txn>): Txn =>
  ({ transaction_id: `t${++made}`, date: daysAgo(10), name: 'Shop', amount: 100, pending: false, account_name: 'Checking', institution_name: 'Bank', category: 'food and drink', iso_currency_code: 'USD', ...over }) as Txn;
// A whole year: $2,950 spent and $5,000 earned each month.
const YEAR: Txn[] = Array.from({ length: 12 }, (_, m) => [txn({ date: daysAgo(34 + m * 30), amount: 2_950 }), txn({ date: daysAgo(34 + m * 30), amount: -5_000, name: 'Payroll', category: 'income' })]).flat();

const plan401k = (account_id: string) => ({ account_id, name: `Plan ${account_id}`, type: 'investment', subtype: '401k', balance: 100_000, currency: 'USD' });
const broker = (accounts = [plan401k('k1')]): AssetInstitution[] => [{ name: 'Fidelity', item_id: 'i1', error: false, staleAsOf: null, staleAsOfAt: null, missing: 0, accounts }];
const row = (id: string, amount: number) => ({
  id,
  contributions_12m: amount,
  contributions_12m_from: daysAgo(364),
  contributions_12m_partial: false,
  contributions_12m_rows: [{ date: daysAgo(30), amount }],
  contributions_12m_activity_from: null,
  note: null,
});

const PLAN = { ...DEFAULT_PLAN, age: 40, targetAge: 55, spending: 40_000 };

type Call = { method: string; url: string; body: any };
type Answer = [number, unknown];
/** The server: the plan as last saved, each workplace plan's row (`rows`,
 *  pending until given), every call recorded; `hold` keeps a call's answer
 *  until the test lets it go. */
function serve() {
  const calls: Call[] = [];
  const state = { plan: PLAN as typeof PLAN, rows: { 'i1:k1': row('i1:k1', 6_000) } as Record<string, ReturnType<typeof row>>, held: [] as { call: Call; go: () => void }[], hold: null as null | ((c: Call) => boolean) };
  const answer = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });
  const rowsFor = (u: URL, sync: boolean) => u.searchParams.getAll('plan').map((id) => state.rows[id] ?? (sync ? { id, failed: true } : { id, pending: true }));
  (globalThis as any).fetch = async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    const u = new URL(url, 'http://nya.test');
    const call = { method, url, body: init?.body ? JSON.parse(String(init.body)) : null };
    calls.push(call);
    if (state.hold?.(call)) await new Promise<void>((go) => state.held.push({ call, go }));
    const result = ((): Answer => {
      if (u.pathname === '/api/plan-inputs') return u.searchParams.get('sync') === '1' ? [200, { plans: rowsFor(u, true) }] : [200, { plan: state.plan, currency: 'USD', plans: rowsFor(u, false) }];
      if (u.pathname === '/api/fire-plan' && method === 'PUT') {
        state.plan = call.body.plan;
        return [200, { plan: state.plan, currency: call.body.currency }];
      }
      if (u.pathname === '/api/plans' && method === 'GET') return plansListing(null);
      if (u.pathname === '/api/allocation-settings') return [200, { settings: null }];
      return [404, { error: 'not here' }];
    })();
    return answer(result[1], result[0]);
  };
  return { calls, state, inputs: () => calls.filter((c) => c.url.startsWith('/api/plan-inputs')) };
}

type Root = ReturnType<typeof createRoot>;
async function home(store: PlanInputsStore, institutions = broker()) {
  const container = dom.document.createElement('ul');
  dom.document.body.appendChild(container);
  const root = createRoot(container as unknown as Element);
  const draw = (insts: AssetInstitution[]) => root.render(<FiProgressCard txns={YEAR} txnsLoading={false} txnNotes={[]} institutions={insts} currency="USD" onOpenPlan={() => {}} planInputs={store} />);
  await act(async () => draw(institutions));
  await settle();
  return {
    text: () => container.textContent,
    redraw: async (insts: AssetInstitution[]) => {
      await act(async () => draw(insts));
      await settle();
    },
    unmount: () => act(async () => root.unmount()),
  };
}

const has = (e: FakeNode | null, cls: string) => e instanceof FakeElement && (e.getAttribute('class') ?? '').split(' ').includes(cls);
const part = (el: FakeElement, cls: string) => el.findAll((e) => has(e, cls))[0] ?? null;
const button = (within: FakeElement, words: string) => within.findAll((e) => e.tagName === 'BUTTON' && e.textContent.trim() === words)[0] ?? null;
const field = (sheet: FakeElement, label: string) =>
  sheet.findAll((e) => e.tagName === 'LABEL' && e.textContent.startsWith(label))[0]?.findAll((e) => e.tagName === 'INPUT' || e.tagName === 'SELECT')[0] ?? null;
const press = async (el: FakeElement | null | undefined) => {
  if (!el) throw new Error('nothing to press');
  await act(async () => {
    el.focus();
    click(el);
  });
  await settle();
};

async function plan(store: PlanInputsStore, institutions = broker()) {
  const container = dom.document.createElement('div');
  dom.document.body.appendChild(container);
  const root = createRoot(container as unknown as Element);
  await act(async () =>
    root.render(<PlanTab txns={YEAR} txnsLoading={false} txnNotes={[]} institutions={institutions} balancesAsOf={new Date().toISOString()} currency="USD" holdings={[]} planInputs={store} />)
  );
  await settle();
  const find = (t: (e: FakeElement) => boolean) => container.findAll(t);
  const row = (title: string) => find((e) => e.tagName === 'BUTTON' && has(e, 'list-row') && part(e, 'list-row-title')?.textContent === title)[0] ?? null;
  return {
    text: () => container.textContent,
    row,
    dialog: () => find((e) => e.getAttribute('role') === 'dialog' && e.getAttribute('data-open') === 'true')[0] ?? null,
    unmount: () => act(async () => root.unmount()),
  };
}

/** Sets the withdrawal rate in the Assumptions sheet and presses Save. */
async function saveRate(tab: Awaited<ReturnType<typeof plan>>, rate: string) {
  await press(tab.row('Assumptions'));
  const sheet = tab.dialog()!;
  await act(async () => type(field(sheet, 'Withdrawal rate')!, rate));
  await press(button(sheet, 'Save'));
}

describe('Home and the Plan on one copy', () => {
  test('the same figures from one answer; a save on the Plan is on Home with nothing asked', async () => {
    const server = serve();
    const store = createPlanInputsStore();
    const h = await home(store);
    expect(h.text()).toContain('$100,000 of $1,000,000 invested (10%) · 46% savings rate');
    expect(server.inputs().length).toBe(1); // the row cached: one request
    await h.unmount();

    // The Plan asks once, and works from the same answer: its FI number, and
    // savings with the workplace plan's $6,000 in them.
    const p = await plan(store);
    expect(server.inputs().length).toBe(2);
    expect(p.text()).toContain('FI number $1,000,000: $40,000 a year ÷ 4% withdrawal rate');
    expect(p.text()).toContain('Saving $30,600 a year');
    await saveRate(p, '3.5');
    await settle(400);
    expect(server.calls.filter((c) => c.method === 'PUT').map((c) => c.body.plan.withdrawalRate)).toEqual([0.035]);
    await p.unmount();

    // Back on Home: the saved plan, and nothing asked.
    const before = server.calls.length;
    const again = await home(store);
    expect(server.calls.length).toBe(before);
    expect(again.text()).toContain('$100,000 of $1,142,857 invested (9%)');
    expect(again.text()).toContain('a 3.5% withdrawal rate');
    await again.unmount();
  });

  test('the Plan opened again while its save is still on its way asks only once it has landed, and shows what was saved', async () => {
    const server = serve();
    const store = createPlanInputsStore();
    const p = await plan(store);
    server.state.hold = (c) => c.method === 'PUT';
    await saveRate(p, '3.5');
    expect(server.state.held.length).toBe(1);
    await p.unmount();

    const asked = server.inputs().length;
    const reopened = await plan(store);
    await settle(100);
    expect(server.inputs().length).toBe(asked); // waiting for the save
    server.state.hold = null;
    server.state.held[0].go();
    await settle(100);
    const order = server.calls.map((c) => `${c.method} ${c.url.split('?')[0]}`).filter((c) => c.includes('fire-plan') || c.includes('plan-inputs'));
    expect(order.slice(-2)).toEqual(['PUT /api/fire-plan', 'GET /api/plan-inputs']);
    expect(part(reopened.row('Assumptions')!, 'list-row-sub')?.textContent).toBe('3.5% withdrawal · 5% growth after inflation until FI · 0% tax');
    await reopened.unmount();
  });

  test('a workplace plan linked keeps Home’s line hidden until its row is in, then counts it', async () => {
    const server = serve();
    const store = createPlanInputsStore();
    const h = await home(store);
    expect(h.text()).toContain('46% savings rate');
    expect(h.text()).toContain('$1,000,000');

    // A second plan, its row not cached: asked for with the first, then
    // synced; the line hides meanwhile, never shows the first plan alone.
    server.state.hold = (c) => c.url.includes('sync=1');
    await h.redraw(broker([plan401k('k1'), plan401k('k2')]));
    expect(server.inputs().map((c) => c.url)).toEqual([
      '/api/plan-inputs?plan=i1%3Ak1',
      '/api/plan-inputs?plan=i1%3Ak1&plan=i1%3Ak2',
      '/api/plan-inputs?sync=1&plan=i1%3Ak2',
    ]);
    expect(h.text()).toBe('');
    server.state.rows['i1:k2'] = row('i1:k2', 4_000);
    server.state.hold = null;
    server.state.held[0].go();
    await settle(100);
    expect(h.text()).toContain('$200,000 of $1,000,000 invested (20%)');
    await h.unmount();
  });
});
