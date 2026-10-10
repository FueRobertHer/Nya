// lib/budget-set.ts
//
// Monthly budgets, per category and per group (#38), as pure functions, safe
// to import from client code: the stored shape (lib/budget-store.ts keeps it
// on the storage seam), the budgets as they stood under names before
// categories had ids, and what a group's budget comes to beside its
// categories' (the reconcile rule).
//
// BY ID. A budget names its category or group by id, so renaming either
// changes nothing here, and merging a category moves its budget onto the one
// it went into (lib/budget-store.ts), where the two add up: their spending is
// counted together from then on, so the limits are too. A group's limit can
// still change, and the month's total with it: merged into another group,
// the budget and the spending go there, and a group with an amount of its own
// caps what it holds; within one, the reconcile rule below can bind
// differently once the category without a budget is gone.
//
// THE RECONCILE RULE. A group can have a budget of its own, a cap on
// everything in it, beside budgets on its categories. The group's meter then
// shows min(the group's amount, its categories' amounts added up), with one
// refinement: a category with no budget has no limit, so the categories bind
// only when every one of them has a budget. An archived category aside, but
// only while it has no spending in the month: archived, it still files the
// transactions its keys bring, and spending with no budget of its own has
// none but the group's. In words:
//   - its categories add up to more than the group's amount: the group's
//     amount is the limit, and the meter says the categories ask for more;
//   - every category has a budget and they add up to less: their sum is the
//     limit, and the meter says the group's amount leaves room unassigned;
//   - otherwise the group's amount is the limit (what its unbudgeted
//     categories may spend is inside it).
// A group with no amount of its own and budgeted categories rolls them up:
// their budgets and their spending added up. Each budgeted category keeps its
// own meter, nested under its group. The month's total is each group's limit
// and spending added up, so nothing is counted twice.
//
// SPENDING is counted by lib/totals.ts (one currency, what the person
// excluded and transfers left out, lib/spending.ts) and handed in by category
// id; a group's is its categories'.

import { categoriesIn, categoryById, categoryForKey, choiceText, groupOf, sortedGroups, textKey, TEXT, type Category, type CategoryGroup, type CategoryIndex } from './categories';

export const BUDGET_SET_VERSION = 1;

export type BudgetAmount = { amount: number };

export type BudgetSet = {
  version: typeof BUDGET_SET_VERSION;
  /** Monthly amount by category id. */
  categories: Record<string, BudgetAmount>;
  /** Monthly amount by group id: a cap on everything in the group. */
  groups: Record<string, BudgetAmount>;
  /** The category budgets as the release before this one reads them (by
   *  each category's first text key, lib/budgets.ts), exactly as this release
   *  last wrote them there, and what was there before that write, so a
   *  change that release makes after a rollback is noticed and taken in, and
   *  a save that stopped between its two writes is finished
   *  (lib/budget-store.ts). */
  mirror: Record<string, number>;
  mirror_before: Record<string, number> | null;
};

/** The budgets the person edits: a set without its bookkeeping. */
export type Budgets = Pick<BudgetSet, 'categories' | 'groups'>;

export const EMPTY_BUDGETS: Budgets = { categories: {}, groups: {} };

/** How many budgets of each kind can be set: 50 on categories, as the
 *  release before this one allowed, so its page, rolled back to, can still
 *  save the copy it reads (lib/budget-store.ts MIRROR); and a group's for each
 *  group there can be. */
export const MAX_CATEGORY_BUDGETS = 50;
export const MAX_GROUP_BUDGETS = 50;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const ID = /^[A-Za-z0-9_-]{1,64}$/;
/** An amount a budget can hold: positive and finite. */
export const isBudgetAmount = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n > 0;

/** Each budget: `{ amount }` and nothing else (see isBudgetSet). */
function isAmounts(v: unknown): v is Record<string, BudgetAmount> {
  if (!isRecord(v)) return false;
  const entries = Object.entries(v);
  return entries.length <= 1000 && entries.every(([id, a]) => ID.test(id) && isRecord(a) && Object.keys(a).length === 1 && isBudgetAmount(a.amount));
}

