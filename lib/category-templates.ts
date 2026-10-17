// lib/category-templates.ts
//
// Starter category templates: a few ready-made sets of categories and groups
// (lib/categories.ts) to start from, offered on the Categories screen and,
// once, to someone whose categories are still the ones Nya made
// (isSeededSet). Pure, safe to import from client code; the route
// (app/api/categories/templates) reads what a plan needs and saves it.
//
// WHAT A TEMPLATE CAN CHANGE, and nothing else:
//   - add groups, and categories of its own (one you already have by that
//     name, in any case, is used instead: moved into the template's group);
//   - rename the categories Nya made at the start (each found by the key it
//     was made with, Plaid's category or "other", so one you renamed is
//     found too, and one another was merged into is placed as what it is,
//     never as what went into it) and move them into the template's groups;
//   - archive one of those it has no place for, when nothing uses it: no
//     transaction of any date, no budget and no rule (lib/category-usage.ts),
//     and it holds no category the template keeps (one merged into it). One
//     in use stays as it is, and the preview says so;
//   - show again one it places that is archived;
//   - remove a group it left empty that is one of a set's (the start's, or a
//     template's, by name and kind) and has no budget of its own, now or in
//     any month the record of budgets by month keeps
//     (lib/budget-months-store.ts), so no past month loses its budget. One
//     left empty that has stays, and the preview says so;
//   - put the groups in its order, its own first.
// It never deletes or merges a category, never moves one into a group of
// another kind (so nothing counts differently: no total moves), and never
// changes what a group with a budget of its own holds, so that budget covers
// what it covered. Every transaction stays in its category, and every budget
// with it: budgets are kept by id (lib/budget-set.ts). Your own categories
// (made by you, or grown from a file) and groups (by a name no set has) stay
// where they are.
//
// PREVIEW, THEN APPLY. planTemplate works out the set a template would make
// and what changes, from the set, the budgets and what uses the categories it
// would archive. The apply works it out again on the stored set, in the same
// compare-and-set that saves it, and refuses when it differs from what was
// previewed (`signature`), so what is applied is what was shown. Applying a
// template twice changes nothing the second time.
//
// UNDO. The apply answers what the template changed, as it was and as it
// made it (undoOf), and undoTemplate puts it back on the set as it is then:
// names, groups and archiving restored, groups it removed added again under
// their own ids (so a budget or a record naming one by id finds it), the
// categories and groups it added removed when nothing uses them, and the
// groups' order. What can't be put back (a name another category has taken,
// a category used since, a group that can't be made again) is kept, and
// said; so is what was changed since the apply (on another device), which
// stays as it is now.

import {
  addCategory,
  CategoryError,
  categoryForKey,
  cleanName,
  CATEGORY_KINDS,
  defaultName,
  deleteCategory,
  indexTaxonomy,
  isTaxonomy,
  MAX_CATEGORIES,
  MAX_GROUPS,
  NAME_MAX,
  PLAID,
  plaidText,
  seedTaxonomy,
  type Category,
  type CategoryGroup,
  type CategoryKind,
  type CategoryUsage,
  type Taxonomy,
} from './categories';
import type { Budgets } from './budget-set';
import type { BudgetMonths } from './rollover';

export type TemplateId = 'simple' | 'detailed' | 'freelancer';
export const TEMPLATE_IDS: readonly TemplateId[] = ['simple', 'detailed', 'freelancer'];

/** The key the uncategorized category is placed by: the words it was seeded
 *  as. Every other seeded category is placed by Plaid's primary category. */
export const UNCATEGORIZED_KEY = 'other';

/** Where a template puts a category Nya made at the start. */
export type Placement = {
  /** The template's group, by name. */
  group: string;
  /** Its name in the template. */
  name: string;
  /** Archived when nothing uses it; otherwise left as it is. */
  archive?: true;
};

export type CategoryTemplate = {
  id: TemplateId;
  name: string;
  /** What it is, in a sentence. */
  summary: string;
  /** Its groups, in order. */
  groups: readonly { name: string; kind: CategoryKind }[];
  /** Each category Nya made at the start, by the key it was made with. */
  seeded: Readonly<Record<string, Placement>>;
  /** Categories of its own, each in one of its groups. */
  added: readonly { name: string; group: string }[];
};

// The seed, as lib/categories.ts makes it: its groups in order, and each
// seeded category's group and name.
const SEED = seedTaxonomy([], (() => {
  let n = 0;
  return () => `seed${++n}`;
})());
const SEED_GROUPS = [...SEED.groups].sort((a, b) => a.order - b.order).map((g) => ({ name: g.name, kind: g.kind }));
const seedKeyOf = (c: Category) => (c.id === SEED.uncategorized ? UNCATEGORIZED_KEY : c.provider_keys.find((k) => k.provider === PLAID)!.key);
const SEED_PLACEMENTS: Record<string, Placement> = Object.fromEntries(
  SEED.categories.map((c) => [seedKeyOf(c), { group: SEED.groups.find((g) => g.id === c.group)!.name, name: c.name }])
);

