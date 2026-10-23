// lib/category-actions.ts
//
// The changes to your categories and their groups (lib/categories.ts) that
// app/api/categories makes, one action per request, and that the API's
// writes make (lib/api-writes.ts), in one place so the two never differ.
// Each change is one compare-and-set on the stored set (lib/category-store.ts
// changeTaxonomy) running the same pure operations; a change refused throws
// CategoryError (400 a bad request, 404 something gone since, 409 not now).
// The route's header says what each action does.

import type { Ctx } from './containers';
import { StoredDataUnreadableError, describeUnreadable } from './repo';
import { loggable } from './log-safe';
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
  type Category,
  type CategoryGroup,
  type Taxonomy,
} from './categories';
import { changeTaxonomy, ensureTaxonomy, newCategoryId, readTaxonomy } from './category-store';
import { categoryUsage } from './category-usage';
import { loadBudgets, moveMergedBudgets } from './budget-store';
import { dropMonths, moveMergedMonths } from './budget-months-store';

/** An id as the page sends one. */
const isId = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(v);

/** An id field of the body, or a refusal. */
function id(body: Record<string, unknown>, field = 'id'): string {
  const v = body[field];
  if (!isId(v)) throw new CategoryError('Invalid request');
  return v;
}

/** A deleted category's or group's record of budgets by month dropped (it
 *  had no budget, or it couldn't have been deleted). Best effort: one left
 *  behind is read as gone, and dropped by the next note of the budget set
 *  (lib/rollover.ts noteBudgets). */
async function dropDeleted(ctx: Ctx, kind: 'categories' | 'groups', id: string): Promise<void> {
  try {
    await dropMonths(ctx, kind, id);
  } catch (err) {
    console.error('Deleted a category or group; its budgets by month go on the next change:', err instanceof StoredDataUnreadableError ? describeUnreadable(err) : loggable(err));
  }
}

/**
 * Makes the one change a request names by `action`, and answers the set as it
 * is after it; null for an action there is none of. Throws CategoryError,
 * BudgetError or what the seam throws.
 */
export async function changeCategories(ctx: Ctx, body: Record<string, unknown>): Promise<Taxonomy | null> {
  switch (body.action) {
    case 'add-category':
      return (await addCategoryAs(ctx, { name: body.name, group: body.group, icon: body.icon }, newCategoryId())).taxonomy;
    case 'rename-category': {
      const target = id(body);
      return changeTaxonomy(ctx, (t) => renameCategory(t, target, body.name));
    }
    case 'set-icon': {
      const target = id(body);
      return changeTaxonomy(ctx, (t) => setCategoryIcon(t, target, body.icon));
    }
    case 'move-category': {
      const target = id(body);
      return changeTaxonomy(ctx, (t) => moveCategory(t, target, body.group));
    }
    case 'archive': {
      const target = id(body);
      if (typeof body.archived !== 'boolean') throw new CategoryError('Invalid request');
      const archived = body.archived;
      return changeTaxonomy(ctx, (t) => setArchived(t, target, archived));
    }
    case 'merge': {
      const target = id(body);
      const into = id(body, 'into');
      const taxonomy = await changeTaxonomy(ctx, (t) => mergeCategories(t, target, into));
      // Its budget moves to the one it went into. Counted together already
      // (lib/budget-set.ts placeBudgets follows the merge), so a failure here
      // loses nothing, and the merge, saved, is answered as made: the next
      // save of budgets moves it.
      try {
        await moveMergedBudgets(ctx, taxonomy);
      } catch (err) {
        console.error('Merged categories; their budgets move on the next save:', err instanceof StoredDataUnreadableError ? describeUnreadable(err) : loggable(err));
      }
      // And what they had by month, and their rollover: read as merged
      // meanwhile too (lib/rollover.ts placeMonths), so a failure here loses
      // nothing either.
      try {
        await moveMergedMonths(ctx, taxonomy);
      } catch (err) {
        console.error('Merged categories; their budgets by month move on the next change:', err instanceof StoredDataUnreadableError ? describeUnreadable(err) : loggable(err));
      }
      return taxonomy;
    }
    case 'delete-category':
      return deleteCategoryNow(ctx, id(body));
    case 'add-group':
      return (await addGroupAs(ctx, { name: body.name, kind: body.kind }, newCategoryId())).taxonomy;
    case 'rename-group': {
      const target = id(body);
      return changeTaxonomy(ctx, (t) => renameGroup(t, target, body.name));
    }
    case 'order-groups':
      return changeTaxonomy(ctx, (t) => orderGroups(t, body.ids));
    case 'delete-group':
      return deleteGroupNow(ctx, id(body));
    default:
      return null;
  }
}

