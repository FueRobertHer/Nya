import { describe, expect, test, mock, beforeEach, afterEach } from 'bun:test';
import './clerk-mock';
import { FakeRedis, storageMock, ctxKey, registerTestContainer, unscopedDataKeys, TEST_CTX } from './fake-redis';

// An account's end (#50) where the integration branch meets it: a report on
// a period an account ended in (lib/report/), its totals held to the Activity
// tab's own route and the read-only API's for the same period; budgets and
// group budgets; a category's uses, for deleting it; and what the data
// download says of closures and notes it can't read. Through the real read
// layer, from stored data: a closure stored under an earlier id and carried
// by a link, an account no longer followed, a manual account closed, an
// assumed closure, a missing window, and a hidden account that ended.

process.env.PLAID_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');

// The Activity tab syncs: Plaid answers with nothing new, so its rows are the
// stored ones. A report never calls Plaid at all.
const plaidCalls: string[] = [];
mock.module('@/lib/plaid', () => ({
  plaidClient: new Proxy(
    {},
    {
      get(_target, prop) {
        return async () => {
          plaidCalls.push(String(prop));
          if (prop !== 'transactionsSync') throw new Error(`Plaid ${String(prop)} must not be called here`);
          return {
            data: { added: [], modified: [], removed: [], accounts: [], next_cursor: 'c2', has_more: false, transactions_update_status: 'HISTORICAL_UPDATE_COMPLETE' },
          };
        };
      },
    }
  ),
}));

const fake = new FakeRedis({ deserialize: true });
mock.module('@/lib/storage', () => storageMock(fake));
afterEach(() => expect(unscopedDataKeys(fake)).toEqual([]));

const { ctx, txn } = await import('./api-fixture');
const { forgetEpochs } = await import('@/lib/sessions');
const { encrypt } = await import('@/lib/crypto');
const { encodeJsonBlob } = await import('@/lib/blob');
const { saveItem } = await import('@/lib/storage');
const { saveManualAccount } = await import('@/lib/manual');
const { manualTxnStore, newManualTxn } = await import('@/lib/manual-txns');
const { setAccountHidden } = await import('@/lib/hidden');
const { linkAccounts } = await import('@/lib/links');
const { markEnded, recordAssumedClosures, liftAssumedClosures } = await import('@/lib/lifecycle');
const { readReport } = await import('@/lib/report/read');
const { resolvePeriod } = await import('@/lib/report/period');
const { gapSentences } = await import('@/lib/report/words');
const { readSpending, readBudgets } = await import('@/lib/api-read');
const { summarize } = await import('@/lib/totals');
const { categoryUsage } = await import('@/lib/category-usage');
const { ensureTaxonomy } = await import('@/lib/category-store');
const { loadBudgets, saveBudgets } = await import('@/lib/budget-store');
const { StoredDataUnreadableError } = await import('@/lib/repo');
const { collectUserData, buildUserExport, exportFile } = await import('@/lib/user-export');
const transactionsRoute = await import('@/app/api/transactions/route');
const categoriesRoute = await import('@/app/api/categories/route');

beforeEach(async () => {
  fake.reset();
  forgetEpochs();
  await registerTestContainer(fake);
  plaidCalls.length = 0;
});

/** A whole month two months back: inside every window the app reads, and
 *  never cut by today, whenever the tests run. */
const first = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth() - 2, 1));
const M = first.toISOString().slice(0, 7);
const day = (d: number) => `${M}-${String(d).padStart(2, '0')}`;
const LAST = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).toISOString().slice(0, 10);
const BEFORE = new Date(first.getTime() - 10 * 86_400_000).toISOString().slice(0, 10);
const noon = (d: string) => Date.parse(`${d}T12:00:00.000Z`);

const CHASE = (name: string, mask: string, type: string) => ({ type, label: { name, institution: 'Chase', mask }, item_id: 'item_bank' });
const CARD = CHASE('Card', '2222', 'credit');
const CHECKING = CHASE('Checking', '1111', 'depository');
const SAVINGS = CHASE('Savings', '3333', 'depository');
const WALLET = { type: 'depository', label: { name: 'Wallet', institution: 'Cash', mask: null }, item_id: null };

/** Chase: checking, a card and savings, as the last load remembered them and
 *  as stored, with a month of rows; and a cash wallet entered by hand. */
