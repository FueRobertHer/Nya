import { describe, expect, test, mock, beforeEach, afterEach } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FakeRedis, storageMock, testKey } from './fake-redis';

const fake = new FakeRedis();
mock.module('@/lib/storage', () => storageMock(fake));

const { exportLines } = await import('@/lib/export');
const { verifyArchive, restoreArchive, checkTarget, targetKeys, RestoreRefused, checkRegistry } = await import(
  '@/lib/restore'
);
const { main, parseArgs } = await import('@/scripts/restore');

async function exportText(): Promise<string> {
  let text = '';
  for await (const line of exportLines(fake as any)) text += line;
  return text;
}

/** Everything under the test prefix, as a comparable snapshot of the fake. */
function snapshot() {
  const strings = [...fake.strings].filter(([k]) => k.startsWith('test:')).sort();
  const hashes = [...fake.hashes]
    .filter(([k, h]) => k.startsWith('test:') && h.size > 0)
    .map(([k, h]) => [k, [...h].sort()])
    .sort();
  return { strings, hashes };
}

async function seed() {
  await fake.set(testKey('budgets'), 'cipher-budgets');
  await fake.set(testKey('history:backfill-done'), '1');
  await fake.hset(testKey('history:net-worth'), { '2026-01-01': 'a', '2026-01-02': 'b' });
  await fake.hset(testKey('plaid:items'), { item_1: '{"item_id":"item_1"}' });
}

/** Rebuild an archive's footer after editing its records, so a test can target
 *  one check without tripping the checksum first. */
function reseal(lines: string[]): string {
  const body = lines.slice(0, -1);
  const records = body.slice(1);
  const sha = createHash('sha256').update(body.map((l) => l + '\n').join('')).digest('hex');
  const footer = { end: true, keys: records.length, sha256: sha, unsupported: [] };
  return [...body, JSON.stringify(footer)].join('\n') + '\n';
}

const linesOf = (text: string) => text.slice(0, -1).split('\n');

beforeEach(() => fake.reset());

