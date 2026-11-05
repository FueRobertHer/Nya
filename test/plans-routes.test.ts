import { describe, expect, test, mock, beforeEach, afterEach, setSystemTime } from 'bun:test';
import { FakeRedis, storageMock, TEST_CTX, ctxKey, registerTestContainer, unscopedDataKeys } from './fake-redis';
import type { FirePlanV2 } from '@/lib/fire/plan-v2';
import type { Facts, PlanEntry, PlanFacts } from '@/lib/fire/copies';
import type { TaxFacts } from '@/lib/fire/tax-facts';

// Plans as copies, written (lib/plan-writes.ts), through the routes on
// FakeRedis: GET, PUT and POST /api/fire-plan for your plan, and
// /api/plans for every plan. Your plan's first entry made by whichever write
// comes first (a save, a New copy, Try it, a rename), then `plan-facts`; two
// first writes at once; stamps no two
// entries share; the facts written first, several entries all or none; each
// change of a copy at the stamp the page loaded; the limit and the names;
// the currency a copy takes; entries that can't be read, or a newer version
// saved, beside the ones written; a page from before copies; and `plan-facts`
// missing.

process.env.PLAID_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');

const fake = new FakeRedis({ deserialize: true });
afterEach(() => expect(unscopedDataKeys(fake)).toEqual([]));
mock.module('@/lib/storage', () => storageMock(fake));

const { encrypt } = await import('@/lib/crypto');
const { firePlansStore, planFactsStore } = await import('@/lib/plan-copies');
const { DEFAULT_PLAN } = await import('@/lib/fire/plan');
const { DEFAULT_PLAN_V2 } = await import('@/lib/fire/plan-v2');
const { itemFromIncome } = await import('@/lib/fire/items');
const { itemFromEvent } = await import('./plan-gen');
const { MAIN_ID, MAX_FIRE_PLANS, factsOf } = await import('@/lib/fire/copies');
const { DEFAULT_TAX_FACTS } = await import('@/lib/fire/tax-facts');
const { typedAmounts } = await import('@/lib/fire/plan-currency');
const { AT_MOST, CHANGED, FIRST_CURRENCY, KEEP_MAIN, NAME_TAKEN, NOTHING_TYPED, OTHER_DEVICE, STALE_CURRENCY, factsWere } = await import('@/lib/plan-writes');
const planRoute = await import('@/app/api/fire-plan/route');
const plansRoute = await import('@/app/api/plans/route');

beforeEach(async () => {
  fake.reset();
  (await import('@/lib/sessions')).forgetEpochs();
  await registerTestContainer(fake);
});
afterEach(() => setSystemTime());

const ctx = TEST_CTX;
const PARTIAL = 'Your age was saved; the rest wasn’t: try again';
const NO_PLAN = { id: MAIN_ID, plan: null, currency: null, updated_at: null };

const income = itemFromIncome({ id: 'ss', label: 'Social Security', amount: 24_000, fromAge: 67, inflationAdjusted: true });
const child = itemFromEvent({ id: 'kid', kind: 'child', label: 'A child', fromAge: 42, yearly: 10_000, years: 18 });
const TYPED: FirePlanV2 = { ...DEFAULT_PLAN_V2, age: 40, targetAge: 55, spending: 40_000, items: [income] };
const DEFAULTS = factsOf(DEFAULT_PLAN_V2);

const json = async (res: Response) => ({ status: res.status, body: await res.json() });
const req = (path: string, method: string, body?: unknown) =>
  new Request(`http://localhost/api/${path}`, { method, ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }) });
const get = async () => json(await planRoute.GET());
const put = async (body: unknown) => json(await planRoute.PUT(req('fire-plan', 'PUT', body)));
const post = async (body: unknown) => json(await planRoute.POST(req('fire-plan', 'POST', body)));
const list = async () => json(await plansRoute.GET());
const plans = async (method: 'POST' | 'PUT' | 'PATCH' | 'DELETE', body: unknown) => json(await plansRoute[method](req('plans', method, body)));

/** Your plan's save as a page sends it: the facts it loaded and its stamp. */
const save = (plan: FirePlanV2, based_on: string | null, over: { currency?: string | null; facts_were?: unknown } = {}) =>
  put({ plan, currency: over.currency === undefined ? 'USD' : over.currency, facts_were: over.facts_were ?? factsOf(plan), based_on });

/** Your plan saved first (TYPED, in USD), and its stamp. */
async function yours(plan: FirePlanV2 = TYPED): Promise<string> {
  const r = await save(plan, null, { facts_were: DEFAULTS });
  expect(r.status).toBe(200);
  return r.body.updated_at;
}

/** A copy made from `from`, as New copy, Duplicate and Try it make one. */
async function copy(name: string, plan: FirePlanV2, currency: string | null = null, from: string = MAIN_ID) {
  const r = await plans('POST', { from, name, plan, currency });
  expect([name, r.status]).toEqual([name, 200]);
  return r.body.plan as { id: string; name: string; plan: FirePlanV2; currency: string | null; created_at: string; updated_at: string };
}

const quiet = async <T>(f: () => Promise<T>): Promise<T> => {
  const error = console.error;
  console.error = () => {};
  try {
    return await f();
  } finally {
    console.error = error;
  }
};

/** Bytes that are no ciphertext: a damaged value. */
const DAMAGED = 'damaged-bytes-not-ciphertext-at-all';
const damageEntry = (id: string) => fake.hset(ctxKey('fire-plans'), { [id]: DAMAGED });
/** An entry a newer release wrote (its tax choices, from T2). */
const newerEntry = async (id: string, e: PlanEntry) => fake.hset(ctxKey('fire-plans'), { [id]: await encrypt(ctx, JSON.stringify({ ...e, tax: { filing: 'single' } })) });
/** Each entry's stored bytes, and the facts', to hold a refusal to "nothing written". */
const raw = async () => ({ plans: await fake.hgetall<Record<string, string>>(ctxKey('fire-plans')), facts: await fake.get(ctxKey('plan-facts')) });
const stored = async (id: string) => (await firePlansStore.get(ctx, id))!;

/** Runs `first` just before the store's next call of `method`, as another
 *  device's write landing between this write's read and its own. */
function before(store: object, method: string, first: () => Promise<unknown>) {
  const s = store as Record<string, (...a: unknown[]) => Promise<unknown>>;
  const real = s[method];
  s[method] = async (...args: unknown[]) => {
    s[method] = real;
    await first();
    return real.apply(store, args);
  };
}

/** The order of the writes after a first entry, each named as it lands (the
 *  entries, the facts), for every test of the describe it is called in. */
function watchOrder(): string[] {
  const order: string[] = [];
  const watched: [object, string, string][] = [
    [firePlansStore, 'updateMany', 'entries'],
    [planFactsStore, 'update', 'facts'],
  ];
  const reals = new Map<string, (...a: unknown[]) => Promise<unknown>>();
  beforeEach(() => {
    order.splice(0);
    for (const [store, method, name] of watched) {
      const s = store as Record<string, (...a: unknown[]) => Promise<unknown>>;
      const real = s[method];
      reals.set(`${(store as { name: string }).name}.${method}`, real);
      s[method] = async (...args: unknown[]) => {
        const r = await real.apply(store, args);
        order.push(name);
        return r;
      };
    }
  });
  afterEach(() => {
    for (const [store, method] of watched) (store as Record<string, unknown>)[method] = reals.get(`${(store as { name: string }).name}.${method}`);
  });
  return order;
}

