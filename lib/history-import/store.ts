// lib/history-import/store.ts
//
// What importing history into a LINKED account keeps (#52), on the storage
// seam (lib/repo.ts). Not in the bank's transaction store
// (lib/transactions.ts): that is Plaid's, rewritten by every sync from what
// Plaid sends, refused whole past the size ceiling, and deleted when the
// institution is disconnected, so rows kept there would be lost to a
// disconnect, or fail every sync of an institution grown large.
//
//   imported-transactions     one BOOK per account, under the Plaid account id
//                             the rows were imported into, each its rows,
//                             compressed: the shape of a manual account's book
//                             (lib/manual-txns.ts). Kept past a disconnect, as
//                             balance history is, so a re-linked account keeps
//                             its imported history once the person links the
//                             two (lib/links.ts): readers follow the links, so
//                             an account's rows are every book of every id it
//                             has had. Gone when that earlier account is
//                             forgotten, and with the container.
//   history-imports           one entry per import, under a random id: the
//                             file's records as the bank had them (`raw`,
//                             always), each with what became of it (imported as
//                             which row, kept as a duplicate of which bank row,
//                             already imported as which row, repeated, skipped,
//                             or not read and why), the format, the account,
//                             when, the period the file covers, the bank's
//                             earliest row when it was reviewed, how it was
//                             read, and the counts. Compressed. Read whole only
//                             to undo an import and for the data download. A
//                             row's raw record is its import's record naming
//                             the row (row_id), one lookup away and kept for as
//                             long as the row is: kept apart from the book,
//                             which every Activity load reads, as for a manual
//                             account's imports (lib/import/store.ts).
//   history-import-summaries  one small entry per import, under the same id,
//                             written and removed with it: what the list of
//                             imports shows, and the periods the walk reads
//                             (lib/history-import/extend.ts), so neither
//                             decompresses a file's records.
//   imported-history-walk     one entry ("walk"): what the estimated history
//                             built from imported rows covers (the anchor, the
//                             oldest day drawn, how far back each account
//                             reaches and the stretches not drawn, with why),
//                             and whether it needs building again. Bookkeeping:
//                             not in the download, which has the points
//                             themselves (lib/history.ts).
//
// How a file was read is remembered per account in lib/import/store.ts's
// import-settings, and import requests count against its limits, as a manual
// account's do: one person, one budget of imports an hour.
//
// THE ROWS. Each carries its source ('import:ofx', 'import:csv',
// 'import:qif'), its source's id (OFX's FITID, or a CSV or QIF row's content
// key: lib/import/normalize.ts), the hashed key of an OFX row, its import, and
// what the review decided: nothing (a transaction of its own), `same_as` (the
// bank's row, by its key: kept so that bank row is claimed and a re-import of
// the same period finds it, never counted), or `distinct_from` (the bank rows
// the person said it is not). Rows are never edited: a category is changed
// over them (lib/overrides.ts) and an exclusion beside them
// (lib/txn-annotations.ts), as a bank's row is, and both go with the row.
//
// READS ARE STRICT, as the seam's are. A book that can't be read is named and
// its account's imported rows aren't shown or walked, never read as none.

import { defineMapStore } from '../repo';
import { isCalendarDay, isCurrencyCode } from '../manual-txn-input';
import { FILE_FORMATS, type FileFormat } from '../import/record';
import type { StoredStatement } from '../import/store';
import { IMPORTED_TXN_PREFIX } from './view';

/** The prefix of an imported row's id (kept in lib/history-import/view.ts,
 *  which client code can import), so it is never taken for a bank's
 *  transaction id or a manual row's: what's said about it isn't pruned with
 *  the bank's (lib/overrides.ts, lib/txn-annotations.ts), and the Activity
 *  tab never offers to edit it as a manual row. */
export { IMPORTED_TXN_PREFIX };

export function newImportedTxnId(): string {
  return `${IMPORTED_TXN_PREFIX}${crypto.randomUUID()}`;
}

export function isImportedTxnId(id: unknown): id is string {
  return typeof id === 'string' && id.startsWith(IMPORTED_TXN_PREFIX) && /^[A-Za-z0-9_.:-]{14,200}$/.test(id);
}

/** One row imported into a linked account. Amounts use Plaid's sign:
 *  positive is money out. */
