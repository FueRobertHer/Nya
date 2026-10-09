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
//     login's own Redis counter, moved here unchanged from app/api/login so
//     both routes share it. Fails open if Redis is unreachable, as the login
//     always has: being able to sign in beats a rate limit.
//   - API TOKENS THAT DON'T WORK, per IP, environment-wide (lib/api-http.ts):
//     a request to the read-only API or the MCP server whose token is in the
//     right form but doesn't check out costs reads, so an address that sends
//     too many is turned away before any is made, and a flood of made-up
//     tokens can't become a flood of database reads. Like the wrong
//     passwords, it runs before any container is known, so it is the same
//     kind of environment-wide counter (ratelimit:api:<ip>), never backed up.
//     A token not even in the right form costs nothing and isn't counted.
//     Fails open, as the login's does: a limit that can't be read is no
//     reason to refuse a good token.
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
    const failures = await redis().get<number>(loginKey(req));
    return failures !== null && Number(failures) >= LOGIN_MAX_FAILURES;
  } catch {
    // Redis unavailable: skip the limiter rather than lock the user out.
    return false;
  }
}

/** Counts one wrong password. Best effort. */
export async function countWrongPassword(req: Request): Promise<void> {
  const key = loginKey(req);
  try {
    const failures = await redis().incr(key);
    if (failures === 1) await redis().expire(key, LOGIN_WINDOW_SECONDS);
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

/** Whether this IP has sent too many tokens that don't work, for now. False
 *  when the counter can't be read (fails open, see the header). */
export async function tokenFailuresExhausted(req: Request): Promise<boolean> {
  try {
    const failures = await redis().get<number>(apiFailureKey(req));
    return failures !== null && Number(failures) >= API_AUTH_MAX_FAILURES;
  } catch {
    return false;
  }
}

/** Counts one token that didn't work. Best effort. */
export async function countTokenFailure(req: Request): Promise<void> {
  const key = apiFailureKey(req);
  try {
    const failures = await redis().incr(key);
    if (failures === 1) await redis().expire(key, API_AUTH_WINDOW_SECONDS);
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
