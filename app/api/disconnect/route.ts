import { NextResponse } from 'next/server';
import { dataCtx, containerUnavailable } from '@/lib/data-ctx';
import { getItems } from '@/lib/storage';
import { MANUAL_ITEM_PREFIX } from '@/lib/manual';
import { disconnectItem } from '@/lib/disconnect-item';

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

    await disconnectItem(ctx, item_id, item);

    return NextResponse.json({ success: true });
  } catch (err: any) {
    const unavailable = containerUnavailable(err);
    if (unavailable) return unavailable;
    console.error(err);
    return NextResponse.json({ error: 'Failed to disconnect' }, { status: 500 });
  }
}
