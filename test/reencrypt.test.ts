import { describe, expect, test, mock, beforeEach, afterEach, afterAll } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { FakeRedis, storageMock, testKey } from './fake-redis';

process.env.PLAID_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');

// Raw, like the client the pass uses: values come back exactly as stored.
const fake = new FakeRedis();
mock.module('@/lib/storage', () => storageMock(fake));

const { encrypt, decrypt, formatOf, forgetActiveKey, activeKeyName, importMasterKey, dataKeyId, keysHashKey, MasterKeyError } =
  await import('@/lib/crypto');
const { reencrypt, classify, CAS_STRING, CAS_HASH, PROBE } = await import('@/lib/reencrypt');
const route = await import('@/app/api/ops/reencrypt/route');

// Distinct from other files' masters.
const MASTER = Buffer.alloc(32, 51).toString('base64');
const saved = { ...process.env };

/** A value as written before data keys existed: v1 under k0. */
async function legacy(plain: string): Promise<string> {
  const master = process.env.MASTER_KEY;
  delete process.env.MASTER_KEY;
  forgetActiveKey();
  try {
    return await encrypt(plain);
  } finally {
    process.env.MASTER_KEY = master;
    forgetActiveKey();
  }
}

const run = (budgetMs = 60_000, now?: () => number) => reencrypt({ dryRun: false, budgetMs, now });
const check = () => reencrypt({ dryRun: true, budgetMs: 60_000 });
const snapshot = () => JSON.stringify([[...fake.strings], [...fake.hashes].map(([k, h]) => [k, [...h]])]);

/** A realistic spread: whole-value strings, hashes, an item, and plaintext. */
async function seed() {
  fake.strings.set(testKey('goals'), await legacy('[{"id":"g1"}]'));
  fake.strings.set(testKey('txns:item-1'), await legacy('{"txns":{}}'));
  fake.hashes.set(
    testKey('history:net-worth'),
    new Map([
      ['2026-01-01', await legacy('100')],
      ['2026-01-02', await legacy('101')],
    ])
  );
  fake.hashes.set(
    testKey('plaid:items'),
    new Map([
      [
        'item-1',
        JSON.stringify({ item_id: 'item-1', institution_name: 'Bank é', encrypted_access_token: await legacy('access-sandbox-1') }),
      ],
    ])
  );
  fake.strings.set(testKey('history:backfill-done'), '3');
  fake.hashes.set(testKey('account-links:dismissed'), new Map([['a>b', '2026-01-01T00:00:00.000Z']]));
  fake.strings.set(testKey('txns-blocked:item-1'), '{"reason":"size"}');
}

beforeEach(() => {
  fake.reset();
  process.env.MASTER_KEY = MASTER;
  forgetActiveKey();
});
afterEach(() => {
  process.env = { ...saved };
  forgetActiveKey();
});

describe('the list of keys', () => {
  test('every key name in the code is on it', () => {
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) walk(path);
        else if (/\.tsx?$/.test(name)) files.push(path);
      }
    };
    walk('lib');
    walk('app');
    const names = new Set<string>();
    for (const file of files) {
      const src = readFileSync(file, 'utf8');
      for (const m of src.matchAll(/\bk(?:Env)?\(\s*'([^']+)'\s*\)/g)) names.add(m[1]);
      for (const m of src.matchAll(/\bk(?:Env)?\(\s*`([^`$]*)\$\{/g)) names.add(`${m[1]}x`);
    }
    expect(names.size).toBeGreaterThan(20); // the scan found the stores
    const missing = [...names].filter((n) => classify(n) === null);
    expect(missing).toEqual([]);
  });

  test('a prefix does not swallow its neighbours', () => {
    expect(classify('txns:abc')).toBe('string');
    expect(classify('txns-blocked:abc')).toBe('plain');
    expect(classify('invtxns:abc')).toBe('string');
    expect(classify('invtxns-lock:abc')).toBe('plain');
    expect(classify('history:accounts')).toBe('hash');
    expect(classify('history:accounts:est:flat')).toBe('string');
    expect(classify('something-new')).toBeNull();
    expect(classify('__proto__')).toBeNull();
  });
});