/** A name-keyed copy, as lib/budgets.ts stores budgets. */
export function isLegacyBudgets(v: unknown): v is Record<string, number> {
  return isRecord(v) && Object.values(v).every(isBudgetAmount);
}

const SET_FIELDS = new Set(['version', 'categories', 'groups', 'mirror', 'mirror_before']);

/**
 * The stored shape, closed: a field this release doesn't know, on the set or
 * on a budget (one a later release added), makes the set unrecognised, so
 * this release never saves over it and drops what that release kept there
 * (lib/repo.ts refuses to: the budgets route answers 409). Every save here
 * rebuilds the set from the budgets a page sends, which is why. A later
 * release that needs more per budget, and wants a rollback to this one to
 * keep budgets usable, keeps it beside this set, keyed by the same ids.
 */
export function isBudgetSet(v: unknown): v is BudgetSet {
  return (
    isRecord(v) &&
    Object.keys(v).every((k) => SET_FIELDS.has(k)) &&
    v.version === BUDGET_SET_VERSION &&
    isAmounts(v.categories) &&
    isAmounts(v.groups) &&
    isLegacyBudgets(v.mirror) &&
    (v.mirror_before === null || isLegacyBudgets(v.mirror_before))
  );
}

/** A change to budgets refused, with what to say to the person and the
 *  status a route answers with. */
export class BudgetError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 409 = 400
  ) {
    super(message);
    this.name = 'BudgetError';
  }
}

/** The largest monthly amount a budget takes. */
export const MAX_BUDGET_AMOUNT = 1e12;

/** What the person edits, as a client sends it: ids to positive amounts
 *  (each { amount }), within the counts, kept to the cent. Throws BudgetError
 *  otherwise. */
export function readBudgets(v: unknown): Budgets {
  if (!isRecord(v) || !isRecord(v.categories) || !isRecord(v.groups)) throw new BudgetError('Invalid budgets');
  const read = (m: Record<string, unknown>, max: number, what: string): Record<string, BudgetAmount> => {
    const entries = Object.entries(m);
    if (entries.length > max) throw new BudgetError(`At most ${max} ${what} budgets can be set`);
    const out: Record<string, BudgetAmount> = {};
    for (const [id, a] of entries) {
      const amount = isRecord(a) && Object.keys(a).length === 1 ? a.amount : undefined;
      if (!ID.test(id) || !isBudgetAmount(amount) || amount > MAX_BUDGET_AMOUNT || Math.round(amount * 100) <= 0) {
        throw new BudgetError('Invalid budget entry');
      }
      out[id] = { amount: Math.round(amount * 100) / 100 };
    }
    return out;
  };
  return { categories: read(v.categories, MAX_CATEGORY_BUDGETS, 'category'), groups: read(v.groups, MAX_GROUP_BUDGETS, 'group') };
}

/** The usable entries of a name-keyed blob (lib/budgets.ts, which checks
 *  only that it is an object): a positive amount each, as its route always
 *  required. */
export function legacyBudgets(raw: Record<string, unknown>): Record<string, number> {
  return Object.fromEntries(Object.entries(raw).filter((e): e is [string, number] => isBudgetAmount(e[1])));
}

/** How the stored set stands against the name-keyed copy (see MIRROR in
 *  lib/budget-store.ts): no set yet; the copy is what this release last wrote
 *  there; it is what was there before that write (a save stopped between its
 *  two writes); or anything else, which only the release before this one
 *  writes, after a rollback. */
export type MirrorState = 'none' | 'in-sync' | 'unfinished' | 'changed';

export function mirrorState(set: BudgetSet | null, legacy: Record<string, number>): MirrorState {
  if (!set) return 'none';
  if (sameLegacy(legacy, set.mirror)) return 'in-sync';
  if (set.mirror_before && sameLegacy(legacy, set.mirror_before)) return 'unfinished';
  return 'changed';
}

