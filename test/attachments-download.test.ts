import { describe, expect, test, mock, beforeEach, afterEach, afterAll } from 'bun:test';
import { FakeRedis, storageMock, TEST_CTX, ctxKey, registerTestContainer, unscopedDataKeys } from './fake-redis';
import { FakeObjects, jpeg, pdf, sha, partShas, contains, MASTER } from './attachment-fixture';

// Receipts and documents in the download (#47): the JSON file lists them
// (never a key, a path or a sealed value), and the files themselves come as
// ZIP volumes of about 50 MB (lib/attachment-zip.ts) whose size is known
// before the first byte, read back here by the codebase's own zip reader:
// every name cleaned, every file whole with its CRC-32, the manifest last and
// of the size promised, a file whose objects are missing left out and named,
// one that fails to open part way written as zeros of its size and marked
// damaged, and tried again. The route: one plan for the set, served as made
// ready whatever changes between volumes (review blocking 1), a fresh
// sign-in each volume, a set counted once, a passphrase that opens with age,
// an email that names no file.

process.env.PLAID_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
const fake = new FakeRedis({ deserialize: true });
mock.module('@/lib/storage', () => storageMock(fake));
afterEach(() => expect(unscopedDataKeys(fake)).toEqual([]));

const c = await import('@/lib/crypto');
const att = await import('@/lib/attachments');
const stores = await import('@/lib/attachment-stores');
const objectsMod = await import('@/lib/attachment-objects');
const zip = await import('@/lib/attachment-zip');
const { listZip, readEntry } = await import('@/lib/zip');
const { PART_BYTES } = await import('@/lib/attachment-crypto');
const { encodeJsonBlob } = await import('@/lib/blob');
const { forgetEpochs } = await import('@/lib/sessions');
const { collectUserData, buildUserExport } = await import('@/lib/user-export');
const { composeAccessNotice } = await import('@/lib/download-notice');
const { decryptWithPassphrase } = await import('@/lib/age/age');
const { nativeScrypt } = await import('@/lib/protected-download');
const route = await import('@/app/api/attachments/download/route');
const { backgroundSettled } = await import('@/lib/background');

const ctx = TEST_CTX;
const store = new FakeObjects();
const saved = { ...process.env };
const NOW = Date.parse('2026-10-20T12:00:00.000Z');
const LIMITS = { maxEntries: 10_000, maxEntryBytes: 20 * 1024 * 1024 };

async function giveKey(container: string) {
  const p = await c.prepareContainerKey(container as never, { born: false });
  expect((await c.claimContainerKey(p!)).outcome).toBe('made');
}

const row = (id: string, date: string, name: string) => ({
  transaction_id: id,
  pending_transaction_id: null,
  account_id: 'acc_chk',
  date,
  amount: 42,
  name,
  merchant_name: name,
  merchant_entity_id: null,
  pending: false,
  counterparties: [],
  account_name: 'Checking',
  institution_name: 'Chase',
  iso_currency_code: 'USD',
  unofficial_currency_code: null,
});

/** A file attached as the page does; `at`, when it was added (the order the
 *  ZIP files go in). */
async function attach(transaction_id: string, body: Uint8Array, kind: 'image' | 'pdf' = 'image', at: number = NOW) {
  const { id } = await att.startUpload(ctx, { transaction_id, kind, bytes: body.length, part_sha256: await partShas(body, PART_BYTES), thumb: null, name: kind === 'pdf' ? 'Invoice.pdf' : null }, at);
  for (let i = 0; i * PART_BYTES < body.length; i++) await att.receivePart(ctx, id, i, body.subarray(i * PART_BYTES, (i + 1) * PART_BYTES), at);
  return id;
}

