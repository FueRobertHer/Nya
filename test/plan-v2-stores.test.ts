import { describe, expect, test, mock, beforeEach } from 'bun:test';
import { FakeRedis, storageMock, TEST_CTX, registerTestContainer } from './fake-redis';

// FirePlan version 2 at the storage seam (lib/fire-plan.ts, lib/saved-plan.ts,
// lib/user-restore/check.ts): every store reads either version and keeps it
// as stored, and this release writes version 1 only, through the route,
// the saved plan's route and a restore alike.

process.env.PLAID_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');

const fake = new FakeRedis({ deserialize: true });
mock.module('@/lib/storage', () => storageMock(fake));

const route = await import('@/app/api/fire-plan/route');
const { firePlanStore } = await import('@/lib/fire-plan');
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

describe('the Plan’s store and route', () => {
  test('a version 2 plan stored reads back as stored, version 2, and the route answers it so', async () => {
    await firePlanStore.set(TEST_CTX, v2);
    expect(await firePlanStore.get(TEST_CTX)).toEqual(v2);
    expect((await (await route.GET()).json()).plan).toEqual(v2);
  });

  test('the route saves version 1 as today, and refuses version 2 without writing', async () => {
    expect((await put({ plan: v1 })).status).toBe(200);
    expect(await firePlanStore.get(TEST_CTX)).toEqual(v1);
    const res = await put({ plan: v2 });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('This plan holds what only a newer version of Nya can save');
    expect(await firePlanStore.get(TEST_CTX)).toEqual(v1);
    // So is one that converts back, still marked version 2.
    expect((await put({ plan: planOf(v1) })).status).toBe(400);
  });
});

describe('the saved plan', () => {
  const saved = (plan: unknown) => ({ version: 1, plan, savings: 30_000, currency: 'USD', inflation: 0.025, day: '2026-11-01', savedAt: '2026-11-01T12:00:00.000Z', rev: 'r1' });

  test('reads either version, keeping it; a save takes version 1 only', () => {
    expect(isSavedPlan(saved(v1))).toBe(true);
    expect(isSavedPlan(saved(v2))).toBe(true);
    expect(upgradeSavedPlan(saved(v2))).toEqual(saved(v2));
    expect(parseSavedDraft({ plan: v1, savings: 1, currency: 'USD', inflation: 0.02 })).toMatchObject({ ok: { plan: v1 } });
    expect(parseSavedDraft({ plan: v2, savings: 1, currency: 'USD', inflation: 0.02 })).toMatchObject({ error: expect.stringContaining('plan:') });
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

  test('writes the Plan in version 1, refusing version 2; a saved plan in either, as a newer release’s download holds one', () => {
    expect(refused({ part: 'store:fire-plan', records: [{ value: v1 }] })).toBe('passed');
    expect(refused({ part: 'store:fire-plan', records: [{ value: v2 }] })).toContain('only a newer version of Nya can save');
    const saved = (plan: unknown) => ({ version: 1, plan, savings: 30_000, currency: 'USD', inflation: 0.025, day: '2026-10-01', savedAt: '2026-10-01T12:00:00.000Z', rev: 'r1' });
    expect(refused({ part: 'store:fire-plan-saved', records: [{ value: saved(v1) }] })).toBe('passed');
    expect(refused({ part: 'store:fire-plan-saved', records: [{ value: saved(v2) }] })).toBe('passed');
  });
});

test('the currency record reads the same amounts from either version', () => {
  expect(typedAmounts(planOf(v1))).toEqual(typedAmounts(v1));
  expect(hasTypedAmounts(planOf(v1))).toBe(true);
  expect(hasTypedAmounts(DEFAULT_PLAN_V2)).toBe(false);
});
