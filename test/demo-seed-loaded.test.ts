import { describe, expect, test, mock, beforeEach, afterEach, spyOn } from 'bun:test';
import { FakeRedis, storageMock, registerTestContainer, unscopedDataKeys } from './fake-redis';
import type { SeedRecord } from '@/lib/demo-seed/store';

// What the sign-in page says each demo account was last reset to
// (lib/demo-seed/loaded.ts), read from the record of its resets in the
// container it owns: the scenario's title once a reset finished, and nothing
// otherwise, never an error, never long, and kept for a while.

process.env.PLAID_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');

const fake = new FakeRedis();
afterEach(() => expect(unscopedDataKeys(fake)).toEqual([]));
mock.module('@/lib/storage', () => storageMock(fake));

const { loadedScenarios, forgetLoadedScenarios, LOADED_KEPT_MS, LOADED_WAIT_MS } = await import('@/lib/demo-seed/loaded');
const { seedRecordStore, SEED_VERSION, RESET_RUNS_AT_MOST_MS } = await import('@/lib/demo-seed/store');
const { demoTarget } = await import('@/lib/demo-seed/guard');
const { ownerContainer } = await import('@/lib/owners');
const { demoUsers } = await import('@/lib/demo');

const saved = { ...process.env };
const env = (vars: Record<string, string | undefined>) => {
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) delete (process.env as any)[k];
    else (process.env as any)[k] = v;
  }
};

beforeEach(async () => {
  fake.reset();
  forgetLoadedScenarios();
  await registerTestContainer(fake);
  env({
    VERCEL_ENV: 'preview',
    NODE_ENV: undefined,
    NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: 'pk_test_x',
    CLERK_SECRET_KEY: 'sk_test_x',
    DEMO_USER_IDS: 'user_alex:Alex, user_sam:Sam',
  });
  await ownerContainer('user_owner'); // the first sign-in takes the primary container
  await ownerContainer('user_alex');
  await ownerContainer('user_sam');
});
afterEach(() => {
  process.env = { ...saved };
  forgetLoadedScenarios();
});

const ctxOf = async (userId: string) => (await demoTarget(userId))!.ctx;
/** A reset of `scenario` that started `ago` ms back, finished or not. */
const reset = async (userId: string, scenario: string, finished: boolean, ago = 90_000) => {
  const record: SeedRecord = {
    version: SEED_VERSION,
    scenario,
    started_at: new Date(Date.now() - ago).toISOString(),
    finished_at: finished ? new Date(Date.now() - ago + 60_000).toISOString() : null,
  };
  await seedRecordStore.set(await ctxOf(userId), record);
};

describe('what each demo account was last reset to', () => {
  test('the title of the scenario each finished reset loaded, by account', async () => {
    await reset('user_alex', 'single-renter', true);
    await reset('user_sam', 'early-retiree', true);
    expect(await loadedScenarios(demoUsers())).toEqual({ user_alex: 'Single renter', user_sam: 'Early retiree' });
  });

  test('no line for an account never reset, nor one that hasn’t signed in here', async () => {
    await reset('user_alex', 'household', true);
    expect(await loadedScenarios(demoUsers())).toEqual({ user_alex: 'Two-income household' });
    forgetLoadedScenarios();
    env({ DEMO_USER_IDS: 'user_alex:Alex, user_new:Sam' });
    expect(await loadedScenarios(demoUsers())).toEqual({ user_alex: 'Two-income household' });
  });

  test('no line while a reset runs, nor for one that stopped part way', async () => {
    await reset('user_alex', 'household', false, 60_000);
    await reset('user_sam', 'household', false, RESET_RUNS_AT_MOST_MS + 60_000);
    expect(await loadedScenarios(demoUsers())).toEqual({});
  });

  test('no line for a scenario this deployment doesn’t know', async () => {
    await reset('user_alex', 'a-later-scenario', true);
    await reset('user_sam', 'household', true);
    expect(await loadedScenarios(demoUsers())).toEqual({ user_sam: 'Two-income household' });
  });

  test('nothing read without demo accounts', async () => {
    const before = fake.ops;
    expect(await loadedScenarios([])).toEqual({});
    expect(fake.ops).toBe(before);
  });
});

