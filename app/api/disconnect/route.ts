import { NextResponse } from 'next/server';
import { dataCtx, containerUnavailable } from '@/lib/data-ctx';
import { plaidClient } from '@/lib/plaid';
import { decrypt } from '@/lib/crypto';
import { getItems, removeItem } from '@/lib/storage';
import { clearCaches } from '@/lib/cache';
import { clearItemTransactions, readStoredTxns } from '@/lib/transactions';
import { clearInvestmentStore } from '@/lib/invstore';
import { MANUAL_ITEM_PREFIX } from '@/lib/manual';
import { retireOverrides, pruneOrphanOverrides } from '@/lib/overrides';
import { forgetItem } from '@/lib/last-known';
import { forgetVanished } from '@/lib/vanished';

export async function POST(req: Request) {
  try {
    const ctx = await dataCtx();
    const { item_id } = await req.json();

    // Manual institutions are synthetic groupings, not Plaid Items. Without
    // this guard the call would fall through to a no-op HDEL and return
    // success, which looks like the accounts were removed when nothing
    // happened. They're deleted through /api/manual-accounts instead.
    if (typeof item_id === 'string' && item_id.startsWith(MANUAL_ITEM_PREFIX)) {
      return NextResponse.json(
        { error: 'Manual accounts are removed via /api/manual-accounts' },
        { status: 400 }
      );
    }

    const items = await getItems(ctx);
    const item = items.find((i) => i.item_id === item_id);

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

    return NextResponse.json({ success: true });
  } catch (err: any) {
    const unavailable = containerUnavailable(err);
    if (unavailable) return unavailable;
    console.error(err);
    return NextResponse.json({ error: 'Failed to disconnect' }, { status: 500 });
  }
}
