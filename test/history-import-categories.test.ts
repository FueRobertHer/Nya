import { describe, expect, test, mock, beforeEach, afterEach } from 'bun:test';
import { FakeRedis, storageMock, TEST_CTX, ctxKey, registerTestContainer, unscopedDataKeys } from './fake-redis';

// Rows imported into a linked account from its bank's files (#52), in the
// person's own categories (#38): filed by one rule with every other row (a
// category chosen for one, else the file's own words, which grow a category
// of their own), on the Activity tab, in budgets on a category and on a
// group, in the Plan by their category's kind, in the API by id and group,
// and in the download's nya_ columns, where a bank row standing for one the
// person chose a category for is filed by that category, as the app files
// it. A category's usage counts them, of any date, so it can't be deleted
// while one uses it; a merge takes them along.

process.env.PLAID_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');

const plaid = { later: [] as unknown[] };
mock.module('@/lib/plaid', () => ({
  plaidClient: {
    transactionsSync: async () => ({
      data: { added: plaid.later.splice(0), modified: [], removed: [], accounts: [], next_cursor: 'c-next', has_more: false, transactions_update_status: 'HISTORICAL_UPDATE_COMPLETE' },
    }),
  },
}));

const fake = new FakeRedis({ deserialize: true });
afterEach(() => expect(unscopedDataKeys(fake)).toEqual([]));
mock.module('@/lib/storage', () => storageMock(fake));

const { encrypt } = await import('@/lib/crypto');
const { encodeJsonBlob } = await import('@/lib/blob');
const { saveItem } = await import('@/lib/storage');
const { forgetEpochs } = await import('@/lib/sessions');
const { getOverrides } = await import('@/lib/overrides');
const { readTaxonomy } = await import('@/lib/category-store');
const { planFlow } = await import('@/lib/fire/inputs');
const { readBudgets, queryTransactions, readSpending } = await import('@/lib/api-read');
const { collectUserData, buildUserExport, exportFile, TRANSACTION_COLUMNS } = await import('@/lib/user-export');
const { parseCsv } = await import('./csv-parse');
const routes = await import('@/app/api/history-import/route');
const transactionsRoute = await import('@/app/api/transactions/route');
const recategorizeRoute = await import('@/app/api/recategorize/route');
const categoriesRoute = await import('@/app/api/categories/route');
const budgetsRoute = await import('@/app/api/budgets/route');
const { loadBudgets } = await import('@/lib/budget-store');
const { budgetMonthsStore } = await import('@/lib/budget-months-store');
const { startMonths } = await import('@/lib/rollover');

const ctx = TEST_CTX;
const DAY = 86_400_000;
const daysAgo = (n: number) => new Date(Date.now() - n * DAY).toISOString().slice(0, 10);

function bankTxn(id: string, days: number, amount: number, over: Record<string, unknown> = {}) {
  return {
    transaction_id: id,
    pending_transaction_id: null,
    account_id: 'acc_chk',
    amount,
    iso_currency_code: 'USD',
    unofficial_currency_code: null,
    date: daysAgo(days),
    authorized_date: null,
    authorized_datetime: null,
    datetime: null,
    name: id.toUpperCase(),
    merchant_name: null,
    merchant_entity_id: null,
    website: null,
    logo_url: null,
    personal_finance_category: { primary: 'FOOD_AND_DRINK', detailed: 'FOOD_AND_DRINK_GROCERIES', confidence_level: 'HIGH' },
    personal_finance_category_icon_url: null,
    pending: false,
    payment_channel: 'in store',
    transaction_code: null,
    transaction_type: null,
    check_number: null,
    account_owner: null,
    location: null,
    payment_meta: null,
    counterparties: [],
    category: 'food and drink',
    account_name: 'Checking',
    institution_name: 'Chase',
    ...over,
  };
}

async function storeBank(rows: ReturnType<typeof bankTxn>[]) {
  await fake.set(
    ctxKey('txns:item_chase'),
    await encodeJsonBlob(TEST_CTX, {
      schema_version: 2,
      cursor: 'c1',
      accounts: { acc_chk: { name: 'Checking', official_name: null, type: 'depository', subtype: 'checking', mask: '1111', balances: null } },
      txns: Object.fromEntries(rows.map((t) => [t.transaction_id, t])),
      synced_at: new Date().toISOString(),
    })
  );
}

const BANK = [bankTxn('b_first', 120, 10, { name: 'FIRST ROW' }), bankTxn('b_grocer', 3, 20, { name: 'GROCER' })];

beforeEach(async () => {
  fake.reset();
  forgetEpochs();
  plaid.later = [];
  await registerTestContainer(fake);
  await saveItem(ctx, { item_id: 'item_chase', institution_name: 'Chase', encrypted_access_token: await encrypt(TEST_CTX, 'access-sandbox-chase') });
  await fake.hset(ctxKey('accounts:meta'), {
    item_chase: await encrypt(TEST_CTX, 
      JSON.stringify([{ account_id: 'acc_chk', name: 'Checking', official_name: null, mask: '1111', type: 'depository', subtype: 'checking', limit: null, currency: 'USD' }])
    ),
  });
  await storeBank(BANK);
});

