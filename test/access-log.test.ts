import { describe, expect, test, mock, beforeEach, afterEach } from 'bun:test';
import { FakeRedis, storageMock, TEST_CTX, ctxKey, unscopedDataKeys } from './fake-redis';

// The records of showings (lib/access-log.ts): their arithmetic (one row per
// quarter hour, the widest level shown, what is kept, the days they make in a
// reader's own time zone), their shape, their size at the bound, writes racing
// each other, and the clearing and nightly pruning on the storage seam. The writes a viewer's read makes, both sides'
// views of them, and their life with the connection are in
// test/sharing.test.ts.

process.env.PLAID_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');

const fake = new FakeRedis({ deserialize: true });
afterEach(() => expect(unscopedDataKeys(fake)).toEqual([]));
mock.module('@/lib/storage', () => storageMock(fake));

const { accessLogStore, slotOf, keptShowings, withShowing, isAccessLog, clearUnreadableAccessLog, pruneAccessLog, shownByDay, timeZoneOf } = await import('@/lib/access-log');
const { ACCESS_LOG_DAYS, ACCESS_LOG_SLOT_MINUTES } = await import('@/lib/share-rules');
const { declaredStore } = await import('@/lib/stores');
const { encrypt } = await import('@/lib/crypto');

type Showing = { at: string; times: number; read: Record<string, 'exists' | 'balance' | 'transactions'> };

const SLOT = ACCESS_LOG_SLOT_MINUTES * 60_000;
const DAY = 86_400_000;
const T = Date.parse('2026-10-08T15:42:10.123Z');
const ctx = TEST_CTX;
const log = (...shown: Showing[]) => ({ shown });
const at = (t: number, times = 1): Showing => ({ at: slotOf(t), times, read: { a: 'balance' } });
const DAMAGED = 'not-ciphertext-but-long-enough-to-be-tried';
const everyone = (ids: string[]) => async () => new Set(ids);

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

describe('counting showings', () => {
  test('by the quarter hour, in UTC', () => {
    expect(ACCESS_LOG_SLOT_MINUTES).toBe(15);
    expect(slotOf(T)).toBe('2026-10-08T15:30:00.000Z');
    expect(slotOf(Date.parse('2026-10-08T15:45:00.000Z'))).toBe('2026-10-08T15:45:00.000Z');
    expect(slotOf(Date.parse('2026-10-08T15:44:59.999Z'))).toBe('2026-10-08T15:30:00.000Z');
  });

  test('ten in a quarter hour are one row with a count, and the next quarter hour starts another', () => {
    let current = null as ReturnType<typeof withShowing> | null;
    const start = Date.parse('2026-10-08T15:30:00.000Z');
    for (let i = 0; i < 10; i++) current = withShowing(current, start + i * 60_000, { a: 'balance' });
    expect(current).toEqual(log({ at: '2026-10-08T15:30:00.000Z', times: 10, read: { a: 'balance' } }));
    current = withShowing(current, start + SLOT, { a: 'balance' });
    expect(current!.shown.map((s) => [s.at, s.times])).toEqual([
      ['2026-10-08T15:30:00.000Z', 10],
      ['2026-10-08T15:45:00.000Z', 1],
    ]);
  });

  test('a quarter hour keeps each account at the widest level shown in it, whatever the order', () => {
    let current = withShowing(null, T, { a: 'balance', b: 'transactions' });
    current = withShowing(current, T + 1, { a: 'transactions', b: 'exists', c: 'exists' });
    expect(current.shown[0].read).toEqual({ a: 'transactions', b: 'transactions', c: 'exists' });
    // The next one starts from what it shows, not from the one before.
    expect(withShowing(current, T + SLOT, { a: 'exists' }).shown[1].read).toEqual({ a: 'exists' });
  });

  test('computes only: the record it was given is left as it was', () => {
    const current = log({ at: slotOf(T), times: 1, read: { a: 'exists' } });
    const before = structuredClone(current);
    withShowing(current, T, { a: 'transactions' });
    expect(current).toEqual(before);
  });

  test('one in a quarter hour before the newest (two clocks disagreeing) goes in its place', () => {
    const current = withShowing(withShowing(null, T + SLOT, { a: 'balance' }), T, { a: 'balance' });
    expect(current.shown.map((s) => s.at)).toEqual([slotOf(T), slotOf(T + SLOT)]);
  });
});

