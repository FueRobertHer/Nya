// lib/history.ts
//
// Net-worth history for the over-time chart. Every layer is a Redis hash keyed
// by UTC date (YYYY-MM-DD) with encrypted values.
//
// 1. REAL snapshots (`history:net-worth`): recorded on every clean live fetch
//    and daily by the snapshot cron. Real points win over estimated ones.
// 2. ESTIMATED backfill (`history:net-worth:est`): reconstructed from
//    transaction history (see /api/backfill). Cash and credit accounts are
//    walked backward from current balances, everything else is held flat.
//
// Per-account balances are kept alongside both, which is what lets one account
// be charted and a hidden one be subtracted from past totals. Two more
// per-account layers feed the chart only: `history:accounts:est:ext`
// (investment accounts walked past the oldest cash transaction) and
// `history:accounts:partial` (balances measured on a day one institution
// failed, so no total was recorded).

import { createHash } from 'node:crypto';
import { redis, kc } from './storage';
import type { Ctx } from './containers';
import { encrypt, decrypt, MalformedCiphertextError, DecryptFailedError } from './crypto';
import { type HiddenMap } from './hidden';
import { signedContribution } from './balance';
import { openStored } from './repo';

const HISTORY_HASH = (ctx: Ctx) => kc(ctx, 'history:net-worth');
const ESTIMATED_HASH = (ctx: Ctx) => kc(ctx, 'history:net-worth:est');
// Per-account balances: one JSON map { account_id: balance } per date.
const ACCOUNTS_HASH = (ctx: Ctx) => kc(ctx, 'history:accounts');
// When each day's snapshot was written: date -> ISO instant. History keys are
// UTC days, so this lets a notice say "as of" in the viewer's own time. Kept
// under "snapshot:" so exports leave it out; losing it costs only that precision.
const TAKEN_HASH = (ctx: Ctx) => kc(ctx, 'snapshot:taken');
const ACCOUNTS_EST_HASH = (ctx: Ctx) => kc(ctx, 'history:accounts:est');
// Per-account balances for dates BEYOND the estimated totals: backfill walks an
// investment account past the oldest cash transaction (see reconstruct in
// lib/backfill.ts).
//
// Not folded into ACCOUNTS_EST_HASH because every date there is the breakdown OF
// that date's estimated total, and hidden-account subtraction in getHistory
// reads it as such. These dates fall where an EARLIER run's totals are retained,
// so mixing them in would subtract the wrong amount from points nothing rewrites.
const ACCOUNTS_EST_EXT_HASH = (ctx: Ctx) => kc(ctx, 'history:accounts:est:ext');
// Per-account balances MEASURED on a day the total could not be recorded: one
// institution failed, so recordSnapshot wrote nothing, but every other
// institution answered. Without this, one broken bank turned every other
// account's chart into an estimate for as long as it stayed broken.
//
// Not folded into ACCOUNTS_HASH: each date there is the breakdown of a recorded
// TOTAL (read by hidden-account subtraction and by getLatestAccountSnapshot,
// which relies on its newest date naming every account). A partial map is the
// breakdown of no total.
const ACCOUNTS_PARTIAL_HASH = (ctx: Ctx) => kc(ctx, 'history:accounts:partial');

/** The measured per-account layers' keys, for lib/links.ts, which reads them to
 *  date accounts. One place for the names. */
export const measuredAccountHistoryKeys = (ctx: Ctx) => [ACCOUNTS_HASH(ctx), ACCOUNTS_PARTIAL_HASH(ctx)];
// The balances backfill folded into its flat `rest` term (everything that isn't
// depository/credit), as of the run that produced each estimated point.
//
// Keyed BY DATE because points outside a run's window are retained, so two runs
// can leave two eras of points, each with different flat balances. A hidden
// account is subtracted by the amount actually baked into a point; its current
// balance would be wrong by however much it moved since, and wrong entirely for
// an account linked after that run.
//
// Kept apart from ACCOUNTS_EST_HASH so flat-held accounts don't get a fake
// per-account estimated series. Membership is checked directly (see
// estimatedLayerCovers), never inferred from type: investment accounts move
// between walked and flat from run to run.
const ACCOUNTS_EST_FLAT_BY_DATE = (ctx: Ctx) => kc(ctx, 'history:accounts:est:flatd');
// The old single-record form. Still read, never written: it is the only thing
// describing points written before the per-date key. A new key name rather than
// a reshape, because the old one is a string and Redis would reject a hash write.
const ACCOUNTS_EST_FLAT_LEGACY = (ctx: Ctx) => kc(ctx, 'history:accounts:est:flat');
// Dates a forget of a hidden account has already folded (see foldHiddenAccount),
// under the forget's random tag. Deleted when the forget finishes; lets a retry
// skip what is done.
const FOLD_PROGRESS = (ctx: Ctx, tag: string) => kc(ctx, `history:forgetting:${tag}`);
const BACKFILL_FLAG = (ctx: Ctx) => kc(ctx, 'history:backfill-done');
// Consecutive runs that finished with an Item's investment data still importing.
// Backfill withholds the done-flag then, so the next load rebuilds once the
// flows arrive; this counter bounds that, so a wedged extraction can't trigger a
// full Plaid pull on every app open.
const BACKFILL_PENDING_TRIES = (ctx: Ctx) => kc(ctx, 'history:backfill-pending');

export type HistoryPoint = { date: string; value: number; estimated?: boolean };

/**
 * Records today's total, and the per-account breakdown behind it.
 *
 * Returns the date key it wrote, or null if nothing landed. Callers need the
 * date, not a boolean: /api/net-worth charts today's point itself and must use
 * the same day this wrote, not a second clock read that could straddle UTC
 * midnight.
 *
 * The two writes fail independently and only the total decides the answer: a
 * failed breakdown costs only the breakdown.
 */
export async function recordSnapshot(ctx: Ctx, 
  netWorth: number,
  accountBalances?: Record<string, number>
): Promise<string | null> {
  const at = new Date();
  const today = at.toISOString().slice(0, 10);

  // Breakdown first, so a reader between the writes sees the new breakdown beside
  // the old total, never the reverse. foldHiddenAccount reads the breakdown to
  // decide what to take out of the total.
  let mapLanded = false;
  if (accountBalances && Object.keys(accountBalances).length > 0) {
    try {
      await redis().hset(ACCOUNTS_HASH(ctx), { [today]: await encrypt(JSON.stringify(accountBalances)) });
      mapLanded = true;
    } catch {
      // The total still goes in. What's lost is subtracting a hidden account
      // from THIS date later, which getHistory handles by dropping the point.
    }
  }

  try {
    await redis().hset(HISTORY_HASH(ctx), { [today]: await encrypt(String(netWorth)) });
  } catch {
    // Best-effort: a missed snapshot leaves a gap in the chart.
    return null;
  }

  if (mapLanded) {
    // Best effort, after the writes above so it can't change which of them a
    // failure lands on.
    await redis().hset(TAKEN_HASH(ctx), { [today]: at.toISOString() }).catch(() => {});
    // This map supersedes any partial one written earlier today. Clearing it is
    // what lets getAccountHistory treat a partial map beside a real one as the
    // NEWER measurement. If this fails, one day loses a little precision.
    try {
      await redis().hdel(ACCOUNTS_PARTIAL_HASH(ctx), today);
    } catch {}
  }

  return today;
}

/**
 * Records today's balances for the accounts a partly failed fetch did measure
 * (see ACCOUNTS_PARTIAL_HASH). Only for when recordSnapshot didn't land.
 *
 * Merged into anything already stored for today (a bank that answered at 9am and
 * not at noon keeps its 9am balance); newer values win. Skips the write whenever
 * today's existing map can't be read or decrypted, since overwriting would
 * replace a fuller map with a smaller one. Two racing writers can lose one's
 * values; accepted, since a field per account would put account ids in plaintext.
 *
 * Best-effort, never throws.
 */
