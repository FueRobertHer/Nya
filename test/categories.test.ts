import { describe, expect, test } from 'bun:test';
import {
  addCategory,
  addGroup,
  categoriesIn,
  categoryById,
  CategoryError,
  choiceText,
  deleteCategory,
  deleteGroup,
  displayName,
  groupOf,
  growTaxonomy,
  indexTaxonomy,
  isTaxonomy,
  legacyKind,
  MAX_CATEGORIES,
  mergeCategories,
  moveCategory,
  observedKeys,
  orderGroups,
  PLAID_PRIMARIES,
  plaidText,
  renameCategory,
  renameGroup,
  resolveCategory,
  seedTaxonomy,
  setArchived,
  setCategoryIcon,
  sortedGroups,
  textKey,
  textKeys,
  type Category,
  type CategoryFacts,
  type Taxonomy,
} from '@/lib/categories';

// Your categories (lib/categories.ts): the seed, resolution, growth, the
// stored shape and every edit, pure. The store around them is in
// test/category-store.test.ts.

/** Ids in the order made, so a test can say which is which. */
function ids(prefix = 'id') {
  let n = 0;
  return () => `${prefix}${++n}`;
}

/** Rows shaped as the assembly hands them over (lib/activity.ts): a bank's,
 *  one recategorized, one carried across a re-link, manual and imported ones,
 *  one stored before Plaid's values were, and one that says nothing. */
const ROWS: (CategoryFacts & { id: string })[] = [
  { id: 'coffee', category: 'food and drink', pfc_primary: 'FOOD_AND_DRINK', pfc_detailed: 'FOOD_AND_DRINK_COFFEE' },
  { id: 'rent', category: 'rent and utilities', pfc_primary: 'RENT_AND_UTILITIES', pfc_detailed: 'RENT_AND_UTILITIES_RENT' },
  { id: 'card-payment', category: 'loan payments', pfc_primary: 'LOAN_PAYMENTS', pfc_detailed: 'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT' },
  { id: 'recategorized', category: 'groceries', category_set: true, pfc_primary: 'GENERAL_MERCHANDISE', pfc_detailed: 'GENERAL_MERCHANDISE_SUPERSTORES' },
  { id: 'carried', category: 'gifts', category_set: true, pfc_primary: 'TRANSFER_OUT', pfc_detailed: 'TRANSFER_OUT_ACCOUNT_TRANSFER' },
  { id: 'manual', category: 'farmers market', source: 'manual' },
  { id: 'imported', category: 'transfer: savings', source: 'import:qif' },
  { id: 'legacy', category: 'transfer', pfc_primary: null, pfc_detailed: null },
  { id: 'nothing', category: null, pfc_primary: null, pfc_detailed: null },
];

const seeded = (observed = observedKeys(ROWS)) => seedTaxonomy(observed, ids());
const byName = (t: Taxonomy, name: string) => t.categories.find((c) => c.name === name)!;
const groupNamed = (t: Taxonomy, name: string) => t.groups.find((g) => g.name === name)!;
const filedName = (t: Taxonomy, row: CategoryFacts) => resolveCategory(indexTaxonomy(t), row).category.name;

