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
import { matchRows, type Differs, type Outcome } from './match';
import { digitsOf } from './normalize';
import { isTransfer } from '../spending';
import type { StatementInfo } from './read';
import {
  importSettingsStore,
  importStore,
  importSummaryStore,
  newImportId,
  summaryOf,
  type ImportCounts,
  type ImportEntry,
  type ImportSettings,
  type ReplacedBefore,
  type StoredImportRecord,
  type StoredImportSummary,
  type StoredStatement,
} from './store';

// ---- Planning ----

/** What the person chose for a row whose FITID the account has on another
 *  transaction (lib/import/match.ts): import it as a new row, replace the
 *  stored row with the file's version, or skip it. */
export type ConflictChoice = 'new' | 'replace' | 'skip';
export const CONFLICT_CHOICES: readonly ConflictChoice[] = ['new', 'replace', 'skip'];

/** The person's choices: one for every conflict (`all`), and one for each by
 *  the row's place among the records read (`each`), which wins. A conflict
 *  with neither takes its suggestion, or waits for an answer when it has
 *  none. */
export type ConflictChoices = { all?: ConflictChoice; each?: Record<string, ConflictChoice> };

/** A conflict as the preview lists it. */
export type ImportConflict = {
  /** The row's place among the records read: what a choice for it is keyed by. */
  index: number;
  line: number | null;
  row_id: string;
  differs: Differs;
  suggested: 'new' | null;
  /** What will be done with it, or null until the person says. */
  choice: ConflictChoice | null;
  file: { date: string; name: string; amount: number; currency: string };
  stored: { date: string; name: string; amount: number; currency: string };
};

/** What an import would do, against a book as it stands. */
export type ImportPlan = {
  rows: NormalizedRecord[];
  /** What matching made of each of `rows`, in order. */
  outcomes: Outcome[];
  /** For each row, what is done with it once the person's choices apply. */
  actions: RowAction[];
  /** The rows that can't be read, each with its line and why, in file order. */
  problems: Problem[];
  counts: { new: number; present: number; repeated: number; replaced: number; skipped: number; conflicts: number; unreadable: number };
  conflicts: ImportConflict[];
  /** Rows sharing a FITID with an earlier row of the file that is another
   *  transaction, both imported: their lines, for the preview to name. */
  shared_ids: { line: number | null; with_line: number | null }[];
  first_date: string | null;
  last_date: string | null;
  /** The currency most rows are in, and how many are in each other one. */
  currency: string | null;
  others: { currency: string; count: number }[];
  /** The money out and in of the rows to be added, in `currency`, rounded to
   *  its minor unit. */
  totals: { out: number; in: number };
  /** Rows whose payee, category or note was shortened to fit. */
  shortened: number;
  /** Among the rows to be added or replaced: what the file says they are
   *  (lib/import/ofx.ts bankType, a QIF transfer, a CSV category), which keeps
   *  them out of spending and income (lib/spending.ts), and bank fees. */
  kinds: { transfers: number; atm: number; payments: number; fees: number };
};

/** What is done with one row: added, replacing a stored row, nothing (already
 *  there, repeated or skipped), or waiting for the person's answer. */
export type RowAction = 'add' | 'replace' | 'none' | 'ask';

const byLine = (a: Problem, b: Problem) => a.line - b.line;
const shownRow = (r: { date: string; name: string; amount: number; currency: string }) => ({ date: r.date, name: r.name, amount: r.amount, currency: r.currency });
const roundTo = (n: number, digits: number) => Math.round(n * 10 ** digits) / 10 ** digits;

/** The choice that applies to a conflict (see ConflictChoices). */
function choiceFor(choices: ConflictChoices, index: number, suggested: 'new' | null): ConflictChoice | null {
  return choices.each?.[String(index)] ?? choices.all ?? suggested;
}

/** What importing these rows into this book would do (lib/import/match.ts),
 *  with the person's choices for its conflicts. */