export async function recordPartialAccounts(ctx: Ctx, balances: Record<string, number>): Promise<void> {
  if (Object.keys(balances).length === 0) return;
  const today = new Date().toISOString().slice(0, 10);

  let existing: Record<string, number> = {};
  try {
    const blob = await redis().hget<string>(ACCOUNTS_PARTIAL_HASH(ctx), today);
    if (blob) {
      const parsed = JSON.parse(await decrypt(blob));
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return;
      existing = parsed as Record<string, number>;
    }
  } catch {
    return;
  }

  try {
    await redis().hset(ACCOUNTS_PARTIAL_HASH(ctx), {
      [today]: await encrypt(JSON.stringify({ ...existing, ...balances })),
    });
  } catch {
    // Best-effort: the account's chart falls back to the estimate for today.
  }
}

/**
 * Replace the estimated layer over the range the new run actually covers,
 * leaving anything older intact.
 *
 * Deleting the whole hash would truncate the chart for anyone with estimated
 * points older than the walk's 365-day reach, which no transaction stream can
 * rebuild. Points outside the window are orphans from an earlier run and still
 * the best answer for those dates.
 */
async function replaceRange(
  key: string,
  points: { date: string }[],
  encode: (p: any) => Promise<string>,
  /** An extra date from which to clear even where the run wrote no points, for a
   *  layer whose dates are only valid while no other layer covers them. */
  clearFrom?: string
): Promise<void> {
  const oldestPoint = points.reduce<string | null>((min, p) => (!min || p.date < min ? p.date : min), null);
  const oldest =
    oldestPoint && clearFrom
      ? oldestPoint < clearFrom
        ? oldestPoint
        : clearFrom
      : oldestPoint ?? clearFrom ?? null;
  try {
    const existing = await redis().hkeys(key);
    // No new points and no floor means nothing was reconstructable: keep every
    // stored point rather than blanking the layer.
    const doomed = oldest ? existing.filter((d) => d >= oldest) : [];
    if (doomed.length > 0) await redis().hdel(key, ...doomed);
  } catch {
    // Couldn't enumerate: just write. Stale dates inside the window get
    // overwritten anyway; a date the new run no longer produces keeps its value.
  }
  if (points.length === 0) return;
  const fields: Record<string, string> = {};
  for (const p of points) fields[p.date] = await encode(p);
  await redis().hset(key, fields);
}

export async function replaceEstimated(ctx: Ctx, points: { date: string; value: number }[]): Promise<void> {
  await replaceRange(ESTIMATED_HASH(ctx), points, (p) => encrypt(String(p.value)));
}
/**
 * Replaces the flat (non-cash) balances backfill folded into `rest`, one map per
 * date and range-scoped like the layers it describes. Per-date so each retained
 * point is subtracted by the amount actually baked into it.
 */
export async function replaceEstimatedFlat(ctx: Ctx, 
  points: { date: string; balances: Record<string, number> }[]
): Promise<void> {
  await replaceRange(ACCOUNTS_EST_FLAT_BY_DATE(ctx), points, (p) =>
    encrypt(JSON.stringify(p.balances))
  );
}

/**
 * Whether the estimated layer can account for this id at all: a per-date balance
 * (Plaid cash accounts, walked backward) or a flat balance (everything else).
 *
 * Checked directly rather than inferred from type: backfill walks only *Plaid*
 * accounts, so a manual depository account is in the flat term despite looking
 * like cash. Guessing from type left it un-subtracted from every estimated point.
 */
export async function estimatedLayerCovers(ctx: Ctx, account_id: string): Promise<boolean> {
  if (account_id in ((await getEstimatedFlat(ctx)) ?? {})) return true;
  try {
    const flatByDate = await redis().hgetall<Record<string, string>>(ACCOUNTS_EST_FLAT_BY_DATE(ctx));
    // Newest date, as for the walked map below.
    const newestFlat = Object.keys(flatByDate ?? {}).sort().pop();
    const flatSample = newestFlat ? flatByDate?.[newestFlat] : undefined;
    if (flatSample) {
      const parsed = JSON.parse(await decrypt(flatSample)) as Record<string, number>;
      if (account_id in (parsed ?? {})) return true;
    }
  } catch {
    return false; // unreadable: report not-covered, so the caller forces a recompute
  }
  try {
    const map = await redis().hgetall<Record<string, string>>(ACCOUNTS_EST_HASH(ctx));
    // The NEWEST date, not an arbitrary one: retained points from older runs
    // carry whatever account set was linked back then, so an arbitrary sample can
    // under-report and force a needless recompute. The newest run's date holds
    // every account it walked. Over-reporting is the dangerous direction (a
    // skipped recompute leaves a cliff), and would need the account to be missing
    // from the newest window, which the flat check above already covers.
    const newest = Object.keys(map ?? {}).sort().pop();
    const sample = newest ? map?.[newest] : undefined;
    if (!sample) return false;
    return account_id in ((JSON.parse(await decrypt(sample)) as Record<string, number>) ?? {});
  } catch {
    return false; // unreadable: report not-covered, so the caller forces a recompute
  }
}

/**
 * The flat balances captured by the last backfill.
 *
 * `{}` and `null` differ: `{}` means backfill folded in no non-cash accounts, so
 * subtracting nothing is correct; `null` means what was baked in is unreadable,
 * and subtracting nothing would shift the estimated region by the hidden balance.
 */
export async function getEstimatedFlat(ctx: Ctx): Promise<Record<string, number> | null> {
  try {
    const blob = await redis().get<string>(ACCOUNTS_EST_FLAT_LEGACY(ctx));
    if (!blob) return {}; // never written (layer predates this key): genuinely empty
    return JSON.parse(await decrypt(blob)) as Record<string, number>;
  } catch {
    return null; // unreadable: not the same as "nothing to subtract"
  }
}

/** Least recently used first out, within a budget of approximate bytes. */
class ByteLru<V> {
  private entries = new Map<string, { value: V; bytes: number }>();
  private used = 0;
  constructor(private budget: number) {}
  get(key: string): V | undefined {
    const hit = this.entries.get(key);
    if (!hit) return undefined;
    this.entries.delete(key); // re-inserted: most recently used last
    this.entries.set(key, hit);
    return hit.value;
  }
  set(key: string, value: V, bytes: number): void {
    if (bytes > this.budget) return;
    this.delete(key);
    while (this.used + bytes > this.budget && this.entries.size > 0) {
      const [oldest, entry] = this.entries.entries().next().value!;
      this.entries.delete(oldest);
      this.used -= entry.bytes;
    }
    this.entries.set(key, { value, bytes });
    this.used += bytes;
  }
  delete(key: string): void {
    const entry = this.entries.get(key);
    if (!entry) return;
    this.entries.delete(key);
    this.used -= entry.bytes;
  }
  has(key: string): boolean {
    return this.entries.has(key);
  }
  reset(budget: number): void {
    this.entries.clear();
    this.used = 0;
    this.budget = budget;
  }
}

// Parsed JSON costs several times its text: counted as ~6 bytes a character.
const COST_PER_CHAR = 6;
const DEFAULT_BUDGET = 32 * 1024 * 1024;
const DECRYPTED_MAPS = new ByteLru<Record<string, number>>(DEFAULT_BUDGET);
/** For tests: a smaller budget, emptying the cache. */
export function setDecryptedBudget(bytes: number): void {
  DECRYPTED_MAPS.reset(bytes);
}
const digestOf = (blob: string) => createHash('sha256').update(blob).digest('base64');
/**
 * A per-date balance map, decrypted once per process. getHistory reads every
 * per-account map on every load while anything is hidden, so without this the
 * same year of immutable maps is decrypted on every dashboard load. Keyed by a
 * digest of the ciphertext, so a rewritten map is a different key and never
 * served stale, and one container's entries can't answer for another's. LRU
 * within a byte budget; forgetting an account evicts the maps it rewrote
 * (evictDecrypted) so its balances don't stay in memory.
 */
async function decryptMap(blob: string): Promise<Record<string, number>> {
  const key = digestOf(blob);
  const hit = DECRYPTED_MAPS.get(key);
  if (hit) return hit;
  // Frozen: every caller shares it.
  const map = Object.freeze(JSON.parse(await decrypt(blob))) as Record<string, number>;
  DECRYPTED_MAPS.set(key, map, blob.length * COST_PER_CHAR);
  return map;
}
function evictDecrypted(blob: string): void {
  DECRYPTED_MAPS.delete(digestOf(blob));
}
/** For tests: the cache itself. */
export const decryptMapForTest = (blob: string) => decryptMap(blob);
/** For tests: whether a map is held decrypted. */
export const isDecryptedCached = (blob: string) => DECRYPTED_MAPS.has(digestOf(blob));

