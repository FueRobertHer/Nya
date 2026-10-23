import { NextResponse } from 'next/server';
import { dataCtx, containerUnavailable } from '@/lib/data-ctx';
import { StoredDataUnreadableError, StoreRefusedError, describeUnreadable } from '@/lib/repo';
import { CategoryError, type Taxonomy } from '@/lib/categories';
import { ensureTaxonomy } from '@/lib/category-store';
import { BudgetError } from '@/lib/budget-set';
import { changeCategories } from '@/lib/category-actions';

// Your categories and their groups (lib/categories.ts), for the Categories
// screen under Manage (components/CategoryManager.tsx) and the lists to choose
// a category from.
//
// GET answers the set (`categories`), made on the first read (lib/
// category-store.ts).
//
// POST makes one change, named by `action`, and answers the set as it is
// after it. Each change is one compare-and-set on the stored set, so growing
// it on another request never loses it; a change refused says why (400 a bad
// request, 404 something gone since the page loaded, 409 not now, with what to
// do instead). Nothing here drops a cache: transactions are filed into
// categories after the cache (lib/activity.ts), so a rename, a move or a merge
// shows on the next load of the list.
//
//   add-category    { name, group, icon? }
//   rename-category { id, name }
//   set-icon        { id, icon }            (empty clears it)
//   move-category   { id, group }           (a group of another kind changes how it counts)
//   archive         { id, archived }
//   merge           { id, into }            (budgets on it move to `into`, added up,
//                                            with what they had by month and their
//                                            rollover, lib/budget-months-store.ts)
//   delete-category { id }                  (only when nothing uses it; its record
//                                            of budgets by month goes with it)
//   add-group       { name, kind }
//   rename-group    { id, name }
//   order-groups    { ids }                 (every group's id, in the order wanted)
//   delete-group    { id }                  (only when empty, with no budget of its own)
//
// Each action is lib/category-actions.ts, which the API's writes call too.

const MAX_BODY_CHARS = 16 * 1024;

function failure(err: unknown, what: string): NextResponse {
  const unavailable = containerUnavailable(err);
  if (unavailable) return unavailable;
  if (err instanceof StoredDataUnreadableError) {
    console.error('Stored categories unreadable:', describeUnreadable(err));
    return NextResponse.json({ error: err.message, unreadable: true }, { status: 409 });
  }
  if (err instanceof CategoryError || err instanceof StoreRefusedError || err instanceof BudgetError) {
    return NextResponse.json({ error: err.message }, { status: err.status });
  }
  console.error(err);
  return NextResponse.json({ error: what }, { status: 500 });
}

export async function GET() {
  try {
    const ctx = await dataCtx();
    return NextResponse.json({ categories: await ensureTaxonomy(ctx) });
  } catch (err) {
    return failure(err, 'Failed to load your categories');
  }
}

export async function POST(req: Request) {
  try {
    const ctx = await dataCtx();
    const text = await req.text();
    if (text.length > MAX_BODY_CHARS) return NextResponse.json({ error: 'Request too large' }, { status: 413 });
    let body: Record<string, unknown>;
    try {
      const parsed = JSON.parse(text);
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('not an object');
      body = parsed;
    } catch {
      return NextResponse.json({ error: 'Invalid request' }, { status: 400 });
    }

    const taxonomy: Taxonomy | null = await changeCategories(ctx, body);
    if (!taxonomy) return NextResponse.json({ error: 'Invalid request' }, { status: 400 });
    return NextResponse.json({ categories: taxonomy });
  } catch (err) {
    return failure(err, 'Failed to change your categories');
  }
}
