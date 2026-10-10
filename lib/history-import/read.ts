// lib/history-import/read.ts
//
// Reading what was imported into LINKED accounts (#52), for everything that
// shows or counts transactions: the Activity tab and the read-only API (both
// through lib/activity.ts), the walk that extends the estimated history
// (lib/history-import/extend.ts), sharing (lib/sharing.ts) and the import
// sheet itself.
//
// WHICH ROWS COUNT. An imported row counts as a transaction of its account
// unless it is a duplicate (the person said it is the bank's row) or a bank
// row now supersedes it (lib/history-import/match.ts supersede): the bank's
// rows are the authority wherever they reach. Worked out on every read,
// against the bank's rows as stored (lib/transactions.ts), never by a write,
// so nothing a sync, an undo or a re-link does can leave it stale.
//
// WHOSE ROWS. A book is filed under the account id its rows were imported
// into, and an account's rows are those of every id it has had, by the links
// that apply now (lib/link-core.ts): an import survives a re-link once the
// person links the two. Only an account that is live (on a connection still
// stored) shows its imported rows; one whose institution was disconnected
// keeps them, for a re-link, until it is forgotten. Hidden accounts' rows are
// left out where their bank rows are.
//
// NEVER SHORT WITHOUT SAYING SO. A book that can't be read, or a bank store
// that can't (supersede can't be told without it), keeps that account's
// imported rows out and says so in a note, as an institution that failed to
// sync gets one, never a quiet "none".

import type { Ctx } from '../containers';
import { getItems, type StoredItem } from '../storage';
import { rememberedAccountsReport } from '../last-known';
import { effectiveLinks, getLinks, resolveId, sameAccountIds, type Link } from '../link-core';
import { liveAccountIds } from '../links';
import { readStoredItem, vendorKey, StateUnreadableError, LOOKBACK_DAYS, type OlderTxn, type StoredTxn, type Txn } from '../transactions';
import { RECURRING_LOOKBACK_DAYS } from '../recurring';
import { supersede, type BankRow } from './match';
import { historyImportSummaryStore, importedTxnStore, type HistoryImportSummary, type ImportedTxn } from './store';

/** A linked account, as importing and reading name it. */
export type LinkedAccount = {
  account_id: string;
  item_id: string;
  institution_name: string;
  name: string;
  mask: string | null;
  type: string;
  currency: string | null;
};

/**
 * Every live linked account (on a connection still stored), by id, as the
 * loads last remembered it (lib/last-known.ts), and the Items whose record
 * couldn't be read. A display read: an unreadable record leaves its accounts
 * out, named, and storage failing throws.
 */
export async function liveLinkedAccounts(ctx: Ctx, items?: StoredItem[]): Promise<{ accounts: Map<string, LinkedAccount>; unreadable: string[] }> {
  const [stored, remembered] = await Promise.all([items ? Promise.resolve(items) : getItems(ctx), rememberedAccountsReport(ctx)]);
  const accounts = new Map<string, LinkedAccount>();
  for (const item of stored) {
    for (const a of remembered.byItem[item.item_id] ?? []) {
      accounts.set(a.account_id, {
        account_id: a.account_id,
        item_id: item.item_id,
        institution_name: item.institution_name,
        name: a.name,
        mask: a.mask,
        type: a.type,
        currency: a.currency,
      });
    }
  }
  const live = new Set(stored.map((i) => i.item_id));
  return { accounts, unreadable: remembered.unreadable.filter((id) => live.has(id)) };
}

/** The bank's rows as matching reads them: each with the id its account is
 *  known by now. */
export function bankRowsOf(txns: Iterable<StoredTxn>, links: Map<string, Link>): BankRow[] {
  const out: BankRow[] = [];
  for (const t of txns) {
    out.push({
      transaction_id: t.transaction_id,
      account_id: resolveId(t.account_id, links),
      date: t.date,
      amount: t.amount,
      currency: t.iso_currency_code ?? t.unofficial_currency_code ?? null,
      name: t.name,
      merchant_name: t.merchant_name,
      pending: t.pending,
    });
  }
  return out;
}

