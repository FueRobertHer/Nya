// lib/user-restore/store.ts
//
// What bringing a download back into Nya keeps (docs/data-export.md,
// "Bringing it back"), on the storage seam (lib/repo.ts). Named "user-restore"
// throughout, never "restoring": that word is the operator's restore and the
// container registry's status (lib/containers.ts, lib/restore.ts).
//
//   user-restore      one value per container: the record of the one restore
//                     this account has had, written before anything else it
//                     writes: the file it came from (by its date, never its
//                     contents), the plan (every batch, by its SHA-256, in the
//                     order they are written), how many batches are written,
//                     what came back and what didn't, by count, and, once it
//                     finished, until when it can be undone. A second restore
//                     needs this one undone (or the account emptied). In the
//                     person's download: their record of what was brought back,
//                     and from which download.
//   restored-accounts one entry per account of a Plaid connection the download
//                     had, under the account's id: the bank's name and Plaid
//                     institution id, the account's name, mask, type, subtype
//                     and currency, and the days its restored rows span. What
//                     readers ask to know a restored account, without reading
//                     its rows.
//   restored-transactions  the bank's own posted rows of those accounts, kept
//                     whole (every field the bank store keeps), in books of at
//                     most BOOK_ROWS rows, under "<account id>.<part>" (a part
//                     number, never a date). Each row's id is restoredId() of
//                     the bank's own id, which everything said about it is
//                     keyed by: its prefix is an imported row's, so no pruner
//                     ever takes what is said about one for a vanished bank
//                     row's (lib/overrides.ts, lib/txn-annotations.ts,
//                     lib/split-gone.ts, lib/review-store.ts). Held, never
//                     counted, until the account is linked to a new one
//                     (lib/user-restore/restored.ts). Compressed.
//   restored-investment-transactions  the investment transactions of those
//                     connections, and which days they were checked complete
//                     for, as the download had them, in parts of at most
//                     BOOK_ROWS. Kept so they aren't lost on the next move; no
//                     reader reads them yet. Compressed.
//   restored-answers  one entry per restored account, under its id: what the
//                     person (or, for an account the file says ended, the
//                     restore) answered about it: count its transactions as an
//                     ended account's (`counted`, with the end that answer
//                     wrote, if it wrote one), the connections made since the
//                     restore it isn't at (Plaid Items and connector accounts,
//                     by id), and the connector account that carries it on
//                     (`handed_to`). The person's own answers: in the download,
//                     and a store the release before doesn't know, so a
//                     rollback holds the rows again (lib/user-restore/
//                     restored.ts, COUNTED BEFORE A LINK).
//   user-restore-starts, user-restore-batches, user-restore-previews
//                     the counters that bound starts (and undos and empties),
//                     batches and previews (each a scan of the container).
//
// READS ARE STRICT, as the seam's are. Every shape is closed: no release
// before this one writes these stores, and one that adds a field ships its
// reader first.

import { defineCounterStore, defineMapStore, defineValueStore } from '../repo';
import { BANK_FIELDS, isBankRecord, isCalendarDay, isCount, isId, isInstant, isInstantOrNull, isInvestmentRecord, isPlaidId, isRecord, isText, isTextOrNull, onlyKeys } from './records';
import type { StoredTxn } from '../transactions';
import { BOOK_ROWS, DIGEST, MAX_BATCHES, MAX_BOOKS, PART, bankIdOf, isRestoredId, isUserRestoreId } from './ids';

export {
  BOOK_ROWS,
  MAX_BOOKS,
  UNDO_DAYS,
  MAX_BATCHES,
  restoredId,
  isRestoredId,
  bankIdOf,
  restoredBookId,
  investmentPartId,
  investmentCoverageId,
  USER_RESTORE_ID,
  isUserRestoreId,
  newUserRestoreId,
} from './ids';

// ---- The record ----

export type UserRestoreStatus = 'writing' | 'finished' | 'undoing';

export type PlannedBatch = { part: string; count: number; digest: string };

export type UserRestoreRecord = {
  version: 1;
  /** "user-restore:" and a random UUID, minted by the page for the preview. */
  id: string;
  status: UserRestoreStatus;
  started_at: string;
  finished_at: string | null;
  /** When it can no longer be undone: UNDO_DAYS after it finished. */
  undo_until: string | null;
  last_batch_at: string | null;
  /** The download it came from: when it was made, its version and size, and
   *  whether it was protected with a passphrase. Never its name or contents. */
  source: { exported_at: string; version: 1 | 2; bytes: number; protected: boolean };
  /** Every batch, in the order they are written: its part, how many records,
   *  and the SHA-256 of its bytes. `digest` is the plan's own (of every
   *  batch's), which a resume is checked against. */
  plan: { digest: string; batches: PlannedBatch[] };
  /** How many of the plan's batches are written: always the first ones. */
  done: number;
  /** What came back, and what didn't, counted by part. */
  brought: Record<string, number>;
  left_out: Record<string, number>;
  /** Damaged entries the person chose to restore without, by part (decision
   *  6): how many. */
  without: Record<string, number>;
  /** The recorded days it brought back, or null for none. */
  history: { first: string; last: string } | null;
  /** A restored copy's own restores, from its download: when each was made. */
  earlier: { exported_at: string; restored_at: string }[];
};


