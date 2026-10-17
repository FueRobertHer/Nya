import { describe, expect, test, mock, beforeEach, afterEach, afterAll, setSystemTime } from 'bun:test';
import { FakeRedis, storageMock, TEST_CONTAINER, ctxKey } from './fake-redis';
import { startRedis, upstashOn, type RealRedis } from './real-redis';

// A data key per container (docs/architecture.md, "Per-container data keys"):
// each container's values under a key of its own, made at its birth or by the
// migration pass, checked where its Ctx is resolved, destroyed with it.

process.env.PLAID_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');

// Deserializing, like Upstash's default client.
const fake = new FakeRedis({ deserialize: true });
let client: unknown = fake;
mock.module('@/lib/storage', () => ({ ...storageMock(fake), redis: () => client, rawRedis: () => client }));

const c = await import('@/lib/crypto');
const { registryKey, ContainerError, createFirstContainer } = await import('@/lib/containers');
const { openStored } = await import('@/lib/repo');
const { ownerContainer } = await import('@/lib/owners');
const { forgetEpochs } = await import('@/lib/sessions');
const { containerUnavailable, KEY_UNAVAILABLE_MESSAGE } = await import('@/lib/data-ctx');

const MASTER = Buffer.alloc(32, 3).toString('base64');
const NEW_MASTER = Buffer.alloc(32, 9).toString('base64');
const A = TEST_CONTAINER as any;
const B = '5d1c7e2a-9b3f-4c6d-8e1a-2b3c4d5e6f70' as any;
const UNREGISTERED = '7e8f9a0b-1c2d-4e3f-9a4b-5c6d7e8f9a0b' as any;
const ctxA = { container: A };
const ctxB = { container: B };
const ISO = '2026-01-01T00:00:00.000Z';

const registryRecord = (primary: boolean) => JSON.stringify({ status: 'active', primary, created_at: ISO });
async function register(...ids: string[]) {
  await fake.hset(registryKey(), Object.fromEntries(ids.map((id, i) => [id, registryRecord(i === 0)])));
}
/** Gives a registered container a key of its own, as the migration pass does. */
async function giveKey(container: string): Promise<string> {
  const p = await c.prepareContainerKey(container as any, { born: false });
  expect(p).not.toBeNull();
  expect((await c.claimContainerKey(p!)).outcome).toBe('made');
  return p!.id;
}
/** A data key stored by hand, numbered n, naming a container or none. */
async function plantKey(n: number, container?: string, masterB64 = MASTER): Promise<string> {
  const m = await c.importMasterKey(masterB64);
  const raw = crypto.getRandomValues(new Uint8Array(32));
  const id = await c.dataKeyId(n, raw);
  const record = { created_at: ISO, wrapped: { [m.fingerprint]: await m.wrap(id, raw) }, ...(container ? { container } : {}) };
  await fake.hset(c.keysHashKey(), { [id]: JSON.stringify(record) });
  return id;
}
/** A hash field exactly as stored. */
const stored = (key: string, field: string) => fake.hashes.get(key)?.get(field);
const entryOf = (container: string) => {
  const v = stored(c.containerKeysKey(), container);
  return v === undefined ? undefined : JSON.parse(v);
};
const keysNaming = (container: string) =>
  [...(fake.hashes.get(c.keysHashKey())?.entries() ?? [])].filter(([, v]) => v.includes(`"container":"${container}"`)).map(([id]) => id);

/** Runs fn with console.error collected, answering its result or its error. */
async function quietly<R>(fn: () => Promise<R>): Promise<{ result?: R; error?: any; logged: string[] }> {
  const logged: string[] = [];
  const orig = console.error;
  console.error = (...a: unknown[]) => void logged.push(a.map(String).join(' '));
  try {
    return { result: await fn(), logged };
  } catch (error) {
    return { error, logged };
  } finally {
    console.error = orig;
  }
}

const saved = { ...process.env };
beforeEach(async () => {
  fake.reset();
  client = fake;
  c.forgetActiveKey();
  forgetEpochs();
  process.env.MASTER_KEY = MASTER;
  await register(A, B);
});
afterEach(() => {
  process.env = { ...saved };
  setSystemTime();
});

