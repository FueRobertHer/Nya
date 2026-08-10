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
import { type HiddenMap } from './hidden';
import { signedContribution } from './balance';

const HISTORY_HASH = k('history:net-worth');
const ESTIMATED_HASH = k('history:net-worth:est');
// Per-account balances, one JSON map { account_id: balance } per date, so
// individual accounts can be charted too.
const ACCOUNTS_HASH = k('history:accounts');
const ACCOUNTS_EST_HASH = k('history:accounts:est');
// The balances backfill folded into its flat `rest` term: everything that
// isn't depository/credit (investments, loans, property, manual accounts),
// captured as of the run that produced the estimated layer.
//
// Keyed BY DATE, one map per estimated point. It used to be a single record,
// on the reasoning that the amount is constant across every estimated point --
// true while backfill rewrote the whole layer every run, false now that points
// outside a run's window are retained. Two runs can leave two eras of points in
// the layer, and one record can't describe both: a mortgage flat at $310k in
// run 1 and $302k in run 2 would subtract $302k from points that baked in
// $310k. Worse, an account that moves between the flat term and the walk
// between runs (which investments now do) would sit in both sources at once,
// breaking the exactly-one-applies rule getHistory depends on.
//

// This exists so a hidden account can be subtracted from estimated points by
// the amount actually baked into them. Using its *current* balance instead
// would be wrong by however much it moved since the last backfill (unbounded
// for a 401k or a mortgage), and catastrophically wrong for an account linked
// after that run, which was never in those points at all.
//
// Kept separate from ACCOUNTS_EST_HASH on purpose: merging it there would give
// every flat-held account a fake per-account estimated series, which backfill's
// header deliberately refuses to fabricate.
//
// Which accounts land here is not a property of their type -- investment
// accounts are walked day by day when their transactions are available and flat
// when they aren't, so the same account can move between the two layers between
// runs. That's why membership is always checked directly (see
// estimatedLayerCovers) rather than inferred from account type.
const ACCOUNTS_EST_FLAT_BY_DATE = k('history:accounts:est:flatd');
// The pre-per-date single record. Still read, never written: it's the only
// thing that can describe estimated points written before this key existed.
// A different key name rather than a reshape, because the old one is a plain
// string and the new one a hash -- Redis would reject the write.
const ACCOUNTS_EST_FLAT_LEGACY = k('history:accounts:est:flat');
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

/**
 * Replace the estimated layer over the range the new run actually covers,
 * leaving anything older intact.
 *
 * This used to delete the whole hash. That was safe when backfill ran once per
 * install, but it silently truncated the chart for anyone who had been running
 * long enough to accumulate estimated points older than the walk's 365-day
 * reach: a recompute regenerates [today-365, today] and the older region, which
 * no transaction stream can reconstruct any more, was simply lost. The left
 * edge of the chart jumped forward by up to a year.
 *
 * Scoping the delete to the new window keeps the recompute authoritative where
 * it has data and non-destructive where it doesn't. Points outside the window
 * are orphans from an earlier run: still the best answer available for those
 * dates, since nothing can rebuild them.
 */
async function replaceRange(
  key: string,
  points: { date: string }[],
  encode: (p: any) => Promise<string>
): Promise<void> {
  const oldest = points.reduce<string | null>((min, p) => (!min || p.date < min ? p.date : min), null);
  try {
    const existing = await redis().hkeys(key);
    // No new points means nothing was reconstructable this run -- keep every
    // stored point rather than blanking the layer.
    const doomed = oldest ? existing.filter((d) => d >= oldest) : [];
    if (doomed.length > 0) await redis().hdel(key, ...doomed);
  } catch {
    // Couldn't enumerate: fall through and just write. Stale dates inside the
    // window get overwritten by the hset below anyway; the only loss is that a
    // date the new run no longer produces keeps its old value.
  }
  if (points.length === 0) return;
  const fields: Record<string, string> = {};
  for (const p of points) fields[p.date] = await encode(p);
  await redis().hset(key, fields);
}

export async function replaceEstimated(points: { date: string; value: number }[]): Promise<void> {
  await replaceRange(ESTIMATED_HASH, points, (p) => encrypt(String(p.value)));
}

