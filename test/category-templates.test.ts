import { describe, expect, test, mock, beforeEach, afterEach } from 'bun:test';
import { FakeRedis, storageMock, TEST_CTX, ctxKey, registerTestContainer, unscopedDataKeys } from './fake-redis';
import {
  CategoryError,
  addCategory,
  addGroup,
  categoryForKey,
  indexTaxonomy,
  mergeCategories,
  moveCategory,
  renameCategory,
  renameGroup,
  seedTaxonomy,
  setArchived,
  textKeys,
  MAX_GROUPS,
  MAX_CATEGORIES,
  type CategoryUsage,
  type Taxonomy,
} from '@/lib/categories';
import {
  archiveCandidates,
  isSeededSet,
  planTemplate,
  readUndo,
  SEEDED_KEYS,
  TEMPLATE_IDS,
  TEMPLATES,
  UNCATEGORIZED_KEY,
  undoOf,
  undoTemplate,
  groupsWithBudgets,
  type PlanFacts,
  type TemplateUndo,
} from '@/lib/category-templates';
import { budgetMeters, placeBudgets, type Budgets } from '@/lib/budget-set';
import { applyTemplate, changeLine, keptGroupLine, keptLine, PlanView, CategoryTemplatesView, undoKeptLine, type ShownPlan } from '@/components/CategoryTemplates';
import TemplateOffer, { offeredHere, TemplateOfferCard, TEMPLATE_OFFER_KEY } from '@/components/TemplateOffer';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';

// Starter category templates (lib/category-templates.ts): what a template may
// change and nothing else (it never deletes or merges a category, never moves
// one into a group of another kind, never changes what a group with a budget
// of its own holds), the preview it shows before anything changes, budgets
// following their categories by id, applying twice changing nothing, the
// undo, and the route that previews, applies and undoes in one
// compare-and-set, refusing what changed since the preview.

process.env.PLAID_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');

// Nothing here may call Plaid: what uses a category is read from storage.
mock.module('@/lib/plaid', () => ({
  plaidClient: new Proxy({}, { get: () => () => Promise.reject(new Error('Plaid must not be called')) }),
}));

const fake = new FakeRedis({ deserialize: true });
afterEach(() => expect(unscopedDataKeys(fake)).toEqual([]));
mock.module('@/lib/storage', () => storageMock(fake));

const { forgetEpochs } = await import('@/lib/sessions');
const { setOverride } = await import('@/lib/overrides');
const { ensureTaxonomy, readTaxonomy } = await import('@/lib/category-store');
const route = await import('@/app/api/categories/templates/route');
const budgetsRoute = await import('@/app/api/budgets/route');

const ctx = TEST_CTX;
const OTHER = { container: '3f0b8c1e-6d2a-4b5c-9e7f-0a1b2c3d4e5f' } as typeof TEST_CTX;
const KEY = ctxKey('categories');

const NO_BUDGETS: Budgets = { categories: {}, groups: {} };
// Ids made in order, never twice in the file: a plan's new ids never collide
// with the set's.
let made = 0;
const ids = () => () => `id${++made}`;
/** A set seeded as the app seeds one, with these words grown into it. */
const seeded = (words: string[] = []) => seedTaxonomy(textKeys(words), ids());
const named = (t: Taxonomy, name: string) => t.categories.find((c) => c.name.toLowerCase() === name.toLowerCase());
const groupNamed = (t: Taxonomy, name: string) => t.groups.find((g) => g.name === name);
const groupOf = (t: Taxonomy, name: string) => t.groups.find((g) => g.id === named(t, name)!.group)!.name;
/** Nothing uses any of these: the usage a route would read. */
const nothing = (t: Taxonomy, template = TEMPLATES.simple): Map<string, CategoryUsage> =>
  new Map(archiveCandidates(t, template).map((id) => [id, { transactions: 0, budget: false, rules: 0, keys: t.categories.find((c) => c.id === id)!.provider_keys }]));
const facts = (t: Taxonomy, over: Partial<PlanFacts> = {}): PlanFacts => ({ budgets: NO_BUDGETS, usage: nothing(t), recorded: new Set(), newId: ids(), ...over });
/** What uses each category an undo would remove: nothing. */
const addedUnused = (t: Taxonomy, undo: TemplateUndo, used: Record<string, number> = {}) =>
  new Map(undo.added.categories.map(({ id }) => [id, { transactions: used[id] ?? 0, budget: false, rules: 0, keys: t.categories.find((c) => c.id === id)!.provider_keys }]));
/** The set's shape, ids aside: each group in order with its categories. */
const shape = (t: Taxonomy) =>
  [...t.groups]
    .sort((a, b) => a.order - b.order)
    .map((g) => [g.name, g.kind, t.categories.filter((c) => c.group === g.id).map((c) => `${c.name}${c.archived ? ' (archived)' : ''}`).sort()]);