/**
 * Budgets saved under names (lib/budgets.ts) as budgets by id: each name to
 * the category its words file into (lib/categories.ts text keys), names that
 * land in one category added up (two budgets whose spending is now counted
 * together). `unplaced` names have no category; the caller grows the set
 * with them first, so it is empty unless something is wrong, and never
 * dropped quietly.
 */
export function budgetsFromNames(legacy: Record<string, number>, ix: CategoryIndex): { categories: Record<string, BudgetAmount>; unplaced: string[] } {
  const categories: Record<string, BudgetAmount> = {};
  const unplaced: string[] = [];
  for (const [name, amount] of Object.entries(legacy)) {
    const c = categoryForKey(ix, TEXT, textKey(name));
    if (!c) {
      unplaced.push(name);
      continue;
    }
    categories[c.id] = { amount: (categories[c.id]?.amount ?? 0) + amount };
  }
  return { categories, unplaced };
}

/** The copy the release before this one reads: each category budget under its
 *  category's first text key. A group's budget isn't in it (that release has
 *  no groups), nor one on a category the set no longer has. */
export function legacyCopy(budgets: Budgets, ix: CategoryIndex): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [id, b] of Object.entries(budgets.categories)) {
    const c = categoryById(ix, id);
    if (c) out[choiceText(c)] = (out[choiceText(c)] ?? 0) + b.amount;
  }
  return out;
}

/** Whether two name-keyed copies hold the same budgets. */
export function sameLegacy(a: Record<string, number>, b: Record<string, number>): boolean {
  const ka = Object.keys(a);
  return ka.length === Object.keys(b).length && ka.every((k) => Object.prototype.hasOwnProperty.call(b, k) && a[k] === b[k]);
}

/** A budget naming a category or group the set no longer has (deleted, by
 *  another device, as this one saved): kept, shown, and removable. */
export type OrphanBudget = { kind: 'category' | 'group'; id: string; amount: number };

/**
 * The budgets against the categories as they are now: a budget on a merged
 * category counted on the one it went into, added to that one's own, and one
 * whose category or group is gone kept apart (orphans), never dropped.
 */
export function placeBudgets(budgets: Budgets, ix: CategoryIndex): { categories: Map<string, number>; groups: Map<string, number>; orphans: OrphanBudget[] } {
  const categories = new Map<string, number>();
  const orphans: OrphanBudget[] = [];
  for (const [id, b] of Object.entries(budgets.categories)) {
    const c = categoryById(ix, id);
    if (c) categories.set(c.id, (categories.get(c.id) ?? 0) + b.amount);
    else orphans.push({ kind: 'category', id, amount: b.amount });
  }
  const groups = new Map<string, number>();
  for (const [id, b] of Object.entries(budgets.groups)) {
    if (ix.groupById.has(id)) groups.set(id, b.amount);
    else orphans.push({ kind: 'group', id, amount: b.amount });
  }
  return { categories, groups, orphans };
}

/** The budgets with each merged category's moved onto where it went (added
 *  to that one's), for saving after a merge. Orphans are left as they are. */
export function budgetsAfterMerge(budgets: Budgets, ix: CategoryIndex): Budgets {
  const categories: Record<string, BudgetAmount> = {};
  for (const [id, b] of Object.entries(budgets.categories)) {
    const to = categoryById(ix, id)?.id ?? id;
    categories[to] = { amount: (categories[to]?.amount ?? 0) + b.amount };
  }
  return { ...budgets, categories };
}

// ---- What each budget comes to ----

/** Which side of the reconcile rule binds a group's limit, when the two
 *  differ: its own amount (its categories ask for more), or its categories'
 *  (every one has a budget, and they add up to less). */
export type Reconcile = { binds: 'group' | 'categories'; group: number; categories: number };

export type CategoryMeter = { category: Category; budget: number | null; spent: number };

