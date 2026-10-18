import { describe, expect, test, mock, beforeEach, afterEach } from 'bun:test';
import { createHash } from 'node:crypto';
import { FakeRedis, storageMock, ctxKey, testKey, TEST_CONTAINER } from './fake-redis';

// The key archives (lib/key-archive.ts): the key store's own backups, beside
// the nightly data archives of format 2, which leave it out (lib/export.ts,
// lib/backup.ts). Seven generations, no key dropped without a tombstone,
// checked before anything older goes, rewritten at a deletion, one writer at
// a time; and a restore of an older pair (lib/restore.ts).

process.env.PLAID_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');

// Raw, like the client a backup reads with: values exactly as stored.
const fake = new FakeRedis();
mock.module('@/lib/storage', () => storageMock(fake));

const c = await import('@/lib/crypto');
const ka = await import('@/lib/key-archive');
const { runBackup, backupFolder, keysLock, keysPending, rewriteKeyArchivesAfterDeletion, MIN_KEPT } = await import('@/lib/backup');
const { verifyArchive, restoreArchive, planRestore } = await import('@/lib/restore');
const { registryKey } = await import('@/lib/containers');
const { keyIdsByContainer, namedKeyIds } = await import('@/lib/archive-scan');
type BackupStore = import('@/lib/backup').BackupStore;

const MASTER = Buffer.alloc(32, 61).toString('base64');
const A = TEST_CONTAINER;
const B = '5d1c7e2a-9b3f-4c6d-8e1a-2b3c4d5e6f70';
const ctxA = { container: A } as any;
const ctxB = { container: B } as any;
const DAY = 86_400_000;
const T0 = Date.parse('2026-10-01T16:00:00.000Z');
const night = (n: number) => new Date(T0 + n * DAY);

/** Vercel Blob, kept in memory, with what each put was asked for, how often
 *  each file was read, and a clock of its own (the night a test runs), so
 *  copies age as the nights pass. */
function memoryStore() {
  const files = new Map<string, { body: string; uploadedAt: Date; opts?: { cacheMaxAgeSeconds?: number } }>();
  const store: BackupStore & {
    files: typeof files;
    reads: Map<string, number>;
    clock?: number;
    onPut?: (pathname: string) => Promise<void> | void;
    corrupt?: (pathname: string) => boolean;
  } = {
    files,
    reads: new Map(),
    async put(pathname, body, _signal, opts) {
      if (files.has(pathname)) throw new Error(`exists: ${pathname}`);
      files.set(pathname, { body, uploadedAt: new Date(store.clock ?? Date.now()), opts });
      await store.onPut?.(pathname);
    },
    async get(pathname) {
      store.reads.set(pathname, (store.reads.get(pathname) ?? 0) + 1);
      const f = files.get(pathname);
      if (!f) return null;
      return store.corrupt?.(pathname) ? f.body.slice(0, -2) + '\n' : f.body;
    },
    async list(prefix) {
      return [...files].filter(([p]) => p.startsWith(prefix)).map(([pathname, f]) => ({ pathname, uploadedAt: f.uploadedAt }));
    },
    async del(pathnames) {
      for (const p of pathnames) files.delete(p);
    },
  };
  return store;
}
type MemoryStore = ReturnType<typeof memoryStore>;
const keyFiles = (s: MemoryStore) => [...s.files.keys()].filter((p) => p.startsWith(ka.keyArchiveFolder())).sort();
const dataFiles = (s: MemoryStore) => [...s.files.keys()].filter((p) => p.startsWith(backupFolder())).sort();
const generations = async (s: MemoryStore) => (await ka.listGenerations(s)).generations;
const newest = async (s: MemoryStore) => ka.verifyKeyArchive((await s.get((await generations(s))[0].pathname))!);

const K0 = await crypto.subtle.importKey('raw', Buffer.alloc(32, 7), 'AES-GCM', false, ['encrypt']);
async function legacy(plain: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  return Buffer.concat([iv, new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, K0, new TextEncoder().encode(plain)))]).toString('base64');
}
async function register(...ids: string[]) {
  for (const id of ids) await fake.hset(registryKey(), { [id]: JSON.stringify({ status: 'active', primary: id === A, created_at: '2026-01-01T00:00:00.000Z' }) });
}
async function giveKey(container: string, born = false): Promise<string> {
  const p = (await c.prepareContainerKey(container as any, { born }))!;
  expect((await c.claimContainerKey(p)).outcome).toBe('made');
  return p.id;
}
const entryOf = (container: string) => {
  const v = fake.hashes.get(c.containerKeysKey())?.get(container);
  return v === undefined ? undefined : JSON.parse(v);
};
/** Deletes B the way an account deletion does: out of the registry, and its key destroyed. */
async function deleteB(now = night(100)) {
  await fake.hdel(registryKey(), B);
  for (const key of [...fake.strings.keys(), ...fake.hashes.keys()]) if (key.startsWith(ctxKey('', ctxB))) await fake.del(key);
  return c.destroyContainerKeys(ctxB, now.getTime());
}
const quietly = async <R>(fn: () => Promise<R>): Promise<R> => {
  const orig = console.error;
  console.error = () => {};
  try {
    return await fn();
  } finally {
    console.error = orig;
  }
};
const backup = (s: BackupStore, at: Date, opts: Parameters<typeof runBackup>[3] = {}) => {
  if ('reads' in s) (s as MemoryStore).clock = at.getTime();
  return runBackup(fake as any, s, at, opts);
};
/** The tombstones as the key store holds them. */
const tombstonesNow = () => new Map([...(fake.hashes.get(c.tombstonesKey()) ?? new Map<string, string>())].map(([id, raw]) => [id, JSON.parse(raw)]));
/** Damages a file at rest, keeping its name: cut short. */
const damage = (s: MemoryStore, pathname: string) => {
  const f = s.files.get(pathname)!;
  f.body = f.body.slice(0, -12) + '\n';
};
/** Every key a kept data archive names is held by the newest key archive, or
 *  tombstoned there: what a restore of any of them needs. */
async function expectEveryNamedKeyHeld(s: MemoryStore) {
  const keys = await newest(s);
  const missing: string[] = [];
  for (const p of dataFiles(s)) {
    for (const id of namedKeyIds(keyIdsByContainer(verifyArchive(s.files.get(p)!.body).records))) {
      if (id !== 'k0' && !keys.keys.has(id) && !keys.tombstones.has(id)) missing.push(`${p}: ${id}`);
    }
  }
  expect(missing).toEqual([]);
}

