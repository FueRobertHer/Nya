import { describe, expect, test, mock, beforeEach, afterEach } from 'bun:test';
import { FakeRedis, storageMock, TEST_CTX, registerTestContainer, unscopedDataKeys } from './fake-redis';
import { seedOld } from './restore-fixture';

// The stores added since a restore was first built (designs/restore-2.md,
// section 4), through a real download and restore (test/restore-run.ts):
// Plan scenarios, runway scenarios and the Plan's currency come back as the
// download had them; the Plan and its currency's record go together; the
// record of what API tokens changed never comes back, is counted as left
// out, and makes an account in use; and the API tokens made here are said.

process.env.PLAID_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
process.env.APP_PASSWORD = 'hunter2';
process.env.RESTORE_ENABLED = '1';

const fake = new FakeRedis({ deserialize: true });
afterEach(() => expect(unscopedDataKeys(fake)).toEqual([]));
mock.module('@/lib/storage', () => storageMock(fake));

const { forgetEpochs } = await import('@/lib/sessions');
const { firePlanStore, planCurrencyStore } = await import('@/lib/fire-plan');
const { DEFAULT_PLAN } = await import('@/lib/fire/plan');
const { currencyRecord } = await import('@/lib/fire/plan-currency');
const { planScenariosStore } = await import('@/lib/plan-scenarios');
const { runwayScenariosStore } = await import('@/lib/report/runway-scenario-store');
const { changeStore } = await import('@/lib/api-changes');
const { apiTokenStore } = await import('@/lib/api-token-store');
const { scanAccount } = await import('@/lib/user-restore/empty');
const { classOfKey } = await import('@/lib/user-restore/classes');
const { leftOutLines, tokensLine } = await import('@/components/restore-state');
const { downloadText, restoreAll, call } = await import('./restore-run');

const ctx = TEST_CTX;
/** The copy the download comes from. */
const OTHER = { container: '9c1d2e3f-4a5b-4c6d-8e7f-0a1b2c3d4e5f' } as typeof TEST_CTX;
const AT = '2026-10-01T10:00:00.000Z';

beforeEach(async () => {
  fake.reset();
  forgetEpochs();
  await registerTestContainer(fake);
  await seedOld(fake, OTHER);
});

const PLAN = { ...DEFAULT_PLAN, spending: 40_000 };
const SCENARIO = {
  version: 1 as const,
  name: 'Retire at 50',
  currency: 'EUR',
  createdAt: AT,
  savedAt: AT,
  rev: 'r1',
  set: { targetAge: 50 },
  income: { leaveOut: [], add: [] },
  expenses: { leaveOut: [], add: [] },
  events: [],
};
const RUNWAY = { v: 1 as const, name: 'Leaner months', months: 6 as const, lower_by: 250, currency: 'EUR', income_until: null, planned: true, leave_out_one_offs: false, saved_at: AT };
/** A change a token made there (lib/api-changes.ts): a tag it made. */
const CHANGE = {
  v: 1 as const,
  at: AT,
  via: 'api' as const,
  token: { ref: '0123456789abcdef', label: 'Script' },
  op: 'tag.create' as const,
  target: { kind: 'tag' as const, id: 'tag9' },
  state: 'done' as const,
  before: null,
  after: { tag: { id: 'tag9', name: 'Errands', color: 'blue', created_at: AT } },
};
const CHANGE_ID = '20261001.0123456789abcdef.0123456789ab';

describe('Plan scenarios, runway scenarios and the Plan’s currency', () => {
  test('come back as the download had them, and go into the restored copy’s own download the same', async () => {
    await firePlanStore.set(OTHER, PLAN);
    await planCurrencyStore.set(OTHER, currencyRecord(PLAN, 'EUR'));
    await planScenariosStore.set(OTHER, 'sc1', SCENARIO);
    await runwayScenariosStore.set(OTHER, 'rw1', RUNWAY);
    const text = await downloadText(new Date(), OTHER);
    expect((await restoreAll(text)).status).toBe('finished');
    expect(await firePlanStore.get(ctx)).toEqual(PLAN);
    expect(await planCurrencyStore.get(ctx)).toEqual(currencyRecord(PLAN, 'EUR'));
    expect(await planScenariosStore.get(ctx, 'sc1')).toEqual(SCENARIO);
    expect(await runwayScenariosStore.get(ctx, 'rw1')).toEqual(RUNWAY);
    const was = JSON.parse(text);
    const again = JSON.parse(await downloadText(new Date()));
    for (const part of ['fire-plan', 'fire-plan-currency', 'plan-scenarios', 'runway-scenarios']) expect([part, again[part]]).toEqual([part, was[part]]);
  });
});

