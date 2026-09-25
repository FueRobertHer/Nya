import { describe, expect, test, mock, beforeEach, afterEach } from 'bun:test';
import { FakeRedis, storageMock, testKey } from './fake-redis';

process.env.PLAID_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');

// No linked institutions (storageMock's getItems is empty), so the snapshot
// itself does nothing; what is under test is the rotation hook before it.
const fake = new FakeRedis({ deserialize: true });
mock.module('@/lib/storage', () => storageMock(fake));

const { importMasterKey, dataKeyId, keysHashKey, unwrapDataKey, prepareMasterRotation, rotationPending, ROTATION_GRACE_MS } =
  await import('@/lib/crypto');
const { GET } = await import('@/app/api/snapshot/route');

const OLD = Buffer.alloc(32, 51).toString('base64');
const NEW = Buffer.alloc(32, 52).toString('base64');
let KEY = '';

const saved = { ...process.env };
beforeEach(async () => {
  fake.reset();
  process.env.CRON_SECRET = 'cron';
  process.env.MASTER_KEY = OLD;
  const m = await importMasterKey(OLD);
  const raw = new Uint8Array(32).fill(50);
  KEY = await dataKeyId(1, raw);
  await fake.hset(keysHashKey(), {
    [KEY]: JSON.stringify({ created_at: 'x', wrapped: { [m.fingerprint]: await m.wrap(KEY, raw) } }),
  });
});
afterEach(() => {
  process.env = { ...saved };
});

const cron = () => GET(new Request('http://x/api/snapshot', { headers: { authorization: 'Bearer cron' } }));
const opens = async (b64: string) =>
  unwrapDataKey(await importMasterKey(b64), KEY, (await fake.hget<any>(keysHashKey(), KEY))!).then(
    () => true,
    () => false
  );

describe('the daily cron finishes a due master rotation', () => {
  test('after the rollback window, on the new deployment', async () => {
    await prepareMasterRotation(NEW, Date.now() - ROTATION_GRACE_MS - 1000);
    process.env.MASTER_KEY = NEW;

    expect((await cron()).status).toBe(200);
    expect(await rotationPending()).toBe(false);
    expect(await opens(OLD)).toBe(false);
  });

  test('not before it', async () => {
    await prepareMasterRotation(NEW, Date.now());
    process.env.MASTER_KEY = NEW;

    await cron();
    expect(await rotationPending()).toBe(true);
    expect(await opens(OLD)).toBe(true);
  });

  test('a rotation that cannot finish never costs the snapshot', async () => {
    await prepareMasterRotation(NEW, Date.now() - ROTATION_GRACE_MS - 1000);
    // A key missing its new lock: finishing must refuse.
    const raw = new Uint8Array(32).fill(53);
    const late = await dataKeyId(2, raw);
    const m = await importMasterKey(OLD);
    await fake.hset(keysHashKey(), { [late]: JSON.stringify({ created_at: 'x', wrapped: { [m.fingerprint]: await m.wrap(late, raw) } }) });
    process.env.MASTER_KEY = NEW;

    const errors: string[] = [];
    const origError = console.error;
    console.error = (...a: unknown[]) => errors.push(a.join(' '));
    try {
      const res = await cron();
      expect(res.status).toBe(200);
      expect(errors.join(' ')).toContain('Master rotation finish failed');
    } finally {
      console.error = origError;
    }
    expect(await opens(OLD)).toBe(true);
  });
});

// The cron runs each container on its own (lib/snapshot-job.ts). Here, with
// the real snapshot: one container, holding the (still unscoped) data.
const { saveManualAccount } = await import('@/lib/manual');
const { registryKey } = await import('@/lib/containers');
const { readRuns } = await import('@/lib/snapshot-job');

describe('the cron reports what it recorded, per container', () => {
  const A = crypto.randomUUID() as any;
  const today = new Date().toISOString().slice(0, 10);
  const register = () => fake.hset(registryKey(), { [A]: JSON.stringify({ status: 'active', primary: true, created_at: 'x' }) });
  const withAccount = () =>
    saveManualAccount({
      account_id: 'manual_house',
      name: 'House',
      institution_name: 'Manual',
      type: 'other',
      subtype: null,
      balance: 1000,
      updated_at: new Date().toISOString(),
    } as any);
  const results = async () => (await (await cron()).json()).results;

  test('recorded when the snapshot lands, and not run again that day', async () => {
    await register();
    await withAccount();
    expect(await results()).toEqual([{ container: A, status: 'recorded', ms: expect.any(Number) }]);
    expect(await results()).toEqual([{ container: A, status: 'already' }]);
    expect(await readRuns({ container: A })).toEqual([{ date: today, status: 'recorded', at: expect.any(String), attempts: 1 }]);
  });

  test('failed when the clean snapshot fails to write, and tried again', async () => {
    await register();
    await withAccount();
    fake.failNext('hset');
    const res = await cron();
    expect(res.status).toBe(200);
    expect((await res.json()).results).toEqual([
      { container: A, status: 'failed', reason: 'The snapshot could not be written.', ms: expect.any(Number) },
    ]);
    expect((await results())[0].status).toBe('recorded');
    expect((await readRuns({ container: A }))[0].attempts).toBe(2);
  });

  test('unclean with nothing linked', async () => {
    await register();
    expect(await results()).toEqual([{ container: A, status: 'unclean', reason: 'Nothing is linked.', ms: expect.any(Number) }]);
  });

  test('a registry that cannot be read is a loud 500, after one retry, and nothing is written', async () => {
    await register();
    await withAccount();
    const errors = console.error;
    console.error = () => {};
    try {
      fake.failNext('hgetall', 2);
      const res = await cron();
      expect(res.status).toBe(500);
      expect((await res.json()).error).toContain('registry');
      expect(await readRuns({ container: A })).toEqual([]);
      expect(await fake.hgetall(testKey('history:net-worth'))).toBeNull();

      fake.failNext('hgetall', 1); // one failure is retried
      expect((await cron()).status).toBe(200);
    } finally {
      console.error = errors;
    }
  });

  test('refuses a wrong secret', async () => {
    const res = await GET(new Request('http://x/api/snapshot', { headers: { authorization: 'Bearer nope' } }));
    expect(res.status).toBe(401);
    const none = await GET(new Request('http://x/api/snapshot'));
    expect(none.status).toBe(401);
  });
});
