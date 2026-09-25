import { describe, expect, test, mock, beforeEach, afterEach, afterAll } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { FakeRedis, storageMock, testKey, ctxKey, TEST_CTX, TEST_CONTAINER, registerTestContainer } from './fake-redis';

// Moving the stored data into a container at the cutover (lib/move.ts).
const fake = new FakeRedis();
mock.module('@/lib/storage', () => storageMock(fake));

const { moveData, retireMove, digest, MoveRefused, isMoved, MOVED_KEYS, MOVED_PREFIXES, NOT_MOVED_PREFIXES, checkMoveTarget, MOVE_SET, MOVE_SWAP, MOVE_DELETE, MOVE_PROBE, MOVE_RESOLVE, resolveConflict } = await import('@/lib/move');
const script = await import('../scripts/move-data');
const { forgetEpochs } = await import('@/lib/sessions');

const ctx = TEST_CTX;
const client = fake as any;
// Deletions are carried across here unless a test says otherwise; the flag,
// and the checks for a wrong or retired environment, have their own tests.
const run = (o: object = {}) => moveData(client, ctx, { run: true, propagateDeletes: true, ...o });
const plan = (o: object = {}) => moveData(client, ctx, { run: false, propagateDeletes: true, ...o });
/** Every environment in use has its Plaid items; an old key the checks for a
 *  wrong or retired environment look for. Left out of the counts below. */
const ANCHOR = testKey('plaid:items');

const saved = { ...process.env };
beforeEach(async () => {
  fake.reset();
  forgetEpochs();
  await fake.hset(ANCHOR, { anchor: '{}' });
});
const others = <T extends { key: string }>(entries: T[]) => entries.filter((e) => e.key !== 'plaid:items');
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
    const left = [...(fake as any).strings.keys(), ...(fake as any).hashes.keys()].filter((k: string) => k.includes(':move:tmp') || k.includes(':move:lock') || k.includes(':move:pending'));
    expect(left).toEqual([]);
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
    expect(others(report.entries).map((e) => e.key)).toEqual(['budgets']);
    const keys = [...(fake as any).strings.keys(), ...(fake as any).hashes.keys()] as string[];
    expect(keys.filter((k) => k.includes(`c:${TEST_CONTAINER}:c:`))).toEqual([]);
    expect(await fake.get<string>(ctxKey('cache:net-worth'))).toBeNull();
    expect(await fake.get<string>(ctxKey('invtxns-lock:item_1'))).toBeNull();
  });

  test('a hash left half built by a run that died is not mixed into the copy', async () => {
    await fake.hset(testKey('hidden:accounts'), { a: '1' });
    await fake.hset(ctxKey('move:tmp:0000-dead-run:hidden:accounts'), { stale: 'from a run that died' });
    await run();
    expect(await fake.hgetall<Record<string, string>>(ctxKey('hidden:accounts'))).toEqual({ a: '1' });
  });

  test('builds a hash under a name of its own run, which no other run touches', async () => {
    await fake.hset(testKey('hidden:accounts'), { a: '1' });
    const hset = fake.hset.bind(fake);
    const built: string[] = [];
    fake.hset = (async (key: string, value: Record<string, string>) => {
      if (key.includes(':move:tmp:')) built.push(key.replace(`:${await fake.get<string>(ctxKey('move:lock'))}:`, ':<this run>:'));
      return hset(key, value);
    }) as typeof fake.hset;
    try {
      await run();
    } finally {
      fake.hset = hset;
    }
    expect(built.sort()).toEqual([ctxKey('move:tmp:<this run>:hidden:accounts'), ctxKey('move:tmp:<this run>:plaid:items')]);
  });

  test('a write the new release makes during the run is never written over', async () => {
    await fake.set(testKey('budgets'), 'v1');
    await run();
    await fake.set(testKey('budgets'), 'v2'); // a refresh is planned
    // The new release writes the container key between the check and the write.
    const evalOrig = fake.eval.bind(fake);
    fake.eval = (async (script: string, keys: string[], args: string[]) => {
      if (script.startsWith('-- nya:move-set')) await fake.set(ctxKey('budgets'), 'NEW-RELEASE');
      return evalOrig(script, keys, args);
    }) as typeof fake.eval;
    try {
      await expect(run()).rejects.toThrow('changed in the container while this run was going');
    } finally {
      fake.eval = evalOrig;
    }
    expect(await fake.get<string>(ctxKey('budgets'))).toBe('NEW-RELEASE');
    // The next run sees it for what it is: changed on both sides.
    expect((await plan()).conflicts.map((c) => c.key)).toEqual(['budgets']);
  });

  test('a key that changes between the plan and its write stops the run', async () => {
    await fake.set(testKey('budgets'), 'v1');
    await fake.set(testKey('goals'), 'g1');
    await run();
    await fake.set(testKey('budgets'), 'v2');
    await fake.set(testKey('goals'), 'g2');
    // After the plan, before the writes: the new release writes goals.
    const hget = fake.hget.bind(fake);
    let calls = 0;
    fake.hget = (async (key: string, field: string) => {
      if (key === ctxKey('move:copied') && field === 'budgets' && ++calls === 2) await fake.set(ctxKey('goals'), 'NEW-RELEASE');
      return hget(key, field);
    }) as typeof fake.hget;
    try {
      await expect(run()).rejects.toThrow('changed while this run was going');
    } finally {
      fake.hget = hget;
    }
    expect(await fake.get<string>(ctxKey('goals'))).toBe('NEW-RELEASE');
  });

  test('carries an expiry, if a key has one', async () => {
    await fake.set(testKey('history:backfill-pending'), '2', { ex: 600 });
    await run();
    expect(await fake.ttl(ctxKey('history:backfill-pending'))).toBe(600);
    await fake.hset(testKey('accounts:vanished'), { item_1: 'x' });
    await fake.expire(testKey('accounts:vanished'), 900);
    await run();
    expect(await fake.ttl(ctxKey('accounts:vanished'))).toBe(900);
  });
});

