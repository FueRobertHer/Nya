import { describe, expect, test, mock, beforeEach, afterEach } from 'bun:test';
import './clerk-mock';
import { FakeRedis, storageMock, ctxKey, registerTestContainer, unscopedDataKeys } from './fake-redis';

// Budget rollover and income carryover (#37) through the app's routes: the
// month of budgets read from the stored history (app/api/budgets/month,
// lib/budget-month.ts), the settings (app/api/budgets/rollover), what a save
// of budgets records by month (app/api/budgets), merges and deletes
// (app/api/categories), what a rollback sees, and what can't be read.

process.env.PLAID_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');

// Nothing here may reach Plaid: the month is read from what is stored.
const plaidTouched: string[] = [];
mock.module('@/lib/plaid', () => ({
  plaidClient: new Proxy(
    {},
    {
      get(_target, prop) {
        if (typeof prop === 'string') plaidTouched.push(prop);
        return async () => {
          throw new Error('Plaid must not be called');
        };
      },
    }
  ),
}));

const fake = new FakeRedis({ deserialize: true });
mock.module('@/lib/storage', () => storageMock(fake));
afterEach(() => expect(unscopedDataKeys(fake)).toEqual([]));

const { ctx, OTHER, txn } = await import('./api-fixture');
const { encrypt } = await import('@/lib/crypto');
const { encodeJsonBlob } = await import('@/lib/blob');
const { saveItem } = await import('@/lib/storage');
const { forgetEpochs } = await import('@/lib/sessions');
const { setBudgets, getBudgets } = await import('@/lib/budgets');
const { budgetSetStore, saveBudgets, loadBudgets } = await import('@/lib/budget-store');
const { isBudgetSet } = await import('@/lib/budget-set');
const { budgetMonthsStore, incomeCarryoverStore } = await import('@/lib/budget-months-store');
const { syncsStore, noticesStore } = await import('@/lib/connection-records');
const { setExcluded } = await import('@/lib/txn-annotations');
const { addMonths } = await import('@/lib/rollover');
const { rolloverFailure, readMonthParams } = await import('@/lib/rollover-http');
const { summarize } = await import('@/lib/totals');
const { readBudgetMonth } = await import('@/lib/budget-month');
const { declaredStore } = await import('@/lib/stores');
const { classify } = await import('@/lib/reencrypt');
const { UpdateConflictError, StoredValueTooLargeError, UnreadableValueError } = await import('@/lib/repo');
const { ContainerError } = await import('@/lib/containers');
const { readBudgets } = await import('@/lib/api-read');
const { createToken } = await import('@/lib/api-tokens');
const v1Budgets = await import('@/app/api/v1/budgets/route');
const budgetsRoute = await import('@/app/api/budgets/route');
const monthRoute = await import('@/app/api/budgets/month/route');
const rolloverRoute = await import('@/app/api/budgets/rollover/route');
const categoriesRoute = await import('@/app/api/categories/route');
const recategorize = await import('@/app/api/recategorize/route');
type Taxonomy = import('@/lib/categories').Taxonomy;

/** This month, as the page sends it (the UTC month is always one some time
 *  zone is in), and the months around it. */
const NOW = new Date().toISOString().slice(0, 7);
const M = (n: number) => addMonths(NOW, n);
const on = (n: number, day = 10) => `${M(n)}-${String(day).padStart(2, '0')}`;

beforeEach(async () => {
  fake.reset();
  forgetEpochs();
  delete process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;
  delete process.env.CLERK_SECRET_KEY;
  delete process.env.CONTAINER_ID;
  await registerTestContainer(fake);
  plaidTouched.length = 0;
});
afterEach(() => expect(plaidTouched).toEqual([]));

/** A bank's stored rows, as a sync leaves them. */
async function seedBank(rows: ReturnType<typeof txn>[], opts: { item?: string; name?: string; for?: typeof ctx } = {}) {
  const item = opts.item ?? 'item_bank';
  const who = opts.for ?? ctx;
  await saveItem(who, { item_id: item, institution_name: opts.name ?? 'Bank', encrypted_access_token: await encrypt('access-sandbox-x') });
  const accounts = { acc_chk: { name: 'Checking', official_name: null, type: 'depository', subtype: 'checking', mask: '1111', balances: null } };
  await fake.set(
    ctxKey(`txns:${item}`, who),
    await encodeJsonBlob({ schema_version: 2, cursor: 'c1', accounts, txns: Object.fromEntries(rows.map((t) => [t.transaction_id, t])), synced_at: new Date().toISOString() })
  );
  await syncsStore.set(who, item, { at: new Date().toISOString() });
}

/** A row on a day, spending (positive) or money in (negative), in a category's words. */
const row = (id: string, date: string, amount: number, category = 'food and drink', over: Record<string, unknown> = {}) => txn(id, 'acc_chk', 1, amount, { date, category, ...over });

const call = async (res: Response | Promise<Response>) => {
  const r = await res;
  return { status: r.status, body: await r.json() };
};
const getBudgets_ = () => call(budgetsRoute.GET());
const put = (body: unknown) => call(budgetsRoute.PUT(new Request('http://x/api/budgets', { method: 'PUT', body: JSON.stringify(body) })));
const month = (m = NOW, today = NOW, extra = '') => call(monthRoute.GET(new Request(`http://x/api/budgets/month?month=${m}&today=${today}${extra}`)));
const post = (body: unknown) => call(rolloverRoute.POST(new Request('http://x/api/budgets/rollover', { method: 'POST', body: JSON.stringify(body) })));
const named = (t: Taxonomy, name: string) => t.categories.find((c) => c.name === name)!;
const group = (t: Taxonomy, name: string) => t.groups.find((g) => g.name === name)!;