async function seed() {
  await saveItem(ctx, { item_id: 'item_bank', institution_name: 'Chase', encrypted_access_token: await encrypt(TEST_CTX, 'access-sandbox-bank') });
  const accounts = {
    acc_chk: { name: 'Checking', official_name: null, type: 'depository', subtype: 'checking', mask: '1111', balances: null },
    acc_card: { name: 'Card', official_name: null, type: 'credit', subtype: 'credit card', mask: '2222', balances: null },
    acc_save: { name: 'Savings', official_name: null, type: 'depository', subtype: 'savings', mask: '3333', balances: null },
  };
  await fake.hset(ctxKey('accounts:meta'), {
    item_bank: await encrypt(TEST_CTX, 
      JSON.stringify(
        Object.entries(accounts).map(([account_id, a]) => ({ account_id, name: a.name, official_name: null, type: a.type, subtype: a.subtype, mask: a.mask, limit: null, currency: 'USD' }))
      )
    ),
  });
  const rows = [
    txn('r_old', 'acc_chk', 0, 1, { date: BEFORE }),
    txn('r_pay', 'acc_chk', 0, -2000, { date: day(2), category: 'income' }),
    txn('r_lunch', 'acc_chk', 0, 40, { date: day(3), category: 'food and drink' }),
    txn('r_card', 'acc_card', 0, 25, { date: day(5), category: 'food and drink', account_name: 'Card' }),
    txn('r_save', 'acc_save', 0, 7, { date: day(7), account_name: 'Savings' }),
    // The card's end day, and after it.
    txn('r_card_end', 'acc_card', 0, 60, { date: day(10), category: 'food and drink', account_name: 'Card' }),
    txn('r_hobby', 'acc_card', 0, 33, { date: day(14), category: 'old hobby', account_name: 'Card' }),
    // After checking stopped being tracked.
    txn('r_tv', 'acc_chk', 0, 100, { date: day(20) }),
  ];
  await fake.set(
    ctxKey('txns:item_bank'),
    await encodeJsonBlob(TEST_CTX, { schema_version: 2, cursor: 'c1', accounts, txns: Object.fromEntries(rows.map((t) => [t.transaction_id, t])), synced_at: new Date().toISOString() })
  );
  await saveManualAccount(ctx, { account_id: 'manual_wallet', name: 'Wallet', institution_name: 'Cash', type: 'depository', subtype: 'cash', balance: 40, updated_at: new Date().toISOString() });
  const entered = (date: string, amount: number) => newManualTxn('manual_wallet', { date, amount, currency: 'USD', name: `Market ${date}`, category: 'food and drink', note: null });
  await manualTxnStore.set(ctx, 'manual_wallet', { version: 1, rows: [entered(day(8), 15), entered(day(25), 9)] });
}

/**
 * The ends: the card closed on the 10th, stored under the id it had before a
 * re-link; checking no longer followed from the 18th; the wallet closed on the
 * 21st; an old savings account Nya assumed closed on the 25th; savings missing
 * from Chase's answer from the 6th to the 9th, assumed closed and back; and a
 * hidden account that closed.
 */
async function endThem() {
  await markEnded(ctx, 'acc_card_old', { state: 'closed', on: day(10) }, CARD);
  await linkAccounts(ctx, 'acc_card_old', 'acc_card', { old_type: 'credit' });
  await markEnded(ctx, 'acc_chk', { state: 'untracked', from: day(18) }, CHECKING);
  await markEnded(ctx, 'manual_wallet', { state: 'closed', on: day(21) }, WALLET);
  await recordAssumedClosures(ctx, [{ account_id: 'acc_gone', on: day(25), about: CHASE('Old Savings', '4821', 'depository') }]);
  await recordAssumedClosures(ctx, [{ account_id: 'acc_save', on: day(6), about: SAVINGS }], noon(day(6)));
  await liftAssumedClosures(ctx, ['acc_save'], noon(day(10)));
  await setAccountHidden(ctx, 'acc_hid', 'depository', true);
  await markEnded(ctx, 'acc_hid', { state: 'closed', on: day(12) }, CHASE('Hidden', '9999', 'depository'));
}

