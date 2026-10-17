import { describe, expect, test, mock, beforeEach, afterEach } from 'bun:test';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { FakeRedis, storageMock, ctxKey, testKey } from './fake-redis';

// The release before, reading what this release writes (docs/operations.md,
// "What a rollback sees"). Rolling back is safe at any time, with no switch
// to turn off first, only while the release before reads everything this one
// writes, so this holds it to that with the release before's own code
// (test/fixtures/release-before: its lib/crypto.ts, lib/export.ts,
// lib/restore.ts, lib/containers.ts and lib/key-families.ts, byte for byte,
// with lib/storage taken from this release), both running against one store:
//   - its decrypt opens values under container keys, items' tokens included;
//   - every field of crypto:keys is a key id its reader takes, and every
//     record holds only what it knows, so its parse and unwrap accept each;
//   - its nightly export carries the new records, and its own verifier
//     accepts the archive, which this release can then plan to restore;
//   - its master rotation re-locks container keys, the counter and the
//     tombstones, keeping `container`, and this release reads its values
//     after;
//   - its pass, checking the stores it lists as plain text, finds no
//     ciphertext in the new ones;
//   - what it writes into a container with a key of its own reads here;
//   - its first key numbers past every key, and this release's next one past
//     that.

process.env.PLAID_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');

const fake = new FakeRedis();
mock.module('@/lib/storage', () => storageMock(fake));

const n = await import('@/lib/crypto');
const nContainers = await import('@/lib/containers');
const nRestore = await import('@/lib/restore');
const o = await import('./fixtures/release-before/crypto');
const oExport = await import('./fixtures/release-before/export');
const oRestore = await import('./fixtures/release-before/restore');
const oFamilies = await import('./fixtures/release-before/key-families');

// Masters no other test file uses: an automatic finish is throttled per master
// for the whole process (lib/crypto.ts finishRotationSoon).
const MASTER = Buffer.alloc(32, 193).toString('base64');
const NEXT = Buffer.alloc(32, 194).toString('base64');
const B = '5d1c7e2a-9b3f-4c6d-8e1a-2b3c4d5e6f70';
const C = '6e2d8f3b-0c4a-4d7e-9f2b-3c4d5e6f7a81';
const ISO = '2026-10-01T00:00:00.000Z';

/**
 * The release before's re-encryption pass, on a store it lists as plain text
 * (lib/reencrypt.ts at that release, copied here: the pass itself reads more
 * of that release than is worth keeping): v2, or v1 (base64 of at least a
 * 12-byte IV and a 16-byte tag, so 40+ characters).
 */
const looksEncrypted = (v: unknown) =>
  typeof v === 'string' && (/^v2\.k[0-9]/.test(v) || (v.length >= 40 && v.length % 4 === 0 && /^[A-Za-z0-9+/]+={0,2}$/.test(v)));

async function oldExportText(): Promise<string> {
  let text = '';
  for await (const line of oExport.exportLines(fake as any)) text += line;
  return text;
}

let P = '';
const saved = { ...process.env };
beforeEach(async () => {
  fake.reset();
  n.forgetActiveKey();
  o.forgetActiveKey();
  process.env.MASTER_KEY = MASTER;
  // This release: the first container born with its key; B and C given one by the pass's claim.
  P = await nContainers.createFirstContainer(Date.now(), (id) => n.birthKey(id));
  await fake.hset(testKey('containers'), {
    [B]: JSON.stringify({ status: 'active', primary: false, created_at: ISO }),
    [C]: JSON.stringify({ status: 'active', primary: false, created_at: ISO }),
  });
  for (const id of [B, C]) {
    const p = await n.prepareContainerKey(id as any, { born: false });
    expect((await n.claimContainerKey(p!)).outcome).toBe('made');
  }
});
afterEach(() => {
  process.env = { ...saved };
  n.forgetActiveKey();
  o.forgetActiveKey();
});