describe('your plan’s first entry', () => {
  const order = watchOrder();

  test('before it, your plan is the defaults', async () => {
    expect(await get()).toEqual({ status: 200, body: NO_PLAN });
    expect((await list()).body).toEqual({
      main: MAIN_ID,
      missing: false,
      plans: [{ id: MAIN_ID, name: 'First plan', plan: null, currency: null, created_at: null, updated_at: null }],
      unreadable_ids: [],
      unrecognised_ids: [],
    });
  });

  test('a save makes it, "First plan", then the facts', async () => {
    const r = await save({ ...TYPED, age: 41 }, null, { facts_were: DEFAULTS });
    expect(r.status).toBe(200);
    const entry = await stored(MAIN_ID);
    expect(entry).toEqual({ name: 'First plan', plan: { ...TYPED, age: 41 }, tax: null, currency: 'USD', createdAt: entry.createdAt, updatedAt: entry.updatedAt });
    expect(r.body).toEqual({ id: MAIN_ID, plan: { ...TYPED, age: 41 }, currency: 'USD', updated_at: entry.updatedAt });
    expect(await planFactsStore.get(ctx)).toEqual({ version: 1, main: MAIN_ID, ...factsOf({ ...TYPED, age: 41 }) });
    expect(order).toEqual(['entries', 'facts']);
    expect(await get()).toEqual({ status: 200, body: r.body });
  });

  test('a New copy makes it beside the copy, your plan the defaults, then the facts', async () => {
    const made = await copy('Stop at 52', { ...DEFAULT_PLAN_V2, targetAge: 52 });
    expect(order).toEqual(['entries', 'facts']);
    expect((await firePlansStore.ids(ctx)).sort()).toEqual([MAIN_ID, made.id].sort());
    const main = await stored(MAIN_ID);
    expect(main).toEqual({ name: 'First plan', plan: DEFAULT_PLAN_V2, tax: null, currency: null, createdAt: main.createdAt, updatedAt: main.updatedAt });
    expect(await stored(made.id)).toEqual({ name: 'Stop at 52', plan: { ...DEFAULT_PLAN_V2, targetAge: 52 }, tax: null, currency: null, createdAt: made.created_at, updatedAt: made.updated_at });
    expect(main.updatedAt).not.toBe(made.updated_at);
    expect(await planFactsStore.get(ctx)).toEqual({ version: 1, main: MAIN_ID, ...DEFAULTS });
    // Your plan is saved now: it has a stamp.
    expect((await get()).body).toEqual({ id: MAIN_ID, plan: DEFAULT_PLAN_V2, currency: null, updated_at: main.updatedAt });
  });

  test('Try it makes it too: the copy holds the event, in the currency sent, your plan the defaults with none', async () => {
    // No currency for the event's first amounts: refused, nothing written.
    expect(await plans('POST', { from: MAIN_ID, name: 'A child', plan: { ...DEFAULT_PLAN_V2, items: [child] }, currency: null })).toEqual({ status: 409, body: { error: FIRST_CURRENCY } });
    expect([await fake.type(ctxKey('fire-plans')), await fake.type(ctxKey('plan-facts'))]).toEqual(['none', 'none']);
    const made = await copy('A child', { ...DEFAULT_PLAN_V2, items: [child] }, 'EUR');
    expect(made.currency).toBe('EUR');
    expect(((await stored(made.id)).plan as FirePlanV2).items).toEqual([child]);
    expect((await stored(MAIN_ID)).currency).toBeNull();
    expect(order).toEqual(['entries', 'facts']);
  });

  test('a rename of your plan before it is saved makes it, under that name', async () => {
    const r = await plans('PATCH', { id: MAIN_ID, name: 'Base', based_on: null });
    expect(r.status).toBe(200);
    expect(await stored(MAIN_ID)).toMatchObject({ name: 'Base', plan: DEFAULT_PLAN_V2 });
    expect(await planFactsStore.get(ctx)).toEqual({ version: 1, main: MAIN_ID, ...DEFAULTS });
  });

  test('a leftover facts value, damaged or not, is replaced by the first entry’s', async () => {
    await planFactsStore.set(ctx, { version: 1, main: 'gone', ...factsOf({ ...TYPED, age: 70 }) });
    await yours();
    expect(await planFactsStore.get(ctx)).toEqual({ version: 1, main: MAIN_ID, ...factsOf(TYPED) });
    fake.reset();
    await registerTestContainer(fake);
    await fake.set(ctxKey('plan-facts'), DAMAGED);
    await yours();
    expect(await planFactsStore.get(ctx)).toEqual({ version: 1, main: MAIN_ID, ...factsOf(TYPED) });
  });

  test('the facts not written after it: the save stands, the entry’s own fields are the facts, and the next change makes them', async () => {
    const facts = planFactsStore as unknown as Record<string, unknown>;
    const real = facts.update;
    facts.update = async () => {
      throw new Error('connection reset');
    };
    try {
      expect((await quiet(() => save(TYPED, null, { facts_were: DEFAULTS }))).status).toBe(200);
    } finally {
      facts.update = real;
    }
    expect(await planFactsStore.get(ctx)).toBeNull();
    const read = await get();
    expect(read.body.plan).toEqual(TYPED);
    const next = await save({ ...TYPED, age: 41 }, read.body.updated_at, { facts_were: factsOf(TYPED) });
    expect(next.status).toBe(200);
    expect(await planFactsStore.get(ctx)).toEqual({ version: 1, main: MAIN_ID, ...factsOf({ ...TYPED, age: 41 }) });
  });
});

describe('two first writes at once', () => {
  test('the second to land finds your plan’s entry and is refused at its stamp: one entry, the first’s facts', async () => {
    before(firePlansStore, 'updateMany', () => save({ ...TYPED, age: 50 }, null, { facts_were: DEFAULTS }));
    expect(await save({ ...TYPED, age: 41 }, null, { facts_were: DEFAULTS })).toEqual({ status: 409, body: { error: CHANGED, stale: true } });
    expect(await firePlansStore.ids(ctx)).toEqual([MAIN_ID]);
    expect((await stored(MAIN_ID)).plan.age).toBe(50);
    expect((await planFactsStore.get(ctx))!.age).toBe(50);
  });

  test('a Try it beside a save: the copy isn’t made over your plan made meanwhile', async () => {
    before(firePlansStore, 'updateMany', () => save({ ...TYPED, age: 50 }, null, { facts_were: DEFAULTS }));
    expect(await plans('POST', { from: MAIN_ID, name: 'A child', plan: { ...DEFAULT_PLAN_V2, items: [child] }, currency: 'USD' })).toEqual({ status: 409, body: { error: CHANGED, stale: true } });
    expect(await firePlansStore.ids(ctx)).toEqual([MAIN_ID]);
    expect((await planFactsStore.get(ctx))!.age).toBe(50);
  });

  test('a save beside a New copy: refused, the copy and your plan as it made them', async () => {
    before(firePlansStore, 'updateMany', () => plans('POST', { from: MAIN_ID, name: 'Stop at 52', plan: { ...DEFAULT_PLAN_V2, targetAge: 52 }, currency: null }));
    expect((await save(TYPED, null, { facts_were: DEFAULTS })).status).toBe(409);
    expect(await firePlansStore.count(ctx)).toBe(2);
    expect((await stored(MAIN_ID)).plan).toEqual(DEFAULT_PLAN_V2);
  });
});