const monthPeriod = () => {
  const p = resolvePeriod({ kind: 'range', start: day(1), end: LAST }, 'UTC', Date.now());
  if ('error' in p) throw new Error(p.error);
  return p;
};
const quiet = async <T>(f: () => Promise<T>): Promise<T> => {
  const [error, warn] = [console.error, console.warn];
  console.error = console.warn = () => {};
  try {
    return await f();
  } finally {
    [console.error, console.warn] = [error, warn];
  }
};

describe('a report on a period an account ended in', () => {
  test('its totals are the Activity tab’s and the API’s for the same period: an ended account’s rows from its end day on left out, by every id it has had', async () => {
    await seed();
    await endThem();
    const p = monthPeriod();
    const report = await quiet(() => readReport(ctx, p, { currency: 'USD' }));
    expect(plaidCalls).toEqual([]);
    // In: the pay. Out: lunch, the card before its end, savings, the wallet's
    // first. Not the card's end day or after (under its new id), checking's
    // TV, or the wallet's after it closed.
    expect(report.totals).toMatchObject({ money_in: 2000, money_out: 40 + 25 + 7 + 15, transactions: 5 });

    // The Activity tab: its own route, synced, for the same month.
    const res = await quiet(() => transactionsRoute.GET(new Request('https://nya.test/api/transactions?refresh=1')));
    expect(res.status).toBe(200);
    const shown = (await res.json()).transactions as Parameters<typeof summarize>[0];
    const tab = summarize(shown, (d) => d >= p.start && d <= p.through, 'USD');
    expect(report.totals).toEqual({
      money_in: tab.money_in,
      money_out: tab.money_out,
      net: tab.net,
      transactions: tab.transactions,
      counted: tab.counted,
      transfers: tab.transfers,
      excluded: tab.excluded,
      // The fixture has no rules: none of what is left out is a rule's hide.
      hidden_by_rule: 0,
      exclusion_unknown: tab.exclusion_unknown,
      left_out: tab.left_out,
      left_out_text: tab.left_out_text,
    });

    // The read-only API, by category too.
    const api = await quiet(() => readSpending(ctx, { from: p.start, to: p.through, currency: 'USD' }));
    expect([report.totals.money_in, report.totals.money_out, report.totals.counted]).toEqual([api.money_in, api.money_out, api.counted]);
    expect(report.money_out.map((c) => ({ category: c.category, spent: c.amount, transactions: c.transactions }))).toEqual(
      api.categories.map((c) => ({ category: c.category, spent: c.spent, transactions: c.transactions }))
    );
  });

  test('the sources name each account as closed, no longer followed or assumed closed on its day, with what of it isn’t counted; a hidden one isn’t named', async () => {
    await seed();
    await endThem();
    const report = await quiet(() => readReport(ctx, monthPeriod()));
    expect(report.ended).toEqual([
      { account: 'Card ••2222', institution: 'Chase', state: 'closed', assumed: false, end: day(10), counted_through: day(9), not_counted: 2 },
      { account: 'Checking ••1111', institution: 'Chase', state: 'untracked', assumed: false, end: day(18), counted_through: day(17), not_counted: 1 },
      { account: 'Wallet', institution: 'Cash', state: 'closed', assumed: false, end: day(21), counted_through: day(20), not_counted: 1 },
      { account: 'Old Savings ••4821', institution: 'Chase', state: 'closed', assumed: true, end: day(25), counted_through: day(24), not_counted: 0 },
    ]);
    expect(JSON.stringify(report)).not.toContain('Hidden ••9999');
    // The assumed closure, the missing window and the account still the
    // person's are what may be missing, under Chase's row too.
    expect(report.gaps).toEqual([
      { kind: 'assumed_closed', item_id: 'item_bank', institution: 'Chase', account: 'Old Savings ••4821', on: day(25) },
      { kind: 'missed', item_id: 'item_bank', institution: 'Chase', account: 'Savings ••3333', from: day(6), to: day(9) },
      { kind: 'untracked', item_id: 'item_bank', institution: 'Chase', account: 'Checking ••1111', from: day(18), not_counted: 1 },
    ]);
    expect(gapSentences(report.gaps, (d) => d)).toEqual([
      `Old Savings ••4821 at Chase stopped appearing, and as nobody said whether it closed, Nya took it as closed on ${day(25)}: if it is still open, its transactions from then aren’t here.`,
      `Savings ••3333 was missing at Chase from ${day(6)} to ${day(9)}, so this report may be missing its transactions from those days.`,
      `You stopped following Checking ••1111 at Chase from ${day(18)}: it is still yours, but its transactions from then aren’t in this report, 1 transaction in Nya among them.`,
    ]);
    expect(report.months[0].gaps).toEqual(['Chase']);
    // The wallet counts on the days before it closed: a source of this month.
    expect(report.manual.map((m) => [m.name, m.transactions])).toEqual([['Wallet', 1]]);
  });

  test('a connection whose only account closed before the period, and that stopped syncing since, has nothing in it to be missing', async () => {
    await seed();
    await saveItem(ctx, { item_id: 'item_citi', institution_name: 'Citi', encrypted_access_token: await encrypt(TEST_CTX, 'access-sandbox-citi') });
    await fake.hset(ctxKey('accounts:meta'), {
      item_citi: await encrypt(TEST_CTX, JSON.stringify([{ account_id: 'acc_dc', name: 'Double Cash', official_name: null, type: 'credit', subtype: 'credit card', mask: '5555', limit: null, currency: 'USD' }])),
    });
    const card = { name: 'Double Cash', official_name: null, type: 'credit', subtype: 'credit card', mask: '5555', balances: null };
    await fake.set(
      ctxKey('txns:item_citi'),
      await encodeJsonBlob(TEST_CTX, { schema_version: 2, cursor: 'c', accounts: { acc_dc: card }, txns: { dc_1: txn('dc_1', 'acc_dc', 0, 5, { date: '2020-01-02', institution_name: 'Citi' }) }, synced_at: `${BEFORE}T12:00:00.000Z` })
    );
    const p = monthPeriod();
    // Still open, it last synced before the month: a gap.
    const open = await quiet(() => readReport(ctx, p));
    expect(open.gaps.map((g) => [g.kind, g.institution])).toEqual([['stale', 'Citi']]);
    await markEnded(ctx, 'acc_dc', { state: 'closed', on: BEFORE }, { type: 'credit', label: { name: 'Double Cash', institution: 'Citi', mask: '5555' }, item_id: 'item_citi' });
    const closed = await quiet(() => readReport(ctx, p));
    expect(closed.gaps).toEqual([]);
    expect(closed.institutions.find((i) => i.institution_name === 'Citi')!.ended_by).toBe(BEFORE);
    expect(closed.institutions.find((i) => i.institution_name === 'Chase')!.ended_by).toBeNull();
  });

  test('a period older than the history keeps the rows entered by hand into it, and a closed manual account’s from its day are left out and said', async () => {
    await saveManualAccount(ctx, { account_id: 'manual_jar', name: 'Jar', institution_name: 'Home', type: 'depository', subtype: 'cash', balance: 0, updated_at: new Date().toISOString() });
    const jar = (date: string, amount: number) => newManualTxn('manual_jar', { date, amount, currency: 'USD', name: `Jar ${date}`, category: 'food and drink', note: null });
    await manualTxnStore.set(ctx, 'manual_jar', { version: 1, rows: [jar('2023-03-01', 10), jar('2023-06-01', 20)] });
    await markEnded(ctx, 'manual_jar', { state: 'closed', on: '2023-05-01' }, { type: 'depository', label: { name: 'Jar', institution: 'Home', mask: null }, item_id: null });
    const p = resolvePeriod({ kind: 'year', year: 2023 }, 'UTC', Date.now());
    if ('error' in p) throw new Error(p.error);
    const report = await quiet(() => readReport(ctx, p));
    expect(report.totals).toMatchObject({ money_out: 10, transactions: 1 });
    expect(report.ended).toEqual([{ account: 'Jar', institution: 'Home', state: 'closed', assumed: false, end: '2023-05-01', counted_through: '2023-04-30', not_counted: 1 }]);
    expect(report.manual.map((m) => [m.name, m.transactions])).toEqual([['Jar', 1]]);
    // A year after it closed, it isn't a source, and has nothing to say.
    const later = resolvePeriod({ kind: 'year', year: 2024 }, 'UTC', Date.now());
    if ('error' in later) throw new Error(later.error);
    const after = await quiet(() => readReport(ctx, later));
    expect([after.manual, after.ended]).toEqual([[], []]);
  });

  test('closures that can’t be read fail the report, as they fail the Activity tab: never one counting an account the person closed', async () => {
    await seed();
    await fake.hset(ctxKey('account-lifecycle'), { acc_card: 'damaged-bytes-damaged-bytes-damaged' });
    await expect(quiet(() => readReport(ctx, monthPeriod()))).rejects.toBeInstanceOf(StoredDataUnreadableError);
  });
});