let keyB = '';
const saved = { ...process.env };
beforeEach(async () => {
  fake.reset();
  c.forgetActiveKey();
  process.env.MASTER_KEY = MASTER;
  process.env.BLOB_READ_WRITE_TOKEN = 'token';
  delete process.env.BACKUP_KEEP_DAYS;
  await register(A, B);
  // A writes under the environment's key and k0; B under a key of its own.
  fake.strings.set(ctxKey('goals', ctxA), await legacy('[{"id":"a"}]'));
  fake.strings.set(ctxKey('budgets', ctxA), await c.encrypt(ctxA, '{"a":1}'));
  keyB = await giveKey(B, true);
  fake.strings.set(ctxKey('goals', ctxB), await c.encrypt(ctxB, '[{"id":"b"}]'));
});
afterEach(() => {
  process.env = { ...saved };
});

describe('a key archive file', () => {
  const content = (): import('@/lib/key-archive').KeyArchiveContent => ({
    keys: new Map([
      ['k2-00000002', { record: '{"r":2}' }],
      ['k1-00000001', { record: '{"r":1}', missing_since: '2026-10-01T00:00:00.000Z', named_last: '2026-10-02T00:00:00.000Z' }],
    ]),
    tombstones: new Map([['k3-00000003', { container: B, on: '2026-10-02' }]]),
    beside: new Map([['crypto:key-seq', '3']]),
  });
  const header = { nya_keys: 1 as const, env_prefix: 'test', taken_at: '2026-10-03T00:00:00.000Z', written_at: '2026-10-03T00:00:01.000Z', master: null };
  const text = () => ka.serializeKeyArchive(header, content());
  const reseal = (lines: string[]) => {
    const body = lines.slice(0, -1);
    const sha = createHash('sha256').update(body.map((l) => l + '\n').join('')).digest('hex');
    return [...body, JSON.stringify({ end: true, lines: body.length - 1, sha256: sha })].join('\n') + '\n';
  };

  test('reads back as it was written, in the one order a file has', () => {
    const v = ka.verifyKeyArchive(text());
    expect([...v.keys.keys()]).toEqual(['k1-00000001', 'k2-00000002']);
    expect(v.keys.get('k1-00000001')).toEqual({ record: '{"r":1}', missing_since: '2026-10-01T00:00:00.000Z', named_last: '2026-10-02T00:00:00.000Z' });
    expect(v.tombstones.get('k3-00000003')).toEqual({ container: B, on: '2026-10-02' });
    expect(v.beside.get('crypto:key-seq')).toBe('3');
    expect(ka.serializeKeyArchive(v.header, v)).toBe(text());
  });

  test('refuses anything it can’t vouch for', () => {
    const lines = text().slice(0, -1).split('\n');
    expect(() => ka.verifyKeyArchive(text().replace(/\n/g, '\r\n'))).toThrow(/CRLF/);
    expect(() => ka.verifyKeyArchive(text().slice(0, -5))).toThrow(/cut short/);
    expect(() => ka.verifyKeyArchive(text().replace('{\\"r\\":2}', '{\\"r\\":9}'))).toThrow(/Checksum/);
    expect(() => ka.verifyKeyArchive(reseal([lines[0], lines[2], lines[1], ...lines.slice(3)]))).toThrow(/order/);
    expect(() => ka.verifyKeyArchive(reseal([lines[0], JSON.stringify({ something: 'else' }), ...lines.slice(1)]))).toThrow(/not a key, a tombstone/);
    expect(() => ka.verifyKeyArchive(reseal([lines[0], JSON.stringify({ string: 'crypto:rotation-lock', value: 'x' }), ...lines.slice(1)]))).toThrow(/beside/);
    expect(() => ka.verifyKeyArchive(reseal([lines[0], lines[1], lines[1], ...lines.slice(2)]))).toThrow(/repeats/);
    expect(() => ka.verifyKeyArchive('{"nya_export":2}\n{"end":true}\n')).toThrow(/data archive/);
    // When a carried key was last named: only on a carried key, never before it was first missed, and neither after the generation was taken.
    const carried = (line: object) => reseal([lines[0], JSON.stringify({ key: 'k1-00000001', record: '{"r":1}', ...line }), ...lines.slice(2)]);
    expect(() => ka.verifyKeyArchive(carried({ named_last: '2026-10-02T00:00:00.000Z' }))).toThrow(/invalid named_last/);
    expect(() => ka.verifyKeyArchive(carried({ missing_since: '2026-10-02T00:00:00.000Z', named_last: '2026-10-01T00:00:00.000Z' }))).toThrow(/invalid named_last/);
    expect(() => ka.verifyKeyArchive(carried({ missing_since: '2026-10-01T00:00:00.000Z', named_last: '2026-10-04T00:00:00.000Z' }))).toThrow(/dated after its generation was taken/);
    expect(() => ka.verifyKeyArchive(carried({ missing_since: 'October 1' }))).toThrow(/invalid missing_since/);
  });

  test('a rewrite is the file before it with the destroyed keys’ lines dropped and their tombstones added, and anything else is refused', () => {
    const old = ka.verifyKeyArchive(text());
    const stones = new Map([['k2-00000002', { container: A, on: '2026-10-05' }]]);
    const next = ka.rewriteGeneration(old, stones, new Date('2026-10-05T00:00:00.000Z'))!;
    const v = ka.checkRewrite(old, next, stones);
    expect([...v.keys.keys()]).toEqual(['k1-00000001']);
    expect(v.tombstones.get('k2-00000002')).toEqual({ container: A, on: '2026-10-05' });
    expect(v.header.taken_at).toBe(old.header.taken_at);
    expect(ka.rewriteGeneration(old, new Map(), new Date())).toBeNull(); // nothing to drop
    expect(ka.rewriteGeneration(old, old.tombstones, new Date())).toBeNull(); // nor any tombstone to add
    // A tombstone of a key it never held is added too, so its name says it holds every one.
    const other = new Map([...stones, ['k9-00000009', { container: B, on: '2026-10-05' }]]);
    const both = ka.checkRewrite(old, ka.rewriteGeneration(old, other, new Date('2026-10-05T00:00:00.000Z'))!, other);
    expect([...both.tombstones.keys()].sort()).toEqual(['k2-00000002', 'k3-00000003', 'k9-00000009']);
    expect(() => ka.checkRewrite(old, next, other)).toThrow(/lacks the tombstone of k9-00000009/);
    // Tampered: another key dropped too, a record changed, a key gained.
    const keep = (k: Map<string, any>) => ({ ...old, keys: k });
    const bad = [
      ka.serializeKeyArchive({ ...old.header, written_at: '2026-10-05T00:00:00.000Z' }, { ...keep(new Map()), tombstones: v.tombstones }),
      ka.serializeKeyArchive({ ...old.header, written_at: '2026-10-05T00:00:00.000Z' }, { ...keep(new Map([['k1-00000001', { record: '{"r":7}', missing_since: '2026-10-01T00:00:00.000Z' }]])), tombstones: v.tombstones }),
      ka.serializeKeyArchive({ ...old.header, written_at: '2026-10-05T00:00:00.000Z' }, { ...keep(new Map([...v.keys, ['k9-00000009', { record: '{}' }]])), tombstones: v.tombstones }),
      ka.serializeKeyArchive({ ...old.header, written_at: '2026-10-05T00:00:00.000Z' }, { ...keep(v.keys), tombstones: old.tombstones }),
    ];
    for (const t of bad) expect(() => ka.checkRewrite(old, t, stones)).toThrow(KeyArchiveRefusedOrError());
  });
});

