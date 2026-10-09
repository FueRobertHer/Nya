// lib/storage.ts
//
// Stores connected Plaid items (one per linked institution) in Upstash Redis
// (Vercel KV's successor via the Vercel Marketplace) as a hash keyed by item_id.
// Access tokens are always stored encrypted (lib/crypto.ts); this file never
// handles a raw one, and callers encrypt/decrypt at the call site.
//
// Uses HSET/HDEL on individual fields, not a single read-modify-write JSON blob,
// so two concurrent link flows can't clobber each other's writes.

import { Redis } from '@upstash/redis';
import type { Ctx } from './containers';

// The @upstash/redis client speaks HTTP, so it needs the *REST* URL
// (https://<host>), not a rediss:// connection string. Vercel's Upstash
// integration sometimes populates UPSTASH_REDIS_REST_URL with a
// rediss://...:6379 connection string, which makes the client throw "invalid
// URL". So the URL is resolved defensively: prefer any candidate already
// https://, else derive the REST URL from a rediss:// or redis:// host (Upstash
// serves REST on https://<same-host>). The REST token is the same value as the
// connection-string password, so pairing them works.
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

// Lazily constructed so importing this module (e.g. during `next build`) doesn't
// require the env vars. Supports both the Upstash Marketplace names
// (UPSTASH_REDIS_REST_*) and the legacy names on stores auto-migrated from Vercel
// KV (KV_REST_API_*).
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
 * A client that returns every value exactly as stored. The default client
 * JSON-parses anything that looks like JSON on the way out (a stored "1" comes
 * back as the number 1), which the app never notices since it wrote through the
 * same client, but a byte-exact copy of the database does. Only lib/export.ts
 * should need this.
 */
let _rawRedis: Redis | undefined;
export function rawRedis(): Redis {
  if (!_rawRedis) _rawRedis = new Redis({ ...credentials(), automaticDeserialization: false });
  return _rawRedis;
}

// All environments share one Upstash database, isolated by key namespace: every
// Redis key is prefixed with the environment name (production:..., preview:...,
// dev:...). Vercel sets VERCEL_ENV; local `next dev` falls through to 'dev'.
// REDIS_PREFIX overrides both, e.g. to point a branch at another namespace.
//
// The prefix must be a single plain segment: letters, digits, '-' and '_'. A
// colon would nest one environment inside another ('production:restore-test'
// lives under 'production:'), so anything that walks one environment's keys, like
// lib/export.ts, would sweep up the other's too and a restore would write them
// back as the outer environment's data. Glob characters would make a key pattern
// match more than the prefix. Refused at startup rather than tolerated: a bad
// prefix should stop the app loudly, not blend two databases.
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
 * The environment's own prefix, "<env>:", for the few things that walk the
 * whole environment (export, restore, the re-encryption pass, the data move).
 * Never for building a key: stored data belongs to a container (kc()), and
 * the few environment-wide stores go through kEnv().
 */
export function envPrefix(): string {
  return `${ENV_PREFIX}:`;
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

/** The prefix every key of one container starts with, for the one thing that
 *  walks a whole container (deleting an account, lib/account-deletion.ts). */
export function containerPrefix(ctx: Ctx): string {
  return `${ENV_PREFIX}:c:${ctx.container}:`;
}

/**
 * A key that belongs to the whole environment, never to one container. Only
 * these are environment-wide, and nothing else should be:
 *   - the encryption key store (lib/crypto.ts): a data key id must mean the same
 *     key everywhere in an environment;
 *   - the container registry (lib/containers.ts), which can't live inside one;
 *   - the rate limiters that count by address, before anyone is known: the
 *     login's (lib/rate-limit.ts) and the demo sign-in's
 *     (app/api/demo/sign-in); a limit on what a signed-in person does is a
 *     counter store on the storage seam (lib/repo.ts), in their container;
 *   - the cutoff for sessions from before sessions named a container
 *     (lib/sessions.ts);
 *   - the nightly backup's last outcome (lib/backup.ts);
 *   - which signed-in account owns which container (lib/owners.ts), which decides
 *     the container;
 *   - who shares which accounts with whom (lib/sharing.ts), which is between
 *     containers.
 */
export function kEnv(key: string): string {
  return `${ENV_PREFIX}:${key}`;
}

export type StoredItem = {
  item_id: string;
  institution_name: string;
  encrypted_access_token: string;
  /** Plaid's institution id, stored at link time so a new connection to an
   *  institution already linked can be recognized even while this Item can't be
   *  read. Absent on Items linked before it was stored. */
  institution_id?: string | null;
  /** Whether Plaid was billing Transactions on the Item when it was linked
   *  (from /item/get's `billed_products`), so the transactions sync knows
   *  whether a call would start that charge (lib/item-products.ts). Absent on
   *  Items linked before it was stored, all of which required Transactions;
   *  null when the lookup failed. Plain text, like the name, and listed on the
   *  Security page with it: it says whether Plaid included transactions when
   *  the connection was linked, nothing about what they are. */
  transactions_billed?: boolean | null;
};

const ITEMS_HASH = (ctx: Ctx) => kc(ctx, 'plaid:items');

export async function getItems(ctx: Ctx): Promise<StoredItem[]> {
  const map = await redis().hgetall<Record<string, StoredItem>>(ITEMS_HASH(ctx));
  if (!map) return [];
  return Object.values(map);
}

export async function saveItem(ctx: Ctx, item: StoredItem): Promise<void> {
  await redis().hset(ITEMS_HASH(ctx), { [item.item_id]: item });
}

export async function removeItem(ctx: Ctx, item_id: string): Promise<void> {
  await redis().hdel(ITEMS_HASH(ctx), item_id);
}