/** The keys of the categories Nya makes at the start, in the seed's order. */
export const SEEDED_KEYS: readonly string[] = SEED.categories.map(seedKeyOf);

const DETAILED: CategoryTemplate = {
  id: 'detailed',
  name: 'Detailed',
  summary: 'The categories Nya starts you with: one for each of Plaid’s, in ten groups.',
  groups: SEED_GROUPS,
  seeded: SEED_PLACEMENTS,
  added: [],
};

const SIMPLE: CategoryTemplate = {
  id: 'simple',
  name: 'Simple',
  summary: 'About a dozen broad categories in six groups, with plain names; the ones few people use are archived while nothing uses them.',
  groups: [
    { name: 'Income', kind: 'income' },
    { name: 'Everyday', kind: 'expense' },
    { name: 'Home and bills', kind: 'expense' },
    { name: 'Fun', kind: 'expense' },
    { name: 'Other', kind: 'expense' },
    { name: 'Transfers', kind: 'transfer' },
  ],
  seeded: {
    INCOME: { group: 'Income', name: 'Income' },
    FOOD_AND_DRINK: { group: 'Everyday', name: 'Food' },
    GENERAL_MERCHANDISE: { group: 'Everyday', name: 'Shopping' },
    TRANSPORTATION: { group: 'Everyday', name: 'Transport' },
    PERSONAL_CARE: { group: 'Everyday', name: 'Personal care', archive: true },
    RENT_AND_UTILITIES: { group: 'Home and bills', name: 'Home and utilities' },
    HOME_IMPROVEMENT: { group: 'Home and bills', name: 'Home improvement', archive: true },
    MEDICAL: { group: 'Home and bills', name: 'Health' },
    GENERAL_SERVICES: { group: 'Home and bills', name: 'Services' },
    BANK_FEES: { group: 'Home and bills', name: 'Fees' },
    GOVERNMENT_AND_NON_PROFIT: { group: 'Home and bills', name: 'Taxes and donations', archive: true },
    TRAVEL: { group: 'Fun', name: 'Travel' },
    ENTERTAINMENT: { group: 'Fun', name: 'Entertainment' },
    [UNCATEGORIZED_KEY]: { group: 'Other', name: 'Other' },
    TRANSFER_IN: { group: 'Transfers', name: 'Transfers in' },
    TRANSFER_OUT: { group: 'Transfers', name: 'Transfers out' },
    LOAN_PAYMENTS: { group: 'Transfers', name: 'Loan payments' },
  },
  added: [],
};

const FREELANCER: CategoryTemplate = {
  id: 'freelancer',
  name: 'Freelancer',
  summary: 'Nya’s categories for your personal spending, with your business income and business expenses in groups of their own.',
  groups: [
    SEED_GROUPS[0],
    { name: 'Business income', kind: 'income' },
    ...SEED_GROUPS.slice(1, -2),
    { name: 'Business expenses', kind: 'expense' },
    ...SEED_GROUPS.slice(-2),
  ],
  seeded: { ...SEED_PLACEMENTS, INCOME: { ...SEED_PLACEMENTS.INCOME, name: 'Personal income' } },
  added: [
    { name: 'Client payments', group: 'Business income' },
    { name: 'Other business income', group: 'Business income' },
    { name: 'Software and subscriptions', group: 'Business expenses' },
    { name: 'Equipment', group: 'Business expenses' },
    { name: 'Office and supplies', group: 'Business expenses' },
    { name: 'Business travel', group: 'Business expenses' },
    { name: 'Business meals', group: 'Business expenses' },
    { name: 'Advertising', group: 'Business expenses' },
    { name: 'Professional services', group: 'Business expenses' },
    { name: 'Business fees', group: 'Business expenses' },
    { name: 'Taxes', group: 'Business expenses' },
  ],
};

export const TEMPLATES: Readonly<Record<TemplateId, CategoryTemplate>> = { simple: SIMPLE, detailed: DETAILED, freelancer: FREELANCER };
export const isTemplateId = (v: unknown): v is TemplateId => typeof v === 'string' && (TEMPLATE_IDS as readonly string[]).includes(v);

const lower = (s: string) => s.toLowerCase();

/** A seeded category's name, as the start has it: what a key is called. */
const seedName = (key: string) => SEED_PLACEMENTS[key]?.name ?? defaultName(plaidText(key));

