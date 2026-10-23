import { describe, expect, test, mock, beforeEach, afterEach } from 'bun:test';
import { FakeRedis, storageMock, TEST_CTX, ctxKey, registerTestContainer, unscopedDataKeys } from './fake-redis';

// Shared expenses (#49) everywhere totals are read, to the cent, through the
// routes that write them and the readers that count them: a dinner shared
// half, an IOU you owe, a payment app's payment out that pays the IOU back,
// a cashout from Alex that pays part of the dinner, and last month's shared
// bill that a budget rolls over from. Budgets and rollover (the app's month
// and the API's), the report, year over year, the cash flow (the app's and
// the API's), /spending, /budgets, /categories, /api/v1/shared-expenses and
// get_shared_expenses' sentence all count your part, the IOU once and the
// payments never; the API's totals say what they count that /transactions
// doesn't list.

const ctx = TEST_CTX;
process.env.PLAID_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
delete process.env.MAX_TXN_BLOB_CHARS;

const { addMonths } = await import('@/lib/rollover');
/** Today, this month and last, as the UTC day the API reads. */
const TODAY = new Date().toISOString().slice(0, 10);
const NOW = TODAY.slice(0, 7);
const LAST = addMonths(NOW, -1);
/** This month's first day: never after today, so every row is in the month. */
const FIRST = `${NOW}-01`;
const LAST_DAY = `${LAST}-10`;

const first: any[] = [];
let cursor = 0;
mock.module('@/lib/plaid', () => ({
  plaidClient: {
    transactionsSync: async (req: any) => ({
      data: {
        added: req.cursor ? [] : first,
        modified: [],
        removed: [],
        accounts: [account('acct_card', 'credit'), account('acct_check', 'depository')],
        next_cursor: `c${++cursor}`,
        has_more: false,
        transactions_update_status: 'HISTORICAL_UPDATE_COMPLETE',
      },
    }),
  },
}));

const fake = new FakeRedis();
afterEach(() => expect(unscopedDataKeys(fake)).toEqual([]));
mock.module('@/lib/storage', () => storageMock(fake));

const { encrypt } = await import('@/lib/crypto');
const { rememberAccounts } = await import('@/lib/last-known');
const { setBudgets } = await import('@/lib/budgets');
const { cashFlow } = await import('@/lib/cash-flow');
const { indexTaxonomy } = await import('@/lib/categories');
const { summarize } = await import('@/lib/totals');
const { readSpending, readBudgets, readCategories, queryTransactions } = await import('@/lib/api-read');
const { readCashFlow } = await import('@/lib/api-cash-flow');
const { readApiYearOverYear } = await import('@/lib/api-reports');
const { readReport } = await import('@/lib/report/read');
const { resolvePeriod } = await import('@/lib/report/period');
const { readApiSharedExpenses } = await import('@/lib/shared-expenses/api');
const { callTool, TOOLS } = await import('@/lib/mcp');

function account(id: string, type: string) {
  return { account_id: id, name: type === 'credit' ? 'Card' : 'Checking', official_name: null, type, subtype: type === 'credit' ? 'credit card' : 'checking', mask: '4821', balances: { available: null, current: 100, limit: null, iso_currency_code: 'USD' } };
}
const plaidRow = (id: string, over: Record<string, unknown> = {}) => ({
  transaction_id: id,
  account_id: 'acct_card',
  amount: 120.5,
  iso_currency_code: 'USD',
  date: FIRST,
  name: 'JOES DINER',
  merchant_name: 'Joe’s Diner',
  pending: false,
  counterparties: [],
  personal_finance_category: { primary: 'FOOD_AND_DRINK', detailed: 'FOOD_AND_DRINK_RESTAURANT' },
  ...over,
});

