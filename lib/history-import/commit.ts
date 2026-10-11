// lib/history-import/commit.ts
//
// Committing an import into a LINKED account (#52), undoing it, and listing
// an account's imports: the only part of lib/history-import/ that writes.
//
// ONLY WHAT WAS REVIEWED. The commit works the plan out again
// (lib/history-import/plan.ts) against the account as it is at that moment,
// and refuses (ReviewChangedError, 409) when it no longer matches the review
// the person saw: a sync that brought the bank's rows for the period, a
// re-link, or another import landing between the review and the commit
// changes which rows are proposals, and a choice made for one proposal must
// never be applied to another. It refuses too while a FITID conflict or a
// low-confidence proposal has no answer (UnansweredError).
//
// ONE STEP, OR NONE, as a manual account's import (lib/import/commit.ts): the
// file's records are kept first (lib/history-import/store.ts history-imports,
// refused whole when too large), then the rows go into the account's book in
// one compare-and-set (MapStore.updateMany) over every book of every id the
// account has had, matched again inside it, so a file is never half imported
// and nothing written meanwhile is overwritten. A book the import would take
// past the size ceiling is refused whole (StoredValueTooLargeError, 413),
// never trimmed. If the rows can't be written, the records go again, unless
// the book may hold them after all.
//
// NEVER THE BANK'S OWN STORE, NEVER THE REAL HISTORY. An import writes its
// rows and its records, nothing else: the bank's transactions
// (lib/transactions.ts) and the recorded balances (lib/history.ts) are
// untouched. The estimated history is drawn from them afterwards
// (lib/history-import/extend.ts), into the estimated layer only.
//
// UNDO takes out every row the import kept (counted ones and duplicates)
// except those a later import found already there, which it hands to the
// earliest such import, and what was said about them (an exclusion, a
// category), their splits and their places in groups (lib/split-gone.ts),
// then its records. The import changed nothing else, so the
// account is exactly as it was before it; which rows count is worked out on
// every read (lib/history-import/match.ts settle), so that is as it was too:
// a later import's duplicate of one of its rows counts again.

import { createHash } from 'node:crypto';
import type { Ctx } from '../containers';
import { MANY_AT_ONCE, StoreRefusedError, StoredDataUnreadableError, UnreadableEntriesError } from '../repo';
import { forgetAnnotations } from '../txn-annotations';
import { forgetOverrides } from '../overrides';
import { forgetSplitsAndGroups } from '../split-gone';
import { loggable } from '../log-safe';
import type { FileFormat, Problem } from '../import/record';
import type { NormalizedRecord } from '../import/normalize';
import type { StatementInfo } from '../import/read';
import { importSettingsStore, type StoredStatement } from '../import/store';
import { bankKey as keyOf, type BankRow, type Settled } from './match';
import { planHistoryImport, type HistoryChoices, type HistoryPlan, type Period } from './plan';
import {
  historyImportStore,
  historyImportSummaryStore,
  importedTxnStore,
  newHistoryImportId,
  newImportedTxnId,
  summaryOfEntry,
  type Covers,
  type HistoryImportCounts,
  type HistoryImportEntry,
  type HistoryImportRecord,
  type HistoryImportSummary,
  type ImportedBook,
  type ImportedTxn,
} from './store';

/** The fingerprint of a review (HistoryPlan.review) a request carries back:
 *  equal fingerprints are the same review. */
export function reviewDigest(review: string): string {
  return createHash('sha256').update(review).digest('hex').slice(0, 32);
}

/** The plan changed since the review the person saw: nothing was written. */
export class ReviewChangedError extends Error {
  constructor() {
    super('What this account holds changed since you reviewed this file (a sync, a re-link or another import), so nothing was imported. Review it again.');
    this.name = 'ReviewChangedError';
  }
}

