import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test';
import { FakeRedis, storageMock, TEST_CTX, registerTestContainer, unscopedDataKeys } from './fake-redis';
import { FakeSimplefin, fakeAccount, type FakeTxn } from './simplefin-fake';

// SimpleFIN's rows in the person's own categories (#38): a pair Nya works out
// between two SimpleFIN accounts is filed, by the words a bank gives the same
// pair, into a category in the Transfers group, so every total leaves it out
// (lib/spending.ts decides by the group's kind), while the cash forecast still
// counts a steady card payment from cash as a bill and the Plan a loan pair as
// a loan payment (both read the words, never the group); renamed, it stays a
// transfer, and moved to a group of another kind, its category counts as that
// kind, a bank's rows and these alike (the row's mark then stops saying how to
// count it). A
// category chosen for one through the picker is stored as the category's
// words, filed by its id, and undoes the pair. SimpleFIN rows count in a
// category's usage, follow a merge, and count in a group's budget.

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

const { setTransportForTests } = await import('@/lib/connectors/http');
const { connect, trackAccounts } = await import('@/lib/connectors/manage');
const { connectorAccountsStore } = await import('@/lib/connectors/store');
const { manualTxnStore } = await import('@/lib/manual-txns');
const { forgetEpochs } = await import('@/lib/sessions');
const { countsInTotals, isTransfer } = await import('@/lib/spending');
const { detectRecurring } = await import('@/lib/recurring');
const { forecastEvents } = await import('@/lib/forecast');
const { planFlow } = await import('@/lib/fire/inputs');
const { readBudgets } = await import('@/lib/api-read');
const { recategorizedRow } = await import('@/components/transaction-edits');
const { pairedWords } = await import('@/components/MonthBreakdown');
const transactionsRoute = await import('@/app/api/transactions/route');
const recategorizeRoute = await import('@/app/api/recategorize/route');
const categoriesRoute = await import('@/app/api/categories/route');
const budgetsRoute = await import('@/app/api/budgets/route');

const ctx = TEST_CTX;
const DAY = 86_400_000;
const NOW = Date.now();
const dayOf = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const TODAY = dayOf(NOW);
const ago = (n: number) => Math.floor(Date.parse(`${dayOf(NOW - n * DAY)}T12:00:00Z`) / 1000);
const txn = (id: string, daysAgo: number, amount: string, description: string): FakeTxn => ({ id, posted: ago(daysAgo), amount, description });

let server: FakeSimplefin;
beforeAll(async () => {
  server = await FakeSimplefin.start();
});
afterAll(() => {
  setTransportForTests(null);
  server.stop();
});
beforeEach(async () => {
  fake.reset();
  server.reset();
  forgetEpochs();
  await registerTestContainer(fake);
  setTransportForTests(server.transport());
});

/** Checking, a card, a mortgage and savings through SimpleFIN: a card paid
 *  monthly from checking, a mortgage payment, a move to savings, and a
 *  coffee and a dinner that are only spending. */
async function trackAll(): Promise<void> {
  server.accounts = [
    fakeAccount({
      id: 'CHK',
      name: 'Checking',
      balance: '5000.00',
      'balance-date': ago(1),
      transactions: [
        txn('pay0', 3, '-300.00', 'PAYMENT TO VISA'),
        txn('pay1', 33, '-300.00', 'PAYMENT TO VISA'),
        txn('pay2', 63, '-300.00', 'PAYMENT TO VISA'),
        txn('mtg', 5, '-2000.00', 'MORTGAGE PMT'),
        txn('sav', 6, '-500.00', 'TO SAVINGS'),
        txn('coffee', 2, '-12.50', 'COFFEE'),
        txn('payroll', 10, '2500.00', 'PAYROLL'),
      ],
    }),
    fakeAccount({
      id: 'CARD',
      name: 'Visa',
      balance: '-300.00',
      'balance-date': ago(1),
      transactions: [txn('thanks0', 2, '300.00', 'PAYMENT THANK YOU'), txn('thanks1', 32, '300.00', 'PAYMENT THANK YOU'), txn('thanks2', 62, '300.00', 'PAYMENT THANK YOU'), txn('dinner', 2, '-45.67', 'DINER')],
    }),
    fakeAccount({ id: 'MTG', name: 'Home Loan', balance: '-250000.00', 'balance-date': ago(1), transactions: [txn('mtgin', 4, '2000.00', 'PAYMENT RECEIVED')] }),
    fakeAccount({ id: 'SAV', name: 'Savings', balance: '1500.00', 'balance-date': ago(1), transactions: [txn('savin', 6, '500.00', 'FROM CHECKING')] }),
  ];
  const { connection_id } = await connect(ctx, 'simplefin', server.setupToken(`t${Math.random()}`), NOW);
  await trackAccounts(
    ctx,
    connection_id,
    [
      { remote_id: 'CHK', type: 'depository' },
      { remote_id: 'CARD', type: 'credit' },
      { remote_id: 'MTG', type: 'loan' },
      { remote_id: 'SAV', type: 'depository' },
    ],
    NOW
  );
}

