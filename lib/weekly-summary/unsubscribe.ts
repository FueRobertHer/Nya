// lib/weekly-summary/unsubscribe.ts
//
// The link in each weekly summary that turns it off in one click, without
// signing in (app/unsubscribe, app/api/weekly-summary/unsubscribe).
//
// A TOKEN is "<container>.<expires>.<mac>":
//   - container: the opaque id of the container the summary is about. A
//     request without a session finds its container from the token itself,
//     as an API token does (lib/api-tokens.ts), so nothing environment-wide is
//     needed to look one up (the seam keeps containers only, lib/repo.ts);
//   - expires: the UTC day it stops working (YYYYMMDD), LINK_DAYS after the
//     email was made, so a link in an old email, or one forwarded, doesn't
//     work for ever;
//   - mac: HMAC-SHA256, base64url, of what the link is for, the container and
//     the day, under a key kept in that container (lib/weekly-summary/
//     store.ts weekly-summary-state): 32 random bytes made when the summary
//     is turned on, and made anew whenever it is turned on after being off.
// SINGLE PURPOSE: it can turn off that container's weekly summary and nothing
// else, and only the summary, never any other email. The key signs nothing
// else, and what it signs names the purpose.
//
// CHECKING ONE (checkLink). Something not in a token's form is refused at once,
// reading nothing. One in the right form that doesn't work is refused the same
// way whatever the reason (a container that doesn't exist, one without a
// summary, a forged or altered mac, an expired day, records that can't be
// read), after the same work: the container's registry entry and its key are
// read at once, and a mac is computed and compared in constant time, under a
// key that is never right when there is none. So neither the answer nor its
// timing tells which containers exist or have a summary. Only once the mac
// checks out is the container's state told: being restored or archived is
// `unavailable` (try again later), and only to the holder of a real link.
//
// RATE LIMITED, twice: a link that doesn't work is counted against the
// address it came from, with the API's tokens that don't work
// (lib/rate-limit.ts), which turns the address away for a while after a
// flood; and a link that works, per container (unsubscribeCount), so a good
// one can't be hammered either.
//
// The link is never acted on by opening it: mail apps and the security
// scanners in front of them open links on their own. A browser opening it gets
// a page with a button (app/unsubscribe), and a mail app that offers
// one-click unsubscribe POSTs to it, as RFC 8058 says (List-Unsubscribe-Post).

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { getContainer, isContainerId, type ContainerId, type Ctx } from '../containers';
import { StoredDataUnreadableError } from '../repo';
import { weeklySettingStore, weeklyStateStore, unsubscribeCount, UNSUBSCRIBES_PER_HOUR, type WeeklyState } from './store';

/** How long a link works after its email was made. */
export const LINK_DAYS = 90;

/** What the mac covers besides the container and the day: the one thing a
 *  link may do. */
const PURPOSE = 'nya-weekly-summary-off-v1';

