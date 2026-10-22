// lib/user-restore/forget.ts
//
// Forgetting an account a restore brought back (lib/links.ts
// forgetEarlierAccount, which forgets everything else an earlier account
// has): its bank rows (every book), what was said about them by their ids
// (categories chosen, notes, tags and exclusions, splits, places in groups,
// approvals, an approval under the pending row a row replaced), and its
// entry among the restored accounts, last. No pruner takes those records by
// itself, since a restored row's id has an imported row's prefix (that is
// what keeps them while the account waits to be linked), so this is the one
// place they go. A book nobody can read keeps what was said about its rows:
// which rows those were can't be told.

import type { Ctx } from '../containers';
import { forgetAnnotations } from '../txn-annotations';
import { forgetOverrides } from '../overrides';
import { forgetSplitsAndGroups } from '../split-gone';
import { StoredDataUnreadableError } from '../stored-json';
import { restoredAccountsStore, restoredBookId, restoredId, restoredTxnStore } from './store';
import { bookIdsOf } from './restored';

/** The books an account has: from its entry, or, with none that can be read,
 *  the parts there are, counted from the first (they are made in order). */
async function booksOf(ctx: Ctx, account_id: string): Promise<string[]> {
  try {
    const entry = await restoredAccountsStore.get(ctx, account_id);
    if (entry) return bookIdsOf(account_id, entry);
  } catch (err) {
    if (!(err instanceof StoredDataUnreadableError)) throw err;
  }
  const ids: string[] = [];
  for (let part = 1; part <= 10_000 && (await restoredTxnStore.has(ctx, restoredBookId(account_id, part))); part++) ids.push(restoredBookId(account_id, part));
  return ids;
}

/** Forgets what a restore brought back for one account (see the header),
 *  readable or not. Answers whether it had anything. Running it again after
 *  a stop finishes it. Storage failing throws. */
export async function forgetRestoredAccount(ctx: Ctx, account_id: string): Promise<boolean> {
  const [books, has] = await Promise.all([booksOf(ctx, account_id), restoredAccountsStore.has(ctx, account_id)]);
  if (books.length === 0 && !has) return false;
  const rows: string[] = [];
  for (const id of books) {
    let book;
    try {
      book = await restoredTxnStore.get(ctx, id);
    } catch (err) {
      if (!(err instanceof StoredDataUnreadableError)) throw err;
      continue;
    }
    for (const r of book?.rows ?? []) {
      rows.push(r.id);
      const pending = r.bank.pending_transaction_id;
      if (pending) {
        try {
          rows.push(restoredId(pending));
        } catch {
          // Not an id a row could have had: nothing is kept under it.
        }
      }
    }
  }
  await forgetAnnotations(ctx, rows);
  await forgetOverrides(ctx, rows);
  await forgetSplitsAndGroups(ctx, rows);
  for (let i = 0; i < books.length; i += 500) await restoredTxnStore.remove(ctx, ...books.slice(i, i + 500));
  await restoredAccountsStore.remove(ctx, account_id);
  return true;
}