describe('the facts after a first entry', () => {
  test('never written over a save another device made from that entry meanwhile', async () => {
    // Between this first save's entry and its facts, another device loads
    // your plan and saves a new age.
    before(planFactsStore, 'update', async () => {
      const loaded = (await get()).body;
      expect((await save({ ...loaded.plan, age: 41 }, loaded.updated_at, { facts_were: factsOf(loaded.plan) })).status).toBe(200);
    });
    expect((await save(TYPED, null, { facts_were: DEFAULTS })).status).toBe(200);
    expect((await planFactsStore.get(ctx))!.age).toBe(41);
    expect((await get()).body.plan.age).toBe(41);
  });
});

// `plan-facts` version 2, as a newer release writes it. This release writes
// only version 1, and never a lower version than it read: after a rollback, an
// age saved here keeps the tax facts.
describe('facts of version 2, written by a newer release', () => {
  const TAX: TaxFacts = { ...DEFAULT_TAX_FACTS, countAnyway: ['acc_529'], owners: [{ account_id: 'acc_1', owner: 'partner' }], rothContributions: [{ owner: 'you', amount: 45_000 }] };
  const v2Facts = (facts: Facts, main: string = MAIN_ID): PlanFacts => ({ version: 2, main, ...facts, tax: TAX });

  describe('with your plan there', () => {
    let at: string;
    beforeEach(async () => {
      at = await yours();
      await planFactsStore.set(ctx, v2Facts(factsOf(TYPED)));
    });
    const kept = async (facts: Facts, main: string = MAIN_ID) => expect(await planFactsStore.get(ctx)).toEqual(v2Facts(facts, main));

    test('read: the plans answer as ever, with the facts in their fields', async () => {
      const read = await get();
      expect([read.status, read.body.plan]).toEqual([200, TYPED]);
      expect((await list()).status).toBe(200);
    });

    test('a saved age keeps them', async () => {
      const older = { ...TYPED, age: 41 };
      expect((await save(older, at, { facts_were: factsOf(TYPED) })).status).toBe(200);
      await kept(factsOf(older));
      expect((await stored(MAIN_ID)).plan.age).toBe(41);
    });

    test('a save that changes no fact leaves them as they are', async () => {
      const was = await fake.get<string>(ctxKey('plan-facts'));
      expect((await save({ ...TYPED, spending: 41_000 }, at)).status).toBe(200);
      expect(await fake.get<string>(ctxKey('plan-facts'))).toBe(was);
    });

    test('an Also save, over two plans with a new age, keeps them', async () => {
      const made = await copy('Stop at 52', { ...TYPED, targetAge: 52 }, 'USD');
      const older = { ...TYPED, age: 41 };
      const r = await plans('PUT', {
        saves: [
          { id: MAIN_ID, plan: older, currency: 'USD', based_on: at },
          { id: made.id, plan: { ...older, targetAge: 52 }, currency: 'USD', based_on: made.updated_at },
        ],
        facts_were: factsOf(TYPED),
      });
      expect(r.status).toBe(200);
      await kept(factsOf(older));
    });

    test('New copy, rename, its currency, delete and your plan’s currency keep them', async () => {
      const made = await copy('Stop at 52', { ...TYPED, targetAge: 52 }, 'USD');
      await kept(factsOf(TYPED));
      const renamed = await plans('PATCH', { id: made.id, name: 'Stop at 53', based_on: made.updated_at });
      expect(renamed.status).toBe(200);
      await kept(factsOf(TYPED));
      const relabelled = await plans('PATCH', { id: made.id, currency: 'EUR', based_on: renamed.body.plan.updated_at });
      expect(relabelled.status).toBe(200);
      await kept(factsOf(TYPED));
      expect((await plans('DELETE', { id: made.id, based_on: relabelled.body.plan.updated_at })).status).toBe(200);
      await kept(factsOf(TYPED));
      expect((await post({ currency: 'CAD', amounts: typedAmounts(TYPED), answered: true })).status).toBe(200);
      await kept(factsOf(TYPED));
    });

    test('make this your plan keeps them, naming the new one', async () => {
      const made = await copy('Stop at 52', { ...TYPED, targetAge: 52 }, 'USD');
      const r = await plans('PATCH', { main: made.id, based_on: made.updated_at });
      expect(r.status).toBe(200);
      await kept(factsOf(TYPED), made.id);
    });

    test('a body can’t pose as them: facts sent as a page’s are the five a plan holds, and nothing more', async () => {
      const sent = { ...factsOf(TYPED), version: 2, main: 'other', tax: TAX };
      expect((await save({ ...TYPED, age: 41 }, at, { facts_were: sent })).status).toBe(400);
      expect(factsWere(sent)).toBeNull();
      expect(factsWere({ ...factsOf(TYPED), tax: TAX })).toBeNull();
      expect(factsWere(factsOf(TYPED))).toEqual(factsOf(TYPED));
    });
  });

  describe('alone, with no plan there', () => {
    const ALONE: PlanFacts = { version: 2, main: MAIN_ID, ...DEFAULTS, tax: TAX };
    beforeEach(() => planFactsStore.set(ctx, ALONE));

    test('your plan stays new: the defaults, and nothing made by reading', async () => {
      expect(await get()).toEqual({ status: 200, body: NO_PLAN });
      expect(await firePlansStore.count(ctx)).toBe(0);
      expect(await planFactsStore.get(ctx)).toEqual(ALONE);
    });

    test('your plan’s first save is taken, and keeps them under its own facts', async () => {
      expect((await save(TYPED, null, { facts_were: DEFAULTS })).status).toBe(200);
      expect(await planFactsStore.get(ctx)).toEqual(v2Facts(factsOf(TYPED)));
      expect((await get()).body.plan).toEqual(TYPED);
    });

    test('so is a New copy', async () => {
      const made = await copy('Stop at 52', { ...DEFAULT_PLAN_V2, targetAge: 52 });
      expect(made.plan.targetAge).toBe(52);
      expect(await planFactsStore.get(ctx)).toEqual(ALONE);
    });

    test('a leftover naming a plan that’s gone is put right, the tax facts kept', async () => {
      await planFactsStore.set(ctx, { ...ALONE, main: 'gone', age: 70 });
      await yours();
      expect(await planFactsStore.get(ctx)).toEqual(v2Facts(factsOf(TYPED)));
    });
  });

  describe('written between a first save’s read and its facts', () => {
    const withTax = (facts: Facts): PlanFacts => ({ version: 2, main: MAIN_ID, ...facts, tax: TAX });

    test('over nothing: this save’s facts stand, never the defaults the tax facts came with', async () => {
      before(planFactsStore, 'update', () => planFactsStore.set(ctx, withTax(DEFAULTS)));
      expect((await save(TYPED, null, { facts_were: DEFAULTS })).status).toBe(200);
      expect(await planFactsStore.get(ctx)).toEqual(withTax(factsOf(TYPED)));
      expect((await get()).body.plan).toEqual(TYPED);
    });

    test('over a leftover: the same', async () => {
      await planFactsStore.set(ctx, { version: 1, main: MAIN_ID, ...DEFAULTS });
      before(planFactsStore, 'update', () => planFactsStore.set(ctx, withTax(DEFAULTS)));
      expect((await save(TYPED, null, { facts_were: DEFAULTS })).status).toBe(200);
      expect(await planFactsStore.get(ctx)).toEqual(withTax(factsOf(TYPED)));
    });

    test('a save another device made from the new entry meanwhile still stands, tax facts and all', async () => {
      await planFactsStore.set(ctx, withTax(DEFAULTS));
      before(planFactsStore, 'update', async () => {
        const loaded = (await get()).body;
        expect((await save({ ...loaded.plan, age: 41 }, loaded.updated_at, { facts_were: factsOf(loaded.plan) })).status).toBe(200);
      });
      expect((await save(TYPED, null, { facts_were: DEFAULTS })).status).toBe(200);
      expect(await planFactsStore.get(ctx)).toEqual(withTax(factsOf({ ...TYPED, age: 41 })));
    });
  });

  test('facts of a version newer still are refused: nothing written over them', async () => {
    await yours();
    await fake.set(ctxKey('plan-facts'), await encrypt(ctx, JSON.stringify({ version: 3, main: MAIN_ID, ...factsOf(TYPED), tax: TAX })));
    const was = await raw();
    expect((await quiet(get)).status).toBe(409);
    expect((await quiet(() => save({ ...TYPED, age: 41 }, null))).status).toBe(409);
    expect(await raw()).toEqual(was);
  });
});

