import { NextResponse } from 'next/server';
import { dataCtx } from '@/lib/data-ctx';
import { clearTransactionsCache } from '@/lib/cache';
import { isTransactionId, setExcluded, TooManyAnnotationsError } from '@/lib/txn-annotations';
import { storeFailure } from '@/lib/store-failure';

// What the person says about one transaction (lib/txn-annotations.ts), one
// transaction per request: today, whether it is left out of budgets and
// reports. Any transaction, Plaid's or a manual one, by its transaction_id.
// The transactions route applies it on read, so the cached payload, which has
// the old flag, is dropped.

export async function PATCH(req: Request) {
  try {
    const ctx = await dataCtx();
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ error: 'Invalid request' }, { status: 400 });
    }
    const { transaction_id, excluded } = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>;
    if (!isTransactionId(transaction_id)) return NextResponse.json({ error: 'Invalid transaction id' }, { status: 400 });
    if (typeof excluded !== 'boolean') return NextResponse.json({ error: 'Say whether to exclude it' }, { status: 400 });

    const saved = await setExcluded(ctx, transaction_id, excluded);
    await clearTransactionsCache(ctx);
    return NextResponse.json({ transaction_id, excluded: saved?.excluded === true });
  } catch (err) {
    if (err instanceof TooManyAnnotationsError) return NextResponse.json({ error: err.message }, { status: 400 });
    return storeFailure(err, 'Failed to save that');
  }
}