describe('running it again', () => {
  test('finds everything up to date and changes nothing', async () => {
    await seedOld();
    await run();
    const before = await fake.hgetall<Record<string, string>>(ctxKey('move:copied'));
    const report = await run();
    expect(report.up_to_date).toBe(8);
    expect(report.copied + report.refreshed + report.deleted + report.kept).toBe(0);
    expect(await fake.hgetall<Record<string, string>>(ctxKey('move:copied'))).toEqual(before);
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

  test('a key the old release deleted since is deleted from the container too', async () => {
    await fake.hset(testKey('manual:accounts'), { m1: 'x' });
    await fake.set(testKey('history:backfill-done'), '1');
    await run();
    await fake.hdel(testKey('manual:accounts'), 'm1'); // the last one: the hash is gone
    await fake.del(testKey('history:backfill-done'));
    const report = await run();
    expect(report.deleted).toBe(2);
    expect(await fake.type(ctxKey('manual:accounts'))).toBe('none');
    expect(await fake.get<string>(ctxKey('history:backfill-done'))).toBeNull();
    expect(await fake.hkeys(ctxKey('move:copied'))).toEqual(['plaid:items']);
  });

  test('deletions are carried across only when asked, and never many at once', async () => {
    const keys = ['goals', 'budgets', 'txn-vendor-renames', 'history:backfill-done', 'history:backfill-pending', 'hidden:accounts'];
    for (const k of keys) await fake.set(testKey(k), 'x');
    await run();
    await fake.del(testKey('goals'));
    await expect(run({ propagateDeletes: false })).rejects.toThrow('--propagate-deletes');
    expect(await fake.get<string>(ctxKey('goals'))).toBe('x');
    for (const k of keys) await fake.del(testKey(k));
    await expect(run()).rejects.toThrow('looks like the old keys being retired');
    for (const k of keys.slice(1)) expect(await fake.get<string>(ctxKey(k))).toBe('x');
  });

  test('an old key gone before it was read, with the container holding its own, is left alone', async () => {
    await fake.set(testKey('goals'), 'old');
    await fake.set(ctxKey('goals'), 'written by the new release');
    const scan = fake.scan.bind(fake);
    fake.scan = (async (cursor: any, opts: any) => {
      const page = await scan(cursor, opts);
      await fake.del(testKey('goals')); // deleted between the scan and the read
      return page;
    }) as typeof fake.scan;
    try {
      const report = await run();
      expect(others(report.entries)).toEqual([{ key: 'goals', action: 'kept', reason: 'only in the container: the new release wrote it' }]);
    } finally {
      fake.scan = scan;
    }
    expect(await fake.get<string>(ctxKey('goals'))).toBe('written by the new release');
  });

  test('a key deleted on both sides is simply forgotten', async () => {
    await fake.set(testKey('goals'), 'g');
    await run();
    await fake.del(testKey('goals'), ctxKey('goals'));
    const report = await run();
    expect(others(report.entries)).toEqual([{ key: 'goals', action: 'up-to-date' }]);
    expect(await fake.get<string>(ctxKey('goals'))).toBeNull();
    expect(await fake.hkeys(ctxKey('move:copied'))).toEqual(['plaid:items']);
  });

  test('a key the new release wrote is kept, and the rest still copied', async () => {
    await seedOld();
    await run();
    await fake.set(ctxKey('budgets'), 'written by the new release');
    await fake.set(testKey('goals'), 'a new old key');
    const report = await run();
    expect(report.kept).toBe(1);
    expect(await fake.get<string>(ctxKey('budgets'))).toBe('written by the new release');
    expect(await fake.get<string>(ctxKey('goals'))).toBe('a new old key');
  });

  test('a key the new release deleted is not brought back', async () => {
    await fake.hset(testKey('hidden:accounts'), { a: '1' });
    await fake.set(testKey('history:backfill-done'), '1');
    await run();
    await fake.del(ctxKey('hidden:accounts'), ctxKey('history:backfill-done')); // unhidden; recompute asked for
    const report = await run();
    expect(report.kept).toBe(2);
    expect(await fake.type(ctxKey('hidden:accounts'))).toBe('none');
    expect(await fake.get<string>(ctxKey('history:backfill-done'))).toBeNull();
  });

  test('a key changed on both sides refuses the run, writing nothing', async () => {
    await seedOld();
    await run();
    await fake.set(ctxKey('budgets'), 'written by the new release');
    await fake.set(testKey('budgets'), 'written by the old release');
    await fake.set(testKey('goals'), 'a new old key');
    await fake.set(testKey('txns:item_1'), 'changed');

    const dry = await plan();
    expect(dry.conflicts).toEqual([{ key: 'budgets', action: 'conflict', reason: 'changed in both places since it was copied' }]);

    await expect(run()).rejects.toThrow(MoveRefused);
    expect(await fake.get<string>(ctxKey('budgets'))).toBe('written by the new release');
    expect(await fake.get<string>(ctxKey('goals'))).toBeNull();
    expect(await fake.get<string>(ctxKey('txns:item_1'))).toBe('blob-1');
  });

  test('deleted on one side and changed on the other is a conflict', async () => {
    await fake.set(testKey('goals'), 'g');
    await fake.set(testKey('budgets'), 'b');
    await run();
    await fake.del(testKey('goals'));
    await fake.set(ctxKey('goals'), 'edited in the container');
    await fake.set(testKey('budgets'), 'edited in the old');
    await fake.del(ctxKey('budgets'));
    const dry = await plan();
    expect(dry.conflicts.map((c) => c.key).sort()).toEqual(['budgets', 'goals']);
  });

  test('a container key it never copied is a conflict, unless identical', async () => {
    await fake.set(testKey('goals'), 'old');
    await fake.set(ctxKey('goals'), 'already there');
    await fake.set(testKey('budgets'), 'same');
    await fake.set(ctxKey('budgets'), 'same');
    const dry = await plan();
    expect(dry.conflicts).toEqual([{ key: 'goals', action: 'conflict', reason: 'the container already holds this key, and this tool did not write it' }]);
    expect(dry.up_to_date).toBe(1);
    await expect(run()).rejects.toThrow(MoveRefused);
    expect(await fake.get<string>(ctxKey('goals'))).toBe('already there');
  });

  test('a run that dies leaves each key copied and recorded, or untouched', async () => {
    await fake.set(testKey('budgets'), 'v1');
    await fake.set(testKey('goals'), 'g1');
    await run();
    await fake.set(testKey('budgets'), 'v2');
    await fake.set(testKey('goals'), 'g2');
    // The first key's write fails; the lock release after it too.
    const evalOrig = fake.eval.bind(fake);
    fake.eval = (async (script: string, keys: string[], args: string[]) => {
      if (script.startsWith('-- nya:move-set')) fake.failNext('eval', 2);
      return evalOrig(script, keys, args);
    }) as typeof fake.eval;
    try {
      await expect(run()).rejects.toThrow();
    } finally {
      fake.eval = evalOrig;
    }
    // Neither half-done: budgets untouched and still recorded as v1.
    expect(await fake.get<string>(ctxKey('budgets'))).toBe('v1');
    await fake.set(testKey('budgets'), 'v3'); // the old release keeps writing
    await fake.del(ctxKey('move:lock')); // what the expiry would do
    const report = await run();
    expect(report.conflicts).toEqual([]);
    expect(await fake.get<string>(ctxKey('budgets'))).toBe('v3');
    expect(await fake.get<string>(ctxKey('goals'))).toBe('g2');
  });

  test('a run that outlives its lock stops before its next write', async () => {
    await fake.set(testKey('budgets'), 'b');
    await fake.set(testKey('goals'), 'g');
    const evalOrig = fake.eval.bind(fake);
    fake.eval = (async (script: string, keys: string[], args: string[]) => {
      // The lock expired and another run took it.
      if (script.startsWith('-- nya:move-set')) await fake.set(ctxKey('move:lock'), 'another run');
      return evalOrig(script, keys, args);
    }) as typeof fake.eval;
    try {
      await expect(run()).rejects.toThrow('no longer holds its lock');
    } finally {
      fake.eval = evalOrig;
    }
    expect(await fake.get<string>(ctxKey('budgets'))).toBeNull();
    expect(await fake.get<string>(ctxKey('goals'))).toBeNull();
    expect(await fake.get<string>(ctxKey('move:lock'))).toBe('another run'); // not released by the loser
    await fake.del(ctxKey('move:lock'));
  });

  test('a write sent twice (a retry after a lost answer) is done once, without a false refusal', async () => {
    await fake.set(testKey('budgets'), 'b');
    await fake.hset(testKey('hidden:accounts'), { a: '1', b: '2' });
    const evalOrig = fake.eval.bind(fake);
    fake.eval = (async (script: string, keys: string[], args: string[]) => {
      if (/^-- nya:move-(set|swap|delete)/.test(script)) await evalOrig(script, keys, args);
      return evalOrig(script, keys, args);
    }) as typeof fake.eval;
    try {
      await run();
    } finally {
      fake.eval = evalOrig;
    }
    expect(await fake.get<string>(ctxKey('budgets'))).toBe('b');
    expect(await fake.hgetall<Record<string, string>>(ctxKey('hidden:accounts'))).toEqual({ a: '1', b: '2' });
    const again = await plan();
    expect(again.copied).toBe(0);
    expect(again.conflicts).toEqual([]);
  });

  test('the probe checks a string as well as a hash', async () => {
    await fake.set(testKey('budgets'), 'b');
    const evalOrig = fake.eval.bind(fake);
    const probed: string[] = [];
    fake.eval = (async (script: string, keys: string[], args: string[]) => {
      if (script.startsWith('-- nya:move-probe')) {
        probed.push(keys[0]);
        if (keys[0] === testKey('budgets')) return 'something else';
      }
      return evalOrig(script, keys, args);
    }) as typeof fake.eval;
    try {
      await expect(run()).rejects.toThrow('digests budgets differently');
    } finally {
      fake.eval = evalOrig;
    }
    expect(probed).toEqual([testKey('plaid:items'), testKey('budgets')]);
    expect(await fake.get<string>(ctxKey('budgets'))).toBeNull();
  });

  test('a hash being built always expires, and the copy keeps the old key\'s expiry or none', async () => {
    await fake.hset(testKey('hidden:accounts'), { a: '1' });
    const expire = fake.expire.bind(fake);
    const seen: number[] = [];
    fake.expire = (async (key: string, seconds: number) => {
      if (key.includes(':move:tmp:')) seen.push(seconds);
      return expire(key, seconds);
    }) as typeof fake.expire;
    try {
      await run();
    } finally {
      fake.expire = expire;
    }
    expect(seen.every((n) => n === 3600)).toBe(true);
    expect(seen.length).toBeGreaterThan(0);
    expect(await fake.ttl(ctxKey('hidden:accounts'))).toBe(-1);
  });

  test('a database that digests differently, or cannot run the script, is refused before any read', async () => {
    await fake.set(testKey('budgets'), 'b');
    const evalOrig = fake.eval.bind(fake);
    fake.eval = (async (script: string, keys: string[], args: string[]) => {
      if (script.startsWith('-- nya:move-probe')) return 'something else';
      return evalOrig(script, keys, args);
    }) as typeof fake.eval;
    try {
      await expect(plan()).rejects.toThrow('digests plaid:items differently');
      await expect(run()).rejects.toThrow('digests plaid:items differently');
    } finally {
      fake.eval = evalOrig;
    }
    fake.failNext('eval'); // the probe
    await expect(run()).rejects.toThrow('could not run the move');
    expect(await fake.get<string>(ctxKey('budgets'))).toBeNull();
    expect(await fake.get<string>(ctxKey('move:lock'))).toBeNull();
  });

  test('one run at a time', async () => {
    await fake.set(testKey('budgets'), 'b');
    await fake.set(ctxKey('move:lock'), 'another run', { nx: true, ex: 3600 });
    await expect(run()).rejects.toThrow('Another run is in progress');
    expect(await fake.get<string>(ctxKey('budgets'))).toBeNull();
    expect(await fake.get<string>(ctxKey('move:lock'))).toBe('another run');
    await fake.del(ctxKey('move:lock'));
    await run();
    expect(await fake.get<string>(ctxKey('move:lock'))).toBeNull(); // released
  });
});

describe('an environment that looks wrong', () => {
  test('with none of the keys every environment has, a run is refused and a report warns', async () => {
    await fake.del(ANCHOR);
    await fake.set(testKey('budgets'), 'b');
    await expect(moveData(client, ctx, { run: true })).rejects.toThrow('allow-empty');
    expect(await fake.get<string>(ctxKey('budgets'))).toBeNull();
    const warn = console.warn;
    const lines: string[] = [];
    console.warn = (...a: unknown[]) => lines.push(a.join(' '));
    try {
      await moveData(client, ctx, { run: false });
    } finally {
      console.warn = warn;
    }
    expect(lines.join(' ')).toContain('allow-empty');
    // With the usual keys there, no complaint.
    await fake.hset(ANCHOR, { i: '{}' });
    await moveData(client, ctx, { run: true });
    expect(await fake.get<string>(ctxKey('budgets'))).toBe('b');
  });

  test('retiring waits for a run in progress', async () => {
    await fake.set(testKey('budgets'), 'b');
    await run();
    await fake.set(ctxKey('move:lock'), 'a run', { nx: true, ex: 3600 });
    await expect(retireMove(client, ctx)).rejects.toThrow('Another run is in progress');
    expect(await fake.get<string>(ctxKey('move:retired'))).toBeNull();
    await fake.del(ctxKey('move:lock'));
    await retireMove(client, ctx);
    expect(await fake.get<string>(ctxKey('move:lock'))).toBeNull();
  });

  test('once the old keys are gone, a run is refused rather than deleting the copies', async () => {
    await fake.set(testKey('budgets'), 'b');
    await fake.set(testKey('txns:item_1'), 'history no bank will serve again');
    await run();
    // The old keys are deleted, weeks later.
    await fake.del(ANCHOR, testKey('budgets'), testKey('txns:item_1'));
    await expect(run()).rejects.toThrow('the old keys look deleted');
    await expect(run({ allowEmpty: true })).rejects.toThrow('the old keys look deleted');
    expect(await fake.get<string>(ctxKey('budgets'))).toBe('b');
    expect(await fake.get<string>(ctxKey('txns:item_1'))).toBe('history no bank will serve again');
  });

  test('retiring the move, once there is nothing left to do, stops every later run', async () => {
    await fake.set(testKey('budgets'), 'b');
    await expect(retireMove(client, ctx)).rejects.toThrow('Not retired');
    await run();
    await retireMove(client, ctx, new Date('2026-11-01T00:00:00Z'));
    await expect(run()).rejects.toThrow('retired from the move on 2026-11-01');
    await expect(plan()).rejects.toThrow('retired');
    expect(await fake.get<string>(ctxKey('budgets'))).toBe('b');
  });
});

describe('settling a conflict by hand', () => {
  const HIST = 'history:net-worth';
  test('merged into the container and settled, the key is kept, and runs go on', async () => {
    await fake.hset(testKey(HIST), { A: '1', B: '2' });
    await fake.set(testKey('budgets'), 'b1');
    await run();
    await fake.hset(testKey(HIST), { X: 'old side' });
    await fake.hset(ctxKey(HIST), { Y: 'new side' });
    await fake.set(testKey('budgets'), 'b2'); // held back while the conflict stands
    await expect(run()).rejects.toThrow(MoveRefused);
    // Merged by hand into the container: still a conflict until settled.
    await fake.hset(ctxKey(HIST), { X: 'old side' });
    expect((await plan()).conflicts.map((c) => c.key)).toEqual([HIST]);
    const e = await resolveConflict(client, ctx, HIST);
    expect(e.action).toBe('kept');
    const report = await run();
    expect(report.conflicts).toEqual([]);
    expect(await fake.get<string>(ctxKey('budgets'))).toBe('b2');
    expect(await fake.hgetall<Record<string, string>>(ctxKey(HIST))).toEqual({ A: '1', B: '2', X: 'old side', Y: 'new side' });
    // A later write to the old key is a conflict again, never copied over.
    await fake.hset(testKey(HIST), { Z: 'later' });
    expect((await plan()).conflicts.map((c) => c.key)).toEqual([HIST]);
    expect(await fake.get<string>(ctxKey('move:lock'))).toBeNull();
  });

  test('an old key deleted while the container changed is settled too', async () => {
    await fake.set(testKey('goals'), 'g1');
    await run();
    await fake.del(testKey('goals'));
    await fake.set(ctxKey('goals'), 'g-new');
    expect((await plan()).conflicts.map((c) => c.key)).toEqual(['goals']);
    expect((await resolveConflict(client, ctx, 'goals')).action).toBe('kept');
    expect(await fake.hget<string>(ctxKey('move:copied'), 'goals')).toBeNull();
    await run();
    expect(await fake.get<string>(ctxKey('goals'))).toBe('g-new');
  });

  test('refuses a key not in conflict, one not moved, and a change made meanwhile', async () => {
    await fake.set(testKey('budgets'), 'b1');
    await run();
    await expect(resolveConflict(client, ctx, 'budgets')).rejects.toThrow('not in conflict (up-to-date)');
    await expect(resolveConflict(client, ctx, 'cache:net-worth')).rejects.toThrow('not a key the move copies');
    await fake.set(testKey('budgets'), 'b2');
    await fake.set(ctxKey('budgets'), 'c2');
    const evalOrig = fake.eval.bind(fake);
    fake.eval = (async (script: string, keys: string[], args: string[]) => {
      if (script.startsWith('-- nya:move-resolve')) await fake.set(testKey('budgets'), 'b3');
      return evalOrig(script, keys, args);
    }) as typeof fake.eval;
    try {
      await expect(resolveConflict(client, ctx, 'budgets')).rejects.toThrow('changed');
    } finally {
      fake.eval = evalOrig;
    }
    expect(await fake.hget<string>(ctxKey('move:copied'), 'budgets')).toBe(digest({ kind: 'string', value: 'b1' }));
  });

  test('the command settles one key and goes alone', async () => {
    await registerTestContainer(fake);
    forgetEpochs();
    await fake.set(testKey('goals'), 'g1');
    await run();
    await fake.set(testKey('goals'), 'g2');
    await fake.set(ctxKey('goals'), 'c2');
    await expect(script.main(['--target', 'test', '--resolve', 'goals', '--run'], client)).rejects.toThrow('each go alone');
    const log = console.log;
    console.log = () => {};
    try {
      await script.main(['--target', 'test', '--resolve', 'goals'], client);
    } finally {
      console.log = log;
    }
    expect((await plan()).conflicts).toEqual([]);
    expect(() => script.parseArgs(['--resolve'])).toThrow('needs the key name');
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
    await expect(script.main(['--target', 'test', '--run', '--allow-empty'], client)).rejects.toThrow('No container exists yet');

    await registerTestContainer(fake);
    forgetEpochs();
    const log = console.log;
    const lines: string[] = [];
    console.log = (...a: unknown[]) => lines.push(a.join(' '));
    try {
      await script.main(['--target', 'test', '--allow-empty'], client);
      expect(await fake.get<string>(ctxKey('budgets'))).toBeNull(); // report only
      await script.main(['--target', 'test', '--run', '--allow-empty'], client);
    } finally {
      console.log = log;
    }
    expect(await fake.get<string>(ctxKey('budgets'))).toBe('b');
    expect(lines.join('\n')).toContain('Copied. The old keys are untouched.');
  });

  test('rejects an unknown flag', () => {
    expect(() => script.parseArgs(['--force'])).toThrow('Unknown argument');
  });
});

const hasRedis = Bun.which('redis-server') !== null;
describe.skipIf(!hasRedis && !process.env.CI)('the compare-and-set scripts, on a real Redis', () => {
  const port = 30000 + Math.floor(Math.random() * 20000);
  let server: ReturnType<typeof Bun.spawn> | null = null;
  let r: InstanceType<typeof Bun.RedisClient>;
  const evalScript = (script: string, keys: string[], args: string[]) => r.send('EVAL', [script, String(keys.length), ...keys, ...args]);

  beforeEach(async () => {
    if (!server) {
      server = Bun.spawn(['redis-server', '--port', String(port), '--save', '', '--appendonly', 'no'], { stdout: 'ignore', stderr: 'ignore' });
      r = new Bun.RedisClient(`redis://127.0.0.1:${port}`);
      for (let i = 0; i < 50; i++) {
        try {
          await r.send('PING', []);
          break;
        } catch {
          await Bun.sleep(50);
        }
      }
    }
    await r.send('FLUSHALL', []);
    await r.send('SET', ['lock', 'tok']);
  });
  afterAll(() => {
    server?.kill();
    server = null;
  });
  // Field names and values of the kinds stored: dates, ids, ciphertext, and
  // non-ASCII text, in an order Redis will not keep.
  const fields: [string, string][] = [
    ['2026-09-25', 'v2.k1.c.QUJD'],
    ['acct_é', 'naïve café ✓'],
    ['2025-01-01', '{"a":1}'],
    ['Z', ''],
  ];

  test('Redis digests a string and a hash exactly as the copier does', async () => {
    await r.send('SET', ['s', 'v2.k1.c.dGV4dA== ✓']);
    await r.send('HSET', ['h', ...fields.flat()]);
    const s = digest({ kind: 'string', value: 'v2.k1.c.dGV4dA== ✓' })!;
    const h = digest({ kind: 'hash', fields: [...fields].reverse() })!;
    expect(await evalScript(MOVE_PROBE, ['s'], [])).toBe(s);
    expect(await evalScript(MOVE_PROBE, ['h'], [])).toBe(h);
    expect(await evalScript(MOVE_PROBE, ['none'], [])).toBe('');
    await r.send('HSET', ['rec', 's', s, 'h', h]);
    expect(await evalScript(MOVE_DELETE, ['s', 'rec', 'lock'], ['wrong', 's', 'tok'])).toBe(0);
    expect(await evalScript(MOVE_DELETE, ['s', 'rec', 'lock'], [s, 's', 'tok'])).toBe(1);
    expect(await evalScript(MOVE_DELETE, ['h', 'rec', 'lock'], [h, 'h', 'tok'])).toBe(1);
    expect(await r.send('EXISTS', ['s', 'h', 'rec'])).toBe(0);
    // A retried delete whose first answer was lost: done already.
    expect(await evalScript(MOVE_DELETE, ['s', 'rec', 'lock'], [s, 's', 'tok'])).toBe(1);
  });

  test('a string is written, with its expiry and its record, only over what was expected', async () => {
    expect(await evalScript(MOVE_SET, ['t', 'rec', 'lock'], ['', 'value', '600', 'budgets', 'd1', 'tok'])).toBe(1);
    expect(await r.send('GET', ['t'])).toBe('value');
    expect(Number(await r.send('TTL', ['t']))).toBeGreaterThan(590);
    expect(await r.send('HGET', ['rec', 'budgets'])).toBe('d1');
    // Something else there now: refused, nothing changed.
    expect(await evalScript(MOVE_SET, ['t', 'rec', 'lock'], ['', 'other', '0', 'budgets', 'd2', 'tok'])).toBe(0);
    expect(await r.send('GET', ['t'])).toBe('value');
    expect(await r.send('HGET', ['rec', 'budgets'])).toBe('d1');
    // The same write retried after it landed: done already.
    const d = digest({ kind: 'string', value: 'value' })!;
    await r.send('HSET', ['rec', 'budgets', d]);
    expect(await evalScript(MOVE_SET, ['t', 'rec', 'lock'], ['', 'value', '600', 'budgets', d, 'tok'])).toBe(1);
  });

  test('nothing is written once the run no longer holds the lock', async () => {
    await r.send('SET', ['lock', 'someone-else']);
    expect(await evalScript(MOVE_SET, ['t', 'rec', 'lock'], ['', 'value', '0', 'budgets', 'd1', 'tok'])).toBe(-1);
    await r.send('HSET', ['tmp', 'a', '1']);
    const d = digest({ kind: 'hash', fields: [['a', '1']] })!;
    expect(await evalScript(MOVE_SWAP, ['t', 'rec', 'tmp', 'lock'], ['', 'k', d, 'tok'])).toBe(-1);
    await r.send('SET', ['s', 'x']);
    expect(await evalScript(MOVE_DELETE, ['s', 'rec', 'lock'], [digest({ kind: 'string', value: 'x' })!, 's', 'tok'])).toBe(-1);
    expect(await r.send('EXISTS', ['t', 'rec'])).toBe(0);
    expect(await r.send('GET', ['s'])).toBe('x');
  });

  test('a settled conflict records the old key as seen, only if neither side changed', async () => {
    await r.send('SET', ['old', 'o']);
    await r.send('SET', ['t', 'c']);
    const o = digest({ kind: 'string', value: 'o' })!;
    const c = digest({ kind: 'string', value: 'c' })!;
    expect(await evalScript(MOVE_RESOLVE, ['old', 't', 'rec', 'lock'], [o, 'wrong', 'k', 'tok'])).toBe(0);
    expect(await evalScript(MOVE_RESOLVE, ['old', 't', 'rec', 'lock'], [o, c, 'k', 'other'])).toBe(-1);
    expect(await r.send('EXISTS', ['rec'])).toBe(0);
    expect(await evalScript(MOVE_RESOLVE, ['old', 't', 'rec', 'lock'], [o, c, 'k', 'tok'])).toBe(1);
    expect(await r.send('HGET', ['rec', 'k'])).toBe(o);
    await r.send('DEL', ['old']);
    expect(await evalScript(MOVE_RESOLVE, ['old', 't', 'rec', 'lock'], ['', c, 'k', 'tok'])).toBe(1);
    expect(await r.send('EXISTS', ['rec'])).toBe(0);
  });

  test('a swapped-in hash drops the expiry it was built with when asked', async () => {
    await r.send('HSET', ['tmp', 'a', '1']);
    await r.send('EXPIRE', ['tmp', '3600']);
    const d = digest({ kind: 'hash', fields: [['a', '1']] })!;
    expect(await evalScript(MOVE_SWAP, ['t', 'rec', 'tmp', 'lock'], ['', 'k', d, 'tok', '1'])).toBe(1);
    expect(Number(await r.send('TTL', ['t']))).toBe(-1);
    await r.send('HSET', ['tmp', 'a', '1']);
    await r.send('EXPIRE', ['tmp', '600']);
    await r.send('DEL', ['t', 'rec']);
    expect(await evalScript(MOVE_SWAP, ['t', 'rec', 'tmp', 'lock'], ['', 'k', d, 'tok', '0'])).toBe(1);
    expect(Number(await r.send('TTL', ['t']))).toBeGreaterThan(590);
  });

  test('a hash is swapped in whole, only over what was expected and only when complete', async () => {
    await r.send('HSET', ['t', 'old', '1']);
    await r.send('HSET', ['tmp', ...fields.flat()]);
    const before = digest({ kind: 'hash', fields: [['old', '1']] })!;
    const d = digest({ kind: 'hash', fields })!;
    expect(await evalScript(MOVE_SWAP, ['t', 'rec', 'tmp', 'lock'], ['not-it', 'hidden:accounts', d, 'tok'])).toBe(0);
    // Not what should have been built: refused.
    expect(await evalScript(MOVE_SWAP, ['t', 'rec', 'tmp', 'lock'], [before, 'hidden:accounts', 'other', 'tok'])).toBe(-2);
    expect(await evalScript(MOVE_SWAP, ['t', 'rec', 'tmp', 'lock'], [before, 'hidden:accounts', d, 'tok'])).toBe(1);
    expect(await r.send('HGET', ['t', 'acct_é'])).toBe('naïve café ✓');
    expect(await r.send('HEXISTS', ['t', 'old'])).toBe(0);
    expect(await r.send('EXISTS', ['tmp'])).toBe(0);
    expect(await r.send('HGET', ['rec', 'hidden:accounts'])).toBe(d);
    // Retried after it landed (the temporary hash is gone by then): done.
    expect(await evalScript(MOVE_SWAP, ['t', 'rec', 'tmp', 'lock'], [before, 'hidden:accounts', d, 'tok'])).toBe(1);
  });
});