/**
 * The flat balances that applied on one date: the per-date record, falling back
 * to the legacy single record for points written before it existed. Same
 * `{}` vs `null` contract as getEstimatedFlat.
 */
async function flatFor(
  byDate: Record<string, string> | null,
  date: string,
  legacy: Record<string, number> | null
): Promise<Record<string, number> | null> {
  const blob = byDate?.[date];
  if (!blob) return legacy;
  try {
    return await decryptMap(blob);
  } catch {
    return null;
  }
}

/** Same, for the per-account estimated layer, range-scoped so retained total
 *  points keep the per-date maps that hidden-account subtraction reads. */
export async function replaceEstimatedAccounts(ctx: Ctx, 
  points: { date: string; balances: Record<string, number> }[]
): Promise<void> {
  await replaceRange(ACCOUNTS_EST_HASH(ctx), points, (p) => encrypt(JSON.stringify(p.balances)));
}

/**
 * Replaces the per-account extension layer (ACCOUNTS_EST_EXT_HASH): the span an
 * investment account's own flows reach past the cash horizon. Range-scoped like
 * every other layer.
 *
 * `coveredFrom` is this run's full-walk horizon. getAccountHistory prefers the
 * extension where both layers have a date, so a stale extension point left
 * behind would shadow a newer walk that now covers it and leave a step at the
 * join. The extension is therefore cleared from this horizon forward even when
 * the run produces no extension points, which is the common case.
 */
export async function replaceEstimatedExtension(ctx: Ctx, 
  points: { date: string; balances: Record<string, number> }[],
  coveredFrom: string
): Promise<void> {
  await replaceRange(
    ACCOUNTS_EST_EXT_HASH(ctx),
    points,
    (p) => encrypt(JSON.stringify(p.balances)),
    coveredFrom
  );
}

/**
 * The most recent REAL per-account snapshot, as `{ date, balances }`, or null
 * when nothing readable was ever recorded.
 *
 * Lets an institution whose live fetch just failed show its last good balances
 * with an honest "as of" (see lib/last-known.ts). Real layer only: presenting a
 * walked estimate as "your balance on Aug 7" would dress an inferred number as
 * an observed one.
 *
 * Returned as one whole date, so an institution's subtotal existed on a single
 * day. It does not settle which accounts still exist: this map is global and
 * needs every institution healthy, while an Item's own record needs only that
 * Item healthy, so the two drift. lib/last-known.ts owns that reconciliation;
 * do not add an inference here.
 *
 * Reads the date keys and fetches only the winner, since `hgetall` would pull
 * every date since install to decrypt one.
 */
export async function getLatestAccountSnapshot(ctx: Ctx): Promise<{
  date: string;
  balances: Record<string, number>;
} | null> {
  let keys: string[];
  try {
    keys = await redis().hkeys(ACCOUNTS_HASH(ctx));
  } catch {
    return null;
  }
  if (keys.length === 0) return null;

  // No age limit on purpose: whether a snapshot is too old is a display decision,
  // and the caller needs the date to say "too old" rather than show nothing.
  //
  // Future dates ARE excluded: clock skew on the writing machine can mint one,
  // and it would win every lookup indefinitely.
  const today = new Date().toISOString().slice(0, 10);
  const dates = keys
    .filter((d) => d <= today)
    .sort()
    .reverse();

  for (const date of dates) {
    let balances: Record<string, number>;
    try {
      const blob = await redis().hget<string>(ACCOUNTS_HASH(ctx), date);
      if (!blob) continue;
      balances = JSON.parse(await decrypt(blob)) as Record<string, number>;
    } catch {
      continue; // undecryptable date (rotated key): try the day before
    }
    const usable: Record<string, number> = {};
    for (const [id, b] of Object.entries(balances ?? {})) {
      if (typeof b === 'number' && Number.isFinite(b)) usable[id] = b;
    }
    if (Object.keys(usable).length > 0) return { date, balances: usable };
  }
  return null;
}

/** One account's newest measured balance (latestMeasuredBalances). */
export type MeasuredBalance = {
  /** The UTC day it was measured. */
  date: string;
  value: number;
  /** Where it was found: the map recorded with a total ('recorded'), or a
   *  partial one, measured on a day one institution failed ('partial'). */
  layer: 'recorded' | 'partial';
};

/**
 * Each account's newest MEASURED balance and its UTC day, never an estimate:
 * the balance the read-only API gives a linked account (lib/api-read.ts),
 * which never asks Plaid. The precedence of getAccountHistory's measured
 * points, which this must keep agreeing with: on each date, a partial map
 * naming the account wins (recordSnapshot clears the day's partial map when it
 * records a total, so one beside a recorded map is newer), then the recorded
 * map; within a map, the account's current id, then its earlier ids in order
 * (`accounts` maps each account to its ids, current first). Future dates are
 * passed over, as getLatestAccountSnapshot passes them: clock skew can mint
 * one. Reads the dates, then only the maps it needs, newest first and a few
 * more each round trip, until every account has a balance: on most days the
 * newest map names them all. A map damaged for good (unreadableForGood) is
 * passed over (the next date down answers, with its own date); a failure that
 * may pass (storage, or the key store, out of reach) throws, never "an older
 * balance". An account no measured map names is left out.
 */
export async function latestMeasuredBalances(ctx: Ctx, accounts: Map<string, string[]>): Promise<Map<string, MeasuredBalance>> {
  const found = new Map<string, MeasuredBalance>();
  if (accounts.size === 0) return found;
  const [recordedDates, partialDates] = await Promise.all([redis().hkeys(ACCOUNTS_HASH(ctx)), redis().hkeys(ACCOUNTS_PARTIAL_HASH(ctx))]);
  const recorded = new Set(recordedDates);
  const partial = new Set(partialDates);
  const today = new Date().toISOString().slice(0, 10);
  const dates = [...new Set([...recordedDates, ...partialDates])].filter((d) => d <= today).sort().reverse();

  const mapAt = async (key: string, date: string): Promise<Record<string, number> | null> => {
    const blob = await redis().hget<string>(key, date); // uncaught: storage failing is never "no balance"
    if (!blob) return null;
    try {
      return await decryptMap(blob);
    } catch (err) {
      if (!unreadableForGood(err)) throw err;
      return null; // damaged for good: the date before answers
    }
  };
  const valueIn = (map: Record<string, number> | null, ids: string[]): number | null => {
    for (const id of ids) {
      const v = map?.[id];
      if (typeof v === 'number' && Number.isFinite(v)) return v;
    }
    return null;
  };

  for (let i = 0, size = 1; i < dates.length && found.size < accounts.size; i += size, size = Math.min(size * 4, 32)) {
    const batch = await Promise.all(
      dates.slice(i, i + size).map(async (date) => {
        const [p, r] = await Promise.all([
          partial.has(date) ? mapAt(ACCOUNTS_PARTIAL_HASH(ctx), date) : null,
          recorded.has(date) ? mapAt(ACCOUNTS_HASH(ctx), date) : null,
        ]);
        return { date, p, r };
      })
    );
    for (const { date, p, r } of batch) {
      for (const [account, ids] of accounts) {
        if (found.has(account)) continue;
        const fromPartial = valueIn(p, ids);
        const value = fromPartial ?? valueIn(r, ids);
        if (value !== null) found.set(account, { date, value, layer: fromPartial !== null ? 'partial' : 'recorded' });
      }
    }
  }
  return found;
}

/** The moment the snapshot dated `date` was last written, or null if unknown. */
export async function snapshotTakenAt(ctx: Ctx, date: string): Promise<string | null> {
  try {
    const v = await redis().hget<string>(TAKEN_HASH(ctx), date);
    return typeof v === 'string' && !Number.isNaN(Date.parse(v)) ? v : null;
  } catch {
    return null;
  }
}