/**
 * Replaces the flat (non-cash) balances backfill folded into `rest`, one map
 * per date and range-scoped like the layers it describes.
 *
 * Per-date because a run only speaks for the dates it wrote. Retained points
 * from an earlier run keep that run's flat balances, so each point is
 * subtracted by the amount actually baked into it, and an account that moved
 * between the flat term and the walk between runs is in exactly one source for
 * any given date.
 */
export async function replaceEstimatedFlat(
  points: { date: string; balances: Record<string, number> }[]
): Promise<void> {
  await replaceRange(ACCOUNTS_EST_FLAT_BY_DATE, points, (p) =>
    encrypt(JSON.stringify(p.balances))
  );
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
    const flatByDate = await redis().hgetall<Record<string, string>>(ACCOUNTS_EST_FLAT_BY_DATE);
    const [flatSample] = Object.values(flatByDate ?? {});
    if (flatSample) {
      const parsed = JSON.parse(await decrypt(flatSample)) as Record<string, number>;
      if (account_id in (parsed ?? {})) return true;
    }
  } catch {
    return false; // unreadable: report not-covered, so the caller forces a recompute
  }
  try {
    const map = await redis().hgetall<Record<string, string>>(ACCOUNTS_EST_HASH);
    // Any one date used to answer for all of them, because backfill seeded
    // every cash account before the walk and rewrote the layer wholesale. That
    // no longer holds exactly: points older than the newest run's window are
    // retained, and carry whatever account set was linked back then.
    //
    // It stays safe because of which way it errs. The caller hides a currently
    // linked account, which the newest run always covers -- so sampling a new
    // date answers correctly, and sampling a stale one can only under-report
    // and force a recompute that wasn't needed. Over-reporting would be the
    // dangerous direction (a skipped recompute leaves a cliff in the chart) and
    // requires the account to be missing from the newest window, where the flat
    // record checked just above already accounts for it.
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
    const blob = await redis().get<string>(ACCOUNTS_EST_FLAT_LEGACY);
    if (!blob) return {}; // never written (layer predates this key) -- genuinely empty
    return JSON.parse(await decrypt(blob)) as Record<string, number>;
  } catch {
    return null; // unreadable: the caller must not treat this as "nothing to subtract"
  }
}

/**
 * The flat balances that applied on one specific date, preferring the per-date
 * record and falling back to the legacy single record for points written before
 * the per-date one existed.
 *
 * Same tri-state contract as getEstimatedFlat: `{}` means "nothing was folded
 * in", `null` means "unreadable, don't treat as nothing".
 */
async function flatFor(
  byDate: Record<string, string> | null,
  date: string,
  legacy: Record<string, number> | null
): Promise<Record<string, number> | null> {
  const blob = byDate?.[date];
  if (!blob) return legacy;
  try {
    return JSON.parse(await decrypt(blob)) as Record<string, number>;
  } catch {
    return null;
  }
}

/** Same, for the per-account estimated layer -- and range-scoped for the same
 *  reason, so retained total points keep the per-date maps that hidden-account
 *  subtraction reads for those dates. */
export async function replaceEstimatedAccounts(
  points: { date: string; balances: Record<string, number> }[]
): Promise<void> {
  await replaceRange(ACCOUNTS_EST_HASH, points, (p) => encrypt(JSON.stringify(p.balances)));
}

/**
 * The most recent REAL per-account snapshot, as `{ date, balances }`. Null when
 * nothing readable was ever recorded.
 *
 * Exists so an institution whose live fetch just failed can still show its last
 * good balances with an honest "as of" (see lib/last-known.ts). The REAL layer
 * only, deliberately: the estimated layer is a reconstruction, and presenting a
 * walked figure as "your balance on Aug 7" would put an inferred number on
 * screen dressed as an observed one.
 *
 * ONE DATE, WHOLE. Returned as a single coherent picture rather than searched
 * per account, so an institution's subtotal is a figure that actually existed
 * on one day instead of a mix of dates that never coexisted.
 *
 * What this map does NOT settle is which accounts still exist. It is a complete
 * picture of a day when everything answered (recordSnapshot only runs when
 * `clean`), but it is a GLOBAL record while the caller's other source is
 * per-Item, and the two have different write conditions: a snapshot needs every
 * institution healthy, an Item's record needs only that Item healthy. So they
 * drift, and an account can be in one and not the other for reasons that have
 * nothing to do with it being closed. lib/last-known.ts owns that reconciliation
 * and reports what it could not resolve; do not add an inference here.
 *
 * Reads the date keys, then fetches only the winner. `hgetall` would pull every
 * date since install -- each an encrypted map of every account -- to decrypt
 * one, on the degraded path, forever growing.
 */