/** Any refusal of a rewrite. */
function KeyArchiveRefusedOrError() {
  return /rewritten key archive|key archive/;
}

describe('the nightly key archive', () => {
  test('is written after the data archive, outside its folder, briefly cached, and holds what the data archive leaves out', async () => {
    const s = memoryStore();
    const r = await backup(s, night(0));
    expect(dataFiles(s)).toEqual([`${backupFolder()}nya-2026-10-01T16-00-00-000Z.f2.ndjson`]);
    expect(keyFiles(s)).toEqual([r.key_archive.pathname]);
    expect(s.files.get(r.key_archive.pathname)!.opts).toEqual({ cacheMaxAgeSeconds: 60 });
    expect(s.files.get(r.pathname)!.opts).toBeUndefined();
    const keys = ka.verifyKeyArchive(s.files.get(r.key_archive.pathname)!.body);
    expect([...keys.keys.keys()].sort()).toEqual([...fake.hashes.get(c.keysHashKey())!.keys()].sort());
    expect(keys.keys.get(keyB)!.record).toBe(fake.hashes.get(c.keysHashKey())!.get(keyB)!);
    expect([...keys.beside.keys()].sort()).toEqual(['crypto:active', 'crypto:key-seq', 'crypto:master']);
    const data = verifyArchive(s.files.get(r.pathname)!.body);
    expect(data.records.map((x) => x.key).filter((k) => k.startsWith('crypto:'))).toEqual(['crypto:container-keys']);
  });

  test('seven generations are kept, the oldest deleted only once the new one is checked', async () => {
    const s = memoryStore();
    for (let n = 0; n < 10; n++) await backup(s, night(n));
    const kept = await generations(s);
    expect(kept).toHaveLength(ka.KEY_GENERATIONS);
    expect(kept.at(-1)!.taken).toBe('2026-10-04T16-00-00-000Z');
    // A night whose key archive fails its check deletes nothing at all.
    const before = keyFiles(s);
    const record = JSON.parse(fake.hashes.get(c.keysHashKey())!.get(keyB)!);
    record.wrapped[Object.keys(record.wrapped)[0]] = record.wrapped[Object.keys(record.wrapped)[0]].replace(/^./, (ch: string) => (ch === 'A' ? 'B' : 'A'));
    fake.hashes.get(c.keysHashKey())!.set(keyB, JSON.stringify(record));
    c.forgetActiveKey();
    await expect(backup(s, night(10))).rejects.toThrow(/doesn.t open with this master/);
    expect(keyFiles(s).filter((p) => before.includes(p))).toEqual(before);
    expect((await generations(s)).length).toBe(ka.KEY_GENERATIONS + 1); // tonight's, unchecked, beside them
    expect(dataFiles(s).length).toBeGreaterThanOrEqual(MIN_KEPT); // and the data archive is kept
  });

  test('a key that leaves the store without a tombstone is carried forward until no data archive kept can need it', async () => {
    process.env.BACKUP_KEEP_DAYS = '3'; // so the newest seven data archives are what is kept
    const s = memoryStore();
    await backup(s, night(0));
    const lost = keyB;
    fake.hashes.get(c.keysHashKey())!.delete(lost); // by hand, or a bug
    const r1 = await quietly(() => backup(s, night(1)));
    expect(r1.key_archive.carried).toEqual([lost]);
    expect((await newest(s)).keys.get(lost)).toEqual({ record: expect.any(String), missing_since: night(1).toISOString(), named_last: night(1).toISOString() });
    // Still named by a value: carried, however long, and dated each night.
    for (let n = 2; n <= 12; n++) await quietly(() => backup(s, night(n)));
    expect((await newest(s)).keys.get(lost)).toMatchObject({ missing_since: night(1).toISOString(), named_last: night(12).toISOString() });
    // Named by nothing from night 13, but the data archives of nights 6 to 12
    // still name it: carried until the oldest kept is newer than night 12.
    fake.strings.delete(ctxKey('goals', ctxB));
    for (let n = 13; n <= 19; n++) {
      const r = await quietly(() => backup(s, night(n)));
      expect(r.key_archive.let_go).toEqual([]);
      expect((await newest(s)).keys.get(lost)!.named_last).toBe(night(12).toISOString());
      await expectEveryNamedKeyHeld(s);
    }
    const r = await quietly(() => backup(s, night(20)));
    expect(r.key_archive.let_go).toEqual([lost]);
    expect((await newest(s)).keys.has(lost)).toBe(false);
    await expectEveryNamedKeyHeld(s);
  });

  test('with the default retention, a key named for longer than a copy is kept is never dropped while a kept data archive names it', async () => {
    // The review's probe: the key leaves the store on night 1, the value
    // naming it on night 41, and copies are kept 30 days.
    const s = memoryStore();
    await backup(s, night(0));
    const lost = keyB;
    fake.hashes.get(c.keysHashKey())!.delete(lost);
    let goneOn = -1;
    for (let n = 1; n <= 75; n++) {
      if (n === 41) fake.strings.delete(ctxKey('goals', ctxB));
      const r = await quietly(() => backup(s, night(n)));
      if (r.key_archive.let_go.includes(lost)) goneOn = n;
      await expectEveryNamedKeyHeld(s);
    }
    // Night 40's data archive, the last to name it, is pruned on night 71.
    expect(goneOn).toBe(72);
  });

  test('a night whose key archive failed counts as naming every key carried, until its data archive is pruned', async () => {
    process.env.BACKUP_KEEP_DAYS = '3';
    const s = memoryStore();
    await backup(s, night(0));
    const lost = keyB;
    fake.hashes.get(c.keysHashKey())!.delete(lost);
    await quietly(() => backup(s, night(1)));
    // Night 2's data archive names it, but no key archive records that.
    await fake.set(testKey('backups:keys-lock'), 'another writer');
    await expect(quietly(() => backup(s, night(2), { keysLockWaitMs: 10 }))).rejects.toThrow(/another writer held the lock/);
    await fake.del(testKey('backups:keys-lock'));
    fake.strings.delete(ctxKey('goals', ctxB));
    await quietly(() => backup(s, night(3)));
    expect((await newest(s)).keys.get(lost)!.named_last).toBe(night(2).toISOString());
    let goneOn = -1;
    for (let n = 4; n <= 12; n++) {
      if ((await quietly(() => backup(s, night(n)))).key_archive.let_go.includes(lost)) goneOn = n;
      await expectEveryNamedKeyHeld(s);
    }
    // Night 2's data archive is pruned on night 9; from night 1's alone it would have gone then.
    expect(goneOn).toBe(10);
  });

  test('a generation that isn’t what the store and the one before make it is deleted, so no night builds on it', async () => {
    const s = memoryStore();
    await backup(s, night(0));
    fake.hashes.get(c.keysHashKey())!.delete(keyB);
    await quietly(() => backup(s, night(1)));
    const before = keyFiles(s);
    // A fault in building it, simulated: the night's values name the carried
    // key once the generation was built without saying so.
    const named = new Set<string>();
    s.onPut = (p) => void (p.startsWith(ka.keyArchiveFolder()) && named.add(keyB));
    const write = ka.writeKeyArchive(fake as any, s, keysLock, { takenAt: night(2), named, kept: [night(2).toISOString()], maxDays: 31 });
    await expect(write).rejects.toBeInstanceOf(ka.KeyArchiveIncomplete);
    await expect(write).rejects.toThrow(`${keyB} is carried forward without when a data archive last named it`);
    expect(keyFiles(s)).toEqual(before);
  });

  test('what is checked: a generation that isn’t what the store and the one before make it is incomplete; a problem of the store’s is refused', async () => {
    const live = await ka.readLiveKeyStore(fake as any);
    const header = { nya_keys: 1 as const, env_prefix: 'test', taken_at: night(1).toISOString(), written_at: night(1).toISOString(), master: null };
    const of = (content: import('@/lib/key-archive').KeyArchiveContent) => ka.verifyKeyArchive(ka.serializeKeyArchive(header, content));
    const check = (written: ReturnType<typeof of>, previous: ReturnType<typeof of> | null = null, named = new Set<string>()) =>
      ka.checkGeneration(written, { named, previous, live, letGo: [], kept: [night(1).toISOString()], maxDays: 31 });
    await expect(check(of(live))).resolves.toBeUndefined();
    const without = new Map(live.keys);
    without.delete(keyB);
    await expect(check(of({ ...live, keys: without }))).rejects.toThrow(new ka.KeyArchiveIncomplete(`${keyB}, in the key store, is missing from the new key archive.`));
    await expect(check(of({ ...live, keys: new Map([...live.keys, ['k9-00000009', { record: '{}' }]]) }))).rejects.toBeInstanceOf(ka.KeyArchiveIncomplete);
    const before = of({ ...live, keys: new Map([...live.keys, ['k9-00000009', { record: '{}' }]]) });
    await expect(check(of(live), before)).rejects.toThrow(new ka.KeyArchiveIncomplete('k9-00000009, in the generation before, is missing from the new key archive.'));
    await expect(check(of({ ...live, tombstones: new Map() }), of({ ...live, tombstones: new Map([['k8-00000008', { container: B, on: '2026-10-01' }]]) }))).rejects.toThrow(/tombstone of k8-00000008 is missing/);
    // A value naming a key nothing holds: the file is the store as it stands, so refused, not incomplete.
    const refused = await check(of(live), null, new Set(['k77-deadbeef'])).catch((e) => e);
    expect(refused).toBeInstanceOf(ka.KeyArchiveRefused);
    expect(refused).not.toBeInstanceOf(ka.KeyArchiveIncomplete);
  });

  test('a value under a key neither the store nor the archives hold fails the run', async () => {
    fake.strings.set(ctxKey('budgets', ctxB), `v2.k77-deadbeef.-.${'A'.repeat(40)}`);
    fake.checkCiphertext = false;
    await expect(backup(memoryStore(), night(0))).rejects.toThrow(/k77-deadbeef, which the key archive neither holds nor marks destroyed/);
  });

  test('a key archive that doesn’t read back as written is deleted, and nothing older goes', async () => {
    const s = memoryStore();
    for (let n = 0; n < 8; n++) await backup(s, night(n));
    const before = keyFiles(s);
    s.corrupt = (p) => p.startsWith(ka.keyArchiveFolder()) && p.includes('2026-10-09T16');
    await expect(backup(s, night(8))).rejects.toThrow(/did not read back/);
    expect(keyFiles(s)).toEqual(before);
  });

  test('without a master, a key archive of tombstones alone is kept; one with keys can’t be checked', async () => {
    delete process.env.MASTER_KEY;
    c.forgetActiveKey();
    await expect(backup(memoryStore(), night(0))).rejects.toThrow(/can.t be checked/);
    fake.hashes.delete(c.keysHashKey());
    fake.strings.delete(ctxKey('goals', ctxB));
    fake.strings.delete(ctxKey('budgets', ctxA));
    const r = await backup(memoryStore(), night(0));
    expect(r.key_archive.keys).toBe(0);
  });
});

