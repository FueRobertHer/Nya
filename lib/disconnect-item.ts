// lib/disconnect-item.ts
//
// Removing a linked Plaid Item and everything kept for it. One definition, used
// by the Disconnect button (app/api/disconnect). Kept apart from the route so
// there is one definition of what a disconnect leaves behind.

import { plaidClient } from './plaid';
import { decrypt } from './crypto';
import { getItems, removeItem, type StoredItem } from './storage';
import { clearCaches } from './cache';
import { clearItemTransactions, readStoredTxns } from './transactions';
import { clearInvestmentStore } from './invstore';
import { retireOverrides, pruneOrphanOverrides } from './overrides';
import { forgetItem } from './last-known';
import { forgetVanished } from './vanished';
import type { Ctx } from './containers';

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
      console.error('Plaid item removal failed, removing local record anyway', err);
    }
  }

  // Its categorized transactions are recorded under a key that survives a
  // re-link, BEFORE its store is deleted, so linking the re-added account
  // later carries the categories across (lib/overrides.ts). Best effort: a
  // failure costs that convenience, never the disconnect.
  try {
    await retireOverrides(ctx, await readStoredTxns(ctx, item_id));
  } catch (err) {
    console.error('disconnect: could not record categories to carry across a re-link', err instanceof Error ? err.message : err);
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
    await pruneOrphanOverrides(ctx, (await getItems(ctx)).map((i) => i.item_id));
  } catch (err) {
    console.error('disconnect: could not prune old category overrides', err instanceof Error ? err.message : err);
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
  // Its accounts stay in the account directory, so that if the same
  // institution is added back, even months later, they can be matched to
  // the new ones (lib/links.ts): nothing to do here.

  // Cached payloads no longer reflect the linked institutions.
  await clearCaches(ctx);
}
