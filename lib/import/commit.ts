// lib/import/commit.ts
//
// The pipeline's commit stage, into a manual account (#43): the one part of
// lib/import/ that touches storage. Importing into a linked account (#52) adds
// a review step before a commit of its own; everything before this is shared.
//
// ONE STEP, OR NONE. The rows go into the account's book (lib/manual-txns.ts)
// in one compare-and-set (MapStore.updateMany), matched against the book as it
// is at that moment: an edit or an add on another device landing between the
// preview and the import is matched against too, never overwritten, and a
// file is never half imported. A book the import would take past the size
// ceiling is refused whole (StoredValueTooLargeError, 413), never trimmed.
//
// THE RAW RECORDS (lib/import/store.ts) are written first, under the import's
// random id, and then the rows, each carrying that id (import_id), its source
// ('import:ofx', 'import:csv', 'import:qif') and its source_id. So a file too
// large to keep is refused before the book is touched, and an import's rows
// are never stored without the records they came from. If the rows can't be
// written, the entry goes again, unless the book may hold them after all (a
// connection lost on the way): then it stays, and the import is listed, with
// Undo, so nothing is left that the person can't see or take out. When the
// book changed between the first matching and the write, the entry is written
// again with what was actually imported.
//
// UNDO takes out every row the import added, wherever it is now (a row moved
// to another manual account carries its import_id with it), edited since or
// not, and what was said about those rows (lib/txn-annotations.ts), then the
// entry. The person confirms first; the list of imports says how many rows
// are still there and how many were edited. An entry whose bytes are damaged
// is removed with its rows, since Undo is the person's confirmation; one this
// release doesn't recognise is left alone, and the undo refused (409).
//
// BALANCES STAY TYPED. Nothing here moves a balance: a statement's ledger
// balance is offered (statementBalance) and moved by the route, as the
// account's Update form would move it, only when the person asks and only
// from a statement dated today or yesterday. No import ever writes the
// history layer (lib/history.ts): the rows are transactions, and the
// estimated history holds manual accounts flat (lib/backfill.ts).

import { UnreadableEntriesError, StoreRefusedError, StoredDataUnreadableError, MANY_AT_ONCE } from '../repo';
import type { Ctx } from '../containers';
import { manualTxnStore, newManualTxnId, type ManualTxn, type ManualTxnBook } from '../manual-txns';
import type { ManualAccount } from '../manual';
import { isOwedType } from '../balance';
import { addDays, DEFAULT_CURRENCY } from '../manual-txn-input';
import { MAX_BALANCE } from '../manual';
import { forgetAnnotations } from '../txn-annotations';
import { loggable } from '../log-safe';
import type { FileFormat, Problem } from './record';
import type { NormalizedRecord } from './normalize';
import { matchRows, type Outcome } from './match';
import type { StatementInfo } from './read';
import {
  importSettingsStore,
  importStore,
  newImportId,
  type ImportCounts,
  type ImportEntry,
  type ImportSettings,
  type StoredImportRecord,
  type StoredStatement,
} from './store';

// ---- Planning ----

/** What an import would do, against a book as it stands. */
export type ImportPlan = {
  rows: NormalizedRecord[];
  /** What becomes of each of `rows`, in order. */
  outcomes: Outcome[];
  /** The rows that can't be read, each with its line and why, in file order. */
  problems: Problem[];
  counts: { new: number; present: number; repeated: number; unreadable: number };
  first_date: string | null;
  last_date: string | null;
  /** The currency most rows are in, and how many are in each other one. */
  currency: string | null;
  others: { currency: string; count: number }[];
  /** The new rows' money out and in, in `currency`. */
  totals: { out: number; in: number };
  /** Rows whose payee, category or note was shortened to fit. */
  shortened: number;
};

const byLine = (a: Problem, b: Problem) => a.line - b.line;

