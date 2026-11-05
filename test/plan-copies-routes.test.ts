import { describe, expect, test, mock, beforeEach, afterEach } from 'bun:test';
import { FakeRedis, storageMock, TEST_CTX, ctxKey, registerTestContainer, unscopedDataKeys } from './fake-redis';
import type { FirePlan, PlanIncome } from '@/lib/fire/plan';
import type { PlanEntry, PlanFacts } from '@/lib/fire/copies';

// The plans as copies read (lib/plan-copies.ts), and your plan saved, through
// the routes: GET /api/fire-plan and /api/plan-inputs answer your plan's
// entry with the facts in its fields (the defaults while there is none),
// GET /api/plans every plan, and PUT and POST
// /api/fire-plan save into your entry on the rules of app/api/fire-plan (the
// stamp, the version, the facts as the page loaded them, the currency). The
// other plans' writes, and your plan's first entry, are
// test/plans-routes.test.ts's.

process.env.PLAID_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');

const fake = new FakeRedis({ deserialize: true });
afterEach(() => expect(unscopedDataKeys(fake)).toEqual([]));
mock.module('@/lib/storage', () => storageMock(fake));

const { encrypt } = await import('@/lib/crypto');
const { firePlansStore, planFactsStore } = await import('@/lib/plan-copies');
const { DEFAULT_PLAN } = await import('@/lib/fire/plan');
const { planOf } = await import('@/lib/fire/plan-v2');
const { itemFromIncome } = await import('@/lib/fire/items');
const { MAIN_ID, factsOf } = await import('@/lib/fire/copies');
const { typedAmounts } = await import('@/lib/fire/plan-currency');
const planRoute = await import('@/app/api/fire-plan/route');
const inputsRoute = await import('@/app/api/plan-inputs/route');
const plansRoute = await import('@/app/api/plans/route');

beforeEach(async () => {
  fake.reset();
  (await import('@/lib/sessions')).forgetEpochs();
  await registerTestContainer(fake);
});

const ctx = TEST_CTX;
const AT = '2026-11-01T10:00:00.000Z';
const CHANGED = 'Your plan changed: load the page again';
const OTHER_DEVICE = 'Changed on another device: load it again';
const PARTIAL = 'Your age was saved; the rest wasn’t: try again';
const STALE_CURRENCY = 'The currency your plan’s figures are in was changed since this page loaded it, so nothing was saved: load it again.';
const FIRST_CURRENCY = 'Say which currency your plan’s figures are in, then save again: nothing was saved.';
const NO_PLAN = { id: MAIN_ID, plan: null, currency: null, updated_at: null, tax_facts: null };

const income = (over: Partial<PlanIncome> = {}): PlanIncome => ({ id: 'ss', label: 'Social Security', amount: 24_000, fromAge: 67, inflationAdjusted: true, ...over });
/** Your plan as an entry may hold it: version 1, as the release before saved it. */
const TYPED: FirePlan = { ...DEFAULT_PLAN, age: 40, targetAge: 55, spending: 40_000, income: [income()] };
/** And as this release saves it: version 2. */
const TYPED2 = planOf(TYPED);
const BLANK2 = planOf(DEFAULT_PLAN);
const entry = (over: Partial<PlanEntry> = {}): PlanEntry => ({ name: 'First plan', plan: TYPED, tax: null, currency: 'USD', createdAt: AT, updatedAt: AT, ...over });
const facts = (over: Partial<PlanFacts> = {}): PlanFacts => ({ version: 1, main: MAIN_ID, ...factsOf(TYPED), ...over }) as PlanFacts;
const pension = { ...itemFromIncome(income({ id: 'pen', label: 'Pension' })), kind: 'pension' as const };

const json = async (res: Response) => ({ status: res.status, body: await res.json() });
const req = (path: string, method: string, body?: unknown) =>
  new Request(`http://localhost/api/${path}`, { method, ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }) });
const get = async () => json(await planRoute.GET());
const put = async (body: unknown) => json(await planRoute.PUT(req('fire-plan', 'PUT', body)));
const post = async (body: unknown) => json(await planRoute.POST(req('fire-plan', 'POST', body)));
const inputs = async () => json(await inputsRoute.GET(req('plan-inputs', 'GET')));
const list = async () => json(await plansRoute.GET());
/** Your plan's save as a page sends it, loaded at `based_on` with the facts
 *  of TYPED unless said. */