/** The earliest posted row of a connection: where the bank's window begins,
 *  as far as can be told. Null when it has none. */
export function earliestPosted(txns: Iterable<StoredTxn>): string | null {
  let first: string | null = null;
  for (const t of txns) if (!t.pending && (first === null || t.date < first)) first = t.date;
  return first;
}

/** The imports in the order they were made (by when, then by id), from their
 *  summaries; one whose summary can't be read comes last. Only the order of
 *  supersede depends on it (lib/history-import/match.ts). */
export function importOrder(summaries: { entries: Map<string, HistoryImportSummary>; unreadable: string[]; unrecognised: string[] }): string[] {
  const known = [...summaries.entries].sort(([a, x], [b, y]) => (x.imported_at < y.imported_at ? -1 : x.imported_at > y.imported_at ? 1 : a < b ? -1 : a > b ? 1 : 0));
  return [...known.map(([id]) => id), ...[...summaries.unreadable, ...summaries.unrecognised].sort()];
}

/** Which rows count (see the header): neither a duplicate nor superseded. */
export function countedRows(held: readonly ImportedTxn[], banks: readonly BankRow[], order: readonly string[]): { counted: ImportedTxn[]; superseded: Map<string, BankRow> } {
  const superseded = supersede(held, banks, order);
  return { counted: held.filter((r) => !r.same_as && !superseded.has(r.id)), superseded };
}

/** What every account with imported rows needs read, once: its rows under
 *  every id, its connection's bank rows, and where those begin. */
export type ImportedAccountRead = {
  account: LinkedAccount;
  /** Every id it has had, the current first. */
  ids: string[];
  held: ImportedTxn[];
  banks: BankRow[];
  bank_from: string | null;
};

export type ImportedRead = {
  accounts: ImportedAccountRead[];
  order: string[];
  summaries: Map<string, HistoryImportSummary>;
  /** Accounts whose imported rows can't be used, named, with why. */
  notes: string[];
  /** The current ids of those accounts. */
  flawed: Set<string>;
};

/**
 * Every live account's imported rows, with what is needed to tell which
 * count (see the header). `links` are the links that apply now (null when
 * they can't be read: then only rows filed under an account's current id are
 * found, and a note says the rest may be missing). `leftOut` are ids not to
 * read (hidden accounts, each of their ids). `only` narrows it to accounts
 * with these current ids. Reads only the books and the connections that
 * matter: nothing more than one read of the books when nothing was imported.
 */
