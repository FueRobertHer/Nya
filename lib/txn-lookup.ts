// lib/txn-lookup.ts
//
// Stored transactions by id, for the routes that change how a transaction
// counts (splits, app/api/transaction-splits; groups,
// app/api/transaction-groups): what each one is as stored (its amount,
// currency, day, account and whether it is still pending), read from the
// banks' stores (lib/transactions.ts), the books of the manual and SimpleFIN
// accounts (lib/manual-txns.ts), and the rows imported into linked accounts
// from their banks' files (#52, lib/history-import/store.ts), never syncing.
// An imported row is found whether or not it counts now: one a bank row
// stands for keeps its split and its place in a group, which that bank row
// shows (lib/split-rows.ts), and an edit of them is made on it. Its amount is
// that bank row's when the sync kept the two as a pair
// (lib/history-import/match.ts KEPT ONCE MADE) and the bank changed its
// amount since: the amount shown, which a split of it adds up to. Strict: an
// id not found while a store that could hold it couldn't be read is never
// answered as "not stored", nor is an imported row's amount while the pairs
// that could change it can't be read.

import type { Ctx } from './containers';
import { getItems } from './storage';
import { contentKey, readStoredTxns, StateUnreadableError } from './transactions';
import { manualTxnStore } from './manual-txns';
import { MANUAL_TXN_PREFIX } from './manual-txn-input';
import { importedTwinsStore, importedTxnStore, IMPORTED_TXN_PREFIX } from './history-import/store';
import { isFileImportedId, RESTORED_TXN_PREFIX } from './history-import/view';
import { restoredTxnStore } from './user-restore/store';
import { countedRows, readImported, standsFor } from './history-import/read';
import { effectiveLinks, getLinks, resolveId } from './link-core';
import { liveAccountsReport } from './links';
import { splitStore } from './splits';
import { groupStore } from './groups';
import { expensePaymentsStore, expenseSharesStore } from './shared-expenses/store';

/** A transaction as stored: what a split or a group is checked against. */
export type FoundTxn = {
  transaction_id: string;
  account_id: string;
  date: string;
  /** Plaid's sign: positive is money out. */
  amount: number;
  /** Its currency (ISO, or Plaid's unofficial code), or null when it says none. */
  currency: string | null;
  pending: boolean;
  /** Its name as stored (the merchant, else the bank's words; a manual row's
   *  payee), for a refusal to name it. */
  name: string;
  /** A posted bank row's content key (lib/transactions.ts contentKey: the
   *  account, the day, the amount and the bank's own words), what carries a
   *  receipt on it across a re-link (lib/attachments.ts). Absent for a
   *  pending row and for rows that keep their id (manual and imported). */
  content?: string;
};

/** Where a row imported into a linked account is looked for, as a refusal
 *  names it, and what says which bank row stands for one. */
const IMPORTED_BOOKS = 'transactions imported from files';
const RESTORED_BOOKS = 'transactions brought back from your download';
const IMPORTED_PAIRS = 'which of the bank’s transactions stand for the ones you imported';

/** Some of the stores that could hold what was asked for couldn't be read,
 *  so whether it is stored isn't known: nothing was changed. 409. */
export class LookupUnreadableError extends Error {
  readonly status = 409;
  constructor(readonly where: string[]) {
    // Reconnecting a bank, or reading a manual account again, brings back
    // what it holds; nothing does that for an imported row.
    const lasting = where.some((w) => w !== IMPORTED_BOOKS && w !== IMPORTED_PAIRS && w !== RESTORED_BOOKS) ? '; if it lasts, reconnecting the bank, or reading the manual account again, brings them back' : '';
    super(`Some of your stored transactions couldn’t be read just now (${where.join(', ')}), so nothing was changed. Try again later${lasting}.`);
    this.name = 'LookupUnreadableError';
  }
}

/**
 * The stored transactions with these ids, by id. An id no readable store
 * holds is left out of the answer, unless a store that could hold it couldn't
 * be read: then LookupUnreadableError, never "not stored". A bank's id is
 * looked for in every linked institution's store (they are read one at a
 * time, until every bank id is found), a manual row's in every book, and a
 * row imported into a linked account in every account's imported rows, on
 * the account it was imported into.
 */