describe('a fresh account’s first age, then a second save', () => {
  test('the age saved first is every plan’s, and the next save, made from its answer, is taken and keeps it', async () => {
    const first = await save({ ...DEFAULT_PLAN_V2, age: 34 }, null, { currency: null, facts_were: DEFAULTS });
    expect(first.status).toBe(200);
    expect((await planFactsStore.get(ctx))!.age).toBe(34);
    const second = await save({ ...first.body.plan, spending: 45_000 }, first.body.updated_at, { facts_were: factsOf(first.body.plan) });
    expect(second.status).toBe(200);
    expect(second.body.plan).toEqual({ ...DEFAULT_PLAN_V2, age: 34, spending: 45_000 });
    expect(second.body.updated_at > first.body.updated_at).toBe(true);
    expect((await planFactsStore.get(ctx))!.age).toBe(34);
    // A page still holding no stamp, or the facts before the first: refused.
    expect(await save({ ...first.body.plan, spending: 46_000 }, null)).toEqual({ status: 409, body: { error: CHANGED, stale: true } });
    expect(await save({ ...DEFAULT_PLAN_V2, age: 35 }, second.body.updated_at, { currency: null, facts_were: DEFAULTS })).toEqual({ status: 409, body: { error: OTHER_DEVICE, stale: true } });
    expect((await stored(MAIN_ID)).plan.spending).toBe(45_000);
  });
});

describe('stamps', () => {
  test('no two entries share one: an Also save over your plan and a copy, in one millisecond', async () => {
    setSystemTime(new Date('2026-11-04T12:00:00.000Z'));
    const main = await yours();
    const x = await copy('Stop at 52', { ...TYPED, targetAge: 52 });
    expect(x.updated_at).not.toBe(main);
    const r = await plans('PUT', {
      saves: [
        { id: MAIN_ID, plan: { ...TYPED, spending: 41_000 }, currency: 'USD', based_on: main },
        { id: x.id, plan: { ...TYPED, targetAge: 52, spending: 41_000 }, currency: 'USD', based_on: x.updated_at },
      ],
      facts_were: factsOf(TYPED),
    });
    expect(r.status).toBe(200);
    const stamps = [(await stored(MAIN_ID)).updatedAt, (await stored(x.id)).updatedAt];
    expect(new Set([...stamps, main, x.updated_at]).size).toBe(4);
    expect(r.body.plans.map((p: { updated_at: string }) => p.updated_at)).toEqual(stamps);
    expect(r.body.main).toEqual({ id: MAIN_ID, plan: { ...TYPED, spending: 41_000 }, currency: 'USD', updated_at: stamps[0] });
  });

  test('that copy made your plan is restamped: a save from before, at any stamp either held, is refused and writes nothing', async () => {
    setSystemTime(new Date('2026-11-04T12:00:00.000Z'));
    const main = await yours();
    const x = await copy('Stop at 52', { ...TYPED, targetAge: 52 });
    const also = await plans('PUT', {
      saves: [
        { id: MAIN_ID, plan: { ...TYPED, spending: 41_000 }, currency: 'USD', based_on: main },
        { id: x.id, plan: { ...TYPED, targetAge: 52, spending: 41_000 }, currency: 'USD', based_on: x.updated_at },
      ],
      facts_were: factsOf(TYPED),
    });
    const [mainAt, xAt] = also.body.plans.map((p: { updated_at: string }) => p.updated_at);
    const made = await plans('PATCH', { main: x.id, based_on: xAt });
    expect(made.status).toBe(200);
    const now = (await stored(x.id)).updatedAt;
    expect(made.body).toEqual({ id: x.id, plan: { ...TYPED, targetAge: 52, spending: 41_000 }, currency: 'USD', updated_at: now });
    expect([main, x.updated_at, mainAt, xAt]).not.toContain(now);
    expect((await planFactsStore.get(ctx))!.main).toBe(x.id);
    const was = await raw();
    for (const old of [main, x.updated_at, mainAt, xAt]) {
      expect(await save({ ...TYPED, spending: 99_000 }, old)).toEqual({ status: 409, body: { error: CHANGED, stale: true } });
    }
    expect(await raw()).toEqual(was);
    // At the new stamp, the save lands in your new plan; the old one is left byte for byte.
    const ok = await save({ ...TYPED, targetAge: 52, spending: 42_000 }, now);
    expect([ok.status, ok.body.id]).toEqual([200, x.id]);
    expect((await fake.hgetall<Record<string, string>>(ctxKey('fire-plans')))![MAIN_ID]).toBe(was.plans![MAIN_ID]);
  });

  test('a copy made your plan never takes a stamp your plan has held, so a page holding that one is refused, within one millisecond too', async () => {
    const T = Date.parse('2026-11-04T12:00:00.000Z');
    setSystemTime(new Date(T));
    await yours();
    const x = await copy('Stop at 52', { ...TYPED, targetAge: 52 });
    // A page loads your plan at a later millisecond; another device saves it
    // twice in that millisecond, then makes the copy your plan.
    setSystemTime(new Date(T + 10));
    const held = (await get()).body.updated_at;
    const loaded = await save({ ...TYPED, spending: 41_000 }, held);
    const theirs = await save({ ...TYPED, spending: 42_000 }, loaded.body.updated_at);
    expect(theirs.status).toBe(200);
    const made = await plans('PATCH', { main: x.id, based_on: x.updated_at });
    expect(made.status).toBe(200);
    expect([held, loaded.body.updated_at, theirs.body.updated_at, x.updated_at]).not.toContain(made.body.updated_at);
    expect(await save({ ...TYPED, spending: 99_000 }, loaded.body.updated_at)).toEqual({ status: 409, body: { error: CHANGED, stale: true } });
    expect((await stored(x.id)).plan.spending).toBe(40_000);
  });

  test('your plan saved on one device as a copy is made your plan on another, in one millisecond: they never share a stamp, so that device’s next save is refused', async () => {
    setSystemTime(new Date('2026-11-04T12:00:00.000Z'));
    const main = await yours();
    const x = await copy('Stop at 52', { ...TYPED, targetAge: 52 }, 'USD');
    // This device has read the plans for its save when the other makes the
    // copy your plan.
    before(firePlansStore, 'updateMany', async () => expect((await plans('PATCH', { main: x.id, based_on: x.updated_at })).status).toBe(200));
    const mine = await save({ ...TYPED, spending: 41_000 }, main);
    expect(mine.status).toBe(200);
    expect((await stored(MAIN_ID)).updatedAt).not.toBe((await stored(x.id)).updatedAt);
    expect(await save({ ...TYPED, spending: 99_000 }, mine.body.updated_at)).toEqual({ status: 409, body: { error: CHANGED, stale: true } });
    expect((await stored(x.id)).plan.spending).toBe(40_000);
  });

  test('every write moves an entry’s stamp on, even when the clock steps back', async () => {
    setSystemTime(new Date('2026-11-04T12:00:00.000Z'));
    const main = await yours();
    setSystemTime(new Date('2026-11-04T11:00:00.000Z'));
    const next = await save({ ...TYPED, spending: 41_000 }, main);
    expect(next.body.updated_at > main).toBe(true);
  });
});

