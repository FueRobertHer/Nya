// lib/overrides.ts
//
// Manual category overrides for transactions (Mint-style recategorization).
// Plaid's auto-categorization is good but not always right; overrides are a
// Redis hash of transaction_id -> category, applied on top of the fetched
// data in /api/transactions. Values are encrypted for consistency with
// everything else financial.

import { redis, k } from './storage';
import { encrypt, decrypt } from './crypto';

const OVERRIDES_HASH = k('txn-category-overrides');

export async function getOverrides(): Promise<Record<string, string>> {
  try {
    const map = await redis().hgetall<Record<string, string>>(OVERRIDES_HASH);
    if (!map) return {};
    const out: Record<string, string> = {};
    await Promise.all(
      Object.entries(map).map(async ([id, blob]) => {
        try {
          out[id] = await decrypt(blob);
        } catch {
          // undecryptable override (rotated key) -- drop it
        }
      })
    );
    return out;
  } catch {
    return {};
  }
}

export async function setOverride(transaction_id: string, category: string): Promise<void> {
  await redis().hset(OVERRIDES_HASH, { [transaction_id]: await encrypt(category) });
}