/** Rows still waiting for an answer: nothing was written. */
export class UnansweredError extends Error {
  constructor(readonly count: number) {
    super(
      count === 1
        ? 'One row in this file still needs an answer: say whether it is the bank’s transaction or one of its own, then import.'
        : `${count.toLocaleString('en-US')} rows in this file still need an answer: say whether each is the bank’s transaction or one of its own, then import.`
    );
    this.name = 'UnansweredError';
  }
}

/**
 * The days a file covers (see lib/history-import/store.ts Covers): its
 * statement's period where it has one, else its first to last day, never
 * narrower than its rows, and no later than `today`. `stated` is the period
 * the person said the file covers, which may only widen it (the route checks).
 * Null for a file with no rows.
 */
export function coveredPeriod(
  statement: Pick<StatementInfo, 'start' | 'end'> | null,
  first: string | null,
  last: string | null,
  today: string,
  stated?: { from: string; to: string } | null
): Covers | null {
  if (!first || !last) return null;
  let from = statement?.start && statement.start < first ? statement.start : first;
  let to = statement?.end && statement.end > last ? statement.end : last;
  if (stated) {
    if (stated.from < from) from = stated.from;
    if (stated.to > to) to = stated.to;
  }
  if (to > today) to = today < last ? last : today;
  return { from, to, stated: !!stated };
}

function storedStatement(s: StatementInfo | null): StoredStatement | null {
  if (!s) return null;
  return {
    kind: s.kind,
    label: s.label,
    bank_id: s.account?.bank_id ?? null,
    mask: s.account?.mask ?? null,
    type: s.account?.type ?? null,
    currency: s.currency,
    start: s.start,
    end: s.end,
    ledger: s.ledger,
  };
}

export type HistoryCommitInput = {
  /** The account's id now, and every id it has had (current first). */
  account_id: string;
  ids: string[];
  format: FileFormat;
  file_name: string | null;
  file_bytes: number;
  encoding: string;
  rows: NormalizedRecord[];
  problems: Problem[];
  read: Record<string, unknown>;
  statement: StatementInfo | null;
  columns: string[] | null;
  covers: Covers;
  /** The account's bank rows, its imports in order with the period each
   *  covers, and where the bank's rows begin, as read for the review. */
  banks: readonly BankRow[];
  order: readonly string[];
  imports: ReadonlyMap<string, { covers: Period | null }>;
  bank_from: string | null;
  choices: HistoryChoices;
  /** The digest of the review the person saw (reviewDigest). */
  reviewed: string;
  now?: Date;
};

export type HistoryCommitResult = { import_id: string | null; plan: HistoryPlan; entry: HistoryImportEntry | null };

const SKIPPED = 'Its bank id (FITID) is on another transaction an earlier import kept, and it was skipped as asked.';

/** The entry an import keeps: every record read, in file order, with what
 *  became of it. */
function entryOf(input: HistoryCommitInput, plan: HistoryPlan, rowIds: string[], at: string): HistoryImportEntry {
  const records: { line: number; record: HistoryImportRecord }[] = [];
  plan.rows.forEach((r, i) => {
    const o = plan.outcomes[i];
    const action = plan.actions[i];
    const pair = plan.pairs.get(i);
    const raw = r.record.raw;
    const twin = pair
      ? {
          kind: pair.twin.kind,
          id: pair.twin.id,
          date: pair.twin.date,
          name: (pair.twin.kind === 'bank' && pair.twin.merchant_name) || pair.twin.name,
          amount: pair.twin.amount,
          days: pair.days,
          confidence: pair.confidence,
          ...(pair.edge ? { edge: pair.edge.kind } : {}),
          chose: action === 'duplicate' ? ('same' as const) : ('new' as const),
        }
      : undefined;
    let record: HistoryImportRecord;
    if (action === 'add') record = { line: r.line, outcome: 'imported', row_id: rowIds[i], ...(twin ? { twin } : {}), raw };
    else if (action === 'duplicate') record = { line: r.line, outcome: 'duplicate', row_id: rowIds[i], twin, raw };
    else if (o.outcome === 'present') record = { line: r.line, outcome: 'present', row_id: o.row_id, raw };
    else if (o.outcome === 'repeated') record = { line: r.line, outcome: 'repeated', raw };
    else record = { line: r.line, outcome: 'skipped', ...(o.outcome === 'conflict' ? { row_id: o.row_id } : {}), reason: SKIPPED, raw };
    records.push({ line: r.line ?? 0, record });
  });
  for (const p of plan.problems) records.push({ line: p.line, record: { line: p.line || null, outcome: 'unreadable', reason: p.reason, raw: p.raw ?? null } });
  records.sort((a, b) => a.line - b.line);
  const c = plan.counts;
  const counts: HistoryImportCounts = { imported: c.new, duplicates: c.duplicates, already: c.already, present: c.present, repeated: c.repeated, skipped: c.skipped, unreadable: c.unreadable };
  return {
    version: 1,
    account_id: input.account_id,
    format: input.format,
    source: `import:${input.format}`,
    file_name: input.file_name,
    file_bytes: input.file_bytes,
    encoding: input.encoding,
    imported_at: at,
    currency: plan.currency,
    first_date: plan.first_date,
    last_date: plan.last_date,
    covers: input.covers,
    bank_from: input.bank_from,
    counts,
    read: input.read,
    statement: storedStatement(input.statement),
    columns: input.columns,
    records: records.map((r) => r.record),
  };
}

