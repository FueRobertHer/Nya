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
// Per-account balances are kept alongside both, which is what lets a single
// account be charted and a hidden one be subtracted from past totals. Those
// have a third layer of their own (`history:accounts:est:ext`, see below): an
// investment account can be walked back further than any total can honestly be
// stated, and that span belongs to the chart only. And a fourth
// (`history:accounts:partial`): balances measured on a day one institution
// failed, so no total could be recorded but every other account still was.
//
// Every layer is a Redis hash keyed by UTC date (YYYY-MM-DD), values encrypted
// with the same AES-256-GCM key as everything else financial, so a
// database-only leak doesn't expose your net-worth series either.

import { createHash } from 'node:crypto';
import { redis, kc } from './storage';
import type { Ctx } from './containers';
import { encrypt, decrypt, MalformedCiphertextError, DecryptFailedError } from './crypto';
import { type HiddenMap } from './hidden';
import { signedContribution } from './balance';

const HISTORY_HASH = (ctx: Ctx) => kc(ctx, 'history:net-worth');
const ESTIMATED_HASH = (ctx: Ctx) => kc(ctx, 'history:net-worth:est');
// Per-account balances, one JSON map { account_id: balance } per date, so
// individual accounts can be charted too.
const ACCOUNTS_HASH = (ctx: Ctx) => kc(ctx, 'history:accounts');
const ACCOUNTS_EST_HASH = (ctx: Ctx) => kc(ctx, 'history:accounts:est');
// Per-account balances for dates BEYOND the estimated totals layer: backfill
// walks an investment account past the oldest cash transaction, where its own
// flows still have data but no total can honestly be stated (see reconstruct in
// lib/backfill.ts).
//
// Its own key rather than more dates in ACCOUNTS_EST_HASH, and this is the
// whole reason it exists. That hash is not just "per-account history": every
// date in it is the account-by-account breakdown OF the estimated total for
// that date, and the hidden-account subtraction in getHistory reads it as such.
// The extension covers dates older than the newest run's totals -- exactly
// where an EARLIER run's totals are retained (replaceRange only deletes from
// the new run's oldest point forward) -- so writing there would answer "what
// was in this total" with balances from a different run's walk, and hiding an
// account would then subtract the wrong number from a point nothing rewrites.
// Kept apart, it feeds the per-account chart and nothing else.
const ACCOUNTS_EST_EXT_HASH = (ctx: Ctx) => kc(ctx, 'history:accounts:est:ext');
// Per-account balances MEASURED on a day the total could not be recorded: one
// institution failed, so recordSnapshot wrote nothing, but every other
// institution answered and its balances are as real as any snapshot's.
// Without this, one broken bank turned every other account's chart into an
// estimate for as long as it stayed broken (23 days, once).
//
// Its own key rather than ACCOUNTS_HASH because that hash means something this
// one does not: each date there is the account-by-account breakdown of a
// recorded TOTAL, and getHistory subtracts hidden accounts from that total by
// reading it. A partial map is the breakdown of no total. getLatestAccountSnapshot
// must not read it either: it relies on its newest date naming every account
// that existed, and a partial map by definition leaves the failing
// institution's accounts out. Feeds the per-account chart and nothing else.
const ACCOUNTS_PARTIAL_HASH = (ctx: Ctx) => kc(ctx, 'history:accounts:partial');

/** The measured per-account layers' keys, for lib/links.ts, which reads them to
 *  date accounts. One place for the names. */
export const measuredAccountHistoryKeys = (ctx: Ctx) => [ACCOUNTS_HASH(ctx), ACCOUNTS_PARTIAL_HASH(ctx)];
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
const ACCOUNTS_EST_FLAT_BY_DATE = (ctx: Ctx) => kc(ctx, 'history:accounts:est:flatd');
// The pre-per-date single record. Still read, never written: it's the only
// thing that can describe estimated points written before this key existed.
// A different key name rather than a reshape, because the old one is a plain
// string and the new one a hash -- Redis would reject the write.
const ACCOUNTS_EST_FLAT_LEGACY = (ctx: Ctx) => kc(ctx, 'history:accounts:est:flat');
// Which points a forget of a hidden account has already folded (see
// foldHiddenAccount), under the forget's random tag: dates only, deleted when
// the forget finishes. What lets a retry skip what is done.
const FOLD_PROGRESS = (ctx: Ctx, tag: string) => kc(ctx, `history:forgetting:${tag}`);
const BACKFILL_FLAG = (ctx: Ctx) => kc(ctx, 'history:backfill-done');
// How many runs in a row have finished with an Item's investment data still
// importing. Backfill withholds the done-flag in that state so the next load
// rebuilds with the flows once they arrive, and this is what stops that being
// unbounded: PRODUCT_NOT_READY is supposed to clear in minutes, but a wedged
// extraction would otherwise re-run a full multi-institution Plaid pull on
// every app open, forever.
const BACKFILL_PENDING_TRIES = (ctx: Ctx) => kc(ctx, 'history:backfill-pending');

