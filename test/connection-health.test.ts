import { describe, expect, test, mock, beforeEach, afterEach } from 'bun:test';
import { FakeRedis, storageMock, TEST_CTX, ctxKey, registerTestContainer, unscopedDataKeys } from './fake-redis';

// Connection health on the server (lib/connection-health.ts): Plaid's early
// warnings recorded from the webhook and cleared by a repair or a removal,
// each connection's last good sync, and the health the dashboard is sent,
// which is never frozen into the cache.

const ctx = TEST_CTX;
process.env.PLAID_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');

// What Plaid answers, by access token. Every call the routes here can make is
// stubbed, since mock.module is process-wide.
const plaid: Record<string, () => unknown> = {};
const txnFails = new Set<string>();
mock.module('@/lib/plaid', () => ({
  plaidClient: {
    accountsGet: async (req: any) => {
      const answer = plaid[req.access_token];
      if (!answer) throw { response: { data: { error_code: 'ITEM_NOT_FOUND' } } };
      return answer();
    },
    investmentsHoldingsGet: async () => ({ data: { holdings: [], securities: [] } }),
    liabilitiesGet: async () => ({ data: { liabilities: {} } }),
    itemRemove: async () => ({ data: {} }),
    transactionsSync: async (req: any) => {
      if (txnFails.has(req.access_token)) throw { response: { data: { error_code: 'ITEM_LOGIN_REQUIRED' } } };
      return {
        data: { added: [], modified: [], removed: [], accounts: [], next_cursor: 'c', has_more: false, transactions_update_status: 'HISTORICAL_UPDATE_COMPLETE' },
      };
    },
  },
}));

const fake = new FakeRedis();
afterEach(() => expect(unscopedDataKeys(fake)).toEqual([]));
mock.module('@/lib/storage', () => storageMock(fake));

const { encrypt } = await import('@/lib/crypto');
const { applyWebhook } = await import('@/lib/plaid-webhook');
const { recordSyncs, readHealthForDisplay, withHealth, recordWarning } = await import('@/lib/connection-health');
const { warningsStore, syncsStore, noticesStore } = await import('@/lib/connection-records');
const { readCache, CacheKey } = await import('@/lib/cache');
const { classifyFailure } = await import('@/lib/connection-state');
const { forgetEpochs } = await import('@/lib/sessions');
const { fetchInstitution } = await import('@/lib/networth');
type Inst = import('@/lib/networth').InstitutionResult;

const DAY = 86_400_000;
const NOW = Date.parse('2026-10-08T13:00:00.000Z');
const at = (days: number) => new Date(NOW + days * DAY).toISOString();

const account = (id: string, current = 100) => ({
  account_id: id,
  name: 'Checking',
  official_name: null,
  type: 'depository',
  subtype: 'checking',
  mask: '4821',
  balances: { available: current, current, limit: null, iso_currency_code: 'USD' },
});

async function link(item_id: string, institution_name = 'Chase') {
  const token = `token-${item_id}`;
  await fake.hset(ctxKey('plaid:items'), {
    [item_id]: JSON.stringify({ item_id, institution_name, encrypted_access_token: await encrypt(token) }),
  });
  return token;
}
const answers = (token: string, item: Record<string, unknown> = {}) => {
  plaid[token] = () => ({ data: { item: { institution_id: 'ins_3', ...item }, accounts: [account(`acct_${token}`)] } });
};
const fails = (token: string, error_code: string) => {
  plaid[token] = () => {
    throw { response: { data: { error_code } } };
  };
};

const route = async (path: string, method: string, body?: unknown, query = '') => {
  const mod: any = await import(`@/app/api/${path}/route`);
  const res = await mod[method](new Request(`http://x/api/${path}${query}`, { method, body: body ? JSON.stringify(body) : undefined }));
  return { status: res.status, body: await res.json() };
};
const dashboard = (fresh = true) => route('net-worth', 'GET', undefined, fresh ? '?refresh=1' : '');
const healthOfItem = (body: any, item_id: string) => body.institutions.find((i: any) => i.item_id === item_id)?.health;

const quiet = { error: console.error, warn: console.warn, log: console.log };
beforeEach(async () => {
  fake.reset();
  for (const k of Object.keys(plaid)) delete plaid[k];
  txnFails.clear();
  forgetEpochs();
  console.error = () => {};
  console.warn = () => {};
  console.log = () => {};
  await registerTestContainer(fake);
});
afterEach(() => Object.assign(console, quiet));

