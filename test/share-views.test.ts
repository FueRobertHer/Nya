import { describe, expect, test, mock, beforeEach, afterEach, setSystemTime } from 'bun:test';
import { clerk } from './clerk-mock';
import { FakeRedis, storageMock, registerTestContainer, unscopedDataKeys, ctxKey, testKey } from './fake-redis';

// The other kinds of share (#45 step 3: lib/share-kinds.ts, lib/share-views.ts,
// lib/sharing.ts): someone's net worth, spending, holdings, budgets and goals,
// each a projection of their own data built on the server as it is read, from
// the functions their own screens and the read-only API use. Against the
// owner's own numbers, to the cent; what a share never holds; hidden and
// ended accounts; stores that can't be read; ends and the record of showings;
// what a release from before them reads; and that a viewer reaches nothing
// that isn't shared with them. Plaid is never asked.

process.env.PLAID_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');

const plaidTouched: string[] = [];
mock.module('@/lib/plaid', () => ({
  plaidClient: new Proxy(
    {},
    {
      get(_target, prop) {
        if (typeof prop === 'string') plaidTouched.push(prop);
        return async () => {
          throw new Error('Plaid must not be called for a share');
        };
      },
    }
  ),
}));

const fake = new FakeRedis({ deserialize: true });
mock.module('@/lib/storage', () => storageMock(fake));
afterEach(() => expect(unscopedDataKeys(fake)).toEqual([]));

const { ctx, seedPerson, seedOther, daysAgo, DAY, chaseTxns, syncedAt, txn } = await import('./api-fixture');
const { readNetWorth, readNetWorthAndHistory, readSpending, readBudgets } = await import('@/lib/api-read');
const { tidy } = await import('@/lib/totals');

// The fixture dates everything it seeds from the clock when it seeds, and the
// clock is held at noon of the day this file loaded, so the bank's rows
// below are the ones it seeds. Which months they fall in is worked out from
// their dates, never assumed.
const NOW = new Date(`${new Date().toISOString().slice(0, 10)}T12:00:00.000Z`);
setSystemTime(NOW);
const CHASE_TXNS = chaseTxns();
const SYNCED_AT = syncedAt();
setSystemTime();
const dateOf = (id: string) => CHASE_TXNS.find((t) => t.transaction_id === id)!.date;
const TODAY = NOW.toISOString().slice(0, 10);
const MONTH = TODAY.slice(0, 7);
const monthOf = (day: string) => day.slice(0, 7);
const addMonths = (month: string, n: number) => {
  const [y, m] = month.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1 + n, 1)).toISOString().slice(0, 7);
};
/** Each month from `to` back to `from`, newest first. */
const monthsBack = (to: string, from: string) => {
  const out: string[] = [];
  for (let m = to; m >= from; m = addMonths(m, -1)) out.push(m);
  return out;
};
/** What the owner's spending counts, in dollars, by the spending rule: the
 *  bank's coffee, rent, fee, card purchase, lunch and three months of the
 *  subscription, and the market entered by hand on the wallet the day
 *  before (seedPerson). Never the pay, the transfer, the cash, the loan
 *  payment, the euros, the excluded purchase or the hidden account's. */
const COUNTED: [string, number][] = [['t_coffee', 5.5], ['t_rent', 1200], ['t_fee', 35], ['t_card', 80], ['t_posted', 12], ['t_flix0', 15.99], ['t_flix1', 15.99], ['t_flix2', 15.99]];
const countedRows = () => [...COUNTED.map(([id, amount]) => ({ id, date: dateOf(id), amount })), { id: 'market', date: daysAgo(1), amount: 25 }];
const spentIn = (month: string, leave: string[] = []) => tidy(countedRows().filter((r) => monthOf(r.date) === month && !leave.includes(r.id)).reduce((s, r) => s + r.amount, 0));
/** What the budgets count in a month: food and drink (coffee, lunch, the
 *  market) and housing (the rent, recategorized); travel's euros are left out. */
const budgetSpent = (month: string) => spentIn(month, ['t_fee', 't_card', 't_flix0', 't_flix1', 't_flix2']);
const { readGoals } = await import('@/lib/api-goals');
const { forgetEpochs } = await import('@/lib/sessions');
const { ownerContainer } = await import('@/lib/owners');
const { markEnded } = await import('@/lib/lifecycle');
const { allocationSettingsStore } = await import('@/lib/allocation-settings');
const { accessLogStore } = await import('@/lib/access-log');
const { weeklySettingStore } = await import('@/lib/weekly-summary/store');
const { setBudgets } = await import('@/lib/budgets');
const { encodeJsonBlob } = await import('@/lib/blob');
const { SHARED_READS_PER_WINDOW } = await import('@/lib/share-rules');
const { connectWithoutTransactions } = await import('./api-fixture');
const { encrypt } = await import('@/lib/crypto');
const { recordDirectory } = await import('@/lib/links');
const { saveManualAccount } = await import('@/lib/manual');

const route = async (path: string, method: string, body?: unknown, query = '') => {
  const mod: any = await import(`@/app/api/${path}/route`);
  const res = await mod[method](new Request(`http://x/api/${path}${query}`, { method, body: body === undefined ? undefined : JSON.stringify(body) }));
  return { status: res.status as number, body: (await res.json()) as any };
};
const as = async <T>(user: string, fn: () => Promise<T>) => {
  clerk.signedIn = user;
  return fn();
};
const quietly = async <T>(fn: () => Promise<T>): Promise<T> => {
  const [error, warn] = [console.error, console.warn];
  console.error = console.warn = () => {};
  try {
    return await fn();
  } finally {
    [console.error, console.warn] = [error, warn];
  }
};

let pair = '';
/** Shares on the owner's connection with the partner. */
const share = (change: Record<string, unknown>, id = pair) => as('user_owner', () => route('connections', 'PUT', { id, ...change }));
const shareViews = (views: Record<string, unknown>, accounts?: Record<string, string>) => share({ views, ...(accounts ? { accounts } : {}) });
/** What the partner is shown of the owner's share, through their own read. */
const partnerSees = async () => {
  const { body } = await as('user_partner', () => route('shared', 'GET'));
  return body.shared as any[];
};
const partnerViews = async () => (await partnerSees())[0]?.views;
/** "What they see", as the owner asks for it. */
const previewOf = (who = 'user_owner', id = pair) => as(who, () => route('connections/preview', 'GET', undefined, `?id=${encodeURIComponent(id)}`));
/** The owner's share as stored, in the connections hash. */
const storedShare = async (id = pair) => fake.hget<any>(testKey('connections'), `${id}|share|user_owner`);
/** Everything stored in the owner's container, by key and field. */
const ownerData = () => {
  const prefix = ctxKey('');
  const out: Record<string, unknown> = {};
  for (const [k, v] of (fake as any).strings) if (k.startsWith(prefix)) out[k] = v;
  for (const [k, h] of (fake as any).hashes) if (k.startsWith(prefix)) for (const [f, v] of h) out[`${k} ${f}`] = v;
  return out;
};

/** The bank's stored rows as the fixture keeps them, with `extra` beside them. */
async function chaseTxnsWith(extra: Record<string, unknown>[]) {
  const accounts = {
    acc_chk: { name: 'Checking', official_name: null, type: 'depository', subtype: 'checking', mask: '1111', balances: null },
    acc_card: { name: 'Card', official_name: null, type: 'credit', subtype: 'credit card', mask: '2222', balances: null },
    acc_save: { name: 'Savings', official_name: null, type: 'depository', subtype: 'savings', mask: '3333', balances: null },
  };
  const txns = Object.fromEntries([...CHASE_TXNS, ...extra].map((t: any) => [t.transaction_id, t]));
  await fake.set(ctxKey('txns:item_chase'), await encodeJsonBlob(ctx, { schema_version: 2, cursor: 'c1', accounts, txns, synced_at: SYNCED_AT }));
}

