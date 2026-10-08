// lib/manual-txns.ts
//
// Transactions on a manual account (lib/manual.ts), entered by hand: cash, a
// bank Plaid can't reach, a card used abroad. Later, rows imported from a file
// (#43: CSV, OFX) or pulled through SimpleFIN land here too, each marked with
// its `source` and the source's own id (`source_id`, an OFX FITID say), so a
// re-import can tell what is already stored and a batch can be removed whole.
//
// ONE BOOK PER ACCOUNT. A map store on the storage seam (lib/repo.ts), keyed
// by the manual account's id, each value that account's rows, compressed: the
// shape lib/transactions.ts keeps an Item's rows in, and the one #43 asks for.
// Years of imported history fit easily: a row takes about 100 characters
// stored, so one account holds some 80,000 (test/manual-txns.test.ts measures
// ten thousand); a book that would ever cross the request-size ceiling
// (lib/blob.ts) is refused whole and loudly (StoredValueTooLargeError, 413),
// never trimmed. Deleting the account deletes its book in one step, and an
// account's rows are read with one decrypt.
//
// WHO WINS. Every change to a book goes through MapStore.update, a
// compare-and-set: two devices adding to one account at once both land, and
// so will an import running beside an edit. A row is found by its id, which
// the client gets with it.
//
// READS ARE STRICT. These rows feed spending totals, and imports will match
// against them: an unreadable book is an error naming its account, never an
// empty one. /api/transactions shows the other accounts' rows and says which
// account's could not be read; a change to a book that cannot be read is
// refused (409) and leaves it as it is.
//
// IDS. A row's id is "manual-txn:" and a random UUID, minted here: it is the
// row's transaction_id on the Activity tab, and the key of anything said about
// it (lib/txn-annotations.ts). Plaid's transaction ids are letters and digits,
// so the colon keeps the two from ever colliding.
//
// BALANCES STAY TYPED. A manual account's balance is what the person typed or
// a script pushed; it feeds net worth and the real history layer
// (lib/history.ts), and nothing here moves it. The quick-add form offers to
// update it as well, which the route records as the same balance update the
// account's Update form makes. The estimated history (lib/backfill.ts) keeps
// holding manual accounts flat: rows typed beside a typed balance need not add
// up to it, so walking the balance back through them would be invention.

import { defineMapStore, UnreadableEntriesError } from './repo';
import type { Ctx } from './containers';
import { getManualAccounts, toInstitutions, type ManualAccount } from './manual';
import { isCalendarDay, isCurrencyCode, type TxnFields } from './manual-txn-input';
import type { Txn } from './transactions';

/** The start of every manual row's id. Not a Plaid id: Plaid's have no colon. */
export const MANUAL_TXN_PREFIX = 'manual-txn:';

/** One transaction on a manual account. Amounts use Plaid's sign: positive is
 *  money out. */
export type ManualTxn = TxnFields & {
  id: string;
  /** The manual account it belongs to: the book it is kept in. */
  account_id: string;
  /** 'manual' for one entered in the app; 'import:csv', 'import:ofx' or
   *  'simplefin' once those exist. */
  source: string;
  /** The source's own id for the row, for matching a re-import; null for one
   *  entered by hand. */
  source_id: string | null;
  created_at: string;
  updated_at: string;
};

/** One account's rows, in the order they were added. */
export type ManualTxnBook = { version: 1; rows: ManualTxn[] };

export function newManualTxnId(): string {
  return `${MANUAL_TXN_PREFIX}${crypto.randomUUID()}`;
}

/** A manual row's id: the prefix, then characters the seam takes in a field
 *  name (an annotation is kept under it), 200 in all at most. */
