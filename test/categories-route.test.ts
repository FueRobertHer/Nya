import { describe, expect, test, mock, beforeEach, afterEach } from 'bun:test';
import { FakeRedis, storageMock, TEST_CTX, ctxKey, registerTestContainer, unscopedDataKeys } from './fake-redis';

// The Categories screen's route (app/api/categories): every change, each a
// compare-and-set on the stored set, refused with what to do instead; a merge
// moving its budget; a delete only of what nothing uses; and the container's
// data only, with the seam's errors answered as everywhere.

process.env.PLAID_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');

// Nothing here may call Plaid: a delete reads the stored rows only.
mock.module('@/lib/plaid', () => ({
  plaidClient: new Proxy({}, { get: () => () => Promise.reject(new Error('Plaid must not be called')) }),
}));

const fake = new FakeRedis({ deserialize: true });
afterEach(() => expect(unscopedDataKeys(fake)).toEqual([]));
mock.module('@/lib/storage', () => storageMock(fake));

const { forgetEpochs } = await import('@/lib/sessions');
const { setOverride } = await import('@/lib/overrides');
const { setBudgets, getBudgets } = await import('@/lib/budgets');
const { saveManualAccount } = await import('@/lib/manual');
const { manualTxnStore, newManualTxn } = await import('@/lib/manual-txns');
const { readTaxonomy, ensureTaxonomy } = await import('@/lib/category-store');
const { budgetSetStore } = await import('@/lib/budget-store');
const route = await import('@/app/api/categories/route');
const budgetsRoute = await import('@/app/api/budgets/route');
const recategorize = await import('@/app/api/recategorize/route');
const { getOverrides } = await import('@/lib/overrides');
type Taxonomy = import('@/lib/categories').Taxonomy;

const ctx = TEST_CTX;
const OTHER = { container: '3f0b8c1e-6d2a-4b5c-9e7f-0a1b2c3d4e5f' } as typeof TEST_CTX;
const KEY = ctxKey('categories');

beforeEach(async () => {
  fake.reset();
  forgetEpochs();
  await registerTestContainer(fake);
});

const get = async () => {
  const res = await route.GET();
  return { status: res.status, body: await res.json() };
};
const act = async (body: unknown) => {
  const res = await route.POST(new Request('http://x/api/categories', { method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body) }));
  return { status: res.status, body: await res.json() };
};
const named = (t: Taxonomy, name: string) => t.categories.find((c) => c.name === name);
const groupNamed = (t: Taxonomy, name: string) => t.groups.find((g) => g.name === name)!;

describe('reading', () => {
  test('made on the first read, then read as stored, with nothing written', async () => {
    const first = await get();
    expect(first.status).toBe(200);
    expect(named(first.body.categories, 'food and drink')).toBeDefined();
    const stored = fake.strings.get(KEY);
    expect((await get()).body).toEqual(first.body);
    expect(fake.strings.get(KEY)).toBe(stored);
  });
});