describe('each container encrypts under a key of its own', () => {
  test('a container with a key writes only under it, and reads its own values', async () => {
    const keyB = await giveKey(B);
    const v = await c.encrypt(ctxB, 'B balance 100');
    expect(c.formatOf(v)).toEqual({ version: 2, keyId: keyB, flags: '-' });
    expect(await c.decrypt(ctxB, v)).toBe('B balance 100');
    expect(JSON.parse(stored(c.keysHashKey(), keyB)!).container).toBe(B);
    // One without a key still writes to the environment's.
    const shared = await c.encrypt(ctxA, 'A');
    expect(c.formatOf(shared).keyId).not.toBe(keyB);
    expect(stored(c.keysHashKey(), c.formatOf(shared).keyId)).not.toContain('"container"');
  });

  test('a value under another container’s key is refused as unrecognised, never decrypted, and logged as a possible bug', async () => {
    await giveKey(B);
    const v = await c.encrypt(ctxB, 'B secret');
    const read = await quietly(() => c.decrypt(ctxA, v));
    expect(read.error).toBeInstanceOf(c.KeyNotForContainerError);
    expect(read.error.message).toContain(B);
    expect(read.logged.join('\n')).toContain('Possible isolation bug');
    expect(read.logged.join('\n')).not.toContain('B secret');
    // Through the seam: intact as far as anything can tell, and not A's to remove.
    const opened = await quietly(() => openStored(ctxA, v));
    expect(opened.result).toMatchObject({ ok: false, flaw: 'unrecognised' });
    expect(await c.decrypt(ctxB, v)).toBe('B secret');
  });

  test('values under k0 or the environment’s key read in every container until the pass moves them', async () => {
    delete process.env.MASTER_KEY;
    const old = await c.encrypt(ctxA, 'old');
    process.env.MASTER_KEY = MASTER;
    c.forgetActiveKey();
    const env = await c.encrypt(ctxA, 'env');
    await giveKey(A);
    expect(c.formatOf(old).keyId).toBe('k0');
    expect(c.formatOf(env).version).toBe(2);
    for (const ctx of [ctxA, ctxB]) {
      expect(await c.decrypt(ctx, old)).toBe('old');
      expect(await c.decrypt(ctx, env)).toBe('env');
    }
  });

  test('the test double refuses, on every write, a value under one container’s key stored in another', async () => {
    await giveKey(B);
    const v = await c.encrypt(ctxB, 'x');
    await expect(fake.set(ctxKey('x', ctxA), v)).rejects.toThrow(/wrong Ctx/);
    await expect(fake.hset(ctxKey('plaid:items', ctxA), { i: JSON.stringify({ encrypted_access_token: v }) })).rejects.toThrow(/wrong Ctx/);
    await expect(fake.eval(`-- nya:history-set-if-absent\n`, [ctxKey('h', ctxA)], ['f', v])).rejects.toThrow(/wrong Ctx/);
    await fake.set(ctxKey('x', ctxB), v); // its own container: fine
    // Recorded as well as thrown: a writer that catches the error still fails its test.
    expect(fake.takeViolations()).toHaveLength(3);
    fake.checkCiphertext = false; // planted on purpose
    await fake.set(ctxKey('x', ctxA), v);
    expect(fake.takeViolations()).toEqual([]);
    fake.checkCiphertext = true;
    await fake.set(ctxKey('x', ctxA), v).catch(() => {});
    expect(() => fake.reset()).toThrow(/broke the isolation check before this reset/);
    expect(fake.checkCiphertext).toBe(true);
    expect(fake.takeViolations()).toEqual([]);
  });
});

describe('a container whose own key can’t be used is unavailable, and nothing falls back', () => {
  /** Every way in, each refused with ContainerKeyError, a ContainerError:
   *  the check made where a Ctx is resolved, a write, and a read of a value
   *  under its key (when there is one to read). */
  async function refusedEveryWay(ctx: { container: any }, value?: string) {
    const ways: (() => Promise<unknown>)[] = [() => c.checkContainerKey(ctx), () => c.encrypt(ctx, 'y'), ...(value ? [() => c.decrypt(ctx, value)] : [])];
    for (const attempt of ways) {
      const { error } = await quietly(attempt);
      expect(error).toBeInstanceOf(c.ContainerKeyError);
      expect(error).toBeInstanceOf(ContainerError);
    }
  }

  test('its key gone from the store', async () => {
    const keyB = await giveKey(B);
    const v = await c.encrypt(ctxB, 'x');
    await fake.hdel(c.keysHashKey(), keyB);
    c.forgetActiveKey();
    await refusedEveryWay(ctxB, v);
  });

  test('this master can’t open it, or there is no master at all', async () => {
    await giveKey(B);
    const v = await c.encrypt(ctxB, 'x');
    process.env.MASTER_KEY = NEW_MASTER;
    await refusedEveryWay(ctxB, v);
    delete process.env.MASTER_KEY;
    c.forgetActiveKey();
    await refusedEveryWay(ctxB, v);
  });

  test('its map entry names a key whose record names another container, or none', async () => {
    const keyA = await giveKey(A);
    const vA = await c.encrypt(ctxA, 'a');
    await fake.hset(c.containerKeysKey(), { [B]: JSON.stringify({ key: keyA, since: ISO }) });
    await refusedEveryWay(ctxB, vA);
    const shared = await plantKey(60);
    await fake.hset(c.containerKeysKey(), { [B]: JSON.stringify({ key: shared, since: ISO }) });
    c.forgetActiveKey();
    const { error } = await quietly(() => c.checkContainerKey(ctxB));
    expect(error).toBeInstanceOf(c.ContainerKeyError);
    expect(error.message).toContain('names no container');
  });

  test('its map entry can’t be read, or says the key was destroyed with the account', async () => {
    await fake.hset(c.containerKeysKey(), { [B]: '{damaged' });
    await refusedEveryWay(ctxB);
    await fake.hset(c.containerKeysKey(), { [B]: JSON.stringify({ destroyed: '2026-10-01' }) });
    c.forgetActiveKey();
    const { error } = await quietly(() => c.encrypt(ctxB, 'late'));
    expect(error).toBeInstanceOf(c.ContainerKeyError);
    expect(error.message).toContain('destroyed with the account');
  });

  test('a storage failure stays a storage failure, and is tried again on the next use', async () => {
    const keyB = await giveKey(B);
    c.forgetActiveKey();
    fake.failNext('hget');
    const { error } = await quietly(() => c.encrypt(ctxB, 'x'));
    expect(error).toBeDefined();
    expect(error).not.toBeInstanceOf(ContainerError);
    expect(c.formatOf(await c.encrypt(ctxB, 'x')).keyId).toBe(keyB);
  });

  test('the person is told a plain sentence; the key and the reason go to the log', async () => {
    const keyB = await giveKey(B);
    await fake.hdel(c.keysHashKey(), keyB);
    c.forgetActiveKey();
    const { error } = await quietly(() => c.checkContainerKey(ctxB));
    const { result: res, logged } = await quietly(async () => containerUnavailable(error)!);
    expect(res!.status).toBe(503);
    const body = await res!.json();
    expect(body).toEqual({ error: KEY_UNAVAILABLE_MESSAGE });
    expect(JSON.stringify(body)).not.toContain(keyB);
    expect(logged.join('\n')).toContain(keyB);
  });
});

