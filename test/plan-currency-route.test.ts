import { describe, expect, test, mock, beforeEach, afterEach } from 'bun:test';
import { FakeRedis, storageMock, TEST_CTX, ctxKey, registerTestContainer, unscopedDataKeys } from './fake-redis';
import './clerk-mock';
import type { FirePlan } from '@/lib/fire/plan';

// The currency the Plan's figures are in, stored beside the plan
// (lib/fire-plan.ts planCurrencyStore) and answered with it
// (app/api/fire-plan): an older stored Plan read without change, what each
// save records, what the release before does after a rollback (it reads the
// plan as ever, never this store, and a save of its own that changes an
// amount leaves the record apart, so the Plan asks), a record that can't be
// read or is a newer version's, and the download and a restore round trip.

process.env.PLAID_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
process.env.APP_PASSWORD = 'hunter2';
process.env.RESTORE_UNDO_PAUSE_MS = '0';

const fake = new FakeRedis({ deserialize: true });
afterEach(() => expect(unscopedDataKeys(fake)).toEqual([]));
mock.module('@/lib/storage', () => storageMock(fake));

const { encrypt, decrypt } = await import('@/lib/crypto');
const { readEncryptedJson } = await import('@/lib/stored-json');
const { firePlanStore, planCurrencyStore } = await import('@/lib/fire-plan');
const { declaredStore } = await import('@/lib/stores');
const { DEFAULT_PLAN, isFirePlan } = await import('@/lib/fire/plan');
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

const plan = (over: Partial<FirePlan> = {}): FirePlan => ({ ...DEFAULT_PLAN, ...over });
const TYPED = plan({ age: 40, targetAge: 55, spending: 40_000, savings: 30_000 });
const put = (body: unknown) => route.PUT(new Request('http://x', { method: 'PUT', body: JSON.stringify(body) }));
const post = (body: unknown) => route.POST(new Request('http://x', { method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body) }));
const get = async () => (await route.GET()).json();
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

describe('the store', () => {
  test('is declared on the seam beside the plan, in the download, and on the key inventory', () => {
    expect(planCurrencyStore.name).toBe('fire-plan-currency');
    expect(planCurrencyStore.kind).toBe('value');
    expect(declaredStore('fire-plan-currency')).toBe(planCurrencyStore);
    expect(planCurrencyStore.exportable).toBe(true);
    expect(SEAM['fire-plan-currency']).toEqual({ kind: 'value', restore: 'write' });
    expect(classify(recordKey.replace(/^[^:]+:(?=c:)/, ''))).toBe('string');
  });

  test('encrypted: neither the currency nor an amount is readable in the database', async () => {
    await planCurrencyStore.set(TEST_CTX, currencyRecord(TYPED, 'EUR'));
    const raw = String(await fake.get(recordKey));
    expect(raw).not.toContain('EUR');
    expect(raw).not.toContain('40000');
    expect(JSON.parse(await decrypt(TEST_CTX, raw))).toEqual({ version: 1, currency: 'EUR', amounts: typedAmounts(TYPED) });
  });
});

