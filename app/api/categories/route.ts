import { NextResponse } from 'next/server';
import { dataCtx, containerUnavailable } from '@/lib/data-ctx';
import { StoredDataUnreadableError, StoreRefusedError, describeUnreadable } from '@/lib/repo';
import {
  addCategory,
  addGroup,
  CategoryError,
  deleteCategory,
  deleteGroup,
  mergeCategories,
  moveCategory,
  orderGroups,
  renameCategory,
  renameGroup,
  setArchived,
  setCategoryIcon,
  type Taxonomy,
} from '@/lib/categories';
import { changeTaxonomy, ensureTaxonomy, newCategoryId, readTaxonomy } from '@/lib/category-store';
import { categoryUsage } from '@/lib/category-usage';
import { loadBudgets, moveMergedBudgets } from '@/lib/budget-store';
import { BudgetError } from '@/lib/budget-set';

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
//   merge           { id, into }            (budgets on it move to `into`, added up)
//   delete-category { id }                  (only when nothing uses it)
//   add-group       { name, kind }
//   rename-group    { id, name }
//   order-groups    { ids }                 (every group's id, in the order wanted)
//   delete-group    { id }                  (only when empty, with no budget of its own)

const MAX_BODY_CHARS = 16 * 1024;
/** An id as the page sends one. */
const isId = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(v);

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

/** An id field of the body, or a refusal. */
function id(body: Record<string, unknown>, field = 'id'): string {
  const v = body[field];
  if (!isId(v)) throw new CategoryError('Invalid request');
  return v;
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

    let taxonomy: Taxonomy;
    switch (body.action) {
      case 'add-category':
        taxonomy = await changeTaxonomy(ctx, (t) => addCategory(t, { name: body.name, group: body.group, icon: body.icon }, newCategoryId).taxonomy);
        break;
      case 'rename-category': {
        const target = id(body);
        taxonomy = await changeTaxonomy(ctx, (t) => renameCategory(t, target, body.name));
        break;
      }
      case 'set-icon': {
        const target = id(body);
        taxonomy = await changeTaxonomy(ctx, (t) => setCategoryIcon(t, target, body.icon));
        break;
      }
      case 'move-category': {
        const target = id(body);
        taxonomy = await changeTaxonomy(ctx, (t) => moveCategory(t, target, body.group));
        break;
      }
      case 'archive': {
        const target = id(body);
        if (typeof body.archived !== 'boolean') throw new CategoryError('Invalid request');
        const archived = body.archived;
        taxonomy = await changeTaxonomy(ctx, (t) => setArchived(t, target, archived));
        break;
      }
      case 'merge': {
        const target = id(body);
        const into = id(body, 'into');
        taxonomy = await changeTaxonomy(ctx, (t) => mergeCategories(t, target, into));
        // Its budget moves to the one it went into. Counted together already
        // (lib/budget-set.ts placeBudgets), so a failure here loses nothing:
        // the next save moves it.
        await moveMergedBudgets(ctx, taxonomy);
        break;
      }
      case 'delete-category': {
        const target = id(body);
        // What uses it, read strictly before anything is changed. A use added
        // between this read and the delete (another device choosing it) is
        // words that file nowhere afterwards: the next load gives them a
        // category again.
        const usage = await categoryUsage(ctx, (await readTaxonomy(ctx)) ?? (await ensureTaxonomy(ctx)), target);
        taxonomy = await changeTaxonomy(ctx, (t) => deleteCategory(t, target, usage));
        break;
      }
      case 'add-group':
        taxonomy = await changeTaxonomy(ctx, (t) => addGroup(t, { name: body.name, kind: body.kind }, newCategoryId).taxonomy);
        break;
      case 'rename-group': {
        const target = id(body);
        taxonomy = await changeTaxonomy(ctx, (t) => renameGroup(t, target, body.name));
        break;
      }
      case 'order-groups':
        taxonomy = await changeTaxonomy(ctx, (t) => orderGroups(t, body.ids));
        break;
      case 'delete-group': {
        const target = id(body);
        const { budgets } = await loadBudgets(ctx);
        taxonomy = await changeTaxonomy(ctx, (t) => deleteGroup(t, target, budgets.groups[target] !== undefined));
        break;
      }
      default:
        return NextResponse.json({ error: 'Invalid request' }, { status: 400 });
    }
    return NextResponse.json({ categories: taxonomy });
  } catch (err) {
    return failure(err, 'Failed to change your categories');
  }
}
