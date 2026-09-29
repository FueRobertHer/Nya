import { describe, expect, test, mock, beforeEach, afterEach } from 'bun:test';
import { createHash } from 'node:crypto';
import { FakeRedis, storageMock, testKey } from './fake-redis';

const fake = new FakeRedis();
mock.module('@/lib/storage', () => storageMock(fake));

const { exportLines } = await import('@/lib/export');
const { POST } = await import('@/app/api/ops/export/route');

const NOW = new Date('2026-06-15T12:00:00.000Z');

async function collect(client = fake as any): Promise<string[]> {
  const out: string[] = [];
  for await (const line of exportLines(client, NOW)) out.push(line);
  return out;
}

const parse = (lines: string[]) => lines.map((l) => JSON.parse(l));

beforeEach(() => fake.reset());

describe('the archive', () => {
  test('opens with a header naming where it came from', async () => {
    const [header] = parse(await collect());

    expect(header).toEqual({
      nya_export: 1,
      schema_era: 'containers',
      env_prefix: 'test',
      container_id: null,
      taken_at: NOW.toISOString(),
      excluded: [
        'cache:*',
        'c:*:cache:*',
        'ratelimit:*',
        'c:*:ratelimit:*',
        'invtxns-lock:*',
        'c:*:invtxns-lock:*',
        'sessions:*',
        'c:*:sessions:*',
        'snapshot:*',
        'c:*:snapshot:*',
        'move:*',
        'c:*:move:*',
        'account-links:lock*',
        'c:*:account-links:lock*',
        'history:forgetting:*',
        'c:*:history:forgetting:*',
        'backups:*',
        'c:*:backups:*',
        'invites:*',
        'c:*:invites:*',
      ],
    });
  });

  test('carries strings and hashes exactly, with the prefix stripped', async () => {
    await fake.set(testKey('budgets'), 'v1-ciphertext');
    // A value the default client would have turned into the number 1.
    await fake.set(testKey('history:backfill-done'), '1');
    await fake.hset(testKey('history:net-worth'), { '2026-01-01': 'aaa', '2026-01-02': 'bbb' });

    const records = parse(await collect()).slice(1, -1);

    expect(records).toEqual([
      { key: 'budgets', type: 'string', ttl: null, value: 'v1-ciphertext' },
      { key: 'history:backfill-done', type: 'string', ttl: null, value: '1' },
      {
        key: 'history:net-worth',
        type: 'hash',
        ttl: null,
        value: { '2026-01-01': 'aaa', '2026-01-02': 'bbb' },
      },
    ]);
  });

  test('records a TTL where the key has one', async () => {
    // No exported key carries a TTL today (the ones that do are caches, which
    // are excluded). This pins the field so a future expiring key is restored
    // expiring, not permanent.
    await fake.set(testKey('some:key'), 'v', { ex: 600 });

    const [record] = parse(await collect()).slice(1, -1);
    expect(record.ttl).toBe(600);
  });

  test('leaves out caches and rate-limit counters', async () => {
    await fake.set(testKey('cache:net-worth'), 'stale');
    await fake.set(testKey('ratelimit:login:1.2.3.4'), '3');
    // A forget's progress names points of a fold a restore wouldn't match.
    await fake.hset(testKey('c:00000000-0000-4000-8000-000000000000:history:forgetting:t1'), { 'r:2026-01-01': '1' });
    await fake.set(testKey('goals'), 'kept');

    const keys = parse(await collect()).slice(1, -1).map((r) => r.key);
    expect(keys).toEqual(['goals']);
  });

  test('never reaches another environment', async () => {
    await fake.set(testKey('goals'), 'mine');
    await fake.set('production:goals', 'not mine');
    // Shares the letters but not the namespace: the colon is part of the match.
    await fake.set('testing:goals', 'not mine either');

    const keys = parse(await collect()).slice(1, -1).map((r) => r.key);
    expect(keys).toEqual(['goals']);
  });

  test('pages through a hash larger than one scan page', async () => {
    const fields: Record<string, string> = {};
    for (let i = 0; i < 450; i++) fields[`2025-${String(i).padStart(4, '0')}`] = `v${i}`;
    await fake.hset(testKey('history:accounts'), fields);

    const [record] = parse(await collect()).slice(1, -1);
    expect(record.value).toEqual(fields);
  });

  test('pages through more keys than one scan page', async () => {
    for (let i = 0; i < 1050; i++) await fake.set(testKey(`k${String(i).padStart(4, '0')}`), `v${i}`);

    const lines = parse(await collect());
    expect(lines.at(-1).keys).toBe(1050);
    expect(lines.slice(1, -1).map((r) => r.key)).toHaveLength(1050);
  });

  test('reads in pipelines, not a request per key', async () => {
    // Every command used to be its own request to Upstash (three or more per
    // key), and the nightly backup ran out of time. 450 keys were ~1,400
    // requests; batched, each 100 keys cost a handful of pipelines.
    for (let i = 0; i < 400; i++) await fake.set(testKey(`s${String(i).padStart(3, '0')}`), `v${i}`);
    const fields: Record<string, string> = {};
    for (let i = 0; i < 450; i++) fields[`f${i}`] = `v${i}`;
    // Each hash distinct too, so a page landing on the wrong hash would show.
    for (let i = 0; i < 50; i++) await fake.hset(testKey(`h${String(i).padStart(2, '0')}`), { ...fields, which: `h${i}` });
    fake.ops = 0;
    fake.pipelines = 0;
    fake.pipelined = 0;

    const lines = parse(await collect());
    expect(lines.at(-1).keys).toBe(450);
    for (const r of lines.slice(1, -1)) {
      if (r.type === 'hash') expect(r.value).toEqual({ ...fields, which: `h${Number(r.key.slice(1))}` });
      else expect(r.value).toBe(`v${Number(r.key.slice(1))}`);
    }

    const direct = fake.ops - fake.pipelined;
    expect(direct).toBe(1); // the one SCAN
    expect(fake.pipelines).toBeLessThan(30);
  });

  test('strings and hashes across several batches keep their own order, values and TTLs', async () => {
    // Mixed types and some TTLs, so a value or TTL attached to its neighbour
    // (an index slip between the per-type pipelines) would show.
    for (let i = 0; i < 250; i++) {
      const key = testKey(`k${String(i).padStart(3, '0')}`);
      if (i % 2) await fake.set(key, `v${i}`, i % 3 ? undefined : { ex: 1000 + i });
      else await fake.hset(key, { f: `v${i}` });
    }

    const records = parse(await collect()).slice(1, -1);
    expect(records.map((r) => r.key)).toEqual(Array.from({ length: 250 }, (_, i) => `k${String(i).padStart(3, '0')}`));
    records.forEach((r, i) => {
      if (i % 2) expect(r).toEqual({ key: r.key, type: 'string', ttl: i % 3 ? null : 1000 + i, value: `v${i}` });
      else expect(r).toEqual({ key: r.key, type: 'hash', ttl: null, value: { f: `v${i}` } });
    });
  });

  test('large strings are fetched a few at a time, not all in one pipeline', async () => {
    // Five 3 MiB values: at most two fit under the 8 MiB a pipeline may ask
    // for, so the GETs are split, and every value still arrives whole.
    const big = (c: string) => c.repeat(3 * 1024 * 1024);
    for (const c of 'abcde') await fake.set(testKey(`txns:${c}`), big(c));
    await fake.set(testKey('small'), 'x');
    const gets: number[] = [];
    const counting = Object.assign(Object.create(fake), {
      pipeline() {
        const p = fake.pipeline.call(this);
        let n = 0;
        return new Proxy(p, {
          get: (target, name) => {
            if (name === 'get') return (...a: unknown[]) => (n++, target.get(...a));
            if (name === 'exec') return () => (n && gets.push(n), target.exec());
            return target[name];
          },
        });
      },
    });

    const records = parse(await collect(counting)).slice(1, -1);
    expect(records.map((r) => r.key)).toEqual(['small', 'txns:a', 'txns:b', 'txns:c', 'txns:d', 'txns:e']);
    // Compared whole, not by length: a value on the wrong key must fail.
    records.slice(1).forEach((r, i) => expect(r.value === big('abcde'[i])).toBe(true));
    expect(Math.max(...gets)).toBeLessThanOrEqual(3);
    expect(gets.reduce((a, b) => a + b, 0)).toBe(6);
  });

  test('keeps a hash field named __proto__', async () => {
    // Built with JSON.parse so "__proto__" is an own field, as Redis would hold
    // it, rather than an object literal setting the prototype.
    await fake.hset(testKey('h'), JSON.parse('{"__proto__":"v","a":"b"}'));

    const [line] = (await collect()).slice(1, -1);
    expect(line).toContain('"__proto__":"v"');
    expect(line).toContain('"a":"b"');
  });

  test('hash fields come out sorted, whatever order Redis returns them in', async () => {
    await fake.hset(testKey('h'), { b: '2', c: '3', a: '1' });
    const reversing = Object.assign(Object.create(fake), {
      hscan: async (key: string, cursor: string | number, opts?: { count?: number }) => {
        const [next, flat] = await fake.hscan(key, cursor, opts);
        const pairs: string[][] = [];
        for (let i = 0; i < flat.length; i += 2) pairs.push([flat[i], flat[i + 1]]);
        return [next, pairs.reverse().flat()];
      },
    });

    const [plain] = (await collect()).slice(1, -1);
    const [reversed] = (await collect(reversing)).slice(1, -1);
    expect(plain).toBe(reversed);
    expect(Object.keys(JSON.parse(plain).value)).toEqual(['a', 'b', 'c']);
  });

  test('two exports of unchanged data are identical', async () => {
    await fake.set(testKey('b'), '2');
    await fake.set(testKey('a'), '1');
    await fake.hset(testKey('c'), { x: '1' });

    expect(await collect()).toEqual(await collect());
  });
});