export async function readImported(
  ctx: Ctx,
  opts: { items?: StoredItem[]; links: Map<string, Link> | null; leftOut?: ReadonlySet<string>; only?: ReadonlySet<string> } = { links: null }
): Promise<ImportedRead> {
  const books = await importedTxnStore.getAllReport(ctx);
  const empty: ImportedRead = { accounts: [], order: [], summaries: new Map(), notes: [], flawed: new Set() };
  if (books.entries.size === 0 && books.unreadable.length === 0 && books.unrecognised.length === 0) return empty;
  const items = opts.items ?? (await getItems(ctx));
  const links = opts.links ?? new Map<string, Link>();
  const [{ accounts: live }, summaries] = await Promise.all([liveLinkedAccounts(ctx, items), historyImportSummaryStore.getAllReport(ctx)]);
  const leftOut = opts.leftOut ?? new Set<string>();
  const wanted = (bookId: string): LinkedAccount | null => {
    const current = resolveId(bookId, links);
    const account = live.get(current);
    if (!account || leftOut.has(current) || leftOut.has(bookId)) return null;
    if (opts.only && !opts.only.has(current)) return null;
    return account;
  };

  const notes: string[] = [];
  const flawed = new Set<string>();
  for (const id of [...books.unreadable, ...books.unrecognised]) {
    const account = wanted(id);
    if (!account || flawed.has(account.account_id)) continue;
    flawed.add(account.account_id);
    notes.push(`${account.institution_name}: transactions imported for ${account.name} couldn't be read`);
  }
  const byAccount = new Map<string, ImportedTxn[]>();
  let unresolved = false;
  for (const [bookId, book] of books.entries) {
    const account = wanted(bookId);
    if (!account) {
      if (!opts.links && book.rows.length > 0) unresolved = true;
      continue;
    }
    if (flawed.has(account.account_id)) continue;
    const list = byAccount.get(account.account_id) ?? [];
    list.push(...book.rows);
    byAccount.set(account.account_id, list);
  }
  if (unresolved) notes.push("Imported transactions of accounts linked across a reconnect aren't shown while the account links can't be read");
  if (byAccount.size === 0) return { ...empty, notes, flawed };

  // The bank's rows of the connections holding these accounts, read once each.
  const itemIds = new Set([...byAccount.keys()].map((id) => live.get(id)!.item_id));
  const bankByItem = new Map<string, { rows: BankRow[]; from: string | null }>();
  const unreadableItems = new Set<string>();
  await Promise.all(
    items
      .filter((i) => itemIds.has(i.item_id))
      .map(async (item) => {
        try {
          const { txns } = await readStoredItem(ctx, item.item_id);
          const all = Object.values(txns);
          bankByItem.set(item.item_id, { rows: bankRowsOf(all, links), from: earliestPosted(all) });
        } catch (err) {
          if (!(err instanceof StateUnreadableError)) throw err;
          unreadableItems.add(item.item_id);
        }
      })
  );

  const accounts: ImportedAccountRead[] = [];
  for (const [id, held] of byAccount) {
    const account = live.get(id)!;
    if (unreadableItems.has(account.item_id)) {
      flawed.add(id);
      notes.push(`${account.institution_name}: transactions imported for ${account.name} aren't shown while the bank's own can't be read`);
      continue;
    }
    const bank = bankByItem.get(account.item_id) ?? { rows: [], from: null };
    const ids = sameAccountIds(id, links);
    accounts.push({ account, ids, held, banks: bank.rows.filter((b) => b.account_id === id), bank_from: bank.from });
  }
  return { accounts, order: importOrder(summaries), summaries: summaries.entries, notes, flawed };
}

const DAY_MS = 86_400_000;
const daysAgo = (n: number) => new Date(Date.now() - n * DAY_MS).toISOString().slice(0, 10);

/** One counted row as the Activity tab shows a transaction: on its account as
 *  it is known now, with the bank's display fields empty, its source said, and
 *  a vendor key as a bank row of its institution would have, so renaming the
 *  merchant covers it too. */
export function toDisplay(row: ImportedTxn, account: LinkedAccount, withAccountId: boolean): Txn {
  return {
    transaction_id: row.id,
    date: row.date,
    name: row.name,
    amount: row.amount,
    pending: false,
    account_name: account.name,
    account_type: account.type,
    institution_name: account.institution_name,
    category: row.category,
    iso_currency_code: row.currency,
    unofficial_currency_code: null,
    vendor_key: vendorKey({ merchant_entity_id: null, merchant_name: null, name: row.name, institution_name: account.institution_name }),
    logo_url: null,
    category_icon_url: null,
    subcategory: null,
    category_confidence: null,
    transaction_code: row.transaction_code ?? null,
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
    source: row.source,
    note: row.note,
    ...(withAccountId ? { account_id: account.account_id } : {}),
  };
}

/**
 * The counted imported rows of every live, unhidden linked account, as the
 * Activity tab shows transactions (lib/activity.ts): the last LOOKBACK_DAYS
 * of them (`txns`), and those before, back to RECURRING_LOOKBACK_DAYS, for
 * recurring detection (`older`), with a note for each account whose imported
 * rows can't be shown. `withAccountIds` puts each row's account on it, as the
 * read-only API wants.
 */
