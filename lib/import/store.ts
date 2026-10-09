// lib/import/store.ts
//
// What an import keeps, on the storage seam (lib/repo.ts), beside the rows it
// adds to the account's book (lib/manual-txns.ts):
//
//   imports           one entry per import, under a random id: the file's raw
//                     records (each as the file had it, with what became of
//                     it: imported as which row, already there as which row,
//                     a stored row it replaced and how that row was before,
//                     skipped, repeated, or not read and why), the format,
//                     the account, when, how it was read, and the counts.
//                     Compressed, since a file's records can run to megabytes
//                     of JSON. Read whole only to undo an import and for the
//                     data download.
//                     "Keep the raw record" (#43, #52): when a row looks
//                     wrong years later, what the bank's file said is the
//                     only thing that can settle it. The records, not the
//                     file: they are what can be shown against a row, and a
//                     file's headers, other statements and other accounts
//                     are not the person's transactions on this account.
//   import-summaries  one small entry per import, under the same id, written
//                     and removed with it: what the sheet's list of imports
//                     shows (the account, file name, format, when, counts,
//                     dates, currency, statement, balance set), so listing an
//                     account's imports never reads a file's records. Derived
//                     from the entry, so not in the download, which has the
//                     entry whole.
//   import-settings   one entry per manual account: how its last file was
//                     read (a CSV's columns by name, its sign, decimal mark
//                     and date order; whether amounts were flipped) and the
//                     statement's account (bank, kind and last four of the
//                     number, never the whole number), so the next file from
//                     the same bank imports in one tap and a file for another
//                     account is caught.
//   import-requests   the service's count of import requests per person, an
//                     hour at a time: each one parses up to a few megabytes
//                     and encrypts its records, so a script holding a
//                     session can't run them in a loop.
//   import-reads      the same for reads of the list of imports and of what
//                     an undo would do, with a higher limit: each reads every
//                     account's transactions.
//
// The entries and the settings are in the person's download (exportable),
// since they are the person's own records and choices; the summaries are
// derived from the entries, and the counts are bookkeeping. All of them live
// in the container, so deleting the account deletes them; deleting a manual
// account deletes its imports' entries, summaries and its settings
// (lib/import/commit.ts forgetAccountImports).
//
// READS ARE STRICT, as the seam's are, except where a caller says otherwise:
// the list of imports shows what it can read and names what it can't, and
// only an entry whose bytes are damaged is ever removed, by an undo the
// person confirmed.

import { defineCounterStore, defineMapStore } from '../repo';
import { FILE_FORMATS, type FileFormat } from './record';

/** What became of one record of the file. */
export type RecordOutcome = 'imported' | 'present' | 'replaced' | 'skipped' | 'repeated' | 'unreadable';

/** A stored row as it was before an import replaced it with the file's
 *  version (lib/import/commit.ts): what its undo puts back. */
export type ReplacedBefore = {
  date: string;
  amount: number;
  currency: string;
  name: string;
  category: string | null;
  note: string | null;
  transaction_code: string | null;
};

export type StoredImportRecord = {
  /** Where it starts in the file, when it came from one. */
  line: number | null;
  outcome: RecordOutcome;
  /** The row it became (imported), was found as (present), replaced, or was
   *  skipped beside (skipped: a stored row with its FITID). */
  row_id?: string;
  /** Why it wasn't read, or was skipped. */
  reason?: string;
  /** Replaced: the stored row as it was before. */
  before?: ReplacedBefore;
  /** As the file had it: an OFX transaction's fields, a CSV line's cells, a
   *  QIF record's lines. */
  raw: unknown;
};

/** The statement or account of the file it came from, never its full number. */
export type StoredStatement = {
  kind: 'bank' | 'creditcard';
  label: string;
  bank_id: string | null;
  mask: string | null;
  type: string | null;
  currency: string | null;
  start: string | null;
  end: string | null;
  ledger: { amount: number; as_of: string | null } | null;
};

