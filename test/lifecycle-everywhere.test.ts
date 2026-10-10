import { describe, expect, test, mock, beforeEach, afterEach } from 'bun:test';
import './clerk-mock';
import { FakeRedis, storageMock, ctxKey, registerTestContainer, unscopedDataKeys } from './fake-redis';
import { parseCsv } from './csv-parse';

// An account's end (#50) everywhere else: the read-only API (fields added
// only), transactions in budgets and spending from the end day, the data
// download (JSON and the balances CSV), and storage usage. Through the API's
// own fixture: a bit of everything, stored.

process.env.PLAID_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');

mock.module('@/lib/plaid', () => ({
  plaidClient: new Proxy({}, { get: () => async () => { throw new Error('Plaid must not be called here'); } }),
}));

const fake = new FakeRedis({ deserialize: true });
mock.module('@/lib/storage', () => storageMock(fake));
afterEach(() => expect(unscopedDataKeys(fake)).toEqual([]));

const { ctx, daysAgo, seedPerson } = await import('./api-fixture');
const { forgetEpochs } = await import('@/lib/sessions');
const { markEnded, recordAssumedClosures } = await import('@/lib/lifecycle');
const { addUserNote } = await import('@/lib/timeline-notes');
const { linkAccounts } = await import('@/lib/links');
const api = await import('@/lib/api-read');
const { StoredDataUnreadableError } = await import('@/lib/repo');
const { collectUserData, buildUserExport, exportFile, BALANCE_COLUMNS } = await import('@/lib/user-export');
const { readStorageUsage } = await import('@/lib/blob-sizes');

const CARD = { type: 'credit', label: { name: 'Card', institution: 'Chase', mask: '2222' }, item_id: 'item_chase' };
const WALLET = { type: 'depository', label: { name: 'Wallet', institution: 'Cash', mask: null }, item_id: null };

beforeEach(async () => {
  fake.reset();
  forgetEpochs();
  await registerTestContainer(fake);
  await seedPerson(fake);
});

const total = (nw: Awaited<ReturnType<typeof api.readNetWorth>>) => nw.totals.find((t) => t.currency === 'USD')!.net_worth;

describe('the read-only API gains fields, and counts an ended account in nothing from its day', () => {
  test('accounts carry their end; an open one says null', async () => {
    await markEnded(ctx, 'acc_card', { state: 'closed', on: daysAgo(7), note: 'Paid off' }, CARD);
    await recordAssumedClosures(ctx, [{ account_id: 'acc_ira', on: daysAgo(2), about: { ...CARD, type: 'investment' } }]);
    const { accounts } = await api.readAccounts(ctx);
    const byId = Object.fromEntries(accounts.map((a) => [a.id, a]));
    expect(byId.acc_card.lifecycle).toEqual({ state: 'closed', date: daysAgo(7), note: 'Paid off', assumed: false });
    expect(byId.acc_ira.lifecycle).toEqual({ state: 'closed', date: daysAgo(2), note: null, assumed: true });
    expect(byId.acc_chk.lifecycle).toBeNull();
    // Every other field as it was: an ended account is still listed.
    expect(byId.acc_card).toMatchObject({ balance: 310, is_debt: true, hidden: false });
  });

  test('net worth now leaves it out; its history from its end day', async () => {
    const before = await api.readNetWorthAndHistory(ctx, { includeEstimated: true, interval: 'day' });
    await markEnded(ctx, 'acc_card', { state: 'closed', on: daysAgo(2) }, CARD);
    const after = await api.readNetWorthAndHistory(ctx, { includeEstimated: true, interval: 'day' });
    // The card owed 310: without it, 310 more.
    expect(total(after.now)).toBe(total(before.now) + 310);
    expect(after.now.totals[0].accounts).toBe(before.now.totals[0].accounts - 1);
    const at = (h: typeof before.history, d: string) => h.points.find((p) => p.date === d)?.value;
    // Every day before it untouched, the end day on without the card.
    expect(at(after.history, daysAgo(10))).toBe(at(before.history, daysAgo(10)));
    expect(at(after.history, daysAgo(3))).toBe(at(before.history, daysAgo(3)));
    expect(at(after.history, daysAgo(2))).toBe(at(before.history, daysAgo(2))! + 300);
  });

  test('its transactions from its end day are left out of the list and of spending, those before stay', async () => {
    const all = await api.queryTransactions(ctx, { from: daysAgo(30), to: daysAgo(0), limit: 500 });
    const cardIds = (page: typeof all) => page.transactions.filter((t) => t.account_id === 'acc_card').map((t) => t.id).sort();
    expect(cardIds(all)).toEqual(['t_card', 't_paris']);
    await markEnded(ctx, 'acc_card', { state: 'closed', on: daysAgo(7) }, CARD);
    // t_paris is dated on the end day; t_card the day before.
    expect(cardIds(await api.queryTransactions(ctx, { from: daysAgo(30), to: daysAgo(0), limit: 500 }))).toEqual(['t_card']);
  });

  test('a manual account’s rows too (a cash jar emptied and closed)', async () => {
    const spent = async () => (await api.readSpending(ctx, { from: daysAgo(30), to: daysAgo(0) })).money_out;
    const before = await spent();
    await markEnded(ctx, 'manual_wallet', { state: 'closed', on: daysAgo(1) }, WALLET);
    expect(await spent()).toBe(before - 25);
  });

  test('an end that can’t be read fails the answer, never counting the account', async () => {
    await fake.hset(ctxKey('account-lifecycle'), { acc_card: 'damaged-bytes-damaged-bytes-damaged' });
    await expect(api.readNetWorth(ctx)).rejects.toBeInstanceOf(StoredDataUnreadableError);
    await expect(api.readAccounts(ctx)).rejects.toBeInstanceOf(StoredDataUnreadableError);
    await expect(api.queryTransactions(ctx, { from: daysAgo(30), to: daysAgo(0), limit: 10 })).rejects.toBeInstanceOf(StoredDataUnreadableError);
  });

  test('a re-link carries the end: an earlier id’s end applies to the account it became', async () => {
    await markEnded(ctx, 'acc_old_card', { state: 'untracked', from: daysAgo(30) }, CARD);
    await linkAccounts(ctx, 'acc_old_card', 'acc_card', { old_type: 'credit' });
    const { accounts } = await api.readAccounts(ctx);
    expect(accounts.find((a) => a.id === 'acc_card')?.lifecycle).toMatchObject({ state: 'untracked', date: daysAgo(30) });
  });
});