describe('the seed', () => {
  test('the default groups in order, every Plaid primary in its group with its words, and other as uncategorized', () => {
    const t = seedTaxonomy([], ids());
    expect(sortedGroups(t).map((g) => [g.name, g.kind])).toEqual([
      ['Income', 'income'],
      ['Food', 'expense'],
      ['Shopping', 'expense'],
      ['Housing', 'expense'],
      ['Transport', 'expense'],
      ['Travel and entertainment', 'expense'],
      ['Health and personal care', 'expense'],
      ['Services and fees', 'expense'],
      ['Other', 'expense'],
      ['Transfers', 'transfer'],
    ]);
    for (const value of Object.keys(PLAID_PRIMARIES)) {
      const c = t.categories.find((x) => x.provider_keys.some((k) => k.provider === 'plaid' && k.key === value))!;
      // Named exactly as Nya showed the category before categories had ids.
      expect(c.name).toBe(plaidText(value));
      expect(c.provider_keys).toEqual([
        { provider: 'plaid', key: value },
        { provider: 'text', key: plaidText(value) },
      ]);
    }
    expect(groupOf(indexTaxonomy(t), byName(t, 'food and drink')).name).toBe('Food');
    expect(groupOf(indexTaxonomy(t), byName(t, 'loan payments')).name).toBe('Transfers');
    const other = t.categories.find((c) => c.id === t.uncategorized)!;
    expect(other).toMatchObject({ name: 'other', provider_keys: [{ provider: 'text', key: 'other' }] });
    expect(groupOf(indexTaxonomy(t), other).name).toBe('Other');
    expect(isTaxonomy(t)).toBe(true);
  });

  test('from the categories already on the person’s data: each where its kind belongs, so no total moves', () => {
    const t = seeded();
    const ix = indexTaxonomy(t);
    const where = (name: string) => groupOf(ix, byName(t, name)).name;
    // Words of the person's own, or a file's, become categories of their own.
    expect(where('groceries')).toBe('Other');
    expect(where('gifts')).toBe('Other');
    expect(where('farmers market')).toBe('Other');
    // Words the spending rule called transfers are in a transfer group.
    expect(where('transfer: savings')).toBe('Transfers');
    expect(where('transfer')).toBe('Transfers');
    // Every category's kind is what the spending rule gave each of its words.
    for (const c of t.categories) {
      for (const k of c.provider_keys.filter((k) => k.provider === 'text')) expect([c.name, groupOf(ix, c).kind]).toEqual([c.name, legacyKind(k.key)]);
    }
    expect(isTaxonomy(t)).toBe(true);
  });

  test('a budget saved under a name with capitals keeps them, and words already a category join it', () => {
    const t = seedTaxonomy(textKeys(['Food', 'Travel', '  Food  ', 'income']), ids());
    expect(byName(t, 'Food').provider_keys).toEqual([{ provider: 'text', key: 'food' }]);
    // "Travel" is Plaid's travel, seeded: no second one.
    expect(t.categories.filter((c) => textKey(c.name) === 'travel')).toHaveLength(1);
    expect(t.categories.filter((c) => c.name === 'income')).toHaveLength(1);
  });

  test('ids are the factory’s: random in the app, and never two alike', () => {
    const t = seeded();
    const all = [...t.groups.map((g) => g.id), ...t.categories.map((c) => c.id)];
    expect(new Set(all).size).toBe(all.length);
  });
});

describe('resolution', () => {
  const t = seeded();
  const ix = indexTaxonomy(t);
  const row = (id: string) => ROWS.find((r) => r.id === id)!;
  const filed = (r: CategoryFacts) => resolveCategory(ix, r);

  test('the person’s own choice first, over what Plaid says', () => {
    expect(filed(row('recategorized')).category.name).toBe('groceries');
    expect(filed(row('carried')).category.name).toBe('gifts');
    // Even when Plaid's detailed value is mapped to a category of its own.
    const coffee = addCategory(t, { name: 'Coffee', group: groupNamed(t, 'Food').id }, ids('c'));
    const mapped = mapKey(coffee.taxonomy, coffee.category.id, 'plaid', 'GENERAL_MERCHANDISE_SUPERSTORES');
    expect(resolveCategory(indexTaxonomy(mapped), row('recategorized')).category.name).toBe('groceries');
  });

  test('then Plaid: its detailed value where one is mapped, else its primary', () => {
    expect(filed(row('coffee')).category.name).toBe('food and drink');
    const coffee = addCategory(t, { name: 'Coffee', group: groupNamed(t, 'Food').id }, ids('c'));
    const mapped = mapKey(coffee.taxonomy, coffee.category.id, 'plaid', 'FOOD_AND_DRINK_COFFEE');
    expect(resolveCategory(indexTaxonomy(mapped), row('coffee')).category.name).toBe('Coffee');
    expect(resolveCategory(indexTaxonomy(mapped), { ...row('coffee'), pfc_detailed: 'FOOD_AND_DRINK_RESTAURANT' }).category.name).toBe('food and drink');
  });

  test('a manual or imported row by its own words, a row stored before Plaid’s values by its words', () => {
    expect(filed(row('manual')).category.name).toBe('farmers market');
    expect(filed(row('imported')).category.name).toBe('transfer: savings');
    expect(filed(row('legacy')).category.name).toBe('transfer');
    // Words are matched as keys: case and spaces don't matter.
    expect(filed({ category: '  Farmers   MARKET ', source: 'manual' }).category.name).toBe('farmers market');
  });

  test('a row that says nothing is filed as uncategorized, and says so', () => {
    expect(filed(row('nothing'))).toEqual({ category: t.categories.find((c) => c.id === t.uncategorized)!, said: false });
    expect(filed({ category: 'other', source: 'manual' })).toMatchObject({ said: true });
    expect(filed({ category: 'other', source: 'manual' }).category.id).toBe(t.uncategorized);
  });

  test('every key the rows carry is one the seed has, so nothing is filed by default', () => {
    expect(growTaxonomy(t, observedKeys(ROWS), ids('x')).added).toBe(0);
  });
});