/** A bank's CSV export with a category column, read by its columns. */
const OPTIONS = { csv: { columns: { date: 0, description: 1, amount: 2, category: 3 }, sign: 'negative-out' } };
function csv(rows: { days: number; name: string; amount: number; category: string }[]): string {
  return ['Date,Description,Amount,Category', ...rows.map((r) => `${daysAgo(r.days)},${r.name},${r.amount.toFixed(2)},${r.category}`)].join('\n');
}
function upload(meta: Record<string, unknown>, file: string): Request {
  const form = new FormData();
  form.set('file', new Blob([new TextEncoder().encode(file) as Uint8Array<ArrayBuffer>]), 'export.csv');
  form.set('meta', JSON.stringify({ file_name: 'export.csv', ...meta }));
  return new Request('http://localhost/api/history-import', { method: 'POST', body: form });
}
async function importCsv(file: string): Promise<string> {
  const p = await routes.POST(upload({ action: 'preview', account_id: 'acc_chk', options: OPTIONS }, file));
  const review = (await p.json()).preview.review;
  const res = await routes.POST(upload({ action: 'import', account_id: 'acc_chk', options: OPTIONS, review }, file));
  const body = await res.json();
  expect(res.status).toBe(200);
  return body.import_id;
}

/** The Activity tab's answer, as the app reads it (filing, and growing the set). */
async function activity(): Promise<{ transactions: any[]; categories: any }> {
  const res = await transactionsRoute.GET(new Request('http://localhost/api/transactions?refresh=1'));
  expect(res.status).toBe(200);
  return res.json();
}
const one = (rows: any[], name: string) => rows.find((t) => t.name === name);
const categoryNamed = (t: any, name: string) => t.categories.find((c: any) => c.name.toLowerCase() === name.toLowerCase());
const groupOf = (t: any, c: any) => t.groups.find((g: any) => g.id === c.group);
async function choose(transaction_id: string, category_id: string) {
  const res = await recategorizeRoute.POST(new Request('http://localhost/api/recategorize', { method: 'POST', body: JSON.stringify({ transaction_id, category_id }) }));
  expect(res.status).toBe(200);
}
async function change(body: Record<string, unknown>): Promise<{ status: number; body: any }> {
  const res = await categoriesRoute.POST(new Request('http://localhost/api/categories', { method: 'POST', body: JSON.stringify(body) }));
  return { status: res.status, body: await res.json() };
}

describe('on the Activity tab', () => {
  test('filed by the file’s own words, which grow a category; a category chosen through the picker is stored as its words and filed by its id', async () => {
    await importCsv(csv([{ days: 40, name: 'STAPLES 0042', amount: -35.5, category: 'Home office' }]));
    const a = await activity();
    const office = categoryNamed(a.categories, 'home office');
    expect(office).toBeDefined();
    const row = one(a.transactions, 'STAPLES 0042');
    expect([row.source, row.category_id, row.category_kind]).toEqual(['import:csv', office.id, 'expense']);
    // Chosen through the picker: stored as the category's words, filed by its id.
    const food = categoryNamed(a.categories, 'food and drink');
    await choose(row.transaction_id, food.id);
    expect((await getOverrides(ctx))[row.transaction_id]).toBe('food and drink');
    expect(one((await activity()).transactions, 'STAPLES 0042').category_id).toBe(food.id);
  });
});

describe('in budgets, the Plan and the API', () => {
  test('count in a category’s budget and its group’s, by their category’s kind in the Plan, and by id and group in the API', async () => {
    await importCsv(
      csv([
        { days: 40, name: 'STAPLES 0042', amount: -35.5, category: 'Home office' },
        { days: 41, name: 'CLIENT PAYMENT', amount: 900, category: 'Income' },
      ])
    );
    const a = await activity();
    const office = categoryNamed(a.categories, 'home office');
    const group = groupOf(a.categories, office);
    const put = await budgetsRoute.PUT(
      new Request('http://localhost/api/budgets', {
        method: 'PUT',
        body: JSON.stringify({ budget_set: { categories: { [office.id]: { amount: 50 } }, groups: { [group.id]: { amount: 100 } } } }),
      })
    );
    expect(put.status).toBe(200);
    // Each month has the budgets it had then (#37, lib/rollover.ts), and the
    // save noted these as made this month, with none before. The record by
    // month says instead that they were kept since the month the imported
    // rows fall in, as for someone who budgeted then, so that month's
    // budgets are these, and what the rows spent counts against them.
    const month = daysAgo(40).slice(0, 7);
    await budgetMonthsStore.set(ctx, startMonths((await loadBudgets(ctx)).budgets, month));
    const budgets = await readBudgets(ctx, { month });
    expect(budgets.budgets.find((b) => b.category_id === office.id)).toMatchObject({ budget: 50, spent: 35.5 });
    expect(budgets.groups.find((g) => g.id === group.id)).toMatchObject({ own: 100, spent: 35.5 });

    // The Plan: the client's payment is income by its category's kind, the
    // purchase spending.
    const rows = a.transactions;
    expect([planFlow(one(rows, 'CLIENT PAYMENT')), planFlow(one(rows, 'STAPLES 0042'))]).toEqual(['income', 'spending']);

    // The API: found by its category's id, with its group.
    const page = await queryTransactions(ctx, { from: daysAgo(364), to: daysAgo(0), categoryId: office.id, limit: 50 });
    expect(page.transactions.map((t) => [t.name, t.category_id, t.group_id, t.source])).toEqual([['STAPLES 0042', office.id, group.id, 'import:csv']]);
    expect((await readSpending(ctx, { from: daysAgo(364), to: daysAgo(0) })).categories.find((c) => c.category_id === office.id)).toMatchObject({
      group_id: group.id,
      spent: 35.5,
      transactions: 1,
    });
  });
});

