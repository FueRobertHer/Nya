import { describe, expect, test, mock, beforeEach, afterEach, jest } from 'bun:test';
import { FakeRedis, storageMock, testKey } from './fake-redis';

// The feature switches: the registry (lib/flags.ts), and reading and
// evaluating them (lib/flag-read.ts) over the store (lib/flag-store.ts).

const fake = new FakeRedis({ deserialize: true });
mock.module('@/lib/storage', () => storageMock(fake));

const flags = await import('@/lib/flags');
const read = await import('@/lib/flag-read');
const { flagsStore } = await import('@/lib/flag-store');
const { flagCache } = await import('@/lib/flag-cache');
const { opsGuard } = await import('@/lib/ops');

const VARIABLES = ['RESTORE_ENABLED', 'RESTORE_CARRY_ON_ENABLED', 'LUNCHFLOW_ENABLED', 'PLAID_BROKERAGE_LINK', 'API_WRITES_ENABLED', 'CSP_MODE', 'OPS_ENABLED', 'CLERK_ALLOWED_USER_IDS'];
const C1 = '5d1c7e2a-9b3f-4c6d-8e1a-2b3c4d5e6f70';
const C2 = '6e2d8f3b-0c4a-4d7e-9f2b-3c4d5e6f7a81';
const AT = '2026-11-01T12:00:00.000Z';

const saved = { ...process.env };
let errors: string[] = [];
const realError = console.error;
beforeEach(() => {
  fake.reset();
  flagCache.forget();
  process.env = { ...saved };
  for (const name of VARIABLES) delete process.env[name];
  delete process.env.VERCEL_ENV;
  errors = [];
  console.error = (...args: unknown[]) => void errors.push(args.map(String).join(' '));
});
afterEach(() => {
  console.error = realError;
  process.env = { ...saved };
});

/** Stores a value as /dev/flags would. */
const store = (key: string, value: unknown) => fake.hset(testKey('flags:values'), { [key]: JSON.stringify(value) });
const audience = (on: (typeof flags.AUDIENCES)[number], containers: string[] = []) => ({ on, containers: containers as never[], updatedAt: AT });
const who = (container: string | null, opts: { demo?: boolean; admin?: boolean } = {}): ReturnType<typeof read.flagWho> => ({
  container: container as never,
  demo: opts.demo ?? false,
  admin: async () => opts.admin ?? false,
});

