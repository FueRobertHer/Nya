import { describe, expect, test, mock, beforeEach, afterEach } from 'bun:test';
import { FakeRedis, storageMock, TEST_CTX, ctxKey, registerTestContainer, unscopedDataKeys } from './fake-redis';
import './clerk-mock';
import type { FirePlanV2 } from '@/lib/fire/plan-v2';

// The currency the Plan's figures are in: kept in your plan's entry
// (`fire-plans`, lib/plan-copies.ts) beside the amounts it is the currency
// of, written in the same write as they are, and answered with the plan
// (app/api/fire-plan). What each save records, what recording it alone
// takes, and the download and a restore. The record the plan before copies
// kept beside it (lib/fire-plan.ts planCurrencyStore) stays declared, so a
// download and a restore still carry its bytes, but nothing reads it any
// more, damaged, a newer version's or whole: the first write removes it. The
// release before reads the currency in each entry
// (test/release-before-plans.test.ts).

process.env.PLAID_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
process.env.APP_PASSWORD = 'hunter2';
process.env.RESTORE_UNDO_PAUSE_MS = '0';

const fake = new FakeRedis({ deserialize: true });
afterEach(() => expect(unscopedDataKeys(fake)).toEqual([]));
mock.module('@/lib/storage', () => storageMock(fake));

const { encrypt, decrypt } = await import('@/lib/crypto');
const { firePlanStore, planCurrencyStore } = await import('@/lib/fire-plan');
const { firePlansStore } = await import('@/lib/plan-copies');
const { declaredStore } = await import('@/lib/stores');
const { DEFAULT_PLAN } = await import('@/lib/fire/plan');
const { DEFAULT_PLAN_V2 } = await import('@/lib/fire/plan-v2');
const { MAIN_ID, factsOf } = await import('@/lib/fire/copies');
const { currencyRecord, typedAmounts } = await import('@/lib/fire/plan-currency');
const { classify } = await import('@/lib/reencrypt');
const { SEAM } = await import('@/lib/user-restore/parts');
const route = await import('@/app/api/fire-plan/route');
const { downloadText, restoreAll, EXPORTED } = await import('./restore-run');

beforeEach(async () => {
  fake.reset();
  (await import('@/lib/sessions')).forgetEpochs();
  await registerTestContainer(fake);
  process.env.RESTORE_ENABLED = '1';
});

const plan = (over: Partial<FirePlanV2> = {}): FirePlanV2 => ({ ...DEFAULT_PLAN_V2, ...over });
const TYPED = plan({ age: 40, targetAge: 55, spending: 40_000, savings: 30_000 });
const NO_PLAN = { id: MAIN_ID, plan: null, currency: null, updated_at: null };
const put = (body: unknown) => route.PUT(new Request('http://x', { method: 'PUT', body: JSON.stringify(body) }));
const post = (body: unknown) => route.POST(new Request('http://x', { method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body) }));
const get = async () => (await route.GET()).json();
/** Your plan's save as a page sends it: loaded at `based_on`, with the
 *  facts it holds (none of these saves changes one but where said). */
const save = async (p: FirePlanV2, currency: string | null, based_on: string | null, facts_were = factsOf(p)) => {
  const res = await put({ plan: p, currency, facts_were, based_on });
  return { status: res.status, body: await res.json() };
};
/** Your plan's first save. */
const first = async (p: FirePlanV2, currency: string | null) => {
  const r = await save(p, currency, null, factsOf(DEFAULT_PLAN_V2));
  expect(r.status).toBe(200);
  return r.body;
};
const mine = async () => (await firePlansStore.get(TEST_CTX, MAIN_ID))!;
const recordKey = ctxKey('fire-plan-currency');
const quiet = async <T>(f: () => Promise<T>): Promise<T> => {
  const orig = console.error;
  console.error = () => {};
  try {
    return await f();
  } finally {
    console.error = orig;
  }
};