describe('the facts', () => {
  async function two() {
    const main = await yours();
    const x = await copy('Stop at 52', { ...TYPED, targetAge: 52 });
    return { main, x };
  }

  test('a change is written first, then every entry with it, all at once', async () => {
    const { main, x } = await two();
    const order: string[] = [];
    before(planFactsStore, 'update', async () => void order.push('facts'));
    before(firePlansStore, 'updateMany', async () => void order.push('entries'));
    const r = await plans('PUT', {
      saves: [
        { id: x.id, plan: { ...TYPED, targetAge: 52, age: 41 }, currency: 'USD', based_on: x.updated_at },
        { id: MAIN_ID, plan: { ...TYPED, age: 41 }, currency: 'USD', based_on: main },
      ],
      facts_were: factsOf(TYPED),
    });
    expect(r.status).toBe(200);
    expect(order).toEqual(['facts', 'entries']);
    expect(await planFactsStore.get(ctx)).toEqual({ version: 1, main: MAIN_ID, ...factsOf({ ...TYPED, age: 41 }) });
    expect([(await stored(MAIN_ID)).plan.age, (await stored(x.id)).plan.age]).toEqual([41, 41]);
    expect(r.body.main.plan.age).toBe(41);
  });

  test('plans saved together share the facts, and each once: refused, nothing written', async () => {
    const { main, x } = await two();
    const was = await raw();
    const mixed = await plans('PUT', {
      saves: [
        { id: MAIN_ID, plan: { ...TYPED, age: 41 }, currency: 'USD', based_on: main },
        { id: x.id, plan: { ...TYPED, age: 42 }, currency: 'USD', based_on: x.updated_at },
      ],
      facts_were: factsOf(TYPED),
    });
    expect(mixed.status).toBe(400);
    const twice = await plans('PUT', {
      saves: [
        { id: MAIN_ID, plan: TYPED, currency: 'USD', based_on: main },
        { id: MAIN_ID, plan: TYPED, currency: 'USD', based_on: main },
      ],
      facts_were: factsOf(TYPED),
    });
    expect(twice.status).toBe(400);
    expect(await raw()).toEqual(was);
  });

  test('one stale stamp among them: refused before anything is written', async () => {
    const { main, x } = await two();
    const was = await raw();
    const r = await plans('PUT', {
      saves: [
        { id: MAIN_ID, plan: { ...TYPED, age: 41 }, currency: 'USD', based_on: main },
        { id: x.id, plan: { ...TYPED, age: 41 }, currency: 'USD', based_on: main },
      ],
      facts_were: factsOf(TYPED),
    });
    expect(r).toEqual({ status: 409, body: { error: CHANGED, stale: true } });
    expect(await raw()).toEqual(was);
  });

  test('an entry changed between the facts and the entries: the facts stand, no entry is written, and it says so', async () => {
    const { main, x } = await two();
    before(firePlansStore, 'updateMany', () => firePlansStore.update(ctx, x.id, (cur) => ({ ...cur!, updatedAt: '2030-01-01T00:00:00.000Z' })));
    const r = await quiet(() =>
      plans('PUT', {
        saves: [
          { id: MAIN_ID, plan: { ...TYPED, age: 41, spending: 41_000 }, currency: 'USD', based_on: main },
          { id: x.id, plan: { ...TYPED, age: 41 }, currency: 'USD', based_on: x.updated_at },
        ],
        facts_were: factsOf(TYPED),
      })
    );
    expect(r).toEqual({ status: 409, body: { error: PARTIAL, stale: true } });
    expect((await planFactsStore.get(ctx))!.age).toBe(41);
    expect((await stored(MAIN_ID)).plan).toEqual(TYPED);
    expect((await stored(MAIN_ID)).updatedAt).toBe(main);
  });

  test('changed since the page loaded them, by another device: a change refused, nothing written; an unrelated save keeps that age', async () => {
    const { main } = await two();
    await planFactsStore.update(ctx, (cur) => ({ ...cur!, age: 50 }));
    const was = await raw();
    expect(await save({ ...TYPED, age: 41 }, main, { facts_were: factsOf(TYPED) })).toEqual({ status: 409, body: { error: OTHER_DEVICE, stale: true } });
    expect(await raw()).toEqual(was);
    const r = await save({ ...TYPED, spending: 41_000 }, main);
    expect(r.status).toBe(200);
    expect(r.body.plan).toEqual({ ...TYPED, spending: 41_000, age: 50 });
    expect((await planFactsStore.get(ctx))!.age).toBe(50);
  });
});

