import { describe, expect, test, mock, beforeEach, afterEach } from 'bun:test';
import { FakeRedis, storageMock, TEST_CTX, ctxKey, registerTestContainer, unscopedDataKeys } from './fake-redis';

// Moving what named categories by name onto category ids (#38), and keeping
// it readable to the release before: budgets move to the `budget-set` store
// (lib/budget-store.ts) with a name-keyed copy kept for that release; a
// category chosen for a transaction, carried across a re-link, or written on
// a manual or imported row stays as the words it was, each words a key of one
// category (lib/categories.ts), so nothing of theirs is rewritten. Lossless,
// idempotent, and readable by the release before, rolled back to.

process.env.PLAID_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');

let plaidRows: Record<string, unknown>[] = [];
mock.module('@/lib/plaid', () => ({
  plaidClient: {
    transactionsSync: async () => ({
      data: {
        added: plaidRows,
        modified: [],
        removed: [],
        accounts: [{ account_id: 'acct_chk', name: 'Checking', official_name: null, type: 'depository', subtype: 'checking', mask: '0001', balances: { current: 1000, available: 1000, limit: null, iso_currency_code: 'USD' } }],
        next_cursor: 'cursor-1',
        has_more: false,
        transactions_update_status: 'HISTORICAL_UPDATE_COMPLETE',
      },
    }),
  },
}));

const fake = new FakeRedis({ deserialize: true });
afterEach(() => expect(unscopedDataKeys(fake)).toEqual([]));
mock.module('@/lib/storage', () => storageMock(fake));

const { encrypt } = await import('@/lib/crypto');
const { forgetEpochs } = await import('@/lib/sessions');
const { getBudgets, setBudgets } = await import('@/lib/budgets');
const { getOverrides, setOverride } = await import('@/lib/overrides');
const { budgetSetStore, loadBudgets, saveBudgets, moveMergedBudgets } = await import('@/lib/budget-store');
const { changeTaxonomy, readTaxonomy, ensureTaxonomy } = await import('@/lib/category-store');
const { renameCategory, mergeCategories, addGroup, indexTaxonomy, categoryById } = await import('@/lib/categories');
const { saveManualAccount } = await import('@/lib/manual');
const { manualTxnStore } = await import('@/lib/manual-txns');
const budgetsRoute = await import('@/app/api/budgets/route');
const recategorize = await import('@/app/api/recategorize/route');
const transactions = await import('@/app/api/transactions/route');
const manualTxns = await import('@/app/api/manual-transactions/route');
type Taxonomy = import('@/lib/categories').Taxonomy;

const ctx = TEST_CTX;
const OTHER = { container: '3f0b8c1e-6d2a-4b5c-9e7f-0a1b2c3d4e5f' } as typeof TEST_CTX;
const SET_KEY = ctxKey('budget-set');
const LEGACY_KEY = ctxKey('budgets');

beforeEach(async () => {
  fake.reset();
  forgetEpochs();
  plaidRows = [];
  await registerTestContainer(fake);
});

const get = async () => {
  const res = await budgetsRoute.GET();
  return { status: res.status, body: await res.json() };
};
const put = async (body: unknown) => {
  const res = await budgetsRoute.PUT(new Request('http://x/api/budgets', { method: 'PUT', body: JSON.stringify(body) }));
  return { status: res.status, body: await res.json() };
};
const post = async (route: { POST: (req: Request) => Promise<Response> }, body: unknown) => {
  const res = await route.POST(new Request('http://x', { method: 'POST', body: JSON.stringify(body) }));
  return { status: res.status, body: await res.json() };
};
const named = (t: Taxonomy, name: string) => t.categories.find((c) => c.name === name)!;
const group = (t: Taxonomy, name: string) => t.groups.find((g) => g.name === name)!;
/** Each stored budget by its category's name. */
const byName = (t: Taxonomy, set: { categories: Record<string, { amount: number }> }) =>
  Object.fromEntries(Object.entries(set.categories).map(([id, b]) => [categoryById(indexTaxonomy(t), id)?.name ?? `gone:${id}`, b.amount]));

/** Budgets as the release before this one saved them, by name. */
const LEGACY = { 'food and drink': 400, groceries: 150, 'Kids stuff': 80, travel: 200 };