/** Ends ahead, as the drawer sends them. */
const LATER = new Date(NOW.getTime() + 31 * DAY).toISOString();
const EVEN_LATER = new Date(NOW.getTime() + 61 * DAY).toISOString();

const GOAL = (n: number) => `0000000${n}-1d2e-4f5a-8b6c-7d8e9f0a1b2c`;
/** The owner's goals, saved as the app saves them. */
async function saveGoals() {
  const res = await as('user_owner', () =>
    route('goals', 'PUT', {
      goals: [
        { id: GOAL(1), name: 'Rainy day', target: 3000, account_id: 'acc_chk', plan: { allocation: 1000, monthly_target: 100, target_date: '2030-01-31' } },
        { id: GOAL(2), name: 'SECRET-HIDDEN-GOAL', target: 60_000, account_id: 'acc_save', plan: {} },
        { id: GOAL(3), name: 'Someday', target: 800, account_id: null, plan: { monthly_target: 50 } },
        { id: GOAL(4), name: 'SECRET-UNCHOSEN-GOAL', target: 500, account_id: 'manual_wallet', plan: {} },
        // No pace known for the IRA (no months of balances yet): its monthly target projects it.
        { id: GOAL(5), name: 'Retire', target: 50_500, account_id: 'acc_ira', plan: { monthly_target: 500 } },
      ],
    })
  );
  expect(res.status).toBe(200);
}

const saved = { ...process.env };
beforeEach(async () => {
  setSystemTime(NOW);
  fake.reset();
  forgetEpochs();
  await registerTestContainer(fake);
  process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY = 'pk_test_x';
  process.env.CLERK_SECRET_KEY = 'sk_test_x';
  process.env.CLERK_ALLOWED_USER_IDS = 'user_owner,user_partner,user_third';
  await seedPerson(fake);
  // Every connection of the owner's loaded, so every total can be whole, and
  // the account directory as those loads keep it (lib/links.ts): what names
  // an account in a share.
  await fake.hdel(ctxKey('plaid:items'), 'item_new');
  const seen = (account_id: string, name: string, type: string, subtype: string, mask: string) => ({ account_id, name, official_name: null, type, subtype, mask });
  await recordDirectory(ctx, [
    {
      item_id: 'item_chase',
      institution_name: 'Chase',
      institution_id: 'ins_3',
      error: null,
      accounts: [seen('acc_chk', 'Checking', 'depository', 'checking', '1111'), seen('acc_card', 'Card', 'credit', 'credit card', '2222'), seen('acc_save', 'Savings', 'depository', 'savings', '3333')],
    },
    { item_id: 'item_broker', institution_name: 'Broker', institution_id: 'ins_9', error: null, accounts: [seen('acc_ira', 'IRA', 'investment', 'ira', '4444')] },
  ] as any);
  // The owner claims the data seeded; someone else's container is there
  // too; the partner and a third person get their own.
  expect(await ownerContainer('user_owner')).toBe(ctx.container);
  await seedOther(fake);
  await as('user_partner', () => route('shared', 'GET'));
  await as('user_third', () => route('shared', 'GET'));
  const invite = await as('user_owner', () => route('connections/invite', 'POST', {}));
  const accepted = await as('user_partner', () => route('connections/accept', 'POST', { token: invite.body.url.split('/connect/')[1], label: 'Alex' }));
  pair = accepted.body.id;
  plaidTouched.length = 0;
});
afterEach(() => {
  process.env = { ...saved };
  setSystemTime();
  expect(plaidTouched).toEqual([]);
});

describe('net worth', () => {
  test('each account’s newest measured balance added up, to the cent, as the owner’s own total, with the accounts in it when chosen', async () => {
    const every = { acc_chk: 'balance', acc_card: 'balance', acc_ira: 'transactions', manual_house: 'balance', manual_wallet: 'balance' };
    expect((await shareViews({ net_worth: { detail: 'total', accounts: true } }, every)).status).toBe(200);
    const nw = (await partnerViews()).net_worth;
    // Checking 1,250.00 (its newest, partial, day), the card's 310.00 owed,
    // the IRA's 20,500.00, the house and the wallet; Savings is hidden.
    expect(nw.total).toBe(1250 - 310 + 20_500 + 300_000 + 40);
    const own = await readNetWorth(ctx);
    expect(nw.total).toBe(own.totals[0].net_worth);
    expect(nw).toMatchObject({ detail: 'total', currency: 'USD', as_of: TODAY, from: daysAgo(2), other_currencies: [], without_balance: 0 });
    expect(nw.history).toBeUndefined();
    expect(nw.accounts).toEqual([
      { label: 'Broker IRA ••4444', balance: 20_500, currency: 'USD', debt: false, as_of: daysAgo(2) },
      { label: 'Cash Wallet', balance: 40, currency: 'USD', debt: false, as_of: TODAY },
      { label: 'Chase Card ••2222', balance: 310, currency: 'USD', debt: true, as_of: daysAgo(1) },
      { label: 'Chase Checking ••1111', balance: 1250, currency: 'USD', debt: false, as_of: daysAgo(1) },
      { label: 'Property House', balance: 300_000, currency: 'USD', debt: false, as_of: TODAY },
    ]);
    // They add up to the total, a debt taken away.
    expect(nw.accounts.reduce((s: number, a: any) => s + (a.debt ? -a.balance : a.balance), 0)).toBe(nw.total);
  });

  test('with its accounts, only those whose balances the account rows share: never one set to Not shared or That it exists', async () => {
    await shareViews({ net_worth: { detail: 'total', accounts: true } }, { acc_chk: 'balance', acc_card: 'exists', acc_ira: 'transactions' });
    const [seen] = await partnerSees();
    expect(seen.views.net_worth.accounts.map((a: any) => a.label)).toEqual(['Broker IRA ••4444', 'Chase Checking ••1111']);
    // The card shows that it exists, and nothing of its balance anywhere; the
    // house and the wallet, not shared, aren't named at all.
    expect(seen.accounts.find((a: any) => a.id === 'acc_card')).toMatchObject({ level: 'exists', balance: null });
    expect(JSON.stringify(seen)).not.toMatch(/House|Wallet|Property|"balance":310|300000|"balance":40\b/);
    // The total is still the whole net worth.
    expect(seen.views.net_worth.total).toBe(321_480);
    // None shared at a balance: none listed.
    await shareViews({ net_worth: { detail: 'total', accounts: true } }, { acc_chk: 'exists', acc_card: 'none', acc_ira: 'none' });
    expect((await partnerViews()).net_worth.accounts).toEqual([]);
  });

  test('its history is the owner’s chart, hidden accounts subtracted, a point a week', async () => {
    await shareViews({ net_worth: { detail: 'history', accounts: false } });
    const nw = (await partnerViews()).net_worth;
    const own = await readNetWorthAndHistory(ctx, { includeEstimated: true, interval: 'week' });
    expect(nw.history).toEqual(own.history.points.map((p) => ({ date: p.date, value: p.value, ...(p.estimated ? { estimated: true } : {}) })));
    // The estimated point of the week before, marked as such (Savings was never
    // in the estimated layer, so nothing comes off it), then two recorded days
    // in one week: the last of them, Savings' 5,000.00 taken out.
    expect(nw.history).toEqual([
      { date: daysAgo(10), value: 320_000, estimated: true },
      { date: daysAgo(2), value: 1200 - 300 + 20_500 + 300_000 },
    ]);
  });

  test('without its accounts, no account is named', async () => {
    await shareViews({ net_worth: { detail: 'history', accounts: false } });
    const seen = await partnerSees();
    expect(seen[0].accounts).toEqual([]);
    expect(seen[0].views.net_worth.accounts).toBeUndefined();
    expect(JSON.stringify(seen)).not.toMatch(/Checking|Card|Savings|IRA|Wallet|House|Broker|Chase|Property|acc_|manual_|1111|2222|4444/);
  });

  test('an account in another currency is left out of the total and named by its currency', async () => {
    await fake.hset(ctxKey('accounts:meta'), {
      item_chase: await encrypt(
        ctx,
        JSON.stringify([
          { account_id: 'acc_chk', name: 'Checking', type: 'depository', subtype: 'checking', mask: '1111', limit: null, official_name: null, currency: 'USD' },
          { account_id: 'acc_card', name: 'Card', type: 'credit', subtype: 'credit card', mask: '2222', limit: 5000, official_name: null, currency: 'EUR' },
          { account_id: 'acc_save', name: 'Savings', type: 'depository', subtype: 'savings', mask: '3333', limit: null, official_name: null, currency: 'USD' },
        ])
      ),
    });
    await shareViews({ net_worth: { detail: 'total', accounts: false } });
    const nw = (await partnerViews()).net_worth;
    expect(nw.total).toBe(1250 + 20_500 + 300_000 + 40);
    expect(nw.other_currencies).toEqual([{ currency: 'EUR', accounts: 1 }]);
  });
});

