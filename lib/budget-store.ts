// lib/budget-store.ts
//
// Your budgets by category id and by group id (lib/budget-set.ts): the
// `budget-set` value store on the storage seam, and how budgets move to it
// from the blob earlier releases keep them in by name (lib/budgets.ts), while
// staying readable there.
//
// THE MIGRATION. The first time the app reads budgets after this release,
// each budget saved under a name moves to the category those words file into
// (lib/categories.ts text keys; the category set is grown first so every name
// has one, past any limit), and the set is stored. Names that land in one
// category add up. Run again it finds the set stored and changes nothing. The
// name-keyed blob is never deleted.
//
// MIRROR: WHAT A ROLLBACK SEES. Every save writes the set, then the
// name-keyed blob, with the category budgets under each category's first
// text key (legacyCopy): the words the release before this one files those
// transactions under. So that release, rolled back to, reads every category
// budget as last saved here (a renamed category's under its old words, a
// merged one's under the words of the one it went into), and never a group's,
// which it has no place for. The set keeps the copy it last wrote (`mirror`),
// and what the blob held before (`mirror_before`, until the blob is written),
// so a read here knows which of these it is looking at:
//   - in sync: the blob is the copy last written. The set is the budgets.
//   - unfinished: the blob is still what it was before the last save (the
//     save stopped between its writes). The save is finished.
//   - changed: anything else, which only that release writes, after a
//     rollback. Its category budgets are taken in, by name, as on the first
//     read; the groups' budgets, which it never saw, are kept.
// OVERLAPPING SAVES (two devices) each write the set by compare-and-set, so
// the set is always one save whole; the blob is written plainly, so a slow
// save's blob write can land after a later save's. Whoever writes the blob
// reads the set again after it, and writes the set's copy instead when it is
// no longer its own (writeCopy), so the last to write the blob always leaves
// it the copy of the set as last saved, never a copy that would read as a
// rollback's change. What is left is the moment between such a stale write
// and its correction: a read landing exactly then reads it as changed. A
// read takes a change in only over the set it read beside the blob, so a
// save landing between the two is read again, never overwritten.
//
// READS ARE STRICT. Both stores are read strictly before anything is decided:
// a blob or a set that can't be read stops the read with
// StoredDataUnreadableError (the route answers 409 and the Budgets tab says
// so), and nothing is ever saved over either.

import { defineValueStore, UpdateConflictError } from './repo';
import type { Ctx } from './containers';
import { getBudgets, getBudgetsReport, setBudgets } from './budgets';
import { categoryById, indexTaxonomy, isProvisionalId, textKeys, type CategoryIndex, type Taxonomy } from './categories';
import { ensureTaxonomy, grown, provisionalIds } from './category-store';
import {
  BudgetError,
  budgetsAfterMerge,
  budgetsFromNames,
  isBudgetSet,
  legacyBudgets,
  legacyCopy,
  mirrorState,
  sameLegacy,
  BUDGET_SET_VERSION,
  type BudgetSet,
  type Budgets,
} from './budget-set';

export const budgetSetStore = defineValueStore<BudgetSet>('budget-set', {
  what: 'budgets',
  isValid: isBudgetSet,
  exportable: true, // what the person set; the download's budgets section shows it by name
});

const budgetsOf = (set: BudgetSet): Budgets => ({ categories: set.categories, groups: set.groups });

/** The category budgets taken in by name (the first read, or after a
 *  rollback changed them), the groups' kept. Every name has a category: the
 *  set was grown with them, past any limit. */
function takeIn(cur: BudgetSet | null, legacy: Record<string, number>, ix: CategoryIndex): BudgetSet {
  const { categories, unplaced } = budgetsFromNames(legacy, ix);
  if (unplaced.length > 0) throw new Error(`budgets: ${unplaced.length} budget name(s) have no category to move to`);
  return { version: BUDGET_SET_VERSION, categories, groups: cur?.groups ?? {}, mirror: legacy, mirror_before: null };
}

