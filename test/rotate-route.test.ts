import { describe, expect, test, mock, beforeEach, afterEach } from 'bun:test';
import { FakeRedis, storageMock } from './fake-redis';

process.env.PLAID_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');

const fake = new FakeRedis({ deserialize: true });
mock.module('@/lib/storage', () => storageMock(fake));

const { importMasterKey, dataKeyId, keysHashKey, unwrapDataKey } = await import('@/lib/crypto');
const route = await import('@/app/api/ops/rotate-master/route');

// Distinct from other files' masters.
const CURRENT = Buffer.alloc(32, 41).toString('base64');
const NEW = Buffer.alloc(32, 42).toString('base64');

let KEY = '';
const saved = { ...process.env };
beforeEach(async () => {
  fake.reset();
  process.env.MASTER_KEY = CURRENT;
  process.env.OPS_ENABLED = '1';
  process.env.OPS_SECRET = 's3cret';
  const m = await importMasterKey(CURRENT);
  const raw = new Uint8Array(32).fill(40);
  KEY = await dataKeyId(1, raw);
  await fake.hset(keysHashKey(), {
    [KEY]: JSON.stringify({ created_at: 'x', wrapped: { [m.fingerprint]: await m.wrap(KEY, raw) } }),
  });
});
afterEach(() => {
  process.env = { ...saved };
});

const post = (body?: string, auth = 'Bearer s3cret') =>
  route.POST(
    new Request('http://x/api/ops/rotate-master', {
      method: 'POST',
      headers: auth ? { authorization: auth } : {},
      body,
    })
  );

async function opens(b64: string): Promise<boolean> {
  const stored = await fake.hget<any>(keysHashKey(), KEY);
  return unwrapDataKey(await importMasterKey(b64), KEY, stored).then(
    () => true,
    () => false
  );
}

describe('locked like every ops route', () => {
  test('does not exist unless OPS_ENABLED is set', async () => {
    delete process.env.OPS_ENABLED;
    expect((await post(JSON.stringify({ new_master_key: NEW }))).status).toBe(404);
  });

  test('rejects a missing or wrong secret, changing nothing', async () => {
    const before = JSON.stringify(await fake.hgetall(keysHashKey()));
    expect((await post(JSON.stringify({ new_master_key: NEW }), '')).status).toBe(401);
    expect((await post(JSON.stringify({ new_master_key: NEW }), 'Bearer nope')).status).toBe(401);
    expect(JSON.stringify(await fake.hgetall(keysHashKey()))).toBe(before);
  });

  test('every other method is a 404', async () => {
    for (const method of ['GET', 'HEAD', 'OPTIONS', 'PUT', 'PATCH', 'DELETE'] as const) {
      expect((await route[method]()).status).toBe(404);
    }
  });
});

describe('the rotation', () => {
  test('step 1 adds the new lock and says what to do next, without echoing the key', async () => {
    const res = await post(JSON.stringify({ new_master_key: NEW }));
    const text = await res.text();

    expect(res.status).toBe(200);
    expect(JSON.parse(text)).toMatchObject({ prepared: 1, new_master_fingerprint: (await importMasterKey(NEW)).fingerprint });
    expect(text).toContain('redeploy');
    expect(text).not.toContain(NEW);
    expect(await opens(CURRENT)).toBe(true);
    expect(await opens(NEW)).toBe(true);
  });

  test('an empty POST after the redeploy finishes it', async () => {
    await post(JSON.stringify({ new_master_key: NEW }));
    process.env.MASTER_KEY = NEW; // the redeploy

    const res = await post();
    expect(await res.json()).toEqual({ finished: 1, pending: 0 });
    expect(await opens(CURRENT)).toBe(false);
    expect(await opens(NEW)).toBe(true);
  });

  test('an empty POST before the redeploy changes nothing and reports it pending', async () => {
    await post(JSON.stringify({ new_master_key: NEW }));
    const res = await post('');
    expect(await res.json()).toEqual({ finished: 0, pending: 1 });
    expect(await opens(CURRENT)).toBe(true);
  });

  test('a refused rotation is a 409 naming why, and changes nothing', async () => {
    const before = JSON.stringify(await fake.hgetall(keysHashKey()));
    const res = await post(JSON.stringify({ new_master_key: CURRENT }));
    expect(res.status).toBe(409);
    expect((await res.json()).error).toContain('same as the current one');
    expect(JSON.stringify(await fake.hgetall(keysHashKey()))).toBe(before);
  });

  test('a malformed key is a 409 that does not echo it', async () => {
    const res = await post(JSON.stringify({ new_master_key: 'short' }));
    expect(res.status).toBe(409);
    expect(await res.text()).not.toContain('short"');
  });

  test('bad bodies are rejected', async () => {
    expect((await post('{nope')).status).toBe(400);
    expect((await post(JSON.stringify({ new_master_key: 5 }))).status).toBe(400);
    expect((await post('x'.repeat(2000))).status).toBe(413);
  });
});