export type HistoryPoint = { date: string; value: number; estimated?: boolean };

/**
 * Records today's total, and the per-account breakdown behind it.
 *
 * Returns THE DATE KEY IT WROTE, or null if nothing landed. Two callers need
 * more than "it worked": /api/ingest/balance tells a script whether the chart
 * was updated, and /api/net-worth charts today's point itself (see
 * withTodayPoint) and must label it with the same day this wrote, not a second
 * reading of the clock that could fall on the other side of UTC midnight.
 *
 * THE TWO WRITES FAIL INDEPENDENTLY, and only the first decides the answer.
 * They were one try/catch returning a single boolean, which made a total that
 * landed indistinguishable from one that didn't whenever the per-account write
 * failed after it -- a state lib/history.ts already documents as reachable and
 * getHistory already handles. A caller told "nothing was recorded" would hide a
 * point that is genuinely in the chart's own layer. So: if the total lands the
 * date comes back, and a failed breakdown costs only the breakdown.
 */
export async function recordSnapshot(ctx: Ctx, 
  netWorth: number,
  accountBalances?: Record<string, number>
): Promise<string | null> {
  const today = new Date().toISOString().slice(0, 10);

  try {
    await redis().hset(HISTORY_HASH(ctx), { [today]: await encrypt(String(netWorth)) });
  } catch {
    // Best-effort: a missed snapshot just leaves a gap in the chart.
    return null;
  }

  if (accountBalances && Object.keys(accountBalances).length > 0) {
    try {
      await redis().hset(ACCOUNTS_HASH(ctx), { [today]: await encrypt(JSON.stringify(accountBalances)) });
    } catch {
      // The total is in the chart either way. What's lost is the ability to
      // subtract a hidden account from THIS date later, which getHistory
      // already handles by dropping the point it can't correct. Today's
      // partial map, if any, is left alone below, so the per-account charts
      // still have something measured for today.
      return today;
    }
    // This map now supersedes any partial one written earlier today. Clearing
    // it is what lets getAccountHistory read a partial map that sits beside a
    // real one as the NEWER measurement: it can only have been written after
    // the last snapshot. Best-effort: if this fails, an earlier partial reading
    // shows for today in place of this one, which costs one day's precision.
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
 * MERGED into anything already stored for today, because loads on a bad day
 * can fail differently: a bank that answered at 9am and not at noon keeps its
 * 9am balance. Newer values win for the same account.
 *
 * Skips the write, rather than starting from empty, whenever today's existing
 * map can't be read or decrypted: overwriting would replace a fuller map with a
 * smaller one, and a decrypt failure can be transient (a data key that didn't
 * load). The cost of skipping is at most this one load's values.
 *
 * Two partial writes racing on the same day can lose one's values (both read,
 * last write wins). Accepted: it costs part of one day's per-account points,
 * and a field per account would put account ids in plaintext.
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
  encode: (p: any) => Promise<string>,
  /** An extra date from which to clear, even where the run wrote no points --
   *  for a layer whose dates are only valid while no other layer covers them.
   *  Without it, "wrote nothing" means "keep everything", which is right for a
   *  layer that stands alone and wrong for one that must yield. */
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
    // No new points and no floor means nothing was reconstructable this run --
    // keep every stored point rather than blanking the layer.
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

export async function replaceEstimated(ctx: Ctx, points: { date: string; value: number }[]): Promise<void> {
  await replaceRange(ESTIMATED_HASH(ctx), points, (p) => encrypt(String(p.value)));
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
export async function replaceEstimatedFlat(ctx: Ctx, 
  points: { date: string; balances: Record<string, number> }[]
): Promise<void> {
  await replaceRange(ACCOUNTS_EST_FLAT_BY_DATE(ctx), points, (p) =>
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
export async function estimatedLayerCovers(ctx: Ctx, account_id: string): Promise<boolean> {
  if (account_id in ((await getEstimatedFlat(ctx)) ?? {})) return true;
  try {
    const flatByDate = await redis().hgetall<Record<string, string>>(ACCOUNTS_EST_FLAT_BY_DATE(ctx));
    // Newest date, for the same reason as the walked map below.
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
    // The NEWEST date, not an arbitrary one. Any date used to answer for all of
    // them, because backfill seeded every cash account before the walk and
    // rewrote the layer wholesale. Retention broke that: points older than the
    // newest run's window are kept and carry whatever account set was linked
    // back then, so an arbitrary sample can under-report a cash account --
    // harmless in itself, since it only forces a recompute that wasn't needed,
    // but it forces one on hides that didn't need it.
    //
    // The newest date is written by the newest run and holds every account it
    // walked, which is what the caller is asking about: it hides a currently
    // linked account. Over-reporting would be the dangerous direction (a
    // skipped recompute leaves a cliff in the chart) and requires the account
    // to be missing from the newest window, where the flat record checked just
    // above already accounts for it.
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
 * `{}` and `null` mean different things and callers must not conflate them.
 * `{}` is "backfill ran and folded no non-cash accounts in", so subtracting
 * nothing is correct. `null` is "we can't read what was baked in", where
 * subtracting nothing would silently shift the whole estimated region by the
 * hidden balance.
 */
export async function getEstimatedFlat(ctx: Ctx): Promise<Record<string, number> | null> {
  try {
    const blob = await redis().get<string>(ACCOUNTS_EST_FLAT_LEGACY(ctx));
    if (!blob) return {}; // never written (layer predates this key) -- genuinely empty
    return JSON.parse(await decrypt(blob)) as Record<string, number>;
  } catch {
    return null; // unreadable: the caller must not treat this as "nothing to subtract"
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
 * per-account map on every load while anything is hidden, and a hidden
 * account stays hidden for good (including past a disconnect, #46), so without
 * this the same year of immutable maps is decrypted again on every dashboard
 * load. Keyed by a digest of the ciphertext, so a rewritten map (a backfill,
 * a re-encryption, a forgotten account) is a different key and never served
 * stale, and one container's entries can't answer for another's. Least
 * recently used entries go first, within a byte budget; forgetting an account
 * evicts the maps it rewrote (evictDecrypted), so its balances don't stay in
 * memory.
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
    return await decryptMap(blob);
  } catch {
    return null;
  }
}

/** Same, for the per-account estimated layer -- and range-scoped for the same
 *  reason, so retained total points keep the per-date maps that hidden-account
 *  subtraction reads for those dates. */
export async function replaceEstimatedAccounts(ctx: Ctx, 
  points: { date: string; balances: Record<string, number> }[]
): Promise<void> {
  await replaceRange(ACCOUNTS_EST_HASH(ctx), points, (p) => encrypt(JSON.stringify(p.balances)));
}

/**
 * Replaces the per-account extension layer (ACCOUNTS_EST_EXT_HASH): the span an
 * investment account's own flows reach past the cash horizon.
 *
 * Range-scoped like every other layer, so a run that reaches less far back than
 * an earlier one leaves that earlier era's points alone rather than truncating
 * the chart.
 *
 * `coveredFrom` is this run's full-walk horizon, and it is what keeps the two
 * layers from disagreeing. The extension only means anything on dates the
 * estimated layer can't speak for, and which dates those are changes run to
 * run: link a bank with a longer transaction history and the full walk now
 * covers a span the extension used to own. getAccountHistory prefers the
 * extension where both have a date, so anything left behind there would shadow
 * the newer walk -- the account's chart would read from one run up to the old
 * seam and another after it, with a step at the join that is pure artifact.
 * So the extension is cleared from this horizon forward even on a run that
 * produces no extension points at all, which is the common case.
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
      const blob = await redis().hget<string>(ACCOUNTS_HASH(ctx), date);
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
 * Resolved PER ACCOUNT, not per date. The three layers answer for different
 * account sets on the same date: the extension names only the investment
 * accounts walked past the cash horizon, so picking a whole map per date would
 * drop a cash account's retained point on any date the extension also covers.
 * Asking each layer for this one account in turn keeps every layer's coverage.
 *
 * Extension over estimated, because where both have a date the extension is the
 * newer run: the estimated layer keeps points from an era whose walk reached
 * further back, and mixing two walks inside one line is what the precedence is
 * here to avoid.
 *
 * A partial measurement (ACCOUNTS_PARTIAL_HASH) comes FIRST for the accounts
 * it names, even over a real map for the same date. recordSnapshot clears the
 * day's partial map whenever it writes a real one, so a partial map beside a
 * real map was written after it: the newer measurement of the same day, and
 * possibly of an account that appeared after the snapshot. It only speaks for
 * the accounts it names, though. One that leaves this account out says its
 * institution failed at that moment, not that the account was gone, so the
 * other layers still get their turn in the usual order.
 */
export async function getAccountHistory(ctx: Ctx, 
  account_id: string,
  /** Earlier ids of the SAME account (lib/links.ts), newest first. On each
   *  date the current id wins, then these in order, so history recorded under
   *  an id the account had before a reconnect joins up with its current one. */
  olderIds: string[] = []
): Promise<HistoryPoint[]> {
  const ids = [account_id, ...olderIds.filter((id) => id !== account_id)];
  const [realMap, partialMap, estMap, extMap] = await Promise.all([
    redis().hgetall<Record<string, string>>(ACCOUNTS_HASH(ctx)),
    redis().hgetall<Record<string, string>>(ACCOUNTS_PARTIAL_HASH(ctx)),
    redis().hgetall<Record<string, string>>(ACCOUNTS_EST_HASH(ctx)),
    redis().hgetall<Record<string, string>>(ACCOUNTS_EST_EXT_HASH(ctx)),
  ]);

  /** This account's balance in one encrypted per-account map, under the first
   *  of its ids the map names, or null when the map is unreadable or names none. */
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
        // A real map that names none of the account's ids is an answer, not a
        // gap: the account wasn't there that day. Falling through to an estimate would
        // put a reconstructed figure on a date that was actually measured.
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
//   3 - an investment account whose flows out-run its balance is floored at
//       zero instead of dropped back to flat, and its own series is walked past
//       the cash horizon. Both make a large arrival (a rollover) visible on the
//       account's chart where it previously was not.
//   4 - a contribution booked as a single buy (or a payout as a single sell)
//       with no cash row beside it counts as money crossing the boundary
//       (countedTrades in lib/investments.ts). Before, the walk read each as an
//       internal trade and carried every 401k paycheck back into the past.
//   5 - an in-kind transfer reported with amount 0 is valued from its quantity
//       and price; deposit, transfer and withdrawal trades count under the
//       same rule as contributions, with sell/transfer as money out so an
//       exchange nets to zero; and that rule is judged from cash rows within
//       45 days of each trade. Investment rows come from the stored history
//       (lib/invstore.ts).
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
 * says whether to stop waiting.
 *
 * True means give up and accept the reconstruction as it stands (investment
 * accounts held flat, which is what every run did before the retry existed).
 * A failure to count returns true for the same reason: the retry is an
 * optimization, and an uncountable one is an unbounded one.
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
 * What one hidden account contributed to one point, signed as it was added
 * to the total; null when that can't be told, and the point must be dropped.
 * The one rule for it, used to subtract a hidden account (getHistory) and to
 * record what a forgotten hidden account contributed (forgetAccountBalances).
 *
 * REAL points: the per-account map recorded with the total. A real date with
 * no per-account map can't be corrected. This is reachable: recordSnapshot
 * writes the total and the map as two separate awaits, so the first can land
 * and the second fail. Showing the point would put a single-day spike the
 * size of the hidden account into the chart, so it is dropped instead and the
 * line interpolates across one day.
 *
 * ESTIMATED points: the estimated layer splits every account across two
 * sources, and exactly one of them applies: cash accounts have a per-date
 * balance (the transaction walk), everything else has a constant flat balance
 * (backfill's `rest` term). So a miss in one is only correct if the other is
 * readable and genuinely doesn't list the account. Resolved per date: two
 * runs can leave two eras of points in this layer, each with its own flat
 * balances, and an account can be flat in one era and walked in the next.
 * An unreadable flat record, or a missing per-date map for an account not in
 * it, means nothing here can be trusted. Absent from a map that could be read
 * means the account was never in these points (linked after the last
 * backfill): nothing to remove.
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
export async function getHistory(ctx: Ctx, hidden?: HiddenMap): Promise<HistoryPoint[]> {
  const hiding = !!hidden && hidden.size > 0;

  // The per-account maps are only read when something is actually hidden.
  // Decrypting a year of them on every dashboard load to subtract nothing would
  // be pure waste, and nothing hidden is the common case.
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
 * with a straight line between those two real points. Still `estimated`, so it
 * still draws dashed. Leading and trailing estimates are left alone. Expects
 * date-sorted points and returns a new array; never mutates what it is given
 * (withTodayPoint's input shares point objects with the caller's).
 *
 * WHY. Inside a hole between two recorded days, the backward walk is a worse
 * answer than the line. The walk starts from today's accounts, so it cannot see
 * an account that has since been closed or deleted, and it holds manual and
 * other flat accounts at today's balance. Both are errors in LEVEL that change
 * on the day money moves between a seen and an unseen account. The one hole
 * this was written for showed a 22% dip that never happened: a manually tracked
 * 401k, since deleted, was rolled into a linked IRA mid-hole. Keeping the walk's
 * shape and shifting it to meet both real ends was tried on that data and still
 * drew a 9% dip followed by an 11% hump. The line is exact at both ends and
 * cannot invent a swing. What it costs is the timing of real events inside the
 * hole, which the dashed style already says are not known.
 *
 * For the TOTAL only. A single account's walk has neither error (it is that
 * account's own flows), so getAccountHistory keeps it.
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
 * /api/net-worth starts getHistory() concurrently with the Plaid fetch, so what
 * comes back cannot include the snapshot recorded moments later in the same
 * request: it holds either no point for today at all, or the one an earlier
 * load wrote hours ago. Both would draw a chart that disagrees with the total
 * printed above it.
 *
 * `visible` is the right value to write, not `netWorth`: getHistory subtracts
 * hidden accounts from every point it returns, and visible is that same
 * subtraction performed on today's live balances.
 *
 * Only called when the snapshot actually landed, which is what keeps this
 * honest in both directions. A point appears in the chart exactly when one was
 * stored, so the chart never shows a figure the history layer doesn't have. And
 * because a snapshot is only recorded on a clean fetch, a total containing
 * balances recovered by lib/last-known.ts can never reach here -- charting one
 * would draw last week's figure as though it had been measured today, the one
 * thing that module's display-only rule exists to prevent.
 *
 * Bridged again afterwards: today's point can be the real one that closes a
 * hole, turning estimates getHistory left trailing into interior ones.
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

// ---------------------------------------------------------------------------
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
 * may be forgotten, and for a hidden one records its contribution first,
 * foldHiddenAccount). The net-worth TOTALS are left exactly as they
 * are: they were the user's net worth on those dates.
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
 * value. Answers 1 when done, 0 when anything changed since it was read.
 */
export const HISTORY_FOLD = `-- nya:history-fold
local date = ARGV[1]
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
 * lowered by what the account contributed to it, by the rule the chart uses
 * to subtract it (hiddenContribution), and the account is removed from the
 * per-account maps that point is read with, in ONE step per point
 * (HISTORY_FOLD). So at every moment each point is either untouched (and the
 * still-hidden account is subtracted by the chart as before) or folded (and
 * the account is simply not there): never counted twice, never missing.
 *
 * A point the chart drops while the account is hidden (what it contributed
 * can't be told) is deleted if it falls within the account's known life, and
 * left alone outside it, where the account can't be in it.
 *
 * Before any point, the single pre-per-date flat record is copied to each
 * estimated date that still relies on it (the same record, so every point
 * reads exactly what it read before), so points can be folded one at a time.
 *
 * Progress is kept under `tag` (FOLD_PROGRESS), so a retry skips what is done;
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
        if (m && m !== 'unreadable' && account_id in m) {
          const { [account_id]: _gone, ...rest } = m;
          next = await encrypt(JSON.stringify(rest));
        }
        pairs.push(blobs[i] ?? '', next);
      }
      const answer = Number(
        await redis().eval(HISTORY_FOLD, [totalKey, progress, ...mapKeys], [date, `${estimated ? 'e' : 'r'}:${date}`, total ?? '', newTotal, ...pairs])
      );
      if (answer === 1) {
        for (const b of blobs) if (b) evictDecrypted(b);
        folded++;
        if (newTotal === '-') deleted++;
        return;
      }
      if (attempt >= 3) throw new Error(`history: ${date} kept changing while an account was being forgotten`);
    }
  };
  for (let i = 0; i < points.length; i += FORGET_BATCH) {
    await Promise.all(points.slice(i, i + FORGET_BATCH).map(foldOne));
  }
  return { folded, deleted };
}

/** Deletes a finished fold's progress record. */
export async function dropFoldProgress(ctx: Ctx, tag: string): Promise<void> {
  await redis().del(FOLD_PROGRESS(ctx, tag));
}
