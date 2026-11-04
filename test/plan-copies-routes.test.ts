import { describe, expect, test, mock, beforeEach, afterEach } from 'bun:test';
import { FakeRedis, storageMock, TEST_CTX, ctxKey, registerTestContainer, unscopedDataKeys } from './fake-redis';
import type { FirePlan, PlanIncome } from '@/lib/fire/plan';
import type { PlanEntry, PlanFacts } from '@/lib/fire/copies';

// The plan once a newer release has made the plans copies (lib/plan-copies.ts),
// through the routes: GET /api/fire-plan and /api/plan-inputs answer your
// plan's entry, PUT and POST save into it on the rules of app/api/fire-plan
// (the stamp, the version, the facts as the page loaded them, the currency),
// the scenario routes name the copies and save nothing, and nothing here ever
// makes either store.

process.env.PLAID_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');

const fake = new FakeRedis({ deserialize: true });
afterEach(() => expect(unscopedDataKeys(fake)).toEqual([]));
mock.module('@/lib/storage', () => storageMock(fake));

const { encrypt } = await import('@/lib/crypto');
const { firePlanStore, planCurrencyStore } = await import('@/lib/fire-plan');
const { firePlansStore, planFactsStore } = await import('@/lib/plan-copies');
const { planScenariosStore } = await import('@/lib/plan-scenarios');
const { DEFAULT_PLAN } = await import('@/lib/fire/plan');
const { planOf } = await import('@/lib/fire/plan-v2');
const { itemFromIncome } = await import('@/lib/fire/items');
const { MAIN_ID, factsOf } = await import('@/lib/fire/copies');
const { currencyRecord, typedAmounts } = await import('@/lib/fire/plan-currency');
const planRoute = await import('@/app/api/fire-plan/route');
const inputsRoute = await import('@/app/api/plan-inputs/route');
const scenariosRoute = await import('@/app/api/plan-scenarios/route');

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

const income = (over: Partial<PlanIncome> = {}): PlanIncome => ({ id: 'ss', label: 'Social Security', amount: 24_000, fromAge: 67, inflationAdjusted: true, ...over });
const TYPED: FirePlan = { ...DEFAULT_PLAN, age: 40, targetAge: 55, spending: 40_000, income: [income()] };
const entry = (over: Partial<PlanEntry> = {}): PlanEntry => ({ name: 'First plan', plan: TYPED, tax: null, currency: 'USD', createdAt: AT, updatedAt: AT, ...over });
const facts = (over: Partial<PlanFacts> = {}): PlanFacts => ({ version: 1, main: MAIN_ID, ...factsOf(TYPED), ...over });
const pension = { ...itemFromIncome(income({ id: 'pen', label: 'Pension' })), kind: 'pension' as const };

const json = async (res: Response) => ({ status: res.status, body: await res.json() });
const req = (path: string, method: string, body?: unknown) =>
  new Request(`http://localhost/api/${path}`, { method, ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }) });
const get = async () => json(await planRoute.GET());
const put = async (body: unknown) => json(await planRoute.PUT(req('fire-plan', 'PUT', body)));
const post = async (body: unknown) => json(await planRoute.POST(req('fire-plan', 'POST', body)));
const inputs = async () => json(await inputsRoute.GET(req('plan-inputs', 'GET')));
const scenarios = async (method: 'GET' | 'POST' | 'PUT' | 'DELETE', body?: unknown) =>
  json(method === 'GET' ? await scenariosRoute.GET() : await (scenariosRoute[method] as (r: Request) => Promise<Response>)(req('plan-scenarios', method, body)));

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
const raw = async () => ({ plans: await fake.hgetall(ctxKey('fire-plans')), facts: await fake.get(ctxKey('plan-facts')) });

/** Runs `before` just before the store's next compare-and-set reads, as
 *  another device's write landing between this save's read and its write. */
function between(store: { update: (...a: any[]) => Promise<unknown> }, before: () => Promise<unknown>) {
  const update = store.update;
  store.update = async (...args: any[]) => {
    store.update = update;
    await before();
    return update.apply(store, args);
  };
  return () => (store.update = update);
}

/** The legacy plan and its record, as every account has them until copies. */
async function legacy(plan: FirePlan = { ...DEFAULT_PLAN, spending: 30_000 }) {
  await firePlanStore.set(ctx, plan);
  await planCurrencyStore.set(ctx, currencyRecord(plan, 'EUR'));
  return plan;
}