describe('making a container’s key', () => {
  test('made and proven before anything is stored, naming its container', async () => {
    const at = Date.parse('2026-10-01T00:00:00.000Z');
    const p = (await c.prepareContainerKey(B, { born: true, now: at }))!;
    expect(stored(c.keysHashKey(), p.id)).toBeUndefined();
    expect(entryOf(B)).toBeUndefined();
    expect(JSON.parse(p.record).container).toBe(B);
    expect(JSON.parse(p.entry)).toEqual({ key: p.id, since: '2026-10-01T00:00:00.000Z', moved: '2026-10-01T00:00:00.000Z' });
    expect(JSON.parse((await c.prepareContainerKey(B, { born: false }))!.entry).moved).toBeUndefined();
    delete process.env.MASTER_KEY;
    expect(await c.prepareContainerKey(B, { born: false })).toBeNull();
  });

  test('claimed in one step, only while nothing stands in the way', async () => {
    const p = (await c.prepareContainerKey(B, { born: false }))!;
    expect((await c.claimContainerKey((await c.prepareContainerKey(UNREGISTERED, { born: false }))!)).outcome).toBe('unregistered');
    await fake.set(c.rotationKey(), '{}');
    expect((await c.claimContainerKey(p)).outcome).toBe('rotation');
    await fake.del(c.rotationKey());
    await fake.set(c.rotationLockKey(), 'someone');
    expect((await c.claimContainerKey(p)).outcome).toBe('rotation');
    await fake.del(c.rotationLockKey());
    await fake.set(c.currentMasterKeyName(), JSON.stringify({ fingerprint: 'ffffffffffffffff' }));
    expect((await c.claimContainerKey(p)).outcome).toBe('master');
    await fake.del(c.currentMasterKeyName());
    await fake.hset(c.keysHashKey(), { [p.id]: 'someone else’s' });
    expect((await c.claimContainerKey(p)).outcome).toBe('taken');
    expect(stored(c.keysHashKey(), p.id)).toBe('someone else’s');
    await fake.hdel(c.keysHashKey(), p.id);
    expect(fake.hashes.get(c.containerKeysKey())?.size ?? 0).toBe(0);

    expect(await c.claimContainerKey(p)).toEqual({ outcome: 'made', entry: JSON.parse(p.entry) });
    expect(stored(c.keysHashKey(), p.id)).toBe(p.record);
    expect(JSON.parse(fake.strings.get(c.currentMasterKeyName())!)).toEqual({ fingerprint: (await c.importMasterKey(MASTER)).fingerprint });
    const again = (await c.prepareContainerKey(B, { born: false }))!;
    expect(await c.claimContainerKey(again)).toEqual({ outcome: 'have', entry: JSON.parse(p.entry) });
    expect(stored(c.keysHashKey(), again.id)).toBeUndefined();
  });

  test('claims at once: one key wins, the others are never stored, and every write uses the winner', async () => {
    const ps = await Promise.all(Array.from({ length: 6 }, () => c.prepareContainerKey(B, { born: false })));
    const outcomes = await Promise.all(ps.map((p) => c.claimContainerKey(p!)));
    expect(outcomes.filter((o) => o.outcome === 'made')).toHaveLength(1);
    expect(outcomes.filter((o) => o.outcome === 'have')).toHaveLength(5);
    const winner = ps[outcomes.findIndex((o) => o.outcome === 'made')]!;
    expect(keysNaming(B)).toEqual([winner.id]);
    for (const o of outcomes) expect(o.entry).toMatchObject({ key: winner.id });
    const writes = await Promise.all(Array.from({ length: 4 }, (_, i) => c.encrypt(ctxB, `v${i}`)));
    for (const w of writes) expect(c.formatOf(w).keyId).toBe(winner.id);
  });
});