describe('the footer proves completeness', () => {
  test('counts the records and hashes the header and record lines', async () => {
    await fake.set(testKey('a'), '1');
    await fake.hset(testKey('b'), { f: 'v' });

    const lines = await collect();
    const footer = JSON.parse(lines.at(-1)!);
    // Header included: restore trusts its era and prefix, so they must be
    // covered. Footer excluded, since it carries the hash.
    const expected = createHash('sha256').update(lines.slice(0, -1).join('')).digest('hex');

    expect(footer).toEqual({ end: true, keys: 2, sha256: expected, unsupported: [] });
  });

  test('an empty environment still gets a footer, so it is distinguishable from a cut-off one', async () => {
    const lines = parse(await collect());

    expect(lines).toHaveLength(2);
    expect(lines[1]).toMatchObject({ end: true, keys: 0 });
  });

  // Every command the walk issues, because swallowing a failure in ANY of them
  // would yield a complete-looking archive with keys missing: a caught scan
  // gives zero keys and a valid footer, a caught type or hscan drops keys one
  // at a time.
  for (const command of ['scan', 'type', 'strlen', 'get', 'hscan', 'ttl'] as const) {
    test(`a failed ${command} ends the stream with NO footer`, async () => {
      await fake.set(testKey('a'), '1');
      await fake.hset(testKey('b'), { f: 'v' });
      fake.failNext(command);

      const seen: string[] = [];
      let error: unknown;
      try {
        for await (const line of exportLines(fake as any, NOW)) seen.push(line);
      } catch (err) {
        error = err;
      }

      expect(error).toBeDefined();
      expect(seen.some((l) => JSON.parse(l).end)).toBe(false);
    });
  }

  test('a key outside the prefix is refused, not archived under a wrong name', async () => {
    await fake.set(testKey('a'), '1');
    const leaky = Object.assign(Object.create(fake), {
      scan: async () => ['0', [testKey('a'), 'production:goals']],
    });

    await expect(collect(leaky)).rejects.toThrow(/outside/);
  });

  test('a value the client deserialized is refused rather than archived wrong', async () => {
    await fake.set(testKey('flag'), '1');
    const deserializing = Object.assign(Object.create(fake), {
      get: async () => 1,
    });

    await expect(collect(deserializing)).rejects.toThrow(/non-string/);
  });

  test('a hash value the client deserialized is refused too', async () => {
    await fake.hset(testKey('h'), { f: '1' });
    const deserializing = Object.assign(Object.create(fake), {
      hscan: async () => ['0', ['f', 1]],
    });

    await expect(collect(deserializing)).rejects.toThrow(/non-string/);
  });

  test('a key of a type the format cannot carry is named, not dropped', async () => {
    await fake.set(testKey('a'), '1');
    await fake.set(testKey('odd'), 'x');
    const withList = Object.assign(Object.create(fake), {
      type: async (key: string) => (key === testKey('odd') ? 'list' : fake.type(key)),
    });

    const footer = JSON.parse((await collect(withList)).at(-1)!);
    expect(footer.keys).toBe(1);
    expect(footer.unsupported).toEqual([{ key: 'odd', type: 'list' }]);
  });
});