const save = (plan: unknown, based_on: string | null = AT, over: { currency?: string | null; facts_were?: unknown } = {}) =>
  put({ plan, currency: over.currency === undefined ? 'USD' : over.currency, facts_were: over.facts_were ?? factsOf(TYPED), based_on });

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
/** Each entry's stored bytes, and the facts', to hold a refusal to "nothing written". */
const raw = async () => ({ plans: await fake.hgetall<Record<string, string>>(ctxKey('fire-plans')), facts: await fake.get(ctxKey('plan-facts')) });

/** Runs `before` just before the store's next compare-and-set over entries,
 *  as another device's write landing between this save's read and its write. */
function between(before: () => Promise<unknown>) {
  const store = firePlansStore as unknown as { updateMany: (...a: unknown[]) => Promise<unknown> };
  const real = store.updateMany;
  store.updateMany = async (...args: unknown[]) => {
    store.updateMany = real;
    await before();
    return real.apply(firePlansStore, args);
  };
}

/** The ids GET /api/plans lists, yours first, and which is yours. */
const listed = async () => {
  const { body } = await list();
  return { main: body.main, missing: body.missing, ids: body.plans.map((p: { id: string }) => p.id), names: body.plans.map((p: { name: string }) => p.name) };
};

describe('the plan read, before any entry', () => {
  test('is the defaults; the facts alone change nothing', async () => {
    expect(await get()).toEqual({ status: 200, body: NO_PLAN });
    await planFactsStore.set(ctx, facts({ age: 60 }));
    expect(await get()).toEqual({ status: 200, body: NO_PLAN });
    expect((await inputs()).body).toEqual({ ...NO_PLAN, plans: [] });
    expect(await listed()).toEqual({ main: MAIN_ID, missing: false, ids: [MAIN_ID], names: ['First plan'] });
  });

  test('damaged facts beside no entry are never read into the answer', async () => {
    await fake.set(ctxKey('plan-facts'), DAMAGED);
    expect(await get()).toEqual({ status: 200, body: NO_PLAN });
    expect((await inputs()).status).toBe(200);
    expect((await list()).status).toBe(200);
  });
});

