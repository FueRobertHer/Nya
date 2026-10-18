// lib/history-import/read.ts
//
// Reading what was imported into LINKED accounts (#52), for everything that
// shows or counts transactions: the Activity tab and the read-only API (both
// through lib/activity.ts), the walk that extends the estimated history
// (lib/history-import/extend.ts), sharing (lib/sharing.ts) and the import
// sheet itself.
//
// WHICH ROWS COUNT. An imported row counts as a transaction of its account
// unless it is a duplicate standing for its twin (the person said it is a
// transaction already there, and that one still is) or a bank row now
// supersedes it (lib/history-import/match.ts settle): the bank's rows are the
// authority wherever they reach. Worked out on every read, against the bank's
// rows as stored (lib/transactions.ts), so nothing an undo or a re-link does
// can leave it stale: a duplicate whose bank row a re-link no longer brings
// counts again. One thing is kept: which bank row stood for which imported
// row, by the sync that changes that bank row, before it saves the change
// (lib/history-import/twins.ts), so a bank row the bank modifies keeps
// standing for the row it stood for, whatever its amount becomes (settle's
// `twins`, read here with the bank's rows: a connection's that can't be read
// keeps its accounts' imported rows out, said), and carried across a re-link
// by the content its bank row had. What the person said about a
// row (its category, an exclusion or an include, tags, a note) carries to the
// bank's row that stands for it (importedForActivity's `represents`), and so
// do its split and its place in a group (lib/split-rows.ts).
//
// WHOSE ROWS. A book is filed under the account id its rows were imported
// into, and an account's rows are those of every id it has had, by the links
// that apply now (lib/link-core.ts): an import survives a re-link once the
// person links the two. Only an account that is live (on a connection still
// stored) shows its imported rows; one whose institution was disconnected
// keeps them, for a re-link, until it is forgotten. An account that ended
// (#50, lib/lifecycle.ts) is live while its connection is stored, though its
// bank no longer returns it, as its bank's rows are still read; its imported
// rows dated from its end on are left out where its bank's are
// (importedForActivity's `endedFrom`). Hidden accounts' rows are left out
// where their bank rows are.
//
// NEVER SHORT WITHOUT SAYING SO. A book that can't be read, or a bank store
// that can't (supersede can't be told without it), keeps that account's
// imported rows out and says so in a note, as an institution that failed to
// sync gets one, never a quiet "none"; and so does a connection whose
// accounts can't be read, while books no live account claims could be its,
// and an end that can't be read, while a book no live account claims is
// filed under one of that account's ids: it may be an account that ended,
// live through that end. Either leaves the read `unresolved`, which the walk
// waits on rather than draw the chart without those rows.

import type { Ctx } from '../containers';
import { getItems, type StoredItem } from '../storage';
import { rememberedAccountsReport } from '../last-known';
import { effectiveLinks, getLinks, resolveId, sameAccountIds, type Link } from '../link-core';
import { directoryIds, liveAccountIds } from '../links';
import { bankRowDisplay, bankRowOlder, readStoredItem, vendorKey, StateUnreadableError, LOOKBACK_DAYS, type OlderTxn, type StoredTxn, type Txn } from '../transactions';
import type { CarriedAnnotation } from '../txn-annotations';
import { restoredAccountsStore, restoredTxnStore, restoredId, type RestoredAccount } from '../user-restore/store';
import {
  bookIdsOf,
  heldOf,
  heldWithRestored,
  linkedTo,
  oldTwins,
  restoreCovers,
  restoreOrder,
  withRestoredRows,
  type HeldTxn,
  type RestoredContext,
  type RestoredForAccount,
} from '../user-restore/restored';
import { RECURRING_LOOKBACK_DAYS } from '../recurring';
import { endDays, endOf, lifecycleStore, type LifecycleView } from '../lifecycle';
import { UnreadableEntriesError, type MapStore } from '../repo';
import { settle, type BankRow, type Settled } from './match';
import type { CoveredAccount, DayRange } from './coverage';
import { historyImportSummaryStore, importedTwinsStore, importedTxnStore, type HistoryImportSummary, type ImportedTwins, type ImportedTxn } from './store';

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
 * couldn't be read. With them, each account that ended (lib/lifecycle.ts) on
 * a connection still stored that the loads no longer remember, a bank having
 * stopped returning it once it closed: named and kinded as its end recorded
 * it, since its rows before its end still count (WHOSE ROWS). A record
 * that can't be read leaves its accounts out and is named, so a reader never
 * takes their rows for no live account's (NEVER SHORT WITHOUT SAYING SO): an
 * Item's (`unreadable`), and an end that can't be read or that a later
 * release wrote (`endsUnread`, by the id it is stored under), whose account
 * may be one that ended this would list. Storage failing throws.
 */