export async function findTransactions(ctx: Ctx, ids: readonly string[]): Promise<Map<string, FoundTxn>> {
  const found = new Map<string, FoundTxn>();
  // What couldn't be read, among the banks' stores and among the books.
  const unreadBanks: string[] = [];
  let unreadBooks = false;
  let unreadImported = false;
  const manual = new Set(ids.filter((id) => id.startsWith(MANUAL_TXN_PREFIX)));
  const restored = new Set(ids.filter((id) => id.startsWith(RESTORED_TXN_PREFIX)));
  const imported = new Set(ids.filter((id) => id.startsWith(IMPORTED_TXN_PREFIX) && !restored.has(id)));
  const bank = new Set(ids.filter((id) => !manual.has(id) && !imported.has(id) && !restored.has(id)));
  if (bank.size > 0) {
    for (const item of await getItems(ctx)) {
      if ([...bank].every((id) => found.has(id))) break;
      let rows;
      try {
        rows = await readStoredTxns(ctx, item.item_id);
      } catch (err) {
        if (!(err instanceof StateUnreadableError)) throw err;
        unreadBanks.push(item.institution_name);
        continue;
      }
      for (const t of rows) {
        if (!bank.has(t.transaction_id)) continue;
        found.set(t.transaction_id, {
          transaction_id: t.transaction_id,
          account_id: t.account_id,
          date: t.date,
          amount: t.amount,
          currency: t.iso_currency_code ?? t.unofficial_currency_code ?? null,
          pending: t.pending,
          name: t.merchant_name || t.name,
          ...(t.pending ? {} : { content: contentKey(t.account_id, t) }),
        });
      }
    }
  }
  if (manual.size > 0) {
    const { entries, unreadable, unrecognised } = await manualTxnStore.getAllReport(ctx);
    for (const book of entries.values()) {
      for (const r of book.rows) {
        if (!manual.has(r.id)) continue;
        found.set(r.id, { transaction_id: r.id, account_id: r.account_id, date: r.date, amount: r.amount, currency: r.currency, pending: false, name: r.name });
      }
    }
    unreadBooks = unreadable.length + unrecognised.length > 0;
  }
  let unreadPairs = false;
  if (imported.size > 0) {
    const [{ entries, unreadable, unrecognised }, twins] = await Promise.all([importedTxnStore.getAllReport(ctx), importedTwinsStore.getAllReport(ctx)]);
    for (const book of entries.values()) {
      for (const r of book.rows) {
        if (!imported.has(r.id)) continue;
        found.set(r.id, { transaction_id: r.id, account_id: r.account_id, date: r.date, amount: r.amount, currency: r.currency, pending: false, name: r.name });
      }
    }
    unreadImported = unreadable.length + unrecognised.length > 0;
    unreadPairs = twins.unreadable.length + twins.unrecognised.length > 0;
    // A row a bank row was kept as standing for, at that row's amount now
    // (see the header), read from the connection that keeps the pair.
    const pinned = new Map<string, Map<string, string>>();
    for (const [item_id, entry] of twins.entries) {
      for (const [row, bank] of Object.entries(entry.twins)) {
        if (!found.has(row)) continue;
        const byBank = pinned.get(item_id) ?? new Map<string, string>();
        byBank.set(bank, row);
        pinned.set(item_id, byBank);
      }
    }
    for (const [item_id, byBank] of pinned) {
      let rows;
      try {
        rows = await readStoredTxns(ctx, item_id);
      } catch (err) {
        if (!(err instanceof StateUnreadableError)) throw err;
        unreadPairs = true;
        continue;
      }
      for (const t of rows) {
        const row = byBank.get(t.transaction_id);
        if (row === undefined || t.pending) continue;
        found.set(row, { ...found.get(row)!, amount: t.amount, currency: t.iso_currency_code ?? t.unofficial_currency_code ?? found.get(row)!.currency });
      }
    }
  }
  // A bank row a restore brought back, in the books of every restored
  // account (lib/user-restore/store.ts), held or not: a split or a group of
  // one is made as on any row (lib/user-restore/restored.ts).
  let unreadRestored = false;
  if (restored.size > 0) {
    const { entries, unreadable, unrecognised } = await restoredTxnStore.getAllReport(ctx);
    for (const book of entries.values()) {
      for (const r of book.rows) {
        if (!restored.has(r.id)) continue;
        const b = r.bank;
        found.set(r.id, {
          transaction_id: r.id,
          account_id: r.account_id,
          date: b.date,
          amount: b.amount,
          currency: b.iso_currency_code ?? b.unofficial_currency_code ?? null,
          pending: false,
          name: b.merchant_name || b.name,
          content: contentKey(r.account_id, b),
        });
      }
    }
    unreadRestored = unreadable.length + unrecognised.length > 0;
  }
  const missing = (among: Set<string>) => [...among].some((id) => !found.has(id));
  const where = [
    ...(unreadBanks.length > 0 && missing(bank) ? unreadBanks : []),
    ...(unreadBooks && missing(manual) ? ['a manual account'] : []),
    ...(unreadImported && missing(imported) ? [IMPORTED_BOOKS] : []),
    ...(unreadRestored && missing(restored) ? [RESTORED_BOOKS] : []),
    // Found, but whether a bank row now stands for it at another amount
    // can't be told: no amount is answered for it.
    ...(unreadPairs && imported.size > 0 ? [IMPORTED_PAIRS] : []),
  ];
  if (where.length > 0) throw new LookupUnreadableError(where);
  return found;
}

// ---- What a bank row stands for ----

