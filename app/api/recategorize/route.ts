import { NextResponse } from 'next/server';
import { dataCtx, containerUnavailable } from '@/lib/data-ctx';
import { setOverride } from '@/lib/overrides';
import { clearTransactionsCache } from '@/lib/cache';
import { editManualTxn, isManualTxnId, MANUAL_TXN_PREFIX } from '@/lib/manual-txns';
import { storeFailure } from '@/lib/store-failure';

// Store a manual category for one transaction. The transactions route
// applies these overrides on top of Plaid's auto-categorization.
//
// A manual row (lib/manual-txns.ts) has no bank's category under it to
// override: its category is the person's own, so it is changed on the row
// itself, and the row's edit form and the Activity tab's picker always agree.
// (When rules arrive, they should leave it alone as they leave an override.)

export async function POST(req: Request) {
  try {
    const ctx = await dataCtx();
    const { transaction_id, category } = await req.json();
    if (typeof transaction_id !== 'string' || !transaction_id || transaction_id.length > 100) {
      return NextResponse.json({ error: 'Invalid transaction id' }, { status: 400 });
    }
    if (typeof category !== 'string' || !category.trim() || category.length > 60) {
      return NextResponse.json({ error: 'Invalid category' }, { status: 400 });
    }

    if (transaction_id.startsWith(MANUAL_TXN_PREFIX)) {
      if (!isManualTxnId(transaction_id)) return NextResponse.json({ error: 'Invalid transaction id' }, { status: 400 });
      try {
        const saved = await editManualTxn(ctx, transaction_id, { category: category.trim().toLowerCase() });
        if (!saved) return NextResponse.json({ error: 'That transaction no longer exists' }, { status: 404 });
      } catch (err) {
        return storeFailure(err, 'Failed to recategorize');
      }
    } else {
      await setOverride(ctx, transaction_id, category.trim().toLowerCase());
    }
    await clearTransactionsCache(ctx); // the cached payload has the old category

    return NextResponse.json({ success: true });
  } catch (err) {
    const unavailable = containerUnavailable(err);
    if (unavailable) return unavailable;
    console.error(err);
    return NextResponse.json({ error: 'Failed to recategorize' }, { status: 500 });
  }
}
