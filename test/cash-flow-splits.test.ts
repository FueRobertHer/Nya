import { describe, expect, test, mock, beforeEach, afterEach } from 'bun:test';
import './clerk-mock';
import { FakeRedis, storageMock, registerTestContainer, unscopedDataKeys } from './fake-redis';

// The cash flow (#41) over split and grouped transactions (#39), as the
// assembly gives them to the Activity tab and the API (lib/activity.ts,
// lib/split-rows.ts): held to the month's totals and the budgets' spending
// (lib/totals.ts summarize and spendingByCategory) to the cent, counts
// included, over every period and every month, with a charge split across
// two groups, splits the bank changed the amount of since (up and down), a
// group netting to an amount out, one netting to nothing and one netting to
// money in, and groups with a transaction on a hidden or an ended account;
// what a tap lists; and /api/v1/cash-flow beside /api/v1/spending.

process.env.PLAID_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
mock.module('@/lib/plaid', () => ({
  plaidClient: new Proxy(
    {},
    {
      get() {
        return async () => {
          throw new Error('Plaid must not be called');
        };
      },
    }
  ),
}));
const fake = new FakeRedis({ deserialize: true });
mock.module('@/lib/storage', () => storageMock(fake));
afterEach(() => expect(unscopedDataKeys(fake)).toEqual([]));

const { ctx, daysAgo, seedPerson } = await import('./api-fixture');
const { createToken } = await import('@/lib/api-tokens');
const { forgetEpochs } = await import('@/lib/sessions');
const { ensureTaxonomy } = await import('@/lib/category-store');
const { splitStore } = await import('@/lib/splits');
const { groupStore } = await import('@/lib/groups');
const { manualTxnStore } = await import('@/lib/manual-txns');
const { markEnded } = await import('@/lib/lifecycle');
const { readActivity } = await import('@/lib/api-read');
const { cashFlow, inPeriod, lastDayOf, periodOf, pickedRows, PERIODS } = await import('@/lib/cash-flow');
const { summarize, spendingByCategory, tidy } = await import('@/lib/totals');
const { countTransactions, totalsCurrency } = await import('@/lib/spending');
const { filedId } = await import('@/lib/categories');
const { bankRows } = await import('@/lib/split-rows');
const { localDate } = await import('@/lib/local-date');
const { wholeSplits } = await import('@/components/SplitRows');
const cashFlowRoute = await import('@/app/api/v1/cash-flow/route');
const spendingRoute = await import('@/app/api/v1/spending/route');

const NOW_ISO = new Date().toISOString();
const WALLET_ROW = 'manual-txn:5a0c1d2e-3f40-4a5b-8c6d-7e8f9a0b1c2d';
// Money back, on the wallet: Sam's half of lunch, a fee refunded, a payout.
const PAYBACK = 'manual-txn:6b1d2e3f-4a5b-4c6d-8e7f-0a1b2c3d4e5f';
const FEE_BACK = 'manual-txn:7c2e3f40-5b6c-4d7e-9f80-1b2c3d4e5f60';
const PAYOUT = 'manual-txn:8d3f4051-6c7d-4e8f-a091-2c3d4e5f6071';
const WALLET = { type: 'depository', label: { name: 'Wallet', institution: 'Cash', mask: null }, item_id: null };

let token = '';
let cat: (name: string) => string;
const saved = { ...process.env };
beforeEach(async () => {
  fake.reset();
  forgetEpochs();
  delete process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;
  delete process.env.CLERK_SECRET_KEY;
  delete process.env.CONTAINER_ID;
  await registerTestContainer(fake);
  await seedPerson(fake);
  token = (await createToken(ctx, 'Tests')).token;
  const taxonomy = await ensureTaxonomy(ctx);
  cat = (name) => taxonomy.categories.find((c) => c.name === name)!.id;
});
afterEach(() => {
  process.env = { ...saved };
});

/** The card's 80 split into food and a shelf (two groups); two months of
 *  Netflix split at a price the bank has changed since, up a dollar and
 *  down two; lunch Sam paid half of, a fee refunded in full and coffee a club
 *  paid out more than, each grouped. */