describe('a copy’s changes, each at the stamp the page loaded', () => {
  test('rename: names unique in any case, a stale stamp refused, the stamp moved on', async () => {
    const main = await yours();
    const x = await copy('Stop at 52', { ...TYPED, targetAge: 52 }, 'USD');
    expect(await plans('PATCH', { id: x.id, name: 'first PLAN', based_on: x.updated_at })).toEqual({ status: 409, body: { error: NAME_TAKEN } });
    expect(await plans('PATCH', { id: x.id, name: 'Later', based_on: main })).toEqual({ status: 409, body: { error: CHANGED, stale: true } });
    const r = await plans('PATCH', { id: x.id, name: '  Stop at 53 ', based_on: x.updated_at });
    expect(r.status).toBe(200);
    expect(r.body.plan).toMatchObject({ id: x.id, name: 'Stop at 53' });
    expect(r.body.plan.updated_at > x.updated_at).toBe(true);
    // Its own name in another case is its own.
    expect((await plans('PATCH', { id: x.id, name: 'STOP AT 53', based_on: r.body.plan.updated_at })).status).toBe(200);
    // Your plan renamed too, at its own stamp.
    expect((await plans('PATCH', { id: MAIN_ID, name: 'Mine', based_on: main })).body.plan.name).toBe('Mine');
    expect((await plans('PATCH', { id: x.id, name: 'x'.repeat(41), based_on: r.body.plan.updated_at })).status).toBe(400);
  });

  test('relabel: a copy’s amounts said to be in a currency; one with none refused', async () => {
    await yours();
    const none = await copy('Nothing typed', DEFAULT_PLAN_V2);
    expect(await plans('PATCH', { id: none.id, currency: 'EUR', based_on: none.updated_at })).toEqual({ status: 409, body: { error: NOTHING_TYPED } });
    const x = await copy('Stop at 52', { ...TYPED, targetAge: 52 }, 'USD');
    expect(await plans('PATCH', { id: x.id, currency: 'EUR', based_on: none.updated_at })).toEqual({ status: 409, body: { error: CHANGED, stale: true } });
    const r = await plans('PATCH', { id: x.id, currency: 'EUR', based_on: x.updated_at });
    expect([r.status, r.body.plan.currency]).toEqual([200, 'EUR']);
    expect((await stored(x.id)).currency).toBe('EUR');
    expect((await stored(MAIN_ID)).currency).toBe('USD');
    expect((await plans('PATCH', { id: x.id, currency: 'eur', based_on: r.body.plan.updated_at })).status).toBe(400);
  });

  test('delete: at its stamp; your plan never; one already gone is no error', async () => {
    const main = await yours();
    const x = await copy('Stop at 52', { ...TYPED, targetAge: 52 }, 'USD');
    expect(await plans('DELETE', { id: MAIN_ID, based_on: main })).toEqual({ status: 409, body: { error: KEEP_MAIN } });
    expect(await plans('DELETE', { id: x.id, based_on: main })).toEqual({ status: 409, body: { error: CHANGED, stale: true } });
    expect(await plans('DELETE', { id: x.id })).toEqual({ status: 409, body: { error: CHANGED, stale: true } });
    expect(await plans('DELETE', { id: x.id, based_on: x.updated_at })).toEqual({ status: 200, body: { ok: true } });
    expect(await firePlansStore.ids(ctx)).toEqual([MAIN_ID]);
    expect((await plans('DELETE', { id: x.id, based_on: x.updated_at })).status).toBe(200);
    // Before your plan is saved, it can't be deleted either.
    fake.reset();
    await registerTestContainer(fake);
    expect(await plans('DELETE', { id: MAIN_ID, based_on: null })).toEqual({ status: 409, body: { error: KEEP_MAIN } });
  });

  test('make this your plan: at its stamp, restamped first, then the facts name it; the plan that was yours is a copy, and can be deleted', async () => {
    const main = await yours();
    const x = await copy('Stop at 52', { ...TYPED, targetAge: 52 }, 'USD');
    expect(await plans('PATCH', { main: x.id, based_on: main })).toEqual({ status: 409, body: { error: CHANGED, stale: true } });
    expect(await plans('PATCH', { main: MAIN_ID, based_on: main })).toEqual({ status: 409, body: { error: CHANGED, stale: true } });
    expect(await plans('PATCH', { main: 'gone', based_on: main })).toEqual({ status: 409, body: { error: CHANGED, stale: true } });
    const order: string[] = [];
    before(firePlansStore, 'updateMany', async () => void order.push('entry'));
    before(planFactsStore, 'update', async () => void order.push('facts'));
    const r = await plans('PATCH', { main: x.id, based_on: x.updated_at });
    expect(r.status).toBe(200);
    expect(order).toEqual(['entry', 'facts']);
    expect(r.body.updated_at > x.updated_at).toBe(true);
    expect((await get()).body).toEqual(r.body);
    const listed = (await list()).body;
    expect([listed.main, listed.plans.map((p: { id: string }) => p.id)]).toEqual([x.id, [x.id, MAIN_ID]]);
    // The old stamp, after: refused for every change.
    expect((await plans('PATCH', { id: x.id, name: 'Other', based_on: x.updated_at })).status).toBe(409);
    expect((await plans('DELETE', { id: x.id, based_on: r.body.updated_at })).body).toEqual({ error: KEEP_MAIN });
    expect((await plans('DELETE', { id: MAIN_ID, based_on: main })).status).toBe(200);
    expect(await firePlansStore.ids(ctx)).toEqual([x.id]);
    expect((await get()).body.id).toBe(x.id);
  });

  test('make this your plan stopped after the restamp: said as stale, so the page reads the plans again and can try again', async () => {
    await yours();
    const x = await copy('Stop at 52', { ...TYPED, targetAge: 52 }, 'USD');
    before(planFactsStore, 'update', async () => {
      throw new Error('down');
    });
    const r = await quiet(() => plans('PATCH', { main: x.id, based_on: x.updated_at }));
    expect(r).toEqual({ status: 409, body: { error: '“Stop at 52” wasn’t made your plan: try again', stale: true } });
    const now = (await list()).body.plans.find((p: { id: string }) => p.id === x.id).updated_at;
    expect(now > x.updated_at).toBe(true);
    expect((await plans('PATCH', { main: x.id, based_on: now })).status).toBe(200);
  });

  test('a body other than the route takes is refused, nothing written', async () => {
    const main = await yours();
    const was = await raw();
    for (const [method, body] of [
      ['POST', { from: MAIN_ID, name: 'X', plan: TYPED, currency: 'USD', extra: 1 }],
      ['POST', { from: MAIN_ID, name: '', plan: TYPED, currency: 'USD' }],
      ['POST', { from: MAIN_ID, name: 'X', plan: DEFAULT_PLAN, currency: null }],
      ['POST', { from: '__proto__', name: 'X', plan: TYPED, currency: 'USD' }],
      ['PUT', { saves: [], facts_were: factsOf(TYPED) }],
      ['PUT', { saves: [{ id: MAIN_ID, plan: TYPED, currency: 'USD', based_on: main }] }],
      ['PUT', { saves: [{ id: MAIN_ID, plan: TYPED, currency: 'USD' }], facts_were: factsOf(TYPED) }],
      ['PATCH', { id: MAIN_ID, name: 'X' }],
      ['PATCH', { main: MAIN_ID, based_on: null }],
      ['PATCH', { id: MAIN_ID, name: 'X', currency: 'USD', based_on: main }],
      ['DELETE', { id: MAIN_ID, based_on: main, also: true }],
      ['DELETE', { id: MAIN_ID, unreadable: 'yes' }],
    ] as const) {
      expect([method, body, (await plans(method, body)).status]).toEqual([method, body, 400]);
    }
    expect(await raw()).toEqual(was);
  });
});

