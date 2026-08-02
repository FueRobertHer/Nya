// lib/history.ts
//
// Net-worth history for the over-time chart, in two layers:
//
// 1. REAL snapshots (`history:net-worth`) -- recorded whenever a clean live
//    fetch happens (each upserts today's point) and daily by the snapshot
//    cron, so history accumulates going forward.
// 2. ESTIMATED backfill (`history:net-worth:est`) -- reconstructed once from
//    transaction history (see /api/backfill): cash and credit accounts are
//    walked backward from their current balances, everything else is held
//    flat. Real points always win over estimated ones for the same date.
//
// Both layers are Redis hashes keyed by UTC date (YYYY-MM-DD), values
// encrypted with the same AES-256-GCM key as everything else financial, so
// a database-only leak doesn't expose your net-worth series either.

import { redis, k } from './storage';
import { encrypt, decrypt } from './crypto';
import { signedContribution, type HiddenMap } from './hidden';

const HISTORY_HASH = k('history:net-worth');
const ESTIMATED_HASH = k('history:net-worth:est');
// Per-account balances, one JSON map { account_id: balance } per date, so
// individual accounts can be charted too.
const ACCOUNTS_HASH = k('history:accounts');
const ACCOUNTS_EST_HASH = k('history:accounts:est');
// The balances backfill folded into its flat `rest` term: everything that
// isn't depository/credit (investments, loans, property, manual accounts),
// captured as of the run that produced the estimated layer. One record, not
// one per date, because the amount is constant across every estimated point.
//
// This exists so a hidden account can be subtracted from estimated points by
// the amount actually baked into them. Using its *current* balance instead
// would be wrong by however much it moved since the last backfill (unbounded
// for a 401k or a mortgage), and catastrophically wrong for an account linked
// after that run, which was never in those points at all.
//
// Kept separate from ACCOUNTS_EST_HASH on purpose: merging it there would give
// investments a flat per-account estimated series, which backfill's header
// deliberately refuses to fabricate.
const ACCOUNTS_EST_FLAT = k('history:accounts:est:flat');
const BACKFILL_FLAG = k('history:backfill-done');

export type HistoryPoint = { date: string; value: number; estimated?: boolean };

/** Returns whether the snapshot actually landed. Callers that report success
 *  to a caller of their own (e.g. /api/ingest/balance telling a script the
 *  chart was updated) need to know; the rest can ignore it. */
export async function recordSnapshot(
  netWorth: number,
  accountBalances?: Record<string, number>
): Promise<boolean> {
  try {
    const today = new Date().toISOString().slice(0, 10);
    await redis().hset(HISTORY_HASH, { [today]: await encrypt(String(netWorth)) });
    if (accountBalances && Object.keys(accountBalances).length > 0) {
      await redis().hset(ACCOUNTS_HASH, { [today]: await encrypt(JSON.stringify(accountBalances)) });
    }
    return true;
  } catch {
    // Best-effort: a missed snapshot just leaves a gap in the chart.
    return false;
  }
}

/** Wholesale-replace the estimated layer (backfill recomputes it entirely). */
export async function replaceEstimated(points: { date: string; value: number }[]): Promise<void> {
  await redis().del(ESTIMATED_HASH);
  if (points.length === 0) return;
  const fields: Record<string, string> = {};
  for (const p of points) fields[p.date] = await encrypt(String(p.value));
  await redis().hset(ESTIMATED_HASH, fields);
}

/** Replaces the flat (non-cash) balances that backfill folded into `rest`. */
export async function replaceEstimatedFlat(balances: Record<string, number>): Promise<void> {
  await redis().set(ACCOUNTS_EST_FLAT, await encrypt(JSON.stringify(balances)));
}

/**
 * Whether the estimated layer can account for this id at all: either it has a
 * per-date balance (Plaid cash accounts, walked backward from transactions) or
 * a flat balance (everything else).
 *
 * Membership is checked directly rather than inferred from account type,
 * because type doesn't determine it. Backfill's cashType loop only iterates
 * *Plaid* accounts, so a MANUAL depository account -- which looks like cash by
 * type -- is actually in the flat term. Guessing from type left manual accounts
 * in neither map and silently un-subtracted from every estimated point.
 */