/** Values this release writes under container keys: a born one's and a claimed one's, and an item's token. */
async function seedNewValues() {
  const ctxP = { container: P } as any;
  const ctxB = { container: B } as any;
  await fake.set(ctxKey('goals', ctxP), await n.encrypt(ctxP, '[{"id":"g1"}]'));
  await fake.hset(ctxKey('history:net-worth', ctxB), { '2026-10-01': await n.encrypt(ctxB, '100') });
  await fake.hset(ctxKey('plaid:items', ctxB), { i1: JSON.stringify({ item_id: 'i1', institution_name: 'Bank', encrypted_access_token: await n.encrypt(ctxB, 'access-sandbox-1') }) });
  return {
    goals: String(await fake.get(ctxKey('goals', ctxP))),
    nw: String(fake.hashes.get(ctxKey('history:net-worth', ctxB))!.get('2026-10-01')),
    token: JSON.parse(String(fake.hashes.get(ctxKey('plaid:items', ctxB))!.get('i1'))).encrypted_access_token as string,
  };
}

/** C deleted, the way an account deletion leaves it: out of the registry, its key destroyed. */
async function deleteC() {
  await fake.hdel(testKey('containers'), C);
  await n.destroyContainerKeys({ container: C } as any);
}

describe('the release before’s own code', () => {
  test('is kept byte for byte, as its git blobs', () => {
    // From the integration branch this one merges into (c558fcf; the same
    // blobs as at 18c6ffd, where this branch began).
    const blobs: Record<string, string> = {
      'crypto.ts': '52cd23e1bb8c9cf1c37a8aaf1e59e4d5055d71a2',
      'containers.ts': '0c547c66695f11ba96aac4914364189c551a3fce',
      'export.ts': '5906750754885798848a4dff583f00219bacb519',
      'restore.ts': '16995a794a83b431b04ac275aa8c3c127ad3b201',
      'key-families.ts': 'd1bfee8d2ac6f844363f85cd140078eca803d071',
    };
    for (const [file, blob] of Object.entries(blobs)) {
      const bytes = readFileSync(join(import.meta.dir, 'fixtures', 'release-before', file));
      expect([file, createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex')]).toEqual([file, blob]);
    }
  });
});

describe('the release before, reading what this release writes', () => {
  test('decrypts values under container keys, born and claimed, items’ tokens included', async () => {
    const v = await seedNewValues();
    for (const [value, plain] of [
      [v.goals, '[{"id":"g1"}]'],
      [v.nw, '100'],
      [v.token, 'access-sandbox-1'],
    ] as const) {
      const keyId = n.formatOf(value).keyId;
      expect(JSON.parse(String(fake.hashes.get(n.keysHashKey())!.get(keyId))).container).toBeDefined();
      o.forgetActiveKey();
      expect(await o.decrypt(value)).toBe(plain);
    }
  });

  test('takes every field of crypto:keys as a key id, and every record as one it reads, opens and checks', async () => {
    await seedNewValues();
    await deleteC();
    const master = await o.importMasterKey(MASTER);
    const fields = [...fake.hashes.get(n.keysHashKey())!];
    expect(fields.map(([, r]) => JSON.parse(r).container).sort()).toEqual([P, B].sort()); // C's destroyed
    for (const [id, record] of fields) {
      // No counter or marker among them (crypto:key-seq is a key of its own),
      // nothing its KEY_ID refuses, and nothing in a record it doesn't know.
      expect([id, o.isKeyId(id)]).toEqual([id, true]);
      expect([id, Object.keys(JSON.parse(record)).filter((f) => !['created_at', 'wrapped', 'next', 'container'].includes(f))]).toEqual([id, []]);
      const raw = await o.unwrapDataKey(master, id, o.parseStoredDataKey(id, record));
      // The same commitment and the same lock as this release's.
      expect(await o.dataKeyId(Number(id.slice(1, id.indexOf('-'))), raw)).toBe(id);
      expect(await o.keyCommitment(raw)).toBe(await n.keyCommitment(raw));
      expect(await n.unwrapDataKey(await n.importMasterKey(MASTER), id, n.parseStoredDataKey(id, record))).toEqual(raw);
    }
    expect(fake.strings.has(testKey('crypto:key-seq'))).toBe(true);
    // And one it locks opens here.
    const raw = crypto.getRandomValues(new Uint8Array(32));
    const id = await o.dataKeyId(77, raw);
    expect(await n.unwrapDataKey(await n.importMasterKey(MASTER), id, { created_at: ISO, wrapped: { [master.fingerprint]: await master.wrap(id, raw) } })).toEqual(raw);
  });

  test('exports the new records in format 1, which its own verifier accepts and this release can restore', async () => {
    await seedNewValues();
    await deleteC();
    // An account deleted while its deletion was still running: the owners marker.
    await fake.hset(testKey('owners'), { user_c: `deleted:${C}`, user_p: P });
    const text = await oldExportText();
    const { records } = oRestore.verifyArchive(text);
    const keys = records.map((r: { key: string }) => r.key);
    for (const k of ['crypto:keys', 'crypto:container-keys', 'crypto:destroyed', 'crypto:key-seq', 'owners']) expect(keys).toContain(k);
    const plan = nRestore.planRestore(nRestore.verifyArchive(text), null, { tombstones: new Map(), keySeq: null });
    expect(plan.left_out).toEqual([]); // C left nothing but its tombstone
    expect([...plan.keyStore.tombstones.values()].map((t) => t.container)).toContain(C);
  });

  test('rotates the master over container keys, the counter and the tombstones, keeping `container`, and this release reads its values after', async () => {
    const v = await seedNewValues();
    await deleteC();
    const before = new Map([...fake.hashes.get(n.keysHashKey())!].map(([id, r]) => [id, JSON.parse(r).container]));
    const prepared = await o.prepareMasterRotation(NEXT);
    expect(prepared.prepared).toBe(2); // P's and B's; C's destroyed
    process.env.MASTER_KEY = NEXT;
    o.forgetActiveKey();
    n.forgetActiveKey();
    await o.finishMasterRotation({ force: true });
    await o.autoFinishSettled();
    const next = await n.importMasterKey(NEXT);
    for (const [id, raw] of fake.hashes.get(n.keysHashKey())!) {
      const rec = JSON.parse(raw);
      expect([id, Object.keys(rec.wrapped), rec.next, rec.container]).toEqual([id, [next.fingerprint], undefined, before.get(id)]);
    }
    expect(fake.strings.has(testKey('crypto:key-seq'))).toBe(true);
    expect(fake.hashes.get(n.tombstonesKey())!.size).toBe(1);
    expect(await n.decrypt({ container: B } as any, v.nw)).toBe('100');
    expect(await n.decrypt({ container: P } as any, v.goals)).toBe('[{"id":"g1"}]');
  });

  test('finds no ciphertext in the new records, each in a store it lists as plain text', async () => {
    await seedNewValues();
    await deleteC();
    const { keysLock } = await import('@/lib/backup');
    await keysLock.markPending(C, new Date(ISO));
    const token = await keysLock.take(10);
    await fake.hset(testKey('owners'), { user_c: `deleted:${C}` });
    const fresh = [
      'crypto:container-keys',
      'crypto:destroyed',
      'crypto:key-seq',
      'backups:keys-lock',
      'backups:keys-pending',
      'owners',
    ];
    for (const name of fresh) {
      expect([name, oFamilies.listedKind(name)]).toEqual([name, 'plain']);
      const full = testKey(name);
      const values = fake.hashes.has(full) ? [...fake.hashes.get(full)!.values()] : [fake.strings.get(full)];
      expect([name, values.length > 0 && values.every((x) => x !== undefined)]).toEqual([name, true]);
      expect([name, values.filter(looksEncrypted)]).toEqual([name, []]);
    }
    await keysLock.release(token!);
  });

  test('writes into a container with a key of its own under the environment’s key, which this release reads', async () => {
    await seedNewValues();
    const written = await o.encrypt('written while rolled back');
    const keyId = o.formatOf(written).keyId;
    expect(keyId === 'k0' || JSON.parse(String(fake.hashes.get(n.keysHashKey())!.get(keyId))).container === undefined).toBe(true);
    await fake.set(ctxKey('budgets', { container: B }), written);
    expect(await n.decrypt({ container: B } as any, written)).toBe('written while rolled back');
  });

  test('numbers its first key past every key, container keys included, and this release’s next one never clashes with it', async () => {
    await seedNewValues();
    await fake.del(testKey('crypto:active'));
    o.forgetActiveKey();
    const id = o.formatOf(await o.encrypt('x')).keyId;
    expect(id).not.toBe('k0');
    const ids = [...fake.hashes.get(n.keysHashKey())!.keys()];
    const number = (k: string) => Number(k.slice(1, k.indexOf('-')));
    expect(number(id)).toBe(Math.max(...ids.map(number)));
    expect(ids.filter((k) => number(k) === number(id))).toEqual([id]);
    // This release numbers from its own counter, which the release before
    // doesn't move: two keys may share a number, never an id, since an id
    // commits to its key.
    const p = await n.prepareContainerKey(B as any, { born: false });
    expect(ids).not.toContain(p!.id);
  });
});
