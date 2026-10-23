// lib/plaid-webhook.ts
//
// Receiving Plaid's webhooks: proving one came from Plaid, and deciding what
// it changes here.
//
// Verification follows Plaid's documented scheme. The Plaid-Verification header
// is an ES256 JWT whose claims carry the SHA-256 of the raw request body and
// the time it was issued. The key comes from /webhook_verification_key/get by
// the JWT's key id. Anything that fails is refused, so an unauthenticated
// caller can only ever get a 401, never a cache flush.
//
// What a webhook does: drop the container's cached payloads. The next
// dashboard load then fetches from Plaid, and until then loads are served from
// storage (lib/cache.ts). Dropping a cache cannot lose data, which is what
// makes it safe to do on the say-so of a verified webhook. Besides that, three
// ITEM webhooks are remembered, none of which can change a balance or the
// history: NEW_ACCOUNTS_AVAILABLE (lib/new-accounts.ts), and Plaid's early
// warnings that a connection will end, PENDING_EXPIRATION and
// PENDING_DISCONNECT, which LOGIN_REPAIRED clears (lib/connection-health.ts).

import { createHash, createPublicKey, timingSafeEqual, verify } from 'node:crypto';
import { plaidClient } from './plaid';
import { clearCaches } from './cache';
import { markNewAccounts } from './new-accounts';
import { clearRepaired, recordWarning } from './connection-health';
import type { Ctx } from './containers';

/** A webhook older than this is refused (Plaid's own guidance is 5 minutes). */
export const MAX_AGE_SECONDS = 5 * 60;

export class WebhookRejected extends Error {}

type Jwk = Record<string, unknown> & { kid?: string; expired_at?: number | null };

// Keys are stable for a long while, so one lookup serves many webhooks, but not
// forever: a cached key is looked up again after KEY_MAX_AGE_MS, so a rotation or
// revocation is noticed. An unknown key id is remembered as unknown for a minute,
// and lookups of ids never seen before are capped at MAX_LOOKUPS a minute for the
// whole process, so unauthenticated requests naming ids at random cannot turn
// this route into an unbounded stream of Plaid calls (they can still use up the
// cap for a minute, which costs a genuine webhook one retry: Plaid retries).
const KEY_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const MISS_MS = 60 * 1000;
const MAX_TRACKED = 64;
const MAX_LOOKUPS = 20;
let lookupWindow = { start: 0, n: 0 };
const keys = new Map<string, { jwk: Jwk; at: number }>();
const misses = new Map<string, number>();

/** For tests. */
export function forgetKeys(): void {
  keys.clear();
  misses.clear();
  lookupWindow = { start: 0, n: 0 };
}

const b64json = (part: string): any => JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));

async function keyFor(kid: string, now: number): Promise<Jwk> {
  const known = keys.get(kid);
  if (known && now - known.at < KEY_MAX_AGE_MS) return known.jwk;
  const missed = misses.get(kid);
  if (missed !== undefined && now - missed < MISS_MS) throw new Error('unknown key');
  if (now - lookupWindow.start >= MISS_MS) lookupWindow = { start: now, n: 0 };
  if (++lookupWindow.n > MAX_LOOKUPS) throw new Error('too many key lookups');
  try {
    const res = await plaidClient.webhookVerificationKeyGet({ key_id: kid });
    const jwk = res.data.key as unknown as Jwk;
    if (keys.size >= MAX_TRACKED) keys.clear();
    keys.set(kid, { jwk, at: now });
    misses.delete(kid);
    return jwk;
  } catch (err) {
    if (misses.size >= MAX_TRACKED) misses.clear();
    misses.set(kid, now);
    throw err;
  }
}

/**
 * Throws WebhookRejected unless `header` is a valid Plaid signature over
 * exactly `rawBody`. `now` is in milliseconds, for tests.
 */
