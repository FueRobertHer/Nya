import { describe, expect, test, mock, beforeEach, afterEach } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { FakeRedis, storageMock, testKey, ctxKey, TEST_CTX, TEST_CONTAINER, registerTestContainer } from './fake-redis';

// Moving the stored data into a container at the cutover (lib/move.ts).
const fake = new FakeRedis();
mock.module('@/lib/storage', () => storageMock(fake));

const { moveData, MoveRefused, isMoved, MOVED_KEYS, MOVED_PREFIXES, NOT_MOVED_PREFIXES, checkMoveTarget } = await import('@/lib/move');
const script = await import('../scripts/move-data');
const { forgetEpochs } = await import('@/lib/sessions');

const ctx = TEST_CTX;
const client = fake as any;
const run = () => moveData(client, ctx, { run: true });
const plan = () => moveData(client, ctx, { run: false });

const saved = { ...process.env };
beforeEach(() => {
  fake.reset();
  forgetEpochs();
});
afterEach(() => {
  process.env = { ...saved };
});

/** A realistic spread of old keys, including values a deserializing client
 *  would change ('1', JSON) and a hash longer than one scan page. */
async function seedOld() {
  await fake.set(testKey('budgets'), 'v1-ciphertext');
  await fake.set(testKey('history:backfill-done'), '1');
  await fake.set(testKey('history:accounts:est:flat'), '{"a":1}');
  const days: Record<string, string> = {};
  for (let i = 0; i < 450; i++) days[`2025-${String(i).padStart(4, '0')}`] = `v${i}`;
  await fake.hset(testKey('history:accounts'), days);
  await fake.hset(testKey('plaid:items'), { item_1: '{"item_id":"item_1"}' });
  await fake.set(testKey('txns:item_1'), 'blob-1');
  await fake.set(testKey('txns-blocked:item_1'), '{"at":"x","chars":9}');
  await fake.set(testKey('invtxns:item_1'), 'inv-blob-1');
}