describe('an older stored Plan', () => {
  test('reads without change: the plan as it was saved, and no currency, since none was recorded', async () => {
    // Exactly as every release before saved it, and nothing beside it.
    await fake.set(ctxKey('fire-plan'), await encrypt(TEST_CTX, JSON.stringify(TYPED)));
    expect(await get()).toEqual({ plan: TYPED, currency: null });
    expect(await fake.get(recordKey)).toBeNull();
    expect(JSON.parse(await decrypt(TEST_CTX, String(await fake.get(ctxKey('fire-plan')))))).toEqual(TYPED);
  });

  test('its currency recorded for the plan as stored, with the amounts the page shows; a plan changed since is refused', async () => {
    await firePlanStore.set(TEST_CTX, TYPED);
    const stale = await post({ currency: 'USD', amounts: typedAmounts({ ...TYPED, spending: 45_000 }) });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ stale: true });
    expect(await fake.get(recordKey)).toBeNull();
    const res = await post({ currency: 'USD', amounts: typedAmounts(TYPED) });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ plan: TYPED, currency: 'USD' });
    expect(await get()).toEqual({ plan: TYPED, currency: 'USD' });
    // The plan itself is untouched.
    expect(await firePlanStore.get(TEST_CTX)).toEqual(TYPED);
  });

  test('nothing to record for a plan with nothing typed, or none at all; what it takes is checked', async () => {
    expect((await post({ currency: 'USD', amounts: typedAmounts(DEFAULT_PLAN) })).status).toBe(409);
    await firePlanStore.set(TEST_CTX, plan({ age: 40 }));
    expect((await post({ currency: 'USD', amounts: typedAmounts(DEFAULT_PLAN) })).status).toBe(409);
    for (const body of ['{no', [], { currency: 'usd', amounts: typedAmounts(TYPED) }, { currency: 'USD' }, { currency: 'USD', amounts: { spending: 1 } }, { currency: 'USD', amounts: typedAmounts(TYPED), also: 1 }, { currency: 'USD', amounts: typedAmounts(TYPED), replace_unreadable: 'yes' }]) {
      expect((await post(body)).status).toBe(400);
    }
    expect(await fake.get(recordKey)).toBeNull();
  });
});

describe('each save', () => {
  test('records the currency with the plan; a save that names none (a page of the release before) leaves the record, which holds only while the amounts do', async () => {
    const res = await put({ plan: TYPED, currency: 'EUR' });
    expect(await res.json()).toEqual({ plan: TYPED, currency: 'EUR' });
    expect(await get()).toEqual({ plan: TYPED, currency: 'EUR' });
    // An age changed by a page that sends no currency: the amounts are the same.
    expect(await (await put({ plan: { ...TYPED, age: 41 } })).json()).toEqual({ plan: { ...TYPED, age: 41 }, currency: 'EUR' });
    // An amount changed by one: the record is of other amounts, so not known.
    expect(await (await put({ plan: { ...TYPED, age: 41, spending: 50_000 } })).json()).toEqual({ plan: { ...TYPED, age: 41, spending: 50_000 }, currency: null });
    expect(await get()).toMatchObject({ currency: null });
  });

  test('refuses a currency that isn’t a code, and saves nothing', async () => {
    const res = await put({ plan: TYPED, currency: 'Euro' });
    expect(res.status).toBe(400);
    expect(await fake.get(ctxKey('fire-plan'))).toBeNull();
    expect(await fake.get(recordKey)).toBeNull();
  });

  test('a save stopped between its two writes leaves a record of the amounts before, which reads as none', async () => {
    await put({ plan: TYPED, currency: 'USD' });
    // The record's write, after the plan's, fails.
    const store = planCurrencyStore as { set: typeof planCurrencyStore.set };
    const set = store.set;
    store.set = async () => {
      throw new Error('connection reset');
    };
    let res: Response;
    try {
      res = await quiet(() => put({ plan: { ...TYPED, spending: 60_000 }, currency: 'USD' }));
    } finally {
      store.set = set;
    }
    expect(res.status).toBe(500);
    expect(await get()).toEqual({ plan: { ...TYPED, spending: 60_000 }, currency: null });
  });
});

