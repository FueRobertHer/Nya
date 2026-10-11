import { NextResponse } from 'next/server';
import { dataCtx, containerUnavailable } from '@/lib/data-ctx';
import { StoredDataUnreadableError, StoreRefusedError, describeUnreadable } from '@/lib/repo';
import { loadBudgets, saveBudgets } from '@/lib/budget-store';
import { BudgetError, budgetsFromNames, legacyCopy, readBudgets, MAX_CATEGORY_BUDGETS, type Budgets } from '@/lib/budget-set';
import { indexTaxonomy, textKeys, type Taxonomy } from '@/lib/categories';
import { ensureTaxonomy } from '@/lib/category-store';
import { noteMonths } from '@/lib/budget-months-store';
import { isMonth, thisMonth } from '@/lib/rollover';

// Monthly budgets, per category and per group, by id (lib/budget-set.ts),
// kept by lib/budget-store.ts, which moves the budgets saved under names
// before categories had ids the first time they are read, and keeps a
// name-keyed copy the release before this one reads (see its header).
//
// GET answers the budgets (`budget_set`: { categories, groups }, each id to
// { amount }), the categories they are in (`categories`), and, for a page
// from the release before this one still open after a deploy, the category
// budgets by the words that release files transactions under (`budgets`).
//
// PUT replaces the budgets whole, as the Budgets tab sends them
// (`budget_set`). A page from the release before sends `budgets`, by name:
// those become the category budgets, each on the category its words file
// into, and the groups' budgets, which that page never saw, are kept.
//
// BY MONTH (#37). A save changes this month's amounts, never an earlier
// month's: the record of budgets by month (lib/budget-months-store.ts) keeps
// what each changed budget had, for the months before this one. `month` is
// this month as the page has it (lib/rollover.ts thisMonth; the UTC month
// without one, as from a page of the release before). The record is noted
// before anything is written, so a save it can't record (it can't be read) is
// refused, with 409 and `unreadable`, rather than rewriting the months before
// it with the new amount. A failure to record after the budgets are saved
// leaves them saved: the next read of the month notes the change, as of the
// month it is read in.

/** The answer for both: the budgets, their categories, and the copy by name. */
function answer(budgets: Budgets, taxonomy: Taxonomy) {
  return { budget_set: budgets, budgets: legacyCopy(budgets, indexTaxonomy(taxonomy)), categories: taxonomy };
}

/** What a failure answers: the container (503); stored data that can't be
 *  read (409, flagged, so the page never shows "none" and saves over it);
 *  the seam refusing a write, or a change refused (their status). */
function failure(err: unknown, what: string): NextResponse {
  const unavailable = containerUnavailable(err);
  if (unavailable) return unavailable;
  if (err instanceof StoredDataUnreadableError) {
    console.error('Stored budgets unreadable:', describeUnreadable(err));
    return NextResponse.json({ error: err.message, unreadable: true }, { status: 409 });
  }
  if (err instanceof StoreRefusedError || err instanceof BudgetError) return NextResponse.json({ error: err.message }, { status: err.status });
  console.error(err);
  return NextResponse.json({ error: what }, { status: 500 });
}

export async function GET() {
  try {
    const ctx = await dataCtx();
    const { budgets, taxonomy } = await loadBudgets(ctx);
    return NextResponse.json(answer(budgets, taxonomy));
  } catch (err) {
    return failure(err, 'Failed to load budgets');
  }
}

/** Budgets by name, as a page from the release before this one sends them:
 *  checked as that release checked them. */
function readNamed(v: unknown): Record<string, number> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new BudgetError('Invalid budgets');
  const entries = Object.entries(v);
  if (entries.length > MAX_CATEGORY_BUDGETS) throw new BudgetError('Too many budgets');
  const out: Record<string, number> = {};
  for (const [category, amount] of entries) {
    const name = String(category).trim().slice(0, 60);
    const value = Number(amount);
    if (!name || !Number.isFinite(value) || value <= 0) throw new BudgetError('Invalid budget entry');
    out[name] = value;
  }
  return out;
}

export async function PUT(req: Request) {
  try {
    const ctx = await dataCtx();
    const body = await req.json().catch(() => null);
    if (typeof body !== 'object' || body === null || Array.isArray(body)) return NextResponse.json({ error: 'Invalid budgets' }, { status: 400 });
    if (body.month !== undefined && !isMonth(body.month)) return NextResponse.json({ error: 'Invalid month' }, { status: 400 });
    const month = thisMonth(body.month);
    // Migrated first, so what is replaced is what this page was shown.
    const current = await loadBudgets(ctx);
    // Strict: a record that can't be read refuses the save before anything is
    // written (see BY MONTH).
    await noteMonths(ctx, current.budgets, current.taxonomy, month);
    let next: Budgets;
    let taxonomy = current.taxonomy;
    if (body.budget_set !== undefined) {
      next = readBudgets(body.budget_set);
    } else {
      const named = readNamed(body.budgets);
      taxonomy = await ensureTaxonomy(ctx, { required: textKeys(Object.keys(named)) });
      next = { categories: budgetsFromNames(named, indexTaxonomy(taxonomy)).categories, groups: current.budgets.groups };
    }
    const saved = await saveBudgets(ctx, next, taxonomy);
    try {
      await noteMonths(ctx, saved, taxonomy, month, current.budgets);
    } catch (err) {
      console.error('Budgets saved; the change is recorded by month on the next read:', err instanceof StoredDataUnreadableError ? describeUnreadable(err) : err instanceof Error ? err.name : typeof err);
    }
    return NextResponse.json(answer(saved, taxonomy));
  } catch (err) {
    return failure(err, 'Failed to save budgets');
  }
}