export async function liveLinkedAccounts(
  ctx: Ctx,
  items?: StoredItem[]
): Promise<{ accounts: Map<string, LinkedAccount>; unreadable: string[]; endsUnread: { unreadable: string[]; unrecognised: string[] } }> {
  const [stored, remembered, ends] = await Promise.all([items ? Promise.resolve(items) : getItems(ctx), rememberedAccountsReport(ctx), lifecycleStore.getAllReport(ctx)]);
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
  const byItem = new Map(stored.map((i) => [i.item_id, i]));
  for (const [id, entry] of ends.entries) {
    const item = entry.item_id === null ? undefined : byItem.get(entry.item_id);
    if (!item || accounts.has(id) || endOf(entry.lifecycle) === null) continue;
    accounts.set(id, {
      account_id: id,
      item_id: item.item_id,
      institution_name: item.institution_name,
      name: entry.label.name,
      mask: entry.label.mask,
      type: entry.type ?? 'other',
      currency: entry.currency ?? null,
    });
  }
  const live = new Set(stored.map((i) => i.item_id));
  return { accounts, unreadable: remembered.unreadable.filter((id) => live.has(id)), endsUnread: { unreadable: ends.unreadable, unrecognised: ends.unrecognised } };
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

/** The periods imports cover, by import, from their summaries
 *  (lib/history-import/match.ts settle reads them for its edge rule). */
export function coversOf(summaries: ReadonlyMap<string, HistoryImportSummary>): Map<string, { from: string; to: string }> {
  return new Map([...summaries].map(([id, s]) => [id, { from: s.covers.from, to: s.covers.to }]));
}

/** Which rows count (see the header), and what each one that doesn't is.
 *  `pending` for what is shown: a pending bank row stands in for a row like
 *  it until it posts, which the estimated history never takes. `twins`, the
 *  pairs kept once made at the account's connection (twinsOf), which every
 *  reader passes, so they all count the same rows. */
export function countedRows<T extends ImportedTxn>(
  held: readonly T[],
  banks: readonly BankRow[],
  order: readonly string[],
  opts: { bankFrom: string | null; covers?: ReadonlyMap<string, { from: string; to: string }>; pending?: boolean; twins: ReadonlyMap<string, string> }
): Settled<T> {
  return settle(held, banks, order, opts);
}

/** A connection's pairs kept once made (lib/history-import/store.ts
 *  ImportedTwins), as settle reads them. */
export const twinsOf = (entry: ImportedTwins | null | undefined): Map<string, string> => new Map(Object.entries(entry?.twins ?? {}));

/** What every account with imported rows needs read, once: its rows under
 *  every id, its connection's bank rows, where those begin, and which of
 *  them were kept as standing for which of its rows. */
export type ImportedAccountRead = {
  account: LinkedAccount;
  /** Every id it has had, the current first. */
  ids: string[];
  /** Its rows imported from files and, once linked to an account a restore
   *  brought back, that account's bank rows (lib/user-restore/restored.ts
   *  HeldTxn, paired as the old copy paired them). */
  held: HeldTxn[];
  banks: BankRow[];
  bank_from: string | null;
  twins: Map<string, string>;
};

export type ImportedRead = {
  accounts: ImportedAccountRead[];
  order: string[];
  summaries: Map<string, HistoryImportSummary>;
  /** The periods the imports cover (coversOf). */
  covers: Map<string, { from: string; to: string }>;
  /** Accounts whose imported rows can't be used, named, with why. */
  notes: string[];
  /** The current ids of those accounts. */
  flawed: Set<string>;
  /** Imported rows may be missing for want of something that can't be read
   *  without saying whose: the links, a connection's accounts, or an
   *  account's end (see NEVER SHORT WITHOUT SAYING SO). */
  unresolved: boolean;
  /** Imports whose summary can't be read: their order and period aren't known. */
  summariesUnreadable: string[];
};

/** Some entries of a map store, named as getAllReport names every one: the
 *  readable ones in id order, and the ids of those that can't be used,
 *  rather than thrown. A deployment problem is thrown, as by every read. */
async function entriesReport<T>(store: MapStore<T>, ctx: Ctx, ids: Iterable<string>): Promise<{ entries: Map<string, T>; unreadable: string[]; unrecognised: string[] }> {
  const wanted = [...new Set(ids)].sort();
  try {
    return { entries: await store.getMany(ctx, wanted), unreadable: [], unrecognised: [] };
  } catch (err) {
    if (!(err instanceof UnreadableEntriesError)) throw err;
    const bad = new Set([...err.unreadable, ...err.unrecognised]);
    return { entries: await store.getMany(ctx, wanted.filter((id) => !bad.has(id))), unreadable: err.unreadable, unrecognised: err.unrecognised };
  }
}

/**
 * Every live account's imported rows, with what is needed to tell which
 * count (see the header). `links` are the links that apply now (null when
 * they can't be read: then only rows filed under an account's current id are
 * found, and a note says the rest may be missing). `leftOut` are ids not to
 * read (hidden accounts, each of their ids). `only` narrows it to accounts
 * with these current ids. Reads only the books and the connections that
 * matter: nothing more than one read of the books, and one of the accounts
 * a restore brought back, when nothing was imported or brought back.
 * `bookIds` reads only the books under those ids (every id of the accounts
 * wanted, lib/link-core.ts sameAccountIds), and with them only the summaries
 * of the imports their rows came from and the pairs kept at the connections
 * they are matched at: for a reader of a few accounts, whose rows nothing
 * else changes (the sync keeping its connection's pairs,
 * lib/history-import/twins.ts). What can't be read among them is named as
 * when every one is read; nothing else is read to be named.
 *
 * An account a restore brought back that is linked to a live one gives that
 * account its bank rows, paired with its file rows as the old copy paired
 * them (lib/user-restore/restored.ts): held among them, ranked first.
 * `restored: false` leaves them out, for the walk, which draws the balance
 * history of accounts that never had any: a restored account's is restored.
 */
export async function readImported(
  ctx: Ctx,
  opts: {
    items?: StoredItem[];
    links: Map<string, Link> | null;
    leftOut?: ReadonlySet<string>;
    only?: ReadonlySet<string>;
    /** Each connection's stored rows, already read (by the sync that wrote
     *  them, say), so they aren't read twice; null for one that couldn't be. */
    bankStates?: ReadonlyMap<string, Record<string, StoredTxn> | null>;
    bookIds?: Iterable<string>;
    restored?: boolean;
  } = { links: null }
): Promise<ImportedRead> {
  const bookIds = opts.bookIds ? [...opts.bookIds] : null;
  const [books, restoredReport] = await Promise.all([
    bookIds ? entriesReport(importedTxnStore, ctx, bookIds) : importedTxnStore.getAllReport(ctx),
    opts.restored === false
      ? Promise.resolve({ entries: new Map<string, RestoredAccount>(), unreadable: [] as string[], unrecognised: [] as string[] })
      : bookIds
        ? entriesReport(restoredAccountsStore, ctx, bookIds)
        : restoredAccountsStore.getAllReport(ctx),
  ]);
  const empty: ImportedRead = { accounts: [], order: [], summaries: new Map(), covers: new Map(), notes: [], flawed: new Set(), unresolved: false, summariesUnreadable: [] };
  const restoredUnread = [...restoredReport.unreadable, ...restoredReport.unrecognised];
  const nothing = books.entries.size === 0 && books.unreadable.length === 0 && books.unrecognised.length === 0;
  if (nothing && restoredReport.entries.size === 0 && restoredUnread.length === 0) return empty;
  const items = opts.items ?? (await getItems(ctx));
  const links = opts.links ?? new Map<string, Link>();
  const [{ accounts: live, unreadable: unknownItems, endsUnread }, summaries, listed] = await Promise.all([
    liveLinkedAccounts(ctx, items),
    bookIds
      ? entriesReport(historyImportSummaryStore, ctx, [...books.entries.values()].flatMap((b) => b.rows.map((r) => r.import_id)))
      : historyImportSummaryStore.getAllReport(ctx),
    restoredReport.entries.size > 0 ? directoryIds(ctx) : Promise.resolve(new Set<string>()),
  ]);
  const unreadEnds = new Set([...endsUnread.unreadable, ...endsUnread.unrecognised]);
  const leftOut = opts.leftOut ?? new Set<string>();
  const summariesUnreadable = [...summaries.unreadable, ...summaries.unrecognised];
  const wanted = (bookId: string): LinkedAccount | null => {
    const current = resolveId(bookId, links);
    const account = live.get(current);
    if (!account || leftOut.has(current) || leftOut.has(bookId)) return null;
    if (opts.only && !opts.only.has(current)) return null;
    return account;
  };

  let unlinked = false;
  let unowned = false;
  let unended = false;
  // A book no live account claims, which may still be one's, as far as can
  // be told: with the links unread, filed under its earlier id; with a
  // connection's accounts unread, one of those; with an end unread under one
  // of the ids its account has had, an account that ended its bank no longer
  // returns, live through that end (liveLinkedAccounts), unless it is one not
  // read here either way (hidden, or not among `only`).
  const unclaimed = (bookId: string) => {
    const current = resolveId(bookId, links);
    if (live.has(current)) return;
    if (!opts.links) unlinked = true;
    if (unknownItems.length > 0) unowned = true;
    const readHere = !leftOut.has(current) && !leftOut.has(bookId) && (!opts.only || opts.only.has(current));
    if (readHere && sameAccountIds(current, links).some((id) => unreadEnds.has(id))) unended = true;
  };

  const notes: string[] = [];
  const flawed = new Set<string>();
  for (const id of [...books.unreadable, ...books.unrecognised]) {
    const account = wanted(id);
    if (!account) {
      // Whether it holds rows can't be told: it may.
      unclaimed(id);
      continue;
    }
    if (flawed.has(account.account_id)) continue;
    flawed.add(account.account_id);
    notes.push(`${account.institution_name}: transactions imported for ${account.name} couldn't be read`);
  }
  const byAccount = new Map<string, ImportedTxn[]>();
  for (const [bookId, book] of books.entries) {
    const account = wanted(bookId);
    if (!account) {
      if (book.rows.length > 0) unclaimed(bookId);
      continue;
    }
    if (flawed.has(account.account_id)) continue;
    const list = byAccount.get(account.account_id) ?? [];
    list.push(...book.rows);
    byAccount.set(account.account_id, list);
  }

  // The accounts a restore brought back that are linked to a live account,
  // while their directory entry exists (lib/user-restore/restored.ts), and
  // their books. One whose record can't be read may be one of them.
  const restoredHere = new Map<string, { current: string; a: RestoredAccount }>();
  for (const [id, a] of restoredReport.entries) {
    if (!listed.has(id) || !linkedTo(id, links, live)) continue;
    const account = wanted(id);
    if (account && !flawed.has(account.account_id)) restoredHere.set(id, { current: account.account_id, a });
  }
  const unrestored = restoredUnread.length > 0;
  if (unrestored) notes.push("Transactions brought back from your download aren't shown while what was brought back can't be read");
  const byRestored = new Map<string, HeldTxn[]>();
  if (restoredHere.size > 0) {
    const restoredBooks = await entriesReport(restoredTxnStore, ctx, [...restoredHere].flatMap(([id, { a }]) => bookIdsOf(id, a)));
    for (const bookId of [...restoredBooks.unreadable, ...restoredBooks.unrecognised]) {
      const here = restoredHere.get(bookId.slice(0, bookId.lastIndexOf('.')));
      if (!here || flawed.has(here.current)) continue;
      flawed.add(here.current);
      const account = live.get(here.current)!;
      notes.push(`${account.institution_name}: transactions brought back from your download for ${account.name} couldn't be read`);
    }
    for (const book of restoredBooks.entries.values()) {
      const here = restoredHere.get(book.account_id);
      if (!here || flawed.has(here.current)) continue;
      const list = byRestored.get(here.current) ?? [];
      for (const r of book.rows) list.push(heldOf(r));
      byRestored.set(here.current, list);
    }
  }
  if (unlinked) notes.push("Imported transactions of accounts linked across a reconnect aren't shown while the account links can't be read");
  if (unowned) {
    const names = items.filter((i) => unknownItems.includes(i.item_id)).map((i) => i.institution_name);
    notes.push(`${[...new Set(names)].join(', ')}: transactions imported for its accounts aren't shown while its accounts can't be read`);
  }
  if (unended) notes.push("Transactions imported for an account whose closure can't be read aren't shown until it can be");
  const unresolved = unlinked || unowned || unended || unrestored;
  const heldAccounts = new Set([...byAccount.keys(), ...byRestored.keys()].filter((id) => !flawed.has(id)));
  if (heldAccounts.size === 0) return { ...empty, notes, flawed, unresolved, summariesUnreadable };

  // The bank's rows of the connections holding these accounts, read once each
  // (or as the caller already read them), and which of them were kept as
  // standing for which imported rows: a connection's whose pairs can't be
  // read keeps its accounts' imported rows out, said, as when its own rows
  // can't be, never counted as if none were kept. And the pairs the old copy
  // kept at the connections the restored accounts were on.
  const itemIds = new Set([...heldAccounts].map((id) => live.get(id)!.item_id));
  const oldItems = new Set([...restoredHere.values()].filter(({ current }) => heldAccounts.has(current)).map(({ a }) => a.item_id));
  const bankByItem = new Map<string, { rows: BankRow[]; from: string | null }>();
  const unreadableItems = new Set<string>();
  const use = (item_id: string, txns: Record<string, StoredTxn>) => {
    const all = Object.values(txns);
    bankByItem.set(item_id, { rows: bankRowsOf(all, links), from: earliestPosted(all) });
  };
  const [, twins] = await Promise.all([
    Promise.all(
      items
        .filter((i) => itemIds.has(i.item_id))
        .map(async (item) => {
          const given = opts.bankStates?.get(item.item_id);
          if (given === null) return void unreadableItems.add(item.item_id);
          if (given) return use(item.item_id, given);
          try {
            use(item.item_id, (await readStoredItem(ctx, item.item_id)).txns);
          } catch (err) {
            if (!(err instanceof StateUnreadableError)) throw err;
            unreadableItems.add(item.item_id);
          }
        })
    ),
    bookIds ? entriesReport(importedTwinsStore, ctx, [...itemIds, ...oldItems]) : importedTwinsStore.getAllReport(ctx),
  ]);
  const twinsUnread = new Set([...twins.unreadable, ...twins.unrecognised]);
  const fileOrder = importOrder(summaries);
  const fileCovers = coversOf(summaries.entries);
  const importedAt = new Map([...summaries.entries].map(([id, sm]) => [id, sm.imported_at]));
  // Where each old connection's rows began, from every account it had here.
  const oldFrom = new Map<string, string>();
  for (const a of restoredReport.entries.values()) {
    if (a.rows && (!oldFrom.has(a.item_id) || a.rows.first < oldFrom.get(a.item_id)!)) oldFrom.set(a.item_id, a.rows.first);
  }

  const accounts: ImportedAccountRead[] = [];
  for (const id of heldAccounts) {
    const account = live.get(id)!;
    if (unreadableItems.has(account.item_id)) {
      flawed.add(id);
      notes.push(`${account.institution_name}: transactions imported for ${account.name} aren't shown while the bank's own can't be read`);
      continue;
    }
    const mine = [...restoredHere.values()].filter(({ current }) => current === id).map(({ a }) => a);
    if (twinsUnread.has(account.item_id) || mine.some((a) => twinsUnread.has(a.item_id))) {
      flawed.add(id);
      notes.push(`${account.institution_name}: transactions imported for ${account.name} aren't shown while which of the bank's own stand for them can't be read`);
      continue;
    }
    const bank = bankByItem.get(account.item_id) ?? { rows: [], from: null };
    const ids = sameAccountIds(id, links);
    const restoredRows = byRestored.get(id) ?? [];
    let restored: RestoredForAccount | null = null;
    if (restoredRows.length > 0) {
      const here = new Set(restoredRows.map((r) => r.id));
      const pairs = new Map<string, string>();
      for (const item_id of new Set(mine.map((a) => a.item_id))) for (const [row, r] of oldTwins(twins.entries.get(item_id), here)) pairs.set(row, r);
      const froms = mine.map((a) => oldFrom.get(a.item_id)).filter((d): d is string => d !== undefined);
      restored = {
        rows: restoredRows,
        twins: pairs,
        bankFrom: froms.length > 0 ? froms.reduce((x, y) => (y < x ? y : x)) : null,
        before: mine.map((a) => a.restored_at).reduce((x, y) => (y < x ? y : x)),
      };
    }
    const held = heldWithRestored(byAccount.get(id) ?? [], restored, fileOrder, { covers: fileCovers, importedAt });
    accounts.push({ account, ids, held, banks: bank.rows.filter((b) => b.account_id === id), bank_from: bank.from, twins: twinsOf(twins.entries.get(account.item_id)) });
  }
  const restores = [...restoredReport.entries.values()];
  return {
    accounts,
    order: [...restoreOrder(restores), ...fileOrder],
    summaries: summaries.entries,
    covers: new Map([...restoreCovers(restores), ...fileCovers]),
    notes,
    flawed,
    unresolved,
    summariesUnreadable,
  };
}

const DAY_MS = 86_400_000;
const daysAgo = (n: number) => new Date(Date.now() - n * DAY_MS).toISOString().slice(0, 10);

/** One counted row as the Activity tab shows a transaction: on its account as
 *  it is known now, with the bank's display fields empty, its source said, and
 *  a vendor key as a bank row of its institution would have, so renaming the
 *  merchant covers it too. Its account rides along, never sent, for a rule's
 *  account condition (`account_ref`, lib/txn-layers.ts), as a bank row's
 *  does. */
export function toDisplay(row: HeldTxn, account: LinkedAccount, withAccountId: boolean, carry?: CarriedForRows): Txn {
  if (row.restored) return restoredDisplay(row, row.restored, account, withAccountId, carry);
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
    account_ref: account.account_id,
  };
}