async function splitAndGroup() {
  const wallet = (await manualTxnStore.get(ctx, 'manual_wallet'))!;
  const manual = (id: string, days: number, amount: number, name: string) => ({
    id,
    account_id: 'manual_wallet',
    date: daysAgo(days),
    amount,
    currency: 'USD',
    name,
    category: null,
    note: null,
    source: 'manual',
    source_id: null,
    created_at: NOW_ISO,
    updated_at: NOW_ISO,
  });
  await manualTxnStore.set(ctx, 'manual_wallet', {
    ...wallet,
    rows: [...wallet.rows, manual(PAYBACK, 1, -6, 'SAM VENMO'), manual(FEE_BACK, 6, -35, 'FEE REFUND'), manual(PAYOUT, 2, -20, 'COFFEE CLUB')],
  });
  const split = (amount: number, parts: [string, number, string][]) => ({
    version: 1 as const,
    amount,
    currency: 'USD',
    parts: parts.map(([id, a, c]) => ({ id, amount: a, category_id: cat(c) })),
    updated_at: NOW_ISO,
  });
  await splitStore.set(ctx, 't_card', split(80, [['p-food', 50, 'food and drink'], ['p-home', 30, 'home improvement']]));
  await splitStore.set(ctx, 't_flix0', split(14.99, [['f0a', 10, 'entertainment'], ['f0b', 4.99, 'general merchandise']]));
  await splitStore.set(ctx, 't_flix1', split(17.99, [['f1a', 10, 'entertainment'], ['f1b', 7.99, 'general merchandise']]));
  const group = (id: string, name: string, category: string, members: string[], days: number) =>
    groupStore.set(ctx, id, { version: 1, name, category_id: cat(category), members, date: daysAgo(days), currency: 'USD', created_at: NOW_ISO, updated_at: NOW_ISO });
  await group('g-lunch', 'Lunch with Sam', 'food and drink', ['t_posted', PAYBACK], 1);
  await group('g-fee', 'Fee refunded', 'bank fees', ['t_fee', FEE_BACK], 6);
  await group('g-club', 'Coffee club', 'food and drink', ['t_coffee', PAYOUT], 2);
}

const today = () => localDate();
/** The chart's flows over the rows are the totals' own, period by period
 *  and month by month: money in, out, every count, and each category's
 *  spending and transactions, by the category each row is filed under. */
async function expectTheTotals() {
  const { rows, ix } = await readActivity(ctx, false);
  const currency = totalsCurrency(rows);
  const months = periodOf('last-12-months', today()).months.map((m) => ({ from: `${m}-01`, to: lastDayOf(m) }));
  const ranges = [...PERIODS.map((p) => periodOf(p.key, today())), ...months, { from: daysAgo(100), to: daysAgo(0) }];
  for (const range of ranges) {
    const inRange = inPeriod(range);
    const flow = cashFlow(rows, inRange, currency, ix);
    const s = summarize(rows, inRange, currency, (bucket) => ({ category: bucket, category_id: bucket, group_id: null, group: null }));
    const label = `${range.from} to ${range.to}`;
    expect([label, flow.money_in, flow.money_out, flow.transactions, flow.counted, flow.transfers, flow.excluded]).toEqual([label, s.money_in, s.money_out, s.transactions, s.counted, s.transfers, s.excluded]);
    const categories = flow.groups.flatMap((g) => g.categories);
    const budgets = spendingByCategory(rows, inRange, currency, (t) => filedId(ix, t));
    expect([label, Object.fromEntries(categories.map((c) => [c.id, c.amount]))]).toEqual([label, Object.fromEntries(Object.entries(budgets).map(([id, v]) => [id, tidy(v)]))]);
    expect([label, Object.fromEntries(categories.map((c) => [c.id, c.transactions]))]).toEqual([label, Object.fromEntries(s.categories.map((c) => [c.category, c.transactions]))]);
    expect([label, tidy(flow.payers.reduce((a, p) => a + p.amount, 0))]).toEqual([label, flow.money_in]);
  }
  return { rows, ix, currency };
}

const LAST_100 = () => inPeriod({ from: daysAgo(100), to: daysAgo(0) });