describe('the limit and the names', () => {
  test(`${MAX_FIRE_PLANS} plans at most, damaged and newer ones counted; no new one with a name another has, in any case`, async () => {
    await yours();
    expect(await plans('POST', { from: MAIN_ID, name: 'FIRST plan', plan: TYPED, currency: 'USD' })).toEqual({ status: 409, body: { error: NAME_TAKEN } });
    for (let i = 1; i <= MAX_FIRE_PLANS - 3; i++) await copy(`Copy ${i}`, TYPED, 'USD');
    await damageEntry('broken');
    await newerEntry('later', { name: 'Later', plan: TYPED, tax: null, currency: 'USD', createdAt: '2030-01-01T00:00:00.000Z', updatedAt: '2030-01-01T00:00:00.000Z' });
    expect(await firePlansStore.count(ctx)).toBe(MAX_FIRE_PLANS);
    const was = await raw();
    expect(await plans('POST', { from: MAIN_ID, name: 'One more', plan: TYPED, currency: 'USD' })).toEqual({ status: 409, body: { error: AT_MOST } });
    expect(await raw()).toEqual(was);
    await quiet(() => plans('DELETE', { id: 'broken', unreadable: true }));
    expect((await plans('POST', { from: MAIN_ID, name: 'One more', plan: TYPED, currency: 'USD' })).status).toBe(200);
  });

  test('a name on more than one line, or holding a control character, is refused', async () => {
    await yours();
    const x = await copy('Stop at 52', TYPED, 'USD');
    const was = await raw();
    for (const name of ['Stop\nat 52', 'Tab\there', 'Bell\u0007', 'Nul\u0000']) {
      expect((await plans('POST', { from: MAIN_ID, name, plan: TYPED, currency: 'USD' })).status).toBe(400);
      expect((await plans('PATCH', { id: x.id, name, based_on: x.updated_at })).status).toBe(400);
    }
    expect(await raw()).toEqual(was);
  });

  test('copies made at the same moment past the limit: the one counted over is taken back', async () => {
    await yours();
    for (let i = 1; i <= MAX_FIRE_PLANS - 2; i++) await copy(`Copy ${i}`, TYPED, 'USD');
    // Another device makes the last one while this one is being made.
    before(firePlansStore, 'updateMany', () => plans('POST', { from: MAIN_ID, name: 'Theirs', plan: TYPED, currency: 'USD' }));
    const r = await plans('POST', { from: MAIN_ID, name: 'Mine', plan: TYPED, currency: 'USD' });
    expect(r.status).toBe(409);
    expect(await firePlansStore.count(ctx)).toBe(MAX_FIRE_PLANS);
    expect((await list()).body.plans.map((p: { name: string }) => p.name)).toContain('Theirs');
  });
});

describe('the currency a new copy takes', () => {
  test('Duplicate: its source’s, while the source holds amounts; a page in another currency refused', async () => {
    await yours();
    const x = await copy('In euros', { ...TYPED, spending: 30_000 }, 'USD');
    await plans('PATCH', { id: x.id, currency: 'EUR', based_on: x.updated_at });
    const source = (await list()).body.plans.find((p: { id: string }) => p.id === x.id);
    expect(await plans('POST', { from: x.id, name: 'In euros 2', plan: source.plan, currency: 'USD' })).toEqual({ status: 409, body: { error: STALE_CURRENCY, stale: true } });
    expect((await copy('In euros 2', source.plan, null, x.id)).currency).toBe('EUR');
    expect((await copy('In euros 3', source.plan, 'EUR', x.id)).currency).toBe('EUR');
    // A source with nothing typed gives nothing to a copy with nothing typed.
    const blank = await copy('Blank', DEFAULT_PLAN_V2);
    expect((await copy('Blank 2', DEFAULT_PLAN_V2, 'EUR', blank.id)).currency).toBeNull();
  });

  test('Try it: your plan’s, while it holds amounts; over none, the one sent; with neither, refused', async () => {
    await yours();
    const kid = await copy('A child', { ...TYPED, items: [income, child] }, null);
    expect(kid.currency).toBe('USD');
    expect(await plans('POST', { from: MAIN_ID, name: 'Two children', plan: { ...TYPED, items: [income, child, { ...child, id: 'kid2' }] }, currency: 'EUR' })).toEqual({
      status: 409,
      body: { error: STALE_CURRENCY, stale: true },
    });
    const blank = await copy('Blank', DEFAULT_PLAN_V2);
    expect(await plans('POST', { from: blank.id, name: 'Blank child', plan: { ...DEFAULT_PLAN_V2, items: [child] }, currency: null })).toEqual({ status: 409, body: { error: FIRST_CURRENCY } });
    expect((await copy('Blank child', { ...DEFAULT_PLAN_V2, items: [child] }, 'GBP', blank.id)).currency).toBe('GBP');
  });

  test('a copy’s save keeps its currency; another over its amounts is refused', async () => {
    await yours();
    const x = await copy('Stop at 52', { ...TYPED, targetAge: 52 }, 'USD');
    const r = await plans('PUT', { saves: [{ id: x.id, plan: { ...TYPED, targetAge: 52, spending: 1 }, currency: null, based_on: x.updated_at }], facts_were: factsOf(TYPED) });
    expect([r.status, r.body.plans[0].currency]).toEqual([200, 'USD']);
    const again = await plans('PUT', { saves: [{ id: x.id, plan: { ...TYPED, spending: 2 }, currency: 'EUR', based_on: r.body.plans[0].updated_at }], facts_were: factsOf(TYPED) });
    expect(again).toEqual({ status: 409, body: { error: STALE_CURRENCY, stale: true } });
  });
});

