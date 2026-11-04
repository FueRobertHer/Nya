import { describe, expect, test, mock, beforeEach } from 'bun:test';
import { FakeRedis, storageMock, TEST_CTX, registerTestContainer } from './fake-redis';

// FirePlan version 2 at the storage seam (lib/plan-copies.ts,
// lib/saved-plan.ts, lib/user-restore/check.ts): every store reads either
// version and keeps it as stored. This release saves your plan in version 2
// only, and the saved plan in either.

process.env.PLAID_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');

const fake = new FakeRedis({ deserialize: true });
mock.module('@/lib/storage', () => storageMock(fake));

const route = await import('@/app/api/fire-plan/route');
const { firePlansStore } = await import('@/lib/plan-copies');
const { MAIN_ID, factsOf } = await import('@/lib/fire/copies');
const { DEFAULT_PLAN } = await import('@/lib/fire/plan');
const { DEFAULT_PLAN_V2, planOf } = await import('@/lib/fire/plan-v2');
const { itemFromEvent } = await import('@/lib/fire/items');
const { isSavedPlan, parseSavedDraft, upgradeSavedPlan } = await import('@/lib/fire/saved-plan');
const { checkBatch, BatchRefused } = await import('@/lib/user-restore/check');
const { typedAmounts, hasTypedAmounts } = await import('@/lib/fire/plan-currency');

beforeEach(async () => {
  fake.reset();
  (await import('@/lib/sessions')).forgetEpochs();
  await registerTestContainer(fake);
});

const v1 = { ...DEFAULT_PLAN, age: 40, targetAge: 55, income: [{ id: 'ss', label: 'Social Security', amount: 24_000, fromAge: 67, inflationAdjusted: true }], expenses: [{ id: 'roof', label: 'Roof', amount: 30_000, atAge: 50 }] };
const v2 = { ...DEFAULT_PLAN_V2, age: 40, targetAge: null, stopAtFi: true, items: [itemFromEvent({ id: 'k', kind: 'child', label: 'A child', fromAge: 42, yearly: 10_000, years: 18 })] };

const put = (body: unknown) => route.PUT(new Request('http://x', { method: 'PUT', body: JSON.stringify(body) }));

describe('the Plan’s stores and route', () => {
  const AT = '2026-11-01T10:00:00.000Z';

  test('a version 2 plan in your plan’s entry reads back as stored, version 2, and the route answers it so', async () => {
    await firePlansStore.set(TEST_CTX, MAIN_ID, { name: 'First plan', plan: v2, tax: null, currency: 'USD', createdAt: AT, updatedAt: AT });
    expect((await firePlansStore.get(TEST_CTX, MAIN_ID))!.plan).toEqual(v2);
    expect((await (await route.GET()).json()).plan).toEqual(v2);
  });

  test('a version 1 plan in an entry, as the release before may have saved it, reads back version 1', async () => {
    await firePlansStore.set(TEST_CTX, MAIN_ID, { name: 'First plan', plan: v1, tax: null, currency: 'USD', createdAt: AT, updatedAt: AT });
    expect((await (await route.GET()).json()).plan).toEqual(v1);
  });

  test('the route saves version 2, and refuses version 1 without writing', async () => {
    const saved = await put({ plan: v2, currency: 'USD', facts_were: factsOf(DEFAULT_PLAN_V2), based_on: null });
    expect(saved.status).toBe(200);
    const { updated_at } = await saved.json();
    expect((await firePlansStore.get(TEST_CTX, MAIN_ID))!.plan).toEqual(v2);
    const res = await put({ plan: v1, currency: 'USD', facts_were: factsOf(v2), based_on: updated_at });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toStartWith('Invalid plan: ');
    expect((await firePlansStore.get(TEST_CTX, MAIN_ID))!.plan).toEqual(v2);
    // One that converts back to version 1 is saved as it is, version 2.
    expect((await put({ plan: planOf(v1), currency: 'USD', facts_were: factsOf(v2), based_on: updated_at })).status).toBe(200);
    expect((await firePlansStore.get(TEST_CTX, MAIN_ID))!.plan).toEqual(planOf(v1));
  });
});

describe('the saved plan', () => {
  const saved = (plan: unknown) => ({ version: 1, plan, savings: 30_000, currency: 'USD', inflation: 0.025, day: '2026-11-01', savedAt: '2026-11-01T12:00:00.000Z', rev: 'r1' });

  test('reads either version, keeping it; a save takes either, each held to its own rules', () => {
    expect(isSavedPlan(saved(v1))).toBe(true);
    expect(isSavedPlan(saved(v2))).toBe(true);
    expect(upgradeSavedPlan(saved(v2))).toEqual(saved(v2));
    expect(parseSavedDraft({ plan: v1, savings: 1, currency: 'USD', inflation: 0.02 })).toMatchObject({ ok: { plan: v1 } });
    expect(parseSavedDraft({ plan: v2, savings: 1, currency: 'USD', inflation: 0.02 })).toMatchObject({ ok: { plan: v2 } });
    expect(parseSavedDraft({ plan: { ...v2, partnerAge: 200 }, savings: 1, currency: 'USD', inflation: 0.02 })).toMatchObject({ error: expect.stringContaining('plan: partnerAge') });
  });
});

describe('a restore', () => {
  const env = { exported: '2026-10-10', today: '2026-10-18' };
  const refused = (body: unknown): string => {
    try {
      checkBatch(body, env);
    } catch (err) {
      if (err instanceof BatchRefused) return err.problem;
      throw err;
    }
    return 'passed';
  };

  test('writes a saved plan in either version, as a newer release’s download holds one; the plan before copies is no part it writes', () => {
    expect(refused({ part: 'store:fire-plan', records: [{ value: v1 }] })).toBe('This batch names a part this version of Nya doesn’t write.');
    const saved = (plan: unknown) => ({ version: 1, plan, savings: 30_000, currency: 'USD', inflation: 0.025, day: '2026-10-01', savedAt: '2026-10-01T12:00:00.000Z', rev: 'r1' });
    expect(refused({ part: 'store:fire-plan-saved', records: [{ value: saved(v1) }] })).toBe('passed');
    expect(refused({ part: 'store:fire-plan-saved', records: [{ value: saved(v2) }] })).toBe('passed');
  });
});

test('the amounts a currency holds for read the same from either version', () => {
  expect(typedAmounts(planOf(v1))).toEqual(typedAmounts(v1));
  expect(hasTypedAmounts(planOf(v1))).toBe(true);
  expect(hasTypedAmounts(DEFAULT_PLAN_V2)).toBe(false);
});
