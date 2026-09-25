// lib/cache.ts
//
// Short-lived cache of assembled API payloads (balances, transactions) in
// Redis, so dashboard loads don't wait on live Plaid round trips every time.
// The Refresh button bypasses it with ?refresh=1.
//
// These payloads are financial data, so they're encrypted with the same
// AES-256-GCM key as the Plaid access tokens (lib/crypto.ts) -- a
// database-only leak exposes neither tokens nor balances.
//
// THE FIRST STORE INSIDE A CONTAINER (#53). Callers name a cache (CacheKey),
// never a Redis key; the key is built here, with kc(), inside the container
// the request resolved. Caches went first because they are disposable: a
// mistake costs one cold load.
//
// A request that cannot resolve its container (CONTAINER_ID unset or wrong,
// or the database failing) gets no cache, never a guessed key: every read
// misses and every write is skipped, logged once per reason. Clears still
// run where CONTAINER_ID points, since deleting cannot do harm. A cache is
// never allowed to break the request that uses it.

import { redis, k, kc } from './storage';
import { encrypt, decrypt } from './crypto';
import { CONTAINER_ENV, ContainerError, asContainerId, isContainerId, resolveCtx, type Ctx } from './containers';

const TTL_SECONDS = 15 * 60;

/** The caches a caller can name. The value is the key inside the container. */
export const CacheKey = {
  NetWorth: 'cache:net-worth',
  Transactions: 'cache:transactions',
} as const;
export type CacheKey = (typeof CacheKey)[keyof typeof CacheKey];

// Per-account investment activity, one hash field per account_id rather than
// one key each. A hash keeps clearCaches() a single del of known keys -- with
// per-account keys it would need a scan, and this is the only cache whose key
// set isn't known ahead of time.
//
// Versioned because the payload's MEANING changed when rollovers were split out
// of its contributions figure, not just its shape: entries written by the
// previous deploy would otherwise keep serving the un-split number for the rest
// of their TTL. Versioning the key rather than the field lets the old hash
// expire wholesale on the TTL it already carries, instead of leaving dead
// fields inside a live hash that every write renews.
const INVESTMENT_ACTIVITY = 'cache:inv-activity:v4';

/**
 * The same caches at their keys from before containers. Nothing reads or
 * writes them any more; clearCaches() still deletes them, so a rollback to the
 * previous deploy (which reads only these) is not served a payload that a
 * link or disconnect since should have cleared. Remove once no deployment
 * from before containers can come back.
 */
const LEGACY_KEYS = () => [k('cache:net-worth'), k('cache:transactions'), k('cache:inv-activity:v4')];

/** Every cache's key, spelled out, so the key-name check in
 *  test/reencrypt.test.ts can see each one. */
function keyOf(ctx: Ctx, which: CacheKey | typeof INVESTMENT_ACTIVITY): string {
  switch (which) {
    case 'cache:net-worth':
      return kc(ctx, 'cache:net-worth');
    case 'cache:transactions':
      return kc(ctx, 'cache:transactions');
    case 'cache:inv-activity:v4':
      return kc(ctx, 'cache:inv-activity:v4');
  }
}

/** How long a process reuses the container it resolved. Short, so a
 *  container marked restoring or archived stops being cached into promptly;
 *  long enough that a cache hit is one Redis round trip, not two. */
const CTX_REUSE_MS = 30 * 1000;
let _ctx: { env: string; ctx: Ctx; at: number } | null = null;
const _logged = new Set<string>();

/**
 * The container a request's caches live in, or null for "no cache this
 * request". Resolve it once per request and pass it to every call below.
 * A failure is logged once per distinct reason and never reused: the next
 * request tries again.
 */
export async function cacheCtx(now: number = Date.now()): Promise<Ctx | null> {
  const env = process.env[CONTAINER_ENV] ?? '';
  if (_ctx && _ctx.env === env && now - _ctx.at >= 0 && now - _ctx.at < CTX_REUSE_MS) return _ctx.ctx;
  try {
    const ctx = await resolveCtx();
    _ctx = { env, ctx, at: now };
    return ctx;
  } catch (err) {
    // A ContainerError is written for the operator. Anything else is the
    // database failing; Upstash appends the command it ran, which here holds
    // only the registry key and a container id, but it is cut off anyway.
    const why =
      err instanceof ContainerError
        ? err.message
        : err instanceof Error
          ? `${err.name}: ${err.message.replace(/, command was: [\s\S]*$/, '').slice(0, 200)}`
          : 'error';
    if (!_logged.has(why)) {
      _logged.add(why);
      console.error(`Caching is off: the container could not be resolved (${why}).`);
    }
    return null;
  }
}