/** Categories made, and budgets set on them by name, as the page saves them. */
async function budget(byName: Record<string, number>, groups: Record<string, number> = {}): Promise<Taxonomy> {
  const { body } = await getBudgets_();
  const t: Taxonomy = body.categories;
  const res = await put({
    budget_set: {
      categories: Object.fromEntries(Object.entries(byName).map(([n, amount]) => [named(t, n).id, { amount }])),
      groups: Object.fromEntries(Object.entries(groups).map(([n, amount]) => [group(t, n).id, { amount }])),
    },
    month: NOW,
  });
  expect(res.status).toBe(200);
  return t;
}

/**
 * Budgets as saved before this release (by name, by the release before the
 * one with ids, and groups' by the one before this): there is no record of
 * them by month yet, so the months before the record begins are assumed to
 * have had them, as for a person updating to this release.
 */
async function budgetBefore(byName: Record<string, number>, groups: Record<string, number> = {}): Promise<Taxonomy> {
  await setBudgets(ctx, byName);
  const { body } = await getBudgets_();
  const t: Taxonomy = body.categories;
  if (Object.keys(groups).length > 0) {
    const { budgets, taxonomy } = await loadBudgets(ctx);
    await saveBudgets(ctx, { ...budgets, groups: Object.fromEntries(Object.entries(groups).map(([n, amount]) => [group(t, n).id, { amount }])) }, taxonomy);
  }
  expect(await budgetMonthsStore.get(ctx)).toBeNull();
  return t;
}

const rollover = (t: Taxonomy, name: string, from: string, kind: 'category' | 'group' = 'category') =>
  post({ action: 'rollover', kind, id: kind === 'category' ? named(t, name).id : group(t, name).id, on: true, from, month: NOW });

