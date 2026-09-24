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
// 1. A FAILED FETCH NEVER WRITES. A Plaid error returns no rows. Merging that
//    would read as "everything was deleted".
// 2. NOTHING IS EVER DELETED. A row is only EXCLUDED, and only once two
//    verified syncs at least a day apart both covered its account and date and
//    neither returned it. It comes back the moment a sync returns it again.
//    Absence on one fetch proves nothing: an institution can omit an account,
//    return a short page, or re-key rows. Excluding instead of deleting means
//    even a wrong call costs a hidden row, never a lost one.
// 3. ONLY A VERIFIED FETCH COUNTS AS EVIDENCE. Offset pagination skips a row
//    whenever the list shifts between pages (a pending trade settling does it).
//    So a range is split by date until each request fits in one page and no
//    offset is ever used; a fetch is verified only if every request returned
//    exactly the total it reported, with no duplicate ids. Anything else is
//    upserted, which is always safe, and proves nothing.
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
        `invstore: refusing to persist ${item_id}: blob is ${encoded.length} chars, over the ${maxBlobChars()} ceiling. Nothing was written or dropped.`
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
      return 'item-gone';
    }
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

type WindowFetch = {
  rows: InvestmentTransaction[];
  securities: Security[];
  /** Metadata for every account any response listed. */
  accounts: AccountBase[];
  /** Accounts EVERY response listed: the only ones whose absence of rows means
   *  anything. One request that leaves an account out says nothing about its
   *  rows in that request's dates, so the account is not judged at all. */
  present: string[];
  /** Every request returned exactly the total it reported, with no duplicates. */
  verified: boolean;
  note: string | null;
  pending: boolean;
};

/**
 * Every raw row in [start, end], split by date so that no request needs an
 * offset. A range whose total overflows one page is halved and each half asked
 * again; only a single day with more rows than a page falls back to offsets,
 * and that makes the whole fetch unverified.
 *
 * `beforeEachRequest` runs before every Plaid call; the sync uses it to keep
 * its lock alive through a long first fill.
 */