describe('the days a record makes, in its reader’s own time zone', () => {
  const levels = (exists = 0, balance = 0, transactions = 0) => ({ exists, balance, transactions });
  const shown: Showing[] = [
    { at: '2026-10-04T06:00:00.000Z', times: 2, read: { a: 'balance' } },
    { at: '2026-10-04T15:00:00.000Z', times: 1, read: { a: 'transactions', b: 'balance' } },
    { at: '2026-10-04T20:00:00.000Z', times: 2, read: { a: 'balance', c: 'exists' } },
  ];

  test('newest first, each account counted once, at the widest level shown that day', () => {
    // 11 PM on Oct 3, then 8 AM and 1 PM on Oct 4.
    expect(shownByDay(shown, 'America/Los_Angeles')).toEqual([
      { day: '2026-10-04', times: 3, levels: levels(1, 1, 1) },
      { day: '2026-10-03', times: 2, levels: levels(0, 1, 0) },
    ]);
    // 3 PM on Oct 4, then midnight and 5 AM on Oct 5.
    expect(shownByDay(shown, 'Asia/Tokyo').map((d) => [d.day, d.times])).toEqual([
      ['2026-10-05', 3],
      ['2026-10-04', 2],
    ]);
    expect(shownByDay([], 'UTC')).toEqual([]);
  });

  test('half and three quarter hour time zones get each quarter hour in the right day', () => {
    // 00:10 on Oct 5 in Kolkata (UTC+5:30) is 18:40 UTC on Oct 4, counted in
    // the quarter hour from 18:30: midnight there, Oct 5. By the hour, it
    // would have been 11:30 PM on Oct 4.
    const day = (zone: string, iso: string) => shownByDay([{ at: slotOf(Date.parse(iso)), times: 1, read: { a: 'balance' } }], zone)[0].day;
    expect(day('Asia/Kolkata', '2026-10-04T18:40:00.000Z')).toBe('2026-10-05');
    expect(day('Asia/Kolkata', '2026-10-04T18:20:00.000Z')).toBe('2026-10-04'); // 11:50 PM
    expect(day('Asia/Kathmandu', '2026-10-04T18:20:00.000Z')).toBe('2026-10-05'); // UTC+5:45: 00:05
    expect(day('America/St_Johns', '2026-10-05T02:40:00.000Z')).toBe('2026-10-05'); // UTC-2:30 in summer: 00:10
    expect(day('Pacific/Chatham', '2026-10-04T10:50:00.000Z')).toBe('2026-10-05'); // UTC+13:45: 00:35
  });

  test('only a time zone the server knows, as a device would send it', () => {
    for (const zone of ['UTC', 'Asia/Kolkata', 'America/Argentina/Buenos_Aires', 'Etc/GMT+5']) expect(timeZoneOf(zone)).toBe(zone);
    for (const bad of [undefined, null, 42, '', 'Mars/Olympus', 'America/New_York ', 'Asia/Kolkata; drop', '../../etc/passwd', 'x'.repeat(65)]) {
      expect(timeZoneOf(bad)).toBeNull();
    }
  });
});