describe('a container is born with its key', () => {
  beforeEach(async () => {
    fake.reset();
    await register(A); // the data already here, which the first account claims
  });

  test('a new account’s container has its key from its first request: written in the step that registers it', async () => {
    expect(String(await ownerContainer('user_owner'))).toBe(A);
    expect(entryOf(A)).toBeUndefined(); // the data already here moves through the pass
    const theirs = String(await ownerContainer('user_partner'));
    const entry = entryOf(theirs);
    expect(entry.key).toMatch(/^k[1-9][0-9]*-[0-9a-f]{8}$/);
    expect(entry.moved).toBe(entry.since); // moved from the start
    expect(keysNaming(theirs)).toEqual([entry.key]);
    expect(c.formatOf(await c.encrypt({ container: theirs as any }, 'x')).keyId).toBe(entry.key);
  });

  test('two tabs at once: one container, with one key', async () => {
    await ownerContainer('user_owner');
    const [a, b] = await Promise.all([ownerContainer('user_partner'), ownerContainer('user_partner')]);
    expect(String(a)).toBe(String(b));
    expect(keysNaming(String(a))).toHaveLength(1);
  });

  test('while a master rotation is under way, or with no master, born without one, writing as before', async () => {
    await ownerContainer('user_owner');
    await fake.set(c.rotationKey(), JSON.stringify({ from: 'a', next: 'b', prepared_at: ISO }));
    const during = String(await ownerContainer('user_partner'));
    expect(entryOf(during)).toBeUndefined();
    await fake.del(c.rotationKey());
    delete process.env.MASTER_KEY;
    const none = String(await ownerContainer('user_third'));
    expect(entryOf(none)).toBeUndefined();
    expect(c.formatOf(await c.encrypt({ container: none as any }, 'x')).keyId).toBe('k0');
  });

  test('a key that can’t be made is logged, and the account is set up all the same', async () => {
    await ownerContainer('user_owner');
    fake.failNext('eval'); // the key counter
    const { result, logged } = await quietly(() => ownerContainer('user_partner'));
    expect(logged.join('\n')).toContain('No data key made for the new container');
    expect(entryOf(String(result))).toBeUndefined();
  });

  test('the first container, made by the ops route, is born with its key too', async () => {
    fake.reset();
    const id = await createFirstContainer(Date.now(), (fresh) => c.birthKey(fresh));
    expect(keysNaming(id)).toEqual([entryOf(id).key]);
  });
});

describe('key numbers', () => {
  test('come from a counter started past the highest in the store, then cost one step each', async () => {
    await plantKey(7);
    let scans = 0;
    const hscan = fake.hscan.bind(fake);
    fake.hscan = (async (...args: Parameters<typeof fake.hscan>) => (scans++, hscan(...args))) as typeof fake.hscan;
    try {
      expect(await c.nextKeyNumber()).toBe(8);
      expect(scans).toBeGreaterThan(0);
      scans = 0;
      expect(await c.nextKeyNumber()).toBe(9);
      expect(scans).toBe(0);
    } finally {
      fake.hscan = hscan as typeof fake.hscan;
    }
    // Never a field of the key store, which the release before refuses.
    expect(fake.hashes.get(c.keysHashKey())!.size).toBe(1);
  });

  test('the store is read a page at a time, never every number in one call', async () => {
    const fields: Record<string, string> = {};
    for (let i = 1; i <= 5000; i++) fields[`k${i}-${i.toString(16).padStart(8, '0')}`] = '{}';
    await fake.hset(c.keysHashKey(), fields);
    const max = Math.max;
    Math.max = ((...args: number[]) => {
      if (args.length > 1000) throw new RangeError('Maximum call stack size exceeded');
      return max(...args);
    }) as typeof Math.max;
    try {
      expect(await c.nextKeyNumber()).toBe(5001);
    } finally {
      Math.max = max;
    }
  });

  test('past the most the id format allows, no key is made: the container stays on the shared key, and it is said', async () => {
    await fake.set(c.keySeqKey(), String(c.MAX_KEY_NUMBER));
    const { result, logged } = await quietly(() => c.prepareContainerKey(B, { born: false }));
    expect(result).toBeNull();
    expect(logged.join('\n')).toContain(`past ${c.MAX_KEY_NUMBER}`);
    expect((await quietly(() => c.birthKey(B))).result!.args).toEqual(['', '', '', '']);
  });

  test('two keys may share a number: their ids differ, and each opens', async () => {
    const k3 = await plantKey(3);
    const old = await c.encryptV2('under k3', k3);
    await fake.set(c.keySeqKey(), '2'); // a counter behind the store
    const p = (await c.prepareContainerKey(B, { born: false }))!;
    expect(p.id.startsWith('k3-')).toBe(true);
    expect(p.id).not.toBe(k3);
    await c.claimContainerKey(p);
    const mine = await c.encrypt(ctxB, 'under B’s k3');
    expect(c.formatOf(mine).keyId).toBe(p.id);
    expect(await c.decrypt(ctxB, mine)).toBe('under B’s k3');
    expect(await c.decrypt(ctxB, old)).toBe('under k3');
  });

  test('a counter holding something else is refused, not guessed past', async () => {
    await fake.set(c.keySeqKey(), 'abc');
    await expect(c.nextKeyNumber()).rejects.toThrow();
  });
});