describe('verifyArchive refuses anything it cannot vouch for', () => {
  test('accepts a real export', async () => {
    await seed();
    const archive = verifyArchive(await exportText());
    expect(archive.records.map((r) => r.key)).toEqual([
      'budgets',
      'history:backfill-done',
      'history:net-worth',
      'plaid:items',
    ]);
  });

  test('a file cut off mid-line', async () => {
    await seed();
    const text = await exportText();
    expect(() => verifyArchive(text.slice(0, -10))).toThrow(/cut short/);
    // Even when only the final newline is missing: the footer may look whole,
    // but nothing proves the writer finished.
    expect(() => verifyArchive(text.slice(0, -1))).toThrow(/cut short/);
  });

  test('a file cut off between lines, so the footer is missing', async () => {
    await seed();
    const lines = linesOf(await exportText());
    const cut = lines.slice(0, -1).join('\n') + '\n';
    expect(() => verifyArchive(cut)).toThrow(/footer/);
  });

  test('Windows line endings are named as such, not as damage', async () => {
    await seed();
    const text = (await exportText()).replace(/\n/g, '\r\n');
    expect(() => verifyArchive(text)).toThrow(/CRLF/);
  });

  test('an edited record', async () => {
    await seed();
    const text = (await exportText()).replace('cipher-budgets', 'cipher-budgetz');
    expect(() => verifyArchive(text)).toThrow(/Checksum/);
  });

  test('an edited header, since the hash covers it', async () => {
    await seed();
    const text = (await exportText()).replace('"env_prefix":"test"', '"env_prefix":"prod"');
    expect(() => verifyArchive(text)).toThrow(/Checksum/);
  });

  test('a count that does not match', async () => {
    await seed();
    const lines = linesOf(await exportText());
    const footer = JSON.parse(lines.at(-1)!);
    lines[lines.length - 1] = JSON.stringify({ ...footer, keys: footer.keys + 1 });
    expect(() => verifyArchive(lines.join('\n') + '\n')).toThrow(/Footer says/);
  });

  test('another key layout', async () => {
    await seed();
    const lines = linesOf(await exportText());
    lines[0] = JSON.stringify({ ...JSON.parse(lines[0]), schema_era: 'container-v1' });
    expect(() => verifyArchive(reseal(lines))).toThrow(/key layout/);
  });

  test('a format version it does not know', async () => {
    const lines = linesOf(await exportText());
    lines[0] = JSON.stringify({ ...JSON.parse(lines[0]), nya_export: 2 });
    expect(() => verifyArchive(reseal(lines))).toThrow(/format/);
  });

  test('keys the export could not carry', async () => {
    const lines = linesOf(await exportText());
    const footer = JSON.parse(lines.at(-1)!);
    lines[lines.length - 1] = JSON.stringify({ ...footer, unsupported: [{ key: 'x', type: 'list' }] });
    expect(() => verifyArchive(lines.join('\n') + '\n')).toThrow(/could not carry/);
  });

  test('something that is not an export at all', () => {
    expect(() => verifyArchive('{"hello":1}\n{"end":true}\n')).toThrow(/header/);
    expect(() => verifyArchive('')).toThrow(RestoreRefused);
  });

  for (const [name, record, pattern] of [
    ['a repeated key', null, /repeats/],
    ['an excluded key', { key: 'cache:net-worth', type: 'string', ttl: null, value: 'x' }, /never include/],
    [
      "an excluded key inside a container",
      { key: 'c:0b6f5a52-3c1d-4e2f-8a9b-1c2d3e4f5a6b:cache:net-worth', type: 'string', ttl: null, value: 'x' },
      /never include/,
    ],
    ['an empty hash', { key: 'h', type: 'hash', ttl: null, value: {} }, /empty hash/],
    ['an unknown type', { key: 'l', type: 'list', ttl: null, value: [] }, /unknown type/],
    ['a negative ttl', { key: 's', type: 'string', ttl: -1, value: 'x' }, /ttl/],
    ['a zero ttl', { key: 's', type: 'string', ttl: 0, value: 'x' }, /ttl/],
    ['a non-string value', { key: 's', type: 'string', ttl: null, value: 1 }, /non-string/],
    ['a non-string hash value', { key: 'h', type: 'hash', ttl: null, value: { f: 1 } }, /non-string/],
    ['an early footer', { end: true, keys: 0, sha256: '', unsupported: [] }, /footer before/],
  ] as const) {
    test(name, async () => {
      await fake.set(testKey('budgets'), 'x');
      const lines = linesOf(await exportText());
      const extra = record === null ? lines[1] : JSON.stringify(record);
      lines.splice(lines.length - 1, 0, extra);
      expect(() => verifyArchive(reseal(lines))).toThrow(pattern);
    });
  }
});