describe('the templates themselves', () => {
  test('each places every category Nya starts with, in a group of the kind it counts as, and Other in a spending group', () => {
    const seed = seeded();
    const ix = indexTaxonomy(seed);
    for (const id of TEMPLATE_IDS) {
      const tpl = TEMPLATES[id];
      expect([id, Object.keys(tpl.seeded).sort()]).toEqual([id, [...SEEDED_KEYS].sort()]);
      const kinds = new Map(tpl.groups.map((g) => [g.name, g.kind]));
      // Group names and category names are each unique in the template.
      expect(kinds.size).toBe(tpl.groups.length);
      const names = [...Object.values(tpl.seeded).map((p) => p.name), ...tpl.added.map((a) => a.name)].map((n) => n.toLowerCase());
      expect(new Set(names).size).toBe(names.length);
      for (const [key, p] of Object.entries(tpl.seeded)) {
        const c = key === UNCATEGORIZED_KEY ? ix.byId.get(seed.uncategorized)! : seed.categories.find((x) => x.provider_keys.some((k) => k.provider === 'plaid' && k.key === key))!;
        expect([id, key, kinds.get(p.group)]).toEqual([id, key, ix.groupById.get(c.group)!.kind]);
      }
      expect(kinds.get(tpl.seeded[UNCATEGORIZED_KEY].group)).toBe('expense');
      for (const a of tpl.added) expect(kinds.has(a.group)).toBe(true);
    }
  });

  test('Detailed is the seed itself: on a set still as Nya made it, it changes nothing', () => {
    const seed = seeded(['groceries', 'coffee']);
    expect(isSeededSet(seed)).toBe(true);
    const plan = planTemplate(seed, TEMPLATES.detailed, facts(seed, { usage: nothing(seed, TEMPLATES.detailed) }));
    expect(plan.unchanged).toBe(true);
    expect(shape(plan.taxonomy)).toEqual(shape(seed));
  });

  test('a set someone changed is no longer the seeded one, and isn’t offered them', () => {
    const seed = seeded();
    expect(isSeededSet(renameCategory(seed, named(seed, 'travel')!.id, 'Trips'))).toBe(false);
    expect(isSeededSet(setArchived(seed, named(seed, 'travel')!.id, true))).toBe(false);
    expect(isSeededSet(addGroup(seed, { name: 'Kids', kind: 'expense' }, ids()).taxonomy)).toBe(false);
    expect(isSeededSet(mergeCategories(seed, named(seed, 'entertainment')!.id, named(seed, 'travel')!.id))).toBe(false);
    const applied = planTemplate(seed, TEMPLATES.simple, facts(seed)).taxonomy;
    expect(isSeededSet(applied)).toBe(false);
  });
});