const route = async (path: string, method: string, body?: unknown, query = '') => {
  const mod: any = await import(`@/app/api/${path}/route`);
  const res = await mod[method](new Request(`http://x/api/${path}${query}`, { method, body: body !== undefined ? JSON.stringify(body) : undefined }));
  return { status: res.status as number, body: await res.json() };
};
const listed = async () => (await route('transactions', 'GET')).body as { transactions: any[]; notes: string[] };
const cents = (n: number) => Math.round(n * 100) / 100;

let categories: any;
const category = (name: string) => categories.categories.find((c: any) => c.name === name);

beforeEach(async () => {
  fake.reset();
  first.length = 0;
  first.push(
    // This month: the dinner, a coffee, a payment out by Venmo filed as a
    // purchase, and Alex's cashout.
    plaidRow('t_dinner'),
    plaidRow('t_coffee', { amount: 4.35, name: 'BLUE BOTTLE', merchant_name: 'Blue Bottle' }),
    plaidRow('t_venmo_out', { amount: 25.1, name: 'VENMO PAYMENT', merchant_name: 'Venmo', personal_finance_category: { primary: 'GENERAL_MERCHANDISE', detailed: 'GENERAL_MERCHANDISE_OTHER_GENERAL_MERCHANDISE' } }),
    plaidRow('t_cashout', { account_id: 'acct_check', amount: -20, name: 'VENMO CASHOUT', merchant_name: 'Venmo', personal_finance_category: { primary: 'TRANSFER_IN', detailed: 'TRANSFER_IN_ACCOUNT_TRANSFER' } }),
    // Last month: a $200 dinner, shared half.
    plaidRow('t_last', { amount: 200, date: LAST_DAY, name: 'OSTERIA', merchant_name: 'Osteria' })
  );
  (await import('@/lib/sessions')).forgetEpochs();
  await registerTestContainer(fake);
  await fake.hset(ctxKey('plaid:items'), { item_a: JSON.stringify({ item_id: 'item_a', institution_name: 'Chase', encrypted_access_token: await encrypt(ctx, 'token-a') }) });
  await rememberAccounts(ctx, [{ item_id: 'item_a', institution_name: 'Chase', institution_id: null, error: null, accounts: [{ ...account('acct_card', 'credit'), balance: 100 }, { ...account('acct_check', 'depository'), balance: 900 }] } as any]);
  categories = (await route('categories', 'GET')).body.categories;
});

/** Alex; this month's dinner and last month's shared half; an IOU you owe
 *  for groceries; the Venmo payment out confirmed against the IOU and
 *  Alex's cashout against $20 of the dinner. */
async function seeded() {
  await listed();
  const alex = await route('shared-expenses/people', 'POST', { name: 'Alex Smith', venmo: '@alex-s', app: 'venmo' });
  expect(alex.status).toBe(200);
  const person = alex.body.id as string;
  const share = async (transaction_id: string, amount: number) => {
    const res = await route('shared-expenses/shares', 'PUT', { transaction_id, entries: [{ person, amount, how: { kind: 'half' } }] });
    expect(res.status).toBe(200);
    return res.body.share.entries[0].id as string;
  };
  const dinner = await share('t_dinner', 60.25);
  const last = await share('t_last', 100);
  const owed = await route('shared-expenses/ious', 'POST', { person, direction: 'by_you', amount: 25.1, currency: 'USD', date: FIRST, what: 'Groceries Alex bought', category_id: category('food and drink').id });
  expect(owed.status).toBe(200);
  const iou = owed.body.id as string;
  expect((await route('shared-expenses/payments', 'POST', { transaction_id: 't_venmo_out', allocations: [{ item: iou, amount: 25.1 }] })).status).toBe(200);
  expect((await route('shared-expenses/payments', 'POST', { transaction_id: 't_cashout', allocations: [{ item: dinner, amount: 20 }] })).status).toBe(200);
  return { person, dinner, last, iou };
}

/** This month's money out, as every reader is to count it: the dinner at
 *  your part, the coffee and the IOU; the payment out pays the IOU, so it is
 *  never counted beside it. */
