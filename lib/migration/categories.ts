// lib/migration/categories.ts
//
// The other app's categories mapped to the person's own (lib/categories.ts),
// for the review of an import from another app (lib/migration/plan.ts) and
// for its commit (lib/migration/commit.ts), which makes the new ones. Pure,
// safe to import from client code.
//
// BY NAME WHERE THEY MATCH, NEW WHERE THEY DON'T, and always in a review the
// person confirms. Each of the app's categories (its group and name, as its
// rows carry them) is proposed, in this order: the person's category with the
// same name (in any case); the one whose words (a text key) are the same;
// for money the app keeps aside to budget (YNAB's Ready to Assign, ZeroSum's
// Ready to Budget), the person's income category; else a new category of that
// name, with the kind the app gives it (income, a transfer) or spending, in a
// group named as the app's, made when the person has none of that name and
// kind, else in the group of its kind the app's own reads would grow it into
// (lib/categories.ts growTaxonomy). The person can send any of them to a
// category they have, or make it new with another kind; the review shows
// where each goes, and whether the app counted it otherwise.
//
// THE RULES OF lib/categories.ts HOLD: a new category's name is unique (in
// any case: "Misc" in two of the app's groups becomes "Misc" and "Misc
// (Fun)"), at most NAME_MAX characters, filed by a text key no other
// category has (as addCategory makes it); at most MAX_CATEGORIES categories
// (an import that would need more is refused until the person sends some to
// categories they have) and MAX_GROUPS groups (past it, a new category goes
// in its kind's group instead). The commit makes them in one compare-and-set
// with addGroup and addCategory themselves (applyCategoryPlan), so nothing is
// made that an edit in the app couldn't make.

import {
  addCategory,
  addGroup,
  categoryById,
  categoryForKey,
  choiceText,
  cleanName,
  groupOf,
  indexTaxonomy,
  KIND_WORDS,
  MAX_CATEGORIES,
  MAX_GROUPS,
  NAME_MAX,
  sortedGroups,
  TEXT,
  textKey,
  type Category,
  type CategoryIndex,
  type CategoryKind,
  type Taxonomy,
} from '../categories';
import type { AppCategory } from '../import/apps/types';

/** One of the app's categories, as its rows name it. */
export type SourceCategory = {
  key: string;
  group: string | null;
  name: string;
  /** The kind the app gives it (see AppCategory), or null: spending. */
  kind: CategoryKind | null;
  from: 'app' | 'name' | null;
  /** Transactions, and parts of split ones, filed under it. */
  rows: number;
};

/** What the person chose for one: a category of theirs, by id, or a new one
 *  of this kind. */
export type CategoryChoice = { to: 'existing'; id: string } | { to: 'new'; kind: CategoryKind };

/** Where one goes. A new category's group is one the person has, or one the
 *  commit makes (`new`). */
export type CategoryTarget =
  | { to: 'existing'; id: string; name: string; text: string; kind: CategoryKind; group: string; archived: boolean }
  | { to: 'new'; name: string; text: string; kind: CategoryKind; group: { id: string; name: string } | { new: string } };

export type CategoryMapping = SourceCategory & {
  target: CategoryTarget;
  /** Why it goes there: the person's choice, or the proposal's reason. */
  by: 'choice' | 'name' | 'text' | 'income' | 'new';
  /** The app counts it as another kind than where it goes does, in words. */
  differs: string | null;
};

export type CategoryPlan = {
  mappings: CategoryMapping[];
  /** The groups to make, in order. */
  groups: { name: string; kind: CategoryKind }[];
  /** New categories, and the room the person's set has for them. */
  added: number;
  room: number;
  /** Why it can't be imported as it stands, or null. */
  problem: string | null;
};

/** The key an app's category is mapped by: its group's words and its own. */
export function sourceKey(c: Pick<AppCategory, 'group' | 'name'>): string {
  return `${textKey(c.group ?? '')}\u001f${textKey(c.name)}`;
}

/** The app's categories that a migration's opening balances are filed
 *  under: neither income nor spending (lib/import/apps/types.ts starting). */
export const OPENING: AppCategory = { group: null, name: 'Starting balances', kind: 'transfer', from: 'app' };

/** What apps call the money they keep aside to budget: income, for Nya. */
const TO_BUDGET = new Set(['ready to assign', 'to be budgeted', 'ready to budget', 'available this month', 'available next month']);

/** The text key a new category of this name gets: its name's, or with " (2)"
 *  and on where another category has those words (lib/categories.ts
 *  addCategory, whose rule this is). */