describe('the plan read, once there are entries', () => {
  test('is your plan’s entry, with the facts in its fields, its id, its currency and its stamp', async () => {
    await firePlansStore.set(ctx, MAIN_ID, entry({ updatedAt: 'stamp-1' }));
    await planFactsStore.set(ctx, facts({ age: 50, includeCash: true }));
    const want = { id: MAIN_ID, plan: { ...TYPED, age: 50, includeCash: true }, currency: 'USD', updated_at: 'stamp-1', tax_facts: null };
    expect(await get()).toEqual({ status: 200, body: want });
    expect((await inputs()).body).toEqual({ ...want, plans: [] });
    expect((await list()).body.plans).toEqual([{ id: MAIN_ID, name: 'First plan', plan: want.plan, currency: 'USD', created_at: AT, updated_at: 'stamp-1' }]);
  });

  test('without the facts, your entry’s own fields are them, every copy’s too', async () => {
    await firePlansStore.set(ctx, MAIN_ID, entry());
    await firePlansStore.set(ctx, 'x', entry({ name: 'Older age', plan: { ...TYPED, age: 30, targetAge: 52 }, createdAt: '2026-11-02T10:00:00.000Z' }));
    expect((await get()).body).toEqual({ id: MAIN_ID, plan: TYPED, currency: 'USD', updated_at: AT, tax_facts: null });
    expect((await list()).body.plans[1].plan).toEqual({ ...TYPED, targetAge: 52 });
  });

  test('a partner’s age in the facts reads a version 1 entry as version 2', async () => {
    await firePlansStore.set(ctx, MAIN_ID, entry());
    await planFactsStore.set(ctx, facts({ partnerAge: 38 }));
    expect((await get()).body.plan).toEqual({ ...planOf(TYPED), partnerAge: 38 });
  });

  test('an entry with nothing typed answers no currency, so the Plan follows the accounts', async () => {
    await firePlansStore.set(ctx, MAIN_ID, entry({ plan: DEFAULT_PLAN, currency: 'USD' }));
    expect((await get()).body.currency).toBeNull();
    expect((await list()).body.plans[0].currency).toBeNull();
  });

  test('a version 2 entry whose only amount is a pension answers its currency', async () => {
    await firePlansStore.set(ctx, MAIN_ID, entry({ plan: { ...BLANK2, items: [pension] }, currency: 'EUR' }));
    expect((await get()).body.currency).toBe('EUR');
  });

  test('the facts naming a plan not there: main, else the oldest, and the list says so', async () => {
    await firePlansStore.set(ctx, MAIN_ID, entry());
    await firePlansStore.set(ctx, 'x', entry({ name: 'Stop at 52', plan: { ...TYPED, targetAge: 52 }, createdAt: '2026-11-02T10:00:00.000Z' }));
    await planFactsStore.set(ctx, facts({ main: 'gone' }));
    expect((await get()).body).toMatchObject({ id: MAIN_ID, plan: { targetAge: 55 } });
    expect(await listed()).toEqual({ main: MAIN_ID, missing: true, ids: [MAIN_ID, 'x'], names: ['First plan', 'Stop at 52'] });
    await firePlansStore.remove(ctx, MAIN_ID);
    expect((await get()).body).toMatchObject({ id: 'x', plan: { targetAge: 52 } });
    expect(await listed()).toEqual({ main: 'x', missing: true, ids: ['x'], names: ['Stop at 52'] });
  });

  test('main there without the facts: yours, nothing said; no main and no facts: the oldest, said', async () => {
    await firePlansStore.set(ctx, MAIN_ID, entry());
    expect((await listed()).missing).toBe(false);
    await firePlansStore.remove(ctx, MAIN_ID);
    await firePlansStore.set(ctx, 'b', entry({ name: 'Later', createdAt: '2026-11-03T10:00:00.000Z' }));
    await firePlansStore.set(ctx, 'a', entry({ name: 'Earlier', createdAt: '2026-11-02T10:00:00.000Z' }));
    expect(await listed()).toEqual({ main: 'a', missing: true, ids: ['a', 'b'], names: ['Earlier', 'Later'] });
    expect((await get()).body.id).toBe('a');
  });

  test('copies listed in the order they were made; one that can’t be read, or a newer version saved, never stops it and is named by id', async () => {
    await firePlansStore.set(ctx, MAIN_ID, entry());
    await firePlansStore.set(ctx, 'y', entry({ name: 'Second', createdAt: '2026-11-03T10:00:00.000Z' }));
    await firePlansStore.set(ctx, 'x', entry({ name: 'First copy', createdAt: '2026-11-02T10:00:00.000Z' }));
    await damageEntry('broken');
    await fake.hset(ctxKey('fire-plans'), { later: await encrypt(ctx, JSON.stringify({ ...entry(), tax: { filing: 'single' } })) });
    expect((await get()).status).toBe(200);
    expect((await inputs()).status).toBe(200);
    const { body } = await list();
    expect([body.plans.map((p: { id: string }) => p.id), body.unreadable_ids, body.unrecognised_ids]).toEqual([[MAIN_ID, 'x', 'y'], ['broken'], ['later']]);
  });

  test('damaged facts beside entries: unreadable everywhere, never the defaults, and nothing written', async () => {
    await firePlansStore.set(ctx, MAIN_ID, entry());
    await fake.set(ctxKey('plan-facts'), DAMAGED);
    const was = await raw();
    await quiet(async () => {
      for (const r of [await get(), await inputs(), await list(), await save(TYPED2), await post({ currency: 'USD', amounts: typedAmounts(TYPED) })]) {
        expect([r.status, r.body.unreadable]).toEqual([409, true]);
      }
    });
    expect(await raw()).toEqual(was);
  });

  test('your entry can’t be read: unreadable, whether named, main, or every one there', async () => {
    await quiet(async () => {
      await damageEntry(MAIN_ID);
      await firePlansStore.set(ctx, 'x', entry());
      expect([(await get()).status, (await get()).body.unreadable]).toEqual([409, true]);
      await firePlansStore.set(ctx, MAIN_ID, entry());
      await damageEntry('x');
      await planFactsStore.set(ctx, facts({ main: 'x' }));
      expect([(await get()).status, (await list()).status, (await save(TYPED2)).status]).toEqual([409, 409, 409]);
      await planFactsStore.remove(ctx);
      await firePlansStore.remove(ctx, MAIN_ID);
      expect((await get()).body.unreadable).toBe(true);
    });
  });
});

