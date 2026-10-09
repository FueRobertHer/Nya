// lib/connectors/sync.ts
//
// Fetching from a connector (lib/connectors/types.ts) and keeping what comes:
// the daily fetch the snapshot job runs for each container beside Plaid's
// (lib/snapshot-job.ts), the person's own Refresh, and the first fetch when
// they choose accounts.
//
// A FEW REQUESTS A DAY. SimpleFIN allows 24 requests a day per Access URL and
// updates once a day, so Nya makes at most DAILY_REQUESTS in a day's window
// per container, counted before each is sent (connector-requests, a counter
// on the seam: a count that can't be read stops requests until its window
// ends, never opens them). The daily run asks once for the recent window, and
// while older history is still coming, for at most BACKFILL_WINDOWS_PER_RUN
// older windows, never taking the count past DAILY_REQUESTS - REFRESH_RESERVE,
// so the person's Refresh always has some left. A run two hours later (the
// snapshot's catch-up) asks again only if the last answer is older than
// REFETCH_HOURS or failed.
//
// WINDOWS. A request asks for the transactions posted in a window of at most
// the connector's windowDays (90 for SimpleFIN). The recent window starts
// overlapDays (5) before the last day fetched, so a transaction that posted
// late into a day already fetched is still caught, and never more than
// windowDays ago. History before that arrives a window at a time going back,
// each overlapping the one after it by overlapDays, until a window brings
// nothing older than what is already there (the connector has no more) or
// HISTORY_DAYS is reached. A gap (more than windowDays without an answer)
// starts the walk back again from the recent window, so no stretch is ever
// skipped: what was fetched already is matched, never added twice.
//
// MATCHED BY THE CONNECTOR'S ID. Each answer's transactions go through the
// import pipeline's normalize stage (lib/import/normalize.ts: the rules a
// typed transaction meets, its text cleaned) and into the account's book
// (lib/manual-txns.ts) in one compare-and-set per 16 accounts, matched by the
// connector's own transaction id (source 'simplefin', source_id): an id the
// book has is the same transaction, so fetching an overlapping window again
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

import { connectionsStore, connectorAccountsStore, secretsStore, requestsCount, type AvailableAccount, type ConnectorAccount, type ConnectorConnection, type FetchRecord, type StoredProblem } from './store';
import { connectorOf } from './registry';
import { ConnectorFailure, type ConnectorDef, type FetchRequest, type RemoteAccount, type RemoteAnswer } from './types';
import { manualTxnStore, newManualTxnId, type ManualTxn, type ManualTxnBook } from '../manual-txns';
import { normalizeRecords, type ImportRow } from '../import/normalize';
import { MANY_AT_ONCE, StoreRefusedError, StoredDataUnreadableError } from '../repo';
import { addDays } from '../manual-txn-input';
import { clearCaches } from '../cache';
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
 *  and never more than windowDays ago. */