export async function getRealSnapshotDates(ctx: Ctx): Promise<Set<string>> {
  try {
    return new Set(await redis().hkeys(HISTORY_HASH(ctx)));
  } catch {
    return new Set();
  }
}

/**
 * Balance history for one account, merged like getHistory (real wins) with the
 * extension layer between the two.
 *
 * Resolved per account, not per date: the layers answer for different account
 * sets on the same date, so picking a whole map per date would drop a cash
 * account's retained point wherever the extension also has that date.
 *
 * Extension over estimated: where both have a date the extension is the newer
 * run, and mixing two walks in one line is what the precedence avoids.
 *
 * A partial measurement (ACCOUNTS_PARTIAL_HASH) comes first for the accounts it
 * names, even over a real map for the same date, because recordSnapshot clears
 * the day's partial map whenever it writes a real one, so a partial beside a real
 * one is newer. It only speaks for the accounts it names: one that leaves this
 * account out means its institution failed, not that the account was gone.
 */
export async function getAccountHistory(ctx: Ctx, 
  account_id: string,
  /** Earlier ids of the SAME account (lib/links.ts), newest first. On each date
   *  the current id wins, then these in order, so history recorded before a
   *  reconnect joins up with the current id. */
  olderIds: string[] = []
): Promise<HistoryPoint[]> {
  const ids = [account_id, ...olderIds.filter((id) => id !== account_id)];
  const [realMap, partialMap, estMap, extMap] = await Promise.all([
    redis().hgetall<Record<string, string>>(ACCOUNTS_HASH(ctx)),
    redis().hgetall<Record<string, string>>(ACCOUNTS_PARTIAL_HASH(ctx)),
    redis().hgetall<Record<string, string>>(ACCOUNTS_EST_HASH(ctx)),
    redis().hgetall<Record<string, string>>(ACCOUNTS_EST_EXT_HASH(ctx)),
  ]);

  /** This account's balance in one encrypted map under the first of its ids the
   *  map names, or null when the map is unreadable or names none. */
  async function balanceIn(blob: string | undefined): Promise<number | null> {
    if (!blob) return null;
    try {
      const balances = JSON.parse(await decrypt(blob)) as Record<string, number>;
      for (const id of ids) {
        const value = balances[id];
        if (typeof value === 'number' && Number.isFinite(value)) return value;
      }
      return null;
    } catch {
      return null;
    }
  }

  const dates = new Set([
    ...Object.keys(realMap ?? {}),
    ...Object.keys(partialMap ?? {}),
    ...Object.keys(estMap ?? {}),
    ...Object.keys(extMap ?? {}),
  ]);

  const points = await Promise.all(
    [...dates].map(async (date): Promise<HistoryPoint | null> => {
      const measured = await balanceIn(partialMap?.[date]);
      if (measured !== null) return { date, value: measured };
      if (realMap?.[date]) {
        const real = await balanceIn(realMap[date]);
        // A real map naming none of the account's ids is an answer (the account
        // wasn't there), not a gap: an estimate here would show a reconstructed
        // figure on a measured date.
        return real === null ? null : { date, value: real };
      }
      const value = (await balanceIn(extMap?.[date])) ?? (await balanceIn(estMap?.[date]));
      return value === null ? null : { date, value, estimated: true };
    })
  );
  return points
    .filter((p): p is HistoryPoint => p !== null)
    .sort((a, b) => (a.date < b.date ? -1 : 1));
}

/**
 * The balances measured on each of `dates`, per account, for allocation over
 * time (app/api/allocation-history): the real and partial layers only, never
 * an estimate, by the precedence getAccountHistory reads them with. On a date,
 * a partial measurement comes first for the accounts it names (recordSnapshot
 * clears a day's partial map when it writes a real one, so a partial beside a
 * real one is newer), then the real map. Keyed by the id each balance was
 * recorded under: the caller follows links and leaves hidden accounts out.
 *
 * A date neither layer has is absent. A date whose map is damaged for good
 * (unreadableForGood) is named in `unreadable`, never taken for a day with no
 * balances; a failure that may pass (the key store unreachable) throws.
 * Reads only the dates asked for, two commands in all.
 */
export async function readMeasuredBalances(
  ctx: Ctx,
  dates: readonly string[]
): Promise<{ balances: Map<string, Record<string, number>>; unreadable: string[] }> {
  const balances = new Map<string, Record<string, number>>();
  const unreadable: string[] = [];
  const wanted = [...new Set(dates)];
  if (wanted.length === 0) return { balances, unreadable };
  const [real, partial] = await Promise.all(
    [ACCOUNTS_HASH(ctx), ACCOUNTS_PARTIAL_HASH(ctx)].map(
      async (key) => (await redis().hmget<Record<string, string | null>>(key, ...wanted)) ?? {}
    )
  );
  /** A stored map's finite balances, or null when it is damaged for good. */
  const open = async (blob: unknown): Promise<Record<string, number> | null> => {
    try {
      if (typeof blob !== 'string') throw new SyntaxError('a balance map is not stored as text');
      const map = await decryptMap(blob);
      const out: Record<string, number> = {};
      for (const [id, value] of Object.entries(map ?? {})) if (typeof value === 'number' && Number.isFinite(value)) out[id] = value;
      return out;
    } catch (err) {
      if (unreadableForGood(err)) return null;
      throw err;
    }
  };
  await Promise.all(
    wanted.map(async (date) => {
      const realBlob = real[date] ?? null;
      const partialBlob = partial[date] ?? null;
      if (realBlob === null && partialBlob === null) return;
      const [r, p] = await Promise.all([realBlob === null ? {} : open(realBlob), partialBlob === null ? {} : open(partialBlob)]);
      if (r === null || p === null) {
        unreadable.push(date);
        return;
      }
      balances.set(date, { ...r, ...p });
    })
  );
  unreadable.sort();
  return { balances, unreadable };
}

/** One day of a stored series, as the download of my data gives it. */
export type StoredPoint = { date: string; value: number; estimated: boolean };

/** The days a series has stored that can't be used, by why, each in date
 *  order, as the storage seam reports entries (lib/repo.ts getAllReport):
 *  `unreadable`, their stored bytes are damaged; `unrecognised`, stored intact
 *  in a form this code does not know (a total that isn't a number, a map
 *  that isn't one of balances, or one holding a balance that isn't a
 *  number). */
export type UnusableDays = { unreadable: string[]; unrecognised: string[] };

/**
 * Every stored balance, for the download of my data (lib/user-export.ts): the
 * net-worth totals and each account's own series, recorded and estimated
 * points marked. One point per day per series, by the precedence the app
 * reads them with: for the totals a recorded one wins over an estimate
 * (getHistory); for an account a partial measurement, then the recorded map,
 * then the extension, then the estimate (getAccountHistory, which this must
 * keep agreeing with; test/user-export.test.ts checks that it does).
 *
 * Nothing the chart adds on read: no hidden account is subtracted (stored
 * totals include hidden accounts, lib/hidden.ts), no estimate between two
 * recorded days is replaced by a line (bridgeInteriorEstimates), and no
 * earlier id is joined to the account it was linked to (the download lists
 * the links). The flat balances behind estimated totals are not read: they
 * are balances of the day backfill ran, copied onto past days, not a history
 * of those accounts (see ACCOUNTS_EST_FLAT_BY_DATE).
 *
 * A day that can't be used is NAMED, never dropped quietly and never a reason
 * to stop: `problems` lists it, by the storage seam's rules (lib/repo.ts
 * openStored), for the series it is missing from. So is a day whose map reads
 * but holds a balance that isn't a finite number (a later version's shape,
 * say): its numbers are used, as the chart uses them, and the day is named
 * `unrecognised`, since an account's balance on it is left out. It is not
 * read around either: a day whose recorded total or map can't be used gets
 * no estimate in its place, as the chart gives it none. A partial measurement
 * that can't be used, on a day with no recorded map, does fall back to the
 * estimate, marked as one, as the chart does. Anything that says nothing
 * about the data is thrown as it is: storage out of reach, a key this
 * deployment can't load, a failed decrypt under k0 (which a replaced
 * PLAID_ENCRYPTION_KEY would look exactly like). An estimate on a day that
 * also has a recorded value is superseded and not read, so it can never be
 * named.
 */
