// lib/manual-txns.ts
//
// Transactions on a manual account (lib/manual.ts), entered by hand: cash, a
// bank Plaid can't reach, a card used abroad. Rows imported from a file (#43:
// OFX or QFX, CSV, QIF; lib/import/) land here too, and later rows pulled
// through SimpleFIN, each marked with its `source` and the source's own id
// (`source_id`, an OFX FITID say), so a re-import can tell what is already
// stored, and with the import it came in (`import_id`), so one import can be
// taken out whole.
//
// ONE BOOK PER ACCOUNT. A map store on the storage seam (lib/repo.ts), keyed
// by the manual account's id, each value that account's rows, compressed: the
// shape lib/transactions.ts keeps an Item's rows in, and the one #43 asks for.
// Years of imported history fit easily: a row takes about 100 characters
// stored, so one account holds some 80,000 (test/manual-txns.test.ts measures
// ten thousand); a book that would ever cross the request-size ceiling
// (lib/blob.ts) is refused whole and loudly (StoredValueTooLargeError, 413),
// never trimmed. Deleting the account deletes its book in one step, and an
// account's rows are read with one decrypt. Keeping each import's raw record
// beside its row, as #43 also asks, would take several times that room: it
// is in a store of its own (lib/import/store.ts), not in the book.
//
// WHO WINS. Every change to a book is a compare-and-set (MapStore.updateMany):
// two devices adding to one account at once both land, and so will an import
// running beside an edit. Moving a row to another account changes both books
// in that one step, so the row is always in exactly one of them: never both,
// never neither, whatever fails or races. The client sends the account a row
// is on with each edit or delete, so only that book is read.
//
// READS ARE STRICT. These rows feed spending totals, and imports will match
// against them: an unreadable book is an error naming its account, never an
// empty one. /api/transactions shows the other accounts' rows and says which
// account's could not be read; a change to a book that cannot be read is
// refused (409) and leaves it as it is.
//
// IDS. A row's id is "manual-txn:" and a random UUID, minted by the form when
// it opens, so an add that is sent again (its answer lost on a phone's
// connection) finds its row already there and changes nothing: one row, and a
// balance moved once. It is the row's transaction_id on the Activity tab, and
// the key of anything said about it (lib/txn-annotations.ts). Plaid's
// transaction ids are letters and digits, so the colon keeps the two from
// ever colliding.
//
// BALANCES STAY TYPED. A manual account's balance is what the person typed or
// a script pushed; it feeds net worth and the real history layer
// (lib/history.ts), and nothing here moves it. The quick-add form offers to
// update it as well: the route moves it from the figure the form showed to
// the one it said, as one compare-and-set (lib/manual.ts moveManualBalance),
// and notes the move on the row (balance_update), so the same add sent again
// moves it once. The estimated history (lib/backfill.ts) keeps
// holding manual accounts flat: rows typed beside a typed balance need not add
// up to it, so walking the balance back through them would be invention.

import { defineMapStore, UnreadableEntriesError } from './repo';
import type { Ctx } from './containers';
import { getManualAccounts, toInstitutions, type ManualAccount } from './manual';
import { amountUnitsError, isCalendarDay, isCurrencyCode, MANUAL_TXN_PREFIX, newManualTxnId, type TxnFields } from './manual-txn-input';
import type { Txn } from './transactions';

export { MANUAL_TXN_PREFIX, newManualTxnId };

/** One transaction on a manual account. Amounts use Plaid's sign: positive is
 *  money out. */