/** What importing these rows into this book would do (lib/import/match.ts). */
export function planImport(rows: NormalizedRecord[], problems: Problem[], book: ManualTxnBook | null): ImportPlan {
  const outcomes = matchRows(
    rows.map((r) => r.row),
    book?.rows ?? []
  );
  const counts = { new: 0, present: 0, repeated: 0, unreadable: problems.length };
  for (const o of outcomes) counts[o.outcome]++;
  const byCurrency = new Map<string, number>();
  let first: string | null = null;
  let last: string | null = null;
  for (const { row } of rows) {
    byCurrency.set(row.currency, (byCurrency.get(row.currency) ?? 0) + 1);
    if (first === null || row.date < first) first = row.date;
    if (last === null || row.date > last) last = row.date;
  }
  let currency: string | null = null;
  for (const [c, n] of byCurrency) if (currency === null || n > byCurrency.get(currency)!) currency = c;
  const totals = { out: 0, in: 0 };
  rows.forEach(({ row }, i) => {
    if (outcomes[i].outcome !== 'new' || row.currency !== currency) return;
    if (row.amount > 0) totals.out += row.amount;
    else totals.in -= row.amount;
  });
  return {
    rows,
    outcomes,
    problems: [...problems].sort(byLine),
    counts,
    first_date: first,
    last_date: last,
    currency,
    others: [...byCurrency].filter(([c]) => c !== currency).map(([c, count]) => ({ currency: c, count })),
    totals: { out: Math.round(totals.out * 100) / 100, in: Math.round(totals.in * 100) / 100 },
    shortened: rows.filter((r) => r.shortened).length,
  };
}

// ---- The statement's balance ----

/** Why a statement's balance isn't offered as the account's. */
export type BalanceRefusal = 'undated' | 'past' | 'ahead' | 'currency' | 'kind' | 'too-large' | 'owed-negative';

export type StatementBalance = {
  /** The balance as the account keeps it (an amount owed is positive). */
  amount: number;
  as_of: string | null;
  /** The account's balance now, which it would move from. */
  from: number;
  /** Null when it may be set; else why it is only shown. */
  refusal: BalanceRefusal | null;
};

/**
 * A statement's ledger balance, as the account's balance would be, and
 * whether it may be set from it: only from a statement dated today or
 * yesterday (or tomorrow, for a bank a time zone ahead), since setting a
 * balance records it as today's, and an older one would put a past figure in
 * today's place; only in US dollars, which manual balances are kept in; only
 * from a card statement onto a credit or loan account and a bank statement
 * onto any other, so the sign means what it says; and within the bounds the
 * Update form keeps. `today` is the server's day (UTC).
 */
export function statementBalance(account: Pick<ManualAccount, 'type' | 'balance'>, s: StatementInfo | null, today: string): StatementBalance | null {
  if (!s?.ledger) return null;
  const owed = isOwedType(account.type);
  // A card's balance is negative while money is owed; Nya keeps what is
  // owed as a positive amount (lib/balance.ts).
  const amount = Math.round((owed ? -s.ledger.amount : s.ledger.amount) * 100) / 100 || 0;
  const as_of = s.ledger.as_of;
  const kindFits = s.kind === 'creditcard' ? owed : !owed && account.type !== 'investment';
  let refusal: BalanceRefusal | null = null;
  if (!as_of) refusal = 'undated';
  else if (s.currency && s.currency !== DEFAULT_CURRENCY) refusal = 'currency';
  else if (!kindFits) refusal = 'kind';
  else if (as_of < addDays(today, -1)) refusal = 'past';
  else if (as_of > addDays(today, 1)) refusal = 'ahead';
  else if (Math.abs(amount) > MAX_BALANCE) refusal = 'too-large';
  else if (owed && amount < 0) refusal = 'owed-negative';
  return { amount, as_of, from: account.balance, refusal };
}

// ---- The statement's account ----

type StatementAccount = NonNullable<NonNullable<ImportSettings['ofx']>['statement']>;

export function statementAccountOf(s: StatementInfo | null): StatementAccount | null {
  if (!s?.account) return null;
  return { kind: s.kind, bank_id: s.account.bank_id, mask: s.account.mask, type: s.account.type };
}