/** The rows an import keeps: its counted rows and its duplicates, each with
 *  what the review decided: a duplicate names its twin (the bank's row by its
 *  key, or the earlier import's row standing on it), and a row of its own
 *  the bank's row it was shown beside, so that pair is never made again. */
function rowsOf(input: HistoryCommitInput, plan: HistoryPlan, import_id: string, rowIds: string[], at: string): ImportedTxn[] {
  const out: ImportedTxn[] = [];
  plan.rows.forEach((r, i) => {
    const action = plan.actions[i];
    if (action !== 'add' && action !== 'duplicate') return;
    const pair = plan.pairs.get(i);
    const { date, amount, currency, name, category, note, source, source_id, source_key, transaction_code } = r.row;
    out.push({
      id: rowIds[i],
      account_id: input.account_id,
      date,
      amount,
      currency,
      name,
      category,
      note,
      source,
      source_id,
      ...(source_key ? { source_key } : {}),
      ...(transaction_code ? { transaction_code } : {}),
      import_id,
      ...(pair && action === 'duplicate' ? ('key' in pair.twin.names ? { same_as: pair.twin.names.key } : { same_as_row: pair.twin.names.row }) : {}),
      ...(pair && action === 'add' && pair.twin.kind === 'bank' ? { distinct_from: [keyOf(pair.twin)] } : {}),
      created_at: at,
    });
  });
  return out;
}

/** Whether an import keeps anything: rows to add, or duplicates to keep. */
const changes = (plan: HistoryPlan) => plan.counts.new + plan.counts.duplicates + plan.counts.already > 0;

/** The plan, or the refusal: a review that changed, or answers missing. */
function checked(plan: HistoryPlan, reviewed: string): HistoryPlan {
  if (reviewDigest(plan.review) !== reviewed) throw new ReviewChangedError();
  const waiting = plan.counts.conflicts + plan.counts.unanswered;
  if (waiting > 0) throw new UnansweredError(waiting);
  return plan;
}

/**
 * Imports the reviewed rows into the account (see the header). Nothing is
 * stored when no row would be kept. Throws ReviewChangedError, UnansweredError,
 * and what the seam throws (StoredValueTooLargeError when the book or the
 * records would be too large, UnreadableEntriesError for a book that can't be
 * read, UpdateConflictError when it kept changing), having written nothing.
 */