describe('the data download', () => {
  async function download() {
    return buildUserExport(await collectUserData({ ctx, userId: null }), new Date());
  }

  test('each account says when it ended, its stored closures and the notes have parts of their own', async () => {
    await markEnded(ctx, 'acc_card', { state: 'left', on: daysAgo(7), note: 'Divided' }, CARD);
    await markEnded(ctx, 'manual_wallet', { state: 'closed', on: daysAgo(1) }, WALLET);
    await addUserNote(ctx, { date: daysAgo(3), text: 'Bought the house', account_id: 'manual_house' });
    const doc = await download();
    expect(doc.accounts.find((a) => a.account_id === 'acc_card')?.lifecycle).toEqual({ state: 'left', date: daysAgo(7), note: 'Divided', assumed: false });
    expect(doc.accounts.find((a) => a.account_id === 'acc_chk')?.lifecycle).toBeNull();
    expect(doc.manual_accounts.find((m) => m.account_id === 'manual_wallet')?.lifecycle).toEqual({ state: 'closed', date: daysAgo(1), note: null, assumed: false });
    expect((doc['account-lifecycle'] as any[]).map((e) => [e.id, e.value.lifecycle])).toEqual([
      ['acc_card', { state: 'left', on: daysAgo(7), note: 'Divided' }],
      ['manual_wallet', { state: 'closed', on: daysAgo(1) }],
    ]);
    const notes = (doc['timeline-notes'] as any[]).map((e) => e.value);
    expect(notes.map((n) => [n.date, n.kind, n.text]).sort((a, b) => (a[0] < b[0] ? -1 : 1))).toEqual([
      [daysAgo(7), 'auto', 'Card ••2222 no longer yours: Divided'],
      [daysAgo(3), 'user', 'Bought the house'],
      [daysAgo(1), 'auto', 'Wallet closed'],
    ]);
  });

  test('an account known only from its closure is listed too', async () => {
    await markEnded(ctx, 'acc_long_gone', { state: 'closed', on: '2025-01-01' }, CARD);
    const doc = await download();
    expect(doc.accounts.find((a) => a.account_id === 'acc_long_gone')?.lifecycle).toMatchObject({ state: 'closed', date: '2025-01-01' });
  });

  test('the balances CSV carries each account’s end on its rows, and the notes as rows of their own', async () => {
    await markEnded(ctx, 'acc_card', { state: 'closed', on: daysAgo(7) }, CARD);
    await addUserNote(ctx, { date: daysAgo(3), text: 'A note, with "quotes"' });
    const file = exportFile(await download(), 'balances-csv');
    const [header, ...rows] = parseCsv([...file.pieces()].join(''));
    expect(header).toEqual([...BALANCE_COLUMNS]);
    const row = (r: string[]) => Object.fromEntries(header.map((h, i) => [h, r[i]]));
    const card = rows.map(row).find((r) => r.record === 'account' && r.account_id === 'acc_card')!;
    expect(card).toMatchObject({ account_state: 'closed', account_state_date: daysAgo(7), note: '' });
    const chk = rows.map(row).find((r) => r.record === 'account' && r.account_id === 'acc_chk')!;
    expect(chk).toMatchObject({ account_state: '', account_state_date: '' });
    const notes = rows.map(row).filter((r) => r.record === 'note');
    expect(notes).toEqual([
      expect.objectContaining({ date: daysAgo(7), kind: 'auto', account_id: 'acc_card', account_name: 'Card', note: 'Card ••2222 closed' }),
      expect.objectContaining({ date: daysAgo(3), kind: 'user', account_id: '', note: 'A note, with "quotes"', balance: '' }),
    ]);
    // Oldest day first still, the notes after the day's balances.
    const dates = rows.map((r) => r[0]);
    expect(dates).toEqual([...dates].sort());
  });

  test('a closure that can’t be read is named among the problems, and the CSV says it is incomplete', async () => {
    await fake.hset(ctxKey('account-lifecycle'), { acc_card: 'damaged-bytes-damaged-bytes-damaged' });
    const doc = await download();
    expect(doc.problems).toContainEqual({ section: 'account-lifecycle', problem: 'unreadable', ids: ['acc_card'] });
    expect(exportFile(doc, 'balances-csv').incomplete).toContain('account-lifecycle');
  });
});

describe('storage usage', () => {
  test('measures both stores', async () => {
    await markEnded(ctx, 'acc_card', { state: 'closed', on: daysAgo(7) }, CARD);
    await addUserNote(ctx, { date: daysAgo(3), text: 'Bought the house' });
    const { stores } = await readStorageUsage(ctx);
    const byName = Object.fromEntries(stores.map((s) => [s.store, s]));
    // One closure, and its note beside the person's own.
    expect(byName['account-lifecycle']).toMatchObject({ entries: 1 });
    expect(byName['timeline-notes']).toMatchObject({ entries: 2 });
    expect(byName['account-lifecycle'].chars).toBeGreaterThan(0);
  });
});
