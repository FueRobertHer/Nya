import { describe, expect, test, mock, beforeEach, afterEach } from 'bun:test';
import { FakeRedis, storageMock, TEST_CTX, ctxKey, registerTestContainer, unscopedDataKeys } from './fake-redis';
import { seedOld, restoreRecord } from './restore-fixture';
import type { PlanEntry, PlanFacts } from '@/lib/fire/copies';

// Plans as copies in a download and a restore (lib/user-restore): the facts
// are a setting, the plans data but for your plan alone; a file that brings
// plans replaces every plan the account holds, never merges with them, and
// pairs the facts; a file with a plan from before copies clears the copies,
// so none hides it; a file with no plan leaves the account's.

process.env.PLAID_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
process.env.APP_PASSWORD = 'hunter2';
process.env.RESTORE_ENABLED = '1';

const fake = new FakeRedis({ deserialize: true });
afterEach(() => expect(unscopedDataKeys(fake)).toEqual([]));
mock.module('@/lib/storage', () => storageMock(fake));

const { forgetEpochs } = await import('@/lib/sessions');
const { encrypt } = await import('@/lib/crypto');
const { firePlanStore, planCurrencyStore } = await import('@/lib/fire-plan');
const { firePlansStore, planFactsStore } = await import('@/lib/plan-copies');
const { savedPlanStore } = await import('@/lib/saved-plan');
const { DEFAULT_PLAN } = await import('@/lib/fire/plan');
const { planOf } = await import('@/lib/fire/plan-v2');
const { MAIN_ID, factsOf } = await import('@/lib/fire/copies');
const { currencyRecord } = await import('@/lib/fire/plan-currency');
const { scanAccount } = await import('@/lib/user-restore/empty');
const { classOfKey } = await import('@/lib/user-restore/classes');
const { checkBatch, BatchRefused } = await import('@/lib/user-restore/check');
const { writeBatch, BatchNotWritten } = await import('@/lib/user-restore/commit');
const { broughtLines } = await import('@/components/restore-state');
const planRoute = await import('@/app/api/fire-plan/route');
const { downloadText, restoreAll, call } = await import('./restore-run');

const ctx = TEST_CTX;
/** The copy the download comes from. */
const OTHER = { container: '9c1d2e3f-4a5b-4c6d-8e7f-0a1b2c3d4e5f' } as typeof TEST_CTX;
const AT = '2026-11-01T10:00:00.000Z';

beforeEach(async () => {
  fake.reset();
  forgetEpochs();
  await registerTestContainer(fake);
  await seedOld(fake, OTHER);
});

const PLAN = { ...DEFAULT_PLAN, age: 40, spending: 40_000 };
const entry = (over: Partial<PlanEntry> = {}): PlanEntry => ({ name: 'First plan', plan: PLAN, tax: null, currency: 'USD', createdAt: AT, updatedAt: AT, ...over });
const facts = (over: Partial<PlanFacts> = {}): PlanFacts => ({ version: 1, main: MAIN_ID, ...factsOf(PLAN), ...over });
const DAMAGED = 'damaged-bytes-not-ciphertext-at-all';
const plansOf = async (c = ctx) => Object.fromEntries((await firePlansStore.getAll(c)).entries());