describe('the record before copies', () => {
  test('is still declared on the seam beside the plan, in the download, and on the key inventory', () => {
    expect(planCurrencyStore.name).toBe('fire-plan-currency');
    expect(planCurrencyStore.kind).toBe('value');
    expect(declaredStore('fire-plan-currency')).toBe(planCurrencyStore);
    expect(planCurrencyStore.exportable).toBe(true);
    expect(SEAM['fire-plan-currency']).toEqual({ kind: 'value', restore: 'write' });
    expect(classify(recordKey.replace(/^[^:]+:(?=c:)/, ''))).toBe('string');
  });

  test('encrypted: neither the currency nor an amount is readable in the database', async () => {
    await planCurrencyStore.set(TEST_CTX, currencyRecord(DEFAULT_PLAN, 'EUR'));
    const raw = String(await fake.get(recordKey));
    expect(raw).not.toContain('"EUR"');
    expect(JSON.parse(await decrypt(TEST_CTX, raw))).toEqual({ version: 1, currency: 'EUR', amounts: typedAmounts(DEFAULT_PLAN) });
  });

  test('is never read, whole, damaged or a newer version’s: the plan is the defaults, and the first save removes it', async () => {
    const legacy = { ...DEFAULT_PLAN, age: 40, spending: 40_000 };
    for (const record of [
      async () => planCurrencyStore.set(TEST_CTX, currencyRecord(legacy, 'EUR')),
      async () => fake.set(recordKey, 'damaged-bytes-not-ciphertext-at-all'),
      async () => fake.set(recordKey, await encrypt(TEST_CTX, JSON.stringify({ version: 2, currency: 'EUR', amounts: typedAmounts(legacy), by: 'item' }))),
    ]) {
      fake.reset();
      await registerTestContainer(fake);
      await firePlanStore.set(TEST_CTX, legacy);
      await record();
      expect(await get()).toEqual(NO_PLAN);
      // Nothing to record a currency for: no plan is saved.
      expect((await post({ currency: 'EUR', amounts: typedAmounts(legacy), answered: true })).status).toBe(409);
      const saved = await first(TYPED, 'USD');
      expect(saved.currency).toBe('USD');
      expect([await fake.get(recordKey), await fake.get(ctxKey('fire-plan'))]).toEqual([null, null]);
    }
  });
});

describe('each save', () => {
  test('records the currency in your plan’s entry, in the same write as its amounts, and answers it', async () => {
    const saved = await first(TYPED, 'EUR');
    expect(saved).toEqual({ id: MAIN_ID, plan: TYPED, currency: 'EUR', updated_at: saved.updated_at });
    expect(await mine()).toMatchObject({ plan: TYPED, currency: 'EUR', updatedAt: saved.updated_at });
    expect(await get()).toEqual(saved);
    expect(await fake.get(recordKey)).toBeNull();
  });

  test('a save naming none keeps the currency over the amounts; first amounts with none are refused, and nothing written', async () => {
    const blank = await first(plan({ age: 40 }), null);
    expect(blank.currency).toBeNull();
    const before = await fake.hgetall<Record<string, string>>(ctxKey('fire-plans'));
    const refused = await save(TYPED, null, blank.updated_at);
    expect(refused).toEqual({ status: 409, body: { error: 'Say which currency your plan’s figures are in, then save again: nothing was saved.' } });
    expect(await fake.hgetall<Record<string, string>>(ctxKey('fire-plans'))).toEqual(before);
    const typed = await save(TYPED, 'USD', blank.updated_at);
    expect(typed.body.currency).toBe('USD');
    const kept = await save({ ...TYPED, spending: 50_000 }, null, typed.body.updated_at);
    expect([kept.status, kept.body.currency]).toEqual([200, 'USD']);
    expect((await mine()).currency).toBe('USD');
  });

  test('never changes what the figures mean: another currency over the amounts is refused, and nothing written', async () => {
    const saved = await first(TYPED, 'USD');
    const other = await save({ ...TYPED, spending: 41_000 }, 'EUR', saved.updated_at);
    expect(other).toEqual({ status: 409, body: { error: 'The currency your plan’s figures are in was changed since this page loaded it, so nothing was saved: load it again.', stale: true } });
    expect(await get()).toEqual(saved);
  });

  test('once the amounts are gone, the next ones may be in another currency', async () => {
    const saved = await first(TYPED, 'USD');
    const blank = await save(plan({ age: 40 }), null, saved.updated_at);
    expect([blank.status, blank.body.currency]).toEqual([200, null]);
    const euros = await save(TYPED, 'EUR', blank.body.updated_at);
    expect([euros.status, euros.body.currency]).toEqual([200, 'EUR']);
  });

  test('refuses a currency that isn’t a code, and saves nothing', async () => {
    const res = await put({ plan: TYPED, currency: 'Euro', facts_were: factsOf(DEFAULT_PLAN_V2), based_on: null });
    expect(res.status).toBe(400);
    expect(await fake.type(ctxKey('fire-plans'))).toBe('none');
  });

  test('a write that fails leaves the plan and its currency both as they were; one written with its reply lost holds both', async () => {
    const saved = await first(TYPED, 'USD');
    const plans = firePlansStore as unknown as Record<string, unknown>;
    const real = plans.updateMany as typeof firePlansStore.updateMany;
    const withWrite = async <T>(write: typeof firePlansStore.updateMany, f: () => Promise<T>) => {
      plans.updateMany = write;
      try {
        return await quiet(f);
      } finally {
        plans.updateMany = real;
      }
    };
    const dropped = await withWrite(async () => {
      throw new Error('connection reset');
    }, () => save({ ...TYPED, spending: 60_000 }, 'USD', saved.updated_at));
    expect(dropped.status).toBe(500);
    expect(await get()).toEqual(saved);
    const lost = await withWrite(async (...args) => {
      await real.apply(firePlansStore, args);
      throw new Error('timed out');
    }, () => save({ ...TYPED, spending: 60_000 }, 'USD', saved.updated_at));
    expect(lost.status).toBe(500);
    expect(await get()).toMatchObject({ plan: { ...TYPED, spending: 60_000 }, currency: 'USD' });
  });
});

