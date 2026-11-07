import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test';
import { AsyncLocalStorage } from 'node:async_hooks';
import { clerk } from './clerk-mock';
import { FakeRedis, storageMock, TEST_CONTAINER, TEST_CTX, ctxKey, registerTestContainer } from './fake-redis';
import { installDom, trackRoots } from './mini-dom';
import { simulateOnPage } from './plan-on-page';

// What the plan's inputs cost to bring in: the requests Home's FI line and
// the Plan tab send for them, and the Redis commands each one costs, as the
// app runs them (Clerk mode, every route handler real, on test/fake-redis.ts).
// Two workplace plans in one item and one in another; a saved plan with its
// currency recorded; the investment store synced a moment ago, so a row not
// cached costs a sync that reads the store but asks Plaid nothing.
//
// The numbers are the ones the pull request that brought the plan's inputs
// into one request (D16) reports, before and after. Before, each screen
// asked for the plan (GET /api/fire-plan) and for each workplace plan's row
// (GET /api/investment-activity) every time it was shown: Home's first load
// was 4 requests and 28 commands with no row cached, and every return to
// Home, and every time the Plan opened, 4 requests and 12 commands.

process.env.PLAID_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
const env = { ...process.env };
beforeAll(() => {
  process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY = 'pk_test_x';
  process.env.CLERK_SECRET_KEY = 'sk_test_x';
  clerk.signedIn = 'user_owner';
});

const fake = new FakeRedis({ deserialize: true });
mock.module('@/lib/storage', () => storageMock(fake));

// Each request's commands, by the request that sent them: a command is told
// to the request whose handler is running it.
const sending = new AsyncLocalStorage<string[]>();
const gated = fake as unknown as { gate: (command: string) => void };
const gate = gated.gate.bind(fake);
gated.gate = (command) => {
  sending.getStore()?.push(command);
  gate(command);
};

// A Plaid that answers each item's own accounts, by its access token.
const DAY = 86_400_000;
const daysAgo = (n: number) => new Date(Date.now() - n * DAY).toISOString().slice(0, 10);
const contribution = (id: string, account_id: string, date: string, amount: number) => ({
  investment_transaction_id: id,
  account_id,
  security_id: 's1',
  date,
  name: 'Contribution',
  quantity: 1,
  amount: -amount,
  price: amount,
  fees: 0,
  type: 'cash',
  subtype: 'contribution',
  iso_currency_code: 'USD',
  unofficial_currency_code: null,
});
const PLAID: Record<string, { accounts: string[]; rows: ReturnType<typeof contribution>[] }> = {
  'tok-i1': { accounts: ['k1', 'k2'], rows: [contribution('a1', 'k1', daysAgo(40), 500), contribution('a2', 'k1', daysAgo(10), 500), contribution('b1', 'k2', daysAgo(20), 300)] },
  'tok-i2': { accounts: ['k3'], rows: [contribution('c1', 'k3', daysAgo(30), 800)] },
};
mock.module('@/lib/plaid', () => ({
  plaidClient: {
    investmentsTransactionsGet: async (req: any) => {
      const { accounts, rows } = PLAID[req.access_token];
      const inRange = rows.filter((r) => r.date >= req.start_date && r.date <= req.end_date);
      const offset = req.options?.offset ?? 0;
      return {
        data: {
          accounts: accounts.map((account_id) => ({ account_id, name: account_id, mask: '0000', type: 'investment', subtype: '401k' })),
          securities: [{ security_id: 's1', name: 'Target 2055', ticker_symbol: 'VFFVX' }],
          investment_transactions: inRange.slice(offset, offset + (req.options?.count ?? 500)),
          total_investment_transactions: inRange.length,
        },
      };
    },
  },
}));

const dom = installDom();
const realFetch = globalThis.fetch;
afterAll(() => {
  globalThis.fetch = realFetch;
  dom.uninstall();
  process.env = { ...env };
  clerk.signedIn = null;
});

const React = await import('react');
const { act } = React;
for (const k of Object.keys(require.cache)) if (/react-dom[\\/](?:client\.js|cjs[\\/]react-dom-client\.)/.test(k)) delete require.cache[k];
const { createRoot } = trackRoots(require('react-dom/client') as typeof import('react-dom/client'));
const { default: FiProgressCard } = await import('@/components/FiProgressCard');
const { default: PlanTab } = await import('@/components/PlanTab');
const { DEFAULT_PLAN } = await import('@/lib/fire/plan');
const { planOf } = await import('@/lib/fire/plan-v2');
const { factsOf } = await import('@/lib/fire/copies');
const { plansListing } = await import('./plans-listing');
const { encrypt } = await import('@/lib/crypto');
const { saveItem } = await import('@/lib/storage');
const { syncInvestments } = await import('@/lib/invstore');
const { dataCtx } = await import('@/lib/data-ctx');
const { localDate } = await import('@/lib/local-date');
const firePlan = await import('@/app/api/fire-plan/route');
const activity = await import('@/app/api/investment-activity/route');
const planInputs = await import('@/app/api/plan-inputs/route');
const { createPlanInputsStore, FRESH_MS } = await import('@/lib/plan-inputs-store');
type PlanInputsStore = import('@/lib/plan-inputs-store').PlanInputsStore;
type Txn = import('@/components/MonthBreakdown').Txn;
type AssetInstitution = import('@/lib/fire/inputs').AssetInstitution;