describe('what the scan makes of them', () => {
  test('the facts are a setting; the plans data', () => {
    expect(classOfKey(`c:${ctx.container}:plan-facts`).cls).toBe('setting');
    expect(classOfKey(`c:${ctx.container}:fire-plans`).cls).toBe('data');
  });

  test('your plan alone is a setting, whatever its id, damaged or not', async () => {
    await planFactsStore.set(ctx, facts());
    for (const plant of [() => firePlansStore.set(ctx, MAIN_ID, entry()), () => firePlansStore.set(ctx, 'x', entry()), () => fake.hset(ctxKey('fire-plans'), { [MAIN_ID]: DAMAGED })]) {
      await fake.del(ctxKey('fire-plans'));
      await plant();
      const scan = await scanAccount(ctx);
      expect([scan.empty, scan.found, scan.settings]).toEqual([true, [], ['fire-plans', 'plan-facts']]);
    }
  });

  test('more than one are copies of your plan; one a newer release wrote is data Nya doesn’t show', async () => {
    await firePlansStore.set(ctx, MAIN_ID, entry());
    await firePlansStore.set(ctx, 'x', entry({ name: 'Stop at 52' }));
    expect(await scanAccount(ctx)).toMatchObject({ empty: false, found: ['copies of your plan'], unseen: false });
    await fake.del(ctxKey('fire-plans'));
    await fake.hset(ctxKey('fire-plans'), { [MAIN_ID]: await encrypt(ctx, JSON.stringify({ ...entry(), tax: { filing: 'single' } })) });
    expect(await scanAccount(ctx)).toMatchObject({ empty: false, found: ['data Nya doesn’t show'], unseen: true });
  });
});

describe('a file’s check', () => {
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

  test('takes entries and facts of this shape, a plan of either version, and nothing else', () => {
    expect(refused({ part: 'store:fire-plans', records: [{ id: MAIN_ID, value: entry() }, { id: 'x', value: entry({ plan: { ...planOf(PLAN), partnerAge: 38 } }) }] })).toBe('passed');
    expect(refused({ part: 'store:plan-facts', records: [{ value: facts() }] })).toBe('passed');
    expect(refused({ part: 'store:fire-plans', records: [{ id: 'x', value: { ...entry(), tax: { filing: 'single' } } }] })).not.toBe('passed');
    expect(refused({ part: 'store:plan-facts', records: [{ value: { ...facts(), version: 2 } }] })).not.toBe('passed');
  });

});

test('a restore writes at most twice the plans Nya keeps', async () => {
  const records = Array.from({ length: 23 }, (_, i) => ({ id: `p${i}`, value: entry() }));
  const refusal = await writeBatch(ctx, 'store:fire-plans', records, restoreRecord() as never).catch((err) => err);
  expect([refusal instanceof BatchNotWritten, refusal.status]).toEqual([true, 413]);
  expect(await firePlansStore.count(ctx)).toBe(0);
  await writeBatch(ctx, 'store:fire-plans', records.slice(0, 22), restoreRecord() as never);
  expect(await firePlansStore.count(ctx)).toBe(22);
});