describe('the plan the facts name, with main there too', () => {
  const X = entry({ name: 'Stop at 52', plan: { ...TYPED, targetAge: 52 }, createdAt: '2026-11-02T10:00:00.000Z', updatedAt: 'x-1' });
  beforeEach(async () => {
    await firePlansStore.set(ctx, MAIN_ID, entry());
    await firePlansStore.set(ctx, 'x', X);
    await planFactsStore.set(ctx, facts({ main: 'x' }));
  });

  test('is read, and the list names it yours, main among the copies', async () => {
    expect((await get()).body).toEqual({ id: 'x', plan: X.plan, currency: 'USD', updated_at: 'x-1', tax_facts: null });
    expect(await listed()).toEqual({ main: 'x', missing: false, ids: ['x', MAIN_ID], names: ['Stop at 52', 'First plan'] });
  });

  test('is the one PUT and POST write, at its own stamp, main left byte for byte', async () => {
    const main = (await fake.hgetall<Record<string, string>>(ctxKey('fire-plans')))![MAIN_ID];
    expect(await save({ ...TYPED2, targetAge: 53 }, AT)).toEqual({ status: 409, body: { error: CHANGED, stale: true } });
    const r = await save({ ...TYPED2, targetAge: 53 }, 'x-1');
    expect([r.status, r.body.id]).toEqual([200, 'x']);
    expect((await firePlansStore.get(ctx, 'x'))!.plan.targetAge).toBe(53);
    await firePlansStore.update(ctx, 'x', (cur) => ({ ...cur!, currency: null }));
    expect((await post({ currency: 'EUR', amounts: typedAmounts({ ...TYPED, targetAge: 53 }) })).status).toBe(200);
    expect((await firePlansStore.get(ctx, 'x'))!.currency).toBe('EUR');
    expect((await fake.hgetall<Record<string, string>>(ctxKey('fire-plans')))![MAIN_ID]).toBe(main);
  });
});

