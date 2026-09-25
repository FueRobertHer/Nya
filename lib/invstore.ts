// lib/invstore.ts
//
// Per-Item store of investment transactions, so the money-added line, the
// year-to-date figures and the backfill walk can reach past Plaid's window and
// keep working through an outage.
//
// WHY THIS IS NOT lib/transactions.ts AGAIN. The cash store rests on
// /transactions/sync, which hands over a cursor and explicit added, modified and
// removed lists. /investments/transactions/get is a date-range query with none
// of that: no cursor, no removal signal, offset pagination, and account ids that
// rotate on reauth. Every rule below exists because the obvious approach loses
// rows nothing can re-serve. They were found by two reviews of this design, in
// this order of danger:
//
// 1. A FAILURE NEVER MAKES ANYTHING WORSE. A Plaid error returns no rows for
//    the ranges it cut off, and reading that as "everything was deleted" is
//    the obvious mistake. Only ranges that were answered AND verified judge or
//    cover anything; what was answered before a failure is kept.
// 2. NOTHING IS EVER DELETED. A row is only EXCLUDED, and only once two
//    verified syncs at least a day apart both covered its account and date and
//    neither returned it. It comes back the moment a sync returns it again.
//    Absence on one fetch proves nothing: an institution can omit an account,
//    return a short page, or re-key rows. Excluding instead of deleting means
//    even a wrong call costs a hidden row, never a lost one.
// 3. ONLY A VERIFIED ANSWER COUNTS AS EVIDENCE, range by range. Offset
//    pagination skips a row whenever the list shifts between pages (a pending
//    trade settling does it). So a range is split by date until each request
//    fits in one page; a range is verified only if its answer held exactly the
//    total it reported, with no duplicate ids. Anything else is upserted, which
//    is always safe, and proves nothing about its own dates only.
// 4. COVERAGE IS PER ACCOUNT AND ONLY FROM VERIFIED FETCHES. The store claims to
//    hold every row of an account for [from, through] and nothing more, so a
//    reader can tell a quiet month from an unfetched one.
// 5. ONE SYNC PER ITEM AT A TIME, and a disconnected Item stays disconnected: a
//    lock around read-fetch-write, and a check after writing that the Item
//    still exists.
//
// Account-id rotation is NOT remapped here. Rows stay under the old id: kept,
// exported, never excluded (an account absent from a response is never judged),
// just not shown on the new account. Remapping can be added later from this
// data; doing it now risks merging two accounts for good, since masks repeat.
//
// Deleted with the Item on disconnect (clearInvestmentStore). A full relink
// makes a new Item and a new, empty store, so history kept past Plaid's window
// is lost for that institution, as with the cash store.

import type { AccountBase, InvestmentTransaction, Security } from 'plaid';
import { plaidClient } from './plaid';
import { decrypt } from './crypto';
import { redis, k, getItems, type StoredItem } from './storage';
import { encodeJsonBlob, decodeJsonBlob, maxBlobChars, blobWarnChars } from './blob';
import { containerLabel, forgetBlobSize, recordBlobSize } from './blob-sizes';
import { classifyFetchError, isPendingSubtype, toInvestmentTxn, type InvestmentTxn } from './investments';

export const INVSTORE_SCHEMA = 1;
const PAGE_SIZE = 500;
// Requests per sync, as a runaway guard. A range splits in two whenever its
// total overflows one page, so this allows tens of thousands of rows.
const MAX_REQUESTS = 80;
// How far back a first fill asks. Plaid serves roughly 24 months.
const FILL_DAYS = 730;
// The window every later sync re-verifies.
const WINDOW_DAYS = 365;
// Missing in two verified syncs this far apart before a row is excluded.
const CONFIRM_MS = 24 * 60 * 60 * 1000;
const FRESH_MS = 15 * 60 * 1000;
const LOCK_MS = 120_000;
// How long one sync may spend asking Plaid, so a first fill of a busy Item
// stops and keeps what it has instead of running into the platform's time limit
// and losing all of it. The rest is asked for on the next sync.
const FETCH_BUDGET_MS = 40_000;

const DAY = 86_400_000;
const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const dayMs = (date: string) => Date.parse(`${date}T00:00:00Z`);
const addDays = (date: string, n: number) => isoDay(dayMs(date) + n * DAY);