/** Writes of the name-keyed copy one save makes at most, chasing saves that
 *  land meanwhile (see OVERLAPPING SAVES). */
const COPY_WRITES = 5;

/**
 * Writes the name-keyed copy, then reads the set again: when another save
 * has written the set since (its copy isn't this one), writes that save's
 * copy instead, until the blob holds the set's. Then forgets what the blob
 * held before the save. Past COPY_WRITES the saves still landing write the
 * blob after this one, and check it after themselves.
 */
async function writeCopy(ctx: Ctx, copy: Record<string, number>): Promise<void> {
  let wrote = copy;
  for (let writes = 1; ; writes++) {
    await setBudgets(ctx, wrote);
    const now = await budgetSetStore.get(ctx);
    if (!now) return;
    if (sameLegacy(now.mirror, wrote)) break;
    if (writes >= COPY_WRITES) {
      console.error(`budgets: the name-keyed copy kept changing under ${COPY_WRITES} writes; the saves still landing write it after this one`);
      return;
    }
    wrote = now.mirror;
  }
  const settled = wrote;
  await budgetSetStore.update(ctx, (cur) => (cur && cur.mirror_before !== null && sameLegacy(cur.mirror, settled) ? { ...cur, mirror_before: null } : cur));
}

/** Reads of both stores loadBudgets makes before giving up, when a save
 *  keeps landing between its read and its write. */
const LOAD_ATTEMPTS = 3;

/**
 * The budgets, for the app: migrated from the name-keyed blob the first time,
 * a stopped save finished, a rollback's changes taken in (see the header).
 * Grows the category set by the blob's names first, so it answers the set
 * the budgets are in. Writes only in those three cases. Strict.
 */
export async function loadBudgets(ctx: Ctx): Promise<{ budgets: Budgets; taxonomy: Taxonomy }> {
  for (let attempt = 1; ; attempt++) {
    const legacy = legacyBudgets(await getBudgets(ctx));
    const taxonomy = await ensureTaxonomy(ctx, { required: textKeys(Object.keys(legacy)) });
    const ix = indexTaxonomy(taxonomy);
    const set = await budgetSetStore.get(ctx);
    const state = mirrorState(set, legacy);
    if (state === 'in-sync') return { budgets: budgetsOf(set!), taxonomy };
    if (state === 'unfinished') {
      await writeCopy(ctx, set!.mirror);
      return { budgets: budgetsOf(set!), taxonomy };
    }
    // Taken in only over the set as it was read beside the blob: a save
    // landing between the two (another request, another device) wrote both
    // since, so both are read again rather than the blob taken over it.
    const seen = JSON.stringify(set);
    let moved = false;
    const written = await budgetSetStore.update(ctx, (cur) => {
      moved = JSON.stringify(cur) !== seen;
      return moved ? cur : takeIn(cur, legacy, ix);
    });
    if (!moved) return { budgets: budgetsOf(written!), taxonomy };
    if (attempt >= LOAD_ATTEMPTS) throw new UpdateConflictError('budgets');
  }
}

/**
 * The budgets for a reader that must not write (the read-only API, the data
 * download), against the set it read (lib/category-store.ts
 * taxonomyForReading): what loadBudgets would answer, with nothing written,
 * and that set grown in memory by the blob's names, for any it lacks (with
 * provisional ids). Strict.
 */
export async function budgetsForReading(ctx: Ctx, read: Taxonomy): Promise<{ budgets: Budgets; taxonomy: Taxonomy }> {
  const [raw, set] = await Promise.all([getBudgets(ctx), budgetSetStore.get(ctx)]);
  return budgetsAsRead(raw, set, read);
}

/**
 * budgetsForReading, for a reader that names what it can't use instead of
 * stopping (the download of my data, lib/user-export.ts): when the set, or
 * the name-keyed blob it is checked against (see MIRROR), was saved but can't
 * be used, `problem` says why, since the budgets can't be told without both:
 * `unreadable`, damaged; `unrecognised`, in a form this release doesn't know.
 * What says nothing about them (storage out of reach, a key this deployment
 * can't load) throws, as every read does.
 */