describe('saving your plan (PUT)', () => {
  test('any key but the plan, its currency, the facts it was loaded with and the stamp is refused, as is one of the wrong type', async () => {
    expect(await put({ plan: TYPED2, scenario: 'x', facts_were: factsOf(TYPED), based_on: null })).toEqual({ status: 400, body: { error: 'scenario isn’t taken here' } });
    await firePlansStore.set(ctx, MAIN_ID, entry());
    expect((await put({ plan: TYPED2, currency: 'USD', id: 'x', facts_were: factsOf(TYPED), based_on: AT })).status).toBe(400);
    expect((await put({ plan: TYPED2, facts_were: { age: 'forty' }, based_on: AT })).status).toBe(400);
    expect((await put({ plan: TYPED2, facts_were: factsOf(TYPED), based_on: 7 })).status).toBe(400);
    expect((await put({ plan: TYPED2, currency: 'usd', facts_were: factsOf(TYPED), based_on: AT })).status).toBe(400);
    expect(await firePlansStore.get(ctx, MAIN_ID)).toEqual(entry());
  });

  test('into your entry with a newer stamp', async () => {
    await firePlansStore.set(ctx, MAIN_ID, entry());
    await planFactsStore.set(ctx, facts());
    const next = { ...TYPED2, spending: 45_000 };
    const r = await save(next);
    expect(r.status).toBe(200);
    const stored = (await firePlansStore.get(ctx, MAIN_ID))!;
    expect(stored).toEqual({ ...entry(), plan: next, updatedAt: stored.updatedAt });
    expect(stored.updatedAt > AT).toBe(true);
    expect(r.body).toEqual({ id: MAIN_ID, plan: next, currency: 'USD', updated_at: stored.updatedAt, tax_facts: null });
  });

  test('the stamp sent: matching taken, another refused', async () => {
    await firePlansStore.set(ctx, MAIN_ID, entry({ updatedAt: 'stamp-1' }));
    expect(await save(TYPED2, 'stamp-0')).toEqual({ status: 409, body: { error: CHANGED, stale: true } });
    expect(await save(TYPED2, null)).toEqual({ status: 409, body: { error: CHANGED, stale: true } });
    expect((await save(TYPED2, 'stamp-1')).status).toBe(200);
  });

  test('version 2 is what is saved, over an entry of either version; version 1 is refused', async () => {
    await firePlansStore.set(ctx, MAIN_ID, entry());
    expect((await save(TYPED)).status).toBe(400);
    const two = { ...TYPED2, items: [...TYPED2.items, pension] };
    const r = await save(two);
    expect(r.status).toBe(200);
    expect((await firePlansStore.get(ctx, MAIN_ID))!.plan).toEqual(two);
    expect((await save({ ...two, spending: 41_000 }, r.body.updated_at)).status).toBe(200);
  });

  test('facts unchanged from those loaded: none written, and another device’s age stands', async () => {
    await firePlansStore.set(ctx, MAIN_ID, entry());
    await planFactsStore.set(ctx, facts({ age: 50 }));
    // Loaded at 40; another device has saved 50 since.
    const r = await save({ ...TYPED2, spending: 41_000 });
    expect(r.status).toBe(200);
    expect((await planFactsStore.get(ctx))!.age).toBe(50);
    expect(r.body.plan).toEqual({ ...TYPED2, spending: 41_000, age: 50 });
  });

  test('facts changed from those loaded: written for every plan', async () => {
    await firePlansStore.set(ctx, MAIN_ID, entry());
    await firePlansStore.set(ctx, 'x', entry({ name: 'Copy', createdAt: '2026-11-02T10:00:00.000Z' }));
    await planFactsStore.set(ctx, facts());
    const r = await save({ ...TYPED2, age: 41 });
    expect(r.status).toBe(200);
    expect(await planFactsStore.get(ctx)).toEqual(facts({ age: 41 }));
    expect((await list()).body.plans[1].plan.age).toBe(41);
  });

  test('facts changed over facts changed elsewhere: refused, and nothing written', async () => {
    await firePlansStore.set(ctx, MAIN_ID, entry());
    await planFactsStore.set(ctx, facts({ age: 50 }));
    const before = await raw();
    expect(await save({ ...TYPED2, age: 41 })).toEqual({ status: 409, body: { error: OTHER_DEVICE, stale: true } });
    expect(await raw()).toEqual(before);
  });

  test('without the facts: a change makes them, from your entry’s fields, and goes into the entry', async () => {
    await firePlansStore.set(ctx, MAIN_ID, entry());
    expect((await save({ ...TYPED2, age: 41 })).status).toBe(200);
    expect((await firePlansStore.get(ctx, MAIN_ID))!.plan.age).toBe(41);
    expect(await planFactsStore.get(ctx)).toEqual(facts({ age: 41 }));
  });

  test('a refusal before the first write leaves every entry and the facts byte for byte', async () => {
    await firePlansStore.set(ctx, MAIN_ID, entry({ updatedAt: 'stamp-1' }));
    await planFactsStore.set(ctx, facts());
    const before = await raw();
    expect((await save({ ...TYPED2, age: 41 }, 'stamp-0')).status).toBe(409);
    expect(await raw()).toEqual(before);
  });

  test('a refusal at the entry’s write after the facts landed says so, the entry as it was, the facts new', async () => {
    await firePlansStore.set(ctx, MAIN_ID, entry({ updatedAt: 'stamp-1' }));
    await planFactsStore.set(ctx, facts());
    between(() => firePlansStore.update(ctx, MAIN_ID, (cur) => ({ ...cur!, updatedAt: 'stamp-2' })));
    const r = await quiet(() => save({ ...TYPED2, age: 41 }, 'stamp-1'));
    expect(r).toEqual({ status: 409, body: { error: PARTIAL, stale: true } });
    expect(await firePlansStore.get(ctx, MAIN_ID)).toEqual(entry({ updatedAt: 'stamp-2' }));
    expect(await planFactsStore.get(ctx)).toEqual(facts({ age: 41 }));
  });

  test('an entry deleted mid-save isn’t made again', async () => {
    await firePlansStore.set(ctx, MAIN_ID, entry());
    await firePlansStore.set(ctx, 'x', entry({ name: 'Other', createdAt: '2026-11-02T10:00:00.000Z' }));
    between(() => firePlansStore.remove(ctx, MAIN_ID));
    expect(await save(TYPED2)).toEqual({ status: 409, body: { error: CHANGED, stale: true } });
    expect(await firePlansStore.ids(ctx)).toEqual(['x']);
  });

  test('the currency: another over typed amounts refused, a first over nothing typed taken, nothing typed keeps the entry’s', async () => {
    await firePlansStore.set(ctx, MAIN_ID, entry());
    expect(await save(TYPED2, AT, { currency: 'EUR' })).toEqual({ status: 409, body: { error: STALE_CURRENCY, stale: true } });
    await firePlansStore.set(ctx, MAIN_ID, entry({ plan: DEFAULT_PLAN, currency: 'USD' }));
    const blank = await save({ ...BLANK2, targetAge: 60 }, AT, { currency: 'EUR', facts_were: factsOf(DEFAULT_PLAN) });
    expect(blank.status).toBe(200);
    expect((await firePlansStore.get(ctx, MAIN_ID))!.currency).toBe('USD');
    const r = await save(TYPED2, blank.body.updated_at, { currency: 'EUR', facts_were: factsOf(DEFAULT_PLAN) });
    expect([r.status, r.body.currency]).toEqual([200, 'EUR']);
    expect((await firePlansStore.get(ctx, MAIN_ID))!.currency).toBe('EUR');
  });

  test('first amounts with no currency over an entry holding none: refused, the currency it kept never theirs', async () => {
    await firePlansStore.set(ctx, MAIN_ID, entry({ plan: DEFAULT_PLAN, currency: 'EUR' }));
    const before = await raw();
    expect(await save(TYPED2, AT, { currency: null, facts_were: factsOf(DEFAULT_PLAN) })).toEqual({ status: 409, body: { error: FIRST_CURRENCY } });
    expect(await raw()).toEqual(before);
    // Over amounts, a save with no currency keeps the entry's: theirs.
    await firePlansStore.set(ctx, MAIN_ID, entry());
    const kept = await save({ ...TYPED2, spending: 41_000 }, AT, { currency: null });
    expect([kept.status, kept.body.currency]).toEqual([200, 'USD']);
  });

  test('a save in another currency over a version 2 entry whose only amount is a pension is refused', async () => {
    const two = { ...BLANK2, items: [pension] };
    await firePlansStore.set(ctx, MAIN_ID, entry({ plan: two, currency: 'USD' }));
    expect(await save({ ...two, targetAge: 60 }, AT, { currency: 'EUR', facts_were: factsOf(two) })).toEqual({ status: 409, body: { error: STALE_CURRENCY, stale: true } });
  });
});