describe('the first run', () => {
  test('copies every listed key into the container, byte for byte, and leaves the old keys alone', async () => {
    await seedOld();
    const report = await run();
    expect(report.copied).toBe(8);
    expect(report.conflicts).toEqual([]);

    expect(await fake.get<string>(ctxKey('budgets'))).toBe('v1-ciphertext');
    expect(await fake.get<string>(ctxKey('history:backfill-done'))).toBe('1');
    expect(await fake.get<string>(ctxKey('history:accounts:est:flat'))).toBe('{"a":1}');
    expect(Object.keys((await fake.hgetall<Record<string, string>>(ctxKey('history:accounts')))!)).toHaveLength(450);
    expect(await fake.hget<string>(ctxKey('history:accounts'), '2025-0449')).toBe('v449');
    expect(await fake.get<string>(ctxKey('txns:item_1'))).toBe('blob-1');
    expect(await fake.get<string>(ctxKey('txns-blocked:item_1'))).toBe('{"at":"x","chars":9}');
    expect(await fake.get<string>(ctxKey('invtxns:item_1'))).toBe('inv-blob-1');
    // The old keys are exactly as they were: rollback is redeploying.
    expect(await fake.get<string>(testKey('budgets'))).toBe('v1-ciphertext');
    expect(await fake.hget<string>(testKey('history:accounts'), '2025-0000')).toBe('v0');
    // No temporary key is left behind.
    expect(await fake.type(ctxKey('move:tmp'))).toBe('none');
  });

  test('without --run it only reports', async () => {
    await seedOld();
    const report = await plan();
    expect(report.copied).toBe(8);
    expect(await fake.get<string>(ctxKey('budgets'))).toBeNull();
    expect(await fake.type(ctxKey('move:copied'))).toBe('none');
  });

  test('copies nothing that is not on the list, and never a key already in a container', async () => {
    await fake.set(testKey('budgets'), 'b');
    await fake.set(testKey('cache:net-worth'), 'c');
    await fake.set(testKey('ratelimit:login:1.2.3.4'), '2');
    await fake.hset(testKey('crypto:keys'), { k1: 'w' });
    await fake.hset(testKey('containers'), { [TEST_CONTAINER]: '{}' });
    await fake.set(testKey('invtxns-lock:item_1'), 'tok');
    await fake.set(testKey('sessions:legacy-cutoff'), '1');
    await fake.set(testKey('something-new'), 'x');
    await fake.set(ctxKey('goals', { container: '11111111-2222-4333-8444-555555555555' }), 'other container');
    const report = await run();
    expect(report.entries.map((e) => e.key)).toEqual(['budgets']);
    const keys = [...(fake as any).strings.keys(), ...(fake as any).hashes.keys()] as string[];
    expect(keys.filter((k) => k.includes(`c:${TEST_CONTAINER}:c:`))).toEqual([]);
    expect(await fake.get<string>(ctxKey('cache:net-worth'))).toBeNull();
    expect(await fake.get<string>(ctxKey('invtxns-lock:item_1'))).toBeNull();
  });

  test('a hash left half built by a run that died is not mixed into the copy', async () => {
    await fake.hset(testKey('hidden:accounts'), { a: '1' });
    await fake.hset(ctxKey('move:tmp'), { stale: 'from a run that died' });
    await run();
    expect(await fake.hgetall<Record<string, string>>(ctxKey('hidden:accounts'))).toEqual({ a: '1' });
  });

  test('a copy that does not read back as written stops the run, unrecorded', async () => {
    await fake.set(testKey('budgets'), 'real');
    const set = fake.set.bind(fake);
    fake.set = (async (key: string, value: string, opts?: any) => set(key, key === ctxKey('budgets') ? 'mangled' : value, opts)) as typeof fake.set;
    try {
      await expect(run()).rejects.toThrow('did not read back');
    } finally {
      fake.set = set;
    }
    expect(await fake.hget<string>(ctxKey('move:copied'), 'budgets')).toBeNull();
  });

  test('carries an expiry, if a key has one', async () => {
    await fake.set(testKey('history:backfill-pending'), '2', { ex: 600 });
    await run();
    expect(await fake.ttl(ctxKey('history:backfill-pending'))).toBe(600);
  });
});

describe('running it again', () => {
  test('finds everything up to date and writes nothing', async () => {
    await seedOld();
    await run();
    fake.ops = 0;
    const report = await run();
    expect(report.up_to_date).toBe(8);
    expect(report.copied + report.refreshed).toBe(0);
  });

  test('refreshes a key whose old value changed since, when nothing has written the copy', async () => {
    await seedOld();
    await run();
    await fake.set(testKey('budgets'), 'changed-before-deploy');
    await fake.hset(testKey('history:accounts'), { '2026-01-01': 'new day' });
    const report = await run();
    expect(report.refreshed).toBe(2);
    expect(await fake.get<string>(ctxKey('budgets'))).toBe('changed-before-deploy');
    expect(await fake.hget<string>(ctxKey('history:accounts'), '2026-01-01')).toBe('new day');
  });

  test('a hash field deleted from the old key is deleted from the copy', async () => {
    await fake.hset(testKey('hidden:accounts'), { a: '1', b: '2' });
    await run();
    await fake.hdel(testKey('hidden:accounts'), 'b');
    await run();
    expect(await fake.hgetall<Record<string, string>>(ctxKey('hidden:accounts'))).toEqual({ a: '1' });
  });

  test('refuses, writing nothing, once the new release has written a key', async () => {
    await seedOld();
    await run();
    await fake.set(ctxKey('budgets'), 'written by the new release');
    await fake.set(testKey('goals'), 'a new old key');
    await fake.set(testKey('txns:item_1'), 'changed');

    const dry = await plan();
    expect(dry.conflicts).toEqual([{ key: 'budgets', action: 'conflict', reason: 'the container key was written after it was copied' }]);

    await expect(run()).rejects.toThrow(MoveRefused);
    expect(await fake.get<string>(ctxKey('budgets'))).toBe('written by the new release');
    expect(await fake.get<string>(ctxKey('goals'))).toBeNull();
    expect(await fake.get<string>(ctxKey('txns:item_1'))).toBe('blob-1');
  });

  test('a container key it never copied is a conflict too', async () => {
    await fake.set(testKey('goals'), 'old');
    await fake.set(ctxKey('goals'), 'already there');
    const dry = await plan();
    expect(dry.conflicts[0]).toMatchObject({ key: 'goals', reason: 'the container already holds this key, and this tool did not write it' });
    await expect(run()).rejects.toThrow(MoveRefused);
    expect(await fake.get<string>(ctxKey('goals'))).toBe('already there');
  });

  test('an identical container key it never copied is simply up to date', async () => {
    await fake.set(testKey('goals'), 'same');
    await fake.set(ctxKey('goals'), 'same');
    expect((await run()).up_to_date).toBe(1);
  });
});