const THIS_MONTH = cents(60.25 + 4.35 + 25.1);
/** Last month's: the shared dinner at your part. */
const LAST_MONTH = 100;
const IOU_NOTE = 'Includes 1 IOU you owe, your part of what someone else paid: /transactions doesn’t list it, /shared-expenses does';

describe('every reader counts your part, the IOU once and the payments never, to the cent', () => {
  test('the Activity tab’s own rows and the list the API gives', async () => {
    await seeded();
    const rows = (await listed()).transactions;
    const month = summarize(rows, (d) => d.startsWith(NOW), 'USD');
    expect(month.money_out).toBe(THIS_MONTH);
    expect(summarize(rows, (d) => d.startsWith(LAST), 'USD').money_out).toBe(LAST_MONTH);
    // The API lists the bank's rows, never the IOU.
    const page = await queryTransactions(ctx, { from: FIRST, to: TODAY, limit: 100 } as any);
    expect(page.transactions.map((t: any) => t.id ?? t.transaction_id).sort()).toEqual(['t_cashout', 't_coffee', 't_dinner', 't_venmo_out']);
  });

  test('budgets, with what rolled over: your part of last month’s bill, never its whole', async () => {
    await seeded();
    await setBudgets(ctx, { 'food and drink': 150 });
    const food = category('food and drink').id;
    const on = await route('budgets/rollover', 'POST', { action: 'rollover', kind: 'category', id: food, on: true, from: LAST, month: NOW });
    expect(on.status).toBe(200);
    // The app's month: 150 less last month's part (100) rolls 50 over.
    const app = (await route('budgets/month', 'GET', undefined, `?month=${NOW}&today=${NOW}`)).body;
    expect(cents(app.spent[food])).toBe(THIS_MONTH);
    expect(app.carries.categories[food].carry).toBe(50);
    // The API's, and what it counts that /transactions doesn't list.
    const api = await readBudgets(ctx, { month: NOW });
    expect(api.budgets).toEqual([expect.objectContaining({ category: 'food and drink', budget: 150, spent: THIS_MONTH, remaining: cents(150 - THIS_MONTH), available: 200, available_remaining: cents(200 - THIS_MONTH) })]);
    expect(api.budgets[0].rollover?.carry).toBe(50);
    expect(api.notes).toContain(IOU_NOTE);
    // Counting what the bank says: the whole of each, so last month rolls
    // over less than nothing, and the IOU counts in nothing.
    expect((await route('shared-expenses', 'PUT', { counting: 'bank' })).status).toBe(200);
    const bank = await readBudgets(ctx, { month: NOW });
    expect(bank.budgets).toEqual([expect.objectContaining({ spent: cents(120.5 + 4.35), available: 100 })]);
    expect(bank.budgets[0].rollover?.carry).toBe(-50);
    expect(bank.notes).not.toContain(IOU_NOTE);
  });

  test('the report, and year over year', async () => {
    await seeded();
    const period = resolvePeriod({ kind: 'range', start: FIRST, end: TODAY }, 'UTC', Date.now());
    if ('error' in period) throw new Error(period.error);
    const report = await readReport(ctx, period);
    expect([report.totals.money_in, report.totals.money_out]).toEqual([0, THIS_MONTH]);
    // The dinner, the coffee and the IOU in food and drink; the payment out
    // counts nothing in its own.
    expect(report.money_out).toEqual([{ category: 'food and drink', amount: THIS_MONTH, transactions: 3 }]);
    const last = resolvePeriod({ kind: 'range', start: `${LAST}-01`, end: `${LAST}-28` }, 'UTC', Date.now());
    if ('error' in last) throw new Error(last.error);
    expect((await readReport(ctx, last)).totals.money_out).toBe(LAST_MONTH);

    const yoy = await readApiYearOverYear(ctx);
    expect(yoy.month.this.money_out).toBe(THIS_MONTH);
    const months = new Map(yoy.months.map((m) => [m.month, m.this.money_out]));
    expect(months.get(NOW)).toBe(THIS_MONTH);
    // Last month is this year's, but in January.
    const sameYear = LAST.slice(0, 4) === NOW.slice(0, 4);
    if (sameYear) expect(months.get(LAST)).toBe(LAST_MONTH);
    expect(yoy.year.this.money_out).toBe(cents(THIS_MONTH + (sameYear ? LAST_MONTH : 0)));
  });

  test('the cash flow, the app’s and the API’s', async () => {
    await seeded();
    const rows = (await listed()).transactions;
    const app = cashFlow(rows, (d) => d >= FIRST && d <= TODAY, 'USD', indexTaxonomy(categories));
    expect([app.money_in, app.money_out]).toEqual([0, THIS_MONTH]);
    expect(app.groups.map((g) => [g.name, g.amount])).toEqual([['Food', THIS_MONTH]]);
    const api = await readCashFlow(ctx, { from: FIRST, to: TODAY });
    expect([api.money_in, api.money_out]).toEqual([0, THIS_MONTH]);
    expect(api.groups.map((g) => [g.name, g.amount])).toEqual([['Food', THIS_MONTH]]);
    expect(api.notes).toContain(IOU_NOTE);
    // Over last month alone: no IOU there, so no note.
    const before = await readCashFlow(ctx, { from: `${LAST}-01`, to: `${LAST}-28` });
    expect(before.money_out).toBe(LAST_MONTH);
    expect(before.notes.filter((n) => n.includes('IOU'))).toEqual([]);
  });

  test('/spending and /categories, with what they count that /transactions doesn’t list', async () => {
    await seeded();
    const sp = await readSpending(ctx, { from: FIRST, to: TODAY });
    expect(sp.money_out).toBe(THIS_MONTH);
    expect(sp.categories).toEqual([expect.objectContaining({ category: 'food and drink', spent: THIS_MONTH, transactions: 3 })]);
    expect(sp.notes).toContain(IOU_NOTE);
    expect((await readSpending(ctx, { from: `${LAST}-01`, to: `${LAST}-28` })).money_out).toBe(LAST_MONTH);
    const cats = await readCategories(ctx);
    expect(cats.notes).toContain(IOU_NOTE);
    // The dinners, the coffee and the IOU: one each.
    expect(cats.categories.find((c) => c.name === 'food and drink')!.transactions).toBe(4);
  });

  test('/api/v1/shared-expenses and get_shared_expenses’ sentence', async () => {
    const { person, dinner, last, iou } = await seeded();
    const se = await readApiSharedExpenses(ctx);
    expect(se.counting).toBe('part');
    // Alex owes 60.25 less the 20 paid, and 100: the IOU is paid back.
    expect(se.people).toEqual([expect.objectContaining({ id: person, name: 'Alex Smith', balances: [{ currency: 'USD', amount: 140.25, open_items: 2 }] })]);
    const items = new Map(se.items.map((i) => [i.id, [i.kind, i.amount, i.open, i.counted]]));
    expect(items.get(dinner)).toEqual(['share', 60.25, 40.25, 0]);
    expect(items.get(last)).toEqual(['share', 100, 100, 0]);
    expect(items.get(iou)).toEqual(['iou', 25.1, 0, 25.1]);
    expect(se.payments.map((p) => [p.transaction_id, p.amount, p.allocations.map((a) => [a.item, a.amount])]).sort()).toEqual([
      ['t_cashout', -20, [[dinner, 20]]],
      ['t_venmo_out', 25.1, [[iou, 25.1]]],
    ]);
    const answer = (await callTool({ ctx, access: 'read' } as any, 'get_shared_expenses', {})) as any;
    expect(answer.content[0].text).toBe('1 person: Alex Smith owes you 140.25 USD. 1 IOU; counting: part.');
    expect(answer.structuredContent).toEqual(se);
  });
});