describe('what is kept', () => {
  test(`${ACCESS_LOG_DAYS} days: a quarter hour is kept while any of it is inside`, () => {
    const S = Date.parse('2026-07-01T10:15:00.000Z');
    const one = log({ at: '2026-07-01T10:15:00.000Z', times: 1, read: { a: 'balance' } });
    // The window starts ACCESS_LOG_DAYS before now; the quarter hour ends at S + 15 minutes.
    expect(keptShowings(one, S + SLOT + ACCESS_LOG_DAYS * DAY - 1)).toHaveLength(1);
    expect(keptShowings(one, S + SLOT + ACCESS_LOG_DAYS * DAY)).toEqual([]);
    expect(keptShowings(log(at(T - ACCESS_LOG_DAYS * DAY), at(T - DAY)), T)).toHaveLength(2);
  });

  test('every showing drops what is no longer kept', () => {
    const old = at(T - (ACCESS_LOG_DAYS + 1) * DAY, 4);
    const recent = at(T - DAY, 2);
    expect(withShowing(log(old, recent), T, { a: 'balance' }).shown.map((s) => [s.at, s.times])).toEqual([
      [recent.at, 2],
      [slotOf(T), 1],
    ]);
  });

  test('at its bound, every quarter hour of the window, a record stays well under the ceiling, and one more showing is quick', async () => {
    const plaidId = (i: number) => `${'Bx'.repeat(17)}${String(i).padStart(3, '0')}`; // 37 characters, like Plaid's
    const levels = ['exists', 'balance', 'transactions'] as const;
    const read = Object.fromEntries(Array.from({ length: 10 }, (_, i) => [plaidId(i), levels[i % 3]]));
    const now = Date.parse('2026-10-09T12:00:00.000Z');
    // Every quarter hour of the window, each shown at once.
    const full = { shown: [] as Showing[] };
    for (let t = now - ACCESS_LOG_DAYS * DAY; t <= now; t += SLOT) full.shown.push({ at: slotOf(t), times: 1, read });
    expect(full.shown).toHaveLength((ACCESS_LOG_DAYS * DAY) / SLOT + 1);
    // One more keeps it at the bound: the oldest quarter hour goes.
    expect(withShowing(full, now + SLOT, read).shown).toHaveLength((ACCESS_LOG_DAYS * DAY) / SLOT + 1);
    await accessLogStore.set(ctx, 'c1', full);
    const stored = (fake as any).hashes.get(ctxKey('sharing-access-log')).get('c1') as string;
    expect(stored.length).toBeLessThan(500_000); // compressed: the ceiling is 8 MB
    const started = performance.now();
    await accessLogStore.update(ctx, 'c1', (cur) => withShowing(cur, now + 1, read));
    expect(performance.now() - started).toBeLessThan(2000);
    // Never more quarter hours than the window holds.
    expect((await accessLogStore.get(ctx, 'c1'))!.shown.length).toBeLessThanOrEqual((ACCESS_LOG_DAYS * DAY) / SLOT + 1);
  });
});

describe('the stored shape', () => {
  test('is checked on every read and write', () => {
    expect(isAccessLog(log({ at: '2026-10-08T15:45:00.000Z', times: 3, read: { acct_1: 'balance', manual_x: 'exists' } }))).toBe(true);
    expect(isAccessLog(log())).toBe(true);
    for (const bad of [
      null,
      [],
      {},
      { shown: {} },
      { hours: [] },
      log({ at: '2026-10-08T15:40:00.000Z', times: 1, read: {} }), // not on a quarter hour
      log({ at: '2026-10-08T15:45:00Z', times: 1, read: {} }), // not as written
      log({ at: '2026-10-08', times: 1, read: {} }),
      log({ at: '2026-10-08T15:45:00.000Z', times: 0, read: {} }), // nothing shown
      log({ at: '2026-10-08T15:45:00.000Z', times: 1.5, read: {} }),
      log({ at: '2026-10-08T15:45:00.000Z', times: 1, read: { a: 'everything' as any } }),
      log({ at: '2026-10-08T15:45:00.000Z', times: 1, read: [] as any }),
    ]) {
      expect([bad, isAccessLog(bad)]).toEqual([bad, false]);
    }
  });

  test('a store on the seam, in the catalogue, encrypted and compressed', async () => {
    const declared = declaredStore('sharing-access-log');
    expect(declared).toBe(accessLogStore as any);
    expect(declared).toMatchObject({ kind: 'map', exportable: true });
    await accessLogStore.set(ctx, 'c1', log({ at: '2026-10-08T15:45:00.000Z', times: 1, read: { acct_1: 'balance' } }));
    const stored = (fake as any).hashes.get(ctxKey('sharing-access-log')).get('c1') as string;
    expect(stored).not.toContain('acct_1');
    expect(stored).not.toContain('2026-10-08');
  });
});