describe('a destroyed key leaves every key archive', () => {
  test('at the deletion: every generation rewritten, as a pure filter of itself, and the files it replaces deleted', async () => {
    const s = memoryStore();
    for (let n = 0; n < 3; n++) await backup(s, night(n));
    const olds = await Promise.all((await generations(s)).map(async (g) => ka.verifyKeyArchive((await s.get(g.pathname))!)));
    for (const g of olds) expect(g.keys.has(keyB)).toBe(true);
    await deleteB();
    const at = await rewriteKeyArchivesAfterDeletion(s, B);
    expect(at).toEqual({ rewritten_at: expect.any(String) });
    const after = await generations(s);
    expect(after).toHaveLength(3);
    expect(keyFiles(s)).toHaveLength(3); // the files replaced are gone
    for (const [i, g] of after.entries()) {
      const v = ka.verifyKeyArchive((await s.get(g.pathname))!);
      expect(v.keys.has(keyB)).toBe(false);
      expect(v.tombstones.get(keyB)).toEqual({ container: B, on: night(100).toISOString().slice(0, 10) });
      expect([...v.keys.keys()]).toEqual([...olds[i].keys.keys()].filter((k) => k !== keyB));
      expect(v.header.taken_at).toBe(olds[i].header.taken_at);
      expect(s.files.get(g.pathname)!.opts).toEqual({ cacheMaxAgeSeconds: 60 });
    }
    // And the next night's generation is born without it.
    await backup(s, night(3));
    expect((await newest(s)).keys.has(keyB)).toBe(false);
  });

  test('one writer at a time: a deletion that can’t take the lock leaves the rewrite to the next nightly run, which does it and clears the marker', async () => {
    const s = memoryStore();
    await backup(s, night(0));
    await deleteB();
    await fake.set(testKey('backups:keys-lock'), 'the nightly run');
    expect(await quietly(() => rewriteKeyArchivesAfterDeletion(s, B, { lockWaitMs: 10 }))).toEqual({ pending: true });
    expect(await keysPending()).toEqual({ since: expect.any(String), containers: [B] });
    expect((await newest(s)).keys.has(keyB)).toBe(true); // not yet
    // While it is held, the nightly run waits, then fails rather than write beside it.
    await expect(backup(s, night(1), { keysLockWaitMs: 10 })).rejects.toThrow(/another writer held the lock/);
    await fake.del(testKey('backups:keys-lock'));
    const r = await backup(s, night(2));
    expect(r.key_archive.rewritten.length).toBeGreaterThan(0);
    for (const g of await generations(s)) expect(ka.verifyKeyArchive((await s.get(g.pathname))!).keys.has(keyB)).toBe(false);
    expect(await keysPending()).toBeNull();
  });

  test('a key destroyed while the nightly run writes is still out of every generation when it finishes', async () => {
    const s = memoryStore();
    await backup(s, night(0));
    let once = false;
    s.onPut = async (p) => {
      if (!once && p.startsWith(ka.keyArchiveFolder())) {
        once = true;
        await deleteB();
      }
    };
    await quietly(() => backup(s, night(1)));
    for (const g of await generations(s)) expect(ka.verifyKeyArchive((await s.get(g.pathname))!).keys.has(keyB)).toBe(false);
  });

  test('a marker that can’t be read still says a rewrite is owed, and the nightly run that does it clears it', async () => {
    await fake.set(testKey('backups:keys-pending'), 'not a marker');
    expect(await keysPending()).toEqual({ since: new Date(0).toISOString(), containers: [], unreadable: true });
    await backup(memoryStore(), night(0));
    expect(await keysPending()).toBeNull();
    // One written by hand in another order says the same, and is cleared too.
    await fake.set(testKey('backups:keys-pending'), JSON.stringify({ containers: [B], since: night(0).toISOString() }));
    await backup(memoryStore(), night(1));
    expect(await keysPending()).toBeNull();
    // A deletion adding to one that can't be read starts it afresh, dated now.
    await fake.set(testKey('backups:keys-pending'), '{"since":');
    await keysLock.markPending(B, night(2));
    expect(await keysPending()).toEqual({ since: night(2).toISOString(), containers: [B] });
  });

  test('the lock is released only by its holder', async () => {
    const token = (await keysLock.take(10))!;
    expect(await keysLock.take(10)).toBeNull();
    await keysLock.release('not the holder');
    expect(fake.strings.get(testKey('backups:keys-lock'))).toBe(token);
    await keysLock.release(token);
    expect(fake.strings.has(testKey('backups:keys-lock'))).toBe(false);
  });

  test('with no store kept, there is nothing to rewrite', async () => {
    await deleteB();
    expect(await rewriteKeyArchivesAfterDeletion(null, B)).toEqual({ none: true });
  });

  test('a file is read only when its name says it lacks a tombstone: a quiet night reads just the one it builds on', async () => {
    const s = memoryStore();
    for (let n = 0; n < 4; n++) await backup(s, night(n));
    const keyReads = () => [...s.reads].filter(([p]) => p.startsWith(ka.keyArchiveFolder()));
    s.reads.clear();
    const r = await backup(s, night(4));
    const [tonight, before] = await generations(s);
    // The newest before it, to build on, and tonight's, read back.
    expect(keyReads().sort()).toEqual([[before.pathname, 1], [r.key_archive.pathname, 1]].sort() as any);
    // A deletion reads and rewrites each once; the night after reads none of them again.
    await deleteB();
    s.reads.clear();
    expect(await rewriteKeyArchivesAfterDeletion(s, B)).toEqual({ rewritten_at: expect.any(String) });
    expect(keyReads().length).toBe(2 * 5); // each old file, and each rewrite read back
    for (const g of await generations(s)) expect(g.tombstones).toBe(ka.tombstoneDigest([keyB]));
    s.reads.clear();
    await backup(s, night(5));
    expect(keyReads().length).toBe(2);
    expect(tonight.pathname).not.toBe((await generations(s))[1].pathname); // rewritten since
  });
});

