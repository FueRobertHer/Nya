import { NextResponse } from 'next/server';
import { plaidClient } from '@/lib/plaid';
import { decrypt } from '@/lib/crypto';
import { getItems, removeItem } from '@/lib/storage';
import { clearCaches } from '@/lib/cache';
import { clearItemTransactions } from '@/lib/transactions';
import { MANUAL_ITEM_PREFIX } from '@/lib/manual';

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

    await removeItem(item_id);
    // Drop this Item's persisted sync cursor + transactions.
    await clearItemTransactions(item_id);

    // Cached payloads no longer reflect the linked institutions.
    await clearCaches();

    return NextResponse.json({ success: true });
  } catch (err: any) {
    console.error(err);
    return NextResponse.json({ error: 'Failed to disconnect' }, { status: 500 });
  }
}
