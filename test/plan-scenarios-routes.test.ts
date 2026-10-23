import { describe, expect, test, mock, beforeEach, afterEach, afterAll, setSystemTime } from 'bun:test';
import { clerk } from './clerk-mock';
import { FakeRedis, storageMock, ctxKey, TEST_CTX, registerTestContainer, unscopedDataKeys } from './fake-redis';

// The saved Plan scenarios on the storage seam (app/api/plan-scenarios,
// lib/plan-scenarios.ts): every field checked, at most MAX_PLAN_SCENARIOS
// even when saves meet at the limit, an edit only to the version the page
// loaded, one a newer version saved never changed or deleted, a damaged one
// deleted only once confirmed, each person's own, the seam's errors, and in
// the data download. Only settings are ever stored, never a figure.

process.env.PLAID_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');

const fake = new FakeRedis({ deserialize: true });
mock.module('@/lib/storage', () => storageMock(fake));
afterEach(() => expect(unscopedDataKeys(fake)).toEqual([]));

/** The file's own clock: Oct 22, 2026, 15:00 UTC. */
const NOW = Date.parse('2026-10-22T15:00:00.000Z');
setSystemTime(new Date(NOW));
afterAll(() => setSystemTime());

const { ctx, OTHER, seedOther } = await import('./api-fixture');
const { encrypt } = await import('@/lib/crypto');
const { forgetEpochs } = await import('@/lib/sessions');
const { planScenariosStore } = await import('@/lib/plan-scenarios');
const { MAX_PLAN_SCENARIOS } = await import('@/lib/fire/scenarios');
const { declaredStore } = await import('@/lib/stores');
const { acrossParts } = await import('@/lib/user-restore/plan');
const { collectUserData, buildUserExport } = await import('@/lib/user-export');
const route = await import('@/app/api/plan-scenarios/route');

const env = { ...process.env };

beforeEach(async () => {
  setSystemTime(new Date(NOW));
  fake.reset();
  forgetEpochs();
  clerk.signedIn = null;
  delete process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;
  delete process.env.CLERK_SECRET_KEY;
  delete process.env.CONTAINER_ID;
  await registerTestContainer(fake);
});
afterEach(() => {
  process.env = { ...env };
});

const quiet = async <T>(f: () => Promise<T>): Promise<T> => {
  const [error, warn] = [console.error, console.warn];
  console.error = () => {};
  console.warn = () => {};
  try {
    return await f();
  } finally {
    console.error = error;
    console.warn = warn;
  }
};

const call = async (method: 'GET' | 'POST' | 'PUT' | 'DELETE', body?: unknown) => {
  const init: RequestInit = { method };
  if (body !== undefined) init.body = typeof body === 'string' ? body : JSON.stringify(body);
  const res = await (route as any)[method](new Request('https://nya.test/api/plan-scenarios', init));
  return { res, body: await res.json() };
};

const draft = (over: Record<string, unknown> = {}) => ({
  name: 'Retire at 50',
  currency: 'USD',
  set: { targetAge: 50, spending: 45_000 },
  income: { leaveOut: ['ss'], add: [] },
  expenses: { leaveOut: [], add: [{ id: 'car', label: 'Car', amount: 30_000, atAge: 60 }] },
  events: [{ id: 'c1', kind: 'child', label: 'A child', fromAge: 42, yearly: 15_000, years: 18 }],
  ...over,
});

const stored = (name: string, over: Record<string, unknown> = {}) => ({
  version: 1 as const,
  name,
  currency: null,
  createdAt: '2026-10-01T00:00:00.000Z',
  savedAt: '2026-10-01T00:00:00.000Z',
  rev: `rev-${name}`,
  set: {},
  income: { leaveOut: [], add: [] },
  expenses: { leaveOut: [], add: [] },
  events: [],
  ...over,
});