describe('the chart over split and grouped transactions: the totals’ own figures, counts included', () => {
  test('to the cent, over every period and every month', async () => {
    const before = await readActivity(ctx, false);
    const was = cashFlow(before.rows, LAST_100(), 'USD', before.ix);
    await splitAndGroup();
    const { rows, ix } = await expectTheTotals();
    const flow = cashFlow(rows, LAST_100(), 'USD', ix);
    // Each group counts at its net: lunch 12 less Sam's 6, the fee 35 less
    // its refund, the coffee 5.5 less a payout of 20 (money in). The first
    // month's subscription comes to the bank's 15.99 still, its new dollar a
    // part of its own; the second's parts come to 2 more than the bank's,
    // which is money back.
    expect([flow.money_in, flow.money_out]).toEqual([tidy(was.money_in + 14.5 + 2), tidy(was.money_out - 12 + 6 - 35 - 5.5 + 2)]);
    // Transactions, not rows: the wallet's three more, no more.
    expect(flow.transactions).toBe(was.transactions + 3);
  });

  test('a charge split across two groups flows to both and counts once on its side; what the bank changed a split by is a part of its own', async () => {
    await splitAndGroup();
    const { rows, ix } = await expectTheTotals();
    const flow = cashFlow(rows, LAST_100(), 'USD', ix);
    const categories = flow.groups.flatMap((g) => g.categories.map((c) => ({ ...c, group: g.name })));
    const of = (name: string) => categories.find((c) => c.name === name)!;
    const card = rows.filter((t) => t.split_of === 't_card').map((t) => t.transaction_id);
    expect(card).toEqual(['split:p-food', 'split:p-home']);
    expect([of('food and drink').group, of('home improvement').group]).toEqual(['Food', 'Housing']);
    expect(of('food and drink').ids).toContain('split:p-food');
    expect(of('home improvement')).toMatchObject({ amount: 30, transactions: 1, ids: ['split:p-home'] });
    // Each side counts transactions: out, the rent, the card, lunch's two,
    // three months of the subscription and the market (eleven rows); in, the
    // pay, the coffee club's two and the second month's money back.
    expect([flow.money_in_transactions, flow.money_out_transactions]).toEqual([4, 8]);
    // Up a dollar: spending in the subscription's own category. Down two:
    // money back, from its payer, a refund.
    expect(rows.find((t) => t.transaction_id === 'split-rest:t_flix0')).toMatchObject({ amount: 1, category_id: cat('entertainment') });
    expect(rows.find((t) => t.transaction_id === 'split-rest:t_flix1')).toMatchObject({ amount: -2, category_id: cat('entertainment') });
    expect(flow.payers.find((p) => p.key === 'netflix')).toMatchObject({ name: 'Netflix', amount: 2, transactions: 1, refund: true, ids: ['split-rest:t_flix1'] });
    // Each month's subscription is one transaction in each of its categories.
    expect(of('general merchandise').ids).toEqual(expect.arrayContaining(['split:f0b', 'split:f1b']));
  });

  test('a group counts once, at its net, in its own category: its money back is no payer, one netting to nothing flows nowhere, one netting to money in is a payer of its name', async () => {
    await splitAndGroup();
    const { rows, ix } = await expectTheTotals();
    const flow = cashFlow(rows, LAST_100(), 'USD', ix);
    // The wallet's money back is inside its groups: no payer of its own.
    expect(flow.payers.map((p) => p.name).sort()).toEqual(['Coffee club', 'Netflix', 'T_PAY']);
    expect(flow.payers.find((p) => p.key === 'coffee club')).toMatchObject({ name: 'Coffee club', amount: 14.5, transactions: 2, refund: true, ids: ['group:g-club'] });
    const lunch = rows.find((t) => t.transaction_id === 'group:g-lunch')!;
    expect([lunch.amount, lunch.category_id]).toEqual([6, cat('food and drink')]);
    expect(flow.groups.flatMap((g) => g.categories).find((c) => c.ids.includes('group:g-lunch'))).toMatchObject({ name: 'food and drink' });
    // The refunded fee: counted, two transactions, and no money either way.
    const fee = rows.find((t) => t.transaction_id === 'group:g-fee')!;
    expect(fee.amount).toBe(0);
    expect([...flow.payers.flatMap((p) => p.ids), ...flow.groups.flatMap((g) => g.ids)]).not.toContain('group:g-fee');
    expect(summarize([fee], LAST_100(), 'USD')).toMatchObject({ counted: 2, money_in: 0, money_out: 0 });
  });

  test('a group with a transaction on a hidden account nets without it, as the totals net it', async () => {
    await splitAndGroup();
    await groupStore.set(ctx, 'g-move', { version: 1, name: 'Moving', category_id: cat('home improvement'), members: ['t_hidden', 't_rent'], date: daysAgo(3), currency: 'USD', created_at: NOW_ISO, updated_at: NOW_ISO });
    const { rows, ix } = await expectTheTotals();
    const move = rows.find((t) => t.transaction_id === 'group:g-move')!;
    expect([move.amount, move.group_missing, move.group_members!.map((m) => m.transaction_id)]).toEqual([1200, 1, ['t_rent']]);
    const flow = cashFlow(rows, LAST_100(), 'USD', ix);
    // With the card's shelf: the group's one transaction here, and the part.
    expect(flow.groups.flatMap((g) => g.categories).find((c) => c.ids.includes('group:g-move'))).toMatchObject({ name: 'home improvement', amount: 1230, transactions: 2 });
    // The hidden account's transaction is in no row, inside the group or out.
    expect(rows.some((t) => t.transaction_id === 't_hidden' || t.group_members?.some((m) => m.transaction_id === 't_hidden'))).toBe(false);
  });

  test('a group with a transaction on an account that ended nets without it, from its end, as the totals net it', async () => {
    await splitAndGroup();
    await markEnded(ctx, 'manual_wallet', { state: 'closed', on: daysAgo(1) }, WALLET);
    const { rows, ix } = await expectTheTotals();
    const lunch = rows.find((t) => t.transaction_id === 'group:g-lunch')!;
    expect([lunch.amount, lunch.group_missing]).toEqual([12, 1]);
    expect(rows.some((t) => t.transaction_id === WALLET_ROW || t.transaction_id === PAYBACK)).toBe(false);
    const flow = cashFlow(rows, LAST_100(), 'USD', ix);
    // Lunch's one transaction here, and the card's food.
    expect(flow.groups.flatMap((g) => g.categories).find((c) => c.ids.includes('group:g-lunch'))).toMatchObject({ name: 'food and drink', amount: 62, transactions: 2 });
  });
});