/** What was carried across a re-link to bank rows by their content
 *  (lib/overrides.ts, lib/txn-annotations.ts), as the bank's part of the
 *  Activity tab reads it: put on a restored row as on the bank row it was. */
export type CarriedForRows = { categories?: Map<string, string>; excluded?: Set<string>; annotations?: Map<string, CarriedAnnotation> };

/** The bank's row a restore brought back, shown on its linked account as
 *  the bank's part shows a bank row (lib/transactions.ts bankRowDisplay),
 *  under the id everything said about it is kept by; the pending row it
 *  replaced named by that row's restored id, as its approval is
 *  (lib/review-layer.ts). */
function restoredDisplay(row: HeldTxn, bank: StoredTxn, account: LinkedAccount, withAccountId: boolean, carry?: CarriedForRows): Txn {
  const t = bankRowDisplay(
    { ...bank, account_id: account.account_id },
    {
      account_name: account.name,
      account_type: account.type,
      carried: carry?.categories,
      carriedExclusions: carry?.excluded,
      carriedAnnotations: carry?.annotations,
      withAccountIds: withAccountId,
    }
  );
  t.transaction_id = row.id;
  if (t.pending_from !== undefined) {
    try {
      t.pending_from = restoredId(t.pending_from);
    } catch {
      delete t.pending_from;
    }
  }
  return t;
}

