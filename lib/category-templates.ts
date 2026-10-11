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
//     found too) and move them into the template's groups;
//   - archive one of those it has no place for, when nothing uses it: no
//     transaction of any date, no budget and no rule (lib/category-usage.ts).
//     One in use stays as it is, and the preview says so;
//   - show again one it places that is archived;
//   - remove a group it left empty, which has no budget of its own;
//   - put the groups in its order, its own first.
// It never deletes or merges a category, never moves one into a group of
// another kind (so nothing counts differently: no total moves), and never
// changes what a group with a budget of its own holds, so that budget covers
// what it covered. Every transaction stays in its category, and every budget
// with it: budgets are kept by id (lib/budget-set.ts). Your own categories
// and groups stay where they are.
//
// PREVIEW, THEN APPLY. planTemplate works out the set a template would make
// and what changes, from the set, the budgets and what uses the categories it
// would archive. The apply works it out again on the stored set, in the same
// compare-and-set that saves it, and refuses when it differs from what was
// previewed (`signature`), so what is applied is what was shown. Applying a
// template twice changes nothing the second time.
//
// UNDO. The apply answers what the template changed, as it was (undoOf), and
// undoTemplate puts it back on the set as it is then: names, groups and
// archiving restored, groups it removed added again, the categories and
// groups it added removed when nothing uses them, and the groups' order. What
// can't be put back (a name another category has taken, a category used
// since) is kept, and said.

import {
  addCategory,
  CategoryError,
  categoryForKey,
  cleanName,
  CATEGORY_KINDS,
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

/** The seeded category a key places: the uncategorized one for
 *  UNCATEGORIZED_KEY, else the one Plaid's primary category files into
 *  (which a merge may have moved to another category). */
function seededCategory(t: Taxonomy, ix: ReturnType<typeof indexTaxonomy>, key: string): Category | null {
  if (key === UNCATEGORIZED_KEY) return ix.byId.get(t.uncategorized) ?? null;
  return categoryForKey(ix, PLAID, key);
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
  const groups = [...t.groups].sort((a, b) => a.order - b.order);
  if (groups.length !== SEED_GROUPS.length || groups.some((g, i) => g.name !== SEED_GROUPS[i].name || g.kind !== SEED_GROUPS[i].kind)) return false;
  for (const key of SEEDED_KEYS) {
    const c = seededCategory(t, ix, key);
    const p = SEED_PLACEMENTS[key];
    if (!c || c.name !== p.name || ix.groupById.get(c.group)?.name !== p.group) return false;
  }
  return t.categories.every((c) => !c.archived && !c.icon);
}

/** Why a template leaves a category as it is, or doesn't do all it says. */
export type KeptWhy =
  /** One it would archive, in use. */
  | 'used'
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
};

export type TemplatePlan = {
  template: TemplateId;
  groups: { added: string[]; removed: string[]; reordered: boolean };
  /** Every category it adds, renames, moves, archives or shows again. */
  categories: PlannedCategory[];
  /** What it leaves as it is, and why. */
  kept: KeptCategory[];
  /** Seeded categories merged into another before, placed once, as that one. */
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
 *  what it holds), and what uses each category the template would archive,
 *  by id (lib/category-usage.ts; one not here counts as used). */
export type PlanFacts = { budgets: Budgets; usage: ReadonlyMap<string, CategoryUsage>; newId: () => string };

const unused = (u: CategoryUsage | undefined): boolean => !!u && u.transactions === 0 && !u.budget && (u.rules ?? 0) === 0;

/** The categories a template would archive if nothing used them: what the
 *  route reads the usage of before planning. */
export function archiveCandidates(t: Taxonomy, template: CategoryTemplate): string[] {
  const ix = indexTaxonomy(t);
  const out = new Set<string>();
  for (const [key, p] of Object.entries(template.seeded)) {
    if (!p.archive) continue;
    const c = seededCategory(t, ix, key);
    if (c && c.id !== t.uncategorized && !c.archived) out.add(c.id);
  }
  return [...out];
}

/** Groups by id, in their order. */
const ordered = (groups: readonly CategoryGroup[]) => [...groups].sort((a, b) => a.order - b.order || a.name.localeCompare(b.name));

/**
 * The set a template makes of `t`, and what it changes (see WHAT A TEMPLATE
 * CAN CHANGE). Throws CategoryError when it can't be applied at all (past
 * the limits on groups).
 */