describe('spending', () => {
  test('money out by group and category, each month, by the spending rule, in one currency with what it left out named, to the cent', async () => {
    await shareViews({ spending: { detail: 'amounts', by: 'category' } });
    const sp = (await partnerViews()).spending;
    expect(sp).toMatchObject({ detail: 'amounts', by: 'category', currency: 'USD' });
    // From the first month with a transaction (the oldest of the
    // subscription's) to this one, so far.
    expect(sp.months.map((m: any) => [m.month, m.so_far])).toEqual(monthsBack(MONTH, monthOf(dateOf('t_flix2'))).map((m) => [m, m === MONTH]));
    for (const m of sp.months) {
      expect(m.total).toBe(spentIn(m.month));
      // The same figures the owner's own totals give for the month, group by
      // group and category by category.
      const own = await readSpending(ctx, { from: `${m.month}-01`, to: `${m.month}-31` });
      expect(m.total).toBe(own.money_out);
      expect(m.groups.map((g: any) => [g.name, g.amount])).toEqual(own.groups.map((g) => [g.name, g.spent]));
      const categories = m.groups.flatMap((g: any) => g.categories.map((c: any) => [c.name.toLowerCase(), c.amount]));
      expect(categories.sort()).toEqual(own.categories.map((c) => [c.category.toLowerCase(), c.spent]).sort());
      for (const g of m.groups) {
        expect(g.pct).toBe(Math.round((g.amount / m.total) * 100));
        expect(g.label).toBe(g.pct === 0 ? '<1%' : g.pct === 100 && g.amount < m.total ? '>99%' : `${g.pct}%`);
        expect(g.categories.reduce((s: number, c: any) => s + c.amount, 0)).toBeCloseTo(g.amount, 8);
      }
      // The euros are named in their month, by their currency alone, and
      // added nowhere.
      expect(m.left_out).toBe(m.month === monthOf(dateOf('t_paris')) ? 'What went out in EUR isn’t in these totals, which are in USD.' : null);
    }
    // Everything, to the cent.
    expect(tidy(sp.months.reduce((s: number, m: any) => s + m.total, 0))).toBe(tidy(5.5 + 1200 + 35 + 80 + 12 + 25 + 3 * 15.99));
  });

  test('as percentages, no amount anywhere, and by group, no category', async () => {
    await shareViews({ spending: { detail: 'shares', by: 'group' } });
    const sp = (await partnerViews()).spending;
    for (const m of sp.months) {
      expect(m.total).toBeUndefined();
      for (const g of m.groups) {
        expect(Object.keys(g).sort()).toEqual(['label', 'name', 'pct']);
      }
    }
    expect(JSON.stringify(sp)).not.toMatch(/1357|1200|15\.99/);
  });

  test('what another currency left out is money out only, named by its currency alone: never money in, nor how many', async () => {
    // Two paychecks in euros on the coffee's day.
    const day = dateOf('t_coffee');
    await chaseTxnsWith([1, 2].map((i) => ({ ...txn(`t_eur_pay${i}`, 'acc_chk', 0, -2000, { iso_currency_code: 'EUR', category: 'income' }), date: day })));
    await shareViews({ spending: { detail: 'shares', by: 'group' } });
    const sp = (await partnerViews()).spending;
    const m = sp.months.find((x: any) => x.month === monthOf(day));
    expect(m.left_out).toBe(monthOf(day) === monthOf(dateOf('t_paris')) ? 'What went out in EUR isn’t in these totals, which are in USD.' : null);
    for (const x of sp.months) expect(x.left_out ?? '').not.toMatch(/\d/);
    // The owner's own totals count the paychecks among what they left out; the share never does.
    const own = await readSpending(ctx, { from: `${m.month}-01`, to: `${m.month}-31` });
    expect(own.left_out.find((l) => l.currency === 'EUR')!.count).toBeGreaterThanOrEqual(2);
  });

  test('a transaction whose exclusion can’t be read is counted, as the owner’s Activity tab counts it, and its month says so', async () => {
    await shareViews({ spending: { detail: 'amounts', by: 'group' }, budgets: { detail: 'amounts', by: 'group' } });
    // The excluded $2,000.00 purchase's record damaged.
    await fake.hset(ctxKey('transaction-annotations'), { t_big: 'garbage' });
    const v = await quietly(partnerViews);
    const month = monthOf(dateOf('t_big'));
    const m = v.spending.months.find((x: any) => x.month === month);
    expect(m.exclusions_unknown).toBe(true);
    const own = await quietly(() => readSpending(ctx, { from: `${month}-01`, to: `${month}-31` }));
    expect(own.exclusion_unknown).toBeGreaterThan(0);
    expect(m.total).toBe(own.money_out);
    expect(m.total).toBe(tidy(spentIn(month) + 2000));
    for (const x of v.spending.months) if (x.month !== month) expect(x.exclusions_unknown).toBeUndefined();
    // The budgets say that month may be off.
    expect(v.budgets.months.find((x: any) => x.month === month).may_be_incomplete).toBe(true);
  });

  test('a bank account whose transactions don’t come in leaves spending that may be short, and says so', async () => {
    await shareViews({ spending: { detail: 'amounts', by: 'group' } });
    expect((await partnerViews()).spending.may_be_incomplete).toBeUndefined();
    await connectWithoutTransactions(fake, { item_id: 'item_refused', name: 'Refused Bank', accounts: [{ account_id: 'acc_ref', type: 'depository' }], refused: { code: 'PRODUCTS_NOT_SUPPORTED' } });
    const sp = (await quietly(partnerViews)).spending;
    expect(sp.unreadable).toBeUndefined();
    expect(sp.may_be_incomplete).toBe(true);
  });

  test('never a transaction, its merchant, note, tags, split parts or group', async () => {
    const categories = (await as('user_owner', () => route('categories', 'GET'))).body.categories;
    const id = (name: string) => categories.categories.find((c: any) => c.name === name).id;
    // A split of the rent and a group of two of them, each the owner's own.
    expect((await as('user_owner', () => route('transaction-splits', 'PUT', { transaction_id: 't_rent', parts: [{ amount: 1000, category_id: id('rent and utilities'), note: 'SECRET-PART-NOTE' }, { amount: 200, category_id: id('travel') }] }))).status).toBe(200);
    expect((await as('user_owner', () => route('transaction-groups', 'POST', { name: 'SECRET-GROUP-NAME', category_id: id('food and drink'), members: ['t_coffee', 't_posted'] }))).status).toBe(200);
    await shareViews({ spending: { detail: 'amounts', by: 'category' }, budgets: { detail: 'amounts', by: 'category' } });
    const text = JSON.stringify([await partnerSees(), (await previewOf()).body]);
    expect(text).toContain('"spending"');
    for (const secret of ['SECRET', 't_coffee', 't_rent', 't_posted', 'Blue Bottle', 'Coffee place', 'BLUE BOTTLE', 'Farmers market', 'apples', 'NETFLIX', 'Netflix', 'Posted lunch', 'acc_chk', 'manual_wallet', 'transactions', 'merchant', 'split', 'members']) {
      expect(text).not.toContain(secret);
    }
    // The split counts as its parts, and the group once, at its net, on its
    // day, by the owner's own rule: everything spent is as before.
    const months = (await partnerViews()).spending.months;
    expect(tidy(months.reduce((s: number, m: any) => s + m.total, 0))).toBe(tidy(5.5 + 1200 + 35 + 80 + 12 + 25 + 3 * 15.99));
  });
});

