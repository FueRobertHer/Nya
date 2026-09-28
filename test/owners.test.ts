import { describe, expect, test, mock, beforeEach, afterEach, afterAll } from 'bun:test';
import { clerk } from './clerk-mock';
import { startRedis, type RealRedis } from './real-redis';
import { FakeRedis, storageMock, registerTestContainer, TEST_CONTAINER, testKey } from './fake-redis';

// Clerk's auth(), reduced to who is signed in.

const fake = new FakeRedis();
mock.module('@/lib/storage', () => storageMock(fake));

const { dataCtx, deploymentCtx } = await import('@/lib/data-ctx');
const ingest = await import('@/app/api/ingest/balance/route');
const { ownerContainer, ownersKey } = await import('@/lib/owners');
const { forgetEpochs } = await import('@/lib/sessions');
const { registryKey } = await import('@/lib/containers');

const saved = { ...process.env };
beforeEach(async () => {
  fake.reset();
  forgetEpochs();
  clerk.signedIn = null;
  process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY = 'pk_test_x';
  process.env.CLERK_SECRET_KEY = 'sk_test_x';
  await registerTestContainer(fake);
});
afterEach(() => {
  process.env = { ...saved };
});

const owners = async () => (await fake.hgetall<Record<string, string>>(ownersKey())) ?? {};

describe('which container a Clerk account reaches', () => {
  test('the first sign-in claims the data already here, and keeps it', async () => {
    clerk.signedIn = 'user_owner';
    expect(String((await dataCtx()).container)).toBe(TEST_CONTAINER);
    expect(await owners()).toEqual({ user_owner: TEST_CONTAINER });
    expect(String((await dataCtx()).container)).toBe(TEST_CONTAINER);
  });

  test('anyone after that gets a new, empty container of their own, never the first one', async () => {
    clerk.signedIn = 'user_owner';
    await dataCtx();
    clerk.signedIn = 'user_partner';
    const theirs = String((await dataCtx()).container);
    expect(theirs).not.toBe(TEST_CONTAINER);
    expect(String((await dataCtx()).container)).toBe(theirs); // and keeps it
    const record = JSON.parse((await fake.hget<string>(registryKey(), theirs))!);
    expect(record).toMatchObject({ status: 'active', primary: false });
    expect(await owners()).toEqual({ user_owner: TEST_CONTAINER, user_partner: theirs });
    // The deployment's container is still the first one: jobs without a session use it.
    forgetEpochs();
    expect(String((await deploymentCtx()).container)).toBe(TEST_CONTAINER);
  });

  test('two first sign-ins at once: one claims the data, the other gets its own', async () => {
    const [a, b] = await Promise.all([ownerContainer('user_a'), ownerContainer('user_b')]);
    expect(new Set([String(a), String(b)]).size).toBe(2);
    expect([String(a), String(b)]).toContain(TEST_CONTAINER);
    expect(Object.keys(await owners()).length).toBe(2);
  });

  // Someone cleared the whole map by hand: whoever signs in next must not take
  // the first container, with its owner's banks.
  test('with nothing mapped but several containers, nobody claims anything', async () => {
    await ownerContainer('user_owner');
    const theirs = await ownerContainer('user_partner');
    await fake.del(ownersKey());
    await expect(ownerContainer('user_partner')).rejects.toThrow('several containers exist');
    await expect(ownerContainer('user_owner')).rejects.toThrow('several containers exist');
    expect(await owners()).toEqual({});
    const registry = (await fake.hgetall<Record<string, string>>(registryKey())) ?? {};
    expect(Object.keys(registry).sort()).toEqual([TEST_CONTAINER, String(theirs)].sort());
  });

  test('a new account signing in from two tabs at once gets one container', async () => {
    await ownerContainer('user_owner');
    const [a, b] = await Promise.all([ownerContainer('user_partner'), ownerContainer('user_partner')]);
    expect(String(a)).toBe(String(b));
    const registry = (await fake.hgetall<Record<string, string>>(registryKey())) ?? {};
    expect(Object.keys(registry).length).toBe(2);
  });

  test('the owner in two tabs at once gets the same container both times', async () => {
    const [a, b] = await Promise.all([ownerContainer('user_owner'), ownerContainer('user_owner')]);
    expect([String(a), String(b)]).toEqual([TEST_CONTAINER, TEST_CONTAINER]);
  });

  test('a container that is not active, or gone, is not reached', async () => {
    await ownerContainer('user_owner');
    await fake.hset(registryKey(), { [TEST_CONTAINER]: JSON.stringify({ status: 'restoring', primary: true, created_at: 'x' }) });
    await expect(ownerContainer('user_owner')).rejects.toThrow('restoring');
    await fake.del(registryKey());
    await expect(ownerContainer('user_owner')).rejects.toThrow('not in the registry');
  });

  test('a mapping that is not a container id is refused', async () => {
    await fake.hset(ownersKey(), { user_owner: 'not-a-container' });
    await expect(ownerContainer('user_owner')).rejects.toThrow('not a container');
  });

  test('nothing to claim yet', async () => {
    await fake.del(registryKey());
    forgetEpochs();
    await expect(ownerContainer('user_owner')).rejects.toThrow('No container exists yet');
    expect(await owners()).toEqual({});
    expect(await fake.hgetall(registryKey())).toBeNull(); // nothing made up either
  });

  test('signed out reaches nothing', async () => {
    await expect(dataCtx()).rejects.toThrow('Not signed in');
  });
});