export type ManualTxn = TxnFields & {
  id: string;
  /** The manual account it belongs to: the book it is kept in. */
  account_id: string;
  /** 'manual' for one entered in the app; 'import:ofx', 'import:csv' or
   *  'import:qif' for one imported from a file; 'simplefin' once it exists. */
  source: string;
  /** The source's own id for the row, for matching a re-import: an OFX
   *  file's FITID, or for a file without ids (CSV, QIF) the content key it
   *  was imported with (lib/import/normalize.ts). Null for one entered by
   *  hand. */
  source_id: string | null;
  /** The import it came in with (#43), so that import can be taken out whole;
   *  absent or null for one entered by hand. */
  import_id?: string | null;
  /** For a row from a file with ids of its own (OFX): the content key it was
   *  imported with, hashed (lib/import/normalize.ts keyHash), so a later file
   *  holding exactly that version of it finds it, edited since or not. */
  source_key?: string;
  /** Plaid's code for what its file said it was, when the file says so
   *  outright (an OFX file's ATM transaction is "atm": lib/import/ofx.ts
   *  bankType); absent otherwise. The spending rules read it as they read a
   *  bank's (lib/spending.ts, lib/fire/inputs.ts). */
  transaction_code?: string | null;
  /** The balance update its add made, once made ("Also update the balance"):
   *  from the figure the form showed to the one it said, on the account it
   *  was added to (absent on a note written before it was kept). Absent when
   *  it made none. Kept so the same add sent again never moves the balance
   *  twice, nor leaves the row and the balance apart. */
  balance_update?: { from: number; to: number; account_id?: string } | null;
  created_at: string;
  /** When it was last changed in the app. An import that replaces it with
   *  its file's version, and the undo of that, leave it as it was: neither is
   *  the person's change (lib/import/commit.ts). */
  updated_at: string;
};

/** One account's rows, in the order they were added. */
export type ManualTxnBook = { version: 1; rows: ManualTxn[] };

/** A manual row's id: the prefix, then characters the seam takes in a field
 *  name (an annotation is kept under it), 200 in all at most. */
export function isManualTxnId(id: unknown): id is string {
  return typeof id === 'string' && id.startsWith(MANUAL_TXN_PREFIX) && /^[A-Za-z0-9_.:-]{12,200}$/.test(id);
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isInstant = (v: unknown) => typeof v === 'string' && !Number.isNaN(Date.parse(v));
const isText = (v: unknown) => typeof v === 'string';
const isTextOrNull = (v: unknown) => v === null || typeof v === 'string';
const isAmount = (v: unknown) => typeof v === 'number' && Number.isFinite(v);
const isBalanceUpdate = (v: unknown) =>
  v === undefined || v === null || (isRecord(v) && isAmount(v.from) && isAmount(v.to) && (v.account_id === undefined || isText(v.account_id)));
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
    (v.import_id === undefined || isTextOrNull(v.import_id)) &&
    (v.source_key === undefined || (typeof v.source_key === 'string' && v.source_key.length <= 64)) &&
    (v.transaction_code === undefined || v.transaction_code === null || (typeof v.transaction_code === 'string' && v.transaction_code.length <= 40)) &&
    isBalanceUpdate(v.balance_update) &&
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

/** A row entered in the app, stamped now, under the id its form made. */
export function newManualTxn(account_id: string, fields: TxnFields, now: Date = new Date(), id: string = newManualTxnId()): ManualTxn {
  const at = now.toISOString();
  return { id, account_id, ...fields, source: 'manual', source_id: null, created_at: at, updated_at: at };
}

/** A change a stored row can't take (an amount more precise than its
 *  currency): refused before anything is written. */
export class InvalidTxnError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidTxnError';
  }
}

/**
 * Adds a row to its account's book, once: if a row is already there under its
 * id (the same add sent again, its first answer lost), nothing is written, and
 * the answer says so (`added` false) with the row as stored.
 */
export async function addManualTxn(ctx: Ctx, row: ManualTxn): Promise<{ row: ManualTxn; added: boolean }> {
  let result = { row, added: true };
  await manualTxnStore.updateMany(ctx, [row.account_id], (books) => {
    const book = books.get(row.account_id) ?? null;
    const there = book?.rows.find((r) => r.id === row.id);
    result = there ? { row: there, added: false } : { row, added: true };
    return there ? new Map() : new Map([[row.account_id, { version: 1 as const, rows: [...(book?.rows ?? []), row] }]]);
  });
  return result;
}