describe('a category', () => {
  test('added in a group, by a name no other has; a bad group or name refused', async () => {
    const t: Taxonomy = (await get()).body.categories;
    const food = groupNamed(t, 'Food');
    const added = await act({ action: 'add-category', name: 'Coffee', group: food.id, icon: '☕' });
    expect(added.status).toBe(200);
    expect(named(added.body.categories, 'Coffee')).toMatchObject({ group: food.id, icon: '☕', provider_keys: [{ provider: 'text', key: 'coffee' }] });
    expect(await readTaxonomy(ctx)).toEqual(added.body.categories);
    expect((await act({ action: 'add-category', name: 'COFFEE', group: food.id })).status).toBe(409);
    expect((await act({ action: 'add-category', name: 'Tea', group: 'nope' })).status).toBe(404);
    expect((await act({ action: 'add-category', name: '', group: food.id })).status).toBe(400);
    expect((await act({ action: 'add-category', name: 'x'.repeat(61), group: food.id })).status).toBe(400);
  });

  test('renamed, given an icon, moved and archived; an id that isn’t one refused', async () => {
    const t: Taxonomy = (await get()).body.categories;
    const travel = named(t, 'travel')!;
    expect((await act({ action: 'rename-category', id: travel.id, name: 'Trips' })).status).toBe(200);
    expect((await act({ action: 'set-icon', id: travel.id, icon: '✈️' })).status).toBe(200);
    expect((await act({ action: 'move-category', id: travel.id, group: groupNamed(t, 'Transport').id })).status).toBe(200);
    const archived = await act({ action: 'archive', id: travel.id, archived: true });
    expect(archived.body.categories.categories.find((c: { id: string }) => c.id === travel.id)).toMatchObject({
      name: 'Trips',
      icon: '✈️',
      group: groupNamed(t, 'Transport').id,
      archived: true,
    });
    expect((await act({ action: 'archive', id: travel.id, archived: 'yes' })).status).toBe(400);
    expect((await act({ action: 'rename-category', id: 'bad id!', name: 'x' })).status).toBe(400);
    expect((await act({ action: 'rename-category', id: 'nope', name: 'x' })).status).toBe(404);
    // The uncategorized category can't be archived, nor moved out of spending.
    expect((await act({ action: 'archive', id: t.uncategorized, archived: true })).status).toBe(409);
    expect((await act({ action: 'move-category', id: t.uncategorized, group: groupNamed(t, 'Transfers').id })).status).toBe(409);
  });

  test('merged: its keys and its budget go to the other, added up, and the release before reads the sum', async () => {
    await setBudgets(ctx, { groceries: 150, 'food and drink': 400 });
    await setOverride(ctx, 'txn_1', 'groceries');
    const t: Taxonomy = (await (await budgetsRoute.GET()).json()).categories;
    const [groceries, food] = [named(t, 'groceries')!, named(t, 'food and drink')!];
    const merged = await act({ action: 'merge', id: groceries.id, into: food.id });
    expect(merged.status).toBe(200);
    expect(named(merged.body.categories, 'groceries')).toBeUndefined();
    expect(merged.body.categories.merged).toEqual({ [groceries.id]: food.id });
    expect((await budgetSetStore.get(ctx))!.categories).toEqual({ [food.id]: { amount: 550 } });
    expect(await getBudgets(ctx)).toEqual({ 'food and drink': 550 });
    // Its budget moving can fail (budgets that can't be read): the merge, saved,
    // is still answered as made, and the budgets are left exactly as they were.
    const coffee = (await act({ action: 'add-category', name: 'Coffee', group: groupNamed(t, 'Food').id })).body.categories;
    await fake.set(ctxKey('budget-set'), 'damaged-bytes-that-are-not-ciphertext');
    const again = await act({ action: 'merge', id: named(coffee, 'Coffee')!.id, into: food.id });
    expect(again.status).toBe(200);
    expect(named(again.body.categories, 'Coffee')).toBeUndefined();
    expect(await readTaxonomy(ctx)).toEqual(again.body.categories);
    expect(fake.strings.get(ctxKey('budget-set'))).toBe('damaged-bytes-that-are-not-ciphertext');
    await fake.del(ctxKey('budget-set'));
    // Across kinds: refused, nothing changed.
    const before = fake.strings.get(KEY);
    const across = await act({ action: 'merge', id: named(t, 'transfer out')!.id, into: food.id });
    expect(across.status).toBe(409);
    expect(across.body.error).toContain('would change your totals');
    expect(fake.strings.get(KEY)).toBe(before);
  });

  test('deleted only when nothing uses it: a chosen category, a manual row of any date, a budget, or Plaid all keep it', async () => {
    await saveManualAccount(ctx, { account_id: 'manual_w-1', name: 'Wallet', institution_name: 'Cash', type: 'depository', subtype: null, balance: 0, updated_at: '2026-10-01T12:00:00.000Z' });
    const t = await ensureTaxonomy(ctx, { observed: [{ provider: 'text', key: 'gifts' }, { provider: 'text', key: 'old hobby' }, { provider: 'text', key: 'unused' }] });
    await setOverride(ctx, 'txn_1', 'gifts');
    // A manual row from years back, outside every window.
    await manualTxnStore.set(ctx, 'manual_w-1', {
      version: 1,
      rows: [newManualTxn('manual_w-1', { date: '2019-01-05', amount: 20, currency: 'USD', name: 'Paints', category: 'old hobby', note: null })],
    });
    for (const [name, why] of [
      ['gifts', 'is used by 1 transaction'],
      ['old hobby', 'is used by 1 transaction'],
      ['travel', 'Plaid files'],
    ] as const) {
      const res = await act({ action: 'delete-category', id: named(t, name)!.id });
      expect([name, res.status]).toEqual([name, 409]);
      expect(res.body.error).toContain(why);
    }
    // With a budget on it.
    const unused = named(t, 'unused')!;
    await (await budgetsRoute.PUT(new Request('http://x', { method: 'PUT', body: JSON.stringify({ budget_set: { categories: { [unused.id]: { amount: 10 } }, groups: {} } }) }))).json();
    expect((await act({ action: 'delete-category', id: unused.id })).body.error).toContain('a budget');
    await budgetsRoute.PUT(new Request('http://x', { method: 'PUT', body: JSON.stringify({ budget_set: { categories: {}, groups: {} } }) }));
    const gone = await act({ action: 'delete-category', id: unused.id });
    expect(gone.status).toBe(200);
    expect(named(gone.body.categories, 'unused')).toBeUndefined();
  });
});