describe('a month of budgets, from the stored history', () => {
  test('budgets saved before rollover existed load without loss and show exactly as before', async () => {
    await setBudgets(ctx, { 'food and drink': 400, travel: 200 });
    await seedBank([row('a', on(0, 2), 120), row('b', on(0, 3), 30, 'travel'), row('old', on(-1), 999)]);
    const { status, body } = await month();
    expect(status).toBe(200);
    const t: Taxonomy = (await getBudgets_()).body.categories;
    const budgets = { [named(t, 'food and drink').id]: { amount: 400 }, [named(t, 'travel').id]: { amount: 200 } };
    // Nothing rolls over and income carryover is off: answered from the
    // budgets alone, no transactions read (the page counts the month itself).
    expect(body).toMatchObject({ history: false, budgets: { categories: budgets, groups: {} }, spent: {}, earliest: null, gaps: [], notes: [] });
    expect(body.carries).toEqual({ categories: {}, groups: {} });
    expect(body.rollover).toEqual({ categories: {}, groups: {} });
    expect(body.income).toBeNull();
    expect(body.pool).toBeNull();
    // Asked for the history, it reads it all the same.
    const read = (await month(NOW, NOW, '&history=1')).body;
    expect(read).toMatchObject({ history: true, budgets: { categories: budgets, groups: {} }, earliest: M(-1) });
    expect(read.spent).toEqual({ [named(t, 'food and drink').id]: 120, [named(t, 'travel').id]: 30 });
    expect(read.carries).toEqual(body.carries);
    // Nothing read changed the budgets, or the copy the release before reads.
    expect(await getBudgets(ctx)).toEqual({ 'food and drink': 400, travel: 200 });
  });

  test('without budgets, a read keeps no record; the first budget begins it, with none before', async () => {
    await seedBank([row('a', on(-1), 50)]);
    expect((await month()).status).toBe(200);
    expect((await month(NOW, NOW, '&history=1')).status).toBe(200);
    expect(await fake.get(ctxKey('budget-months'))).toBeNull();
    const t = await budget({ 'food and drink': 100 });
    const food = named(t, 'food and drink').id;
    expect((await budgetMonthsStore.get(ctx))!.categories[food]).toEqual({ seen: 100, amounts: [{ until: NOW, amount: null }] });
    expect((await month(M(-1))).body.budgets.categories).toEqual({});
  });

  test('a stored history that can’t be read keeps no plain month from loading', async () => {
    await setBudgets(ctx, { 'food and drink': 400 });
    await seedBank([row('a', on(0, 2), 120)]);
    await fake.set(ctxKey('txns:item_bank'), 'not a blob');
    const plain = await month();
    expect(plain.status).toBe(200);
    expect(plain.body).toMatchObject({ history: false, notes: [] });
    // Read, it says so.
    expect((await month(NOW, NOW, '&history=1')).body.notes.join(' ')).toContain('could not be read');
  });

  test('leftover and overspending carry, read back past the year the page loads', async () => {
    const t = await budgetBefore({ 'food and drink': 100 });
    // Fourteen months back: before the 365 days the dashboard loads.
    await seedBank([row('m14', on(-14, 1), 40), row('m13', on(-13), 150), row('m2', on(-2), 100), row('m1', on(-1), 80), row('now', on(0), 5)]);
    expect((await rollover(t, 'food and drink', M(-14))).status).toBe(200);
    const { body } = await month();
    const food = named(t, 'food and drink').id;
    // 14 months of 100 budgeted (from M-14 to M-1), 370 spent.
    expect(body.carries.categories[food]).toMatchObject({ carry: 1400 - 370, from: M(-14), why: 'start', start: M(-14), uncertain: [] });
    expect(body.rollover.categories[food]).toBe(M(-14));
    expect(body.earliest).toBe(M(-14));
    expect(body.spent[food]).toBe(5);
  });

  test('turning rollover off drops its carry to zero at once; earlier months keep theirs', async () => {
    const t = await budgetBefore({ 'food and drink': 100 });
    await seedBank([row('m2', on(-2), 40), row('m1', on(-1), 40)]);
    await rollover(t, 'food and drink', M(-2));
    const food = named(t, 'food and drink').id;
    expect((await month()).body.carries.categories[food].carry).toBe(120);
    const off = await post({ action: 'rollover', kind: 'category', id: food, on: false, month: NOW });
    expect(off.status).toBe(200);
    expect(off.body.rollover).toEqual([{ from: M(-2), to: M(0) }]);
    const now = (await month()).body;
    expect(now.carries.categories[food]).toBeUndefined();
    expect(now.rollover.categories[food]).toBeUndefined();
    expect((await month(M(-1))).body.carries.categories[food].carry).toBe(60);
  });

  test('a reset sets the carry to zero from this month', async () => {
    const t = await budgetBefore({ 'food and drink': 100 });
    await seedBank([row('m1', on(-1), 10)]);
    await rollover(t, 'food and drink', M(-1));
    const food = named(t, 'food and drink').id;
    const reset = await post({ action: 'reset', kind: 'category', id: food, month: NOW });
    expect(reset.body.rollover).toEqual([{ from: M(-1), to: M(0) }, { from: M(0), reset: true }]);
    expect((await month()).body.carries.categories[food]).toMatchObject({ carry: 0, why: 'reset' });
  });

  test('a recategorization in a past month changes the carry at once', async () => {
    const t = await budgetBefore({ 'food and drink': 100 });
    await seedBank([row('lunch', on(-1), 70), row('dinner', on(-1), 20)]);
    await rollover(t, 'food and drink', M(-1));
    const food = named(t, 'food and drink').id;
    expect((await month()).body.carries.categories[food].carry).toBe(10);
    const res = await recategorize.POST(new Request('http://x', { method: 'POST', body: JSON.stringify({ transaction_id: 'lunch', category_id: named(t, 'travel').id }) }));
    expect(res.status).toBe(200);
    expect((await month()).body.carries.categories[food].carry).toBe(80);
  });

  test('transfers, what you excluded and other currencies never count, and the others are named', async () => {
    const t = await budgetBefore({ 'food and drink': 100 });
    await seedBank([
      row('food', on(-1), 30),
      row('move', on(-1), 500, 'transfer out', { transaction_code: 'transfer' }),
      row('trip', on(-1), 50, 'food and drink', { iso_currency_code: 'EUR' }),
      row('oneoff', on(-1), 60),
      row('euro-now', on(0), 9, 'food and drink', { iso_currency_code: 'EUR' }),
    ]);
    await setExcluded(ctx, 'oneoff', true);
    await rollover(t, 'food and drink', M(-1));
    const { body } = await month();
    expect(body.carries.categories[named(t, 'food and drink').id].carry).toBe(70);
    expect(body.currency).toBe('USD');
    expect(body.left_out_text).toBe("1 transaction in EUR isn't in these budgets, which are in USD.");
    // Last month's, which the carry counts, named too.
    expect(body.counted_left_out_text).toBe("1 transaction in EUR isn't in what rolled over from earlier months, which is in USD.");
    const api = await readBudgets(ctx, { month: NOW });
    expect(api.rollover_left_out).toEqual([{ currency: 'EUR', count: 1 }]);
    expect(api.rollover_left_out_text).toBe(body.counted_left_out_text);
  });

  test('changing this month’s amount leaves the carry of earlier months as it was', async () => {
    const t = await budgetBefore({ 'food and drink': 100 });
    await seedBank([row('m2', on(-2), 50), row('m1', on(-1), 50)]);
    await rollover(t, 'food and drink', M(-2));
    const food = named(t, 'food and drink').id;
    expect((await month()).body.carries.categories[food].carry).toBe(100);
    expect((await put({ budget_set: { categories: { [food]: { amount: 300 } }, groups: {} }, month: NOW })).status).toBe(200);
    const after = (await month()).body;
    expect(after.carries.categories[food].carry).toBe(100);
    expect(after.budgets.categories[food]).toEqual({ amount: 300 });
    // Last month, looked back on, had its own amount.
    expect((await month(M(-1))).body.budgets.categories[food]).toEqual({ amount: 100 });
    expect((await budgetMonthsStore.get(ctx))!.categories[food].amounts).toEqual([{ until: NOW, amount: 100 }]);
  });

  test('a month that may be incomplete makes the carry across it uncertain, and says why', async () => {
    const t = await budgetBefore({ 'food and drink': 100 });
    await seedBank([row('m3', on(-3, 1), 10), row('m2', on(-2), 10)]);
    // The connection broke, and last synced in the middle of two months ago.
    const lastOk = `${on(-2, 15)}T12:00:00.000Z`;
    await syncsStore.set(ctx, 'item_bank', { at: lastOk });
    await noticesStore.set(ctx, 'item_bank', { episode: 'e1', since: lastOk, state: 'needs_reauth', notified_at: null, reminded_at: null });
    await rollover(t, 'food and drink', M(-3));
    const { body } = await month();
    expect(body.carries.categories[named(t, 'food and drink').id].uncertain).toEqual([M(-2), M(-1)]);
    expect(body.gaps).toContainEqual({ month: M(-2), gaps: [{ kind: 'stopped', institution: 'Bank', since: lastOk }] });
    expect(body.gaps.map((g: { month: string }) => g.month)).not.toContain(M(-3));
  });

  test('a connection whose health can’t be read leaves every month counted uncertain, naming it', async () => {
    const t = await budgetBefore({ 'food and drink': 100 });
    await seedBank([row('m2', on(-2, 1), 30)]);
    await fake.hset(ctxKey('connection-notices'), { item_bank: 'not-ciphertext-at-all-but-long-enough' });
    await rollover(t, 'food and drink', M(-2));
    const { body } = await month();
    expect(body.carries.categories[named(t, 'food and drink').id].uncertain).toEqual([M(-2), M(-1)]);
    expect(body.gaps[0]).toEqual({ month: M(-2), gaps: [{ kind: 'unread', what: 'How Bank is doing' }] });
  });

  test('a bank whose stored history begins after a month began leaves that month uncertain', async () => {
    const t = await budgetBefore({ 'food and drink': 100 });
    await seedBank([row('m2', on(-2, 14), 30), row('m1', on(-1), 30)]);
    await rollover(t, 'food and drink', M(-2));
    const { body } = await month();
    expect(body.carries.categories[named(t, 'food and drink').id].uncertain).toEqual([M(-2)]);
    expect(body.gaps).toEqual([{ month: M(-2), gaps: [{ kind: 'begins', institution: 'Bank', first: on(-2, 14) }] }]);
  });

  test('a start before any transactions counts from the first month with one, and names it', async () => {
    const t = await budgetBefore({ 'food and drink': 100 });
    await seedBank([row('m2', on(-2), 30)]);
    await rollover(t, 'food and drink', M(-6));
    const c = (await month()).body.carries.categories[named(t, 'food and drink').id];
    expect(c).toMatchObject({ carry: 170, from: M(-2), why: 'data', start: M(-6) });
  });

  test('a budget made this month had none before: rollover from earlier counts from when it began, and says so', async () => {
    const t = await budget({ 'food and drink': 100 });
    await seedBank([row('m1', on(-1), 30)]);
    expect((await rollover(t, 'food and drink', M(-3))).status).toBe(200);
    const { body } = await month();
    const food = named(t, 'food and drink').id;
    expect(body.carries.categories[food]).toMatchObject({ carry: 0, from: NOW, why: 'budget', start: M(-3) });
    expect(body.starts.categories[food]).toBe(NOW);
    // Last month, looked back on, had no budget at all.
    expect((await month(M(-1))).body.budgets.categories).toEqual({});
  });

  test('budgets older than the record are assumed for the months before it, and said to be', async () => {
    const t = await budgetBefore({ 'food and drink': 100 });
    await seedBank([row('m1', on(-1), 30)]);
    const now = (await month()).body;
    expect(now.recorded_since).toBe(NOW);
    expect(now.assumed).toEqual({ categories: [], groups: [] });
    const before = (await month(M(-1))).body;
    expect(before.budgets.categories).toEqual({ [named(t, 'food and drink').id]: { amount: 100 } });
    expect(before.assumed.categories).toEqual([named(t, 'food and drink').id]);
    // Rollover can start as far back as there are transactions, or further.
    expect(now.starts.categories[named(t, 'food and drink').id]).toBe(addMonths(NOW, -120));
  });

  test('a group’s own budget rolls over what everything in it left', async () => {
    const t = await budgetBefore({}, { Food: 200 });
    await seedBank([row('m1', on(-1), 120)]);
    expect((await rollover(t, 'Food', M(-1), 'group')).status).toBe(200);
    const { body } = await month();
    expect(body.carries.groups[group(t, 'Food').id].carry).toBe(80);
    expect(body.rollover.groups[group(t, 'Food').id]).toBe(M(-1));
  });
});