export async function importedForActivity(
  ctx: Ctx,
  opts: { items: StoredItem[]; links: Map<string, Link> | null; leftOut: ReadonlySet<string>; withAccountIds?: boolean }
): Promise<{ txns: Txn[]; older: OlderTxn[]; notes: string[] }> {
  const read = await readImported(ctx, { items: opts.items, links: opts.links, leftOut: opts.leftOut });
  const cutoff = daysAgo(LOOKBACK_DAYS);
  const since = daysAgo(RECURRING_LOOKBACK_DAYS);
  const txns: Txn[] = [];
  const older: OlderTxn[] = [];
  for (const a of read.accounts) {
    const { counted } = countedRows(a.held, a.banks, read.order);
    for (const row of counted) {
      if (row.date < since) continue;
      const t = toDisplay(row, a.account, !!opts.withAccountIds);
      if (row.date >= cutoff) txns.push(t);
      else
        older.push({
          transaction_id: t.transaction_id,
          date: t.date,
          name: t.name,
          amount: t.amount,
          account_name: t.account_name,
          account_type: t.account_type,
          institution_name: t.institution_name,
          category: t.category,
          subcategory: t.subcategory,
          iso_currency_code: t.iso_currency_code,
          unofficial_currency_code: null,
          transaction_code: t.transaction_code,
          vendor_key: t.vendor_key,
          logo_url: null,
          source: t.source,
        });
    }
  }
  return { txns, older, notes: read.notes };
}

/** What importing into one account reads first: every id it has had, its kept
 *  rows under them, its connection's bank rows and where they begin, and the
 *  imports in order, with their summaries. */
export type AccountContext = {
  ids: string[];
  held: ImportedTxn[];
  banks: BankRow[];
  bank_from: string | null;
  order: string[];
  summaries: Map<string, HistoryImportSummary>;
};

/**
 * The context of an import into `account` (see AccountContext), read
 * strictly: a book of the account that can't be read throws
 * (UnreadableEntriesError), and so does its connection's bank store
 * (StateUnreadableError), since a file matched against either read as empty
 * would duplicate what is there. `links` are the links that apply now.
 */
export async function readAccountContext(ctx: Ctx, account: LinkedAccount, links: Map<string, Link>): Promise<AccountContext> {
  const ids = sameAccountIds(account.account_id, links);
  const [books, summaries, item] = await Promise.all([
    importedTxnStore.getMany(ctx, ids),
    historyImportSummaryStore.getAllReport(ctx),
    readStoredItem(ctx, account.item_id),
  ]);
  const all = Object.values(item.txns);
  const mine = new Set(ids);
  return {
    ids,
    held: [...books.values()].flatMap((b) => b.rows),
    banks: bankRowsOf(all, links).filter((b) => b.account_id === account.account_id || mine.has(b.account_id)),
    bank_from: earliestPosted(all),
    order: importOrder(summaries),
    summaries: summaries.entries,
  };
}

/**
 * For sharing at the transactions level (lib/sharing.ts): each of these live
 * accounts' imported rows that count, dated `since` or later, read as a read
 * made on someone else's behalf (changing nothing), and the accounts whose
 * imported rows can't be read, which the share says of them rather than
 * showing them short. Strict about the links, as every read there is.
 */
export async function importedForShare(ctx: Ctx, accountIds: ReadonlySet<string>, since: string): Promise<{ rows: Map<string, ImportedTxn[]>; unreadable: Set<string> }> {
  const rows = new Map<string, ImportedTxn[]>();
  if (accountIds.size === 0) return { rows, unreadable: new Set() };
  const [links, live] = await Promise.all([getLinks(ctx), liveAccountIds(ctx, { strict: true, readOnly: true })]);
  const read = await readImported(ctx, { links: effectiveLinks(links, live), only: accountIds });
  for (const a of read.accounts) {
    const { counted } = countedRows(a.held, a.banks, read.order);
    rows.set(a.account.account_id, counted.filter((r) => r.date >= since));
  }
  return { rows, unreadable: read.flawed };
}