export async function readHistoryForExport(
  ctx: Ctx
): Promise<{ totals: StoredPoint[]; accounts: Map<string, StoredPoint[]>; problems: { totals: UnusableDays; accounts: UnusableDays } }> {
  const [real, est, realAcc, partialAcc, estAcc, extAcc] = await Promise.all(
    [HISTORY_HASH(ctx), ESTIMATED_HASH(ctx), ACCOUNTS_HASH(ctx), ACCOUNTS_PARTIAL_HASH(ctx), ACCOUNTS_EST_HASH(ctx), ACCOUNTS_EST_EXT_HASH(ctx)].map(
      async (key) => (await redis().hgetall<Record<string, unknown>>(key)) ?? {}
    )
  );
  const totalsNamed = { unreadable: new Set<string>(), unrecognised: new Set<string>() };
  const accountsNamed = { unreadable: new Set<string>(), unrecognised: new Set<string>() };

  /** A stored total, or null when it can't be used, named. */
  const total = async (date: string, blob: unknown): Promise<number | null> => {
    const opened = await openStored(blob);
    if (!opened.ok) {
      totalsNamed[opened.flaw].add(date);
      return null;
    }
    // Number('') is 0: an empty value is no zero net worth.
    const value = opened.text.trim() === '' ? NaN : Number(opened.text);
    if (Number.isFinite(value)) return value;
    totalsNamed.unrecognised.add(date);
    return null;
  };
  const totals = (
    await Promise.all([
      ...Object.entries(real).map(async ([date, blob]) => ({ date, value: await total(date, blob), estimated: false })),
      ...Object.entries(est)
        .filter(([date]) => !Object.hasOwn(real, date))
        .map(async ([date, blob]) => ({ date, value: await total(date, blob), estimated: true })),
    ])
  ).filter((p): p is StoredPoint => p.value !== null);

  /** A stored map of balances, or null when it can't be used, named. */
  const open = async (date: string, blob: unknown): Promise<Record<string, unknown> | null> => {
    const opened = await openStored(blob);
    if (!opened.ok) {
      accountsNamed[opened.flaw].add(date);
      return null;
    }
    let map: unknown;
    try {
      map = JSON.parse(opened.text);
    } catch {
      map = null;
    }
    if (!map || typeof map !== 'object' || Array.isArray(map)) {
      accountsNamed.unrecognised.add(date);
      return null;
    }
    // A balance that isn't a finite number is one this code doesn't know (no
    // writer stores one): the day is named, and the rest of the map is used.
    if (Object.values(map).some((v) => typeof v !== 'number' || !Number.isFinite(v))) accountsNamed.unrecognised.add(date);
    return map as Record<string, unknown>;
  };
  /** A layer's maps that can be used, for the days given. */
  const maps = async (layer: Record<string, unknown>, dates: string[]) => {
    const read = await Promise.all(dates.map(async (date) => [date, await open(date, layer[date])] as const));
    return new Map(read.filter((e): e is readonly [string, Record<string, unknown>] => e[1] !== null));
  };
  // The estimate layers are read only for days with no recorded map: where one
  // is stored, readable or not, they are superseded (below).
  const unrecorded = (layer: Record<string, unknown>) => Object.keys(layer).filter((date) => !Object.hasOwn(realAcc, date));
  const [realMaps, partialMaps, estMaps, extMaps] = await Promise.all([
    maps(realAcc, Object.keys(realAcc)),
    maps(partialAcc, Object.keys(partialAcc)),
    maps(estAcc, unrecorded(estAcc)),
    maps(extAcc, unrecorded(extAcc)),
  ]);
  // A value that isn't a finite number is no balance, as getAccountHistory
  // reads it; its day is named (open, above).
  const num = (map: Record<string, unknown> | undefined, id: string): number | null => {
    const v = map && Object.hasOwn(map, id) ? map[id] : undefined;
    return typeof v === 'number' && Number.isFinite(v) ? v : null;
  };

  const accounts = new Map<string, StoredPoint[]>();
  const dates = new Set([...realMaps.keys(), ...partialMaps.keys(), ...estMaps.keys(), ...extMaps.keys()]);
  for (const date of dates) {
    const [partial, recorded, ext, estimate] = [partialMaps.get(date), realMaps.get(date), extMaps.get(date), estMaps.get(date)];
    const ids = new Set([partial, recorded, ext, estimate].flatMap((m) => Object.keys(m ?? {})));
    for (const id of ids) {
      let point: StoredPoint | null = null;
      const measured = num(partial, id);
      if (measured !== null) point = { date, value: measured, estimated: false };
      else if (Object.hasOwn(realAcc, date)) {
        // A recorded map that doesn't name the account says it wasn't there
        // that day: no estimate stands in for it. Nor for a recorded map that
        // can't be read, which is named instead.
        const value = num(recorded, id);
        point = value === null ? null : { date, value, estimated: false };
      } else {
        const value = num(ext, id) ?? num(estimate, id);
        point = value === null ? null : { date, value, estimated: true };
      }
      if (!point) continue;
      const series = accounts.get(id) ?? [];
      series.push(point);
      accounts.set(id, series);
    }
  }
  const byDate = (a: StoredPoint, b: StoredPoint) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0);
  for (const series of accounts.values()) series.sort(byDate);
  const sorted = (named: { unreadable: Set<string>; unrecognised: Set<string> }): UnusableDays => ({
    unreadable: [...named.unreadable].sort(),
    unrecognised: [...named.unrecognised].sort(),
  });
  return { totals: totals.sort(byDate), accounts, problems: { totals: sorted(totalsNamed), accounts: sorted(accountsNamed) } };
}

// The backfill flag makes /api/backfill idempotent; linking a new institution
// clears it. It stores a schema number rather than '1' so that changing HOW the
// estimated layer is built forces a recompute: the client's "thin history"
// trigger never fires for anyone who already has an estimated layer.
//
// Bump this whenever the walk changes shape.
//   1 - cash and credit walked; everything else flat
//   2 - investment external flows walked too
//   3 - an investment account whose flows out-run its balance is floored at zero
//       instead of dropped to flat, and its series is walked past the cash
//       horizon, so a large arrival (a rollover) shows on its chart
//   4 - a contribution booked as a single buy (or a payout as a single sell)
//       with no cash row beside it counts as money crossing the boundary
//       (countedTrades in lib/investments.ts)
//   5 - an in-kind transfer with amount 0 is valued from quantity and price;
//       deposit, transfer and withdrawal trades count like contributions (sell
//       and transfer as money out, so an exchange nets to zero), judged from
//       cash rows within 45 days of each trade. Rows come from lib/invstore.ts.
const BACKFILL_SCHEMA = 5;

export async function isBackfillDone(ctx: Ctx): Promise<boolean> {
  try {
    const flag = await redis().get(BACKFILL_FLAG(ctx));
    if (!flag) return false;
    // Legacy '1' from before this was versioned means schema 1.
    return Number(flag) >= BACKFILL_SCHEMA;
  } catch {
    return false;
  }
}

export async function markBackfillDone(ctx: Ctx): Promise<void> {
  await redis().set(BACKFILL_FLAG(ctx), String(BACKFILL_SCHEMA));
}

/**
 * Counts this run as one that ended with investment data still importing, and
 * says whether to stop waiting. True means accept the reconstruction as it
 * stands (investment accounts held flat). A failure to count also returns true:
 * an uncountable retry is an unbounded one.
 */
export async function backfillPendingExhausted(ctx: Ctx, limit: number): Promise<boolean> {
  try {
    return (await redis().incr(BACKFILL_PENDING_TRIES(ctx))) >= limit;
  } catch {
    return true;
  }
}

/** Forget the pending-run count: this run had nothing outstanding, or gave up. */
export async function clearBackfillPending(ctx: Ctx): Promise<void> {
  try {
    await redis().del(BACKFILL_PENDING_TRIES(ctx));
  } catch {
    // Worst case a later pending run gives up sooner than it needed to.
  }
}

export async function clearBackfillDone(ctx: Ctx): Promise<void> {
  try {
    await redis().del(BACKFILL_FLAG(ctx));
  } catch {
    // Worst case the next backfill is skipped; harmless.
  }
}

