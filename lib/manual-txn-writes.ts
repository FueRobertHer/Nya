// lib/manual-txn-writes.ts
//
// Adding, changing and deleting a transaction on a manual account: what the
// quick-add form and the edit form do through app/api/manual-transactions,
// and what the API's writes do (lib/api-writes.ts), in one place so the two
// never differ. The route reads a request, checks the balance move only the
// form asks for, and answers; the steps that store, refuse or clean up are
// here. lib/manual-txns.ts keeps the books themselves.

import type { Ctx } from './containers';
import { getManualAccount, type ManualAccount } from './manual';
import { getKeptAccount, type KeptAccount } from './kept-accounts';
import {
  addManualTxn,
  deleteManualTxn,
  editManualTxn,
  manualRowForDisplay,
  newManualTxn,
  removeAccountTxns,
  type ManualTxn,
  type ManualTxnChanges,
} from './manual-txns';
import type { TxnFields } from './manual-txn-input';
import { forgetAnnotations } from './txn-annotations';
import { forgetSplitsAndGroups } from './split-gone';
import { followEdit } from './review-store';
import { currencyOf } from './spending';
import { loggable } from './log-safe';

/**
 * Adds one row to an account's book under `id`, once (an add sent again finds
 * its row: `added` false), as a row entered in the app. An account deleted
 * while this was saved (app/api/manual-accounts DELETE) mustn't be left a
 * book nothing shows: its row goes with it ('account-gone').
 */
export async function addRow(
  ctx: Ctx,
  account: ManualAccount,
  fields: TxnFields,
  id: string,
  now: Date = new Date()
): Promise<{ row: ManualTxn; added: boolean } | 'account-gone'> {
  const { row, added } = await addManualTxn(ctx, newManualTxn(account.account_id, fields, now, id));
  if (added && !(await getManualAccount(ctx, account.account_id))) {
    await removeAccountTxns(ctx, account.account_id);
    return 'account-gone';
  }
  return { row, added };
}

/** What changeManualTransaction did. */
export type RowChange = { saved: ManualTxn; on: KeptAccount } | 'gone' | 'account-gone';

/**
 * Changes one row: any of its fields, or the account it is on (`target`, an
 * account the caller has read). `from` is the account the page shows it on,
 * so only that book is read. `expect` is a check of the row as it is, run
 * inside the book's compare-and-set (lib/manual-txns.ts editManualTxn).
 * 'gone' when it was deleted or moved since; 'account-gone' when it was moved
 * into an account deleted meanwhile, where it goes with the account. A new
 * amount or currency is the person's own word: an approval of the row follows
 * it (lib/review-store.ts followEdit), best effort.
 */
export async function changeManualTransaction(
  ctx: Ctx,
  id: string,
  changes: ManualTxnChanges,
  opts: { from?: string; target?: ManualAccount; expect?: (row: ManualTxn) => void; now?: Date } = {}
): Promise<RowChange> {
  const saved = await editManualTxn(ctx, id, changes, { from: opts.from, expect: opts.expect, now: opts.now });
  if (!saved) return 'gone';
  // Moved into an account deleted meanwhile: the row goes with it, as the
  // account's rows do. An edit in place can't bring a deleted book back: it
  // writes only where its row is.
  if (opts.target && !(await getManualAccount(ctx, opts.target.account_id))) {
    await removeAccountTxns(ctx, opts.target.account_id);
    return 'account-gone';
  }
  // A SimpleFIN account's row (its category changed) answers like the rest.
  const on = opts.target ?? (await getKeptAccount(ctx, saved.account_id));
  if (!on) return 'account-gone';
  if (changes.amount !== undefined || changes.currency !== undefined) {
    const row = manualRowForDisplay(on, saved);
    await followEdit(ctx, saved.id, { amount: row.amount, currency: currencyOf(row) }).catch((err) =>
      console.warn('manual-transactions: an approval did not follow the edit', loggable(err))
    );
  }
  return { saved, on };
}

/**
 * Removes one row and what was said about it: its exclusion, tags and note
 * beside it, its split, its places in groups and its approval, best effort
 * (one left behind names a row that no longer exists, which is never shown).
 * `from` is the account the page shows it on, read first; one moved
 * meanwhile is found where it is now. False when it is nowhere. `expect`
 * runs inside the book's compare-and-set (lib/manual-txns.ts deleteManualTxn).
 */
export async function removeManualTransaction(ctx: Ctx, id: string, from?: string, opts: { expect?: (row: ManualTxn) => void } = {}): Promise<boolean> {
  const deleted = await deleteManualTxn(ctx, id, from, { expect: opts.expect });
  await forgetAnnotations(ctx, [id]).catch((err) => console.warn('manual-transactions: an exclusion was left behind', loggable(err)));
  await forgetSplitsAndGroups(ctx, [id]).catch((err) => console.warn('manual-transactions: a split or a group was left behind', loggable(err)));
  return deleted;
}