simulateOnPage();
// mini-dom's window has no scrollBy, and no layout: a switch scrolls nowhere.
(globalThis as unknown as { window: { scrollBy: () => void } }).window.scrollBy = () => {};

// A year of transactions: $2,950 spent and $5,000 earned each month.
const day = (n: number) => {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return localDate(d);
};
let made = 0;
const txn = (over: Partial<Txn>): Txn =>
  ({ transaction_id: `t${++made}`, date: day(10), name: 'Shop', amount: 100, pending: false, account_name: 'Checking', institution_name: 'Bank', category: 'food and drink', iso_currency_code: 'USD', ...over }) as Txn;
const YEAR: Txn[] = Array.from({ length: 12 }, (_, m) => [txn({ date: day(34 + m * 30), amount: 2_950 }), txn({ date: day(34 + m * 30), amount: -5_000, name: 'Payroll', category: 'income' })]).flat();

const plan401k = (account_id: string, balance: number) => ({ account_id, name: `Plan ${account_id}`, type: 'investment', subtype: '401k', balance, currency: 'USD' });
const INSTITUTIONS: AssetInstitution[] = [
  { name: 'Fidelity', item_id: 'i1', error: false, staleAsOf: null, staleAsOfAt: null, missing: 0, accounts: [plan401k('k1', 100_000), plan401k('k2', 50_000)] },
  { name: 'Vanguard', item_id: 'i2', error: false, staleAsOf: null, staleAsOfAt: null, missing: 0, accounts: [plan401k('k3', 80_000)] },
];

// The requests, each with the commands it sent. Routes not about the plan's
// inputs (the Plan's list of plans, allocation settings, saved plan and
// allocation history) are answered here (404 where nothing is given),
// counted apart, and cost nothing.
type Sent = { path: string; commands: string[] };
let sent: Sent[] = [];
let inflight = 0;
const ROUTES: Record<string, (req: Request) => Promise<Response>> = {
  'GET /api/fire-plan': () => firePlan.GET(),
  'GET /api/investment-activity': (req) => activity.GET(req),
  'GET /api/plan-inputs': (req) => planInputs.GET(req),
};
const STUBS: Record<string, unknown> = {
  'GET /api/plans': plansListing(null)[1],
  'GET /api/allocation-settings': { settings: null },
};
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(String(input), 'http://nya.test');
  const path = `${init?.method ?? 'GET'} ${url.pathname}`;
  const commands: string[] = [];
  sent.push({ path, commands });
  const route = ROUTES[path];
  if (!route) return Response.json(STUBS[path] ?? { error: 'not here' }, { status: path in STUBS ? 200 : 404 });
  inflight++;
  try {
    return await sending.run(commands, () => route(new Request(url, { method: init?.method, body: init?.body })));
  } finally {
    inflight--;
  }
}) as typeof fetch;

/** Waits until no request has been in flight for a few turns. */
async function settle() {
  for (let quiet = 0; quiet < 5; ) {
    await act(async () => void (await new Promise((r) => setTimeout(r, 10))));
    quiet = inflight === 0 ? quiet + 1 : 0;
  }
}

/** What one moment cost: the requests for the plan's inputs by path, the
 *  commands they sent by path and by command, and the other requests. */
function tally(list: Sent[]) {
  const requests: Record<string, number> = {};
  const commands: Record<string, number> = {};
  const byCommand: Record<string, number> = {};
  const others: Record<string, number> = {};
  for (const { path, commands: sentBy } of list) {
    if (!(path in ROUTES)) {
      others[path] = (others[path] ?? 0) + 1;
      continue;
    }
    requests[path] = (requests[path] ?? 0) + 1;
    commands[path] = (commands[path] ?? 0) + sentBy.length;
    for (const c of sentBy) byCommand[c] = (byCommand[c] ?? 0) + 1;
  }
  return { requests, commands, byCommand, others };
}

/** Runs `what`, and returns what it cost. */
async function measure(what: () => Promise<unknown>) {
  sent = [];
  await what();
  await settle();
  return tally(sent);
}

