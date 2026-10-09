import { describe, expect, test, mock, beforeEach, afterEach } from 'bun:test';
import { FakeRedis, storageMock, ctxKey, TEST_CTX, unscopedDataKeys } from './fake-redis';

// The stored reads the API is built on, which never call Plaid: each account's
// newest measured balance (lib/history.ts), an Item's rows as stored
// (lib/transactions.ts), and the remembered accounts with what can't be read
// named (lib/last-known.ts).

process.env.PLAID_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');

let syncPages: any[] = [];
mock.module('@/lib/plaid', () => ({
  plaidClient: {
    transactionsSync: async () => ({ data: syncPages.shift() }),
  },
}));

const fake = new FakeRedis({ deserialize: true });
mock.module('@/lib/storage', () => storageMock(fake));
afterEach(() => expect(unscopedDataKeys(fake)).toEqual([]));

const { encrypt } = await import('@/lib/crypto');
const { encodeJsonBlob, decodeJsonBlob } = await import('@/lib/blob');
const { latestMeasuredBalances } = await import('@/lib/history');
const { storedItemTransactions, syncItemTransactions } = await import('@/lib/transactions');
const { rememberedAccountsReport } = await import('@/lib/last-known');
const { sampleSeries, comparePageKeys } = await import('@/lib/api-read');

const ctx = TEST_CTX;
const DAY = 86_400_000;
const daysAgo = (n: number) => new Date(Date.now() - n * DAY).toISOString().slice(0, 10);
const map = (m: Record<string, number>) => encrypt(JSON.stringify(m));
const DAMAGED = 'not-ciphertext-but-long-enough-to-be-tried';

beforeEach(() => {
  fake.reset();
  syncPages = [];
});

describe('each account’s newest measured balance', () => {
  test('the newest date naming it, a partial map before the recorded one, never an estimate', async () => {
    await fake.hset(ctxKey('history:accounts'), {
      [daysAgo(3)]: await map({ a: 1, b: 10, c: 100 }),
      [daysAgo(2)]: await map({ a: 2, b: 20 }),
    });
    await fake.hset(ctxKey('history:accounts:partial'), { [daysAgo(2)]: await map({ a: 2.5 }), [daysAgo(1)]: await map({ b: 30 }) });
    await fake.hset(ctxKey('history:accounts:est'), { [daysAgo(0)]: await map({ a: 999, b: 999, c: 999 }) });
    const got = await latestMeasuredBalances(ctx, new Map([['a', ['a']], ['b', ['b']], ['c', ['c']], ['never', ['never']]]));
    expect(Object.fromEntries(got)).toEqual({
      a: { date: daysAgo(2), value: 2.5, layer: 'partial' },
      b: { date: daysAgo(1), value: 30, layer: 'partial' },
      c: { date: daysAgo(3), value: 100, layer: 'recorded' },
    });
  });

  test('an account’s current id first, then its earlier ids, on each date', async () => {
    await fake.hset(ctxKey('history:accounts'), {
      [daysAgo(5)]: await map({ old_a: 7 }),
      [daysAgo(4)]: await map({ old_a: 8, new_a: 9 }),
    });
    expect((await latestMeasuredBalances(ctx, new Map([['new_a', ['new_a', 'old_a']]]))).get('new_a')).toEqual({ date: daysAgo(4), value: 9, layer: 'recorded' });
    // Before the new id was ever recorded, the earlier one answers.
    expect((await latestMeasuredBalances(ctx, new Map([['newer', ['newer', 'old_a']]]))).get('newer')).toEqual({ date: daysAgo(4), value: 8, layer: 'recorded' });
  });

  test('a map that can’t be decrypted is passed over, and a future date is never taken', async () => {
    await fake.hset(ctxKey('history:accounts'), {
      [daysAgo(4)]: await map({ a: 4 }),
      [daysAgo(3)]: DAMAGED,
      [daysAgo(-2)]: await map({ a: 99 }), // clock skew minted a date ahead
    });
    expect((await latestMeasuredBalances(ctx, new Map([['a', ['a']]]))).get('a')).toEqual({ date: daysAgo(4), value: 4, layer: 'recorded' });
  });

  test('reads only the maps it needs, newest first', async () => {
    const fields: Record<string, string> = {};
    for (let d = 1; d <= 40; d++) fields[daysAgo(d)] = await map({ a: d, b: d });
    await fake.hset(ctxKey('history:accounts'), fields);
    let reads = 0;
    const hget = fake.hget.bind(fake);
    (fake as any).hget = async (...args: any[]) => {
      reads++;
      return hget(...(args as [string, string]));
    };
    try {
      expect((await latestMeasuredBalances(ctx, new Map([['a', ['a']], ['b', ['b']]]))).get('a')).toEqual({ date: daysAgo(1), value: 1, layer: 'recorded' });
      expect(reads).toBe(1);
    } finally {
      (fake as any).hget = hget;
    }
  });

  test('storage failing throws, never "no balance"', async () => {
    await fake.hset(ctxKey('history:accounts'), { [daysAgo(1)]: await map({ a: 1 }) });
    fake.failNext('hget');
    await expect(latestMeasuredBalances(ctx, new Map([['a', ['a']]]))).rejects.toThrow('armed failure');
    fake.failNext('hkeys');
    await expect(latestMeasuredBalances(ctx, new Map([['a', ['a']]]))).rejects.toThrow('armed failure');
  });
});