describe('holdings', () => {
  test('by asset class and tax bucket from the positions last recorded, with the positions when chosen, never an account', async () => {
    await shareViews({ holdings: { detail: 'amounts', positions: true } });
    const h = (await partnerViews()).holdings;
    // The IRA's 20,500.00: its 20,000.00 of VTI, and 500.00 no position explains.
    expect(h).toMatchObject({ detail: 'amounts', currency: 'USD', total: 20_500 });
    expect(h.classes).toEqual([
      { slot: 'us-stocks', name: 'US stocks', pct: 98, label: '98%', amount: 20_000 },
      { slot: 'unclassified', name: 'Unclassified', pct: 2, label: '2%', amount: 500 },
    ]);
    expect(h.buckets).toEqual([{ slot: 'tax-deferred', name: 'Tax-deferred', pct: 100, label: '100%', amount: 20_500 }]);
    expect(h.positions).toEqual([{ ticker: 'VTI', name: 'Vanguard Total Stock Market ETF', class: 'US stocks', pct: 98, label: '98%', amount: 20_000 }]);
    // The newest and the oldest day it is from: the positions', and the balance's.
    expect(h.from <= h.as_of).toBe(true);
    expect(h.notes.join(' ')).toContain('Unclassified');
    const text = JSON.stringify(await partnerSees());
    for (const never of ['acc_ira', 'IRA', 'Broker', '4444', 'sec_vti', '15000', '"quantity"', '"price"', 'cost']) expect(text).not.toContain(never);
  });

  test('with the owner’s own buckets and splits, and as percentages, no amount', async () => {
    await allocationSettingsStore.set(ctx, { v: 1, buckets: [{ account_id: 'acc_ira', bucket: 'roth' }], funds: [], accounts: [{ account_id: 'acc_ira', split: { bonds: 100 } }], target: null });
    await shareViews({ holdings: { detail: 'shares', positions: false } });
    const h = (await partnerViews()).holdings;
    // The unlisted 500.00 is the owner's split's: bonds.
    expect(h.classes).toEqual([
      { slot: 'us-stocks', name: 'US stocks', pct: 98, label: '98%' },
      { slot: 'bonds', name: 'Bonds', pct: 2, label: '2%' },
    ]);
    expect(h.buckets).toEqual([{ slot: 'roth', name: 'Roth', pct: 100, label: '100%' }]);
    expect(h.total).toBeUndefined();
    expect(h.positions).toBeUndefined();
  });
});

describe('holdings: what isn’t counted is said', () => {
  test('an investment account with no balance yet and no position, never counted as nothing', async () => {
    const meta = (a: Record<string, unknown>) => ({ official_name: null, subtype: null, mask: null, limit: null, currency: 'USD', ...a });
    await fake.hset(ctxKey('accounts:meta'), {
      item_broker: await encrypt(
        ctx,
        JSON.stringify([meta({ account_id: 'acc_ira', name: 'IRA', type: 'investment', subtype: 'ira', mask: '4444' }), meta({ account_id: 'acc_roth', name: 'Roth', type: 'investment', subtype: 'roth', mask: '5555' })])
      ),
    });
    await shareViews({ holdings: { detail: 'shares', positions: false } });
    const h = (await partnerViews()).holdings;
    expect(h.notes).toContain('1 investment account has no balance yet and no position, so it isn’t counted.');
    expect(JSON.stringify(h)).not.toMatch(/Roth|5555|acc_roth/);
  });
});

describe('budgets', () => {
  test('this month and last, spent against what is available, by group and category, as the Budgets tab counts them', async () => {
    await shareViews({ budgets: { detail: 'amounts', by: 'category' } });
    const b = (await partnerViews()).budgets;
    expect(b.months.map((m: any) => m.month)).toEqual([MONTH, addMonths(MONTH, -1)]);
    for (const m of b.months) {
      // Food and drink (coffee, lunch, the market) against 100.00, housing (the
      // rent) against 1,500.00, travel against 200.00 (its euros left out).
      const spent = budgetSpent(m.month);
      const pct = Math.round((spent / 1800) * 100);
      expect(m.total).toEqual({ name: 'All budgets', spent, limit: 1800, pct, label: spent > 0 && pct === 0 ? '<1%' : `${pct}%`, over: false });
      const own = await readBudgets(ctx, { month: m.month });
      expect(m.total.spent).toBe(own.total.spent);
      const lines = m.groups.flatMap((g: any) => g.categories);
      expect(lines.map((c: any) => [c.name.toLowerCase(), c.spent, c.limit]).sort()).toEqual(own.budgets.map((x) => [x.category.toLowerCase(), x.spent, x.available]).sort());
      const food = spentIn(m.month, ['t_rent', 't_fee', 't_card', 't_flix0', 't_flix1', 't_flix2']);
      expect(lines.find((c: any) => c.name === 'Food and drink')).toEqual({
        name: 'Food and drink',
        spent: food,
        limit: 100,
        pct: Math.round(food),
        label: food > 0 && Math.round(food) === 0 ? '<1%' : `${Math.round(food)}%`,
        over: false,
      });
      // What the owner's own budgets leave out, by currency alone: never how many.
      expect(m.left_out).toBe(own.left_out.length > 0 ? `What was spent in ${own.left_out.map((l) => l.currency).join(' and ')} isn’t in these budgets, which are in USD.` : null);
    }
  });

  test('as progress, money that is there never reads 0%: a little spent against a large budget is <1%', async () => {
    await setBudgets(ctx, { 'food and drink': 100_000, housing: 1500, travel: 200 });
    await shareViews({ budgets: { detail: 'progress', by: 'category' } });
    const b = (await partnerViews()).budgets;
    for (const m of b.months) {
      const food = m.groups.flatMap((g: any) => g.categories).find((c: any) => c.name === 'Food and drink');
      const spent = spentIn(m.month, ['t_rent', 't_fee', 't_card', 't_flix0', 't_flix1', 't_flix2']);
      expect(food).toEqual({ name: 'Food and drink', pct: 0, label: spent > 0 ? '<1%' : '0%', over: false });
    }
  });

  test('as progress: how much of each is spent, and whether over, never an amount', async () => {
    await shareViews({ budgets: { detail: 'progress', by: 'group' } });
    const b = (await partnerViews()).budgets;
    for (const m of b.months) {
      expect(Object.keys(m.total).sort()).toEqual(['label', 'name', 'over', 'pct']);
      for (const g of m.groups) expect(Object.keys(g).sort()).toEqual(['label', 'name', 'over', 'pct']);
    }
  });
});

