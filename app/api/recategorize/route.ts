import { NextResponse } from 'next/server';
import { setOverride } from '@/lib/overrides';
import { clearTransactionsCache } from '@/lib/cache';

// Store a manual category for one transaction. The transactions route
// applies these overrides on top of Plaid's auto-categorization.

export async function POST(req: Request) {
  try {
    const { transaction_id, category } = await req.json();
    if (typeof transaction_id !== 'string' || !transaction_id || transaction_id.length > 100) {
      return NextResponse.json({ error: 'Invalid transaction id' }, { status: 400 });
    }
    if (typeof category !== 'string' || !category.trim() || category.length > 60) {
      return NextResponse.json({ error: 'Invalid category' }, { status: 400 });
    }

    await setOverride(transaction_id, category.trim().toLowerCase());
    await clearTransactionsCache(); // the cached payload has the old category

    return NextResponse.json({ success: true });
  } catch (err) {
    console.error(err);
    return NextResponse.json({ error: 'Failed to recategorize' }, { status: 500 });
  }
}