describe('a tap lists a node’s rows, put back whole by the list', () => {
  test('a split transaction with only its part in the node under it, labelled and edited by every part; a group’s row with its transactions', async () => {
    await splitAndGroup();
    const { rows, ix } = await readActivity(ctx, false);
    const pick = (node: string) => pickedRows(rows, { period: 'last-12-months', node, label: '' }, { ix, currency: 'USD', today: today() });
    const home = pick(`category:${cat('home improvement')}`);
    expect(home.map((t) => t.transaction_id)).toEqual(['split:p-home']);
    const listed = bankRows(home);
    expect(listed.map((t) => [t.transaction_id, t.amount, t.split_parts!.map((p) => p.transaction_id)])).toEqual([['t_card', 80, ['split:p-home']]]);
    expect(wholeSplits(rows as unknown as Parameters<typeof wholeSplits>[0]).get('t_card')!.split_parts!.map((p) => p.transaction_id)).toEqual(['split:p-food', 'split:p-home']);
    const club = pick('payer:coffee club');
    expect(bankRows(club, { groups: 'keep' }).map((t) => [t.transaction_id, t.group_members!.map((m) => m.transaction_id)])).toEqual([['group:g-club', ['t_coffee', PAYOUT]]]);
    expect(countTransactions(club)).toBe(2);
  });
});

const get = async (route: any, path: string, query: string) => {
  const res: Response = await route.GET(new Request(`https://nya.test/api/v1/${path}?${query}`, { headers: { authorization: `Bearer ${token}` } }));
  expect(res.status).toBe(200);
  return (await res.json()) as any;
};

describe('/api/v1/cash-flow over split and grouped transactions', () => {
  test('agrees with /api/v1/spending to the cent, counts included, for the last hundred days and for each month', async () => {
    await splitAndGroup();
    await groupStore.set(ctx, 'g-move', { version: 1, name: 'Moving', category_id: cat('home improvement'), members: ['t_hidden', 't_rent'], date: daysAgo(3), currency: 'USD', created_at: NOW_ISO, updated_at: NOW_ISO });
    const months = [...new Set([0, 30, 60, 90].map((d) => daysAgo(d).slice(0, 7)))];
    for (const query of [`from=${daysAgo(100)}&to=${daysAgo(0)}`, ...months.map((m) => `month=${m}`)]) {
      const [f, s] = await Promise.all([get(cashFlowRoute, 'cash-flow', query), get(spendingRoute, 'spending', query)]);
      expect([query, f.money_in, f.money_out, f.net, f.transactions, f.counted, f.transfers, f.excluded, f.exclusion_unknown]).toEqual([
        query,
        s.money_in,
        s.money_out,
        s.net,
        s.transactions,
        s.counted,
        s.transfers,
        s.excluded,
        s.exclusion_unknown,
      ]);
      const categories = f.groups.flatMap((g: any) => g.categories.map((c: any) => ({ category: c.name, category_id: c.id, group: g.name, group_id: g.id, spent: c.amount, transactions: c.transactions })));
      expect([query, [...categories].sort((a, b) => b.spent - a.spent || (a.category < b.category ? -1 : 1))]).toEqual([query, s.categories]);
      expect([query, f.groups.map((g: any) => ({ id: g.id, name: g.name, kind: g.kind, spent: g.amount, transactions: g.transactions }))]).toEqual([query, s.groups]);
    }
    const all = await get(cashFlowRoute, 'cash-flow', `from=${daysAgo(100)}&to=${daysAgo(0)}`);
    expect(all.payers.find((p: any) => p.name === 'Coffee club')).toEqual({ name: 'Coffee club', amount: 14.5, transactions: 2, refund: true });
    expect(all.payers.some((p: any) => ['SAM VENMO', 'FEE REFUND', 'COFFEE CLUB'].includes(p.name))).toBe(false);
    expect(all.groups.find((g: any) => g.name === 'Housing').categories.find((c: any) => c.name === 'home improvement')).toMatchObject({ amount: 1230, transactions: 2 });
  });
});