describe('saved plan scenarios, on the storage seam', () => {
  test('saved, listed in the order they were made, edited and deleted, each under a random id, in the data download', async () => {
    const saved = await call('POST', { scenario: draft() });
    expect(saved.res.status).toBe(200);
    const at = new Date(NOW).toISOString();
    expect(saved.body.scenario).toMatchObject({ version: 1, name: 'Retire at 50', currency: 'USD', createdAt: at, savedAt: at });
    expect(saved.body.scenario.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(saved.body.scenario.rev).toMatch(/^[0-9a-f-]{36}$/);
    // Only what the person chose: never a figure.
    expect(Object.keys(saved.body.scenario).sort()).toEqual(['createdAt', 'currency', 'events', 'expenses', 'id', 'income', 'name', 'rev', 'savedAt', 'set', 'version']);

    setSystemTime(new Date(NOW + 60_000));
    const second = await call('POST', { scenario: draft({ name: 'Part time' }) });
    expect((await call('GET')).body).toEqual({ scenarios: [saved.body.scenario, second.body.scenario], unreadable_ids: [], unrecognised_ids: [] });

    // An edit keeps when it was made and its place, and gets a new version.
    setSystemTime(new Date(NOW + 120_000));
    const edited = await call('PUT', { id: saved.body.scenario.id, based_on: saved.body.scenario.rev, scenario: draft({ name: 'Retire at 52', set: { targetAge: 52 } }) });
    expect(edited.res.status).toBe(200);
    expect(edited.body.scenario).toMatchObject({ id: saved.body.scenario.id, name: 'Retire at 52', createdAt: at, savedAt: new Date(NOW + 120_000).toISOString() });
    expect(edited.body.scenario.rev).not.toBe(saved.body.scenario.rev);
    expect((await call('GET')).body.scenarios.map((s: any) => s.name)).toEqual(['Retire at 52', 'Part time']);

    expect(declaredStore('plan-scenarios')).toMatchObject({ kind: 'map', exportable: true, what: 'saved plan scenarios' });
    const doc = buildUserExport(await quiet(() => collectUserData({ ctx, userId: null })), new Date(NOW)) as any;
    expect(JSON.stringify(doc['plan-scenarios'])).toContain('Retire at 52');

    expect((await call('DELETE', { id: saved.body.scenario.id })).res.status).toBe(200);
    expect((await call('GET')).body.scenarios.map((s: any) => s.name)).toEqual(['Part time']);
  });

  test('every field is checked, and anything else refused', async () => {
    const refused: [unknown, string][] = [
      ['not json', 'Send the scenario'],
      [{ scenario: draft(), extra: 1 }, 'extra isn’t taken here'],
      [{ scenario: draft({ name: '' }) }, 'A name is 1 to 40 characters'],
      [{ scenario: draft({ name: 'two\nlines' }) }, 'on one line'],
      [{ scenario: draft({ currency: null }) }, 'needs the currency they are in'],
      [{ scenario: draft({ currency: 'usd' }) }, 'three-letter code'],
      [{ scenario: draft({ set: { age: 50 } }) }, 'isn’t a setting a scenario can change'],
      [{ scenario: draft({ set: { withdrawalRate: 0.5 } }) }, 'withdrawalRate must be a number'],
      [{ scenario: draft({ set: { start: 'custom' } }) }, 'starts from a balance you typed needs that balance'],
      [{ scenario: draft({ events: [{ id: 'x', kind: 'windfall', label: 'Gift', atAge: 50, amount: 1 }] }) }, 'not a kind of life event'],
      [{ scenario: draft({ events: [{ id: 'x', kind: 'child', label: 'A child', fromAge: 42, yearly: 0, years: 18 }] }) }, 'extra spending a year'],
      [{ scenario: { ...draft(), result: 0.93 } }, 'result isn’t part of a scenario'],
    ];
    for (const [body, words] of refused) {
      const r = await call('POST', body);
      expect([JSON.stringify(body).slice(0, 60), r.res.status, r.body.error]).toEqual([JSON.stringify(body).slice(0, 60), 400, expect.stringContaining(words)]);
    }
    for (const body of [{}, { id: '../x', based_on: 'r', scenario: draft() }, { id: 'a', scenario: draft() }, { id: 'a', based_on: 'r', scenario: draft({ name: '' }) }, { id: 'a', based_on: 'r', scenario: draft(), also: 1 }]) {
      expect((await call('PUT', body)).res.status).toBe(400);
    }
    for (const body of [{}, { id: '../x' }, { id: 'a', also: 1 }, { id: 'a', unreadable: 'yes' }]) expect((await call('DELETE', body)).res.status).toBe(400);
    expect((await call('GET')).body.scenarios).toEqual([]);
  });

  test('a name another scenario has, in any case, is refused, on a new one and on an edit', async () => {
    const first = (await call('POST', { scenario: draft() })).body.scenario;
    const again = await call('POST', { scenario: draft({ name: ' retire AT 50 ' }) });
    expect([again.res.status, again.body.error]).toEqual([409, 'Another scenario has that name: choose another, so they can be told apart.']);
    const other = (await call('POST', { scenario: draft({ name: 'Part time' }) })).body.scenario;
    const renamed = await call('PUT', { id: other.id, based_on: other.rev, scenario: draft({ name: 'Retire at 50' }) });
    expect(renamed.res.status).toBe(409);
    // Its own name, kept on an edit, is no clash.
    expect((await call('PUT', { id: first.id, based_on: first.rev, scenario: draft({ name: 'RETIRE AT 50' }) })).res.status).toBe(200);
    expect(await planScenariosStore.count(ctx)).toBe(2);
  });

  test('two that already share a name (saved at the same moment) can both still be changed, and renamed apart, but not renamed to it', async () => {
    await planScenariosStore.set(ctx, 'a', stored('Retire at 50', { rev: 'ra' }));
    await planScenariosStore.set(ctx, 'b', stored('retire at 50', { rev: 'rb' }));
    const edit = await call('PUT', { id: 'a', based_on: 'ra', scenario: draft({ name: 'Retire at 50', set: { targetAge: 52 } }) });
    expect(edit.res.status).toBe(200);
    expect(edit.body.scenario.set.targetAge).toBe(52);
    const apart = await call('PUT', { id: 'b', based_on: 'rb', scenario: draft({ name: 'Retire at 52' }) });
    expect(apart.res.status).toBe(200);
    // Renamed to a name the other has: refused, and nothing written.
    const back = await call('PUT', { id: 'b', based_on: apart.body.scenario.rev, scenario: draft({ name: 'RETIRE at 50' }) });
    expect([back.res.status, back.body.error]).toEqual([409, 'Another scenario has that name: choose another, so they can be told apart.']);
    expect((await planScenariosStore.get(ctx, 'b'))?.name).toBe('Retire at 52');
    // A stale edit is still said to be stale first, with the version as it is now.
    const stale = await call('PUT', { id: 'b', based_on: 'rb', scenario: draft({ name: 'Retire at 50' }) });
    expect([stale.res.status, stale.body.stale, stale.body.scenario.name]).toEqual([409, true, 'Retire at 52']);
  });

  test('at most MAX_PLAN_SCENARIOS, counting one that can’t be read', async () => {
    for (let i = 0; i < MAX_PLAN_SCENARIOS - 1; i++) await planScenariosStore.set(ctx, `s${i}`, stored(`S${i}`));
    await fake.hset(ctxKey('plan-scenarios'), { broken: 'damaged-bytes-not-ciphertext-at-all' });
    const r = await call('POST', { scenario: draft() });
    expect([r.res.status, r.body.error]).toEqual([409, `At most ${MAX_PLAN_SCENARIOS} scenarios can be saved: delete one first`]);
  });

  test('eleven saves sent together never leave more than MAX_PLAN_SCENARIOS', async () => {
    const results = await Promise.all(Array.from({ length: MAX_PLAN_SCENARIOS + 1 }, (_, i) => call('POST', { scenario: draft({ name: `Together ${i}` }) })));
    const count = await planScenariosStore.count(ctx);
    expect(count).toBeLessThanOrEqual(MAX_PLAN_SCENARIOS);
    const saved = results.filter((r) => r.res.status === 200);
    expect(results.every((r) => r.res.status === 200 || r.res.status === 409)).toBe(true);
    expect(saved.length).toBeLessThan(results.length);
    for (const r of results.filter((x) => x.res.status === 409)) {
      expect([`At most ${MAX_PLAN_SCENARIOS} scenarios can be saved: delete one first`, 'Other scenarios were being saved at the same moment, so this one wasn’t: try again.']).toContain(r.body.error);
    }
    // Each save answered as saved is stored, each refused one is not.
    expect(count).toBe(saved.length);
    for (const r of saved) expect(await planScenariosStore.get(ctx, r.body.scenario.id)).toMatchObject({ name: r.body.scenario.name });
  });

  test('a download holding up to twice the limit is one a restore takes back', () => {
    const file = (n: number) =>
      ({ core: {}, bank: { accounts: new Map() }, books: new Map(), entries: new Map([['plan-scenarios', Array.from({ length: n }, (_, i) => ({ id: `s${i}`, value: {} }))]]) }) as any;
    expect(acrossParts(file(MAX_PLAN_SCENARIOS * 2))).toBeNull();
    expect(acrossParts(file(MAX_PLAN_SCENARIOS * 2 + 1))).toContain('plan-scenarios');
  });

  test('an edit only to the version the page loaded: a stale one is refused with it as it is now', async () => {
    const saved = (await call('POST', { scenario: draft() })).body.scenario;
    const first = await call('PUT', { id: saved.id, based_on: saved.rev, scenario: draft({ name: 'On my phone' }) });
    expect(first.res.status).toBe(200);
    // The other device still has the first version.
    const stale = await call('PUT', { id: saved.id, based_on: saved.rev, scenario: draft({ name: 'On my laptop' }) });
    expect(stale.res.status).toBe(409);
    expect(stale.body).toMatchObject({ stale: true, error: 'This scenario was changed on another device: here it is as it is now.', scenario: { id: saved.id, name: 'On my phone', rev: first.body.scenario.rev } });
    expect(await planScenariosStore.get(ctx, saved.id)).toMatchObject({ name: 'On my phone' });
  });

  test('an edit to one that was deleted makes nothing, so never one past the limit', async () => {
    const saved = (await call('POST', { scenario: draft() })).body.scenario;
    await call('DELETE', { id: saved.id });
    const r = await call('PUT', { id: saved.id, based_on: saved.rev, scenario: draft() });
    expect([r.res.status, r.body.error]).toEqual([404, 'That scenario isn’t there any more: it was deleted.']);
    expect(await planScenariosStore.count(ctx)).toBe(0);
  });

  test('one that can’t be read is named, never dropped, and deleted only once confirmed; one a newer version saved is never changed or deleted', async () => {
    await planScenariosStore.set(ctx, 'good', stored('Good'));
    await fake.hset(ctxKey('plan-scenarios'), { broken: 'damaged-bytes-not-ciphertext-at-all', later: await encrypt(TEST_CTX, JSON.stringify({ ...stored('Later'), version: 2 })) });
    const listed = await quiet(() => call('GET'));
    expect(listed.res.status).toBe(200);
    expect(listed.body.scenarios.map((s: any) => s.id)).toEqual(['good']);
    expect(listed.body.unreadable_ids).toEqual(['broken']);
    expect(listed.body.unrecognised_ids).toEqual(['later']);
    expect((await quiet(() => call('DELETE', { id: 'broken' }))).res.status).toBe(409);
    expect((await call('DELETE', { id: 'broken', unreadable: true })).res.status).toBe(200);
    const newer = 'That scenario was saved by a newer version of Nya, so it can’t be changed or deleted here.';
    for (const body of [{ id: 'later' }, { id: 'later', unreadable: true }]) {
      const r = await quiet(() => call('DELETE', body));
      expect([r.res.status, r.body.error]).toEqual([409, newer]);
    }
    const put = await quiet(() => call('PUT', { id: 'later', based_on: 'rev-Later', scenario: draft() }));
    expect([put.res.status, put.body.error]).toEqual([409, newer]);
    const before = await fake.hget(ctxKey('plan-scenarios'), 'later');
    expect(before).not.toBeNull();
    expect((await quiet(() => call('GET'))).body.unrecognised_ids).toEqual(['later']);
    // A damaged one can't be edited either: it is read before anything is written.
    await fake.hset(ctxKey('plan-scenarios'), { broken: 'damaged-bytes-not-ciphertext-at-all' });
    const damaged = await quiet(() => call('PUT', { id: 'broken', based_on: 'r', scenario: draft() }));
    expect([damaged.res.status, damaged.body.unreadable]).toEqual([409, true]);
    expect((await fake.hget(ctxKey('plan-scenarios'), 'broken')) as unknown).toBe('damaged-bytes-not-ciphertext-at-all');
  });

  test('each person’s own: another’s are never listed, edited or deleted from here', async () => {
    await seedOther(fake);
    await planScenariosStore.set(OTHER, 'theirs', stored('OTHER-SECRET-SCENARIO'));
    expect(JSON.stringify((await call('GET')).body)).not.toContain('OTHER-SECRET');
    expect((await call('PUT', { id: 'theirs', based_on: 'rev-OTHER-SECRET-SCENARIO', scenario: draft() })).res.status).toBe(404);
    expect((await call('DELETE', { id: 'theirs' })).res.status).toBe(200);
    expect(await planScenariosStore.get(OTHER, 'theirs')).toMatchObject({ name: 'OTHER-SECRET-SCENARIO' });
    expect(await planScenariosStore.count(ctx)).toBe(0);
  });

  test('the seam’s errors: 503 with no container', async () => {
    fake.reset();
    forgetEpochs();
    expect((await quiet(() => call('GET'))).res.status).toBe(503);
    expect((await quiet(() => call('POST', { scenario: draft() }))).res.status).toBe(503);
    expect((await quiet(() => call('PUT', { id: 'a', based_on: 'r', scenario: draft() }))).res.status).toBe(503);
    expect((await quiet(() => call('DELETE', { id: 'a' }))).res.status).toBe(503);
  });

  test('and 500 for storage that fails, with nothing of it said', async () => {
    fake.failNext('hset');
    const failed = await quiet(() => call('POST', { scenario: draft() }));
    expect([failed.res.status, failed.body]).toEqual([500, { error: 'Failed to save the scenario' }]);
    expect(await planScenariosStore.count(ctx)).toBe(0);
    const saved = (await call('POST', { scenario: draft() })).body.scenario;
    fake.failNext('eval');
    const put = await quiet(() => call('PUT', { id: saved.id, based_on: saved.rev, scenario: draft({ name: 'x' }) }));
    expect([put.res.status, put.body]).toEqual([500, { error: 'Failed to save the scenario' }]);
    expect(await planScenariosStore.get(ctx, saved.id)).toMatchObject({ name: 'Retire at 50' });
  });
});