describe('a category’s usage', () => {
  test('counts imported rows of any date, by their own words or as chosen for them: a delete is refused while one uses it, and a merge takes them along', async () => {
    // Years old: past every window the app reads, still the account's.
    await importCsv(
      csv([
        { days: 1500, name: 'OLD ANTIQUE SHOP', amount: -80, category: 'Antiques' },
        { days: 40, name: 'STAPLES 0042', amount: -35.5, category: 'Home office' },
      ])
    );
    let a = await activity();
    const misc = groupOf(a.categories, categoryNamed(a.categories, 'other'));
    const added = await change({ action: 'add-category', name: 'Antiques', group: misc.id });
    expect(added.status).toBe(200);
    const antiques = categoryNamed(added.body.categories, 'antiques');
    const refused = await change({ action: 'delete-category', id: antiques.id });
    expect(refused.status).toBe(409);

    // Chosen for an imported row: used too.
    a = await activity();
    const crafts = await change({ action: 'add-category', name: 'Crafts', group: misc.id });
    const craftsId = categoryNamed(crafts.body.categories, 'crafts').id;
    await choose(one(a.transactions, 'STAPLES 0042').transaction_id, craftsId);
    expect((await change({ action: 'delete-category', id: craftsId })).status).toBe(409);

    // Merged: the row is filed under the category it went into.
    const food = categoryNamed(a.categories, 'food and drink');
    expect((await change({ action: 'merge', id: craftsId, into: food.id })).status).toBe(200);
    expect(one((await activity()).transactions, 'STAPLES 0042').category_id).toBe(food.id);
  });
});

describe('the download', () => {
  test('files imported rows in the nya_ columns, and a bank row standing for one the person chose a category for by that category, as the app does', async () => {
    await importCsv(
      csv([
        { days: 40, name: 'STAPLES 0042', amount: -35.5, category: 'Home office' },
        { days: 50, name: 'CORNER SHOP', amount: -60, category: 'Groceries' },
      ])
    );
    let a = await activity();
    const office = categoryNamed(a.categories, 'home office');
    const crafts = categoryNamed((await change({ action: 'add-category', name: 'Crafts', group: groupOf(a.categories, office).id })).body.categories, 'crafts');
    await choose(one(a.transactions, 'CORNER SHOP').transaction_id, crafts.id);
    // The bank sends the corner shop later: its row stands for the imported one.
    plaid.later.push(bankTxn('b_mid', 49, 60, { name: 'CORNER SHOP #12' }));
    a = await activity();
    const bankRow = one(a.transactions, 'CORNER SHOP #12');
    expect(bankRow.category_id).toBe(crafts.id);
    expect(one(a.transactions, 'CORNER SHOP')).toBeUndefined();

    const doc = buildUserExport(await collectUserData({ ctx, userId: null }), new Date());
    // The JSON: the bank row filed by the carried category, as the app files it.
    const json = doc.transactions.find((t) => t.transaction_id === 'b_mid')!;
    expect([json.your_category, json.nya_category, json.nya_category_id]).toEqual([null, crafts.name, crafts.id]);
    // The CSV: the imported row in its own category, and the bank row as yours.
    const [header, ...rows] = parseCsv([...exportFile(doc, 'transactions-csv').pieces()].join(''));
    expect(header).toEqual([...TRANSACTION_COLUMNS]);
    const col = (r: string[], name: (typeof TRANSACTION_COLUMNS)[number]) => r[TRANSACTION_COLUMNS.indexOf(name)];
    const byName = (name: string) => rows.find((r) => col(r, 'name') === name)!;
    const staples = byName('STAPLES 0042');
    expect([col(staples, 'source'), col(staples, 'category'), col(staples, 'nya_category'), col(staples, 'nya_category_id'), col(staples, 'nya_group')]).toEqual([
      'import:csv',
      'home office',
      office.name,
      office.id,
      groupOf(a.categories, office).name,
    ]);
    const mid = byName('CORNER SHOP #12');
    expect([col(mid, 'your_category'), col(mid, 'nya_category'), col(mid, 'nya_category_id')]).toEqual(['crafts', crafts.name, crafts.id]);
    expect(rows.some((r) => col(r, 'name') === 'CORNER SHOP')).toBe(false);
  });
});