describe("Plaid's early warnings, from the webhook", () => {
  test('a pending expiration is recorded for its connection, with the time it ends, encrypted', async () => {
    await link('item_chase');
    expect(
      await applyWebhook(ctx, { webhook_type: 'ITEM', webhook_code: 'PENDING_EXPIRATION', item_id: 'item_chase', consent_expiration_time: at(7) }, NOW)
    ).toBe(true);
    expect(await warningsStore.get(ctx, 'item_chase')).toEqual({
      kind: 'pending_expiration',
      received_at: at(0),
      ends_at: at(7),
      ends_estimated: false,
      reason: null,
    });
    // Under the connection's own opaque id, and not readable at rest.
    expect(await fake.hkeys(ctxKey('connection-warnings'))).toEqual(['item_chase']);
    const raw = await fake.hget<string>(ctxKey('connection-warnings'), 'item_chase');
    expect(raw).not.toContain('pending_expiration');
    expect(raw).not.toContain('2026');
  });

  test('a pending disconnect is recorded with its reason and an estimated end; a retry keeps the first', async () => {
    await link('item_chase');
    const hook = { webhook_type: 'ITEM', webhook_code: 'PENDING_DISCONNECT', item_id: 'item_chase', reason: 'INSTITUTION_MIGRATION' };
    await applyWebhook(ctx, hook, NOW);
    await applyWebhook(ctx, hook, NOW + 2 * DAY);
    expect(await warningsStore.get(ctx, 'item_chase')).toEqual({
      kind: 'pending_disconnect',
      received_at: at(0),
      ends_at: at(7),
      ends_estimated: true,
      reason: 'INSTITUTION_MIGRATION',
    });
  });

  test('LOGIN_REPAIRED clears the warning and the break, so a later one is told afresh', async () => {
    await link('item_chase');
    await recordWarning(ctx, 'item_chase', { webhook_code: 'PENDING_EXPIRATION' }, NOW);
    await noticesStore.set(ctx, 'item_chase', { episode: 'e1', since: at(-1), state: 'reconnect_soon', notified_at: at(-1), reminded_at: null });
    await applyWebhook(ctx, { webhook_type: 'ITEM', webhook_code: 'LOGIN_REPAIRED', item_id: 'item_chase' }, NOW);
    expect(await warningsStore.get(ctx, 'item_chase')).toBeNull();
    expect(await noticesStore.get(ctx, 'item_chase')).toBeNull();
  });

  // Review: seam rule 4. An unrecognised entry is intact data (a later
  // version's, after a rollback); an unreadable one may go only once the
  // person confirms. A webhook can do neither, so it writes over nothing.
  test('a stored warning this version cannot use is never written over: unreadable or unrecognised, it is left as it is', async () => {
    await link('item_chase');
    await link('item_amex', 'Amex');
    const later = await encrypt(JSON.stringify({ kind: 'consent_renewal', received_at: at(-1), ends_at: at(12), ends_estimated: false, reason: null, extra: 1 }));
    await fake.hset(ctxKey('connection-warnings'), { item_chase: 'damaged', item_amex: later });
    const before = await warningsStore.getAllReport(ctx);
    expect([before.unreadable, before.unrecognised]).toEqual([['item_chase'], ['item_amex']]);
    const logs: string[] = [];
    console.error = (...a: unknown[]) => void logs.push(a.join(' '));
    for (const item_id of ['item_chase', 'item_amex']) {
      expect(await recordWarning(ctx, item_id, { webhook_code: 'PENDING_DISCONNECT' }, NOW)).toBe(false);
      // Through the webhook too: answered as handled, so Plaid stops retrying
      // what would only find the same.
      expect(await applyWebhook(ctx, { webhook_type: 'ITEM', webhook_code: 'PENDING_EXPIRATION', item_id, consent_expiration_time: at(5) }, NOW)).toBe(true);
    }
    expect(await fake.hget<string>(ctxKey('connection-warnings'), 'item_chase')).toBe('damaged');
    expect(await fake.hget<string>(ctxKey('connection-warnings'), 'item_amex')).toBe(later);
    expect(logs.some((l) => l.includes('is not one this version understands'))).toBe(true);
    expect(logs.some((l) => l.includes('could not be read'))).toBe(true);
    // A repair still clears them: it ends what either said.
    await applyWebhook(ctx, { webhook_type: 'ITEM', webhook_code: 'LOGIN_REPAIRED', item_id: 'item_amex' }, NOW);
    expect(await fake.hget<string>(ctxKey('connection-warnings'), 'item_amex')).toBeNull();
  });

  test('other webhooks record nothing', async () => {
    for (const webhook_code of ['ERROR', 'NEW_ACCOUNTS_AVAILABLE', 'USER_PERMISSION_REVOKED']) {
      await applyWebhook(ctx, { webhook_type: 'ITEM', webhook_code, item_id: 'item_chase' }, NOW);
    }
    await applyWebhook(ctx, { webhook_type: 'TRANSACTIONS', webhook_code: 'PENDING_EXPIRATION', item_id: 'item_chase' }, NOW);
    expect((await warningsStore.getAll(ctx)).size).toBe(0);
  });
});