export async function verifyWebhook(rawBody: string, header: string | null, now: number = Date.now()): Promise<void> {
  if (!header) throw new WebhookRejected('missing Plaid-Verification header');
  const parts = header.split('.');
  if (parts.length !== 3) throw new WebhookRejected('malformed token');
  const [h, p, s] = parts;

  let head: any;
  let claims: any;
  try {
    head = b64json(h);
    claims = b64json(p);
  } catch {
    throw new WebhookRejected('malformed token');
  }
  // Only ES256 is accepted: never the algorithm the token itself names.
  if (head?.alg !== 'ES256' || typeof head?.kid !== 'string') throw new WebhookRejected('unexpected algorithm');

  let jwk: Jwk;
  try {
    jwk = await keyFor(head.kid, now);
  } catch {
    throw new WebhookRejected('unknown key');
  }
  if (jwk.expired_at != null && jwk.expired_at * 1000 <= now) throw new WebhookRejected('key expired');

  let ok = false;
  try {
    ok = verify(
      'sha256',
      Buffer.from(`${h}.${p}`),
      { key: createPublicKey({ key: jwk as any, format: 'jwk' }), dsaEncoding: 'ieee-p1363' },
      Buffer.from(s, 'base64url')
    );
  } catch {
    ok = false;
  }
  if (!ok) throw new WebhookRejected('bad signature');

  if (typeof claims?.iat !== 'number' || Math.abs(now / 1000 - claims.iat) > MAX_AGE_SECONDS) {
    throw new WebhookRejected('stale or undated');
  }

  const want = Buffer.from(String(claims.request_body_sha256 ?? ''), 'hex');
  const got = createHash('sha256').update(rawBody).digest();
  if (want.length !== got.length || !timingSafeEqual(want, got)) throw new WebhookRejected('body does not match');
}

/**
 * Whether this webhook means the data we hold may now be out of date.
 *
 * Deliberately generous about Item problems (a login gone stale, an expiring
 * consent, an error): clearing the cache makes the next load fetch, which is
 * how the app finds out and shows the reconnect prompt. Unknown kinds change
 * nothing.
 */
export function invalidates(body: { webhook_type?: unknown; webhook_code?: unknown }): boolean {
  const type = body.webhook_type;
  const code = body.webhook_code;
  switch (type) {
    case 'TRANSACTIONS':
      return code === 'SYNC_UPDATES_AVAILABLE' || code === 'INITIAL_UPDATE' || code === 'HISTORICAL_UPDATE' || code === 'DEFAULT_UPDATE';
    case 'HOLDINGS':
    case 'INVESTMENTS_TRANSACTIONS':
    case 'LIABILITIES':
      return code === 'DEFAULT_UPDATE';
    case 'ITEM':
      return (
        code === 'ERROR' ||
        code === 'LOGIN_REPAIRED' ||
        code === 'PENDING_EXPIRATION' ||
        code === 'PENDING_DISCONNECT' ||
        code === 'USER_PERMISSION_REVOKED' ||
        code === 'USER_ACCOUNT_REVOKED' ||
        code === 'NEW_ACCOUNTS_AVAILABLE'
      );
    default:
      return false;
  }
}

/**
 * Applies a verified webhook to a container. Returns whether it changed anything.
 * The caller has already checked `item_id` is one of this container's Items.
 */
export async function applyWebhook(
  ctx: Ctx,
  body: { webhook_type?: unknown; webhook_code?: unknown; item_id?: unknown; consent_expiration_time?: unknown; reason?: unknown },
  now: number = Date.now()
): Promise<boolean> {
  if (!invalidates(body)) return false;
  if (body.webhook_type === 'ITEM' && typeof body.item_id === 'string') {
    // Remembered so the card can offer to add them to this Item, rather than the
    // user connecting the institution a second time to get at them.
    if (body.webhook_code === 'NEW_ACCOUNTS_AVAILABLE') await markNewAccounts(ctx, body.item_id);
    // Plaid's week of notice that the connection will end, shown as "Reconnect
    // soon" and emailed by the daily job (lib/connection-notices.ts). A failure
    // to record it answers 500, so Plaid sends it again.
    if (body.webhook_code === 'PENDING_EXPIRATION' || body.webhook_code === 'PENDING_DISCONNECT') {
      await recordWarning(ctx, body.item_id, body, now);
    }
    // Repaired elsewhere (update mode in another app, say): nothing to warn of.
    if (body.webhook_code === 'LOGIN_REPAIRED') await clearRepaired(ctx, body.item_id);
  }
  await clearCaches(ctx);
  return true;
}