describe('showings at the same moment', () => {
  // From a reviewer's probe: several devices, or a refresh on each, at once.
  for (const n of [2, 5, 10]) {
    test(`${n} at once are all counted`, async () => {
      const results = await Promise.allSettled(
        Array.from({ length: n }, () => accessLogStore.update(ctx, 'c1', (cur) => withShowing(cur, T, { a: 'balance' })))
      );
      expect(results.filter((r) => r.status === 'rejected')).toEqual([]);
      expect((await accessLogStore.get(ctx, 'c1'))!.shown[0].times).toBe(n);
    });
  }

  test('the nightly pass racing a showing keeps the showing', async () => {
    await accessLogStore.set(ctx, 'c1', log(at(T - (ACCESS_LOG_DAYS + 2) * DAY, 3)));
    await Promise.all([pruneAccessLog(ctx, T, everyone(['c1'])), accessLogStore.update(ctx, 'c1', (cur) => withShowing(cur, T, { a: 'balance' }))]);
    expect((await accessLogStore.get(ctx, 'c1'))!.shown.map((s) => s.times)).toEqual([1]);
  });
});

describe('clearing a damaged record', () => {
  test('removes only an unreadable one', async () => {
    const readable = log(at(T));
    await accessLogStore.set(ctx, 'ok', readable);
    const unrecognised = await encrypt('{"not":"a record"}');
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
  test('drops what is no longer kept, and the records with nothing left', async () => {
    const old = at(T - (ACCESS_LOG_DAYS + 1) * DAY);
    const recent = at(T - DAY, 2);
    await accessLogStore.setMany(ctx, [
      ['mixed', log(old, recent)],
      ['stale', log(old)],
      ['fresh', log(recent)],
    ]);
    await fake.hset(ctxKey('sharing-access-log'), { bad: DAMAGED });
    await pruneAccessLog(ctx, T, everyone(['mixed', 'stale', 'fresh', 'bad']));
    const { entries, unreadable } = await accessLogStore.getAllReport(ctx);
    expect([...entries]).toEqual([
      ['fresh', log(recent)],
      ['mixed', log(recent)],
    ]);
    expect(unreadable).toEqual(['bad']); // its connection is there: only the person may clear it
  });

  test('deletes every record whose connection has ended, readable or not, by id', async () => {
    await accessLogStore.setMany(ctx, [
      ['live', log(at(T))],
      ['gone', log(at(T))],
    ]);
    await fake.hset(ctxKey('sharing-access-log'), { gone_bad: DAMAGED, gone_odd: await encrypt('{"not":"a record"}') });
    await pruneAccessLog(ctx, T, everyone(['live']));
    expect([...((fake as any).hashes.get(ctxKey('sharing-access-log')) as Map<string, string>).keys()]).toEqual(['live']);
  });

  test('deletes nothing for its connection when the connections can’t all be read', async () => {
    await accessLogStore.set(ctx, 'gone', log(at(T)));
    await pruneAccessLog(ctx, T, async () => null);
    expect(await accessLogStore.get(ctx, 'gone')).toEqual(log(at(T)));
  });

  test('reads the connections after the records, so a record written in between is never judged by older ones', async () => {
    const order: string[] = [];
    const real = fake.hgetall.bind(fake);
    (fake as any).hgetall = async (...args: any[]) => (order.push('records'), real(...(args as [string])));
    try {
      await pruneAccessLog(ctx, T, async () => (order.push('connections'), new Set<string>()));
    } finally {
      (fake as any).hgetall = real;
    }
    expect(order).toEqual(['records', 'connections']);
  });

  test('never throws, and one record failing leaves the rest pruned', async () => {
    const old = at(T - (ACCESS_LOG_DAYS + 1) * DAY);
    await accessLogStore.setMany(ctx, [
      ['a', log(old)],
      ['b', log(old)],
    ]);
    fake.failNext('eval'); // the first record's read
    const { logged } = await quietly(() => pruneAccessLog(ctx, T, everyone(['a', 'b'])));
    expect(logged).toHaveLength(1);
    expect([...(await accessLogStore.getAll(ctx)).keys()]).toEqual(['a']);
    fake.failNext('hgetall');
    expect((await quietly(() => pruneAccessLog(ctx, T, everyone(['a'])))).logged).toHaveLength(1);
  });
});