export function recentStart(history: History | null, today: string, def: Pick<ConnectorDef, 'windowDays' | 'overlapDays'>): string {
  const earliest = addDays(today, -def.windowDays);
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
        (books) => {
          counts = { added: 0, updated: 0 }; // this may run more than once
          const writes = new Map<string, ManualTxnBook | null>();
          for (const { account, rows } of chunk) {
            const book = books.get(account.account_id) ?? null;
            const next = [...(book?.rows ?? [])];
            const index = new Map<string, number>();
            next.forEach((r, n) => {
              if (r.source === 'simplefin' && r.source_id) index.set(r.source_id, n);
            });
            let changed = false;
            for (const row of rows) {
              const n = index.get(row.source_id!);
              if (n === undefined) {
                index.set(row.source_id!, next.length);
                next.push(newRow(account.account_id, row, at));
                counts.added++;
                changed = true;
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
async function secretOf(ctx: Ctx, connection_id: string): Promise<string | ConnectorFailure> {
  try {
    const kept = await secretsStore.get(ctx, connection_id);
    if (kept) return kept.secret;
    return new ConnectorFailure('credentials', 'nya', 'Nya no longer has the access SimpleFIN gave it. Connect again with a new Setup Token.');
  } catch (err) {
    if (err instanceof StoredDataUnreadableError) {
      return new ConnectorFailure('credentials', 'nya', 'Nya can’t read the access SimpleFIN gave it. Connect again with a new Setup Token.');
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

/** The accounts an answer offers that aren't tracked, for choosing. */
function availableIn(answer: RemoteAnswer, tracked: ReadonlySet<string>): AvailableAccount[] {
  return answer.accounts
    .filter((a) => !tracked.has(a.remote_id))
    .slice(0, MAX_AVAILABLE)
    .map((a) => ({
      remote_id: a.remote_id,
      name: a.name,
      institution: a.institution.name,
      institution_key: a.institution.key,
      currency: a.currency,
      currency_text: a.currency_text,
    }));
}

/** Writes each tracked account's balance from the answer, in one
 *  compare-and-set per MANY_AT_ONCE accounts: an account stopped meanwhile is
 *  not written back. */
async function writeBalances(ctx: Ctx, pairs: { account: ConnectorAccount; remote: RemoteAccount }[], at: string): Promise<void> {
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
          });
        }
        return writes;
      }
    );
  }
}

/** Stores what a request for balances came to, on the connection entry. */
async function saveFetch(ctx: Ctx, connection_id: string, record: FetchRecord, answered: { answer: RemoteAnswer; start: string | null; today: string } | null): Promise<void> {
  await connectionsStore.update(ctx, connection_id, (current) => {
    if (!current) return null;
    if (!answered) return { ...current, last_fetch: record };
    const tracked = new Set(current.tracked.map((t) => t.remote_id));
    return {
      ...current,
      last_fetch: record,
      last_answer_at: record.at,
      available: availableIn(answered.answer, tracked),
      history: answered.start === null ? current.history : advanceHistory(current.history, answered.start, answered.today),
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
  await writeBalances(ctx, present, at);
  const nyaIdOf = new Map(tracked.map((a) => [a.remote_id, a.account_id]));
  const problems: StoredProblem[] = answer.problems.map((p) => ({
    message: p.message,
    side: p.side,
    accounts: p.accounts === null ? null : p.accounts.flatMap((id) => (nyaIdOf.has(id) ? [nyaIdOf.get(id)!] : [])),
  }));
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
  while (done.windows < BACKFILL_WINDOWS_PER_RUN) {
    const conn = await connectionsStore.get(ctx, connection_id);
    const window = backfillWindow(conn?.history ?? null, def);
    if (!conn || !window) break;
    const tracked = await trackedOf(ctx, connection_id);
    if (tracked.length === 0) break;
    if (deadline - Date.now() < MIN_REQUEST_MS) break;
    if (!(await takeRequest(ctx, DAILY_REQUESTS - REFRESH_RESERVE))) break;
    let answer: RemoteAnswer;
    try {
      answer = await def.fetch(secret, { start: window.start, end: window.end }, { timeoutMs: Math.min(REQUEST_TIMEOUT_MS, deadline - Date.now()) });
    } catch (err) {
      if (!(err instanceof ConnectorFailure)) throw err;
      await connectionsStore.update(ctx, connection_id, (c) => (c?.history ? { ...c, history: { ...c.history, failed: new Date(now).toISOString() } } : c));
      break;
    }
    const remotes = new Set(tracked.map((a) => a.remote_id));
    const byRemote = new Map(answer.accounts.map((a) => [a.remote_id, a]));
    const merged = await mergeRecords(
      ctx,
      tracked.flatMap((account) => {
        const remote = byRemote.get(account.remote_id);
        return remote ? [{ account, records: remote.transactions }] : [];
      }),
      now
    );
    const from = conn.history!.from;
    // Anything older than what was there: the connector has more.
    const older = answer.accounts.some((a) => remotes.has(a.remote_id) && a.transactions.some((t) => t.date < from));
    await connectionsStore.update(ctx, connection_id, (c) => {
      if (!c?.history) return c;
      const reached = window.start < c.history.from ? window.start : c.history.from;
      return { ...c, history: { ...c.history, from: reached, complete: !older || reached <= limit, failed: null } };
    });
    done.windows++;
    done.added += merged.added;
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
export async function syncConnection(ctx: Ctx, connection_id: string, opts: { purpose: SyncPurpose; now?: number; deadline?: number }): Promise<SyncResult> {
  const now = opts.now ?? Date.now();
  const deadline = opts.deadline ?? Date.now() + REQUEST_TIMEOUT_MS;
  const result: SyncResult = { record: null, skipped: null, answer: null, backfilled: { windows: 0, added: 0 } };
  const conn = await connectionsStore.get(ctx, connection_id);
  if (!conn) return { ...result, skipped: 'gone' };
  const def = connectorOf(conn.connector);
  const tracked = await trackedOf(ctx, connection_id);
  const today = utcDay(now);

  const lastAnswer = conn.last_answer_at ? Date.parse(conn.last_answer_at) : null;
  const fresh = opts.purpose === 'daily' && conn.last_fetch !== null && conn.last_fetch.failure === null && lastAnswer !== null && now - lastAnswer < REFETCH_HOURS * HOUR;
  let secret: string | null = null;
  let changed = false;

  if (fresh) result.skipped = 'fresh';
  else if (deadline - Date.now() < MIN_REQUEST_MS) result.skipped = 'time';
  else if (!(await takeRequest(ctx))) result.skipped = 'budget';
  else {
    const kept = await secretOf(ctx, connection_id);
    if (kept instanceof ConnectorFailure) {
      result.record = failureRecord(now, kept);
      await saveFetch(ctx, connection_id, result.record, null);
      if (tracked.length > 0) await clearCaches(ctx);
      return result;
    }
    secret = kept;
    const request: FetchRequest = tracked.length === 0 ? { balancesOnly: true } : { start: recentStart(conn.history, today, def), end: null };
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
    await saveFetch(ctx, connection_id, result.record, { answer: result.answer, start: request.balancesOnly ? null : request.start, today });
    changed = tracked.length > 0;
  }

  // Older history, on the daily run only, and only once the recent window
  // has answered (now or within REFETCH_HOURS).
  if (opts.purpose === 'daily' && result.skipped !== 'budget' && result.skipped !== 'time' && (result.skipped === 'fresh' || result.record?.failure === null) && tracked.length > 0) {
    if (secret === null) {
      const kept = await secretOf(ctx, connection_id);
      secret = kept instanceof ConnectorFailure ? null : kept;
    }
    if (secret !== null) {
      result.backfilled = await backfill(ctx, connection_id, def, secret, now, deadline);
      if (result.backfilled.added > 0) changed = true;
    }
  }
  // Cached payloads hold the balances and transactions from before.
  if (changed) await clearCaches(ctx);
  return result;
}

/**
 * The daily run for one container: every connection it has, at once, within
 * DAILY_DEADLINE_MS. Never throws: a failure is stored on its connection or
 * logged, and the snapshot it runs beside goes on (lib/snapshot-job.ts). A
 * connection whose entry can't be read is left alone (and holds its accounts
 * out of the day's total, lib/connectors/institutions.ts).
 */
export async function syncConnectorsDaily(ctx: Ctx, opts: { now?: number } = {}): Promise<void> {
  const deadline = Date.now() + DAILY_DEADLINE_MS;
  try {
    const { entries, unreadable, unrecognised } = await connectionsStore.getAllReport(ctx);
    if (unreadable.length + unrecognised.length > 0) {
      console.error(`Connectors: ${unreadable.length + unrecognised.length} connection(s) in container ${ctx.container} could not be read and were not fetched.`);
    }
    await Promise.all(
      [...entries.keys()].map((id) =>
        syncConnection(ctx, id, { purpose: 'daily', now: opts.now, deadline }).catch((err) =>
          console.error(`Connectors: the daily fetch failed for a connection in container ${ctx.container}.`, loggable(err))
        )
      )
    );
  } catch (err) {
    console.error(`Connectors: the daily fetch could not start for container ${ctx.container}.`, loggable(err));
  }
}