const accountLabel = (a: StatementAccount) =>
  `${a.kind === 'creditcard' ? 'a credit card' : 'an account'}${a.mask ? ` ending ${a.mask}` : ''}${a.bank_id ? ` at bank ${a.bank_id}` : ''}`;

/** Whether a statement is for another account than the one this account's
 *  last OFX file was: what each was for, in words, or null. */
export function accountMismatch(remembered: StatementAccount | null | undefined, s: StatementInfo | null): { expected: string; found: string } | null {
  const found = statementAccountOf(s);
  if (!remembered || !found) return null;
  const same = remembered.kind === found.kind && remembered.mask === found.mask && remembered.bank_id === found.bank_id && remembered.type === found.type;
  return same ? null : { expected: accountLabel(remembered), found: accountLabel(found) };
}

// ---- Committing ----

export type CommitInput = {
  account: ManualAccount;
  format: FileFormat;
  file_name: string | null;
  file_bytes: number;
  encoding: string;
  rows: NormalizedRecord[];
  problems: Problem[];
  read: Record<string, unknown>;
  statement: StatementInfo | null;
  columns: string[] | null;
  now?: Date;
};

export type CommitResult = {
  /** The import's id, or null when nothing was new, so nothing was stored. */
  import_id: string | null;
  plan: ImportPlan;
  /** The import's entry as stored, or null. */
  entry: ImportEntry | null;
};

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

/** The entry an import keeps: every record read, in file order, each with
 *  what became of it. */
function entryOf(input: CommitInput, plan: ImportPlan, rowIds: string[], at: string): ImportEntry {
  const records: { line: number; record: StoredImportRecord }[] = [];
  plan.rows.forEach((r, i) => {
    const o = plan.outcomes[i];
    const record: StoredImportRecord =
      o.outcome === 'new'
        ? { line: r.line, outcome: 'imported', row_id: rowIds[i], raw: r.record.raw }
        : o.outcome === 'present'
          ? { line: r.line, outcome: 'present', row_id: o.row_id, raw: r.record.raw }
          : { line: r.line, outcome: 'repeated', raw: r.record.raw };
    records.push({ line: r.line ?? 0, record });
  });
  for (const p of plan.problems) records.push({ line: p.line, record: { line: p.line || null, outcome: 'unreadable', reason: p.reason, raw: p.raw ?? null } });
  records.sort((a, b) => a.line - b.line);
  const counts: ImportCounts = { imported: plan.counts.new, present: plan.counts.present, repeated: plan.counts.repeated, unreadable: plan.counts.unreadable };
  return {
    version: 1,
    account_id: input.account.account_id,
    format: input.format,
    source: `import:${input.format}`,
    file_name: input.file_name,
    file_bytes: input.file_bytes,
    encoding: input.encoding,
    imported_at: at,
    currency: plan.currency,
    first_date: plan.first_date,
    last_date: plan.last_date,
    counts,
    read: input.read,
    statement: storedStatement(input.statement),
    columns: input.columns,
    records: records.map((r) => r.record),
  };
}

const sameOutcomes = (a: Outcome[], b: Outcome[]) => a.length === b.length && a.every((o, i) => JSON.stringify(o) === JSON.stringify(b[i]));

/**
 * Imports the rows into the account's book (see the header), and keeps the
 * file's records. Nothing is stored when no row is new. Throws what the
 * seam throws (StoredValueTooLargeError when the book or the records would
 * be too large, UnreadableEntriesError for a book that can't be read,
 * UpdateConflictError when it kept changing), having written nothing.
 */