/**
 * The rows imported into linked accounts from files (#52) that each of these
 * bank transactions stands for now, earlier imports first, worked out as the
 * read layer works them out (lib/history-import/read.ts importedForActivity's
 * `represents`): the rows whose split, or place in a group, the bank row
 * shows (lib/split-rows.ts), which a split or a group of its own would hide.
 * Only the banks' own rows among `found` are looked at, on the links that
 * apply now, with the pairs the sync kept (lib/history-import/twins.ts), so
 * a bank row the bank modified stands for what the read layer says. Strict
 * about these accounts only: the links, or what these accounts' imported
 * rows are, that can't be read throw (LookupUnreadableError for the rows),
 * never an answer of "none"; what can't be read of other accounts doesn't. A
 * connection whose accounts can't be read matters only to an account a link
 * touches (one of its ids may be live there again, which pauses the link,
 * lib/link-core.ts effectiveLinks) or to one of its own (whose imported rows
 * no live account claims then). One read of the books when nothing was
 * imported.
 */
export async function importedStoodFor(ctx: Ctx, found: Iterable<FoundTxn>): Promise<Map<string, string[]>> {
  // A bank row a restore brought back stands for rows as a bank row does
  // (lib/history-import/read.ts standsFor).
  const bank = [...found].filter((t) => !t.transaction_id.startsWith(MANUAL_TXN_PREFIX) && !isFileImportedId(t.transaction_id));
  const out = new Map<string, string[]>();
  if (bank.length === 0) return out;
  const [files, brought] = await Promise.all([importedTxnStore.count(ctx), restoredTxnStore.count(ctx)]);
  if (files + brought === 0) return out;
  const [links, live] = await Promise.all([getLinks(ctx), liveAccountsReport(ctx)]);
  if (live.unreadable.length > 0) {
    const roots = new Set(bank.map((t) => resolveId(t.account_id, links)));
    if ([...links.keys()].some((old) => roots.has(resolveId(old, links)))) throw new LookupUnreadableError([IMPORTED_BOOKS]);
  }
  const applied = effectiveLinks(links, live.ids);
  const accounts = new Set(bank.map((t) => resolveId(t.account_id, applied)));
  const read = await readImported(ctx, { links: applied, only: accounts });
  if (read.unresolved || [...accounts].some((a) => read.flawed.has(a))) throw new LookupUnreadableError([IMPORTED_BOOKS]);
  const wanted = new Set(bank.map((t) => t.transaction_id));
  const rank = new Map(read.order.map((id, i) => [id, i]));
  const at = new Map<string, number>();
  for (const a of read.accounts) {
    const settled = countedRows(a.held, a.banks, read.order, { bankFrom: a.bank_from, covers: read.covers, pending: true, twins: a.twins });
    for (const r of a.held) at.set(r.id, rank.get(r.import_id) ?? Number.MAX_SAFE_INTEGER);
    for (const [rowId, bankId] of standsFor(settled)) if (wanted.has(bankId)) out.set(bankId, [...(out.get(bankId) ?? []), rowId]);
  }
  for (const list of out.values()) list.sort((x, y) => (at.get(x) ?? 0) - (at.get(y) ?? 0));
  return out;
}

// ---- What a disconnect takes ----

/**
 * How many of a connection's stored transactions are split, and how many are
 * in a group: what disconnecting it takes with it (lib/disconnect-item.ts,
 * lib/split-gone.ts), which adding it back doesn't bring back, for the
 * confirmation to say before it happens. The rows imported into its accounts
 * from files aren't among them: they are kept past a disconnect, for a
 * re-link, and so are their splits and their places in groups. Strict: a
 * store of its transactions that can't be read is LookupUnreadableError, and
 * splits or groups that can't be read throw as the seam does, never a count
 * of none.
 */
export async function splitsAndGroupsOn(ctx: Ctx, item_id: string): Promise<{ split: number; grouped: number; shared: number }> {
  let ids: Set<string>;
  try {
    ids = new Set((await readStoredTxns(ctx, item_id)).map((t) => t.transaction_id));
  } catch (err) {
    if (!(err instanceof StateUnreadableError)) throw err;
    const item = (await getItems(ctx)).find((i) => i.item_id === item_id);
    throw new LookupUnreadableError([item?.institution_name ?? 'a bank']);
  }
  if (ids.size === 0) return { split: 0, grouped: 0, shared: 0 };
  const [splits, groups, shares, payments] = await Promise.all([splitStore.getAll(ctx), groupStore.getAll(ctx), expenseSharesStore.ids(ctx), expensePaymentsStore.ids(ctx)]);
  let split = 0;
  for (const id of splits.keys()) if (ids.has(id)) split++;
  let grouped = 0;
  for (const g of groups.values()) for (const id of g.members) if (ids.has(id)) grouped++;
  // Shared, or paying something back (lib/shared-expenses/): kept, and
  // moved by the person to the transaction once it is back.
  const shared = new Set([...shares, ...payments].filter((id) => ids.has(id))).size;
  return { split, grouped, shared };
}