const TOKEN = /^([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.(\d{8})\.([A-Za-z0-9_-]{43})$/;
/** "<container>.<YYYYMMDD>.<43 characters>". */
export const TOKEN_LENGTH = 36 + 1 + 8 + 1 + 43;

/** A fresh key: 32 random bytes, base64url. */
export function newLinkKey(): string {
  return randomBytes(32).toString('base64url');
}

/** Never anyone's key: what a link is checked against when there is none, so
 *  the work is the same (see the header). */
const NO_KEY = Buffer.alloc(32);

function macOf(key: Buffer, container: string, expires: string): Buffer {
  return createHmac('sha256', key).update(`${PURPOSE}:${container}:${expires}`).digest();
}

/** "2027-01-09" from "20270109". */
const dayOf = (compact: string) => `${compact.slice(0, 4)}-${compact.slice(4, 6)}-${compact.slice(6, 8)}`;

/** The token for a link, signed with `key`, working through the UTC day `expires` (YYYY-MM-DD). */
export function linkToken(container: ContainerId, key: string, expires: string): string {
  const compact = expires.replaceAll('-', '');
  return `${container}.${compact}.${macOf(Buffer.from(key, 'base64url'), container, compact).toString('base64url')}`;
}

/** The day a link made at `now` works through. */
export function linkExpiry(now: number): string {
  return new Date(now + LINK_DAYS * 86_400_000).toISOString().slice(0, 10);
}

/** A token's parts, or null for anything that is not one. */
export function parseLinkToken(raw: unknown): { container: ContainerId; expires: string; mac: Buffer } | null {
  if (typeof raw !== 'string' || raw.length !== TOKEN_LENGTH) return null;
  const m = TOKEN.exec(raw);
  if (!m || !isContainerId(m[1])) return null;
  const expires = dayOf(m[2]);
  if (Number.isNaN(Date.parse(`${expires}T00:00:00Z`)) || new Date(`${expires}T00:00:00Z`).toISOString().slice(0, 10) !== expires) return null;
  const mac = Buffer.from(m[3], 'base64url');
  return mac.length === 32 ? { container: m[1], expires: m[2], mac } : null;
}

/** The address in an email's text: the page that asks before it turns the
 *  summary off. */
export function pageUrl(link: string, token: string): string {
  return `${link}/unsubscribe?t=${token}`;
}

/** The address a mail app posts to for one-click unsubscribe (RFC 8058). */
export function oneClickUrl(link: string, token: string): string {
  return `${link}/api/weekly-summary/unsubscribe?t=${token}`;
}

/** What checking a link came to (see the header). */
export type LinkCheck = { kind: 'ok'; ctx: Ctx } | { kind: 'malformed' } | { kind: 'refused' } | { kind: 'unavailable' };

/** The key a container's links are signed with, or null: none, or records
 *  that can't be read, which can't be checked and so don't work. */
async function keyOf(ctx: Ctx): Promise<WeeklyState['key'] | null> {
  try {
    return (await weeklyStateStore.get(ctx))?.key ?? null;
  } catch (err) {
    if (!(err instanceof StoredDataUnreadableError)) throw err;
    console.error('Weekly summary: a link was refused, as the records its key is kept in could not be read.');
    return null;
  }
}

/**
 * Checks a link's token (see CHECKING ONE). `now` decides whether it has
 * expired, by UTC day. Storage failing, or a registry entry that can't be
 * read, throws: that says nothing about the link.
 */
export async function checkLink(raw: unknown, now: number = Date.now()): Promise<LinkCheck> {
  const parsed = parseLinkToken(raw);
  if (!parsed) return { kind: 'malformed' };
  const ctx: Ctx = { container: parsed.container };
  const [registered, key] = await Promise.all([getContainer(parsed.container), keyOf(ctx)]);
  const expected = macOf(key ? Buffer.from(key, 'base64url') : NO_KEY, parsed.container, parsed.expires);
  const matches = timingSafeEqual(expected, parsed.mac);
  const today = new Date(now).toISOString().slice(0, 10).replaceAll('-', '');
  if (!key || !matches || parsed.expires < today) return { kind: 'refused' };
  if (registered?.status !== 'active') return { kind: 'unavailable' };
  return { kind: 'ok', ctx };
}

/** A link that checked out, counted against its container's limit: false
 *  when it is over. Throws if the count can't be taken. */
export async function takeUnsubscribe(ctx: Ctx): Promise<{ ok: boolean; retryAfterSeconds: number }> {
  const { count, secondsLeft } = await unsubscribeCount.take(ctx);
  return { ok: count <= UNSUBSCRIBES_PER_HOUR, retryAfterSeconds: secondsLeft };
}

/**
 * Turns the container's weekly summary off, whatever it was: already off, or
 * never set, is left as it is, so the answer is the same and tells nothing.
 * Only over a setting it could read (lib/repo.ts update): one that can't be
 * read throws StoredDataUnreadableError, and is left exactly as it is.
 */
export async function turnOff(ctx: Ctx, now: number = Date.now()): Promise<void> {
  await weeklySettingStore.update(ctx, (current) => (current && current.enabled ? { ...current, enabled: false, updated_at: new Date(now).toISOString() } : current));
}
