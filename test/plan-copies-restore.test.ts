import { describe, expect, test, mock, beforeEach, afterEach } from 'bun:test';
import { createHash } from 'node:crypto';
import { FakeRedis, storageMock, TEST_CTX, ctxKey, registerTestContainer, unscopedDataKeys } from './fake-redis';
import { seedOld, restoreRecord } from './restore-fixture';
import type { PlanEntry, PlanFacts } from '@/lib/fire/copies';

// Plans as copies in a download and a restore (lib/user-restore): the facts
// are a setting, the plans data but for your plan alone; a file that brings
// plans replaces every plan the account holds, never merges with them, and
// pairs the facts; a file with no plans leaves the account's. A file from
// before copies holds the Plan's old parts (lib/user-restore/parts.ts
// RETIRED_PARTS): read past, never written, and its plan said not to come
// back when it held one and the file brings no plans. A restore another
// release planned with one of those parts can only be undone.

process.env.PLAID_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
process.env.APP_PASSWORD = 'hunter2';
process.env.RESTORE_ENABLED = '1';

const fake = new FakeRedis({ deserialize: true });
afterEach(() => expect(unscopedDataKeys(fake)).toEqual([]));
mock.module('@/lib/storage', () => storageMock(fake));

const { forgetEpochs } = await import('@/lib/sessions');
const { encrypt } = await import('@/lib/crypto');
const { firePlansStore, planFactsStore } = await import('@/lib/plan-copies');
const { savedPlanStore } = await import('@/lib/saved-plan');
const { DEFAULT_PLAN } = await import('@/lib/fire/plan');
const { planOf } = await import('@/lib/fire/plan-v2');
const { MAIN_ID, factsOf } = await import('@/lib/fire/copies');
const { scanAccount } = await import('@/lib/user-restore/empty');
const { classOfKey } = await import('@/lib/user-restore/classes');
const { checkBatch, BatchRefused } = await import('@/lib/user-restore/check');
const { writeBatch, BatchNotWritten } = await import('@/lib/user-restore/commit');
const { collect } = await import('@/lib/user-restore/file');
const { userRestoreStore } = await import('@/lib/user-restore/store');
const { broughtLines, leftOutLines } = await import('@/components/restore-state');
const { downloadText, restoreAll, planned, sourceOf, call } = await import('./restore-run');

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

/** OTHER's download, with parts as a version of Nya from before copies wrote
 *  them (or put over its own, `problems` among them). */
