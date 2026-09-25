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
  test('every key name in the code is on it, and none is built out of sight', () => {
    const root = join(import.meta.dir, '..');
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (name === 'node_modules' || name.startsWith('.')) continue;
        if (statSync(path).isDirectory()) walk(path);
        else if (/\.tsx?$/.test(name)) files.push(path);
      }
    };
    for (const dir of ['lib', 'app', 'scripts', 'components']) {
      try {
        walk(join(root, dir));
      } catch {
        // not every checkout has every directory
      }
    }
    const names = new Set<string>();
    const opaque: string[] = [];
    for (const file of files) {
      const src = readFileSync(file, 'utf8');
      // kc(ctx, 'name'): the name is the second argument.
      for (const m of src.matchAll(/\bkc\(\s*[A-Za-z_.]+\s*,\s*([^)]*?)\s*\)/g)) {
        const quoted = /^(['"`])([^'"`$]*)\1$/.exec(m[1]);
        const templated = /^`([^`$]*)\$\{/.exec(m[1]);
        if (quoted) names.add(quoted[2]);
        else if (templated) names.add(`${templated[1]}x`);
        else if (!/^[a-zA-Z_]+: string$/.test(m[1])) opaque.push(`${file.slice(root.length + 1)}: kc(..., ${m[1]})`);
      }
      for (const m of src.matchAll(/\bk(?:Env)?\(\s*([^)]*?)\s*\)/g)) {
        const arg = m[1];
        if (arg === '') continue; // "k()" in a comment
        const quoted = /^(['"`])([^'"`$]*)\1$/.exec(arg);
        const templated = /^`([^`$]*)\$\{/.exec(arg);
        if (quoted) names.add(quoted[2]);
        else if (templated) names.add(`${templated[1]}x`);
        else if (!/^[a-zA-Z_]+: string$/.test(arg)) opaque.push(`${file.slice(root.length + 1)}: k(${arg})`);
      }
    }
    expect(names.size).toBeGreaterThan(20); // the scan found the stores
    // A key name the scan cannot read (a variable, a helper) could be a store
    // this file never hears of. Spell it out at the call, or list it here.
    expect(opaque).toEqual([]);
    const missing = [...names].filter((n) => n !== '' && classify(n) === null);
    expect(missing).toEqual([]);
  });

  test('a prefix does not swallow its neighbours', () => {
    expect(classify('txns:abc')).toBe('string');
    expect(classify('txns-blocked:abc')).toBe('plain');
    expect(classify('invtxns:abc')).toBe('string');
    expect(classify('invtxns-lock:abc')).toBe('plain');
    expect(classify('history:accounts')).toBe('hash');
    expect(classify('history:accounts:est:flat')).toBe('string');
    expect(classify('cache:net-worth')).toBe('cipher');
    expect(classify('crypto:keys')).toBe('plain');
    expect(classify('containers')).toBe('plain');
    const c = 'c:0b6f5a52-3c1d-4e2f-8a9b-1c2d3e4f5a6b:';
    expect(classify(`${c}goals`)).toBe('string');
    expect(classify(`${c}history:accounts`)).toBe('hash');
    expect(classify(`${c}brand-new`)).toBeNull();
    expect(classify(`${c}${c}goals`)).toBeNull(); // never nested
    expect(classify('c:not-a-uuid:goals')).toBeNull();
    expect(classify('something-new')).toBeNull();
    expect(classify('__proto__')).toBeNull();
  });
});