describe('recording the currency alone', () => {
  test('for your plan as stored, with the amounts the page shows; a plan changed since is refused', async () => {
    const saved = await first(TYPED, 'USD');
    await firePlansStore.update(TEST_CTX, MAIN_ID, (cur) => ({ ...cur!, currency: null }));
    const stale = await post({ currency: 'USD', amounts: typedAmounts({ ...TYPED, spending: 45_000 }) });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ stale: true });
    expect((await mine()).currency).toBeNull();
    const res = await post({ currency: 'USD', amounts: typedAmounts(TYPED) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ id: MAIN_ID, plan: TYPED, currency: 'USD', updated_at: body.updated_at });
    expect(body.updated_at > saved.updated_at).toBe(true);
    // The plan itself is untouched.
    expect((await mine()).plan).toEqual(TYPED);
  });

  test('without the person’s answer, only over none: never to change one; the answer replaces it', async () => {
    await first(TYPED, 'USD');
    // The same, again: nothing to change.
    expect((await post({ currency: 'USD', amounts: typedAmounts(TYPED) })).status).toBe(200);
    const change = await post({ currency: 'EUR', amounts: typedAmounts(TYPED) });
    expect([change.status, (await change.json()).stale]).toEqual([409, true]);
    expect((await mine()).currency).toBe('USD');
    expect(await (await post({ currency: 'EUR', amounts: typedAmounts(TYPED), answered: true })).json()).toMatchObject({ plan: TYPED, currency: 'EUR' });
    expect((await mine()).currency).toBe('EUR');
  });

  test('nothing to record before your plan is saved, or for one with nothing typed; what it takes is checked', async () => {
    expect((await post({ currency: 'USD', amounts: typedAmounts(TYPED) })).status).toBe(409);
    await first(plan({ age: 40 }), null);
    expect((await post({ currency: 'USD', amounts: typedAmounts(DEFAULT_PLAN_V2) })).status).toBe(409);
    for (const body of ['{no', [], { currency: 'usd', amounts: typedAmounts(TYPED) }, { currency: 'USD' }, { currency: 'USD', amounts: { spending: 1 } }, { currency: 'USD', amounts: typedAmounts(TYPED), also: 1 }, { currency: 'USD', amounts: typedAmounts(TYPED), answered: 'yes' }]) {
      expect((await post(body)).status).toBe(400);
    }
    expect((await mine()).currency).toBeNull();
  });
});

describe('the download and a restore', () => {
  test('the currency is in your plan’s entry, and comes back with it, still holding for its amounts', async () => {
    const saved = await first(TYPED, 'EUR');
    const text = await downloadText(EXPORTED);
    const doc = JSON.parse(text);
    expect(doc['fire-plans']).toEqual([{ id: MAIN_ID, value: { name: 'First plan', plan: TYPED, tax: null, currency: 'EUR', createdAt: expect.any(String), updatedAt: saved.updated_at } }]);
    expect(doc['fire-plan-currency']).toBeNull();
    fake.reset();
    await registerTestContainer(fake);
    expect(await get()).toEqual(NO_PLAN);
    const record = await restoreAll(text);
    expect(record.status).toBe('finished');
    expect(await get()).toEqual(saved);
  });

  test('a download from before copies brings no plan back: the Plan is the defaults until it is saved', async () => {
    const legacy = { ...DEFAULT_PLAN, age: 40, spending: 40_000 };
    await firePlanStore.set(TEST_CTX, legacy);
    await planCurrencyStore.set(TEST_CTX, currencyRecord(legacy, 'EUR'));
    const doc = JSON.parse(await downloadText(EXPORTED));
    expect(doc['fire-plan-currency']).toEqual(currencyRecord(legacy, 'EUR'));
    fake.reset();
    await registerTestContainer(fake);
    expect((await restoreAll(JSON.stringify(doc))).status).toBe('finished');
    expect(await get()).toEqual(NO_PLAN);
    await first(TYPED, 'USD');
    expect([await fake.get(recordKey), await fake.get(ctxKey('fire-plan'))]).toEqual([null, null]);
  });
});