describe('the registry', () => {
  test('names the eight moved switches by their variables, and the Plan’s two with none', () => {
    const named = Object.fromEntries(flags.FLAG_KEYS.map((k) => [k, 'variable' in flags.FLAGS[k] ? (flags.FLAGS[k] as { variable: string }).variable : null]));
    expect(named).toEqual({
      restore: 'RESTORE_ENABLED',
      'restore-carry-on': 'RESTORE_CARRY_ON_ENABLED',
      lunchflow: 'LUNCHFLOW_ENABLED',
      'brokerage-link': 'PLAID_BROKERAGE_LINK',
      'api-writes': 'API_WRITES_ENABLED',
      'plan-items-in-fi': null,
      'plan-child-accounts': null,
      csp: 'CSP_MODE',
      ops: 'OPS_ENABLED',
      'sign-in': 'CLERK_ALLOWED_USER_IDS',
    });
  });

  test('every flag has a sentence and what off means; a release flag has the day it should be gone by', () => {
    for (const key of flags.FLAG_KEYS) {
      const def = flags.flagDef(key);
      expect([key, def.about.length > 10 && def.offMeans.length > 10]).toEqual([key, true]);
      if (def.kind === 'release') expect([key, /^\d{4}-\d{2}-\d{2}$/.test(def.removeBy) && Number.isFinite(Date.parse(def.removeBy))]).toEqual([key, true]);
    }
    expect(flags.flagDef('plan-items-in-fi')).toMatchObject({ kind: 'release', removeBy: '2027-04-30', value: 'audience' });
    expect(flags.flagDef('plan-child-accounts')).toMatchObject({ kind: 'release', removeBy: '2027-04-30', value: 'audience' });
  });

  test('every flag has a short plain name of its own, as the admin page titles it', () => {
    const names = flags.FLAG_KEYS.map((k) => flags.flagDef(k).name);
    for (const [i, name] of names.entries()) expect([flags.FLAG_KEYS[i], name.length > 0 && name.length <= 40 && !/[\u2013\u2014]/.test(name)]).toEqual([flags.FLAG_KEYS[i], true]);
    expect(new Set(names).size).toBe(names.length);
    expect(flags.flagDef('plan-child-accounts').name).toBe('Child’s accounts out of invested assets');
  });

  test('defaults reproduce each variable unset, in every environment', () => {
    for (const env of [undefined, 'preview', 'production', 'development']) {
      if (env) process.env.VERCEL_ENV = env;
      else delete process.env.VERCEL_ENV;
      for (const key of flags.AUDIENCE_KEYS) expect([env, key, flags.defaultChoice(key)]).toEqual([env, key, 'nobody']);
      expect(flags.defaultChoice('csp')).toBe('report-only');
      expect(flags.defaultChoice('ops')).toBe('off');
    }
  });

  test('a variable is set when its value, trimmed, is not empty; then it parses as it always has', () => {
    for (const blank of ['', '   ']) {
      process.env.OPS_ENABLED = blank;
      process.env.RESTORE_ENABLED = blank;
      process.env.CLERK_ALLOWED_USER_IDS = blank;
      expect(flags.variableSet('ops')).toBe(false);
      expect(flags.audienceVariable('restore')).toBeUndefined();
      expect(flags.signInVariable()).toBeUndefined();
    }
    process.env.RESTORE_ENABLED = '1';
    expect(flags.audienceVariable('restore')).toBe(true);
    process.env.RESTORE_ENABLED = 'true'; // only "1" was ever on
    expect(flags.audienceVariable('restore')).toBe(false);
    process.env.OPS_ENABLED = '0';
    expect(flags.opsVariable()).toBe(false);
    process.env.CSP_MODE = ' Enforce ';
    expect(flags.cspVariable()).toBe('enforce');
    process.env.CSP_MODE = 'typo';
    expect(flags.cspVariable()).toBe('report-only');
    // Set, and listing nobody.
    process.env.CLERK_ALLOWED_USER_IDS = ' , ';
    expect(flags.signInVariable()).toEqual({ ids: [], emails: [] });
    process.env.CLERK_ALLOWED_USER_IDS = 'user_a, Pat@Example.com,user_a';
    expect(flags.signInVariable()).toEqual({ ids: ['user_a'], emails: ['pat@example.com'] });
  });

  test('each kind’s check takes its own shape and refuses others', () => {
    const good = {
      audience: audience('admin', [C1]),
      mode: { mode: 'enforce', updatedAt: AT },
      switch: { on: true, updatedAt: AT },
      list: { ids: ['user_a'], emails: ['pat@example.com'], updatedAt: AT },
    };
    const byKind = { audience: 'restore', mode: 'csp', switch: 'ops', list: 'sign-in' } as const;
    for (const [kind, key] of Object.entries(byKind)) {
      for (const [other, value] of Object.entries(good)) expect([key, other, flags.isFlagValue(key, value)]).toEqual([key, other, other === kind]);
    }
    expect(flags.isFlagValue('restore', audience('somebody' as never))).toBe(false);
    expect(flags.isFlagValue('restore', audience('everyone', ['not-a-container']))).toBe(false);
    expect(flags.isFlagValue('restore', audience('everyone', [C1, C1]))).toBe(false);
    expect(flags.isFlagValue('restore', { ...audience('everyone'), extra: 1 })).toBe(false);
    expect(flags.isFlagValue('restore', { ...audience('everyone'), updatedAt: 'yesterday' })).toBe(false);
    expect(flags.isFlagValue('sign-in', { ids: [], emails: ['Pat@Example.com'], updatedAt: AT })).toBe(false); // emails lowercase
    expect(flags.isFlagValue('sign-in', { ids: ['a@b'], emails: [], updatedAt: AT })).toBe(false); // an email among ids
    expect(flags.isFlagValue('unknown-flag', audience('everyone'))).toBe(false);
  });

  test('a choice sets a value of its kind, an audience keeping its accounts; the list takes none', () => {
    const now = Date.parse(AT);
    expect(flags.valueFromChoice('restore', 'admin', audience('nobody', [C1]), now)).toEqual(audience('admin', [C1]));
    expect(flags.valueFromChoice('restore', 'everyone', null, now)).toEqual(audience('everyone'));
    expect(flags.valueFromChoice('csp', 'enforce', null, now)).toEqual({ mode: 'enforce', updatedAt: AT });
    expect(flags.valueFromChoice('ops', 'on', null, now)).toEqual({ on: true, updatedAt: AT });
    expect(flags.valueFromChoice('ops', 'maybe', null, now)).toBeNull();
    expect(flags.valueFromChoice('sign-in', 'anything', null, now)).toBeNull();
    expect(flags.choiceOf('ops', { on: false, updatedAt: AT })).toBe('off');
  });
});

