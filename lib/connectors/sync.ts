// lib/connectors/sync.ts
//
// Fetching from a connector (lib/connectors/types.ts) and keeping what comes:
// the daily fetch the snapshot job runs for each container beside Plaid's
// (lib/snapshot-job.ts), the person's own Refresh, and the first fetch when
// they choose accounts.
//
// A FEW REQUESTS A DAY. SimpleFIN allows 24 requests a day per Access URL and
// updates once a day, so Nya makes at most DAILY_REQUESTS in a day's window
// per container (a request being one fetch: Lunch Flow's asks account by
// account, lib/connectors/lunchflow.ts, and counts once), counted before each
// is sent (connector-requests, a counter
// on the seam: a count that can't be read stops requests until its window
// ends, never opens them). The daily run asks once for the recent window, and
// while older history is still coming, for at most BACKFILL_WINDOWS_PER_RUN
// older windows, never taking the count past DAILY_REQUESTS - REFRESH_RESERVE,
// so the person's Refresh always has some left. A run two hours later (the
// snapshot's catch-up) skips the recent window only when the last answer is
// under REFETCH_HOURS old and was whole for every tracked account (no
// failure, no problem that concerns them, none missing, every balance there
// and current: lib/connectors/institutions.ts answeredWhole), so a bank held
// out of the day's total is always asked again. An account that ended
// (lib/lifecycle.ts) holds nothing there, nor in judging an answer whole for
// the history below: a card closed at the bank that SimpleFIN stops
// returning never stalls the history of the accounts beside it. What such an
// answer left out of it is kept on it instead (ConnectorAccount `left_out`),
// since the history moved on without its transactions: an older window, the
// days it newly reached; a recent answer, the days from the last one the
// history had reached (rows post late into days fetched already), open until
// an answer holds it again. An answer that holds it, with no problem about
// it, takes the days it covers off, so what came is never said to be
// missing: a recent one, everything from its own start on. A report says
// what may still be missing (lib/report/read.ts), and so does its OFX
// statement.
//
// WINDOWS. A request asks for the transactions posted in a window of at most
// the connector's windowDays (90 for SimpleFIN, 731 for Lunch Flow). The
// recent window has no end (it runs to now), so it starts at most
// windowDays - 1 days back, at 00:00 UTC, and spans under windowDays days; and
// overlapDays (5 for SimpleFIN, 45 for Lunch Flow) before the last day
// fetched, so a transaction that posted late into a day already fetched is
// still caught. History before that arrives a window at a time going back,
// each overlapping the one after it by overlapDays, until two whole answers in
// a row bring nothing older than what is already there (the connector has no
// more; one quiet window could be a quiet account) or HISTORY_DAYS is
// reached: no window starts before it, and a recent window that reaches it
// (Lunch Flow's first) leaves the history complete. Only a whole answer
// (every tracked account in it, no problem reported that concerns them) moves
// the walk on or ends it: anything less is noted as failed and asked again
// the next night. A request also says which accounts not tracked Nya offers
// already, and the history's limit (FetchRequest `offered`, `since`), for a
// connector that asks account by account. A gap (more than windowDays
// without an answer) starts the walk back again from the recent window, so no
// stretch is ever skipped: what was fetched already is matched, never added
// twice.
//
// MATCHED BY THE CONNECTOR'S ID. Each answer's transactions go through the
// import pipeline's normalize stage (lib/import/normalize.ts: the rules a
// typed transaction meets, its text cleaned) and into the account's book
// (lib/manual-txns.ts) in one compare-and-set per 16 accounts, matched by the
// connector's own transaction id (its kind as the row's source, 'simplefin' or
// 'lunchflow', and source_id): an id the book has is the same transaction, so
// fetching an overlapping window again
// adds nothing, and one whose date, amount or description the bank has since
// changed is brought up to date, keeping the person's category. An id is
// never matched by content: two identical coffees with two ids are two
// transactions. Pending transactions never come (lib/connectors/simplefin.ts).
//
// FAILURES. A request that fails stores what it failed with, in the
// connector's own words where it gave some, and changes nothing else: no
// balance, no transaction. What a failure, a problem the connector reported,
// or an account missing from its answer does to net worth and its history is
// decided in lib/connectors/institutions.ts, from what is stored here.
//
// Never logs a credential: the connector's errors carry no URL
// (lib/connectors/http.ts), and anything else goes through loggable().