// Keys can change between the scan that lists them and the reads that fetch
// them. A key that is genuinely gone is left out and not counted; everything
// else is still archived and counted.
describe('keys that disappear mid-export', () => {
  /** A client that deletes `victim` just before `command` reads it. */
  function deletesBefore(command: 'type' | 'get' | 'hscan' | 'ttl', victim: string) {
    const real = (fake as any)[command].bind(fake);
    return Object.assign(Object.create(fake), {
      [command]: async (key: string, ...rest: unknown[]) => {
        if (key === testKey(victim)) await fake.del(key);
        return real(key, ...rest);
      },
    });
  }

  for (const [command, victim] of [
    ['type', 'gone_s'],
    ['get', 'gone_s'],
    ['hscan', 'gone_h'],
    ['ttl', 'gone_s'],
  ] as const) {
    test(`a key deleted before its ${command} is left out and not counted`, async () => {
      await fake.set(testKey('kept'), '1');
      await fake.set(testKey('gone_s'), '2');
      await fake.hset(testKey('gone_h'), { f: 'v' });

      const lines = parse(await collect(deletesBefore(command, victim)));
      const keys = lines.slice(1, -1).map((r) => r.key);

      expect(keys).not.toContain(victim);
      expect(keys).toContain('kept');
      expect(lines.at(-1).keys).toBe(keys.length);
      // Gone is not the same as a type the format cannot carry.
      expect(lines.at(-1).unsupported).toEqual([]);
    });
  }

  test('a hash that reads back empty is never archived as an empty record', async () => {
    // Redis cannot hold an empty hash, and HSET with no fields is an error, so
    // an empty record would be one restore cannot write. Forced here with a
    // client whose hscan sees nothing while the key still otherwise exists.
    await fake.hset(testKey('h'), { f: 'v' });
    const emptied = Object.assign(Object.create(fake), { hscan: async () => ['0', []] });

    const lines = parse(await collect(emptied));
    expect(lines.slice(1, -1)).toEqual([]);
    expect(lines.at(-1).keys).toBe(0);
  });
});

