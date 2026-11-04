import { describe, expect, test, mock, beforeEach, afterEach } from 'bun:test';
import { FakeRedis, storageMock, TEST_CTX, ctxKey, registerTestContainer, unscopedDataKeys } from './fake-redis';
import type { FirePlan } from '@/lib/fire/plan';
import type { PlanFacts } from '@/lib/fire/copies';

// The release before (E1, its Plan's readers byte for byte in
// test/fixtures/release-before/fire, pinned by test/release-before.test.ts)
// reading what this release's Plan writes, through this release's routes:
//   - every plan, saved plan, scenario and currency record they store, which
//     are what E1 stores (version 1, beside no new store);
//   - every answer GET gives from your plan's entry once a newer release has
//     made the plans copies, which an E1 page still open takes as a plan;
//   - and neither `fire-plans` nor `plan-facts` is ever made here, so E1, on a
//     rollback, never meets a store it doesn't know that this release made.

process.env.PLAID_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');

const fake = new FakeRedis({ deserialize: true });
afterEach(() => expect(unscopedDataKeys(fake)).toEqual([]));
mock.module('@/lib/storage', () => storageMock(fake));

const oPlanV2 = await import('./fixtures/release-before/fire/plan-v2');
const oSaved = await import('./fixtures/release-before/fire/saved-plan');
const oScenarios = await import('./fixtures/release-before/fire/scenarios');
const oCurrency = await import('./fixtures/release-before/fire/plan-currency');
const { firePlanStore, planCurrencyStore } = await import('@/lib/fire-plan');
const { firePlansStore, planFactsStore } = await import('@/lib/plan-copies');
const { planScenariosStore } = await import('@/lib/plan-scenarios');
const { savedPlanStore } = await import('@/lib/saved-plan');
const { emptyAccount } = await import('@/lib/user-restore/undo');
const { planOf, toStored } = await import('@/lib/fire/plan-v2');
const { expensesOf, incomeOf, withExpenses, withIncome } = await import('@/lib/fire/items');
const { MAIN_ID, factsOf } = await import('@/lib/fire/copies');
const { typedAmounts } = await import('@/lib/fire/plan-currency');
const { genEvents, genPlan, rand } = await import('./plan-gen');
const planRoute = await import('@/app/api/fire-plan/route');
const savedRoute = await import('@/app/api/saved-plan/route');
const scenariosRoute = await import('@/app/api/plan-scenarios/route');

beforeEach(async () => {
  fake.reset();
  (await import('@/lib/sessions')).forgetEpochs();
  await registerTestContainer(fake);
});