import {
  connectionsStore,
  connectorAccountsStore,
  secretsStore,
  requestsCount,
  MAX_LEFT_OUT,
  type AvailableAccount,
  type ConnectorAccount,
  type ConnectorConnection,
  type FetchRecord,
  type LeftOut,
  type StoredProblem,
} from './store';
import { answeredWhole } from './institutions';
import { matchCarried, takeOver } from './continue';
import { connectorOf } from './registry';
import { CONNECTOR_WORDS, ConnectorFailure, type ConnectorDef, type ConnectorKind, type FetchRequest, type RemoteAccount, type RemoteAnswer } from './types';
import { manualTxnStore, newManualTxnId, type ManualTxn, type ManualTxnBook } from '../manual-txns';
import { normalizeRecords, type ImportRow } from '../import/normalize';
import { MANY_AT_ONCE, StoreRefusedError, StoredDataUnreadableError } from '../repo';
import { addDays } from '../manual-txn-input';
import { clearCaches } from '../cache';
import { endedIdsUnlinked } from '../lifecycle';
import { loggable } from '../log-safe';
import type { Ctx } from '../containers';
import type { RawRecord } from '../import/record';

/** The most requests a container makes to connectors in a day's window: well
 *  under SimpleFIN's 24 per Access URL, for every connection together. */
export const DAILY_REQUESTS = 8;
/** Requests the backfill leaves for the person's own Refresh. */
export const REFRESH_RESERVE = 3;
/** Older windows the daily run asks for, while history is still coming. */
export const BACKFILL_WINDOWS_PER_RUN = 2;
/** How far back history is fetched: what Plaid is asked for at link. */
export const HISTORY_DAYS = 730;
/** How long one request may take. */
export const REQUEST_TIMEOUT_MS = 20_000;
/** A request isn't started with less time than this left. */
export const MIN_REQUEST_MS = 3_000;
/** How long the connectors' part of one container's daily run may take. It
 *  runs beside Plaid's fetch, whose worst case is longer (lib/snapshot-job.ts
 *  START_BUDGET_MS), so it never makes the run longer. */
export const DAILY_DEADLINE_MS = 60_000;
/** The daily run asks again only once the last answer is this old. */
export const REFETCH_HOURS = 12;
/** How many accounts the connector offers that are listed for choosing. */
const MAX_AVAILABLE = 200;

const HOUR = 3_600_000;
const utcDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

// ---- The request budget ----

/**
 * Takes one request from the container's budget if the count is below
 * `ceiling`: false, sending nothing, when it isn't, or when the count can't
 * be read (a limit built on it stays shut). The count is read first, so a
 * request turned away costs nothing; two racing past the read are settled by
 * the count each takes.
 */
export async function takeRequest(ctx: Ctx, ceiling: number = DAILY_REQUESTS): Promise<boolean> {
  try {
    if ((await requestsCount.read(ctx)).count >= ceiling) return false;
    return (await requestsCount.take(ctx)).count <= ceiling;
  } catch (err) {
    console.error(`Connectors: the request count for container ${ctx.container} could not be read; no request was made.`, loggable(err));
    return false;
  }
}

/** Requests left in the current window, and when it ends (0 when none is
 *  running). Null when the count can't be read. */
export async function requestsLeft(ctx: Ctx): Promise<{ left: number; resets_in_seconds: number } | null> {
  try {
    const { count, secondsLeft } = await requestsCount.read(ctx);
    return { left: Math.max(0, DAILY_REQUESTS - count), resets_in_seconds: secondsLeft };
  } catch {
    return null;
  }
}

// ---- Windows ----

type History = NonNullable<ConnectorConnection['history']>;

/** Where the recent window starts: overlapDays before the last day fetched,
 *  and never more than windowDays - 1 days ago, so a window that runs to now
 *  spans under windowDays days. */
export function recentStart(history: History | null, today: string, def: Pick<ConnectorDef, 'windowDays' | 'overlapDays'>): string {
  const earliest = addDays(today, -(def.windowDays - 1));
  if (!history) return earliest;
  const resume = addDays(history.to, -def.overlapDays);
  return resume < earliest ? earliest : resume;
}

/** The history once a recent window from `start` was fetched on `today`:
 *  extended when it joins what was fetched, started again when it doesn't. */
export function advanceHistory(history: History | null, start: string, today: string): History {
  if (!history || start > history.to) return { from: start, to: today, complete: false, failed: null };
  return { ...history, from: start < history.from ? start : history.from, to: today > history.to ? today : history.to };
}

/** The next older window to fetch, or null when history is complete. It ends
 *  overlapDays into what was fetched already. */
export function backfillWindow(history: History | null, def: Pick<ConnectorDef, 'windowDays' | 'overlapDays'>): { start: string; end: string } | null {
  if (!history || history.complete) return null;
  const end = addDays(history.from, def.overlapDays);
  return { start: addDays(end, -def.windowDays), end };
}

// ---- Keeping transactions ----

/** What merging an answer's transactions did. */
export type Merged = { added: number; updated: number; unreadable: number; notes: string[] };

/** A connector's row as an account's book keeps it. */
function newRow(account_id: string, row: ImportRow, at: string): ManualTxn {
  return {
    id: newManualTxnId(),
    account_id,
    date: row.date,
    amount: row.amount,
    currency: row.currency,
    name: row.name,
    category: null,
    note: null,
    source: row.source,
    source_id: row.source_id,
    ...(row.source_key ? { source_key: row.source_key } : {}),
    created_at: at,
    updated_at: at,
  };
}