describe('a key archive that doesn’t read back intact', () => {
  test('one read cut short is read again', async () => {
    const s = memoryStore();
    for (let n = 0; n < 3; n++) await backup(s, night(n));
    const [top] = await generations(s);
    let once = true;
    s.corrupt = (p) => (p === top.pathname && once ? !(once = false) : false);
    await backup(s, night(3));
    expect(once).toBe(false);
    expect(await generations(s)).toHaveLength(4);
  });

  test('an older one is deleted, since a newer one holds what it held, and the rewrite is done', async () => {
    const s = memoryStore();
    for (let n = 0; n < 4; n++) await backup(s, night(n));
    const [, older] = await generations(s);
    damage(s, older.pathname);
    // A quiet night never reads it.
    await backup(s, night(4));
    expect(s.files.has(older.pathname)).toBe(true);
    // A deletion reads every file: it deletes that one and rewrites the rest.
    await deleteB();
    const errors: string[] = [];
    const log = console.error;
    console.error = (...a: unknown[]) => void errors.push(a.map(String).join(' '));
    try {
      expect(await rewriteKeyArchivesAfterDeletion(s, B)).toEqual({ rewritten_at: expect.any(String) });
    } finally {
      console.error = log;
    }
    expect(errors.join('\n')).toContain(`${older.pathname} doesn't read back intact`);
    expect(s.files.has(older.pathname)).toBe(false);
    expect(await generations(s)).toHaveLength(4);
    for (const g of await generations(s)) expect(ka.verifyKeyArchive((await s.get(g.pathname))!).keys.has(keyB)).toBe(false);
    // And the nightly runs go on.
    await backup(s, night(5));
  });

  test('the newest can’t be: a deletion leaves it for the nightly run, which fails naming it', async () => {
    const s = memoryStore();
    for (let n = 0; n < 2; n++) await backup(s, night(n));
    const [top] = await generations(s);
    damage(s, top.pathname);
    await deleteB();
    expect(await quietly(() => rewriteKeyArchivesAfterDeletion(s, B))).toEqual({ pending: true });
    await expect(quietly(() => backup(s, night(2)))).rejects.toThrow(`The newest key archive, ${top.pathname}, doesn't read back intact`);
    expect(s.files.has(top.pathname)).toBe(true);
  });

  test('the newest kept, damaged: the older ones are rewritten without the key all the same, and the run then fails naming it', async () => {
    const s = memoryStore();
    for (let n = 0; n < 3; n++) await backup(s, night(n));
    const [top, ...older] = await generations(s);
    damage(s, top.pathname);
    await deleteB();
    await expect(quietly(() => ka.rewriteGenerations(s, tombstonesNow(), night(3)))).rejects.toThrow(`The key archive ${top.pathname} doesn't read back intact`);
    // Kept, since it alone may hold a key; every other one without B's key.
    expect(s.files.has(top.pathname)).toBe(true);
    const now = await generations(s);
    expect(now.map((g) => g.taken)).toEqual([top, ...older].map((g) => g.taken));
    for (const g of now.slice(1)) {
      expect(g.pathname).not.toBe(older.find((o) => o.taken === g.taken)!.pathname);
      const held = ka.verifyKeyArchive((await s.get(g.pathname))!);
      expect([held.keys.has(keyB), held.tombstones.has(keyB)]).toEqual([false, true]);
    }
    // A deletion that meets it leaves the rest for the nightly run, as before.
    expect(await quietly(() => rewriteKeyArchivesAfterDeletion(s, B))).toEqual({ pending: true });
  });

  describe('the older files a rewrite that stopped left of a generation', () => {
    /** Three generations, each with an older file of its own beside its
     *  newest (the same keys, written a second before), as a rewrite that
     *  stopped before deleting what it replaced leaves them; and B deleted. */
    async function withOlderFiles() {
      const s = memoryStore();
      for (let n = 0; n < 3; n++) await backup(s, night(n));
      const gens = await generations(s);
      const older = gens.map((g) => {
        const f = s.files.get(g.pathname)!;
        const { header } = ka.verifyKeyArchive(f.body);
        const pathname = ka.keyArchiveName(header.taken_at, new Date(Date.parse(header.written_at) - 1000), []);
        s.files.set(pathname, { ...f });
        return pathname;
      });
      expect((await ka.listGenerations(s)).stale).toEqual([...older].sort());
      await deleteB();
      return { s, gens, older };
    }

    test('a run that finishes deletes them all', async () => {
      const { s, older } = await withOlderFiles();
      await ka.rewriteGenerations(s, tombstonesNow(), night(3));
      expect(older.map((p) => s.files.has(p))).toEqual([false, false, false]);
    });

    test('a run that fails on a kept one deletes those of the generations it rewrote, which hold the key just destroyed, and keeps the kept one’s', async () => {
      const { s, gens, older } = await withOlderFiles();
      damage(s, gens[0].pathname);
      await expect(quietly(() => ka.rewriteGenerations(s, tombstonesNow(), night(3)))).rejects.toThrow(`The key archive ${gens[0].pathname} doesn't read back intact`);
      // The kept one's older file may be the only one of it that reads.
      expect(older.map((p) => s.files.has(p))).toEqual([true, false, false]);
      expect(ka.verifyKeyArchive(s.files.get(older[0])!.body).keys.has(keyB)).toBe(true);
    });

    test('a deletion of them that fails never hides the run’s own failure, naming the kept one; the next run deletes them', async () => {
      const { s, gens, older } = await withOlderFiles();
      damage(s, gens[0].pathname);
      const del = s.del;
      s.del = async (pathnames, signal) => {
        if (pathnames.some((p) => older.includes(p))) throw new Error('store out of reach');
        return del(pathnames, signal);
      };
      await expect(quietly(() => ka.rewriteGenerations(s, tombstonesNow(), night(3)))).rejects.toThrow(`The key archive ${gens[0].pathname} doesn't read back intact`);
      expect(older.map((p) => s.files.has(p))).toEqual([true, true, true]);
      s.del = del;
      // The next run passes the two rewritten over by their names, so it
      // reads them for their older files: one that doesn't read back keeps
      // its own.
      const [, middle] = await generations(s);
      damage(s, middle.pathname);
      await expect(quietly(() => ka.rewriteGenerations(s, tombstonesNow(), night(4)))).rejects.toThrow(`The key archive ${gens[0].pathname} doesn't read back intact`);
      expect(older.map((p) => s.files.has(p))).toEqual([true, true, false]);
    });

    test('a read of them that fails never hides it either: what wasn’t read keeps its older files', async () => {
      const { s, gens, older } = await withOlderFiles();
      damage(s, gens[0].pathname);
      // A first run rewrites the older two, and can't delete what it leaves.
      const del = s.del;
      s.del = async (pathnames, signal) => {
        if (pathnames.some((p) => older.includes(p))) throw new Error('store out of reach');
        return del(pathnames, signal);
      };
      await expect(quietly(() => ka.rewriteGenerations(s, tombstonesNow(), night(3)))).rejects.toThrow(`The key archive ${gens[0].pathname} doesn't read back intact`);
      s.del = del;
      // The next run passes them over by their names, and can't read them for their older files.
      const [, ...rewritten] = await generations(s);
      const get = s.get;
      s.get = async (pathname, signal) => {
        if (rewritten.some((g) => g.pathname === pathname)) throw new Error('store out of reach');
        return get(pathname, signal);
      };
      await expect(quietly(() => ka.rewriteGenerations(s, tombstonesNow(), night(4)))).rejects.toThrow(`The key archive ${gens[0].pathname} doesn't read back intact`);
      expect(older.map((p) => s.files.has(p))).toEqual([true, true, true]);
    });
  });

  describe('a newer one passed over by its name', () => {
    /** Three generations, B deleted, and its rewrite stopped part way: the
     *  newest rewritten (its name holds every tombstone), the older two not. */
    async function stoppedPartWay() {
      const s = memoryStore();
      for (let n = 0; n < 3; n++) await backup(s, night(n));
      await deleteB();
      const put = s.put;
      let puts = 0;
      s.put = async (...args) => {
        if (++puts === 2) throw new Error('cut off');
        return put(...args);
      };
      await expect(quietly(() => ka.rewriteGenerations(s, tombstonesNow(), night(3)))).rejects.toThrow('cut off');
      s.put = put;
      const [top, middle, oldest] = await generations(s);
      expect([top, middle, oldest].map((g) => ka.verifyKeyArchive(s.files.get(g.pathname)!.body).tombstones.has(keyB))).toEqual([true, false, false]);
      return { s, top, middle, oldest };
    }

    test('counts as intact once it reads back intact: an older one that doesn’t is deleted on its strength', async () => {
      const { s, top, middle } = await stoppedPartWay();
      damage(s, middle.pathname);
      const before = s.reads.get(top.pathname) ?? 0;
      const { dropped } = await quietly(() => ka.rewriteGenerations(s, tombstonesNow(), night(4)));
      expect(dropped).toEqual([middle.pathname]);
      expect(s.reads.get(top.pathname)).toBeGreaterThan(before);
    });

    test('never on its name alone: damaged too, the older one is kept and the run fails naming it, the oldest rewritten all the same', async () => {
      const { s, top, middle, oldest } = await stoppedPartWay();
      damage(s, top.pathname);
      damage(s, middle.pathname);
      await expect(quietly(() => ka.rewriteGenerations(s, tombstonesNow(), night(4)))).rejects.toThrow(`The key archive ${middle.pathname} doesn't read back intact`);
      expect([s.files.has(top.pathname), s.files.has(middle.pathname)]).toEqual([true, true]);
      const rewritten = (await generations(s)).find((g) => g.taken === oldest.taken)!;
      expect(rewritten.pathname).not.toBe(oldest.pathname);
      expect(ka.verifyKeyArchive(s.files.get(rewritten.pathname)!.body).keys.has(keyB)).toBe(false);
    });
  });
});

