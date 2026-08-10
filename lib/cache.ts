// lib/cache.ts
//
// Short-lived cache of assembled API payloads (balances, transactions) in
// Redis, so dashboard loads don't wait on live Plaid round trips every time.
// The Refresh button bypasses it with ?refresh=1.
//
// These payloads are financial data, so they're encrypted with the same
// AES-256-GCM key as the Plaid access tokens (lib/crypto.ts) -- a
// database-only leak exposes neither tokens nor balances.

import { redis, k } from './storage';
import { encrypt, decrypt } from './crypto';

const TTL_SECONDS = 15 * 60;

export const NET_WORTH_CACHE_KEY = k('cache:net-worth');
export const TRANSACTIONS_CACHE_KEY = k('cache:transactions');
// Per-account investment activity, one hash field per account_id rather than
// one key each. A hash keeps clearCaches() a single del of known keys -- with
// per-account keys it would need a scan, and this is the only cache whose key
// set isn't known ahead of time.
export const INVESTMENT_ACTIVITY_CACHE_KEY = k('cache:inv-activity');

export async function readCache<T>(key: string): Promise<T | null> {
  try {
    const blob = await redis().get<string>(key);
    if (!blob) return null;
    return JSON.parse(await decrypt(blob)) as T;
  } catch {
    // Decrypt/parse failure (rotated key, corrupted value) is just a miss.
    return null;
  }
}

export async function writeCache(key: string, value: unknown): Promise<void> {
  try {
    await redis().set(key, await encrypt(JSON.stringify(value)), { ex: TTL_SECONDS });
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
export async function readAccountCache<T>(field: string): Promise<T | null> {
  try {
    const blob = await redis().hget<string>(INVESTMENT_ACTIVITY_CACHE_KEY, field);
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

export async function writeAccountCache(field: string, value: unknown): Promise<void> {
  try {
    await redis().hset(INVESTMENT_ACTIVITY_CACHE_KEY, {
      [field]: await encrypt(JSON.stringify({ at: Date.now(), value })),
    });
    // Best-effort cleanup only; if this fails the stamp above still expires
    // every field on read, so a hash with no TTL can serve stale data to nobody.
    await redis().expire(INVESTMENT_ACTIVITY_CACHE_KEY, TTL_SECONDS * 4);
  } catch {
    // A cache write failure must never break the request that produced the data.
  }
}

/** Drop all cached payloads -- call after any mutation (link/disconnect). */
export async function clearCaches(): Promise<void> {
  try {
    await redis().del(
      NET_WORTH_CACHE_KEY,
      TRANSACTIONS_CACHE_KEY,
      INVESTMENT_ACTIVITY_CACHE_KEY
    );
  } catch {
    // Worst case the stale cache lives out its TTL.
  }
}

/** Drop only the net-worth payload. Called when a live fetch comes back with a
 *  failed institution, so a healthy entry written before the failure can't keep
 *  being served alongside it for the rest of its TTL. */
export async function clearNetWorthCache(): Promise<void> {
  try {
    await redis().del(NET_WORTH_CACHE_KEY);
  } catch {
    // Worst case the stale cache lives out its TTL.
  }
}

/** Drop only the transactions payload (e.g. after a recategorization). */
export async function clearTransactionsCache(): Promise<void> {
  try {
    await redis().del(TRANSACTIONS_CACHE_KEY);
  } catch {
    // Worst case the stale cache lives out its TTL.
  }
}
