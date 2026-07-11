import { NextResponse } from 'next/server';
import { plaidClient } from '@/lib/plaid';
import { decrypt } from '@/lib/crypto';
import { getItems, removeItem } from '@/lib/storage';

export async function POST(req: Request) {
  try {
    const { item_id } = await req.json();
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
    return NextResponse.json({ success: true });
  } catch (err: any) {
    console.error(err);
    return NextResponse.json({ error: 'Failed to disconnect' }, { status: 500 });
  }
}