/**
 * Where a row with this id is kept among the books that can be read, or null:
 * for an add, to tell the same add sent again (the id is on that account
 * already) from an id that is on another account. A book that can't be read
 * is passed over: it can't hold an id a form has only just made.
 */
export async function locateManualTxn(ctx: Ctx, id: string): Promise<{ account_id: string; row: ManualTxn } | null> {
  const { entries } = await manualTxnStore.getAllReport(ctx);
  for (const [account_id, book] of entries) {
    const row = book.rows.find((r) => r.id === id);
    if (row) return { account_id, row };
  }
  return null;
}

/**
 * Where a row is kept, read strictly: its account and the row, or null. With
 * `account_id` (the account the client shows it on) only that book is read,
 * and a row not in it is gone from there (deleted or moved meanwhile).
 * Without it every book is read, and when the row isn't in any that could be
 * read and some could not, this can't say it is gone: it throws
 * UnreadableEntriesError naming those books.
 */
export async function findManualTxn(ctx: Ctx, id: string, account_id?: string): Promise<{ account_id: string; row: ManualTxn } | null> {
  if (account_id !== undefined) {
    const row = (await manualTxnStore.get(ctx, account_id))?.rows.find((r) => r.id === id);
    return row ? { account_id, row } : null;
  }
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
 * Changes a row and returns it as saved, or null when it no longer exists
 * where it was looked for. `from` is the account the client shows it on (only
 * that book is read); without it every book is. A new account_id moves it:
 * out of one book and into the other in one step (MapStore.updateMany), from
 * the row as it is at that moment, so a delete or an edit landing meanwhile
 * is neither undone nor lost. The target account must exist (the route
 * checks). An amount no longer whole in the row's currency (a currency
 * changed alone, say) throws InvalidTxnError, and nothing is written.
 */
export async function editManualTxn(
  ctx: Ctx,
  id: string,
  changes: ManualTxnChanges,
  opts: { from?: string; now?: Date } = {}
): Promise<ManualTxn | null> {
  const found = await findManualTxn(ctx, id, opts.from);
  if (!found) return null;
  const source = found.account_id;
  const target = changes.account_id ?? source;
  const at = (opts.now ?? new Date()).toISOString();
  let saved: ManualTxn | null = null;
  await manualTxnStore.updateMany(ctx, [source, target], (books) => {
    saved = null; // this may run more than once
    const book = books.get(source) ?? null;
    const row = book?.rows.find((r) => r.id === id);
    // Deleted or moved by another device since it was found: nothing to change.
    if (!book || !row) return new Map();
    const next: ManualTxn = { ...row, ...changes, id, account_id: target, updated_at: at };
    const units = amountUnitsError(next.amount, next.currency);
    if (units) throw new InvalidTxnError(units);
    saved = next;
    if (target === source) return new Map([[source, { ...book, rows: book.rows.map((r) => (r.id === id ? next : r)) }]]);
    const into = books.get(target) ?? null;
    return new Map([
      [source, withoutRow(book, id)],
      [target, { version: 1 as const, rows: [...(into?.rows ?? []), next] }],
    ]);
  });
  return saved;
}

/**
 * Records on a row the balance update its add made (ManualTxn.balance_update),
 * wherever the row is now; nothing when it is gone. `account_id` is the
 * account it was added to, whose balance moved, read first.
 */
export async function noteBalanceUpdate(ctx: Ctx, id: string, account_id: string, update: { from: number; to: number }): Promise<void> {
  const found = (await findManualTxn(ctx, id, account_id)) ?? (await findManualTxn(ctx, id));
  if (!found) return;
  const note = { from: update.from, to: update.to, account_id };
  await manualTxnStore.updateMany(ctx, [found.account_id], (books) => {
    const book = books.get(found.account_id) ?? null;
    if (!book?.rows.some((r) => r.id === id)) return new Map();
    return new Map([[found.account_id, { ...book, rows: book.rows.map((r) => (r.id === id ? { ...r, balance_update: note } : r)) }]]);
  });
}

