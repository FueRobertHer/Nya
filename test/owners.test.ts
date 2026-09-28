import { describe, expect, test, mock, beforeEach, afterEach, afterAll } from 'bun:test';
import { startRedis, type RealRedis } from './real-redis';
import { FakeRedis, storageMock, registerTestContainer, TEST_CONTAINER, testKey } from './fake-redis';

// Clerk's auth(), reduced to who is signed in.
let signedIn: string | null = null;
mock.module('@clerk/nextjs/server', () => ({
  auth: async () => ({ userId: signedIn }),
  clerkMiddleware: (handler: any) => (req: any, event: any) => handler(async () => ({ userId: signedIn }), req, event),
}));

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
  signedIn = null;
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
    signedIn = 'user_owner';
    expect(String((await dataCtx()).container)).toBe(TEST_CONTAINER);
    expect(await owners()).toEqual({ user_owner: TEST_CONTAINER });
    expect(String((await dataCtx()).container)).toBe(TEST_CONTAINER);
  });

  test('anyone after that reaches nothing', async () => {
    signedIn = 'user_owner';
    await dataCtx();
    signedIn = 'user_other';
    await expect(dataCtx()).rejects.toThrow('no data here yet');
    expect(Object.keys(await owners())).toEqual(['user_owner']);
  });

  test('two first sign-ins at once: one owner, and the other reaches nothing', async () => {
    const results = await Promise.allSettled([ownerContainer('user_a'), ownerContainer('user_b')]);
    expect(results.filter((r) => r.status === 'fulfilled').length).toBe(1);
    expect(Object.keys(await owners()).length).toBe(1);
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
  });

  test('signed out reaches nothing', async () => {
    await expect(dataCtx()).rejects.toThrow('Not signed in');
  });
});

describe('what stays as it was', () => {
  test('password mode uses the deployment container and never records an owner', async () => {
    delete process.env.CLERK_SECRET_KEY;
    signedIn = 'user_owner';
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

  test('claims only while nobody owns anything', async () => {
    real = await startRedis();
    const r = real.client;
    const { CLAIM_FIRST } = await import('@/lib/owners');
    const claim = (user: string, container: string) => r.send('EVAL', [CLAIM_FIRST, '1', 'owners', user, container]);
    expect(await claim('user_a', 'c1')).toBe(1);
    expect(await claim('user_b', 'c2')).toBe(0);
    expect(await claim('user_a', 'c2')).toBe(0);
    expect(await r.send('HGETALL', ['owners'])).toEqual({ user_a: 'c1' });
  });
});