export async function commitImport(ctx: Ctx, input: CommitInput): Promise<CommitResult> {
  const { account } = input;
  const at = (input.now ?? new Date()).toISOString();
  // Strict: a book that can't be read is never matched as an empty one.
  const before = await manualTxnStore.get(ctx, account.account_id);
  const first = planImport(input.rows, input.problems, before);
  if (first.counts.new === 0) return { import_id: null, plan: first, entry: null };

  const import_id = newImportId();
  // One id per row, made once, so a retried compare-and-set writes the same
  // rows the entry names.
  const rowIds = input.rows.map(() => newManualTxnId());
  const entry = entryOf(input, first, rowIds, at);
  await importStore.set(ctx, import_id, entry);

  let plan = first;
  try {
    await manualTxnStore.updateMany(ctx, [account.account_id], (books) => {
      const book = books.get(account.account_id) ?? null;
      plan = planImport(input.rows, input.problems, book);
      if (plan.counts.new === 0) return new Map();
      const added: ManualTxn[] = [];
      plan.rows.forEach((r, i) => {
        if (plan.outcomes[i].outcome !== 'new') return;
        added.push({ id: rowIds[i], account_id: account.account_id, ...r.row, import_id, created_at: at, updated_at: at });
      });
      return new Map([[account.account_id, { version: 1 as const, rows: [...(book?.rows ?? []), ...added] }]]);
    });
  } catch (err) {
    await dropEntryUnlessStored(ctx, account.account_id, import_id, err);
    throw err;
  }
  if (plan.counts.new === 0) {
    // Everything arrived meanwhile (the same file, sent twice at once).
    await importStore.remove(ctx, import_id);
    return { import_id: null, plan, entry: null };
  }
  let stored = entry;
  if (!sameOutcomes(plan.outcomes, first.outcomes)) {
    stored = entryOf(input, plan, rowIds, at);
    try {
      await importStore.set(ctx, import_id, stored);
    } catch (err) {
      // The rows are in; the entry still names every record, with what the
      // first matching made of them.
      console.warn('import: an import’s records could not be brought up to date', loggable(err));
      stored = entry;
    }
  }
  return { import_id, plan, entry: stored };
}

/** After the rows couldn't be written: the entry goes, unless the book may
 *  hold its rows after all (an answer lost on the way). A refusal or a
 *  damaged book is certain to have written nothing. */
async function dropEntryUnlessStored(ctx: Ctx, account_id: string, import_id: string, err: unknown): Promise<void> {
  try {
    if (!(err instanceof StoreRefusedError || err instanceof StoredDataUnreadableError)) {
      const book = await manualTxnStore.get(ctx, account_id);
      if (book?.rows.some((r) => r.import_id === import_id)) return;
    }
    await importStore.remove(ctx, import_id);
  } catch (cleanup) {
    console.warn('import: an import that failed left its record, listed with Undo', loggable(cleanup));
  }
}

/** Notes on an import's entry the balance it also set. Best effort: the
 *  balance moved either way. */
export async function noteBalanceSet(ctx: Ctx, import_id: string, update: { from: number; to: number; as_of: string }): Promise<void> {
  try {
    await importStore.update(ctx, import_id, (current) => (current ? { ...current, balance_update: update } : null));
  } catch (err) {
    console.warn('import: the balance an import set could not be noted on it', loggable(err));
  }
}

/** Remembers how this account's file was read, for the next one. Best
 *  effort: the import is done either way. */
export async function rememberSettings(ctx: Ctx, account_id: string, patch: Partial<Omit<ImportSettings, 'version' | 'updated_at'>>, now: Date = new Date()): Promise<void> {
  try {
    await importSettingsStore.update(ctx, account_id, (current) => ({ ...(current ?? {}), ...patch, version: 1, updated_at: now.toISOString() }));
  } catch (err) {
    console.warn('import: how a file was read could not be remembered', loggable(err));
  }
}

// ---- Undo ----

/** No import with that id on that account. */
export class ImportNotFoundError extends Error {
  constructor() {
    super('That import was already undone, or isn’t on this account.');
    this.name = 'ImportNotFoundError';
  }
}

export type UndoResult = { removed: number; edited: number; moved: number; ids: string[] };

/** Whether a row changed since its import added it. */
const editedSince = (r: ManualTxn) => r.updated_at !== r.created_at;

