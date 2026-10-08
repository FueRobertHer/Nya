import { describe, expect, test, mock, beforeEach, afterEach } from 'bun:test';
import { FakeRedis, storageMock, TEST_CTX, ctxKey, unscopedDataKeys } from './fake-redis';

// The access log of sharing (lib/access-log.ts): its arithmetic (one row per
// hour, the widest level shown, what is kept), its shape, and its reads,
// clearing and pruning on the storage seam. The writes a viewer's read makes,
// and what the owner sees of them, are in test/sharing.test.ts.

process.env.PLAID_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');

const fake = new FakeRedis({ deserialize: true });
afterEach(() => expect(unscopedDataKeys(fake)).toEqual([]));
mock.module('@/lib/storage', () => storageMock(fake));

const { accessLogStore, hourOf, keptHours, withView, isAccessLog, whenTheyLooked, clearUnreadableAccessLog, pruneAccessLog } = await import(
  '@/lib/access-log'
);
const { ACCESS_LOG_DAYS } = await import('@/lib/share-rules');
const { declaredStore } = await import('@/lib/stores');
const { encrypt } = await import('@/lib/crypto');

const HOUR = 3_600_000;
const DAY = 86_400_000;
const T = Date.parse('2026-10-08T15:42:10.123Z');
const ctx = TEST_CTX;
const log = (...hours: { hour: string; views: number; read: Record<string, any> }[]) => ({ hours });
const DAMAGED = 'not-ciphertext-but-long-enough-to-be-tried';

/** console.error, quietly, with what it was called with. */
async function quietly<R>(fn: () => Promise<R>): Promise<{ result: R; logged: unknown[][] }> {
  const logged: unknown[][] = [];
  const errors = console.error;
  console.error = (...args: unknown[]) => void logged.push(args);
  try {
    return { result: await fn(), logged };
  } finally {
    console.error = errors;
  }
}

beforeEach(() => fake.reset());

describe('counting looks', () => {
  test('by the UTC hour', () => {
    expect(hourOf(T)).toBe('2026-10-08T15:00:00.000Z');
    expect(hourOf(Date.parse('2026-10-08T15:00:00.000Z'))).toBe('2026-10-08T15:00:00.000Z');
    expect(hourOf(Date.parse('2026-10-08T15:59:59.999Z'))).toBe('2026-10-08T15:00:00.000Z');
  });

  test('ten looks in one hour are one row with a count, and the next hour starts another', () => {
    let current = null as ReturnType<typeof withView> | null;
    for (let i = 0; i < 10; i++) current = withView(current, T + i * 60_000, { a: 'balance' });
    expect(current).toEqual(log({ hour: '2026-10-08T15:00:00.000Z', views: 10, read: { a: 'balance' } }));
    current = withView(current, T + HOUR, { a: 'balance' });
    expect(current!.hours.map((h) => [h.hour, h.views])).toEqual([
      ['2026-10-08T15:00:00.000Z', 10],
      ['2026-10-08T16:00:00.000Z', 1],
    ]);
  });

  test('an hour keeps each account at the widest level shown in it, whatever the order', () => {
    let current = withView(null, T, { a: 'balance', b: 'transactions' });
    current = withView(current, T + 1, { a: 'transactions', b: 'exists', c: 'exists' });
    expect(current.hours[0].read).toEqual({ a: 'transactions', b: 'transactions', c: 'exists' });
    // The next hour starts from what it shows, not from the hour before.
    expect(withView(current, T + HOUR, { a: 'exists' }).hours[1].read).toEqual({ a: 'exists' });
  });

  test('computes only: the record it was given is left as it was', () => {
    const current = log({ hour: '2026-10-08T15:00:00.000Z', views: 1, read: { a: 'exists' } });
    const before = structuredClone(current);
    withView(current, T, { a: 'transactions' });
    expect(current).toEqual(before);
  });

  test('a look in an hour before the newest one (two clocks disagreeing) goes in its place', () => {
    const current = withView(withView(null, T + HOUR, { a: 'balance' }), T, { a: 'balance' });
    expect(current.hours.map((h) => h.hour)).toEqual(['2026-10-08T15:00:00.000Z', '2026-10-08T16:00:00.000Z']);
  });
});