export type ImportedTxn = {
  id: string;
  /** The account it was imported into, by its id then: the book it is in. */
  account_id: string;
  date: string;
  amount: number;
  currency: string;
  name: string;
  category: string | null;
  note: string | null;
  /** 'import:ofx', 'import:csv' or 'import:qif'. */
  source: string;
  /** OFX's FITID, or for a file without ids the content key it was imported
   *  with (lib/import/normalize.ts). */
  source_id: string | null;
  /** An OFX row's content key, hashed (lib/import/normalize.ts keyHash). */
  source_key?: string;
  /** Plaid's code for what its file said it was ("atm"), when it said so. */
  transaction_code?: string | null;
  import_id: string;
  /** A duplicate: the bank's row it is, by key (lib/history-import/match.ts
   *  bankKey). Never counted; kept so that row is claimed and a re-import
   *  finds it. */
  same_as?: string | null;
  /** The bank's rows (by key) the person said it is not. */
  distinct_from?: string[];
  created_at: string;
};

export type ImportedBook = { version: 1; rows: ImportedTxn[] };

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isInstant = (v: unknown) => typeof v === 'string' && !Number.isNaN(Date.parse(v));
const isTextOrNull = (v: unknown) => v === null || typeof v === 'string';
const isCount = (v: unknown) => typeof v === 'number' && Number.isInteger(v) && v >= 0;
const isSource = (v: unknown) => typeof v === 'string' && v.length <= 40 && /^[a-z][a-z0-9]*(?::[a-z0-9]+)*$/.test(v);
const isKey = (v: unknown) => typeof v === 'string' && v.length <= 2_000;

/** One stored row: the shape and types, with fields a later release adds kept
 *  as they are. */
export function isImportedTxn(v: unknown): v is ImportedTxn {
  return (
    isRecord(v) &&
    isImportedTxnId(v.id) &&
    typeof v.account_id === 'string' &&
    isCalendarDay(v.date) &&
    typeof v.amount === 'number' &&
    Number.isFinite(v.amount) &&
    isCurrencyCode(v.currency) &&
    typeof v.name === 'string' &&
    isTextOrNull(v.category) &&
    isTextOrNull(v.note) &&
    isSource(v.source) &&
    isTextOrNull(v.source_id) &&
    (v.source_key === undefined || (typeof v.source_key === 'string' && v.source_key.length <= 64)) &&
    (v.transaction_code === undefined || v.transaction_code === null || (typeof v.transaction_code === 'string' && v.transaction_code.length <= 40)) &&
    typeof v.import_id === 'string' &&
    (v.same_as === undefined || v.same_as === null || isKey(v.same_as)) &&
    (v.distinct_from === undefined || (Array.isArray(v.distinct_from) && v.distinct_from.length <= 64 && v.distinct_from.every(isKey))) &&
    isInstant(v.created_at)
  );
}

/** A book: version 1, every row valid, each id once, all of one account. */
export function isImportedBook(v: unknown): v is ImportedBook {
  if (!isRecord(v) || v.version !== 1 || !Array.isArray(v.rows)) return false;
  const ids = new Set<string>();
  let account: string | null = null;
  for (const row of v.rows) {
    if (!isImportedTxn(row) || ids.has(row.id)) return false;
    if (account !== null && row.account_id !== account) return false;
    ids.add(row.id);
    account = row.account_id;
  }
  return true;
}

export const importedTxnStore = defineMapStore<ImportedBook>('imported-transactions', {
  what: 'transactions imported into linked accounts',
  isValid: isImportedBook,
  exportable: true, // the person's own history, from their bank's files
  compress: true, // years of rows
});

// ---- Each import's records ----

/** What became of one record of the file. */
export type HistoryRecordOutcome = 'imported' | 'duplicate' | 'present' | 'repeated' | 'skipped' | 'unreadable';

/** The bank's row a proposal named, as it was shown, and what the person
 *  said: the same transaction, or one of its own. */
export type ProposalRecord = {
  transaction_id: string;
  date: string;
  name: string;
  amount: number;
  days: number;
  confidence: 'high' | 'medium' | 'low';
  chose: 'same' | 'new';
};

export type HistoryImportRecord = {
  line: number | null;
  outcome: HistoryRecordOutcome;
  /** The row it became (imported, duplicate), or was found as (present). */
  row_id?: string;
  /** The bank's row it was proposed as. */
  bank?: ProposalRecord;
  /** Why it wasn't read, or was skipped. */
  reason?: string;
  /** As the file had it. */
  raw: unknown;
};