describe('what stays as it was', () => {
  test('password mode uses the deployment container and never records an owner', async () => {
    delete process.env.CLERK_SECRET_KEY;
    clerk.signedIn = 'user_owner';
    expect(String((await dataCtx()).container)).toBe(TEST_CONTAINER);
    expect(await owners()).toEqual({});
  });

  test('the balance ingest uses the deployment container even with Clerk on', async () => {
    expect(String((await deploymentCtx()).container)).toBe(TEST_CONTAINER);
    expect(await owners()).toEqual({});
  });

  test('the owner map is environment-wide, not inside a container', () => {
    expect(ownersKey()).toBe(testKey('owners'));
  });
});

describe('the balance ingest with Clerk on', () => {
  // It authenticates with its own secret and has no Clerk session: it must
  // still reach the deployment's container rather than be refused.
  test('does not ask Clerk who is signed in', async () => {
    process.env.INGEST_SECRET = 'ingest';
    const res = await ingest.POST(
      new Request('http://x/api/ingest/balance', {
        method: 'POST',
        headers: { authorization: 'Bearer ingest', 'content-type': 'application/json' },
        body: JSON.stringify({ account_id: 'manual_nope', balance: 1 }),
      })
    );
    expect(res.status).not.toBe(503);
  });
});

const hasRedis = Bun.which('redis-server') !== null;
describe.skipIf(!hasRedis && !process.env.CI)('the owner claim, on a real Redis', () => {
  let real: RealRedis | null = null;
  afterAll(() => real?.stop());

  test('claims the data once, then gives each new account its own container', async () => {
    real = await startRedis();
    const r = real.client;
    const { CLAIM_OR_CREATE } = await import('@/lib/owners');
    const run = (user: string, existing: string, fresh: string) =>
      r.send('EVAL', [CLAIM_OR_CREATE, '2', 'owners', 'registry', user, existing, fresh, '{"new":true}']);
    expect(await run('user_a', '', 'x0')).toBe(''); // nothing to claim: nothing written
    expect(await r.send('EXISTS', ['owners'])).toBe(0);
    expect(await run('user_a', 'c1', 'x1')).toBe('c1'); // claims
    expect(await r.send('HEXISTS', ['registry', 'x1'])).toBe(0);
    expect(await run('user_a', 'c1', 'x2')).toBe('c1'); // already mapped
    expect(await run('user_b', 'c1', 'c2')).toBe('c2'); // a new one
    expect(await r.send('HGET', ['registry', 'c2'])).toBe('{"new":true}');
    expect(await run('user_b', 'c1', 'c3')).toBe('c2');
    await expect(run('user_c', 'c1', 'c2')).rejects.toThrow('already registered'); // never two accounts in one
    expect(await r.send('HGETALL', ['owners'])).toEqual({ user_a: 'c1', user_b: 'c2' });
    await r.send('DEL', ['owners']);
    await r.send('HSET', ['registry', 'c1', '{}']);
    await expect(run('user_b', 'c1', 'c9')).rejects.toThrow('NOCLAIM'); // cleared with several: no claim
    expect(await r.send('EXISTS', ['owners'])).toBe(0);
  });
});