describe('categories and budgets', () => {
  /** The categories as the app stores them on its first load, with the
   *  words the card's old row carries. */
  const stored = async () => {
    await loadBudgets(ctx);
    return ensureTaxonomy(ctx, { observed: [{ provider: 'text', key: 'old hobby' }] });
  };

  test('budgets and group budgets leave an ended account’s rows out from its end day, as the Budgets tab does; the days before still count', async () => {
    await seed();
    const t = await stored();
    const food = t.categories.find((c) => c.name === 'food and drink')!;
    await saveBudgets(ctx, { categories: { [food.id]: { amount: 200 } }, groups: { [food.group]: { amount: 150 } } }, t);
    const spent = async () => {
      const b = await quiet(() => readBudgets(ctx, { month: M }));
      return { category: b.budgets.find((x) => x.category_id === food.id)!.spent, group: b.groups.find((g) => g.id === food.group)!.spent };
    };
    expect(await spent()).toEqual({ category: 40 + 25 + 15 + 60 + 9, group: 40 + 25 + 15 + 60 + 9 });
    await endThem();
    expect(await spent()).toEqual({ category: 40 + 25 + 15, group: 40 + 25 + 15 });
  });

  test('a category’s uses, for deleting it, count an ended account’s rows from its end day: still stored, filed under it, and back if it is reopened', async () => {
    await seed();
    await endThem();
    const t = await stored();
    const hobby = t.categories.find((c) => c.name === 'old hobby')!;
    // The card's row after its end, in no total anywhere.
    const api = await quiet(() => readSpending(ctx, { from: day(1), to: LAST }));
    expect(api.categories.map((c) => c.category)).not.toContain('old hobby');
    expect((await quiet(() => categoryUsage(ctx, t, hobby.id))).transactions).toBe(1);
    const res = await quiet(() =>
      categoriesRoute.POST(new Request('https://nya.test/api/categories', { method: 'POST', body: JSON.stringify({ action: 'delete-category', id: hobby.id }) }))
    );
    expect(res.status).toBe(409);
    expect((await res.json()).error).toContain('old hobby is used by 1 transaction');
  });
});