/**
 * The counted imported rows of every live, unhidden linked account, as the
 * Activity tab shows transactions (lib/activity.ts): the last LOOKBACK_DAYS
 * of them (`txns`), and those before, back to RECURRING_LOOKBACK_DAYS, for
 * recurring detection (`older`), with a note for each account whose imported
 * rows can't be shown. `since` reads every one from that day on as `txns`
 * instead, and none before, as the bank's part reads its rows for a report
 * on an earlier period (lib/transactions.ts DisplayInputs). `withAccountIds` puts each row's account on it, as the
 * read-only API wants. `endedFrom`, each id of each account that ended
 * (lib/lifecycle.ts endDays) to the day it stops counting, leaves out its
 * rows dated on or after it, as the bank's own are (lib/transactions.ts
 * displayRows): absent, for a reader that keeps them (lib/activity.ts
 * keepEnded), every row is given. `represents` names, for each bank row standing for
 * imported rows (one that superseded them, or that they are duplicates of),
 * those rows, earlier imports first: what the person said about them carries
 * to it. `bankStates` are the connections' rows as the caller read them.
 * `first` is the day of the earliest of these rows, of any date (before
 * `since` too): where the transactions in Nya begin for budget rollover
 * (lib/budget-month.ts), as the bank's own oldest stored row is.
 * `changed` names, by the bank row's id, the amount of the imported row it
 * stands for when the two differ: a pair kept once made whose bank row the
 * bank changed since (lib/history-import/match.ts KEPT ONCE MADE), which
 * the Activity tab says.
 */