const isCounts = (v: unknown): v is Record<string, number> =>
  isRecord(v) && Object.keys(v).length <= 200 && Object.entries(v).every(([k, n]) => PART.test(k) && isCount(n));

function isPlan(v: unknown): v is UserRestoreRecord['plan'] {
  return (
    isRecord(v) &&
    onlyKeys(v, ['digest', 'batches']) &&
    typeof v.digest === 'string' &&
    DIGEST.test(v.digest) &&
    Array.isArray(v.batches) &&
    v.batches.length >= 1 &&
    v.batches.length <= MAX_BATCHES &&
    v.batches.every((b) => isRecord(b) && onlyKeys(b, ['part', 'count', 'digest']) && typeof b.part === 'string' && PART.test(b.part) && isCount(b.count) && typeof b.digest === 'string' && DIGEST.test(b.digest))
  );
}

export function isUserRestoreRecord(v: unknown): v is UserRestoreRecord {
  if (!isRecord(v) || v.version !== 1) return false;
  if (!onlyKeys(v, ['version', 'id', 'status', 'started_at', 'finished_at', 'undo_until', 'last_batch_at', 'source', 'plan', 'done', 'brought', 'left_out', 'without', 'history', 'earlier'])) return false;
  const s = v.source;
  const h = v.history;
  return (
    isUserRestoreId(v.id) &&
    (v.status === 'writing' || v.status === 'finished' || v.status === 'undoing') &&
    isInstant(v.started_at) &&
    isInstantOrNull(v.finished_at) &&
    isInstantOrNull(v.undo_until) &&
    isInstantOrNull(v.last_batch_at) &&
    isRecord(s) &&
    onlyKeys(s, ['exported_at', 'version', 'bytes', 'protected']) &&
    isInstant(s.exported_at) &&
    (s.version === 1 || s.version === 2) &&
    isCount(s.bytes) &&
    typeof s.protected === 'boolean' &&
    isPlan(v.plan) &&
    isCount(v.done) &&
    v.done <= v.plan.batches.length &&
    isCounts(v.brought) &&
    isCounts(v.left_out) &&
    isCounts(v.without) &&
    (h === null || (isRecord(h) && onlyKeys(h, ['first', 'last']) && isCalendarDay(h.first) && isCalendarDay(h.last) && h.first <= h.last)) &&
    Array.isArray(v.earlier) &&
    v.earlier.length <= 50 &&
    v.earlier.every((e) => isRecord(e) && onlyKeys(e, ['exported_at', 'restored_at']) && isInstant(e.exported_at) && isInstant(e.restored_at))
  );
}

/** The record as the page is told it: the plan by its digest and length,
 *  since only the batch route compares batches (app/api/user-restore). */
export type RecordView = Omit<UserRestoreRecord, 'plan'> & { plan: { digest: string; batches: number } };

export function recordView(r: UserRestoreRecord): RecordView {
  const { plan, ...rest } = r;
  return { ...rest, plan: { digest: plan.digest, batches: plan.batches.length } };
}

export const userRestoreStore = defineValueStore<UserRestoreRecord>('user-restore', {
  what: 'records of bringing back a download',
  isValid: isUserRestoreRecord,
  exportable: true, // the person's record of what was brought back, and from which download
});

// ---- Restored accounts ----

export type RestoredAccount = {
  version: 1;
  restore_id: string;
  /** The connection it was on in the old copy (gone here). */
  item_id: string;
  institution_id: string | null;
  institution_name: string;
  name: string | null;
  mask: string | null;
  type: string | null;
  subtype: string | null;
  currency: string | null;
  /** The posted rows it brought back: the first and last day, how many, and
   *  in how many books (restoredBookId, parts 1 to `books`); null when it
   *  had none. */
  rows: { first: string; last: string; count: number; books: number } | null;
  /** The day the download was made: what its rows can cover up to, as an
   *  import's period does (lib/history-import/match.ts crossesEdge). */
  downloaded: string;
  restored_at: string;
};