/**
 * Puts records into their accounts' books, matched by the connector's id (see
 * the header), one compare-and-set per MANY_AT_ONCE accounts. A book too
 * large to save, or one that can't be read, is left as it is and said in
 * `notes`; storage failing throws.
 */
export async function mergeRecords(ctx: Ctx, items: { account: ConnectorAccount; records: RawRecord[] }[], now: number): Promise<Merged> {
  const today = utcDay(now);
  const at = new Date(now).toISOString();
  const out: Merged = { added: 0, updated: 0, unreadable: 0, notes: [] };
  // Normalized once, outside the compare-and-set, which may run more than once.
  const prepared = items
    .map(({ account, records }) => {
      const { rows, problems } = normalizeRecords(records, { today, currency: account.currency });
      out.unreadable += problems.length;
      // One row per id: the first the answer held.
      const byId = new Map<string, ImportRow>();
      for (const { row } of rows) if (row.source_id && !byId.has(row.source_id)) byId.set(row.source_id, row);
      return { account, rows: [...byId.values()] };
    })
    .filter((p) => p.rows.length > 0);

  for (let i = 0; i < prepared.length; i += MANY_AT_ONCE) {
    const chunk = prepared.slice(i, i + MANY_AT_ONCE);
    let counts = { added: 0, updated: 0 };
    try {
      await manualTxnStore.updateMany(
        ctx,
        chunk.map((p) => p.account.account_id),
        async (books) => {
          counts = { added: 0, updated: 0 }; // this may run more than once
          const writes = new Map<string, ManualTxnBook | null>();
          // A carried-on account is read again here, inside the books'
          // compare-and-set (lib/connectors/continue.ts UNDO): one an undo
          // has begun on, or that is no longer this connection's carried-on
          // account, takes nothing more from this answer.
          const carried = chunk.filter((p) => p.account.continued).map((p) => p.account.account_id);
          const fresh = carried.length > 0 ? await connectorAccountsStore.getMany(ctx, carried) : new Map<string, ConnectorAccount>();
          const stale = (a: ConnectorAccount) => {
            if (!a.continued) return false;
            const now = fresh.get(a.account_id);
            return !now || now.version !== 2 || !!now.continued?.undoing || now.connection_id !== a.connection_id || now.remote_id !== a.remote_id;
          };
          for (const { account, rows } of chunk) {
            if (stale(account)) continue;
            const book = books.get(account.account_id) ?? null;
            const next = [...(book?.rows ?? [])];
            const index = new Map<string, number>();
            // Carried on from an account a restore brought back (lib/
            // connectors/continue.ts): across servers, only rows from the
            // new connection are found by id.
            const c = account.continued;
            const fromNew = (r: ManualTxn) => !c || c.by_id || r.created_at >= c.at || r.continues !== undefined;
            next.forEach((r, n) => {
              if (r.source === account.connector && r.source_id && fromNew(r)) index.set(r.source_id, n);
            });
            let changed = false;
            const unknown: ImportRow[] = [];
            for (const row of rows) {
              const n = index.get(row.source_id!);
              if (n === undefined) {
                unknown.push(row);
                continue;
              }
              const stored = next[n];
              // The bank's own fields follow the bank; the person's category
              // and note, and the row's id, stay.
              if (stored.date !== row.date || stored.amount !== row.amount || stored.currency !== row.currency || stored.name !== row.name) {
                next[n] = { ...stored, date: row.date, amount: row.amount, currency: row.currency, name: row.name, ...(row.source_key ? { source_key: row.source_key } : {}) };
                counts.updated++;
                changed = true;
              }
            }
            // The rows it doesn't have by id: for a carried-on account, those
            // that may be ones from the download take them over, by the
            // import's rule; the rest are added.
            const { taken, added } = c ? matchCarried(c, next, unknown) : { taken: [], added: unknown };
            for (const { row, at: n } of taken) {
              next[n] = takeOver(next[n], row);
              index.set(row.source_id!, n);
              counts.updated++;
              changed = true;
            }
            for (const row of added) {
              if (index.has(row.source_id!)) continue;
              index.set(row.source_id!, next.length);
              next.push(newRow(account.account_id, row, at));
              counts.added++;
              changed = true;
            }
            if (changed) writes.set(account.account_id, { version: 1, rows: next });
          }
          return writes;
        }
      );
      out.added += counts.added;
      out.updated += counts.updated;
    } catch (err) {
      const names = chunk.map((p) => p.account.name).join(', ');
      if (err instanceof StoreRefusedError) {
        out.notes.push(`New transactions for ${names} couldn't be saved: ${err.message}`);
      } else if (err instanceof StoredDataUnreadableError) {
        out.notes.push(`New transactions for ${names} couldn't be saved, because the ones Nya has for ${chunk.length === 1 ? 'it' : 'them'} can't be read.`);
      } else {
        throw err;
      }
    }
  }
  return out;
}

