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
  test('step 1 prepares, and returns the fingerprint to check, never the key', async () => {
    const res = await post(JSON.stringify({ new_master_key: NEW }));
    const text = await res.text();

    expect(res.status).toBe(200);
    expect(JSON.parse(text)).toMatchObject({ prepared: 1, new_master_fingerprint: (await importMasterKey(NEW)).fingerprint });
    expect(text).toContain('redeploy');
    expect(text).not.toContain(NEW);
    expect(await opens(CURRENT)).toBe(true);
    expect(await opens(NEW)).toBe(true);
  });

  test('an empty body reports where it stands and changes nothing', async () => {
    expect(await (await post()).json()).toEqual({ state: 'none', active_key: null });
    await post(JSON.stringify({ new_master_key: NEW }));
    const before = JSON.stringify(await fake.hgetall(keysHashKey()));

    expect(await (await post('{}')).json()).toMatchObject({ state: 'prepared', active_key: null });
    process.env.MASTER_KEY = NEW; // the redeploy
    expect(await (await post('')).json()).toMatchObject({ state: 'grace' });
    expect(JSON.stringify(await fake.hgetall(keysHashKey()))).toBe(before);
    expect(await opens(CURRENT)).toBe(true);
  });

  test('the status names the data key new writes use', async () => {
    await fake.set('test:crypto:active', KEY);
    expect(await (await post()).json()).toMatchObject({ state: 'none', active_key: KEY });
  });

  test('finish_now on the new deployment removes the old locks', async () => {
    await post(JSON.stringify({ new_master_key: NEW }));
    process.env.MASTER_KEY = NEW;

    expect(await (await post(JSON.stringify({ finish_now: true }))).json()).toEqual({ state: 'finished', finished: 1 });
    expect(await opens(CURRENT)).toBe(false);
    expect(await opens(NEW)).toBe(true);
  });

  test('finish_now on the old deployment does nothing', async () => {
    await post(JSON.stringify({ new_master_key: NEW }));
    expect(await (await post(JSON.stringify({ finish_now: true }))).json()).toMatchObject({ state: 'prepared' });
    expect(await opens(CURRENT)).toBe(true);
  });

  test('a refused rotation is a 409 naming why, and changes nothing', async () => {
    const before = JSON.stringify(await fake.hgetall(keysHashKey()));
    const res = await post(JSON.stringify({ new_master_key: CURRENT }));
    expect(res.status).toBe(409);
    expect((await res.json()).error).toContain('same as the current one');
    expect(JSON.stringify(await fake.hgetall(keysHashKey()))).toBe(before);
  });

  test('a running master that cannot open a key is a 409, not a server error', async () => {
    process.env.MASTER_KEY = Buffer.alloc(32, 49).toString('base64');
    const res = await post(JSON.stringify({ new_master_key: NEW }));
    expect(res.status).toBe(409);
    expect((await res.json()).error).toContain('running master cannot open');
  });

  test('a lock that did not save is a 409 explaining it, not a server error', async () => {
    const realHset = fake.hset.bind(fake);
    fake.hset = (async () => undefined) as typeof fake.hset;
    try {
      const res = await post(JSON.stringify({ new_master_key: NEW }));
      expect(res.status).toBe(409);
      expect((await res.json()).error).toContain('not wrapped for master key');
    } finally {
      fake.hset = realHset as typeof fake.hset;
    }
  });

  test('a malformed key is a 409 that does not echo it', async () => {
    const res = await post(JSON.stringify({ new_master_key: 'short' }));
    expect(res.status).toBe(409);
    expect(await res.text()).not.toContain('short"');
  });

  test('anything but the three known bodies is refused, and changes nothing', async () => {
    const before = JSON.stringify(await fake.hgetall(keysHashKey()));
    for (const body of [
      JSON.stringify({ new_master: NEW }), // misspelled
      JSON.stringify({ newMasterKey: NEW }),
      JSON.stringify({ new_master_key: NEW, finish_now: true }),
      JSON.stringify({ finish_now: 'yes' }),
      JSON.stringify(NEW), // a bare string
      '[1]',
      'null',
    ]) {
      expect((await post(body)).status).toBe(400);
    }
    expect((await post('{nope')).status).toBe(400);
    expect((await post(JSON.stringify({ new_master_key: 5 }))).status).toBe(400);
    expect((await post('x'.repeat(2000))).status).toBe(413);
    expect(JSON.stringify(await fake.hgetall(keysHashKey()))).toBe(before);
  });

  test('an unexpected failure is a 500 that repeats nothing from the error', async () => {
    const realHgetall = fake.hgetall.bind(fake);
    fake.hgetall = (async () => {
      throw new Error('command was: ["hgetall","secret-looking-content"]');
    }) as typeof fake.hgetall;
    const logged: string[] = [];
    const origError = console.error;
    console.error = (...a: unknown[]) => logged.push(a.join(' '));
    try {
      const res = await post(JSON.stringify({ new_master_key: NEW }));
      expect(res.status).toBe(500);
      expect(await res.text()).not.toContain('secret-looking-content');
      expect(logged.join(' ')).not.toContain('secret-looking-content');
    } finally {
      fake.hgetall = realHgetall as typeof fake.hgetall;
      console.error = origError;
    }
  });

  test('a concurrent step is refused rather than interleaved', async () => {
    await fake.set('test:crypto:rotation-lock', 'other', { nx: true, px: 60000 });
    const res = await post(JSON.stringify({ new_master_key: NEW }));
    expect(res.status).toBe(409);
    expect((await res.json()).error).toContain('Another rotation step');
  });
});