describe('budgets move onto category ids', () => {
  test('the first read moves every one, losing none, and leaves the name-keyed blob as it was', async () => {
    await setBudgets(ctx, LEGACY);
    const { status, body } = await get();
    expect(status).toBe(200);
    expect(byName(body.categories, body.budget_set)).toEqual(LEGACY);
    expect(body.budget_set.groups).toEqual({});
    // A name of the person's own becomes a category, under the words it had.
    expect(named(body.categories, 'Kids stuff')).toBeDefined();
    // The blob the release before reads is untouched.
    expect(await getBudgets(ctx)).toEqual(LEGACY);
  });

  test('run again, it changes nothing', async () => {
    await setBudgets(ctx, LEGACY);
    const first = await get();
    const stored = { set: fake.strings.get(SET_KEY), legacy: fake.strings.get(LEGACY_KEY), taxonomy: fake.strings.get(ctxKey('categories')) };
    const second = await get();
    expect(second.body).toEqual(first.body);
    expect({ set: fake.strings.get(SET_KEY), legacy: fake.strings.get(LEGACY_KEY), taxonomy: fake.strings.get(ctxKey('categories')) }).toEqual(stored);
  });

  test('two first reads at once move them once, onto one set of categories', async () => {
    await setBudgets(ctx, LEGACY);
    const [a, b] = await Promise.all([get(), get()]);
    expect(a.body.budget_set).toEqual(b.body.budget_set);
    expect(byName(a.body.categories, (await budgetSetStore.get(ctx))!)).toEqual(LEGACY);
  });

  test('names that land on one category add up, so the month’s total budget doesn’t move', async () => {
    await setBudgets(ctx, { 'Food and Drink': 100, 'food and drink': 50 });
    const { body } = await get();
    expect(byName(body.categories, body.budget_set)).toEqual({ 'food and drink': 150 });
  });

  test('none saved: none moved, and a first save starts the set', async () => {
    const { body } = await get();
    expect(body.budget_set).toEqual({ categories: {}, groups: {} });
    const food = named(body.categories, 'food and drink');
    const saved = await put({ budget_set: { categories: { [food.id]: { amount: 300 } }, groups: {} } });
    expect(saved.status).toBe(200);
    expect(await getBudgets(ctx)).toEqual({ 'food and drink': 300 });
  });
});

describe('what a rollback sees', () => {
  test('every category budget as last saved, under the words that release files its transactions by; never a group’s', async () => {
    await setBudgets(ctx, LEGACY);
    const { body } = await get();
    const t: Taxonomy = body.categories;
    // Renamed, regrouped, budgeted per group: none of it changes the words.
    await changeTaxonomy(ctx, (cur) => renameCategory(cur, named(t, 'food and drink').id, 'Eating'));
    const housing = group(t, 'Housing');
    const res = await put({
      budget_set: {
        categories: { [named(t, 'food and drink').id]: { amount: 450 }, [named(t, 'Kids stuff').id]: { amount: 90 } },
        groups: { [housing.id]: { amount: 2000 } },
      },
    });
    expect(res.status).toBe(200);
    // lib/budgets.ts is what the release before reads.
    expect(await getBudgets(ctx)).toEqual({ 'food and drink': 450, 'kids stuff': 90 });
    expect(res.body.budgets).toEqual({ 'food and drink': 450, 'kids stuff': 90 });
  });

  test('a category chosen for a transaction is stored as its words, which that release reads as before', async () => {
    const t = await ensureTaxonomy(ctx);
    const food = named(t, 'food and drink');
    await changeTaxonomy(ctx, (cur) => renameCategory(cur, food.id, 'Eating'));
    expect((await post(recategorize, { transaction_id: 'txn_1', category_id: food.id })).status).toBe(200);
    expect(await getOverrides(ctx)).toEqual({ txn_1: 'food and drink' });
    // A page from that release, still open, sends words: stored as before.
    expect((await post(recategorize, { transaction_id: 'txn_2', category: 'Coffee' })).status).toBe(200);
    expect((await getOverrides(ctx)).txn_2).toBe('coffee');
    expect((await post(recategorize, { transaction_id: 'txn_3', category_id: 'gone' })).status).toBe(404);
  });

  test('a manual row’s category chosen by id is kept as the category’s words', async () => {
    const t = await ensureTaxonomy(ctx, {});
    await saveManualAccount(ctx, { account_id: 'manual_wallet-1', name: 'Wallet', institution_name: 'Cash', type: 'depository', subtype: null, balance: 0, updated_at: '2026-10-01T12:00:00.000Z' });
    const travel = named(t, 'travel');
    await changeTaxonomy(ctx, (cur) => renameCategory(cur, travel.id, 'Trips'));
    const res = await post(manualTxns, { account_id: 'manual_wallet-1', date: '2026-10-01', amount: 20, currency: 'USD', name: 'Train', category_id: travel.id });
    expect(res.status).toBe(200);
    expect(res.body.transaction).toMatchObject({ category: 'travel', category_id: travel.id, category_name: 'Trips', category_kind: 'expense' });
    expect((await manualTxnStore.get(ctx, 'manual_wallet-1'))!.rows[0].category).toBe('travel');
  });
});

