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
// rows as stored (lib/transactions.ts), never by a write, so nothing a sync,
// an undo or a re-link does can leave it stale: a duplicate whose bank row a
// re-link no longer brings counts again. What the person said about a row
// (its category, an exclusion or an include, tags, a note) carries to the
// bank's row that stands for it (importedForActivity's `represents`).
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
// accounts can't be read, while books no live account claims could be its.

import type { Ctx } from '../containers';
import { getItems, type StoredItem } from '../storage';
import { rememberedAccountsReport } from '../last-known';
import { effectiveLinks, getLinks, resolveId, sameAccountIds, type Link } from '../link-core';
import { liveAccountIds } from '../links';
import { readStoredItem, vendorKey, StateUnreadableError, LOOKBACK_DAYS, type OlderTxn, type StoredTxn, type Txn } from '../transactions';
import { RECURRING_LOOKBACK_DAYS } from '../recurring';
import { endOf, lifecycleStore } from '../lifecycle';
import { settle, type BankRow, type Settled } from './match';
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
 * couldn't be read. With them, each account that ended (lib/lifecycle.ts) on
 * a connection still stored that the loads no longer remember, a bank having
 * stopped returning it once it closed: named and kinded as its end recorded
 * it, since its rows before its end still count (WHOSE ROWS). A display
 * read: an unreadable record leaves its accounts out, named (an end that
 * can't be read adds none here: whatever counts reads the ends strictly),
 * and storage failing throws.
 */
export async function liveLinkedAccounts(ctx: Ctx, items?: StoredItem[]): Promise<{ accounts: Map<string, LinkedAccount>; unreadable: string[] }> {
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

/** The periods imports cover, by import, from their summaries
 *  (lib/history-import/match.ts settle reads them for its edge rule). */
export function coversOf(summaries: ReadonlyMap<string, HistoryImportSummary>): Map<string, { from: string; to: string }> {
  return new Map([...summaries].map(([id, s]) => [id, { from: s.covers.from, to: s.covers.to }]));
}

/** Which rows count (see the header), and what each one that doesn't is.
 *  `pending` for what is shown: a pending bank row stands in for a row like
 *  it until it posts, which the estimated history never takes. */
export function countedRows(
  held: readonly ImportedTxn[],
  banks: readonly BankRow[],
  order: readonly string[],
  opts: { bankFrom: string | null; covers?: ReadonlyMap<string, { from: string; to: string }>; pending?: boolean }
): Settled<ImportedTxn> {
  return settle(held, banks, order, opts);
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
  /** The periods the imports cover (coversOf). */
  covers: Map<string, { from: string; to: string }>;
  /** Accounts whose imported rows can't be used, named, with why. */
  notes: string[];
  /** The current ids of those accounts. */
  flawed: Set<string>;
  /** Imported rows may be missing for want of something that can't be read
   *  without saying whose: the links, or a connection's accounts. */
  unresolved: boolean;
  /** Imports whose summary can't be read: their order and period aren't known. */
  summariesUnreadable: string[];
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
  opts: {
    items?: StoredItem[];
    links: Map<string, Link> | null;
    leftOut?: ReadonlySet<string>;
    only?: ReadonlySet<string>;
    /** Each connection's stored rows, already read (by the sync that wrote
     *  them, say), so they aren't read twice; null for one that couldn't be. */
    bankStates?: ReadonlyMap<string, Record<string, StoredTxn> | null>;
  } = { links: null }
): Promise<ImportedRead> {
  const books = await importedTxnStore.getAllReport(ctx);
  const empty: ImportedRead = { accounts: [], order: [], summaries: new Map(), covers: new Map(), notes: [], flawed: new Set(), unresolved: false, summariesUnreadable: [] };
  if (books.entries.size === 0 && books.unreadable.length === 0 && books.unrecognised.length === 0) return empty;
  const items = opts.items ?? (await getItems(ctx));
  const links = opts.links ?? new Map<string, Link>();
  const [{ accounts: live, unreadable: unknownItems }, summaries] = await Promise.all([liveLinkedAccounts(ctx, items), historyImportSummaryStore.getAllReport(ctx)]);
  const leftOut = opts.leftOut ?? new Set<string>();
  const summariesUnreadable = [...summaries.unreadable, ...summaries.unrecognised];
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
  let unlinked = false;
  let unowned = false;
  for (const [bookId, book] of books.entries) {
    const account = wanted(bookId);
    if (!account) {
      // Not a live account's, as far as can be told: with the links unread,
      // it may be one's earlier id; with a connection's accounts unread, it
      // may be one of those.
      if (book.rows.length > 0 && !live.has(resolveId(bookId, links))) {
        if (!opts.links) unlinked = true;
        if (unknownItems.length > 0) unowned = true;
      }
      continue;
    }
    if (flawed.has(account.account_id)) continue;
    const list = byAccount.get(account.account_id) ?? [];
    list.push(...book.rows);
    byAccount.set(account.account_id, list);
  }
  if (unlinked) notes.push("Imported transactions of accounts linked across a reconnect aren't shown while the account links can't be read");
  if (unowned) {
    const names = items.filter((i) => unknownItems.includes(i.item_id)).map((i) => i.institution_name);
    notes.push(`${[...new Set(names)].join(', ')}: transactions imported for its accounts aren't shown while its accounts can't be read`);
  }
  const unresolved = unlinked || unowned;
  if (byAccount.size === 0) return { ...empty, notes, flawed, unresolved, summariesUnreadable };

  // The bank's rows of the connections holding these accounts, read once each
  // (or as the caller already read them).
  const itemIds = new Set([...byAccount.keys()].map((id) => live.get(id)!.item_id));
  const bankByItem = new Map<string, { rows: BankRow[]; from: string | null }>();
  const unreadableItems = new Set<string>();
  const use = (item_id: string, txns: Record<string, StoredTxn>) => {
    const all = Object.values(txns);
    bankByItem.set(item_id, { rows: bankRowsOf(all, links), from: earliestPosted(all) });
  };
  await Promise.all(
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
  return { accounts, order: importOrder(summaries), summaries: summaries.entries, covers: coversOf(summaries.entries), notes, flawed, unresolved, summariesUnreadable };
}

const DAY_MS = 86_400_000;
const daysAgo = (n: number) => new Date(Date.now() - n * DAY_MS).toISOString().slice(0, 10);

/** One counted row as the Activity tab shows a transaction: on its account as
 *  it is known now, with the bank's display fields empty, its source said, and
 *  a vendor key as a bank row of its institution would have, so renaming the
 *  merchant covers it too. Its account rides along, never sent, for a rule's
 *  account condition (`account_ref`, lib/txn-layers.ts), as a bank row's
 *  does. */
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
    account_ref: account.account_id,
  };
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
  }
): Promise<{ txns: Txn[]; older: OlderTxn[]; notes: string[]; represents: Map<string, string[]> }> {
  const read = await readImported(ctx, { items: opts.items, links: opts.links, leftOut: opts.leftOut, bankStates: opts.bankStates });
  const cutoff = opts.since ?? daysAgo(LOOKBACK_DAYS);
  const since = opts.since ?? daysAgo(RECURRING_LOOKBACK_DAYS);
  const txns: Txn[] = [];
  const older: OlderTxn[] = [];
  const represents = new Map<string, string[]>();
  for (const a of read.accounts) {
    const settled = countedRows(a.held, a.banks, read.order, { bankFrom: a.bank_from, covers: read.covers, pending: true });
    for (const [rowId, stand] of standsFor(settled)) {
      const list = represents.get(stand) ?? [];
      list.push(rowId);
      represents.set(stand, list);
    }
    const end = opts.endedFrom?.get(a.account.account_id);
    for (const row of settled.counted) {
      if (row.date < since || (end !== undefined && row.date >= end)) continue;
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
  return { txns, older, notes: read.notes, represents };
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
  const out = new Map(direct);
  for (const [id, st] of settled.standing) {
    if (!('row' in st)) continue;
    // Followed through earlier imports' rows: each names an earlier one, so
    // the chain ends.
    let at: string | undefined = st.row;
    for (let hops = 0; at !== undefined && hops < 1000; hops++) {
      const bank = direct.get(at);
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
 *  rows under them, its connection's bank rows and where they begin, and the
 *  imports in order, with their summaries. */
export type AccountContext = {
  ids: string[];
  held: ImportedTxn[];
  banks: BankRow[];
  bank_from: string | null;
  /** The connection's older transactions may still be arriving: Plaid said
   *  its first pull is done and its full history isn't yet. */
  history_pending: boolean;
  order: string[];
  summaries: Map<string, HistoryImportSummary>;
  covers: Map<string, { from: string; to: string }>;
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
    history_pending: item.history_pending === true,
    order: importOrder(summaries),
    summaries: summaries.entries,
    covers: coversOf(summaries.entries),
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
export async function importedForShare(ctx: Ctx, accountIds: ReadonlySet<string>, since: string): Promise<{ rows: Map<string, ImportedTxn[]>; unreadable: Set<string> }> {
  const rows = new Map<string, ImportedTxn[]>();
  if (accountIds.size === 0) return { rows, unreadable: new Set() };
  const [links, live] = await Promise.all([getLinks(ctx), liveAccountIds(ctx, { strict: true, readOnly: true })]);
  const read = await readImported(ctx, { links: effectiveLinks(links, live), only: accountIds });
  for (const a of read.accounts) {
    const { counted } = countedRows(a.held, a.banks, read.order, { bankFrom: a.bank_from, covers: read.covers, pending: true });
    rows.set(a.account.account_id, counted.filter((r) => r.date >= since));
  }
  return { rows, unreadable: read.flawed };
}