describe('destroying a container’s keys', () => {
  const DAY1 = Date.parse('2026-10-17T12:00:00.000Z');
  const unregister = (container: string) => fake.hdel(registryKey(), container);

  test('refused while the container is registered, changing nothing', async () => {
    const keyB = await giveKey(B);
    const before = JSON.stringify([...fake.hashes.entries()].map(([k, h]) => [k, [...h.entries()]]));
    await expect(c.destroyContainerKeys(ctxB)).rejects.toThrow('still in the registry');
    expect(JSON.stringify([...fake.hashes.entries()].map(([k, h]) => [k, [...h.entries()]]))).toBe(before);
    expect(stored(c.keysHashKey(), keyB)).toBeDefined();
  });

  test('takes the key out of the store, leaves a tombstone and a marker; its values can’t be read, nor written', async () => {
    const keyB = await giveKey(B);
    const v = await c.encrypt(ctxB, 'gone');
    await unregister(B);
    expect(await c.destroyContainerKeys(ctxB, DAY1)).toEqual({ destroyed: [keyB] });
    expect(stored(c.keysHashKey(), keyB)).toBeUndefined();
    expect(JSON.parse(stored(c.tombstonesKey(), keyB)!)).toEqual({ container: B, on: '2026-10-17' });
    expect(entryOf(B)).toEqual({ destroyed: '2026-10-17' });
    expect((await quietly(() => c.decrypt(ctxB, v))).error).toBeInstanceOf(Error);
    expect((await quietly(() => c.checkContainerKey(ctxB))).error).toBeInstanceOf(c.ContainerKeyError);
    expect((await quietly(() => c.encrypt(ctxB, 'late'))).error).toBeInstanceOf(c.ContainerKeyError);
    // Again (a deletion retried): the same answer, nothing more, the day kept.
    expect(await c.destroyContainerKeys(ctxB, DAY1 + 86_400_000)).toEqual({ destroyed: [keyB] });
    expect(JSON.parse(stored(c.tombstonesKey(), keyB)!).on).toBe('2026-10-17');
    expect(entryOf(B)).toEqual({ destroyed: '2026-10-17' });
    expect(await c.readTombstones()).toEqual(new Map([[keyB, { container: B, on: '2026-10-17' }]]));
  });

  test('finds every key whose record names the container, its map entry missing or damaged', async () => {
    const keyB = await giveKey(B);
    const stray = await plantKey(50, B);
    await fake.hset(c.containerKeysKey(), { [B]: '{damaged' });
    await unregister(B);
    expect((await c.destroyContainerKeys(ctxB, DAY1)).destroyed).toEqual([keyB, stray].sort());
    expect(keysNaming(B)).toEqual([]);
    expect(stored(c.tombstonesKey(), stray)).toBeDefined();
  });

  test('never another container’s key, whatever the map entry says, and a key already gone is tombstoned', async () => {
    const keyA = await giveKey(A);
    await fake.hset(c.containerKeysKey(), { [B]: JSON.stringify({ key: keyA, since: ISO }) });
    await unregister(B);
    expect((await c.destroyContainerKeys(ctxB, DAY1)).destroyed).toEqual([]);
    expect(stored(c.keysHashKey(), keyA)).toBeDefined();
    expect(stored(c.tombstonesKey(), keyA)).toBeUndefined();
    // A key its entry names that a restore lost: tombstoned, so a key archive
    // that still holds it drops it.
    const lost = 'k70-0123abcd';
    await fake.hset(c.containerKeysKey(), { [B]: JSON.stringify({ key: lost, since: ISO }) });
    expect((await c.destroyContainerKeys(ctxB, DAY1)).destroyed).toEqual([lost]);
    expect(JSON.parse(stored(c.tombstonesKey(), lost)!)).toEqual({ container: B, on: '2026-10-17' });
  });

  test('a write that comes too late, in an instance that still holds the key, never lands under a shared key', async () => {
    const keyB = await giveKey(B);
    await c.encrypt(ctxB, 'warm'); // this instance holds B's entry and key
    // Another instance deletes the account, without this one's caches being told.
    await unregister(B);
    await fake.eval(c.CONTAINER_KEY_DESTROY, [c.containerKeysKey(), c.keysHashKey(), registryKey(), c.tombstonesKey()], [B, '2026-10-17', keyB]);
    // Within the minute it trusts them, a write still uses the key it holds:
    // under a key nobody has any more, unreadable, for the nightly sweep.
    expect(c.formatOf(await c.encrypt(ctxB, 'late')).keyId).toBe(keyB);
    // After it, writes fail: never k0, never the environment's key.
    setSystemTime(new Date(Date.now() + c.ACTIVE_CACHE_MS + 1000));
    const { error } = await quietly(() => c.encrypt(ctxB, 'later'));
    expect(error).toBeInstanceOf(c.ContainerKeyError);
    expect(error.message).toContain('destroyed');
  });
});