describe('a reconnect through update mode', () => {
  test('clears the connection’s warning and break, and no other connection’s', async () => {
    await link('item_chase');
    await link('item_amex', 'Amex');
    for (const id of ['item_chase', 'item_amex']) {
      await recordWarning(ctx, id, { webhook_code: 'PENDING_EXPIRATION' }, NOW);
      await noticesStore.set(ctx, id, { episode: `e-${id.slice(5)}`, since: at(-1), state: 'reconnect_soon', notified_at: at(-1), reminded_at: null });
    }
    expect(await route('item-reconnected', 'POST', { item_id: 'item_chase' })).toEqual({ status: 200, body: { ok: true } });
    expect(await warningsStore.get(ctx, 'item_chase')).toBeNull();
    expect(await noticesStore.get(ctx, 'item_chase')).toBeNull();
    expect(await warningsStore.get(ctx, 'item_amex')).not.toBeNull();
    expect(await noticesStore.get(ctx, 'item_amex')).not.toBeNull();
  });

  test('refuses what is not one of this container’s connections', async () => {
    await link('item_chase');
    expect((await route('item-reconnected', 'POST', { item_id: 'item_other' })).status).toBe(404);
    for (const body of [{}, { item_id: 42 }, { item_id: '' }, { item_id: 'x'.repeat(201) }]) {
      expect((await route('item-reconnected', 'POST', body)).status).toBe(400);
    }
  });
});

test('a disconnect forgets everything kept about the connection’s health', async () => {
  await link('item_chase');
  await recordWarning(ctx, 'item_chase', { webhook_code: 'PENDING_DISCONNECT' }, NOW);
  await syncsStore.set(ctx, 'item_chase', { at: at(0) });
  await noticesStore.set(ctx, 'item_chase', { episode: 'e1', since: at(0), state: 'needs_reauth', notified_at: null, reminded_at: null });
  expect((await route('disconnect', 'POST', { item_id: 'item_chase' })).status).toBe(200);
  for (const key of ['connection-warnings', 'connection-syncs', 'connection-notices']) expect(await fake.hkeys(ctxKey(key))).toEqual([]);
});

describe('the last good sync', () => {
  const inst = (item_id: string, over: Partial<Inst> = {}): Inst => ({
    institution_name: 'Chase',
    item_id,
    accounts: [],
    holdings: [],
    error: null,
    needs_reauth: false,
    liabilities: 'unavailable',
    ...over,
  });

  test('is recorded for each connection that answered, not for a failed one or a manual group', async () => {
    await syncsStore.set(ctx, 'item_down', { at: at(-3) });
    await recordSyncs(ctx, [inst('item_up'), inst('item_down', { error: 'Could not fetch balances' }), inst('manual:ally', { manual: true })], NOW);
    expect(Object.fromEntries(await syncsStore.getAll(ctx))).toEqual({ item_down: { at: at(-3) }, item_up: { at: at(0) } });
  });

  test('a failure to save it costs nothing', async () => {
    fake.failNext('hset');
    await recordSyncs(ctx, [inst('item_up')], NOW);
    expect(await syncsStore.get(ctx, 'item_up')).toBeNull();
  });
});

