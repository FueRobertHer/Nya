import { describe, expect, test, mock, beforeEach, afterEach } from 'bun:test';
import './clerk-mock';
import { FakeRedis, storageMock, TEST_CTX, ctxKey, registerTestContainer, unscopedDataKeys } from './fake-redis';

// Rows imported into a linked account from its bank's files (#52) in the
// months budget rollover counts (#37, lib/budget-month.ts) and a goal's pace
// averages (#42, lib/goal-flows.ts). They count as the bank's rows do, and
// where the transactions in Nya begin counts them too. A month before a
// bank's stored history begins is complete where files cover it for every
// one of its bank accounts and cards (a goal's account, for its pace), by
// the one rule a report counts them by (lib/history-import/coverage.ts); a
// connection that stopped after it synced stays said to have stopped.

process.env.PLAID_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');

mock.module('@/lib/plaid', () => ({
  plaidClient: {
    transactionsSync: async () => ({
      data: { added: [], modified: [], removed: [], accounts: [], next_cursor: 'c-next', has_more: false, transactions_update_status: 'HISTORICAL_UPDATE_COMPLETE' },
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
const { syncsStore } = await import('@/lib/connection-records');
const { setAccountHidden } = await import('@/lib/hidden');
const { markEnded } = await import('@/lib/lifecycle');
const { loadBudgets } = await import('@/lib/budget-store');
const { budgetMonthsStore } = await import('@/lib/budget-months-store');
const { startMonths, setRollover, monthGapsOf, NO_COVERAGE_GAPS } = await import('@/lib/rollover');
const { readBudgetMonth } = await import('@/lib/budget-month');
const { trailingMonths, addMonths } = await import('@/lib/goal-projection');
const routes = await import('@/app/api/history-import/route');
const budgetsRoute = await import('@/app/api/budgets/route');
const progressRoute = await import('@/app/api/goals/progress/route');

const ctx = TEST_CTX;
const NOW = new Date().toISOString().slice(0, 7);
// The three complete months before this one, oldest first: those a goal's
// pace averages, and those a rollover from M1 counts.
const [M1, M2, M3] = trailingMonths(NOW);
const lastDayOf = (m: string) => new Date(Date.UTC(Number(m.slice(0, 4)), Number(m.slice(5, 7)), 0)).toISOString().slice(0, 10);

function bankTxn(id: string, account_id: string, date: string, amount: number, category: string) {
  return {
    transaction_id: id,
    pending_transaction_id: null,
    account_id,
    amount,
    iso_currency_code: 'USD',
    unofficial_currency_code: null,
    date,
    authorized_date: null,
    authorized_datetime: null,
    datetime: null,
    name: id.toUpperCase(),
    merchant_name: null,
    merchant_entity_id: null,
    website: null,
    logo_url: null,
    personal_finance_category: null,
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
    category,
    account_name: account_id === 'acc_chk' ? 'Checking' : 'Savings',
    institution_name: 'Chase',
  };
}

// Chase's own rows begin in the middle of M2.
const BANK = [
  bankTxn('b_grocer', 'acc_chk', `${M2}-14`, 30, 'food and drink'),
  bankTxn('b_grocer2', 'acc_chk', `${M3}-10`, 30, 'food and drink'),
  bankTxn('b_in', 'acc_sav', `${M2}-20`, -250, 'transfer in'),
  bankTxn('b_in2', 'acc_sav', `${M3}-03`, -250, 'transfer in'),
];

beforeEach(async () => {
  fake.reset();
  forgetEpochs();
  await registerTestContainer(fake);
  await saveItem(ctx, { item_id: 'item_chase', institution_name: 'Chase', encrypted_access_token: await encrypt(TEST_CTX, 'access-sandbox-chase') });
  await fake.hset(ctxKey('accounts:meta'), {
    item_chase: await encrypt(TEST_CTX, 
      JSON.stringify([
        { account_id: 'acc_chk', name: 'Checking', official_name: null, mask: '1111', type: 'depository', subtype: 'checking', limit: null, currency: 'USD' },
        { account_id: 'acc_sav', name: 'Savings', official_name: null, mask: '2222', type: 'depository', subtype: 'savings', limit: null, currency: 'USD' },
      ])
    ),
  });
  await fake.set(
    ctxKey('txns:item_chase'),
    await encodeJsonBlob(TEST_CTX, {
      schema_version: 2,
      cursor: 'c1',
      accounts: {
        acc_chk: { name: 'Checking', official_name: null, type: 'depository', subtype: 'checking', mask: '1111', balances: null },
        acc_sav: { name: 'Savings', official_name: null, type: 'depository', subtype: 'savings', mask: '2222', balances: null },
      },
      txns: Object.fromEntries(BANK.map((t) => [t.transaction_id, t])),
      synced_at: new Date().toISOString(),
    })
  );
  await syncsStore.set(ctx, 'item_chase', { at: new Date().toISOString() });
});

/** A bank's CSV export with a category column, read by its columns: money
 *  out negative. */
const OPTIONS = { csv: { columns: { date: 0, description: 1, amount: 2, category: 3 }, sign: 'negative-out' } };
const csv = (rows: { date: string; name: string; amount: number; category: string }[]) =>
  ['Date,Description,Amount,Category', ...rows.map((r) => `${r.date},${r.name},${r.amount.toFixed(2)},${r.category}`)].join('\n');
function upload(meta: Record<string, unknown>, file: string): Request {
  const form = new FormData();
  form.set('file', new Blob([new TextEncoder().encode(file) as Uint8Array<ArrayBuffer>]), 'export.csv');
  form.set('meta', JSON.stringify({ file_name: 'export.csv', options: OPTIONS, ...meta }));
  return new Request('http://localhost/api/history-import', { method: 'POST', body: form });
}
/** Reviews a file, the period it covers as given, and imports it as reviewed. */
async function importCsv(account_id: string, file: string, covers: { from: string; to: string }) {
  const preview = await (await routes.POST(upload({ action: 'preview', account_id, covers }, file))).json();
  const res = await routes.POST(upload({ action: 'import', account_id, covers, review: preview.preview.review }, file));
  expect(res.status).toBe(200);
}
// Up to the day before Chase's own begin, so the files join them.
const UP_TO_THE_BANK = { from: `${M1}-01`, to: `${M2}-13` };
const checkingFile = csv([{ date: `${M1}-10`, name: 'OLD GROCER', amount: -20, category: 'food and drink' }]);
const savingsFile = csv([
  { date: `${M1}-05`, name: 'OLD TRANSFER', amount: 300, category: 'transfer in' },
  { date: `${M2}-02`, name: 'OLD TRANSFER', amount: 100, category: 'transfer in' },
]);

/** A budget of 100 on food and drink, rolling over from M1. */
async function foodBudgetFromM1(): Promise<string> {
  const t = (await (await budgetsRoute.GET()).json()).categories;
  const food = t.categories.find((c: { name: string }) => c.name.toLowerCase() === 'food and drink').id as string;
  const put = await budgetsRoute.PUT(new Request('http://x/api/budgets', { method: 'PUT', body: JSON.stringify({ budget_set: { categories: { [food]: { amount: 100 } }, groups: {} }, month: NOW }) }));
  expect(put.status).toBe(200);
  // Kept since M1, rolling over from then, as a budget made then would be.
  await budgetMonthsStore.set(ctx, setRollover(startMonths((await loadBudgets(ctx)).budgets, M1), 'categories', food, { on: true, from: M1 }, NOW));
  return food;
}
const monthRead = () => readBudgetMonth(ctx, { month: NOW, today: NOW });

describe('budget rollover', () => {
  test('imported rows count in the carry, and from the first month they reach; a month before the bank’s own is complete only once files cover it for every account', async () => {
    const food = await foodBudgetFromM1();
    // The bank's alone: the first month with transactions is M2, whose first
    // days aren't Chase's, so the carry counts from it; M1, before it, isn't
    // Chase's either.
    let read = await monthRead();
    expect(read.earliest).toBe(M2);
    expect(read.view.carries.categories[food]).toMatchObject({ carry: 140, from: M2, why: 'data', uncertain: [M2] });
    const begins = { kind: 'begins' as const, institution: 'Chase', first: `${M2}-14` };
    expect(read.gaps).toEqual([
      { month: M1, gaps: [begins] },
      { month: M2, gaps: [begins] },
    ]);

    // Checking's file, up to Chase's own: its row in M1 counts, and the
    // carry counts from M1, but savings has nothing there yet.
    await importCsv('acc_chk', checkingFile, UP_TO_THE_BANK);
    read = await monthRead();
    expect(read.earliest).toBe(M1);
    expect(read.view.carries.categories[food]).toMatchObject({ carry: 80 + 70 + 70, from: M1, why: 'start', uncertain: [M1, M2] });
    expect(read.gaps.map((g) => [g.month, g.gaps.map((x) => x.kind)])).toEqual([
      [M1, ['begins']],
      [M2, ['begins']],
    ]);

    // Savings hidden: Checking is all Chase counts, and its files cover it.
    await setAccountHidden(ctx, 'acc_sav', 'depository', true);
    expect((await monthRead()).gaps).toEqual([]);
    await setAccountHidden(ctx, 'acc_sav', 'depository', false);

    // Savings' file too: both are covered, so those months are complete.
    await importCsv('acc_sav', savingsFile, UP_TO_THE_BANK);
    read = await monthRead();
    expect(read.gaps).toEqual([]);
    expect(read.view.carries.categories[food]).toMatchObject({ carry: 220, from: M1, uncertain: [] });
  });

  test('a file that stops short of the bank’s own days leaves the days between short', async () => {
    const food = await foodBudgetFromM1();
    await importCsv('acc_chk', checkingFile, { from: `${M1}-01`, to: lastDayOf(M1) });
    await importCsv('acc_sav', savingsFile.split('\n').slice(0, 2).join('\n'), { from: `${M1}-01`, to: lastDayOf(M1) });
    const read = await monthRead();
    // M1 is whole in both files; M2 begins with days nothing covers.
    expect(read.gaps).toEqual([{ month: M2, gaps: [{ kind: 'begins', institution: 'Chase', first: `${M2}-14` }] }]);
    expect(read.view.carries.categories[food].uncertain).toEqual([M2]);
  });

  test('the rule, month by month: files stand for a connection’s own where it has none, through each account’s end, never for one that stopped after it synced', () => {
    const month = M1;
    const whole = [{ covers: [{ from: `${M1}-01`, to: `${M2}-05` }] }];
    // Plaid gives none for the bank: covered, the month is complete.
    const without = { ...NO_COVERAGE_GAPS, without: [{ institution: 'Credit union', reason: 'refused' as const, files: whole }] };
    expect(monthGapsOf(month, without)).toEqual([]);
    expect(monthGapsOf(M2, without).map((g) => g.kind)).toEqual(['without']);
    // Not synced yet: missing, but where its files cover it; another
    // connection of the same name that can't be read is still missing.
    const unsynced = {
      ...NO_COVERAGE_GAPS,
      incomplete: [{ institution_name: 'Chase', coverage: 'missing' as const, files: whole }],
      stopped: [{ institution_name: 'Chase', last_ok_at: null, files: whole }],
    };
    expect(monthGapsOf(month, unsynced)).toEqual([]);
    expect(monthGapsOf(M2, unsynced).map((g) => g.kind)).toEqual(['missing']);
    expect(monthGapsOf(month, { ...unsynced, incomplete: [...unsynced.incomplete, { institution_name: 'Chase', coverage: 'missing' as const }] }).map((g) => g.kind)).toEqual(['missing']);
    // A connection that stopped after it synced has no files to stand for it.
    expect(monthGapsOf(month, { ...NO_COVERAGE_GAPS, stopped: [{ institution_name: 'Chase', last_ok_at: `${month}-02T00:00:00.000Z` }] }).map((g) => g.kind)).toEqual(['stopped']);
    // An account that ended needs covering only up to the day before its
    // end, and one that ended before the month none of it.
    const first = (files: { covers: { from: string; to: string }[]; end?: string | null }[]) => ({ ...NO_COVERAGE_GAPS, first: [{ institution: 'Chase', day: `${M3}-01`, files }] });
    const card = { covers: [{ from: `${M1}-01`, to: `${M1}-09` }], end: `${M1}-10` };
    expect(monthGapsOf(month, first([...whole, card]))).toEqual([]);
    expect(monthGapsOf(month, first([...whole, { ...card, end: `${M1}-20` }])).map((g) => g.kind)).toEqual(['begins']);
    expect(monthGapsOf(month, first([...whole, { covers: [], end: `${M1}-01` }]))).toEqual([]);
    // None imported at all: the bank's own days decide, as before.
    expect(monthGapsOf(month, first([{ covers: [] }])).map((g) => g.kind)).toEqual(['begins']);
  });
});

describe('a goal’s pace', () => {
  const progress = async () => (await (await progressRoute.GET(new Request(`http://x/api/goals/progress?month=${NOW}`))).json()) as any;

  test('months before the bank’s own begin are unknown, and known once files reach back to them; the files’ rows go in as the bank’s do', async () => {
    expect((await progress()).flows.acc_sav.months).toEqual([
      { month: M1, amount: null },
      { month: M2, amount: 250, gaps: [{ kind: 'begins', on: `${M2}-14` }] },
      { month: M3, amount: 250 },
    ]);
    await importCsv('acc_sav', savingsFile, UP_TO_THE_BANK);
    expect((await progress()).flows.acc_sav.months).toEqual([
      { month: M1, amount: 300 },
      { month: M2, amount: 350 },
      { month: M3, amount: 250 },
    ]);
    // An account that ended has no pace, its imported rows with it.
    await markEnded(ctx, 'acc_sav', { state: 'closed', on: `${M3}-15` }, { type: 'depository', label: { name: 'Savings', institution: 'Chase', mask: '2222' }, item_id: 'item_chase' });
    expect((await progress()).flows.acc_sav).toBeUndefined();
  });

  test('a file that begins part way through a month says so', async () => {
    await importCsv('acc_sav', savingsFile, { from: `${M1}-03`, to: `${M2}-13` });
    expect((await progress()).flows.acc_sav.months[0]).toEqual({ month: M1, amount: 300, gaps: [{ kind: 'begins', on: `${M1}-03` }] });
  });

  describe('at a connection with no rows of its own', () => {
    // A credit union whose transactions Plaid doesn't provide, or one not
    // synced yet: its savings account is paced by its recorded balances,
    // here at each month's end since the month before M1.
    async function creditUnion(kind: 'refused' | 'unsynced') {
      await saveItem(ctx, {
        item_id: 'item_cu',
        institution_name: 'Credit union',
        encrypted_access_token: await encrypt(TEST_CTX, 'access-sandbox-cu'),
        ...(kind === 'refused' ? { transactions_billed: false } : {}),
      });
      await fake.hset(ctxKey('accounts:meta'), {
        item_cu: await encrypt(TEST_CTX, JSON.stringify([{ account_id: 'acc_cu', name: 'Savings', official_name: null, mask: '4444', type: 'depository', subtype: 'savings', limit: null, currency: 'USD' }])),
      });
      if (kind === 'refused') {
        await fake.set(
          ctxKey('txns:item_cu'),
          await encodeJsonBlob(TEST_CTX, { schema_version: 2, cursor: '', accounts: {}, txns: {}, refused: { at: new Date().toISOString(), code: 'PRODUCTS_NOT_SUPPORTED', accounts: ['acc_cu'] } })
        );
      }
      const balance = async (m: string, value: number) => fake.hset(ctxKey('history:accounts'), { [lastDayOf(m)]: await encrypt(TEST_CTX, JSON.stringify({ acc_cu: value })) });
      await balance(addMonths(M1, -1), 1000);
      await balance(M1, 1500);
      await balance(M2, 1500);
      await balance(M3, 1600);
    }
    const BY_BALANCES = {
      source: 'balances',
      months: [
        { month: M1, amount: 500 },
        { month: M2, amount: 0 },
        { month: M3, amount: 100 },
      ],
    };
    const july = csv([
      { date: `${M1}-05`, name: 'OLD TRANSFER', amount: 300, category: 'transfer in' },
      { date: `${M1}-20`, name: 'OLD TRANSFER', amount: 200, category: 'transfer in' },
    ]);
    const after = csv([{ date: `${M3}-10`, name: 'TRANSFER', amount: 100, category: 'transfer in' }]);

    for (const kind of ['refused', 'unsynced'] as const) {
      test(`${kind}: files that stop before the last month averaged leave it paced by its balances, never by months read as nothing in; once they reach it, its transactions count from where they begin`, async () => {
        await creditUnion(kind);
        expect((await progress()).flows.acc_cu).toEqual(BY_BALANCES);
        // A file covering M1 alone: what comes after it isn't known from
        // transactions, so the balances still say.
        await importCsv('acc_cu', july, { from: `${M1}-03`, to: lastDayOf(M1) });
        expect((await progress()).flows.acc_cu).toEqual(BY_BALANCES);
        // Another up to the end of M3: one run of covered days reaches it,
        // and begins where the first file does, not on its first row.
        await importCsv('acc_cu', after, { from: `${M2}-01`, to: lastDayOf(M3) });
        expect((await progress()).flows.acc_cu).toEqual({
          source: 'transactions',
          months: [
            { month: M1, amount: 500, gaps: [{ kind: 'begins', on: `${M1}-03` }] },
            { month: M2, amount: 0 },
            { month: M3, amount: 100 },
          ],
        });
      });
    }
  });

  test('cut off from the bank’s own days by days nothing covers, a file changes nothing', async () => {
    await importCsv('acc_sav', savingsFile.split('\n').slice(0, 2).join('\n'), { from: `${M1}-01`, to: lastDayOf(M1) });
    expect((await progress()).flows.acc_sav.months).toEqual([
      { month: M1, amount: null },
      { month: M2, amount: 250, gaps: [{ kind: 'begins', on: `${M2}-14` }] },
      { month: M3, amount: 250 },
    ]);
  });
});
