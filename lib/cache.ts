// lib/cache.ts
//
// Short-lived cache of assembled API payloads (balances, transactions) in Redis,
// so dashboard loads don't wait on live Plaid round trips. Refresh bypasses it
// with ?refresh=1.
//
// The payloads are financial data, so they're encrypted with the same key as
// everything else (lib/crypto.ts). They live inside the request's container
// (#53). Callers name a cache (CacheKey), never a Redis key; the key is built
// here with kc(). A cache must never break the request that uses it.

import { redis, kc, envPrefix } from './storage';
import { encrypt, decrypt } from './crypto';
import type { Ctx } from './containers';

import { webhooksEnabled } from './webhook-url';

/**
 * How long a cached payload is served. Short by default, since nothing tells the
 * app when its data changed. With webhooks on (lib/webhook-url.ts) Plaid says so
 * and the webhook route drops the caches (clearCaches) when new data arrives, so
 * a payload can stand for hours: loads come from our own storage, and only
 * Refresh, a webhook or the daily snapshot goes to Plaid. Read per call, not at
 * import, so it follows the environment.
 */
// Exported for the retention table on the privacy page (app/privacy), which a
// test holds to these.
export const SHORT_TTL_SECONDS = 15 * 60;
export const WEBHOOK_TTL_SECONDS = 6 * 60 * 60;
const ttlSeconds = () => (webhooksEnabled() ? WEBHOOK_TTL_SECONDS : SHORT_TTL_SECONDS);

/** The caches a caller can name. The value is the key inside the container. */
export const CacheKey = {
  NetWorth: 'cache:net-worth',
  Transactions: 'cache:transactions',
} as const;
export type CacheKey = (typeof CacheKey)[keyof typeof CacheKey];

// Per-account investment activity, one hash field per account_id rather than one
// key each, so clearCaches() is a single del of known keys (per-account keys
// would need a scan).
//
// Versioned because the payload's MEANING changed when rollovers were split out
// of contributions, not just its shape: entries from the previous deploy would
// keep serving the un-split number for their TTL. Versioning the key rather than
// the field lets the old hash expire wholesale instead of leaving dead fields
// inside a live hash that every write renews.
const INVESTMENT_ACTIVITY = 'cache:inv-activity:v4';

/**
 * The same caches at their keys from before containers. Nothing reads or writes
 * them; clearCaches() still deletes them so a rollback to the previous deploy
 * (which reads only these) isn't served a payload a link or disconnect should
 * have cleared. Remove once no deployment from before containers can come back.
 */
const LEGACY_KEYS = () => ['cache:net-worth', 'cache:transactions', 'cache:inv-activity:v4'].map((key) => envPrefix() + key);

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

export async function readCache<T>(ctx: Ctx, which: CacheKey): Promise<T | null> {
  try {
    const blob = await redis().get<string>(keyOf(ctx, which));
    if (!blob) return null;
    return JSON.parse(await decrypt(blob)) as T;
  } catch {
    // Decrypt/parse failure (rotated key, corrupted value) is just a miss.
    return null;
  }
}

export async function writeCache(ctx: Ctx, which: CacheKey, value: unknown): Promise<void> {
  try {
    await redis().set(keyOf(ctx, which), await encrypt(JSON.stringify(value)), { ex: ttlSeconds() });
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
export async function readAccountCache<T>(ctx: Ctx, field: string): Promise<T | null> {
  try {
    const blob = await redis().hget<string>(keyOf(ctx, INVESTMENT_ACTIVITY), field);
    if (!blob) return null;
    const { at, value } = JSON.parse(await decrypt(blob)) as { at: number; value: T };
    // Per-field expiry is enforced here, not by Redis: a hash has one TTL for all
    // fields and every write slides it, so under an expand/collapse loop a field
    // written 40 minutes ago would keep being renewed by writes to other accounts.
    // The key's own TTL stays only as cleanup for a hash nobody touches again.
    if (typeof at !== 'number' || Date.now() - at > ttlSeconds() * 1000) return null;
    return value;
  } catch {
    return null;
  }
}

export async function writeAccountCache(ctx: Ctx, field: string, value: unknown): Promise<void> {
  const key = keyOf(ctx, INVESTMENT_ACTIVITY);
  try {
    await redis().hset(key, {
      [field]: await encrypt(JSON.stringify({ at: Date.now(), value })),
    });
    // Best-effort cleanup only; if this fails the stamp above still expires
    // every field on read, so a hash with no TTL can serve stale data to nobody.
    await redis().expire(key, ttlSeconds() * 4);
  } catch {
    // A cache write failure must never break the request that produced the data.
  }
}

/** Drop all cached payloads -- call after any mutation (link/disconnect). */
export async function clearCaches(ctx: Ctx): Promise<void> {
  try {
    await redis().del(
      keyOf(ctx, CacheKey.NetWorth),
      keyOf(ctx, CacheKey.Transactions),
      keyOf(ctx, INVESTMENT_ACTIVITY),
      ...LEGACY_KEYS()
    );
  } catch {
    // Worst case the stale cache lives out its TTL.
  }
}

/** Drop only the net-worth payload. Called when a live fetch comes back with a
 *  failed institution, so a healthy entry written before the failure can't keep
 *  being served alongside it for the rest of its TTL. */
export async function clearNetWorthCache(ctx: Ctx): Promise<void> {
  try {
    await redis().del(keyOf(ctx, CacheKey.NetWorth));
  } catch {
    // Worst case the stale cache lives out its TTL.
  }
}

/** Drop only the transactions payload (e.g. after a recategorization). */
export async function clearTransactionsCache(ctx: Ctx): Promise<void> {
  try {
    await redis().del(keyOf(ctx, CacheKey.Transactions));
  } catch {
    // Worst case the stale cache lives out its TTL.
  }
}
