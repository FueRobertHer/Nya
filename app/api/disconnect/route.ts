import { NextResponse } from 'next/server';
import { plaidClient } from '@/lib/plaid';
import { decrypt } from '@/lib/crypto';
import { getItems, removeItem } from '@/lib/storage';
import { clearCaches, readCache, NET_WORTH_CACHE_KEY } from '@/lib/cache';
import { clearItemTransactions, getItemAccountIds } from '@/lib/transactions';
import { MANUAL_ITEM_PREFIX } from '@/lib/manual';
import { pruneHidden } from '@/lib/hidden';

export async function POST(req: Request) {
  try {
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

    const items = await getItems();
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

    // Collect the Item's account ids BEFORE its state is dropped, so any
    // hidden-account entries pointing at them can be cleaned up. A stale hidden
    // id is NOT harmless here: the historical per-account maps still contain
    // that account, so getHistory would go on subtracting it from every past
    // point forever, and with the account gone from the live list there'd be no
    // Unhide button to stop it.
    //
    // Two sources, unioned, because the transaction store alone isn't enough:
    // an investments-only Item, or one linked but never synced, has no
    // persisted transaction state and would yield nothing.
    const accountIds = new Set(await getItemAccountIds(item_id));
    const cached = await readCache<{ institutions: any[] }>(NET_WORTH_CACHE_KEY);
    for (const inst of cached?.institutions ?? []) {
      if (inst.item_id !== item_id) continue;
      for (const a of inst.accounts ?? []) accountIds.add(a.account_id);
    }

    await removeItem(item_id);
    // Drop this Item's persisted sync cursor + transactions.
    await clearItemTransactions(item_id);
    await pruneHidden([...accountIds]);

    // Cached payloads no longer reflect the linked institutions.
    await clearCaches();

    return NextResponse.json({ success: true });
  } catch (err: any) {
    console.error(err);
    return NextResponse.json({ error: 'Failed to disconnect' }, { status: 500 });
  }
}