describe('restoreArchive', () => {
  test('round-trips an export exactly', async () => {
    await seed();
    await fake.set(testKey('txns-blocked:item_1'), 'marker', { ex: 600 });
    const before = snapshot();
    const archive = verifyArchive(await exportText());

    fake.reset();
    const result = await restoreArchive(fake as any, archive, { overwrite: false });

    expect(result).toEqual({ written: 5, deleted: 0 });
    expect(snapshot()).toEqual(before);
    expect(await fake.ttl(testKey('txns-blocked:item_1'))).toBe(600);
  });

  test('writes into this process\'s prefix, whatever prefix the archive came from', async () => {
    await seed();
    const lines = linesOf(await exportText());
    lines[0] = JSON.stringify({ ...JSON.parse(lines[0]), env_prefix: 'production' });
    const archive = verifyArchive(reseal(lines));

    fake.reset();
    await restoreArchive(fake as any, archive, { overwrite: false });

    expect(await fake.get<string>(testKey('budgets'))).toBe('cipher-budgets');
    expect([...fake.strings.keys()].some((k) => k.startsWith('production:'))).toBe(false);
  });

  test('refuses a populated target without overwrite, and writes nothing', async () => {
    await seed();
    const archive = verifyArchive(await exportText());
    await fake.set(testKey('budgets'), 'newer');
    const opsBefore = fake.ops;

    await expect(restoreArchive(fake as any, archive, { overwrite: false })).rejects.toThrow(/--overwrite/);
    expect(await fake.get<string>(testKey('budgets'))).toBe('newer');
    // Only reads happened: a scan to find what is there.
    expect(fake.ops - opsBefore).toBeLessThanOrEqual(2);
  });

  test('a target holding only rate-limit counters counts as empty', async () => {
    await seed();
    const archive = verifyArchive(await exportText());
    fake.reset();
    await fake.set(testKey('ratelimit:login:1.2.3.4'), '2');

    expect(await targetKeys(fake as any)).toEqual([]);
    await restoreArchive(fake as any, archive, { overwrite: false });
    expect(await fake.get<string>(testKey('budgets'))).toBe('cipher-budgets');
  });

  test("a container's session epoch is not data: never exported, never replaced", async () => {
    const epochKey = testKey('c:0b6f5a52-3c1d-4e2f-8a9b-1c2d3e4f5a6b:sessions:epoch');
    await seed();
    await fake.set(epochKey, '1');
    const archive = verifyArchive(await exportText());
    expect(archive.records.map((r) => r.key)).not.toContain('c:0b6f5a52-3c1d-4e2f-8a9b-1c2d3e4f5a6b:sessions:epoch');

    // Revoked since the archive was taken: a restore must not bring those back.
    await fake.set(epochKey, '5');
    await fake.set(testKey('sessions:legacy-cutoff'), '1700000000000');
    const existing = await targetKeys(fake as any);
    expect(existing).not.toContain(epochKey);
    await restoreArchive(fake as any, archive, { overwrite: true, backedUp: existing });
    expect(await fake.get<string>(epochKey)).toBe('5');
    expect(await fake.get<string>(testKey('sessions:legacy-cutoff'))).toBe('1700000000000');
  });

  test("the snapshot cron's log is not data: never exported, never replaced", async () => {
    const runsKey = testKey('c:0b6f5a52-3c1d-4e2f-8a9b-1c2d3e4f5a6b:snapshot:runs');
    await seed();
    await fake.hset(runsKey, { '2026-01-01': 'old' });
    const archive = verifyArchive(await exportText());
    expect(archive.records.map((r) => r.key)).not.toContain('c:0b6f5a52-3c1d-4e2f-8a9b-1c2d3e4f5a6b:snapshot:runs');

    await fake.hset(runsKey, { '2026-09-25': 'today' });
    await restoreArchive(fake as any, archive, { overwrite: true, backedUp: await targetKeys(fake as any) });
    expect(await fake.hget<string>(runsKey, '2026-09-25')).toBe('today');
  });

  test('overwrite replaces: strays and stale caches go, rate limits stay', async () => {
    await seed();
    const archive = verifyArchive(await exportText());
    await fake.set(testKey('txns:item_from_later'), 'stray');
    await fake.set(testKey('cache:net-worth'), 'stale');
    await fake.hset(testKey('history:net-worth'), { '2026-09-01': 'newer field' });
    await fake.set(testKey('ratelimit:login:1.2.3.4'), '2');
    await fake.set('production:budgets', 'another environment');

    await restoreArchive(fake as any, archive, { overwrite: true, backedUp: await targetKeys(fake as any) });

    expect(await fake.get<string>(testKey('txns:item_from_later'))).toBeNull();
    expect(await fake.get<string>(testKey('cache:net-worth'))).toBeNull();
    expect(await fake.hget<string>(testKey('history:net-worth'), '2026-09-01')).toBeNull();
    expect(await fake.get<string>(testKey('ratelimit:login:1.2.3.4'))).toBe('2');
    expect(await fake.get<string>('production:budgets')).toBe('another environment');
  });

  test('running it twice leaves the same state', async () => {
    await seed();
    const archive = verifyArchive(await exportText());
    fake.reset();

    await restoreArchive(fake as any, archive, { overwrite: false });
    const once = snapshot();
    await restoreArchive(fake as any, archive, { overwrite: true, backedUp: await targetKeys(fake as any) });

    expect(snapshot()).toEqual(once);
  });

  test('a crash part way is recovered by running again with overwrite', async () => {
    await seed();
    const archive = verifyArchive(await exportText());
    const before = snapshot();
    fake.reset();

    fake.failNext('hset');
    await expect(restoreArchive(fake as any, archive, { overwrite: false })).rejects.toThrow();
    await expect(restoreArchive(fake as any, archive, { overwrite: false })).rejects.toThrow(/--overwrite/);
    await restoreArchive(fake as any, archive, { overwrite: true, backedUp: await targetKeys(fake as any) });

    expect(snapshot()).toEqual(before);
  });

  test('a hash that comes back in a different field order still matches', async () => {
    // Real Redis promises no HSCAN order and often returns a restored hash in a
    // different order from the original. The fake keeps insertion order, so
    // this client reverses every page to stand in for that.
    const fields: Record<string, string> = {};
    for (let i = 0; i < 30; i++) fields[`2026-01-${String(i).padStart(2, '0')}`] = `cipher-${i}`;
    await fake.hset(testKey('history:net-worth'), fields);
    const reversing = Object.assign(Object.create(fake), {
      hscan: async (key: string, cursor: string | number, opts?: { count?: number }) => {
        const [next, flat] = await fake.hscan(key, cursor, opts);
        const pairs: string[][] = [];
        for (let i = 0; i < flat.length; i += 2) pairs.push([flat[i], flat[i + 1]]);
        return [next, pairs.reverse().flat()];
      },
    });

    const archive = verifyArchive(await exportText());
    fake.reset();
    const result = await restoreArchive(reversing, archive, { overwrite: false });

    expect(result.written).toBe(1);
  });

  test('restores an archive whose hash fields are not in sorted order', async () => {
    // Exports taken before fields were sorted (the export as first merged)
    // carry them in whatever order Redis returned. The read-back is sorted, so
    // the comparison has to ignore order or such an archive could never pass.
    await fake.hset(testKey('h'), { a: '1' });
    const lines = linesOf(await exportText());
    lines[1] = JSON.stringify({ key: 'h', type: 'hash', ttl: null, value: { c: '3', a: '1', b: '2' } });
    const archive = verifyArchive(reseal(lines));
    fake.reset();

    const result = await restoreArchive(fake as any, archive, { overwrite: false });
    expect(result.written).toBe(1);
  });

  test('refuses to delete a populated target that was not backed up', async () => {
    await seed();
    const archive = verifyArchive(await exportText());
    await fake.set(testKey('budgets'), 'newer');

    await expect(restoreArchive(fake as any, archive, { overwrite: true })).rejects.toThrow(/no backup/);
    expect(await fake.get<string>(testKey('budgets'))).toBe('newer');
  });

  test('refuses when the target changed after the backup, and deletes nothing', async () => {
    await seed();
    const archive = verifyArchive(await exportText());
    const backedUp = await targetKeys(fake as any);
    await fake.set(testKey('txns:written_after_backup'), 'new');

    await expect(restoreArchive(fake as any, archive, { overwrite: true, backedUp })).rejects.toThrow(
      /changed after it was backed up/
    );
    expect(await fake.get<string>(testKey('txns:written_after_backup'))).toBe('new');
  });

  test('refuses when a target checked empty has filled up since', async () => {
    await seed();
    const archive = verifyArchive(await exportText());
    fake.reset();
    await fake.set(testKey('arrived_meanwhile'), 'x');

    await expect(restoreArchive(fake as any, archive, { overwrite: true, backedUp: [] })).rejects.toThrow(
      /changed after/
    );
    expect(await fake.get<string>(testKey('arrived_meanwhile'))).toBe('x');
  });

  test('a key about to expire is given long enough to be read back', async () => {
    await fake.set(testKey('short'), 'v', { ex: 600 });
    const lines = linesOf(await exportText());
    const rec = JSON.parse(lines[1]);
    lines[1] = JSON.stringify({ ...rec, ttl: 2 });
    const archive = verifyArchive(reseal(lines));
    fake.reset();

    await restoreArchive(fake as any, archive, { overwrite: false });
    expect(await fake.ttl(testKey('short'))).toBe(60);
  });

  test('an extra key appearing at read-back fails it', async () => {
    await seed();
    const archive = verifyArchive(await exportText());
    fake.reset();
    const leaking = Object.assign(Object.create(fake), {
      set: async (key: string, value: string, opts?: { ex: number }) => {
        await fake.set(key, value, opts);
        if (key === testKey('budgets')) await fake.set(testKey('zzz_unexpected'), 'x');
      },
    });

    await expect(restoreArchive(leaking, archive, { overwrite: false })).rejects.toThrow(/1 unexpected/);
  });

  test('a corrupted hash value fails the read-back', async () => {
    await seed();
    const archive = verifyArchive(await exportText());
    fake.reset();
    const corrupting = Object.assign(Object.create(fake), {
      hset: async (key: string, f: Record<string, string>) =>
        fake.hset(key, key === testKey('history:net-worth') ? { ...f, '2026-01-01': 'wrong' } : f),
    });

    await expect(restoreArchive(corrupting, archive, { overwrite: false })).rejects.toThrow(/does not match/);
  });

  test('splits a large hash across several writes, and keeps every field', async () => {
    const fields: Record<string, string> = {};
    for (let i = 0; i < 300; i++) fields[`f${i}`] = 'x'.repeat(4000); // ~1.2M chars
    await fake.hset(testKey('history:accounts'), fields);
    const archive = verifyArchive(await exportText());
    fake.reset();

    let hsets = 0;
    const counting = Object.assign(Object.create(fake), {
      hset: async (key: string, f: Record<string, string>) => {
        hsets++;
        return fake.hset(key, f);
      },
    });
    await restoreArchive(counting, archive, { overwrite: false });

    expect(hsets).toBeGreaterThan(1);
    expect(fake.hashes.get(testKey('history:accounts'))!.size).toBe(300);
  });

  test('keeps a __proto__ hash field', async () => {
    await fake.hset(testKey('h'), JSON.parse('{"__proto__":"v","a":"b"}'));
    const archive = verifyArchive(await exportText());
    fake.reset();

    await restoreArchive(fake as any, archive, { overwrite: false });
    expect(fake.hashes.get(testKey('h'))!.get('__proto__')).toBe('v');
  });

  test('a write that silently goes missing fails the read-back', async () => {
    await seed();
    const archive = verifyArchive(await exportText());
    fake.reset();
    const lossy = Object.assign(Object.create(fake), {
      set: async (key: string, value: string, opts?: { ex: number }) =>
        key === testKey('budgets') ? undefined : fake.set(key, value, opts),
    });

    await expect(restoreArchive(lossy, archive, { overwrite: false })).rejects.toThrow(/does not match/);
  });

  test('a write that lands a different value fails the read-back', async () => {
    await seed();
    const archive = verifyArchive(await exportText());
    fake.reset();
    const corrupting = Object.assign(Object.create(fake), {
      set: async (key: string, value: string, opts?: { ex: number }) =>
        fake.set(key, key === testKey('budgets') ? 'wrong' : value, opts),
    });

    await expect(restoreArchive(corrupting, archive, { overwrite: false })).rejects.toThrow(/does not match/);
  });
});