/** Per-date balances for a layer, or null when that date has no map at all. */
async function balancesFor(source: Record<string, string> | null, date: string): Promise<Record<string, number> | null> {
  const blob = source?.[date];
  if (!blob) return null;
  try {
    return await decryptMap(blob);
  } catch {
    return null;
  }
}

/** What getHistory reads to subtract a hidden account from a point. */
type HiddenSources = {
  realAccounts: Record<string, string> | null;
  estAccounts: Record<string, string> | null;
  estFlatByDate: Record<string, string> | null;
  legacyFlat: Record<string, number> | null;
};

/**
 * What one hidden account contributed to one point, signed as it was added to the
 * total; null when that can't be told, and the point must be dropped. The one
 * rule used both to subtract a hidden account (getHistory) and to fold a
 * forgotten one out of the totals (foldHiddenAccount).
 *
 * REAL points: the per-account map recorded with the total. A real date with no
 * map is reachable (recordSnapshot's two writes are separate awaits) and can't
 * be corrected; showing it would spike the chart by the hidden balance, so it is
 * dropped and the line interpolates across one day.
 *
 * ESTIMATED points: exactly one of two sources applies, the per-date walked
 * balance (cash accounts) or the flat balance (everything else), so a miss in
 * one is only correct if the other is readable and doesn't list the account.
 * Resolved per date, since two runs can leave two eras of points. An unreadable
 * flat record, or no per-date map for an account not in the flat one, means
 * nothing here can be trusted. Absent from a readable map means the account was
 * never in these points (linked after the last backfill): nothing to remove.
 */
async function hiddenContribution(src: HiddenSources, date: string, estimated: boolean, id: string, type: string): Promise<number | null> {
  if (!estimated) {
    const balances = await balancesFor(src.realAccounts, date);
    if (!balances) return null;
    const b = balances[id];
    return typeof b === 'number' ? signedContribution(type, b) : 0;
  }
  const estFlat = await flatFor(src.estFlatByDate, date, src.legacyFlat);
  if (estFlat === null) return null;
  const flatBalance = estFlat[id];
  if (typeof flatBalance === 'number') return signedContribution(type, flatBalance);
  const balances = await balancesFor(src.estAccounts, date);
  if (!balances) return null;
  const b = balances[id];
  return typeof b === 'number' ? signedContribution(type, b) : 0;
}

/**
 * The net-worth series, with hidden accounts subtracted per date.
 *
 * Hiding is retroactive by construction: stored totals include every account
 * (see lib/hidden.ts; only a forgotten hidden account is folded out), and the
 * per-account map recorded with each date lets a hidden account's contribution
 * be removed from every point. Hiding a $40k 401k redraws the whole chart as if
 * it was never counted instead of leaving a permanent $40k cliff. Subtraction
 * never consults a live balance, so it works while an institution is erroring.
 */
export async function getHistory(ctx: Ctx, hidden?: HiddenMap): Promise<HistoryPoint[]> {
  const hiding = !!hidden && hidden.size > 0;

  // Per-account maps are read only when something is hidden: decrypting a year
  // of them on every load to subtract nothing would be waste.
  const [realMap, estMap, realAccounts, estAccounts, estFlatByDate, legacyFlat] = await Promise.all([
    redis().hgetall<Record<string, string>>(HISTORY_HASH(ctx)),
    redis().hgetall<Record<string, string>>(ESTIMATED_HASH(ctx)),
    hiding ? redis().hgetall<Record<string, string>>(ACCOUNTS_HASH(ctx)) : null,
    hiding ? redis().hgetall<Record<string, string>>(ACCOUNTS_EST_HASH(ctx)) : null,
    hiding ? redis().hgetall<Record<string, string>>(ACCOUNTS_EST_FLAT_BY_DATE(ctx)) : null,
    hiding ? getEstimatedFlat(ctx) : null,
  ]);
  const sources: HiddenSources = { realAccounts, estAccounts, estFlatByDate, legacyFlat };

  const entries: { date: string; blob: string; estimated: boolean }[] = [];
  for (const [date, blob] of Object.entries(realMap ?? {})) {
    entries.push({ date, blob, estimated: false });
  }
  for (const [date, blob] of Object.entries(estMap ?? {})) {
    if (!realMap?.[date]) entries.push({ date, blob, estimated: true });
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
        for (const [id, { type }] of hidden!) {
          const c = await hiddenContribution(sources, date, estimated, id, type);
          // Can't tell what this account contributed: dropped rather than
          // showing a spike the size of the account (see hiddenContribution).
          if (c === null) return null;
          value -= c;
        }
      }

      return { date, value, ...(estimated ? { estimated: true } : {}) };
    })
  );
  return bridgeInteriorEstimates(
    points.filter((p): p is HistoryPoint => p !== null).sort((a, b) => (a.date < b.date ? -1 : 1))
  );
}

const dayMs = (date: string) => Date.parse(`${date}T00:00:00Z`);

/**
 * Replaces every run of estimated points that has a real point on BOTH sides
 * with a straight line between those two real points (still `estimated`, so it
 * draws dashed). Leading and trailing estimates are left alone. Expects
 * date-sorted points and returns a new array; never mutates its input
 * (withTodayPoint's input shares point objects with the caller's).
 *
 * Inside a hole between two recorded days the backward walk is worse than the
 * line: it starts from today's accounts, so it can't see a since-closed account
 * and holds flat accounts at today's balance, both errors in LEVEL that change
 * on the day money moves between a seen and an unseen account. One hole showed a
 * 22% dip that never happened (a deleted manual 401k rolled into a linked IRA);
 * shifting the walk to meet both ends still drew a 9% dip and an 11% hump. The
 * line is exact at both ends and can't invent a swing; it costs only the timing
 * of events inside the hole, which the dashed style already says are unknown.
 *
 * For the TOTAL only: a single account's walk is that account's own flows, so
 * getAccountHistory keeps it.
 */
export function bridgeInteriorEstimates(points: HistoryPoint[]): HistoryPoint[] {
  const out = points.slice();
  let lastReal = -1;
  for (let i = 0; i < out.length; i++) {
    if (out[i].estimated) continue;
    if (lastReal >= 0 && i - lastReal > 1) {
      const from = out[lastReal];
      const to = out[i];
      const t0 = dayMs(from.date);
      const span = dayMs(to.date) - t0;
      for (let j = lastReal + 1; j < i; j++) {
        const f = span > 0 ? (dayMs(out[j].date) - t0) / span : 0;
        const value = Math.round((from.value + (to.value - from.value) * f) * 100) / 100;
        out[j] = { date: out[j].date, value, estimated: true };
      }
    }
    lastReal = i;
  }
  return out;
}

/**
 * Puts today's live figure into the history series.
 *
 * /api/net-worth starts getHistory() concurrently with the Plaid fetch, so its
 * result has no point for today, or a stale one from an earlier load, and the
 * chart would disagree with the total above it.
 *
 * `visible` is the value to write, not `netWorth`: it is the same hidden-account
 * subtraction getHistory applies to every point, done on today's live balances.
 *
 * Only called when the snapshot landed, so the chart never shows a figure the
 * history layer doesn't have, and a total containing balances recovered by
 * lib/last-known.ts (display-only) can never be charted as if measured today.
 *
 * Bridged again afterwards: today's point can be the real one that closes a
 * hole, turning trailing estimates into interior ones.
 */
export function withTodayPoint(
  history: HistoryPoint[],
  today: string,
  visible: number
): HistoryPoint[] {
  const rest = history.filter((p) => p.date !== today);
  rest.push({ date: today, value: visible });
  return bridgeInteriorEstimates(rest.sort((a, b) => (a.date < b.date ? -1 : 1)));
}

// Forgetting an earlier account (#46)

/** Rewrites one field only if it still holds what was read. */
export const HISTORY_CAS_FIELD = `-- nya:history-cas-field
if redis.call('HGET', KEYS[1], ARGV[1]) ~= ARGV[2] then return 0 end
redis.call('HSET', KEYS[1], ARGV[1], ARGV[3])
return 1`;
/** Rewrites a plain value only if it still holds what was read. */
export const HISTORY_CAS_VALUE = `-- nya:history-cas-value
if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end
redis.call('SET', KEYS[1], ARGV[2])
return 1`;