// ---- One connection ----

export type SyncPurpose = 'daily' | 'refresh' | 'first';

export type SyncResult = {
  /** What the request for balances came to, or null when none was made. */
  record: FetchRecord | null;
  /** Why no request for balances was made. */
  skipped: null | 'fresh' | 'budget' | 'time' | 'gone';
  /** The answer, for a route that shows what the connector offers with
   *  balances (never stored for an account that isn't tracked). */
  answer: RemoteAnswer | null;
  backfilled: { windows: number; added: number };
};

/** The accounts of a connection, tracked. */
async function trackedOf(ctx: Ctx, connection_id: string): Promise<ConnectorAccount[]> {
  return [...(await connectorAccountsStore.getAll(ctx)).values()].filter((a) => a.connection_id === connection_id);
}

/** The credential kept for a connection, or the failure that it can't be used. */
async function secretOf(ctx: Ctx, connection_id: string, kind: ConnectorKind): Promise<string | ConnectorFailure> {
  const { label, again } = CONNECTOR_WORDS[kind];
  try {
    const kept = await secretsStore.get(ctx, connection_id);
    if (kept) return kept.secret;
    return new ConnectorFailure('credentials', 'nya', `Nya no longer has the access ${label} gave it. Connect again with ${again}.`);
  } catch (err) {
    if (err instanceof StoredDataUnreadableError) {
      return new ConnectorFailure('credentials', 'nya', `Nya can’t read the access ${label} gave it. Connect again with ${again}.`);
    }
    throw err;
  }
}

/** A request that brought nothing, as stored. */
function failureRecord(at: number, f: ConnectorFailure): FetchRecord {
  return {
    at: new Date(at).toISOString(),
    failure: { kind: f.kind, side: f.side, message: f.message.slice(0, 1000), status: f.status },
    problems: [],
    missing: [],
    added: 0,
    updated: 0,
    pending: 0,
    unreadable: 0,
  };
}

/** The accounts an answer offers that aren't tracked, for choosing: those it
 *  asked about, and those it only listed (RemoteAnswer `listed`), as they
 *  were offered before (`before`), under the names they have now. One
 *  listed that wasn't offered before has nothing to be offered with yet. */
function availableIn(answer: RemoteAnswer, tracked: ReadonlySet<string>, before: readonly AvailableAccount[] = []): AvailableAccount[] {
  const asked: AvailableAccount[] = answer.accounts
    .filter((a) => !tracked.has(a.remote_id))
    .map((a) => ({
      remote_id: a.remote_id,
      name: a.name,
      institution: a.institution.name,
      institution_key: a.institution.key,
      currency: a.currency,
      currency_text: a.currency_text,
    }));
  const was = new Map(before.map((a) => [a.remote_id, a]));
  const listed = (answer.listed ?? []).flatMap((a) => {
    const kept = was.get(a.remote_id);
    return kept && !tracked.has(a.remote_id) ? [{ ...kept, name: a.name, institution: a.institution.name, institution_key: a.institution.key }] : [];
  });
  const seen = new Set(asked.map((a) => a.remote_id));
  return [...asked, ...listed.filter((a) => !seen.has(a.remote_id))].slice(0, MAX_AVAILABLE);
}

/** What a request about transactions also says (FetchRequest): the accounts
 *  it already offers, by their remote ids, so a connector that asks account
 *  by account needn't ask their balances again, and the history's limit. */
function windowExtras(conn: ConnectorConnection, today: string): { offered: string[]; since: string } {
  return { offered: conn.available.filter((a) => a.currency !== null).map((a) => a.remote_id), since: addDays(today, -HISTORY_DAYS) };
}

/** Writes each tracked account's balance from the answer, in one
 *  compare-and-set per MANY_AT_ONCE accounts: an account stopped meanwhile is
 *  not written back. One the answer reported no problem about (`troubled`
 *  lists those it did) was synced cleanly: its `ok_at` is the time of its
 *  balance. */
async function writeBalances(ctx: Ctx, pairs: { account: ConnectorAccount; remote: RemoteAccount }[], at: string, troubled: ReadonlySet<string>): Promise<void> {
  for (let i = 0; i < pairs.length; i += MANY_AT_ONCE) {
    const chunk = pairs.slice(i, i + MANY_AT_ONCE);
    await connectorAccountsStore.updateMany(
      ctx,
      chunk.map((p) => p.account.account_id),
      (current) => {
        const writes = new Map<string, ConnectorAccount | null>();
        for (const { account, remote } of chunk) {
          const now = current.get(account.account_id);
          if (!now) continue;
          writes.set(account.account_id, {
            ...now,
            name: remote.name,
            institution_name: remote.institution.name,
            reported_balance: remote.balance,
            reported_available: remote.available,
            balance_at: remote.balance_at,
            fetched_at: at,
            ok_at: troubled.has(account.account_id) ? (now.ok_at ?? null) : (remote.balance_at ?? at),
          });
        }
        return writes;
      }
    );
  }
}