describe('a download and a restore', () => {
  test('bring your plans and their facts back as they were, a newer version’s saved plan too, and say how many', async () => {
    await firePlansStore.set(OTHER, MAIN_ID, entry());
    await firePlansStore.set(OTHER, 'x', entry({ name: 'Stop at 52', plan: { ...planOf(PLAN), partnerAge: 38 }, createdAt: '2026-11-02T10:00:00.000Z' }));
    await planFactsStore.set(OTHER, facts({ main: 'x', partnerAge: 38 }));
    const saved = { version: 1 as const, plan: { ...planOf(PLAN), stopAtFi: true, targetAge: null }, savings: 18_000, currency: 'USD', inflation: 0.03, day: '2026-11-01', savedAt: AT, rev: 'rev-1' };
    await savedPlanStore.set(OTHER, saved);
    const text = await downloadText(new Date(), OTHER);
    const record = await restoreAll(text);
    expect(record.status).toBe('finished');
    expect(await plansOf()).toEqual(await plansOf(OTHER));
    expect(await planFactsStore.get(ctx)).toEqual(facts({ main: 'x', partnerAge: 38 }));
    expect(await savedPlanStore.get(ctx)).toEqual(saved);
    expect(broughtLines(record.brought, null)).toContain('2 plans');
    const was = JSON.parse(text);
    const again = JSON.parse(await downloadText(new Date()));
    for (const part of ['fire-plans', 'plan-facts']) expect([part, again[part]]).toEqual([part, was[part]]);
  });

  test('a file whose plan isn’t main, into an account holding main: no stray copy left, and the next restore still taken', async () => {
    await firePlansStore.set(OTHER, 'x', entry({ name: 'Mine' }));
    await planFactsStore.set(OTHER, facts({ main: 'x' }));
    const text = await downloadText(new Date(), OTHER);
    await firePlansStore.set(ctx, MAIN_ID, entry({ name: 'Here' }));
    await planFactsStore.set(ctx, facts({ age: 60 }));
    expect((await restoreAll(text)).status).toBe('finished');
    expect(Object.keys(await plansOf())).toEqual(['x']);
    expect(await planFactsStore.get(ctx)).toEqual(facts({ main: 'x' }));
    // Your plan alone again: a setting, which a next restore replaces.
    const scan = await scanAccount(ctx);
    expect([scan.found.includes('copies of your plan'), scan.settings.includes('fire-plans')]).toEqual([false, true]);
  });

  test('a damaged plan in the account is cleared by a file with plans', async () => {
    await firePlansStore.set(OTHER, MAIN_ID, entry());
    const text = await downloadText(new Date(), OTHER);
    await fake.hset(ctxKey('fire-plans'), { [MAIN_ID]: DAMAGED });
    await fake.set(ctxKey('plan-facts'), DAMAGED);
    expect((await restoreAll(text)).status).toBe('finished');
    expect(await plansOf()).toEqual({ [MAIN_ID]: entry() });
    // The file had no facts: the account's damaged ones go too.
    expect(await planFactsStore.getReport(ctx)).toEqual({ value: null, unreadable: false, unrecognised: false });
  });

  test('a file with the plan from before copies clears the account’s copies and facts, so the plan it brings is the one read', async () => {
    const legacy = { ...DEFAULT_PLAN, spending: 30_000 };
    await firePlanStore.set(OTHER, legacy);
    await planCurrencyStore.set(OTHER, currencyRecord(legacy, 'EUR'));
    const text = await downloadText(new Date(), OTHER);
    await fake.hset(ctxKey('fire-plans'), { [MAIN_ID]: DAMAGED });
    await planFactsStore.set(ctx, facts());
    expect((await restoreAll(text)).status).toBe('finished');
    expect([await firePlansStore.count(ctx), await planFactsStore.get(ctx)]).toEqual([0, null]);
    const read = await planRoute.GET();
    expect(await read.json()).toEqual({ plan: legacy, currency: 'EUR' });
  });

  test('a file with no plan leaves the account’s plans and facts', async () => {
    const text = await downloadText(new Date(), OTHER);
    await firePlansStore.set(ctx, MAIN_ID, entry());
    await planFactsStore.set(ctx, facts({ age: 60 }));
    expect((await restoreAll(text)).status).toBe('finished');
    expect(await plansOf()).toEqual({ [MAIN_ID]: entry() });
    expect(await planFactsStore.get(ctx)).toEqual(facts({ age: 60 }));
  });

  test('an account whose one plan a newer release wrote is in use, so the restore asks for an empty one', async () => {
    const text = await downloadText(new Date(), OTHER);
    await fake.hset(ctxKey('fire-plans'), { [MAIN_ID]: await encrypt(ctx, JSON.stringify({ ...entry(), tax: { filing: 'single' } })) });
    const state = await call('GET', '/api/user-restore?scan=1');
    expect(state.body.scan).toMatchObject({ empty: false, unseen: true });
    await expect(restoreAll(text)).rejects.toThrow();
  });

  test('of an account without copies, never make them', async () => {
    await firePlanStore.set(OTHER, PLAN);
    const text = await downloadText(new Date(), OTHER);
    expect(JSON.parse(text)['fire-plans']).toEqual([]);
    expect((await restoreAll(text)).status).toBe('finished');
    expect([await fake.type(ctxKey('fire-plans')), await fake.type(ctxKey('plan-facts'))]).toEqual(['none', 'none']);
  });
});

