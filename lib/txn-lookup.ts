// lib/txn-lookup.ts
//
// Stored transactions by id, for the routes that change how a transaction
// counts (splits, app/api/transaction-splits; groups,
// app/api/transaction-groups): what each one is as stored (its amount,
// currency, day, account and whether it is still pending), read from the
// banks' stores (lib/transactions.ts) and the books of the manual and
// SimpleFIN accounts (lib/manual-txns.ts), never syncing. Strict: an id not
// found while a store that could hold it couldn't be read is never answered
// as "not stored".

import type { Ctx } from './containers';
import { getItems } from './storage';
import { readStoredTxns, StateUnreadableError } from './transactions';
import { manualTxnStore } from './manual-txns';
import { MANUAL_TXN_PREFIX } from './manual-txn-input';
import { splitStore } from './splits';
import { groupStore } from './groups';

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
};

/** Some of the stores that could hold what was asked for couldn't be read,
 *  so whether it is stored isn't known: nothing was changed. 409. */
export class LookupUnreadableError extends Error {
  readonly status = 409;
  constructor(readonly where: string[]) {
    super(
      `Some of your stored transactions couldn’t be read just now (${where.join(', ')}), so nothing was changed. Try again later; if it lasts, reconnecting the bank, or reading the manual account again, brings them back.`
    );
    this.name = 'LookupUnreadableError';
  }
}

/**
 * The stored transactions with these ids, by id. An id no readable store
 * holds is left out of the answer, unless a store that could hold it couldn't
 * be read: then LookupUnreadableError, never "not stored". A bank's id is
 * looked for in every linked institution's store (they are read one at a
 * time, until every bank id is found), a manual row's in every book.
 */
export async function findTransactions(ctx: Ctx, ids: readonly string[]): Promise<Map<string, FoundTxn>> {
  const found = new Map<string, FoundTxn>();
  // What couldn't be read, among the banks' stores and among the books.
  const unreadBanks: string[] = [];
  let unreadBooks = false;
  const bank = new Set(ids.filter((id) => !id.startsWith(MANUAL_TXN_PREFIX)));
  const manual = new Set(ids.filter((id) => id.startsWith(MANUAL_TXN_PREFIX)));
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
  const missing = (among: Set<string>) => [...among].some((id) => !found.has(id));
  const where = [...(unreadBanks.length > 0 && missing(bank) ? unreadBanks : []), ...(unreadBooks && missing(manual) ? ['a manual account'] : [])];
  if (where.length > 0) throw new LookupUnreadableError(where);
  return found;
}

// ---- What a disconnect takes ----

/**
 * How many of a connection's stored transactions are split, and how many are
 * in a group: what disconnecting it takes with it (lib/disconnect-item.ts,
 * lib/split-gone.ts), which adding it back doesn't bring back, for the
 * confirmation to say before it happens. Strict: a store of its transactions
 * that can't be read is LookupUnreadableError, and splits or groups that
 * can't be read throw as the seam does, never a count of none.
 */
export async function splitsAndGroupsOn(ctx: Ctx, item_id: string): Promise<{ split: number; grouped: number }> {
  let ids: Set<string>;
  try {
    ids = new Set((await readStoredTxns(ctx, item_id)).map((t) => t.transaction_id));
  } catch (err) {
    if (!(err instanceof StateUnreadableError)) throw err;
    const item = (await getItems(ctx)).find((i) => i.item_id === item_id);
    throw new LookupUnreadableError([item?.institution_name ?? 'a bank']);
  }
  if (ids.size === 0) return { split: 0, grouped: 0 };
  const [splits, groups] = await Promise.all([splitStore.getAll(ctx), groupStore.getAll(ctx)]);
  let split = 0;
  for (const id of splits.keys()) if (ids.has(id)) split++;
  let grouped = 0;
  for (const g of groups.values()) for (const id of g.members) if (ids.has(id)) grouped++;
  return { split, grouped };
}
