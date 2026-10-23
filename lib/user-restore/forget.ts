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
//
// NEVER WHAT THIS VERSION DOESN'T KNOW. An entry or a book in a form this
// version doesn't know (a newer version wrote it, or a fault: sealed under
// another account's key, say) is intact as far as this code can tell, and is
// never removed (lib/repo.ts, ONLY UNREADABLE ENTRIES MAY EVER BE OFFERED FOR
// REMOVAL): forgetting the account is refused, before anything is changed
// (restoredForgetRefusal).

import type { Ctx } from '../containers';
import { forgetAnnotations } from '../txn-annotations';
import { forgetOverrides } from '../overrides';
import { forgetSplitsAndGroups } from '../split-gone';
import { StoredDataUnreadableError } from '../stored-json';
import { UnreadableEntriesError } from '../repo';
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
  return partsOf(ctx, account_id);
}

/** The parts of an account's books there are, counted from the first (they
 *  are made in order), for one whose entry can't be read. */
async function partsOf(ctx: Ctx, account_id: string): Promise<string[]> {
  const ids: string[] = [];
  for (let part = 1; part <= 10_000 && (await restoredTxnStore.has(ctx, restoredBookId(account_id, part))); part++) ids.push(restoredBookId(account_id, part));
  return ids;
}

/** What a restore brought back for one account, as forgetting it would take
 *  it: the rows that can be read, counted, with their first and last days;
 *  whether a book of them can't be read (its rows uncounted); and whether one
 *  is in a form this version doesn't know (see the header). Storage failing
 *  throws. */
export type RestoredRows = { count: number; first: string | null; last: string | null; unreadable: boolean; unrecognised: boolean };

export async function restoredRowsOf(ctx: Ctx, account_id: string): Promise<RestoredRows> {
  const out: RestoredRows = { count: 0, first: null, last: null, unreadable: false, unrecognised: false };
  for (const id of await booksOf(ctx, account_id)) {
    let book;
    try {
      book = await restoredTxnStore.get(ctx, id);
    } catch (err) {
      if (err instanceof UnreadableEntriesError && err.unrecognised.length > 0) out.unrecognised = true;
      else if (err instanceof StoredDataUnreadableError) out.unreadable = true;
      else throw err;
      continue;
    }
    for (const r of book?.rows ?? []) {
      out.count++;
      if (out.first === null || r.bank.date < out.first) out.first = r.bank.date;
      if (out.last === null || r.bank.date > out.last) out.last = r.bank.date;
    }
  }
  return out;
}

/** The words that refuse forgetting this account (lib/links.ts
 *  forgetEarlierAccount), read before it changes anything: what a restore
 *  brought back for it, its entry or a book, is in a form this version
 *  doesn't know (see the header). Null when nothing is. */
export async function restoredForgetRefusal(ctx: Ctx, account_id: string): Promise<string | null> {
  let unknown = false;
  try {
    await restoredAccountsStore.get(ctx, account_id);
  } catch (err) {
    if (err instanceof UnreadableEntriesError && err.unrecognised.length > 0) unknown = true;
    else if (!(err instanceof StoredDataUnreadableError)) throw err;
  }
  if (!unknown && !(await restoredRowsOf(ctx, account_id)).unrecognised) return null;
  return REFUSED;
}

const REFUSED = 'What a restore brought back for this account is in a form this version of Nya doesn’t know: a newer version wrote it, or it is a fault. It is kept as it is, so the account can’t be forgotten here: ask whoever runs this copy of Nya.';

/**
 * restoredForgetRefusal for many accounts at once, as cheaply as it can be
 * had, for a list that offers Forget (the Earlier accounts list,
 * app/api/account-links): the restored accounts read once; only those a
 * restore brought back looked at further; an entry this version doesn't
 * know refused without its books read; the books of the rest read one at a
 * time until the first this version doesn't know, counting nothing. Each
 * account asked that would be refused is in `refused`, with the words; one
 * whose books couldn't be checked (a book sealed under a key this deployment
 * can't use, storage failing part way) in `unchecked`, offered nothing. The
 * forget itself still asks restoredForgetRefusal, so nothing rests on this.
 * Reading the restored accounts failing throws.
 */
export async function restoredRefusals(ctx: Ctx, ids: readonly string[]): Promise<{ refused: Map<string, string>; unchecked: Set<string> }> {
  const report = await restoredAccountsStore.getAllReport(ctx);
  const refused = new Map<string, string>();
  const unchecked = new Set<string>();
  await Promise.all(
    ids.map(async (id) => {
      if (report.unrecognised.includes(id)) return void refused.set(id, REFUSED);
      const entry = report.entries.get(id);
      if (!entry && !report.unreadable.includes(id)) return; // nothing restored for it
      try {
        const books = entry ? bookIdsOf(id, entry) : await partsOf(ctx, id);
        for (const book of books) {
          try {
            await restoredTxnStore.get(ctx, book);
          } catch (err) {
            if (err instanceof UnreadableEntriesError && err.unrecognised.length > 0) return void refused.set(id, REFUSED);
            if (!(err instanceof StoredDataUnreadableError)) throw err;
          }
        }
      } catch {
        unchecked.add(id);
      }
    })
  );
  return { refused, unchecked };
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
