import { describe, expect, test } from 'bun:test';
import {
  budgetMeters,
  budgetsAfterMerge,
  budgetsFromNames,
  isBudgetSet,
  legacyBudgets,
  legacyCopy,
  mirrorState,
  placeBudgets,
  readBudgets,
  spendingByGroup,
  BudgetError,
  type Budgets,
} from '@/lib/budget-set';
import { addGroup, indexTaxonomy, mergeCategories, moveCategory, renameCategory, seedTaxonomy, setArchived, textKeys, type Taxonomy } from '@/lib/categories';

// Budgets by category and by group (lib/budget-set.ts): the reconcile rule a
// group's meter is drawn by, the rollups, merges, what a budget saved under a
// name becomes, and the name-keyed copy the release before reads.

let n = 0;
const ids = () => `x${++n}`;
const base = seedTaxonomy(textKeys(['groceries', 'restaurants', 'coffee']), ids);
// Food holds food and drink and three of the person's own, for these tests.
const food = base.groups.find((g) => g.name === 'Food')!;
const t: Taxonomy = ['groceries', 'restaurants', 'coffee'].reduce((acc, name) => moveCategory(acc, acc.categories.find((c) => c.name === name)!.id, food.id), base);
const ix = indexTaxonomy(t);
const id = (name: string) => t.categories.find((c) => c.name === name)!.id;
const budgets = (categories: Record<string, number>, groups: Record<string, number> = {}): Budgets => ({
  categories: Object.fromEntries(Object.entries(categories).map(([name, amount]) => [id(name), { amount }])),
  groups: Object.fromEntries(Object.entries(groups).map(([gid, amount]) => [gid, { amount }])),
});
const spent = (by: Record<string, number>) => new Map(Object.entries(by).map(([name, amount]) => [id(name), amount]));
const meterOf = (b: Budgets, s: Map<string, number>, group = food.id) => budgetMeters(ix, placeBudgets(b, ix), s).groups.find((m) => m.group.id === group)!;