describe('what is kept', () => {
  const at = (t: number) => ({ hour: hourOf(t), views: 1, read: { a: 'balance' as const } });

  test(`${ACCESS_LOG_DAYS} days: an hour is kept while any of it is inside`, () => {
    const H = Date.parse('2026-07-01T10:00:00.000Z');
    const one = log({ hour: '2026-07-01T10:00:00.000Z', views: 1, read: { a: 'balance' } });
    // The window starts ACCESS_LOG_DAYS before now; the hour ends at H + 1h.
    expect(keptHours(one, H + HOUR + ACCESS_LOG_DAYS * DAY - 1)).toHaveLength(1);
    expect(keptHours(one, H + HOUR + ACCESS_LOG_DAYS * DAY)).toEqual([]);
    // Newer hours stay.
    expect(keptHours(log(at(T - ACCESS_LOG_DAYS * DAY), at(T - DAY)), T)).toHaveLength(2);
  });

  test('and nothing from before the connection began, to the hour', () => {
    const since = Date.parse('2026-10-08T12:20:00.000Z');
    const earlier = log(at(Date.parse('2026-10-07T09:00:00.000Z')), at(Date.parse('2026-10-08T11:30:00.000Z')), at(Date.parse('2026-10-08T12:05:00.000Z')));
    // The hour it began in is kept: part of it is this connection's.
    expect(keptHours(earlier, T, since).map((h) => h.hour)).toEqual(['2026-10-08T12:00:00.000Z']);
    // A start that can't be read is no limit, never "everything is earlier".
    expect(keptHours(earlier, T, NaN)).toHaveLength(3);
  });

  test('every look drops what is no longer kept', () => {
    const old = { hour: hourOf(T - (ACCESS_LOG_DAYS + 1) * DAY), views: 4, read: { a: 'balance' as const } };
    const recent = { hour: hourOf(T - DAY), views: 2, read: { a: 'balance' as const } };
    const before = { hour: hourOf(T - 3 * DAY), views: 1, read: { a: 'exists' as const } };
    expect(withView(log(old, before, recent), T, { a: 'balance' }, T - 2 * DAY).hours.map((h) => [h.hour, h.views])).toEqual([
      [recent.hour, 2],
      [hourOf(T), 1],
    ]);
  });
});

describe('the stored shape', () => {
  test('is checked on every read and write', () => {
    const good = log({ hour: '2026-10-08T15:00:00.000Z', views: 3, read: { acct_1: 'balance', manual_x: 'exists' } });
    expect(isAccessLog(good)).toBe(true);
    expect(isAccessLog(log())).toBe(true);
    for (const bad of [
      null,
      [],
      {},
      { hours: {} },
      log({ hour: '2026-10-08T15:30:00.000Z', views: 1, read: {} }), // not on the hour
      log({ hour: '2026-10-08', views: 1, read: {} }),
      log({ hour: '2026-10-08T15:00:00.000Z', views: 0, read: {} }), // no look
      log({ hour: '2026-10-08T15:00:00.000Z', views: 1.5, read: {} }),
      log({ hour: '2026-10-08T15:00:00.000Z', views: 1, read: { a: 'everything' } }),
      log({ hour: '2026-10-08T15:00:00.000Z', views: 1, read: [] as any }),
    ]) {
      expect([bad, isAccessLog(bad)]).toEqual([bad, false]);
    }
  });

  test('a store on the seam, in the catalogue and the data download, encrypted and compressed', async () => {
    const declared = declaredStore('sharing-access-log');
    expect(declared).toBe(accessLogStore as any);
    expect(declared).toMatchObject({ kind: 'map', exportable: true });
    await accessLogStore.set(ctx, 'c1', log({ hour: '2026-10-08T15:00:00.000Z', views: 1, read: { acct_1: 'balance' } }));
    const stored = (fake as any).hashes.get(ctxKey('sharing-access-log')).get('c1') as string;
    expect(stored).not.toContain('acct_1');
    expect(stored).not.toContain('2026-10-08');
  });
});