const ITEM = { item_id: 'item_a', institution_name: 'Test Bank', encrypted_access_token: '' };
const stored = (txns: Record<string, unknown>, over: Record<string, unknown> = {}) =>
  encodeJsonBlob({ schema_version: 2, cursor: 'c1', accounts: { acct_1: { name: 'Checking' }, acct_2: { name: 'Savings' } }, txns, ...over });
const row = (id: string, account_id: string, daysBack: number, amount: number) => ({
  transaction_id: id,
  pending_transaction_id: null,
  account_id,
  amount,
  iso_currency_code: 'USD',
  unofficial_currency_code: null,
  date: daysAgo(daysBack),
  authorized_date: null,
  authorized_datetime: null,
  datetime: null,
  name: id,
  merchant_name: null,
  merchant_entity_id: null,
  website: null,
  logo_url: null,
  personal_finance_category: null,
  personal_finance_category_icon_url: null,
  pending: false,
  payment_channel: null,
  transaction_code: null,
  transaction_type: null,
  check_number: null,
  account_owner: null,
  location: null,
  payment_meta: null,
  counterparties: [],
  category: null,
  account_name: '',
  institution_name: 'Test Bank',
});

describe('an Item’s rows as stored', () => {
  test('the same rows a sync shows, without one, with when they were synced', async () => {
    await fake.set(ctxKey('txns:item_a'), await stored({ t1: row('t1', 'acct_1', 1, 5), t2: row('t2', 'acct_2', 2, 6) }, { synced_at: '2026-10-08T10:00:00.000Z' }));
    const read = await storedItemTransactions(ctx, ITEM, { hiddenAccountIds: new Set(['acct_2']), withAccountIds: true });
    expect(read).toMatchObject({ note: null, coverage: 'complete', synced_at: '2026-10-08T10:00:00.000Z' });
    expect(read.txns.map((t) => [t.transaction_id, t.account_id, t.account_name])).toEqual([['t1', 'acct_1', 'Checking']]);
    // Without account ids, as the Activity tab has its rows.
    expect((await storedItemTransactions(ctx, ITEM)).txns.every((t) => t.account_id === undefined)).toBe(true);
  });

  test('a store that can’t be read, or was never synced, is a note and no rows, never an empty institution', async () => {
    const quiet = console.error;
    console.error = () => {};
    try {
      await fake.set(ctxKey('txns:item_a'), DAMAGED);
      expect(await storedItemTransactions(ctx, ITEM)).toEqual({ txns: [], note: 'Test Bank: stored transactions could not be read', coverage: 'missing', synced_at: null });
    } finally {
      console.error = quiet;
    }
    await fake.del(ctxKey('txns:item_a'));
    expect(await storedItemTransactions(ctx, ITEM)).toEqual({ txns: [], note: 'Test Bank: no transactions stored yet; open the app to load them', coverage: 'missing', synced_at: null });
    // Saved before sync times were kept: rows, as of a time not known.
    await fake.set(ctxKey('txns:item_a'), await stored({ t1: row('t1', 'acct_1', 1, 5) }));
    expect(await storedItemTransactions(ctx, ITEM)).toMatchObject({ coverage: 'complete', synced_at: null });
  });

  test('a sync that saves stamps when, and the stamp survives the next', async () => {
    syncPages = [{ added: [], modified: [], removed: [], accounts: [], next_cursor: 'c2', has_more: false, transactions_update_status: 'HISTORICAL_UPDATE_COMPLETE' }];
    await fake.set(ctxKey('txns:item_a'), await stored({ t1: row('t1', 'acct_1', 1, 5) }));
    const item = { ...ITEM, encrypted_access_token: await encrypt('access-sandbox-x') };
    const before = Date.now();
    await syncItemTransactions(ctx, item);
    const state = await decodeJsonBlob<any>((await fake.get<string>(ctxKey('txns:item_a')))!);
    expect(Date.parse(state.synced_at)).toBeGreaterThanOrEqual(before);
    expect((await storedItemTransactions(ctx, item)).synced_at).toBe(state.synced_at);
  });
});