describe('the read-only API and the Budgets tab agree', () => {
  test('the same budgets, carries, availability and pool, from the same read, with nothing written', async () => {
    const t = await budgetBefore({ 'food and drink': 100, travel: 50 }, { Food: 300 });
    await seedBank([
      row('pay', on(-2, 1), -2500, 'income'),
      row('m2', on(-2, 2), 60),
      row('trip', on(-2, 3), 80, 'travel'),
      row('m1', on(-1), 130),
      row('now', on(0, 1), 7),
    ]);
    await rollover(t, 'food and drink', M(-2));
    await rollover(t, 'Food', M(-2), 'group');
    await post({ action: 'income', enabled: true, start: M(-2), month: NOW });
    const app = (await month()).body;
    const stored = { months: await fake.get<string>(ctxKey('budget-months')), set: await fake.get<string>(ctxKey('budget-set')) };
    const api = await readBudgets(ctx, { month: NOW });
    const food = named(t, 'food and drink').id;
    const foodRow = api.budgets.find((b) => b.category_id === food)!;
    expect(foodRow.rollover).toEqual({ ...app.carries.categories[food], uncertain_months: app.carries.categories[food].uncertain, uncertain: undefined });
    expect(foodRow).toMatchObject({ budget: 100, available: 100 + app.carries.categories[food].carry, spent: app.spent[food] });
    const foodGroup = api.groups.find((g) => g.id === group(t, 'Food').id)!;
    expect(foodGroup.rollover?.carry).toBe(app.carries.groups[group(t, 'Food').id].carry);
    expect(api.income).toMatchObject({ carried_in: app.pool.carried_in, available: app.pool.available, months: app.pool.months });
    expect(api.earliest_month).toBe(app.earliest);
    // The read-only API writes nothing.
    expect({ months: await fake.get<string>(ctxKey('budget-months')), set: await fake.get<string>(ctxKey('budget-set')) }).toEqual(stored);
  });

  test('a month that may be incomplete, or comes before anything stored, is said in notes, never only in a field of its own', async () => {
    const t = await budgetBefore({ 'food and drink': 100 });
    await seedBank([row('m3', on(-3, 1), 10), row('m2', on(-2), 10), row('now', on(0, 1), 5)]);
    // The connection broke, and last synced in the middle of two months ago.
    const lastOk = `${on(-2, 15)}T12:00:00.000Z`;
    await syncsStore.set(ctx, 'item_bank', { at: lastOk });
    await noticesStore.set(ctx, 'item_bank', { episode: 'e1', since: lastOk, state: 'needs_reauth', notified_at: null, reminded_at: null });
    const now = await readBudgets(ctx, { month: NOW });
    expect(now.notes).toContain(`${NOW} may be incomplete, so what is spent may be off: Bank hasn’t synced since ${on(-2, 15)}`);
    // Before anything stored: nothing counted, said once.
    const old = await readBudgets(ctx, { month: M(-30) });
    expect(old.budgets[0].spent).toBe(0);
    expect(old.notes).toContain(`No transactions are stored from before ${M(-3)}, so nothing is counted as spent in ${M(-30)}`);
    expect(old.notes.filter((n) => n.includes('may be incomplete'))).toEqual([]);
    // What rolled over counts the months since it stopped.
    await rollover(t, 'food and drink', M(-3));
    expect((await readBudgets(ctx, { month: NOW })).notes).toContain(
      `What rolled over counts months that may be incomplete (${M(-2)} and ${M(-1)}), so it may be off: see incomplete_months`
    );
    await post({ action: 'income', enabled: true, start: M(-3), month: NOW });
    expect((await readBudgets(ctx, { month: NOW })).notes).toContain(
      `What rolled over and the income pool count months that may be incomplete (${M(-2)}, ${M(-1)} and ${NOW}), so they may be off: see incomplete_months`
    );
  });

  test('a month still to come, as far ahead as one can be asked: amounts, no carry, no pool, quickly', async () => {
    const t = await budgetBefore({ 'food and drink': 100 });
    await seedBank([row('m1', on(-1), 40), row('pay', on(-1, 2), -3000, 'income')]);
    await rollover(t, 'food and drink', M(-2));
    await post({ action: 'income', enabled: true, start: M(-2), month: NOW });
    const { token } = await createToken(ctx, 'Tests');
    for (const asked of ['9999-12', addMonths(NOW, 36)]) {
      const started = performance.now();
      const res = await v1Budgets.GET(new Request(`https://nya.test/api/v1/budgets?month=${asked}`, { headers: { authorization: `Bearer ${token}` } }));
      const text = await res.text();
      expect(res.status).toBe(200);
      expect(performance.now() - started).toBeLessThan(2000);
      expect(text.length).toBeLessThan(20_000);
      const body = JSON.parse(text);
      expect(body.budgets).toEqual([expect.objectContaining({ budget: 100, available: 100, rollover: null, spent: 0 })]);
      expect(body.income).toBeNull();
      expect(body.incomplete_months).toEqual([]);
      expect(body.notes).toContain(`${asked} hasn’t begun, so nothing has rolled into it yet, and no income pool is worked out for it`);
    }
  });

  test('a record that can’t be read is a 409 there too, never an answer without it', async () => {
    await budgetBefore({ 'food and drink': 100 });
    await seedBank([]);
    await fake.set(ctxKey('budget-months'), 'not-ciphertext-at-all-but-long-enough');
    const { token } = await createToken(ctx, 'Tests');
    const res = await v1Budgets.GET(new Request('https://nya.test/api/v1/budgets', { headers: { authorization: `Bearer ${token}` } }));
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe('unreadable');
  });
});