export async function getLatestAccountSnapshot(): Promise<{
  date: string;
  balances: Record<string, number>;
} | null> {
  let keys: string[];
  try {
    keys = await redis().hkeys(ACCOUNTS_HASH);
  } catch {
    return null;
  }
  if (keys.length === 0) return null;

  // No age limit here on purpose: whether a snapshot is too old to present is a
  // display decision, and the caller needs the date even when it fails that
  // test so it can say "too old" rather than silently showing nothing.
  //
  // Future dates ARE excluded. Keys come from toISOString() on whichever
  // machine wrote them, so clock skew can mint one, and it would otherwise win
  // every lookup indefinitely.
  const today = new Date().toISOString().slice(0, 10);
  const dates = keys
    .filter((d) => d <= today)
    .sort()
    .reverse();

  for (const date of dates) {
    let balances: Record<string, number>;
    try {
      const blob = await redis().hget<string>(ACCOUNTS_HASH, date);
      if (!blob) continue;
      balances = JSON.parse(await decrypt(blob)) as Record<string, number>;
    } catch {
      continue; // undecryptable date (rotated key) -- try the day before
    }
    const usable: Record<string, number> = {};
    for (const [id, b] of Object.entries(balances ?? {})) {
      if (typeof b === 'number' && Number.isFinite(b)) usable[id] = b;
    }
    if (Object.keys(usable).length > 0) return { date, balances: usable };
  }
  return null;
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
//
// It stores a schema number rather than a bare '1' so that changing HOW the
// estimated layer is built forces a recompute. Without it, a layer built by an
// older algorithm would live forever: the only automatic trigger is the client
// noticing history is "thin", which is never true for anyone who already has an
// estimated layer, so the improvement would only ever reach new users.
//
// Bump this whenever the walk changes shape.
//   1 - cash and credit walked; everything else flat
//   2 - investment external flows walked too
const BACKFILL_SCHEMA = 2;

export async function isBackfillDone(): Promise<boolean> {
  try {
    const flag = await redis().get(BACKFILL_FLAG);
    if (!flag) return false;
    // Legacy '1' from before this was versioned means schema 1.
    return Number(flag) >= BACKFILL_SCHEMA;
  } catch {
    return false;
  }
}

export async function markBackfillDone(): Promise<void> {
  await redis().set(BACKFILL_FLAG, String(BACKFILL_SCHEMA));
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
  const [realMap, estMap, realAccounts, estAccounts, estFlatByDate, legacyFlat] = await Promise.all([
    redis().hgetall<Record<string, string>>(HISTORY_HASH),
    redis().hgetall<Record<string, string>>(ESTIMATED_HASH),
    hiding ? redis().hgetall<Record<string, string>>(ACCOUNTS_HASH) : null,
    hiding ? redis().hgetall<Record<string, string>>(ACCOUNTS_EST_HASH) : null,
    hiding ? redis().hgetall<Record<string, string>>(ACCOUNTS_EST_FLAT_BY_DATE) : null,
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
          // Resolved per date: two runs can leave two eras of points in this
          // layer, each with its own flat balances, and an account can be flat
          // in one era and walked in the next. Reading one global record would
          // subtract the wrong era's number, and would double-count an account
          // that appears in both sources across eras.
          //
          // A null result means the flat record for this date is unreadable, so
          // nothing here can be trusted.
          const estFlat = await flatFor(estFlatByDate, date, legacyFlat);
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