describe('the container registry', () => {
  const A = '0b6f5a52-3c1d-4e2f-8a9b-1c2d3e4f5a6b';
  const B = '1c7a6b63-4d2e-4f30-9bac-2d3e4f5a6b7c';
  const entry = JSON.stringify({ status: 'active', primary: true, created_at: 'x' });

  test("an archive whose keys name a container missing from its registry is refused", async () => {
    await seed();
    await fake.set(testKey(`c:${A}:goals`), 'cipher-goals');
    const unlisted = await exportText();
    expect(() => verifyArchive(unlisted)).toThrow(/does not list/);

    await fake.hset(testKey('containers'), { [A]: entry });
    const listed = await exportText();
    expect(verifyArchive(listed).records.map((r) => r.key)).toContain(`c:${A}:goals`);
  });

  test('checkRegistry: same containers, or none on the target, or asked to', () => {
    const set = (...ids: string[]) => new Set(ids);
    expect(() => checkRegistry(set(A), null, false)).not.toThrow(); // fresh target
    expect(() => checkRegistry(null, null, false)).not.toThrow();
    expect(() => checkRegistry(set(A), set(A), false)).not.toThrow();
    expect(() => checkRegistry(null, set(A), false)).toThrow(/predates containers/);
    expect(() => checkRegistry(set(B), set(A), false)).toThrow(/are not the target's/);
    expect(() => checkRegistry(set(A, B), set(A), false)).toThrow(/are not the target's/);
    expect(() => checkRegistry(null, set(A), true)).not.toThrow();
    expect(() => checkRegistry(set(B), set(A), true)).not.toThrow();
  });

  test('restoreArchive refuses to drop the target registry, and deletes nothing', async () => {
    await seed(); // an archive from before containers
    const archive = verifyArchive(await exportText());
    await fake.hset(testKey('containers'), { [A]: entry });
    const existing = await targetKeys(fake as any);
    const before = snapshot();

    await expect(restoreArchive(fake as any, archive, { overwrite: true, backedUp: existing })).rejects.toThrow(
      /predates containers/
    );
    expect(snapshot()).toEqual(before);

    await restoreArchive(fake as any, archive, { overwrite: true, backedUp: existing, replaceRegistry: true });
    expect(await fake.hgetall(testKey('containers'))).toBeNull();
  });

  test('an archive with the same registry restores as usual', async () => {
    await seed();
    await fake.hset(testKey('containers'), { [A]: entry });
    const archive = verifyArchive(await exportText());
    await fake.set(testKey('budgets'), 'newer');
    const existing = await targetKeys(fake as any);
    await restoreArchive(fake as any, archive, { overwrite: true, backedUp: existing });
    expect(await fake.get<string>(testKey('budgets'))).toBe('cipher-budgets');
  });
});

describe('checkTarget', () => {
  test('the named target must match the prefix this process writes to', () => {
    expect(checkTarget('test', false)).toBe('test');
    expect(() => checkTarget(undefined, false)).toThrow(/--target/);
    expect(() => checkTarget('restore-test', false)).toThrow(/REDIS_PREFIX resolves to "test"/);
  });
});

describe('the command', () => {
  let dir: string;
  const cwd = process.cwd();
  const logs: string[] = [];
  const origLog = console.log;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'nya-restore-'));
    process.chdir(dir);
    logs.length = 0;
    console.log = (...a: unknown[]) => logs.push(a.join(' '));
  });
  afterEach(async () => {
    console.log = origLog;
    process.chdir(cwd);
    await rm(dir, { recursive: true, force: true });
  });

  async function archiveFile(): Promise<string> {
    await seed();
    const path = join(dir, 'archive.ndjson');
    await writeFile(path, await exportText());
    return path;
  }

  test('an archive from before containers will not drop the target registry, even in a dry run', async () => {
    const file = await archiveFile(); // no registry in it
    const id = '0b6f5a52-3c1d-4e2f-8a9b-1c2d3e4f5a6b';
    await fake.hset(testKey('containers'), { [id]: JSON.stringify({ status: 'active', primary: true, created_at: 'x' }) });

    await expect(main([file, '--target', 'test', '--overwrite', '--dry-run'], fake as any)).rejects.toThrow(
      /--replace-registry/
    );
    await expect(main([file, '--target', 'test', '--overwrite'], fake as any)).rejects.toThrow(/--replace-registry/);
    expect(await fake.hgetall(testKey('containers'))).not.toBeNull();
    expect((await readdir(dir)).filter((f) => f.startsWith('nya-pre-restore-'))).toEqual([]); // refused before the backup

    await main([file, '--target', 'test', '--overwrite', '--replace-registry'], fake as any);
    expect(await fake.hgetall(testKey('containers'))).toBeNull();
    expect(await fake.get<string>(testKey('budgets'))).toBe('cipher-budgets');
  });

  test('parses its flags and rejects unknown ones', () => {
    expect(parseArgs(['a.ndjson', '--target', 'x', '--overwrite'])).toEqual({
      file: 'a.ndjson',
      target: 'x',
      overwrite: true,
      confirmProduction: false,
      dryRun: false,
      allowEmpty: false,
      allowDifferentSource: false,
      replaceRegistry: false,
    });
    expect(parseArgs(['a', '--target', 'x', '--allow-empty', '--allow-different-source'])).toMatchObject({
      allowEmpty: true,
      allowDifferentSource: true,
    });
    expect(() => parseArgs(['a.ndjson', '--force'])).toThrow(/Unknown flag/);
    expect(() => parseArgs([])).toThrow(/Usage/);
  });

  test('restores into an empty target', async () => {
    const file = await archiveFile();
    const before = snapshot();
    fake.reset();

    await main([file, '--target', 'test'], fake as any);

    expect(snapshot()).toEqual(before);
    expect(logs.at(-1)).toContain('Read-back matches');
  });

  test('a dry run writes nothing', async () => {
    const file = await archiveFile();
    fake.reset();

    await main([file, '--target', 'test', '--dry-run'], fake as any);
    expect(snapshot()).toEqual({ strings: [], hashes: [] });
  });

  test('exports a populated target to a file before replacing it', async () => {
    const file = await archiveFile();
    await fake.set(testKey('budgets'), 'newer');

    await main([file, '--target', 'test', '--overwrite'], fake as any);

    const saved = (await readdir(dir)).filter((f) => f.startsWith('nya-pre-restore-test-'));
    expect(saved).toHaveLength(1);
    const pre = verifyArchive(await Bun.file(join(dir, saved[0])).text());
    expect(pre.records.find((r) => r.key === 'budgets')!.value).toBe('newer');
    expect(await fake.get<string>(testKey('budgets'))).toBe('cipher-budgets');
  });

  test('a dry run over a populated target writes no backup and deletes nothing', async () => {
    const file = await archiveFile();
    await fake.set(testKey('budgets'), 'current');

    await main([file, '--target', 'test', '--overwrite', '--dry-run'], fake as any);

    expect((await readdir(dir)).filter((f) => f.startsWith('nya-pre-restore-'))).toEqual([]);
    expect(await fake.get<string>(testKey('budgets'))).toBe('current');
  });

  test('backs up a target holding a single key', async () => {
    const file = await archiveFile();
    fake.reset();
    await fake.set(testKey('only'), 'one');

    await main([file, '--target', 'test', '--overwrite'], fake as any);
    expect((await readdir(dir)).filter((f) => f.startsWith('nya-pre-restore-'))).toHaveLength(1);
  });

  test("a container's cache on the target does not stop an overwrite", async () => {
    const file = await archiveFile();
    // Left out of the backup, like every cache, so not "missing" from it.
    await fake.set(testKey('c:0b6f5a52-3c1d-4e2f-8a9b-1c2d3e4f5a6b:cache:net-worth'), 'stale');

    await main([file, '--target', 'test', '--overwrite'], fake as any);
    expect(await fake.get<string>(testKey('budgets'))).toBe('cipher-budgets');
    expect(await fake.get<string>(testKey('c:0b6f5a52-3c1d-4e2f-8a9b-1c2d3e4f5a6b:cache:net-worth'))).toBeNull();
  });

  test('a target that cannot be backed up is left alone, and says why', async () => {
    const file = await archiveFile();
    await fake.set(testKey('odd'), 'x');
    const withList = Object.assign(Object.create(fake), {
      type: async (key: string) => (key === testKey('odd') ? 'list' : fake.type(key)),
    });

    await expect(main([file, '--target', 'test', '--overwrite'], withList)).rejects.toThrow(
      /Could not back up the target/
    );
    expect(await fake.get<string>(testKey('odd'))).toBe('x');
    expect(await fake.get<string>(testKey('budgets'))).toBe('cipher-budgets');
  });

  test('a key that slips out of the backup stops the restore', async () => {
    const file = await archiveFile();
    await fake.set(testKey('slippery'), 'x');
    // Present when the target is scanned, gone by the time the backup reads it.
    const vanishing = Object.assign(Object.create(fake), {
      type: async (key: string) => (key === testKey('slippery') ? 'none' : fake.type(key)),
    });

    await expect(main([file, '--target', 'test', '--overwrite'], vanishing)).rejects.toThrow(
      /changed while it was being backed up/
    );
    expect(await fake.get<string>(testKey('slippery'))).toBe('x');
  });

  test('an empty archive will not empty a populated target without --allow-empty', async () => {
    const path = join(dir, 'empty.ndjson');
    await writeFile(path, await exportText()); // taken before seeding: no keys
    await seed();

    await expect(main([path, '--target', 'test', '--overwrite'], fake as any)).rejects.toThrow(/--allow-empty/);
    expect(await fake.get<string>(testKey('budgets'))).toBe('cipher-budgets');

    await main([path, '--target', 'test', '--overwrite', '--allow-empty'], fake as any);
    expect(await fake.get<string>(testKey('budgets'))).toBeNull();
  });

  test('an archive from another environment will not replace a populated target without saying so', async () => {
    await seed();
    const lines = linesOf(await exportText());
    lines[0] = JSON.stringify({ ...JSON.parse(lines[0]), env_prefix: 'dev' });
    const path = join(dir, 'from-dev.ndjson');
    await writeFile(path, reseal(lines));
    await fake.set(testKey('budgets'), 'current');

    await expect(main([path, '--target', 'test', '--overwrite'], fake as any)).rejects.toThrow(
      /--allow-different-source/
    );
    expect(await fake.get<string>(testKey('budgets'))).toBe('current');

    await main([path, '--target', 'test', '--overwrite', '--allow-different-source'], fake as any);
    expect(await fake.get<string>(testKey('budgets'))).toBe('cipher-budgets');
  });

  test('an archive from another environment restores into an EMPTY target with no extra flag', async () => {
    await seed();
    const lines = linesOf(await exportText());
    lines[0] = JSON.stringify({ ...JSON.parse(lines[0]), env_prefix: 'production' });
    const path = join(dir, 'from-prod.ndjson');
    await writeFile(path, reseal(lines));
    fake.reset();

    await main([path, '--target', 'test'], fake as any);
    expect(await fake.get<string>(testKey('budgets'))).toBe('cipher-budgets');
  });

  test('a wrong target writes nothing', async () => {
    const file = await archiveFile();
    fake.reset();

    await expect(main([file, '--target', 'production'], fake as any)).rejects.toThrow(RestoreRefused);
    expect(snapshot()).toEqual({ strings: [], hashes: [] });
  });

  test('a damaged archive writes nothing, even with overwrite', async () => {
    const file = await archiveFile();
    const text = await Bun.file(file).text();
    await writeFile(file, text.replace('cipher-budgets', 'tampered'));
    await fake.set(testKey('budgets'), 'current');

    await expect(main([file, '--target', 'test', '--overwrite'], fake as any)).rejects.toThrow(/Checksum/);
    expect(await fake.get<string>(testKey('budgets'))).toBe('current');
  });
});

// Production needs its own confirmation. k() is fixed to "test:" in this
// process, so this runs the real module in a child with REDIS_PREFIX set.
describe('production', () => {
  const run = (flags: string) =>
    Bun.spawnSync(
      [
        process.execPath,
        '-e',
        `const { checkTarget } = await import('./lib/restore.ts'); checkTarget('production', ${flags}); console.log('ok');`,
      ],
      { env: { ...process.env, REDIS_PREFIX: 'production' }, cwd: `${import.meta.dir}/..` }
    );

  test('is refused without --confirm-production', () => {
    const res = run('false');
    expect(res.exitCode).not.toBe(0);
    expect(res.stderr.toString()).toContain('--confirm-production');
  });

  test('is allowed with it', () => {
    const res = run('true');
    expect(res.exitCode).toBe(0);
    expect(res.stdout.toString()).toContain('ok');
  });
});