describe('income carryover', () => {
  test('off by default, and off it changes nothing about the budgets', async () => {
    const t = await budget({ 'food and drink': 100 });
    await seedBank([row('pay', on(-1), -3000, 'income'), row('m1', on(-1), 40)]);
    await rollover(t, 'food and drink', M(-1));
    const before = (await month()).body;
    expect(before.income).toBeNull();
    expect(before.pool).toBeNull();
    // On, then off: the budgets read exactly as they did.
    expect((await post({ action: 'income', enabled: true, start: M(-1), month: NOW })).status).toBe(200);
    expect((await month()).body.pool).not.toBeNull();
    const off = await post({ action: 'income', enabled: false, month: NOW });
    expect(off.body.income).toEqual({ version: 1, enabled: false, start: M(-1) });
    const after = (await month()).body;
    expect(after.pool).toBeNull();
    const { income: _a, ...budgetsBefore } = before;
    const { income: _b, ...budgetsAfter } = after;
    expect(budgetsAfter).toEqual(budgetsBefore);
  });

  test('the pool reconciles with the months’ net flows, and moving money between your own accounts never inflates it', async () => {
    const rows = [
      row('pay1', on(-3, 1), -9000.01, 'income'),
      row('rent', on(-3, 2), 1234.56, 'rent and utilities'),
      row('coffee', on(-3, 3), 0.1),
      row('tea', on(-3, 4), 0.2),
      row('refund', on(-3, 5), -19.99),
      row('pay2', on(-2, 1), -2000.33, 'income'),
      row('car', on(-2, 2), 2999.97, 'transportation'),
      row('sweep-in', on(-2, 3), -5000, 'transfer in', { transaction_code: 'transfer' }),
      row('sweep-out', on(-2, 3), 5000, 'transfer out', { transaction_code: 'transfer' }),
      row('m1', on(-1), 0.3),
      row('now', on(0, 1), 10),
    ];
    await seedBank(rows);
    await budget({});
    expect((await post({ action: 'income', enabled: true, start: M(-3), month: NOW })).status).toBe(200);
    const pool = (await month()).body.pool;
    // The months' net flows, as the Activity tab totals each month.
    const read = await readBudgetMonth(ctx, { month: NOW, today: NOW });
    const nets = [M(-3), M(-2), M(-1)].map((m) => summarize(read.activity.rows, (d) => d.slice(0, 7) === m, 'USD').net);
    expect(pool.carried_in).toBe(Math.round(nets.reduce((a, n) => a + n, 0) * 100) / 100);
    // 9,020.00 in and 1,234.86 out; 2,000.33 in and 2,999.97 out; 0.30 out.
    expect(pool.carried_in).toBe(6785.2);
    expect(pool.months.map((m: { month: string }) => m.month)).toEqual([M(-3), M(-2), M(-1), M(0)]);
    expect(pool.months[1]).toMatchObject({ income: 2000.33, spending: 2999.97 });
    expect(pool.available).toBe(Math.round((pool.carried_in - 10) * 100) / 100);
  });
});