describe('master rotation, with a key per container', () => {
  test('every container’s key is prepared and finished, keeping its container; its values read throughout', async () => {
    const keyA = await giveKey(A);
    const keyB = await giveKey(B);
    const vA = await c.encrypt(ctxA, 'a');
    const vB = await c.encrypt(ctxB, 'b');
    await c.prepareMasterRotation(NEW_MASTER);
    process.env.MASTER_KEY = NEW_MASTER;
    c.forgetActiveKey();
    expect(await c.decrypt(ctxA, vA)).toBe('a');
    expect(await c.finishMasterRotation({ force: true })).toEqual({ state: 'finished', finished: 2 });
    for (const [id, owner] of [[keyA, A], [keyB, B]]) expect(JSON.parse(stored(c.keysHashKey(), id)!).container).toBe(owner);
    c.forgetActiveKey();
    expect(await c.decrypt(ctxB, vB)).toBe('b');
    expect(c.formatOf(await c.encrypt(ctxB, 'c')).keyId).toBe(keyB);
  });

  test('an interrupted finish keeps the record, and the next attempt completes it, key by key', async () => {
    const ids: string[] = [];
    for (let i = 0; i < c.WRITE_PAGE * 2 + 5; i++) ids.push(await plantKey(100 + i, i % 2 ? B : A));
    await c.prepareMasterRotation(NEW_MASTER);
    process.env.MASTER_KEY = NEW_MASTER;
    const fp = (await c.importMasterKey(NEW_MASTER)).fingerprint;
    const finished = () => ids.filter((id) => JSON.parse(stored(c.keysHashKey(), id)!).next === undefined);

    const hset = fake.hset.bind(fake);
    let pages = 0;
    fake.hset = (async (key: string, fields: Record<string, string>) => {
      if (key === c.keysHashKey() && ++pages === 2) throw new Error('timed out');
      return hset(key, fields);
    }) as typeof fake.hset;
    try {
      await expect(c.finishMasterRotation({ force: true })).rejects.toThrow('timed out');
    } finally {
      fake.hset = hset as typeof fake.hset;
    }
    expect(await c.rotationPending()).toBe(true); // the record stays until every key is finished
    expect(finished()).toHaveLength(c.WRITE_PAGE);

    expect(await c.finishMasterRotation({ force: true })).toEqual({ state: 'finished', finished: ids.length });
    for (const id of ids) expect(Object.keys(JSON.parse(stored(c.keysHashKey(), id)!).wrapped)).toEqual([fp]);
    expect(await c.rotationPending()).toBe(false);
    expect(JSON.parse(fake.strings.get(c.currentMasterKeyName())!)).toEqual({ fingerprint: fp });
    // Done: repeating it finds nothing to do.
    expect(await c.finishMasterRotation({ force: true })).toEqual({ state: 'none' });
  });

  test('an interrupted prepare leaves no record and every key openable by the running master', async () => {
    const ids: string[] = [];
    for (let i = 0; i < c.WRITE_PAGE + 5; i++) ids.push(await plantKey(300 + i, B));
    const hset = fake.hset.bind(fake);
    let pages = 0;
    fake.hset = (async (key: string, fields: Record<string, string>) => {
      if (key === c.keysHashKey() && ++pages === 2) throw new Error('killed');
      return hset(key, fields);
    }) as typeof fake.hset;
    try {
      await expect(c.prepareMasterRotation(NEW_MASTER)).rejects.toThrow('killed');
    } finally {
      fake.hset = hset as typeof fake.hset;
    }
    expect(await c.rotationPending()).toBe(false);
    const current = await c.importMasterKey(MASTER);
    for (const id of ids) await c.unwrapDataKey(current, id, JSON.parse(stored(c.keysHashKey(), id)!));
    // The new deployment, redeployed anyway, removes nothing.
    process.env.MASTER_KEY = NEW_MASTER;
    expect(await c.finishMasterRotation({ force: true })).toEqual({ state: 'none' });
    for (const id of ids) await c.unwrapDataKey(current, id, JSON.parse(stored(c.keysHashKey(), id)!));
  });
});