describe('the data download', () => {
  const unchanged = 'Nothing was changed: what could not be read is still stored as it was.';

  test('closures and notes it can’t read are named, with what that leaves each account’s end', async () => {
    await seed();
    await endThem();
    await fake.hset(ctxKey('account-lifecycle'), { acc_lost: 'damaged-bytes-damaged-bytes-damaged' });
    await fake.hset(ctxKey('timeline-notes'), { 'user.lost': 'damaged-bytes-damaged-bytes-damaged' });
    const doc = buildUserExport(await quiet(() => collectUserData({ ctx, userId: null })), new Date());
    expect(doc.problems).toContainEqual({ section: 'account-lifecycle', problem: 'unreadable', ids: ['acc_lost'] });
    expect(doc.notes).toContain(
      `Not all of your account closures could be read, so this file is missing 1 entry whose stored data is damaged. The JSON file lists them under problems, each by the id of the account it is about, whose lifecycle in this file is then null although it may have ended. ${unchanged}`
    );
    expect(doc.notes).toContain(`Not all of your timeline notes could be read, so this file is missing 1 note whose stored data is damaged. The JSON file lists them under problems. ${unchanged}`);
    // The balances CSV is made from both, and says it in its own words.
    const balances = exportFile(doc, 'balances-csv');
    expect(balances.incomplete).toEqual(expect.arrayContaining(['account-lifecycle', 'timeline-notes']));
    expect(balances.notes).toContain(
      `Not all of your account closures could be read: 1 entry whose stored data is damaged. An account one of them is about has no account_state in this file, although it may have ended. The JSON download lists them under problems. ${unchanged}`
    );
    expect(balances.notes).toContain(`Not all of your timeline notes could be read, so this file is missing 1 note whose stored data is damaged. The JSON download lists them under problems. ${unchanged}`);
    // The transactions CSV is made from neither: nothing is missing from it.
    const transactions = exportFile(doc, 'transactions-csv');
    expect(transactions.incomplete).toEqual([]);
    expect(transactions.notes.join(' ')).not.toContain('account closures');
  });
});