describe('reading them', () => {
  test('with no variable and nothing stored, each answers as its variable unset does today', async () => {
    for (const key of flags.AUDIENCE_KEYS) {
      expect([key, await read.flagOnFresh(key, who(C1, { admin: true, demo: true }))]).toEqual([key, false]);
      expect([key, await read.flagOnCached(key, who(C1, { admin: true, demo: true }))]).toEqual([key, false]);
      expect([key, await read.flagOnForAnyone(key)]).toEqual([key, false]);
    }
    expect(await read.cspModeCached()).toBe('report-only');
    expect(await read.opsOnCached()).toBe(false);
    expect(await read.opsOnFresh()).toBe(false);
    expect((await read.signInFromStore()).list).toEqual({ ids: [], emails: [] });
  });

  test('a set variable decides, and nothing is read', async () => {
    for (const name of ['RESTORE_ENABLED', 'RESTORE_CARRY_ON_ENABLED', 'LUNCHFLOW_ENABLED', 'PLAID_BROKERAGE_LINK', 'API_WRITES_ENABLED', 'OPS_ENABLED']) process.env[name] = '1';
    process.env.CSP_MODE = 'enforce';
    await store('restore', audience('nobody'));
    const before = fake.ops;
    for (const key of flags.AUDIENCE_KEYS.filter((k) => 'variable' in flags.FLAGS[k])) {
      expect([key, await read.flagOnFresh(key, who(null))]).toEqual([key, true]);
      expect([key, await read.flagOnCached(key, who(null))]).toEqual([key, true]);
    }
    expect(await read.cspModeCached()).toBe('enforce');
    expect(await read.opsOnFresh()).toBe(true);
    expect(await read.opsOnCached()).toBe(true);
    expect(fake.ops).toBe(before);
  });

  test('a stored audience: everyone, the admin, the admin and the demo accounts, and the accounts it names', async () => {
    const cases: [ReturnType<typeof audience>, ReturnType<typeof who>, boolean][] = [
      [audience('everyone'), who(null), true],
      [audience('nobody'), who(C1, { admin: true, demo: true }), false],
      [audience('admin'), who(C1, { admin: true }), true],
      [audience('admin'), who(C1, { demo: true }), false],
      [audience('admin-and-demo'), who(C1, { demo: true }), true],
      [audience('admin-and-demo'), who(C1, { admin: true }), true],
      [audience('admin-and-demo'), who(C1), false],
      [audience('nobody', [C1]), who(C1), true],
      [audience('nobody', [C1]), who(C2), false],
      [audience('nobody', [C1]), who(null), false],
    ];
    for (const [value, w, on] of cases) {
      fake.reset();
      await store('plan-child-accounts', value);
      expect([value, w.container, await read.flagOnFresh('plan-child-accounts', w)]).toEqual([value, w.container, on]);
    }
  });

  test('the admin is asked only when an audience needs it', async () => {
    let asked = 0;
    const w = { container: C1 as never, demo: false, admin: async () => (asked++, true) };
    await store('restore', audience('everyone'));
    await store('lunchflow', audience('nobody', [C1]));
    expect(await read.flagOnFresh('restore', w)).toBe(true);
    expect(await read.flagOnFresh('lunchflow', w)).toBe(true);
    expect(asked).toBe(0);
    await store('restore', audience('admin'));
    expect(await read.flagOnFresh('restore', w)).toBe(true);
    expect(asked).toBe(1);
  });

  test('each flag’s off state: on, then off, and the gate refuses', async () => {
    for (const key of flags.AUDIENCE_KEYS) {
      await store(key, audience('everyone'));
      expect([key, await read.flagOnFresh(key, who(C1))]).toEqual([key, true]);
      await store(key, audience('nobody'));
      expect([key, await read.flagOnFresh(key, who(C1))]).toEqual([key, false]);
    }
    await store('ops', { on: true, updatedAt: AT });
    expect(await read.opsOnFresh()).toBe(true);
    await store('ops', { on: false, updatedAt: AT });
    expect(await read.opsOnFresh()).toBe(false);
  });

  test('a field this release doesn’t know is skipped; a known flag’s value it can’t read takes the default, logged by key alone', async () => {
    await store('a-newer-flag', { anything: true });
    await fake.hset(testKey('flags:values'), { restore: '{"on":"everyone","containers":[],"updatedAt":"x","secret":"value"}' });
    await store('lunchflow', audience('everyone'));
    const got = await read.readFlagsFresh();
    expect([...got.keys()].sort()).toEqual(['lunchflow', 'restore']);
    expect(got.get('restore')).toBe(read.UNREADABLE);
    // Its default applies.
    expect(await read.flagOnFresh('restore', who(C1, { admin: true }))).toBe(false);
    expect(errors.some((e) => e.includes('restore') && !e.includes('secret'))).toBe(true);
    expect(errors.some((e) => e.includes('a-newer-flag'))).toBe(false);
  });

  test('a fresh read that fails answers off, logged', async () => {
    await store('restore', audience('everyone'));
    fake.failNext('hgetall');
    expect(await read.flagOnFresh('restore', who(C1))).toBe(false);
    fake.failNext('hgetall');
    expect(await read.opsOnFresh()).toBe(false);
    expect(errors.length).toBe(2);
  });
});

