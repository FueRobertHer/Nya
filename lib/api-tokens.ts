// lib/api-tokens.ts
//
// Personal API tokens: what lets a program a person chooses read their data
// through the read-only API (app/api/v1) and the MCP server (app/api/mcp),
// without a session. Stage API-0 of the developer platform (master plan, M3).
//
// A TOKEN is "nya_<id>_<secret>_<container>":
//   - id: 16 hex characters (8 random bytes), which token it is. Not secret:
//     it is the start of the token, so the list of tokens can show
//     "nya_3f9a0c1e..." for a person to recognise one by;
//   - secret: 43 characters of base64url (32 random bytes). Shown once, when
//     the token is made, and never stored: only its SHA-256 is, compared in
//     constant time;
//   - container: the opaque id of the container whose data it reads. A request
//     without a session finds its container from the token itself, so nothing
//     environment-wide is needed to look a token up (the seam keeps containers
//     only, lib/repo.ts): the token's record lives in that container, and
//     deleting the account deletes every token with the rest of it.
//
// STORED in the container (lib/api-token-store.ts), in a map store on the
// storage seam keyed by the token's id: its label, the SHA-256 of its secret,
// when it was made and when it was last used. Encrypted like every seam value;
// the id is a field name in plain text, as random as an account's. Not
// exportable: the hashes are credential material. The data download lists each
// token's label and dates itself (lib/user-export.ts), never its hash or id.
// The stored shape is closed, so a later version's record never authenticates
// here (isApiToken).
//
// CHECKING ONE (authenticate). Every failure is the same 401, after the same
// work: a malformed token, an unknown container or one that isn't active
// (restoring, archived), an unknown or revoked token, a wrong secret. Each
// reads the container's registry entry and the token's record (at once, with
// stand-ins where the token gave none) and compares a hash, so neither the
// answer nor its timing tells which containers exist. Only once the secret
// matches is the rest checked, which takes a real token to reach: with Clerk
// (lib/auth-mode.ts), the container must still have an owner on the allowlist,
// as signing in does; with the shared password, it must be this deployment's,
// as a session's must (lib/sessions.ts). Either failing is the same 401.
//
// RATE LIMITED per token: REQUESTS_PER_MINUTE in a window of
// RATE_WINDOW_SECONDS (a counter map store on the seam, in the container),
// counted once a token checks out. A count that can't be read is said (the
// route answers 503) and cleared, so the token's next request starts a new
// window: it is the service's own bookkeeping, and nothing of the person's is
// lost.
//
// READ ONLY. No route a token reaches changes the person's data. The only
// writes a token's request makes are its own bookkeeping: its count, and when
// it was last used, at most once every LAST_USED_EVERY_MS.
//
// At most MAX_TOKENS per person. Making one needs a fresh sign-in
// (lib/fresh-sign-in.ts, app/api/api-tokens), since a token goes on working
// after "Sign out everywhere"; revoking one takes effect on its next request.

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { UnreadableEntriesError, type CounterWindow } from './repo';
import { apiTokenStore, apiRequestCount, type ApiToken } from './api-token-store';
import { getContainer, isContainerId, type ContainerId, type Ctx } from './containers';
import { clerkEnabled, clerkUserAllowed } from './auth-mode';
import { ownersOf } from './owners';
import { deploymentContainer } from './sessions';
import { LABEL_MAX, MAX_TOKENS, RATE_WINDOW_SECONDS, REQUESTS_PER_MINUTE, TOKEN_PREFIX } from './api-limits';

export { LABEL_MAX, MAX_TOKENS, RATE_WINDOW_SECONDS, REQUESTS_PER_MINUTE, TOKEN_PREFIX };

/** How often, at most, a token's last use is written down. */
export const LAST_USED_EVERY_MS = 60_000;

