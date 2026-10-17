import { NextResponse } from 'next/server';
import { dataCtx } from '@/lib/data-ctx';
import { forgetOverrides, getOverride, setOverride } from '@/lib/overrides';
import { clearTransactionsCache } from '@/lib/cache';
import { editManualTxn, findManualTxn, isManualTxnId, MANUAL_TXN_PREFIX } from '@/lib/manual-txns';
import { isManualId } from '@/lib/manual';
import { storeFailure } from '@/lib/store-failure';
import { choiceForId, taxonomyForReading } from '@/lib/category-store';
import { categoryById, CategoryError, indexTaxonomy } from '@/lib/categories';
import { noteRecategorized, todayOf } from '@/lib/review-store';
import { recordCategorization } from '@/lib/vendor-default-store';
import { isVendorKey, MAX_VENDOR_NAME } from '@/lib/vendor-defaults';
import { loggable } from '@/lib/log-safe';

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
//
// A MERCHANT'S DEFAULT (lib/vendor-defaults.ts). With the merchant's vendor
// key (`vendor_key`, and `name`, the merchant as shown, for the Defaults
// list), a category chosen by id counts as one of the merchant's last three
// categorizations, and its default changes when two of those agree
// (lib/vendor-default-store.ts recordCategorization; `today`, the page's day,
// is the day a new default files from). Best effort: the category is saved
// whether or not the vote can be, and the answer says what the vote did
// (`vendor`: the merchant's entry before and after, for an undo).
//
// AN APPROVED TRANSACTION (lib/review-store.ts) keeps its approval, which now
// holds the category chosen (noteRecategorized), best effort too.
//
// AN UNDO. The answer says what the category was before (`previous`: the
// words chosen for it before, or null for none, when that could be read), and
// `{ transaction_id, account_id?, restore: { category } }` puts exactly that
// back (Card Mode's undo): null takes the person's choice off a bank's row,
// so the bank's category (or a rule's, or a default's) shows again.

/** What an undo puts back: the words chosen before, or none. */
function isRestore(v: unknown): v is { category: string | null } {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
  const r = v as Record<string, unknown>;
  return Object.keys(r).every((k) => k === 'category') && (r.category === null || (typeof r.category === 'string' && !!r.category.trim() && r.category.length <= 60));
}

export async function POST(req: Request) {
  try {
    const ctx = await dataCtx();
    const { transaction_id, category_id, account_id, category: words, vendor_key, name, today, restore } = await req.json();
    let category: unknown = words;
    if (typeof transaction_id !== 'string' || !transaction_id || transaction_id.length > 100) {
      return NextResponse.json({ error: 'Invalid transaction id' }, { status: 400 });
    }
    const manual = transaction_id.startsWith(MANUAL_TXN_PREFIX);
    if (manual) {
      if (!isManualTxnId(transaction_id)) return NextResponse.json({ error: 'Invalid transaction id' }, { status: 400 });
      if (account_id !== undefined && (typeof account_id !== 'string' || account_id.length > 80 || !isManualId(account_id))) {
        return NextResponse.json({ error: 'Invalid account id' }, { status: 400 });
      }
    }
    if (vendor_key !== undefined && !isVendorKey(vendor_key)) return NextResponse.json({ error: 'Invalid vendor key' }, { status: 400 });
    if (name !== undefined && (typeof name !== 'string' || name.length > MAX_VENDOR_NAME)) return NextResponse.json({ error: 'Invalid name' }, { status: 400 });
    if (today !== undefined && typeof today !== 'string') return NextResponse.json({ error: 'Invalid day' }, { status: 400 });

    if (restore !== undefined) {
      if (!isRestore(restore) || category_id !== undefined || words !== undefined || vendor_key !== undefined) {
        return NextResponse.json({ error: 'Say what to put back: the category it had before, or none' }, { status: 400 });
      }
      if (manual) {
        try {
          const saved = await editManualTxn(ctx, transaction_id, { category: restore.category }, { from: account_id });
          if (!saved) return NextResponse.json({ error: 'That transaction was deleted or moved since this page loaded. Reload to see it.' }, { status: 404 });
        } catch (err) {
          return storeFailure(err, 'Failed to put the category back');
        }
        return NextResponse.json({ success: true });
      }
      if (restore.category === null) await forgetOverrides(ctx, [transaction_id]);
      else await setOverride(ctx, transaction_id, restore.category);
      await clearTransactionsCache(ctx); // the cached payload has the category undone
      return NextResponse.json({ success: true });
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

    // What it had before, for an undo: the words chosen for it, or none. Not
    // known (left out of the answer) when that can't be read.
    let previous: { category: string | null } | undefined;
    if (manual) {
      const found = await findManualTxn(ctx, transaction_id, account_id).catch(() => null);
      previous = found ? { category: found.row.category } : undefined;
      try {
        const saved = await editManualTxn(ctx, transaction_id, { category: category.trim().toLowerCase() }, { from: account_id });
        if (!saved) return NextResponse.json({ error: 'That transaction was deleted or moved since this page loaded. Reload to see it.' }, { status: 404 });
      } catch (err) {
        return storeFailure(err, 'Failed to recategorize');
      }
    } else {
      previous = await getOverride(ctx, transaction_id)
        .then((c) => ({ category: c }))
        .catch(() => undefined);
      await setOverride(ctx, transaction_id, category.trim().toLowerCase());
      await clearTransactionsCache(ctx); // the cached payload has the old category
    }

    // A category chosen by id: what its approval holds, and one of the
    // merchant's last three categorizations. Neither stops the change above.
    let vendor: Record<string, unknown> | undefined;
    if (category_id !== undefined) {
      try {
        const ix = indexTaxonomy((await taxonomyForReading(ctx)).taxonomy);
        const chosen = categoryById(ix, String(category_id));
        if (chosen) {
          await noteRecategorized(ctx, transaction_id, chosen.id).catch((err) => console.warn('recategorize: the approval was left as it was', loggable(err)));
          if (vendor_key !== undefined && !manual) {
            const resolve = (id: string) => categoryById(ix, id)?.id ?? null;
            const vote = await recordCategorization(ctx, { vendor_key, name: typeof name === 'string' ? name.trim() : '', category_id: chosen.id }, { resolve, today: todayOf(today) });
            if (vote) {
              vendor = { entry: vote.entry, previous: vote.previous, changed: vote.changed };
            }
          }
        }
      } catch (err) {
        console.warn('recategorize: the merchant’s categorization was not recorded', loggable(err));
      }
    }

    return NextResponse.json({ success: true, ...(previous ? { previous } : {}), ...(vendor ? { vendor } : {}) });
  } catch (err) {
    // The seam's answers (lib/store-failure.ts): categories or overrides that
    // can't be read are 409 and flagged, a change that kept losing its
    // compare-and-set its own 409, no usable container 503.
    return storeFailure(err, 'Failed to recategorize');
  }
}