/** The set with one more key on a category (as a later hand-made mapping would). */
function mapKey(t: Taxonomy, id: string, provider: string, key: string): Taxonomy {
  return { ...t, categories: t.categories.map((c) => (c.id === id ? { ...c, provider_keys: [...c.provider_keys, { provider, key }] } : c)) };
}

describe('growing', () => {
  test('a key no category has: a new category where its kind belongs, ids for the new only', () => {
    const t = seeded();
    const before = new Map(t.categories.map((c) => [c.name, c.id]));
    const { taxonomy, added } = growTaxonomy(t, textKeys(['pet supplies', 'transfers to mum', 'income']), ids('new'));
    expect(added).toBe(2);
    const ix = indexTaxonomy(taxonomy);
    expect(groupOf(ix, byName(taxonomy, 'pet supplies')).name).toBe('Other');
    expect(groupOf(ix, byName(taxonomy, 'transfers to mum')).name).toBe('Transfers');
    for (const [name, id] of before) expect(byName(taxonomy, name).id).toBe(id);
  });

  test('Plaid starting a new primary: a category with its value and its words; one that already has its words takes it', () => {
    const t = seeded();
    const fresh = growTaxonomy(t, [{ provider: 'plaid', key: 'LOAN_DISBURSEMENTS' }], ids('new')).taxonomy;
    expect(byName(fresh, 'loan disbursements').provider_keys).toEqual([
      { provider: 'plaid', key: 'LOAN_DISBURSEMENTS' },
      { provider: 'text', key: 'loan disbursements' },
    ]);
    // "farmers market" was seeded from words; Plaid's value for it joins it.
    const joined = growTaxonomy(t, [{ provider: 'plaid', key: 'FARMERS_MARKET' }], ids('new')).taxonomy;
    expect(byName(joined, 'farmers market').provider_keys.map((k) => k.key)).toEqual(['farmers market', 'FARMERS_MARKET']);
    expect(joined.categories).toHaveLength(t.categories.length);
  });

  test('words that are a category’s name join it, so a renamed category keeps what a file calls it', () => {
    const t = seeded();
    const renamed = renameCategory(t, byName(t, 'groceries').id, 'Supermarket');
    const grown = growTaxonomy(renamed, textKeys(['SUPERMARKET']), ids('new')).taxonomy;
    expect(byName(grown, 'Supermarket').provider_keys.map((k) => k.key)).toEqual(['groceries', 'supermarket']);
  });

  test('a group of the kind it needs is made when none is left', () => {
    const t = seeded();
    const withoutTransfers = { ...t, groups: t.groups.filter((g) => g.kind !== 'transfer'), categories: t.categories.filter((c) => groupOf(indexTaxonomy(t), c).kind !== 'transfer') };
    const grown = growTaxonomy(withoutTransfers, textKeys(['transfer out']), ids('new')).taxonomy;
    const g = groupOf(indexTaxonomy(grown), byName(grown, 'transfer out'));
    expect([g.name, g.kind]).toEqual(['Transfers', 'transfer']);
    expect(isTaxonomy(grown)).toBe(true);
  });

  test('nothing to add answers the same set, and stops at the limit, except for what must have a category', () => {
    const t = seeded();
    expect(growTaxonomy(t, observedKeys(ROWS), ids()).taxonomy).toBe(t);
    const many = textKeys(Array.from({ length: MAX_CATEGORIES }, (_, i) => `category ${i}`));
    const full = growTaxonomy(t, many, ids('n'));
    expect(full.full).toBe(true);
    expect(full.taxonomy.categories).toHaveLength(MAX_CATEGORIES);
    const past = growTaxonomy(full.taxonomy, textKeys(['a budget name']), ids('b'), { limit: Infinity });
    expect(past.added).toBe(1);
    // A key with no room is filed as uncategorized, saying it said something.
    const ix = indexTaxonomy(full.taxonomy);
    expect(resolveCategory(ix, { category: 'no room', source: 'manual' })).toMatchObject({ said: true, category: { id: t.uncategorized } });
  });
});

