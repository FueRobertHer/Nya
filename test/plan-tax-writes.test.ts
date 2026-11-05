import { describe, expect, test, mock, beforeEach, afterEach } from 'bun:test';
import { FakeRedis, storageMock, TEST_CONTAINER, TEST_CTX, registerTestContainer, unscopedDataKeys } from './fake-redis';
import type { FirePlanV2 } from '@/lib/fire/plan-v2';
import type { PlanFacts } from '@/lib/fire/copies';
import type { TaxChoices } from '@/lib/fire/tax-choices';
import type { TaxHousehold } from '@/lib/fire/tax-facts';

// What only the detailed tax model writes, through the routes on FakeRedis: the
// opt-in, a plan's choices, the household, and a change of start to "at your stop
// age", each behind `plan-tax` on a fresh read. Going back to flat isn't.

process.env.PLAID_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');

const fake = new FakeRedis({ deserialize: true });
afterEach(() => expect(unscopedDataKeys(fake)).toEqual([]));
mock.module('@/lib/storage', () => storageMock(fake));

const { firePlansStore, planFactsStore } = await import('@/lib/plan-copies');
const { DEFAULT_PLAN_V2, NEW_PLAN_START } = await import('@/lib/fire/plan-v2');
const { MAIN_ID, factsOf } = await import('@/lib/fire/copies');
const { DEFAULT_TAX_CHOICES } = await import('@/lib/fire/tax-choices');
const { DEFAULT_TAX_FACTS, householdOf } = await import('@/lib/fire/tax-facts');
const { flagsStore } = await import('@/lib/flag-store');
const { HOUSEHOLD_NOT_SAVED, OTHER_DEVICE, TAX_OFF, saveMain } = await import('@/lib/plan-writes');
const planRoute = await import('@/app/api/fire-plan/route');
const plansRoute = await import('@/app/api/plans/route');
const factsRoute = await import('@/app/api/plan-facts/route');

const ctx = TEST_CTX;
const TYPED: FirePlanV2 = { ...DEFAULT_PLAN_V2, age: 40, targetAge: 55, spending: 40_000 };
const DEFAULTS = factsOf(DEFAULT_PLAN_V2);
const NO_ONE: TaxHousehold = householdOf(DEFAULT_TAX_FACTS);
const COUPLE: TaxHousehold = { filing: 'joint', birthYears: [{ owner: 'you', year: 1986 }], dependents: [{ id: 'd1', untilAge: 55 }], paidToday: { kind: 'category', name: 'Health' } };
const CHOICES: TaxChoices = { ...DEFAULT_TAX_CHOICES, state: 'CO', stateRate: 0.044, health: { ...DEFAULT_TAX_CHOICES.health, beforeMedicare: { kind: 'aca', adult: 11_000, quotedAge: 50, child: null } } };