describe('the pass', () => {
  test('a check counts what is under k0 and writes nothing, not even a key', async () => {
    await seed();
    const before = snapshot();
    const report = await check();
    expect(report).toMatchObject({ active_key: null, dry_run: true, walked_all: true, moved: 0, to_move: { k0: 5 }, complete: false });
    expect(report.unreadable).toEqual([]);
    expect(snapshot()).toBe(before);
  });

  test('a check with an active key counts only what is not under it', async () => {
    await seed();
    fake.strings.set(testKey('budgets'), await encrypt('{"food":1}')); // creates k1, writes under it
    const before = snapshot();
    const report = await check();
    expect(report.active_key).toMatch(/^k1-/);
    expect(report.to_move).toEqual({ k0: 5 });
    expect(snapshot()).toBe(before);
  });

  test('a check reports an active key this deployment cannot use', async () => {
    fake.strings.set(activeKeyName(), 'k0');
    const err = await check().catch((e) => e);
    expect(err).toBeInstanceOf(MasterKeyError);
    expect(err.message).toContain('not a data key id');
  });

  test('a run moves every value to the active key, and readers get the same data', async () => {
    await seed();
    const report = await run();
    const active = report.active_key as string;
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

  test('a database without the needed script support is refused before anything, even a key', async () => {
    await seed();
    const realEval = fake.eval.bind(fake);
    fake.eval = (async () => {
      // The shape Upstash gives: the error, then the command it ran.
      throw new Error(
        "ERR user_script:1: attempt to call field 'sha1hex' (a nil value), command was: [[\"eval\",\"-- nya:probe\\nreturn redis.sha1hex('nya')\",0]]"
      );
    }) as typeof fake.eval;
    const before = snapshot();
    try {
      for (const attempt of [run, check]) {
        const err = await attempt().catch((e) => e);
        expect(err).toBeInstanceOf(MasterKeyError);
        expect(err.message).toContain('sha1hex');
      }
    } finally {
      fake.eval = realEval as typeof fake.eval;
    }
    expect(snapshot()).toBe(before); // no data key created either
  });

  test('an Upstash error about something else is not mistaken for missing support', async () => {
    const realEval = fake.eval.bind(fake);
    const upstash = new Error(
      'WRONGPASS invalid or missing auth token, command was: [["eval","-- nya:probe\\nreturn redis.sha1hex(\'nya\')",0]]'
    );
    fake.eval = (async () => {
      throw upstash;
    }) as typeof fake.eval;
    try {
      expect(await run().catch((e) => e)).toBe(upstash);
      expect(await check().catch((e) => e)).toBe(upstash);
    } finally {
      fake.eval = realEval as typeof fake.eval;
    }
  });

  test('a run reads the active key fresh, not from the minute-long cache', async () => {
    await seed();
    await encrypt('x'); // caches k1 as active
    const m = await importMasterKey(MASTER);
    const raw = new Uint8Array(32).fill(54);
    const k2 = await dataKeyId(2, raw);
    fake.hashes.get(keysHashKey())!.set(k2, JSON.stringify({ created_at: 'x', wrapped: { [m.fingerprint]: await m.wrap(k2, raw) } }));
    fake.strings.set(activeKeyName(), k2); // a restore, say, changed it
    expect(await run()).toMatchObject({ active_key: k2, moved: 5, complete: true });
  });

  test('an active key missing from the key store is refused with a reason', async () => {
    fake.strings.set(activeKeyName(), 'k3-00000000');
    const err = await run().catch((e) => e);
    expect(err).toBeInstanceOf(MasterKeyError);
    expect(err.message).toContain('not in the key store');
  });

  test('any other failure of the probe is not mistaken for missing support', async () => {
    const realEval = fake.eval.bind(fake);
    fake.eval = (async () => {
      throw new TypeError('fetch failed');
    }) as typeof fake.eval;
    try {
      const err = await run().catch((e) => e);
      expect(err).toBeInstanceOf(TypeError);
    } finally {
      fake.eval = realEval as typeof fake.eval;
    }
  });

  test('caches are moved too, keeping their expiry', async () => {
    fake.strings.set(testKey('cache:net-worth'), await legacy('{"total":1}'));
    fake.ttls.set(testKey('cache:net-worth'), 900);
    fake.hashes.set(testKey('cache:inv-activity:v4'), new Map([['acct', await legacy('[]')]]));
    expect(await run()).toMatchObject({ moved: 2, complete: true });
    expect(await decrypt(fake.strings.get(testKey('cache:net-worth'))!)).toBe('{"total":1}');
    expect(fake.ttls.get(testKey('cache:net-worth'))).toBe(900);
  });

  test('old-format ciphertext in a key listed as plaintext is reported too', async () => {
    fake.strings.set(testKey('history:backfill-done'), await legacy('3'));
    fake.hashes.set(testKey('account-links:dismissed'), new Map([['a>b', '2026-01-01T00:00:00.000Z']]));
    fake.strings.set(testKey('crypto:rotation-lock'), crypto.randomUUID());
    const report = await check();
    expect(report.unreadable.map((u) => u.key)).toEqual(['history:backfill-done']);
  });

  test('encrypted data in a key listed as plaintext is reported', async () => {
    fake.strings.set(testKey('txns-blocked:item-1'), await encrypt('x'));
    fake.hashes.set(testKey('account-links:dismissed'), new Map([['a>b', await encrypt('y')]]));
    const report = await check();
    expect(report.complete).toBe(false);
    expect(report.unreadable.map((u) => [u.key, u.field, u.reason])).toEqual([
      ['account-links:dismissed', 'a>b', 'listed as plaintext but holds encrypted data'],
      ['txns-blocked:item-1', undefined, 'listed as plaintext but holds encrypted data'],
    ]);
  });

  /** Runs `during` once, just before the first compare-and-set on `key`. */
  async function runWith(key: string, during: () => Promise<void> | void) {
    const realEval = fake.eval.bind(fake);
    let done = false;
    fake.eval = (async (script: string, keys: string[], args: string[]) => {
      if (!done && keys[0] === testKey(key)) {
        done = true;
        await during();
      }
      return realEval(script, keys, args);
    }) as typeof fake.eval;
    try {
      return await run();
    } finally {
      fake.eval = realEval as typeof fake.eval;
    }
  }

  test('a hash field deleted mid-pass stays deleted', async () => {
    await seed();
    const report = await runWith('history:net-worth', () => {
      fake.hashes.get(testKey('history:net-worth'))!.delete('2026-01-01');
    });
    expect(report).toMatchObject({ deleted_meanwhile: 1, changed_meanwhile: 0, complete: true });
    expect(fake.hashes.get(testKey('history:net-worth'))!.has('2026-01-01')).toBe(false);
  });

  test('a string deleted mid-pass stays deleted', async () => {
    await seed();
    const report = await runWith('goals', () => {
      fake.strings.delete(testKey('goals'));
    });
    expect(report.deleted_meanwhile).toBe(1);
    expect(fake.strings.has(testKey('goals'))).toBe(false);
  });

  test('an item re-saved mid-pass keeps the new save', async () => {
    await seed();
    const newer = JSON.stringify({ item_id: 'item-1', institution_name: 'Renamed', encrypted_access_token: await legacy('access-2') });
    const report = await runWith('plaid:items', () => {
      fake.hashes.get(testKey('plaid:items'))!.set('item-1', newer);
    });
    expect(report.changed_meanwhile).toBe(1);
    expect(fake.hashes.get(testKey('plaid:items'))!.get('item-1')).toBe(newer);
    expect(await run()).toMatchObject({ moved: 1, complete: true });
    const item = JSON.parse(fake.hashes.get(testKey('plaid:items'))!.get('item-1')!);
    expect(item.institution_name).toBe('Renamed');
    expect(await decrypt(item.encrypted_access_token)).toBe('access-2');
  });

  test('a key deleted between listing and reading is skipped', async () => {
    await seed();
    const realType = fake.type.bind(fake);
    fake.type = (async (key: string) => {
      if (key === testKey('goals')) fake.strings.delete(key);
      return realType(key);
    }) as typeof fake.type;
    try {
      expect(await run()).toMatchObject({ moved: 4, complete: true });
    } finally {
      fake.type = realType as typeof fake.type;
    }
  });

  test('if the active key leaves the key store mid-pass (a restore), it stops without writing under it', async () => {
    await seed();
    const err = await runWith('history:net-worth', () => {
      fake.hashes.delete(keysHashKey()); // a restore replaced the key store
    }).catch((e) => e);
    expect(err).toBeInstanceOf(MasterKeyError);
    expect(err.message).toContain('stopped');
    for (const v of fake.hashes.get(testKey('history:net-worth'))!.values()) expect(formatOf(v).keyId).toBe('k0');
  });

  test('if the active key changes mid-pass, it stops', async () => {
    await seed();
    const err = await runWith('goals', () => {
      fake.strings.set(activeKeyName(), 'k9-00000000');
    }).catch((e) => e);
    expect(err).toBeInstanceOf(MasterKeyError);
    expect(formatOf(fake.strings.get(testKey('goals'))!).keyId).toBe('k0');
  });

  test('a value that never compares equal is reported, not retried forever', async () => {
    await seed();
    const realEval = fake.eval.bind(fake);
    fake.eval = (async (script: string, keys: string[], args: string[]) =>
      keys[0] === testKey('goals') ? 0 : realEval(script, keys, args)) as typeof fake.eval;
    let report;
    try {
      report = await run();
    } finally {
      fake.eval = realEval as typeof fake.eval;
    }
    expect(report.changed_meanwhile).toBe(0);
    expect(report.unreadable).toEqual([
      { key: 'goals', reason: 'could not be compared (it changed and changed back, or is not valid UTF-8 text); tried again next call' },
    ]);
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

  const GUARD = ['active', 'keys'];
  const setGuard = async (id = 'k1-aaaaaaaa') => {
    await client.send('SET', ['active', id]);
    await client.send('HSET', ['keys', id, '{}']);
    return id;
  };

  test('a string is replaced only while it still matches, keeping its expiry', async () => {
    const id = await setGuard();
    await client.send('SET', ['s', 'old é', 'PX', '100000']);
    expect(await evalScript(CAS_STRING, ['s', ...GUARD], [sha1('other'), 'new', id])).toBe(0);
    expect(await client.send('GET', ['s'])).toBe('old é');
    expect(await evalScript(CAS_STRING, ['s', ...GUARD], [sha1('old é'), 'new', id])).toBe(1);
    expect(await client.send('GET', ['s'])).toBe('new');
    expect(Number(await client.send('PTTL', ['s']))).toBeGreaterThan(90000);

    await client.send('SET', ['plain', 'v']);
    expect(await evalScript(CAS_STRING, ['plain', ...GUARD], [sha1('v'), 'w', id])).toBe(1);
    expect(Number(await client.send('PTTL', ['plain']))).toBe(-1);

    expect(await evalScript(CAS_STRING, ['missing', ...GUARD], [sha1(''), 'x', id])).toBe(-1);
    expect(await client.send('EXISTS', ['missing'])).toBe(0);
  });

  test('a hash field is replaced only while it still matches', async () => {
    const id = await setGuard();
    await client.send('HSET', ['h', 'f', 'old', 'g', 'keep']);
    expect(await evalScript(CAS_HASH, ['h', ...GUARD], ['f', sha1('other'), 'new', id])).toBe(0);
    expect(await client.send('HGET', ['h', 'f'])).toBe('old');
    expect(await evalScript(CAS_HASH, ['h', ...GUARD], ['f', sha1('old'), 'new', id])).toBe(1);
    expect(await client.send('HGET', ['h', 'f'])).toBe('new');
    expect(await client.send('HGET', ['h', 'g'])).toBe('keep');
    expect(await evalScript(CAS_HASH, ['h', ...GUARD], ['gone', sha1(''), 'x', id])).toBe(-1);
    expect(await client.send('HEXISTS', ['h', 'gone'])).toBe(0);
  });

  test('nothing is written unless the key is still active and still stored', async () => {
    const id = await setGuard();
    await client.send('SET', ['s', 'old']);
    await client.send('HSET', ['h', 'f', 'old']);
    // Not the active key.
    expect(await evalScript(CAS_STRING, ['s', ...GUARD], [sha1('old'), 'new', 'k2-bbbbbbbb'])).toBe(-2);
    expect(await evalScript(CAS_HASH, ['h', ...GUARD], ['f', sha1('old'), 'new', 'k2-bbbbbbbb'])).toBe(-2);
    // Active, but gone from the key store.
    await client.send('DEL', ['keys']);
    expect(await evalScript(CAS_STRING, ['s', ...GUARD], [sha1('old'), 'new', id])).toBe(-2);
    expect(await evalScript(CAS_HASH, ['h', ...GUARD], ['f', sha1('old'), 'new', id])).toBe(-2);
    // No active key at all.
    await setGuard();
    await client.send('DEL', ['active']);
    expect(await evalScript(CAS_STRING, ['s', ...GUARD], [sha1('old'), 'new', id])).toBe(-2);
    expect(await client.send('GET', ['s'])).toBe('old');
    expect(await client.send('HGET', ['h', 'f'])).toBe('old');
  });

  test('the whole pass, run against it', async () => {
    // The data lives in the real Redis; lib/crypto keeps its key store in the
    // test double, so the two crypto keys the scripts check are mirrored.
    await seed();
    const realClient: import('@/lib/reencrypt').ReencryptClient = {
      scan: async (cursor, o) => (await client.send('SCAN', [String(cursor), 'MATCH', o.match, 'COUNT', String(o.count)])) as [string, string[]],
      hscan: async (key, cursor, o) => (await client.send('HSCAN', [key, String(cursor), 'COUNT', String(o.count)])) as [string, string[]],
      type: async (key) => String(await client.send('TYPE', [key])),
      get: (key) => client.send('GET', [key]),
      hget: (key, field) => client.send('HGET', [key, field]),
      getrange: (key, a, b) => client.send('GETRANGE', [key, String(a), String(b)]),
      eval: (script, keys, args) => evalScript(script, keys, args),
    };
    for (const [key, value] of fake.strings) await client.send('SET', [key, value]);
    for (const [key, h] of fake.hashes) for (const [f, v] of h) await client.send('HSET', [key, f, v]);
    await encrypt('create the first data key');
    await client.send('SET', [activeKeyName(), fake.strings.get(activeKeyName())!]);
    for (const [f, v] of fake.hashes.get(keysHashKey())!) await client.send('HSET', [keysHashKey(), f, v]);

    const report = await reencrypt({ dryRun: false, budgetMs: 60_000, client: realClient });
    expect(report).toMatchObject({ moved: 5, unreadable_count: 0, complete: true });
    expect(await decrypt(String(await client.send('GET', [testKey('goals')])))).toBe('[{"id":"g1"}]');
    const item = JSON.parse(String(await client.send('HGET', [testKey('plaid:items'), 'item-1'])));
    expect(await decrypt(item.encrypted_access_token)).toBe('access-sandbox-1');
    expect(await reencrypt({ dryRun: true, budgetMs: 60_000, client: realClient })).toMatchObject({ complete: true });
  });
});