describe('the lists', () => {
  // Every key the code builds inside a container, read from the source: each
  // must be moved or deliberately not. A new key cannot be forgotten.
  const libDir = join(import.meta.dir, '..', 'lib');
  const built = new Set<string>();
  for (const f of readdirSync(libDir).filter((f) => f.endsWith('.ts'))) {
    const src = readFileSync(join(libDir, f), 'utf8');
    for (const m of src.matchAll(/\bkc\(\s*\w+\s*,\s*(['`])([^'`$]*)(\$\{)?/g)) built.add(m[2]);
  }

  test('cover every key the code builds inside a container', () => {
    expect(built.size).toBeGreaterThan(20);
    const uncovered = [...built].filter((key) => !isMoved(key) && !(MOVED_PREFIXES as readonly string[]).includes(key) && !NOT_MOVED_PREFIXES.some((p) => key.startsWith(p)));
    expect(uncovered).toEqual([]);
  });

  test('name nothing the code no longer builds', () => {
    const stale = (MOVED_KEYS as readonly string[]).filter((key) => !built.has(key));
    expect(stale).toEqual([]);
    for (const p of MOVED_PREFIXES) expect(built.has(p)).toBe(true);
  });

  test('a per-Item prefix alone is not a key', () => {
    expect(isMoved('txns:')).toBe(false);
    expect(isMoved('txns:item_1')).toBe(true);
    expect(isMoved('invtxns-lock:item_1')).toBe(false);
  });
});

describe('the command', () => {
  test('names the environment twice, and production once more', () => {
    expect(() => checkMoveTarget(undefined, false)).toThrow('Name the environment');
    expect(() => checkMoveTarget('production', false)).toThrow('REDIS_PREFIX resolves to "test"');
    expect(checkMoveTarget('test', false)).toBe('test');
    expect(() => checkMoveTarget('production', false, 'production')).toThrow('--confirm-production');
    expect(checkMoveTarget('production', true, 'production')).toBe('production');
  });

  test('refuses without a container, and moves into this deployment\'s', async () => {
    await fake.set(testKey('budgets'), 'b');
    await expect(script.main(['--target', 'test', '--run'], client)).rejects.toThrow('No container exists yet');

    await registerTestContainer(fake);
    forgetEpochs();
    const log = console.log;
    const lines: string[] = [];
    console.log = (...a: unknown[]) => lines.push(a.join(' '));
    try {
      await script.main(['--target', 'test'], client);
      expect(await fake.get<string>(ctxKey('budgets'))).toBeNull(); // report only
      await script.main(['--target', 'test', '--run'], client);
    } finally {
      console.log = log;
    }
    expect(await fake.get<string>(ctxKey('budgets'))).toBe('b');
    expect(lines.join('\n')).toContain('Copied and read back');
  });

  test('rejects an unknown flag', () => {
    expect(() => script.parseArgs(['--force'])).toThrow('Unknown argument');
  });
});
