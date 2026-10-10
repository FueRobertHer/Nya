// lib/rate-limit.ts
//
// Counters that turn a request away once it has been made too often. Each is
// a fixed window that starts with its first count and expires with it. Three
// of them:
//
//   - WRONG PASSWORDS, per IP, environment-wide: the login (app/api/login) and
//     the password asked for again before a download of my data
//     (app/api/my-data) share one counter, so a stolen session cookie can't
//     use the download to guess the password faster than the login allows. It
//     runs before anyone, or any container, is known, so it can't live in
//     one, and the storage seam (lib/repo.ts) keeps containers only: it is the
//     login's own Redis counter, moved here from app/api/login so both routes
//     share it, and counted with its expiry in one step (COUNT_IN_WINDOW).
//     Fails open if Redis is unreachable, as the login always has: being able
//     to sign in beats a rate limit.
//   - API TOKENS THAT DON'T WORK, per IP, environment-wide (lib/api-http.ts):
//     a request to the read-only API or the MCP server whose token is in the
//     right form but doesn't check out costs two reads, so an address that
//     sends a flood of them (API_AUTH_MAX_FAILURES in lib/api-limits.ts, set
//     well above anything a misconfigured client or a shared address sends)
//     is turned away for the rest of the window at the cost of one read each,
//     the count's. Every request with a token in the right form, good ones
//     too, reads the count first: one read more. Like the wrong passwords, it
//     runs before any container is known, so it is the same kind of
//     environment-wide counter (ratelimit:api:<ip>), counted and read with
//     its expiry in one step as the wrong passwords are (COUNT_IN_WINDOW,
//     READ_IN_WINDOW), and never backed up. A token
//     not even in the right form costs nothing and isn't counted. Fails open,
//     as the login's does: a limit that can't be read is no reason to refuse
//     a good token.
//
// BY ADDRESS, from X-Forwarded-For's first entry. On Vercel the platform sets
// that header, so the first entry is the client's address. Anywhere else, run
// Nya only behind a proxy that sets the header itself, overwriting what the
// client sent: one that appends to it lets a client choose its address, to
// slip a limit or aim it at someone else's, and with no header at all every
// client shares one count ("unknown").
//   - DOWNLOADS OF MY DATA, per container (app/api/my-data), a counter store on
//     the storage seam (downloadCount). Each download decrypts everything the
//     person has, so a script holding a fresh sign-in can't pull it in a
//     loop. Fails closed: a download is never urgent, and a limit that can't
//     be read is no reason to decrypt everything again.

import { redis, kEnv } from './storage';
import { defineCounterStore } from './repo';
import type { Ctx } from './containers';
import { DOWNLOADS_PER_WINDOW, DOWNLOAD_WINDOW_SECONDS } from './download-limit';
import { API_AUTH_MAX_FAILURES, API_AUTH_WINDOW_SECONDS } from './api-limits';

// ---- Counting by address ----

/**
 * Counts one in an address's window and answers the count, in one step: INCR,
 * then the window (ARGV[1] seconds) as the count's expiry whenever it has
 * none, which a first count never has. Sent as INCR and then EXPIRE, a request
 * that died between the two left a count that never ended, and its address
 * locked out until someone deleted the key; one script can't stop part way. A
 * TTL of 0 is under a second left: that window is still running, and keeps its
 * end. The first line names the script for the test double. Also the demo
 * sign-in's (app/api/demo/sign-in).
 */
export const COUNT_IN_WINDOW = `-- nya:ratelimit-count
local n = redis.call('INCR', KEYS[1])
if redis.call('TTL', KEYS[1]) < 0 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end
return n`;

/**
 * An address's count as it stands (as stored, for the client to parse), or 0
 * with none, by the same rule: a count found without an expiry (left by the
 * code before COUNT_IN_WINDOW, or written by hand) is given a whole window, so
 * an address already locked out for good is let in again when it ends. The
 * only write a read makes, and it only ever ends a window.
 */
export const READ_IN_WINDOW = `-- nya:ratelimit-read
local n = redis.call('GET', KEYS[1])
if not n then return 0 end
if redis.call('TTL', KEYS[1]) == -1 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end
return n`;

// ---- Wrong passwords ----

export const LOGIN_MAX_FAILURES = 10;
export const LOGIN_WINDOW_SECONDS = 15 * 60;