type SecuritySnapshot = {
  name: string | null;
  ticker_symbol: string | null;
  type: string | null;
  is_cash_equivalent: boolean | null;
  cusip: string | null;
  isin: string | null;
  iso_currency_code: string | null;
};

export type StoredInvRow = {
  /** Every field Plaid sent, kept whole: past Plaid's window nothing can re-fetch it. */
  raw: InvestmentTransaction;
  /** Last day a sync returned it. */
  seen_at: string;
  /** First verified sync that covered it and didn't return it. */
  missing_since?: string;
  /** Excluded from every reader: confirmed missing, or named by a cancel row. */
  excluded?: boolean;
};

type AccountMeta = {
  name: string | null;
  official_name: string | null;
  mask: string | null;
  type: string | null;
  subtype: string | null;
  /** Day of the last VERIFIED sync the account appeared in. */
  last_seen: string | null;
};

export type Coverage = { from: string; through: string };

export type InvStoreState = {
  schema_version: number;
  txns: Record<string, StoredInvRow>;
  securities: Record<string, SecuritySnapshot>;
  accounts: Record<string, AccountMeta>;
  coverage: Record<string, Coverage>;
  /** Last VERIFIED sync. */
  synced_at: string | null;
  verified_at: string | null;
  /** Last sync whose fetch worked, verified or not: what freshness is judged by. */
  attempted_at?: string | null;
  /** Ids named by a cancel row, with the day it was seen. Never served again. */
  cancelled?: Record<string, string>;
};

export class InvStoreUnreadableError extends Error {
  constructor(readonly item_id: string, readonly reason: unknown) {
    super(`invstore: stored state for ${item_id} is unreadable`);
    this.name = 'InvStoreUnreadableError';
  }
}

const stateKey = (item_id: string) => k(`invtxns:${item_id}`);
const lockKey = (item_id: string) => k(`invtxns-lock:${item_id}`);

function emptyState(): InvStoreState {
  return {
    schema_version: INVSTORE_SCHEMA,
    txns: {},
    securities: {},
    accounts: {},
    coverage: {},
    synced_at: null,
    verified_at: null,
    attempted_at: null,
    cancelled: {},
  };
}

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);

/**
 * The stored state. An absent key is the ONLY empty start. A failed read, an
 * undecodable blob, a shape this code doesn't recognise, or a NEWER schema all
 * throw: the caller must not write over any of them (a newer schema would lose
 * the fields this code doesn't know on a rollback).
 */
export async function readInvStore(item_id: string): Promise<InvStoreState> {
  let blob: string | null;
  try {
    blob = await redis().get<string>(stateKey(item_id));
  } catch (err) {
    throw new InvStoreUnreadableError(item_id, err);
  }
  if (!blob) return emptyState();
  let parsed: any;
  try {
    parsed = await decodeJsonBlob<any>(blob);
  } catch (err) {
    throw new InvStoreUnreadableError(item_id, err);
  }
  if (
    !isPlainObject(parsed) ||
    typeof parsed.schema_version !== 'number' ||
    parsed.schema_version > INVSTORE_SCHEMA ||
    !isPlainObject(parsed.txns) ||
    !isPlainObject(parsed.accounts) ||
    !isPlainObject(parsed.coverage) ||
    !isPlainObject(parsed.securities) ||
    (parsed.cancelled !== undefined && !isPlainObject(parsed.cancelled))
  ) {
    throw new InvStoreUnreadableError(item_id, new Error('unrecognised shape or newer schema'));
  }
  return parsed as InvStoreState;
}

type WriteOutcome = 'written' | 'oversize' | 'error' | 'item-gone';

async function writeInvStore(item_id: string, state: InvStoreState): Promise<WriteOutcome> {
  try {
    const encoded = await encodeJsonBlob(state);
    // Refused, never trimmed: dropping the oldest rows would drop exactly the
    // ones no fetch can bring back (the same call as lib/transactions.ts).
    if (encoded.length > maxBlobChars()) {
      console.error(
        `invstore: refusing to persist ${item_id} in ${await containerLabel()}: blob is ${encoded.length} chars, over the ${maxBlobChars()} ceiling. Nothing was written or dropped.`
      );
      return 'oversize';
    }
    if (encoded.length > blobWarnChars()) {
      console.warn(`invstore: ${item_id} blob is ${encoded.length} chars, past 60% of the ceiling`);
    }
    await redis().set(stateKey(item_id), encoded);
    // A disconnect that landed while this sync was running would otherwise be
    // undone here, leaving an orphaned blob of financial data that every export
    // then carries. Checked AFTER writing, so the window is closed rather than
    // narrowed: whichever finishes second, the key ends up gone.
    if (!(await getItems()).some((i) => i.item_id === item_id)) {
      await redis().del(stateKey(item_id));
      await forgetBlobSize('invtxns', item_id);
      return 'item-gone';
    }
    await recordBlobSize('invtxns', item_id, encoded.length);
    return 'written';
  } catch (err) {
    console.warn(`invstore: failed to persist ${item_id}; the next sync will retry`, err);
    return 'error';
  }
}