describe('the preview', () => {
  test('Simple on the seed: its groups added, the emptied ones removed, each category renamed and moved, the unused ones archived', () => {
    const seed = seeded(['groceries']);
    const plan = planTemplate(seed, TEMPLATES.simple, facts(seed));
    expect(plan.groups.added).toEqual(['Everyday', 'Home and bills', 'Fun']);
    expect(plan.groups.removed).toEqual(['Food', 'Shopping', 'Housing', 'Transport', 'Travel and entertainment', 'Health and personal care', 'Services and fees']);
    const line = (name: string) => changeLine(plan.categories.find((c) => c.name === name)!);
    expect(line('Food')).toBe('Food and drink becomes Food, in Everyday.');
    // A name that only changes its capitals isn't one the app shows.
    expect(line('Income')).toBeNull();
    expect(line('Home improvement')).toBe('Home improvement moves from Housing to Home and bills. Archived, since nothing uses it.');
    expect(line('Taxes and donations')).toBe('Government and non profit becomes Taxes and donations, in Home and bills. Archived, since nothing uses it.');
    expect(plan.kept).toEqual([]);
    // What it makes: six groups, in its order, your own category where it was.
    expect(shape(plan.taxonomy)).toEqual([
      ['Income', 'income', ['Income']],
      ['Everyday', 'expense', ['Food', 'Personal care (archived)', 'Shopping', 'Transport']],
      ['Home and bills', 'expense', ['Fees', 'Health', 'Home and utilities', 'Home improvement (archived)', 'Services', 'Taxes and donations (archived)']],
      ['Fun', 'expense', ['Entertainment', 'Travel']],
      ['Other', 'expense', ['Other', 'groceries']],
      ['Transfers', 'transfer', ['Loan payments', 'Transfers in', 'Transfers out']],
    ]);
  });

  test('never deletes or merges a category, and never changes how one counts', () => {
    const seed = seeded(['groceries', 'coffee']);
    for (const id of TEMPLATE_IDS) {
      const plan = planTemplate(seed, TEMPLATES[id], facts(seed, { usage: nothing(seed, TEMPLATES[id]) }));
      const after = indexTaxonomy(plan.taxonomy);
      const before = indexTaxonomy(seed);
      for (const c of seed.categories) {
        const now = after.byId.get(c.id);
        expect([id, c.name, !!now]).toEqual([id, c.name, true]);
        // Its keys, so every transaction stays filed where it was.
        expect(now!.provider_keys).toEqual(c.provider_keys);
        expect(after.groupById.get(now!.group)!.kind).toBe(before.groupById.get(c.group)!.kind);
      }
      expect(plan.taxonomy.merged ?? {}).toEqual(seed.merged ?? {});
    }
  });

  test('one it would archive that has transactions, a budget or a rule stays shown, and the preview says why', () => {
    const seed = seeded();
    const [care, improvement, government] = ['personal care', 'home improvement', 'government and non profit'].map((n) => named(seed, n)!);
    const usage = new Map<string, CategoryUsage>([
      [care.id, { transactions: 3, budget: false, rules: 0 }],
      [improvement.id, { transactions: 0, budget: true, rules: 0 }],
      [government.id, { transactions: 0, budget: false, rules: 2 }],
    ]);
    const plan = planTemplate(seed, TEMPLATES.simple, facts(seed, { usage }));
    for (const c of [care, improvement, government]) expect(plan.taxonomy.categories.find((x) => x.id === c.id)!.archived).toBeUndefined();
    expect(plan.kept.map((k) => keptLine(k, 'Simple'))).toEqual([
      'Personal care isn’t archived: 3 transactions are filed under it.',
      'Home improvement isn’t archived: it has a budget.',
      'Government and non profit isn’t archived: 2 rules use it.',
    ]);
    // Still renamed and moved into Simple's group.
    expect(groupOf(plan.taxonomy, 'Personal care')).toBe('Everyday');
    // Usage not read (missing) counts as used: never archived on a guess.
    const unknown = planTemplate(seed, TEMPLATES.simple, facts(seed, { usage: new Map() }));
    expect(unknown.taxonomy.categories.some((c) => c.archived)).toBe(false);
    expect(keptLine(unknown.kept[0], 'Simple')).toBe('Personal care isn’t archived: what uses it couldn’t be counted.');
  });

  test('budgets follow their categories by id, and a group with a budget of its own keeps what it holds', () => {
    const seed = seeded();
    const food = named(seed, 'food and drink')!;
    const housing = groupNamed(seed, 'Housing')!;
    const budgets: Budgets = { categories: { [food.id]: { amount: 400 } }, groups: { [housing.id]: { amount: 1500 } } };
    const plan = planTemplate(seed, TEMPLATES.simple, facts(seed, { budgets }));
    expect(plan.budgets).toEqual([{ id: food.id, name: 'Food', group: 'Everyday' }]);
    // The budget is where it was, by id, and the meters find it in Everyday.
    const ix = indexTaxonomy(plan.taxonomy);
    const meters = budgetMeters(ix, placeBudgets(budgets, ix), new Map([[food.id, 120]]));
    const everyday = meters.groups.find((g) => g.group.name === 'Everyday')!;
    expect(everyday.categories.find((c) => c.category.id === food.id)).toMatchObject({ budget: 400, spent: 120 });
    // Housing keeps both its categories, its name and its budget's reach.
    expect(groupNamed(plan.taxonomy, 'Housing')!.id).toBe(housing.id);
    expect(plan.taxonomy.categories.filter((c) => c.group === housing.id).map((c) => c.name).sort()).toEqual(['Home and utilities', 'Home improvement']);
    expect(plan.groups.removed).not.toContain('Housing');
    expect(plan.kept.filter((k) => k.why === 'group-budget').map((k) => keptLine(k, 'Simple'))).toEqual([
      'Rent and utilities stays where it is: Housing has a budget of its own, so what it holds stays the same.',
      'Home improvement stays where it is: Housing has a budget of its own, so what it holds stays the same.',
    ]);
    // And nothing moves into a group with a budget of its own.
    const everydayGroup = { ...facts(seed), budgets };
    const applied = planTemplate(seed, TEMPLATES.simple, everydayGroup).taxonomy;
    const lockedEveryday: Budgets = { categories: {}, groups: { [groupNamed(applied, 'Everyday')!.id]: { amount: 900 } } };
    const detailed = planTemplate(applied, TEMPLATES.detailed, facts(applied, { budgets: lockedEveryday, usage: nothing(applied, TEMPLATES.detailed) }));
    expect(detailed.taxonomy.categories.filter((c) => c.group === groupNamed(applied, 'Everyday')!.id).map((c) => c.name).sort()).toEqual(
      ['food and drink', 'general merchandise', 'personal care', 'transportation']
    );
  });

  test('a category someone moved into a group of another kind stays there, renamed, so it counts as they chose', () => {
    let t = seeded();
    t = addGroup(t, { name: 'Debts', kind: 'expense' }, ids()).taxonomy;
    t = moveCategory(t, named(t, 'loan payments')!.id, groupNamed(t, 'Debts')!.id);
    const plan = planTemplate(t, TEMPLATES.simple, facts(t));
    expect(groupOf(plan.taxonomy, 'Loan payments')).toBe('Debts');
    expect(plan.kept.map((k) => keptLine(k, 'Simple'))).toContain('Loan payments stays where it is: Simple’s group for it counts its transactions another way, which would change your totals.');
  });

  test('a name another category has is kept, a seeded category found by its key though renamed, and one merged placed once', () => {
    let t = seeded();
    // A category of yours called Food: food and drink keeps its name.
    t = addCategory(t, { name: 'Food', group: groupNamed(t, 'Other')!.id }, ids()).taxonomy;
    // Travel renamed: still found by Plaid's key, and given Simple's name.
    t = renameCategory(t, named(t, 'travel')!.id, 'Trips');
    // Entertainment merged into Trips: placed once, as Travel.
    t = mergeCategories(t, named(t, 'entertainment')!.id, named(t, 'Trips')!.id);
    const plan = planTemplate(t, TEMPLATES.simple, facts(t));
    expect(named(plan.taxonomy, 'food and drink')).toBeDefined();
    expect(plan.kept.map((k) => keptLine(k, 'Simple'))).toContain('Food and drink keeps its name: another category is called Food.');
    expect(named(plan.taxonomy, 'Travel')!.id).toBe(named(t, 'Trips')!.id);
    expect(plan.merged).toEqual([{ name: 'entertainment', into: 'Travel' }]);
  });

  test('a category another was merged into is placed as what it is, never archived while it holds one the template keeps', () => {
    // Personal care merged into medical: medical becomes Health, where Simple
    // puts it, and the note says personal care went into it.
    let t = seeded();
    t = mergeCategories(t, named(t, 'personal care')!.id, named(t, 'medical')!.id);
    const medical = named(t, 'medical')!;
    let plan = planTemplate(t, TEMPLATES.simple, facts(t));
    expect(named(plan.taxonomy, 'Health')!.id).toBe(medical.id);
    expect(groupOf(plan.taxonomy, 'Health')).toBe('Home and bills');
    expect(named(plan.taxonomy, 'Health')!.archived).toBeUndefined();
    expect(plan.merged).toEqual([{ name: 'personal care', into: 'Health' }]);
    // Medical merged into personal care: it stays personal care, in
    // Everyday, and isn't archived, unused as it is, since Simple keeps
    // medical in its lists: new medical transactions never land in an
    // archived category.
    t = seeded();
    t = mergeCategories(t, named(t, 'medical')!.id, named(t, 'personal care')!.id);
    const care = named(t, 'personal care')!;
    expect(archiveCandidates(t, TEMPLATES.simple)).not.toContain(care.id);
    const unused = new Map([[care.id, { transactions: 0, budget: false, rules: 0 }], ...nothing(t)]);
    plan = planTemplate(t, TEMPLATES.simple, facts(t, { usage: unused }));
    const after = plan.taxonomy.categories.find((c) => c.id === care.id)!;
    expect([after.name, groupOf(plan.taxonomy, 'Personal care'), after.archived]).toEqual(['Personal care', 'Everyday', undefined]);
    expect(categoryForKey(indexTaxonomy(plan.taxonomy), 'plaid', 'MEDICAL')!.id).toBe(care.id);
    expect(plan.kept.map((k) => keptLine(k, 'Simple'))).toEqual(['Personal care isn’t archived: Medical was merged into it before, and Simple keeps that in its lists.']);
    expect(plan.merged).toEqual([{ name: 'medical', into: 'Personal care' }]);
    const { taxonomy: _t, signature: _s, ...rest } = plan;
    const text = renderToStaticMarkup(PlanView({ plan: { ...rest, basis: 'b'.repeat(64) } })).replace(/<[^>]+>/g, ' ');
    expect(text).toContain('Medical was merged into Personal care before, so it files there and isn’t a category of its own here.');
  });

  test('a category of yours that a seeded one was merged into stays yours: not renamed, not moved', () => {
    let t = seeded(['groceries']);
    const groceries = named(t, 'groceries')!;
    t = mergeCategories(t, named(t, 'food and drink')!.id, groceries.id);
    const plan = planTemplate(t, TEMPLATES.simple, facts(t));
    const after = plan.taxonomy.categories.find((c) => c.id === groceries.id)!;
    expect([after.name, groupOf(plan.taxonomy, 'groceries')]).toEqual(['groceries', 'Other']);
    expect(plan.categories.some((c) => c.id === groceries.id)).toBe(false);
    expect(plan.merged).toEqual([{ name: 'food and drink', into: 'groceries' }]);
  });

  test('a group left empty stays when it is yours, or had a budget in a past month, and the preview says why', () => {
    let t = seeded();
    t = addGroup(t, { name: 'Kids', kind: 'expense' }, ids()).taxonomy;
    const kids = groupNamed(t, 'Kids')!;
    t = moveCategory(t, named(t, 'personal care')!.id, kids.id);
    const food = groupNamed(t, 'Food')!;
    const plan = planTemplate(t, TEMPLATES.simple, facts(t, { recorded: new Set([food.id]) }));
    expect(plan.groups.removed).toEqual(['Shopping', 'Housing', 'Transport', 'Travel and entertainment', 'Health and personal care', 'Services and fees']);
    expect(groupNamed(plan.taxonomy, 'Kids')!.id).toBe(kids.id);
    expect(groupNamed(plan.taxonomy, 'Food')!.id).toBe(food.id);
    expect(plan.taxonomy.categories.some((c) => c.group === food.id || c.group === kids.id)).toBe(false);
    expect(plan.groups.kept.map(keptGroupLine)).toEqual([
      'Food is left empty and stays: it had a budget in past months, which those months keep.',
      'Kids is left empty and stays: it is a group of yours. Delete it on the Categories screen if you don’t need it.',
    ]);
    const { taxonomy: _t, signature: _s, ...rest } = plan;
    const text = renderToStaticMarkup(PlanView({ plan: { ...rest, basis: 'b'.repeat(64) } }));
    expect(text).toContain('Kids is left empty and stays');
  });

  test('the groups with a budget in some month are the record’s that had one', () => {
    const record = {
      version: 1 as const,
      since: '2026-01',
      categories: {},
      groups: {
        now: { seen: 600 },
        before: { seen: null, amounts: [{ until: '2026-09', amount: 600 }] },
        never: { seen: null, amounts: [{ until: '2026-09', amount: null }] },
      },
    };
    expect([...groupsWithBudgets(record)].sort()).toEqual(['before', 'now']);
    expect(groupsWithBudgets(null).size).toBe(0);
  });

  test('a category of its own not added, its group’s name being one of yours of another kind, says so', () => {
    let t = seeded();
    t = addGroup(t, { name: 'Business income', kind: 'expense' }, ids()).taxonomy;
    const plan = planTemplate(t, TEMPLATES.freelancer, facts(t, { usage: nothing(t, TEMPLATES.freelancer) }));
    expect(plan.kept.filter((k) => k.id === null && k.why === 'kind').map((k) => keptLine(k, 'Freelancer'))).toEqual([
      'Client payments isn’t added: your group called Business income counts its transactions another way than Freelancer’s group of that name.',
      'Other business income isn’t added: your group called Business income counts its transactions another way than Freelancer’s group of that name.',
    ]);
  });

  test('Freelancer adds its groups and categories, and uses one of yours by the name', () => {
    let t = seeded();
    t = addCategory(t, { name: 'taxes', group: groupNamed(t, 'Other')!.id }, ids()).taxonomy;
    const taxes = named(t, 'taxes')!;
    const plan = planTemplate(t, TEMPLATES.freelancer, facts(t, { usage: nothing(t, TEMPLATES.freelancer) }));
    expect(plan.groups.added).toEqual(['Business income', 'Business expenses']);
    expect(groupOf(plan.taxonomy, 'Client payments')).toBe('Business income');
    expect(named(plan.taxonomy, 'Taxes')!.id).toBe(taxes.id);
    expect(groupOf(plan.taxonomy, 'Taxes')).toBe('Business expenses');
    expect(named(plan.taxonomy, 'Personal income')!.id).toBe(named(t, 'income')!.id);
    expect(plan.categories.filter((c) => c.id === null).map((c) => c.name)).toEqual([
      'Client payments',
      'Other business income',
      'Software and subscriptions',
      'Equipment',
      'Office and supplies',
      'Business travel',
      'Business meals',
      'Advertising',
      'Professional services',
      'Business fees',
    ]);
    // Each added one has a key of its own, as one added by hand does.
    const added = named(plan.taxonomy, 'Client payments')!;
    expect(added.provider_keys).toEqual([{ provider: 'text', key: 'client payments' }]);
  });

  test('applying twice is harmless: the second time changes nothing', () => {
    for (const id of TEMPLATE_IDS) {
      const seed = seeded(['groceries']);
      const first = planTemplate(seed, TEMPLATES[id], facts(seed, { usage: nothing(seed, TEMPLATES[id]) }));
      const second = planTemplate(first.taxonomy, TEMPLATES[id], facts(first.taxonomy, { usage: nothing(first.taxonomy, TEMPLATES[id]) }));
      expect([id, second.unchanged]).toEqual([id, true]);
      expect(second.taxonomy).toEqual(first.taxonomy);
    }
  });

  test('one template after another: Simple, then Detailed, is the seed again', () => {
    const seed = seeded(['groceries']);
    const simple = planTemplate(seed, TEMPLATES.simple, facts(seed)).taxonomy;
    const back = planTemplate(simple, TEMPLATES.detailed, facts(simple, { usage: nothing(simple, TEMPLATES.detailed) }));
    expect(shape(back.taxonomy)).toEqual(shape(seed));
    expect(back.categories.filter((c) => c.archive === 'unarchive').map((c) => c.name).sort()).toEqual(['government and non profit', 'home improvement', 'personal care']);
  });

  test('at the most categories a set can hold, its own aren’t added, nor their groups made empty', () => {
    const full = seeded(Array.from({ length: MAX_CATEGORIES - 17 }, (_, i) => `kept ${i}`));
    expect(full.categories.length).toBe(MAX_CATEGORIES);
    const plan = planTemplate(full, TEMPLATES.freelancer, facts(full, { usage: nothing(full, TEMPLATES.freelancer) }));
    expect(plan.groups.added).toEqual([]);
    expect(plan.taxonomy.categories.length).toBe(MAX_CATEGORIES);
    expect(plan.kept.filter((k) => k.why === 'full').map((k) => k.name)).toEqual(TEMPLATES.freelancer.added.map((a) => a.name));
    expect(keptLine(plan.kept.find((k) => k.why === 'full')!, 'Freelancer')).toBe(`Client payments isn’t added: you have ${MAX_CATEGORIES} categories, the most there can be.`);
    // What it can do, it does.
    expect(named(plan.taxonomy, 'Personal income')).toBeDefined();
  });

  test('refused whole when it would leave more groups than a set can have', () => {
    let t = seeded();
    for (let i = t.groups.length; i < MAX_GROUPS; i++) t = addGroup(t, { name: `Group ${i}`, kind: 'expense' }, ids()).taxonomy;
    // Each of these holds a category, so none is emptied.
    expect(() => planTemplate(t, TEMPLATES.freelancer, facts(t, { usage: nothing(t, TEMPLATES.freelancer) }))).toThrow(CategoryError);
  });

  test('the preview reads as plain sentences: what changes, what stays and why, and how transactions and budgets file', () => {
    const seed = seeded();
    const plan = planTemplate(seed, TEMPLATES.simple, facts(seed, { budgets: { categories: { [named(seed, 'travel')!.id]: { amount: 200 } }, groups: {} } }));
    const { taxonomy: _t, signature: _s, ...rest } = plan;
    const html = renderToStaticMarkup(PlanView({ plan: { ...rest, basis: 'b'.repeat(64) } }));
    const text = html.replace(/<[^>]+>/g, ' ').replace(/&#x27;/g, "'").replace(/\s+/g, ' ');
    expect(text).toContain('Adds Everyday, Home and bills and Fun.');
    expect(text).toContain('Removes Food, Shopping, Housing, Transport, Travel and entertainment, Health and personal care and Services and fees, left empty.');
    expect(text).toContain('Transfer in becomes Transfers in.');
    expect(text).toContain('Every transaction stays in its category');
    expect(text).toContain('Nothing is deleted or merged.');
    expect(text).toContain('Budgets stay with their categories: Travel’s, in Fun.');
    const list = renderToStaticMarkup(CategoryTemplatesView({ step: { at: 'list' }, busy: false, error: null, onPreview: () => {}, onApply: () => {}, onUndo: () => {}, onList: () => {} }));
    // Each button is named for its set, so a screen reader tells them apart.
    for (const id of TEMPLATE_IDS) expect(list).toContain(`See what ${TEMPLATES[id].name} changes</button>`);
    expect(list).toContain('it never deletes or merges one');
  });
});

describe('the offer, once', () => {
  test('one row that opens the sets, and beside it, not inside it, a bare × that keeps yours; nothing filled', () => {
    const html = renderToStaticMarkup(TemplateOfferCard({ onKeep: () => {}, onSee: () => {} }));
    expect(html).toStartWith('<ul class="card list-rows template-offer"><li><button type="button" class="list-row" aria-haspopup="dialog">');
    expect(html).toContain('<span class="list-row-title">Categories that fit you</span><span class="list-row-sub">A starter set may suit you better</span>');
    // The row's button closes before the ×'s opens: no button inside another.
    // Its name shown on hover too, as the header's icon buttons', for voice control.
    expect(html).toContain('</button><button type="button" class="icon-btn" aria-label="Keep my categories" title="Keep my categories">');
    expect(html.match(/<button/g)).toHaveLength(2);
    expect(html).not.toContain('class="btn"');
    expect(html).not.toContain('btn secondary');
  });

  test('isn’t drawn on the server, before the device says whether it had it', () => {
    expect(renderToStaticMarkup(createElement(TemplateOffer, { taxonomy: seeded(), onTaxonomy: () => {} }))).toBe('');
  });

  test('a device that can’t say whether it had the offer offers it, and one that had it doesn’t', () => {
    const was = globalThis.localStorage;
    try {
      Object.assign(globalThis, { localStorage: { getItem: () => { throw new Error('SecurityError'); } } });
      expect(offeredHere()).toBe(false);
      Object.assign(globalThis, { localStorage: { getItem: (k: string) => (k === TEMPLATE_OFFER_KEY ? '1' : null) } });
      expect(offeredHere()).toBe(true);
    } finally {
      Object.assign(globalThis, { localStorage: was });
    }
  });
});

describe('undo', () => {
  test('puts the set back as it was', () => {
    for (const id of TEMPLATE_IDS) {
      const seed = seeded(['groceries']);
      const plan = planTemplate(seed, TEMPLATES[id], facts(seed, { usage: nothing(seed, TEMPLATES[id]) }));
      const undo = undoOf(id, seed, plan.taxonomy);
      const back = undoTemplate(plan.taxonomy, undo, facts(plan.taxonomy, { usage: addedUnused(plan.taxonomy, undo) }));
      expect([id, back.kept]).toEqual([id, []]);
      expect(shape(back.taxonomy)).toEqual(shape(seed));
      // The categories that were there are the same ones, by id, and so are
      // the groups it removed: made again under their own ids.
      for (const c of seed.categories) expect(back.taxonomy.categories.find((x) => x.id === c.id)!.name).toBe(c.name);
      expect([id, back.taxonomy.groups.map((g) => g.id).sort()]).toEqual([id, seed.groups.map((g) => g.id).sort()]);
    }
  });

  test('keeps what it can’t put back: a category it added that is used now, a name taken since, one deleted since', () => {
    const seed = seeded();
    const plan = planTemplate(seed, TEMPLATES.freelancer, facts(seed, { usage: nothing(seed, TEMPLATES.freelancer) }));
    const undo = undoOf('freelancer', seed, plan.taxonomy);
    let now = plan.taxonomy;
    // Someone named another category "income" since, the name it had.
    now = renameCategory(now, named(now, 'transportation')!.id, 'Income');
    const client = named(now, 'Client payments')!;
    const back = undoTemplate(now, undo, facts(now, { usage: addedUnused(now, undo, { [client.id]: 2 }) }));
    expect(back.kept).toEqual([
      { name: 'Personal income', why: 'name-taken' },
      { name: 'Client payments', why: 'used' },
      { name: 'Business income', why: 'not-empty', group: true },
    ]);
    expect(named(back.taxonomy, 'Client payments')).toBeDefined();
    expect(named(back.taxonomy, 'Software and subscriptions')).toBeUndefined();
    expect(groupNamed(back.taxonomy, 'Business expenses')).toBeUndefined();
  });

  test('what was changed since the apply stays as it is now, and is said', () => {
    const seed = seeded();
    const plan = planTemplate(seed, TEMPLATES.freelancer, facts(seed, { usage: nothing(seed, TEMPLATES.freelancer) }));
    const undo = undoOf('freelancer', seed, plan.taxonomy);
    let now = plan.taxonomy;
    // On another device, since: a category it renamed, one it added, and a
    // group it added, each renamed.
    now = renameCategory(now, named(now, 'Personal income')!.id, 'Salary');
    now = renameCategory(now, named(now, 'Equipment')!.id, 'Gear');
    now = renameGroup(now, groupNamed(now, 'Business expenses')!.id, 'Work costs');
    const back = undoTemplate(now, undo, facts(now, { usage: addedUnused(now, undo) }));
    expect(back.kept.map(undoKeptLine)).toEqual([
      'Salary was changed since, so it stays as it is now.',
      'Gear was changed since, so it stays as it is now.',
      'The group Work costs was changed since, so it stays as it is now.',
    ]);
    expect(named(back.taxonomy, 'Salary')).toBeDefined();
    expect(groupOf(back.taxonomy, 'Gear')).toBe('Work costs');
    // The rest went as it should: the other categories it added are gone.
    expect(named(back.taxonomy, 'Advertising')).toBeUndefined();
    expect(groupNamed(back.taxonomy, 'Business income')).toBeUndefined();
  });

  test('a group it removed that can’t be made again is said, and what it held stays where it is', () => {
    const seed = seeded();
    const plan = planTemplate(seed, TEMPLATES.simple, facts(seed));
    const undo = undoOf('simple', seed, plan.taxonomy);
    // A group called Food that counts income, made since.
    const now = addGroup(plan.taxonomy, { name: 'Food', kind: 'income' }, ids()).taxonomy;
    const back = undoTemplate(now, undo, facts(now, { usage: addedUnused(now, undo) }));
    expect(back.kept.map(undoKeptLine)).toEqual([
      'The group Food isn’t back, as another group has its name, so what it held stays where it is.',
      'The group Everyday stays: it holds categories, or has a budget of its own.',
    ]);
    expect([named(back.taxonomy, 'food and drink')!.name, groupOf(back.taxonomy, 'food and drink')]).toEqual(['food and drink', 'Everyday']);
    // No room for the groups it removed: each is said.
    let full = plan.taxonomy;
    for (let i = full.groups.length; i < MAX_GROUPS; i++) full = addGroup(full, { name: `Group ${i}`, kind: 'expense' }, ids()).taxonomy;
    const crowded = undoTemplate(full, undo, facts(full, { usage: addedUnused(full, undo) }));
    expect(crowded.kept.filter((k) => k.why === 'group-full').map((k) => k.name)).toEqual(undo.removed.map((r) => r.name));
    expect(undoKeptLine(crowded.kept.find((k) => k.why === 'group-full')!)).toBe('The group Food isn’t back, as you have the most groups there can be, so what it held stays where it is.');
  });

  test('an undo is read field by field: anything else is refused', () => {
    const seed = seeded();
    const plan = planTemplate(seed, TEMPLATES.simple, facts(seed));
    const undo = undoOf('simple', seed, plan.taxonomy);
    expect(readUndo(JSON.parse(JSON.stringify(undo)))).toEqual(undo);
    for (const bad of [
      null,
      'undo',
      { ...undo, template: 'fancy' },
      { ...undo, categories: [{ id: 'a:b', name: 'x', group: 'g', archived: false, after: { name: 'y', group: 'g', archived: false } }] },
      { ...undo, categories: [{ id: 'a', name: '', group: 'g', archived: false, after: { name: 'y', group: 'g', archived: false } }] },
      { ...undo, categories: [{ id: 'a', name: 'x', group: 'g', archived: false }] },
      { ...undo, categories: [{ id: 'a', name: 'x', group: 'g', archived: false, after: { name: 'y', group: 'g:h', archived: false } }] },
      { ...undo, removed: [{ id: 'g', name: 'G', kind: 'savings' }] },
      { ...undo, added: { categories: [7], groups: [] } },
      { ...undo, added: { categories: ['a'], groups: [] } },
      { ...undo, added: { categories: [], groups: [{ id: 'g' }] } },
      { ...undo, added: { categories: [] } },
      { ...undo, order: 'all' },
    ]) {
      expect(readUndo(bad)).toBeNull();
    }
  });
});

// ---- The route ----

beforeEach(async () => {
  fake.reset();
  forgetEpochs();
  await registerTestContainer(fake);
});

const act = async (body: unknown) => {
  const res = await route.POST(new Request('http://x/api/categories/templates', { method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body) }));
  return { status: res.status, body: await res.json() };
};