export type ImportCounts = {
  imported: number;
  present: number;
  repeated: number;
  unreadable: number;
  /** Stored rows it replaced with the file's version, and rows it skipped
   *  (conflicts the person chose so for: lib/import/match.ts). */
  replaced?: number;
  skipped?: number;
};

const isCounts = (c: unknown): c is ImportCounts =>
  isRecord(c) &&
  isCount(c.imported) &&
  isCount(c.present) &&
  isCount(c.repeated) &&
  isCount(c.unreadable) &&
  (c.replaced === undefined || isCount(c.replaced)) &&
  (c.skipped === undefined || isCount(c.skipped));

export type ImportEntry = {
  version: 1;
  /** The manual account it was imported into. */
  account_id: string;
  format: FileFormat;
  /** The source its rows carry: 'import:ofx', 'import:csv', 'import:qif'. */
  source: string;
  /** As the person's device named the file, if it did. */
  file_name: string | null;
  file_bytes: number;
  /** How its bytes were read as text (lib/import/text.ts). */
  encoding: string;
  imported_at: string;
  /** The currency most of its rows are in, and the days they cover. */
  currency: string | null;
  first_date: string | null;
  last_date: string | null;
  counts: ImportCounts;
  /** How it was read: the options the person chose, and what was found. */
  read: Record<string, unknown>;
  statement: StoredStatement | null;
  /** A CSV file's column names. */
  columns: string[] | null;
  /** The balance it also set, from the statement's (lib/import/commit.ts). */
  balance_update?: { from: number; to: number; as_of: string } | null;
  records: StoredImportRecord[];
};

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
function isCount(v: unknown): boolean {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0;
}
const isTextOrNull = (v: unknown) => v === null || typeof v === 'string';
const isInstant = (v: unknown) => typeof v === 'string' && !Number.isNaN(Date.parse(v));
const OUTCOMES: ReadonlySet<string> = new Set(['imported', 'present', 'replaced', 'skipped', 'repeated', 'unreadable']);

function isBefore(v: unknown): v is ReplacedBefore {
  return (
    isRecord(v) &&
    typeof v.date === 'string' &&
    typeof v.amount === 'number' &&
    Number.isFinite(v.amount) &&
    typeof v.currency === 'string' &&
    typeof v.name === 'string' &&
    isTextOrNull(v.category) &&
    isTextOrNull(v.note) &&
    isTextOrNull(v.transaction_code)
  );
}

function isStoredRecord(v: unknown): v is StoredImportRecord {
  return (
    isRecord(v) &&
    (v.line === null || isCount(v.line)) &&
    typeof v.outcome === 'string' &&
    OUTCOMES.has(v.outcome) &&
    (v.row_id === undefined || typeof v.row_id === 'string') &&
    (v.reason === undefined || typeof v.reason === 'string') &&
    (v.before === undefined || isBefore(v.before)) &&
    (v.outcome !== 'replaced' || (typeof v.row_id === 'string' && isBefore(v.before))) &&
    'raw' in v
  );
}

function isStatement(v: unknown): v is StoredStatement {
  return (
    isRecord(v) &&
    (v.kind === 'bank' || v.kind === 'creditcard') &&
    typeof v.label === 'string' &&
    isTextOrNull(v.bank_id) &&
    isTextOrNull(v.mask) &&
    isTextOrNull(v.type) &&
    isTextOrNull(v.currency) &&
    isTextOrNull(v.start) &&
    isTextOrNull(v.end) &&
    (v.ledger === null || (isRecord(v.ledger) && typeof v.ledger.amount === 'number' && isTextOrNull(v.ledger.as_of)))
  );
}

/**
 * One import's entry: the shape and types, with any field a later release
 * adds kept as it is, so a rollback reads newer entries rather than calling
 * them unrecognised.
 */