describe('rolled forward again', () => {
  test('a change the release before made, after a rollback, is taken in; the groups’ budgets it never saw are kept', async () => {
    await setBudgets(ctx, LEGACY);
    const t: Taxonomy = (await get()).body.categories;
    const housing = group(t, 'Housing');
    await put({ budget_set: { categories: { [named(t, 'groceries').id]: { amount: 150 } }, groups: { [housing.id]: { amount: 1800 } } } });
    // Rolled back: that release changes a budget and adds one of a name it knows.
    await setBudgets(ctx, { groceries: 175, 'pet food': 40 });
    const { body } = await get();
    expect(byName(body.categories, body.budget_set)).toEqual({ groceries: 175, 'pet food': 40 });
    expect(body.budget_set.groups).toEqual({ [housing.id]: { amount: 1800 } });
    // Taken in once: read again, nothing changes.
    const again = await get();
    expect(again.body).toEqual(body);
  });

  test('a save that stopped between its writes is finished, never taken for a rollback’s change', async () => {
    await setBudgets(ctx, LEGACY);
    const t: Taxonomy = (await get()).body.categories;
    const food = named(t, 'food and drink');
    // The set written with its new copy; the name-keyed blob not yet.
    await budgetSetStore.update(ctx, (cur) => ({ ...cur!, categories: { [food.id]: { amount: 999 } }, mirror: { 'food and drink': 999 }, mirror_before: cur!.mirror }));
    expect(await getBudgets(ctx)).toEqual(LEGACY);
    const { body } = await get();
    expect(byName(body.categories, body.budget_set)).toEqual({ 'food and drink': 999 });
    expect(await getBudgets(ctx)).toEqual({ 'food and drink': 999 });
    expect((await budgetSetStore.get(ctx))!.mirror_before).toBeNull();
  });

  test('a page from the release before saving by name: its names become the category budgets, the groups’ kept', async () => {
    const t: Taxonomy = (await get()).body.categories;
    const housing = group(t, 'Housing');
    await put({ budget_set: { categories: {}, groups: { [housing.id]: { amount: 1800 } } } });
    const res = await put({ budgets: { 'food and drink': 300, 'Gym': 45 } });
    expect(res.status).toBe(200);
    expect(byName(res.body.categories, res.body.budget_set)).toEqual({ 'food and drink': 300, Gym: 45 });
    expect(res.body.budget_set.groups).toEqual({ [housing.id]: { amount: 1800 } });
  });
});