describe('the cache', () => {
  // Now, so the readers that take no clock (the CSP's, the sign-in list's) agree with it.
  let T = 0;
  beforeEach(() => {
    T = Date.now();
  });

  test('reads once per thirty seconds, and callers at the same time share one read', async () => {
    await store('csp', { mode: 'enforce', updatedAt: AT });
    const before = fake.ops;
    const answers = await Promise.all([read.cachedFlags(T), read.cachedFlags(T), read.cachedFlags(T)]);
    expect(answers.map((a) => a.source)).toEqual(['read', 'read', 'read']);
    expect(fake.ops - before).toBe(1);
    await store('csp', { mode: 'off', updatedAt: AT });
    expect((await read.cachedFlags(T + read.CACHE_MS - 1)).flags.get('csp')).toMatchObject({ mode: 'enforce' });
    expect((await read.cachedFlags(T + read.CACHE_MS)).flags.get('csp')).toMatchObject({ mode: 'off' });
  });

  test('a failed read keeps the last value read, then tries again thirty seconds on', async () => {
    await store('csp', { mode: 'enforce', updatedAt: AT });
    await read.cachedFlags(T);
    fake.failNext('hgetall');
    const kept = await read.cachedFlags(T + read.CACHE_MS);
    expect(kept.source).toBe('last');
    expect(kept.flags.get('csp')).toMatchObject({ mode: 'enforce' });
    // The wait runs from the failure, which the real time the read took moves
    // past T + CACHE_MS (see "from when it failed" below).
    const failedAt = flagCache.flags.triedAt;
    expect((await read.cachedFlags(failedAt + read.RETRY_MS)).source).toBe('last'); // not again yet
    expect((await read.cachedFlags(failedAt + read.CACHE_MS)).source).toBe('read');
  });

  test('with nothing read yet a failure gives the defaults, as none, and tries again two seconds on', async () => {
    fake.failNext('hgetall');
    const none = await read.cachedFlags(T);
    const failedAt = flagCache.flags.triedAt;
    expect(none.source).toBe('none');
    expect(none.flags.size).toBe(0);
    expect(await read.cspModeCached()).toBe('report-only');
    expect((await read.signInFromStore()).list).toBeNull();
    expect((await read.cachedFlags(failedAt + read.RETRY_MS)).source).toBe('read');
  });

  test('stops waiting on a slow read, and counts it as failed', async () => {
    const slow = fake.hgetall.bind(fake);
    let release: () => void = () => {};
    (fake as unknown as { hgetall: unknown }).hgetall = () => new Promise((resolve) => (release = () => resolve(null)));
    // On a fake clock: no answer a moment before the wait is up, one at it.
    jest.useFakeTimers();
    try {
      const started = Date.now();
      let answered = false;
      const pending = read.cachedFlags(T).finally(() => (answered = true));
      await new Promise((resolve) => setImmediate(resolve));
      jest.advanceTimersByTime(read.WAIT_MS - 1);
      await new Promise((resolve) => setImmediate(resolve));
      expect(answered).toBe(false);
      jest.advanceTimersByTime(1);
      const answer = await pending;
      expect(answer.source).toBe('none');
      expect(Date.now() - started).toBeGreaterThanOrEqual(read.WAIT_MS - 50);
    } finally {
      jest.useRealTimers();
      (fake as unknown as { hgetall: unknown }).hgetall = slow;
      release();
    }
  });

  test('a read under way when the cache is forgotten never lands after it, and its caller reads again', async () => {
    await store('csp', { mode: 'enforce', updatedAt: AT });
    const pending = read.cachedFlags(T);
    const before = flagCache.flags;
    flagCache.forget();
    await store('csp', { mode: 'off', updatedAt: AT });
    const answer = await pending;
    // The old slot was never written; the caller read the store again.
    expect(before.value).toBeUndefined();
    expect(answer.source).toBe('read');
    expect(answer.flags.get('csp')).toMatchObject({ mode: 'off' });
  });

  test('a failed read waits before trying again from when it failed, not from when it began', async () => {
    fake.failNext('hgetall');
    expect((await read.cachedFlags(T)).source).toBe('none');
    // The failure is kept as T plus the real time the read took (a millisecond
    // or more once earlier files have warmed the process up), never before T:
    // the wait runs from there.
    const failedAt = flagCache.flags.triedAt;
    expect(failedAt).toBeGreaterThanOrEqual(T);
    const reads = fake.ops;
    expect((await read.cachedFlags(failedAt + read.RETRY_MS - 1)).source).toBe('none');
    expect(fake.ops).toBe(reads);
    expect((await read.cachedFlags(failedAt + read.RETRY_MS)).source).toBe('read');
  });

  test('a stored sign-in list that can’t be read leaves who may sign in unknown, never refusing those on it', async () => {
    await fake.hset(testKey('flags:values'), { 'sign-in': '{"ids":"not a list"}' });
    expect((await read.signInFromStore()).list).toBeNull();
  });

  test('a page’s flags: booleans for the audience flags only', async () => {
    await store('plan-child-accounts', audience('nobody', [C1]));
    await store('sign-in', { ids: ['user_a'], emails: [], updatedAt: AT });
    const sent = await read.clientFlags(who(C1));
    expect(sent).toEqual({ restore: false, 'restore-carry-on': false, lunchflow: false, 'brokerage-link': false, 'api-writes': false, 'plan-items-in-fi': false, 'plan-child-accounts': true });
  });
});