export async function commitHistoryImport(ctx: Ctx, input: HistoryCommitInput): Promise<HistoryCommitResult> {
  const at = (input.now ?? new Date()).toISOString();
  // Every book of the account, in the one step (a handful of ids at most).
  const ids = [...new Set(input.ids)].slice(0, MANY_AT_ONCE);
  if (ids[0] !== input.account_id) ids.unshift(input.account_id);
  const planFor = (books: Map<string, ImportedBook | null>) =>
    planHistoryImport({
      rows: input.rows,
      problems: input.problems,
      held: [...books.values()].flatMap((b) => b?.rows ?? []),
      banks: input.banks,
      order: input.order,
      bankFrom: input.bank_from,
      covers: input.covers,
      imports: input.imports,
      choices: input.choices,
    });
  // Strict: a book that can't be read is never matched as an empty one.
  const first = checked(planFor(new Map<string, ImportedBook | null>(await importedTxnStore.getMany(ctx, ids))), input.reviewed);
  if (!changes(first)) return { import_id: null, plan: first, entry: null };

  const import_id = newHistoryImportId();
  // One id per row, made once, so a retried compare-and-set writes the rows
  // the entry names.
  const rowIds = input.rows.map(() => newImportedTxnId());
  const entry = entryOf(input, first, rowIds, at);
  await historyImportStore.set(ctx, import_id, entry);
  try {
    await historyImportSummaryStore.set(ctx, import_id, summaryOfEntry(entry));
  } catch (err) {
    await historyImportStore.remove(ctx, import_id).catch((cleanup) => console.warn('history import: an import that failed left its records', loggable(cleanup)));
    throw err;
  }

  let plan = first;
  try {
    await importedTxnStore.updateMany(ctx, ids, (books) => {
      plan = checked(planFor(books), input.reviewed);
      if (!changes(plan)) return new Map();
      const book = books.get(input.account_id) ?? null;
      return new Map([[input.account_id, { version: 1 as const, rows: [...(book?.rows ?? []), ...rowsOf(input, plan, import_id, rowIds, at)] }]]);
    });
  } catch (err) {
    await dropEntryUnlessStored(ctx, input.account_id, import_id, err);
    throw err;
  }
  if (!changes(plan)) {
    // Everything arrived meanwhile (the same file, sent twice at once).
    await historyImportStore.remove(ctx, import_id);
    await historyImportSummaryStore.remove(ctx, import_id);
    return { import_id: null, plan, entry: null };
  }
  return { import_id, plan, entry };
}

/** After the rows couldn't be written: the records go, unless the book may
 *  hold the rows after all (an answer lost on the way). A refusal, a damaged
 *  book or a changed review is certain to have written nothing. */
async function dropEntryUnlessStored(ctx: Ctx, account_id: string, import_id: string, err: unknown): Promise<void> {
  try {
    const certain = err instanceof StoreRefusedError || err instanceof StoredDataUnreadableError || err instanceof ReviewChangedError || err instanceof UnansweredError;
    if (!certain) {
      const book = await importedTxnStore.get(ctx, account_id);
      if (book?.rows.some((r) => r.import_id === import_id)) return;
    }
    await historyImportStore.remove(ctx, import_id);
    await historyImportSummaryStore.remove(ctx, import_id);
  } catch (cleanup) {
    console.warn('history import: an import that failed left its records, listed with Undo', loggable(cleanup));
  }
}

// ---- Undo ----

/** No import with that id on that account. */
export class HistoryImportNotFoundError extends Error {
  constructor() {
    super('That import was already undone, or isn’t on this account.');
    this.name = 'HistoryImportNotFoundError';
  }
}

type UndoBasis = {
  entry: HistoryImportEntry | null;
  /** Its entry's bytes are damaged: removed with the rows. */
  damaged: boolean;
  summaryLeft: boolean;
  /** Rows a later import found already there, each with the earliest such
   *  import: kept, for it. */
  relied: Map<string, string>;
  later: Map<string, HistoryImportSummary>;
};

/**
 * What undoing an import must respect: its entry, read strictly (damaged
 * bytes are noted, anything else unreadable throws), and the later imports
 * into the same account that found any of its rows already there. One of
 * those whose entry can't be read could have relied on any of them, so it
 * throws rather than guessing.
 */