/**
 * Takes an import out (see the header): its rows wherever they are, what was
 * said about them, and its entry. Throws ImportNotFoundError when there is
 * nothing of it on this account, UnreadableEntriesError when the account's
 * book can't be read or the entry is one this release doesn't recognise.
 */
export async function undoImport(ctx: Ctx, account_id: string, import_id: string): Promise<UndoResult> {
  let entry: ImportEntry | null = null;
  let damaged = false;
  try {
    entry = await importStore.get(ctx, import_id);
  } catch (err) {
    // Damaged bytes hold nothing anyone can read: they go with the rows,
    // since the person confirmed this. Anything else is left as it is.
    if (err instanceof UnreadableEntriesError && err.unreadable.includes(import_id)) damaged = true;
    else throw err;
  }
  if (entry && entry.account_id !== account_id) throw new ImportNotFoundError();

  const result: UndoResult = { removed: 0, edited: 0, moved: 0, ids: [] };
  // A row moved between books while this ran is found on the next pass.
  for (let pass = 0; pass < 3; pass++) {
    const report = await manualTxnStore.getAllReport(ctx);
    if (report.unreadable.includes(account_id) || report.unrecognised.includes(account_id)) {
      throw new UnreadableEntriesError(manualTxnStore.what, report.unreadable.filter((id) => id === account_id), report.unrecognised.filter((id) => id === account_id));
    }
    const holding = [...report.entries].filter(([, book]) => book.rows.some((r) => r.import_id === import_id)).map(([id]) => id);
    if (holding.length === 0) break;
    for (let i = 0; i < holding.length; i += MANY_AT_ONCE) {
      const chunk = holding.slice(i, i + MANY_AT_ONCE);
      let taken: { id: string; edited: boolean; moved: boolean }[] = [];
      await manualTxnStore.updateMany(ctx, chunk, (books) => {
        taken = [];
        const next = new Map<string, ManualTxnBook | null>();
        for (const [id, book] of books) {
          if (!book) continue;
          const keep = book.rows.filter((r) => r.import_id !== import_id);
          if (keep.length === book.rows.length) continue;
          for (const r of book.rows) if (r.import_id === import_id) taken.push({ id: r.id, edited: editedSince(r), moved: id !== account_id });
          next.set(id, keep.length > 0 ? { ...book, rows: keep } : null);
        }
        return next;
      });
      for (const t of taken) {
        result.ids.push(t.id);
        result.removed++;
        if (t.edited) result.edited++;
        if (t.moved) result.moved++;
      }
    }
  }
  if (!entry && !damaged && result.removed === 0) throw new ImportNotFoundError();
  // What was said about the rows goes with them. Best effort: a record left
  // behind names a row that no longer exists, which is never shown.
  await forgetAnnotations(ctx, result.ids).catch((err) => console.warn('import: exclusions of undone rows were left behind', loggable(err)));
  await importStore.remove(ctx, import_id);
  return result;
}

// ---- Listing ----

export type ImportSummary = {
  id: string;
  /** 'ok', or why its entry can't be shown: its bytes are damaged, a later
   *  release wrote it, or it is gone while rows still name it. */
  record: 'ok' | 'unreadable' | 'unrecognised' | 'missing';
  format: FileFormat | null;
  file_name: string | null;
  imported_at: string | null;
  counts: ImportCounts | null;
  first_date: string | null;
  last_date: string | null;
  currency: string | null;
  statement: string | null;
  balance_update: ImportEntry['balance_update'] | null;
  /** Its rows stored now, on any account; of those, how many were changed
   *  since, and how many are on another account. Null when some book can't
   *  be read, so they can't be counted. */
  rows_now: number | null;
  edited_now: number | null;
  moved_now: number | null;
};

/**
 * The imports into an account, newest first, with what is left of each. For
 * the import sheet's list: a display read that names what it can't read
 * rather than failing (the entries and the books are read with getAllReport;
 * nothing is written or removed from this answer). An import whose rows are
 * on this account but whose entry can't be read or is gone is listed too, so
 * Undo can take its rows out.
 */
