// lib/rate-limit.ts
//
// Counters in Redis that turn a request away once it has been made too often.
// Each is a fixed window that starts with its first count and expires with it.
// Two of them:
//
//   - WRONG PASSWORDS, per IP, environment-wide: the login (app/api/login) and
//     the password asked for again before a download of my data
//     (app/api/my-data) share one counter, so a stolen session cookie can't
//     use the download to guess the password faster than the login allows. It
//     runs before anyone, or any container, is known, so it can't live in
//     one. Fails open if Redis is unreachable, as the login always has: being
//     able to sign in beats a rate limit.
//   - DOWNLOADS OF MY DATA, per container (app/api/my-data). Each one decrypts
//     everything the person has, so a script holding a fresh sign-in can't
//     pull it in a loop. Fails closed: a download is never urgent, and a limit
//     that can't be read is no reason to decrypt everything again.

import { redis, kc, kEnv } from './storage';
import type { Ctx } from './containers';
import { DOWNLOADS_PER_WINDOW, DOWNLOAD_WINDOW_SECONDS } from './download-limit';

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

// ---- Downloads of my data ----

// The numbers live where the page can read them too (lib/download-limit.ts).
export { DOWNLOADS_PER_WINDOW, DOWNLOAD_WINDOW_SECONDS };

const downloadsKey = (ctx: Ctx) => kc(ctx, 'ratelimit:downloads');

export type DownloadAllowance = { ok: true } | { ok: false; retryAfterSeconds: number };

/** Seconds until a window ends, from a TTL reply: what is left (at least a
 *  second: 0 means under one), or the whole window when the counter has no
 *  expiry (-1, given one when next counted) or is gone (-2). */
const secondsLeft = (ttl: unknown) => (Number(ttl) >= 0 ? Math.max(1, Number(ttl)) : DOWNLOAD_WINDOW_SECONDS);

/**
 * Whether another download fits in this window, without counting one. Asked
 * before the fresh sign-in, so a request that is turned away for its limit
 * doesn't put the person through a sign-in for nothing. Throws if the counter
 * can't be read.
 */
export async function downloadAllowed(ctx: Ctx): Promise<DownloadAllowance> {
  const key = downloadsKey(ctx);
  const [count, ttl] = (await redis().pipeline().get(key).ttl(key).exec()) as [unknown, unknown];
  if (Number(count ?? 0) < DOWNLOADS_PER_WINDOW) return { ok: true };
  return { ok: false, retryAfterSeconds: secondsLeft(ttl) };
}

/**
 * Counts one download and says whether it is within the limit: the count is
 * what decides, so two requests racing past downloadAllowed can't both get
 * the last one. Counted only once the fresh sign-in has passed. Throws if the
 * counter can't be written.
 *
 * The expiry is set whenever the counter has none, not only on the first
 * count: a first count whose expiry was lost (the request ended between the
 * two) would otherwise never expire, and turn every download away for good.
 */
export async function takeDownload(ctx: Ctx): Promise<DownloadAllowance> {
  const key = downloadsKey(ctx);
  const [count, ttl] = (await redis().pipeline().incr(key).ttl(key).exec()) as [unknown, unknown];
  // Only a counter with no expiry at all (-1). A TTL of 0 is under a second
  // left: that window is ending, and must not be given a fresh hour.
  if (Number(ttl) < 0) await redis().expire(key, DOWNLOAD_WINDOW_SECONDS);
  if (Number(count) <= DOWNLOADS_PER_WINDOW) return { ok: true };
  return { ok: false, retryAfterSeconds: secondsLeft(ttl) };
}