/** The groups a set makes (the start's, or a template's), by kind and name
 *  in any case: a group by any other is yours, and no template removes it. */
const SET_GROUPS: ReadonlySet<string> = new Set(Object.values(TEMPLATES).flatMap((tpl) => tpl.groups.map((g) => `${g.kind}:${lower(g.name)}`)));
const isSetGroup = (g: CategoryGroup) => SET_GROUPS.has(`${g.kind}:${lower(g.name)}`);

/**
 * The key a template places a category by: the one it was made with. "other"
 * for the uncategorized category; else its first key, when that is Plaid's
 * primary category, as every category Nya made at the start has it. A merge
 * adds the keys of the category merged away after the kept one's own, so the
 * kept one is placed as what it is, never as what went into it; and one you
 * made (its first key is its name's) is placed by none, whatever was merged
 * into it. Null for one placed by none.
 */
function madeWith(t: Taxonomy, c: Category): string | null {
  if (c.id === t.uncategorized) return UNCATEGORIZED_KEY;
  const first = c.provider_keys[0];
  return first !== undefined && first.provider === PLAID ? first.key : null;
}

/** Each category a key places, by the key it was made with. */
function byMadeWith(t: Taxonomy): Map<string, Category> {
  const out = new Map<string, Category>();
  for (const c of t.categories) {
    const key = madeWith(t, c);
    if (key !== null && !out.has(key)) out.set(key, c);
  }
  return out;
}

/** The keys a template keeps shown: a category holding one (merged into it)
 *  is never archived, so what files under that key never lands in an
 *  archived category. */
const shownKeys = (template: CategoryTemplate) => new Set(Object.entries(template.seeded).flatMap(([k, p]) => (p.archive ? [] : [k])));

/** The key of a category merged into `c` that the template keeps shown, if
 *  `c` holds one (other than its own). */
function holdsShown(c: Category, own: string, shown: ReadonlySet<string>): string | null {
  return c.provider_keys.find((k) => k.provider === PLAID && k.key !== own && shown.has(k.key))?.key ?? null;
}

/**
 * Whether the set is still the one Nya made: the default groups as they were
 * named, each seeded category with its name, in its group, shown, without an
 * icon, and nothing merged. Categories Nya grew since (from a file, a
 * category chosen for a transaction) don't count against it, if shown and
 * without icons. For offering the templates once (components/TemplateOffer.tsx).
 */
export function isSeededSet(t: Taxonomy): boolean {
  if (t.merged && Object.keys(t.merged).length > 0) return false;
  const ix = indexTaxonomy(t);
  const made = byMadeWith(t);
  const groups = [...t.groups].sort((a, b) => a.order - b.order);
  if (groups.length !== SEED_GROUPS.length || groups.some((g, i) => g.name !== SEED_GROUPS[i].name || g.kind !== SEED_GROUPS[i].kind)) return false;
  for (const key of SEEDED_KEYS) {
    const c = made.get(key);
    const p = SEED_PLACEMENTS[key];
    if (!c || c.name !== p.name || ix.groupById.get(c.group)?.name !== p.group) return false;
  }
  return t.categories.every((c) => !c.archived && !c.icon);
}

/**
 * The groups the record of budgets by month (lib/budget-months-store.ts) has
 * a budget for, now or in any month it keeps: what a template keeps though
 * it left them empty, so their past months keep their budgets. A record that
 * can't be read is never taken for none (the route reads it strictly).
 */
export function groupsWithBudgets(months: BudgetMonths | null): Set<string> {
  const had = (m: BudgetMonths['groups'][string]) => m.seen !== null || (m.amounts ?? []).some((a) => a.amount !== null) || (m.rollover ?? []).length > 0;
  return new Set(Object.entries(months?.groups ?? {}).flatMap(([id, m]) => (had(m) ? [id] : [])));
}

/** Why a template leaves a category as it is, or doesn't do all it says. */
export type KeptWhy =
  /** One it would archive, in use. */
  | 'used'
  /** One it would archive, holding a category it keeps (merged into it). */
  | 'holds'
  /** Its group, or the template's, has a budget of its own. */
  | 'group-budget'
  /** The template's group counts as another kind. */
  | 'kind'
  /** Another category has the template's name for it. */
  | 'name-taken'
  /** No room: past MAX_CATEGORIES. */
  | 'full';

export type PlannedCategory = {
  /** Null for one the template adds. */
  id: string | null;
  /** Its name after. */
  name: string;
  /** Its name before, when renamed. */
  was: string | null;
  /** Its group's name after. */
  group: string;
  /** Its group's name before, when moved. */
  from: string | null;
  /** Archived, or shown again. */
  archive: 'archive' | 'unarchive' | null;
};