export function isImportEntry(v: unknown): v is ImportEntry {
  if (!isRecord(v) || v.version !== 1) return false;
  return (
    typeof v.account_id === 'string' &&
    (FILE_FORMATS as readonly unknown[]).includes(v.format) &&
    typeof v.source === 'string' &&
    isTextOrNull(v.file_name) &&
    isCount(v.file_bytes) &&
    typeof v.encoding === 'string' &&
    isInstant(v.imported_at) &&
    isTextOrNull(v.currency) &&
    isTextOrNull(v.first_date) &&
    isTextOrNull(v.last_date) &&
    isCounts(v.counts) &&
    isRecord(v.read) &&
    (v.statement === null || isStatement(v.statement)) &&
    (v.columns === null || (Array.isArray(v.columns) && v.columns.every((x) => typeof x === 'string'))) &&
    isBalanceUpdate(v.balance_update) &&
    Array.isArray(v.records) &&
    v.records.every(isStoredRecord)
  );
}

function isBalanceUpdate(v: unknown): boolean {
  return v === undefined || v === null || (isRecord(v) && typeof v.from === 'number' && typeof v.to === 'number' && typeof v.as_of === 'string');
}

export const importStore = defineMapStore<ImportEntry>('imports', {
  what: 'file imports',
  isValid: isImportEntry,
  exportable: true, // the person's own records, as their bank's files had them
  compress: true, // a file's records can be large
});

// ---- What the list of imports shows ----

/** An import as the sheet's list shows it: its entry without the records. */
export type StoredImportSummary = {
  version: 1;
  account_id: string;
  format: FileFormat;
  file_name: string | null;
  imported_at: string;
  currency: string | null;
  first_date: string | null;
  last_date: string | null;
  counts: ImportCounts;
  /** The statement or account of the file, as the sheet named it. */
  statement: string | null;
  balance_update: { from: number; to: number; as_of: string } | null;
  /** Rows an earlier import had added that this one found already there,
   *  kept for this one when that import was undone (lib/import/commit.ts
   *  undoImport): this one's Undo takes them out. */
  taken_over?: number;
};

export function isImportSummary(v: unknown): v is StoredImportSummary {
  return (
    isRecord(v) &&
    v.version === 1 &&
    typeof v.account_id === 'string' &&
    (FILE_FORMATS as readonly unknown[]).includes(v.format) &&
    isTextOrNull(v.file_name) &&
    isInstant(v.imported_at) &&
    isTextOrNull(v.currency) &&
    isTextOrNull(v.first_date) &&
    isTextOrNull(v.last_date) &&
    isCounts(v.counts) &&
    isTextOrNull(v.statement) &&
    isBalanceUpdate(v.balance_update) &&
    (v.taken_over === undefined || isCount(v.taken_over))
  );
}

/** An entry's summary. */
export function summaryOf(e: ImportEntry, taken_over = 0): StoredImportSummary {
  return {
    version: 1,
    account_id: e.account_id,
    format: e.format,
    file_name: e.file_name,
    imported_at: e.imported_at,
    currency: e.currency,
    first_date: e.first_date,
    last_date: e.last_date,
    counts: e.counts,
    statement: e.statement?.label ?? null,
    balance_update: e.balance_update ?? null,
    ...(taken_over > 0 ? { taken_over } : {}),
  };
}

export const importSummaryStore = defineMapStore<StoredImportSummary>('import-summaries', {
  what: 'import summaries',
  isValid: isImportSummary,
  exportable: false, // derived from the entries, which the download has whole
});

/** An import's id: "import:" and a random UUID, as plain in the database as
 *  every field name is, and saying nothing about the file. */
export function newImportId(): string {
  return `import:${crypto.randomUUID()}`;
}

export function isImportId(id: unknown): id is string {
  return typeof id === 'string' && /^import:[A-Za-z0-9-]{8,64}$/.test(id);
}

// ---- What each account's last file taught ----

export type ImportSettings = {
  version: 1;
  /** A CSV file's mapping, by column name, and how its values were read. */
  csv?: {
    columns: Record<string, string>;
    sign: 'negative-out' | 'positive-out';
    decimal: '.' | ',' | null;
    date_order: 'mdy' | 'dmy' | null;
    delimiter: string;
    currency: string;
  } | null;
  /** An OFX file's statement account (masked), whether its amounts were read
   *  the other way round, and the currency chosen for a file whose statement
   *  doesn't say one. */
  ofx?: {
    statement: { kind: 'bank' | 'creditcard'; bank_id: string | null; mask: string | null; type: string | null } | null;
    flip: boolean;
    currency?: string;
  } | null;
  qif?: { date_order: 'mdy' | 'dmy' | null; decimal: '.' | ',' | null; flip: boolean; currency: string } | null;
  updated_at: string;
};