/** For tests. */
export function forgetCacheCtx(): void {
  _ctx = null;
  _logged.clear();
}

export async function readCache<T>(ctx: Ctx | null, which: CacheKey): Promise<T | null> {
  if (!ctx) return null;
  try {
    const blob = await redis().get<string>(keyOf(ctx, which));
    if (!blob) return null;
    return JSON.parse(await decrypt(blob)) as T;
  } catch {
    // Decrypt/parse failure (rotated key, corrupted value) is just a miss.
    return null;
  }
}

export async function writeCache(ctx: Ctx | null, which: CacheKey, value: unknown): Promise<void> {
  if (!ctx) return;
  try {
    await redis().set(keyOf(ctx, which), await encrypt(JSON.stringify(value)), { ex: TTL_SECONDS });
  } catch {
    // A cache write failure must never break the request that produced the data.
  }
}

/**
 * Cached investment activity for one account.
 *
 * Unlike the account sparkline -- whose endpoint reads straight from Redis and
 * so can be re-fetched on every tap -- this one makes live paginated Plaid
 * calls, so an uncached expand/collapse loop would hammer the API.
 */
export async function readAccountCache<T>(ctx: Ctx | null, field: string): Promise<T | null> {
  if (!ctx) return null;
  try {
    const blob = await redis().hget<string>(keyOf(ctx, INVESTMENT_ACTIVITY), field);
    if (!blob) return null;
    const { at, value } = JSON.parse(await decrypt(blob)) as { at: number; value: T };
    // Per-field expiry is enforced here, not by Redis. A hash carries one TTL
    // for all its fields, and every write would slide it -- so under an
    // expand/collapse loop a field written 40 minutes ago would keep being
    // renewed by writes to other accounts and never expire. The key's own TTL
    // stays on purely as cleanup for a hash nobody touches again.
    if (typeof at !== 'number' || Date.now() - at > TTL_SECONDS * 1000) return null;
    return value;
  } catch {
    return null;
  }
}

export async function writeAccountCache(ctx: Ctx | null, field: string, value: unknown): Promise<void> {
  if (!ctx) return;
  const key = keyOf(ctx, INVESTMENT_ACTIVITY);
  try {
    await redis().hset(key, {
      [field]: await encrypt(JSON.stringify({ at: Date.now(), value })),
    });
    // Best-effort cleanup only; if this fails the stamp above still expires
    // every field on read, so a hash with no TTL can serve stale data to nobody.
    await redis().expire(key, TTL_SECONDS * 4);
  } catch {
    // A cache write failure must never break the request that produced the data.
  }
}

/**
 * Where to clear when the container could not be resolved: the one
 * CONTAINER_ID names, unchecked. Deleting is harmless under a wrong id, and
 * skipping it would leave a payload a mutation should have dropped, to be
 * served again once resolving works. Only ever used to delete.
 */
function clearTarget(ctx: Ctx | null): Ctx | null {
  if (ctx) return ctx;
  const raw = process.env[CONTAINER_ENV];
  return isContainerId(raw) ? { container: asContainerId(raw) } : null;
}

/** Drop all cached payloads -- call after any mutation (link/disconnect). */
export async function clearCaches(ctx: Ctx | null): Promise<void> {
  try {
    const target = clearTarget(ctx);
    const keys = target
      ? [keyOf(target, CacheKey.NetWorth), keyOf(target, CacheKey.Transactions), keyOf(target, INVESTMENT_ACTIVITY)]
      : [];
    await redis().del(...keys, ...LEGACY_KEYS());
  } catch {
    // Worst case the stale cache lives out its TTL.
  }
}

/** Drop only the net-worth payload. Called when a live fetch comes back with a
 *  failed institution, so a healthy entry written before the failure can't keep
 *  being served alongside it for the rest of its TTL. */
export async function clearNetWorthCache(ctx: Ctx | null): Promise<void> {
  const target = clearTarget(ctx);
  if (!target) return;
  try {
    await redis().del(keyOf(target, CacheKey.NetWorth));
  } catch {
    // Worst case the stale cache lives out its TTL.
  }
}

/** Drop only the transactions payload (e.g. after a recategorization). */
export async function clearTransactionsCache(ctx: Ctx | null): Promise<void> {
  const target = clearTarget(ctx);
  if (!target) return;
  try {
    await redis().del(keyOf(target, CacheKey.Transactions));
  } catch {
    // Worst case the stale cache lives out its TTL.
  }
}
