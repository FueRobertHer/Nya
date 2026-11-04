import { describe, expect, test, mock, beforeEach, afterEach } from 'bun:test';
import { FakeRedis, storageMock, TEST_CTX, ctxKey, registerTestContainer, unscopedDataKeys } from './fake-redis';
import type { FirePlanV2 } from '@/lib/fire/plan-v2';
import type { PlanEntry, PlanFacts } from '@/lib/fire/copies';
import type { PlanItem } from '@/lib/fire/items';

// The release before (C2, whose readers of the plans as copies are in
// test/fixtures/release-before/fire/copies.ts byte for byte, pinned by
// test/release-before.test.ts) reading what this release writes, so a
// rollback to it loses no plan. Every write this release makes (your plan's
// first save, a New copy, a Try it, an Also save over two plans, a rename, a
// copy's currency, a delete, Make this your plan, your plan's currency alone)
// is read back from the stored bytes with C2's own checks: each entry is an
// entry to it (isPlanEntry, after its upgrade), the facts are facts to it
// (isPlanFacts), your plan is the one it picks (mainOf, never said to be
// missing), every entry that holds an amount holds its currency, and what its
// GET answers from them is the plan this release answers. A saved plan of
// version 2 is a saved plan to it (isSavedPlan). E2 writes items of every
// kind on every anchor, the stop at FI, your partner's age and your own FI
// number, all of which C2 reads, and C2's cards keep the items they can't
// show (its withIncome, withExpenses and withEvents).

process.env.PLAID_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');

const fake = new FakeRedis({ deserialize: true });
afterEach(() => expect(unscopedDataKeys(fake)).toEqual([]));
mock.module('@/lib/storage', () => storageMock(fake));

const oCopies = await import('./fixtures/release-before/fire/copies');
const oSaved = await import('./fixtures/release-before/fire/saved-plan');
const oPlanV2 = await import('./fixtures/release-before/fire/plan-v2');
const oItems = await import('./fixtures/release-before/fire/items');
const { openStored } = await import('@/lib/repo');
const { firePlansStore, planFactsStore } = await import('@/lib/plan-copies');
const { savedPlanStore } = await import('@/lib/saved-plan');
const { emptyAccount } = await import('@/lib/user-restore/undo');
const { DEFAULT_PLAN_V2, planOf } = await import('@/lib/fire/plan-v2');
const { eventItems, itemFromEvent, itemFromIncome } = await import('@/lib/fire/items');
const { MAIN_ID, factsOf } = await import('@/lib/fire/copies');
const { typedAmounts } = await import('@/lib/fire/plan-currency');
const { genEvents, genPlan, rand } = await import('./plan-gen');
const planRoute = await import('@/app/api/fire-plan/route');
const plansRoute = await import('@/app/api/plans/route');
const savedRoute = await import('@/app/api/saved-plan/route');

beforeEach(async () => {
  fake.reset();
  (await import('@/lib/sessions')).forgetEpochs();
  await registerTestContainer(fake);
});

const ctx = TEST_CTX;
const income = itemFromIncome({ id: 'ss', label: 'Social Security', amount: 24_000, fromAge: 67, inflationAdjusted: true });
const child = itemFromEvent({ id: 'kid', kind: 'child', label: 'A child', fromAge: 42, yearly: 10_000, years: 18 });
const TYPED: FirePlanV2 = { ...DEFAULT_PLAN_V2, age: 40, targetAge: 55, spending: 40_000, items: [income] };
const DEFAULTS = factsOf(DEFAULT_PLAN_V2);