export async function estimatedLayerCovers(account_id: string): Promise<boolean> {
  if (account_id in ((await getEstimatedFlat()) ?? {})) return true;
  try {
    const map = await redis().hgetall<Record<string, string>>(ACCOUNTS_EST_HASH);
    // Any one date answers for all of them: backfill seeds `balances` with
    // every cash account before the walk and only ever updates values, so each
    // date's snapshot carries the identical key set. hgetall is unordered, so
    // this is an arbitrary date rather than the earliest, which is fine given
    // that invariant.
    const [sample] = Object.values(map ?? {});
    if (!sample) return false;
    return account_id in ((JSON.parse(await decrypt(sample)) as Record<string, number>) ?? {});
  } catch {
    return false; // unreadable: report not-covered, so the caller forces a recompute
  }
}

/**
 * The flat balances captured by the last backfill.
 *
 * `{}` and `null` mean different things and callers must not conflate them.
 * `{}` is "backfill ran and folded no non-cash accounts in", so subtracting
 * nothing is correct. `null` is "we can't read what was baked in", where
 * subtracting nothing would silently shift the whole estimated region by the
 * hidden balance.
 */
export async function getEstimatedFlat(): Promise<Record<string, number> | null> {
  try {
    const blob = await redis().get<string>(ACCOUNTS_EST_FLAT);
    if (!blob) return {}; // never written (layer predates this key) -- genuinely empty
    return JSON.parse(await decrypt(blob)) as Record<string, number>;
  } catch {
    return null; // unreadable: the caller must not treat this as "nothing to subtract"
  }
}

/** Same, for the per-account estimated layer. */
export async function replaceEstimatedAccounts(
  points: { date: string; balances: Record<string, number> }[]
): Promise<void> {
  await redis().del(ACCOUNTS_EST_HASH);
  if (points.length === 0) return;
  const fields: Record<string, string> = {};
  for (const p of points) fields[p.date] = await encrypt(JSON.stringify(p.balances));
  await redis().hset(ACCOUNTS_EST_HASH, fields);
}

export async function getRealSnapshotDates(): Promise<Set<string>> {
  try {
    return new Set(await redis().hkeys(HISTORY_HASH));
  } catch {
    return new Set();
  }
}

/** Balance history for one account, merged like getHistory (real wins). */
export async function getAccountHistory(account_id: string): Promise<HistoryPoint[]> {
  const [realMap, estMap] = await Promise.all([
    redis().hgetall<Record<string, string>>(ACCOUNTS_HASH),
    redis().hgetall<Record<string, string>>(ACCOUNTS_EST_HASH),
  ]);

  const entries: { date: string; blob: string; estimated: boolean }[] = [];
  for (const [date, blob] of Object.entries(realMap ?? {})) {
    entries.push({ date, blob, estimated: false });
  }
  for (const [date, blob] of Object.entries(estMap ?? {})) {
    if (!realMap?.[date]) entries.push({ date, blob, estimated: true });
  }

  const points = await Promise.all(
    entries.map(async ({ date, blob, estimated }): Promise<HistoryPoint | null> => {
      try {
        const balances = JSON.parse(await decrypt(blob)) as Record<string, number>;
        const value = balances[account_id];
        if (typeof value !== 'number' || !Number.isFinite(value)) return null;
        return { date, value, ...(estimated ? { estimated: true } : {}) };
      } catch {
        return null;
      }
    })
  );
  return points
    .filter((p): p is HistoryPoint => p !== null)
    .sort((a, b) => (a.date < b.date ? -1 : 1));
}

// The backfill flag makes /api/backfill idempotent; linking a new
// institution clears it so history gets recomputed with the new accounts.
export async function isBackfillDone(): Promise<boolean> {
  try {
    return !!(await redis().get(BACKFILL_FLAG));
  } catch {
    return false;
  }
}

export async function markBackfillDone(): Promise<void> {
  await redis().set(BACKFILL_FLAG, '1');
}

export async function clearBackfillDone(): Promise<void> {
  try {
    await redis().del(BACKFILL_FLAG);
  } catch {
    // Worst case the next backfill is skipped; harmless.
  }
}

