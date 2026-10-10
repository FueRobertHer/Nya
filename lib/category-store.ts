// lib/category-store.ts
//
// Where your categories are kept (lib/categories.ts): one encrypted value per
// container on the storage seam (lib/repo.ts), the `categories` store, and the
// reads that seed it, grow it and file transactions by it.
//
// SEEDED ON FIRST READ, by the app, never by the read-only API. The first of
// the app's routes to need categories makes the set: the default groups, every
// Plaid primary category, Other, and every category already written as text
// on the person's data (the categories they chose for transactions, those
// carried across a re-link, a budget's name, and, through the transactions
// route, every category on their transactions, manual and imported ones
// among them). Two routes doing that at once (the dashboard loads
// transactions and budgets side by side) agree: the set is made and grown
// with a compare-and-set (ValueStore.update), so the second sees the first's
// and adds only what it lacks. Nothing is written when nothing is missing.
//
// GROWN AS THE APP READS. A transaction whose category no category has yet
// (Plaid started using a new one, a file brought its own) gets one on the next
// load of the Activity tab's transactions, so every id the app shows is a
// stored one. The read-only API and the data download write nothing: they
// grow a copy in memory, whose new categories have provisional ids
// (lib/categories.ts isProvisionalId), shown as null.
//
// READS. readTaxonomy and the store's own get are strict: a set that can't be
// read throws, never reads as "none" (which would seed a second set over it).
// Filing transactions for display (fileTransactions) is the one lenient use:
// a set that can't be read files them by the categories they came with, with
// a note, since nothing writes on what it shows; every edit reads strictly
// and refuses.

import { defineValueStore, UpdateConflictError, StoredDataUnreadableError, describeUnreadable } from './repo';
import type { Ctx } from './containers';
import { getOverrides, getCarried } from './overrides';
import { getBudgets } from './budgets';
import {
  categoryById,
  choiceText,
  CategoryError,
  growTaxonomy,
  indexTaxonomy,
  isTaxonomy,
  observedKeys,
  resolveCategory,
  groupOf,
  seedTaxonomy,
  textKeys,
  type CategoryFacts,
  type CategoryIndex,
  type CategoryKind,
  type ObservedKey,
  type Taxonomy,
} from './categories';

export const taxonomyStore = defineValueStore<Taxonomy>('categories', {
  what: 'categories',
  isValid: isTaxonomy,
  exportable: true, // the person's own categories and groups
});

/** A new category's or group's id: random, so it says nothing of what it is. */
export const newCategoryId = (): string => crypto.randomUUID();

/** Strict, writes nothing: the stored set, or null when none was ever made. */
export function readTaxonomy(ctx: Ctx): Promise<Taxonomy | null> {
  return taxonomyStore.get(ctx);
}

/** Keys to grow a set by: `required` ones always get a category (a budget's
 *  name), `observed` ones while there is room. */
export type TaxonomyKeys = { observed?: ObservedKey[]; required?: ObservedKey[] };

/** The set (seeded when there is none) grown by the keys: the required ones
 *  past any limit first, then the rest. The set itself when nothing is added. */
export function grown(cur: Taxonomy | null, keys: TaxonomyKeys, newId: () => string): Taxonomy {
  const base = cur ?? seedTaxonomy([], newId);
  const withRequired = growTaxonomy(base, keys.required ?? [], newId, { limit: Infinity }).taxonomy;
  return growTaxonomy(withRequired, keys.observed ?? [], newId).taxonomy;
}

/** Provisional ids, for a copy grown in memory (never stored: the store's
 *  shape refuses an id with ":"). Random, so a copy grown again from a copy
 *  never gives two categories one id. */
export function provisionalIds(): () => string {
  return () => `new:${crypto.randomUUID()}`;
}

/**
 * What seeding takes in beside the keys a route hands it: the categories the
 * person chose for transactions and those carried across a re-link (read
 * leniently: one that can't be read now is grown when its transaction is
 * shown), and the names their budgets were saved under (required, so every
 * budget has a category to move to: lib/budget-store.ts). A budget blob that
 * can't be read adds nothing here: the budgets route reads it strictly and
 * says so.
 */
async function seedKeys(ctx: Ctx): Promise<TaxonomyKeys> {
  const [overrides, carried, budgets] = await Promise.all([
    getOverrides(ctx),
    getCarried(ctx),
    getBudgets(ctx).catch(() => ({}) as Record<string, number>),
  ]);
  const carriedTexts = [...carried.values()].flatMap((rows) => Object.values(rows).filter((c): c is string => c !== null));
  return { observed: textKeys([...Object.values(overrides), ...carriedTexts]), required: textKeys(Object.keys(budgets)) };
}

/**
 * The set for the app's own routes, which may write: seeded if there is none
 * (with seedKeys), and grown by `keys` it lacks, in one compare-and-set. Reads
 * once and writes nothing when nothing is missing. Throws what a strict read
 * throws.
 */
export async function ensureTaxonomy(ctx: Ctx, keys: TaxonomyKeys = {}): Promise<Taxonomy> {
  const current = await taxonomyStore.get(ctx);
  if (current && grown(current, keys, provisionalIds()) === current) return current;
  const extra = current ? {} : await seedKeys(ctx);
  const all: TaxonomyKeys = {
    required: [...(keys.required ?? []), ...(extra.required ?? [])],
    observed: [...(extra.observed ?? []), ...(keys.observed ?? [])],
  };
  return (await taxonomyStore.update(ctx, (cur) => grown(cur, all, newCategoryId)))!;
}