describe('merging and deleting', () => {
  test('a merged category’s budget counts on the one it went into, added up, and moves there', async () => {
    await setBudgets(ctx, { groceries: 150, 'food and drink': 400 });
    const t: Taxonomy = (await get()).body.categories;
    const [groceries, food] = [named(t, 'groceries'), named(t, 'food and drink')];
    const merged = await changeTaxonomy(ctx, (cur) => mergeCategories(cur, groceries.id, food.id));
    // Read before the move: already counted together.
    expect((await get()).body.budget_set.categories).toEqual({ [groceries.id]: { amount: 150 }, [food.id]: { amount: 400 } });
    await moveMergedBudgets(ctx, merged);
    const { body } = await get();
    expect(body.budget_set.categories).toEqual({ [food.id]: { amount: 550 } });
    // The release before reads the sum under the words of the one kept.
    expect(await getBudgets(ctx)).toEqual({ 'food and drink': 550 });
  });

  test('a budget on a category since deleted is kept and shown until removed; a new one on it is refused', async () => {
    const t: Taxonomy = (await get()).body.categories;
    await saveBudgets(ctx, { categories: { [named(t, 'travel').id]: { amount: 100 } }, groups: {} }, t);
    await budgetSetStore.update(ctx, (cur) => ({ ...cur!, categories: { ...cur!.categories, gone_1: { amount: 25 } } }));
    expect((await get()).body.budget_set.categories.gone_1).toEqual({ amount: 25 });
    // Saved alongside the rest: kept.
    expect((await put({ budget_set: { categories: { gone_1: { amount: 25 } }, groups: {} } })).status).toBe(200);
    // Removed when left out.
    expect((await put({ budget_set: { categories: {}, groups: {} } })).status).toBe(200);
    const refused = await put({ budget_set: { categories: { gone_1: { amount: 25 } }, groups: {} } });
    expect(refused.status).toBe(409);
    expect(refused.body.error).toBe('A category you budgeted no longer exists. Reload to see your categories as they are.');
  });
});

describe('the budgets route', () => {
  test('refuses what isn’t a budget, before anything is written', async () => {
    const t: Taxonomy = (await get()).body.categories;
    const food = named(t, 'food and drink').id;
    const before = fake.strings.get(SET_KEY) ?? null;
    for (const bad of [
      { budget_set: { categories: { [food]: { amount: -1 } }, groups: {} } },
      { budget_set: { categories: { [food]: { amount: 'x' } }, groups: {} } },
      { budget_set: { categories: { [food]: { amount: 5, rollover: true } }, groups: {} } },
      { budget_set: { categories: { 'bad id!': { amount: 5 } }, groups: {} } },
      { budget_set: { categories: {} } },
      { budget_set: { categories: Object.fromEntries(Array.from({ length: 101 }, (_, i) => [`c${i}`, { amount: 1 }])), groups: {} } },
      { budgets: { food: 0 } },
      [],
    ]) {
      expect([bad, (await put(bad)).status]).toEqual([bad, 400]);
    }
    expect(fake.strings.get(SET_KEY) ?? null).toBe(before);
    // A group that isn't one.
    expect((await put({ budget_set: { categories: {}, groups: { nope: { amount: 5 } } } })).status).toBe(409);
  });

  test('budgets that can’t be read answer 409, flagged, and are never saved over', async () => {
    await fake.set(LEGACY_KEY, 'garbage-ciphertext-long-enough-to-try');
    const read = await get();
    expect(read.status).toBe(409);
    expect(read.body.unreadable).toBe(true);
    expect((await put({ budget_set: { categories: {}, groups: {} } })).status).toBe(409);
    expect(fake.strings.get(LEGACY_KEY)).toBe('garbage-ciphertext-long-enough-to-try');
    expect(fake.strings.has(SET_KEY)).toBe(false);
    // The set itself damaged: the same.
    fake.reset();
    await registerTestContainer(fake);
    forgetEpochs();
    await fake.set(SET_KEY, 'damaged-set-bytes-not-ciphertext');
    expect((await get()).status).toBe(409);
    expect((await put({ budget_set: { categories: {}, groups: {} } })).status).toBe(409);
    expect(fake.strings.get(SET_KEY)).toBe('damaged-set-bytes-not-ciphertext');
  });

  test('a save too large for one request is refused whole (413), with nothing written', async () => {
    const t: Taxonomy = (await get()).body.categories;
    const before = process.env.MAX_TXN_BLOB_CHARS;
    process.env.MAX_TXN_BLOB_CHARS = '200';
    try {
      const res = await put({ budget_set: { categories: { [named(t, 'travel').id]: { amount: 100 } }, groups: {} } });
      expect(res.status).toBe(413);
    } finally {
      if (before === undefined) delete process.env.MAX_TXN_BLOB_CHARS;
      else process.env.MAX_TXN_BLOB_CHARS = before;
    }
    expect(await getBudgets(ctx)).toEqual({});
  });

  test('a container being restored answers 503', async () => {
    await registerTestContainer(fake, 'restoring');
    forgetEpochs();
    expect((await get()).status).toBe(503);
    expect((await put({ budget_set: { categories: {}, groups: {} } })).status).toBe(503);
  });

  test('each container’s budgets are its own', async () => {
    await setBudgets(ctx, LEGACY);
    await setBudgets(OTHER, { 'OTHER-BUDGET': 1 });
    const { body } = await get();
    expect(JSON.stringify(body)).not.toContain('OTHER-BUDGET');
    expect(await budgetSetStore.get(OTHER)).toBeNull();
    const theirs = await loadBudgets(OTHER);
    expect(byName(theirs.taxonomy, theirs.budgets)).toEqual({ 'OTHER-BUDGET': 1 });
    expect(named(theirs.taxonomy, 'Kids stuff')).toBeUndefined();
  });
});

