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

// The @upstash/redis client speaks HTTP, so it needs the *REST* URL
// (https://<host>), not a rediss:// connection string. Vercel's Upstash
// Marketplace integration injects several env vars, and on some projects it
// populates UPSTASH_REDIS_REST_URL with a rediss://…:6379 connection string
// instead of the REST URL — which makes the client throw "invalid URL". So we
// resolve the URL defensively: prefer any candidate that's already https://,
// and if we only have a rediss:///redis:// one, derive the REST URL from its
// host (Upstash serves REST on https://<same-host>). The REST token is the
// same value as the connection-string password, so pairing them works.
function resolveRedisUrl(): string | undefined {
  const candidates = [
    process.env.UPSTASH_REDIS_REST_URL,
    process.env.KV_REST_API_URL,
  ].filter((u): u is string => !!u);

  const https = candidates.find((u) => u.startsWith('https://'));
  if (https) return https;

  const conn = candidates.find((u) => u.startsWith('rediss://') || u.startsWith('redis://'));
  if (conn) {
    try {
      return `https://${new URL(conn).hostname}`;
    } catch {
      /* fall through to the missing-credentials error */
    }
  }
  return undefined;
}

// Lazily constructed so importing this module (e.g. during `next build`)
// doesn't require the env vars to be set. Supports both the env var names
// the Upstash Marketplace integration injects (UPSTASH_REDIS_REST_*) and
// the legacy names kept on stores auto-migrated from Vercel KV
// (KV_REST_API_*).
let _redis: Redis | undefined;
export function redis(): Redis {
  if (!_redis) {
    const url = resolveRedisUrl();
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

// All environments share one Upstash database, isolated by key namespace:
// every Redis key is prefixed with the environment name (production:…,
// preview:…, dev:…). Vercel sets VERCEL_ENV; local `next dev` falls through
// to 'dev'. REDIS_PREFIX overrides both, e.g. to point a branch at another
// namespace deliberately.
const ENV_PREFIX = process.env.REDIS_PREFIX ?? process.env.VERCEL_ENV ?? 'dev';

export function k(key: string): string {
  return `${ENV_PREFIX}:${key}`;
}

export type StoredItem = {
  item_id: string;
  institution_name: string;
  encrypted_access_token: string;
};

const ITEMS_HASH = k('plaid:items');

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