export async function listImports(ctx: Ctx, account_id: string): Promise<ImportSummary[]> {
  const [imports, books] = await Promise.all([importStore.getAllReport(ctx), manualTxnStore.getAllReport(ctx)]);
  const complete = books.unreadable.length === 0 && books.unrecognised.length === 0;
  const live = new Map<string, { rows: number; edited: number; moved: number }>();
  const onThisAccount = new Set<string>();
  for (const [id, book] of books.entries) {
    for (const r of book.rows) {
      if (!r.import_id) continue;
      const n = live.get(r.import_id) ?? { rows: 0, edited: 0, moved: 0 };
      n.rows++;
      if (editedSince(r)) n.edited++;
      if (id !== account_id) n.moved++;
      live.set(r.import_id, n);
      if (id === account_id) onThisAccount.add(r.import_id);
    }
  }
  const now = (id: string) => {
    const n = live.get(id);
    // A row in a book that couldn't be read can't be counted; zero would say
    // it is gone.
    if (!complete && !n) return { rows_now: null, edited_now: null, moved_now: null };
    return { rows_now: n?.rows ?? 0, edited_now: n?.edited ?? 0, moved_now: n?.moved ?? 0 };
  };
  const out: ImportSummary[] = [];
  for (const [id, e] of imports.entries) {
    if (e.account_id !== account_id) continue;
    out.push({
      id,
      record: 'ok',
      format: e.format,
      file_name: e.file_name,
      imported_at: e.imported_at,
      counts: e.counts,
      first_date: e.first_date,
      last_date: e.last_date,
      currency: e.currency,
      statement: e.statement?.label ?? null,
      balance_update: e.balance_update ?? null,
      ...now(id),
    });
  }
  const flawed = new Map<string, ImportSummary['record']>([
    ...imports.unreadable.map((id) => [id, 'unreadable'] as const),
    ...imports.unrecognised.map((id) => [id, 'unrecognised'] as const),
  ]);
  for (const id of onThisAccount) {
    // Listed above, or another account's import with a row moved here.
    if (imports.entries.has(id)) continue;
    out.push({
      id,
      record: flawed.get(id) ?? 'missing',
      format: null,
      file_name: null,
      imported_at: null,
      counts: null,
      first_date: null,
      last_date: null,
      currency: null,
      statement: null,
      balance_update: null,
      ...now(id),
    });
  }
  return out.sort((a, b) => (b.imported_at ?? '').localeCompare(a.imported_at ?? ''));
}

/**
 * For deleting a manual account: its imports' entries and its settings go.
 * Its rows go with its book (the caller deletes that), and so does an entry
 * whose bytes are damaged that only this account's rows named, since the
 * person asked for everything about the account to go. Rows of its imports
 * moved to another account keep their import there; that import, its entry
 * gone, is still listed on that account with Undo. Call it before the book
 * is deleted. Throws only when storage can't be reached.
 */
export async function forgetAccountImports(ctx: Ctx, account_id: string): Promise<void> {
  const [imports, books] = await Promise.all([importStore.getAllReport(ctx), manualTxnStore.getAllReport(ctx)]);
  const ids = new Set<string>();
  for (const [id, e] of imports.entries) if (e.account_id === account_id) ids.add(id);
  const mine = new Set((books.entries.get(account_id)?.rows ?? []).flatMap((r) => (r.import_id ? [r.import_id] : [])));
  const elsewhere = new Set<string>();
  for (const [id, book] of books.entries) if (id !== account_id) for (const r of book.rows) if (r.import_id) elsewhere.add(r.import_id);
  for (const id of imports.unreadable) if (mine.has(id) && !elsewhere.has(id)) ids.add(id);
  if (ids.size > 0) await importStore.remove(ctx, ...ids);
  await importSettingsStore.remove(ctx, account_id);
}