export function isManualTxnId(id: unknown): id is string {
  return typeof id === 'string' && id.startsWith(MANUAL_TXN_PREFIX) && /^[A-Za-z0-9_.:-]{12,200}$/.test(id);
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isInstant = (v: unknown) => typeof v === 'string' && !Number.isNaN(Date.parse(v));
const isText = (v: unknown) => typeof v === 'string';
const isTextOrNull = (v: unknown) => v === null || typeof v === 'string';
/** A source: lower-case words joined by ":", like "import:csv". */
const isSource = (v: unknown) => typeof v === 'string' && v.length <= 40 && /^[a-z][a-z0-9]*(?::[a-z0-9]+)*$/.test(v);

/**
 * One stored row. The shape and types only, not today's limits (a payee's
 * length, how far ahead a date may be): those are checked when a row is saved
 * (lib/manual-txn-input.ts), and a row saved under other limits must still
 * read. Fields a later release adds are kept as they are, so a rollback reads
 * its rows rather than calling the whole book unrecognised.
 */
export function isManualTxn(v: unknown): v is ManualTxn {
  if (!isRecord(v)) return false;
  return (
    isManualTxnId(v.id) &&
    isText(v.account_id) &&
    isCalendarDay(v.date) &&
    typeof v.amount === 'number' &&
    Number.isFinite(v.amount) &&
    isCurrencyCode(v.currency) &&
    isText(v.name) &&
    isTextOrNull(v.category) &&
    isTextOrNull(v.note) &&
    isSource(v.source) &&
    isTextOrNull(v.source_id) &&
    isInstant(v.created_at) &&
    isInstant(v.updated_at)
  );
}

/** A book: version 1, every row valid, each id once, all of one account. */
export function isManualTxnBook(v: unknown): v is ManualTxnBook {
  if (!isRecord(v) || v.version !== 1 || !Array.isArray(v.rows)) return false;
  const ids = new Set<string>();
  let account: string | null = null;
  for (const row of v.rows) {
    if (!isManualTxn(row) || ids.has(row.id)) return false;
    if (account !== null && row.account_id !== account) return false;
    ids.add(row.id);
    account = row.account_id;
  }
  return true;
}

export const manualTxnStore = defineMapStore<ManualTxnBook>('manual-transactions', {
  what: 'manual transactions',
  isValid: isManualTxnBook,
  exportable: true, // what the person entered
  compress: true, // a book can hold years of rows
});

/** A row entered in the app, stamped now. */
export function newManualTxn(account_id: string, fields: TxnFields, now: Date = new Date()): ManualTxn {
  const at = now.toISOString();
  return { id: newManualTxnId(), account_id, ...fields, source: 'manual', source_id: null, created_at: at, updated_at: at };
}

/** Adds a row to its account's book (a row already there under its id is
 *  replaced, so a retried add is still one row). */
export async function addManualTxn(ctx: Ctx, row: ManualTxn): Promise<void> {
  await manualTxnStore.update(ctx, row.account_id, (book) => ({
    version: 1,
    rows: [...(book?.rows ?? []).filter((r) => r.id !== row.id), row],
  }));
}

/**
 * Where a row is kept, read strictly: its account and the row, or null when no
 * book has it. When it isn't in any book that could be read and some could
 * not, this cannot say it is gone, and throws UnreadableEntriesError naming
 * those books.
 */
export async function findManualTxn(ctx: Ctx, id: string): Promise<{ account_id: string; row: ManualTxn } | null> {
  const { entries, unreadable, unrecognised } = await manualTxnStore.getAllReport(ctx);
  for (const [account_id, book] of entries) {
    const row = book.rows.find((r) => r.id === id);
    if (row) return { account_id, row };
  }
  if (unreadable.length > 0 || unrecognised.length > 0) {
    throw new UnreadableEntriesError(manualTxnStore.what, unreadable, unrecognised);
  }
  return null;
}

/** What an edit may change: the fields entered, and the account. */
export type ManualTxnChanges = Partial<TxnFields> & { account_id?: string };

/**
 * Changes a row, wherever it is kept, and returns it as saved, or null when it
 * no longer exists. A new account_id moves it: it is copied into that
 * account's book first and only then taken out of the old one, so a failure in
 * between leaves it in both (shown once, the moved copy, by
 * manualRowsForDisplay) rather than in neither, and repeating the edit
 * finishes the move. The target account must exist (the route checks).
 */
export async function editManualTxn(ctx: Ctx, id: string, changes: ManualTxnChanges, now: Date = new Date()): Promise<ManualTxn | null> {
  const found = await findManualTxn(ctx, id);
  if (!found) return null;
  const target = changes.account_id ?? found.account_id;
  const at = now.toISOString();

  if (target === found.account_id) {
    let saved: ManualTxn | null = null;
    await manualTxnStore.update(ctx, target, (book) => {
      saved = null; // update may run this more than once
      const row = book?.rows.find((r) => r.id === id);
      // Deleted or moved by another device since it was found: nothing to change.
      if (!book || !row) return book;
      const next: ManualTxn = { ...row, ...changes, id, account_id: target, updated_at: at };
      saved = next;
      return { ...book, rows: book.rows.map((r) => (r.id === id ? next : r)) };
    });
    return saved;
  }

  const moved: ManualTxn = { ...found.row, ...changes, id, account_id: target, updated_at: at };
  await manualTxnStore.update(ctx, target, (book) => ({
    version: 1,
    rows: [...(book?.rows ?? []).filter((r) => r.id !== id), moved],
  }));
  await manualTxnStore.update(ctx, found.account_id, (book) => withoutRow(book, id));
  return moved;
}

/** A book with one row taken out: null (no book at all) when none is left. */
function withoutRow(book: ManualTxnBook | null, id: string): ManualTxnBook | null {
  if (!book) return null;
  const rows = book.rows.filter((r) => r.id !== id);
  if (rows.length === book.rows.length) return book;
  return rows.length > 0 ? { ...book, rows } : null;
}

/** Deletes a row wherever it is kept. False when it no longer exists. */
export async function deleteManualTxn(ctx: Ctx, id: string): Promise<boolean> {
  const found = await findManualTxn(ctx, id);
  if (!found) return false;
  await manualTxnStore.update(ctx, found.account_id, (book) => withoutRow(book, id));
  return true;
}

/**
 * Deletes a manual account's book, readable or not, for deleting the account:
 * its rows go with it. Returns the ids of the rows it held, when the book
 * could be read, so what was said about them can go too; an unreadable book
 * is deleted all the same (the person asked for the whole account to go), and
 * whatever was said about its rows is left, never shown again.
 */
export async function removeAccountTxns(ctx: Ctx, account_id: string): Promise<string[]> {
  let ids: string[] = [];
  try {
    ids = (await manualTxnStore.get(ctx, account_id))?.rows.map((r) => r.id) ?? [];
  } catch (err) {
    console.warn('manual-txns: a deleted account\'s transactions could not be read; deleting them anyway', err instanceof Error ? err.name : err);
  }
  await manualTxnStore.remove(ctx, account_id);
  return ids;
}

/** The fields a Plaid row carries that a typed one has nothing for: null, so
 *  every row has one shape. */
const NO_PLAID_DETAIL = {
  logo_url: null,
  category_icon_url: null,
  subcategory: null,
  category_confidence: null,
  transaction_code: null,
  payment_channel: null,
  datetime: null,
  website: null,
  check_number: null,
  account_owner: null,
  city: null,
  region: null,
  counterparty: null,
  payment_processor: null,
  payment_reference: null,
} as const;

/**
 * Every manual row the Activity tab shows, as it shows a transaction: rows of
 * accounts that exist and aren't hidden, dated on or after `cutoff` (the same
 * window as Plaid's rows), labelled with the account's name and institution as
 * the Accounts tab groups them, newest first (by date, then the most recently
 * entered). A row found in two books (a move interrupted) is shown once, the
 * copy saved last. The category and payee are the row's own: an edit changes
 * the row, so no category override or vendor rename applies (vendor_key is
 * empty, which hides the rename field).
 */
export function manualRowsForDisplay(
  accounts: ManualAccount[],
  books: Map<string, ManualTxnBook>,
  opts: { hidden: Set<string>; cutoff: string }
): Txn[] {
  const institutionOf = new Map<string, string>();
  for (const inst of toInstitutions(accounts)) for (const a of inst.accounts) institutionOf.set(a.account_id, inst.institution_name);
  const byId = new Map<string, { row: ManualTxn; account: ManualAccount }>();
  for (const account of accounts) {
    if (opts.hidden.has(account.account_id)) continue;
    for (const row of books.get(account.account_id)?.rows ?? []) {
      if (row.date < opts.cutoff) continue;
      const seen = byId.get(row.id);
      if (!seen || row.updated_at > seen.row.updated_at) byId.set(row.id, { row, account });
    }
  }
  return [...byId.values()]
    .sort(
      (a, b) =>
        (a.row.date < b.row.date ? 1 : a.row.date > b.row.date ? -1 : 0) ||
        (a.row.created_at < b.row.created_at ? 1 : a.row.created_at > b.row.created_at ? -1 : 0) ||
        (a.row.id < b.row.id ? -1 : a.row.id > b.row.id ? 1 : 0)
    )
    .map(({ row, account }) => ({
      transaction_id: row.id,
      date: row.date,
      name: row.name,
      amount: row.amount,
      pending: false,
      account_name: account.name,
      institution_name: institutionOf.get(account.account_id) ?? 'Manual',
      category: row.category,
      iso_currency_code: row.currency,
      vendor_key: '',
      ...NO_PLAID_DETAIL,
      source: row.source,
      account_id: row.account_id,
      note: row.note,
    }));
}

/**
 * The manual rows for /api/transactions, with a note for each account whose
 * rows could not be read ("<institution>: ..."), as an institution that
 * failed to sync gets one. The rest are shown: a book that can't be read
 * hides only its own account's rows, and says so. Strict underneath: nothing
 * unreadable is ever shown as no rows without a note.
 */
export async function readManualTxnsForDisplay(
  ctx: Ctx,
  opts: { hidden: Set<string>; cutoff: string }
): Promise<{ txns: Txn[]; notes: string[] }> {
  const [accounts, report] = await Promise.all([
    getManualAccounts(ctx).then(
      (value) => ({ ok: true as const, value }),
      (err: unknown) => ({ ok: false as const, err })
    ),
    manualTxnStore.getAllReport(ctx).then(
      (value) => ({ ok: true as const, value }),
      (err: unknown) => ({ ok: false as const, err })
    ),
  ]);
  if (!accounts.ok) {
    console.error('manual-txns: manual accounts could not be read', accounts.err instanceof Error ? accounts.err.message : accounts.err);
    return { txns: [], notes: ["Manual accounts: couldn't be read, so transactions entered for them aren't shown"] };
  }
  if (!report.ok) {
    console.error('manual-txns: manual transactions could not be read', report.err instanceof Error ? report.err.message : report.err);
    // Only an account that could have rows makes this worth saying.
    return accounts.value.length > 0
      ? { txns: [], notes: ["Manual accounts: transactions entered for them couldn't be read"] }
      : { txns: [], notes: [] };
  }
  const { entries, unreadable, unrecognised } = report.value;
  const flawed = new Set([...unreadable, ...unrecognised]);
  const institutionOf = new Map<string, string>();
  for (const inst of toInstitutions(accounts.value)) for (const a of inst.accounts) institutionOf.set(a.account_id, inst.institution_name);
  const notes = accounts.value
    .filter((a) => flawed.has(a.account_id) && !opts.hidden.has(a.account_id))
    .map((a) => `${institutionOf.get(a.account_id) ?? 'Manual'}: transactions entered for ${a.name} couldn't be read`);
  return { txns: manualRowsForDisplay(accounts.value, entries, opts), notes };
}