describe('the route', () => {
  test('previews, writing nothing; applies what it previewed; undoes it', async () => {
    const start = await ensureTaxonomy(ctx);
    const stored = fake.strings.get(KEY);
    const preview = await act({ action: 'preview', template: 'simple' });
    expect(preview.status).toBe(200);
    expect(preview.body.preview.groups.added).toEqual(['Everyday', 'Home and bills', 'Fun']);
    expect(preview.body.preview.taxonomy).toBeUndefined();
    expect(preview.body.preview.basis).toMatch(/^[0-9a-f]{64}$/);
    expect(fake.strings.get(KEY)).toBe(stored);

    const applied = await act({ action: 'apply', template: 'simple', basis: preview.body.preview.basis });
    expect(applied.status).toBe(200);
    expect(await readTaxonomy(ctx)).toEqual(applied.body.categories);
    expect(named(applied.body.categories, 'Food')!.id).toBe(named(start, 'food and drink')!.id);
    // Applied again: nothing to change.
    const again = await act({ action: 'preview', template: 'simple' });
    expect(again.body.preview.unchanged).toBe(true);

    const undone = await act({ action: 'undo', undo: applied.body.undo });
    expect(undone.status).toBe(200);
    expect(undone.body.kept).toEqual([]);
    expect(shape(undone.body.categories)).toEqual(shape(start));
  });

  test('refuses an apply when the categories changed since the preview, changing nothing', async () => {
    await ensureTaxonomy(ctx);
    const preview = await act({ action: 'preview', template: 'simple' });
    // Another device renames a category the template renames.
    const { changeTaxonomy } = await import('@/lib/category-store');
    await changeTaxonomy(ctx, (t) => renameCategory(t, named(t, 'travel')!.id, 'Trips'));
    const stored = fake.strings.get(KEY);
    const refused = await act({ action: 'apply', template: 'simple', basis: preview.body.preview.basis });
    expect(refused.status).toBe(409);
    expect(refused.body.error).toContain('changed since');
    // Marked, so the page works the preview out again.
    expect(refused.body.changed).toBe(true);
    expect(fake.strings.get(KEY)).toBe(stored);
  });

  test('the page shows the preview worked out again after an apply refused for a change, so Apply applies what is shown', async () => {
    const plan = { basis: 'a'.repeat(64) } as ShownPlan;
    const fresh = { basis: 'c'.repeat(64) } as ShownPlan;
    const calls: unknown[] = [];
    const next = await applyTemplate('simple', plan, async (body) => {
      calls.push(body);
      return body.action === 'apply'
        ? { ok: false, error: 'Your categories changed since this was worked out, so nothing was changed.', changed: true }
        : { ok: true, data: { preview: fresh } };
    });
    expect(calls).toEqual([
      { action: 'apply', template: 'simple', basis: plan.basis },
      { action: 'preview', template: 'simple' },
    ]);
    expect(next).toEqual({ step: { at: 'preview', template: 'simple', plan: fresh }, error: 'Your categories changed since this was worked out, so nothing was changed. Here is what it would do now.' });
    // Refused for another reason: the preview as it was, with why.
    expect(await applyTemplate('simple', plan, async () => ({ ok: false, error: 'Nope.', changed: false }))).toEqual({ step: { at: 'preview', template: 'simple', plan }, error: 'Nope.' });
  });

  test('a group with a budget in a past month stays, so its record of budgets by month stays; undo brings removed groups back by id', async () => {
    const t = await ensureTaxonomy(ctx);
    const food = groupNamed(t, 'Food')!;
    const shopping = groupNamed(t, 'Shopping')!;
    const { noteMonths, budgetMonthsStore } = await import('@/lib/budget-months-store');
    // Food had a budget of its own until September.
    await noteMonths(ctx, { categories: {}, groups: { [food.id]: { amount: 600 } } }, t, '2026-07');
    await noteMonths(ctx, { categories: {}, groups: {} }, t, '2026-09');
    const preview = await act({ action: 'preview', template: 'simple' });
    expect(preview.body.preview.groups.removed).not.toContain('Food');
    expect(preview.body.preview.groups.kept).toEqual([{ name: 'Food', why: 'past-budgets' }]);
    const applied = await act({ action: 'apply', template: 'simple', basis: preview.body.preview.basis });
    expect(applied.status).toBe(200);
    expect(groupNamed(applied.body.categories, 'Food')!.id).toBe(food.id);
    // The next read of a month notes the set again: Food's past stays.
    await noteMonths(ctx, { categories: {}, groups: {} }, applied.body.categories, '2026-10');
    expect((await budgetMonthsStore.get(ctx))!.groups[food.id]).toEqual({ seen: null, amounts: [{ until: '2026-09', amount: 600 }] });
    // Undo: Shopping, which it removed, is back under its own id.
    const undone = await act({ action: 'undo', undo: applied.body.undo });
    expect(undone.body.kept).toEqual([]);
    expect(groupNamed(undone.body.categories, 'Shopping')!.id).toBe(shopping.id);
    expect(shape(undone.body.categories)).toEqual(shape(t));
  });

  test('a record of budgets by month that can’t be read answers 409, and nothing is changed', async () => {
    await ensureTaxonomy(ctx);
    await fake.set(ctxKey('budget-months'), 'damaged-bytes-that-are-not-ciphertext');
    const stored = fake.strings.get(KEY);
    const res = await act({ action: 'preview', template: 'simple' });
    expect(res.status).toBe(409);
    expect(res.body.unreadable).toBe(true);
    expect((await act({ action: 'apply', template: 'simple', basis: 'a'.repeat(64) })).status).toBe(409);
    expect(fake.strings.get(KEY)).toBe(stored);
  });

  test('archives nothing that has a transaction, a budget or a rule, reading what uses each from storage', async () => {
    const t = await ensureTaxonomy(ctx);
    // A transaction filed under personal care by hand.
    await setOverride(ctx, 'txn_1', 'personal care');
    // A budget on home improvement.
    await budgetsRoute.PUT(
      new Request('http://x', { method: 'PUT', body: JSON.stringify({ budget_set: { categories: { [named(t, 'home improvement')!.id]: { amount: 50 } }, groups: {} } }) })
    );
    const preview = await act({ action: 'preview', template: 'simple' });
    const kept = preview.body.preview.kept.map((k: { name: string; why: string }) => [k.name, k.why]);
    expect(kept).toEqual([
      ['personal care', 'used'],
      ['home improvement', 'used'],
    ]);
    const applied = await act({ action: 'apply', template: 'simple', basis: preview.body.preview.basis });
    const after: Taxonomy = applied.body.categories;
    expect(named(after, 'Personal care')!.archived).toBeUndefined();
    expect(named(after, 'Home improvement')!.archived).toBeUndefined();
    expect(named(after, 'Taxes and donations')!.archived).toBe(true);
    // The budget is still on its category, by id.
    const budgets = await (await budgetsRoute.GET()).json();
    expect(budgets.budget_set.categories[named(after, 'Home improvement')!.id]).toEqual({ amount: 50 });
  });

  test('what uses the categories is read once for all of them: an apply’s, and undoing Freelancer’s eleven', async () => {
    const t = await ensureTaxonomy(ctx);
    // Something filed by hand under a category Freelancer adds, once added.
    const reads = { overrides: 0 };
    const real = fake.hgetall.bind(fake);
    (fake as any).hgetall = async (key: string) => {
      if (key === ctxKey('txn-category-overrides')) reads.overrides++;
      return real(key);
    };
    try {
      const preview = await act({ action: 'preview', template: 'freelancer' });
      // At most once, whatever it may archive.
      expect(reads.overrides).toBeLessThanOrEqual(1);
      const applied = await act({ action: 'apply', template: 'freelancer', basis: preview.body.preview.basis });
      expect(applied.status).toBe(200);
      expect(applied.body.undo.added.categories.length).toBeGreaterThan(4);
      const used = applied.body.undo.added.categories[0];
      await setOverride(ctx, 'txn_9', used.name);
      // What one category's read makes.
      reads.overrides = 0;
      await (await import('@/lib/category-usage')).categoryUsage(ctx, applied.body.categories, used.id);
      const once = reads.overrides;
      expect(once).toBeGreaterThan(0);
      reads.overrides = 0;
      const undone = await act({ action: 'undo', undo: applied.body.undo });
      expect(undone.status).toBe(200);
      expect(reads.overrides).toBe(once);
      // Still read for each: the one with a transaction stays, the rest go.
      expect(undone.body.kept).toContainEqual({ name: used.name, why: 'used' });
      expect(named(undone.body.categories, used.name)).toBeDefined();
      for (const a of applied.body.undo.added.categories.slice(1)) expect(named(undone.body.categories, a.name)).toBeUndefined();
      expect(named(t, used.name)).toBeUndefined();
    } finally {
      (fake as any).hgetall = real;
    }
  });

  test('refuses what isn’t a request: a template it doesn’t have, a basis that isn’t one, an undo that isn’t one, too large', async () => {
    expect((await act({ action: 'preview', template: 'fancy' })).status).toBe(400);
    expect((await act({ action: 'apply', template: 'simple' })).status).toBe(400);
    expect((await act({ action: 'apply', template: 'simple', basis: 'xyz' })).status).toBe(400);
    expect((await act({ action: 'undo', undo: { template: 'simple' } })).status).toBe(400);
    expect((await act({ action: 'rename-everything' })).status).toBe(400);
    expect((await act('not json')).status).toBe(400);
    expect((await act({ action: 'preview', template: 'simple', pad: 'x'.repeat(70_000) })).status).toBe(413);
  });

  test('categories that can’t be read answer 409, flagged, and are never saved over', async () => {
    await fake.set(KEY, 'damaged-bytes-that-are-not-ciphertext');
    const res = await act({ action: 'preview', template: 'simple' });
    expect(res.status).toBe(409);
    expect(res.body.unreadable).toBe(true);
    expect((await act({ action: 'apply', template: 'simple', basis: 'a'.repeat(64) })).status).toBe(409);
    expect(fake.strings.get(KEY)).toBe('damaged-bytes-that-are-not-ciphertext');
  });

  test('a container being restored answers 503', async () => {
    await registerTestContainer(fake, 'restoring');
    forgetEpochs();
    expect((await act({ action: 'preview', template: 'simple' })).status).toBe(503);
  });

  test('each container’s categories are its own', async () => {
    const theirs = await ensureTaxonomy(OTHER);
    const preview = await act({ action: 'preview', template: 'freelancer' });
    await act({ action: 'apply', template: 'freelancer', basis: preview.body.preview.basis });
    expect(await ensureTaxonomy(OTHER)).toEqual(theirs);
    expect(named(await ensureTaxonomy(ctx), 'Client payments')).toBeDefined();
  });
});