function loginKey(req: Request): string {
  // Vercel sets x-forwarded-for; first hop is the client.
  const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown';
  // Environment-wide: it runs before anyone, or any container, is known.
  return kEnv(`ratelimit:login:${ip}`);
}

/** Whether this IP has used up its wrong passwords for now. False when the
 *  counter can't be read (fails open, see the header). */
export async function passwordAttemptsExhausted(req: Request): Promise<boolean> {
  try {
    const failures = await redis().eval(READ_IN_WINDOW, [loginKey(req)], [String(LOGIN_WINDOW_SECONDS)]);
    return Number(failures) >= LOGIN_MAX_FAILURES;
  } catch {
    // Redis unavailable: skip the limiter rather than lock the user out.
    return false;
  }
}

/** Counts one wrong password, with its window's end. Best effort. */
export async function countWrongPassword(req: Request): Promise<void> {
  try {
    await redis().eval(COUNT_IN_WINDOW, [loginKey(req)], [String(LOGIN_WINDOW_SECONDS)]);
  } catch {
    // Best-effort counter.
  }
}

/** A clean slate after the right password. Best effort: the counter expires
 *  on its own. */
export async function clearWrongPasswords(req: Request): Promise<void> {
  try {
    await redis().del(loginKey(req));
  } catch {
    // Counter just expires on its own.
  }
}

// ---- API tokens that don't work ----

// The numbers live where the developer page can read them too (lib/api-limits.ts).
export { API_AUTH_MAX_FAILURES, API_AUTH_WINDOW_SECONDS };

function apiFailureKey(req: Request): string {
  const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown';
  // Environment-wide: it runs before any container is known.
  return kEnv(`ratelimit:api:${ip}`);
}

/** Whether this IP has sent too many tokens that don't work, for now, read
 *  with its window's end (READ_IN_WINDOW: a count found without one is given
 *  one). False when the counter can't be read (fails open, see the header). */
export async function tokenFailuresExhausted(req: Request): Promise<boolean> {
  try {
    const failures = await redis().eval(READ_IN_WINDOW, [apiFailureKey(req)], [String(API_AUTH_WINDOW_SECONDS)]);
    return Number(failures) >= API_AUTH_MAX_FAILURES;
  } catch {
    return false;
  }
}

/** Counts one token that didn't work, with its window's end, in one step
 *  (COUNT_IN_WINDOW): a count can never be left without one. Best effort. */
export async function countTokenFailure(req: Request): Promise<void> {
  try {
    await redis().eval(COUNT_IN_WINDOW, [apiFailureKey(req)], [String(API_AUTH_WINDOW_SECONDS)]);
  } catch {
    // Best-effort counter.
  }
}

// ---- Downloads of my data ----

// The numbers live where the page can read them too (lib/download-limit.ts).
export { DOWNLOADS_PER_WINDOW, DOWNLOAD_WINDOW_SECONDS };

/** Each container's downloads of my data in the current window. Inside the
 *  container, so deleting the account deletes it; left out of the download
 *  itself, as the service's bookkeeping. The window starts with the first
 *  download and ends on its own (the seam counts and sets the expiry in one
 *  step, so a count can't be left without one). */
export const downloadCount = defineCounterStore('download-count', {
  what: 'download counts',
  windowSeconds: DOWNLOAD_WINDOW_SECONDS,
});

export type DownloadAllowance = { ok: true } | { ok: false; retryAfterSeconds: number };

/**
 * Whether another download fits in this window, without counting one. Asked
 * before the fresh sign-in, so a request that is turned away for its limit
 * doesn't put the person through a sign-in for nothing. Throws if the count
 * can't be read.
 */
export async function downloadAllowed(ctx: Ctx): Promise<DownloadAllowance> {
  const { count, secondsLeft } = await downloadCount.read(ctx);
  if (count < DOWNLOADS_PER_WINDOW) return { ok: true };
  return { ok: false, retryAfterSeconds: secondsLeft };
}

/**
 * Counts one download and says whether it is within the limit: the count is
 * what decides, so two requests racing past downloadAllowed can't both get
 * the last one. Counted only once the fresh sign-in has passed. Throws if the
 * count can't be taken.
 */
export async function takeDownload(ctx: Ctx): Promise<DownloadAllowance> {
  const { count, secondsLeft } = await downloadCount.take(ctx);
  if (count <= DOWNLOADS_PER_WINDOW) return { ok: true };
  return { ok: false, retryAfterSeconds: secondsLeft };
}