describe('merges, deletes and the record by month', () => {
  test('merging a category moves its rollover and amounts with its budget, and the carry counts them together', async () => {
    const t = await budgetBefore({ 'food and drink': 100, groceries: 50 });
    await seedBank([row('a', on(-1), 30), row('b', on(-1), 20, 'groceries')]);
    await rollover(t, 'groceries', M(-1));
    const groceries = named(t, 'groceries').id;
    const food = named(t, 'food and drink').id;
    expect((await month()).body.carries.categories[groceries].carry).toBe(30);
    const merged = await call(categoriesRoute.POST(new Request('http://x', { method: 'POST', body: JSON.stringify({ action: 'merge', id: groceries, into: food }) })));
    expect(merged.status).toBe(200);
    const record = (await budgetMonthsStore.get(ctx))!;
    expect(record.categories[groceries]).toBeUndefined();
    expect(record.categories[food]).toMatchObject({ seen: 150, rollover: [{ from: M(-1) }] });
    const { body } = await month();
    expect(body.budgets.categories[food]).toEqual({ amount: 150 });
    // 150 budgeted last month, 50 spent in the two together.
    expect(body.carries.categories[food].carry).toBe(100);
  });

  test('deleting a category drops its record', async () => {
    const t = await budgetBefore({ groceries: 50 });
    await seedBank([]);
    await rollover(t, 'groceries', M(0));
    const groceries = named(t, 'groceries').id;
    // The budget removed (its rollover ends), then the category deleted.
    expect((await put({ budget_set: { categories: {}, groups: {} }, month: NOW })).status).toBe(200);
    expect((await budgetMonthsStore.get(ctx))!.categories[groceries]).toBeDefined();
    const res = await call(categoriesRoute.POST(new Request('http://x', { method: 'POST', body: JSON.stringify({ action: 'delete-category', id: groceries }) })));
    expect(res.status).toBe(200);
    expect((await budgetMonthsStore.get(ctx))!.categories[groceries]).toBeUndefined();
  });
});

describe('what a rollback to the release before sees', () => {
  test('the budget set it reads is the same closed shape, saved as before; its change is noted from the month it is first read', async () => {
    const t = await budgetBefore({ 'food and drink': 100 }, { Food: 400 });
    await seedBank([row('m2', on(-2), 50), row('m1', on(-1), 50)]);
    await rollover(t, 'food and drink', M(-2));
    await post({ action: 'income', enabled: true, start: M(-2), month: NOW });
    await month();
    const food = named(t, 'food and drink').id;
    // The budget set: exactly what that release reads, and nothing it doesn't.
    const set = (await budgetSetStore.get(ctx))!;
    expect(isBudgetSet(set)).toBe(true);
    expect(Object.keys(set).every((k) => ['version', 'categories', 'groups', 'mirror', 'mirror_before', 'replaced'].includes(k))).toBe(true);
    expect(set.categories).toEqual({ [food]: { amount: 100 } });
    expect(await getBudgets(ctx)).toEqual({ 'food and drink': 100 });
    // That release saves a new amount, as it saves budgets: this release's
    // records are beside its set, and it never touches them.
    const record = await fake.get<string>(ctxKey('budget-months'));
    const { budgets, taxonomy } = await loadBudgets(ctx);
    await saveBudgets(ctx, { ...budgets, categories: { [food]: { amount: 250 } } }, taxonomy);
    expect(await fake.get<string>(ctxKey('budget-months'))).toBe(record);
    // Read again here: the new amount from this month on, the months before
    // keep theirs, and the carry into this month is unchanged.
    const { body } = await month();
    expect(body.budgets.categories[food]).toEqual({ amount: 250 });
    expect(body.carries.categories[food].carry).toBe(100);
    expect((await month(M(-1))).body.budgets.categories[food]).toEqual({ amount: 100 });
  });
});