const ctx = TEST_CTX;
const AT = '2026-11-01T10:00:00.000Z';
const req = (path: string, method: string, body: unknown) => new Request(`http://localhost/api/${path}`, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const call = async (handler: (r: Request) => Promise<Response>, path: string, method: string, body: unknown) => {
  const res = await handler(req(path, method, body));
  return { status: res.status, body: await res.json() };
};
const newStores = async () => [await fake.type(ctxKey('fire-plans')), await fake.type(ctxKey('plan-facts'))];

/** A version 1 plan edited as the cards edit it, as a save sends it; null
 *  where the edit makes more than version 1 takes. */
function edited(seed: number): FirePlan | null {
  const g = rand(seed);
  let v2 = planOf(genPlan(g, seed % 3 === 0));
  v2 = withIncome(v2, [...incomeOf(v2).slice(1), { id: `new${seed}`, label: 'Pension', amount: g.int(1, 40) * 1000, fromAge: g.int(50, 70), inflationAdjusted: g.chance(0.5) }]);
  v2 = withExpenses(v2, expensesOf(v2).map((x) => ({ ...x, amount: x.amount + 1000 })));
  v2 = { ...v2, spending: g.int(20, 90) * 1000 };
  const sent = toStored(v2, 1);
  return 'error' in sent ? null : sent.plan;
}

describe('the release before’s readers take what this release writes', () => {
  test('every plan and currency record a save stores, and every saved plan and scenario, through the routes', async () => {
    let saved = 0;
    for (let seed = 9400; seed < 9460; seed++) {
      const plan = edited(seed);
      if (!plan) continue;
      saved++;
      expect((await call(planRoute.PUT, 'fire-plan', 'PUT', { plan, currency: 'USD', facts_were: factsOf(plan) })).status).toBe(200);
      const stored = await firePlanStore.get(ctx);
      expect(oPlanV2.isStoredPlan(stored)).toBe(true);
      expect(oPlanV2.upgradeStoredPlan(stored)).toEqual(stored);
      const record = await planCurrencyStore.get(ctx);
      expect(oCurrency.isPlanCurrencyRecord(record)).toBe(true);
      if (oCurrency.hasTypedAmounts(plan)) expect(oCurrency.recordedCurrency(stored!, record)).toBe('USD');

      const keep = await call(savedRoute.PUT, 'saved-plan', 'PUT', { saved: { plan, savings: 20_000, currency: 'USD', inflation: 0.03 }, based_on: (await savedPlanStore.get(ctx))?.rev ?? null });
      expect(keep.status).toBe(200);
      expect(oSaved.isSavedPlan(await savedPlanStore.get(ctx))).toBe(true);

      const g = rand(seed);
      const draft = { name: `Scenario ${seed}`, currency: 'USD', set: { targetAge: g.int(40, 70) }, income: { leaveOut: [], add: [] }, expenses: { leaveOut: [], add: [] }, events: genEvents(g).slice(0, 3) };
      const made = await call(scenariosRoute.POST, 'plan-scenarios', 'POST', { scenario: draft });
      expect(made.status).toBe(200);
      expect(oScenarios.isPlanScenario(await planScenariosStore.get(ctx, made.body.scenario.id))).toBe(true);
      await planScenariosStore.remove(ctx, made.body.scenario.id);
    }
    expect(saved).toBeGreaterThan(45);
    expect(await newStores()).toEqual(['none', 'none']);
  });

  test('every answer GET gives from your plan’s entry, either version, the facts applied, is a plan to an E1 page', async () => {
    for (let seed = 1; seed <= 150; seed++) {
      const g = rand(seed);
      const p = genPlan(g, seed % 3 === 0);
      const plan = g.chance(0.5) ? p : { ...planOf(p), stopAtFi: g.chance(0.3), fiNumber: g.chance(0.2) ? g.int(500, 3000) * 1000 : null };
      await firePlansStore.set(ctx, MAIN_ID, { name: 'First plan', plan, tax: null, currency: g.chance(0.8) ? 'USD' : null, createdAt: AT, updatedAt: AT });
      const facts: PlanFacts = {
        version: 1,
        main: MAIN_ID,
        age: g.chance(0.9) ? g.int(22, 70) : null,
        partnerAge: g.chance(0.4) ? g.int(22, 70) : null,
        includeCash: g.chance(0.5),
        planFunding: g.chance(0.3) ? [{ account_id: 'acc_1', paidFrom: g.pick(['bank', 'payroll'] as const) }] : [],
        method: g.pick(['historical', 'monte-carlo'] as const),
      };
      if (g.chance(0.8)) await planFactsStore.set(ctx, facts);
      else await planFactsStore.remove(ctx);
      const res = await planRoute.GET();
      const body = await res.json();
      expect([seed, res.status, oPlanV2.isStoredPlan(body.plan)]).toEqual([seed, 200, true]);
      expect(body.currency === null || typeof body.currency === 'string').toBe(true);
    }
  });
});

describe('nothing this release writes makes either store', () => {
  test('the plan’s save and its currency, the saved plan, and every scenario route', async () => {
    const plan = { ...edited(9500)!, age: 41 };
    expect((await call(planRoute.PUT, 'fire-plan', 'PUT', { plan, currency: 'USD' })).status).toBe(200);
    expect((await call(planRoute.POST, 'fire-plan', 'POST', { currency: 'EUR', amounts: typedAmounts(plan), answered: true })).status).toBe(200);
    expect((await call(savedRoute.PUT, 'saved-plan', 'PUT', { saved: { plan, savings: 1, currency: 'USD', inflation: 0.02 }, based_on: null })).status).toBe(200);
    const draft = { name: 'Retire at 50', currency: 'USD', set: { targetAge: 50 }, income: { leaveOut: [], add: [] }, expenses: { leaveOut: [], add: [] }, events: [] };
    const made = await call(scenariosRoute.POST, 'plan-scenarios', 'POST', { scenario: draft });
    expect((await call(scenariosRoute.PUT, 'plan-scenarios', 'PUT', { id: made.body.scenario.id, scenario: { ...draft, name: 'Retire at 51' }, based_on: made.body.scenario.rev })).status).toBe(200);
    expect((await call(scenariosRoute.DELETE, 'plan-scenarios', 'DELETE', { id: made.body.scenario.id })).status).toBe(200);
    expect(await newStores()).toEqual(['none', 'none']);
  });

  test('emptying an account takes both away, as every store', async () => {
    await firePlansStore.set(ctx, MAIN_ID, { name: 'First plan', plan: edited(9501)!, tax: null, currency: 'USD', createdAt: AT, updatedAt: AT });
    await planFactsStore.set(ctx, { version: 1, main: MAIN_ID, ...factsOf(edited(9501)!) });
    await emptyAccount(ctx, { userId: null });
    expect(await newStores()).toEqual(['none', 'none']);
  });
});