export async function importedForActivity(
  ctx: Ctx,
  opts: {
    items: StoredItem[];
    links: Map<string, Link> | null;
    leftOut: ReadonlySet<string>;
    withAccountIds?: boolean;
    bankStates?: ReadonlyMap<string, Record<string, StoredTxn> | null>;
    since?: string;
    endedFrom?: ReadonlyMap<string, string>;
    /** What was carried across a re-link, for restored rows (toDisplay). */
    carry?: CarriedForRows;
  }
): Promise<{ txns: Txn[]; older: OlderTxn[]; notes: string[]; represents: Map<string, string[]>; first: string | null; changed: Map<string, number> }> {
  const read = await readImported(ctx, { items: opts.items, links: opts.links, leftOut: opts.leftOut, bankStates: opts.bankStates });
  let first: string | null = null;
  const changed = new Map<string, number>();
  const cutoff = opts.since ?? daysAgo(LOOKBACK_DAYS);
  const since = opts.since ?? daysAgo(RECURRING_LOOKBACK_DAYS);
  const txns: Txn[] = [];
  const older: OlderTxn[] = [];
  const represents = new Map<string, string[]>();
  for (const a of read.accounts) {
    const settled = countedRows(a.held, a.banks, read.order, { bankFrom: a.bank_from, covers: read.covers, pending: true, twins: a.twins });
    for (const [rowId, stand] of standsFor(settled)) {
      const list = represents.get(stand) ?? [];
      list.push(rowId);
      represents.set(stand, list);
    }
    // A pair whose bank row says another amount now than the imported row
    // (only a pair kept once made can: the rule pairs equal amounts).
    const amountOf = new Map(a.held.map((r) => [r.id, r.amount]));
    const paired = [...settled.superseded, ...[...settled.standing].flatMap(([id, st]) => ('bank' in st ? [[id, st.bank] as const] : []))];
    for (const [rowId, bank] of paired) {
      const was = amountOf.get(rowId);
      if (was !== undefined && Math.round(was * 1000) !== Math.round(bank.amount * 1000) && !changed.has(bank.transaction_id)) changed.set(bank.transaction_id, was);
    }
    const end = opts.endedFrom?.get(a.account.account_id);
    for (const row of settled.counted) {
      if (end !== undefined && row.date >= end) continue;
      if (first === null || row.date < first) first = row.date;
      if (row.date < since) continue;
      const t = toDisplay(row, a.account, !!opts.withAccountIds, opts.carry);
      if (row.date >= cutoff) txns.push(t);
      else if (row.restored)
        older.push({
          ...bankRowOlder(
            { ...row.restored, account_id: a.account.account_id },
            { account_name: a.account.name, account_type: a.account.type, carried: opts.carry?.categories, carriedExclusions: opts.carry?.excluded, carriedAnnotations: opts.carry?.annotations }
          ),
          transaction_id: row.id,
        });
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
          account_ref: a.account.account_id,
        });
    }
  }
  // Each bank row's, earlier imports first: what was said about the earliest
  // decides what carries where two say different things (lib/activity.ts).
  const rank = new Map(read.order.map((id, i) => [id, i]));
  const importOf = new Map(read.accounts.flatMap((a) => a.held.map((r) => [r.id, r.import_id] as const)));
  const at = (rowId: string) => rank.get(importOf.get(rowId) ?? '') ?? Number.MAX_SAFE_INTEGER;
  for (const list of represents.values()) list.sort((x, y) => at(x) - at(y));
  return { txns, older, notes: read.notes, represents, first, changed };
}