/**
 * Adds a category under `newId` (minted by the caller, so a create sent
 * again finds its own: `created` false, the set as it is), in one
 * compare-and-set. `check`, run inside it on the set as read, may refuse by
 * throwing (the API keeps room for the categories a bank adds).
 */
export async function addCategoryAs(
  ctx: Ctx,
  input: { name: unknown; group: unknown; icon?: unknown },
  newId: string,
  check?: (t: Taxonomy) => void
): Promise<{ taxonomy: Taxonomy; category: Category; created: boolean }> {
  let created = false;
  const taxonomy = await changeTaxonomy(ctx, (t) => {
    created = false; // this may run more than once
    if (t.categories.some((c) => c.id === newId)) return t;
    check?.(t);
    created = true;
    return addCategory(t, input, () => newId).taxonomy;
  });
  return { taxonomy, category: taxonomy.categories.find((c) => c.id === newId)!, created };
}

/** Adds a group under `newId`, as addCategoryAs adds a category. */
export async function addGroupAs(
  ctx: Ctx,
  input: { name: unknown; kind: unknown },
  newId: string,
  check?: (t: Taxonomy) => void
): Promise<{ taxonomy: Taxonomy; group: CategoryGroup; created: boolean }> {
  let created = false;
  const taxonomy = await changeTaxonomy(ctx, (t) => {
    created = false;
    if (t.groups.some((g) => g.id === newId)) return t;
    check?.(t);
    created = true;
    return addGroup(t, input, () => newId).taxonomy;
  });
  return { taxonomy, group: taxonomy.groups.find((g) => g.id === newId)!, created };
}

/** What a change to one category may set: any of these, each the app's own
 *  action. */
export type CategoryEdit = { name?: unknown; group?: unknown; icon?: unknown; archived?: boolean };

/**
 * Changes one category: its name, its group, its icon and whether it is
 * archived, in that order, the app's actions on one copy of the set, in one
 * compare-and-set: all of it or none. `check` runs inside it on the category
 * as read (the API's version), and may refuse by throwing.
 */
export async function editCategory(ctx: Ctx, target: string, edit: CategoryEdit, check?: (c: Category | null, t: Taxonomy) => void): Promise<Taxonomy> {
  return changeTaxonomy(ctx, (t0) => {
    check?.(t0.categories.find((c) => c.id === target) ?? null, t0);
    let t = t0;
    if (edit.name !== undefined) t = renameCategory(t, target, edit.name);
    if (edit.group !== undefined) t = moveCategory(t, target, edit.group);
    if (edit.icon !== undefined) t = setCategoryIcon(t, target, edit.icon);
    if (edit.archived !== undefined) t = setArchived(t, target, edit.archived);
    return t;
  });
}

/** Renames one group, as editCategory changes a category. */
export async function editGroup(ctx: Ctx, target: string, name: unknown, check?: (g: CategoryGroup | null, t: Taxonomy) => void): Promise<Taxonomy> {
  return changeTaxonomy(ctx, (t) => {
    check?.(t.groups.find((g) => g.id === target) ?? null, t);
    return renameGroup(t, target, name);
  });
}

/**
 * Deletes a category, only when nothing uses it. What uses it is read
 * strictly before anything is changed, for the keys it has now: a merge into
 * it before the delete lands changes them, and the delete is refused
 * (lib/categories.ts deleteCategory). A use added in between otherwise
 * (another device choosing it) is words that file nowhere afterwards: the
 * next load gives them a category again. Its record of budgets by month goes
 * with it. `check` runs inside the compare-and-set on the category as read.
 */
export async function deleteCategoryNow(ctx: Ctx, target: string, check?: (c: Category | null) => void): Promise<Taxonomy> {
  const usage = await categoryUsage(ctx, (await readTaxonomy(ctx)) ?? (await ensureTaxonomy(ctx)), target);
  const taxonomy = await changeTaxonomy(ctx, (t) => {
    check?.(t.categories.find((c) => c.id === target) ?? null);
    return deleteCategory(t, target, usage);
  });
  await dropDeleted(ctx, 'categories', target);
  return taxonomy;
}

/** Deletes a group, only when it is empty and has no budget of its own. */
export async function deleteGroupNow(ctx: Ctx, target: string, check?: (g: CategoryGroup | null) => void): Promise<Taxonomy> {
  const { budgets } = await loadBudgets(ctx);
  const taxonomy = await changeTaxonomy(ctx, (t) => {
    check?.(t.groups.find((g) => g.id === target) ?? null);
    return deleteGroup(t, target, budgets.groups[target] !== undefined);
  });
  await dropDeleted(ctx, 'groups', target);
  return taxonomy;
}