describe('after a rollback, the release before', () => {
  test('reads the plan as it always has: this release changes nothing of its shape, and keeps its currency elsewhere', async () => {
    await put({ plan: TYPED, currency: 'EUR' });
    // The release before's reader: the same store, the same check.
    expect(await readEncryptedJson(TEST_CTX, ctxKey('fire-plan'), 'plan assumptions', isFirePlan)).toEqual(TYPED);
  });

  test('saving the plan alone (all it knows) keeps the record while no amount changes, and leaves it apart once one does: the Plan then asks', async () => {
    await put({ plan: TYPED, currency: 'EUR' });
    // What its save writes: the plan, never the record.
    await firePlanStore.set(TEST_CTX, { ...TYPED, withdrawalRate: 0.035 });
    expect(await get()).toMatchObject({ currency: 'EUR' });
    await firePlanStore.set(TEST_CTX, { ...TYPED, spending: 36_000 });
    expect(await get()).toEqual({ plan: { ...TYPED, spending: 36_000 }, currency: null });
    // The record is still there as it was, never rewritten without a save of this release.
    expect(await planCurrencyStore.get(TEST_CTX)).toEqual(currencyRecord(TYPED, 'EUR'));
  });
});

describe('a record that can’t be read', () => {
  test('damaged: the plan still loads, says so, a save leaves it alone, and only the person’s answer replaces it', async () => {
    await firePlanStore.set(TEST_CTX, TYPED);
    await fake.set(recordKey, 'damaged-bytes-not-ciphertext-at-all');
    expect(await get()).toEqual({ plan: TYPED, currency: null, currency_problem: 'unreadable' });
    const saved = await put({ plan: { ...TYPED, age: 41 }, currency: 'USD' });
    expect(saved.status).toBe(200);
    expect(await saved.json()).toEqual({ plan: { ...TYPED, age: 41 }, currency: null, currency_problem: 'unreadable' });
    expect(await fake.get<string>(recordKey)).toBe('damaged-bytes-not-ciphertext-at-all');
    const amounts = typedAmounts(TYPED);
    const refused = await post({ currency: 'USD', amounts });
    expect([refused.status, (await refused.json()).unreadable]).toEqual([409, true]);
    expect(await fake.get<string>(recordKey)).toBe('damaged-bytes-not-ciphertext-at-all');
    expect(await (await post({ currency: 'USD', amounts, replace_unreadable: true })).json()).toEqual({ plan: { ...TYPED, age: 41 }, currency: 'USD' });
  });

  test('a newer version’s: never written over, by a save or an answer', async () => {
    await firePlanStore.set(TEST_CTX, TYPED);
    const newer = await encrypt(TEST_CTX, JSON.stringify({ version: 2, currency: 'EUR', amounts: typedAmounts(TYPED), by: 'item' }));
    await fake.set(recordKey, newer);
    expect(await get()).toEqual({ plan: TYPED, currency: null, currency_problem: 'newer' });
    expect((await put({ plan: TYPED, currency: 'USD' })).status).toBe(200);
    expect((await post({ currency: 'USD', amounts: typedAmounts(TYPED), replace_unreadable: true })).status).toBe(409);
    expect(await fake.get<string>(recordKey)).toBe(newer);
  });
});

describe('the download and a restore', () => {
  test('the record is a part of its own, and comes back with the plan, still holding for it', async () => {
    await put({ plan: TYPED, currency: 'EUR' });
    const text = await downloadText(EXPORTED);
    const doc = JSON.parse(text);
    expect(doc['fire-plan']).toEqual(TYPED);
    expect(doc['fire-plan-currency']).toEqual({ version: 1, currency: 'EUR', amounts: typedAmounts(TYPED) });
    fake.reset();
    await registerTestContainer(fake);
    expect(await get()).toEqual({ plan: null, currency: null });
    const record = await restoreAll(text);
    expect(record.status).toBe('finished');
    expect(await get()).toEqual({ plan: TYPED, currency: 'EUR' });
  });

  test('a download from the release before has no record: the plan comes back, and its currency isn’t known until said', async () => {
    await firePlanStore.set(TEST_CTX, TYPED);
    const doc = JSON.parse(await downloadText(EXPORTED));
    expect(doc['fire-plan-currency']).toBeNull();
    fake.reset();
    await registerTestContainer(fake);
    await restoreAll(JSON.stringify(doc));
    expect(await get()).toEqual({ plan: TYPED, currency: null });
  });
});
