// lib/disconnect-item.ts
//
// Removing a linked Plaid Item and everything kept for it. One definition, used
// by the Disconnect button (app/api/disconnect). Kept apart from the route so
// there is one definition of what a disconnect leaves behind.

import { plaidClient } from './plaid';
import { decrypt } from './crypto';
import { removeItem, type StoredItem } from './storage';
import { clearCaches } from './cache';
import { clearItemTransactions, contentKey, readStoredTxns, storedTransactionIds, type StoredTxn } from './transactions';
import { clearInvestmentStore } from './invstore';
import { retireOverrides, pruneOrphanOverrides } from './overrides';
import { pruneOrphanAnnotations, retireAnnotations } from './txn-annotations';
import { forgetItem } from './last-known';
import { forgetVanished } from './vanished';
import { clearNewAccounts } from './new-accounts';
import { forgetConnection } from './connection-health';
import type { Ctx } from './containers';
import { loggable } from './log-safe';

/**
 * `item` is the stored Item, or undefined when only a stale id is being
 * cleaned up: the local records still go, Plaid is not called.
 */
export async function disconnectItem(
  ctx: Ctx,
  item_id: string,
  item: StoredItem | undefined,
): Promise<void> {
  if (item) {
    try {
      const access_token = await decrypt(item.encrypted_access_token);
      await plaidClient.itemRemove({ access_token });
    } catch (err) {
      // If Plaid-side removal fails (e.g. already revoked), still remove
      // our local record so the broken entry doesn't linger.
      console.error('Plaid item removal failed, removing local record anyway', loggable(err));
    }
  }

  // Its categorized transactions are recorded under a key that survives a
  // re-link, BEFORE its store is deleted, so linking the re-added account
  // later carries the categories across (lib/overrides.ts). Best effort: a
  // failure costs that convenience, never the disconnect.
  let stored: StoredTxn[] | null = null;
  try {
    stored = await readStoredTxns(ctx, item_id);
    await retireOverrides(ctx, stored);
  } catch (err) {
    console.error('disconnect: could not record categories to carry across a re-link', err instanceof Error ? err.message : err);
  }
  // And which of them were excluded from budgets and reports, the same way
  // (lib/txn-annotations.ts), so a re-link doesn't quietly put a one-off back
  // in every total. Best effort too.
  try {
    if (stored) {
      await retireAnnotations(
        ctx,
        stored.map((t) => ({ transaction_id: t.transaction_id, account_id: t.account_id, key: contentKey(t.account_id, t), pending: t.pending }))
      );
    }
  } catch (err) {
    console.error('disconnect: could not record exclusions to carry across a re-link', err instanceof Error ? err.message : err);
  }

  await removeItem(ctx, item_id);
  // Drop this Item's persisted sync cursor + transactions.
  await clearItemTransactions(ctx, item_id);
  // And its stored investment transactions. A sync still running writes, then
  // sees the Item gone and deletes what it wrote (lib/invstore.ts).
  await clearInvestmentStore(ctx, item_id);
  // And any override left behind for a transaction no stored Item has any
  // more (best effort: a user's categories are theirs to be rid of too).
  try {
    await pruneOrphanOverrides(ctx);
  } catch (err) {
    console.error('disconnect: could not prune old category overrides', err instanceof Error ? err.message : err);
  }
  // And what was said about them, this Item's own exclusions among them, now
  // that it is gone: the ones to carry were recorded above (best effort too).
  try {
    await pruneOrphanAnnotations(ctx, () => storedTransactionIds(ctx));
  } catch (err) {
    console.error('disconnect: could not prune old exclusions', err instanceof Error ? err.message : err);
  }
  // Hidden accounts STAY hidden (#46). Their history is kept, so dropping the
  // entry would put the account back into every past total the moment it
  // was disconnected, and re-linking it would bring it back unhidden. The
  // Hidden card lists it as disconnected, with Unhide, and linking the
  // re-added account carries the hidden state across (lib/links.ts).
  await forgetItem(ctx, item_id);
  // Its vanished-account record goes with it: the Item is gone, so nothing
  // can confirm or clear those entries, and a relink starts clean.
  await forgetVanished(ctx, item_id);
  // And any "new accounts available" prompt, which could only offer to add
  // accounts to an Item that no longer exists.
  await clearNewAccounts(ctx, item_id);
  // And its health: Plaid's warnings, its last sync, and the email bookkeeping
  // of a break (lib/connection-health.ts), so no email follows a removal. Best
  // effort: a record left behind is inert, and the daily job drops records of
  // connections that are gone (lib/connection-notices.ts).
  try {
    await forgetConnection(ctx, item_id);
  } catch (err) {
    console.error('disconnect: could not forget the connection’s health records', err instanceof Error ? err.name : typeof err);
  }
  // Its accounts stay in the account directory, so that if the same
  // institution is added back, even months later, they can be matched to
  // the new ones (lib/links.ts): nothing to do here.

  // Cached payloads no longer reflect the linked institutions.
  await clearCaches(ctx);
}