describe('with an entry that can’t be read, and one a newer version saved', () => {
  async function there() {
    const main = await yours();
    const x = await copy('Stop at 52', { ...TYPED, targetAge: 52 }, 'USD');
    await damageEntry('broken');
    await newerEntry('later', { name: 'Later', plan: TYPED, tax: null, currency: 'USD', createdAt: '2030-01-01T00:00:00.000Z', updatedAt: '2030-01-01T00:00:00.000Z' });
    return { main, x };
  }

  test('the plans are listed, with their ids; your plan and the copy save, alone or together', async () => {
    const { main, x } = await there();
    expect((await list()).body).toMatchObject({ main: MAIN_ID, unreadable_ids: ['broken'], unrecognised_ids: ['later'] });
    expect((await list()).body.plans.map((p: { id: string }) => p.id)).toEqual([MAIN_ID, x.id]);
    const one = await save({ ...TYPED, spending: 41_000 }, main);
    expect(one.status).toBe(200);
    const both = await plans('PUT', {
      saves: [
        { id: MAIN_ID, plan: { ...TYPED, age: 41 }, currency: 'USD', based_on: one.body.updated_at },
        { id: x.id, plan: { ...TYPED, targetAge: 52, age: 41 }, currency: 'USD', based_on: x.updated_at },
      ],
      facts_were: factsOf(TYPED),
    });
    expect(both.status).toBe(200);
    expect(await fake.hget<string>(ctxKey('fire-plans'), 'broken')).toBe(DAMAGED);
    expect((await copy('Another', TYPED, 'USD')).name).toBe('Another');
  });

  test('neither is written: a save, rename or make main of one says it can’t be read; a newer one is never deleted, a damaged one only once confirmed', async () => {
    const { main } = await there();
    await quiet(async () => {
      for (const id of ['broken', 'later']) {
        const r = await plans('PUT', { saves: [{ id, plan: TYPED, currency: 'USD', based_on: main }], facts_were: factsOf(TYPED) });
        expect([id, r.status, r.body.unreadable]).toEqual([id, 409, true]);
        expect((await plans('PATCH', { id, name: 'Mine', based_on: main })).body.unreadable).toBe(true);
        expect((await plans('PATCH', { main: id, based_on: main })).body.unreadable).toBe(true);
      }
      expect((await plans('DELETE', { id: 'later', unreadable: true })).status).toBe(409);
      expect((await plans('DELETE', { id: 'broken' })).body.unreadable).toBe(true);
    });
    expect((await firePlansStore.ids(ctx)).sort()).toContain('broken');
    expect(await plans('DELETE', { id: 'broken', unreadable: true })).toEqual({ status: 200, body: { ok: true } });
    expect((await firePlansStore.ids(ctx)).sort()).not.toContain('broken');
    expect(await firePlansStore.ids(ctx)).toContain('later');
  });

  test('your plan’s entry damaged: every write says so, and nothing is written', async () => {
    const { x } = await there();
    await damageEntry(MAIN_ID);
    const was = await raw();
    await quiet(async () => {
      for (const r of [
        await save(TYPED, x.updated_at),
        await plans('POST', { from: x.id, name: 'More', plan: TYPED, currency: 'USD' }),
        await plans('PATCH', { id: x.id, name: 'Other', based_on: x.updated_at }),
        await plans('PATCH', { main: x.id, based_on: x.updated_at }),
        await get(),
        await list(),
      ]) {
        expect([r.status, r.body.unreadable]).toEqual([409, true]);
      }
    });
    expect(await raw()).toEqual(was);
  });
});

describe('a page from before copies (the release before)', () => {
  test('a save with no stamp or no facts is refused as stale, and writes nothing', async () => {
    const main = await yours();
    const was = await raw();
    expect(await put({ plan: { ...DEFAULT_PLAN, age: 41 }, currency: 'USD', facts_were: factsOf(TYPED) })).toEqual({ status: 409, body: { error: CHANGED, stale: true } });
    expect(await put({ plan: TYPED, currency: 'USD', based_on: main })).toEqual({ status: 409, body: { error: CHANGED, stale: true } });
    expect(await put({ plan: { ...DEFAULT_PLAN, age: 41 }, currency: 'USD' })).toEqual({ status: 409, body: { error: CHANGED, stale: true } });
    expect(await raw()).toEqual(was);
  });

  test('before your plan is saved too, writing nothing', async () => {
    expect(await put({ plan: { ...DEFAULT_PLAN, age: 41 }, currency: 'USD' })).toEqual({ status: 409, body: { error: CHANGED, stale: true } });
    expect([await fake.type(ctxKey('fire-plans')), await fake.type(ctxKey('plan-facts'))]).toEqual(['none', 'none']);
  });

  test('a version 1 plan with a stamp is refused: version 2 is what is saved', async () => {
    const main = await yours();
    const r = await put({ plan: { ...DEFAULT_PLAN, age: 40 }, currency: 'USD', facts_were: factsOf(TYPED), based_on: main });
    expect(r.status).toBe(400);
  });
});

describe('the currency recorded alone (POST /api/fire-plan)', () => {
  test('before your plan is saved, and over nothing typed, there is nothing to record', async () => {
    const { typedAmounts } = await import('@/lib/fire/plan-currency');
    expect(await post({ currency: 'USD', amounts: typedAmounts(TYPED) })).toEqual({ status: 409, body: { error: NOTHING_TYPED } });
    await yours(DEFAULT_PLAN_V2);
    expect(await post({ currency: 'USD', amounts: typedAmounts(DEFAULT_PLAN_V2) })).toEqual({ status: 409, body: { error: NOTHING_TYPED } });
  });

  test('a change moves your plan’s stamp on, a fresh one, so a save from before it is refused', async () => {
    const { typedAmounts } = await import('@/lib/fire/plan-currency');
    const main = await yours();
    const x = await copy('Stop at 52', { ...TYPED, targetAge: 52 }, 'USD');
    const r = await post({ currency: 'EUR', amounts: typedAmounts(TYPED), answered: true });
    expect([r.status, r.body.currency]).toEqual([200, 'EUR']);
    expect([main, x.updated_at]).not.toContain(r.body.updated_at);
    expect((await save({ ...TYPED, spending: 1 }, main, { currency: 'EUR' })).status).toBe(409);
  });
});

describe('`plan-facts` missing beside entries', () => {
  test('make this your plan keeps the age your plan held, never the copy’s older one', async () => {
    const main = await yours({ ...TYPED, age: 45 });
    const x = await copy('Stop at 52', { ...TYPED, age: 45, targetAge: 52 }, 'USD');
    // A write stopped before the facts, and the copy holding an older age.
    await planFactsStore.remove(ctx);
    await firePlansStore.update(ctx, x.id, (cur) => ({ ...cur!, plan: { ...cur!.plan, age: 40 } }));
    expect((await get()).body.plan.age).toBe(45);
    const r = await plans('PATCH', { main: x.id, based_on: x.updated_at });
    expect(r.status).toBe(200);
    expect(r.body.plan).toEqual({ ...TYPED, age: 45, targetAge: 52 });
    expect(await planFactsStore.get(ctx)).toEqual({ version: 1, main: x.id, ...factsOf({ ...TYPED, age: 45 }) });
    expect((await get()).body.plan.age).toBe(45);
    expect(main).not.toBe(r.body.updated_at);
  });

  test('a save changing the facts makes them, from your plan’s own fields', async () => {
    const main = await yours();
    await planFactsStore.remove(ctx);
    const r = await save({ ...TYPED, age: 41 }, main, { facts_were: factsOf(TYPED) });
    expect(r.status).toBe(200);
    expect(await planFactsStore.get(ctx)).toEqual({ version: 1, main: MAIN_ID, ...factsOf({ ...TYPED, age: 41 }) });
  });
});