/**
 * Whether a value failed to decrypt for good (damaged, or not what this code
 * can read) rather than for now (the key store unreachable, a key this
 * deployment can't open yet). Forgetting treats the first as "holds nothing
 * anyone can read" and stops on the second, to be retried.
 */
function unreadableForGood(err: unknown): boolean {
  return err instanceof MalformedCiphertextError || err instanceof DecryptFailedError || err instanceof SyntaxError;
}

/**
 * Removes one account's balances from every per-account layer, for a user
 * forgetting an earlier account (lib/links.ts forgetEarlierAccount checks it
 * may be forgotten, and for a hidden one has already folded it out of the
 * totals, foldHiddenAccount). The net-worth TOTALS are not touched here: for
 * an account that wasn't hidden they were the user's net worth on those
 * dates. Also removes the zeros a fold left in its place.
 *
 * Each map is rewritten only if it still holds what was read (a backfill can
 * rewrite estimated dates at any time), re-read and retried if not, several
 * dates at a time; every version read is evicted from the decrypted cache. A
 * map that can't be decrypted for good holds nothing anyone can read: it is
 * left as it is, and its date reported. Any other failure stops it, to be run
 * again. Safe to run again.
 */
export async function forgetAccountBalances(
  ctx: Ctx,
  account_id: string,
  /** Only today's date, in the layers written today (a second pass). */
  opts: { today?: boolean } = {}
): Promise<{ changed: number; unreadableDates: string[] }> {
  let changed = 0;
  const unreadable = new Set<string>();
  const hashes = [ACCOUNTS_HASH(ctx), ACCOUNTS_EST_HASH(ctx), ACCOUNTS_EST_EXT_HASH(ctx), ACCOUNTS_PARTIAL_HASH(ctx), ACCOUNTS_EST_FLAT_BY_DATE(ctx)];

  // Decrypted once each (the pre-check below fills this; a map re-read after
  // a lost compare-and-set is decrypted then). 'unreadable': for good.
  const read = new Map<string, Record<string, number> | 'unreadable'>();
  const decryptOnce = async (blob: string): Promise<Record<string, number> | 'unreadable'> => {
    const known = read.get(blob);
    if (known) return known;
    let map: Record<string, number> | 'unreadable';
    try {
      map = JSON.parse(await decrypt(blob)) as Record<string, number>;
    } catch (err) {
      if (!unreadableForGood(err)) throw err;
      map = 'unreadable';
    }
    read.set(blob, map);
    return map;
  };

  // Without the account, or null when it isn't in the map.
  const without = async (blob: string): Promise<string | null | 'unreadable'> => {
    evictDecrypted(blob);
    const map = await decryptOnce(blob);
    if (map === 'unreadable') return 'unreadable';
    if (!map || typeof map !== 'object' || !(account_id in map)) return null;
    const { [account_id]: _gone, ...rest } = map;
    return encrypt(JSON.stringify(rest));
  };

  const scrub = async (key: string, date: string, first: string) => {
    let blob: string | null = first;
    for (let attempt = 0; blob !== null; attempt++) {
      const next = await without(blob);
      if (next === 'unreadable') {
        unreadable.add(date);
        return;
      }
      if (next === null) return;
      if (Number(await redis().eval(HISTORY_CAS_FIELD, [key], [date, blob, next])) === 1) {
        changed++;
        return;
      }
      if (attempt >= 3) throw new Error(`history: ${date} kept changing while an account was being forgotten`);
      blob = await redis().hget<string>(key, date);
    }
  };

  if (opts.today) {
    const today = new Date().toISOString().slice(0, 10);
    for (const key of [ACCOUNTS_HASH(ctx), ACCOUNTS_PARTIAL_HASH(ctx)]) {
      const blob = await redis().hget<string>(key, today);
      if (blob) await scrub(key, today, blob);
    }
    return { changed, unreadableDates: [...unreadable] };
  }

  const all = await Promise.all(hashes.map(async (key) => [key, Object.entries((await redis().hgetall<Record<string, string>>(key)) ?? {})] as const));
  const legacyFirst = await redis().get<string>(ACCOUNTS_EST_FLAT_LEGACY(ctx));
  // Every map decrypted before any is rewritten: one that can't be read for
  // now stops it here, with nothing changed, rather than half way through.
  for (const [, entries] of all) for (const [, blob] of entries) await decryptOnce(blob);
  if (legacyFirst) await decryptOnce(legacyFirst);
  for (const [key, entries] of all) {
    for (let i = 0; i < entries.length; i += FORGET_BATCH) {
      await Promise.all(entries.slice(i, i + FORGET_BATCH).map(([date, blob]) => scrub(key, date, blob)));
    }
  }

  // The single pre-per-date flat record, if this environment still has one.
  for (let attempt = 0; ; attempt++) {
    const blob = await redis().get<string>(ACCOUNTS_EST_FLAT_LEGACY(ctx));
    if (!blob) break;
    const next = await without(blob);
    if (next === 'unreadable') {
      unreadable.add('before per-date records');
      break;
    }
    if (next === null) break;
    if (Number(await redis().eval(HISTORY_CAS_VALUE, [ACCOUNTS_EST_FLAT_LEGACY(ctx)], [blob, next])) === 1) {
      changed++;
      break;
    }
    if (attempt >= 3) throw new Error('history: the flat record kept changing while an account was being forgotten');
  }
  return { changed, unreadableDates: [...unreadable].sort() };
}

/** How many dates are rewritten at once while forgetting an account. */
const FORGET_BATCH = 16;

/** Deletes a field only if it still holds what was read. */
export const HISTORY_DELETE_IF = `-- nya:history-delete-if
if redis.call('HGET', KEYS[1], ARGV[1]) ~= ARGV[2] then return 0 end
redis.call('HDEL', KEYS[1], ARGV[1])
return 1`;

/** Writes a field only when it is absent. */
export const HISTORY_SET_IF_ABSENT = `-- nya:history-set-if-absent
if redis.call('HEXISTS', KEYS[1], ARGV[1]) == 1 then return 0 end
redis.call('HSET', KEYS[1], ARGV[1], ARGV[2])
return 1`;

/**
 * Folds one point, all at once: rewrites (or deletes) a total and rewrites
 * the per-account maps it is read with, only if every one still holds what
 * was read, and marks the point done. KEYS: total hash, progress key, then
 * the map hashes. ARGV: date, progress field, expected total ('' = absent),
 * new total ('' = keep, '-' = delete), then for each map its expected and new
 * value. Answers 1 when done, 2 when the point was already folded (by an
 * earlier attempt still finishing), 0 when anything changed since it was read.
 */
export const HISTORY_FOLD = `-- nya:history-fold
local date = ARGV[1]
if redis.call('HEXISTS', KEYS[2], ARGV[2]) == 1 then return 2 end
if (redis.call('HGET', KEYS[1], date) or '') ~= ARGV[3] then return 0 end
for i = 3, #KEYS do
  if (redis.call('HGET', KEYS[i], date) or '') ~= ARGV[5 + (i - 3) * 2] then return 0 end
end
if ARGV[4] == '-' then redis.call('HDEL', KEYS[1], date)
elseif ARGV[4] ~= '' then redis.call('HSET', KEYS[1], date, ARGV[4]) end
for i = 3, #KEYS do
  local old, new = ARGV[5 + (i - 3) * 2], ARGV[6 + (i - 3) * 2]
  if new ~= old and new ~= '' then redis.call('HSET', KEYS[i], date, new) end
end
redis.call('HSET', KEYS[2], ARGV[2], '1')
return 1`;