export type HistoryImportCounts = {
  /** Added and counted. */
  imported: number;
  /** Kept as duplicates of the bank's rows. */
  duplicates: number;
  /** Already imported for the account. */
  present: number;
  repeated: number;
  skipped: number;
  unreadable: number;
};

/** The days a file covers, which the walk may cross: its statement's period
 *  (OFX), or its first to last day, or wider where the person said so
 *  (`stated`). */
export type Covers = { from: string; to: string; stated: boolean };

export type HistoryImportEntry = {
  version: 1;
  /** The linked account it was imported into, by its id then. */
  account_id: string;
  format: FileFormat;
  source: string;
  file_name: string | null;
  file_bytes: number;
  encoding: string;
  imported_at: string;
  currency: string | null;
  first_date: string | null;
  last_date: string | null;
  covers: Covers;
  /** The bank's earliest row for the connection when it was reviewed. */
  bank_from: string | null;
  counts: HistoryImportCounts;
  read: Record<string, unknown>;
  statement: StoredStatement | null;
  columns: string[] | null;
  records: HistoryImportRecord[];
};

const OUTCOMES: ReadonlySet<string> = new Set(['imported', 'duplicate', 'present', 'repeated', 'skipped', 'unreadable']);
const CONFIDENCES: ReadonlySet<unknown> = new Set(['high', 'medium', 'low']);

function isProposalRecord(v: unknown): v is ProposalRecord {
  return (
    isRecord(v) &&
    typeof v.transaction_id === 'string' &&
    typeof v.date === 'string' &&
    typeof v.name === 'string' &&
    typeof v.amount === 'number' &&
    isCount(v.days) &&
    CONFIDENCES.has(v.confidence) &&
    (v.chose === 'same' || v.chose === 'new')
  );
}

function isRecordOf(v: unknown): v is HistoryImportRecord {
  return (
    isRecord(v) &&
    (v.line === null || isCount(v.line)) &&
    typeof v.outcome === 'string' &&
    OUTCOMES.has(v.outcome) &&
    (v.row_id === undefined || typeof v.row_id === 'string') &&
    (v.bank === undefined || isProposalRecord(v.bank)) &&
    (v.reason === undefined || typeof v.reason === 'string') &&
    'raw' in v
  );
}

function isCounts(v: unknown): v is HistoryImportCounts {
  return isRecord(v) && isCount(v.imported) && isCount(v.duplicates) && isCount(v.present) && isCount(v.repeated) && isCount(v.skipped) && isCount(v.unreadable);
}

export function isCovers(v: unknown): v is Covers {
  return isRecord(v) && isCalendarDay(v.from) && isCalendarDay(v.to) && v.from <= v.to && typeof v.stated === 'boolean';
}

const isDayOrNull = (v: unknown) => v === null || isCalendarDay(v);

/** One import's entry, with any field a later release adds kept. */
export function isHistoryImportEntry(v: unknown): v is HistoryImportEntry {
  return (
    isRecord(v) &&
    v.version === 1 &&
    typeof v.account_id === 'string' &&
    (FILE_FORMATS as readonly unknown[]).includes(v.format) &&
    typeof v.source === 'string' &&
    isTextOrNull(v.file_name) &&
    isCount(v.file_bytes) &&
    typeof v.encoding === 'string' &&
    isInstant(v.imported_at) &&
    isTextOrNull(v.currency) &&
    isDayOrNull(v.first_date) &&
    isDayOrNull(v.last_date) &&
    isCovers(v.covers) &&
    isDayOrNull(v.bank_from) &&
    isCounts(v.counts) &&
    isRecord(v.read) &&
    (v.statement === null || isRecord(v.statement)) &&
    (v.columns === null || (Array.isArray(v.columns) && v.columns.every((x) => typeof x === 'string'))) &&
    Array.isArray(v.records) &&
    v.records.every(isRecordOf)
  );
}

export const historyImportStore = defineMapStore<HistoryImportEntry>('history-imports', {
  what: 'imports into linked accounts',
  isValid: isHistoryImportEntry,
  exportable: true, // the person's own records, as their bank's files had them
  compress: true, // a file's records can be large
});

// ---- What the list of imports, and the walk, read ----

export type HistoryImportSummary = {
  version: 1;
  account_id: string;
  format: FileFormat;
  file_name: string | null;
  imported_at: string;
  currency: string | null;
  first_date: string | null;
  last_date: string | null;
  covers: Covers;
  bank_from: string | null;
  counts: HistoryImportCounts;
  statement: string | null;
  /** Rows an earlier import had added that this one found already there,
   *  kept for this one when that import was undone. */
  taken_over?: number;
};