export function isRestoredAccount(v: unknown): v is RestoredAccount {
  if (!isRecord(v) || v.version !== 1) return false;
  if (!onlyKeys(v, ['version', 'restore_id', 'item_id', 'institution_id', 'institution_name', 'name', 'mask', 'type', 'subtype', 'currency', 'rows', 'downloaded', 'restored_at'])) return false;
  const r = v.rows;
  return (
    isUserRestoreId(v.restore_id) &&
    isPlaidId(v.item_id) &&
    isTextOrNull(v.institution_id, 200) &&
    isText(v.institution_name, 500) &&
    isTextOrNull(v.name, 500) &&
    isTextOrNull(v.mask, 40) &&
    isTextOrNull(v.type, 40) &&
    isTextOrNull(v.subtype, 100) &&
    isTextOrNull(v.currency, 20) &&
    (r === null ||
      (isRecord(r) &&
        onlyKeys(r, ['first', 'last', 'count', 'books']) &&
        isCalendarDay(r.first) &&
        isCalendarDay(r.last) &&
        r.first <= r.last &&
        isCount(r.count) &&
        isCount(r.books) &&
        r.books >= 1 &&
        r.books <= MAX_BOOKS &&
        r.count <= r.books * BOOK_ROWS)) &&
    isCalendarDay(v.downloaded) &&
    isInstant(v.restored_at)
  );
}

export const restoredAccountsStore = defineMapStore<RestoredAccount>('restored-accounts', {
  what: 'accounts brought back from a download',
  isValid: isRestoredAccount,
  exportable: true, // which of the person's accounts came back from a download, and from which bank
});

// ---- Restored bank rows ----

export type RestoredTxn = {
  id: string;
  account_id: string;
  /** The restore that brought it (its record's id). */
  import_id: string;
  /** The bank's own transaction, every field the bank store keeps. */
  bank: StoredTxn;
  created_at: string;
};

export type RestoredBook = { version: 1; account_id: string; part: number; rows: RestoredTxn[] };

export function isRestoredTxn(v: unknown): v is RestoredTxn {
  return (
    isRecord(v) &&
    onlyKeys(v, ['id', 'account_id', 'import_id', 'bank', 'created_at']) &&
    isRestoredId(v.id) &&
    isPlaidId(v.account_id) &&
    isUserRestoreId(v.import_id) &&
    isBankRecord(v.bank) &&
    // Every field present, as the bank store holds a row.
    BANK_FIELDS.every((k) => k in (v.bank as object)) &&
    (v.bank as StoredTxn).transaction_id === bankIdOf(v.id) &&
    (v.bank as StoredTxn).account_id === v.account_id &&
    isInstant(v.created_at)
  );
}

/** A book: version 1, of one account and part, at most BOOK_ROWS rows, each
 *  id once. */
export function isRestoredBook(v: unknown): v is RestoredBook {
  if (!isRecord(v) || v.version !== 1 || !onlyKeys(v, ['version', 'account_id', 'part', 'rows'])) return false;
  if (!isPlaidId(v.account_id) || !(Number.isSafeInteger(v.part) && (v.part as number) >= 1 && (v.part as number) <= MAX_BOOKS)) return false;
  if (!Array.isArray(v.rows) || v.rows.length > BOOK_ROWS) return false;
  const ids = new Set<string>();
  for (const r of v.rows) {
    if (!isRestoredTxn(r) || r.account_id !== v.account_id || ids.has(r.id)) return false;
    ids.add(r.id);
  }
  return true;
}


export const restoredTxnStore = defineMapStore<RestoredBook>('restored-transactions', {
  what: 'transactions brought back from a download',
  isValid: isRestoredBook,
  exportable: true, // the person's own bank history, which no bank may serve again
  compress: true, // years of rows
});

// ---- Restored investment transactions ----

export type RestoredInvestments =
  | { version: 1; kind: 'rows'; item_id: string; part: number; rows: Record<string, unknown>[] }
  | { version: 1; kind: 'coverage'; item_id: string; coverage: { account_id: string; from: string; through: string }[] };

export function isRestoredInvestments(v: unknown): v is RestoredInvestments {
  if (!isRecord(v) || v.version !== 1 || !isPlaidId(v.item_id)) return false;
  if (v.kind === 'rows') {
    return (
      onlyKeys(v, ['version', 'kind', 'item_id', 'part', 'rows']) &&
      Number.isSafeInteger(v.part) &&
      (v.part as number) >= 1 &&
      Array.isArray(v.rows) &&
      v.rows.length <= BOOK_ROWS &&
      v.rows.every((r) => isInvestmentRecord(r) && r.item_id === v.item_id)
    );
  }
  if (v.kind === 'coverage') {
    return (
      onlyKeys(v, ['version', 'kind', 'item_id', 'coverage']) &&
      Array.isArray(v.coverage) &&
      v.coverage.length <= 1000 &&
      v.coverage.every((c) => isRecord(c) && onlyKeys(c, ['account_id', 'from', 'through']) && isText(c.account_id, 150) && isText(c.from, 40) && isText(c.through, 40))
    );
  }
  return false;
}

