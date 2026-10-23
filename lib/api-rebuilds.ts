// lib/api-rebuilds.ts
//
// When a balance set through the API has the estimated history rebuilt. The
// app's own Update form clears the backfill flag every time a balance moves
// (lib/manual-account-writes.ts setAccountBalance), so the app's next visit
// rebuilds the estimate. A script can push a balance every few minutes, and
// a rebuild pulls Plaid's transactions again, so a push clears it only the
// first time in a day's window for each account (`balance.<account id>` in
// api-write-days, lib/api-token-store.ts).
//
// A PUSH THAT SKIPPED IT IS REMEMBERED. The estimate holds a manual account
// flat at its balance across the days before any was recorded, so a skipped
// push leaves that whole flat term on an older balance. Each skip leaves a
// mark (`rebuild.<account id>`, in the same store), its day's window started
// again by every skip, so it lasts a day past the last one. The nightly
// snapshot (lib/snapshot-job.ts), which runs every day, clears the flag for
// any mark it finds and removes the marks; the next window's first push
// rebuilds anyway, and removes its account's. Either way the estimate is
// never more than a day behind the balance.

import type { Ctx } from './containers';
import { apiWriteDays } from './api-token-store';
import { manualAccountIds } from './manual';
import { clearBackfillDone } from './history';
import { UnreadableEntriesError } from './repo';

const mark = (accountId: string) => `rebuild.${accountId}`;

/**
 * Whether this push of an account's balance clears the backfill flag: the
 * first in its day's window, which takes the account's mark too. A later one
 * leaves its mark instead. One that can't be counted, or marked, rebuilds.
 */
export async function rebuildForPush(ctx: Ctx, accountId: string, now: number = Date.now()): Promise<boolean> {
  try {
    if ((await apiWriteDays.take(ctx, `balance.${accountId}`, now)).count === 1) {
      await apiWriteDays.remove(ctx, mark(accountId)).catch(() => {});
      return true;
    }
    // Started again, so the mark lasts a day past this push.
    await apiWriteDays.remove(ctx, mark(accountId));
    await apiWriteDays.take(ctx, mark(accountId), now);
    return false;
  } catch {
    return true;
  }
}

/**
 * The nightly catch-up: the backfill flag cleared when a push skipped its
 * rebuild in the last day, and the marks removed. A mark that can't be read
 * clears it too, and goes. Never throws: a failure is logged, and the marks
 * stay for the next night.
 */
export async function catchUpRebuilds(ctx: Ctx, now: number = Date.now()): Promise<void> {
  try {
    const ids = (await manualAccountIds(ctx)).map(mark);
    if (ids.length === 0) return;
    let marked: string[];
    try {
      marked = (await apiWriteDays.peek(ctx, ids, now)).flatMap((w, i) => (w.count > 0 ? [ids[i]] : []));
    } catch (err) {
      if (!(err instanceof UnreadableEntriesError)) throw err;
      marked = err.unreadable;
    }
    if (marked.length === 0) return;
    // Cleared first, so a clear that fails keeps the marks for the next
    // night. A push marking in the moment between the two loses its mark
    // only if it also wrote its balance after the clear and the estimate was
    // rebuilt in that same moment.
    await clearBackfillDone(ctx, { strict: true });
    await apiWriteDays.remove(ctx, ...marked);
  } catch (err) {
    console.error('API: a skipped rebuild of the estimate could not be caught up', err instanceof Error ? err.name : typeof err);
  }
}