const withParts = async (parts: Record<string, unknown>) => JSON.stringify({ ...JSON.parse(await downloadText(new Date(), OTHER)), ...parts });
const LEGACY = { ...DEFAULT_PLAN, spending: 30_000 };
const SCENARIO = { id: 'sc1', value: { version: 1, name: 'Old', currency: null, createdAt: AT, savedAt: AT, rev: 'r1', set: { targetAge: 50 }, income: { leaveOut: [], add: [] }, expenses: { leaveOut: [], add: [] }, events: [] } };
const CURRENCY = { version: 1, currency: 'EUR', amounts: { spending: 30_000 } };
const OLD_PLAN = 'your Plan and its scenarios as an older version of Nya kept them: make them again on the Plan tab if you need them';
/** How often the preview lists the old plan as not coming back. */
const saysOldPlan = async (text: string) => {
  const { p } = await planned(text);
  return leftOutLines(p.left_out, p.collected.never).filter((l) => l === OLD_PLAN).length;
};
/** The keys the old parts were stored under: never written now. */
const legacyKeys = async (): Promise<string[]> => [await fake.type(ctxKey('fire-plan')), await fake.type(ctxKey('fire-plan-currency')), await fake.type(ctxKey('plan-scenarios'))];
const NONE: string[] = ['none', 'none', 'none'];

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

  test('a file from before copies: the rest comes back, the account’s plans and facts stay, none of its old plan is written, and the preview says so once', async () => {
    const saved = { version: 1 as const, plan: planOf(PLAN), savings: 18_000, currency: 'USD', inflation: 0.03, day: '2026-11-01', savedAt: AT, rev: 'rev-1' };
    await savedPlanStore.set(OTHER, saved);
    const text = await withParts({ 'fire-plan': LEGACY, 'fire-plan-currency': CURRENCY, 'plan-scenarios': [SCENARIO] });
    expect(JSON.parse(text)['fire-plans']).toEqual([]);
    await firePlansStore.set(ctx, MAIN_ID, entry());
    await planFactsStore.set(ctx, facts({ age: 60 }));
    expect(await saysOldPlan(text)).toBe(1);
    const record = await restoreAll(text);
    expect(record.status).toBe('finished');
    expect(record.left_out).toMatchObject({ plan_before_copies: 1 });
    expect(await savedPlanStore.get(ctx)).toEqual(saved);
    expect(await plansOf()).toEqual({ [MAIN_ID]: entry() });
    expect(await planFactsStore.get(ctx)).toEqual(facts({ age: 60 }));
    expect(await legacyKeys()).toEqual(NONE);
    expect(Object.keys(record.brought).filter((k) => ['store:fire-plan', 'store:fire-plan-currency', 'store:plan-scenarios'].includes(k))).toEqual([]);
  });

  test('the same file with plans: they replace the account’s, as any file’s, and the old plan isn’t named', async () => {
    await firePlansStore.set(OTHER, MAIN_ID, entry({ name: 'There' }));
    await planFactsStore.set(OTHER, facts());
    const text = await withParts({ 'fire-plan': LEGACY, 'fire-plan-currency': CURRENCY, 'plan-scenarios': [SCENARIO] });
    await firePlansStore.set(ctx, MAIN_ID, entry({ name: 'Here' }));
    expect(await saysOldPlan(text)).toBe(0);
    const record = await restoreAll(text);
    expect(record.status).toBe('finished');
    expect(record.left_out).not.toHaveProperty('plan_before_copies');
    expect(await plansOf()).toEqual({ [MAIN_ID]: entry({ name: 'There' }) });
    expect(await legacyKeys()).toEqual(NONE);
  });

  test('a download whose old parts are empty, as every one made since copies, says nothing of them; nor does a currency alone', async () => {
    for (const parts of [{ 'fire-plan': null, 'fire-plan-currency': null, 'plan-scenarios': [] }, { 'fire-plan': null, 'fire-plan-currency': CURRENCY, 'plan-scenarios': [] }]) {
      fake.reset();
      forgetEpochs();
      await registerTestContainer(fake);
      await seedOld(fake, OTHER);
      const text = await withParts(parts);
      expect(await saysOldPlan(text)).toBe(0);
      expect((await restoreAll(text)).status).toBe('finished');
      expect(await legacyKeys()).toEqual(NONE);
    }
  });

  test('a file saying its old plan couldn’t be read, or was a newer version’s, is still taken, and says the plan doesn’t come back', async () => {
    for (const problems of [[{ section: 'fire-plan', problem: 'unreadable' }], [{ section: 'fire-plan', problem: 'unrecognised' }], [{ section: 'plan-scenarios', problem: 'unreadable', ids: ['sc1'] }]]) {
      const text = await withParts({ 'fire-plan': null, 'plan-scenarios': [], problems });
      expect([problems, await saysOldPlan(text)]).toEqual([problems, 1]);
    }
    // The currency alone isn't the plan: taken, and nothing said.
    expect(await saysOldPlan(await withParts({ problems: [{ section: 'fire-plan-currency', problem: 'unreadable' }] }))).toBe(0);
  });

  test('old scenarios that aren’t a list are refused, as any list part; an old plan, an object, is read past', async () => {
    await expect(collect(sourceOf(await withParts({ 'plan-scenarios': { sc1: SCENARIO.value } })))).rejects.toThrow('plan-scenarios: must be a list');
    expect(await saysOldPlan(await withParts({ 'fire-plan': { ...LEGACY, deeper: { rows: [[1, 2], { a: null }] } } }))).toBe(1);
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
    const text = await withParts({ 'fire-plan': PLAN });
    expect(JSON.parse(text)['fire-plans']).toEqual([]);
    expect((await restoreAll(text)).status).toBe('finished');
    expect([await fake.type(ctxKey('fire-plans')), await fake.type(ctxKey('plan-facts'))]).toEqual(['none', 'none']);
  });
});

describe('a batch that clears the account’s plans, refused', () => {
  const at = (part: string, count: number) => restoreRecord({ plan: { digest: 'a'.repeat(64), batches: [{ part, count, digest: 'c'.repeat(64) }] }, done: 0 }) as never;

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

describe('a restore another release planned with an old part', () => {
  const body = JSON.stringify({ part: 'store:fire-plan', records: [{ value: LEGACY }] });
  const digest = createHash('sha256').update(body).digest('hex');
  const batches = [
    { part: 'store:tags', count: 1, digest: 'b'.repeat(64) },
    { part: 'store:fire-plan', count: 1, digest },
  ];
  const record = (over: Record<string, unknown>) => restoreRecord({ plan: { digest: 'a'.repeat(64), batches }, brought: { 'store:tags': 1, 'store:fire-plan': 1 }, ...over });
  const ID = restoreRecord().id;
  const UNDO = 'Undo this restore, then bring the file back again: another version of Nya planned it, so it can’t go on here.';

  test('is refused at its next batch and at its finish, saying what to do; one finished is not', async () => {
    await userRestoreStore.set(ctx, record({ done: 1 }) as never);
    expect(await call('POST', `/api/user-restore/batch?restore_id=${ID}&index=1`, body)).toEqual({ status: 409, body: { error: UNDO } });
    expect(await legacyKeys()).toEqual(NONE);
    await userRestoreStore.set(ctx, record({ done: 2 }) as never);
    expect(await call('POST', `/api/user-restore/batch?restore_id=${ID}&finish=1`)).toEqual({ status: 409, body: { error: UNDO } });
    expect((await userRestoreStore.get(ctx))!.status).toBe('writing');
    await userRestoreStore.set(ctx, record({ done: 2, status: 'finished', finished_at: AT, undo_until: '2026-11-08T10:00:00.000Z' }) as never);
    const finished = await call('POST', `/api/user-restore/batch?restore_id=${ID}&finish=1`);
    expect([finished.status, finished.body.record.status]).toEqual([200, 'finished']);
  });
});