describe('how long a change stays new', () => {
  // Each test's values carry an updatedAt of their own, since newUntil keeps
  // its answer per stored value.
  const turn = (on: (typeof flags.AUDIENCES)[number], at: string, containers: string[] = []) =>
    flagsStore.update('plan-items-in-fi', () => ({ on, containers: containers as never[], updatedAt: at }), 'local development', Date.parse(at));

  test('not on for everyone: a far-off day, so the line shows wherever it is on', async () => {
    expect(await read.newUntil('plan-items-in-fi')).toBe('9999-12-31');
    await turn('admin', '2026-11-02T09:00:00.000Z');
    expect(await read.newUntil('plan-items-in-fi')).toBe('9999-12-31');
  });

  test('on for everyone: sixty days from the latest change that turned it on, kept per value', async () => {
    await turn('admin', '2026-10-01T09:00:00.000Z');
    await turn('everyone', '2026-10-02T09:00:00.000Z');
    await turn('nobody', '2026-10-03T09:00:00.000Z');
    await turn('everyone', '2026-11-01T12:00:00.000Z');
    // A change that keeps it on for everyone doesn't start it again.
    await turn('everyone', '2026-11-05T12:00:00.000Z', [C1]);
    flagCache.forget();
    expect(read.NEW_DAYS).toBe(60);
    expect(await read.newUntil('plan-items-in-fi')).toBe('2026-12-31');
    const before = fake.ops;
    expect(await read.newUntil('plan-items-in-fi')).toBe('2026-12-31');
    expect(fake.ops).toBe(before);
  });

  test('that change gone from the record: a past day, so it never reads as new, kept per value', async () => {
    await store('plan-items-in-fi', { on: 'everyone', containers: [], updatedAt: '2026-11-06T12:00:00.000Z' });
    expect(await read.newUntil('plan-items-in-fi')).toBe('1970-01-01');
    const before = fake.ops;
    expect(await read.newUntil('plan-items-in-fi')).toBe('1970-01-01');
    expect(fake.ops).toBe(before);
  });

  test('a record that can’t be read: a past day, not kept, so the next page asks again', async () => {
    await turn('everyone', '2026-11-07T12:00:00.000Z');
    flagCache.forget();
    await read.cachedFlags();
    fake.failNext('hgetall');
    expect(await read.newUntil('plan-items-in-fi')).toBe('1970-01-01');
    expect(errors).toEqual([]);
    expect(await read.newUntil('plan-items-in-fi')).toBe('2027-01-06');
  });
});