async function undoBasis(ctx: Ctx, ids: readonly string[], import_id: string): Promise<UndoBasis> {
  let entry: HistoryImportEntry | null = null;
  let damaged = false;
  try {
    entry = await historyImportStore.get(ctx, import_id);
  } catch (err) {
    if (err instanceof UnreadableEntriesError && err.unreadable.includes(import_id)) damaged = true;
    else throw err;
  }
  const mine = new Set(ids);
  if (entry && !mine.has(entry.account_id)) throw new HistoryImportNotFoundError();
  const summaries = await historyImportSummaryStore.getAllReport(ctx);
  const own = summaries.entries.get(import_id) ?? null;
  if (!entry && own && !mine.has(own.account_id)) throw new HistoryImportNotFoundError();
  const summaryLeft = !!own || summaries.unreadable.includes(import_id);
  const since = entry?.imported_at ?? own?.imported_at ?? null;
  const candidates = [...summaries.entries]
    .filter(([id, s]) => id !== import_id && mine.has(s.account_id) && s.counts.present > 0 && (since === null || s.imported_at >= since))
    .map(([id]) => id);
  for (const id of [...summaries.unreadable, ...summaries.unrecognised]) if (id !== import_id) candidates.push(id);
  const later = new Map<string, HistoryImportSummary>();
  const relied = new Map<string, { by: string; at: string }>();
  for (const id of candidates) {
    const e = await historyImportStore.get(ctx, id);
    if (!e || !mine.has(e.account_id) || (since !== null && e.imported_at < since)) continue;
    later.set(id, summaries.entries.get(id) ?? summaryOfEntry(e));
    for (const r of e.records) {
      if (r.outcome !== 'present' || !r.row_id) continue;
      const seen = relied.get(r.row_id);
      if (!seen || e.imported_at < seen.at) relied.set(r.row_id, { by: id, at: e.imported_at });
    }
  }
  return { entry, damaged, summaryLeft, relied: new Map([...relied].map(([row, { by }]) => [row, by])), later };
}

export type HistoryUndoPlan = {
  record: 'ok' | 'unreadable';
  /** Counted rows that go, and duplicates that go with them. */
  remove: number;
  duplicates: number;
  /** Rows a later import found already there: kept, for it. */
  kept: { import_id: string; file_name: string | null; imported_at: string; count: number }[];
  /** Some book of the account can't be read: its rows of this import can't be counted. */
  incomplete: boolean;
};

/** What undoing an import would do, changing nothing: for the confirmation. */
export async function historyUndoPlan(ctx: Ctx, ids: readonly string[], import_id: string): Promise<HistoryUndoPlan> {
  const basis = await undoBasis(ctx, ids, import_id);
  const books = await importedTxnStore.getAllReport(ctx);
  const plan: HistoryUndoPlan = { record: basis.damaged ? 'unreadable' : 'ok', remove: 0, duplicates: 0, kept: [], incomplete: ids.some((id) => books.unreadable.includes(id) || books.unrecognised.includes(id)) };
  const kept = new Map<string, number>();
  for (const book of books.entries.values()) {
    for (const r of book.rows) {
      if (r.import_id !== import_id) continue;
      const by = basis.relied.get(r.id);
      if (by) kept.set(by, (kept.get(by) ?? 0) + 1);
      else if (r.same_as || r.same_as_row) plan.duplicates++;
      else plan.remove++;
    }
  }
  if (!basis.entry && !basis.damaged && !basis.summaryLeft && plan.remove + plan.duplicates + kept.size === 0) throw new HistoryImportNotFoundError();
  plan.kept = [...kept].map(([id, count]) => {
    const s = basis.later.get(id);
    return { import_id: id, file_name: s?.file_name ?? null, imported_at: s?.imported_at ?? '', count };
  });
  return plan;
}

export type HistoryUndoResult = {
  removed: number;
  duplicates: number;
  kept: number;
  ids: string[];
  /** The days of the rows taken out: the backfill walks those after the
   *  chart's earliest point (lib/history-import/extend.ts). */
  dates: string[];
};