describe('the nightly count, from the values’ headers', () => {
  test('a moved container with a value under a shared key is dated by the archive, and walked again by the pass', async () => {
    const keyA = await giveKey(A);
    await c.updateContainerEntry(A, (e) => (e && 'key' in e ? { ...e, moved: '2026-10-01T00:00:00.000Z' } : null));
    const r = await backup(memoryStore(), night(1));
    expect(r.shared_in).toEqual([A]); // the values A wrote before its key are still under the shared ones
    expect(entryOf(A)).toEqual({ key: keyA, since: expect.any(String), shared_in: night(1).toISOString() });
    // B, all under its own key, is left as it was: moved from its birth.
    expect(entryOf(B).moved).toBe(entryOf(B).since);
    expect(entryOf(B).shared_in).toBeUndefined();
  });

  test('an archive the release before took after a container’s key was made holds the key: it is dated apart, and the pass walks the container again', async () => {
    const s = memoryStore();
    const since = entryOf(B).since as string;
    const later = new Date(Date.parse(since) + 3_600_000);
    await s.put(`${backupFolder()}nya-${later.toISOString().replace(/[:.]/g, '-')}.ndjson`, 'format 1');
    const r = await backup(s, new Date(Date.parse(since) + DAY));
    expect(r.rollback_noted).toEqual([B]);
    expect(entryOf(B)).toEqual({ key: keyB, since, key_in: later.toISOString() });
    // Noted once; a value under a shared key found later keeps it.
    fake.strings.set(ctxKey('budgets', ctxB), await legacy('{}'));
    const r2 = await backup(s, new Date(Date.parse(since) + 2 * DAY));
    expect(r2.rollback_noted).toEqual([]);
    expect(r2.shared_in).toEqual([B]);
    expect(entryOf(B)).toEqual({ key: keyB, since, shared_in: new Date(Date.parse(since) + 2 * DAY).toISOString(), key_in: later.toISOString() });
  });

  test('an archive the release before took before a container’s key was made says nothing of it', async () => {
    const s = memoryStore();
    const since = entryOf(B).since as string;
    await s.put(`${backupFolder()}nya-${new Date(Date.parse(since) - 3_600_000).toISOString().replace(/[:.]/g, '-')}.ndjson`, 'format 1');
    expect((await backup(s, new Date(Date.parse(since) + DAY))).rollback_noted).toEqual([]);
    expect(entryOf(B).key_in).toBeUndefined();
    expect(entryOf(B).moved).toBe(since);
  });
});