describe('never an error', () => {
  test('a read that fails is no line for that account, and the page still loads', async () => {
    await reset('user_alex', 'single-renter', true);
    await reset('user_sam', 'household', true);
    const logged = spyOn(console, 'error').mockImplementation(() => {});
    try {
      fake.failNext('get', 2);
      await expect(loadedScenarios(demoUsers())).resolves.toEqual({});
      expect(logged).toHaveBeenCalledWith('Demo scenario not read for the sign-in page', 'Error');
      forgetLoadedScenarios();
      fake.failNext('hget', 50);
      await expect(loadedScenarios(demoUsers())).resolves.toEqual({});
    } finally {
      logged.mockRestore();
    }
  });

  test('a container the reset refuses is no line, and not a failure', async () => {
    await reset('user_alex', 'single-renter', true);
    await reset('user_sam', 'household', true);
    await fake.hset('test:owners', { user_partner: (await ctxOf('user_sam')).container });
    const logged = spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(await loadedScenarios(demoUsers())).toEqual({ user_alex: 'Single renter' });
      expect(logged).not.toHaveBeenCalled();
    } finally {
      logged.mockRestore();
    }
  });
});

describe('never long', () => {
  test('the page waits a short while at most, and an account that hasn’t answered has no line', async () => {
    expect(LOADED_WAIT_MS).toBeLessThanOrEqual(1000);
    await reset('user_alex', 'single-renter', true);
    await reset('user_sam', 'household', true);
    const sam = String((await ctxOf('user_sam')).container);
    const realGet = fake.get;
    // Sam's record never comes back.
    fake.get = ((key: string) => (key.includes(sam) ? new Promise(() => {}) : realGet.call(fake, key))) as typeof fake.get;
    try {
      const started = performance.now();
      const got = await loadedScenarios(demoUsers(), { waitMs: 40 });
      expect(performance.now() - started).toBeLessThan(500);
      expect(got).toEqual({ user_alex: 'Single renter' });
    } finally {
      fake.get = realGet;
    }
  });
});

describe('kept a while', () => {
  test('one answer serves every load for 30 seconds, reading nothing, then it is read again', async () => {
    expect(LOADED_KEPT_MS).toBe(30_000);
    const t = Date.now();
    await reset('user_alex', 'single-renter', true);
    expect(await loadedScenarios(demoUsers(), { now: t })).toEqual({ user_alex: 'Single renter' });
    await reset('user_alex', 'early-retiree', true);
    const before = fake.ops;
    expect(await loadedScenarios(demoUsers(), { now: t + LOADED_KEPT_MS - 1 })).toEqual({ user_alex: 'Single renter' });
    expect(fake.ops).toBe(before);
    expect(await loadedScenarios(demoUsers(), { now: t + LOADED_KEPT_MS })).toEqual({ user_alex: 'Early retiree' });
    expect(fake.ops).toBeGreaterThan(before);
  });

  test('loads that arrive together wait on one read', async () => {
    await reset('user_alex', 'single-renter', true);
    const first = loadedScenarios(demoUsers());
    const second = loadedScenarios(demoUsers());
    expect(second).toBe(first);
    expect(await second).toEqual({ user_alex: 'Single renter' });
  });

  test('other demo accounts are read afresh', async () => {
    await reset('user_alex', 'single-renter', true);
    await reset('user_sam', 'household', true);
    expect(await loadedScenarios(demoUsers())).toEqual({ user_alex: 'Single renter', user_sam: 'Two-income household' });
    env({ DEMO_USER_IDS: 'user_sam:Sam' });
    expect(await loadedScenarios(demoUsers())).toEqual({ user_sam: 'Two-income household' });
  });
});
