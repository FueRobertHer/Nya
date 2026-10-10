import { describe, expect, test, mock, beforeEach, afterEach } from 'bun:test';
import { FakeRedis, storageMock, TEST_CTX, ctxKey, registerTestContainer, unscopedDataKeys } from './fake-redis';

// Where your categories are kept (lib/category-store.ts): seeded once, by the
// app, from what is already on the person's data; grown by keys it lacks with
// a compare-and-set; read without writing by the API and the download; and a
// set that can't be read never seeded over.

process.env.PLAID_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');

const fake = new FakeRedis({ deserialize: true });
afterEach(() => expect(unscopedDataKeys(fake)).toEqual([]));
mock.module('@/lib/storage', () => storageMock(fake));

const { encrypt } = await import('@/lib/crypto');
const { setOverride } = await import('@/lib/overrides');
const { setBudgets } = await import('@/lib/budgets');
const { UnreadableValueError } = await import('@/lib/repo');
const store = await import('@/lib/category-store');
const { indexTaxonomy, isProvisionalId, renameCategory, categoryById, mergeCategories, CategoryError, textKeys, MAX_CATEGORIES } = await import('@/lib/categories');
const { isTransfer } = await import('@/lib/spending');
type Taxonomy = import('@/lib/categories').Taxonomy;

const ctx = TEST_CTX;
const OTHER = { container: '3f0b8c1e-6d2a-4b5c-9e7f-0a1b2c3d4e5f' } as typeof TEST_CTX;
const KEY = ctxKey('categories');

beforeEach(async () => {
  fake.reset();
  await registerTestContainer(fake);
});

const named = (t: Taxonomy, name: string) => t.categories.find((c) => c.name === name);
const CARRY_KEY = ctxKey('txn-category-carry');

describe('seeding', () => {
  test('on the first read, from the categories already on the person’s data, and never again', async () => {
    await setOverride(ctx, 't1', 'groceries');
    await fake.hset(CARRY_KEY, { acc_old: await encrypt(JSON.stringify({ 'acc_old|2025-01-02|500|bakery': 'bread', 'acc_old|2025-01-03|700|x': null })) });
    await setBudgets(ctx, { 'Kids stuff': 120, 'food and drink': 400 });
    const t = await store.ensureTaxonomy(ctx, { observed: textKeys(['farmers market']) });
    for (const name of ['groceries', 'bread', 'Kids stuff', 'farmers market', 'food and drink', 'other']) expect([name, !!named(t, name)]).toEqual([name, true]);
    expect(await store.readTaxonomy(ctx)).toEqual(t);
    // Read again with nothing new: the same set, and nothing written.
    const stored = fake.strings.get(KEY);
    const again = await store.ensureTaxonomy(ctx, { observed: textKeys(['groceries']) });
    expect(again).toEqual(t);
    expect(fake.strings.get(KEY)).toBe(stored);
  });

  test('two first reads at once agree on one set: the second grows the first’s', async () => {
    const [a, b] = await Promise.all([
      store.ensureTaxonomy(ctx, { observed: textKeys(['pets']) }),
      store.ensureTaxonomy(ctx, { required: textKeys(['Holidays']) }),
    ]);
    const stored = (await store.readTaxonomy(ctx))!;
    expect(named(stored, 'pets')).toBeDefined();
    expect(named(stored, 'Holidays')).toBeDefined();
    // Each answer's categories are the stored ones, under the same ids.
    for (const t of [a, b]) for (const c of t.categories) expect(stored.categories.find((x) => x.id === c.id)?.name).toBe(c.name);
  });

  test('a set that can’t be read is never seeded over: every read says so, and nothing is written', async () => {
    await fake.set(KEY, 'damaged-bytes-that-are-not-ciphertext');
    await expect(store.readTaxonomy(ctx)).rejects.toBeInstanceOf(UnreadableValueError);
    await expect(store.ensureTaxonomy(ctx)).rejects.toBeInstanceOf(UnreadableValueError);
    await expect(store.changeTaxonomy(ctx, (t) => t)).rejects.toBeInstanceOf(UnreadableValueError);
    expect(fake.strings.get(KEY)).toBe('damaged-bytes-that-are-not-ciphertext');
  });

  test('each container has its own', async () => {
    const mine = await store.ensureTaxonomy(ctx, { observed: textKeys(['mine only']) });
    const theirs = await store.ensureTaxonomy(OTHER, {});
    expect(named(theirs, 'mine only')).toBeUndefined();
    expect(theirs.uncategorized).not.toBe(mine.uncategorized);
  });
});