describe('goals', () => {
  test('the chosen ones, with progress, target and when each will be reached; never the rate behind it, nor a goal not chosen or on a hidden account', async () => {
    await saveGoals();
    await shareViews({ goals: { detail: 'amounts', goals: [GOAL(1), GOAL(2), GOAL(3)] } });
    const g = (await partnerViews()).goals;
    const own = (await readGoals(ctx)).goals;
    const rainy = own.find((x) => x.id === GOAL(1))!;
    expect(g.goals).toEqual([
      {
        name: 'Rainy day',
        state: 'tracked',
        pct: 33,
        label: '33%',
        currency: 'USD',
        target: 3000,
        saved: 1000,
        target_date: '2030-01-31',
        outlook: { status: rainy.projection!.status, completion: rainy.projection!.completion_month, beyond: false, date_passed: false },
        as_of: daysAgo(1),
      },
      { name: 'Someday', state: 'untracked', pct: null, label: null, currency: null, target: 800, target_date: null, outlook: null, as_of: null },
    ]);
    const text = JSON.stringify(await partnerSees());
    for (const never of ['SECRET', 'monthly_target', 'rate', 'needed', 'short', 'should_have', 'allocation', '"100"', GOAL(1), 'acc_chk']) expect(text).not.toContain(never);
  });

  test('a goal with nothing saved yet reads 0%, never <1%', async () => {
    await saveManualAccount(ctx, { account_id: 'manual_jar', name: 'Jar', institution_name: 'Cash', type: 'depository', subtype: 'cash', balance: 0, updated_at: NOW.toISOString() });
    const res = await as('user_owner', () =>
      route('goals', 'PUT', { goals: [{ id: GOAL(7), name: 'New fund', target: 500, account_id: 'manual_jar', plan: { monthly_target: 50 } }] })
    );
    expect(res.status).toBe(200);
    await shareViews({ goals: { detail: 'progress', goals: [GOAL(7)] } });
    const [fund] = (await partnerViews()).goals.goals;
    expect(fund).toMatchObject({ name: 'New fund', state: 'tracked', pct: 0, label: '0%' });
  });

  test('as progress, no amount', async () => {
    await saveGoals();
    await shareViews({ goals: { detail: 'progress', goals: [GOAL(1)] } });
    const [rainy] = (await partnerViews()).goals.goals;
    expect(rainy.pct).toBe(33);
    expect(rainy.saved).toBeUndefined();
    expect(rainy.target).toBeUndefined();
  });

  test('a goals share whose every goal chosen is on a hidden account shows nothing, as a share of hidden accounts does, and records nothing', async () => {
    await saveGoals();
    await shareViews({ goals: { detail: 'progress', goals: [GOAL(2)] } });
    expect(await partnerSees()).toEqual([]);
    expect((await previewOf()).body).toEqual({ connection: pair, view: null });
    const log = await fake.hget<any>(testKey('connections'), `${pair}|log`);
    expect(await accessLogStore.get(ctx, log.id)).toBeNull();
  });

  test('only goals of the owner’s, not archived, can be chosen; one already chosen stays chosen', async () => {
    await saveGoals();
    expect((await shareViews({ goals: { detail: 'progress', goals: ['someone-elses-goal'] } })).status).toBe(409);
    expect((await shareViews({ goals: { detail: 'progress', goals: [GOAL(1)] } })).status).toBe(200);
    // Goals that can't be read: a goal already chosen keeps the share saving.
    await fake.set(ctxKey('goals'), 'garbage');
    expect((await quietly(() => shareViews({ goals: { detail: 'amounts', goals: [GOAL(1)] } }))).status).toBe(200);
    const added = await quietly(() => shareViews({ goals: { detail: 'amounts', goals: [GOAL(1), GOAL(3)] } }));
    expect(added.status).toBe(409);
    expect(added.body.unreadable).toBe(true);
  });
});

describe('what the owner’s screens leave out stays out', () => {
  test('an account that ended counts from its day in nothing, as everywhere in the app', async () => {
    await markEnded(ctx, 'acc_card', { state: 'closed', on: dateOf('t_card') }, { type: 'credit', label: { name: 'Card', institution: 'Chase', mask: '2222' }, item_id: 'item_chase' });
    await shareViews({ net_worth: { detail: 'total', accounts: true }, spending: { detail: 'amounts', by: 'group' } }, { acc_chk: 'balance', acc_card: 'balance' });
    const v = await partnerViews();
    expect(v.net_worth.total).toBe(1250 + 20_500 + 300_000 + 40);
    expect(v.net_worth.accounts.map((a: any) => a.label)).toEqual(['Chase Checking ••1111']);
    // The card's purchase on its end day is left out with it.
    for (const m of v.spending.months) expect(m.total).toBe(spentIn(m.month, ['t_card']));
  });

  test('a goal on an account that ended says so, with the day', async () => {
    await saveGoals();
    await markEnded(ctx, 'acc_chk', { state: 'closed', on: daysAgo(1) }, { type: 'depository', label: { name: 'Checking', institution: 'Chase', mask: '1111' }, item_id: 'item_chase' });
    await shareViews({ goals: { detail: 'amounts', goals: [GOAL(1)] } });
    expect((await partnerViews()).goals.goals).toEqual([
      { name: 'Rainy day', state: 'ended', pct: null, label: null, currency: 'USD', target: 3000, target_date: '2030-01-31', outlook: null, as_of: null, ended_on: daysAgo(1) },
    ]);
  });
});