/**
 * Takes an import out (see the header). Undoing again after an undo that
 * failed part way finishes it. Throws HistoryImportNotFoundError when nothing
 * of it is on this account, UnreadableEntriesError when a book of the
 * account can't be read, its entry is one this release doesn't recognise, or
 * a later import's can't be read.
 */
export async function undoHistoryImport(ctx: Ctx, ids: readonly string[], import_id: string): Promise<HistoryUndoResult> {
  const basis = await undoBasis(ctx, ids, import_id);
  const result: HistoryUndoResult = { removed: 0, duplicates: 0, kept: 0, ids: [], dates: [] };
  const handed = new Map<string, number>();
  const report = await importedTxnStore.getAllReport(ctx);
  const flawed = ids.filter((id) => report.unreadable.includes(id) || report.unrecognised.includes(id));
  if (flawed.length > 0) {
    throw new UnreadableEntriesError(importedTxnStore.what, flawed.filter((id) => report.unreadable.includes(id)), flawed.filter((id) => report.unrecognised.includes(id)));
  }
  // Every book holding its rows: the account's, whatever ids it has had.
  const holding = [...report.entries].filter(([, book]) => book.rows.some((r) => r.import_id === import_id)).map(([id]) => id);
  for (let i = 0; i < holding.length; i += MANY_AT_ONCE) {
    const chunk = holding.slice(i, i + MANY_AT_ONCE);
    let taken: { id: string; duplicate: boolean; date: string }[] = [];
    let passed: string[] = [];
    await importedTxnStore.updateMany(ctx, chunk, (books) => {
      taken = [];
      passed = [];
      const next = new Map<string, ImportedBook | null>();
      for (const [id, book] of books) {
        if (!book) continue;
        let changed = false;
        const rows: ImportedTxn[] = [];
        for (const r of book.rows) {
          if (r.import_id !== import_id) {
            rows.push(r);
            continue;
          }
          changed = true;
          const by = basis.relied.get(r.id);
          if (by) {
            rows.push({ ...r, import_id: by });
            passed.push(by);
          } else taken.push({ id: r.id, duplicate: !!(r.same_as || r.same_as_row), date: r.date });
        }
        if (changed) next.set(id, rows.length > 0 ? { ...book, rows } : null);
      }
      return next;
    });
    for (const t of taken) {
      result.ids.push(t.id);
      result.dates.push(t.date);
      if (t.duplicate) result.duplicates++;
      else result.removed++;
    }
    for (const by of passed) handed.set(by, (handed.get(by) ?? 0) + 1);
  }
  result.kept = [...handed.values()].reduce((n, c) => n + c, 0);
  if (!basis.entry && !basis.damaged && !basis.summaryLeft && result.ids.length + result.kept === 0) throw new HistoryImportNotFoundError();
  for (const [id, count] of handed) {
    await historyImportSummaryStore
      .update(ctx, id, (current) => (current ? { ...current, taken_over: (current.taken_over ?? 0) + count } : null))
      .catch((err) => console.warn('history import: rows kept for a later import could not be noted on it', loggable(err)));
  }
  // What was said about the rows (an exclusion, tags, a note, a category)
  // goes with them, and so do their splits and their places in groups (a
  // group left with none goes). Best effort: a record left behind names a row
  // that no longer exists, which is never shown, and a group says one of its
  // transactions isn't there.
  await forgetAnnotations(ctx, result.ids).catch((err) => console.warn('history import: exclusions, tags and notes of undone rows were left behind', loggable(err)));
  await forgetOverrides(ctx, result.ids).catch((err) => console.warn('history import: categories of undone rows were left behind', loggable(err)));
  await forgetSplitsAndGroups(ctx, result.ids).catch((err) => console.warn('history import: splits or groups of undone rows were left behind', loggable(err)));
  await historyImportStore.remove(ctx, import_id);
  await historyImportSummaryStore.remove(ctx, import_id);
  return result;
}

// ---- Listing ----