describe('restoring an older pair', () => {
  test('a data archive five nights old restores with the newest key archive, and a deleted account stays deleted', async () => {
    const s = memoryStore();
    for (let n = 0; n < 8; n++) await backup(s, night(n));
    const oldData = verifyArchive((await s.get(`${backupFolder()}nya-${night(2).toISOString().replace(/[:.]/g, '-')}.f2.ndjson`))!);
    await deleteB();
    await rewriteKeyArchivesAfterDeletion(s, B);
    const keys = await newest(s);
    expect(keys.keys.has(keyB)).toBe(false);
    // The old data archive still holds B: the plan leaves it out.
    expect(oldData.records.some((r) => r.key.startsWith(`c:${B}:`))).toBe(true);
    const plan = planRestore(oldData, keys, { tombstones: new Map(), keySeq: null });
    expect(plan.left_out).toEqual([B]);
    expect(plan.records.some((r) => r.key.startsWith(`c:${B}:`))).toBe(false);
    expect(Object.keys((plan.records.find((r) => r.key === 'containers') as any).value)).toEqual([A]);
    expect(JSON.parse((plan.records.find((r) => r.key === 'crypto:container-keys') as any).value[B])).toEqual({ destroyed: night(100).toISOString().slice(0, 10) });

    // Restored into an empty database: A reads as it was, and B is nowhere.
    const goalsA = fake.strings.get(ctxKey('goals', ctxA))!;
    fake.reset();
    c.forgetActiveKey();
    await restoreArchive(fake as any, oldData, { overwrite: false, keys });
    expect(fake.strings.get(ctxKey('goals', ctxA))).toBe(goalsA);
    expect(await c.decrypt(ctxA, fake.strings.get(ctxKey('budgets', ctxA))!)).toBe('{"a":1}');
    expect([...fake.strings.keys(), ...fake.hashes.keys()].filter((k) => k.includes(B))).toEqual([]);
    expect(fake.hashes.get(c.tombstonesKey())!.has(keyB)).toBe(true);
    expect(fake.hashes.get(c.keysHashKey())!.has(keyB)).toBe(false);
    // Any of the seven generations would have done: each was rewritten.
    for (const g of await generations(s)) expect(planRestore(oldData, ka.verifyKeyArchive((await s.get(g.pathname))!), { tombstones: new Map(), keySeq: null }).left_out).toEqual([B]);
  });
});

