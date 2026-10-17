import { NextResponse } from 'next/server';
import { createHash } from 'node:crypto';
import { dataCtx, containerUnavailable } from '@/lib/data-ctx';
import type { Ctx } from '@/lib/containers';
import { StoredDataUnreadableError, StoreRefusedError, describeUnreadable } from '@/lib/repo';
import { CategoryError, type CategoryUsage, type Taxonomy } from '@/lib/categories';
import { changeTaxonomy, ensureTaxonomy, newCategoryId } from '@/lib/category-store';
import { categoryUsage } from '@/lib/category-usage';
import { loadBudgets } from '@/lib/budget-store';
import { BudgetError } from '@/lib/budget-set';
import { budgetMonthsStore } from '@/lib/budget-months-store';
import {
  archiveCandidates,
  groupsWithBudgets,
  isTemplateId,
  planTemplate,
  readUndo,
  TEMPLATES,
  undoOf,
  undoTemplate,
  type TemplatePlan,
  type TemplateUndo,
  type UndoKept,
} from '@/lib/category-templates';

// Starter category templates (lib/category-templates.ts), for the Categories
// screen (components/CategoryTemplates.tsx). Each action reads what it needs
// strictly: the categories, the budgets (a group with a budget of its own
// keeps what it holds), the record of budgets by month (a group left empty
// that had a budget in a past month stays, so that month keeps it), and what
// uses each category it would archive or remove (lib/category-usage.ts, the
// stored rows of any date, never Plaid), so nothing is archived or removed on
// a read that failed.
//
//   preview { template }          what it would change: the plan, and `basis`,
//                                 a digest of its changes
//   apply   { template, basis }   applies it in one compare-and-set on the
//                                 stored set, worked out again on the set as
//                                 it is then, and refused (409, `changed`)
//                                 when that isn't what was previewed; answers
//                                 the set and the undo (what it changed, as it
//                                 was and as it made it)
//   undo    { undo }              puts back what an apply changed, as far as
//                                 it can, in one compare-and-set; answers the
//                                 set and what it kept, and why
//
// Errors are answered as the categories route answers them. Nothing here
// drops a cache: transactions are filed into categories after the cache
// (lib/activity.ts), so a change shows on the next load of the list.

const MAX_BODY_CHARS = 64 * 1024;
const BASIS = /^[0-9a-f]{64}$/;

/** A digest of a plan's changes: what a preview showed, for the apply. */
const digest = (signature: string) => createHash('sha256').update(signature).digest('hex');

/** An apply refused because what it would do is no longer what was
 *  previewed: answered 409 with `changed`, so the page previews again. */
class PlanChanged extends CategoryError {
  constructor() {
    super('Your categories changed since this was worked out, so nothing was changed.', 409);
  }
}

function failure(err: unknown, what: string): NextResponse {
  const unavailable = containerUnavailable(err);
  if (unavailable) return unavailable;
  if (err instanceof PlanChanged) return NextResponse.json({ error: err.message, changed: true }, { status: 409 });
  if (err instanceof StoredDataUnreadableError) {
    console.error('Stored data unreadable for a category template:', describeUnreadable(err));
    return NextResponse.json({ error: err.message, unreadable: true }, { status: 409 });
  }
  if (err instanceof CategoryError || err instanceof StoreRefusedError || err instanceof BudgetError) {
    return NextResponse.json({ error: err.message }, { status: err.status });
  }
  console.error(err);
  return NextResponse.json({ error: what }, { status: 500 });
}

/** What uses each category, a few at a time: each read is every stored row
 *  (lib/category-usage.ts), so they aren't all made at once. Strict. */
async function usageOf(ctx: Ctx, taxonomy: Taxonomy, ids: readonly string[]): Promise<Map<string, CategoryUsage>> {
  const out = new Map<string, CategoryUsage>();
  for (let i = 0; i < ids.length; i += 4) {
    const batch = ids.slice(i, i + 4);
    const got = await Promise.all(batch.map((id) => categoryUsage(ctx, taxonomy, id)));
    batch.forEach((id, k) => out.set(id, got[k]));
  }
  return out;
}

/** A plan as the page is sent it: everything but the set it would make. */
function shown(plan: TemplatePlan) {
  const { taxonomy: _set, signature, ...rest } = plan;
  return { ...rest, basis: digest(signature) };
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

    if (body.action === 'preview' || body.action === 'apply') {
      if (!isTemplateId(body.template)) return NextResponse.json({ error: 'Invalid request' }, { status: 400 });
      const basis = body.basis;
      if (body.action === 'apply' && (typeof basis !== 'string' || !BASIS.test(basis))) return NextResponse.json({ error: 'Invalid request' }, { status: 400 });
      const template = TEMPLATES[body.template];
      const start = await ensureTaxonomy(ctx);
      const [{ budgets }, months] = await Promise.all([loadBudgets(ctx), budgetMonthsStore.get(ctx)]);
      const recorded = groupsWithBudgets(months);
      const usage = await usageOf(ctx, start, archiveCandidates(start, template));
      if (body.action === 'preview') {
        return NextResponse.json({ preview: shown(planTemplate(start, template, { budgets, usage, recorded, newId: newCategoryId })) });
      }
      // Worked out again on the set as it is when it is saved, which may run
      // more than once: what was previewed, or nothing.
      const made: { plan?: TemplatePlan; before?: Taxonomy } = {};
      const after = await changeTaxonomy(ctx, (t) => {
        const plan = planTemplate(t, template, { budgets, usage, recorded, newId: newCategoryId });
        if (digest(plan.signature) !== basis) throw new PlanChanged();
        made.plan = plan;
        made.before = t;
        return plan.unchanged ? t : plan.taxonomy;
      });
      const undo: TemplateUndo = undoOf(template.id, made.before!, after);
      return NextResponse.json({ categories: after, undo, applied: shown(made.plan!) });
    }

    if (body.action === 'undo') {
      const undo = readUndo(body.undo);
      if (!undo) return NextResponse.json({ error: 'Invalid request' }, { status: 400 });
      const start = await ensureTaxonomy(ctx);
      const { budgets } = await loadBudgets(ctx);
      const added = undo.added.categories.filter((a) => start.categories.some((c) => c.id === a.id)).map((a) => a.id);
      const usage = await usageOf(ctx, start, added);
      const done: { kept: UndoKept[] } = { kept: [] };
      const after = await changeTaxonomy(ctx, (t) => {
        const r = undoTemplate(t, undo, { budgets, usage });
        done.kept = r.kept;
        return r.taxonomy;
      });
      return NextResponse.json({ categories: after, kept: done.kept });
    }

    return NextResponse.json({ error: 'Invalid request' }, { status: 400 });
  } catch (err) {
    return failure(err, 'Failed to change your categories');
  }
}