describe('a container’s map entry', () => {
  test('is changed only from what was read: a change in between is read again, never overwritten', async () => {
    const keyB = await giveKey(B);
    let interfere = true;
    const out = await c.updateContainerEntry(B, (e) => {
      if (interfere) {
        interfere = false;
        fake.hashes.get(c.containerKeysKey())!.set(B, JSON.stringify({ ...e, shared_in: '2026-10-01T00:00:00.000Z' }));
      }
      return e && 'key' in e ? { ...e, moved: '2026-10-02T00:00:00.000Z' } : null;
    });
    expect(out).toEqual({ key: keyB, since: expect.any(String), shared_in: '2026-10-01T00:00:00.000Z', moved: '2026-10-02T00:00:00.000Z' });
    expect(entryOf(B)).toEqual(out);
    // Answering null leaves it as it is.
    expect(await c.updateContainerEntry(B, () => null)).toEqual(out);
  });

  test('every entry is read a page at a time; one that can’t be read is reported, not thrown', async () => {
    await giveKey(A);
    await fake.hset(c.containerKeysKey(), { [B]: '{nope' });
    const all = await c.readContainerEntries();
    expect(all.get(A)).toMatchObject({ key: expect.any(String) });
    expect(all.get(B)).toBeInstanceOf(c.ContainerKeyError);
  });
});

