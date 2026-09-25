import { describe, expect, test, mock, beforeEach, afterEach } from 'bun:test';
import { FakeRedis, storageMock, testKey } from './fake-redis';

process.env.PLAID_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');

const fake = new FakeRedis({ deserialize: true });
mock.module('@/lib/storage', () => storageMock(fake));

const {
  cacheCtx,
  forgetCacheCtx,
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
  forgetCacheCtx();
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

describe('without a container, no cache (and never a guessed key)', () => {
  test('cacheCtx resolves CONTAINER_ID', async () => {
    expect(await cacheCtx()).toEqual(ctx);
  });

  test('an unset or unknown CONTAINER_ID turns caching off, logged once', async () => {
    delete process.env.CONTAINER_ID;
    const { result, logged } = await quiet(async () => [await cacheCtx(), await cacheCtx()]);
    expect(result).toEqual([null, null]);
    expect(logged).toHaveLength(1);
    expect(logged[0]).toContain('Caching is off');
    expect(logged[0]).toContain('CONTAINER_ID is not set');

    forgetCacheCtx();
    process.env.CONTAINER_ID = crypto.randomUUID();
    const second = await quiet(() => cacheCtx());
    expect(second.result).toBeNull();
    expect(second.logged[0]).toContain('not in the registry');
  });

  test('with no context every read misses and nothing is written', async () => {
    delete process.env.CONTAINER_ID;
    const before = JSON.stringify([[...fake.strings], [...fake.hashes].map(([k, h]) => [k, [...h]])]);
    const ops = fake.ops;
    await writeCache(null, CacheKey.NetWorth, { a: 1 });
    await writeAccountCache(null, 'f', { a: 1 });
    expect(await readCache<unknown>(null, CacheKey.NetWorth)).toBeNull();
    expect(await readAccountCache<unknown>(null, 'f')).toBeNull();
    await clearNetWorthCache(null);
    await clearTransactionsCache(null);
    expect(fake.ops).toBe(ops); // not a single command: no key was even guessed
    expect(JSON.stringify([[...fake.strings], [...fake.hashes].map(([k, h]) => [k, [...h]])])).toBe(before);
  });

  test('clearCaches with no context and no CONTAINER_ID still drops the old unscoped keys', async () => {
    await writeCache(ctx, CacheKey.NetWorth, { a: 1 });
    await fake.set(testKey('cache:net-worth'), 'old');
    delete process.env.CONTAINER_ID;
    await clearCaches(null);
    expect(await fake.get(testKey('cache:net-worth'))).toBeNull();
    expect(await readCache<unknown>(ctx, CacheKey.NetWorth)).toEqual({ a: 1 }); // nothing names it
  });

  test('a clear that could not resolve the container still clears where CONTAINER_ID points', async () => {
    // A registry read failing during a mutation must not leave the payload it
    // should drop, to be served again once resolving works.
    await writeCache(ctx, CacheKey.NetWorth, { a: 1 });
    await writeCache(ctx, CacheKey.Transactions, { a: 1 });
    await clearNetWorthCache(null);
    expect(await readCache<unknown>(ctx, CacheKey.NetWorth)).toBeNull();
    await clearTransactionsCache(null);
    expect(await readCache<unknown>(ctx, CacheKey.Transactions)).toBeNull();
    await writeAccountCache(ctx, 'f', { a: 1 });
    await clearCaches(null);
    expect(await readAccountCache<unknown>(ctx, 'f')).toBeNull();
  });

  test('an archived or restoring container gets no cache', async () => {
    for (const status of ['archived', 'restoring']) {
      await fake.hset(testKey('containers'), { [ctx.container]: JSON.stringify({ status, primary: true, created_at: 'x' }) });
      forgetCacheCtx();
      const { result, logged } = await quiet(() => cacheCtx());
      expect(result).toBeNull();
      expect(logged[0]).toContain(status);
    }
  });

  test('a resolved container is reused for a short while, a failure never is', async () => {
    const t0 = Date.now();
    expect(await cacheCtx(t0)).toEqual(ctx);
    const ops = fake.ops;
    expect(await cacheCtx(t0 + 20_000)).toEqual(ctx);
    expect(fake.ops).toBe(ops); // no registry read
    await cacheCtx(t0 + 31_000);
    expect(fake.ops).toBe(ops + 1); // read again

    fake.failNext('hget');
    forgetCacheCtx();
    const failed = await quiet(() => cacheCtx(t0));
    expect(failed.result).toBeNull();
    expect(await cacheCtx(t0 + 1)).toEqual(ctx); // the next request tries again
  });

  test('a changed CONTAINER_ID is not served from the reuse', async () => {
    const t0 = Date.now();
    await cacheCtx(t0);
    process.env.CONTAINER_ID = crypto.randomUUID();
    const { result } = await quiet(() => cacheCtx(t0 + 1));
    expect(result).toBeNull();
  });

  test('each distinct reason is logged once, and a database error says what failed', async () => {
    delete process.env.CONTAINER_ID;
    const first = await quiet(async () => {
      await cacheCtx();
      await cacheCtx();
    });
    expect(first.logged).toHaveLength(1);

    process.env.CONTAINER_ID = ctx.container;
    fake.failNext('hget');
    const second = await quiet(() => cacheCtx());
    expect(second.logged).toHaveLength(1);
    expect(second.logged[0]).toContain('armed failure for hget');
  });

  test('a Redis failure while resolving is no cache, not a failed request', async () => {
    fake.failNext('hget');
    const { result } = await quiet(() => cacheCtx());
    expect(result).toBeNull();
  });
});