/**
 * The net-worth series, with hidden accounts subtracted per date.
 *
 * Hiding is retroactive by construction: the stored totals always include every
 * account (see the store-true principle in lib/hidden.ts), and the per-account
 * balance map recorded alongside each date is what lets a hidden account's
 * contribution be removed from every point. Hiding a $40k 401k therefore
 * redraws the whole chart as if it was never counted, instead of putting a $40k
 * cliff on the day you hid it -- which would be permanent, since nothing ever
 * rewrites a real point for a past date.
 *
 * Subtraction never consults a live balance, so it keeps working while an
 * institution is erroring (which is exactly when `computeNetWorth` returns no
 * accounts for it).
 */
export async function getHistory(hidden?: HiddenMap): Promise<HistoryPoint[]> {
  const hiding = !!hidden && hidden.size > 0;

  // The per-account maps are only read when something is actually hidden.
  // Decrypting a year of them on every dashboard load to subtract nothing would
  // be pure waste, and nothing hidden is the common case.
  const [realMap, estMap, realAccounts, estAccounts, estFlat] = await Promise.all([
    redis().hgetall<Record<string, string>>(HISTORY_HASH),
    redis().hgetall<Record<string, string>>(ESTIMATED_HASH),
    hiding ? redis().hgetall<Record<string, string>>(ACCOUNTS_HASH) : null,
    hiding ? redis().hgetall<Record<string, string>>(ACCOUNTS_EST_HASH) : null,
    hiding ? getEstimatedFlat() : null,
  ]);

  const entries: { date: string; blob: string; estimated: boolean }[] = [];
  for (const [date, blob] of Object.entries(realMap ?? {})) {
    entries.push({ date, blob, estimated: false });
  }
  for (const [date, blob] of Object.entries(estMap ?? {})) {
    if (!realMap?.[date]) entries.push({ date, blob, estimated: true });
  }

  /** Per-date balances for a layer, or null when that date has no map at all. */
  async function balancesFor(
    source: Record<string, string> | null,
    date: string
  ): Promise<Record<string, number> | null> {
    const blob = source?.[date];
    if (!blob) return null;
    try {
      return JSON.parse(await decrypt(blob)) as Record<string, number>;
    } catch {
      return null;
    }
  }

  const points = await Promise.all(
    entries.map(async ({ date, blob, estimated }): Promise<HistoryPoint | null> => {
      let value: number;
      try {
        value = Number(await decrypt(blob));
      } catch {
        return null; // undecryptable point (rotated key) -- drop it
      }
      if (!Number.isFinite(value)) return null;

      if (hiding) {
        const balances = await balancesFor(estimated ? estAccounts : realAccounts, date);

        if (!estimated) {
          // A real date with no per-account map can't be corrected. This is
          // reachable: recordSnapshot writes the total and the map as two
          // separate awaits, so the first can land and the second fail. Showing
          // the point would put a single-day spike the size of the hidden
          // account into the chart, so drop it instead and let the line
          // interpolate across one day.
          if (!balances) return null;
          for (const [id, { type }] of hidden!) {
            const b = balances[id];
            if (typeof b === 'number') value -= signedContribution(type, b);
          }
        } else {
          // The estimated layer splits every account across two sources, and
          // exactly one of them applies: cash accounts have a per-date balance
          // (the transaction walk), everything else has a constant flat balance
          // (backfill's `rest` term). So a miss in one is only correct if the
          // other is readable and genuinely doesn't list the account.
          //
          // `estFlat === null` means the flat record itself is unreadable, so
          // nothing here can be trusted.
          if (estFlat === null) return null;
          for (const [id, { type }] of hidden!) {
            const flatBalance = estFlat[id];
            if (typeof flatBalance === 'number') {
              value -= signedContribution(type, flatBalance);
              continue;
            }
            // Not in the flat record, so if it's in the estimated layer at all
            // it's a cash account with a per-date balance. A missing per-date
            // map means we can't tell whether it was in this point, and
            // subtracting nothing would leave a spike the size of the account.
            // Drop the point instead, matching the real branch above.
            if (!balances) return null;
            const b = balances[id];
            // Present and absent are both meaningful here: absent from a map we
            // could read means the account was never in these points (linked
            // after the last backfill), so there is nothing to remove.
            if (typeof b === 'number') value -= signedContribution(type, b);
          }
        }
      }

      return { date, value, ...(estimated ? { estimated: true } : {}) };
    })
  );
  return points
    .filter((p): p is HistoryPoint => p !== null)
    .sort((a, b) => (a.date < b.date ? -1 : 1));
}