describe('the reconcile rule: a group’s limit is min(its own amount, its categories’ added up)', () => {
  test('its categories ask for more than the group allows: the group’s amount binds', () => {
    const m = meterOf(budgets({ groceries: 500, restaurants: 400 }, { [food.id]: 800 }), spent({ groceries: 300, coffee: 20 }));
    expect(m).toMatchObject({ own: 800, categories_total: 900, limit: 800, reconcile: { binds: 'group', group: 800, categories: 900 } });
    // A group's own budget caps everything in it, budgeted or not.
    expect(m.spent).toBe(320);
  });

  test('every category budgeted, adding up to less: their sum binds', () => {
    const all = budgets({ groceries: 300, restaurants: 200, coffee: 50, 'food and drink': 100 }, { [food.id]: 800 });
    const m = meterOf(all, spent({ groceries: 100 }));
    expect(m).toMatchObject({ limit: 650, reconcile: { binds: 'categories', group: 800, categories: 650 } });
  });

  test('a category with no budget has no limit, so the group’s amount binds and nothing needs saying', () => {
    const m = meterOf(budgets({ groceries: 300 }, { [food.id]: 800 }), spent({ groceries: 100, coffee: 40 }));
    expect(m).toMatchObject({ limit: 800, reconcile: null, spent: 140 });
    // An archived category without a budget doesn't keep the rule from binding.
    const archivedAll = ['restaurants', 'coffee', 'food and drink'].reduce((acc, name) => setArchived(acc, id(name), true), t);
    const aix = indexTaxonomy(archivedAll);
    const m2 = budgetMeters(aix, placeBudgets(budgets({ groceries: 300 }, { [food.id]: 800 }), aix), spent({})).groups.find((g) => g.group.id === food.id)!;
    expect(m2).toMatchObject({ limit: 300, reconcile: { binds: 'categories' } });
  });

  test('an archived category with spending this month and no budget is a category without one: the group’s amount stays the limit', () => {
    // Its keys still file transactions, so what it spends counts against the
    // group's own budget, and the categories never bind while it has none.
    const archived = setArchived(t, id('coffee'), true);
    const aix = indexTaxonomy(archived);
    const b = budgets({ groceries: 300, restaurants: 200, 'food and drink': 100 }, { [food.id]: 800 });
    const meter = (s: Map<string, number>) => budgetMeters(aix, placeBudgets(b, aix), s).groups.find((g) => g.group.id === food.id)!;
    expect(meter(spent({ groceries: 100, coffee: 150 }))).toMatchObject({ limit: 800, reconcile: null, spent: 250 });
    // With nothing spent there this month, it is left aside, as before.
    expect(meter(spent({ groceries: 100 }))).toMatchObject({ limit: 600, reconcile: { binds: 'categories', group: 800, categories: 600 }, spent: 100 });
  });

  test('the two agreeing say nothing', () => {
    expect(meterOf(budgets({ groceries: 300, restaurants: 200, coffee: 50, 'food and drink': 100 }, { [food.id]: 650 }), spent({})).reconcile).toBeNull();
  });

  test('no amount of its own: its budgeted categories roll up, budgets and spending alike', () => {
    const m = meterOf(budgets({ groceries: 300, restaurants: 200 }), spent({ groceries: 120, restaurants: 30, coffee: 999 }));
    expect(m).toMatchObject({ own: null, limit: 500, spent: 150, spent_all: 1149, reconcile: null });
  });

  test('a group’s own amount alone: everything in it against it', () => {
    expect(meterOf(budgets({}, { [food.id]: 400 }), spent({ coffee: 50, groceries: 100 }))).toMatchObject({ limit: 400, spent: 150 });
  });

  test('neither: no meter, its spending still listed', () => {
    const m = meterOf(budgets({}), spent({ coffee: 12 }));
    expect(m.limit).toBeNull();
    expect(m.categories.map((c) => [c.category.name, c.budget, c.spent])).toEqual([['coffee', null, 12]]);
  });

  test('the total counts each group once: its limit, never its categories’ again', () => {
    const transport = t.groups.find((g) => g.name === 'Transport')!;
    const b = budgets({ groceries: 500, restaurants: 400, transportation: 100 }, { [food.id]: 800 });
    const { total } = budgetMeters(ix, placeBudgets(b, ix), spent({ groceries: 300, transportation: 60 }));
    expect(total).toEqual({ budget: 900, spent: 360 });
    expect(budgetMeters(ix, placeBudgets(b, ix), spent({})).groups.find((g) => g.group.id === transport.id)!.limit).toBe(100);
  });
});

describe('placing budgets on the categories as they are', () => {
  test('a merged category’s budget counts on the one it went into, added up; one on something gone is kept apart', () => {
    const merged = mergeCategories(t, id('coffee'), id('restaurants'));
    const mix = indexTaxonomy(merged);
    const b: Budgets = { categories: { [id('coffee')]: { amount: 30 }, [id('restaurants')]: { amount: 200 }, gone: { amount: 5 } }, groups: { nogroup: { amount: 9 } } };
    const placed = placeBudgets(b, mix);
    expect(placed.categories.get(id('restaurants'))).toBe(230);
    expect(placed.orphans).toEqual([
      { kind: 'category', id: 'gone', amount: 5 },
      { kind: 'group', id: 'nogroup', amount: 9 },
    ]);
    // And moved there for good when saved after the merge.
    expect(budgetsAfterMerge(b, mix).categories).toEqual({ [id('restaurants')]: { amount: 230 }, gone: { amount: 5 } });
  });
});