describe('what can’t be read', () => {
  const all = {
    net_worth: { detail: 'history', accounts: true },
    spending: { detail: 'amounts', by: 'category' },
    holdings: { detail: 'amounts', positions: true },
    budgets: { detail: 'amounts', by: 'category' },
    goals: { detail: 'amounts', goals: [GOAL(1)] },
  };
  const unreadable = (v: any) => Object.entries(v).filter(([, x]: any) => x.unreadable).map(([k]) => k);
  beforeEach(saveGoals);

  test('each kind says so on its own, never a short figure, and the rest is shown', async () => {
    expect((await shareViews(all, { acc_chk: 'balance' })).status).toBe(200);
    expect(unreadable(await partnerViews())).toEqual([]);
    // The budgets.
    await fake.set(ctxKey('budgets'), 'garbage');
    expect(unreadable(await quietly(partnerViews))).toEqual(['budgets']);
    // And the goals, and the allocation settings.
    await fake.set(ctxKey('goals'), 'garbage');
    await fake.set(ctxKey('allocation-settings'), 'garbage');
    const v = await quietly(partnerViews);
    expect(unreadable(v)).toEqual(['holdings', 'budgets', 'goals']);
    expect(v.budgets).toEqual({ unreadable: true });
    // The accounts and the rest are still shown.
    expect((await quietly(partnerSees))[0].accounts.map((a: any) => a.id)).toEqual(['acc_chk']);
    expect(v.net_worth.total).toBe(321_480);
  });

  test('a bank’s stored transactions that can’t be read: spending and budgets say so', async () => {
    await shareViews(all);
    await fake.set(ctxKey('txns:item_chase'), 'garbage');
    expect(unreadable(await quietly(partnerViews))).toEqual(['spending', 'budgets']);
  });

  test('a manual account’s book that can’t be read: spending and budgets say so', async () => {
    await shareViews(all);
    await fake.hset(ctxKey('manual-transactions'), { manual_wallet: 'garbage' });
    expect(unreadable(await quietly(partnerViews))).toEqual(['spending', 'budgets']);
  });

  test('rows imported from files into a linked account that can’t be read: spending and budgets say so', async () => {
    await shareViews(all);
    await fake.hset(ctxKey('imported-transactions'), { acc_chk: 'garbage' });
    expect(unreadable(await quietly(partnerViews))).toEqual(['spending', 'budgets']);
  });

  test('a connection not loaded yet: net worth and holdings can’t be whole, so say so', async () => {
    await fake.hset(ctxKey('plaid:items'), { item_new: JSON.stringify({ item_id: 'item_new', institution_name: 'NewBank', encrypted_access_token: await encrypt(ctx, 'x') }) });
    await shareViews(all);
    expect(unreadable(await quietly(partnerViews))).toEqual(['net_worth', 'holdings']);
  });

  test('the preview says the same, kind by kind', async () => {
    await shareViews(all);
    await fake.set(ctxKey('budgets'), 'garbage');
    const preview = await quietly(() => previewOf());
    expect(preview.status).toBe(200);
    expect(preview.body.view.views.budgets).toEqual({ unreadable: true });
    expect(preview.body.view.views).toEqual(await quietly(partnerViews));
  });

  test('storage out of reach says nothing about the data: the preview couldn’t be shown, never that nothing is', async () => {
    await shareViews({ budgets: all.budgets });
    fake.failNext('hgetall', 50);
    const preview = await quietly(() => previewOf());
    expect(preview.status).toBe(500);
    expect(preview.body).toEqual({ error: 'Could not show what they see' });
  });
});

describe('the preview', () => {
  test('is exactly what they see, and says what they could work out from all of it together', async () => {
    await saveGoals();
    await shareViews(
      { net_worth: { detail: 'history', accounts: false }, spending: { detail: 'amounts', by: 'group' }, holdings: { detail: 'shares', positions: false }, goals: { detail: 'amounts', goals: [GOAL(1), GOAL(5)] } },
      { acc_ira: 'balance' }
    );
    const [seen] = await partnerSees();
    const preview = (await previewOf()).body;
    expect(preview.view.views).toEqual(seen.views);
    expect(preview.view.accounts).toEqual(seen.accounts);
    expect(preview.inferences.map((i: any) => i.id)).toEqual(['net_worth_rest', 'income', 'goal_contribution', 'holdings_total']);
    const said = (id: string) => preview.inferences.find((i: any) => i.id === id).text;
    expect(said('net_worth_rest')).toBe('They see your net worth and the balance of Broker IRA ••4444, so they can work out what your other accounts add up to.');
    expect(said('holdings_total')).toContain('the balance of Broker IRA ••4444');
    // Only the goal projected: Rainy day's pace says nothing has gone in lately.
    expect(said('goal_contribution')).toBe('From the progress of Retire and when it is projected to be reached, they can work out about how much goes into it a month.');
    // Theirs only: never in what they are sent.
    expect(JSON.stringify(seen)).not.toContain('inferences');
  });

  test('a net worth beside holdings in amounts gives what the accounts besides the investments add up to; a goal’s account listed in a net worth gives its target', async () => {
    await saveGoals();
    await shareViews({ net_worth: { detail: 'total', accounts: false }, holdings: { detail: 'amounts', positions: false } });
    const said = (await previewOf()).body.inferences;
    expect(said).toEqual([
      { id: 'net_worth_rest', text: 'They see your net worth and your holdings in amounts, so they can work out about what your accounts besides your investments add up to.' },
    ]);
    // Rainy day, as progress, counts checking, whose balance a net worth with
    // its accounts lists only because checking's own share shows it.
    await shareViews({ net_worth: { detail: 'total', accounts: true }, holdings: null, goals: { detail: 'progress', goals: [GOAL(1)] } }, { acc_chk: 'balance' });
    const preview = (await previewOf()).body;
    expect(preview.view.views.net_worth.accounts.map((a: any) => a.label)).toEqual(['Chase Checking ••1111']);
    expect(preview.inferences.map((i: any) => i.id)).toContain('goal_target');
    expect(preview.inferences.find((i: any) => i.id === 'goal_target').text).toBe('From the progress of Rainy day and the balance of Chase Checking ••1111, they may be able to work out its target.');
  });

  test('when what they could work out can’t be worked out, it says so, and still shows what they see', async () => {
    await saveGoals();
    await shareViews({ goals: { detail: 'progress', goals: [GOAL(1)] } });
    // A manual account's record damaged: the goals still read (that account's
    // goal says it can't be), but the accounts the warnings go by can't.
    await fake.hset(ctxKey('manual:accounts'), { manual_wallet: 'garbage' });
    const preview = await quietly(() => previewOf());
    expect(preview.status).toBe(200);
    expect(preview.body.inferences_unavailable).toBe(true);
    expect(preview.body.view.views.goals.goals.map((g: any) => g.name)).toEqual(['Rainy day']);
    expect(preview.body.view.views).toEqual((await quietly(partnerSees))[0].views);
  });

  test('records nothing, and changes nothing of the owner’s data: the preview is only counted against their own limit on reads', async () => {
    await saveGoals();
    await shareViews({ net_worth: { detail: 'history', accounts: true }, spending: { detail: 'amounts', by: 'category' }, holdings: { detail: 'amounts', positions: true }, budgets: { detail: 'amounts', by: 'category' }, goals: { detail: 'amounts', goals: [GOAL(1)] } });
    const was = ownerData();
    await previewOf();
    const counted = ctxKey('sharing-reads');
    const { [counted]: reads, ...rest } = ownerData();
    expect(reads).toBe('1');
    expect(rest).toEqual(was);
    // Their own read changes nothing either, but their record of showings
    // (their read is counted in their own container).
    const before = ownerData();
    await partnerSees();
    const after = ownerData();
    const changed = Object.keys(after).filter((k) => after[k] !== before[k]);
    expect(changed.every((k) => k.startsWith(`${ctxKey('sharing-access-log')} `))).toBe(true);
    expect(changed).toHaveLength(1);
  });
});