/** A book with one row taken out: null (no book at all) when none is left. */
function withoutRow(book: ManualTxnBook | null, id: string): ManualTxnBook | null {
  if (!book) return null;
  const rows = book.rows.filter((r) => r.id !== id);
  if (rows.length === book.rows.length) return book;
  return rows.length > 0 ? { ...book, rows } : null;
}

/**
 * Deletes a row: from the book of `from` (the account the client shows it
 * on), read alone; when it isn't there (moved on another device meanwhile),
 * wherever it is now, since the person asked for this row to go. False when
 * it is nowhere.
 */
export async function deleteManualTxn(ctx: Ctx, id: string, from?: string): Promise<boolean> {
  for (const where of from !== undefined ? [from, undefined] : [undefined]) {
    const found = await findManualTxn(ctx, id, where);
    if (!found) continue;
    let removed = false;
    await manualTxnStore.updateMany(ctx, [found.account_id], (books) => {
      const book = books.get(found.account_id) ?? null;
      removed = !!book?.rows.some((r) => r.id === id);
      return removed ? new Map([[found.account_id, withoutRow(book, id)]]) : new Map();
    });
    if (removed) return true;
  }
  return false;
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

/** The institution each account is shown under, as the Accounts tab groups
 *  them (lib/manual.ts toInstitutions). */
function institutionsOf(accounts: ManualAccount[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const inst of toInstitutions(accounts)) for (const a of inst.accounts) out.set(a.account_id, inst.institution_name);
  return out;
}

/** One manual row as the Activity tab shows a transaction. */
function toDisplay(row: ManualTxn, account: ManualAccount, institution: string): Txn {
  return {
    transaction_id: row.id,
    date: row.date,
    name: row.name,
    amount: row.amount,
    pending: false,
    account_name: account.name,
    account_type: account.type,
    institution_name: institution,
    category: row.category,
    iso_currency_code: row.currency,
    vendor_key: '',
    ...NO_PLAID_DETAIL,
    transaction_code: row.transaction_code ?? null,
    source: row.source,
    account_id: row.account_id,
    note: row.note,
  };
}

/** One row as the Activity tab shows it, on its account, for a route's answer
 *  (the next load groups the institution with the rest). */
export function manualRowForDisplay(account: ManualAccount, row: ManualTxn): Txn {
  return toDisplay(row, account, institutionsOf([account]).get(account.account_id) ?? 'Manual');
}

/**
 * Every manual row the Activity tab shows, as it shows a transaction: rows of
 * accounts that exist and aren't hidden, dated on or after `cutoff` (the same
 * window as Plaid's rows), labelled with the account's name and institution as
 * the Accounts tab groups them, newest first (by date, then the most recently
 * entered). A row repeated across books (only a restored or hand-written book
 * could hold one) is shown once, the copy saved last. The category and payee
 * are the row's own: an edit changes
 * the row, so no category override or vendor rename applies (vendor_key is
 * empty, which hides the rename field).
 */
export function manualRowsForDisplay(
  accounts: ManualAccount[],
  books: Map<string, ManualTxnBook>,
  opts: { hidden: Set<string>; cutoff: string }
): Txn[] {
  const institutionOf = institutionsOf(accounts);
  // A row is in one book only (a move changes both in one step); a book
  // restored from a backup could still repeat one, which shows once.
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
    .map(({ row, account }) => toDisplay(row, account, institutionOf.get(account.account_id) ?? 'Manual'));
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
  const institutionOf = institutionsOf(accounts.value);
  const notes = accounts.value
    .filter((a) => flawed.has(a.account_id) && !opts.hidden.has(a.account_id))
    .map((a) => `${institutionOf.get(a.account_id) ?? 'Manual'}: transactions entered for ${a.name} couldn't be read`);
  return { txns: manualRowsForDisplay(accounts.value, entries, opts), notes };
}