export type KeptCategory = {
  id: string | null;
  /** As it is called now (or, not added, as the template calls it). */
  name: string;
  why: KeptWhy;
  /** What uses it (`used`). */
  uses?: { transactions: number; budget: boolean; rules: number };
  /** The group (`group-budget`, `kind`). */
  group?: string;
  /** The name the template has for it (`name-taken`). */
  wanted?: string;
  /** The category merged into it that the template keeps (`holds`), as the
   *  start names it. */
  holds?: string;
};

/** A group a template leaves empty but keeps, and why: one of yours (by a
 *  name no set has), or one with a budget in a past month. */
export type KeptGroup = { name: string; why: 'yours' | 'past-budgets' };

export type TemplatePlan = {
  template: TemplateId;
  groups: { added: string[]; removed: string[]; reordered: boolean; kept: KeptGroup[] };
  /** Every category it adds, renames, moves, archives or shows again. */
  categories: PlannedCategory[];
  /** What it leaves as it is, and why. */
  kept: KeptCategory[];
  /** Seeded categories merged into another before (`name`, as the start
   *  names it), filed with the one they went into (`into`, as it is after). */
  merged: { name: string; into: string }[];
  /** Budgets on categories it renames or moves: they stay with them. */
  budgets: { id: string; name: string; group: string }[];
  /** Nothing would change. */
  unchanged: boolean;
  /** The changes, as text: what an apply checks it is applying. */
  signature: string;
  /** The set as it would be. */
  taxonomy: Taxonomy;
};

/** What a plan reads beside the set: the budgets (a group's own budget keeps
 *  what it holds), what uses each category the template would archive, by
 *  id (lib/category-usage.ts; one not here counts as used), and the groups
 *  with a budget in some month of the record of budgets by month
 *  (groupsWithBudgets: one left empty is kept). */
export type PlanFacts = { budgets: Budgets; usage: ReadonlyMap<string, CategoryUsage>; recorded: ReadonlySet<string>; newId: () => string };

const unused = (u: CategoryUsage | undefined): boolean => !!u && u.transactions === 0 && !u.budget && (u.rules ?? 0) === 0;

/** The categories a template would archive if nothing used them: what the
 *  route reads the usage of before planning. */
export function archiveCandidates(t: Taxonomy, template: CategoryTemplate): string[] {
  const made = byMadeWith(t);
  const shown = shownKeys(template);
  const out = new Set<string>();
  for (const [key, p] of Object.entries(template.seeded)) {
    if (!p.archive) continue;
    const c = made.get(key);
    if (c && c.id !== t.uncategorized && !c.archived && holdsShown(c, key, shown) === null) out.add(c.id);
  }
  return [...out];
}

/** Groups in their order (then by name, for groups saved with the same). */
const ordered = (groups: readonly CategoryGroup[]) => [...groups].sort((a, b) => a.order - b.order || a.name.localeCompare(b.name));

/**
 * The set a template makes of `t`, and what it changes (see WHAT A TEMPLATE
 * CAN CHANGE). Throws CategoryError when it can't be applied at all (past
 * the limits on groups).
 */