describe('the ops routes', () => {
  const ask = (secret?: string) => opsGuard(new Request('https://nya.test/api/ops/export', { method: 'POST', headers: secret ? { authorization: `Bearer ${secret}` } : {} }));

  test('turned off holds at once for every request, signed with the secret or not, even while this copy still says on', async () => {
    process.env.OPS_SECRET = 'the-secret';
    await store('ops', { on: true, updatedAt: AT });
    expect(await ask('the-secret')).toBeNull();
    expect((await ask('wrong'))!.status).toBe(401);
    await store('ops', { on: false, updatedAt: AT });
    // This instance's copy still says on: the fresh read decides.
    expect((await read.cachedFlags()).flags.get('ops')).toMatchObject({ on: true });
    expect((await ask('wrong'))!.status).toBe(404);
    expect((await ask())!.status).toBe(404);
    expect((await ask('the-secret'))!.status).toBe(404);
  });

  test('off, a probe reads nothing', async () => {
    process.env.OPS_SECRET = 'the-secret';
    await read.cachedFlags();
    const reads = fake.ops;
    expect((await ask('the-secret'))!.status).toBe(404);
    expect(fake.ops).toBe(reads);
  });
});

describe('the store', () => {
  test('a change through it lands in both keys, as plain text', async () => {
    await flagsStore.update('ops', () => ({ on: true, updatedAt: AT }), 'local development', Date.parse(AT));
    expect(JSON.parse(String(fake.hashes.get(testKey('flags:values'))!.get('ops')))).toEqual({ on: true, updatedAt: AT });
    const [change] = (await flagsStore.changes()).entries;
    expect(change).toMatchObject({ key: 'ops', from: null, to: { on: true }, by: 'local development' });
    expect(await flagsStore.update('ops', () => ({ on: 'yes' }) as never, 'local development').catch((e: unknown) => e)).toBeInstanceOf(TypeError);
  });
});