describe('recording the currency (POST)', () => {
  const amounts = typedAmounts(TYPED);

  test('over nothing typed refused; a first one taken; a change only when the person answered', async () => {
    await firePlansStore.set(ctx, MAIN_ID, entry({ plan: DEFAULT_PLAN, currency: null }));
    expect((await post({ currency: 'USD', amounts: typedAmounts(DEFAULT_PLAN) })).status).toBe(409);
    await firePlansStore.set(ctx, MAIN_ID, entry({ currency: null }));
    const first = await post({ currency: 'USD', amounts });
    expect([first.status, first.body.currency, first.body.id]).toEqual([200, 'USD', MAIN_ID]);
    expect(first.body.updated_at > AT).toBe(true);
    expect((await post({ currency: 'EUR', amounts })).status).toBe(409);
    expect((await firePlansStore.get(ctx, MAIN_ID))!.currency).toBe('USD');
    expect((await post({ currency: 'EUR', amounts, answered: true })).body.currency).toBe('EUR');
  });

  test('for amounts other than the entry’s, refused as stale, including a save landing between its read and its write', async () => {
    await firePlansStore.set(ctx, MAIN_ID, entry({ currency: null }));
    expect((await post({ currency: 'USD', amounts: typedAmounts({ ...TYPED, spending: 1 }) })).body.stale).toBe(true);
    const store = firePlansStore as unknown as { updateMany: (...a: unknown[]) => Promise<unknown> };
    const real = store.updateMany;
    store.updateMany = async (...args: unknown[]) => {
      store.updateMany = real;
      await firePlansStore.update(ctx, MAIN_ID, (cur) => ({ ...cur!, plan: { ...TYPED, spending: 99_000 } }));
      return real.apply(firePlansStore, args);
    };
    const r = await post({ currency: 'USD', amounts });
    expect([r.status, r.body.stale]).toEqual([409, true]);
    expect((await firePlansStore.get(ctx, MAIN_ID))!.currency).toBeNull();
  });

  test('what it takes is checked', async () => {
    await firePlansStore.set(ctx, MAIN_ID, entry({ currency: null }));
    for (const body of [[], { currency: 'usd', amounts }, { currency: 'USD' }, { currency: 'USD', amounts: { spending: 1 } }, { currency: 'USD', amounts, also: 1 }, { currency: 'USD', amounts, answered: 'yes' }]) {
      expect((await post(body)).status).toBe(400);
    }
    expect((await firePlansStore.get(ctx, MAIN_ID))!.currency).toBeNull();
  });
});