describe('growing beside an edit', () => {
  test('a rename and a growth at the same moment both land', async () => {
    const t = await store.ensureTaxonomy(ctx);
    const food = named(t, 'food and drink')!;
    await Promise.all([
      store.changeTaxonomy(ctx, (cur) => renameCategory(cur, food.id, 'Eating')),
      store.ensureTaxonomy(ctx, { observed: textKeys(['pet supplies']) }),
      store.ensureTaxonomy(ctx, { observed: [{ provider: 'plaid', key: 'LOAN_DISBURSEMENTS' }] }),
    ]);
    const stored = (await store.readTaxonomy(ctx))!;
    expect(stored.categories.find((c) => c.id === food.id)!.name).toBe('Eating');
    expect(named(stored, 'pet supplies')).toBeDefined();
    expect(named(stored, 'loan disbursements')).toBeDefined();
  });

  test('an edit refused writes nothing', async () => {
    await store.ensureTaxonomy(ctx);
    const before = fake.strings.get(KEY);
    const err = await store
      .changeTaxonomy(ctx, () => {
        throw new CategoryError('no', 409);
      })
      .catch((e) => e);
    expect(err).toBeInstanceOf(CategoryError);
    expect(fake.strings.get(KEY)).toBe(before);
  });
});

describe('reading without writing (the read-only API, the download)', () => {
  test('before the app has stored any: the seed it would make, with provisional ids, and nothing written', async () => {
    await setBudgets(ctx, { Holidays: 300 });
    const { taxonomy, stored } = await store.taxonomyForReading(ctx, { observed: textKeys(['pets']) });
    expect(stored).toBe(false);
    expect(taxonomy.categories.every((c) => isProvisionalId(c.id))).toBe(true);
    expect(named(taxonomy, 'pets')).toBeDefined();
    expect(named(taxonomy, 'Holidays')).toBeDefined();
    expect(fake.strings.has(KEY)).toBe(false);
  });

  test('once stored: the stored ids, and a provisional one only for a key it lacks', async () => {
    const stored = await store.ensureTaxonomy(ctx);
    const before = fake.strings.get(KEY);
    const { taxonomy } = await store.taxonomyForReading(ctx, { observed: textKeys(['pets', 'food and drink']) });
    expect(named(taxonomy, 'food and drink')!.id).toBe(named(stored, 'food and drink')!.id);
    expect(isProvisionalId(named(taxonomy, 'pets')!.id)).toBe(true);
    expect(fake.strings.get(KEY)).toBe(before);
  });

  test('provisional ids grown twice never repeat', async () => {
    const one = (await store.taxonomyForReading(ctx, { observed: textKeys(['a']) })).taxonomy;
    const two = store.grown(one, { observed: textKeys(['b']) }, store.provisionalIds());
    expect(named(two, 'a')!.id).not.toBe(named(two, 'b')!.id);
  });
});