export function planTemplate(t: Taxonomy, template: CategoryTemplate, facts: PlanFacts): TemplatePlan {
  const ix = indexTaxonomy(t);
  const made = byMadeWith(t);
  const shown = shownKeys(template);
  const locked = (groupId: string) => facts.budgets.groups[groupId] !== undefined;
  const kept: KeptCategory[] = [];

  // The template's groups: one of yours with the name (any case), else new.
  let groups: CategoryGroup[] = t.groups.map((g) => ({ ...g }));
  const added: string[] = [];
  const groupOfTemplate = new Map<string, CategoryGroup | null>();
  for (const tg of template.groups) {
    const have = groups.find((g) => lower(g.name) === lower(tg.name));
    if (have) groupOfTemplate.set(tg.name, have.kind === tg.kind ? have : null);
    else {
      const made: CategoryGroup = { id: facts.newId(), name: tg.name, kind: tg.kind, order: 0 };
      groups.push(made);
      added.push(made.id);
      groupOfTemplate.set(tg.name, made);
    }
  }

  // Each category's end state, from the seeded ones the template places and
  // the names it adds that you have already.
  type End = { name: string; group: string; archived: boolean };
  const ends = new Map<string, End>();
  const order: string[] = [];
  const place = (c: Category, p: Placement, archive: boolean) => {
    const target = groupOfTemplate.get(p.group) ?? null;
    const now = ix.groupById.get(c.group)!;
    let group = c.group;
    if (target && target.id !== c.group) {
      if (target.kind !== now.kind) kept.push({ id: c.id, name: c.name, why: 'kind', group: now.name });
      else if (locked(c.group) || locked(target.id)) kept.push({ id: c.id, name: c.name, why: 'group-budget', group: locked(c.group) ? now.name : target.name });
      else group = target.id;
    } else if (!target) kept.push({ id: c.id, name: c.name, why: 'kind', group: now.name });
    ends.set(c.id, { name: p.name, group, archived: archive });
    order.push(c.id);
  };

  // A seeded category merged into another before files with that one: the
  // kept one is placed as what it is, and the note says where it went.
  const mergedInto: { key: string; holder: string }[] = [];
  for (const [key, p] of Object.entries(template.seeded)) {
    const c = made.get(key);
    if (!c) {
      const holder = categoryForKey(ix, PLAID, key);
      if (holder) mergedInto.push({ key, holder: holder.id });
      continue;
    }
    let archived = !!c.archived;
    if (p.archive && c.id !== t.uncategorized) {
      if (!c.archived) {
        const holds = holdsShown(c, key, shown);
        const u = facts.usage.get(c.id);
        if (holds !== null) kept.push({ id: c.id, name: c.name, why: 'holds', holds: seedName(holds) });
        else if (unused(u)) archived = true;
        else if (u) kept.push({ id: c.id, name: c.name, why: 'used', uses: { transactions: u.transactions, budget: u.budget, rules: u.rules ?? 0 } });
        else kept.push({ id: c.id, name: c.name, why: 'used' });
      }
    } else archived = false;
    place(c, p, archived);
  }

  // The template's own categories: one of yours by the name (not placed
  // above) is used as it, shown; the rest are added below.
  const toAdd: { name: string; group: string }[] = [];
  for (const a of template.added) {
    const have = t.categories.find((c) => !ends.has(c.id) && lower(c.name) === lower(a.name));
    if (have) place(have, { group: a.group, name: a.name }, false);
    else toAdd.push(a);
  }

  // Names: each must be one no other category ends with (any case). A rename
  // that would take another's name is left out, and said.
  const nameOf = (c: Category) => ends.get(c.id)?.name ?? c.name;
  for (let changed = true; changed; ) {
    changed = false;
    const seen = new Map<string, string[]>();
    for (const c of t.categories) seen.set(lower(nameOf(c)), [...(seen.get(lower(nameOf(c))) ?? []), c.id]);
    for (const ids of seen.values()) {
      if (ids.length < 2) continue;
      for (const id of ids) {
        const end = ends.get(id);
        const c = ix.byId.get(id)!;
        if (end && end.name !== c.name) {
          kept.push({ id, name: c.name, why: 'name-taken', wanted: end.name });
          end.name = c.name;
          changed = true;
          break;
        }
      }
    }
  }

  let taxonomy: Taxonomy = {
    ...t,
    groups,
    categories: t.categories.map((c) => {
      const end = ends.get(c.id);
      if (!end) return c;
      const next: Category = { ...c, name: end.name, group: end.group };
      if (end.archived) next.archived = true;
      else delete next.archived;
      return next;
    }),
  };

  // Its own categories, added where it says (lib/categories.ts addCategory:
  // a name no category has, a key of its own, the limit).
  const plannedAdded: PlannedCategory[] = [];
  for (const a of toAdd) {
    const g = groupOfTemplate.get(a.group);
    if (!g) {
      kept.push({ id: null, name: a.name, why: 'kind', group: a.group });
      continue;
    }
    if (taxonomy.categories.length >= MAX_CATEGORIES) {
      kept.push({ id: null, name: a.name, why: 'full' });
      continue;
    }
    try {
      taxonomy = addCategory(taxonomy, { name: a.name, group: g.id }, facts.newId).taxonomy;
      plannedAdded.push({ id: null, name: a.name, was: null, group: g.name, from: null, archive: null });
    } catch (err) {
      if (!(err instanceof CategoryError)) throw err;
      kept.push({ id: null, name: a.name, why: 'name-taken', wanted: a.name });
    }
  }

  // Groups it emptied, with no budget of their own, go, when they are a
  // set's and had no budget in a past month either; yours, and one whose
  // past months had a budget, stay, empty, and are said. The template's own,
  // left empty (what it was to hold stayed where it was, or couldn't be
  // added), aren't made.
  const holds = (id: string) => taxonomy.categories.some((c) => c.group === id);
  const before = new Set(t.groups.map((g) => g.id));
  const keptGroups: KeptGroup[] = [];
  const emptied = t.groups.filter((g) => {
    if (!t.categories.some((c) => c.group === g.id) || holds(g.id) || locked(g.id)) return false;
    const why = !isSetGroup(g) ? 'yours' : facts.recorded.has(g.id) ? 'past-budgets' : null;
    if (why !== null) keptGroups.push({ name: g.name, why });
    return why === null;
  });
  const unmade = added.filter((id) => !holds(id));
  groups = taxonomy.groups.filter((g) => !emptied.some((e) => e.id === g.id) && !unmade.includes(g.id));
  const groupsAdded = added.filter((id) => !unmade.includes(id));
  if (groups.length > MAX_GROUPS) throw new CategoryError(`This template would leave you with more than ${MAX_GROUPS} groups. Delete some first.`, 409);

  // The order: the template's groups first, as it lists them, then the rest
  // as they were.
  const first = template.groups.map((tg) => groupOfTemplate.get(tg.name)).filter((g): g is CategoryGroup => !!g && groups.some((x) => x.id === g.id));
  const rest = ordered(groups).filter((g) => !first.some((f) => f.id === g.id));
  const inOrder = [...first, ...rest];
  // Moved about: the groups you had, that stay, in another order than before.
  const stayed = ordered(t.groups)
    .filter((g) => groups.some((x) => x.id === g.id))
    .map((g) => g.id);
  const reordered = stayed.join() !== inOrder.filter((g) => before.has(g.id)).map((g) => g.id).join();
  taxonomy = { ...taxonomy, groups: inOrder.map((g, order) => ({ ...g, order })) };
  if (!isTaxonomy(taxonomy)) throw new Error('A template made a set that is not one');

  const groupName = (id: string) => taxonomy.groups.find((g) => g.id === id)?.name ?? ix.groupById.get(id)?.name ?? '';
  const planned: PlannedCategory[] = [];
  for (const id of order) {
    const c = ix.byId.get(id)!;
    const end = taxonomy.categories.find((x) => x.id === id)!;
    const archive = !!end.archived === !!c.archived ? null : end.archived ? 'archive' : 'unarchive';
    if (end.name === c.name && end.group === c.group && archive === null) continue;
    planned.push({ id, name: end.name, was: end.name !== c.name ? c.name : null, group: groupName(end.group), from: end.group !== c.group ? groupName(c.group) : null, archive });
  }
  planned.push(...plannedAdded);

  const budgets = planned
    .filter((p) => p.id !== null && facts.budgets.categories[p.id] !== undefined && (p.was !== null || p.from !== null))
    .map((p) => ({ id: p.id!, name: p.name, group: p.group }));
  const removed = emptied.map((g) => g.name);
  const addedNames = groupsAdded.map(groupName);
  const unchanged = planned.length === 0 && removed.length === 0 && addedNames.length === 0 && !reordered;
  const signature = JSON.stringify({
    template: template.id,
    groups: { added: addedNames, removed, reordered, kept: keptGroups.map((g) => [g.name, g.why]) },
    categories: planned.map((p) => [p.id, p.was, p.name, p.from, p.group, p.archive]),
  });
  // Each merged seeded category, by the name the start gave it, with the
  // name the one it went into ends with.
  const endName = (id: string) => taxonomy.categories.find((c) => c.id === id)?.name ?? ix.byId.get(id)?.name ?? '';
  const merged = mergedInto.map((m) => ({ name: seedName(m.key), into: endName(m.holder) }));
  return {
    template: template.id,
    groups: { added: addedNames, removed, reordered, kept: keptGroups },
    categories: planned,
    kept: dedupeKept(kept),
    merged,
    budgets,
    unchanged,
    signature,
    taxonomy,
  };
}

