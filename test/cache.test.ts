import { describe, expect, test, mock, beforeEach, afterEach } from 'bun:test';
import { FakeRedis, storageMock, testKey } from './fake-redis';

process.env.PLAID_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');

const fake = new FakeRedis({ deserialize: true });
mock.module('@/lib/storage', () => storageMock(fake));

const {
  readCache,
  writeCache,
  readAccountCache,
  writeAccountCache,
  clearCaches,
  clearNetWorthCache,
  clearTransactionsCache,
  CacheKey,
} = await import('@/lib/cache');
const { createFirstContainer, asContainerId } = await import('@/lib/containers');

const saved = { ...process.env };
let ctx: { container: ReturnType<typeof asContainerId> };

beforeEach(async () => {
  fake.reset();
  delete process.env.MASTER_KEY; // plain k0 writes: the cache is not about keys
  const id = await createFirstContainer();
  process.env.CONTAINER_ID = id;
  ctx = { container: id };
});
afterEach(() => {
  process.env = { ...saved };
});

const quiet = async <T>(fn: () => Promise<T>) => {
  const logged: string[] = [];
  const orig = console.error;
  console.error = (...a: unknown[]) => logged.push(a.join(' '));
  try {
    return { result: await fn(), logged };
  } finally {
    console.error = orig;
  }
};

describe('the caches live in the container', () => {
  test('under the container, never at the old unscoped keys', async () => {
    await writeCache(ctx, CacheKey.NetWorth, { total: 1 });
    await writeCache(ctx, CacheKey.Transactions, { txns: [] });
    await writeAccountCache(ctx, 'item:acct', { rows: [] });
    const keys = [...fake.strings.keys(), ...fake.hashes.keys()].filter((k) => k.includes('cache:')).sort();
    expect(keys).toEqual(
      [
        testKey(`c:${ctx.container}:cache:inv-activity:v4`),
        testKey(`c:${ctx.container}:cache:net-worth`),
        testKey(`c:${ctx.container}:cache:transactions`),
      ].sort()
    );
    expect(await readCache<unknown>(ctx, CacheKey.NetWorth)).toEqual({ total: 1 });
    expect(await readAccountCache<unknown>(ctx, 'item:acct')).toEqual({ rows: [] });
  });

  test('another container sees none of it', async () => {
    await writeCache(ctx, CacheKey.NetWorth, { total: 1 });
    const other = { container: asContainerId(crypto.randomUUID()) };
    expect(await readCache<unknown>(other, CacheKey.NetWorth)).toBeNull();
  });

  test('keeps its expiry', async () => {
    await writeCache(ctx, CacheKey.NetWorth, { total: 1 });
    expect(await fake.ttl(testKey(`c:${ctx.container}:cache:net-worth`))).toBe(15 * 60);
  });

  test('an account entry older than the TTL is a miss', async () => {
    const realNow = Date.now;
    await writeAccountCache(ctx, 'f', { v: 1 });
    Date.now = () => realNow() + 16 * 60 * 1000;
    try {
      expect(await readAccountCache<unknown>(ctx, 'f')).toBeNull();
    } finally {
      Date.now = realNow;
    }
  });
});

describe('clearing', () => {
  test('clearCaches drops every cache, and the old unscoped keys too', async () => {
    await writeCache(ctx, CacheKey.NetWorth, { a: 1 });
    await writeCache(ctx, CacheKey.Transactions, { a: 1 });
    await writeAccountCache(ctx, 'f', { a: 1 });
    // Left by the deploy before containers; a rollback would read them.
    await fake.set(testKey('cache:net-worth'), 'old');
    await fake.set(testKey('cache:transactions'), 'old');
    await fake.hset(testKey('cache:inv-activity:v4'), { f: 'old' });

    await clearCaches(ctx);
    expect([...fake.strings.keys(), ...fake.hashes.keys()].filter((k) => k.includes('cache:'))).toEqual([]);
  });

  test('the narrow clears touch only their own cache', async () => {
    await writeCache(ctx, CacheKey.NetWorth, { a: 1 });
    await writeCache(ctx, CacheKey.Transactions, { a: 1 });
    await clearNetWorthCache(ctx);
    expect(await readCache<unknown>(ctx, CacheKey.NetWorth)).toBeNull();
    expect(await readCache<unknown>(ctx, CacheKey.Transactions)).toEqual({ a: 1 });
    await clearTransactionsCache(ctx);
    expect(await readCache<unknown>(ctx, CacheKey.Transactions)).toBeNull();
  });
});