describe('the route', () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
  });

  const call = (auth?: string) =>
    POST(
      new Request('http://x/api/ops/export', {
        method: 'POST',
        headers: auth ? { authorization: auth } : {},
      })
    );

  test('does not exist unless OPS_ENABLED is set', async () => {
    process.env.OPS_SECRET = 's3cret';
    delete process.env.OPS_ENABLED;

    expect((await call('Bearer s3cret')).status).toBe(404);
  });

  test('stays closed when enabled with no secret configured', async () => {
    process.env.OPS_ENABLED = '1';
    delete process.env.OPS_SECRET;

    expect((await call('Bearer ')).status).toBe(401);
    expect((await call()).status).toBe(401);
  });

  test('every other method is a 404 whether or not it is enabled', async () => {
    const route = await import('@/app/api/ops/export/route');
    for (const enabled of [undefined, '1']) {
      if (enabled) process.env.OPS_ENABLED = enabled;
      else delete process.env.OPS_ENABLED;
      for (const method of ['GET', 'HEAD', 'OPTIONS', 'PUT', 'PATCH', 'DELETE'] as const) {
        const res = await route[method]();
        expect(res.status).toBe(404);
        expect(res.headers.get('allow')).toBeNull();
      }
    }
  });

  test('rejects a wrong secret', async () => {
    process.env.OPS_ENABLED = '1';
    process.env.OPS_SECRET = 's3cret';

    expect((await call('Bearer nope')).status).toBe(401);
  });

  test('streams the archive with the right secret, uncacheable', async () => {
    process.env.OPS_ENABLED = '1';
    process.env.OPS_SECRET = 's3cret';
    await fake.set(testKey('goals'), 'ciphertext');

    const res = await call('Bearer s3cret');
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('content-type')).toBe('application/x-ndjson');

    const lines = (await res.text()).trim().split('\n').map((l) => JSON.parse(l));
    expect(lines[1]).toEqual({ key: 'goals', type: 'string', ttl: null, value: 'ciphertext' });
    expect(lines.at(-1)).toMatchObject({ end: true, keys: 1 });
  });
});

// lib/storage.ts validates the prefix at load. Checked in a separate process
// because every test file here replaces lib/storage with a mock, and Bun shares
// that mock across files, so an import in this process would never run the
// real module.
describe('the key prefix', () => {
  const load = (prefix: string) =>
    Bun.spawnSync([process.execPath, '-e', "await import('./lib/storage.ts')"], {
      env: { ...process.env, REDIS_PREFIX: prefix },
      cwd: `${import.meta.dir}/..`,
    });

  test('a plain segment is accepted', () => {
    expect(load('restore-test').exitCode).toBe(0);
  });

  for (const bad of ['production:restore-test', 'prod*', 'a?b', 'x[y]', '']) {
    test(`${JSON.stringify(bad)} is refused at startup`, () => {
      const res = load(bad);
      expect(res.exitCode).not.toBe(0);
      expect(res.stderr.toString()).toContain('Invalid Redis key prefix');
    });
  }
});