describe('the pass', () => {
  test('a check counts what is under k0 and writes nothing', async () => {
    await seed();
    const before = snapshot();
    const report = await check();
    expect(report).toMatchObject({ dry_run: true, walked_all: true, moved: 0, to_move: { k0: 5 }, complete: false });
    expect(report.unreadable).toEqual([]);
    // Only the first data key was created, which any write would have done.
    const after = JSON.parse(snapshot());
    const data = (s: unknown[][]) => JSON.stringify(s.filter(([k]) => !String(k).includes(':crypto:')));
    expect(data(after[0])).toBe(data(JSON.parse(before)[0]));
    expect(data(after[1])).toBe(data(JSON.parse(before)[1]));
  });

  test('a run moves every value to the active key, and readers get the same data', async () => {
    await seed();
    const report = await run();
    const active = report.active_key;
    expect(active).toMatch(/^k1-/);
    expect(report).toMatchObject({ walked_all: true, moved: 5, changed_meanwhile: 0, complete: true });

    const goals = fake.strings.get(testKey('goals'))!;
    expect(formatOf(goals).keyId).toBe(active);
    expect(await decrypt(goals)).toBe('[{"id":"g1"}]');
    expect(await decrypt(fake.strings.get(testKey('txns:item-1'))!)).toBe('{"txns":{}}');
    const hist = fake.hashes.get(testKey('history:net-worth'))!;
    expect(await decrypt(hist.get('2026-01-01')!)).toBe('100');
    expect(await decrypt(hist.get('2026-01-02')!)).toBe('101');

    const item = JSON.parse(fake.hashes.get(testKey('plaid:items'))!.get('item-1')!);
    expect(item).toMatchObject({ item_id: 'item-1', institution_name: 'Bank é' });
    expect(Object.keys(item)).toEqual(['item_id', 'institution_name', 'encrypted_access_token']);
    expect(formatOf(item.encrypted_access_token).keyId).toBe(active);
    expect(await decrypt(item.encrypted_access_token)).toBe('access-sandbox-1');

    expect(await check()).toMatchObject({ to_move: {}, complete: true });
  });

  test('plaintext keys are never touched', async () => {
    await seed();
    await run();
    expect(fake.strings.get(testKey('history:backfill-done'))).toBe('3');
    expect(fake.strings.get(testKey('txns-blocked:item-1'))).toBe('{"reason":"size"}');
    expect([...fake.hashes.get(testKey('account-links:dismissed'))!]).toEqual([['a>b', '2026-01-01T00:00:00.000Z']]);
  });

  test('running it again moves nothing and changes nothing', async () => {
    await seed();
    await run();
    const before = snapshot();
    expect(await run()).toMatchObject({ moved: 0, complete: true });
    expect(snapshot()).toBe(before);
  });

  test('a string already under the active key is not read in full', async () => {
    await seed();
    await run();
    const realGet = fake.get.bind(fake);
    const read: string[] = [];
    fake.get = (async (key: string) => {
      read.push(key);
      return realGet(key);
    }) as typeof fake.get;
    try {
      await run();
    } finally {
      fake.get = realGet as typeof fake.get;
    }
    expect(read.filter((k) => k.includes('txns:') || k.includes('goals'))).toEqual([]);
  });

  test('a value under an older data key is moved too', async () => {
    const m = await importMasterKey(MASTER);
    const raw = new Uint8Array(32).fill(52);
    const old = await dataKeyId(1, raw);
    fake.hashes.set(keysHashKey(), new Map([[old, JSON.stringify({ created_at: 'x', wrapped: { [m.fingerprint]: await m.wrap(old, raw) } })]]));
    // The value is written while k1 is active, then k2 takes over.
    fake.strings.set(activeKeyName(), old);
    fake.strings.set(testKey('budgets'), await encrypt('{"food":1}'));
    const raw2 = new Uint8Array(32).fill(53);
    const next = await dataKeyId(2, raw2);
    fake.hashes.get(keysHashKey())!.set(next, JSON.stringify({ created_at: 'x', wrapped: { [m.fingerprint]: await m.wrap(next, raw2) } }));
    fake.strings.set(activeKeyName(), next);
    forgetActiveKey();

    expect(await check()).toMatchObject({ to_move: { [old]: 1 } });
    expect(await run()).toMatchObject({ active_key: next, moved: 1, complete: true });
    const budgets = fake.strings.get(testKey('budgets'))!;
    expect(formatOf(budgets).keyId).toBe(next);
    expect(await decrypt(budgets)).toBe('{"food":1}');
  });

  test('a save that lands mid-pass wins, and is left for next time', async () => {
    await seed();
    const realEval = fake.eval.bind(fake);
    let raced = false;
    fake.eval = (async (script: string, keys: string[], args: string[]) => {
      if (!raced && keys[0] === testKey('goals')) {
        raced = true;
        fake.strings.set(testKey('goals'), await legacy('[{"id":"newer"}]'));
      }
      return realEval(script, keys, args);
    }) as typeof fake.eval;
    let report;
    try {
      report = await run();
    } finally {
      fake.eval = realEval as typeof fake.eval;
    }
    expect(report).toMatchObject({ moved: 4, changed_meanwhile: 1, complete: false });
    expect(await decrypt(fake.strings.get(testKey('goals'))!)).toBe('[{"id":"newer"}]');

    expect(await run()).toMatchObject({ moved: 1, complete: true });
    expect(await decrypt(fake.strings.get(testKey('goals'))!)).toBe('[{"id":"newer"}]');
  });

  test('an unreadable value is reported and left alone, without quoting it', async () => {
    await seed();
    fake.hashes.get(testKey('history:net-worth'))!.set('2026-01-03', 'secret-plaintext-value');
    const report = await run();
    expect(report.complete).toBe(false);
    expect(report.unreadable_count).toBe(1);
    expect(report.unreadable[0]).toMatchObject({ key: 'history:net-worth', field: '2026-01-03' });
    expect(JSON.stringify(report)).not.toContain('secret-plaintext-value');
    expect(fake.hashes.get(testKey('history:net-worth'))!.get('2026-01-03')).toBe('secret-plaintext-value');
    expect(report.moved).toBe(5); // everything else still moved
  });

  test('a key not on the list is reported and left alone', async () => {
    await seed();
    fake.strings.set(testKey('brand-new-store'), await legacy('x'));
    const before = fake.strings.get(testKey('brand-new-store'));
    const report = await run();
    expect(report.unclassified).toEqual(['brand-new-store']);
    expect(report.complete).toBe(false);
    expect(fake.strings.get(testKey('brand-new-store'))).toBe(before!);
  });

  test('a key of the wrong type is reported, not guessed at', async () => {
    fake.hashes.set(testKey('goals'), new Map([['a', await legacy('x')]]));
    const report = await run();
    expect(report.unreadable[0]).toEqual({ key: 'goals', reason: 'expected a string, found a hash' });
  });

  test('an item without a token, or not JSON, is reported', async () => {
    fake.hashes.set(
      testKey('plaid:items'),
      new Map([
        ['a', '{"item_id":"a"}'],
        ['b', 'not json'],
      ])
    );
    const report = await check();
    expect(report.unreadable.map((u) => [u.field, u.reason]).sort()).toEqual([
      ['a', 'has no encrypted_access_token'],
      ['b', 'not valid JSON'],
    ]);
  });

  test('a value bound to a context is left for its owner', async () => {
    const { encryptV2 } = await import('@/lib/crypto');
    fake.strings.set(testKey('goals'), await encryptV2('x', 'k0', 'some-context'));
    const report = await run();
    expect(report.unreadable[0].reason).toBe('bound to a context; its owner must move it');
  });

  test('out of time before it starts, it moves nothing', async () => {
    await seed();
    let t = 0;
    const report = await run(1, () => (t += 1));
    expect(report).toMatchObject({ walked_all: false, moved: 0, complete: false });
  });

  test('stops at the time limit and carries on next call', async () => {
    await seed();
    let t = 0;
    const first = await run(7, () => (t += 1)); // a few keys' worth of time
    expect(first.walked_all).toBe(false);
    expect(first.complete).toBe(false);
    expect(first.moved).toBeGreaterThan(0);
    expect(first.moved).toBeLessThan(5);

    const second = await run();
    expect(second.walked_all).toBe(true);
    expect(first.moved + second.moved).toBe(5);
    expect(second.complete).toBe(true);
  });

  test('without a master it refuses, and writes nothing', async () => {
    await seed();
    delete process.env.MASTER_KEY;
    const before = snapshot();
    expect(await run().catch((e) => e)).toBeInstanceOf(MasterKeyError);
    expect(snapshot()).toBe(before);
  });

  test('a database without the needed script support is refused before any write', async () => {
    await seed();
    const realEval = fake.eval.bind(fake);
    fake.eval = (async () => {
      throw new Error('ERR unknown command');
    }) as typeof fake.eval;
    try {
      const err = await run().catch((e) => e);
      expect(err).toBeInstanceOf(MasterKeyError);
      expect(err.message).toContain('sha1hex');
    } finally {
      fake.eval = realEval as typeof fake.eval;
    }
    expect((await check()).to_move).toEqual({ k0: 5 });
  });
});