/** The end of an open window, while it is worked on: after every day. */
const OPEN = '9999-12-31';

/** Windows as spans with an end, in day order, those that touch made one. */
function spans(list: readonly LeftOut[]): { from: string; to: string }[] {
  const sorted = list.map((w) => ({ from: w.from, to: w.to ?? OPEN })).filter((w) => w.from <= w.to).sort((a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : 0));
  const out: { from: string; to: string }[] = [];
  for (const w of sorted) {
    const last = out.at(-1);
    if (last && (last.to === OPEN || w.from <= addDays(last.to, 1))) last.to = w.to > last.to ? w.to : last.to;
    else out.push({ ...w });
  }
  return out;
}

const windows = (list: readonly { from: string; to: string }[]): LeftOut[] => {
  const out = list.map((w) => ({ from: w.from, to: w.to === OPEN ? null : w.to }));
  // Too many: kept as one, which says more may be missing, never less.
  return out.length > MAX_LEFT_OUT ? [{ from: out[0].from, to: out.at(-1)!.to }] : out;
};

/** The days an account was left out of, with `from` to `to` added (`to`
 *  null: open, see LeftOut). Pure. */
export function withLeftOut(list: readonly LeftOut[] | undefined, from: string, to: string | null): LeftOut[] {
  return windows(spans([...(list ?? []), { from, to }]));
}

/** The days an account was left out of, without `from` to `to` (`to` null:
 *  everything from `from` on), which an answer holding it covered. Pure. */
export function withoutLeftOut(list: readonly LeftOut[] | undefined, from: string, to: string | null): LeftOut[] {
  const end = to ?? OPEN;
  const out: { from: string; to: string }[] = [];
  for (const w of spans(list ?? [])) {
    if (w.to < from || w.from > end) {
      out.push(w);
      continue;
    }
    if (w.from < from) out.push({ from: w.from, to: addDays(from, -1) });
    if (end !== OPEN && w.to > end) out.push({ from: addDays(end, 1), to: w.to });
  }
  return windows(spans(out));
}

const sameWindows = (a: readonly LeftOut[], b: readonly LeftOut[]) => a.length === b.length && a.every((w, i) => w.from === b[i].from && w.to === b[i].to);

/**
 * What one answer says of each tracked account's own days (see the header):
 * one it holds with no problem about it (`left` false) has the days it
 * `covered` taken off; one that ended and that a whole answer left out or
 * named a problem for alone has the days that answer moved the history over
 * (`leftOut`) added. Written only when they change: an account SimpleFIN no
 * longer returns costs a write when its window opens, and one when an answer
 * holds it again.
 */
async function noteLeftOut(
  ctx: Ctx,
  tracked: readonly ConnectorAccount[],
  ended: ReadonlySet<string>,
  left: (a: ConnectorAccount) => boolean,
  covered: { from: string; to: string | null },
  leftOut: { from: string; to: string | null } | null
): Promise<void> {
  for (const a of tracked) {
    const out = left(a);
    const next = (list: readonly LeftOut[] | undefined): LeftOut[] | null => {
      if (!out) return list?.length ? withoutLeftOut(list, covered.from, covered.to) : null;
      return leftOut && ended.has(a.account_id) ? withLeftOut(list, leftOut.from, leftOut.to) : null;
    };
    const was = a.left_out ?? [];
    const now = next(was);
    if (!now || sameWindows(now, was)) continue;
    await connectorAccountsStore.update(ctx, a.account_id, (c) => {
      if (!c) return c;
      const changed = next(c.left_out);
      if (!changed || sameWindows(changed, c.left_out ?? [])) return c;
      const { left_out: _was, ...rest } = c;
      return changed.length > 0 ? { ...rest, left_out: changed } : rest;
    });
  }
}

/** Whether an answer, as recorded, was whole for the accounts tracked: none
 *  missing, and no problem reported that concerns them or names no bank;
 *  those that ended (`ended`) aside, which hold nothing (see the header). */
function wholeRecord(record: FetchRecord, ended: ReadonlySet<string>): boolean {
  return record.failure === null && record.missing.every((id) => ended.has(id)) && record.problems.every((p) => p.accounts !== null && p.accounts.every((id) => ended.has(id)));
}

/** Stores what a request for balances came to, on the connection entry. Only
 *  a whole answer moves the history on: after one that wasn't, the next
 *  recent window starts where the last whole one ended, so a stretch an
 *  account was missing from is fetched again. */
