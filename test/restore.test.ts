import { describe, expect, test, mock, beforeEach, afterEach } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FakeRedis, storageMock, testKey } from './fake-redis';

const fake = new FakeRedis();
mock.module('@/lib/storage', () => storageMock(fake));

const { exportLines } = await import('@/lib/export');
const { verifyArchive, restoreArchive, checkTarget, targetKeys, RestoreRefused } = await import(
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
    ['an empty hash', { key: 'h', type: 'hash', ttl: null, value: {} }, /empty hash/],
    ['an unknown type', { key: 'l', type: 'list', ttl: null, value: [] }, /unknown type/],
    ['a negative ttl', { key: 's', type: 'string', ttl: -1, value: 'x' }, /ttl/],
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

  test('overwrite replaces: strays and stale caches go, rate limits stay', async () => {
    await seed();
    const archive = verifyArchive(await exportText());
    await fake.set(testKey('txns:item_from_later'), 'stray');
    await fake.set(testKey('cache:net-worth'), 'stale');
    await fake.hset(testKey('history:net-worth'), { '2026-09-01': 'newer field' });
    await fake.set(testKey('ratelimit:login:1.2.3.4'), '2');
    await fake.set('production:budgets', 'another environment');

    await restoreArchive(fake as any, archive, { overwrite: true });

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
    await restoreArchive(fake as any, archive, { overwrite: true });

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
    await restoreArchive(fake as any, archive, { overwrite: true });

    expect(snapshot()).toEqual(before);
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

  test('parses its flags and rejects unknown ones', () => {
    expect(parseArgs(['a.ndjson', '--target', 'x', '--overwrite'])).toEqual({
      file: 'a.ndjson',
      target: 'x',
      overwrite: true,
      confirmProduction: false,
      dryRun: false,
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