describe('a restore with its key archive', () => {
  const dataOf = async (s: MemoryStore, n: number) => verifyArchive((await s.get(`${backupFolder()}nya-${night(n).toISOString().replace(/[:.]/g, '-')}.f2.ndjson`))!);
  const keysOf = async (s: MemoryStore, n: number) => {
    const g = (await generations(s)).find((x) => x.taken === night(n).toISOString().replace(/[:.]/g, '-'))!;
    return ka.verifyKeyArchive((await s.get(g.pathname))!);
  };
  const noTarget = { tombstones: new Map(), keySeq: null };

  test('a data archive whose values need its key archive is refused without one, or with one older than a key it needs', async () => {
    const s = memoryStore();
    await backup(s, night(0));
    expect(() => planRestore(verifyArchive(dataFiles(s).length ? s.files.get(dataFiles(s)[0])!.body : ''), null, noTarget)).toThrow(/pass --keys/);
    // A key made after night 0, with a value under it by night 1.
    const C = 'c0ffee00-1111-4222-8333-444455556666';
    await register(C);
    await giveKey(C, true);
    fake.strings.set(ctxKey('goals', { container: C }), await c.encrypt({ container: C } as any, '[]'));
    await backup(s, night(1));
    const [data1, keys0] = [await dataOf(s, 1), await keysOf(s, 0)];
    expect(() => planRestore(data1, keys0, noTarget)).toThrow(/neither holds nor marks destroyed\. Use a newer key archive/);
    expect(planRestore(await dataOf(s, 1), await keysOf(s, 1), noTarget).left_out).toEqual([]);
  });

  test('the target’s own tombstones leave a deleted account out, even with a key archive from before the deletion', async () => {
    const s = memoryStore();
    await backup(s, night(0));
    const data = await dataOf(s, 0);
    const keys = await keysOf(s, 0);
    expect(keys.keys.has(keyB)).toBe(true);
    await deleteB();
    const { targetKeys } = await import('@/lib/restore');
    const result = await restoreArchive(fake as any, data, { overwrite: true, backedUp: await targetKeys(fake as any), keys });
    expect(result.plan.left_out).toEqual([B]);
    expect(fake.hashes.get(c.keysHashKey())!.has(keyB)).toBe(false);
    expect(fake.hashes.get(c.tombstonesKey())!.has(keyB)).toBe(true);
    expect([...fake.strings.keys(), ...fake.hashes.keys()].filter((k) => k.startsWith(ctxKey('', ctxB)))).toEqual([]);
    expect(JSON.parse(fake.hashes.get(c.containerKeysKey())!.get(B)!)).toEqual({ destroyed: night(100).toISOString().slice(0, 10) });
  });

  test('a format-1 archive, the release before’s, restores alone, and a deleted account is left out of it too', async () => {
    const { exportLines } = await import('@/lib/export');
    // What the release before writes: format 1, the key store inside.
    let text = '';
    for await (const line of exportLines(fake as any)) text += line;
    const lines = text.slice(0, -1).split('\n');
    const header = { ...JSON.parse(lines[0]), nya_export: 1 };
    delete header.keys_apart;
    const keyStore = { key: 'crypto:keys', type: 'hash', ttl: null, value: Object.fromEntries(fake.hashes.get(c.keysHashKey())!) };
    const body = [JSON.stringify(header), JSON.stringify(keyStore), ...lines.slice(1, -1)].sort((a, b) => (a === JSON.stringify(header) ? -1 : b === JSON.stringify(header) ? 1 : 0));
    const sha = createHash('sha256').update(body.map((l) => l + '\n').join('')).digest('hex');
    const format1 = verifyArchive([...body, JSON.stringify({ end: true, keys: body.length - 1, sha256: sha, unsupported: [] })].join('\n') + '\n');
    expect(() => planRestore(format1, ka.verifyKeyArchive(ka.serializeKeyArchive({ nya_keys: 1, env_prefix: 'test', taken_at: night(0).toISOString(), written_at: night(0).toISOString(), master: null }, { keys: new Map(), tombstones: new Map(), beside: new Map() })), noTarget)).toThrow(/without --keys/);
    await deleteB();
    const target = { tombstones: await c.readTombstones(), keySeq: null };
    const plan = planRestore(format1, null, target);
    expect(plan.left_out).toEqual([B]);
    expect(plan.keyStore.keys.has(keyB)).toBe(false);
    expect([...plan.keyStore.keys.keys()].length).toBeGreaterThan(0); // the environment's key comes back
    expect(plan.records.some((r) => r.key === 'crypto:keys')).toBe(false);
  });

  test('a container whose key was made after the key archive, with nothing under it, is restored without its map entry', async () => {
    const s = memoryStore();
    await backup(s, night(0));
    const keyA = await giveKey(A); // nothing written under it yet
    await backup(s, night(1));
    const plan = planRestore(await dataOf(s, 1), await keysOf(s, 0), noTarget);
    expect(plan.maps_dropped).toEqual([A]);
    expect(plan.keyStore.keys.has(keyA)).toBe(false);
    const map = (plan.records.find((r) => r.key === 'crypto:container-keys') as any).value;
    expect(Object.keys(map)).toEqual([B]);
  });

  test('the keys of containers the data archive doesn’t have are left out of the live store', async () => {
    const s = memoryStore();
    await backup(s, night(0));
    const C = 'c0ffee00-1111-4222-8333-444455556666';
    await register(C);
    const keyC = await giveKey(C, true);
    await backup(s, night(1));
    const plan = planRestore(await dataOf(s, 0), await keysOf(s, 1), noTarget);
    expect(plan.keys_left_out).toEqual([keyC]);
    expect(plan.keyStore.keys.has(keyC)).toBe(false);
    expect(plan.keyStore.keys.has(keyB)).toBe(true);
  });

  test('a deleted account’s owners entries and the sharing connections it was in are left out', async () => {
    const owners = testKey('owners');
    await fake.hset(owners, { user_a: A, user_b: B });
    const conn = 'f'.repeat(24);
    const other = 'e'.repeat(24);
    await fake.hset(testKey('connections'), {
      [conn]: JSON.stringify({ users: ['user_a', 'user_b'], status: 'active', created_at: 'x' }),
      [`${conn}|share|user_b`]: '{}',
      [`${conn}|log`]: '{}',
      [other]: JSON.stringify({ users: ['user_a', 'user_c'], status: 'active', created_at: 'x' }),
    });
    const s = memoryStore();
    await backup(s, night(0));
    await deleteB();
    const plan = planRestore(await dataOf(s, 0), await keysOf(s, 0), { tombstones: await c.readTombstones(), keySeq: null });
    expect((plan.records.find((r) => r.key === 'owners') as any).value).toEqual({ user_a: A });
    expect(Object.keys((plan.records.find((r) => r.key === 'connections') as any).value)).toEqual([other]);
  });
});

describe('the restore command, with --keys', () => {
  test('saves the target as a pair, names what it leaves out, and restores both', async () => {
    const { mkdtemp, readdir, writeFile, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { main } = await import('@/scripts/restore');
    const s = memoryStore();
    await backup(s, night(0));
    const dir = await mkdtemp(join(tmpdir(), 'nya-keys-'));
    const cwd = process.cwd();
    const logs: string[] = [];
    const log = console.log;
    try {
      process.chdir(dir);
      await writeFile('data.f2.ndjson', s.files.get(dataFiles(s)[0])!.body);
      await writeFile('keys.ndjson', s.files.get(keyFiles(s)[0])!.body);
      await deleteB();
      console.log = (...a: unknown[]) => void logs.push(a.map(String).join(' '));
      await main(['data.f2.ndjson', '--keys', 'keys.ndjson', '--target', 'test', '--overwrite', '--dry-run'], fake as any);
      expect(logs.join('\n')).toContain(`Leaving out container ${B}: its account was deleted`);
      await main(['data.f2.ndjson', '--keys', 'keys.ndjson', '--target', 'test', '--overwrite'], fake as any);
      const saved = (await readdir(dir)).filter((f) => f.startsWith('nya-pre-restore-test-')).sort();
      expect(saved.map((f) => f.replace(/^.*\d{3}Z/, ''))).toEqual(['.f2.ndjson', '.keys.ndjson']);
      expect(ka.verifyKeyArchive(await Bun.file(join(dir, saved[1])).text()).tombstones.has(keyB)).toBe(true);
      expect(logs.at(-1)).toContain('Read-back matches');
      expect(await c.decrypt(ctxA, fake.strings.get(ctxKey('budgets', ctxA))!)).toBe('{"a":1}');
      await expect(main(['data.f2.ndjson', '--target', 'test', '--overwrite'], fake as any)).rejects.toThrow(/pass --keys/);
    } finally {
      console.log = log;
      process.chdir(cwd);
      await rm(dir, { recursive: true, force: true });
    }
  });
});
