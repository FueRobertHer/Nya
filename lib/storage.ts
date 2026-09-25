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
import type { Ctx } from './containers';

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
function credentials(): { url: string; token: string } {
  const url = resolveRedisUrl();
  const token = process.env.UPSTASH_REDIS_REST_TOKEN ?? process.env.KV_REST_API_TOKEN;
  if (!url || !token) {
    throw new Error(
      'Missing Redis credentials: set UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN (or legacy KV_REST_API_URL / KV_REST_API_TOKEN).'
    );
  }
  return { url, token };
}

let _redis: Redis | undefined;
export function redis(): Redis {
  if (!_redis) _redis = new Redis(credentials());
  return _redis;
}

/**
 * A client that returns every value exactly as stored.
 *
 * The default client JSON-parses anything that looks like JSON on the way out,
 * so a stored "1" comes back as the number 1 and a stored '{"a":1}' as an
 * object. The app never notices, because it wrote those values through the
 * same client. A byte-exact copy of the database does notice: writing the
 * parsed form back would not reproduce what was there. Only lib/export.ts
 * should need this.
 */
let _rawRedis: Redis | undefined;
export function rawRedis(): Redis {
  if (!_rawRedis) _rawRedis = new Redis({ ...credentials(), automaticDeserialization: false });
  return _rawRedis;
}

// All environments share one Upstash database, isolated by key namespace:
// every Redis key is prefixed with the environment name (production:…,
// preview:…, dev:…). Vercel sets VERCEL_ENV; local `next dev` falls through
// to 'dev'. REDIS_PREFIX overrides both, e.g. to point a branch at another
// namespace deliberately.
//
// The prefix must be a single plain segment: letters, digits, '-' and '_'.
// A colon would nest one environment inside another ('production:restore-test'
// lives under 'production:'), so anything that walks one environment's keys,
// like lib/export.ts, would silently sweep up the other's too, and a restore
// would then write them back as the outer environment's own data. Glob
// characters would make a key-pattern match more than the prefix. Refused at
// startup rather than tolerated: a misconfigured prefix should stop the app
// loudly, not blend two databases together.
const ENV_PREFIX = validPrefix(process.env.REDIS_PREFIX ?? process.env.VERCEL_ENV ?? 'dev');

function validPrefix(prefix: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(prefix)) {
    throw new Error(
      `Invalid Redis key prefix ${JSON.stringify(prefix)}: use only letters, digits, '-' and '_' (check REDIS_PREFIX).`
    );
  }
  return prefix;
}

/**
 * A key in the environment, not yet in any container.
 *
 * @deprecated Every record is moving into a container (#53): use kc()
 * for anything that belongs to one, or kEnv() for the few environment-wide
 * stores. Kept until the move, after which it is removed.
 */
export function k(key: string): string {
  return `${ENV_PREFIX}:${key}`;
}

/**
 * A key inside one container: "<env>:c:<container id>:<key>".
 *
 * The container segment comes from a Ctx, which only resolveCtx() (or a test)
 * produces, so a key cannot be built for a container nobody resolved.
 */
export function kc(ctx: Ctx, key: string): string {
  return `${ENV_PREFIX}:c:${ctx.container}:${key}`;
}

/**
 * A key that belongs to the whole environment, never to one container.
 *
 * Identical to k() today, but it stays where it is when everything else moves
 * into containers (#53). Only these are environment-wide, and nothing else
 * should be:
 *   - the encryption key store (lib/crypto.ts): a data key id must mean the
 *     same key everywhere in an environment, or a value could not be
 *     decrypted without knowing which container's store to look in;
 *   - the container registry (lib/containers.ts), which says what containers
 *     exist, so cannot live inside one;
 *   - the login rate limiter (app/api/login), which runs before anyone is
 *     known;
 *   - the cutoff for sessions from before sessions named a container
 *     (lib/sessions.ts), which by definition belong to none.
 */
export function kEnv(key: string): string {
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