const hasRedis = Bun.which('redis-server') !== null;
describe.skipIf(!hasRedis && !process.env.CI)('the key scripts, on a real Redis', () => {
  let real: RealRedis | null = null;
  const send = (command: string, args: string[]) => real!.client.send(command, args);

  beforeEach(async () => {
    real ??= await startRedis();
    await send('FLUSHALL', []);
    client = upstashOn(real.client);
    c.forgetActiveKey();
  });
  afterAll(() => {
    real?.stop();
    real = null;
    client = fake;
  });

  test('the key counter: none without a start, started once, then counting; never past a non-number', async () => {
    expect(await send('EVAL', [c.KEY_SEQ, '1', 'seq', ''])).toBe(-1);
    expect(await send('EXISTS', ['seq'])).toBe(0);
    expect(await send('EVAL', [c.KEY_SEQ, '1', 'seq', '41'])).toBe(42);
    expect(await send('EVAL', [c.KEY_SEQ, '1', 'seq', '7'])).toBe(43);
    expect(await send('EVAL', [c.KEY_SEQ, '1', 'seq', ''])).toBe(44);
    await send('SET', ['seq', 'abc']);
    await expect(send('EVAL', [c.KEY_SEQ, '1', 'seq', ''])).rejects.toThrow();
  });

  test('claiming a container’s key: every outcome, and nothing written but when made', async () => {
    const keys = ['map', 'keys', 'rotation', 'lock', 'master', 'registry'];
    const run = (id: string, master = 'M') =>
      send('EVAL', [c.CONTAINER_KEY_CREATE, String(keys.length), ...keys, 'c1', id, `{"rec":"${id}"}`, `{"key":"${id}"}`, master]);
    expect(await run('k1-aaaaaaaa')).toEqual(['unregistered', '']);
    await send('HSET', ['registry', 'c1', '{}']);
    await send('SET', ['rotation', '{}']);
    expect(await run('k1-aaaaaaaa')).toEqual(['rotation', '']);
    await send('DEL', ['rotation']);
    await send('SET', ['lock', 'x']);
    expect(await run('k1-aaaaaaaa')).toEqual(['rotation', '']);
    await send('DEL', ['lock']);
    await send('SET', ['master', 'OTHER']);
    expect(await run('k1-aaaaaaaa')).toEqual(['master', '']);
    await send('DEL', ['master']);
    await send('HSET', ['keys', 'k1-aaaaaaaa', 'theirs']);
    expect(await run('k1-aaaaaaaa')).toEqual(['taken', '']);
    expect(await send('EXISTS', ['map', 'master'])).toBe(0);
    expect(await run('k2-bbbbbbbb')).toEqual(['made', 'v{"key":"k2-bbbbbbbb"}']);
    expect(await send('HGET', ['keys', 'k2-bbbbbbbb'])).toBe('{"rec":"k2-bbbbbbbb"}');
    expect(await send('GET', ['master'])).toBe('M');
    expect(await run('k3-cccccccc')).toEqual(['have', 'v{"key":"k2-bbbbbbbb"}']);
    expect(await send('HEXISTS', ['keys', 'k3-cccccccc'])).toBe(0);
  });

  test('destroying: refused while registered, only the container’s own keys, each tombstoned once, and a marker', async () => {
    const keys = ['map', 'keys', 'registry', 'stones'];
    const run = (day: string, ...ids: string[]) => send('EVAL', [c.CONTAINER_KEY_DESTROY, String(keys.length), ...keys, B, day, ...ids]);
    await send('HSET', ['registry', B, '{}']);
    expect(await run('2026-10-17', 'k1-aaaaaaaa')).toBe(-1);
    expect(await send('EXISTS', ['map', 'stones'])).toBe(0);
    await send('HDEL', ['registry', B]);
    await send('HSET', ['keys', 'k1-aaaaaaaa', `{"container":"${B}"}`, 'k2-bbbbbbbb', `{"container":"${A}"}`]);
    await send('HSET', ['stones', 'k4-dddddddd', `{"container":"${A}","on":"2026-01-01"}`]);
    expect(await run('2026-10-17', 'k1-aaaaaaaa', 'k2-bbbbbbbb', 'k3-cccccccc', 'k4-dddddddd')).toEqual(['k1-aaaaaaaa', 'k3-cccccccc']);
    expect(await send('HKEYS', ['keys'])).toEqual(['k2-bbbbbbbb']);
    expect(await send('HGET', ['stones', 'k1-aaaaaaaa'])).toBe(`{"container":"${B}","on":"2026-10-17"}`);
    expect(await send('HGET', ['stones', 'k3-cccccccc'])).toBe(`{"container":"${B}","on":"2026-10-17"}`);
    expect(await send('HGET', ['map', B])).toBe('{"destroyed":"2026-10-17"}');
    // Again, another day: the same answer, nothing rewritten.
    expect(await run('2026-10-18', 'k1-aaaaaaaa', 'k3-cccccccc')).toEqual(['k1-aaaaaaaa', 'k3-cccccccc']);
    expect(await send('HGET', ['stones', 'k1-aaaaaaaa'])).toBe(`{"container":"${B}","on":"2026-10-17"}`);
    expect(await send('HGET', ['map', B])).toBe('{"destroyed":"2026-10-17"}');
    expect(await run('2026-10-18')).toEqual([]);
  });

  test('a map entry is read exactly, and written only while it still holds what was read', async () => {
    expect(await send('EVAL', [c.CONTAINER_ENTRY_READ, '1', 'map', B])).toBe('');
    expect(await send('EVAL', [c.CONTAINER_ENTRY_UPDATE, '1', 'map', B, 'x', '{"a":1}'])).toBe(0);
    expect(await send('EVAL', [c.CONTAINER_ENTRY_UPDATE, '1', 'map', B, '', '{"a":1}'])).toBe(1);
    expect(await send('EVAL', [c.CONTAINER_ENTRY_READ, '1', 'map', B])).toBe('v{"a":1}');
    expect(await send('EVAL', [c.CONTAINER_ENTRY_UPDATE, '1', 'map', B, '{"a":2}', '{"a":3}'])).toBe(0);
    expect(await send('EVAL', [c.CONTAINER_ENTRY_UPDATE, '1', 'map', B, '{"a":1}', '{"a":3}'])).toBe(1);
    expect(await send('HGET', ['map', B])).toBe('{"a":3}');
  });

  test('a container’s key made, used and destroyed through the client, as on the double', async () => {
    await send('HSET', [registryKey(), B, registryRecord(false)]);
    const p = (await c.prepareContainerKey(B, { born: false }))!;
    expect((await c.claimContainerKey(p)).outcome).toBe('made');
    const v = await c.encrypt(ctxB, 'real');
    expect(c.formatOf(v).keyId).toBe(p.id);
    expect(await c.decrypt(ctxB, v)).toBe('real');
    expect(await c.updateContainerEntry(B, (e) => (e && 'key' in e ? { ...e, moved: ISO } : null))).toMatchObject({ key: p.id, moved: ISO });
    await send('HDEL', [registryKey(), B]);
    expect(await c.destroyContainerKeys(ctxB, Date.parse('2026-10-17T00:00:00.000Z'))).toEqual({ destroyed: [p.id] });
    expect(await send('HEXISTS', [c.keysHashKey(), p.id])).toBe(0);
    expect(await c.readTombstones()).toEqual(new Map([[p.id, { container: B, on: '2026-10-17' }]]));
    expect((await quietly(() => c.encrypt(ctxB, 'late'))).error).toBeInstanceOf(c.ContainerKeyError);
  });

  test('the next key number past 200,000 keys, read a page at a time', async () => {
    const total = 200_000;
    for (let start = 0; start < total; start += 5000) {
      const args = [c.keysHashKey()];
      for (let n = start + 1; n <= start + 5000; n++) args.push(`k${n}-${n.toString(16).padStart(8, '0')}`, '{}');
      await send('HSET', args);
    }
    expect(await c.nextKeyNumber()).toBe(total + 1);
    expect(await c.nextKeyNumber()).toBe(total + 2);
  }, 60_000);
});