type Root = ReturnType<typeof createRoot>;
async function mountHome(store?: PlanInputsStore, over: Partial<React.ComponentProps<typeof FiProgressCard>> = {}): Promise<{ root: Root; text: () => string }> {
  const container = dom.document.createElement('ul');
  dom.document.body.appendChild(container);
  const root = createRoot(container as unknown as Element);
  await act(async () => root.render(<FiProgressCard txns={YEAR} txnsLoading={false} txnNotes={[]} institutions={INSTITUTIONS} currency="USD" onOpenPlan={() => {}} planInputs={store} {...over} />));
  return { root, text: () => container.textContent };
}
async function mountPlan(store?: PlanInputsStore): Promise<Root> {
  const container = dom.document.createElement('div');
  dom.document.body.appendChild(container);
  const root = createRoot(container as unknown as Element);
  await act(async () =>
    root.render(<PlanTab txns={YEAR} txnsLoading={false} txnNotes={[]} institutions={INSTITUTIONS} balancesAsOf={new Date().toISOString()} currency="USD" holdings={[]} planInputs={store} />)
  );
  return root;
}
const unmount = (root: Root) => act(async () => root.unmount());

beforeAll(async () => {
  await registerTestContainer(fake);
  // The account's container claimed, and its key read, before anything is
  // counted: each request then reads only whose container it is.
  await dataCtx();
  for (const item_id of ['i1', 'i2']) {
    const item = { item_id, institution_name: item_id, encrypted_access_token: await encrypt(TEST_CTX, `tok-${item_id}`) };
    await saveItem(TEST_CTX, item as any);
    await syncInvestments(TEST_CTX, item as any);
  }
  const saved = await firePlan.PUT(new Request('http://nya.test/api/fire-plan', { method: 'PUT', body: JSON.stringify({ plan: planOf({ ...DEFAULT_PLAN, age: 40, targetAge: 55, spending: 40_000 }), currency: 'USD', facts_were: factsOf(DEFAULT_PLAN), based_on: null }) }));
  expect(saved.status).toBe(200);
  // Nothing in the account cache yet: the first rows asked for aren't cached.
  expect(await fake.hgetall(ctxKey('cache:inv-activity:v4'))).toBeNull();
});

// What the Plan asks for besides its inputs: the same before and after.
const PLAN_OTHERS = { 'GET /api/allocation-settings': 1, 'GET /api/saved-plan': 1, 'GET /api/plans': 1, 'POST /api/allocation-history': 1 };
const NOTHING = { requests: {}, commands: {}, byCommand: {}, others: {} };
// One request with every row cached: whose container it is, then your plan
// (the facts every plan shares, your plan's entry and how many plans there
// are: lib/plan-copies.ts readMain) and every row, read together.
const ONE = { requests: { 'GET /api/plan-inputs': 1 }, commands: { 'GET /api/plan-inputs': 5 }, byCommand: { evalRo: 1, get: 1, eval: 1, hlen: 1, hmget: 1 } };