describe('the stored shape', () => {
  const t = seeded();
  const broken: [string, (t: Taxonomy) => unknown][] = [
    ['another version', (t) => ({ ...t, version: 2 })],
    ['a repeated category id', (t) => ({ ...t, categories: [...t.categories, { ...t.categories[1], provider_keys: [{ provider: 'text', key: 'zz' }] }] })],
    ['a category in no group', (t) => ({ ...t, categories: [{ ...t.categories[0], group: 'nope' }, ...t.categories.slice(1)] })],
    ['a key in two categories', (t) => mapKey(t, t.categories[1].id, 'text', choiceText(t.categories[2]))],
    ['a category without words', (t) => ({ ...t, categories: [...t.categories, { id: 'bare', name: 'bare', group: t.groups[0].id, provider_keys: [{ provider: 'plaid', key: 'BARE' }] }] })],
    ['no uncategorized category', (t) => ({ ...t, uncategorized: 'gone' })],
    ['a merge into nothing', (t) => ({ ...t, merged: { old: 'gone' } })],
    ['a provisional id', (t) => ({ ...t, categories: [...t.categories, { id: 'new:1', name: 'x', group: t.groups[0].id, provider_keys: [{ provider: 'text', key: 'x' }] }] })],
    ['a blank name', (t) => ({ ...t, categories: [{ ...t.categories[0], name: '  ' }, ...t.categories.slice(1)] })],
    ['an unknown kind', (t) => ({ ...t, groups: [{ ...t.groups[0], kind: 'savings' }, ...t.groups.slice(1)] })],
  ];
  for (const [what, make] of broken) {
    test(`refuses ${what}`, () => expect(isTaxonomy(make(t))).toBe(false));
  }

  test('lets through fields a later release adds, so a rollback still reads the set', () => {
    const later = { ...t, colors: true, groups: t.groups.map((g) => ({ ...g, color: 'red' })), categories: t.categories.map((c) => ({ ...c, rollover: true })) };
    expect(isTaxonomy(later)).toBe(true);
    // And every edit here keeps them.
    const renamed = renameCategory(later as Taxonomy, t.categories[3].id, 'Renamed') as Taxonomy & { colors?: boolean };
    expect(renamed.colors).toBe(true);
    expect((renamed.categories[3] as Category & { rollover?: boolean }).rollover).toBe(true);
  });
});