const isOrderOrNull = (v: unknown) => v === null || v === 'mdy' || v === 'dmy';
const isMarkOrNull = (v: unknown) => v === null || v === '.' || v === ',';

/** An account's import settings: the fields it knows, and any others kept. */
export function isImportSettings(v: unknown): v is ImportSettings {
  if (!isRecord(v) || v.version !== 1 || !isInstant(v.updated_at)) return false;
  const { csv, ofx, qif } = v;
  const csvOk =
    csv === undefined ||
    csv === null ||
    (isRecord(csv) &&
      isRecord(csv.columns) &&
      Object.values(csv.columns).every((x) => typeof x === 'string') &&
      (csv.sign === 'negative-out' || csv.sign === 'positive-out') &&
      isMarkOrNull(csv.decimal) &&
      isOrderOrNull(csv.date_order) &&
      typeof csv.delimiter === 'string' &&
      typeof csv.currency === 'string');
  const ofxOk =
    ofx === undefined ||
    ofx === null ||
    (isRecord(ofx) &&
      typeof ofx.flip === 'boolean' &&
      (ofx.currency === undefined || typeof ofx.currency === 'string') &&
      (ofx.statement === null ||
        (isRecord(ofx.statement) &&
          (ofx.statement.kind === 'bank' || ofx.statement.kind === 'creditcard') &&
          isTextOrNull(ofx.statement.bank_id) &&
          isTextOrNull(ofx.statement.mask) &&
          isTextOrNull(ofx.statement.type))));
  const qifOk =
    qif === undefined ||
    qif === null ||
    (isRecord(qif) && isOrderOrNull(qif.date_order) && isMarkOrNull(qif.decimal) && typeof qif.flip === 'boolean' && typeof qif.currency === 'string');
  return csvOk && ofxOk && qifOk;
}

export const importSettingsStore = defineMapStore<ImportSettings>('import-settings', {
  what: 'import settings',
  isValid: isImportSettings,
  exportable: true, // what the person chose, for their own accounts
});

// ---- The request limit ----

/** Import requests (previews, imports and undos) one person may make an
 *  hour: far more than importing any number of files by hand takes. */
export const IMPORT_REQUESTS_PER_HOUR = 100;

export const importRequests = defineCounterStore('import-requests', {
  what: 'import request counts',
  windowSeconds: 60 * 60,
});

/** Reads of the list of imports and of what an undo would do, one person may
 *  make an hour: the sheet makes one each time it opens or changes, so this
 *  is far more than using it takes. */
export const IMPORT_READS_PER_HOUR = 300;

export const importReads = defineCounterStore('import-reads', {
  what: 'import list read counts',
  windowSeconds: 60 * 60,
});

export type ImportAllowance = { ok: true } | { ok: false; retryAfterSeconds: number };

/** Counts one request and says whether it is within the limit. Throws if the
 *  count can't be taken: the route then refuses, since an import is never
 *  urgent and a limit that can't be read must not open. */
export async function takeImportRequest(ctx: Parameters<typeof importRequests.take>[0]): Promise<ImportAllowance> {
  const { count, secondsLeft } = await importRequests.take(ctx);
  return count <= IMPORT_REQUESTS_PER_HOUR ? { ok: true } : { ok: false, retryAfterSeconds: secondsLeft };
}

/** The same for a read of the list of imports or of an undo's plan. */
export async function takeImportRead(ctx: Parameters<typeof importReads.take>[0]): Promise<ImportAllowance> {
  const { count, secondsLeft } = await importReads.take(ctx);
  return count <= IMPORT_READS_PER_HOUR ? { ok: true } : { ok: false, retryAfterSeconds: secondsLeft };
}