async function saveFetch(
  ctx: Ctx,
  connection_id: string,
  record: FetchRecord,
  answered: { answer: RemoteAnswer; start: string | null; today: string } | null,
  ended: ReadonlySet<string> = new Set()
): Promise<void> {
  await connectionsStore.update(ctx, connection_id, (current) => {
    if (!current) return null;
    if (!answered) return { ...current, last_fetch: record };
    const tracked = new Set(current.tracked.map((t) => t.remote_id));
    const moves = answered.start !== null && wholeRecord(record, ended);
    const history = moves ? advanceHistory(current.history, answered.start!, answered.today) : current.history;
    return {
      ...current,
      last_fetch: record,
      last_answer_at: record.at,
      available: availableIn(answered.answer, tracked, current.available),
      // A recent window that reached the history's limit (a connector whose
      // window is as long, Lunch Flow's) leaves nothing older to ask for.
      history: history && !history.complete && history.from <= addDays(answered.today, -HISTORY_DAYS) ? { ...history, complete: true } : history,
    };
  });
}

/**
 * Applies an answer: the tracked accounts' transactions into their books,
 * then their balances, and returns the record of it. Tracked accounts the
 * answer didn't hold are named in `missing`; each problem the connector
 * reported names the tracked accounts it concerns (an empty list when it
 * concerns only accounts that aren't tracked; null when it could be any).
 */
async function applyAnswer(ctx: Ctx, tracked: ConnectorAccount[], answer: RemoteAnswer, now: number): Promise<FetchRecord> {
  const byRemote = new Map(answer.accounts.map((a) => [a.remote_id, a]));
  const present = tracked.flatMap((account) => {
    const remote = byRemote.get(account.remote_id);
    return remote ? [{ account, remote }] : [];
  });
  const merged = await mergeRecords(
    ctx,
    present.map(({ account, remote }) => ({ account, records: remote.transactions })),
    now
  );
  const at = new Date(now).toISOString();
  const nyaIdOf = new Map(tracked.map((a) => [a.remote_id, a.account_id]));
  const problems: StoredProblem[] = answer.problems.map((p) => ({
    message: p.message,
    side: p.side,
    accounts: p.accounts === null ? null : p.accounts.flatMap((id) => (nyaIdOf.has(id) ? [nyaIdOf.get(id)!] : [])),
    ...(p.kind ? { kind: p.kind } : {}),
  }));
  // The accounts a problem concerns: those it names, or all of them when it
  // names no bank.
  const troubled = new Set(problems.flatMap((p) => p.accounts ?? tracked.map((a) => a.account_id)));
  await writeBalances(ctx, present, at, troubled);
  return {
    at,
    failure: null,
    problems,
    missing: tracked.filter((a) => !byRemote.has(a.remote_id)).map((a) => a.account_id),
    added: merged.added,
    updated: merged.updated,
    pending: present.reduce((n, p) => n + p.remote.left_out.pending, 0),
    unreadable: merged.unreadable + present.reduce((n, p) => n + p.remote.left_out.unreadable, 0),
    ...(merged.notes.length > 0 ? { note: merged.notes.join(' ').slice(0, 1000) } : {}),
  };
}

/**
 * Older history, a window at a time (see the header), within the budget's
 * share for it and the time left. Never changes a balance or the gate: a
 * window that fails is noted on the connection's history and tried again the
 * next night.
 */