describe('ends and the record of showings', () => {
  test('a share that ends shows none of its kinds from its end, and reads nothing for them', async () => {
    await shareViews({ net_worth: { detail: 'total', accounts: false }, budgets: { detail: 'amounts', by: 'group' } });
    await share({ expires_at: new Date(NOW.getTime() + 3_600_000).toISOString() });
    expect(Object.keys(await partnerViews())).toEqual(['net_worth', 'budgets']);
    setSystemTime(new Date(NOW.getTime() + 3_600_000));
    // Anything of the owner's read now would fail: nothing is.
    await fake.set(ctxKey('budgets'), 'garbage');
    fake.failNext('hgetall', 0);
    expect(await partnerSees()).toEqual([]);
    expect((await previewOf()).body).toEqual({ connection: pair, view: null });
  });

  test('each showing counts the kinds it showed, at the detail shown, the widest in its quarter hour; a kind that couldn’t be read showed nothing', async () => {
    await shareViews({ net_worth: { detail: 'total', accounts: false }, spending: { detail: 'shares', by: 'group' } }, { acc_chk: 'balance' });
    await partnerSees();
    await shareViews({ net_worth: { detail: 'history', accounts: false }, budgets: { detail: 'progress', by: 'group' } }, { acc_chk: 'balance' });
    await fake.set(ctxKey('budgets'), 'garbage');
    await quietly(partnerSees);
    const logId = (await fake.hget<any>(testKey('connections'), `${pair}|log`)).id;
    const record = await accessLogStore.get(ctx, logId);
    expect(record!.shown).toEqual([
      { at: NOW.toISOString(), times: 2, read: { acc_chk: 'balance' }, views: { net_worth: { detail: 'history', accounts: false }, spending: { detail: 'shares', by: 'group' } } },
    ]);
    // Both of them see it, by day, with the kinds.
    const records = await as('user_owner', () => route('connections/records', 'GET', undefined, `?id=${pair}&tz=UTC`));
    expect(records.body.shown_to_them.days).toEqual([
      { day: TODAY, times: 2, levels: { exists: 0, balance: 1, transactions: 0 }, views: { net_worth: { detail: 'history', accounts: false }, spending: { detail: 'shares', by: 'group' } } },
    ]);
  });

  test('a showing keeps what else each kind showed, and which goals: the accounts in a net worth, the categories, the positions', async () => {
    await saveGoals();
    await shareViews(
      {
        net_worth: { detail: 'total', accounts: true },
        spending: { detail: 'amounts', by: 'category' },
        holdings: { detail: 'shares', positions: true },
        budgets: { detail: 'progress', by: 'category' },
        // One on a hidden account, shown to nobody: not in the record either.
        goals: { detail: 'progress', goals: [GOAL(3), GOAL(1), GOAL(2)] },
      },
      { acc_chk: 'balance' }
    );
    await partnerSees();
    const logId = (await fake.hget<any>(testKey('connections'), `${pair}|log`)).id;
    const [row] = (await accessLogStore.get(ctx, logId))!.shown;
    expect(row.views).toEqual({
      net_worth: { detail: 'total', accounts: true },
      spending: { detail: 'amounts', by: 'category' },
      holdings: { detail: 'shares', positions: true },
      budgets: { detail: 'progress', by: 'category' },
      goals: { detail: 'progress', goals: [GOAL(1), GOAL(3)] },
    });
    // The drawer's day counts the goals, never names them.
    const records = await as('user_owner', () => route('connections/records', 'GET', undefined, `?id=${pair}&tz=UTC`));
    expect(records.body.shown_to_them.days[0].views.goals).toEqual({ detail: 'progress', count: 2 });
  });

  test('a record a release from before kinds wrote still reads, and one with a kind this release doesn’t know is unrecognised, never read as less', async () => {
    await shareViews({ net_worth: { detail: 'total', accounts: false } });
    await partnerSees();
    const logId = (await fake.hget<any>(testKey('connections'), `${pair}|log`)).id;
    const before = new Date(NOW.getTime() - 15 * 60_000).toISOString();
    await accessLogStore.set(ctx, logId, { shown: [{ at: before, times: 1, read: { acc_chk: 'balance' } }] });
    await partnerSees();
    expect((await accessLogStore.get(ctx, logId))!.shown.map((s) => s.views ?? null)).toEqual([null, { net_worth: { detail: 'total', accounts: false } }]);
    const later = await encrypt(ctx, JSON.stringify({ shown: [{ at: before, times: 1, read: {}, views: { bills: 'upcoming' } }] }));
    await fake.hset(ctxKey('sharing-access-log'), { [logId]: later });
    const err = await accessLogStore.get(ctx, logId).catch((e) => e);
    expect(err.unrecognised).toEqual([logId]);
  });
});

describe('storage, and what a release from before kinds reads', () => {
  // How the release before this one read and wrote a share (lib/sharing.ts
  // as it was): only its accounts, under "accounts", or with an end under
  // "expiring"; any other field passed over, and dropped when it wrote.
  const isLevel = (v: unknown) => v === 'exists' || v === 'balance' || v === 'transactions';
  const before = {
    parse(g: any): { accounts: Record<string, string>; expires_at: string | null; updated_at: string } | null {
      if (!g || typeof g !== 'object' || Array.isArray(g)) return null;
      const ending = 'expiring' in g || 'expires_at' in g;
      if (ending && 'accounts' in g) return null;
      const levels = ending ? g.expiring : g.accounts;
      if (typeof levels !== 'object' || levels === null || Array.isArray(levels)) return null;
      const accounts: Record<string, string> = {};
      for (const [id, level] of Object.entries(levels)) if (isLevel(level)) accounts[id] = level as string;
      return { accounts, updated_at: String(g.updated_at ?? ''), expires_at: ending ? g.expires_at : null };
    },
    store(s: { accounts: Record<string, string>; expires_at: string | null; updated_at: string }) {
      return JSON.stringify(s.expires_at === null ? { accounts: s.accounts, updated_at: s.updated_at } : { expiring: s.accounts, expires_at: s.expires_at, updated_at: s.updated_at });
    },
    /** From before ends: "accounts" alone. */
    parseFirst(g: any): Record<string, string> {
      return g && typeof g.accounts === 'object' && g.accounts !== null ? g.accounts : {};
    },
  };

  test('kinds are kept beside the accounts, under views, and the release before shares only the accounts', async () => {
    await shareViews({ net_worth: { detail: 'total', accounts: false }, goals: null }, { acc_chk: 'balance' });
    const raw = await storedShare();
    expect(raw).toEqual({ accounts: { acc_chk: 'balance' }, updated_at: NOW.toISOString(), views: { net_worth: { detail: 'total', accounts: false } } });
    expect(before.parse(raw)).toEqual({ accounts: { acc_chk: 'balance' }, updated_at: NOW.toISOString(), expires_at: null });
  });

  test('a change the release before saves drops the kinds: rolled forward again, they are no longer shared', async () => {
    await shareViews({ net_worth: { detail: 'total', accounts: false } }, { acc_chk: 'balance' });
    const old = before.parse(await storedShare())!;
    // It renews the share, as its drawer would.
    await fake.hset(testKey('connections'), { [`${pair}|share|user_owner`]: before.store({ ...old, expires_at: LATER }) });
    const [seen] = await partnerSees();
    expect(seen.views).toBeUndefined();
    expect(seen.accounts.map((a: any) => a.id)).toEqual(['acc_chk']);
    expect((await as('user_owner', () => route('connections', 'GET'))).body.connections[0].views).toEqual({});
  });

  test('a share of kinds alone is one of no accounts to the release before, and with an end nothing at all to the one before ends', async () => {
    await shareViews({ budgets: { detail: 'progress', by: 'group' } });
    expect(before.parse(await storedShare())).toMatchObject({ accounts: {} });
    await share({ expires_at: LATER });
    const raw = await storedShare();
    expect(raw).toEqual({ expiring: {}, expires_at: LATER, updated_at: NOW.toISOString(), views: { budgets: { detail: 'progress', by: 'group' } } });
    expect(before.parseFirst(raw)).toEqual({});
  });

  test('what a later release might write is shared as nothing: a kind it doesn’t know, or one narrowed by a field it doesn’t know', async () => {
    await fake.hset(testKey('connections'), {
      [`${pair}|share|user_owner`]: JSON.stringify({
        accounts: {},
        updated_at: NOW.toISOString(),
        views: { bills: { detail: 'upcoming' }, spending: { detail: 'amounts', by: 'group', except: ['medical'] }, budgets: { detail: 'progress', by: 'group' } },
      }),
    });
    expect(Object.keys(await partnerViews())).toEqual(['budgets']);
  });

  test('taking everything back ends the share, end and all; renewing needs something shared', async () => {
    await shareViews({ net_worth: { detail: 'total', accounts: false } });
    await share({ expires_at: LATER });
    expect((await shareViews({ net_worth: null })).status).toBe(200);
    expect(await storedShare()).toBeNull();
    expect((await share({ expires_at: EVEN_LATER })).status).toBe(409);
  });

  test('the owner’s download has their settings for each kind, never what it showed; the viewer’s, nothing of the owner’s', async () => {
    await saveGoals();
    await shareViews({ spending: { detail: 'amounts', by: 'group' }, goals: { detail: 'progress', goals: [GOAL(1)] } });
    await partnerSees();
    const { mySharing } = await import('@/lib/sharing');
    const mine = await mySharing('user_owner', ctx);
    expect(mine!.connections[0].shared_views).toEqual({ spending: { detail: 'amounts', by: 'group' }, goals: { detail: 'progress', goals: [GOAL(1)] } });
    expect(mine!.connections[0].shown_to_them![0].views).toEqual({ spending: { detail: 'amounts', by: 'group' }, goals: { detail: 'progress', goals: [GOAL(1)] } });
    expect(JSON.stringify(mine)).not.toMatch(/1357|Rainy day/);
    const partnerCtx = { container: await ownerContainer('user_partner') } as any;
    const theirs = await mySharing('user_partner', partnerCtx);
    expect(theirs!.connections[0].shared_views).toBeUndefined();
    // The owner's record of showings to them is about them: the kinds shown,
    // as they were shown, never a figure, a name or the owner's settings.
    expect(theirs!.connections[0].shown_to_me![0].views).toEqual({ spending: { detail: 'amounts', by: 'group' }, goals: { detail: 'progress', goals: [GOAL(1)] } });
    expect(JSON.stringify(theirs)).not.toMatch(/1357|Rainy|Food|Housing/);
  });
});