describe('the route', () => {
  const post = (body?: string, auth = 'Bearer s3cret') =>
    route.POST(new Request('http://x/api/ops/reencrypt', { method: 'POST', headers: auth ? { authorization: auth } : {}, body }));

  beforeEach(() => {
    process.env.OPS_ENABLED = '1';
    process.env.OPS_SECRET = 's3cret';
  });

  test('does not exist unless OPS_ENABLED is set, and needs the secret', async () => {
    delete process.env.OPS_ENABLED;
    expect((await post()).status).toBe(404);
    process.env.OPS_ENABLED = '1';
    expect((await post(undefined, 'Bearer nope')).status).toBe(401);
    for (const method of ['GET', 'HEAD', 'OPTIONS', 'PUT', 'PATCH', 'DELETE'] as const) {
      expect((await route[method]()).status).toBe(404);
    }
  });

  test('an empty body checks; {"run": true} moves', async () => {
    await seed();
    const checked = await (await post()).json();
    expect(checked).toMatchObject({ dry_run: true, to_move: { k0: 5 } });

    const ran = await (await post('{"run":true}')).json();
    expect(ran).toMatchObject({ dry_run: false, moved: 5, complete: true });
  });

  test('anything else is refused', async () => {
    for (const body of ['{"run":"yes"}', '{"run":true,"x":1}', '{"go":true}', '[]', 'nope']) {
      expect((await post(body)).status).toBe(400);
    }
    expect((await post('x'.repeat(300))).status).toBe(413);
  });

  test('a refusal says why', async () => {
    delete process.env.MASTER_KEY;
    const res = await post('{"run":true}');
    expect(res.status).toBe(409);
    expect((await res.json()).error).toContain('MASTER_KEY');
  });
});