describe('renaming renames everywhere at once', () => {
  test('a chosen category, a budget and the list all follow a rename; the stored words don’t move', async () => {
    plaidRows = [
      {
        transaction_id: 'p_coffee',
        account_id: 'acct_chk',
        amount: 5.5,
        iso_currency_code: 'USD',
        date: new Date().toISOString().slice(0, 10),
        name: 'BLUE BOTTLE',
        merchant_name: 'Blue Bottle',
        pending: false,
        personal_finance_category: { primary: 'FOOD_AND_DRINK', detailed: 'FOOD_AND_DRINK_COFFEE', confidence_level: 'HIGH' },
      },
      {
        transaction_id: 'p_store',
        account_id: 'acct_chk',
        amount: 40,
        iso_currency_code: 'USD',
        date: new Date().toISOString().slice(0, 10),
        name: 'SUPERSTORE',
        merchant_name: 'Superstore',
        pending: false,
        personal_finance_category: { primary: 'GENERAL_MERCHANDISE', detailed: 'GENERAL_MERCHANDISE_SUPERSTORES', confidence_level: 'HIGH' },
      },
    ];
    await fake.hset(ctxKey('plaid:items'), { item_a: JSON.stringify({ item_id: 'item_a', institution_name: 'Chase', encrypted_access_token: await encrypt('access-a') }) });
    await setOverride(ctx, 'p_store', 'groceries');
    await setBudgets(ctx, { groceries: 150 });
    const list = async () => (await (await transactions.GET(new Request('http://x/api/transactions'))).json());
    const before = await list();
    const groceries = named(before.categories, 'groceries');
    await changeTaxonomy(ctx, (cur) => renameCategory(cur, groceries.id, 'Supermarket'));
    const after = await list();
    const store = after.transactions.find((t: { transaction_id: string }) => t.transaction_id === 'p_store');
    expect(store).toMatchObject({ category: 'groceries', category_id: groceries.id, category_name: 'Supermarket' });
    const budgets = (await get()).body;
    expect(byName(budgets.categories, budgets.budget_set)).toEqual({ Supermarket: 150 });
    expect(await getOverrides(ctx)).toEqual({ p_store: 'groceries' });
    expect((await readTaxonomy(ctx))!.categories.find((c) => c.id === groceries.id)!.provider_keys).toEqual([{ provider: 'text', key: 'groceries' }]);
  });
});

describe('groups', () => {
  test('a group budget is kept by group id through a rename of the group', async () => {
    const t = await ensureTaxonomy(ctx);
    const { taxonomy, group: kids } = addGroup(t, { name: 'Kids', kind: 'expense' }, () => 'g-kids');
    await changeTaxonomy(ctx, () => taxonomy);
    await put({ budget_set: { categories: {}, groups: { [kids.id]: { amount: 300 } } } });
    await changeTaxonomy(ctx, (cur) => ({ ...cur, groups: cur.groups.map((g) => (g.id === kids.id ? { ...g, name: 'Children' } : g)) }));
    expect((await get()).body.budget_set.groups).toEqual({ 'g-kids': { amount: 300 } });
  });
});
