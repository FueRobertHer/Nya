import { NextResponse } from 'next/server';
import { dataCtx, containerUnavailable } from '@/lib/data-ctx';
import { setOverride } from '@/lib/overrides';
import { clearTransactionsCache } from '@/lib/cache';
import { editManualTxn, isManualTxnId, MANUAL_TXN_PREFIX } from '@/lib/manual-txns';
import { isManualId } from '@/lib/manual';
import { storeFailure } from '@/lib/store-failure';
import { choiceForId } from '@/lib/category-store';
import { CategoryError } from '@/lib/categories';

// Store a manual category for one transaction. The transactions route
// applies these overrides on top of Plaid's auto-categorization.
//
// The category is one of the person's (lib/categories.ts), chosen by id
// (`category_id`), and stored as that category's words (its first text key,
// choiceText), as overrides have always been stored: so a rename or a merge
// later changes nothing here, and the release before categories had ids, rolled
// back to, still reads it. A page from that release still sends the words
// themselves (`category`), stored as before.
//
// A manual row (lib/manual-txns.ts) has no bank's category under it to
// override: its category is the person's own, so it is changed on the row
// itself, and the row's edit form and the Activity tab's picker always agree.
// The page sends the account it shows the row on (`account_id`), so only that
// book is read. Manual rows aren't in the cached payload (the transactions
// route reads them on every request), so that cache stays.
// (When rules arrive, they should leave it alone as they leave an override.)

export async function POST(req: Request) {
  try {
    const ctx = await dataCtx();
    const { transaction_id, category_id, account_id, category: words } = await req.json();
    let category: unknown = words;
    if (typeof transaction_id !== 'string' || !transaction_id || transaction_id.length > 100) {
      return NextResponse.json({ error: 'Invalid transaction id' }, { status: 400 });
    }
    if (category_id !== undefined) {
      try {
        category = await choiceForId(ctx, category_id);
      } catch (err) {
        if (err instanceof CategoryError) return NextResponse.json({ error: err.message }, { status: err.status });
        throw err;
      }
    }
    if (typeof category !== 'string' || !category.trim() || category.length > 60) {
      return NextResponse.json({ error: 'Invalid category' }, { status: 400 });
    }

    if (transaction_id.startsWith(MANUAL_TXN_PREFIX)) {
      if (!isManualTxnId(transaction_id)) return NextResponse.json({ error: 'Invalid transaction id' }, { status: 400 });
      if (account_id !== undefined && (typeof account_id !== 'string' || account_id.length > 80 || !isManualId(account_id))) {
        return NextResponse.json({ error: 'Invalid account id' }, { status: 400 });
      }
      try {
        const saved = await editManualTxn(ctx, transaction_id, { category: category.trim().toLowerCase() }, { from: account_id });
        if (!saved) return NextResponse.json({ error: 'That transaction was deleted or moved since this page loaded. Reload to see it.' }, { status: 404 });
      } catch (err) {
        return storeFailure(err, 'Failed to recategorize');
      }
      return NextResponse.json({ success: true });
    }
    await setOverride(ctx, transaction_id, category.trim().toLowerCase());
    await clearTransactionsCache(ctx); // the cached payload has the old category

    return NextResponse.json({ success: true });
  } catch (err) {
    const unavailable = containerUnavailable(err);
    if (unavailable) return unavailable;
    console.error(err);
    return NextResponse.json({ error: 'Failed to recategorize' }, { status: 500 });
  }
}