describe('what the dashboard is sent', () => {
  test('each connection’s health, its last good sync, and the date for reconnect soon', async () => {
    answers(await link('item_ok'));
    fails(await link('item_down', 'Ally'), 'INSTITUTION_DOWN');
    fails(await link('item_login', 'Amex'), 'ITEM_LOGIN_REQUIRED');
    answers(await link('item_soon', 'Citi'), { consent_expiration_time: new Date(Date.now() + 3 * DAY).toISOString() });
    await syncsStore.set(ctx, 'item_down', { at: '2026-09-12T13:00:00.000Z' });

    const { status, body } = await dashboard();
    expect(status).toBe(200);
    expect(body.health_unavailable).toBeUndefined();
    const ok = healthOfItem(body, 'item_ok');
    expect(ok).toMatchObject({ state: 'healthy', action: 'none' });
    expect(Date.now() - Date.parse(ok.last_ok_at)).toBeLessThan(60_000);
    expect(healthOfItem(body, 'item_down')).toEqual({
      state: 'outage',
      cause: 'institution_down',
      side: 'bank',
      action: 'wait',
      last_ok_at: '2026-09-12T13:00:00.000Z',
      code: 'INSTITUTION_DOWN',
    });
    expect(healthOfItem(body, 'item_login')).toMatchObject({ state: 'needs_reauth', action: 'reconnect', last_ok_at: null });
    expect(body.institutions.find((i: any) => i.item_id === 'item_login').needs_reauth).toBe(true);
    expect(healthOfItem(body, 'item_soon')).toMatchObject({ state: 'reconnect_soon', cause: 'consent_ending', ends_estimated: false });
    // And the answered ones' last good sync is now stored.
    expect([...(await syncsStore.getAll(ctx)).keys()].sort()).toEqual(['item_down', 'item_ok', 'item_soon']);
  });

  test('never frozen into the cache: a warning that lands later shows on the next cached load', async () => {
    answers(await link('item_chase'));
    const first = await dashboard();
    expect(healthOfItem(first.body, 'item_chase').state).toBe('healthy');
    const cached = await readCache<any>(ctx, CacheKey.NetWorth);
    expect(cached.institutions[0].health).toBeUndefined();
    // Recorded without the webhook's cache clear, so the next load is the cached one.
    await recordWarning(ctx, 'item_chase', { webhook_code: 'PENDING_DISCONNECT' });
    const again = await dashboard(false);
    expect(again.body.from_cache).toBe(true);
    expect(healthOfItem(again.body, 'item_chase')).toMatchObject({ state: 'reconnect_soon', cause: 'disconnect_pending', ends_estimated: true });
  });

  test('when the health stores cannot be read, it says so, and still reports what the fetch found', async () => {
    fake.failNext('hgetall');
    expect(await readHealthForDisplay(ctx)).toBeNull();
    const down: Inst = {
      institution_name: 'Chase',
      item_id: 'item_down',
      accounts: [],
      holdings: [],
      error: 'This account needs to be reconnected',
      needs_reauth: true,
      liabilities: 'unavailable',
      failure: classifyFailure({ code: 'ITEM_LOGIN_REQUIRED', responded: true }),
    };
    const manual = { ...down, item_id: 'manual:x', error: null, manual: true, failure: undefined };
    const [h, m] = withHealth([down, manual], null, at(0), NOW);
    expect(h.health).toMatchObject({ state: 'needs_reauth', last_ok_at: null });
    expect(m.health).toBeUndefined();
  });

  test('a warning it cannot read is left out, and its connection says a warning may be missing', async () => {
    await recordWarning(ctx, 'item_a', { webhook_code: 'PENDING_DISCONNECT' }, NOW);
    await fake.hset(ctxKey('connection-warnings'), { item_b: 'damaged' });
    await fake.hset(ctxKey('connection-syncs'), { item_c: await encrypt(JSON.stringify({ at: 'not a time' })) });
    const reads = await readHealthForDisplay(ctx);
    expect([...reads!.warnings.keys()]).toEqual(['item_a']);
    expect([...reads!.unread].sort()).toEqual(['item_b', 'item_c']);
    const inst = (item_id: string): Inst => ({ institution_name: 'Chase', item_id, accounts: [], holdings: [], error: null, needs_reauth: false, liabilities: 'unavailable' });
    const [a, b, c] = withHealth([inst('item_a'), inst('item_b'), inst('item_c')], reads, at(0), NOW);
    expect(a.health).toMatchObject({ state: 'reconnect_soon' });
    expect(a.health?.unread).toBeUndefined();
    expect(b.health).toMatchObject({ state: 'healthy', unread: true });
    expect(c.health).toMatchObject({ state: 'healthy', unread: true });
  });

  test('through the route: such a connection is sent with unread, not as plainly fine', async () => {
    answers(await link('item_chase'));
    await fake.hset(ctxKey('connection-warnings'), { item_chase: 'damaged' });
    const { body } = await dashboard();
    expect(body.health_unavailable).toBeUndefined();
    expect(healthOfItem(body, 'item_chase')).toMatchObject({ state: 'healthy', unread: true });
  });
});

