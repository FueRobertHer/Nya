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
// damaged. The route: a fresh sign-in each volume, a set counted once, a
// passphrase that opens with age, an email that names no file.

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

async function attach(transaction_id: string, body: Uint8Array, kind: 'image' | 'pdf' = 'image') {
  const { id } = await att.startUpload(ctx, { transaction_id, kind, bytes: body.length, part_sha256: await partShas(body, PART_BYTES), thumb: null, name: kind === 'pdf' ? 'Invoice.pdf' : null }, NOW);
  for (let i = 0; i * PART_BYTES < body.length; i++) await att.receivePart(ctx, id, i, body.subarray(i * PART_BYTES, (i + 1) * PART_BYTES), NOW);
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
afterAll(() => objectsMod.setAttachmentObjectsForTests(undefined));

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
  test('read back whole by the zip reader: the files, their names, the manifest last, exactly the size promised', async () => {
    const a = jpeg(PART_BYTES + 777, 'RECEIPT-A');
    const b = pdf(5000);
    const ida = await attach('t1', a);
    const idb = await attach('t3', b, 'pdf');
    const plan = await zip.planVolumes(ctx, store);
    expect(plan.volumes).toHaveLength(1);
    const meta = { exported_at: new Date(NOW).toISOString(), volume: 1, volumes: 1, left_out: plan.left_out };
    const bytes = await collect(zip.volumeChunks(ctx, store, plan.volumes[0], meta));
    expect(bytes.length).toBe(zip.volumeSize(plan.volumes[0], meta));
    const entries = listZip(bytes, LIMITS);
    if (!Array.isArray(entries)) throw new Error(JSON.stringify(entries));
    expect(entries.map((e) => e.name)).toEqual([`2025/2025-03-14 CON Pharmacy ${ida.slice(0, 8)}.jpg`, `2026/2026-05-05 Clinic A ${idb.slice(0, 8)}.pdf`, 'nya-attachments.json']);
    expect(entries.every((e) => (e.flags & 0x0800) !== 0)).toBe(true);
    expect(readEntry(bytes, entries[0], LIMITS)).toEqual(new Uint8Array(a));
    expect(readEntry(bytes, entries[1], LIMITS)).toEqual(new Uint8Array(b));
    const manifest = JSON.parse(new TextDecoder().decode(readEntry(bytes, entries[2], LIMITS) as Uint8Array));
    expect(manifest).toMatchObject({ format: 'nya-attachments', version: 1, volume: 1, volumes: 1, left_out: [] });
    expect(manifest.files.map((f: { sha256: string; damaged: boolean }) => [f.sha256, f.damaged])).toEqual([
      [await sha(a), false],
      [await sha(b), false],
    ]);
    expect(manifest.files[0]).toMatchObject({ id: ida, on: { transaction_id: 't1' }, type: 'image/jpeg', transaction_as_added: { date: '2025-03-14', amount: 42 } });
    expect(JSON.stringify(manifest)).not.toContain('file_key');
  });

  test('a file whose objects are missing is left out and named; one that fails to open part way is zeros of its size, marked damaged', async () => {
    const good = await attach('t1', jpeg(3000));
    const missing = await attach('t2', jpeg(3000));
    const breaks = await attach('t3', jpeg(4000, 'BREAKS'));
    store.objects.delete(objectsMod.objectPath(ctx, missing, 0));
    const plan = await zip.planVolumes(ctx, store);
    expect(plan.left_out).toEqual([{ id: missing, why: 'missing' }]);
    // Damaged after the plan: the length still holds.
    store.objects.get(objectsMod.objectPath(ctx, breaks, 0))!.bytes[20] ^= 1;
    const meta = { exported_at: new Date(NOW).toISOString(), volume: 1, volumes: 1, left_out: plan.left_out };
    const bytes = await collect(zip.volumeChunks(ctx, store, plan.volumes[0], meta));
    expect(bytes.length).toBe(zip.volumeSize(plan.volumes[0], meta));
    const entries = listZip(bytes, LIMITS) as { name: string }[];
    const manifest = JSON.parse(new TextDecoder().decode(readEntry(bytes, entries.at(-1) as never, LIMITS) as Uint8Array));
    expect(manifest.files.map((f: { id: string; damaged: boolean }) => [f.id, f.damaged])).toEqual([
      [good, false],
      [breaks, true],
    ]);
    expect(readEntry(bytes, entries[1] as never, LIMITS)).toEqual(new Uint8Array(4000));
    expect((await stores.attachmentStore.get(ctx, breaks))!.damaged).toBe(true);
    // The next listing leaves it out too.
    expect((await zip.planVolumes(ctx, store)).left_out.map((l) => l.id).sort()).toEqual([missing, breaks].sort());
  });

  test('volumes of about 50 MB, oldest first', async () => {
    const big = jpeg(9 * 1024 * 1024);
    const ids = [];
    for (let i = 0; i < 7; i++) ids.push(await attach(i % 2 ? 't1' : 't2', big));
    const plan = await zip.planVolumes(ctx, store);
    expect(plan.volumes.map((v) => v.length)).toEqual([5, 2]);
    expect(plan.volumes.flat().map((f) => f.record.as_placed!.date)).toEqual([...plan.volumes.flat().map((f) => f.record.as_placed!.date)].sort());
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
  test('a fresh sign-in each volume; the first counts and emails, the rest of the set with its token don’t', async () => {
    const big = jpeg(9 * 1024 * 1024);
    for (let i = 0; i < 7; i++) await attach('t1', big);
    expect((await post({ volume: 1 })).status).toBe(403); // no password
    const first = await post({ volume: 1, password: 'hunter2' });
    expect(first.status).toBe(200);
    const body = new Uint8Array(await first.arrayBuffer());
    expect(String(body.length)).toBe(first.headers.get('content-length')!);
    expect(first.headers.get('x-nya-volumes')).toBe('2');
    const set = first.headers.get('x-nya-set')!;
    const counted = async () => Number((await fake.get<string>(ctxKey('download-count'))) ?? 0);
    const after1 = await counted();
    const second = await post({ volume: 2, set, password: 'hunter2' });
    expect(second.status).toBe(200);
    await second.arrayBuffer();
    expect(await counted()).toBe(after1);
    // A token for another listing counts again.
    await attach('t2', jpeg(3000));
    const third = await post({ volume: 2, set, password: 'hunter2' });
    expect(third.status).toBe(200);
    await third.arrayBuffer();
    expect(await counted()).toBeGreaterThan(after1);
    // A forged token is no token.
    expect(zip.setTokenHolds(`${Date.now() + 1000}.forged`, { container: ctx.container, user: null, digest: 'x', volumes: 1 })).toBe(false);
  });

  test('protected with a passphrase: it opens with age, to the same ZIP', async () => {
    const a = jpeg(3000, 'PROTECTED-MARKER');
    await attach('t1', a);
    const res = await post({ volume: 1, password: 'hunter2', passphrase: 'correct horse battery' });
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

  test('every field checked; the plan counts nothing', async () => {
    await attach('t1', jpeg(3000));
    for (const bad of [{}, { volume: 0 }, { volume: 1.5 }, { volume: 1, extra: 1 }, { volume: 1, passphrase: 'short' }, { volume: 1, set: 5 }]) expect([bad, (await post(bad)).status]).toEqual([bad, 400]);
    expect((await post({ volume: 2, password: 'hunter2' })).status).toBe(400);
    const plan = await (await route.GET()).json();
    expect(plan.volumes).toEqual([expect.objectContaining({ volume: 1, files: 1 })]);
    expect(await fake.get(ctxKey('download-count'))).toBeNull();
  });

  test('the email names no file, and nothing from one', () => {
    const { subject, text } = composeAccessNotice({ kind: 'download', format: 'attachments-zip', protected: false }, new Date(NOW), { clerk: false, link: null });
    expect(subject).toBe('Your Nya data was downloaded');
    expect(text).toContain('your receipts and documents, as ZIP files');
    expect(text).not.toMatch(/\.jpg|\.pdf|Pharmacy|Clinic/);
  });
});