const req = (path: string, method: string, body: unknown) => new Request(`http://localhost/api/${path}`, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const call = async (handler: (r: Request) => Promise<Response>, path: string, method: string, body: unknown) => {
  const res = await handler(req(path, method, body));
  return { status: res.status, body: await res.json() };
};
const ok = <T extends { status: number; body: unknown }>(r: T): T['body'] => {
  expect([r.status, r.body]).toEqual([200, r.body]);
  return r.body;
};
const save = (plan: FirePlanV2, based_on: string | null, facts_were: unknown, currency: string | null = 'USD') => call(planRoute.PUT, 'fire-plan', 'PUT', { plan, currency, facts_were, based_on });
const plans = (method: 'POST' | 'PUT' | 'PATCH' | 'DELETE', body: unknown) => call(plansRoute[method], 'plans', method, body);

/** Every entry and the facts as C2's stores read their bytes: opened, then
 *  its upgrade and its checks. */
async function readAsC2() {
  const fields = (await fake.hgetall<Record<string, string>>(ctxKey('fire-plans'))) ?? {};
  const entries = new Map<string, PlanEntry>();
  const refused: string[] = [];
  for (const [id, stored] of Object.entries(fields)) {
    const opened = await openStored(ctx, stored);
    if (!opened.ok) throw new Error(`${id} can't be opened`);
    const value = oCopies.upgradePlanEntry(JSON.parse(opened.text));
    if (oCopies.isPlanEntry(value)) entries.set(id, value);
    else refused.push(id);
  }
  const rawFacts = await fake.get<string>(ctxKey('plan-facts'));
  let facts: unknown = null;
  if (rawFacts !== null) {
    const opened = await openStored(ctx, rawFacts);
    if (!opened.ok) throw new Error('the facts can’t be opened');
    facts = JSON.parse(opened.text);
  }
  return { entries, refused, facts };
}

/** C2 reads every plan there, with `main` as your plan; and what its GET
 *  /api/fire-plan answers from them is this release's answer. */
async function readsAll(main: string, what: string) {
  const { entries, refused, facts } = await readAsC2();
  expect([what, refused]).toEqual([what, []]);
  expect([what, oCopies.isPlanFacts(facts)]).toEqual([what, true]);
  const f = facts as PlanFacts;
  expect([what, oCopies.mainOf(f, { entries, unreadable: [], unrecognised: [] })]).toEqual([what, { id: main, missing: false }]);
  for (const [id, e] of entries) {
    expect([what, id, oPlanV2.isStoredPlan(e.plan)]).toEqual([what, id, true]);
    if (oCopies.holdsAmounts(e.plan)) expect([what, id, typeof e.currency]).toEqual([what, id, 'string']);
  }
  const mine = entries.get(main)!;
  const c2 = { id: main, plan: oCopies.withFacts(mine.plan, f), currency: oCopies.holdsAmounts(mine.plan) ? mine.currency : null, updated_at: mine.updatedAt };
  expect([what, await (await planRoute.GET()).json()]).toEqual([what, c2]);
  return entries;
}

describe('the release before reads every plan this release writes', () => {
  test('your plan’s first entry, made by a save, a New copy or a Try it, with the facts', async () => {
    const firsts: [string, () => Promise<unknown>][] = [
      ['a save', () => save({ ...TYPED, partnerAge: 38 }, null, DEFAULTS)],
      ['a save with nothing typed', () => save({ ...DEFAULT_PLAN_V2, age: 34 }, null, DEFAULTS, null)],
      ['a New copy', () => plans('POST', { from: MAIN_ID, name: 'Stop at 52', plan: { ...DEFAULT_PLAN_V2, targetAge: 52 }, currency: null })],
      ['a Try it', () => plans('POST', { from: MAIN_ID, name: 'A child', plan: { ...DEFAULT_PLAN_V2, items: [child] }, currency: 'EUR' })],
    ];
    for (const [what, first] of firsts) {
      fake.reset();
      await registerTestContainer(fake);
      expect([what, ((await first()) as { status: number }).status]).toEqual([what, 200]);
      await readsAll(MAIN_ID, what);
    }
  });

  test('a copy’s every change, an Also save over two plans, your plan’s currency, and a copy made your plan', async () => {
    const main = ok(await save(TYPED, null, DEFAULTS)).updated_at as string;
    const x = ok(await plans('POST', { from: MAIN_ID, name: 'Stop at 52', plan: { ...TYPED, targetAge: 52 }, currency: 'USD' })).plan;
    await readsAll(MAIN_ID, 'New copy');
    const kid = ok(await plans('POST', { from: MAIN_ID, name: 'A child', plan: { ...TYPED, items: [income, child] }, currency: 'USD' })).plan;
    await readsAll(MAIN_ID, 'Try it');
    const blank = ok(await plans('POST', { from: MAIN_ID, name: 'Blank', plan: DEFAULT_PLAN_V2, currency: null })).plan;
    await readsAll(MAIN_ID, 'a copy with nothing typed');

    const also = ok(
      await plans('PUT', {
        saves: [
          { id: MAIN_ID, plan: { ...TYPED, age: 41, spending: 41_000 }, currency: 'USD', based_on: main },
          { id: x.id, plan: { ...TYPED, age: 41, targetAge: 52, spending: 41_000 }, currency: 'USD', based_on: x.updated_at },
        ],
        facts_were: factsOf(TYPED),
      })
    );
    const entries = await readsAll(MAIN_ID, 'Also save');
    expect([entries.get(MAIN_ID)!.updatedAt, entries.get(x.id)!.updatedAt]).toEqual(also.plans.map((p: { updated_at: string }) => p.updated_at));

    const typed = ok(await plans('PUT', { saves: [{ id: blank.id, plan: { ...DEFAULT_PLAN_V2, age: 41, fiNumber: 1_200_000 }, currency: 'GBP', based_on: blank.updated_at }], facts_were: factsOf({ ...TYPED, age: 41 }) }));
    expect((await readsAll(MAIN_ID, 'first amounts in a copy')).get(blank.id)!.currency).toBe('GBP');

    const renamed = ok(await plans('PATCH', { id: x.id, name: 'Stop at 53', based_on: also.plans[1].updated_at })).plan;
    await readsAll(MAIN_ID, 'rename');
    const relabelled = ok(await plans('PATCH', { id: x.id, currency: 'EUR', based_on: renamed.updated_at })).plan;
    expect((await readsAll(MAIN_ID, 'relabel')).get(x.id)!.currency).toBe('EUR');
    ok(await plans('DELETE', { id: kid.id, based_on: kid.updated_at }));
    expect([...(await readsAll(MAIN_ID, 'delete')).keys()].sort()).toEqual([MAIN_ID, x.id, blank.id].sort());
    ok(await call(planRoute.POST, 'fire-plan', 'POST', { currency: 'CAD', amounts: typedAmounts({ ...TYPED, age: 41, spending: 41_000 }), answered: true }));
    expect((await readsAll(MAIN_ID, 'your plan’s currency')).get(MAIN_ID)!.currency).toBe('CAD');

    ok(await plans('PATCH', { main: x.id, based_on: relabelled.updated_at }));
    await readsAll(x.id, 'make main');
    ok(await plans('DELETE', { id: MAIN_ID, based_on: (await firePlansStore.get(ctx, MAIN_ID))!.updatedAt }));
    expect([...(await readsAll(x.id, 'the plan that was yours deleted')).keys()].sort()).toEqual([x.id, blank.id].sort());
    expect(typed.main.id).toBe(MAIN_ID);
  });

  test('your plan saved over and over, from generated plans of every shape version 2 holds', async () => {
    let based: string | null = null;
    let facts = DEFAULTS;
    let saved = 0;
    for (let seed = 9600; seed < 9680; seed++) {
      const g = rand(seed);
      const v2 = planOf(genPlan(g, seed % 3 === 0));
      const plan: FirePlanV2 = {
        ...v2,
        items: [...v2.items, ...eventItems(genEvents(g, `e${seed}-`).slice(0, 3))],
        partnerAge: g.chance(0.3) ? g.int(22, 70) : null,
        stopAtFi: g.chance(0.3),
        fiNumber: g.chance(0.2) ? g.int(500, 3000) * 1000 : null,
      };
      const r = await save(plan, based, facts, g.chance(0.5) ? 'USD' : null);
      if (r.status !== 200) {
        // What today's rules refuse, or first amounts with no currency: nothing written.
        expect([seed, r.status === 400 || r.body.error?.startsWith('Say which currency')]).toEqual([seed, true]);
        continue;
      }
      saved++;
      based = r.body.updated_at;
      facts = factsOf(r.body.plan);
      await readsAll(MAIN_ID, `seed ${seed}`);
    }
    expect(saved).toBeGreaterThan(30);
  });

  test('items of every kind on every anchor, the stop at FI and your own FI number', async () => {
    const mk = (id: string, kind: PlanItem['kind'], from: PlanItem['from'], set: Partial<PlanItem>): PlanItem => ({
      id,
      label: id,
      kind,
      from,
      until: null,
      once: null,
      yearly: null,
      replaces: null,
      every: null,
      times: null,
      inflationAdjusted: true,
      owner: null,
      beforeTax: false,
      ...set,
    });
    const at = (age: number) => ({ anchor: { at: 'age' as const, age }, offset: 0 });
    const items: PlanItem[] = [
      mk('ss', 'social-security', at(67), { yearly: 18_000, owner: 'partner', beforeTax: true }),
      mk('pension', 'pension', { anchor: { at: 'stop' }, offset: 5 }, { yearly: 12_000, inflationAdjusted: false, owner: 'you' }),
      mk('pt', 'part-time', { anchor: { at: 'stop' }, offset: 0 }, { until: at(60), yearly: 24_000, replaces: 0, beforeTax: true, owner: 'you' }),
      mk('other', 'other-income', { anchor: { at: 'fi' }, offset: 0 }, { until: { years: 10 }, yearly: 5_000 }),
      mk('home', 'home', at(45), { once: 100_000, yearly: -6_000 }),
      mk('kid', 'child', at(42), { until: { years: 18 }, yearly: 10_000 }),
      mk('car', 'car', { anchor: { at: 'fi' }, offset: -1 }, { once: 40_000, every: 8, times: 3 }),
      mk('travel', 'spending', { anchor: { at: 'balance', amount: 2_000_000 }, offset: 0 }, { yearly: 10_000 }),
      mk('loan', 'loan-end', { anchor: { at: 'item', id: 'home', edge: 'start' }, offset: 10 }, { yearly: 6_000 }),
      mk('job', 'pay', at(45), { until: { anchor: { at: 'item', id: 'pt', edge: 'start' }, offset: 0 }, yearly: -20_000, owner: 'you' }),
      mk('gift', 'windfall', at(60), { once: 50_000 }),
      mk('roof', 'one-off', { anchor: { at: 'stop' }, offset: 2 }, { once: 30_000 }),
    ];
    const plan: FirePlanV2 = { ...TYPED, partnerAge: 38, items };
    const main = ok(await save(plan, null, DEFAULTS)).updated_at as string;
    let entries = await readsAll(MAIN_ID, 'every kind');
    expect((entries.get(MAIN_ID)!.plan as FirePlanV2).items).toEqual(items);
    const facts = factsOf(plan);
    ok(await save({ ...plan, stopAtFi: true, fiNumber: 1_500_000 }, main, facts));
    entries = await readsAll(MAIN_ID, 'the stop at FI and your own FI number');
    const saved = entries.get(MAIN_ID)!.plan as FirePlanV2;
    expect([saved.stopAtFi, saved.fiNumber]).toEqual([true, 1_500_000]);
    ok(await plans('POST', { from: MAIN_ID, name: 'Part-time work when you stop', plan: { ...plan, items: items.slice(0, 3) }, currency: 'USD' }));
    await readsAll(MAIN_ID, 'a Try it with items on anchors');

    // C2's cards edit through its views, and keep every item they can't show.
    const v1 = { id: 'v1', label: 'Rent', amount: 9_000, fromAge: 70, inflationAdjusted: true };
    const kept = oItems.withIncome(oItems.withExpenses(oItems.withEvents(plan, oItems.eventsOf(plan)), oItems.expensesOf(plan)), [...oItems.incomeOf(plan), v1]);
    expect(kept.items.slice(0, items.length)).toEqual(items);
    expect(kept.items.length).toBe(items.length + 1);
  });

  test('a saved plan of version 2, as this release’s saved plan route stores it', async () => {
    for (const plan of [TYPED, { ...TYPED, stopAtFi: true, targetAge: null, items: [income, child] }, { ...DEFAULT_PLAN_V2, partnerAge: 38, fiNumber: 900_000 }]) {
      const body = { saved: { plan, savings: 20_000, currency: 'USD', inflation: 0.03 }, based_on: (await savedPlanStore.get(ctx))?.rev ?? null };
      expect((await call(savedRoute.PUT, 'saved-plan', 'PUT', body)).status).toBe(200);
      expect(oSaved.isSavedPlan(await savedPlanStore.get(ctx))).toBe(true);
    }
  });
});

describe('emptying an account', () => {
  test('takes both stores away, as every store', async () => {
    ok(await save(TYPED, null, DEFAULTS));
    ok(await plans('POST', { from: MAIN_ID, name: 'Stop at 52', plan: { ...TYPED, targetAge: 52 }, currency: 'USD' }));
    await emptyAccount(ctx, { userId: null });
    expect([await fake.type(ctxKey('fire-plans')), await fake.type(ctxKey('plan-facts'))]).toEqual(['none', 'none']);
    expect([await firePlansStore.count(ctx), await planFactsStore.get(ctx)]).toEqual([0, null]);
  });
});