export type GroupMeter = {
  group: CategoryGroup;
  /** The group's own amount, or null. */
  own: number | null;
  /** Its categories' budgets added up (0 with none). */
  categories_total: number;
  /** The limit its meter shows (see THE RECONCILE RULE), or null when
   *  neither it nor any of its categories has a budget. */
  limit: number | null;
  /** What counts against the limit: everything in the group under a budget
   *  of its own, else its budgeted categories' spending. */
  spent: number;
  /** All its spending, budgeted or not. */
  spent_all: number;
  reconcile: Reconcile | null;
  /** Each category with a budget or spending this month, most spent first. */
  categories: CategoryMeter[];
};

/**
 * Every group as the Budgets tab shows it, in the groups' order: its limit by
 * the reconcile rule, what counts against it, and its categories nested.
 * `spent` is the month's spending by category id (lib/totals.ts). The total is
 * the groups' limits and what counts against them added up.
 */
export function budgetMeters(ix: CategoryIndex, placed: ReturnType<typeof placeBudgets>, spent: ReadonlyMap<string, number>): { groups: GroupMeter[]; total: { budget: number; spent: number } } {
  const groups: GroupMeter[] = [];
  let totalBudget = 0;
  let totalSpent = 0;
  for (const g of sortedGroups(ix.taxonomy)) {
    const cats = categoriesIn(ix.taxonomy, g.id);
    const own = placed.groups.get(g.id) ?? null;
    let categoriesTotal = 0;
    let budgetedSpent = 0;
    let spentAll = 0;
    let allBudgeted = true;
    const meters: CategoryMeter[] = [];
    for (const c of cats) {
      const budget = placed.categories.get(c.id) ?? null;
      const s = spent.get(c.id) ?? 0;
      spentAll += s;
      if (budget !== null) {
        categoriesTotal += budget;
        budgetedSpent += s;
      } else if (!c.archived || s > 0) allBudgeted = false;
      if (budget !== null || s > 0) meters.push({ category: c, budget, spent: s });
    }
    const anyBudgeted = meters.some((m) => m.budget !== null);
    let limit: number | null = null;
    let reconcile: Reconcile | null = null;
    if (own !== null) {
      limit = own;
      if (anyBudgeted && categoriesTotal > own) reconcile = { binds: 'group', group: own, categories: categoriesTotal };
      else if (anyBudgeted && allBudgeted && categoriesTotal < own) {
        limit = categoriesTotal;
        reconcile = { binds: 'categories', group: own, categories: categoriesTotal };
      }
    } else if (anyBudgeted) limit = categoriesTotal;
    const counted = own !== null ? spentAll : budgetedSpent;
    if (limit !== null) {
      totalBudget += limit;
      totalSpent += counted;
    }
    meters.sort((a, b) => b.spent - a.spent || a.category.name.localeCompare(b.category.name));
    groups.push({ group: g, own, categories_total: categoriesTotal, limit, spent: counted, spent_all: spentAll, reconcile, categories: meters });
  }
  return { groups, total: { budget: totalBudget, spent: totalSpent } };
}

/** Spending rolled up to groups: each group's total and its categories', most
 *  first, for the Activity tab's top spending. Spending by category id in. */
export function spendingByGroup(ix: CategoryIndex, byCategory: ReadonlyMap<string, number>): { group: CategoryGroup; total: number; categories: { category: Category; total: number }[] }[] {
  const out = new Map<string, { group: CategoryGroup; total: number; categories: { category: Category; total: number }[] }>();
  for (const [id, total] of byCategory) {
    const c = categoryById(ix, id);
    if (!c || total <= 0) continue;
    const g = groupOf(ix, c);
    const entry = out.get(g.id) ?? { group: g, total: 0, categories: [] };
    entry.total += total;
    entry.categories.push({ category: c, total });
    out.set(g.id, entry);
  }
  return [...out.values()]
    .map((e) => ({ ...e, categories: e.categories.sort((a, b) => b.total - a.total || a.category.name.localeCompare(b.category.name)) }))
    .sort((a, b) => b.total - a.total || a.group.name.localeCompare(b.group.name));
}