describe('a batch that clears the account’s plans, refused', () => {
  const at = (part: string, count: number) => restoreRecord({ plan: { digest: 'a'.repeat(64), batches: [{ part, count, digest: 'c'.repeat(64) }] }, done: 0 }) as never;

  test('a plan from before copies that can’t be written over a damaged one leaves the plans Home reads', async () => {
    await firePlansStore.set(ctx, MAIN_ID, entry());
    await planFactsStore.set(ctx, facts());
    await fake.set(ctxKey('fire-plan'), DAMAGED);
    await expect(writeBatch(ctx, 'store:fire-plan', [{ value: { ...DEFAULT_PLAN, spending: 30_000 } }], at('store:fire-plan', 1))).rejects.toThrow();
    expect(await plansOf()).toEqual({ [MAIN_ID]: entry() });
    const read = await planRoute.GET();
    expect([read.status, (await read.json()).plan.spending]).toEqual([200, 40_000]);
  });

  test('plans over the bound leave the account’s as they were', async () => {
    await firePlansStore.set(ctx, MAIN_ID, entry({ name: 'Here' }));
    const records = Array.from({ length: 23 }, (_, i) => ({ id: `p${i}`, value: entry() }));
    const refusal = await writeBatch(ctx, 'store:fire-plans', records, at('store:fire-plans', 23)).catch((err) => err);
    expect([refusal instanceof BatchNotWritten, refusal.status]).toEqual([true, 413]);
    expect(await plansOf()).toEqual({ [MAIN_ID]: entry({ name: 'Here' }) });
  });

  test('written, a damaged plan under an id the file brings is written over, and one under another goes', async () => {
    await fake.hset(ctxKey('fire-plans'), { [MAIN_ID]: DAMAGED, y: DAMAGED });
    await writeBatch(ctx, 'store:fire-plans', [{ id: MAIN_ID, value: entry() }], at('store:fire-plans', 1));
    expect(await plansOf()).toEqual({ [MAIN_ID]: entry() });
  });
});

describe('a batch of plans written twice', () => {
  test('clears and writes its own plans again: the same plans, nothing merged', async () => {
    const batches = [
      { part: 'store:tags', count: 1, digest: 'b'.repeat(64) },
      { part: 'store:fire-plans', count: 2, digest: 'c'.repeat(64) },
    ];
    const record = restoreRecord({ plan: { digest: 'a'.repeat(64), batches }, done: 1 }) as never;
    await firePlansStore.set(ctx, 'here', entry({ name: 'Here' }));
    const records = [
      { id: MAIN_ID, value: entry() },
      { id: 'x', value: entry({ name: 'Stop at 52' }) },
    ];
    await writeBatch(ctx, 'store:fire-plans', records, record);
    const once = await plansOf();
    await writeBatch(ctx, 'store:fire-plans', records, record);
    expect(await plansOf()).toEqual(once);
    expect(Object.keys(once).sort()).toEqual([MAIN_ID, 'x']);
  });

  test('a later batch of the same part never clears what the first wrote', async () => {
    const batches = [
      { part: 'store:fire-plans', count: 1, digest: 'c'.repeat(64) },
      { part: 'store:fire-plans', count: 1, digest: 'd'.repeat(64) },
    ];
    await writeBatch(ctx, 'store:fire-plans', [{ id: MAIN_ID, value: entry() }], restoreRecord({ plan: { digest: 'a'.repeat(64), batches }, done: 0 }) as never);
    await writeBatch(ctx, 'store:fire-plans', [{ id: 'x', value: entry() }], restoreRecord({ plan: { digest: 'a'.repeat(64), batches }, done: 1 }) as never);
    expect(Object.keys(await plansOf()).sort()).toEqual([MAIN_ID, 'x']);
  });
});