describe('a fetch that fails says why (lib/networth.ts)', () => {
  const stored = async (item_id: string) => ({ item_id, institution_name: 'Chase', encrypted_access_token: await encrypt(`token-${item_id}`) });

  test('every code that means signing in again gets the Reconnect button, and the cause behind it', async () => {
    for (const code of ['ITEM_LOGIN_REQUIRED', 'ITEM_LOCKED', 'ACCESS_NOT_GRANTED', 'USER_SETUP_REQUIRED']) {
      fails('token-item_x', code);
      const inst = await fetchInstitution(await stored('item_x'));
      expect([code, inst.needs_reauth, inst.error, inst.failure?.code]).toEqual([code, true, 'This account needs to be reconnected', code]);
    }
    for (const code of ['INSTITUTION_DOWN', 'NO_ACCOUNTS', 'ITEM_NOT_FOUND']) {
      fails('token-item_x', code);
      const inst = await fetchInstitution(await stored('item_x'));
      expect([code, inst.needs_reauth, inst.error]).toEqual([code, false, 'Could not fetch balances']);
    }
  });

  test("Plaid's warning, as a code, is a warning on a call that answered and a reconnect on one that failed", async () => {
    plaid['token-item_x'] = () => ({ data: { item: { error: { error_code: 'PENDING_EXPIRATION', error_type: 'ITEM_ERROR' } }, accounts: [account('a1')] } });
    const answered = await fetchInstitution(await stored('item_x'));
    expect(answered).toMatchObject({ error: null, needs_reauth: false });
    expect(answered.accounts).toHaveLength(1);
    fails('token-item_x', 'PENDING_EXPIRATION');
    const failedCall = await fetchInstitution(await stored('item_x'));
    expect(failedCall).toMatchObject({ needs_reauth: true, error: 'This account needs to be reconnected' });
  });

  test('a 200 that carries a sign-in error on the Item is that failure', async () => {
    plaid['token-item_x'] = () => ({ data: { item: { error: { error_code: 'ITEM_LOCKED', error_type: 'ITEM_ERROR' } }, accounts: [account('a1')] } });
    const inst = await fetchInstitution(await stored('item_x'));
    expect(inst).toMatchObject({ needs_reauth: true, accounts: [], failure: { cause: 'locked', side: 'bank', code: 'ITEM_LOCKED' } });
  });

  // Blocking finding of the review: what a PLAID_ENV or PLAID_SECRET for
  // another environment answers. Nya's side: no Reconnect, and the health
  // view only waits.
  test('Plaid refusing the stored token or Nya’s keys is a failure on Nya’s side, without a Reconnect button', async () => {
    for (const [error_code, error_type, cause] of [
      ['INVALID_ACCESS_TOKEN', 'INVALID_INPUT', 'token'],
      ['INVALID_API_KEYS', 'INVALID_INPUT', 'setup'],
      ['MISSING_FIELDS', 'INVALID_REQUEST', 'setup'],
    ] as const) {
      plaid['token-item_x'] = () => {
        throw { response: { data: { error_code, error_type } } };
      };
      const inst = await fetchInstitution(await stored('item_x'));
      expect([error_code, inst.needs_reauth, inst.error, inst.failure]).toEqual([error_code, false, 'Could not fetch balances', { cause, side: 'nya', code: error_code }]);
    }
  });

  test('no answer at all is unreachable; credentials Nya cannot read are on Nya’s side', async () => {
    plaid['token-item_x'] = () => {
      throw new TypeError('socket hang up');
    };
    expect((await fetchInstitution(await stored('item_x'))).failure).toEqual({ cause: 'unreachable', side: 'unknown', code: null });
    const broken = { item_id: 'item_y', institution_name: 'Chase', encrypted_access_token: 'not-ciphertext' };
    expect((await fetchInstitution(broken)).failure).toEqual({ cause: 'credentials', side: 'nya', code: null });
  });

  test('a good answer carries the consent expiry Plaid reports, or null', async () => {
    answers('token-item_x', { consent_expiration_time: '2026-11-01T00:00:00Z' });
    expect((await fetchInstitution(await stored('item_x'))).consent_expires_at).toBe('2026-11-01T00:00:00.000Z');
    answers('token-item_x');
    expect((await fetchInstitution(await stored('item_x'))).consent_expires_at).toBeNull();
  });
});

test("Activity is told which institutions' transactions this load is missing, and such a load is never cached", async () => {
  await link('item_chase');
  txnFails.add(await link('item_amex', 'Amex'));
  const { body } = await route('transactions', 'GET', undefined, '?refresh=1');
  expect(body.incomplete).toEqual([{ institution_name: 'Amex', coverage: 'missing' }]);
  expect(await readCache(ctx, CacheKey.Transactions)).toBeNull();
  txnFails.clear();
  const clean = await route('transactions', 'GET', undefined, '?refresh=1');
  expect(clean.body.incomplete).toEqual([]);
});