export async function budgetsReport(
  ctx: Ctx,
  read: Taxonomy
): Promise<{ budgets: Budgets; taxonomy: Taxonomy; problem: null } | { problem: 'unreadable' | 'unrecognised' }> {
  const [blob, set] = await Promise.all([getBudgetsReport(ctx), budgetSetStore.getReport(ctx)]);
  const problem = set.unreadable ? 'unreadable' : set.unrecognised ? 'unrecognised' : blob.problem;
  if (problem) return { problem };
  return { ...budgetsAsRead(blob.budgets ?? {}, set.value, read), problem: null };
}

/** What loadBudgets would answer from these, with nothing written: the set
 *  `read` grown in memory by the blob's names, for any it lacks (with
 *  provisional ids), and the budgets in it. */
function budgetsAsRead(raw: Record<string, unknown>, set: BudgetSet | null, read: Taxonomy): { budgets: Budgets; taxonomy: Taxonomy } {
  const legacy = legacyBudgets(raw);
  const taxonomy = grown(read, { required: textKeys(Object.keys(legacy)) }, provisionalIds());
  const state = mirrorState(set, legacy);
  if (state === 'in-sync' || state === 'unfinished') return { budgets: budgetsOf(set!), taxonomy };
  return { budgets: budgetsOf(takeIn(set, legacy, indexTaxonomy(taxonomy))), taxonomy };
}

/**
 * Saves the budgets whole, as the Budgets tab sends them: the set, then the
 * name-keyed copy until the blob holds the set's (writeCopy), then the set
 * again to settle (see MIRROR and OVERLAPPING SAVES). A category or
 * group must be one the set has, or a budget the stored set already had on
 * one since deleted (kept, to show and remove); a merged category's budget
 * moves to where it went. Strict: refuses over a blob or set that can't be
 * read. Answers the budgets as saved.
 */
export async function saveBudgets(ctx: Ctx, next: Budgets, taxonomy: Taxonomy): Promise<Budgets> {
  const ix = indexTaxonomy(taxonomy);
  const [raw, stored] = await Promise.all([getBudgets(ctx), budgetSetStore.get(ctx)]);
  const legacyNow = legacyBudgets(raw);
  for (const id of Object.keys(next.categories)) {
    const c = categoryById(ix, id);
    if (c && isProvisionalId(c.id)) throw new BudgetError('That category is still being set up. Reload, then try again.', 409);
    if (!c && !stored?.categories[id]) throw new BudgetError('A category you budgeted no longer exists. Reload to see your categories as they are.', 409);
  }
  for (const id of Object.keys(next.groups)) {
    if (!ix.groupById.has(id) && !stored?.groups[id]) throw new BudgetError('A group you budgeted no longer exists. Reload to see your categories as they are.', 409);
  }
  const budgets = budgetsAfterMerge(next, ix);
  const copy = legacyCopy(budgets, ix);
  // What the blob holds before this save: the copy of the set it replaces
  // (the route reads budgets first, so a rollback's change is taken in), or,
  // with no set yet, the blob as read.
  await budgetSetStore.update(ctx, (cur) => ({ version: BUDGET_SET_VERSION, ...budgets, mirror: copy, mirror_before: cur ? cur.mirror : legacyNow }));
  await writeCopy(ctx, copy);
  return budgets;
}

/** After a merge: every budget on a merged category moved to the one it went
 *  into, added to its own, saved like any change. */
export async function moveMergedBudgets(ctx: Ctx, taxonomy: Taxonomy): Promise<void> {
  const { budgets } = await loadBudgets(ctx);
  const moved = budgetsAfterMerge(budgets, indexTaxonomy(taxonomy));
  if (Object.keys(moved.categories).length === Object.keys(budgets.categories).length && Object.keys(moved.categories).every((id) => budgets.categories[id])) return;
  await saveBudgets(ctx, moved, taxonomy);
}