/**
 * For a report on a period (lib/report/read.ts): the days the files imported
 * into each account cover, by the id the account is known by now (following
 * `links`), each import counted only where it holds every transaction of its
 * period: none of its lines went unread, or the person said those lines
 * aren't transactions (`whole`), as the estimated history counts one
 * (lib/history-import/extend.ts). LENIENT, for display: an import whose
 * summary can't be read covers nothing here, so a report says no less than
 * it would without it.
 */
export async function importedCoverage(ctx: Ctx, links: ReadonlyMap<string, Pick<Link, 'to'>>): Promise<Map<string, { from: string; to: string }[]>> {
  const summaries = await historyImportSummaryStore.getAllReport(ctx);
  const out = new Map<string, { from: string; to: string }[]>();
  for (const s of summaries.entries.values()) {
    if (s.counts.unreadable > 0 && !s.covers.whole) continue;
    const id = resolveId(s.account_id, links);
    out.set(id, [...(out.get(id) ?? []), { from: s.covers.from, to: s.covers.to }]);
  }
  return out;
}

/**
 * A connection's bank accounts and cards, for what the files imported into
 * them cover (lib/history-import/coverage.ts): as it last reported them
 * (`reported`, lib/last-known.ts), and each that ended that it no longer
 * reports (a bank stops returning a closed account), as its end names it,
 * under its current id; never one `leftOut` (hidden). Each with what its
 * files cover (`covered`, importedCoverage) and the day it stopped counting,
 * when it ended (lib/lifecycle.ts), up to which it needs them. For a
 * report's gaps (lib/report/read.ts) and the months a rollover counts
 * (lib/budget-month.ts) alike.
 */