describe('the Plan and its currency’s record go together', () => {
  /** The account restored into has a Plan of its own, typed in dollars. */
  const tried = async () => {
    const own = { ...DEFAULT_PLAN, spending: 40_000, savings: 12_000 };
    await firePlanStore.set(ctx, own);
    await planCurrencyStore.set(ctx, currencyRecord(own, 'USD'));
    return own;
  };

  test('a file whose Plan has no record of its currency takes the account’s record away, so the Plan asks', async () => {
    await firePlanStore.set(OTHER, PLAN);
    const text = await downloadText(new Date(), OTHER);
    await tried();
    // Settings alone: the account is empty enough.
    expect((await scanAccount(ctx)).found).toEqual([]);
    await restoreAll(text);
    expect(await firePlanStore.get(ctx)).toEqual(PLAN);
    expect(await planCurrencyStore.get(ctx)).toBeNull();
  });

  test('a file with both replaces both', async () => {
    await firePlanStore.set(OTHER, PLAN);
    await planCurrencyStore.set(OTHER, currencyRecord(PLAN, 'EUR'));
    const text = await downloadText(new Date(), OTHER);
    await tried();
    await restoreAll(text);
    expect(await firePlanStore.get(ctx)).toEqual(PLAN);
    expect(await planCurrencyStore.get(ctx)).toEqual(currencyRecord(PLAN, 'EUR'));
  });

  test('a file with neither keeps the account’s pair', async () => {
    const text = await downloadText(new Date(), OTHER);
    const own = await tried();
    await restoreAll(text);
    expect(await firePlanStore.get(ctx)).toEqual(own);
    expect(await planCurrencyStore.get(ctx)).toEqual(currencyRecord(own, 'USD'));
  });
});

describe('what API tokens changed', () => {
  test('is the person’s data to the scan: an account holding a change is in use', async () => {
    expect(classOfKey(`c:${ctx.container}:api-changes`).cls).toBe('data');
    await changeStore.set(ctx, CHANGE_ID, CHANGE);
    const scan = await scanAccount(ctx);
    expect(scan.empty).toBe(false);
    expect(scan.found).toEqual(['changes made with API tokens']);
  });

  test('never comes back with a download, and the preview says how many were left out', async () => {
    await changeStore.set(OTHER, CHANGE_ID, CHANGE);
    const text = await downloadText(new Date(), OTHER);
    expect(JSON.parse(text)['api-changes']).toHaveLength(1);
    const record = await restoreAll(text);
    expect(record.left_out.api_changes).toBe(1);
    expect(await changeStore.count(ctx)).toBe(0);
    expect(leftOutLines(record.left_out, { api_tokens: 0, sharing: 0 })).toContain('1 change made with API tokens in your other copy: about that copy, whose tokens don’t come back');
  });
});

describe('the API tokens made here', () => {
  const token = (access?: 'write') => ({ v: 1 as const, label: 'Raycast', hash: 'a'.repeat(64), user_id: null, created_at: AT, last_used_at: null, ...(access ? { access } : {}) });

  test('are counted with the scan, with how many can write, and said', async () => {
    await apiTokenStore.set(ctx, 'tok_read', token());
    await apiTokenStore.set(ctx, 'tok_write', token('write'));
    const state = await call('GET', '/api/user-restore?scan=1');
    expect(state.status).toBe(200);
    expect(state.body.tokens).toEqual({ kept: 2, writing: 1 });
    // Tokens are machinery: they don't make the account in use.
    expect(state.body.scan.found).toEqual([]);
  });

  test('in words', () => {
    expect(tokensLine(null)).toBeNull();
    expect(tokensLine({ kept: 0, writing: 0 })).toBeNull();
    expect(tokensLine({ kept: 1, writing: 0 })).toBe('1 API token made here stays: it reads what comes back.');
    expect(tokensLine({ kept: 1, writing: 1 })).toBe('1 API token made here stays: it reads what comes back, and can change it.');
    expect(tokensLine({ kept: 3, writing: 1 })).toBe('3 API tokens made here stay: they read what comes back, and 1 of them can change it.');
    expect(tokensLine({ kept: 2, writing: 2 })).toBe('2 API tokens made here stay: they read what comes back, and can change it.');
  });
});