const ID = /^[0-9a-f]{16}$/;
const TOKEN = /^nya_([0-9a-f]{16})_([A-Za-z0-9_-]{43})_([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/;
/** "nya_", the id, "_", the secret, "_", the container. */
export const TOKEN_LENGTH = TOKEN_PREFIX.length + 16 + 1 + 43 + 1 + 36;

export { apiTokenStore, apiRequestCount, type ApiToken };

/** What the list of tokens shows of one: never its hash. */
export type TokenInfo = {
  id: string;
  label: string;
  /** The token's first characters, to recognise it by. */
  hint: string;
  created_at: string;
  last_used_at: string | null;
};

const digest = (secret: string): Buffer => createHash('sha256').update(secret, 'utf8').digest();
const hintOf = (id: string) => `${TOKEN_PREFIX}${id.slice(0, 8)}`;
const infoOf = (id: string, t: ApiToken): TokenInfo => ({ id, label: t.label, hint: hintOf(id), created_at: t.created_at, last_used_at: t.last_used_at });

/** A token in its one written form. */
export function formatToken(id: string, secret: string, container: ContainerId): string {
  return `${TOKEN_PREFIX}${id}_${secret}_${container}`;
}

/** A token's parts, or null for anything that is not one. */
export function parseToken(raw: string | null): { id: string; secret: string; container: ContainerId } | null {
  if (raw === null || raw.length !== TOKEN_LENGTH) return null;
  const m = TOKEN.exec(raw);
  if (!m || !isContainerId(m[3])) return null;
  return { id: m[1], secret: m[2], container: m[3] };
}

/** The token an Authorization header carries ("Bearer <token>"; the scheme in
 *  any case, as HTTP allows), or null. */
export function bearerToken(header: string | null): string | null {
  if (!header || header.length > 512) return null;
  const m = /^Bearer +(\S+) *$/i.exec(header);
  return m ? m[1] : null;
}

/** A label as it is saved (spaces collapsed, trimmed), or why it can't be. */
export function cleanLabel(raw: unknown): string | { error: string } {
  if (typeof raw !== 'string') return { error: 'Give the token a name.' };
  const label = raw.replace(/\s+/g, ' ').trim();
  if (!label) return { error: 'Give the token a name.' };
  if (label.length > LABEL_MAX) return { error: `A name is at most ${LABEL_MAX} characters.` };
  if (/[\u0000-\u001f\u007f]/.test(label)) return { error: 'A name can’t hold control characters.' };
  return label;
}

/** A token refused for the limit: nothing was saved. */
export class TokenLimitError extends Error {
  constructor() {
    super(`You can have at most ${MAX_TOKENS} API tokens. Revoke one you no longer use first.`);
    this.name = 'TokenLimitError';
  }
}

/**
 * Makes a token named `label` (cleaned by cleanLabel), and returns it, the one
 * time it is ever available whole, with what the list shows of it. Refused
 * (TokenLimitError) past MAX_TOKENS, counted again once it is saved so that
 * two made at once can't both pass the limit: past it, the new one is taken
 * back.
 */
export async function createToken(ctx: Ctx, label: string, now: Date = new Date()): Promise<{ token: string; info: TokenInfo }> {
  if ((await apiTokenStore.count(ctx)) >= MAX_TOKENS) throw new TokenLimitError();
  const id = randomBytes(8).toString('hex');
  const secret = randomBytes(32).toString('base64url');
  const record: ApiToken = { v: 1, label, hash: digest(secret).toString('hex'), created_at: now.toISOString(), last_used_at: null };
  // Written only where nothing is: an id already taken (one in 2^64) is never
  // written over.
  await apiTokenStore.update(ctx, id, (current) => {
    if (current) throw new Error('A new API token’s id is already taken; try again.');
    return record;
  });
  if ((await apiTokenStore.count(ctx)) > MAX_TOKENS) {
    await apiTokenStore.remove(ctx, id);
    throw new TokenLimitError();
  }
  return { token: formatToken(id, secret, ctx.container), info: infoOf(id, record) };
}

/**
 * The person's tokens, newest first, never with their hashes, and the ids of
 * any whose record can't be used: `unreadable` (damaged: the person may remove
 * one, once they confirm) and `unrecognised` (intact, from another version:
 * never removed from here). Neither kind authenticates.
 */
export async function listTokens(ctx: Ctx): Promise<{ tokens: TokenInfo[]; unreadable: string[]; unrecognised: string[] }> {
  const { entries, unreadable, unrecognised } = await apiTokenStore.getAllReport(ctx);
  const tokens = [...entries]
    .map(([id, t]) => infoOf(id, t))
    .sort((a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : a.id < b.id ? -1 : 1));
  return { tokens, unreadable, unrecognised };
}

/**
 * Revokes a token: its record goes, so its next request is a 401, and its
 * count with it. False when there is no such token. A record that can't be
 * read is refused (UnreadableEntriesError), unless it is damaged and the
 * person confirmed removing it (`unreadable`); one this version doesn't
 * recognise is intact data and is never removed from here.
 */
export async function revokeToken(ctx: Ctx, id: string, opts: { unreadable?: boolean } = {}): Promise<boolean> {
  if (!ID.test(id)) return false;
  try {
    if ((await apiTokenStore.get(ctx, id)) === null) return false;
  } catch (err) {
    if (!(err instanceof UnreadableEntriesError) || !opts.unreadable || !err.unreadable.includes(id)) throw err;
  }
  await apiTokenStore.remove(ctx, id);
  // Bookkeeping: the hash expires on its own anyway.
  await apiRequestCount.remove(ctx, id).catch(() => {});
  return true;
}

/** A token that checked out: whose data it reads, and its record as read. */
export type Authenticated = { ctx: Ctx; id: string; token: ApiToken };

/** Stand-ins for a token that gave no container, id or secret, so it costs
 *  the same work as one that did (see the header). The container is a valid
 *  v4 id no container is ever given (they are random). */
const STAND_IN = {
  container: '00000000-0000-4000-8000-000000000000' as ContainerId,
  id: '0000000000000000',
  secret: 'A'.repeat(43),
};
const NO_HASH = Buffer.alloc(32);

/** A token's record, or null: none, or one that can't be used, which can't
 *  be checked and so doesn't authenticate. Storage failing throws. */
async function recordOf(ctx: Ctx, id: string): Promise<ApiToken | null> {
  try {
    return await apiTokenStore.get(ctx, id);
  } catch (err) {
    if (!(err instanceof UnreadableEntriesError)) throw err;
    console.error(`API token: a token’s record ${err.unreadable.length > 0 ? 'is damaged' : 'is not one this version understands'}, so it was refused.`);
    return null;
  }
}

/** Whether the container can still be reached by signing in (see the header). */
async function stillServes(container: ContainerId, now: number): Promise<boolean> {
  if (clerkEnabled()) {
    for (const owner of await ownersOf(container)) if (await clerkUserAllowed(owner, now)) return true;
    return false;
  }
  const dep = await deploymentContainer(now);
  return dep.kind === 'container' && dep.container === container;
}

/**
 * The token an Authorization header carries, checked (see the header), or null
 * for every kind of failure alike. Storage failing, or a registry entry that
 * can't be read, throws: that says nothing about the token.
 */
export async function authenticate(header: string | null, now: number = Date.now()): Promise<Authenticated | null> {
  const parsed = parseToken(bearerToken(header));
  const container = parsed?.container ?? STAND_IN.container;
  const id = parsed?.id ?? STAND_IN.id;
  const presented = digest(parsed?.secret ?? STAND_IN.secret);
  const [registered, record] = await Promise.all([getContainer(container), recordOf({ container }, id)]);
  const matches = timingSafeEqual(record ? Buffer.from(record.hash, 'hex') : NO_HASH, presented);
  if (!parsed || registered?.status !== 'active' || !record || !matches) return null;
  if (!(await stillServes(container, now))) return null;
  return { ctx: { container }, id, token: record };
}

/** A token's count couldn't be read; it was cleared (see the header). */
export class RateCountUnreadableError extends Error {
  constructor() {
    super('The request limit could not be checked just now. Try again.');
    this.name = 'RateCountUnreadableError';
  }
}

/** Where a token stands against its limit, this request counted. */
export type Allowance = { ok: boolean; limit: number; remaining: number; resetSeconds: number };

/** Counts one request for the token and says whether it is within the limit.
 *  Throws RateCountUnreadableError for a count that can't be read (cleared),
 *  and whatever storage throws. */
export async function takeRequest(auth: Authenticated, now: number = Date.now()): Promise<Allowance> {
  let window: CounterWindow;
  try {
    window = await apiRequestCount.take(auth.ctx, auth.id, now);
  } catch (err) {
    if (!(err instanceof UnreadableEntriesError)) throw err;
    console.error('API token: a request count could not be read; it was cleared.');
    await apiRequestCount.remove(auth.ctx, auth.id).catch(() => {});
    throw new RateCountUnreadableError();
  }
  return {
    ok: window.count <= REQUESTS_PER_MINUTE,
    limit: REQUESTS_PER_MINUTE,
    remaining: Math.max(0, REQUESTS_PER_MINUTE - window.count),
    resetSeconds: window.secondsLeft,
  };
}

/**
 * Writes down that the token was just used, at most once every
 * LAST_USED_EVERY_MS, keeping the later of what is stored and now (another
 * instance's clock may be ahead). Never brings back a token revoked meanwhile,
 * and never throws: when it was last used is a convenience, and a request is
 * never failed for it.
 */
export async function noteUse(auth: Authenticated, now: number = Date.now()): Promise<void> {
  const last = auth.token.last_used_at === null ? NaN : Date.parse(auth.token.last_used_at);
  if (now - last >= 0 && now - last < LAST_USED_EVERY_MS) return;
  const at = new Date(now).toISOString();
  try {
    await apiTokenStore.update(auth.ctx, auth.id, (current) =>
      current ? { ...current, last_used_at: current.last_used_at !== null && Date.parse(current.last_used_at) > now ? current.last_used_at : at } : null
    );
  } catch (err) {
    console.error('API token: when it was last used could not be saved', err instanceof Error ? err.name : typeof err);
  }
}