export function coveredAccountsOf(
  item_id: string,
  reported: readonly { account_id: string; name: string; type: string | null }[],
  lifecycle: LifecycleView,
  covered: ReadonlyMap<string, readonly DayRange[]>,
  leftOut: ReadonlySet<string>
): (CoveredAccount & { id: string; name: string })[] {
  const roots = new Set(reported.map((a) => lifecycle.rootOf.get(a.account_id) ?? a.account_id));
  const endedThere = [...lifecycle.accounts].flatMap(([root, { entry }]) =>
    entry.item_id === item_id && endOf(entry.lifecycle) !== null && !roots.has(root) ? [{ id: root, name: entry.label.name, type: entry.type }] : []
  );
  const ends = endDays(lifecycle);
  return [...reported.map((a) => ({ id: a.account_id, name: a.name, type: a.type })), ...endedThere]
    .filter((a) => (a.type === 'depository' || a.type === 'credit') && !leftOut.has(a.id))
    .map((a) => ({ id: a.id, name: a.name, covers: covered.get(a.id) ?? [], end: ends.get(a.id) ?? null }));
}

/**
 * The bank's row each imported row that doesn't count stands for, by the
 * bank row's transaction id: the row that superseded it, the one it is a
 * duplicate of, or (a duplicate of an earlier import's row) whatever stands
 * for that one. A row standing for a counted imported row, or for nothing
 * found, is left out.
 */
export function standsFor(settled: Settled<ImportedTxn>): Map<string, string> {
  const direct = new Map<string, string>();
  for (const [id, b] of settled.superseded) direct.set(id, b.transaction_id);
  for (const [id, b] of settled.pendingStood) direct.set(id, b.transaction_id);
  for (const [id, st] of settled.standing) if ('bank' in st) direct.set(id, st.bank.transaction_id);
  // A bank row a restore brought back that counts stands for what it stood
  // for in the old copy, as the bank row it was (lib/user-restore/restored.ts).
  const restoredCounting = new Set(settled.counted.filter((r) => (r as HeldTxn).restored !== undefined).map((r) => r.id));
  const out = new Map(direct);
  for (const [id, st] of settled.standing) {
    if (!('row' in st)) continue;
    // Followed through earlier imports' rows: each names an earlier one, so
    // the chain ends.
    let at: string | undefined = st.row;
    for (let hops = 0; at !== undefined && hops < 1000; hops++) {
      const bank = direct.get(at) ?? (restoredCounting.has(at) ? at : undefined);
      if (bank) {
        out.set(id, bank);
        break;
      }
      const next = settled.standing.get(at);
      at = next && 'row' in next ? next.row : undefined;
    }
  }
  return out;
}

/** What importing into one account reads first: every id it has had, its kept
 *  rows under them, its connection's bank rows and where they begin, which of
 *  those were kept as standing for which kept row, the pending row each
 *  posted one replaced, and the imports in order, with their summaries. */
export type AccountContext = {
  ids: string[];
  /** Its kept rows, and the bank rows of accounts a restore brought back
   *  that are linked to it, paired as the old copy paired them
   *  (lib/user-restore/restored.ts): what a new file is matched against. */
  held: HeldTxn[];
  banks: BankRow[];
  bank_from: string | null;
  twins: Map<string, string>;
  /** Each posted bank row's pending one it replaced (Plaid's
   *  pending_transaction_id), by the posted row's id: whose approval in the
   *  review queue is the posted row's own (lib/review-layer.ts approvalFor). */
  pending_from: Map<string, string>;
  /** The connection's older transactions may still be arriving: Plaid said
   *  its first pull is done and its full history isn't yet. */
  history_pending: boolean;
  order: string[];
  summaries: Map<string, HistoryImportSummary>;
  covers: Map<string, { from: string; to: string }>;
  /** With rows a restore brought back: what pairs the books' rows with
   *  them, for the commit, which reads the books again (withRestoredRows). */
  restored: RestoredContext | null;
};