// The compare-and-set scripts, run by a real Redis when one is installed (the
// test double above only imitates them). Skipped where there is none, as in CI.
const hasRedis = Bun.which('redis-server') !== null;
describe.skipIf(!hasRedis)('the scripts, on a real Redis', () => {
  const port = 30000 + Math.floor(Math.random() * 20000);
  let server: ReturnType<typeof Bun.spawn> | null = null;
  let client: InstanceType<typeof Bun.RedisClient>;
  const sha1 = (s: string) => new Bun.CryptoHasher('sha1').update(s).digest('hex');
  const evalScript = (script: string, keys: string[], args: string[]) =>
    client.send('EVAL', [script, String(keys.length), ...keys, ...args]);

  beforeEach(async () => {
    if (!server) {
      server = Bun.spawn(['redis-server', '--port', String(port), '--save', '', '--appendonly', 'no'], { stdout: 'ignore', stderr: 'ignore' });
      client = new Bun.RedisClient(`redis://127.0.0.1:${port}`);
      for (let i = 0; i < 50; i++) {
        try {
          await client.send('PING', []);
          break;
        } catch {
          await Bun.sleep(50);
        }
      }
    }
    await client.send('FLUSHALL', []);
  });
  afterAll(() => {
    server?.kill();
  });

  test('the probe answers what the pass expects', async () => {
    expect(await evalScript(PROBE, [], [])).toBe(sha1('nya'));
  });

  test('a string is replaced only while it still matches, keeping its expiry', async () => {
    await client.send('SET', ['s', 'old é', 'PX', '100000']);
    expect(await evalScript(CAS_STRING, ['s'], [sha1('other'), 'new'])).toBe(0);
    expect(await client.send('GET', ['s'])).toBe('old é');
    expect(await evalScript(CAS_STRING, ['s'], [sha1('old é'), 'new'])).toBe(1);
    expect(await client.send('GET', ['s'])).toBe('new');
    expect(Number(await client.send('PTTL', ['s']))).toBeGreaterThan(90000);

    await client.send('SET', ['plain', 'v']);
    expect(await evalScript(CAS_STRING, ['plain'], [sha1('v'), 'w'])).toBe(1);
    expect(Number(await client.send('PTTL', ['plain']))).toBe(-1);

    expect(await evalScript(CAS_STRING, ['missing'], [sha1(''), 'x'])).toBe(0);
    expect(await client.send('EXISTS', ['missing'])).toBe(0);
  });

  test('a hash field is replaced only while it still matches', async () => {
    await client.send('HSET', ['h', 'f', 'old', 'g', 'keep']);
    expect(await evalScript(CAS_HASH, ['h'], ['f', sha1('other'), 'new'])).toBe(0);
    expect(await client.send('HGET', ['h', 'f'])).toBe('old');
    expect(await evalScript(CAS_HASH, ['h'], ['f', sha1('old'), 'new'])).toBe(1);
    expect(await client.send('HGET', ['h', 'f'])).toBe('new');
    expect(await client.send('HGET', ['h', 'g'])).toBe('keep');
    expect(await evalScript(CAS_HASH, ['h'], ['gone', sha1(''), 'x'])).toBe(0);
    expect(await client.send('HEXISTS', ['h', 'gone'])).toBe(0);
  });
});