const json = async (res: Response) => ({ status: res.status, body: await res.json() });
const req = (path: string, method: string, body?: unknown) => new Request(`http://localhost/api/${path}`, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const give = async (body: unknown) => json(await factsRoute.POST(req('plan-facts', 'POST', body)));
const put = async (body: unknown) => json(await planRoute.PUT(req('fire-plan', 'PUT', body)));
const save = (plan: FirePlanV2, based_on: string | null, over: Record<string, unknown> = {}, facts_were: unknown = factsOf(plan)) => put({ plan, currency: 'USD', facts_were, based_on, ...over });
const plans = async (method: 'POST' | 'PUT' | 'PATCH' | 'DELETE', body: unknown) => json(await plansRoute[method](req('plans', method, body)));
const quiet = async <T>(f: () => Promise<T>): Promise<T> => {
  const error = console.error;
  console.error = () => {};
  try {
    return await f();
  } finally {
    console.error = error;
  }
};

/** A store's write failing, as the tests of its route do it. */
const failing = async <T>(store: unknown, method: string, f: () => Promise<T>): Promise<T> => {
  const s = store as Record<string, unknown>;
  const real = s[method];
  s[method] = async () => {
    throw new Error('connection reset');
  };
  try {
    return await quiet(f);
  } finally {
    s[method] = real;
  }
};

const setFlag = (on: boolean) => flagsStore.update('plan-tax', async () => ({ on: 'nobody', containers: on ? [TEST_CONTAINER] : [], updatedAt: new Date().toISOString() }) as never, TEST_CONTAINER);
const factsNow = async () => (await planFactsStore.get(ctx)) as PlanFacts | null;
const taxNow = async () => {
  const f = await factsNow();
  if (f?.version !== 2) throw new Error('not version 2');
  return f.tax;
};
/** Your plan saved with the flag off, with its stamp. */
const saved = async () => {
  await setFlag(false);
  const r = await save(TYPED, null, {}, DEFAULTS);
  expect(r.status).toBe(200);
  return r.body.updated_at as string;
};

beforeEach(async () => {
  fake.reset();
  (await import('@/lib/sessions')).forgetEpochs();
  await registerTestContainer(fake);
  await setFlag(true);
});

describe('the opt-in', () => {
  test('flag off: refused in words, and nothing written', async () => {
    const stamp = await saved();
    const r = await give({ kind: 'opt-in' });
    expect(r).toEqual({ status: 403, body: { error: TAX_OFF } });
    expect((await firePlansStore.get(ctx, MAIN_ID))!.updatedAt).toBe(stamp);
    expect((await firePlansStore.get(ctx, MAIN_ID))!.tax).toBeNull();
    expect((await factsNow())!.version).toBe(1);
  });

  test('a flag that can’t be read refuses', async () => {
    await saved();
    const read = fake.hgetall.bind(fake);
    fake.hgetall = (async (key: string) => {
      if (key.includes('flag')) throw new Error('down');
      return read(key);
    }) as typeof fake.hgetall;
    try {
      const r = await quiet(() => give({ kind: 'opt-in' }));
      expect(r.status).toBe(403);
    } finally {
      fake.hgetall = read;
    }
  });

  test('from elsewhere: refused, and nothing written', async () => {
    const stamp = await saved();
    await setFlag(true);
    const res = await factsRoute.POST(new Request('http://localhost/api/plan-facts', { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://elsewhere.example' }, body: JSON.stringify({ kind: 'opt-in' }) }));
    expect(res.status).toBe(403);
    expect((await firePlansStore.get(ctx, MAIN_ID))!.updatedAt).toBe(stamp);
  });

  test('every plan takes the default choices where it has none, keeps its own where it has, and every stamp moves', async () => {
    const stamp = await saved();
    const copy = await plans('POST', { from: MAIN_ID, name: 'Stop at 52', plan: { ...TYPED, targetAge: 52 }, currency: 'USD' });
    const other = await plans('POST', { from: MAIN_ID, name: 'Stop at 60', plan: { ...TYPED, targetAge: 60 }, currency: 'USD' });
    const mine = (await firePlansStore.get(ctx, other.body.plan.id))!;
    await firePlansStore.set(ctx, other.body.plan.id, { ...mine, tax: CHOICES });
    await setFlag(true);

    const r = await give({ kind: 'opt-in' });
    expect(r.status).toBe(200);
    const main = (await firePlansStore.get(ctx, MAIN_ID))!;
    const a = (await firePlansStore.get(ctx, copy.body.plan.id))!;
    const b = (await firePlansStore.get(ctx, other.body.plan.id))!;
    expect([main.tax, a.tax, b.tax]).toEqual([DEFAULT_TAX_CHOICES, DEFAULT_TAX_CHOICES, CHOICES]);
    expect(main.updatedAt).not.toBe(stamp);
    expect(a.updatedAt).not.toBe(copy.body.plan.updated_at);
    expect(b.updatedAt).not.toBe(mine.updatedAt);
    expect(new Set([main.updatedAt, a.updatedAt, b.updatedAt]).size).toBe(3);
    expect((await taxNow()).model).toBe('detailed');
    expect(r.body).toMatchObject({ id: MAIN_ID, updated_at: main.updatedAt, tax: DEFAULT_TAX_CHOICES, tax_facts: { model: 'detailed' } });
    // A plan's money and shared facts didn't move.
    expect(main.plan).toEqual(TYPED);
    expect(main.currency).toBe('USD');
    expect(await factsNow()).toMatchObject(factsOf(TYPED));
  });

  test('with no plan saved: it makes your plan’s entry, at the start a new plan takes', async () => {
    const r = await give({ kind: 'opt-in' });
    expect(r.status).toBe(200);
    const main = (await firePlansStore.get(ctx, MAIN_ID))!;
    expect(main).toMatchObject({ name: 'First plan', tax: DEFAULT_TAX_CHOICES, currency: null, plan: { ...DEFAULT_PLAN_V2, start: NEW_PLAN_START } });
    expect((await taxNow()).model).toBe('detailed');
    expect(r.body).toMatchObject({ plan: { start: NEW_PLAN_START }, updated_at: main.updatedAt, tax: DEFAULT_TAX_CHOICES });
    // The default every older reader's plan rests on stays its own.
    expect(DEFAULT_PLAN_V2.start).toBe('fi-number');
  });

  test('facts failing after the plans: the model stays flat, and it answers a failure', async () => {
    await saved();
    await setFlag(true);
    const r = await failing(planFactsStore, 'update', () => give({ kind: 'opt-in' }));
    expect(r.status).toBeGreaterThanOrEqual(500);
    expect((await factsNow())!.version).toBe(1);
    // The plans moved, so the page loads them again; the next try ends it.
    expect((await firePlansStore.get(ctx, MAIN_ID))!.tax).toEqual(DEFAULT_TAX_CHOICES);
    expect((await give({ kind: 'opt-in' })).status).toBe(200);
    expect((await taxNow()).model).toBe('detailed');
  });

  test('back to flat keeps the choices, and is never gated', async () => {
    await saved();
    await setFlag(true);
    expect((await give({ kind: 'opt-in' })).status).toBe(200);
    await setFlag(false);
    const r = await give({ kind: 'model', model: 'flat' });
    expect(r.status).toBe(200);
    expect((await taxNow()).model).toBe('flat');
    expect((await firePlansStore.get(ctx, MAIN_ID))!.tax).toEqual(DEFAULT_TAX_CHOICES);
    expect(r.body).toMatchObject({ tax: DEFAULT_TAX_CHOICES, tax_facts: { model: 'flat' } });
  });
});

describe('a plan’s choices', () => {
  test('flag off: refused, and nothing written', async () => {
    const stamp = await saved();
    const r = await save({ ...TYPED, spending: 41_000 }, stamp, { tax: CHOICES });
    expect(r).toEqual({ status: 403, body: { error: TAX_OFF } });
    expect((await firePlansStore.get(ctx, MAIN_ID))!).toMatchObject({ tax: null, updatedAt: stamp, plan: TYPED });
  });

  test('flag off: a save that sends none goes through, and keeps those stored', async () => {
    const stamp = await saved();
    const entry = (await firePlansStore.get(ctx, MAIN_ID))!;
    await firePlansStore.set(ctx, MAIN_ID, { ...entry, tax: CHOICES });
    const r = await save({ ...TYPED, spending: 41_000 }, stamp);
    expect(r.status).toBe(200);
    expect((await firePlansStore.get(ctx, MAIN_ID))!.tax).toEqual(CHOICES);
  });

  test('on your plan’s save and on a copy’s, read back in the answers', async () => {
    const stamp = await saved();
    await setFlag(true);
    const r = await save(TYPED, stamp, { tax: CHOICES });
    expect(r.status).toBe(200);
    expect(r.body.tax).toEqual(CHOICES);
    expect((await firePlansStore.get(ctx, MAIN_ID))!.tax).toEqual(CHOICES);

    const copy = await plans('POST', { from: MAIN_ID, name: 'Stop at 52', plan: { ...TYPED, targetAge: 52 }, currency: 'USD' });
    expect(copy.body.plan.tax).toEqual(CHOICES);
    const theirs = { ...CHOICES, stateRate: 0.05 };
    const put2 = await plans('PUT', { saves: [{ id: copy.body.plan.id, plan: { ...TYPED, targetAge: 52 }, currency: 'USD', based_on: copy.body.plan.updated_at, tax: theirs }], facts_were: factsOf(TYPED) });
    expect(put2.status).toBe(200);
    expect((await firePlansStore.get(ctx, copy.body.plan.id))!.tax).toEqual(theirs);
    expect((await firePlansStore.get(ctx, MAIN_ID))!.tax).toEqual(CHOICES);
    const rows = (await json(await plansRoute.GET())).body.plans as { id: string; tax: unknown }[];
    expect(rows.find((x) => x.id === copy.body.plan.id)!.tax).toEqual(theirs);
  });

  test('what a writer may not send is refused, and a stale stamp too', async () => {
    const stamp = await saved();
    await setFlag(true);
    expect((await save(TYPED, stamp, { tax: { ...CHOICES, stateRate: 0.9 } })).status).toBe(400);
    expect((await save(TYPED, stamp, { tax: null })).status).toBe(400);
    expect((await save(TYPED, stamp, { tax: { ...CHOICES, strategy: { order: 'roth-before-deferred', conversions: { kind: 'none' }, convertUntil: null } } })).status).toBe(400);
    expect((await save(TYPED, 'not the stamp', { tax: CHOICES })).status).toBe(409);
    expect((await firePlansStore.get(ctx, MAIN_ID))!.tax).toBeNull();
  });

  test('a strategy stored by a later release isn’t a change, so a Health save goes through', async () => {
    const stamp = await saved();
    await setFlag(true);
    const entry = (await firePlansStore.get(ctx, MAIN_ID))!;
    const later = { ...CHOICES, strategy: { order: 'standard', conversions: { kind: 'bracket', top: 0.12 }, convertUntil: null } } as TaxChoices;
    await firePlansStore.set(ctx, MAIN_ID, { ...entry, tax: later });
    const r = await save(TYPED, stamp, { tax: { ...later, stateRate: 0.05 } });
    expect(r.status).toBe(200);
    expect((await firePlansStore.get(ctx, MAIN_ID))!.tax).toEqual({ ...later, stateRate: 0.05 });
  });

  test('a benchmark is an amount: a plan holding only that holds a currency', async () => {
    await setFlag(true);
    const blank = { ...DEFAULT_PLAN_V2, age: 40 };
    const first = await save(blank, null, { tax: CHOICES }, DEFAULTS);
    expect(first.status).toBe(200);
    expect((await firePlansStore.get(ctx, MAIN_ID))!.currency).toBe('USD');
    expect(first.body.currency).toBe('USD');
    // And one sending no currency for it has to say which, as for any amount.
    const fresh = await plans('POST', { from: MAIN_ID, name: 'Copy', plan: blank, currency: 'USD' });
    expect(fresh.body.plan.currency).toBe('USD');
    fake.reset();
    await registerTestContainer(fake);
    await setFlag(true);
    expect((await put({ plan: blank, currency: null, facts_were: DEFAULTS, based_on: null, tax: CHOICES })).status).toBe(409);
  });

  test('making a copy your plan: one with no choices keeps those it read', async () => {
    const stamp = await saved();
    await setFlag(true);
    expect((await save(TYPED, stamp, { tax: CHOICES })).status).toBe(200);
    const copy = await plans('POST', { from: MAIN_ID, name: 'Stop at 52', plan: { ...TYPED, targetAge: 52 }, currency: 'USD' });
    const entry = (await firePlansStore.get(ctx, copy.body.plan.id))!;
    await firePlansStore.set(ctx, copy.body.plan.id, { ...entry, tax: null });
    const made = await plans('PATCH', { main: copy.body.plan.id, based_on: entry.updatedAt });
    expect(made.status).toBe(200);
    expect((await firePlansStore.get(ctx, copy.body.plan.id))!.tax).toEqual(CHOICES);
  });
});

describe('the household', () => {
  test('flag off: refused, and nothing written', async () => {
    const stamp = await saved();
    const r = await save(TYPED, stamp, { household: COUPLE, household_were: NO_ONE });
    expect(r).toEqual({ status: 403, body: { error: TAX_OFF } });
    expect((await factsNow())!.version).toBe(1);
    expect((await firePlansStore.get(ctx, MAIN_ID))!.updatedAt).toBe(stamp);
  });

  test('goes with the facts, one save with the plan and its choices', async () => {
    const stamp = await saved();
    await setFlag(true);
    const r = await save({ ...TYPED, spending: 41_000 }, stamp, { tax: CHOICES, household: COUPLE, household_were: NO_ONE });
    expect(r.status).toBe(200);
    expect(householdOf(await taxNow())).toEqual(COUPLE);
    expect((await firePlansStore.get(ctx, MAIN_ID))!).toMatchObject({ tax: CHOICES, plan: { spending: 41_000 } });
    expect(r.body).toMatchObject({ tax: CHOICES, tax_facts: COUPLE });
  });

  test('keeps the other tax facts, and an age changed with it', async () => {
    const stamp = await saved();
    await setFlag(true);
    expect((await give({ kind: 'roth', owner: 'you', amount: 45_000 })).status).toBe(200);
    const r = await save({ ...TYPED, age: 41 }, stamp, { household: COUPLE, household_were: NO_ONE }, factsOf(TYPED));
    expect(r.status).toBe(200);
    expect((await taxNow()).rothContributions).toEqual([{ owner: 'you', amount: 45_000 }]);
    expect(await factsNow()).toMatchObject({ age: 41 });
    expect(householdOf(await taxNow())).toEqual(COUPLE);
  });

  test('changed since the page loaded it: refused as stale, and nothing written', async () => {
    const stamp = await saved();
    await setFlag(true);
    const r = await save({ ...TYPED, spending: 41_000 }, stamp, { household: COUPLE, household_were: { ...NO_ONE, filing: 'single' } });
    expect(r).toEqual({ status: 409, body: { error: OTHER_DEVICE, stale: true } });
    expect((await firePlansStore.get(ctx, MAIN_ID))!).toMatchObject({ updatedAt: stamp, plan: TYPED });
    expect((await factsNow())!.version).toBe(1);
  });

  test('what isn’t a household is refused', async () => {
    const stamp = await saved();
    await setFlag(true);
    expect((await save(TYPED, stamp, { household: { ...COUPLE, filing: 'married' }, household_were: NO_ONE })).status).toBe(400);
    expect((await save(TYPED, stamp, { household: COUPLE })).status).toBe(400);
    expect((await save(TYPED, stamp, { household_were: NO_ONE })).status).toBe(400);
  });

  test('saved, the rest failing: says the household landed', async () => {
    const stamp = await saved();
    await setFlag(true);
    const r = await failing(firePlansStore, 'updateMany', () => save(TYPED, stamp, { household: COUPLE, household_were: NO_ONE }));
    expect(r).toEqual({ status: 409, body: { error: 'Your household was saved; the rest wasn’t: try again', stale: true } });
    expect(householdOf(await taxNow())).toEqual(COUPLE);
  });

  describe('on your plan’s first save', () => {
    test('written with the first facts, version 2 at once', async () => {
      const r = await save(TYPED, null, { household: COUPLE, household_were: NO_ONE }, DEFAULTS);
      expect(r.status).toBe(200);
      expect(await factsNow()).toMatchObject({ version: 2, ...factsOf(TYPED), main: MAIN_ID });
      expect(householdOf(await taxNow())).toEqual(COUPLE);
      expect(r.body.tax_facts).toMatchObject(COUPLE);
    });

    test('over tax facts given before any plan, keeping them', async () => {
      expect((await give({ kind: 'roth', owner: 'you', amount: 45_000 })).status).toBe(200);
      const r = await save(TYPED, null, { household: COUPLE, household_were: NO_ONE }, DEFAULTS);
      expect(r.status).toBe(200);
      expect((await taxNow()).rothContributions).toEqual([{ owner: 'you', amount: 45_000 }]);
      expect(householdOf(await taxNow())).toEqual(COUPLE);
    });

    test('with the facts failing: never a silent answer', async () => {
      const r = await failing(planFactsStore, 'update', () => save(TYPED, null, { household: COUPLE, household_were: NO_ONE }, DEFAULTS));
      expect(r).toEqual({ status: 409, body: { error: HOUSEHOLD_NOT_SAVED, stale: true } });
      expect((await firePlansStore.get(ctx, MAIN_ID))!.plan).toEqual(TYPED);
    });

    test('with another device’s kept: never a silent answer', async () => {
      // A save from the new entry meanwhile: `afterFirst` keeps what it wrote.
      const facts = planFactsStore as unknown as Record<string, unknown>;
      const real = facts.update;
      facts.update = async () => ({ version: 2, main: MAIN_ID, ...factsOf(TYPED), tax: DEFAULT_TAX_FACTS });
      try {
        const r = await save(TYPED, null, { household: COUPLE, household_were: NO_ONE }, DEFAULTS);
        expect(r).toEqual({ status: 409, body: { error: HOUSEHOLD_NOT_SAVED, stale: true } });
      } finally {
        facts.update = real;
      }
    });
  });

  test('the demo seed writes through, whatever the flag says', async () => {
    await setFlag(false);
    const main = await saveMain(ctx, TYPED, 'USD', DEFAULTS, null, { tax: CHOICES, household: { to: COUPLE, were: NO_ONE }, gated: false });
    expect(main.entry.tax).toEqual(CHOICES);
    expect(householdOf(await taxNow())).toEqual(COUPLE);
  });
});

describe('at your stop age', () => {
  const AT: FirePlanV2 = { ...TYPED, start: 'at-stop' };

  test('flag off: a change to it is refused, on a save and on a new copy', async () => {
    const stamp = await saved();
    expect(await save(AT, stamp)).toEqual({ status: 403, body: { error: TAX_OFF } });
    expect(await plans('POST', { from: MAIN_ID, name: 'At stop', plan: AT, currency: 'USD' })).toEqual({ status: 403, body: { error: TAX_OFF } });
    expect((await firePlansStore.get(ctx, MAIN_ID))!.plan.start).not.toBe('at-stop');
  });

  test('flag on: it saves', async () => {
    const stamp = await saved();
    await setFlag(true);
    expect((await save(AT, stamp)).status).toBe(200);
    expect((await firePlansStore.get(ctx, MAIN_ID))!.plan.start).toBe('at-stop');
  });

  test('flag off: a plan already there isn’t trapped, and Duplicate works', async () => {
    const stamp = await saved();
    await setFlag(true);
    const r = await save(AT, stamp);
    await setFlag(false);
    const again = await save({ ...AT, spending: 41_000 }, r.body.updated_at);
    expect(again.status).toBe(200);
    expect((await plans('POST', { from: MAIN_ID, name: 'Copy', plan: { ...AT, spending: 41_000 }, currency: 'USD' })).status).toBe(200);
    expect((await save({ ...TYPED, spending: 41_000 }, again.body.updated_at)).status).toBe(200);
  });

  test('a new copy of a plan never saved: your plan takes the start a new plan takes, flagged', async () => {
    const r = await plans('POST', { from: MAIN_ID, name: 'Mine', plan: { ...DEFAULT_PLAN_V2, start: NEW_PLAN_START }, currency: null });
    expect(r.status).toBe(200);
    expect((await firePlansStore.get(ctx, MAIN_ID))!.plan.start).toBe(NEW_PLAN_START);
  });

  test('flag off, a new copy of a plan never saved: your plan stays on the default', async () => {
    await setFlag(false);
    const r = await plans('POST', { from: MAIN_ID, name: 'Mine', plan: { ...DEFAULT_PLAN_V2 }, currency: null });
    expect(r.status).toBe(200);
    expect((await firePlansStore.get(ctx, MAIN_ID))!.plan.start).toBe(DEFAULT_PLAN_V2.start);
  });
});