export type HistoryImportListed = {
  id: string;
  record: 'ok' | 'unreadable' | 'unrecognised' | 'missing';
  format: FileFormat | null;
  file_name: string | null;
  imported_at: string | null;
  counts: HistoryImportCounts | null;
  first_date: string | null;
  last_date: string | null;
  covers: Covers | null;
  currency: string | null;
  statement: string | null;
  taken_over: number;
  /** Its rows stored now, as they count (lib/history-import/match.ts
   *  settle): those counted; duplicates standing for their twin; rows a bank
   *  row now stands for; and of those counted, duplicates whose twin is gone
   *  (the bank no longer holds it, or its import was undone), counted again.
   *  Null when a book of the account can't be read, so they can't be told. */
  rows_now: number | null;
  duplicates_now: number | null;
  superseded_now: number | null;
  returned_now: number | null;
};

/**
 * An account's imports, newest first, with what is left of each: a display
 * read of the summaries and the account's books, never of a file's records
 * (but for an import whose summary is gone while rows still name it, read
 * alone, so Undo can take them out). `settled` is how the account's rows
 * count now (lib/history-import/read.ts countedRows).
 */
export async function listHistoryImports(ctx: Ctx, ids: readonly string[], settled: Settled<ImportedTxn>): Promise<HistoryImportListed[]> {
  const mine = new Set(ids);
  const [summaries, books] = await Promise.all([historyImportSummaryStore.getAllReport(ctx), importedTxnStore.getAllReport(ctx)]);
  const complete = !ids.some((id) => books.unreadable.includes(id) || books.unrecognised.includes(id));
  const counted = new Set(settled.counted.map((r) => r.id));
  const live = new Map<string, { rows: number; duplicates: number; superseded: number; returned: number }>();
  for (const id of ids) {
    for (const r of books.entries.get(id)?.rows ?? []) {
      const n = live.get(r.import_id) ?? { rows: 0, duplicates: 0, superseded: 0, returned: 0 };
      if (counted.has(r.id)) {
        n.rows++;
        if (r.same_as || r.same_as_row) n.returned++;
      } else if (settled.standing.has(r.id)) n.duplicates++;
      else n.superseded++;
      live.set(r.import_id, n);
    }
  }
  const now = (id: string) => {
    const n = live.get(id);
    if (!complete && !n) return { rows_now: null, duplicates_now: null, superseded_now: null, returned_now: null };
    return { rows_now: n?.rows ?? 0, duplicates_now: n?.duplicates ?? 0, superseded_now: n?.superseded ?? 0, returned_now: n?.returned ?? 0 };
  };
  const listed = (id: string, s: HistoryImportSummary): HistoryImportListed => ({
    id,
    record: 'ok',
    format: s.format,
    file_name: s.file_name,
    imported_at: s.imported_at,
    counts: s.counts,
    first_date: s.first_date,
    last_date: s.last_date,
    covers: s.covers,
    currency: s.currency,
    statement: s.statement,
    taken_over: s.taken_over ?? 0,
    ...now(id),
  });
  const unknown = (id: string, record: HistoryImportListed['record']): HistoryImportListed => ({
    id,
    record,
    format: null,
    file_name: null,
    imported_at: null,
    counts: null,
    first_date: null,
    last_date: null,
    covers: null,
    currency: null,
    statement: null,
    taken_over: 0,
    ...now(id),
  });
  const out: HistoryImportListed[] = [];
  for (const [id, s] of summaries.entries) if (mine.has(s.account_id)) out.push(listed(id, s));
  for (const id of live.keys()) {
    if (summaries.entries.has(id)) continue;
    try {
      const e = await historyImportStore.get(ctx, id);
      out.push(e ? listed(id, summaryOfEntry(e)) : unknown(id, 'missing'));
    } catch (err) {
      if (!(err instanceof UnreadableEntriesError)) throw err;
      out.push(unknown(id, err.unreadable.includes(id) ? 'unreadable' : 'unrecognised'));
    }
  }
  return out.sort((a, b) => (b.imported_at ?? '').localeCompare(a.imported_at ?? ''));
}