describe('what can’t be read', () => {
  test('a record of budgets by month that can’t be read: 409, never read as none, never saved over, and budgets still save', async () => {
    const t = await budgetBefore({ 'food and drink': 100 });
    await seedBank([]);
    const food = named(t, 'food and drink').id;
    expect((await month()).status).toBe(200);
    const good = (await fake.get<string>(ctxKey('budget-months')))!;
    let amount = 100;
    for (const bad of ['not-ciphertext-at-all-but-long-enough', await encrypt(JSON.stringify({ version: 1, since: NOW, categories: {}, groups: {}, targets: [] }))]) {
      await fake.set(ctxKey('budget-months'), bad);
      const read = await month();
      expect(read.status).toBe(409);
      expect(read.body.unreadable).toBe(true);
      expect((await post({ action: 'rollover', kind: 'category', id: food, on: true, from: NOW, month: NOW })).status).toBe(409);
      // A save goes through: it writes the budgets, never the record.
      amount += 100;
      const saved = await put({ budget_set: { categories: { [food]: { amount } }, groups: {} }, month: NOW });
      expect(saved.status).toBe(200);
      expect(saved.body.budget_set.categories[food]).toEqual({ amount });
      expect(await fake.get<string>(ctxKey('budget-months'))).toBe(bad);
    }
    // Readable again (a release that knows it, or the damage undone): the
    // change is noted as of the month it is read in, the months before kept.
    await fake.set(ctxKey('budget-months'), good);
    expect((await month()).status).toBe(200);
    expect((await budgetMonthsStore.get(ctx))!.categories[food]).toEqual({ seen: amount, amounts: [{ until: NOW, amount: 100 }] });
    expect((await month(M(-1))).body.budgets.categories[food]).toEqual({ amount: 100 });
  });

  test('an income setting that can’t be read: 409, and never saved over', async () => {
    await budget({});
    await seedBank([]);
    await fake.set(ctxKey('income-carryover'), 'not-ciphertext-at-all-but-long-enough');
    expect((await month()).status).toBe(409);
    expect((await post({ action: 'income', enabled: false, month: NOW })).status).toBe(409);
    expect(await fake.get<string>(ctxKey('income-carryover'))).toBe('not-ciphertext-at-all-but-long-enough');
  });
});

describe('the stores', () => {
  test('declared on the seam, exportable, on the key inventory as one string inside a container', () => {
    for (const name of ['budget-months', 'income-carryover']) {
      expect(declaredStore(name)).toMatchObject({ kind: 'value', exportable: true });
      expect(classify(ctxKey(name).replace(/^[^:]+:(?=c:)/, ''))).toBe('string');
      expect(classify(name)).toBeNull();
    }
  });

  test('another person’s records are never read or written', async () => {
    // Someone else, with their own budgets, rollover and income setting.
    const theirs = { version: 1 as const, since: M(-5), categories: { someone: { seen: 999, rollover: [{ from: M(-5) }] } }, groups: {} };
    await budgetMonthsStore.set(OTHER, theirs);
    await incomeCarryoverStore.set(OTHER, { version: 1, enabled: true, start: M(-5) });
    await seedBank([row('theirs', on(-1), 500)], { for: OTHER, name: 'TheirBank' });
    const before = { months: await fake.get<string>(ctxKey('budget-months', OTHER)), income: await fake.get<string>(ctxKey('income-carryover', OTHER)) };
    const t = await budgetBefore({ 'food and drink': 100 });
    await seedBank([row('mine', on(-1), 10)]);
    await rollover(t, 'food and drink', M(-1));
    await post({ action: 'income', enabled: true, start: M(-1), month: NOW });
    const { body } = await month();
    expect(body.carries.categories[named(t, 'food and drink').id].carry).toBe(90);
    expect(body.pool.months.map((m: { spending: number }) => m.spending)).toEqual([10, 0]);
    expect(JSON.stringify(body)).not.toContain('someone');
    expect(JSON.stringify(body)).not.toContain('TheirBank');
    expect({ months: await fake.get<string>(ctxKey('budget-months', OTHER)), income: await fake.get<string>(ctxKey('income-carryover', OTHER)) }).toEqual(before);
    expect(await budgetMonthsStore.get(OTHER)).toEqual(theirs);
  });

  test('a value the seam can’t use is told apart from damage', async () => {
    await fake.set(ctxKey('budget-months'), await encrypt(JSON.stringify({ version: 2, since: NOW, categories: {}, groups: {} })));
    const err = await budgetMonthsStore.get(ctx).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UnreadableValueError);
    expect((err as InstanceType<typeof UnreadableValueError>).unrecognised).toBe(true);
  });
});