/**
 * The context of an import into `account` (see AccountContext), read
 * strictly: a book of the account that can't be read throws
 * (UnreadableEntriesError), and so does its connection's bank store
 * (StateUnreadableError) or its pairs kept once made, since a file matched
 * against any of them read as empty would duplicate what is there; and so
 * does a record or a book of an account a restore brought back, or the old
 * copy's pairs, for the same reason. `links` are the links that apply now.
 */
export async function readAccountContext(ctx: Ctx, account: LinkedAccount, links: Map<string, Link>): Promise<AccountContext> {
  const ids = sameAccountIds(account.account_id, links);
  const [books, summaries, item, twins, restoredAll] = await Promise.all([
    importedTxnStore.getMany(ctx, ids),
    historyImportSummaryStore.getAllReport(ctx),
    readStoredItem(ctx, account.item_id),
    importedTwinsStore.get(ctx, account.item_id),
    restoredAccountsStore.getAll(ctx),
  ]);
  const all = Object.values(item.txns);
  const mine = new Set(ids);
  const banks = bankRowsOf(all, links).filter((b) => b.account_id === account.account_id || mine.has(b.account_id));
  const theirs = new Set(banks.map((b) => b.transaction_id));
  const fileOrder = importOrder(summaries);
  const fileCovers = coversOf(summaries.entries);
  const fileRows = [...books.values()].flatMap((b) => b.rows);
  // The accounts a restore brought back that are linked to this one, while
  // their directory entry exists (lib/user-restore/restored.ts).
  let restored: RestoredContext | null = null;
  const linked = [...restoredAll].filter(([id]) => id !== account.account_id && mine.has(id));
  if (linked.length > 0) {
    const listed = await directoryIds(ctx);
    const here = linked.filter(([id]) => listed.has(id));
    if (here.length > 0) {
      const oldItems = [...new Set(here.map(([, a]) => a.item_id))];
      const [restoredBooks, kept] = await Promise.all([
        restoredTxnStore.getMany(ctx, here.flatMap(([id, a]) => bookIdsOf(id, a))),
        importedTwinsStore.getMany(ctx, oldItems),
      ]);
      const rows = [...restoredBooks.values()].flatMap((b) => b.rows.map(heldOf));
      if (rows.length > 0) {
        const ids = new Set(rows.map((r) => r.id));
        const pairs = new Map<string, string>();
        for (const item_id of oldItems) for (const [row, r] of oldTwins(kept.get(item_id), ids)) pairs.set(row, r);
        const froms = [...restoredAll.values()].filter((a) => oldItems.includes(a.item_id) && a.rows).map((a) => a.rows!.first);
        restored = {
          account: {
            rows,
            twins: pairs,
            bankFrom: froms.length > 0 ? froms.reduce((x, y) => (y < x ? y : x)) : null,
            before: here.map(([, a]) => a.restored_at).reduce((x, y) => (y < x ? y : x)),
          },
          order: fileOrder,
          covers: fileCovers,
          importedAt: new Map([...summaries.entries].map(([id, sm]) => [id, sm.imported_at])),
        };
      }
    }
  }
  const restores = [...restoredAll.values()];
  return {
    ids,
    held: withRestoredRows(fileRows, restored),
    banks,
    bank_from: earliestPosted(all),
    twins: twinsOf(twins),
    pending_from: new Map(all.flatMap((t) => (!t.pending && t.pending_transaction_id && theirs.has(t.transaction_id) ? [[t.transaction_id, t.pending_transaction_id] as const] : []))),
    history_pending: item.history_pending === true,
    order: [...restoreOrder(restores), ...fileOrder],
    summaries: summaries.entries,
    covers: new Map([...restoreCovers(restores), ...fileCovers]),
    restored,
  };
}

/**
 * For sharing at the transactions level (lib/sharing.ts): each of these live
 * accounts' imported rows that count, as shown (a pending bank row standing
 * in for one), dated `since` or later, read as a read made on someone else's
 * behalf (changing nothing), and the accounts whose imported rows can't be
 * read, which the share says of them rather than showing them short. Strict
 * about the links, as every read there is.
 */
export async function importedForShare(ctx: Ctx, accountIds: ReadonlySet<string>, since: string): Promise<{ rows: Map<string, HeldTxn[]>; unreadable: Set<string> }> {
  const rows = new Map<string, HeldTxn[]>();
  if (accountIds.size === 0) return { rows, unreadable: new Set() };
  const [links, live] = await Promise.all([getLinks(ctx), liveAccountIds(ctx, { strict: true, readOnly: true })]);
  const read = await readImported(ctx, { links: effectiveLinks(links, live), only: accountIds });
  for (const a of read.accounts) {
    const { counted } = countedRows(a.held, a.banks, read.order, { bankFrom: a.bank_from, covers: read.covers, pending: true, twins: a.twins });
    // A restored row by the name the bank's part shows it with.
    const shown = counted.map((r) => (r.restored ? { ...r, name: r.restored.merchant_name || r.restored.name } : r));
    rows.set(a.account.account_id, shown.filter((r) => r.date >= since));
  }
  return { rows, unreadable: read.flawed };
}