describe('the plan read, before copies', () => {
  test('is the plan and its record, as before; the facts alone change nothing', async () => {
    const plan = await legacy();
    const before = await get();
    expect(before).toEqual({ status: 200, body: { plan, currency: 'EUR' } });
    await planFactsStore.set(ctx, facts({ age: 60 }));
    expect(await get()).toEqual(before);
    expect((await inputs()).body).toEqual({ plan, currency: 'EUR', plans: [] });
  });

  test('a damaged facts value beside no copies is never read into the answer', async () => {
    const plan = await legacy();
    await fake.set(ctxKey('plan-facts'), DAMAGED);
    expect(await get()).toEqual({ status: 200, body: { plan, currency: 'EUR' } });
    expect((await inputs()).status).toBe(200);
  });
});

describe('the plan read, once there are copies', () => {
  test('is your plan’s entry, with the facts in its fields, its currency and its stamp; the legacy plan isn’t read', async () => {
    await legacy();
    await firePlansStore.set(ctx, MAIN_ID, entry({ updatedAt: 'stamp-1' }));
    await planFactsStore.set(ctx, facts({ age: 50, includeCash: true }));
    const want = { plan: { ...TYPED, age: 50, includeCash: true }, currency: 'USD', updated_at: 'stamp-1' };
    expect(await get()).toEqual({ status: 200, body: want });
    expect((await inputs()).body).toEqual({ ...want, plans: [] });
  });

  test('without the facts, the entry’s own fields are them', async () => {
    await firePlansStore.set(ctx, MAIN_ID, entry());
    expect((await get()).body).toEqual({ plan: TYPED, currency: 'USD', updated_at: AT });
  });

  test('a partner’s age in the facts reads a version 1 entry as version 2', async () => {
    await firePlansStore.set(ctx, MAIN_ID, entry());
    await planFactsStore.set(ctx, facts({ partnerAge: 38 }));
    expect((await get()).body.plan).toEqual({ ...planOf(TYPED), partnerAge: 38 });
  });

  test('an entry with nothing typed answers no currency, so the Plan follows the accounts', async () => {
    await firePlansStore.set(ctx, MAIN_ID, entry({ plan: DEFAULT_PLAN, currency: 'USD' }));
    expect((await get()).body.currency).toBeNull();
  });

  test('a version 2 entry whose only amount is a pension answers its currency', async () => {
    await firePlansStore.set(ctx, MAIN_ID, entry({ plan: { ...planOf(DEFAULT_PLAN), items: [pension] }, currency: 'EUR' }));
    expect((await get()).body.currency).toBe('EUR');
  });

  test('the facts naming a plan not there: main, else the oldest, and the scenario list says so', async () => {
    await firePlansStore.set(ctx, MAIN_ID, entry());
    await firePlansStore.set(ctx, 'x', entry({ name: 'Stop at 52', plan: { ...TYPED, targetAge: 52 }, createdAt: '2026-11-02T10:00:00.000Z' }));
    await planFactsStore.set(ctx, facts({ main: 'gone' }));
    expect((await get()).body.plan.targetAge).toBe(55);
    expect((await scenarios('GET')).body.copies).toEqual({ names: ['Stop at 52'], count: 1, main: { name: 'First plan', missing: true } });
    await firePlansStore.remove(ctx, MAIN_ID);
    expect((await get()).body.plan.targetAge).toBe(52);
    expect((await scenarios('GET')).body.copies).toEqual({ names: [], count: 0, main: { name: 'Stop at 52', missing: true } });
  });

  test('main there without the facts: yours, nothing said; no main and no facts: the oldest, said', async () => {
    await firePlansStore.set(ctx, MAIN_ID, entry());
    expect((await scenarios('GET')).body.copies.main).toEqual({ name: 'First plan', missing: false });
    await firePlansStore.remove(ctx, MAIN_ID);
    await firePlansStore.set(ctx, 'b', entry({ name: 'Later', createdAt: '2026-11-03T10:00:00.000Z' }));
    await firePlansStore.set(ctx, 'a', entry({ name: 'Earlier', createdAt: '2026-11-02T10:00:00.000Z' }));
    expect((await scenarios('GET')).body.copies).toEqual({ names: ['Later'], count: 1, main: { name: 'Earlier', missing: true } });
  });

  test('a copy that can’t be read never stops it, and is counted, not named', async () => {
    await firePlansStore.set(ctx, MAIN_ID, entry());
    await firePlansStore.set(ctx, 'x', entry({ name: 'Stop at 52', createdAt: '2026-11-02T10:00:00.000Z' }));
    await damageEntry('broken');
    await fake.hset(ctxKey('fire-plans'), { later: await encrypt(ctx, JSON.stringify({ ...entry(), tax: { filing: 'single' } })) });
    expect((await get()).status).toBe(200);
    const listed = await scenarios('GET');
    expect(listed.body).toEqual({ scenarios: [], unreadable_ids: [], unrecognised_ids: ['x', 'broken', 'later'], copies: { names: ['Stop at 52'], count: 3, main: { name: 'First plan', missing: false } } });
  });

  test('a damaged legacy plan or record beside copies never stops it', async () => {
    await fake.set(ctxKey('fire-plan'), DAMAGED);
    await fake.set(ctxKey('fire-plan-currency'), DAMAGED);
    await firePlansStore.set(ctx, MAIN_ID, entry());
    expect((await get()).status).toBe(200);
    expect((await inputs()).status).toBe(200);
  });

  test('damaged facts beside copies: unreadable everywhere, never the legacy plan or the defaults', async () => {
    await legacy();
    await firePlansStore.set(ctx, MAIN_ID, entry());
    await fake.set(ctxKey('plan-facts'), DAMAGED);
    await quiet(async () => {
      for (const r of [await get(), await inputs(), await put({ plan: TYPED, currency: 'USD' }), await post({ currency: 'USD', amounts: typedAmounts(TYPED) }), await scenarios('GET')]) {
        expect([r.status, r.body.unreadable]).toEqual([409, true]);
      }
    });
    expect(await firePlanStore.get(ctx)).toEqual({ ...DEFAULT_PLAN, spending: 30_000 });
  });

  test('your entry can’t be read: unreadable, whether named, main, or every one there', async () => {
    await quiet(async () => {
      await damageEntry(MAIN_ID);
      await firePlansStore.set(ctx, 'x', entry());
      expect([(await get()).status, (await get()).body.unreadable]).toEqual([409, true]);
      await firePlansStore.set(ctx, MAIN_ID, entry());
      await damageEntry('x');
      await planFactsStore.set(ctx, facts({ main: 'x' }));
      expect([(await get()).status, (await scenarios('GET')).status, (await put({ plan: TYPED, currency: 'USD' })).status]).toEqual([409, 409, 409]);
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

  test('is read, and the scenario list names main among the copies', async () => {
    expect((await get()).body).toEqual({ plan: X.plan, currency: 'USD', updated_at: 'x-1' });
    expect((await scenarios('GET')).body.copies).toEqual({ names: ['First plan'], count: 1, main: { name: 'Stop at 52', missing: false } });
  });

  test('is the one PUT and POST write, main left byte for byte', async () => {
    const main = (await fake.hgetall<Record<string, string>>(ctxKey('fire-plans')))![MAIN_ID];
    expect((await put({ plan: { ...TYPED, targetAge: 53 }, currency: 'USD', facts_were: factsOf(TYPED) })).status).toBe(200);
    expect((await firePlansStore.get(ctx, 'x'))!.plan.targetAge).toBe(53);
    await firePlansStore.update(ctx, 'x', (cur) => ({ ...cur!, currency: null }));
    expect((await post({ currency: 'EUR', amounts: typedAmounts({ ...TYPED, targetAge: 53 }) })).status).toBe(200);
    expect((await firePlansStore.get(ctx, 'x'))!.currency).toBe('EUR');
    expect((await fake.hgetall<Record<string, string>>(ctxKey('fire-plans')))![MAIN_ID]).toBe(main);
  });
});

describe('saving your plan (PUT)', () => {
  test('any key but the plan, its currency, the facts it was loaded with and the stamp is refused, copies or not', async () => {
    expect(await put({ plan: TYPED, scenario: 'x' })).toEqual({ status: 400, body: { error: 'scenario isn’t taken here' } });
    await firePlansStore.set(ctx, MAIN_ID, entry());
    expect((await put({ plan: TYPED, currency: 'USD', id: 'x' })).status).toBe(400);
    expect((await put({ plan: TYPED, facts_were: { age: 'forty' } })).status).toBe(400);
    expect((await put({ plan: TYPED, based_on: 7 })).status).toBe(400);
  });

  test('before copies: today’s save, facts_were and based_on ignored, a version 2 plan refused, and neither store made', async () => {
    const r = await put({ plan: TYPED, currency: 'USD', facts_were: factsOf({ ...TYPED, age: 70 }), based_on: 'whatever' });
    expect(r).toEqual({ status: 200, body: { plan: TYPED, currency: 'USD' } });
    expect(await firePlanStore.get(ctx)).toEqual(TYPED);
    expect((await put({ plan: planOf(TYPED) })).status).toBe(400);
    expect([await firePlansStore.count(ctx), await planFactsStore.get(ctx)]).toEqual([0, null]);
  });

  test('once there are copies: into your entry with a newer stamp, never the legacy plan', async () => {
    const was = await legacy();
    await firePlansStore.set(ctx, MAIN_ID, entry());
    await planFactsStore.set(ctx, facts());
    const next = { ...TYPED, spending: 45_000 };
    const r = await put({ plan: next, currency: 'USD', facts_were: factsOf(TYPED) });
    expect(r.status).toBe(200);
    const stored = (await firePlansStore.get(ctx, MAIN_ID))!;
    expect(stored).toEqual({ ...entry(), plan: next, updatedAt: stored.updatedAt });
    expect(stored.updatedAt > AT).toBe(true);
    expect(r.body).toEqual({ plan: next, currency: 'USD', updated_at: stored.updatedAt });
    expect(await firePlanStore.get(ctx)).toEqual(was);
  });

  test('the stamp sent: matching taken, another refused, none taken', async () => {
    await firePlansStore.set(ctx, MAIN_ID, entry({ updatedAt: 'stamp-1' }));
    expect(await put({ plan: TYPED, currency: 'USD', based_on: 'stamp-0' })).toEqual({ status: 409, body: { error: CHANGED, stale: true } });
    const ok = await put({ plan: TYPED, currency: 'USD', based_on: 'stamp-1' });
    expect(ok.status).toBe(200);
    expect((await put({ plan: TYPED, currency: 'USD' })).status).toBe(200);
  });

  test('a version 1 plan over a version 2 entry is refused, so nothing it can’t show is dropped; version 2 is taken', async () => {
    const two = { ...planOf(TYPED), items: [...planOf(TYPED).items, pension] };
    await firePlansStore.set(ctx, MAIN_ID, entry({ plan: two }));
    expect(await put({ plan: TYPED, currency: 'USD' })).toEqual({ status: 409, body: { error: CHANGED, stale: true } });
    const r = await put({ plan: { ...two, spending: 41_000 }, currency: 'USD' });
    expect(r.status).toBe(200);
    expect((await firePlansStore.get(ctx, MAIN_ID))!.plan).toEqual({ ...two, spending: 41_000 });
  });

  test('facts unchanged from those loaded: none written, and another device’s age stands', async () => {
    await firePlansStore.set(ctx, MAIN_ID, entry());
    await planFactsStore.set(ctx, facts({ age: 50 }));
    // Loaded at 40; another device has saved 50 since.
    const r = await put({ plan: { ...TYPED, spending: 41_000 }, currency: 'USD', facts_were: factsOf(TYPED) });
    expect(r.status).toBe(200);
    expect((await planFactsStore.get(ctx))!.age).toBe(50);
    expect(r.body.plan).toEqual({ ...TYPED, spending: 41_000, age: 50 });
  });

  test('facts changed from those loaded: written for every plan', async () => {
    await firePlansStore.set(ctx, MAIN_ID, entry());
    await planFactsStore.set(ctx, facts());
    const r = await put({ plan: { ...TYPED, age: 41 }, currency: 'USD', facts_were: factsOf(TYPED) });
    expect(r.status).toBe(200);
    expect(await planFactsStore.get(ctx)).toEqual(facts({ age: 41 }));
  });

  test('facts changed over facts changed elsewhere: refused, and nothing written', async () => {
    await firePlansStore.set(ctx, MAIN_ID, entry());
    await planFactsStore.set(ctx, facts({ age: 50 }));
    const before = await raw();
    expect(await put({ plan: { ...TYPED, age: 41 }, currency: 'USD', facts_were: factsOf(TYPED) })).toEqual({ status: 409, body: { error: OTHER_DEVICE, stale: true } });
    expect(await raw()).toEqual(before);
  });

  test('from the release before’s page (no facts sent): taken only with the facts as they are', async () => {
    await firePlansStore.set(ctx, MAIN_ID, entry());
    await planFactsStore.set(ctx, facts());
    expect((await put({ plan: { ...TYPED, spending: 41_000 }, currency: 'USD' })).status).toBe(200);
    expect(await put({ plan: { ...TYPED, age: 41 }, currency: 'USD' })).toEqual({ status: 409, body: { error: CHANGED, stale: true } });
    expect((await planFactsStore.get(ctx))!.age).toBe(40);
  });

  test('without the facts: a change goes into the entry, and never makes them', async () => {
    await firePlansStore.set(ctx, MAIN_ID, entry());
    expect((await put({ plan: { ...TYPED, age: 41 }, currency: 'USD', facts_were: factsOf(TYPED) })).status).toBe(200);
    expect((await firePlansStore.get(ctx, MAIN_ID))!.plan.age).toBe(41);
    expect(await planFactsStore.get(ctx)).toBeNull();
  });

  test('without the facts, an age saved elsewhere between the read and the write: refused for a save changing it, kept by one that doesn’t', async () => {
    await firePlansStore.set(ctx, MAIN_ID, entry());
    const elsewhere = () => firePlansStore.update(ctx, MAIN_ID, (cur) => ({ ...cur!, plan: { ...cur!.plan, age: 50 } }));
    between(firePlansStore, elsewhere);
    expect(await put({ plan: { ...TYPED, age: 41 }, currency: 'USD', facts_were: factsOf(TYPED) })).toEqual({ status: 409, body: { error: OTHER_DEVICE, stale: true } });
    expect((await firePlansStore.get(ctx, MAIN_ID))!.plan.age).toBe(50);
    await firePlansStore.set(ctx, MAIN_ID, entry());
    between(firePlansStore, elsewhere);
    expect((await put({ plan: { ...TYPED, spending: 41_000 }, currency: 'USD', facts_were: factsOf(TYPED) })).status).toBe(200);
    expect((await firePlansStore.get(ctx, MAIN_ID))!.plan).toEqual({ ...TYPED, spending: 41_000, age: 50 });
  });

  test('a refusal before the first write leaves every entry and the facts byte for byte', async () => {
    await firePlansStore.set(ctx, MAIN_ID, entry({ updatedAt: 'stamp-1' }));
    await planFactsStore.set(ctx, facts());
    const before = await raw();
    expect((await put({ plan: { ...TYPED, age: 41 }, currency: 'USD', facts_were: factsOf(TYPED), based_on: 'stamp-0' })).status).toBe(409);
    expect(await raw()).toEqual(before);
  });

  test('a refusal at the entry’s write after the facts landed says so, the entry as it was, the facts new', async () => {
    await firePlansStore.set(ctx, MAIN_ID, entry({ updatedAt: 'stamp-1' }));
    await planFactsStore.set(ctx, facts());
    between(firePlansStore, () => firePlansStore.update(ctx, MAIN_ID, (cur) => ({ ...cur!, updatedAt: 'stamp-2' })));
    const r = await quiet(() => put({ plan: { ...TYPED, age: 41 }, currency: 'USD', facts_were: factsOf(TYPED), based_on: 'stamp-1' }));
    expect(r).toEqual({ status: 409, body: { error: PARTIAL, stale: true } });
    expect(await firePlansStore.get(ctx, MAIN_ID)).toEqual(entry({ updatedAt: 'stamp-2' }));
    expect(await planFactsStore.get(ctx)).toEqual(facts({ age: 41 }));
  });

  test('an entry deleted mid-save isn’t made again', async () => {
    await firePlansStore.set(ctx, MAIN_ID, entry());
    await firePlansStore.set(ctx, 'x', entry({ name: 'Other', createdAt: '2026-11-02T10:00:00.000Z' }));
    between(firePlansStore, () => firePlansStore.remove(ctx, MAIN_ID));
    expect(await put({ plan: TYPED, currency: 'USD', facts_were: factsOf(TYPED) })).toEqual({ status: 409, body: { error: CHANGED, stale: true } });
    expect(await firePlansStore.ids(ctx)).toEqual(['x']);
  });

  test('the currency: another over typed amounts refused, a first over nothing typed taken, nothing typed keeps the entry’s', async () => {
    await firePlansStore.set(ctx, MAIN_ID, entry());
    expect(await put({ plan: TYPED, currency: 'EUR' })).toEqual({ status: 409, body: { error: STALE_CURRENCY, stale: true } });
    await firePlansStore.set(ctx, MAIN_ID, entry({ plan: DEFAULT_PLAN, currency: 'USD' }));
    expect((await put({ plan: { ...DEFAULT_PLAN, targetAge: 60 }, currency: 'EUR' })).status).toBe(200);
    expect((await firePlansStore.get(ctx, MAIN_ID))!.currency).toBe('USD');
    const r = await put({ plan: TYPED, currency: 'EUR', facts_were: factsOf(DEFAULT_PLAN) });
    expect([r.status, r.body.currency]).toEqual([200, 'EUR']);
    expect((await firePlansStore.get(ctx, MAIN_ID))!.currency).toBe('EUR');
  });

  test('a save in another currency over a version 2 entry whose only amount is a pension is refused', async () => {
    const two = { ...planOf(DEFAULT_PLAN), items: [pension] };
    await firePlansStore.set(ctx, MAIN_ID, entry({ plan: two, currency: 'USD' }));
    expect(await put({ plan: { ...two, targetAge: 60 }, currency: 'EUR' })).toEqual({ status: 409, body: { error: STALE_CURRENCY, stale: true } });
  });
});

describe('recording the currency (POST), once there are copies', () => {
  const amounts = typedAmounts(TYPED);

  test('over nothing typed refused; a first one taken; a change only when the person answered', async () => {
    await firePlansStore.set(ctx, MAIN_ID, entry({ plan: DEFAULT_PLAN, currency: null }));
    expect((await post({ currency: 'USD', amounts: typedAmounts(DEFAULT_PLAN) })).status).toBe(409);
    await firePlansStore.set(ctx, MAIN_ID, entry({ currency: null }));
    const first = await post({ currency: 'USD', amounts });
    expect([first.status, first.body.currency]).toEqual([200, 'USD']);
    expect((await post({ currency: 'EUR', amounts })).status).toBe(409);
    expect((await firePlansStore.get(ctx, MAIN_ID))!.currency).toBe('USD');
    expect((await post({ currency: 'EUR', amounts, answered: true })).body.currency).toBe('EUR');
  });

  test('for amounts other than the entry’s, refused as stale, including a save landing between its read and its write', async () => {
    await firePlansStore.set(ctx, MAIN_ID, entry({ currency: null }));
    expect((await post({ currency: 'USD', amounts: typedAmounts({ ...TYPED, spending: 1 }) })).body.stale).toBe(true);
    between(firePlansStore, () => firePlansStore.update(ctx, MAIN_ID, (cur) => ({ ...cur!, plan: { ...TYPED, spending: 99_000 } })));
    const r = await post({ currency: 'USD', amounts });
    expect([r.status, r.body.stale]).toEqual([409, true]);
    expect((await firePlansStore.get(ctx, MAIN_ID))!.currency).toBeNull();
  });
});

describe('the scenario routes, once there are copies', () => {
  test('list no scenario, name the copies, and save nothing, even with only your plan there', async () => {
    await planScenariosStore.set(ctx, 'sc1', { version: 1, name: 'Old', currency: null, createdAt: AT, savedAt: AT, rev: 'r1', set: {}, income: { leaveOut: [], add: [] }, expenses: { leaveOut: [], add: [] }, events: [] });
    await firePlansStore.set(ctx, MAIN_ID, entry());
    expect((await scenarios('GET')).body).toEqual({ scenarios: [], unreadable_ids: [], unrecognised_ids: [], copies: { names: [], count: 0, main: { name: 'First plan', missing: false } } });
    const draft = { name: 'New', currency: null, set: {}, income: { leaveOut: [], add: [] }, expenses: { leaveOut: [], add: [] }, events: [] };
    for (const r of [await scenarios('POST', { scenario: draft }), await scenarios('PUT', { id: 'sc1', scenario: draft, based_on: 'r1' }), await scenarios('DELETE', { id: 'sc1' })]) {
      expect(r).toEqual({ status: 409, body: { error: CHANGED, stale: true } });
    }
    expect(await planScenariosStore.ids(ctx)).toEqual(['sc1']);
  });
});

describe('nothing here makes either store', () => {
  test('saving the plan, its currency and a scenario before copies', async () => {
    expect((await put({ plan: TYPED, currency: 'USD', facts_were: factsOf(TYPED) })).status).toBe(200);
    expect((await post({ currency: 'EUR', amounts: typedAmounts(TYPED), answered: true })).status).toBe(200);
    const draft = { name: 'New', currency: 'USD', set: { targetAge: 50 }, income: { leaveOut: [], add: [] }, expenses: { leaveOut: [], add: [] }, events: [] };
    expect((await scenarios('POST', { scenario: draft })).status).toBe(200);
    expect([await firePlansStore.count(ctx), await planFactsStore.get(ctx)]).toEqual([0, null]);
    expect([await fake.type(ctxKey('fire-plans')), await fake.type(ctxKey('plan-facts'))]).toEqual(['none', 'none']);
  });
});