// ---- Forgetting an earlier account ----

/**
 * For forgetting an earlier account (lib/links.ts forgetEarlierAccount): the
 * rows imported under its id, its imports' records and summaries, what was
 * said about those rows, their splits and their places in groups, and how
 * its last file was read. Readable or not: the
 * person asked for everything about it to go. But a row an import into
 * another account found already there (an import made while the two were
 * linked) is that import's transaction too: it is handed to the earliest
 * such import, into its account's book, with what was said about it, as an
 * undo hands it over. Answers the accounts rows were handed to. Throws only
 * when storage can't be reached, or a book a row is handed to can't be read.
 */
export async function forgetImportedHistory(ctx: Ctx, account_id: string): Promise<{ handedTo: string[] }> {
  let rows: ImportedTxn[] = [];
  try {
    rows = (await importedTxnStore.get(ctx, account_id))?.rows ?? [];
  } catch (err) {
    if (!(err instanceof StoredDataUnreadableError)) throw err;
  }
  const summaries = await historyImportSummaryStore.getAllReport(ctx);
  const ids = [...summaries.entries].filter(([, s]) => s.account_id === account_id).map(([id]) => id);
  // A summary that can't be read could be this account's: its entry says.
  for (const id of [...summaries.unreadable, ...summaries.unrecognised]) {
    try {
      if ((await historyImportStore.get(ctx, id))?.account_id === account_id) ids.push(id);
    } catch (err) {
      if (!(err instanceof StoredDataUnreadableError)) throw err;
    }
  }

  // The rows other accounts' imports relied on, each with the earliest such
  // import and its account. Entries that can't be read rely on nothing known.
  const mine = new Set(rows.map((r) => r.id));
  const relied = new Map<string, { by: string; account: string; at: string }>();
  if (mine.size > 0) {
    for (const [id, s] of summaries.entries) {
      if (s.account_id === account_id || s.counts.present === 0) continue;
      let e: HistoryImportEntry | null = null;
      try {
        e = await historyImportStore.get(ctx, id);
      } catch (err) {
        if (!(err instanceof StoredDataUnreadableError)) throw err;
      }
      if (!e) continue;
      for (const r of e.records) {
        if (r.outcome !== 'present' || !r.row_id || !mine.has(r.row_id)) continue;
        const seen = relied.get(r.row_id);
        if (!seen || e.imported_at < seen.at) relied.set(r.row_id, { by: id, account: e.account_id, at: e.imported_at });
      }
    }
  }
  const handed = new Map<string, ImportedTxn[]>();
  for (const r of rows) {
    const to = relied.get(r.id);
    if (!to) continue;
    const list = handed.get(to.account) ?? [];
    list.push({ ...r, account_id: to.account, import_id: to.by });
    handed.set(to.account, list);
  }
  // First into their new books (a row already there is left as it is), so a
  // forget stopped part way loses none: running it again finishes.
  for (const [to, moved] of handed) {
    await importedTxnStore.update(ctx, to, (book) => {
      const have = new Set((book?.rows ?? []).map((r) => r.id));
      const add = moved.filter((r) => !have.has(r.id));
      return add.length === 0 && book ? book : { version: 1, rows: [...(book?.rows ?? []), ...add] };
    });
  }

  await importedTxnStore.remove(ctx, account_id);
  if (ids.length > 0) {
    await historyImportStore.remove(ctx, ...ids);
    await historyImportSummaryStore.remove(ctx, ...ids);
  }
  const gone = rows.filter((r) => !relied.has(r.id)).map((r) => r.id);
  await forgetAnnotations(ctx, gone);
  await forgetOverrides(ctx, gone);
  await forgetSplitsAndGroups(ctx, gone);
  // How its last file was read (lib/import/store.ts), kept per account.
  await importSettingsStore.remove(ctx, account_id);
  return { handedTo: [...handed.keys()] };
}