async function collect(chunks: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  for await (const p of chunks) parts.push(p);
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

const post = (body: unknown) => route.POST(new Request('http://localhost/api/attachments/download', { method: 'POST', body: JSON.stringify(body) }));

beforeEach(async () => {
  fake.reset();
  store.reset();
  c.forgetActiveKey();
  c.forgetContainerKey();
  forgetEpochs();
  objectsMod.setAttachmentObjectsForTests(store);
  process.env.MASTER_KEY = MASTER;
  process.env.ATTACHMENTS_QUOTA_MB = '200';
  delete process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;
  delete process.env.CLERK_SECRET_KEY;
  process.env.APP_PASSWORD = 'hunter2';
  process.env.SESSION_SECRET = 'test-session-secret';
  await registerTestContainer(fake);
  await giveKey(ctx.container);
  await fake.hset(ctxKey('plaid:items'), { item: JSON.stringify({ item_id: 'item', institution_name: 'Chase', encrypted_access_token: 'x' }) });
  await fake.set(
    ctxKey('txns:item'),
    await encodeJsonBlob(ctx, {
      schema_version: 2,
      cursor: 'c',
      accounts: { acc_chk: { name: 'Checking', official_name: null, type: 'depository', subtype: 'checking', mask: '1', balances: null } },
      txns: { t1: row('t1', '2025-03-14', 'CON / Pharmacy..'), t2: row('t2', '2026-02-01', 'Best Buy'), t3: row('t3', '2026-05-05', 'Clinic \u0007\\ "A"') },
    })
  );
});
afterEach(async () => {
  // The emails and the record of the last download, started and not waited
  // for (lib/background.ts), settled before the next test resets the store.
  await backgroundSettled();
  process.env = { ...saved };
  c.forgetContainerKey();
});
afterAll(() => {
  objectsMod.setAttachmentObjectsForTests(undefined);
  // Bun runs every file in one process, and a later file with no storage mock
  // of its own reaches this fake, whose last test left the test container a
  // key of its own; lib/crypto.ts would then cache that key for every file in
  // the next minute. So nothing of this file's fake or keys outlives it.
  fake.reset();
  c.forgetContainerKey();
  c.forgetActiveKey();
});
afterEach(() => zip.setVolumeLimitsForTests(null));

describe('names', () => {
  test('cleaned of anything a file system reads as a path or refuses', () => {
    expect(zip.cleanSegment('a/b\\c:d*e?f"g<h>i|j')).toBe('a b c d e f g h i j');
    expect(zip.cleanSegment('..secret..')).toBe('secret');
    expect(zip.cleanSegment('CON')).toBe('_CON');
    expect(zip.cleanSegment('nul.txt')).toBe('_nul.txt');
    expect(zip.cleanSegment('trailing. . ')).toBe('trailing');
    expect(zip.cleanSegment('\u0000\u0001')).toBe('file');
    expect(zip.cleanSegment('x'.repeat(200)).length).toBe(60);
  });
});

describe('a volume', () => {
  const meta = (left_out: unknown[] = []) => ({ exported_at: new Date(NOW).toISOString(), volume: 1, volumes: 1, left_out: left_out as never[] });

  test('read back whole by the zip reader: the files, their names, the manifest last, exactly the size promised', async () => {
    const a = jpeg(PART_BYTES + 777, 'RECEIPT-A');
    const b = pdf(5000);
    const ida = await attach('t1', a);
    const idb = await attach('t3', b, 'pdf', NOW + 1000);
    const made = await zip.makePlan(ctx, store, NOW);
    expect(made.volumes).toHaveLength(1);
    const m = meta(made.left_out);
    const bytes = await collect(zip.volumeChunks(ctx, store, made.volumes[0], m));
    expect(bytes.length).toBe(zip.volumeSize(made.volumes[0], m));
    const entries = listZip(bytes, LIMITS);
    if (!Array.isArray(entries)) throw new Error(JSON.stringify(entries));
    expect(entries.map((e) => e.name)).toEqual([`2025/2025-03-14 CON Pharmacy ${ida.slice(0, 8)}.jpg`, `2026/2026-05-05 Clinic A ${idb.slice(0, 8)}.pdf`, 'nya-attachments.json']);
    expect(entries.every((e) => (e.flags & 0x0800) !== 0)).toBe(true);
    expect(readEntry(bytes, entries[0], LIMITS)).toEqual(new Uint8Array(a));
    expect(readEntry(bytes, entries[1], LIMITS)).toEqual(new Uint8Array(b));
    const manifest = JSON.parse(new TextDecoder().decode(readEntry(bytes, entries[2], LIMITS) as Uint8Array));
    expect(manifest).toMatchObject({ format: 'nya-attachments', version: 1, volume: 1, volumes: 1, left_out: [], added_since: 0 });
    expect(manifest.files.map((f: { sha256: string; damaged: boolean }) => [f.sha256, f.damaged])).toEqual([
      [await sha(a), false],
      [await sha(b), false],
    ]);
    expect(manifest.files[0]).toMatchObject({ id: ida, on: { transaction_id: 't1' }, type: 'image/jpeg', transaction_as_added: { date: '2025-03-14', amount: 42 } });
    expect(JSON.stringify(manifest)).not.toContain('file_key');
  });

  test('a file whose objects are missing is left out and named; one that fails to open part way is zeros of its size, marked damaged, and tried again next time', async () => {
    const good = await attach('t1', jpeg(3000));
    const missing = await attach('t2', jpeg(3000), 'image', NOW + 1000);
    const breaks = await attach('t3', jpeg(4000, 'BREAKS'), 'image', NOW + 2000);
    store.objects.delete(objectsMod.objectPath(ctx, missing, 0));
    const made = await zip.makePlan(ctx, store, NOW);
    expect(made.left_out).toEqual([{ id: missing, why: 'missing' }]);
    // Damaged after the plan: the length still holds.
    const object = store.objects.get(objectsMod.objectPath(ctx, breaks, 0))!;
    const original = new Uint8Array(object.bytes);
    object.bytes[20] ^= 1;
    const m = meta(made.left_out);
    const bytes = await collect(zip.volumeChunks(ctx, store, made.volumes[0], m));
    expect(bytes.length).toBe(zip.volumeSize(made.volumes[0], m));
    const entries = listZip(bytes, LIMITS) as { name: string }[];
    const manifest = JSON.parse(new TextDecoder().decode(readEntry(bytes, entries.at(-1) as never, LIMITS) as Uint8Array));
    expect(manifest.files.map((f: { id: string; damaged: boolean }) => [f.id, f.damaged])).toEqual([
      [good, false],
      [breaks, true],
    ]);
    expect(readEntry(bytes, entries[1] as never, LIMITS)).toEqual(new Uint8Array(4000));
    expect((await stores.attachmentStore.get(ctx, breaks))!.damaged).toBe(true);
    // Tried again by the next plan (review 7): once it opens whole, the
    // mark goes.
    object.bytes = original;
    const again = await zip.makePlan(ctx, store, NOW);
    expect(again.left_out).toEqual([{ id: missing, why: 'missing' }]);
    expect(again.volumes[0].map((f) => f.id)).toContain(breaks);
    await collect(zip.volumeChunks(ctx, store, again.volumes[0], meta(again.left_out)));
    expect((await stores.attachmentStore.get(ctx, breaks))!.damaged).toBeUndefined();
  });

  test('volumes of about 50 MB, and at most 400 files, in the order the files were added', async () => {
    expect([zip.VOLUME_BYTES, zip.VOLUME_FILES]).toEqual([50 * 1024 * 1024, 400]);
    const big = jpeg(9 * 1024 * 1024);
    for (let i = 0; i < 7; i++) await attach(i % 2 ? 't1' : 't2', big, 'image', NOW + i * 1000);
    const made = await zip.makePlan(ctx, store, NOW);
    expect(made.volumes.map((v) => v.length)).toEqual([5, 2]);
    const added = made.volumes.flat().map((f) => f.record.created_at);
    expect(added).toEqual([...added].sort());
    zip.setVolumeLimitsForTests({ bytes: zip.VOLUME_BYTES, files: 3 });
    expect((await zip.makePlan(ctx, store, NOW)).volumes.map((v) => v.length)).toEqual([3, 3, 1]);
  });
});

describe('the JSON download', () => {
  test('lists every ready file by its name in the ZIP, never a key, a path or a sealed value', async () => {
    const id = await attach('t1', jpeg(3000));
    const data = await collectUserData({ ctx, userId: null });
    const doc = buildUserExport(data, new Date(NOW));
    const listed = (doc as unknown as Record<string, unknown>).attachments as { id: string; file: string }[];
    expect(listed).toEqual([expect.objectContaining({ id, file: expect.stringMatching(/^2025\/2025-03-14 /), on: { transaction_id: 't1' }, type: 'image/jpeg' })]);
    const text = JSON.stringify(doc);
    expect(text).not.toContain('file_key');
    const sealed = (await stores.attachmentStore.get(ctx, id))!.file_key!;
    expect(text).not.toContain(sealed);
    expect(text).not.toContain('attachments/test/');
  });
});

describe('the route', () => {
  /** The download made ready, as the card asks for it. */
  const ready = async () => (await (await route.GET()).json()) as { volumes: { volume: number; files: number }[]; plan: string; left_out: unknown[] };
  /** A volume's ZIP, and what its manifest says. */
  const volume = async (body: Record<string, unknown>) => {
    const res = await post({ password: 'hunter2', ...body });
    expect(res.status).toBe(200);
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect(String(bytes.length)).toBe(res.headers.get('content-length')!);
    const entries = listZip(bytes, LIMITS) as { name: string }[];
    const manifest = JSON.parse(new TextDecoder().decode(readEntry(bytes, entries.at(-1) as never, LIMITS) as Uint8Array));
    const notes = JSON.parse(decodeURIComponent(res.headers.get('x-nya-export-notes') ?? '%5B%5D')) as string[];
    return { res, manifest, ids: (manifest.files as { id: string }[]).map((f) => f.id), set: res.headers.get('x-nya-set')!, added: Number(res.headers.get('x-nya-added')), notes };
  };

  test('a fresh sign-in each volume; the first counts and emails, the rest of the set with its token don’t', async () => {
    zip.setVolumeLimitsForTests({ bytes: zip.VOLUME_BYTES, files: 2 });
    for (let i = 0; i < 3; i++) await attach('t1', jpeg(3000), 'image', NOW + i);
    const made = await ready();
    expect(made.volumes.map((v) => v.files)).toEqual([2, 1]);
    expect((await post({ volume: 1, plan: made.plan })).status).toBe(403); // no password
    const counted = async () => Number((await fake.get<string>(ctxKey('download-count'))) ?? 0);
    const first = await volume({ volume: 1, plan: made.plan });
    expect(first.res.headers.get('x-nya-volumes')).toBe('2');
    const after1 = await counted();
    expect(after1).toBeGreaterThan(0);
    await volume({ volume: 2, plan: made.plan, set: first.set });
    expect(await counted()).toBe(after1);
    // Another plan, made ready again: a new set, counted again.
    const other = await ready();
    await volume({ volume: 1, plan: other.plan, set: first.set });
    expect(await counted()).toBeGreaterThan(after1);
    // A forged token is no token.
    expect(zip.setTokenHolds(`${Date.now() + 1000}.forged`, { container: ctx.container, user: null, digest: 'x', volumes: 1 })).toBe(false);
  });

  test('THE PROBE (review blocking 1): a file deleted after volume 1 never shifts another out of the set; one deleted later is named; one added is counted; one moved stays put', async () => {
    zip.setVolumeLimitsForTests({ bytes: zip.VOLUME_BYTES, files: 2 });
    const ids: string[] = [];
    for (let i = 0; i < 6; i++) ids.push(await attach(i % 2 ? 't1' : 't2', jpeg(3000, `FILE-${i}`), 'image', NOW + i * 1000));
    const made = await ready();
    expect(made.volumes.map((v) => v.files)).toEqual([2, 2, 2]);
    const v1 = await volume({ volume: 1, plan: made.plan });
    expect(v1.ids).toEqual([ids[0], ids[1]]);
    // Between volumes: file 0 (already saved) deleted, file 3 (planned for
    // volume 2) deleted, file 4 moved to another transaction, and a new file
    // added.
    await att.deleteAttachment(ctx, ids[0]);
    await att.deleteAttachment(ctx, ids[3]);
    await att.moveAttachment(ctx, ids[4], 't3');
    await attach('t1', jpeg(3000, 'ADDED'), 'image', NOW + 10_000);
    const v2 = await volume({ volume: 2, plan: made.plan, set: v1.set });
    // Exactly its planned files, less the one deleted, which is named.
    expect(v2.ids).toEqual([ids[2]]);
    expect(v2.manifest.left_out).toEqual([{ id: ids[3], why: 'deleted' }]);
    expect(v2.manifest.set_left_out).toBeUndefined();
    expect(v2.added).toBe(1);
    expect(v2.notes.some((n) => n.startsWith('1 file planned for this ZIP file was deleted'))).toBe(true);
    expect(v2.notes.some((n) => n.startsWith('1 file was added after this download was made ready'))).toBe(true);
    const v3 = await volume({ volume: 3, plan: made.plan, set: v2.set });
    // The moved file is in its planned volume, under its new transaction.
    expect(v3.ids).toEqual([ids[4], ids[5]]);
    expect(v3.manifest.files[0].on).toEqual({ transaction_id: 't3' });
    // The last volume names every planned file the set doesn't hold now,
    // with the volume it was planned for, and how many were added since.
    expect(v3.manifest.set_left_out).toEqual([
      { id: ids[0], why: 'deleted', volume: 1 },
      { id: ids[3], why: 'deleted', volume: 2 },
    ]);
    expect(v3.manifest.added_since).toBe(1);
    // Every file the plan held is in one volume or named: none missing
    // without a word.
    const accounted = new Set([...v1.ids, ...v2.ids, ...v3.ids, ...v3.manifest.set_left_out.map((l: { id: string }) => l.id)]);
    for (const id of ids) expect(accounted.has(id)).toBe(true);
    // The set counted once.
    expect(Number(await fake.get<string>(ctxKey('download-count')))).toBe(1);
  });

  test('a file not whole in storage when the download is made ready is named in the set’s list, never counted as added (review 19)', async () => {
    const ids = [await attach('t1', jpeg(3000), 'image', NOW), await attach('t2', jpeg(3000), 'image', NOW + 1), await attach('t3', jpeg(3000), 'image', NOW + 2)];
    store.objects.delete(objectsMod.objectPath(ctx, ids[1], 0));
    const made = await ready();
    expect(made.left_out).toEqual([{ id: ids[1], why: 'missing' }]);
    const v1 = await volume({ volume: 1, plan: made.plan });
    expect(v1.ids).toEqual([ids[0], ids[2]]);
    expect(v1.manifest.left_out).toEqual([]);
    expect(v1.manifest.set_left_out).toEqual([{ id: ids[1], why: 'missing' }]);
    expect([v1.added, v1.manifest.added_since]).toEqual([0, 0]);
    expect(v1.notes).toEqual(['1 file wasn’t whole in storage when the download was made ready, so it is in none of its ZIP files. The list in this one (nya-attachments.json, set_left_out) names it.']);
    // Deleted since: named as deleted.
    await att.deleteAttachment(ctx, ids[1]);
    expect((await volume({ volume: 1, plan: made.plan, set: v1.set })).manifest.set_left_out).toEqual([{ id: ids[1], why: 'deleted' }]);
  });

  test('a plan made ready too long ago, or not here for this account, is refused', async () => {
    await attach('t1', jpeg(3000));
    const made = await ready();
    const plan = zip.readPlanToken(made.plan, ctx.container, Date.now());
    expect(plan).not.toBeNull();
    const old = zip.planToken({ ...(plan as Exclude<typeof plan, null | 'expired'>), until: Date.now() - 1 });
    const expired = await post({ volume: 1, plan: old, password: 'hunter2' });
    expect(expired.status).toBe(409);
    const said = await expired.json();
    expect(said.plan_expired).toBe(true);
    // What was saved from it is no part of the new set (review nit 24).
    expect(said.error).toContain('save every ZIP file of the new set, and put away any you saved from this one');
    const elsewhere = zip.planToken({ ...(plan as Exclude<typeof plan, null | 'expired'>), container: '5d1c7e2a-9b3f-4c6d-8e1a-2b3c4d5e6f70' });
    expect((await post({ volume: 1, plan: elsewhere, password: 'hunter2' })).status).toBe(400);
    const [head, mac] = [made.plan.slice(0, made.plan.lastIndexOf('.')), made.plan.slice(made.plan.lastIndexOf('.') + 1)];
    expect((await post({ volume: 1, plan: `${head}x.${mac}`, password: 'hunter2' })).status).toBe(400);
    expect(await fake.get(ctxKey('download-count'))).toBeNull();
  });

  test('protected with a passphrase: it opens with age, to the same ZIP', async () => {
    const a = jpeg(3000, 'PROTECTED-MARKER');
    await attach('t1', a);
    const made = await ready();
    const res = await post({ volume: 1, plan: made.plan, password: 'hunter2', passphrase: 'correct horse battery' });
    const file = new Uint8Array(await res.arrayBuffer());
    expect(String(file.length)).toBe(res.headers.get('content-length')!);
    expect(contains(file, 'PROTECTED-MARKER')).toBe(false);
    const opened = (await decryptWithPassphrase(file, 'correct horse battery', { scrypt: nativeScrypt })).reduce((acc, p) => {
      const out = new Uint8Array(acc.length + p.length);
      out.set(acc);
      out.set(p, acc.length);
      return out;
    }, new Uint8Array(0));
    const entries = listZip(opened, LIMITS) as never[];
    expect(readEntry(opened, entries[0], LIMITS)).toEqual(new Uint8Array(a));
  });

  test('every field checked; making it ready counts nothing', async () => {
    await attach('t1', jpeg(3000));
    const made = await ready();
    for (const bad of [{}, { volume: 1 }, { volume: 0, plan: made.plan }, { volume: 1.5, plan: made.plan }, { volume: 1, plan: made.plan, extra: 1 }, { volume: 1, plan: made.plan, passphrase: 'short' }, { volume: 1, plan: made.plan, set: 5 }, { volume: 1, plan: 7 }]) {
      expect([bad, (await post(bad)).status]).toEqual([bad, 400]);
    }
    expect((await post({ volume: 2, plan: made.plan, password: 'hunter2' })).status).toBe(400);
    expect(made.volumes).toEqual([expect.objectContaining({ volume: 1, files: 1 })]);
    expect(await fake.get(ctxKey('download-count'))).toBeNull();
  });

  test('the email names no file, and nothing from one', () => {
    const { subject, text } = composeAccessNotice({ kind: 'download', format: 'attachments-zip', protected: false }, new Date(NOW), { clerk: false, link: null });
    expect(subject).toBe('Your Nya data was downloaded');
    expect(text).toContain('your receipts and documents, as ZIP files');
    expect(text).not.toMatch(/\.jpg|\.pdf|Pharmacy|Clinic/);
  });
});