describe('budgets saved under names, and the copy the release before reads', () => {
  test('each name onto the category its words file into; names on one category add up; a name with none is said, never dropped', () => {
    const { categories, unplaced } = budgetsFromNames({ Groceries: 100, groceries: 50, 'food and drink': 400, nowhere: 7 }, ix);
    expect(categories).toEqual({ [id('groceries')]: { amount: 150 }, [id('food and drink')]: { amount: 400 } });
    expect(unplaced).toEqual(['nowhere']);
  });

  test('the copy: each category budget under its first words, so a renamed one is under its old ones; never a group’s', () => {
    const renamed = indexTaxonomy(renameCategory(t, id('groceries'), 'Supermarket'));
    expect(legacyCopy(budgets({ groceries: 150, coffee: 20 }, { [food.id]: 500 }), renamed)).toEqual({ groceries: 150, coffee: 20 });
  });

  test('how the stored set stands against the copy', () => {
    const set = { version: 1 as const, categories: {}, groups: {}, mirror: { a: 1 }, mirror_before: { a: 2 } };
    expect(mirrorState(null, {})).toBe('none');
    expect(mirrorState(set, { a: 1 })).toBe('in-sync');
    expect(mirrorState(set, { a: 2 })).toBe('unfinished');
    expect(mirrorState(set, { a: 3 })).toBe('changed');
    expect(mirrorState({ ...set, mirror_before: null }, { a: 2 })).toBe('changed');
  });

  test('a name-keyed blob’s usable entries: positive amounts only, as its route required', () => {
    expect(legacyBudgets({ a: 10, b: 0, c: -1, d: 'x', e: Infinity })).toEqual({ a: 10 });
  });
});

describe('the stored shape and what a page sends', () => {
  test('a set as stored; a field this release doesn’t know, on the set or on a budget, makes it unrecognised, never dropped by a save', () => {
    const ok = { version: 1, categories: { a: { amount: 5 } }, groups: {}, mirror: { a: 5 }, mirror_before: null };
    expect(isBudgetSet(ok)).toBe(true);
    for (const bad of [
      { ...ok, later: true },
      { ...ok, categories: { a: { amount: 5, rollover: true } } },
      { ...ok, groups: { g: { amount: 5, months: {} } } },
      { ...ok, version: 2 },
      { ...ok, categories: { a: { amount: 0 } } },
      { ...ok, groups: { 'bad id': { amount: 1 } } },
      { ...ok, mirror_before: undefined },
    ]) {
      expect(isBudgetSet(bad)).toBe(false);
    }
  });

  test('a page’s budgets: ids to { amount }, to the cent, within the counts', () => {
    expect(readBudgets({ categories: { a: { amount: 12.345 } }, groups: { g: { amount: 1 } } })).toEqual({ categories: { a: { amount: 12.35 } }, groups: { g: { amount: 1 } } });
    for (const bad of [
      null,
      { categories: {} },
      { categories: { a: 5 }, groups: {} },
      { categories: { a: { amount: 0.001 } }, groups: {} },
      { categories: { a: { amount: 1e13 } }, groups: {} },
      { categories: {}, groups: Object.fromEntries(Array.from({ length: 51 }, (_, i) => [`g${i}`, { amount: 1 }])) },
      // 50 on categories, as the release before allowed, so its page can still save the copy it reads.
      { categories: Object.fromEntries(Array.from({ length: 51 }, (_, i) => [`c${i}`, { amount: 1 }])), groups: {} },
    ]) {
      expect(() => readBudgets(bad)).toThrow(BudgetError);
    }
  });
});

describe('spending rolled up to groups', () => {
  test('each group’s total and its categories’, most first; a category the set doesn’t have is left to the caller', () => {
    const kids = addGroup(t, { name: 'Kids', kind: 'expense' }, () => 'g-kids');
    const kix = indexTaxonomy(kids.taxonomy);
    const out = spendingByGroup(kix, new Map([[id('groceries'), 100], [id('coffee'), 20], [id('transportation'), 300], ['unknown', 5]]));
    expect(out.map((g) => [g.group.name, g.total, g.categories.map((c) => c.category.name)])).toEqual([
      ['Transport', 300, ['transportation']],
      ['Food', 120, ['groceries', 'coffee']],
    ]);
  });
});