describe('what the routes take', () => {
  test('the month view’s query: one this month, a month no later and not too far back, nothing else', () => {
    const now = Date.parse('2026-10-15T12:00:00Z');
    const q = (s: string) => readMonthParams(new URLSearchParams(s), now);
    expect(q('')).toEqual({ month: '2026-10', today: '2026-10', history: false });
    expect(q('month=2026-08&today=2026-10')).toEqual({ month: '2026-08', today: '2026-10', history: false });
    expect(q('today=2026-10&history=1')).toEqual({ month: '2026-10', today: '2026-10', history: true });
    expect(q('history=true')).toEqual({ error: 'history can only be 1' });
    expect(q('month=2026-11&today=2026-10')).toEqual({ error: 'month can’t be after this month' });
    expect(q('today=2026-09')).toEqual({ error: 'today must be this month, YYYY-MM' });
    expect(q('month=2016-09')).toEqual({ error: 'month can be at most 10 years back' });
    expect(q('month=2026-8')).toEqual({ error: 'month must be a month, YYYY-MM' });
    expect(q('month=2026-08&month=2026-07')).toEqual({ error: 'month is given more than once' });
    expect(q('year=2026')).toEqual({ error: 'Unknown parameter' });
  });

  test('the month view refuses a bad query with 400', async () => {
    expect((await call(monthRoute.GET(new Request('http://x/api/budgets/month?month=2020-13')))).status).toBe(400);
    expect((await call(monthRoute.GET(new Request(`http://x/api/budgets/month?today=${M(-3)}`)))).status).toBe(400);
  });

  test('a change to rollover is checked field by field', async () => {
    const t = await budget({ 'food and drink': 100 });
    const food = named(t, 'food and drink').id;
    const refused = async (body: unknown, status = 400) => expect([JSON.stringify(body), (await post(body)).status]).toEqual([JSON.stringify(body), status]);
    await refused('not an object');
    await refused({ action: 'rollover', kind: 'category', id: food, on: true, from: NOW });
    await refused({ action: 'rollover', kind: 'category', id: food, on: true, from: NOW, month: M(-2) });
    await refused({ action: 'explode', month: NOW });
    await refused({ action: 'rollover', kind: 'category', id: food, on: true, from: NOW, month: NOW, extra: 1 });
    await refused({ action: 'rollover', kind: 'tag', id: food, on: true, from: NOW, month: NOW });
    await refused({ action: 'rollover', kind: 'category', id: 'not an id!', on: true, from: NOW, month: NOW });
    await refused({ action: 'rollover', kind: 'category', id: food, on: 'yes', month: NOW });
    await refused({ action: 'rollover', kind: 'category', id: food, on: true, month: NOW });
    await refused({ action: 'rollover', kind: 'category', id: food, on: false, from: NOW, month: NOW });
    await refused({ action: 'rollover', kind: 'category', id: food, on: true, from: M(1), month: NOW });
    await refused({ action: 'rollover', kind: 'category', id: food, on: true, from: M(-121), month: NOW });
    await refused({ action: 'income', enabled: true, month: NOW });
    await refused({ action: 'income', enabled: false, start: NOW, month: NOW });
    await refused({ action: 'income', enabled: true, start: M(1), month: NOW });
    // A budget that doesn't exist, and a reset of one that doesn't roll over.
    await refused({ action: 'rollover', kind: 'category', id: named(t, 'travel').id, on: true, from: NOW, month: NOW }, 409);
    await refused({ action: 'reset', kind: 'category', id: food, month: NOW }, 409);
    await refused({ action: 'rollover', kind: 'group', id: group(t, 'Food').id, on: true, from: NOW, month: NOW }, 409);
    const big = await call(rolloverRoute.POST(new Request('http://x', { method: 'POST', body: JSON.stringify({ action: 'income', pad: 'x'.repeat(5000) }) })));
    expect(big.status).toBe(413);
  });

  test('a save of budgets takes this month or none, and refuses anything else', async () => {
    await budget({});
    expect((await put({ budget_set: { categories: {}, groups: {} }, month: 'soon' })).status).toBe(400);
    expect((await put({ budget_set: { categories: {}, groups: {} } })).status).toBe(200);
  });

  test('failures answer by the seam’s rules', async () => {
    const answer = async (err: unknown) => {
      const res = rolloverFailure(err, 'Failed');
      return { status: res.status, body: await res.json() };
    };
    expect((await answer(new ContainerError('No container exists yet.'))).status).toBe(503);
    expect(await answer(new UnreadableValueError('budgets by month', false))).toMatchObject({ status: 409, body: { unreadable: true } });
    expect(await answer(new UpdateConflictError('budgets by month'))).toMatchObject({ status: 409, body: { error: expect.stringContaining('kept changing') } });
    expect((await answer(new StoredValueTooLargeError('budgets by month', 10, 5))).status).toBe(413);
    expect(await answer(new Error('secret detail'))).toEqual({ status: 500, body: { error: 'Failed' } });
  });

  test('no container: 503 from both routes', async () => {
    await registerTestContainer(fake, 'restoring');
    expect((await month()).status).toBe(503);
    expect((await post({ action: 'income', enabled: false, month: NOW })).status).toBe(503);
  });
});
