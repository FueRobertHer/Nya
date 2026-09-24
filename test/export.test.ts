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
      schema_era: 'unscoped',
      env_prefix: 'test',
      container_id: null,
      taken_at: NOW.toISOString(),
      excluded: ['cache:*', 'ratelimit:*'],
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
    await fake.set(testKey('txns-blocked:item_a'), 'marker', { ex: 600 });

    const [record] = parse(await collect()).slice(1, -1);
    expect(record.ttl).toBe(600);
  });

  test('leaves out caches and rate-limit counters', async () => {
    await fake.set(testKey('cache:net-worth'), 'stale');
    await fake.set(testKey('ratelimit:login:1.2.3.4'), '3');
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

  test('two exports of unchanged data are identical', async () => {
    await fake.set(testKey('b'), '2');
    await fake.set(testKey('a'), '1');
    await fake.hset(testKey('c'), { x: '1' });

    expect(await collect()).toEqual(await collect());
  });
});

describe('the footer proves completeness', () => {
  test('counts the records and hashes exactly the record lines', async () => {
    await fake.set(testKey('a'), '1');
    await fake.hset(testKey('b'), { f: 'v' });

    const lines = await collect();
    const footer = JSON.parse(lines.at(-1)!);
    const expected = createHash('sha256').update(lines.slice(1, -1).join('')).digest('hex');

    expect(footer).toEqual({ end: true, keys: 2, sha256: expected, unsupported: [] });
  });

  test('an empty environment still gets a footer, so it is distinguishable from a cut-off one', async () => {
    const lines = parse(await collect());

    expect(lines).toHaveLength(2);
    expect(lines[1]).toMatchObject({ end: true, keys: 0 });
  });

  test('a failed read ends the stream with NO footer', async () => {
    await fake.set(testKey('a'), '1');
    await fake.set(testKey('b'), '2');
    fake.failNext('get', 2);

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

  test('a value the client deserialized is refused rather than archived wrong', async () => {
    await fake.set(testKey('flag'), '1');
    const deserializing = Object.assign(Object.create(fake), {
      get: async () => 1,
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