export function planImport(rows: NormalizedRecord[], problems: Problem[], book: ManualTxnBook | null, choices: ConflictChoices = {}): ImportPlan {
  const stored = book?.rows ?? [];
  const outcomes = matchRows(
    rows.map((r) => r.row),
    stored
  );
  const byId = new Map(stored.map((r) => [r.id, r]));
  const counts = { new: 0, present: 0, repeated: 0, replaced: 0, skipped: 0, conflicts: 0, unreadable: problems.length };
  const conflicts: ImportConflict[] = [];
  const shared_ids: ImportPlan['shared_ids'] = [];
  const actions = outcomes.map((o, i): RowAction => {
    if (o.outcome === 'present') counts.present++;
    else if (o.outcome === 'repeated') counts.repeated++;
    else if (o.outcome === 'new') {
      counts.new++;
      if (o.shares_id_with !== undefined) shared_ids.push({ line: rows[i].line, with_line: rows[o.shares_id_with].line });
      return 'add';
    } else {
      const choice = choiceFor(choices, rows[i].index, o.suggested);
      const s = byId.get(o.row_id)!;
      conflicts.push({ index: rows[i].index, line: rows[i].line, row_id: o.row_id, differs: o.differs, suggested: o.suggested, choice, file: shownRow(rows[i].row), stored: shownRow(s) });
      if (choice === 'new') {
        counts.new++;
        return 'add';
      }
      if (choice === 'replace') {
        counts.replaced++;
        return 'replace';
      }
      if (choice === 'skip') counts.skipped++;
      else {
        counts.conflicts++;
        return 'ask';
      }
    }
    return 'none';
  });
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
  const kinds = { transfers: 0, atm: 0, payments: 0, fees: 0 };
  rows.forEach(({ row }, i) => {
    if (actions[i] !== 'add' && actions[i] !== 'replace') return;
    if (row.transaction_code === 'atm') kinds.atm++;
    else if (row.category === 'loan payments') kinds.payments++;
    else if (isTransfer({ transaction_code: row.transaction_code ?? null, category: row.category })) kinds.transfers++;
    else if (row.category === 'bank fees') kinds.fees++;
    if (actions[i] !== 'add' || row.currency !== currency) return;
    if (row.amount > 0) totals.out += row.amount;
    else totals.in -= row.amount;
  });
  const digits = currency ? digitsOf(currency) : 2;
  return {
    rows,
    outcomes,
    actions,
    problems: [...problems].sort(byLine),
    counts,
    conflicts,
    shared_ids,
    first_date: first,
    last_date: last,
    currency,
    others: [...byCurrency].filter(([c]) => c !== currency).map(([c, count]) => ({ currency: c, count })),
    totals: { out: roundTo(totals.out, digits), in: roundTo(totals.in, digits) },
    shortened: rows.filter((r) => r.shortened).length,
    kinds,
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
  /** What the person chose for the file's conflicts. */
  choices?: ConflictChoices;
  now?: Date;
};

export type CommitResult = {
  /** The import's id, or null when nothing was added or replaced, so nothing
   *  was stored. */
  import_id: string | null;
  plan: ImportPlan;
  /** The import's entry as stored, or null. */
  entry: ImportEntry | null;
};

/** Some of the file's rows have a FITID the account has on another
 *  transaction, and the person hasn't said what to do with them. Thrown
 *  before anything is written. */
export class ConflictsUnresolvedError extends Error {
  constructor(readonly count: number) {
    super(
      count === 1
        ? 'One transaction in this file has a bank id (FITID) that is on another transaction already here. Choose what to do with it, then import.'
        : `${count.toLocaleString('en-US')} transactions in this file have a bank id (FITID) that is on another transaction already here. Choose what to do with them, then import.`
    );
    this.name = 'ConflictsUnresolvedError';
  }
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

/** A stored row as it was, for an import that replaces it. */
const beforeOf = (r: ManualTxn): ReplacedBefore => ({
  date: r.date,
  amount: r.amount,
  currency: r.currency,
  name: r.name,
  category: r.category,
  note: r.note,
  transaction_code: r.transaction_code ?? null,
});

/** A row with these fields in place of its own: the bank's facts (day,
 *  amount, currency, payee, Plaid's code), and a category or note only where
 *  the fields have one, so what the person gave the row stays. */
function withFields(r: ManualTxn, f: { date: string; amount: number; currency: string; name: string; category: string | null; note: string | null; transaction_code?: string | null }, at: string, keepEmpty: boolean): ManualTxn {
  const { transaction_code: _old, ...rest } = r;
  const code = f.transaction_code ?? null;
  return {
    ...rest,
    date: f.date,
    amount: f.amount,
    currency: f.currency,
    name: f.name,
    category: keepEmpty ? f.category : (f.category ?? r.category),
    note: keepEmpty ? f.note : (f.note ?? r.note),
    ...(code ? { transaction_code: code } : {}),
    updated_at: at,
  };
}

const SKIPPED = 'Its bank id (FITID) is on another transaction already here, and it was skipped as asked.';

/** The entry an import keeps: every record read, in file order, each with
 *  what became of it. `stored` is the book the rows were matched against, for
 *  how a replaced row was before. */
function entryOf(input: CommitInput, plan: ImportPlan, rowIds: string[], at: string, stored: ManualTxnBook | null): ImportEntry {
  const byId = new Map((stored?.rows ?? []).map((r) => [r.id, r]));
  const records: { line: number; record: StoredImportRecord }[] = [];
  plan.rows.forEach((r, i) => {
    const o = plan.outcomes[i];
    const action = plan.actions[i];
    const raw = r.record.raw;
    let record: StoredImportRecord;
    if (action === 'add') record = { line: r.line, outcome: 'imported', row_id: rowIds[i], raw };
    else if (o.outcome === 'present') record = { line: r.line, outcome: 'present', row_id: o.row_id, raw };
    else if (o.outcome === 'repeated') record = { line: r.line, outcome: 'repeated', raw };
    else if (o.outcome === 'conflict' && action === 'replace') record = { line: r.line, outcome: 'replaced', row_id: o.row_id, before: beforeOf(byId.get(o.row_id)!), raw };
    else if (o.outcome === 'conflict') record = { line: r.line, outcome: 'skipped', row_id: o.row_id, reason: SKIPPED, raw };
    else record = { line: r.line, outcome: 'imported', row_id: rowIds[i], raw };
    records.push({ line: r.line ?? 0, record });
  });
  for (const p of plan.problems) records.push({ line: p.line, record: { line: p.line || null, outcome: 'unreadable', reason: p.reason, raw: p.raw ?? null } });
  records.sort((a, b) => a.line - b.line);
  const c = plan.counts;
  const counts: ImportCounts = {
    imported: c.new,
    present: c.present,
    repeated: c.repeated,
    unreadable: c.unreadable,
    ...(c.replaced > 0 ? { replaced: c.replaced } : {}),
    ...(c.skipped > 0 ? { skipped: c.skipped } : {}),
  };
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

/** Whether an import changes anything: rows to add or replace. */
const changes = (plan: ImportPlan) => plan.counts.new + plan.counts.replaced > 0;

/**
 * Imports the rows into the account's book (see the header), and keeps the
 * file's records. Nothing is stored when no row would be added or replaced.
 * Throws ConflictsUnresolvedError when a conflict has no answer, and what the
 * seam throws (StoredValueTooLargeError when the book or the records would be
 * too large, UnreadableEntriesError for a book that can't be read,
 * UpdateConflictError when it kept changing), having written nothing.
 */
export async function commitImport(ctx: Ctx, input: CommitInput): Promise<CommitResult> {
  const { account } = input;
  const choices = input.choices ?? {};
  const at = (input.now ?? new Date()).toISOString();
  // Strict: a book that can't be read is never matched as an empty one.
  const before = await manualTxnStore.get(ctx, account.account_id);
  const first = planImport(input.rows, input.problems, before, choices);
  if (first.counts.conflicts > 0) throw new ConflictsUnresolvedError(first.counts.conflicts);
  if (!changes(first)) return { import_id: null, plan: first, entry: null };

  const import_id = newImportId();
  // One id per row, made once, so a retried compare-and-set writes the same
  // rows the entry names.
  const rowIds = input.rows.map(() => newManualTxnId());
  const entry = entryOf(input, first, rowIds, at, before);
  // The records first, refused whole when too large; then the summary the
  // list reads, without which the records go again.
  await importStore.set(ctx, import_id, entry);
  try {
    await importSummaryStore.set(ctx, import_id, summaryOf(entry));
  } catch (err) {
    await importStore.remove(ctx, import_id).catch((cleanup) => console.warn('import: an import that failed left its record, listed with Undo', loggable(cleanup)));
    throw err;
  }

  let plan = first;
  let matched: ManualTxnBook | null = before;
  try {
    await manualTxnStore.updateMany(ctx, [account.account_id], (books) => {
      const book = books.get(account.account_id) ?? null;
      matched = book;
      plan = planImport(input.rows, input.problems, book, choices);
      // A row added on another device meanwhile can raise a new conflict.
      if (plan.counts.conflicts > 0) throw new ConflictsUnresolvedError(plan.counts.conflicts);
      if (!changes(plan)) return new Map();
      const replacing = new Map<string, NormalizedRecord>();
      const added: ManualTxn[] = [];
      plan.rows.forEach((r, i) => {
        const o = plan.outcomes[i];
        if (plan.actions[i] === 'replace' && o.outcome === 'conflict') replacing.set(o.row_id, r);
        if (plan.actions[i] !== 'add') return;
        added.push({ id: rowIds[i], account_id: account.account_id, ...r.row, import_id, created_at: at, updated_at: at });
      });
      const kept = (book?.rows ?? []).map((row) => {
        const r = replacing.get(row.id);
        return r ? withFields(row, r.row, at, false) : row;
      });
      return new Map([[account.account_id, { version: 1 as const, rows: [...kept, ...added] }]]);
    });
  } catch (err) {
    await dropEntryUnlessStored(ctx, account.account_id, import_id, err);
    throw err;
  }
  if (!changes(plan)) {
    // Everything arrived meanwhile (the same file, sent twice at once).
    await importStore.remove(ctx, import_id);
    await importSummaryStore.remove(ctx, import_id);
    return { import_id: null, plan, entry: null };
  }
  let stored = entry;
  const final = entryOf(input, plan, rowIds, at, matched);
  if (JSON.stringify(final.records) !== JSON.stringify(entry.records)) {
    try {
      await importStore.set(ctx, import_id, final);
      await importSummaryStore.set(ctx, import_id, summaryOf(final));
      stored = final;
    } catch (err) {
      // The rows are in; the entry still names every record, with what the
      // first matching made of them.
      console.warn('import: an import’s records could not be brought up to date', loggable(err));
    }
  }
  return { import_id, plan, entry: stored };
}

/** After the rows couldn't be written: the entry and its summary go, unless
 *  the book may hold its rows after all (an answer lost on the way). A
 *  refusal, a conflict or a damaged book is certain to have written nothing. */
async function dropEntryUnlessStored(ctx: Ctx, account_id: string, import_id: string, err: unknown): Promise<void> {
  try {
    if (!(err instanceof StoreRefusedError || err instanceof StoredDataUnreadableError || err instanceof ConflictsUnresolvedError)) {
      const book = await manualTxnStore.get(ctx, account_id);
      if (book?.rows.some((r) => r.import_id === import_id)) return;
    }
    await importStore.remove(ctx, import_id);
    await importSummaryStore.remove(ctx, import_id);
  } catch (cleanup) {
    console.warn('import: an import that failed left its record, listed with Undo', loggable(cleanup));
  }
}

/** Notes on an import's entry and summary the balance it also set. Best
 *  effort: the balance moved either way. */
export async function noteBalanceSet(ctx: Ctx, import_id: string, update: { from: number; to: number; as_of: string }): Promise<void> {
  try {
    await importStore.update(ctx, import_id, (current) => (current ? { ...current, balance_update: update } : null));
    await importSummaryStore.update(ctx, import_id, (current) => (current ? { ...current, balance_update: update } : null));
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

/** Whether a row changed since its import added it. */
const editedSince = (r: ManualTxn) => r.updated_at !== r.created_at;

/** What undoing an import needs to know before it changes anything. */
type UndoBasis = {
  entry: ImportEntry | null;
  /** Its entry's bytes are damaged: it is removed with the rows. */
  damaged: boolean;
  /** Rows a later import relied on (found already there, or replaced), each
   *  with the earliest such import: they are kept, for that import. */
  relied: Map<string, string>;
  /** The later imports that relied on any row, as their summaries have them. */
  later: Map<string, StoredImportSummary>;
  /** Rows this import replaced, and how each was before it. */
  restore: Map<string, ReplacedBefore>;
};

/**
 * What undoing an import must respect (see the header): its entry, read
 * strictly (damaged bytes are noted, anything else unreadable throws), and
 * the later imports that relied on any of its rows, read whole: only those
 * whose summaries say they found rows already there or replaced some, and
 * that came after it. One of those that can't be read could have relied on
 * any of its rows, so it throws rather than guessing.
 */
async function undoBasis(ctx: Ctx, account_id: string, import_id: string): Promise<UndoBasis> {
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
  const summaries = await importSummaryStore.getAllReport(ctx);
  const since = entry?.imported_at ?? summaries.entries.get(import_id)?.imported_at ?? null;
  const candidates = [...summaries.entries]
    .filter(([id, s]) => id !== import_id && s.counts.present + (s.counts.replaced ?? 0) > 0 && (since === null || s.imported_at >= since))
    .map(([id]) => id);
  // A summary that can't be read could be any import's: its entry says.
  for (const id of [...summaries.unreadable, ...summaries.unrecognised]) if (id !== import_id) candidates.push(id);
  const later = new Map<string, StoredImportSummary>();
  const relied = new Map<string, { by: string; at: string }>();
  for (const id of candidates) {
    const e = await importStore.get(ctx, id);
    if (!e || (since !== null && e.imported_at < since)) continue;
    later.set(id, summaries.entries.get(id) ?? summaryOf(e));
    for (const r of e.records) {
      if ((r.outcome !== 'present' && r.outcome !== 'replaced') || !r.row_id) continue;
      const seen = relied.get(r.row_id);
      if (!seen || e.imported_at < seen.at) relied.set(r.row_id, { by: id, at: e.imported_at });
    }
  }
  const restore = new Map<string, ReplacedBefore>();
  for (const r of entry?.records ?? []) if (r.outcome === 'replaced' && r.row_id && r.before) restore.set(r.row_id, r.before);
  return { entry, damaged, relied: new Map([...relied].map(([row, { by }]) => [row, by])), later, restore };
}

export type UndoPlan = {
  /** 'ok', or that the import's entry can't be read (Undo still takes its
   *  rows out). */
  record: 'ok' | 'unreadable';
  /** Rows it added that go, how many of them were changed since, and how
   *  many are on another account now. */
  remove: number;
  edited: number;
  moved: number;
  /** Rows it added that a later import found already there and relied on:
   *  kept, for that import, whose Undo takes them out. */
  kept: { import_id: string; file_name: string | null; imported_at: string; count: number }[];
  /** Rows it replaced with its file's version, put back as they were. */
  restore: number;
  /** Some books can't be read: their rows of this import can't be counted. */
  incomplete: boolean;
};

/** What undoing an import would do, changing nothing: for the confirmation. */
export async function undoPlan(ctx: Ctx, account_id: string, import_id: string): Promise<UndoPlan> {
  const basis = await undoBasis(ctx, account_id, import_id);
  const books = await manualTxnStore.getAllReport(ctx);
  const plan: UndoPlan = { record: basis.damaged ? 'unreadable' : 'ok', remove: 0, edited: 0, moved: 0, kept: [], restore: 0, incomplete: books.unreadable.length + books.unrecognised.length > 0 };
  const kept = new Map<string, number>();
  for (const [id, book] of books.entries) {
    for (const r of book.rows) {
      if (r.import_id === import_id) {
        const by = basis.relied.get(r.id);
        if (by) kept.set(by, (kept.get(by) ?? 0) + 1);
        else {
          plan.remove++;
          if (editedSince(r)) plan.edited++;
          if (id !== account_id) plan.moved++;
        }
      } else if (basis.restore.has(r.id) && !basis.relied.has(r.id)) plan.restore++;
    }
  }
  if (!basis.entry && !basis.damaged && plan.remove + kept.size + plan.restore === 0) throw new ImportNotFoundError();
  plan.kept = [...kept].map(([id, count]) => {
    const s = basis.later.get(id);
    return { import_id: id, file_name: s?.file_name ?? null, imported_at: s?.imported_at ?? '', count };
  });
  return plan;
}

export type UndoResult = { removed: number; edited: number; moved: number; kept: number; restored: number; ids: string[] };

/**
 * Takes an import out (see the header): the rows it added wherever they are,
 * except those a later import relied on, which are kept for that import; the
 * rows it replaced, put back as they were (unless a later import relied on
 * them as they are); what was said about the rows that go; its entry and
 * summary. Throws ImportNotFoundError when there is nothing of it on this
 * account, UnreadableEntriesError when the account's book can't be read, the
 * entry is one this release doesn't recognise, or a later import's can't be
 * read.
 */
export async function undoImport(ctx: Ctx, account_id: string, import_id: string, now: Date = new Date()): Promise<UndoResult> {
  const basis = await undoBasis(ctx, account_id, import_id);
  const at = now.toISOString();
  const result: UndoResult = { removed: 0, edited: 0, moved: 0, kept: 0, restored: 0, ids: [] };
  const handed = new Map<string, number>();
  const restored = new Set<string>();
  // A row moved between books while this ran is found on the next pass.
  for (let pass = 0; pass < 3; pass++) {
    const report = await manualTxnStore.getAllReport(ctx);
    if (report.unreadable.includes(account_id) || report.unrecognised.includes(account_id)) {
      throw new UnreadableEntriesError(manualTxnStore.what, report.unreadable.filter((id) => id === account_id), report.unrecognised.filter((id) => id === account_id));
    }
    const touches = (r: ManualTxn) => r.import_id === import_id || (basis.restore.has(r.id) && !basis.relied.has(r.id) && !restored.has(r.id));
    const holding = [...report.entries].filter(([, book]) => book.rows.some(touches)).map(([id]) => id);
    if (holding.length === 0) break;
    for (let i = 0; i < holding.length; i += MANY_AT_ONCE) {
      const chunk = holding.slice(i, i + MANY_AT_ONCE);
      let taken: { id: string; edited: boolean; moved: boolean }[] = [];
      let passed: { to: string }[] = [];
      let putBack: string[] = [];
      await manualTxnStore.updateMany(ctx, chunk, (books) => {
        taken = [];
        passed = [];
        putBack = [];
        const next = new Map<string, ManualTxnBook | null>();
        for (const [id, book] of books) {
          if (!book) continue;
          let changed = false;
          const rows: ManualTxn[] = [];
          for (const r of book.rows) {
            if (r.import_id === import_id) {
              changed = true;
              const by = basis.relied.get(r.id);
              if (by) {
                rows.push({ ...r, import_id: by });
                passed.push({ to: by });
              } else taken.push({ id: r.id, edited: editedSince(r), moved: id !== account_id });
            } else if (basis.restore.has(r.id) && !basis.relied.has(r.id) && !restored.has(r.id)) {
              changed = true;
              rows.push(withFields(r, basis.restore.get(r.id)!, at, true));
              putBack.push(r.id);
            } else rows.push(r);
          }
          if (changed) next.set(id, rows.length > 0 ? { ...book, rows } : null);
        }
        return next;
      });
      for (const t of taken) {
        result.ids.push(t.id);
        result.removed++;
        if (t.edited) result.edited++;
        if (t.moved) result.moved++;
      }
      for (const p of passed) handed.set(p.to, (handed.get(p.to) ?? 0) + 1);
      for (const id of putBack) restored.add(id);
    }
  }
  result.kept = [...handed.values()].reduce((n, c) => n + c, 0);
  result.restored = restored.size;
  if (!basis.entry && !basis.damaged && result.removed + result.kept + result.restored === 0) throw new ImportNotFoundError();
  // The imports that now hold rows say so in their summaries. Best effort:
  // their rows are theirs either way, and their Undo finds them.
  for (const [id, count] of handed) {
    await importSummaryStore
      .update(ctx, id, (current) => (current ? { ...current, taken_over: (current.taken_over ?? 0) + count } : null))
      .catch((err) => console.warn('import: rows kept for a later import could not be noted on it', loggable(err)));
  }
  // What was said about the rows goes with them. Best effort: a record left
  // behind names a row that no longer exists, which is never shown.
  await forgetAnnotations(ctx, result.ids).catch((err) => console.warn('import: exclusions of undone rows were left behind', loggable(err)));
  await importStore.remove(ctx, import_id);
  await importSummaryStore.remove(ctx, import_id);
  return result;
}

// ---- Listing ----

export type ImportSummary = {
  id: string;
  /** 'ok', or why it can't be shown: its record's bytes are damaged, a later
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
  balance_update: StoredImportSummary['balance_update'];
  /** Rows kept for it when an earlier import was undone. */
  taken_over: number;
  /** Its rows stored now, on any account; of those, how many were changed
   *  since, and how many are on another account. Null when some book can't
   *  be read, so they can't be counted. */
  rows_now: number | null;
  edited_now: number | null;
  moved_now: number | null;
};

const unknownImport = (id: string, record: ImportSummary['record']): Omit<ImportSummary, 'rows_now' | 'edited_now' | 'moved_now'> => ({
  id,
  record,
  format: null,
  file_name: null,
  imported_at: null,
  counts: null,
  first_date: null,
  last_date: null,
  currency: null,
  statement: null,
  balance_update: null,
  taken_over: 0,
});

const listed = (id: string, s: StoredImportSummary): Omit<ImportSummary, 'rows_now' | 'edited_now' | 'moved_now'> => ({
  id,
  record: 'ok',
  format: s.format,
  file_name: s.file_name,
  imported_at: s.imported_at,
  counts: s.counts,
  first_date: s.first_date,
  last_date: s.last_date,
  currency: s.currency,
  statement: s.statement,
  balance_update: s.balance_update,
  taken_over: s.taken_over ?? 0,
});

/**
 * The imports into an account, newest first, with what is left of each. For
 * the import sheet's list: a display read of the summaries and the books
 * (getAllReport), never of a file's records, which names what it can't read
 * rather than failing; nothing is written or removed from this answer. An
 * import whose rows are on this account but that has no summary to show is
 * listed too, from its entry, read alone (or as damaged or gone), so Undo can
 * take its rows out.
 */
export async function listImports(ctx: Ctx, account_id: string): Promise<ImportSummary[]> {
  const [summaries, books] = await Promise.all([importSummaryStore.getAllReport(ctx), manualTxnStore.getAllReport(ctx)]);
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
  for (const [id, s] of summaries.entries) if (s.account_id === account_id) out.push({ ...listed(id, s), ...now(id) });
  for (const id of onThisAccount) {
    // Listed above, or another account's import with a row moved here.
    if (summaries.entries.has(id)) continue;
    let item = unknownImport(id, 'missing');
    try {
      const e = await importStore.get(ctx, id);
      if (e) item = listed(id, summaryOf(e));
    } catch (err) {
      if (!(err instanceof UnreadableEntriesError)) throw err;
      item = unknownImport(id, err.unreadable.includes(id) ? 'unreadable' : 'unrecognised');
    }
    out.push({ ...item, ...now(id) });
  }
  return out.sort((a, b) => (b.imported_at ?? '').localeCompare(a.imported_at ?? ''));
}

/**
 * For deleting a manual account: its imports' entries and summaries, and its
 * settings, go. Its rows go with its book (the caller deletes that), and so
 * does an import named only by this account's rows whose summary can't be
 * read and whose entry is this account's or is damaged, since the person
 * asked for everything about the account to go. Rows of its imports moved to
 * another account keep their import there; that import, its entry gone, is
 * still listed on that account with Undo. Call it before the book is deleted.
 * Throws only when storage can't be reached.
 */
export async function forgetAccountImports(ctx: Ctx, account_id: string): Promise<void> {
  const [summaries, books] = await Promise.all([importSummaryStore.getAllReport(ctx), manualTxnStore.getAllReport(ctx)]);
  const ids = new Set<string>();
  for (const [id, s] of summaries.entries) if (s.account_id === account_id) ids.add(id);
  const mine = new Set((books.entries.get(account_id)?.rows ?? []).flatMap((r) => (r.import_id ? [r.import_id] : [])));
  const elsewhere = new Set<string>();
  for (const [id, book] of books.entries) if (id !== account_id) for (const r of book.rows) if (r.import_id) elsewhere.add(r.import_id);
  for (const id of mine) {
    if (summaries.entries.has(id) || elsewhere.has(id)) continue;
    try {
      const e = await importStore.get(ctx, id);
      if (!e || e.account_id === account_id) ids.add(id);
    } catch (err) {
      if (!(err instanceof UnreadableEntriesError)) throw err;
      if (err.unreadable.includes(id)) ids.add(id);
    }
  }
  if (ids.size > 0) {
    await importStore.remove(ctx, ...ids);
    await importSummaryStore.remove(ctx, ...ids);
  }
  await importSettingsStore.remove(ctx, account_id);
}