/** The Activity tab's answer, as the app reads it (filing, and growing the set). */
async function activity(): Promise<{ transactions: any[]; recurring_history: any[]; categories: any }> {
  const res = await transactionsRoute.GET(new Request('http://localhost/api/transactions'));
  expect(res.status).toBe(200);
  return res.json();
}
const one = (rows: any[], name: string, days?: number) => rows.find((t) => t.name === name && (days === undefined || t.date === dayOf(NOW - days * DAY)));

async function change(body: Record<string, unknown>): Promise<{ status: number; body: any }> {
  const res = await categoriesRoute.POST(new Request('http://localhost/api/categories', { method: 'POST', body: JSON.stringify(body) }));
  return { status: res.status, body: await res.json() };
}
const categoryNamed = (t: any, name: string) => t.categories.find((c: any) => c.name === name);
const groupNamed = (t: any, name: string) => t.groups.find((g: any) => g.name === name);

describe('a pair worked out between two SimpleFIN accounts, in the person’s categories', () => {
  test('is filed into a category in the Transfers group: every total leaves it out, the forecast and the Plan still see what it is', async () => {
    await trackAll();
    const a = await activity();
    const rows = a.transactions;
    const filed = (name: string, days?: number) => {
      const t = one(rows, name, days);
      return [t.category_name, t.category_kind, t.paired ?? null, countsInTotals(t, 'USD')];
    };
    expect(filed('PAYMENT TO VISA', 3)).toEqual(['loan payments', 'transfer', 'card', false]);
    expect(filed('PAYMENT THANK YOU', 2)).toEqual(['loan payments', 'transfer', 'card', false]);
    expect(filed('MORTGAGE PMT')).toEqual(['loan payments', 'transfer', 'loan', false]);
    expect(filed('PAYMENT RECEIVED')).toEqual(['loan payments', 'transfer', 'loan', false]);
    expect(filed('TO SAVINGS')).toEqual(['transfer out', 'transfer', 'transfer', false]);
    expect(filed('FROM CHECKING')).toEqual(['transfer in', 'transfer', 'transfer', false]);
    expect(filed('COFFEE')).toEqual([null, 'expense', null, true]);
    // The three pair categories are the seeded ones in the Transfers group.
    const transfers = groupNamed(a.categories, 'Transfers');
    for (const name of ['loan payments', 'transfer out', 'transfer in']) expect(categoryNamed(a.categories, name).group).toBe(transfers.id);

    // The card's payment from cash is still a bill the forecast counts, and
    // the mortgage a loan payment in the Plan's spending.
    const series = detectRecurring([...rows, ...a.recurring_history]);
    expect(series.filter((s) => s.kind === 'bill').map((s) => [s.name, s.accountType, s.paysCardOf])).toContainEqual(['PAYMENT TO VISA', 'depository', { institution: 'My Bank', account: 'Visa' }]);
    const { events } = forecastEvents({ series, planned: [], currency: 'USD', today: TODAY, until: dayOf(NOW + 60 * DAY) });
    expect(events.some((e) => e.name === 'PAYMENT TO VISA' && e.amount === -300)).toBe(true);
    expect(planFlow(one(rows, 'MORTGAGE PMT'))).toBe('loan');
  });

  test('renamed, it is still a transfer; moved to a spending group, a card’s and a loan’s payment count as spending, as a bank’s do there, and so does a move between cash accounts once transfer out is moved', async () => {
    await trackAll();
    const set = (await activity()).categories;
    const loans = categoryNamed(set, 'loan payments');
    expect((await change({ action: 'rename-category', id: loans.id, name: 'Debt payments' })).status).toBe(200);
    let rows = (await activity()).transactions;
    expect([one(rows, 'PAYMENT TO VISA', 3).category_name, one(rows, 'PAYMENT TO VISA', 3).category_kind, isTransfer(one(rows, 'PAYMENT TO VISA', 3))]).toEqual(['Debt payments', 'transfer', true]);
    expect(pairedWords(one(rows, 'PAYMENT TO VISA', 3))).toBe('Card payment between your accounts, worked out from the amounts: give it a category to count it');

    const housing = groupNamed(set, 'Housing');
    expect((await change({ action: 'move-category', id: loans.id, group: housing.id })).status).toBe(200);
    rows = (await activity()).transactions;
    const visa = one(rows, 'PAYMENT TO VISA', 3);
    expect([visa.category_kind, countsInTotals(visa, 'USD')]).toEqual(['expense', true]);
    expect(countsInTotals(one(rows, 'MORTGAGE PMT'), 'USD')).toBe(true);
    // The move to savings is in transfer out, still in Transfers: left out.
    expect(countsInTotals(one(rows, 'TO SAVINGS'), 'USD')).toBe(false);
    // Each row's mark says what it is, and how to count it only while it isn't counted.
    expect(pairedWords(visa)).toBe('Card payment between your accounts, worked out from the amounts');
    expect(pairedWords(one(rows, 'PAYMENT RECEIVED'))).toBe('Loan payment between your accounts, worked out from the amounts');
    expect(pairedWords(one(rows, 'TO SAVINGS'))).toBe('Transfer between your accounts, worked out from the amounts: give it a category to count it');
    // The forecast and the Plan read the words, never the group.
    expect(detectRecurring(rows).some((s) => s.name === 'PAYMENT TO VISA' && s.kind === 'bill' && s.paysCard)).toBe(true);
    expect(planFlow(one(rows, 'MORTGAGE PMT'))).toBe('loan');

    // Transfer out moved there too: the move to savings counts as spending,
    // as a bank's transfer out would, and its other side, in transfer in, doesn't.
    expect((await change({ action: 'move-category', id: categoryNamed(set, 'transfer out').id, group: housing.id })).status).toBe(200);
    rows = (await activity()).transactions;
    const out = one(rows, 'TO SAVINGS');
    expect([out.category_name, out.category_kind, out.transaction_code, countsInTotals(out, 'USD'), planFlow(out)]).toEqual(['transfer out', 'expense', null, true, 'spending']);
    expect(pairedWords(out)).toBe('Transfer between your accounts, worked out from the amounts');
    expect(countsInTotals(one(rows, 'FROM CHECKING'), 'USD')).toBe(false);
  });
});