function freeText(taken: ReadonlySet<string>, name: string): string {
  const base = cutName(textKey(name));
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) {
    const suffix = ` (${n})`;
    const key = `${cutName(base, NAME_MAX - suffix.length)}${suffix}`;
    if (!taken.has(key)) return key;
  }
}

/** A name cut to NAME_MAX, never inside a character written as two, with no
 *  space left at its end (lib/categories.ts cutText). */
function cutName(s: string, max = NAME_MAX): string {
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  return (/[\uD800-\uDBFF]$/.test(cut) ? cut.slice(0, -1) : cut).trimEnd();
}

/** The group a category of this kind goes in when the app's group can't take
 *  it: as growTaxonomy places one, the uncategorized category's group for
 *  spending, else the first of its kind, else one made ("Income",
 *  "Transfers", "Other"). */
function homeOf(t: Taxonomy, ix: CategoryIndex, kind: CategoryKind): { id: string; name: string } | { new: string } {
  const home = ix.byId.get(t.uncategorized);
  if (kind === 'expense' && home) {
    const g = groupOf(ix, home);
    if (g.kind === 'expense') return { id: g.id, name: g.name };
  }
  const first = sortedGroups(t).find((g) => g.kind === kind);
  if (first) return { id: first.id, name: first.name };
  return { new: kind === 'income' ? 'Income' : kind === 'transfer' ? 'Transfers' : 'Other' };
}

/**
 * Where each of the app's categories goes (see the header), with the
 * person's choices applied where they still can be (a category they chose
 * that is gone since is proposed again, and the review shows where it goes).
 */
export function mapCategories(sources: readonly SourceCategory[], t: Taxonomy, choices: Readonly<Record<string, CategoryChoice>> = {}): CategoryPlan {
  const ix = indexTaxonomy(t);
  const byName = new Map(t.categories.map((c) => [c.name.toLowerCase(), c]));
  const groupsByName = new Map(t.groups.map((g) => [g.name.toLowerCase(), g]));
  const names = new Set(t.categories.map((c) => c.name.toLowerCase()));
  const texts = new Set(t.categories.flatMap((c) => c.provider_keys.filter((k) => k.provider === TEXT).map((k) => k.key)));
  const planned = new Map<string, { name: string; kind: CategoryKind }>();
  const existing = (c: Category): CategoryTarget => {
    const g = groupOf(ix, c);
    return { to: 'existing', id: c.id, name: c.name, text: choiceText(c), kind: g.kind, group: g.name, archived: !!c.archived };
  };
  const incomeCategory = categoryForKey(ix, TEXT, 'income');
  // Most used first, so the names they keep are the ones people see most.
  const ordered = [...sources].sort((a, b) => b.rows - a.rows || a.key.localeCompare(b.key));
  let added = 0;
  const mappings = ordered.map((s): CategoryMapping => {
    const choice = Object.hasOwn(choices, s.key) ? choices[s.key] : undefined;
    let target: CategoryTarget | null = null;
    let by: CategoryMapping['by'] = 'choice';
    if (choice?.to === 'existing') {
      const c = categoryById(ix, choice.id);
      if (c) target = existing(c);
    }
    if (!target && choice?.to !== 'new') {
      const named = byName.get(cleanName(s.name).toLowerCase());
      const worded = categoryForKey(ix, TEXT, textKey(s.name));
      if (named) {
        target = existing(named);
        by = 'name';
      } else if (worded) {
        target = existing(worded);
        by = 'text';
      } else if (s.kind === 'income' && s.from === 'app' && TO_BUDGET.has(textKey(s.name)) && incomeCategory && groupOf(ix, incomeCategory).kind === 'income') {
        target = existing(incomeCategory);
        by = 'income';
      }
    }
    if (!target) {
      if (choice?.to !== 'new') by = 'new';
      const kind = choice?.to === 'new' ? choice.kind : (s.kind ?? 'expense');
      // A name no category has, in any case.
      let name = cutName(cleanName(s.name)) || 'Category';
      if (names.has(name.toLowerCase()) && s.group) name = cutName(`${cleanName(s.name)} (${cleanName(s.group)})`);
      // " (2)" and on, the name cut by the suffix's own length, so every
      // number is a name of its own however many share the first.
      for (let n = 2; names.has(name.toLowerCase()); n++) {
        const suffix = ` (${n})`;
        name = `${cutName(cleanName(s.name), NAME_MAX - suffix.length)}${suffix}`;
      }
      names.add(name.toLowerCase());
      const text = freeText(texts, name);
      texts.add(text);
      // The app's group when the person has one of that name and kind, or
      // can have one made; else its kind's home.
      let group: { id: string; name: string } | { new: string } = homeOf(t, ix, kind);
      const wanted = s.group ? cutName(cleanName(s.group)) : '';
      if (wanted) {
        const have = groupsByName.get(wanted.toLowerCase());
        const making = planned.get(wanted.toLowerCase());
        if (have) {
          if (have.kind === kind) group = { id: have.id, name: have.name };
        } else if (making) {
          if (making.kind === kind) group = { new: making.name };
        } else if (t.groups.length + planned.size < MAX_GROUPS) {
          planned.set(wanted.toLowerCase(), { name: wanted, kind });
          group = { new: wanted };
        }
      }
      if ('new' in group && !planned.has(group.new.toLowerCase()) && !groupsByName.has(group.new.toLowerCase())) planned.set(group.new.toLowerCase(), { name: group.new, kind });
      added++;
      target = { to: 'new', name, text, kind, group };
    }
    const differs = s.kind && s.kind !== target.kind ? `The app counts it as ${KIND_WORDS[s.kind]}; ${target.to === 'existing' ? target.name : 'here it'} counts as ${KIND_WORDS[target.kind]}.` : null;
    return { ...s, target, by, differs };
  });
  const room = Math.max(0, MAX_CATEGORIES - t.categories.length);
  const problem =
    added > room
      ? `This file needs ${added.toLocaleString('en-US')} new categories, and your categories have room for ${room.toLocaleString('en-US')} more (Nya keeps at most ${MAX_CATEGORIES}). Send some of them to categories you have, then import.`
      : null;
  return { mappings, groups: [...planned.values()], added, room, problem };
}