describe('what the owner sees', () => {
  const conns = [
    { id: 'c1', since: '2026-01-01T00:00:00.000Z' },
    { id: 'c2', since: '2026-10-08T12:20:00.000Z' },
    { id: 'c3', since: '2026-01-01T00:00:00.000Z' },
  ];

  test('each connection’s kept hours, and none for one that never looked', async () => {
    await accessLogStore.set(ctx, 'c1', log({ hour: hourOf(T - (ACCESS_LOG_DAYS + 2) * DAY), views: 1, read: { a: 'balance' } }, { hour: hourOf(T - DAY), views: 2, read: { a: 'balance' } }));
    await accessLogStore.set(ctx, 'c2', log({ hour: '2026-10-07T10:00:00.000Z', views: 5, read: { a: 'transactions' } }));
    const looked = await whenTheyLooked(ctx, conns, T);
    expect(looked.get('c1')).toEqual({ views: [{ hour: hourOf(T - DAY), views: 2, read: { a: 'balance' } }] });
    // Only from when the connection began: an earlier one between them had the same id.
    expect(looked.get('c2')).toEqual({ views: [] });
    expect(looked.get('c3')).toEqual({ views: [] });
  });

  test('a record that can’t be used says so, and never reads as no looks', async () => {
    await fake.hset(ctxKey('sharing-access-log'), { c1: DAMAGED, c2: await encrypt('{"not":"a log"}') });
    const looked = await whenTheyLooked(ctx, conns, T);
    expect(looked.get('c1')).toEqual({ views: null, views_problem: 'unreadable' });
    expect(looked.get('c2')).toEqual({ views: null, views_problem: 'unrecognised' });
    expect(looked.get('c3')).toEqual({ views: [] });
  });

  test('a record that can’t be reached at all is unavailable, for every connection, without failing', async () => {
    fake.failNext('hgetall');
    const { result, logged } = await quietly(() => whenTheyLooked(ctx, conns, T));
    expect([...result.values()]).toEqual(conns.map(() => ({ views: null, views_problem: 'unavailable' })));
    expect(logged).toHaveLength(1);
  });
});

describe('clearing a damaged record', () => {
  test('removes only an unreadable one', async () => {
    const readable = log({ hour: '2026-10-08T15:00:00.000Z', views: 1, read: { a: 'balance' } });
    await accessLogStore.set(ctx, 'ok', readable);
    const unrecognised = await encrypt('{"not":"a log"}');
    await fake.hset(ctxKey('sharing-access-log'), { bad: DAMAGED, odd: unrecognised });
    expect(await clearUnreadableAccessLog(ctx, 'ok')).toBe(false);
    expect(await clearUnreadableAccessLog(ctx, 'odd')).toBe(false);
    expect(await clearUnreadableAccessLog(ctx, 'none')).toBe(false);
    expect(await clearUnreadableAccessLog(ctx, 'bad')).toBe(true);
    const left = (fake as any).hashes.get(ctxKey('sharing-access-log')) as Map<string, string>;
    expect([...left.keys()].sort()).toEqual(['odd', 'ok']);
    expect(left.get('odd')).toBe(unrecognised); // intact data, never removed
    expect(await accessLogStore.get(ctx, 'ok')).toEqual(readable);
  });

  test('a deployment problem is thrown, never taken for damage', async () => {
    await fake.hset(ctxKey('sharing-access-log'), { bad: DAMAGED });
    fake.failNext('eval');
    await expect(clearUnreadableAccessLog(ctx, 'bad')).rejects.toThrow('armed failure');
    expect((fake as any).hashes.get(ctxKey('sharing-access-log')).has('bad')).toBe(true);
  });
});

describe('the nightly pass', () => {
  test('drops the hours no longer kept, and the entries with none left', async () => {
    const old = { hour: hourOf(T - (ACCESS_LOG_DAYS + 1) * DAY), views: 1, read: { a: 'balance' as const } };
    const recent = { hour: hourOf(T - DAY), views: 2, read: { a: 'balance' as const } };
    await accessLogStore.setMany(ctx, [
      ['mixed', log(old, recent)],
      ['stale', log(old)],
      ['fresh', log(recent)],
    ]);
    await fake.hset(ctxKey('sharing-access-log'), { bad: DAMAGED });
    await pruneAccessLog(ctx, T);
    const { entries, unreadable } = await accessLogStore.getAllReport(ctx);
    expect([...entries]).toEqual([
      ['fresh', log(recent)],
      ['mixed', log(recent)],
    ]);
    expect(unreadable).toEqual(['bad']); // only the person may clear it
  });

  test('never throws, and one entry failing leaves the rest pruned', async () => {
    const old = { hour: hourOf(T - (ACCESS_LOG_DAYS + 1) * DAY), views: 1, read: { a: 'balance' as const } };
    await accessLogStore.setMany(ctx, [
      ['a', log(old)],
      ['b', log(old)],
    ]);
    fake.failNext('eval'); // the first entry's read
    const { logged } = await quietly(() => pruneAccessLog(ctx, T));
    expect(logged).toHaveLength(1);
    expect([...(await accessLogStore.getAll(ctx)).keys()]).toEqual(['a']);
    fake.failNext('hgetall');
    const second = await quietly(() => pruneAccessLog(ctx, T));
    expect(second.logged).toHaveLength(1);
  });
});