export function isHistoryImportSummary(v: unknown): v is HistoryImportSummary {
  return (
    isRecord(v) &&
    v.version === 1 &&
    typeof v.account_id === 'string' &&
    (FILE_FORMATS as readonly unknown[]).includes(v.format) &&
    isTextOrNull(v.file_name) &&
    isInstant(v.imported_at) &&
    isTextOrNull(v.currency) &&
    isDayOrNull(v.first_date) &&
    isDayOrNull(v.last_date) &&
    isCovers(v.covers) &&
    isDayOrNull(v.bank_from) &&
    isCounts(v.counts) &&
    isTextOrNull(v.statement) &&
    (v.taken_over === undefined || isCount(v.taken_over))
  );
}

export function summaryOfEntry(e: HistoryImportEntry, taken_over = 0): HistoryImportSummary {
  return {
    version: 1,
    account_id: e.account_id,
    format: e.format,
    file_name: e.file_name,
    imported_at: e.imported_at,
    currency: e.currency,
    first_date: e.first_date,
    last_date: e.last_date,
    covers: e.covers,
    bank_from: e.bank_from,
    counts: e.counts,
    statement: e.statement?.label ?? null,
    ...(taken_over > 0 ? { taken_over } : {}),
  };
}

export const historyImportSummaryStore = defineMapStore<HistoryImportSummary>('history-import-summaries', {
  what: 'summaries of imports into linked accounts',
  isValid: isHistoryImportSummary,
  exportable: false, // derived from the entries, which the download has whole
});

/** An import's id: "history-import:" and a random UUID, saying nothing about
 *  the file. */
export function newHistoryImportId(): string {
  return `history-import:${crypto.randomUUID()}`;
}

export function isHistoryImportId(id: unknown): id is string {
  return typeof id === 'string' && /^history-import:[A-Za-z0-9-]{8,64}$/.test(id);
}

// ---- What the estimated history built from imports covers ----

/** One account's reach, as lib/history-import/walk.ts AccountReach. */
export type WalkAccountState = {
  account_id: string;
  reach: string | null;
  why: 'not-counted' | 'anchor-not-covered' | null;
  gaps: { imported: { from: string; to: string }; uncovered: { from: string; to: string } }[];
  capped: boolean;
};

export type WalkState = {
  version: 1;
  /** Bumped by everything that changes what the walk would draw: an import,
   *  an undo, a link or an unlink, a forget, a new backfill. */
  generation: number;
  /** The generation last drawn, or null when none is, or the drawing that
   *  ran was overtaken by a change (stale). */
  built: number | null;
  built_at: string | null;
  /** The earliest point it joined, and the oldest day it drew (null: none). */
  anchor: string | null;
  from: string | null;
  /** The days it drew, so the next drawing clears exactly them. */
  drawn: { from: string; until: string } | null;
  accounts: WalkAccountState[];
};

const isDayRange = (v: unknown) => isRecord(v) && isCalendarDay(v.from) && isCalendarDay(v.to);

function isWalkAccountState(v: unknown): v is WalkAccountState {
  return (
    isRecord(v) &&
    typeof v.account_id === 'string' &&
    isDayOrNull(v.reach) &&
    (v.why === null || v.why === 'not-counted' || v.why === 'anchor-not-covered') &&
    Array.isArray(v.gaps) &&
    v.gaps.every((g) => isRecord(g) && isDayRange(g.imported) && isDayRange(g.uncovered)) &&
    typeof v.capped === 'boolean'
  );
}

export function isWalkState(v: unknown): v is WalkState {
  return (
    isRecord(v) &&
    v.version === 1 &&
    isCount(v.generation) &&
    (v.built === null || isCount(v.built)) &&
    (v.built_at === null || isInstant(v.built_at)) &&
    isDayOrNull(v.anchor) &&
    isDayOrNull(v.from) &&
    (v.drawn === null || (isRecord(v.drawn) && isCalendarDay(v.drawn.from) && isCalendarDay(v.drawn.until))) &&
    Array.isArray(v.accounts) &&
    v.accounts.every(isWalkAccountState)
  );
}

export const historyWalkStore = defineMapStore<WalkState>('imported-history-walk', {
  what: 'estimated history from imports',
  isValid: isWalkState,
  exportable: false, // bookkeeping: the download has the points themselves
});

/** The one entry the walk state is kept under. */
export const WALK_ID = 'walk';