describe('remembered accounts, for a display that names what it can’t show', () => {
  test('an Item whose record can’t be read is named, the rest read', async () => {
    await fake.hset(ctxKey('accounts:meta'), {
      item_a: await encrypt(JSON.stringify([{ account_id: 'a1', name: 'Checking', type: 'depository' }])),
      item_b: DAMAGED,
    });
    const report = await rememberedAccountsReport(ctx);
    expect(Object.keys(report.byItem)).toEqual(['item_a']);
    expect(report.unreadable).toEqual(['item_b']);
  });

  test('changes nothing (a field in the old shape stays), and storage failing throws', async () => {
    await fake.hset(ctxKey('accounts:meta'), { a1: await encrypt(JSON.stringify({ account_id: 'a1', name: 'old shape', type: 'depository' })) });
    expect(await rememberedAccountsReport(ctx)).toEqual({ byItem: {}, unreadable: [] });
    expect(fake.hashes.get(ctxKey('accounts:meta'))?.has('a1')).toBe(true);
    fake.failNext('hgetall');
    await expect(rememberedAccountsReport(ctx)).rejects.toThrow('armed failure');
  });
});

describe('series and pages', () => {
  const points = ['2026-09-28', '2026-09-29', '2026-09-30', '2026-10-01', '2026-10-05', '2026-10-06'].map((date, i) => ({ date, value: i }));

  test('the last point of each week or month, or every point', () => {
    expect(sampleSeries(points, 'day')).toEqual(points);
    expect(sampleSeries(points, 'month').map((p) => p.date)).toEqual(['2026-09-30', '2026-10-06']);
    // 2026-09-28 is a Monday: that week runs to 10-04; 10-05 starts the next.
    expect(sampleSeries(points, 'week').map((p) => p.date)).toEqual(['2026-10-01', '2026-10-06']);
    expect(sampleSeries([], 'month')).toEqual([]);
  });

  test('pages are ordered newest day first, then latest moment, then id: a total order', () => {
    const keys = [
      { date: '2026-10-01', datetime: '', id: 'b' },
      { date: '2026-10-02', datetime: '', id: 'a' },
      { date: '2026-10-01', datetime: '2026-10-01T09:00:00Z', id: 'z' },
      { date: '2026-10-01', datetime: '', id: 'a' },
    ];
    expect([...keys].sort(comparePageKeys).map((k) => `${k.date}/${k.datetime}/${k.id}`)).toEqual([
      '2026-10-02//a',
      '2026-10-01/2026-10-01T09:00:00Z/z',
      '2026-10-01//a',
      '2026-10-01//b',
    ]);
    expect(comparePageKeys(keys[0], keys[0])).toBe(0);
  });
});