export const restoredInvestmentsStore = defineMapStore<RestoredInvestments>('restored-investment-transactions', {
  what: 'investment transactions brought back from a download',
  isValid: isRestoredInvestments,
  exportable: true, // the person's own investment history, which no bank may serve again
  compress: true,
});


// ---- What was answered about a restored account ----

/** An end, as the lifecycle store keeps one (lib/lifecycle.ts
 *  EndedLifecycle): checked here rather than imported, so the store
 *  catalogue loads nothing more. */
export type AnsweredEnd = { state: 'closed' | 'left'; on: string; note?: string } | { state: 'untracked'; from: string };

/** The ids an answer may name of each kind, at most: more connections than
 *  anyone makes while a restored bank waits. Each write drops the ids of
 *  connections that are gone (lib/user-restore/answers.ts). */
export const MAX_APART = 50;

export type RestoredAnswer = {
  version: 1;
  /** Its transactions count as an ended account's (decision 1): when, on
   *  whose word (`file`: the restore's, for an account the download says
   *  ended, as the old copy counted it), and the end that answer wrote, if
   *  it wrote one: taken away when the account is linked, and written back
   *  when it is unlinked. Null: not counted. */
  counted: { at: string; by: 'person' | 'file'; ended: AnsweredEnd | null } | null;
  /** The connections made since the restore it isn't at, by the person's
   *  word: Plaid Items and connector accounts (manual ones kept from them
   *  too), by id. */
  apart: { items: string[]; accounts: string[] };
  /** The connector account that carries it on: its rows count before that
   *  account's coverage begins (lib/user-restore/restored.ts handoverCut). */
  handed_to: { account_id: string; at: string } | null;
  set_at: string;
};

function isAnsweredEnd(v: unknown): v is AnsweredEnd {
  if (!isRecord(v)) return false;
  if (v.state === 'untracked') return onlyKeys(v, ['state', 'from']) && isCalendarDay(v.from);
  return (
    (v.state === 'closed' || v.state === 'left') &&
    onlyKeys(v, ['state', 'on', 'note']) &&
    isCalendarDay(v.on) &&
    (v.note === undefined || (isText(v.note, 200) && v.note.length > 0))
  );
}

const isIds = (v: unknown): v is string[] => Array.isArray(v) && v.length <= MAX_APART && v.every(isId) && new Set(v).size === v.length;

export function isRestoredAnswer(v: unknown): v is RestoredAnswer {
  if (!isRecord(v) || v.version !== 1 || !onlyKeys(v, ['version', 'counted', 'apart', 'handed_to', 'set_at'])) return false;
  const c = v.counted;
  const a = v.apart;
  const h = v.handed_to;
  return (
    (c === null ||
      (isRecord(c) && onlyKeys(c, ['at', 'by', 'ended']) && isInstant(c.at) && (c.by === 'person' || c.by === 'file') && (c.ended === null || isAnsweredEnd(c.ended)))) &&
    isRecord(a) &&
    onlyKeys(a, ['items', 'accounts']) &&
    isIds(a.items) &&
    isIds(a.accounts) &&
    (h === null || (isRecord(h) && onlyKeys(h, ['account_id', 'at']) && isId(h.account_id) && isInstant(h.at))) &&
    isInstant(v.set_at)
  );
}

export const restoredAnswersStore = defineMapStore<RestoredAnswer>('restored-answers', {
  what: 'answers about accounts brought back from a download',
  isValid: isRestoredAnswer,
  exportable: true, // the person's own answers about their accounts
});

// ---- Counters ----

/** Starts, undos and emptyings a day: each is a fresh sign-in and a sweep or
 *  a scan of the container. */
export const STARTS_PER_DAY = 5;
export const startsCount = defineCounterStore('user-restore-starts', { what: 'restore starts', windowSeconds: 24 * 60 * 60 });

/** Batches an hour: 2,000 batches of 3.5 MB is about 7 GB. */
export const BATCHES_PER_HOUR = 2_000;
export const batchesCount = defineCounterStore('user-restore-batches', { what: 'restore batches', windowSeconds: 60 * 60 });

/** Previews an hour: each scans the container's keys (a walk of the
 *  environment's keyspace, lib/account-deletion.ts containerKeys). */
export const PREVIEWS_PER_HOUR = 30;
export const previewsCount = defineCounterStore('user-restore-previews', { what: 'restore previews', windowSeconds: 60 * 60 });

