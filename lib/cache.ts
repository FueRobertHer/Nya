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

/** Drop all cached payloads -- call after any mutation (link/disconnect). */
export async function clearCaches(): Promise<void> {
  try {
    await redis().del(NET_WORTH_CACHE_KEY, TRANSACTIONS_CACHE_KEY);
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