describe('what the plan’s inputs cost', () => {
  test('one request between Home and the Plan, none on a return to Home within five minutes, and the same figures throughout', async () => {
    let clock = Date.now();
    const store = createPlanInputsStore({ now: () => clock });

    // Home's first load, no row cached: the plan and the rows asked for
    // together (3 commands for the plan, one HMGET for the rows), then one
    // sync=1 request for the rows not cached, which syncs each item once
    // (its lock, its store, the lock let go) and caches each row.
    let home!: Awaited<ReturnType<typeof mountHome>>;
    expect(await measure(async () => (home = await mountHome(store)))).toEqual({
      requests: { 'GET /api/plan-inputs': 2 },
      commands: { 'GET /api/plan-inputs': 22 },
      byCommand: { evalRo: 2, get: 5, eval: 1, hlen: 1, hmget: 2, hgetall: 1, set: 2, del: 2, hset: 3, expire: 3 },
      others: {},
    });
    const shown = home.text();
    expect(shown).toContain('FI');
    await unmount(home.root);

    // Back on Home within five minutes: nothing asked.
    expect(await measure(async () => (home = await mountHome(store)))).toEqual(NOTHING);
    expect(home.text()).toBe(shown);
    await unmount(home.root);

    // The Plan always asks, once, and Home's copy takes its answer.
    let plan!: Root;
    expect(await measure(async () => (plan = await mountPlan(store)))).toEqual({ ...ONE, others: PLAN_OTHERS });
    await unmount(plan);
    expect(await measure(async () => (home = await mountHome(store)))).toEqual(NOTHING);
    expect(home.text()).toBe(shown);
    await unmount(home.root);

    // After five minutes, one request; the copy is shown while it loads.
    clock += FRESH_MS;
    expect(await measure(async () => (home = await mountHome(store)))).toEqual({ ...ONE, others: {} });
    expect(home.text()).toBe(shown);

    // A refresh, a link or a restore (the dashboard invalidates the copy):
    // one request from the screen showing it.
    expect(await measure(() => act(async () => store.invalidate()))).toEqual({ ...ONE, others: {} });
    expect(home.text()).toBe(shown);
    await unmount(home.root);

    // A new page, the rows cached: one request.
    expect(await measure(async () => (home = await mountHome(createPlanInputsStore())))).toEqual({ ...ONE, others: {} });
    expect(home.text()).toBe(shown);
    await unmount(home.root);
  });

  // Last, since it moves the stored plan on.
  test('a detailed plan costs Home one read of its settings, and every one with an age has its FI number from its years', async () => {
    const facts = await import('@/app/api/plan-facts/route');
    const optIn = await facts.POST(new Request('http://nya.test/api/plan-facts', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'opt-in' }) }));
    expect(optIn.status).toBe(200);

    let home!: { root: Root; text: () => string };
    expect(await measure(async () => (home = await mountHome(createPlanInputsStore())))).toEqual({ ...ONE, others: { 'GET /api/allocation-settings': 1 } });
    expect(home.text()).toStartWith('FI');
    expect(home.text()).not.toContain('Working it out');
    await unmount(home.root);

    // A milestone on a balance goes through the same run, at the same cost.
    const read = await (await firePlan.GET()).json();
    const milestone = { id: 'm', label: 'Part time', kind: 'part-time', from: { anchor: { at: 'balance', amount: 900_000 }, offset: 0 }, until: { anchor: { at: 'age', age: 70 }, offset: 0 }, once: null, yearly: 20_000, replaces: null, every: null, times: null, inflationAdjusted: true, owner: 'you', beforeTax: true };
    const changed = await firePlan.PUT(new Request('http://nya.test/api/fire-plan', { method: 'PUT', body: JSON.stringify({ plan: { ...read.plan, items: [milestone] }, currency: 'USD', facts_were: factsOf(read.plan), based_on: read.updated_at }) }));
    expect(changed.status).toBe(200);
    const cost = await measure(async () => (home = await mountHome(createPlanInputsStore())));
    expect(cost.others).toEqual({ 'GET /api/allocation-settings': 1 });
    expect(home.text()).not.toContain('Working it out');
    expect(home.text()).not.toContain('isn’t worked out');
    expect(home.text()).toStartWith('FI');
    await unmount(home.root);
  });

  // The plan is detailed by now.
  test('Home tells Needs attention what a detailed plan still needs said', async () => {
    const account = (account_id: string, subtype: string) => ({ account_id, name: account_id, type: 'investment', subtype, balance: 5_000, currency: 'USD' });
    const institutions: AssetInstitution[] = [{ ...INSTITUTIONS[0], accounts: [account('Mystery', 'other'), account('My Roth', 'roth')] }];
    const read = await (await firePlan.GET()).json();
    const income = { id: 'p', label: 'Pension', kind: 'pension', from: { anchor: { at: 'age', age: 60 }, offset: 0 }, until: null, once: null, yearly: 12_000, replaces: null, every: null, times: null, inflationAdjusted: true, owner: null, beforeTax: false };
    const changed = await firePlan.PUT(new Request('http://nya.test/api/fire-plan', { method: 'PUT', body: JSON.stringify({ plan: { ...read.plan, items: [income] }, currency: 'USD', facts_were: factsOf(read.plan), based_on: read.updated_at }) }));
    expect(changed.status).toBe(200);

    const says = async (over: Partial<React.ComponentProps<typeof FiProgressCard>> = {}) => {
      const said: string[][] = [];
      const home = await mountHome(createPlanInputsStore(), { institutions, onAttention: (notes) => said.push(notes.map((n) => n.kind)), ...over });
      await settle();
      await unmount(home.root);
      return said;
    };
    expect(await says()).toEqual([['no tax bucket', 'Roth put-in not given', 'income after tax']]);

    // A bucket the person chose is read from their settings, so it isn't asked for again.
    const settings = STUBS['GET /api/allocation-settings'];
    STUBS['GET /api/allocation-settings'] = { settings: { v: 1, buckets: [{ account_id: 'Mystery', bucket: 'taxable' }], funds: [], accounts: [], target: null } };
    expect(await says()).toEqual([['Roth put-in not given', 'income after tax']]);
    STUBS['GET /api/allocation-settings'] = settings;

    // In another currency a detailed plan is at its flat rate, and says nothing here.
    const { firePlansStore } = await import('@/lib/plan-copies');
    const { MAIN_ID } = await import('@/lib/fire/copies');
    await firePlansStore.update(TEST_CTX, MAIN_ID, async (entry) => ({ ...entry!, currency: 'EUR' }));
    expect(await says({ currency: 'EUR' })).toEqual([[]]);
  });
});
