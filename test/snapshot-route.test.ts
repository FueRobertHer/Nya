import { describe, expect, test, mock, beforeEach, afterEach } from 'bun:test';
import { FakeRedis, storageMock } from './fake-redis';

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