/** One note per category and reason, the first. */
function dedupeKept(kept: KeptCategory[]): KeptCategory[] {
  const seen = new Set<string>();
  return kept.filter((k) => {
    const key = `${k.id ?? k.name}:${k.why}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ---- Undo ----

/** A category as a template found it, or as it left it. */
export type CategoryState = { name: string; group: string; archived: boolean };

/** What a template changed, as it was and as it made it: what its undo puts
 *  back, and how it tells what was changed since. */
export type TemplateUndo = {
  template: TemplateId;
  /** Each category it renamed, moved, archived or showed again, as it was,
   *  and as the template left it (`after`). */
  categories: ({ id: string } & CategoryState & { after: CategoryState })[];
  /** What it added: each category as it made it, each group by its name. */
  added: { categories: { id: string; name: string; group: string }[]; groups: { id: string; name: string }[] };
  /** Groups it removed, as they were. */
  removed: { id: string; name: string; kind: CategoryKind }[];
  /** Every group's id, in the order before. */
  order: string[];
};

const stateOf = (c: Category): CategoryState => ({ name: c.name, group: c.group, archived: !!c.archived });
const sameState = (a: CategoryState, b: CategoryState) => a.name === b.name && a.group === b.group && a.archived === b.archived;

/** The undo of going from `before` to `after` (a template applied). */
export function undoOf(template: TemplateId, before: Taxonomy, after: Taxonomy): TemplateUndo {
  const was = new Map(before.categories.map((c) => [c.id, c]));
  const groupsBefore = new Set(before.groups.map((g) => g.id));
  const groupsAfter = new Set(after.groups.map((g) => g.id));
  return {
    template,
    categories: after.categories.flatMap((c) => {
      const b = was.get(c.id);
      return b && !sameState(stateOf(b), stateOf(c)) ? [{ id: b.id, ...stateOf(b), after: stateOf(c) }] : [];
    }),
    added: {
      categories: after.categories.filter((c) => !was.has(c.id)).map((c) => ({ id: c.id, name: c.name, group: c.group })),
      groups: after.groups.filter((g) => !groupsBefore.has(g.id)).map((g) => ({ id: g.id, name: g.name })),
    },
    removed: before.groups.filter((g) => !groupsAfter.has(g.id)).map((g) => ({ id: g.id, name: g.name, kind: g.kind })),
    order: ordered(before.groups).map((g) => g.id),
  };
}

const ID = /^[A-Za-z0-9_-]{1,64}$/;
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isId = (v: unknown): v is string => typeof v === 'string' && ID.test(v);
const isIdList = (v: unknown, max: number): v is string[] => Array.isArray(v) && v.length <= max && v.every(isId);
const isName = (v: unknown): v is string => typeof v === 'string' && cleanName(v).length > 0 && cleanName(v).length <= NAME_MAX;
const isState = (v: unknown): v is CategoryState => isRecord(v) && isName(v.name) && isId(v.group) && typeof v.archived === 'boolean';
const readState = (v: CategoryState): CategoryState => ({ name: cleanName(v.name), group: v.group, archived: v.archived });

/** An undo as a request carries it, checked field by field; null when it
 *  isn't one. */
export function readUndo(v: unknown): TemplateUndo | null {
  if (!isRecord(v) || !isTemplateId(v.template) || !Array.isArray(v.categories) || !isRecord(v.added) || !Array.isArray(v.removed)) return null;
  const { categories: addedCategories, groups: addedGroups } = v.added;
  if (v.categories.length > MAX_CATEGORIES || v.removed.length > MAX_GROUPS || !Array.isArray(addedCategories) || !Array.isArray(addedGroups)) return null;
  if (addedCategories.length > MAX_CATEGORIES || addedGroups.length > MAX_GROUPS || !isIdList(v.order, MAX_GROUPS)) return null;
  for (const c of v.categories) if (!isRecord(c) || !isId(c.id) || !isState(c.after) || !isState(c)) return null;
  for (const g of v.removed) if (!isRecord(g) || !isId(g.id) || !isName(g.name) || !CATEGORY_KINDS.includes(g.kind as CategoryKind)) return null;
  for (const c of addedCategories) if (!isRecord(c) || !isId(c.id) || !isName(c.name) || !isId(c.group)) return null;
  for (const g of addedGroups) if (!isRecord(g) || !isId(g.id) || !isName(g.name)) return null;
  return {
    template: v.template,
    categories: (v.categories as ({ id: string } & CategoryState & { after: CategoryState })[]).map((c) => ({ id: c.id, ...readState(c), after: readState(c.after) })),
    added: {
      categories: (addedCategories as { id: string; name: string; group: string }[]).map((c) => ({ id: c.id, name: cleanName(c.name), group: c.group })),
      groups: (addedGroups as { id: string; name: string }[]).map((g) => ({ id: g.id, name: cleanName(g.name) })),
    },
    removed: (v.removed as { id: string; name: string; kind: CategoryKind }[]).map((g) => ({ id: g.id, name: cleanName(g.name), kind: g.kind })),
    order: v.order,
  };
}

/** What an undo couldn't put back, and why. `group`: it is a group. */
export type UndoKept = {
  name: string;
  why: 'gone' | 'changed' | 'used' | 'name-taken' | 'group-budget' | 'kind' | 'not-empty' | 'group-name-taken' | 'group-full';
  group?: true;
};

/**
 * The set with what a template changed put back (see UNDO). `usage` is what
 * uses each category it added that is still there (lib/category-usage.ts):
 * one in use, or not counted, is kept.
 */
export function undoTemplate(t: Taxonomy, undo: TemplateUndo, facts: Pick<PlanFacts, 'budgets' | 'usage'>): { taxonomy: Taxonomy; kept: UndoKept[] } {
  const kept: UndoKept[] = [];
  const locked = (groupId: string) => facts.budgets.groups[groupId] !== undefined;
  let groups = t.groups.map((g) => ({ ...g }));

  // The groups it removed, back: the same one if it is there, one of the
  // name and kind, or made again under its own id, so a budget or a record
  // of budgets by month naming it by id finds it again. One that can't be
  // made (its name taken by a group of another kind, or no room) isn't, and
  // what it held stays where it is.
  const groupId = new Map<string, string>();
  for (const r of undo.removed) {
    const same = groups.find((g) => g.id === r.id) ?? groups.find((g) => lower(g.name) === lower(r.name) && g.kind === r.kind);
    if (same) groupId.set(r.id, same.id);
    else if (groups.some((g) => lower(g.name) === lower(r.name))) kept.push({ name: r.name, why: 'group-name-taken', group: true });
    else if (groups.length >= MAX_GROUPS) kept.push({ name: r.name, why: 'group-full', group: true });
    else {
      groups.push({ id: r.id, name: r.name, kind: r.kind, order: groups.length });
      groupId.set(r.id, r.id);
    }
  }
  const groupBy = (id: string) => groups.find((g) => g.id === (groupId.get(id) ?? id)) ?? null;

  // Each category it changed, as it was, where that can be; one changed
  // since the apply stays as it is now.
  const byId = new Map(t.categories.map((c) => [c.id, c]));
  const ends = new Map<string, CategoryState>();
  for (const was of undo.categories) {
    const c = byId.get(was.id);
    if (!c) {
      kept.push({ name: was.name, why: 'gone' });
      continue;
    }
    if (!sameState(stateOf(c), was.after)) {
      kept.push({ name: c.name, why: 'changed' });
      continue;
    }
    let group = c.group;
    const target = groupBy(was.group);
    const now = groups.find((g) => g.id === c.group)!;
    if (target && target.id !== c.group) {
      if (target.kind !== now.kind) kept.push({ name: c.name, why: 'kind' });
      else if (locked(c.group) || locked(target.id)) kept.push({ name: c.name, why: 'group-budget' });
      else group = target.id;
    }
    const archived = was.archived && c.id !== t.uncategorized;
    ends.set(c.id, { name: was.name, group, archived });
  }
  // A name another category has now stays as it is.
  const nameOf = (c: Category) => ends.get(c.id)?.name ?? c.name;
  for (let changed = true; changed; ) {
    changed = false;
    for (const c of t.categories) {
      const end = ends.get(c.id);
      if (!end || end.name === c.name) continue;
      if (t.categories.some((o) => o.id !== c.id && lower(nameOf(o)) === lower(end.name))) {
        kept.push({ name: c.name, why: 'name-taken' });
        end.name = c.name;
        changed = true;
      }
    }
  }
  let taxonomy: Taxonomy = {
    ...t,
    groups,
    categories: t.categories.map((c) => {
      const end = ends.get(c.id);
      if (!end) return c;
      const next: Category = { ...c, name: end.name, group: end.group };
      if (end.archived) next.archived = true;
      else delete next.archived;
      return next;
    }),
  };

  // The categories it added go, when nothing uses them (lib/categories.ts
  // deleteCategory: never one with transactions, a budget or a rule) and
  // they are as it made them.
  for (const a of undo.added.categories) {
    const c = taxonomy.categories.find((x) => x.id === a.id);
    if (!c) continue;
    if (c.name !== a.name || c.group !== a.group) {
      kept.push({ name: c.name, why: 'changed' });
      continue;
    }
    const u = facts.usage.get(a.id);
    if (!u) {
      kept.push({ name: c.name, why: 'used' });
      continue;
    }
    try {
      taxonomy = deleteCategory(taxonomy, a.id, u);
    } catch (err) {
      if (!(err instanceof CategoryError)) throw err;
      kept.push({ name: c.name, why: 'used' });
    }
  }
  // And the groups it added, once empty, without a budget of their own, and
  // called as it named them.
  for (const a of undo.added.groups) {
    const g = taxonomy.groups.find((x) => x.id === a.id);
    if (!g) continue;
    if (g.name !== a.name) kept.push({ name: g.name, why: 'changed', group: true });
    else if (taxonomy.categories.some((c) => c.group === a.id) || locked(a.id)) kept.push({ name: g.name, why: 'not-empty', group: true });
    else taxonomy = { ...taxonomy, groups: taxonomy.groups.filter((x) => x.id !== a.id) };
  }
  // The order as it was, for the groups there are; any other after.
  const at = new Map(undo.order.map((id, i) => [groupId.get(id) ?? id, i]));
  const sorted = [...taxonomy.groups].sort((a, b) => (at.get(a.id) ?? Infinity) - (at.get(b.id) ?? Infinity) || a.order - b.order);
  taxonomy = { ...taxonomy, groups: sorted.map((g, order) => ({ ...g, order })) };
  if (!isTaxonomy(taxonomy)) throw new Error('An undo made a set that is not one');
  return { taxonomy, kept };
}