async function fetchWindow(
  access_token: string,
  start: string,
  end: string,
  beforeEachRequest: () => Promise<void> = async () => {}
): Promise<WindowFetch> {
  const rows: InvestmentTransaction[] = [];
  const securities = new Map<string, Security>();
  const accounts = new Map<string, AccountBase>();
  let present: Set<string> | null = null;
  let verified = true;
  let requests = 0;

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
    const listed = new Set<string>();
    for (const a of res.data.accounts || []) {
      accounts.set(a.account_id, a);
      listed.add(a.account_id);
    }
    present = present ? new Set([...present].filter((id) => listed.has(id))) : listed;
    return {
      page: res.data.investment_transactions || [],
      total: res.data.total_investment_transactions,
    };
  };

  const take = (page: InvestmentTransaction[], from: string, to: string) => {
    // Out-of-range rows are never stored: nothing could later replace them.
    for (const t of page) if (t.date >= from && t.date <= to) rows.push(t);
  };

  const fetchRange = async (from: string, to: string): Promise<void> => {
    if (requests >= MAX_REQUESTS) {
      verified = false;
      return;
    }
    const { page, total } = await ask(from, to);
    if (typeof total !== 'number') {
      // No total to compare against: this range proves nothing. A short page is
      // still everything it has, so take it rather than splitting down to
      // single days on a response that will never report one.
      verified = false;
      if (page.length < PAGE_SIZE) {
        take(page, from, to);
        return;
      }
    }
    if (typeof total === 'number' && total <= PAGE_SIZE) {
      if (page.length !== total) verified = false;
      take(page, from, to);
      return;
    }
    if (from === to) {
      // One day with more rows than a page: offsets are the only way, and they
      // can skip. Take what comes and prove nothing with it.
      verified = false;
      take(page, from, to);
      let offset = page.length;
      while (typeof total === 'number' && offset < total && requests < MAX_REQUESTS) {
        const next = await ask(from, to, offset);
        if (next.page.length === 0) break;
        take(next.page, from, to);
        offset += next.page.length;
      }
      return;
    }
    const mid = isoDay(dayMs(from) + Math.floor((dayMs(to) - dayMs(from)) / DAY / 2) * DAY);
    await fetchRange(from, mid);
    await fetchRange(addDays(mid, 1), to);
  };

  try {
    await fetchRange(start, end);
  } catch (err) {
    const { note, pending } = classifyFetchError(err);
    return { rows: [], securities: [], accounts: [], present: [], verified: false, note, pending };
  }

  // Unique ids: a duplicate means two requests overlapped or a page repeated.
  if (new Set(rows.map((r) => r.investment_transaction_id)).size !== rows.length) verified = false;
  return {
    rows,
    securities: [...securities.values()],
    accounts: [...accounts.values()],
    present: [...(present ?? [])],
    verified,
    note: null,
    pending: false,
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

  // Account metadata from any successful response; `last_seen` only from a verified one.
  for (const a of fetch.accounts) {
    state.accounts[a.account_id] = {
      name: a.name ?? null,
      official_name: a.official_name ?? null,
      mask: a.mask ?? null,
      type: a.type ? String(a.type) : null,
      subtype: a.subtype ? String(a.subtype) : null,
      last_seen: fetch.verified ? today : state.accounts[a.account_id]?.last_seen ?? null,
    };
  }

  if (!fetch.verified) return state;

  // Judge absence per account, only for accounts EVERY request listed that
  // returned at least one row, and only from that account's oldest returned row
  // on: before it the institution may simply keep less history.
  const present = new Set(fetch.present);
  const oldest = new Map<string, string>();
  for (const r of fetch.rows) {
    const prior = oldest.get(r.account_id);
    if (!prior || r.date < prior) oldest.set(r.account_id, r.date);
  }
  for (const [id, row] of Object.entries(state.txns)) {
    if (returned.has(id) || cancelled[id] || !row?.raw) continue;
    const account = row.raw.account_id;
    const from = oldest.get(account);
    const judged = present.has(account) && !!from && row.raw.date >= from && row.raw.date <= window.to;
    if (!judged) {
      // Out of range: an unconfirmed mark can no longer be confirmed, so drop it.
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

  // Coverage: every account every request listed, rows or not, now holds all
  // of [window.from, window.to]. Joined to what it had if the two touch.
  for (const account of present) {
    const cov = state.coverage[account];
    state.coverage[account] =
      cov && window.from <= addDays(cov.through, 1)
        ? {
            from: cov.from < window.from ? cov.from : window.from,
            through: cov.through > window.to ? cov.through : window.to,
          }
        : { from: window.from, through: window.to };
  }
  state.verified_at = nowIso;
  state.synced_at = nowIso;
  return state;
}

/** The range the next sync should verify. */
export function nextWindow(state: InvStoreState, now: number): { from: string; to: string } {
  const today = isoDay(now);
  const floor = addDays(today, -FILL_DAYS);
  const lastVerifiedDay = state.verified_at?.slice(0, 10) ?? null;
  const current = Object.entries(state.accounts)
    .filter(([, a]) => lastVerifiedDay && a.last_seen === lastVerifiedDay)
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
  /** Another sync held the lock, so this answer is whatever was stored. The
   *  backfill must wait rather than walk a store that is mid-fill. */
  busy: boolean;
};

function view(state: InvStoreState): Pick<InvSync, 'rows' | 'coverage' | 'unconfirmed'> {
  const rows: InvestmentTxn[] = [];
  const unconfirmed: Record<string, string[]> = {};
  for (const row of Object.values(state.txns)) {
    // A malformed row is skipped, not fatal: it stays stored, untouched.
    if (!row?.raw?.investment_transaction_id || row.excluded) continue;
    rows.push(toInvestmentTxn(row.raw, state.securities));
    if (row.missing_since) (unconfirmed[row.raw.account_id] ??= []).push(row.raw.date);
  }
  return { rows, coverage: state.coverage, unconfirmed };
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
      storeNote = 'Saved investment history could not be read; showing live data only';
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
      const base = state ? view(state) : { rows: [], coverage: {}, unconfirmed: {} };
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

    // Rule 1: a failed fetch never writes.
    if (fetched.note) {
      const base = state ? view(state) : { rows: [], coverage: {}, unconfirmed: {} };
      return { ...base, note: fetched.note, pending: fetched.pending, storeNote, busy: false };
    }
    if (!fetched.verified) {
      console.warn(
        `invstore: ${item.item_id} fetch of ${window.from}..${window.to} was not verifiable (${fetched.rows.length} rows); upserting only`
      );
    }

    const merged = mergeFetch(state ?? emptyState(), fetched, window, now);
    // Unreadable store, or another sync running: answer from this fetch alone.
    if (!state || !locked) return { ...view(merged), note: null, pending: false, storeNote, busy: !locked };

    // Still ours? A lock that lapsed or was taken over means another sync may
    // have written since this one read, and writing now would undo its marks.
    let stillOurs = false;
    try {
      stillOurs = (await redis().get(lockKey(item.item_id))) === token;
    } catch {
      stillOurs = false;
    }
    if (!stillOurs) return { ...view(merged), note: null, pending: false, storeNote, busy: true };

    const outcome = await writeInvStore(item.item_id, merged);
    if (outcome === 'oversize') {
      storeNote = 'Investment history is too large to save; showing live data';
    }
    return { ...view(merged), note: null, pending: false, storeNote, busy: false };
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