/**
 * The set for a reader that must not write (the read-only API, the data
 * download): the stored one, or the seed it would be, grown in memory by the
 * keys it lacks, with provisional ids. `stored` says whether one was stored.
 * Strict: a stored set that can't be read throws.
 */
export async function taxonomyForReading(ctx: Ctx, keys: TaxonomyKeys = {}): Promise<{ taxonomy: Taxonomy; stored: boolean }> {
  const stored = await taxonomyStore.get(ctx);
  const extra = stored ? {} : await seedKeys(ctx);
  const all: TaxonomyKeys = {
    required: [...(keys.required ?? []), ...(extra.required ?? [])],
    observed: [...(extra.observed ?? []), ...(keys.observed ?? [])],
  };
  return { taxonomy: grown(stored, all, provisionalIds()), stored: stored !== null };
}

/**
 * Changes the set with `op`, seeded first if there is none: a compare-and-set,
 * so growing on another request never loses the edit, nor the edit the growth.
 * `op` may run more than once and throws CategoryError to refuse.
 */
export async function changeTaxonomy(ctx: Ctx, op: (t: Taxonomy) => Taxonomy): Promise<Taxonomy> {
  const seeded = await ensureTaxonomy(ctx);
  return (await taxonomyStore.update(ctx, (cur) => op(cur ?? seeded)))!;
}

/** What a transaction gains once filed: its category's id, the name to show
 *  (null for one that says nothing about its category, which shows none) and
 *  the kind it counts as (lib/spending.ts). The facts it was filed by go. */
export type Filing = { category_id?: string; category_name?: string | null; category_kind?: CategoryKind };

/** Files rows in place (lib/categories.ts resolveCategory). A row whose
 *  words no category has room for (past MAX_CATEGORIES) is left unfiled: it
 *  shows its words and counts by them, as before categories had kinds, and
 *  totals by category put it under the uncategorized one (filedId). */
export function fileRows(ix: CategoryIndex, rows: Iterable<CategoryFacts & Filing>): void {
  for (const r of rows) {
    const { category, said, filed } = resolveCategory(ix, r);
    if (filed) {
      r.category_id = category.id;
      r.category_name = said ? category.name : null;
      r.category_kind = groupOf(ix, category).kind;
    } else {
      delete r.category_id;
      delete r.category_name;
      delete r.category_kind;
    }
    delete r.category_set;
    delete r.pfc_primary;
    delete r.pfc_detailed;
  }
}

/**
 * Files transactions for display (lib/activity.ts), in place, and answers the
 * set they were filed by. `grow`: the app, which seeds and grows the stored
 * set; without it, a reader that writes nothing (taxonomyForReading). A set
 * that can't be read files every row by the category it came with, in a
 * seed made in memory, with a note; one that kept changing while it grew is
 * read as it is and grown in memory, for the next load to store.
 */
export async function fileTransactions(ctx: Ctx, rows: (CategoryFacts & Filing)[], opts: { grow: boolean }): Promise<{ taxonomy: Taxonomy; notes: string[] }> {
  const observed = observedKeys(rows);
  const notes: string[] = [];
  let taxonomy: Taxonomy;
  try {
    taxonomy = opts.grow ? await ensureTaxonomy(ctx, { observed }) : (await taxonomyForReading(ctx, { observed })).taxonomy;
  } catch (err) {
    if (err instanceof StoredDataUnreadableError) {
      console.error('Stored categories unreadable:', describeUnreadable(err));
      notes.push("Your categories couldn't be read, so each transaction shows the category it came with until they can be.");
      taxonomy = grown(null, { observed }, provisionalIds());
    } else if (err instanceof UpdateConflictError) {
      taxonomy = (await taxonomyForReading(ctx, { observed })).taxonomy;
    } else throw err;
  }
  fileRows(indexTaxonomy(taxonomy), rows);
  return { taxonomy, notes };
}

/** One row the app answers with on its own (a manual row just saved, for the
 *  page to put in its list), filed as the list files it, the set grown by
 *  its category if need be. */
export async function fileForAnswer<T extends CategoryFacts & Filing>(ctx: Ctx, row: T): Promise<T> {
  await fileTransactions(ctx, [row], { grow: true });
  return row;
}

/** An id as a route takes one: what the seam takes, at most 64 long. */
const ID_PARAM = /^[A-Za-z0-9_:-]{1,80}$/;

/**
 * The words a choice of a category is stored as (lib/categories.ts
 * choiceText), for a category chosen by id from the app's lists: one the set
 * has, following a merge to where it went. Archived ones are hidden from the
 * lists, not refused: a row already in one keeps it. CategoryError (400, 404)
 * otherwise.
 */
export async function choiceForId(ctx: Ctx, id: unknown): Promise<string> {
  if (typeof id !== 'string' || !ID_PARAM.test(id)) throw new CategoryError('Invalid category');
  const c = categoryById(indexTaxonomy(await ensureTaxonomy(ctx)), id);
  if (!c) throw new CategoryError('That category no longer exists. Reload to see your categories as they are.', 404);
  return choiceText(c);
}