/** A plan that no longer holds against the set as it is now (another device
 *  made a category of one of its names, say): nothing is made. */
export class CategoriesChangedError extends Error {
  constructor() {
    super('Your categories changed since you reviewed this file, so nothing was imported. Review it again.');
    this.name = 'CategoriesChangedError';
  }
}

/** Two plans make the same categories in the same places. */
function samePlan(a: CategoryPlan, b: CategoryPlan): boolean {
  const shape = (p: CategoryPlan) => JSON.stringify([p.groups, p.mappings.map((m) => [m.key, m.target])]);
  return shape(a) === shape(b);
}

/**
 * The set with the plan's groups and categories made, by addGroup and
 * addCategory, with ids taken in turn from `ids` (minted before, so a
 * compare-and-set run again makes the same ones). Throws
 * CategoriesChangedError when the plan worked out again on this set isn't
 * the one reviewed, and what addCategory refuses. Pure.
 */
export function applyCategoryPlan(
  t: Taxonomy,
  sources: readonly SourceCategory[],
  choices: Readonly<Record<string, CategoryChoice>>,
  reviewed: CategoryPlan,
  ids: { groups: readonly string[]; categories: readonly string[] }
): { taxonomy: Taxonomy; groups: string[]; categories: string[] } {
  const plan = mapCategories(sources, t, choices);
  if (!samePlan(plan, reviewed)) throw new CategoriesChangedError();
  let next = t;
  const groupIds = new Map<string, string>();
  const made = { groups: [] as string[], categories: [] as string[] };
  let g = 0;
  for (const want of plan.groups) {
    const id = ids.groups[g++];
    if (!id) throw new CategoriesChangedError();
    next = addGroup(next, { name: want.name, kind: want.kind }, () => id).taxonomy;
    groupIds.set(want.name.toLowerCase(), id);
    made.groups.push(id);
  }
  let c = 0;
  for (const m of plan.mappings) {
    if (m.target.to !== 'new') continue;
    const id = ids.categories[c++];
    if (!id) throw new CategoriesChangedError();
    const group = 'id' in m.target.group ? m.target.group.id : groupIds.get(m.target.group.new.toLowerCase());
    if (!group) throw new CategoriesChangedError();
    const result = addCategory(next, { name: m.target.name, group }, () => id);
    if (choiceText(result.category) !== m.target.text) throw new CategoriesChangedError();
    next = result.taxonomy;
    made.categories.push(id);
  }
  return { taxonomy: next, ...made };
}

/** The words each of the app's categories is filed by, once made: its
 *  target's text key. */
export function textsOf(plan: CategoryPlan): Map<string, string> {
  return new Map(plan.mappings.map((m) => [m.key, m.target.text]));
}