/**
 * Takes a HIDDEN account out of every past total for good, before it is
 * forgotten (lib/links.ts forgetEarlierAccount): each point's stored total is
 * lowered by what the account contributed (hiddenContribution) and the account
 * is set to 0 in the per-account maps that point is read with, in ONE step per
 * point (HISTORY_FOLD). At every moment a point is either untouched (the chart
 * subtracts the still-hidden account as before) or folded (the account is there
 * with nothing, so the chart subtracts nothing and drops nothing): never counted
 * twice, never missing.
 *
 * Set to 0 rather than removed while it is still hidden: removed, a flat-only
 * estimated point would read as "can't tell" and drop out of the chart, and a
 * retry would no longer see the account in the maps that give its life.
 * forgetAccountBalances removes the zeros once the hidden entry is gone.
 *
 * A point the chart drops while the account is hidden (contribution can't be
 * told) is deleted if it falls within the account's known life, and left alone
 * outside it. Deleting a real point also deletes that date's estimated total,
 * which would otherwise appear in its place.
 *
 * Totals and breakdowns are written breakdown first everywhere else
 * (recordSnapshot, the backfill), so a fold running beside one reads a new
 * breakdown with an old total, takes nothing out, and the new total that follows
 * never had the account; never the reverse.
 *
 * Before any point, the pre-per-date flat record is copied to each estimated
 * date still relying on it, so points can be folded one at a time.
 *
 * Progress is kept under `tag` (FOLD_PROGRESS) so a retry skips what is done;
 * the caller deletes it when the forget finishes (dropFoldProgress). Stops,
 * changing nothing more, on anything that can't be read for now.
 */
export async function foldHiddenAccount(
  ctx: Ctx,
  account_id: string,
  type: string,
  tag: string,
  life: { first: string | null; last: string | null } = { first: null, last: null }
): Promise<{ folded: number; deleted: number }> {
  const progress = FOLD_PROGRESS(ctx, tag);
  const strict = async (blob: string | null | undefined): Promise<Record<string, number> | null | 'unreadable'> => {
    if (!blob) return null;
    try {
      return await decryptMap(blob);
    } catch (err) {
      if (unreadableForGood(err)) return 'unreadable';
      throw err;
    }
  };

  // 1. The legacy flat record, split per date where it is still what applies.
  const [legacyBlob, estTotals0, flatd0] = await Promise.all([
    redis().get<string>(ACCOUNTS_EST_FLAT_LEGACY(ctx)),
    redis().hgetall<Record<string, string>>(ESTIMATED_HASH(ctx)),
    redis().hgetall<Record<string, string>>(ACCOUNTS_EST_FLAT_BY_DATE(ctx)),
  ]);
  const legacy = await strict(legacyBlob);
  if (legacyBlob && legacy && legacy !== 'unreadable' && account_id in legacy) {
    for (const date of Object.keys(estTotals0 ?? {})) {
      if (flatd0?.[date]) continue;
      await redis().eval(HISTORY_SET_IF_ABSENT, [ACCOUNTS_EST_FLAT_BY_DATE(ctx)], [date, legacyBlob]);
    }
  }

  // 2. Its known life, from every layer that names it, and the directory's.
  const layers = await Promise.all(
    [ACCOUNTS_HASH(ctx), ACCOUNTS_EST_HASH(ctx), ACCOUNTS_EST_EXT_HASH(ctx), ACCOUNTS_PARTIAL_HASH(ctx), ACCOUNTS_EST_FLAT_BY_DATE(ctx)].map(
      async (key) => (await redis().hgetall<Record<string, string>>(key)) ?? {}
    )
  );
  let first = life.first;
  let last = life.last;
  for (const layer of layers) {
    for (const [date, blob] of Object.entries(layer)) {
      const map = await strict(blob);
      if (!map || map === 'unreadable' || !(account_id in map)) continue;
      if (!first || date < first) first = date;
      if (!last || date > last) last = date;
    }
  }
  const withinLife = (date: string) => !!first && !!last && date >= first && date <= last;

  // 3. Every point, real and estimated, one step each.
  const [realTotals, estTotals, done] = await Promise.all([
    redis().hgetall<Record<string, string>>(HISTORY_HASH(ctx)),
    redis().hgetall<Record<string, string>>(ESTIMATED_HASH(ctx)),
    redis().hkeys(progress),
  ]);
  const finished = new Set(done);
  const points = [
    ...Object.keys(realTotals ?? {}).map((date) => ({ date, estimated: false })),
    ...Object.keys(estTotals ?? {}).map((date) => ({ date, estimated: true })),
  ].filter((p) => !finished.has(`${p.estimated ? 'e' : 'r'}:${p.date}`));

  let folded = 0;
  let deleted = 0;
  const foldOne = async ({ date, estimated }: { date: string; estimated: boolean }) => {
    const totalKey = estimated ? ESTIMATED_HASH(ctx) : HISTORY_HASH(ctx);
    const mapKeys = estimated ? [ACCOUNTS_EST_HASH(ctx), ACCOUNTS_EST_FLAT_BY_DATE(ctx)] : [ACCOUNTS_HASH(ctx)];
    for (let attempt = 0; ; attempt++) {
      const [total, ...blobs] = await Promise.all([totalKey, ...mapKeys].map((k) => redis().hget<string>(k, date)));
      const maps = await Promise.all(blobs.map(strict));

      // What it contributed, as the chart works it out; null: can't tell.
      let c: number | null;
      if (!estimated) {
        const m = maps[0];
        c = !m || m === 'unreadable' ? null : typeof m[account_id] === 'number' ? signedContribution(type, m[account_id]) : 0;
      } else {
        const [est, flat] = maps;
        const flatMap = flat === null ? (legacy === 'unreadable' ? 'unreadable' : legacy ?? {}) : flat;
        if (flatMap === 'unreadable') c = null;
        else if (typeof flatMap[account_id] === 'number') c = signedContribution(type, flatMap[account_id]);
        else if (!est || est === 'unreadable') c = null;
        else c = typeof est[account_id] === 'number' ? signedContribution(type, est[account_id]) : 0;
      }

      let newTotal = '';
      if (total) {
        if (c === null) {
          if (withinLife(date)) newTotal = '-';
        } else if (c !== 0) {
          let value: number;
          try {
            value = Number(await decrypt(total));
          } catch (err) {
            if (!unreadableForGood(err)) throw err;
            value = NaN; // unreadable for good: dropped from the chart anyway
          }
          if (Number.isFinite(value)) newTotal = await encrypt(String(value - c));
        }
      }
      const pairs: string[] = [];
      for (let i = 0; i < mapKeys.length; i++) {
        const m = maps[i];
        let next = blobs[i] ?? '';
        if (m && m !== 'unreadable' && account_id in m && m[account_id] !== 0) {
          next = await encrypt(JSON.stringify({ ...m, [account_id]: 0 }));
        }
        pairs.push(blobs[i] ?? '', next);
      }
      const answer = Number(
        await redis().eval(HISTORY_FOLD, [totalKey, progress, ...mapKeys], [date, `${estimated ? 'e' : 'r'}:${date}`, total ?? '', newTotal, ...pairs])
      );
      if (answer === 2) return; // folded already, by an attempt still finishing
      if (answer === 1) {
        for (const b of blobs) if (b) evictDecrypted(b);
        folded++;
        if (newTotal === '-') {
          deleted++;
          if (!estimated) await deleteEstimateOn(date);
        }
        return;
      }
      if (attempt >= 3) throw new Error(`history: ${date} kept changing while an account was being forgotten`);
    }
  };
  const deleteEstimateOn = async (date: string) => {
    for (let attempt = 0; attempt < 4; attempt++) {
      const blob = await redis().hget<string>(ESTIMATED_HASH(ctx), date);
      if (!blob) return;
      if (Number(await redis().eval(HISTORY_DELETE_IF, [ESTIMATED_HASH(ctx)], [date, blob])) === 1) return;
    }
    throw new Error(`history: the estimate for ${date} kept changing while an account was being forgotten`);
  };
  for (let i = 0; i < points.length; i += FORGET_BATCH) {
    // Every point of a batch settled before anything is reported: a failure
    // must not return (and free the lock) while others are still writing.
    const settled = await Promise.allSettled(points.slice(i, i + FORGET_BATCH).map(foldOne));
    const failed = settled.find((r): r is PromiseRejectedResult => r.status === 'rejected');
    if (failed) throw failed.reason;
  }
  return { folded, deleted };
}

/** Deletes a finished fold's progress record. */
export async function dropFoldProgress(ctx: Ctx, tag: string): Promise<void> {
  await redis().del(FOLD_PROGRESS(ctx, tag));
}