describe('a group', () => {
  test('added with a kind, renamed, reordered, and deleted once empty and unbudgeted', async () => {
    const t: Taxonomy = (await get()).body.categories;
    const added = await act({ action: 'add-group', name: 'Kids', kind: 'expense' });
    const kids = groupNamed(added.body.categories, 'Kids');
    expect(kids).toMatchObject({ kind: 'expense', order: 10 });
    expect((await act({ action: 'add-group', name: 'Savings', kind: 'savings' })).status).toBe(400);
    expect((await act({ action: 'rename-group', id: kids.id, name: 'Children' })).status).toBe(200);
    const ids = [kids.id, ...t.groups.map((g) => g.id)];
    const ordered = await act({ action: 'order-groups', ids });
    expect(ordered.body.categories.groups.find((g: { id: string }) => g.id === kids.id).order).toBe(0);
    expect((await act({ action: 'order-groups', ids: ids.slice(1) })).status).toBe(409);
    // Not empty, or with a budget of its own: refused.
    expect((await act({ action: 'delete-group', id: groupNamed(t, 'Food').id })).status).toBe(409);
    await budgetsRoute.PUT(new Request('http://x', { method: 'PUT', body: JSON.stringify({ budget_set: { categories: {}, groups: { [kids.id]: { amount: 50 } } } }) }));
    expect((await act({ action: 'delete-group', id: kids.id })).body.error).toContain('budget of its own');
    await budgetsRoute.PUT(new Request('http://x', { method: 'PUT', body: JSON.stringify({ budget_set: { categories: {}, groups: {} } }) }));
    const gone = await act({ action: 'delete-group', id: kids.id });
    expect(gone.status).toBe(200);
    expect(gone.body.categories.groups.some((g: { id: string }) => g.id === kids.id)).toBe(false);
  });
});

describe('the route', () => {
  test('refuses what isn’t a change: no action, not JSON, too large', async () => {
    expect((await act({ action: 'rename-everything' })).status).toBe(400);
    expect((await act('not json')).status).toBe(400);
    expect((await act('[]')).status).toBe(400);
    expect((await act({ action: 'add-group', name: 'x'.repeat(20_000), kind: 'expense' })).status).toBe(413);
  });

  test('categories that can’t be read answer 409, flagged, and are never seeded or saved over', async () => {
    await fake.set(KEY, 'damaged-bytes-that-are-not-ciphertext');
    const read = await get();
    expect(read.status).toBe(409);
    expect(read.body.unreadable).toBe(true);
    expect((await act({ action: 'add-group', name: 'Kids', kind: 'expense' })).status).toBe(409);
    expect(fake.strings.get(KEY)).toBe('damaged-bytes-that-are-not-ciphertext');
  });

  test('choosing a category by id while they can’t be read answers 409, flagged, as every route on the seam does, and stores nothing', async () => {
    const t: Taxonomy = (await get()).body.categories;
    await fake.set(KEY, 'damaged-bytes-that-are-not-ciphertext');
    const res = await recategorize.POST(new Request('http://x', { method: 'POST', body: JSON.stringify({ transaction_id: 'txn_1', category_id: named(t, 'travel')!.id }) }));
    expect(res.status).toBe(409);
    expect((await res.json()).unreadable).toBe(true);
    expect(await getOverrides(ctx)).toEqual({});
  });

  test('a container being restored answers 503', async () => {
    await registerTestContainer(fake, 'restoring');
    forgetEpochs();
    expect((await get()).status).toBe(503);
    expect((await act({ action: 'add-group', name: 'Kids', kind: 'expense' })).status).toBe(503);
  });

  test('each container’s categories are its own', async () => {
    const t: Taxonomy = (await get()).body.categories;
    await act({ action: 'rename-category', id: named(t, 'travel')!.id, name: 'Trips' });
    const theirs = await ensureTaxonomy(OTHER);
    expect(named(theirs, 'travel')).toBeDefined();
    expect(named(theirs, 'Trips')).toBeUndefined();
    expect(theirs.categories.some((c) => t.categories.some((x) => x.id === c.id))).toBe(false);
  });
});