/** Deletes an Item's stored investment transactions. Call on disconnect. */
export async function clearInvestmentStore(item_id: string): Promise<void> {
  try {
    await redis().del(stateKey(item_id), lockKey(item_id));
  } catch {
    // Best effort, like clearItemTransactions.
  }
  await forgetBlobSize('invtxns', item_id);
}

/** Account ids the store knows for an Item, for disconnect's hidden-set cleanup. */
export async function storedInvestmentAccountIds(item_id: string): Promise<string[]> {
  try {
    return Object.keys((await readInvStore(item_id)).accounts);
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Fetching

/**
 * One date range a single request (or, for one crowded day, a run of offset
 * pages) answered. Verified when the answer provably held every row Plaid has
 * for those dates. `present` is the accounts that answer listed: only for them
 * does a missing row mean anything.
 */
type Segment = { from: string; to: string; verified: boolean; present: string[] };

type WindowFetch = {
  rows: InvestmentTransaction[];
  securities: Security[];
  /** Metadata for every account any response listed. */
  accounts: AccountBase[];
  /** What was answered, range by range. Verification is per segment: one
   *  crowded or failed range no longer makes the rest prove nothing. */
  segments: Segment[];
  /** Every range of the window was asked, with no failure and no budget cut. */
  complete: boolean;
  note: string | null;
  pending: boolean;
};

/**
 * Every raw row in [start, end], split by date so that no request needs an
 * offset. A range whose total overflows one page is halved and each half asked
 * again, NEWEST HALF FIRST, so a fetch cut short by a failure or the budget has
 * still covered the recent dates that matter most. A single day with more rows
 * than a page is read with offsets and verified only if every page reported the
 * same total and the ids add up to it.
 *
 * Stops asking once MAX_REQUESTS or the time budget is spent (a first fill of a
 * busy Item can't be allowed to run past the platform's time limit, which would
 * lose all of it), and on the first Plaid error. Either way what was answered
 * is returned, so the caller can keep it.
 *
 * `beforeEachRequest` runs before every Plaid call; the sync uses it to keep
 * its lock alive through a long first fill.
 */
async function fetchWindow(
  access_token: string,
  start: string,
  end: string,
  beforeEachRequest: () => Promise<void> = async () => {},
  budgetMs: number = FETCH_BUDGET_MS
): Promise<WindowFetch> {
  const rows: InvestmentTransaction[] = [];
  const securities = new Map<string, Security>();
  const accounts = new Map<string, AccountBase>();
  const segments: Segment[] = [];
  const deadline = Date.now() + budgetMs;
  let requests = 0;
  let complete = true;

  const ask = async (from: string, to: string, offset = 0) => {
    await beforeEachRequest();
    requests++;
    const res = await plaidClient.investmentsTransactionsGet({
      access_token,
      start_date: from,
      end_date: to,
      options: { count: PAGE_SIZE, offset, async_update: true },
    });
    for (const s of res.data.securities || []) securities.set(s.security_id, s);
    const listed: string[] = [];
    for (const a of res.data.accounts || []) {
      accounts.set(a.account_id, a);
      listed.push(a.account_id);
    }
    return {
      page: res.data.investment_transactions || [],
      total: res.data.total_investment_transactions,
      listed,
    };
  };

  const take = (page: InvestmentTransaction[], from: string, to: string) => {
    // Out-of-range rows are never stored: nothing could later replace them.
    for (const t of page) if (t.date >= from && t.date <= to) rows.push(t);
  };

  const outOfBudget = () => requests >= MAX_REQUESTS || Date.now() >= deadline;

  const fetchRange = async (from: string, to: string): Promise<void> => {
    if (outOfBudget()) {
      complete = false;
      return;
    }
    const { page, total, listed } = await ask(from, to);
    const hasTotal = typeof total === 'number';
    if (!hasTotal && page.length < PAGE_SIZE) {
      // No total to compare against: this range proves nothing. A short page is
      // still everything it has, so take it rather than splitting down to
      // single days on a response that will never report one.
      take(page, from, to);
      segments.push({ from, to, verified: false, present: listed });
      return;
    }
    if (hasTotal && total <= PAGE_SIZE) {
      take(page, from, to);
      segments.push({ from, to, verified: page.length === total, present: listed });
      return;
    }
    if (from === to) {
      // One crowded day: offsets are the only way. Verified only if the total
      // held still across every page and the ids received add up to it, which
      // catches a row skipped by a shift unless a delete and an insert cancel
      // out exactly between two pages; marking still needs two syncs a day
      // apart, so that rare case costs nothing permanent.
      take(page, from, to);
      const ids = new Set(page.map((r) => r.investment_transaction_id));
      let present = new Set(listed);
      let steady = hasTotal;
      let offset = page.length;
      while (hasTotal && offset < total) {
        if (outOfBudget()) {
          complete = false;
          steady = false;
          break;
        }
        const next = await ask(from, to, offset);
        if (next.total !== total) steady = false;
        present = new Set(next.listed.filter((id) => present.has(id)));
        if (next.page.length === 0) break;
        take(next.page, from, to);
        for (const r of next.page) ids.add(r.investment_transaction_id);
        offset += next.page.length;
      }
      segments.push({ from, to, verified: steady && ids.size === total, present: [...present] });
      return;
    }
    const mid = isoDay(dayMs(from) + Math.floor((dayMs(to) - dayMs(from)) / DAY / 2) * DAY);
    await fetchRange(addDays(mid, 1), to); // newest half first
    await fetchRange(from, mid);
  };

  let note: string | null = null;
  let pending = false;
  try {
    await fetchRange(start, end);
  } catch (err) {
    ({ note, pending } = classifyFetchError(err));
    complete = false;
  }

  // A duplicate id means two answers overlapped or a page repeated: neither
  // range it appeared in proves anything.
  const seen = new Map<string, number>();
  for (const r of rows) seen.set(r.investment_transaction_id, (seen.get(r.investment_transaction_id) ?? 0) + 1);
  const dupDates = rows.filter((r) => (seen.get(r.investment_transaction_id) ?? 0) > 1).map((r) => r.date);
  for (const seg of segments) {
    if (dupDates.some((d) => d >= seg.from && d <= seg.to)) seg.verified = false;
  }

  return {
    rows,
    securities: [...securities.values()],
    accounts: [...accounts.values()],
    segments,
    complete,
    note,
    pending,
  };
}

// ---------------------------------------------------------------------------
// Merging

/** Fold one fetch into a copy of the state. Only called for a fetch with no note. */
export function mergeFetch(
  prev: InvStoreState,
  fetch: WindowFetch,
  window: { from: string; to: string },
  now: number
): InvStoreState {
  const state: InvStoreState = JSON.parse(JSON.stringify(prev));
  const nowIso = new Date(now).toISOString();
  const today = isoDay(now);

  // Securities: field by field, never a known value replaced by an unknown one.
  for (const s of fetch.securities) {
    const old = state.securities[s.security_id];
    const pick = <T>(next: T | null | undefined, prior: T | null | undefined) =>
      next ?? prior ?? null;
    state.securities[s.security_id] = {
      name: pick(s.name, old?.name),
      ticker_symbol: pick(s.ticker_symbol, old?.ticker_symbol),
      type: pick(s.type, old?.type),
      is_cash_equivalent: pick(s.is_cash_equivalent, old?.is_cash_equivalent),
      cusip: pick(s.cusip, old?.cusip),
      isin: pick(s.isin, old?.isin),
      iso_currency_code: pick(s.iso_currency_code, old?.iso_currency_code),
    };
  }

  const returned = new Set(fetch.rows.map((r) => r.investment_transaction_id));
  // Ids named by a cancel row are tombstoned for good, not just excluded now:
  // cancel rows aren't stored, so a later partial fetch that returns the
  // original without its cancel would otherwise serve the cancelled trade again.
  state.cancelled ??= {};
  // A cancel row tombstones the id it names and its own: Plaid can also cancel
  // a trade by re-issuing it under the same id typed `cancel`, and
  // cancel_transaction_id is a legacy field that is usually null.
  for (const r of fetch.rows) {
    if (String(r.type).toLowerCase() !== 'cancel') continue;
    state.cancelled[r.investment_transaction_id] ??= today;
    if (r.cancel_transaction_id) state.cancelled[r.cancel_transaction_id] ??= today;
  }
  const cancelled = state.cancelled;

  // Upserts are always safe. Pending rows, cancel rows and cancelled originals
  // are never stored as live rows.
  for (const r of fetch.rows) {
    if (String(r.type).toLowerCase() === 'cancel' || isPendingSubtype(String(r.subtype))) continue;
    if (cancelled[r.investment_transaction_id]) continue;
    state.txns[r.investment_transaction_id] = { raw: r, seen_at: today };
  }
  for (const id of Object.keys(cancelled)) {
    const row = state.txns[id];
    if (row && !row.excluded) state.txns[id] = { ...row, excluded: true, missing_since: row.missing_since ?? nowIso };
  }
  // Any fetch that worked counts as an attempt, verified or not, so an Item
  // that can never be verified isn't re-fetched from Plaid on every request.
  state.attempted_at = nowIso;

  // Account metadata from any response; `last_seen` only where a verified
  // segment listed the account.
  const verifiedSegs = fetch.segments.filter((g) => g.verified);
  const verifiedFor = new Set(verifiedSegs.flatMap((g) => g.present));
  for (const a of fetch.accounts) {
    state.accounts[a.account_id] = {
      name: a.name ?? null,
      official_name: a.official_name ?? null,
      mask: a.mask ?? null,
      type: a.type ? String(a.type) : null,
      subtype: a.subtype ? String(a.subtype) : null,
      last_seen: verifiedFor.has(a.account_id) ? today : state.accounts[a.account_id]?.last_seen ?? null,
    };
  }

  // Judge absence only where a VERIFIED segment answered for the row's date and
  // listed its account, and only from that account's oldest returned row on:
  // before it the institution may simply keep less history. Each segment
  // proves its own dates; a crowded, failed or unasked range proves nothing
  // and judges nothing, instead of voiding the whole fetch.
  const oldest = new Map<string, string>();
  for (const r of fetch.rows) {
    const prior = oldest.get(r.account_id);
    if (!prior || r.date < prior) oldest.set(r.account_id, r.date);
  }
  const provenFor = (account: string, date: string) =>
    verifiedSegs.some((g) => date >= g.from && date <= g.to && g.present.includes(account));
  for (const [id, row] of Object.entries(state.txns)) {
    if (returned.has(id) || cancelled[id] || !row?.raw) continue;
    const account = row.raw.account_id;
    const from = oldest.get(account);
    const judged = !!from && row.raw.date >= from && row.raw.date <= window.to && provenFor(account, row.raw.date);
    if (!judged) {
      // Not judged here: an unconfirmed mark can only be confirmed by a later
      // verified answer for its date, so drop it rather than leave it hanging.
      if (row.missing_since && !row.excluded) state.txns[id] = { raw: row.raw, seen_at: row.seen_at };
      continue;
    }
    if (row.excluded) continue;
    if (!row.missing_since) {
      state.txns[id] = { ...row, missing_since: nowIso };
    } else if (now - Date.parse(row.missing_since) >= CONFIRM_MS) {
      state.txns[id] = { ...row, excluded: true };
    }
  }

  // Coverage, per account, from the verified segments that listed it: joined
  // into runs of adjacent dates, and joined to what the account already had
  // wherever they touch. When nothing touches, the most recent run replaces it
  // (a gap: older coverage can no longer be claimed as one span with it).
  const accountsWithProof = new Set(verifiedSegs.flatMap((g) => g.present));
  for (const account of accountsWithProof) {
    const runs: Coverage[] = [];
    for (const g of verifiedSegs.filter((x) => x.present.includes(account)).sort((x, y) => (x.from < y.from ? -1 : 1))) {
      const last = runs[runs.length - 1];
      if (last && g.from <= addDays(last.through, 1)) {
        if (g.to > last.through) last.through = g.to;
      } else runs.push({ from: g.from, through: g.to });
    }
    let cov = state.coverage[account] ? { ...state.coverage[account] } : null;
    const touches = (r: Coverage, c: Coverage) =>
      r.from <= addDays(c.through, 1) && r.through >= addDays(c.from, -1);
    if (cov && runs.some((r) => touches(r, cov!))) {
      for (const r of runs) {
        if (!touches(r, cov)) continue;
        if (r.from < cov.from) cov.from = r.from;
        if (r.through > cov.through) cov.through = r.through;
      }
    } else if (runs.length) {
      cov = runs[runs.length - 1];
    }
    if (cov) state.coverage[account] = cov;
  }

  // A clean sync: every range asked, every answer verified. Only this counts
  // as fresh for the backfill, and dates the whole Item's last full check.
  if (fetch.complete && fetch.segments.length > 0 && fetch.segments.every((g) => g.verified)) {
    state.verified_at = nowIso;
    state.synced_at = nowIso;
  }
  return state;
}

/** The range the next sync should verify. */
export function nextWindow(state: InvStoreState, now: number): { from: string; to: string } {
  const today = isoDay(now);
  const floor = addDays(today, -FILL_DAYS);
  // The accounts the latest verified answer listed: closed or rotated-away
  // accounts drop out, so they can't hold the Item in fill mode forever.
  const latestSeen = Object.values(state.accounts).reduce<string | null>(
    (max, a) => (a.last_seen && (!max || a.last_seen > max) ? a.last_seen : max),
    null
  );
  const current = Object.entries(state.accounts)
    .filter(([, a]) => latestSeen && a.last_seen === latestSeen)
    .map(([id]) => id);
  const filling =
    current.length === 0 || current.some((id) => !state.coverage[id] || state.coverage[id].from > addDays(floor, 1));
  if (filling) return { from: floor, to: today };
  // Reach back to the oldest coverage end, so a long absence is re-verified
  // rather than left as a gap, but never further than Plaid can serve.
  const oldestThrough = current.map((id) => state.coverage[id].through).sort()[0];
  const want = addDays(today, -WINDOW_DAYS);
  const from = oldestThrough < want ? oldestThrough : want;
  return { from: from < floor ? floor : from, to: today };
}

// ---------------------------------------------------------------------------
// The sync callers use

export type InvSync = {
  /** Clean rows for readers: never pending, never a cancel, never excluded. */
  rows: InvestmentTxn[];
  coverage: Record<string, Coverage>;
  /** A Plaid failure (rows are whatever was stored before it). */
  note: string | null;
  pending: boolean;
  /** A storage problem; the rows are still good for this request. */
  storeNote: string | null;
  /** Rows marked missing but not yet confirmed, by account: evidence still pending. */
  unconfirmed: Record<string, string[]>;
  /** Their ids. Readers still show them (a glitch must not hide a real row),
   *  but the backfill leaves them out of its walk: right after Plaid re-keys a
   *  batch, the old copies sit here for a day, and walking both would count
   *  every flow twice in a history that is never rebuilt. */
  unconfirmedIds: string[];
  /** Another sync held the lock, so this answer is whatever was stored. The
   *  backfill must wait rather than walk a store that is mid-fill. */
  busy: boolean;
};

function view(state: InvStoreState): Pick<InvSync, 'rows' | 'coverage' | 'unconfirmed' | 'unconfirmedIds'> {
  const rows: InvestmentTxn[] = [];
  const unconfirmed: Record<string, string[]> = {};
  const unconfirmedIds: string[] = [];
  for (const row of Object.values(state.txns)) {
    // A malformed row is skipped, not fatal: it stays stored, untouched.
    if (!row?.raw?.investment_transaction_id || row.excluded) continue;
    rows.push(toInvestmentTxn(row.raw, state.securities));
    if (row.missing_since) {
      (unconfirmed[row.raw.account_id] ??= []).push(row.raw.date);
      unconfirmedIds.push(row.raw.investment_transaction_id);
    }
  }
  return { rows, coverage: state.coverage, unconfirmed, unconfirmedIds };
}

/**
 * Brings an Item's store up to date and returns what it holds.
 *
 * Never throws for a Plaid or storage problem: those come back as `note` and
 * `storeNote`. Returns stored rows during a Plaid outage, and live rows (not
 * written) when the store can't be read or another sync holds the lock.
 */
export async function syncInvestments(
  item: StoredItem,
  opts: {
    maxAgeMs?: number;
    now?: number;
    /** Only a VERIFIED sync counts as fresh. For the backfill, whose runs are
     *  capped: a run that served an unverified store without fetching again
     *  would spend a retry and make no progress. */
    freshOnlyIfVerified?: boolean;
  } = {}
): Promise<InvSync> {
  const now = opts.now ?? Date.now();
  const maxAgeMs = opts.maxAgeMs ?? FRESH_MS;
  const token = crypto.randomUUID();
  let locked = false;
  try {
    locked = (await redis().set(lockKey(item.item_id), token, { nx: true, px: LOCK_MS })) === 'OK';
  } catch {
    locked = false;
  }

  try {
    let state: InvStoreState | null = null;
    let storeNote: string | null = null;
    try {
      state = await readInvStore(item.item_id);
    } catch (err) {
      console.error((err as Error).message, (err as InvStoreUnreadableError).reason);
      storeNote = 'Saved investment history could not be read';
    }

    const lastTry = opts.freshOnlyIfVerified ? state?.synced_at : state?.attempted_at ?? state?.synced_at;
    const fresh = !!lastTry && now - Date.parse(lastTry) < maxAgeMs;
    if (state && (fresh || !locked)) {
      return { ...view(state), note: null, pending: false, storeNote, busy: !fresh && !locked };
    }

    let access_token: string;
    try {
      access_token = await decrypt(item.encrypted_access_token);
    } catch {
      const base = state ? view(state) : { rows: [], coverage: {}, unconfirmed: {}, unconfirmedIds: [] };
      return { ...base, note: 'Could not decrypt stored credentials', pending: false, storeNote, busy: false };
    }

    const window = nextWindow(state ?? emptyState(), now);
    // Refresh the lock before every request: a first fill can make dozens of
    // calls, each allowed the full Plaid timeout, and a lock that lapsed mid-fill
    // would let a second sync start from the same state.
    const keepAlive = async () => {
      if (!locked) return;
      try {
        if ((await redis().get(lockKey(item.item_id))) === token) {
          await redis().set(lockKey(item.item_id), token, { px: LOCK_MS });
        }
      } catch {
        // The lock still holds until its expiry; the next request tries again.
      }
    };
    const fetched = await fetchWindow(access_token, window.from, window.to, keepAlive);

    // Rule 1: a failure never makes anything worse. With nothing answered
    // there is nothing to write. With some ranges answered before it (or before
    // the budget ran out), those are kept: upserts are always safe, and only
    // the ranges that verified judge or cover anything.
    const failure = fetched.note ? { note: fetched.note, pending: fetched.pending } : null;
    if (failure && fetched.rows.length === 0 && fetched.segments.length === 0) {
      const base = state ? view(state) : { rows: [], coverage: {}, unconfirmed: {}, unconfirmedIds: [] };
      return { ...base, ...failure, storeNote, busy: false };
    }
    const unverified = fetched.segments.filter((g) => !g.verified).length;
    if (unverified || !fetched.complete) {
      console.warn(
        `invstore: ${item.item_id} fetch of ${window.from}..${window.to}: ${unverified} unverified range(s)${fetched.complete ? '' : ', not every range asked'}; those upsert only`
      );
    }
    const answer = failure ?? { note: null, pending: false };

    const merged = mergeFetch(state ?? emptyState(), fetched, window, now);
    // Unreadable store, or another sync running: answer from this fetch alone.
    if (!state || !locked) return { ...view(merged), ...answer, storeNote, busy: !locked };

    // Still ours? A lock that lapsed or was taken over means another sync may
    // have written since this one read, and writing now would undo its marks.
    let stillOurs = false;
    try {
      stillOurs = (await redis().get(lockKey(item.item_id))) === token;
    } catch {
      stillOurs = false;
    }
    if (!stillOurs) return { ...view(merged), ...answer, storeNote, busy: true };

    const outcome = await writeInvStore(item.item_id, merged);
    if (outcome === 'oversize') {
      storeNote = 'Investment history is too large to save; showing live data';
    }
    return { ...view(merged), ...answer, storeNote, busy: false };
  } finally {
    if (locked) {
      try {
        if ((await redis().get(lockKey(item.item_id))) === token) await redis().del(lockKey(item.item_id));
      } catch {
        // The lock expires on its own.
      }
    }
  }
}
