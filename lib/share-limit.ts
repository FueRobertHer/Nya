// lib/share-limit.ts
//
// How often one person's app may ask for what is shared with them
// (app/api/shared) and for "What they see" of their own share
// (app/api/connections/preview), the two together: every answer is worked
// out from the sharer's own data as it is read (each kind of share a read of
// what it is built on, lib/share-views.ts), and every answer of the first
// is counted in the sharer's record of showings, a write to their container.
// SHARED_READS_PER_WINDOW in a window (lib/share-rules.ts, where the drawer
// can read it too), far more than opening the Accounts tab and the drawer by
// hand takes, so only a loop is turned away.
//
// A count per container, the asker's, on the storage seam
// (lib/repo.ts defineCounterStore), as the downloads of my data are counted
// (lib/rate-limit.ts): the window starts with its first read and ends on its
// own. Fails closed: a count that can't be taken turns the read away (503),
// as an import's does, until it can.

import { defineCounterStore } from './repo';
import type { Ctx } from './containers';
import { SHARED_READS_PER_WINDOW, SHARED_READS_WINDOW_SECONDS } from './share-rules';

export const sharedReadCount = defineCounterStore('sharing-reads', {
  what: 'counts of reads of what is shared',
  windowSeconds: SHARED_READS_WINDOW_SECONDS,
});

export type SharedReadAllowance = { ok: true } | { ok: false; retryAfterSeconds: number };

/** Counts one read and says whether it is within the limit. Throws if the
 *  count can't be taken. */
export async function takeSharedRead(ctx: Ctx): Promise<SharedReadAllowance> {
  const { count, secondsLeft } = await sharedReadCount.take(ctx);
  return count <= SHARED_READS_PER_WINDOW ? { ok: true } : { ok: false, retryAfterSeconds: secondsLeft };
}

/** How a route turns a read away: past the limit, 429 with when to come
 *  back; a count that can't be taken, 503. */
export type SharedReadRefusal = { status: 429 | 503; body: { error: string; retry_after_seconds?: number }; headers?: Record<string, string> };

/** Counts one read for the asker's container (see the header), and the
 *  answer that turns it away, or null when it is within the limit. Never
 *  throws. */
export async function sharedReadRefusal(ctx: Ctx): Promise<SharedReadRefusal | null> {
  try {
    const allowed = await takeSharedRead(ctx);
    if (allowed.ok) return null;
    const seconds = allowed.retryAfterSeconds;
    const minutes = Math.max(1, Math.ceil(seconds / 60));
    return {
      status: 429,
      body: {
        error: `What is shared can be read ${SHARED_READS_PER_WINDOW} times in ${SHARED_READS_WINDOW_SECONDS / 60} minutes. Try again in ${minutes === 1 ? 'a minute' : `${minutes} minutes`}.`,
        retry_after_seconds: seconds,
      },
      headers: { 'Retry-After': String(seconds) },
    };
  } catch (err) {
    console.error('Sharing: the limit on reads could not be checked', err instanceof Error ? err.name : err);
    return { status: 503, body: { error: 'The limit on reading what is shared couldn’t be checked just now, so nothing was read. Try again in a minute.' } };
  }
}