describe('filing transactions', () => {
  const rows = () => [
    { category: 'food and drink', pfc_primary: 'FOOD_AND_DRINK', pfc_detailed: 'FOOD_AND_DRINK_COFFEE' } as Record<string, unknown>,
    { category: 'pet supplies', category_set: true, pfc_primary: 'GENERAL_MERCHANDISE', pfc_detailed: null } as Record<string, unknown>,
    { category: null, pfc_primary: null, pfc_detailed: null } as Record<string, unknown>,
  ];

  test('the app grows the stored set and files every row by it, the facts it was filed by gone', async () => {
    const r = rows();
    const { taxonomy, notes } = await store.fileTransactions(ctx, r as never, { grow: true });
    expect(notes).toEqual([]);
    const stored = (await store.readTaxonomy(ctx))!;
    expect(taxonomy).toEqual(stored);
    expect(r[0]).toEqual({ category: 'food and drink', category_id: named(stored, 'food and drink')!.id, category_name: 'food and drink', category_kind: 'expense' });
    expect(r[1]).toMatchObject({ category: 'pet supplies', category_id: named(stored, 'pet supplies')!.id, category_name: 'pet supplies' });
    expect(r[2]).toEqual({ category: null, category_id: stored.uncategorized, category_name: null, category_kind: 'expense' });
  });

  test('without growing, nothing is written', async () => {
    const r = rows();
    await store.fileTransactions(ctx, r as never, { grow: false });
    expect(fake.strings.has(KEY)).toBe(false);
    expect(r[1].category_name).toBe('pet supplies');
    expect(isProvisionalId(r[1].category_id as string)).toBe(true);
  });

  test('a set that can’t be read: every row filed by the category it came with, said in a note, nothing written', async () => {
    await fake.set(KEY, 'damaged-bytes-that-are-not-ciphertext');
    const r = rows();
    const { notes } = await store.fileTransactions(ctx, r as never, { grow: true });
    expect(notes).toEqual(["Your categories couldn't be read, so each transaction shows the category it came with until they can be."]);
    expect(r.map((x) => x.category_name)).toEqual(['food and drink', 'pet supplies', null]);
    expect(fake.strings.get(KEY)).toBe('damaged-bytes-that-are-not-ciphertext');
  });

  test('past the limit, a row whose words have no room is left as it came: its words shown, and counted by them', async () => {
    await store.ensureTaxonomy(ctx, { observed: textKeys(Array.from({ length: MAX_CATEGORIES }, (_, i) => `category ${i}`)) });
    expect((await store.readTaxonomy(ctx))!.categories).toHaveLength(MAX_CATEGORIES);
    const r = [{ category: 'transfer to savings', source: 'manual', transaction_code: null } as Record<string, unknown>];
    await store.fileTransactions(ctx, r as never, { grow: true });
    // Not filed under uncategorized as spending: a transfer, as it was before categories had kinds.
    expect(r[0]).toEqual({ category: 'transfer to savings', source: 'manual', transaction_code: null });
    expect(isTransfer(r[0] as never)).toBe(true);
    expect(named((await store.readTaxonomy(ctx))!, 'transfer to savings')).toBeUndefined();
  });

  test('a storage failure is an error, never rows filed by nothing', async () => {
    fake.failNext('get');
    await expect(store.fileTransactions(ctx, rows() as never, { grow: true })).rejects.toThrow(/armed failure/);
  });
});

describe('choosing a category by id', () => {
  test('stores its first words; a merged id finds where it went; an unknown or malformed one is refused', async () => {
    const t = await store.ensureTaxonomy(ctx, { observed: textKeys(['groceries']) });
    const food = named(t, 'food and drink')!;
    const groceries = named(t, 'groceries')!;
    expect(await store.choiceForId(ctx, food.id)).toBe('food and drink');
    await store.changeTaxonomy(ctx, (cur) => mergeCategories(cur, groceries.id, food.id));
    expect(await store.choiceForId(ctx, groceries.id)).toBe('food and drink');
    expect(categoryById(indexTaxonomy((await store.readTaxonomy(ctx))!), groceries.id)!.id).toBe(food.id);
    await expect(store.choiceForId(ctx, 'nope')).rejects.toMatchObject({ status: 404 });
    await expect(store.choiceForId(ctx, 'bad id!')).rejects.toMatchObject({ status: 400 });
    await expect(store.choiceForId(ctx, 42)).rejects.toMatchObject({ status: 400 });
  });
});