describe('managing', () => {
  const fresh = () => seeded();
  const err = (fn: () => unknown) => {
    try {
      fn();
    } catch (e) {
      return e as CategoryError;
    }
    throw new Error('expected a refusal');
  };

  test('renaming renames everywhere at once: the same id, the same keys, so every row and reference follows', () => {
    const t = fresh();
    const food = byName(t, 'food and drink');
    const renamed = renameCategory(t, food.id, 'Eating');
    expect(byName(renamed, 'Eating')).toEqual({ ...food, name: 'Eating' });
    expect(resolveCategory(indexTaxonomy(renamed), ROWS[0]).category.id).toBe(food.id);
    expect(filedName(renamed, ROWS[0])).toBe('Eating');
    // A choice of it is still stored as its first words, which an earlier
    // release reads as before.
    expect(choiceText(byName(renamed, 'Eating'))).toBe('food and drink');
    expect(err(() => renameCategory(t, food.id, 'GROCERIES'))).toMatchObject({ status: 409, message: 'There is already a category named groceries. Merge the two to make them one.' });
    expect(err(() => renameCategory(t, food.id, '   '))).toMatchObject({ status: 400 });
    expect(err(() => renameCategory(t, food.id, 'x'.repeat(61))).status).toBe(400);
    expect(err(() => renameCategory(t, 'nope', 'x')).status).toBe(404);
    // A change of case alone is a rename.
    expect(byName(renameCategory(t, food.id, 'Food And Drink'), 'Food And Drink').id).toBe(food.id);
  });

  test('adding: a unique name, in a group, under its own words, or the first free variant of them', () => {
    const t = fresh();
    const { taxonomy, category } = addCategory(t, { name: '  Coffee  shops ', group: groupNamed(t, 'Food').id, icon: '☕' }, ids('c'));
    expect(category).toEqual({ id: 'c1', name: 'Coffee shops', group: groupNamed(t, 'Food').id, icon: '☕', provider_keys: [{ provider: 'text', key: 'coffee shops' }] });
    expect(isTaxonomy(taxonomy)).toBe(true);
    // Its words taken by a category since renamed: the next free variant.
    const renamed = renameCategory(taxonomy, category.id, 'Cafés');
    const again = addCategory(renamed, { name: 'Coffee shops', group: groupNamed(t, 'Food').id }, ids('d'));
    expect(choiceText(again.category)).toBe('coffee shops (2)');
    expect(err(() => addCategory(t, { name: 'Groceries', group: t.groups[0].id }, ids()))).toMatchObject({ status: 409 });
    const archived = setArchived(t, byName(t, 'groceries').id, true);
    expect(err(() => addCategory(archived, { name: 'groceries', group: t.groups[0].id }, ids())).message).toContain('archived: unarchive it instead');
    expect(err(() => addCategory(t, { name: 'New', group: 'nope' }, ids())).status).toBe(404);
    expect(err(() => addCategory(t, { name: 'New', group: t.groups[0].id, icon: 'x'.repeat(17) }, ids())).status).toBe(400);
  });

  test('an icon is set and cleared', () => {
    const t = fresh();
    const id = byName(t, 'travel').id;
    expect(byName(setCategoryIcon(t, id, '✈️'), 'travel').icon).toBe('✈️');
    expect('icon' in byName(setCategoryIcon(setCategoryIcon(t, id, '✈️'), id, ''), 'travel')).toBe(false);
  });

  test('moving into a group of another kind changes how it counts; the uncategorized category stays spending', () => {
    const t = fresh();
    const loans = byName(t, 'loan payments');
    const moved = moveCategory(t, loans.id, groupNamed(t, 'Housing').id);
    expect(groupOf(indexTaxonomy(moved), byName(moved, 'loan payments')).kind).toBe('expense');
    expect(err(() => moveCategory(t, t.uncategorized, groupNamed(t, 'Transfers').id))).toMatchObject({ status: 409 });
    const intoFood = moveCategory(t, t.uncategorized, groupNamed(t, 'Food').id);
    expect(groupOf(indexTaxonomy(intoFood), byName(intoFood, 'other')).name).toBe('Food');
  });

  test('archiving keeps it on every row, filing new ones; uncategorized can’t be archived', () => {
    const t = fresh();
    const archived = setArchived(t, byName(t, 'food and drink').id, true);
    expect(byName(archived, 'food and drink').archived).toBe(true);
    expect(filedName(archived, ROWS[0])).toBe('food and drink');
    expect('archived' in byName(setArchived(archived, byName(t, 'food and drink').id, false), 'food and drink')).toBe(false);
    expect(err(() => setArchived(t, t.uncategorized, true)).status).toBe(409);
  });

  test('merging moves every key, so every row filed under either is filed under the one kept, and the merged id still finds it', () => {
    const t = fresh();
    const groceries = byName(t, 'groceries');
    const food = byName(t, 'food and drink');
    const merged = mergeCategories(t, groceries.id, food.id);
    const ix = indexTaxonomy(merged);
    expect(merged.categories.find((c) => c.id === groceries.id)).toBeUndefined();
    expect(byName(merged, 'food and drink').provider_keys.map((k) => k.key)).toEqual(['FOOD_AND_DRINK', 'food and drink', 'groceries']);
    expect(resolveCategory(ix, ROWS[3]).category.id).toBe(food.id);
    expect(categoryById(ix, groceries.id)!.id).toBe(food.id);
    // Merged again: the earlier merge follows to where it went.
    const shopping = byName(merged, 'general merchandise');
    const twice = mergeCategories(merged, food.id, shopping.id);
    expect(twice.merged).toEqual({ [groceries.id]: shopping.id, [food.id]: shopping.id });
    expect(isTaxonomy(twice)).toBe(true);
  });

  test('merging is refused across kinds, away from uncategorized, into an archived one, or into itself', () => {
    const t = fresh();
    const food = byName(t, 'food and drink');
    expect(err(() => mergeCategories(t, byName(t, 'transfer out').id, food.id))).toMatchObject({
      status: 409,
      message: 'transfer out counts as a transfer and food and drink as spending, so merging them would change your totals. Move one into a group of the other\'s kind first.',
    });
    expect(err(() => mergeCategories(t, t.uncategorized, food.id)).status).toBe(409);
    // Into uncategorized is fine: it is a spending category like the rest.
    expect(mergeCategories(t, byName(t, 'groceries').id, t.uncategorized).categories.find((c) => c.name === 'groceries')).toBeUndefined();
    expect(err(() => mergeCategories(setArchived(t, food.id, true), byName(t, 'groceries').id, food.id)).status).toBe(409);
    expect(err(() => mergeCategories(t, food.id, food.id)).status).toBe(400);
  });

  test('deleting only what nothing uses, never one Plaid files into, never uncategorized', () => {
    const t = fresh();
    const market = byName(t, 'farmers market');
    expect(err(() => deleteCategory(t, market.id, { transactions: 2, budget: true }))).toMatchObject({
      status: 409,
      message: 'farmers market is used by 2 transactions and a budget, so it can\'t be deleted. Merge it into another category, or archive it to hide it.',
    });
    expect(err(() => deleteCategory(t, byName(t, 'travel').id, { transactions: 0, budget: false })).message).toContain('Plaid files');
    expect(err(() => deleteCategory(t, t.uncategorized, { transactions: 0, budget: false })).status).toBe(409);
    const gone = deleteCategory(t, market.id, { transactions: 0, budget: false });
    expect(gone.categories.find((c) => c.id === market.id)).toBeUndefined();
    expect(isTaxonomy(gone)).toBe(true);
    // A merge that pointed at it goes with it.
    const withMerge = mergeCategories(t, byName(t, 'gifts').id, market.id);
    expect(deleteCategory(withMerge, market.id, { transactions: 0, budget: false }).merged).toEqual({});
  });

  test('groups: added last with a kind, renamed, reordered whole, deleted only when empty and unbudgeted', () => {
    const t = fresh();
    const { taxonomy, group } = addGroup(t, { name: 'Kids', kind: 'expense' }, ids('g'));
    expect(group).toEqual({ id: 'g1', name: 'Kids', kind: 'expense', order: 10 });
    expect(err(() => addGroup(t, { name: 'food', kind: 'expense' }, ids())).status).toBe(409);
    expect(err(() => addGroup(t, { name: 'Savings', kind: 'savings' }, ids())).status).toBe(400);
    expect(renameGroup(taxonomy, 'g1', 'Children').groups.find((g) => g.id === 'g1')!.name).toBe('Children');
    const reversed = [...sortedGroups(taxonomy)].reverse().map((g) => g.id);
    expect(sortedGroups(orderGroups(taxonomy, reversed)).map((g) => g.id)).toEqual(reversed);
    // A list that isn't every group once, in some order, is refused.
    expect(err(() => orderGroups(taxonomy, reversed.slice(1))).status).toBe(409);
    expect(err(() => orderGroups(taxonomy, [...reversed.slice(1), reversed[1]])).status).toBe(409);
    expect(err(() => deleteGroup(taxonomy, groupNamed(t, 'Food').id, false)).message).toBe('Food still holds 1 category: move or merge them into other groups first.');
    expect(err(() => deleteGroup(taxonomy, 'g1', true)).status).toBe(409);
    expect(deleteGroup(taxonomy, 'g1', false).groups.find((g) => g.id === 'g1')).toBeUndefined();
  });

  test('a group’s categories by name', () => {
    const t = fresh();
    expect(categoriesIn(t, groupNamed(t, 'Transfers').id).map((c) => c.name)).toEqual(['loan payments', 'transfer', 'transfer in', 'transfer out', 'transfer: savings']);
  });
});

describe('showing names', () => {
  test('as typed with a capital, else with the first letter in capitals', () => {
    expect(displayName('food and drink')).toBe('Food and drink');
    expect(displayName('iCloud')).toBe('iCloud');
    expect(displayName('Eating Out')).toBe('Eating Out');
    expect(displayName('☕ coffee')).toBe('☕ coffee');
    expect(displayName('')).toBe('');
  });
});