export function planTemplate(t: Taxonomy, template: CategoryTemplate, facts: PlanFacts): TemplatePlan {
  const ix = indexTaxonomy(t);
  const locked = (groupId: string) => facts.budgets.groups[groupId] !== undefined;
  const kept: KeptCategory[] = [];
  const merged: { name: string; into: string }[] = [];

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
  type End = { name: string; group: string; archived: boolean; wanted: string };
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
    ends.set(c.id, { name: p.name, group, archived: archive, wanted: p.name });
    order.push(c.id);
  };

  for (const [key, p] of Object.entries(template.seeded)) {
    const c = seededCategory(t, ix, key);
    if (!c) continue;
    if (ends.has(c.id)) {
      // Merged before into a category another key placed already.
      const seedName = SEED_PLACEMENTS[key]?.name ?? plaidText(key);
      merged.push({ name: seedName, into: ends.get(c.id)!.name });
      continue;
    }
    let archived = !!c.archived;
    if (p.archive && c.id !== t.uncategorized) {
      if (!c.archived) {
        const u = facts.usage.get(c.id);
        if (unused(u)) archived = true;
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

  let categories: Category[] = t.categories.map((c) => {
    const end = ends.get(c.id);
    if (!end) return c;
    const next: Category = { ...c, name: end.name, group: end.group };
    if (end.archived) next.archived = true;
    else delete next.archived;
    return next;
  });

  // Groups it emptied, with no budget of their own, go; the template's own,
  // left empty, aren't made.
  const holds = (id: string) => categories.some((c) => c.group === id) || toAdd.some((a) => groupOfTemplate.get(a.group)?.id === id);
  const before = new Set(t.groups.map((g) => g.id));
  const emptied = t.groups.filter((g) => t.categories.some((c) => c.group === g.id) && !holds(g.id) && !locked(g.id));
  const unmade = added.filter((id) => !holds(id));
  groups = groups.filter((g) => !emptied.some((e) => e.id === g.id) && !unmade.includes(g.id));
  const groupsAdded = added.filter((id) => !unmade.includes(id));
  if (groups.length > MAX_GROUPS) throw new CategoryError(`This template would leave you with more than ${MAX_GROUPS} groups. Delete some first.`, 409);

  // The order: the template's groups first, as it lists them, then the rest
  // as they were.
  const first = template.groups.map((tg) => groupOfTemplate.get(tg.name)).filter((g): g is CategoryGroup => !!g && groups.some((x) => x.id === g.id));
  const rest = ordered(groups).filter((g) => !first.some((f) => f.id === g.id));
  const inOrder = [...first, ...rest];
  groups = inOrder.map((g, order) => ({ ...g, order }));
  // Moved about: the groups you had, that stay, in another order than before.
  const stayed = ordered(t.groups)
    .filter((g) => groups.some((x) => x.id === g.id))
    .map((g) => g.id);
  const reordered = stayed.join() !== inOrder.filter((g) => before.has(g.id)).map((g) => g.id).join();

  let taxonomy: Taxonomy = { ...t, groups, categories };

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
  categories = taxonomy.categories;
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
    groups: { added: addedNames, removed, reordered },
    categories: planned.map((p) => [p.id, p.was, p.name, p.from, p.group, p.archive]),
  });
  return {
    template: template.id,
    groups: { added: addedNames, removed, reordered },
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

/** What a template changed, as it was: what its undo puts back. */
export type TemplateUndo = {
  template: TemplateId;
  /** Each category it renamed, moved, archived or showed again, as it was. */
  categories: { id: string; name: string; group: string; archived: boolean }[];
  /** What it added, by id. */
  added: { categories: string[]; groups: string[] };
  /** Groups it removed, as they were. */
  removed: { id: string; name: string; kind: CategoryKind }[];
  /** Every group's id, in the order before. */
  order: string[];
};

/** The undo of going from `before` to `after` (a template applied). */
export function undoOf(template: TemplateId, before: Taxonomy, after: Taxonomy): TemplateUndo {
  const was = new Map(before.categories.map((c) => [c.id, c]));
  const groupsBefore = new Set(before.groups.map((g) => g.id));
  const groupsAfter = new Set(after.groups.map((g) => g.id));
  return {
    template,
    categories: after.categories
      .filter((c) => {
        const b = was.get(c.id);
        return b && (b.name !== c.name || b.group !== c.group || !!b.archived !== !!c.archived);
      })
      .map((c) => {
        const b = was.get(c.id)!;
        return { id: b.id, name: b.name, group: b.group, archived: !!b.archived };
      }),
    added: { categories: after.categories.filter((c) => !was.has(c.id)).map((c) => c.id), groups: after.groups.filter((g) => !groupsBefore.has(g.id)).map((g) => g.id) },
    removed: before.groups.filter((g) => !groupsAfter.has(g.id)).map((g) => ({ id: g.id, name: g.name, kind: g.kind })),
    order: ordered(before.groups).map((g) => g.id),
  };
}

const ID = /^[A-Za-z0-9_-]{1,64}$/;
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isIdList = (v: unknown, max: number): v is string[] => Array.isArray(v) && v.length <= max && v.every((x) => typeof x === 'string' && ID.test(x));
const isName = (v: unknown): v is string => typeof v === 'string' && cleanName(v).length > 0 && cleanName(v).length <= NAME_MAX;

/** An undo as a request carries it, checked field by field; null when it
 *  isn't one. */
export function readUndo(v: unknown): TemplateUndo | null {
  if (!isRecord(v) || !isTemplateId(v.template) || !Array.isArray(v.categories) || !isRecord(v.added) || !Array.isArray(v.removed)) return null;
  if (v.categories.length > MAX_CATEGORIES || v.removed.length > MAX_GROUPS) return null;
  for (const c of v.categories) {
    if (!isRecord(c) || typeof c.id !== 'string' || !ID.test(c.id) || !isName(c.name) || typeof c.group !== 'string' || !ID.test(c.group) || typeof c.archived !== 'boolean') return null;
  }
  for (const g of v.removed) {
    if (!isRecord(g) || typeof g.id !== 'string' || !ID.test(g.id) || !isName(g.name) || !CATEGORY_KINDS.includes(g.kind as CategoryKind)) return null;
  }
  if (!isIdList(v.added.categories, MAX_CATEGORIES) || !isIdList(v.added.groups, MAX_GROUPS) || !isIdList(v.order, MAX_GROUPS)) return null;
  return {
    template: v.template,
    categories: v.categories.map((c) => ({ id: c.id as string, name: cleanName(c.name as string), group: c.group as string, archived: c.archived as boolean })),
    added: { categories: v.added.categories, groups: v.added.groups },
    removed: v.removed.map((g) => ({ id: g.id as string, name: cleanName(g.name as string), kind: g.kind as CategoryKind })),
    order: v.order,
  };
}

/** What an undo couldn't put back, and why. */
export type UndoKept = { name: string; why: 'gone' | 'used' | 'name-taken' | 'group-budget' | 'kind' | 'not-empty' };

/**
 * The set with what a template changed put back (see UNDO). `usage` is what
 * uses each category it added that is still there (lib/category-usage.ts):
 * one in use, or not counted, is kept.
 */
export function undoTemplate(
  t: Taxonomy,
  undo: TemplateUndo,
  facts: PlanFacts
): { taxonomy: Taxonomy; kept: UndoKept[] } {
  const kept: UndoKept[] = [];
  const locked = (groupId: string) => facts.budgets.groups[groupId] !== undefined;
  let groups = t.groups.map((g) => ({ ...g }));

  // The groups it removed, back: the same one if it is there, one of the
  // name and kind, or a new one.
  const groupId = new Map<string, string>();
  for (const r of undo.removed) {
    const same = groups.find((g) => g.id === r.id) ?? groups.find((g) => lower(g.name) === lower(r.name) && g.kind === r.kind);
    if (same) groupId.set(r.id, same.id);
    else if (!groups.some((g) => lower(g.name) === lower(r.name)) && groups.length < MAX_GROUPS) {
      const made = { id: facts.newId(), name: r.name, kind: r.kind, order: groups.length };
      groups.push(made);
      groupId.set(r.id, made.id);
    }
  }
  const groupBy = (id: string) => groups.find((g) => g.id === (groupId.get(id) ?? id)) ?? null;

  // Each category it changed, as it was, where that can be.
  const byId = new Map(t.categories.map((c) => [c.id, c]));
  const ends = new Map<string, { name: string; group: string; archived: boolean }>();
  for (const was of undo.categories) {
    const c = byId.get(was.id);
    if (!c) {
      kept.push({ name: was.name, why: 'gone' });
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
  // deleteCategory: never one with transactions, a budget or a rule).
  for (const id of undo.added.categories) {
    const c = taxonomy.categories.find((x) => x.id === id);
    if (!c) continue;
    const u = facts.usage.get(id);
    if (!u) {
      kept.push({ name: c.name, why: 'used' });
      continue;
    }
    try {
      taxonomy = deleteCategory(taxonomy, id, u);
    } catch (err) {
      if (!(err instanceof CategoryError)) throw err;
      kept.push({ name: c.name, why: 'used' });
    }
  }
  // And the groups it added, once empty and without a budget of their own.
  for (const id of undo.added.groups) {
    const g = taxonomy.groups.find((x) => x.id === id);
    if (!g) continue;
    if (taxonomy.categories.some((c) => c.group === id) || locked(id)) kept.push({ name: g.name, why: 'not-empty' });
    else taxonomy = { ...taxonomy, groups: taxonomy.groups.filter((x) => x.id !== id) };
  }
  // The order as it was, for the groups there are; any other after.
  const at = new Map(undo.order.map((id, i) => [groupId.get(id) ?? id, i]));
  const sorted = [...taxonomy.groups].sort((a, b) => (at.get(a.id) ?? Infinity) - (at.get(b.id) ?? Infinity) || a.order - b.order);
  taxonomy = { ...taxonomy, groups: sorted.map((g, order) => ({ ...g, order })) };
  if (!isTaxonomy(taxonomy)) throw new Error('An undo made a set that is not one');
  return { taxonomy, kept };
}
