// lib/storage.ts
//
// Stores connected Plaid items (one per linked institution) in Upstash
// Redis (Vercel KV's successor via the Vercel Marketplace), as a Redis
// hash keyed by item_id. Access tokens are always stored encrypted -- see
// lib/crypto.ts. This file never handles a raw access token; callers
// encrypt/decrypt at the call site.
//
// Uses HSET/HDEL on individual fields (not a single read-modify-write JSON
// blob) so that two concurrent link flows can't clobber each other's writes.

import { Redis } from '@upstash/redis';

// Lazily constructed so importing this module (e.g. during `next build`)
// doesn't require the env vars to be set. Supports both the env var names
// the Upstash Marketplace integration injects (UPSTASH_REDIS_REST_*) and
// the legacy names kept on stores auto-migrated from Vercel KV
// (KV_REST_API_*).
let _redis: Redis | undefined;
function redis(): Redis {
  if (!_redis) {
    const url = process.env.UPSTASH_REDIS_REST_URL ?? process.env.KV_REST_API_URL;
    const token = process.env.UPSTASH_REDIS_REST_TOKEN ?? process.env.KV_REST_API_TOKEN;
    if (!url || !token) {
      throw new Error(
        'Missing Redis credentials: set UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN (or legacy KV_REST_API_URL / KV_REST_API_TOKEN).'
      );
    }
    _redis = new Redis({ url, token });
  }
  return _redis;
}

export type StoredItem = {
  item_id: string;
  institution_name: string;
  encrypted_access_token: string;
};

const ITEMS_HASH = 'plaid:items';

export async function getItems(): Promise<StoredItem[]> {
  const map = await redis().hgetall<Record<string, StoredItem>>(ITEMS_HASH);
  if (!map) return [];
  return Object.values(map);
}

export async function saveItem(item: StoredItem): Promise<void> {
  await redis().hset(ITEMS_HASH, { [item.item_id]: item });
}

export async function removeItem(item_id: string): Promise<void> {
  await redis().hdel(ITEMS_HASH, item_id);
}