describe('a category chosen for a SimpleFIN row through the picker', () => {
  test('is stored as the category’s words, filed by its id, and undoes the pair it was in', async () => {
    await trackAll();
    const a = await activity();
    const food = categoryNamed(a.categories, 'food and drink');
    const visa = one(a.transactions, 'PAYMENT TO VISA', 3);
    expect(visa.paired).toBe('card');
    const res = await recategorizeRoute.POST(
      new Request('http://localhost/api/recategorize', { method: 'POST', body: JSON.stringify({ transaction_id: visa.transaction_id, category_id: food.id, account_id: visa.account_id }) })
    );
    expect(res.status).toBe(200);
    // Stored on the row as the category's words (choiceText).
    const book = await manualTxnStore.get(ctx, visa.account_id);
    expect(book!.rows.find((r) => r.id === visa.transaction_id)!.category).toBe('food and drink');
    // Filed by its id, a pair no more, and its other side neither.
    const rows = (await activity()).transactions;
    const after = one(rows, 'PAYMENT TO VISA', 3);
    expect([after.category_id, after.category_name, after.category_kind, after.paired ?? null, after.subcategory]).toEqual([food.id, 'food and drink', 'expense', null, null]);
    const other = one(rows, 'PAYMENT THANK YOU', 2);
    expect([other.category, other.paired ?? null, countsInTotals(other, 'USD')]).toEqual([null, null, true]);
    // The page shows the same at once: the mark and the detail go.
    expect(recategorizedRow(visa, { category_id: food.id }, a.categories)).toEqual({
      category: 'food and drink',
      category_id: food.id,
      category_name: 'food and drink',
      category_kind: 'expense',
      paired: undefined,
      subcategory: null,
    });
    expect(recategorizedRow(one(rows, 'COFFEE'), { category_id: food.id }, a.categories)).not.toHaveProperty('paired');
  });
});

describe('SimpleFIN rows in the person’s categories', () => {
  test('count in a category’s usage, follow a merge, and count in a group’s budget', async () => {
    await trackAll();
    const a = await activity();
    const food = groupNamed(a.categories, 'Food');
    const added = await change({ action: 'add-category', name: 'Coffee shops', group: food.id });
    const coffeeShops = categoryNamed(added.body.categories, 'Coffee shops');
    const coffee = one(a.transactions, 'COFFEE');
    const res = await recategorizeRoute.POST(
      new Request('http://localhost/api/recategorize', { method: 'POST', body: JSON.stringify({ transaction_id: coffee.transaction_id, category_id: coffeeShops.id, account_id: coffee.account_id }) })
    );
    expect(res.status).toBe(200);
    // Used by a SimpleFIN row: it can't be deleted, only merged or archived.
    const refused = await change({ action: 'delete-category', id: coffeeShops.id });
    expect(refused.status).toBe(409);
    // Merged: the row follows, filed into the category it went into.
    const fd = categoryNamed(a.categories, 'food and drink');
    expect((await change({ action: 'merge', id: coffeeShops.id, into: fd.id })).status).toBe(200);
    const merged = one((await activity()).transactions, 'COFFEE');
    expect([merged.category_id, merged.category_name]).toEqual([fd.id, 'food and drink']);

    // A budget on the Food group counts it, as a bank's row there counts.
    const put = await budgetsRoute.PUT(
      new Request('http://localhost/api/budgets', { method: 'PUT', body: JSON.stringify({ budget_set: { categories: {}, groups: { [food.id]: { amount: 100 } } } }) })
    );
    expect(put.status).toBe(200);
    const month = dayOf(NOW - 2 * DAY).slice(0, 7);
    const budgets = await readBudgets(ctx, { month });
    expect(budgets.groups.find((g) => g.name === 'Food')).toMatchObject({ budget: 100, spent: 12.5, remaining: 87.5 });
  });
});