async function backfill(ctx: Ctx, connection_id: string, def: ConnectorDef, secret: string, now: number, deadline: number): Promise<{ windows: number; added: number }> {
  const done = { windows: 0, added: 0 };
  const today = utcDay(now);
  const limit = addDays(today, -HISTORY_DAYS);
  // Accounts that ended hold nothing in judging a window whole (see the header).
  const ended = await endedIdsUnlinked(ctx, now);
  while (done.windows < BACKFILL_WINDOWS_PER_RUN) {
    const conn = await connectionsStore.get(ctx, connection_id);
    const next = backfillWindow(conn?.history ?? null, def);
    if (!conn || !next) break;
    // Never past the history's limit: a history already there has nothing
    // older to ask for, and a window that would start before it starts there.
    if (conn.history!.from <= limit) {
      await connectionsStore.update(ctx, connection_id, (c) => (c?.history && !c.history.complete ? { ...c, history: { ...c.history, complete: true } } : c));
      break;
    }
    const window = next.start < limit ? { ...next, start: limit } : next;
    const tracked = await trackedOf(ctx, connection_id);
    if (tracked.length === 0) break;
    if (deadline - Date.now() < MIN_REQUEST_MS) break;
    if (!(await takeRequest(ctx, DAILY_REQUESTS - REFRESH_RESERVE))) break;
    let answer: RemoteAnswer;
    try {
      answer = await def.fetch(
        secret,
        { start: window.start, end: window.end, accounts: tracked.map((a) => a.remote_id), ...windowExtras(conn, today) },
        { timeoutMs: Math.min(REQUEST_TIMEOUT_MS, deadline - Date.now()) }
      );
    } catch (err) {
      if (!(err instanceof ConnectorFailure)) throw err;
      await connectionsStore.update(ctx, connection_id, (c) => (c?.history ? { ...c, history: { ...c.history, failed: new Date(now).toISOString() } } : c));
      break;
    }
    const remotes = new Set(tracked.map((a) => a.remote_id));
    const live = tracked.filter((a) => !ended.has(a.account_id));
    const liveRemotes = new Set(live.map((a) => a.remote_id));
    const byRemote = new Map(answer.accounts.map((a) => [a.remote_id, a]));
    const merged = await mergeRecords(
      ctx,
      tracked.flatMap((account) => {
        const remote = byRemote.get(account.remote_id);
        return remote ? [{ account, records: remote.transactions }] : [];
      }),
      now
    );
    done.windows++;
    done.added += merged.added;
    // Only a whole answer says anything about what is older: one without a
    // tracked account, or with a problem that concerns one (or names no
    // bank), is noted as failed, and the window is asked again next night.
    const whole =
      live.every((a) => byRemote.has(a.remote_id)) && !answer.problems.some((p) => p.accounts === null || p.accounts.some((id) => liveRemotes.has(id)));
    // What it says of each account's own days (see the header): whole, it
    // moves the history back over the days before where it was.
    await noteLeftOut(
      ctx,
      tracked,
      ended,
      (a) => !byRemote.has(a.remote_id) || answer.problems.some((p) => p.accounts === null || p.accounts.includes(a.remote_id)),
      { from: window.start, to: addDays(window.end, -1) },
      whole ? { from: window.start, to: addDays(conn.history!.from, -1) } : null
    );
    if (!whole) {
      await connectionsStore.update(ctx, connection_id, (c) => (c?.history ? { ...c, history: { ...c.history, failed: new Date(now).toISOString() } } : c));
      break;
    }
    const from = conn.history!.from;
    // Anything older than what was there: the connector has more.
    const older = answer.accounts.some((a) => remotes.has(a.remote_id) && a.transactions.some((t) => t.date < from));
    await connectionsStore.update(ctx, connection_id, (c) => {
      if (!c?.history) return c;
      const reached = window.start < c.history.from ? window.start : c.history.from;
      // Two whole answers in a row with nothing older: there is no more. One
      // could be a quiet stretch of an account that has more before it.
      const empty = older ? 0 : (c.history.empty ?? 0) + 1;
      return { ...c, history: { ...c.history, from: reached, complete: empty >= 2 || reached <= limit, failed: null, empty } };
    });
  }
  return done;
}

/**
 * One connection's fetch: the recent window (balances only when nothing is
 * tracked yet), then for the daily run older history (see the header).
 * Returns what it did; a failed request is stored and returned, not thrown.
 * Throws only what says nothing about the connection (storage unreachable, a
 * deployment that can't read its keys).
 */
export async function syncConnection(
  ctx: Ctx,
  connection_id: string,
  opts: { purpose: SyncPurpose; now?: number; deadline?: number; /** False leaves older history to syncOlderHistory. */ backfill?: boolean }
): Promise<SyncResult> {
  const now = opts.now ?? Date.now();
  const deadline = opts.deadline ?? Date.now() + REQUEST_TIMEOUT_MS;
  const result: SyncResult = { record: null, skipped: null, answer: null, backfilled: { windows: 0, added: 0 } };
  const conn = await connectionsStore.get(ctx, connection_id);
  if (!conn) return { ...result, skipped: 'gone' };
  const def = connectorOf(conn.connector);
  const tracked = await trackedOf(ctx, connection_id);
  const today = utcDay(now);
  // Accounts that ended hold nothing (see the header).
  const ended = tracked.length > 0 ? await endedIdsUnlinked(ctx, now) : new Set<string>();

  const lastAnswer = conn.last_answer_at ? Date.parse(conn.last_answer_at) : null;
  // Recent and whole for every tracked account: anything less is asked again.
  const fresh = opts.purpose === 'daily' && lastAnswer !== null && now - lastAnswer < REFETCH_HOURS * HOUR && answeredWhole(conn, tracked, now, ended);
  let secret: string | null = null;
  let changed = false;

  if (fresh) result.skipped = 'fresh';
  else if (deadline - Date.now() < MIN_REQUEST_MS) result.skipped = 'time';
  else if (!(await takeRequest(ctx))) result.skipped = 'budget';
  else {
    const kept = await secretOf(ctx, connection_id, conn.connector);
    if (kept instanceof ConnectorFailure) {
      result.record = failureRecord(now, kept);
      await saveFetch(ctx, connection_id, result.record, null);
      if (tracked.length > 0) await clearCaches(ctx);
      return result;
    }
    secret = kept;
    const request: FetchRequest =
      tracked.length === 0
        ? { balancesOnly: true }
        : { start: recentStart(conn.history, today, def), end: null, accounts: tracked.map((a) => a.remote_id), ...windowExtras(conn, today) };
    try {
      result.answer = await def.fetch(secret, request, { timeoutMs: Math.min(REQUEST_TIMEOUT_MS, deadline - Date.now()) });
    } catch (err) {
      if (!(err instanceof ConnectorFailure)) throw err;
      result.record = failureRecord(now, err);
      await saveFetch(ctx, connection_id, result.record, null);
      // A payload cached while it was answering would hide that it isn't.
      if (tracked.length > 0) await clearCaches(ctx);
      return result;
    }
    result.record = await applyAnswer(ctx, tracked, result.answer, now);
    await saveFetch(ctx, connection_id, result.record, { answer: result.answer, start: request.balancesOnly ? null : request.start, today }, ended);
    // What it says of each account's own days (see the header): whole, it
    // moves the history on from the last day it had reached.
    const record = result.record;
    if (!request.balancesOnly) {
      const left = new Set([...record.missing, ...record.problems.flatMap((p) => p.accounts ?? tracked.map((a) => a.account_id))]);
      const moved = conn.history && conn.history.to < today && wholeRecord(record, ended) ? conn.history.to : null;
      await noteLeftOut(ctx, tracked, ended, (a) => left.has(a.account_id), { from: request.start, to: null }, moved ? { from: moved, to: null } : null);
    }
    changed = tracked.length > 0;
  }

  // Cached payloads hold the balances and transactions from before.
  if (changed) await clearCaches(ctx);
  if (opts.purpose === 'daily' && opts.backfill !== false) {
    result.backfilled = await syncOlderHistory(ctx, connection_id, result, { now, deadline, secret });
  }
  return result;
}