describe('the owner’s own month', () => {
  test('this month is the owner’s, in the time zone their weekly summary keeps; else by the UTC day', async () => {
    await shareViews({ spending: { detail: 'shares', by: 'group' }, budgets: { detail: 'progress', by: 'group' } });
    // The last evening of the month by UTC: in Kiritimati (UTC+14) the next has begun.
    const [y, mo] = MONTH.split('-').map(Number);
    const lastDay = new Date(Date.UTC(y, mo, 0)).toISOString().slice(0, 10);
    setSystemTime(new Date(`${lastDay}T20:00:00.000Z`));
    expect((await partnerViews()).spending.months[0].month).toBe(MONTH);
    await weeklySettingStore.set(ctx, { v: 1, enabled: false, weekday: 1, time_zone: 'Pacific/Kiritimati', updated_at: NOW.toISOString() });
    const v = await partnerViews();
    expect(v.spending.months[0]).toMatchObject({ month: addMonths(MONTH, 1), so_far: true, groups: [] });
    expect(v.spending.months[1]).toMatchObject({ month: MONTH, so_far: false });
    expect(v.budgets.months.map((m: any) => m.month)).toEqual([addMonths(MONTH, 1), MONTH]);
    // A zone this runtime doesn't know leaves the UTC day.
    await weeklySettingStore.set(ctx, { v: 1, enabled: false, weekday: 1, time_zone: 'Mars/Olympus_Mons', updated_at: NOW.toISOString() });
    expect((await partnerViews()).spending.months[0].month).toBe(MONTH);
  });
});

describe('the limit on reads', () => {
  test(`${SHARED_READS_PER_WINDOW} reads in ten minutes, the preview’s with them, then a 429 that says when; a count that can’t be read turns reads away`, async () => {
    await shareViews({ net_worth: { detail: 'total', accounts: false } });
    const partnerKey = ctxKey('sharing-reads').replace(ctx.container, (await ownerContainer('user_partner'))!);
    await fake.set(partnerKey, String(SHARED_READS_PER_WINDOW - 1));
    expect(await partnerSees()).toHaveLength(1);
    const refused = await as('user_partner', () => route('shared', 'GET'));
    expect(refused.status).toBe(429);
    expect(refused.body.error).toBe(`What is shared can be read ${SHARED_READS_PER_WINDOW} times in 10 minutes. Try again in 10 minutes.`);
    expect(refused.body.retry_after_seconds).toBeGreaterThan(0);
    // The one turned away read nothing, and recorded nothing.
    const logId = (await fake.hget<any>(testKey('connections'), `${pair}|log`)).id;
    expect((await accessLogStore.get(ctx, logId))!.shown.map((s) => s.times)).toEqual([1]);
    // The owner's preview counts in the owner's own container.
    await fake.set(ctxKey('sharing-reads'), String(SHARED_READS_PER_WINDOW));
    expect((await previewOf()).status).toBe(429);
    await fake.set(ctxKey('sharing-reads'), 'garbage');
    const unreadableCount = await quietly(() => previewOf());
    expect(unreadableCount.status).toBe(503);
    expect(unreadableCount.body.error).toContain('couldn’t be checked just now');
  });
});

describe('a viewer reaches nothing that isn’t shared with them', () => {
  test('one connection’s kinds are its own: someone else, connected or not, sees none of them', async () => {
    await shareViews({ net_worth: { detail: 'total', accounts: true }, spending: { detail: 'amounts', by: 'category' } });
    expect((await as('user_third', () => route('shared', 'GET'))).body.shared).toEqual([]);
    // Another person's data never shows on it.
    expect(JSON.stringify(await partnerSees())).not.toContain('OTHER-SECRET');
    // Sharing goes one way: the owner sees nothing of the partner's.
    expect((await as('user_owner', () => route('shared', 'GET'))).body.shared).toEqual([]);
  });

  test('removing or blocking the connection shows nothing, at once', async () => {
    await shareViews({ net_worth: { detail: 'total', accounts: false } });
    expect(await partnerSees()).toHaveLength(1);
    await as('user_owner', () => route('connections', 'DELETE', { id: pair, block: true }));
    expect(await partnerSees()).toEqual([]);
    expect((await previewOf()).status).toBe(409);
    expect(await storedShare()).toBeNull();
  });

  test('a change is checked whole: a kind or level this release doesn’t know is refused, and nothing of it saved', async () => {
    await shareViews({ net_worth: { detail: 'total', accounts: false } }, { acc_chk: 'balance' });
    const kept = await storedShare();
    for (const views of [{ bills: { detail: 'upcoming' } }, { net_worth: { detail: 'daily', accounts: false } }, { spending: { detail: 'amounts' } }, { goals: { detail: 'amounts', goals: [] } }, [], 'net_worth']) {
      const res = await share({ views, accounts: { acc_chk: 'transactions' } });
      expect(res.status).toBe(400);
      expect(typeof res.body.error).toBe('string');
    }
    expect(await storedShare()).toEqual(kept);
  });

  test('the drawer lists the goals that can be chosen, and says when they can’t be read, never failing because of them', async () => {
    await saveGoals();
    const listed = (await as('user_owner', () => route('connections', 'GET'))).body;
    expect(listed.goals.map((g: any) => g.name)).toEqual(['Rainy day', 'SECRET-HIDDEN-GOAL', 'Someday', 'SECRET-UNCHOSEN-GOAL', 'Retire']);
    expect(listed.accounts.find((a: any) => a.id === 'acc_ira').investment).toBe(true);
    expect(listed.accounts.find((a: any) => a.id === 'acc_chk').investment).toBeUndefined();
    await fake.set(ctxKey('goals'), 'garbage');
    const damaged = await quietly(() => as('user_owner', () => route('connections', 'GET')));
    expect(damaged.status).toBe(200);
    expect(damaged.body).toMatchObject({ goals: [], goals_unreadable: true });
    expect((await as('user_owner', () => route('connections', 'DELETE', { id: pair }))).status).toBe(200);
  });
});