/**
 * Older history after a daily run's recent window (see the header), only once
 * that window has answered (now, or within REFETCH_HOURS), within the budget's
 * share for it. Never changes a balance or the gate.
 */
export async function syncOlderHistory(
  ctx: Ctx,
  connection_id: string,
  recent: SyncResult,
  opts: { now?: number; deadline?: number; secret?: string | null } = {}
): Promise<{ windows: number; added: number }> {
  const none = { windows: 0, added: 0 };
  if (recent.skipped === 'budget' || recent.skipped === 'time' || recent.skipped === 'gone') return none;
  if (recent.skipped !== 'fresh' && recent.record?.failure !== null) return none;
  const now = opts.now ?? Date.now();
  const deadline = opts.deadline ?? Date.now() + REQUEST_TIMEOUT_MS;
  const conn = await connectionsStore.get(ctx, connection_id);
  if (!conn || (await trackedOf(ctx, connection_id)).length === 0) return none;
  let secret = opts.secret ?? null;
  if (secret === null) {
    const kept = await secretOf(ctx, connection_id, conn.connector);
    if (kept instanceof ConnectorFailure) return none;
    secret = kept;
  }
  const done = await backfill(ctx, connection_id, connectorOf(conn.connector), secret, now, deadline);
  if (done.added > 0) await clearCaches(ctx);
  return done;
}

/**
 * The daily run for one container: every connection it has, at once, within
 * DAILY_DEADLINE_MS. `recent` settles once each connection's recent window
 * (its balances and latest transactions) is stored, which is all the day's
 * total waits for; `done` once older history has been asked for too, which
 * the snapshot waits for before its run ends (lib/snapshot-job.ts). Neither
 * ever rejects: a failure is stored on its connection or logged, and the
 * snapshot goes on. A connection whose entry can't be read is left alone (and
 * holds its accounts out of the day's total, lib/connectors/institutions.ts).
 */
export function syncConnectorsDaily(ctx: Ctx, opts: { now?: number } = {}): { recent: Promise<void>; done: Promise<void> } {
  const deadline = Date.now() + DAILY_DEADLINE_MS;
  let recentSettled: () => void = () => {};
  const recent = new Promise<void>((resolve) => {
    recentSettled = resolve;
  });
  const failed = (err: unknown) => console.error(`Connectors: the daily fetch failed for a connection in container ${ctx.container}.`, loggable(err));
  const done = (async () => {
    try {
      const { entries, unreadable, unrecognised } = await connectionsStore.getAllReport(ctx);
      if (unreadable.length + unrecognised.length > 0) {
        console.error(`Connectors: ${unreadable.length + unrecognised.length} connection(s) in container ${ctx.container} could not be read and were not fetched.`);
      }
      const ids = [...entries.keys()];
      const results = await Promise.all(
        ids.map((id) =>
          syncConnection(ctx, id, { purpose: 'daily', now: opts.now, deadline, backfill: false }).catch((err) => {
            failed(err);
            return null;
          })
        )
      );
      recentSettled();
      await Promise.all(ids.map((id, i) => (results[i] ? syncOlderHistory(ctx, id, results[i]!, { now: opts.now, deadline }).catch(failed) : null)));
    } catch (err) {
      console.error(`Connectors: the daily fetch could not start for container ${ctx.container}.`, loggable(err));
    } finally {
      recentSettled();
    }
  })();
  return { recent, done };
}
