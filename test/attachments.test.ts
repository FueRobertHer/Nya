import { describe, expect, test, mock, beforeEach, afterEach, afterAll } from 'bun:test';
import { FakeRedis, storageMock, TEST_CTX, ctxKey, registerTestContainer, unscopedDataKeys } from './fake-redis';
import { FakeObjects, contains, jpeg, pdf, segment, exif, sha, partShas, MASTER } from './attachment-fixture';

// Receipts and documents attached to transactions (#47, lib/attachments.ts):
// an upload in parts, every check on it, the limits reserved so uploads at
// the same moment can't pass them together, the file read back whole or
// refused, a delete that takes the key first, a move and a rename, one
// account never reaching another's, and where a file goes when its
// transaction changes: a pending row posting, the bank re-posting or
// removing a row, a disconnect and the link after it, a forget, a deleted
// row, an emptied account. Nothing readable is ever in the file store.

process.env.PLAID_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
const fake = new FakeRedis({ deserialize: true });
mock.module('@/lib/storage', () => storageMock(fake));
afterEach(() => expect(unscopedDataKeys(fake)).toEqual([]));

const c = await import('@/lib/crypto');
const att = await import('@/lib/attachments');
const stores = await import('@/lib/attachment-stores');
const objectsMod = await import('@/lib/attachment-objects');
const { PART_BYTES, PART_FORMAT } = await import('@/lib/attachment-crypto');
const { encodeJsonBlob } = await import('@/lib/blob');
const { forgetEpochs } = await import('@/lib/sessions');
const { contentKey } = await import('@/lib/transactions');
const route = await import('@/app/api/attachments/route');
const one = await import('@/app/api/attachments/[id]/route');
const parts = await import('@/app/api/attachments/[id]/parts/[part]/route');
const file = await import('@/app/api/attachments/[id]/file/route');
const thumb = await import('@/app/api/attachments/[id]/thumb/route');

const ctx = TEST_CTX;
const OTHER = { container: '5d1c7e2a-9b3f-4c6d-8e1a-2b3c4d5e6f70' } as typeof TEST_CTX;
const store = new FakeObjects();
const saved = { ...process.env };
const NOW = Date.parse('2026-10-20T12:00:00.000Z');

async function giveKey(container: string) {
  const p = await c.prepareContainerKey(container as never, { born: false });
  expect((await c.claimContainerKey(p!)).outcome).toBe('made');
}

type Row = { id: string; account?: string; date?: string; amount?: number; name?: string; pending?: boolean; pending_from?: string | null };
const row = (r: Row) => ({
  transaction_id: r.id,
  pending_transaction_id: r.pending_from ?? null,
  account_id: r.account ?? 'acc_chk',
  date: r.date ?? '2026-10-01',
  amount: r.amount ?? 4.5,
  name: r.name ?? 'BLUE BOTTLE 123',
  merchant_name: 'Blue Bottle',
  merchant_entity_id: null,
  pending: r.pending ?? false,
  counterparties: [],
  account_name: 'Checking',
  institution_name: 'Chase',
  iso_currency_code: 'USD',
  unofficial_currency_code: null,
});

/** An Item with these rows stored, as a sync leaves them. */
async function seedItem(item: string, rows: Row[], c2 = ctx) {
  await fake.hset(ctxKey('plaid:items', c2), { [item]: JSON.stringify({ item_id: item, institution_name: 'Chase', encrypted_access_token: 'x' }) });
  const txns = Object.fromEntries(rows.map((r) => [r.id, row(r)]));
  const accounts = Object.fromEntries([...new Set(rows.map((r) => r.account ?? 'acc_chk'))].map((a) => [a, { name: 'Checking', official_name: null, type: 'depository', subtype: 'checking', mask: '1', balances: null }]));
  await fake.set(ctxKey(`txns:${item}`, c2), await encodeJsonBlob(c2, { schema_version: 2, cursor: 'c', accounts, txns }));
}

async function link(old: string, to: string) {
  await fake.hset(ctxKey('account-links'), { [old]: await c.encrypt(ctx, JSON.stringify({ to, linked_at: '2026-10-10T00:00:00.000Z', evidence: {} })) });
}

/** Uploads a file onto a transaction the way the page does, through the
 *  routes, and answers its id. */
async function upload(transaction_id: string, body: Uint8Array, opts: { kind?: 'image' | 'pdf'; thumb?: Uint8Array | null; name?: string; c2?: typeof ctx } = {}) {
  const kind = opts.kind ?? 'image';
  const th = opts.thumb === undefined ? (kind === 'image' ? jpeg(900, 'THUMB-MARKER') : null) : opts.thumb;
  const start = await route.POST(
    new Request('http://localhost/api/attachments', {
      method: 'POST',
      body: JSON.stringify({ transaction_id, kind, bytes: body.length, part_sha256: await partShas(body, PART_BYTES), ...(th ? { thumb: { bytes: th.length, sha256: await sha(th) } } : {}), name: opts.name ?? 'IMG_4821.jpg' }),
    })
  );
  const started = await start.json();
  if (start.status !== 200) throw Object.assign(new Error(started.error), { status: start.status });
  // A part refused cancels the upload, as the page does.
  const refused = async (res: Response) => {
    await del(started.id);
    return Object.assign(new Error((await res.json()).error), { status: res.status });
  };
  for (let i = 0; i * PART_BYTES < body.length; i++) {
    const res = await putPart(started.id, String(i), body.subarray(i * PART_BYTES, (i + 1) * PART_BYTES));
    if (res.status !== 200) throw await refused(res);
  }
  if (th) {
    const res = await putPart(started.id, 't', th);
    if (res.status !== 200) throw await refused(res);
  }
  return started.id as string;
}

const putPart = (id: string, part: string, bytes: Uint8Array) =>
  parts.PUT(new Request(`http://localhost/api/attachments/${id}/parts/${part}`, { method: 'PUT', body: bytes as BodyInit }), { params: Promise.resolve({ id, part }) });
const getFile = (id: string, which: 'file' | 'thumb' = 'file', query = '') =>
  (which === 'file' ? file.GET : thumb.GET)(new Request(`http://localhost/api/attachments/${id}/${which}${query}`), { params: Promise.resolve({ id }) });
const del = (id: string) => one.DELETE(new Request(`http://localhost/api/attachments/${id}`, { method: 'DELETE' }), { params: Promise.resolve({ id }) });
const patch = (id: string, body: unknown) => one.PATCH(new Request(`http://localhost/api/attachments/${id}`, { method: 'PATCH', body: JSON.stringify(body) }), { params: Promise.resolve({ id }) });
const list = async () => (await route.GET(new Request('http://localhost/api/attachments'))).json();
const on = async (...ids: string[]) => (await (await route.GET(new Request(`http://localhost/api/attachments?ids=${ids.join(',')}`))).json()).files;
const record = (id: string) => stores.attachmentStore.get(ctx, id);

beforeEach(async () => {
  fake.reset();
  store.reset();
  c.forgetActiveKey();
  c.forgetContainerKey();
  forgetEpochs();
  objectsMod.setAttachmentObjectsForTests(store);
  process.env.MASTER_KEY = MASTER;
  process.env.ATTACHMENTS_QUOTA_MB = '1';
  await registerTestContainer(fake);
  await giveKey(ctx.container);
  await seedItem('item_chase', [{ id: 't_coffee' }, { id: 't_lunch', amount: 12, name: 'LUNCH PLACE' }, { id: 't_pending', pending: true }]);
});
afterEach(() => {
  process.env = { ...saved };
  c.forgetContainerKey();
});
afterAll(() => objectsMod.setAttachmentObjectsForTests(undefined));

describe('an upload, in parts', () => {
  test('a photo goes up, reads back whole, and nothing readable is stored', async () => {
    process.env.ATTACHMENTS_QUOTA_MB = '100';
    const photo = jpeg(PART_BYTES + 5000, 'RECEIPT-MARKER-PLAINTEXT');
    const id = await upload('t_coffee', photo, { name: 'Pharmacy IMG.jpg' });
    const r = (await record(id))!;
    expect(r).toMatchObject({ status: 'ready', kind: 'image', bytes: photo.length, parts: 2, place: { on: 'transaction', transaction_id: 't_coffee', account_id: 'acc_chk', content: contentKey('acc_chk', row({ id: 't_coffee' })) } });
    expect(r.as_placed).toEqual({ date: '2026-10-01', amount: 4.5, currency: 'USD', name: 'Blue Bottle' });
    expect(r.upload).toBeUndefined();
    // In the file store: three objects (two parts, a thumbnail) in the
    // account's folder, none readable, no name, no marker.
    expect([...store.objects.keys()].sort()).toEqual([0, 1, 't'].map((p) => objectsMod.objectPath(ctx, id, p as never)));
    // Each object starts with the format byte, never as a JPEG does; and no
    // marker long enough to mean something is anywhere in the store (a
    // short one, three or four bytes, turns up in megabytes of ciphertext by
    // chance: review 21).
    for (const [path, o] of store.objects) expect([path, o.bytes[0], o.bytes[0] === 0xff && o.bytes[1] === 0xd8]).toEqual([path, PART_FORMAT, false]);
    const all = store.everything();
    for (const needle of ['RECEIPT-MARKER-PLAINTEXT', 'THUMB-MARKER', 'Pharmacy IMG', 'JFIF\0\u0001\u0001', 'Blue Bottle']) expect([needle, contains(all, needle)]).toEqual([needle, false]);
    // The record keeps no path, no URL and no plaintext key.
    expect(JSON.stringify(r)).not.toMatch(/blob\.vercel-storage|attachments\//);
    // Back whole, with its own headers.
    const res = await getFile(id);
    expect(res.status).toBe(200);
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(new Uint8Array(photo));
    expect(res.headers.get('content-type')).toBe('image/jpeg');
    expect(res.headers.get('cache-control')).toBe('private, no-store');
    expect(res.headers.get('cross-origin-resource-policy')).toBe('same-origin');
    expect(res.headers.get('content-security-policy')).toBe("default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox");
    expect(res.headers.get('content-disposition')).toBe(`inline; filename="Pharmacy IMG.jpg"; filename*=UTF-8''Pharmacy%20IMG.jpg`);
    const t = await getFile(id, 'thumb');
    expect(new Uint8Array(await t.arrayBuffer())).toEqual(new Uint8Array(jpeg(900, 'THUMB-MARKER')));
  });

  test('a PDF is only ever saved, under a policy that lets it be nothing else', async () => {
    const doc = pdf(7000);
    const id = await upload('t_lunch', doc, { kind: 'pdf', name: 'Invoice "Dr\r\nSmith".pdf' });
    const res = await getFile(id);
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(new Uint8Array(doc));
    expect(res.headers.get('content-type')).toBe('application/pdf');
    // The name as kept (its line break a space), its quotes taken out.
    expect(res.headers.get('content-disposition')).toBe(`attachment; filename="Invoice Dr Smith.pdf"; filename*=UTF-8''Invoice%20Dr%20Smith.pdf`);
    expect(res.headers.get('content-security-policy')).toBe("default-src 'none'; sandbox");
    expect((await getFile(id, 'thumb')).status).toBe(404);
  });

  test('a part that isn’t what was declared is refused, never stored short', async () => {
    const photo = jpeg(5000);
    const start = await route.POST(new Request('http://localhost/api/attachments', { method: 'POST', body: JSON.stringify({ transaction_id: 't_coffee', kind: 'image', bytes: photo.length, part_sha256: [await sha(photo)] }) }));
    const { id } = await start.json();
    // Cut short, as a proxy would; the wrong bytes; too long.
    expect((await putPart(id, '0', photo.subarray(0, 4000))).status).toBe(400);
    const other = new Uint8Array(photo);
    other[3000] ^= 1;
    expect((await putPart(id, '0', other)).status).toBe(400);
    expect((await putPart(id, '0', new Uint8Array(PART_BYTES + 1))).status).toBe(413);
    expect((await putPart(id, '1', photo)).status).toBe(400);
    expect((await putPart(id, 't', photo)).status).toBe(400);
    expect(store.objects.size).toBe(0);
    expect((await record(id))!.status).toBe('uploading');
    expect((await putPart(id, '0', photo)).status).toBe(200);
    expect((await record(id))!.status).toBe('ready');
  });

  test('a photo that still carries its location is refused by the server, whatever the page did', async () => {
    const located = jpeg(5000, 'x', [segment(0xe1, exif([0x8825]))]);
    await expect(upload('t_coffee', located, { thumb: null })).rejects.toMatchObject({ status: 415 });
    const xmpThumb = jpeg(900, 'x', [segment(0xe1, 'http://ns.adobe.com/xap/1.0/\0')]);
    await expect(upload('t_coffee', jpeg(5000), { thumb: xmpThumb })).rejects.toMatchObject({ status: 415 });
    await expect(upload('t_coffee', jpeg(5000), { kind: 'pdf', thumb: null })).rejects.toMatchObject({ status: 415 });
    await expect(upload('t_coffee', pdf(5000), { kind: 'image', thumb: null })).rejects.toMatchObject({ status: 415 });
  });

  test('every field of a start is checked', async () => {
    const post = (body: unknown) => route.POST(new Request('http://localhost/api/attachments', { method: 'POST', body: JSON.stringify(body) }));
    const good = { transaction_id: 't_coffee', kind: 'image', bytes: 10, part_sha256: ['a'.repeat(64)] };
    for (const bad of [
      { ...good, transaction_id: '../x' },
      { ...good, transaction_id: 'split:t_coffee:1' },
      { ...good, kind: 'heic' },
      { ...good, bytes: 0 },
      { ...good, bytes: 1.5 },
      { ...good, bytes: 11 * 1024 * 1024 },
      { ...good, part_sha256: ['nothex'] },
      { ...good, part_sha256: [] },
      { ...good, thumb: { bytes: 300 * 1024, sha256: 'a'.repeat(64) } },
      { ...good, thumb: { bytes: 10, sha256: 'a'.repeat(64), extra: 1 } },
      { ...good, name: 5 },
      { ...good, surprise: true },
    ]) {
      expect([bad, (await post(bad)).status]).toEqual([bad, 400]);
    }
    // The parts must match the size.
    expect((await post({ ...good, bytes: PART_BYTES + 1 })).status).toBe(400);
    // A transaction that isn't stored.
    expect((await post({ ...good, transaction_id: 't_nowhere' })).status).toBe(404);
  });
});

describe('turned on, and who may', () => {
  test('without the quota setting nothing can be added, but what is there can still be opened, moved and deleted', async () => {
    const id = await upload('t_coffee', jpeg(5000));
    delete process.env.ATTACHMENTS_QUOTA_MB;
    await expect(upload('t_lunch', jpeg(5000))).rejects.toMatchObject({ status: 403 });
    expect((await getFile(id)).status).toBe(200);
    expect((await patch(id, { transaction_id: 't_lunch' })).status).toBe(200);
    expect((await list()).mode).toEqual({ connected: true, uploads: false, quota_bytes: null });
    expect((await del(id)).status).toBe(200);
    // An invalid setting is off, never on.
    process.env.ATTACHMENTS_QUOTA_MB = 'ten';
    expect(att.attachmentsMode().uploads).toBe(false);
  });

  test('without a file store, nothing at all; without its own key, nothing added', async () => {
    objectsMod.setAttachmentObjectsForTests(null);
    await expect(upload('t_coffee', jpeg(5000))).rejects.toMatchObject({ status: 503 });
    objectsMod.setAttachmentObjectsForTests(store);
    await fake.hdel(c.containerKeysKey(), ctx.container);
    c.forgetContainerKey();
    await expect(upload('t_coffee', jpeg(5000))).rejects.toMatchObject({ status: 409, message: att.NO_OWN_KEY_MESSAGE });
  });
});

describe('the limits, reserved in one step', () => {
  test('the quota holds against uploads started at the same moment', async () => {
    // 1 MB of quota; each file about 300 KB with its thumbnail: three fit.
    const photo = jpeg(300 * 1024);
    const starts = await Promise.all(
      Array.from({ length: 8 }, async () =>
        route.POST(new Request('http://localhost/api/attachments', { method: 'POST', body: JSON.stringify({ transaction_id: 't_coffee', kind: 'image', bytes: photo.length, part_sha256: [await sha(photo)] }) }))
      )
    );
    const statuses = starts.map((r) => r.status).sort();
    // Never more than the quota allows, and never more than three in progress.
    expect(statuses.filter((s) => s === 200).length).toBeLessThanOrEqual(3);
    expect(statuses.every((s) => s === 200 || s === 413 || s === 429)).toBe(true);
    const usage = (await stores.usageStore.get(ctx))!;
    expect(usage.bytes).toBeLessThanOrEqual(1024 * 1024);
  });

  test('at most ten on a transaction, however many start at once', async () => {
    process.env.ATTACHMENTS_QUOTA_MB = '100';
    const small = jpeg(3000);
    const ids: string[] = [];
    for (let i = 0; i < 9; i++) ids.push(await upload('t_coffee', small, { thumb: null }));
    const results = await Promise.allSettled([upload('t_coffee', small, { thumb: null }), upload('t_coffee', small, { thumb: null })]);
    expect(results.filter((r) => r.status === 'fulfilled').length).toBe(1);
    expect((await stores.placeStore.get(ctx, 't_coffee'))!.ids.length).toBe(10);
  });

  test('an expired upload holds nothing: the next start releases it, objects first', async () => {
    process.env.ATTACHMENTS_QUOTA_MB = '100';
    const photo = jpeg(5000);
    const sizes = await partShas(photo, PART_BYTES);
    const done = await att.startUpload(ctx, { transaction_id: 't_coffee', kind: 'image', bytes: photo.length, part_sha256: sizes, thumb: null, name: null }, NOW);
    await att.receivePart(ctx, done.id, 0, photo, NOW);
    // Three more, never finished: the most there may be.
    await att.startUpload(ctx, { transaction_id: 't_coffee', kind: 'image', bytes: photo.length, part_sha256: sizes, thumb: null, name: null }, NOW);
    await att.startUpload(ctx, { transaction_id: 't_lunch', kind: 'image', bytes: photo.length, part_sha256: sizes, thumb: null, name: null }, NOW);
    const third = await att.startUpload(ctx, { transaction_id: 't_lunch', kind: 'image', bytes: photo.length, part_sha256: sizes, thumb: null, name: null }, NOW);
    await expect(att.startUpload(ctx, { transaction_id: 't_lunch', kind: 'image', bytes: photo.length, part_sha256: sizes, thumb: null, name: null }, NOW)).rejects.toMatchObject({ status: 429 });
    // Past the hour, the next start throws the expired ones away first.
    const later = NOW + att.UPLOAD_MS + 1000;
    await att.startUpload(ctx, { transaction_id: 't_lunch', kind: 'image', bytes: photo.length, part_sha256: sizes, thumb: null, name: null }, later);
    expect(await record(third.id)).toBeNull();
    const usage = (await stores.usageStore.get(ctx))!;
    expect(Object.keys(usage.uploads)).toHaveLength(1);
    expect(usage.files).toBe(2); // the ready one, and the new one
    expect(store.objects.size).toBe(1); // the ready one's only
  });

  test('a lost count is worked out again from the records, a record that can’t be read counting as a full file', async () => {
    process.env.ATTACHMENTS_QUOTA_MB = '100';
    await upload('t_coffee', jpeg(3000), { thumb: null });
    await stores.usageStore.remove(ctx);
    await fake.hset(ctxKey('attachments'), { '1b2c3d4e-5f60-4a7b-8c9d-0e1f2a3b4c5d': 'damaged-bytes-not-ciphertext' });
    const usage = await att.usageFromRecords(ctx);
    expect(usage.files).toBe(2);
    expect(usage.bytes).toBeGreaterThan(10 * 1024 * 1024);
  });
});

describe('reading', () => {
  test('a missing part is 410, a damaged one 409 and the record says damaged: never half a file', async () => {
    const id = await upload('t_coffee', jpeg(5000));
    store.objects.delete(objectsMod.objectPath(ctx, id, 0));
    expect((await getFile(id)).status).toBe(410);
    const id2 = await upload('t_lunch', jpeg(5000));
    const p = objectsMod.objectPath(ctx, id2, 0);
    store.objects.get(p)!.bytes[30] ^= 1;
    const res = await getFile(id2);
    expect([res.status, (await res.json()).damaged]).toEqual([409, true]);
    expect((await record(id2))!.damaged).toBe(true);
  });

  test('views are counted, an hour at a time', async () => {
    const id = await upload('t_coffee', jpeg(3000), { thumb: null });
    for (let i = 0; i < att.VIEWS_PER_HOUR; i++) await stores.attachmentRequests.take(ctx, 'read');
    expect((await getFile(id)).status).toBe(429);
  });

  test('the list, and the files on a transaction checked against their records', async () => {
    const a = await upload('t_coffee', jpeg(3000));
    const b = await upload('t_coffee', pdf(3000), { kind: 'pdf' });
    const l = await list();
    expect(l.files.map((f: { id: string }) => f.id).sort()).toEqual([a, b].sort());
    expect(l.usage).toMatchObject({ files: 2, quota_bytes: 1024 * 1024, max_files: 4000 });
    expect(JSON.stringify(l)).not.toContain('file_key');
    expect((await on('t_coffee')).map((f: { id: string }) => f.id).sort()).toEqual([a, b].sort());
    // A stale entry (a crash between the record and the index) is put right
    // where it is read.
    await stores.placeStore.update(ctx, 't_lunch', () => ({ ids: [a] }));
    expect(await on('t_lunch')).toEqual([]);
    expect(await stores.placeStore.get(ctx, 't_lunch')).toBeNull();
  });
});

describe('deleting', () => {
  test('the key leaves first, then the objects and the record, and what it held is released', async () => {
    const id = await upload('t_coffee', jpeg(5000));
    const res = await del(id);
    expect(await res.json()).toEqual({ finished: true });
    expect(await record(id)).toBeNull();
    expect(store.objects.size).toBe(0);
    expect(await stores.placeStore.get(ctx, 't_coffee')).toBeNull();
    expect(await stores.usageStore.get(ctx)).toMatchObject({ bytes: 0, files: 0 });
  });

  test('with the file store out of reach: the file can’t be opened any more, and is left for the sweep', async () => {
    const id = await upload('t_coffee', jpeg(5000));
    store.fail.add('del');
    expect(await (await del(id)).json()).toEqual({ finished: false });
    const r = (await record(id))!;
    expect([r.status, r.file_key]).toEqual(['deleting', null]);
    expect(store.objects.size).toBeGreaterThan(0);
    expect((await getFile(id)).status).toBe(404);
    expect((await list()).deleting).toBe(1);
    // Still counted until it is gone.
    expect((await stores.usageStore.get(ctx))!.files).toBe(1);
  });

  test('an upload in progress is cancelled, its objects first', async () => {
    process.env.ATTACHMENTS_QUOTA_MB = '100';
    const photo = jpeg(PART_BYTES + 10);
    const start = await route.POST(new Request('http://localhost/api/attachments', { method: 'POST', body: JSON.stringify({ transaction_id: 't_coffee', kind: 'image', bytes: photo.length, part_sha256: await partShas(photo, PART_BYTES) }) }));
    const { id } = await start.json();
    await putPart(id, '0', photo.subarray(0, PART_BYTES));
    expect(store.objects.size).toBe(1);
    await del(id);
    expect([store.objects.size, await record(id)]).toEqual([0, null]);
    // A part that arrives after the cancel is deleted again, not kept.
    expect((await putPart(id, '1', photo.subarray(PART_BYTES))).status).toBe(404);
    expect(store.objects.size).toBe(0);
  });
});

describe('what a file reserved, given back once (review 4)', () => {
  test('a delete finished twice, or an upload thrown away twice, gives nothing back twice', async () => {
    const keep = await upload('t_coffee', jpeg(3000));
    const gone = await upload('t_lunch', jpeg(3000));
    store.fail.add('del');
    await del(gone);
    store.fail.clear();
    const deleting = (await record(gone))!;
    await Promise.all([att.finishDelete(ctx, gone, deleting), att.finishDelete(ctx, gone, deleting)]);
    await att.finishDelete(ctx, gone, deleting);
    const kept = (await record(keep))!;
    expect(await stores.usageStore.get(ctx)).toMatchObject({ files: 1, bytes: kept.stored_bytes });
    // An upload thrown away by two starts at once.
    const photo = jpeg(3000);
    const start = await route.POST(new Request('http://localhost/api/attachments', { method: 'POST', body: JSON.stringify({ transaction_id: 't_lunch', kind: 'image', bytes: photo.length, part_sha256: await partShas(photo, PART_BYTES) }) }));
    const { id } = await start.json();
    await Promise.all([att.discardUpload(ctx, id, NOW, { cancelled: true }), att.discardUpload(ctx, id, NOW, { cancelled: true })]);
    await att.discardUpload(ctx, id, NOW, { cancelled: true });
    expect(await stores.usageStore.get(ctx)).toMatchObject({ files: 1, bytes: kept.stored_bytes, uploads: {} });
  });
});

describe('names (review 5)', () => {
  test('cut between characters, never inside one, so the file can always be sent', async () => {
    const name = att.cleanName(`${'a'.repeat(119)}😀.pdf`)!;
    expect(name.length).toBeLessThanOrEqual(stores.NAME_MAX);
    expect(name).toBe('a'.repeat(119));
    expect(() => encodeURIComponent(name)).not.toThrow();
    expect(att.cleanName('😀'.repeat(70))).toBe('😀'.repeat(60));
    // A lone half of one is made whole.
    expect(att.cleanName('a\ud83d')).toBe('a\ufffd');
    const id = await upload('t_coffee', jpeg(3000), { name: `${'b'.repeat(119)}😀.jpg` });
    expect((await getFile(id)).status).toBe(200);
    expect((await getFile(id, 'thumb')).status).toBe(200);
    expect((await patch(id, { name: `${'c'.repeat(119)}😀` })).status).toBe(200);
    expect((await getFile(id, 'file', '?download=1')).status).toBe(200);
    // And the header never throws, whatever a record holds.
    const { disposition } = await import('@/lib/attachment-http');
    expect(disposition('attachment', 'x\ud83d.pdf')).toContain("filename*=UTF-8''x%EF%BF%BD.pdf");
  });
});

describe('a thumbnail that doesn’t open (review 7)', () => {
  test('loses its thumbnail, never the file: the file still opens and is still in the ZIP', async () => {
    const id = await upload('t_coffee', jpeg(3000));
    store.objects.get(objectsMod.objectPath(ctx, id, 't'))!.bytes[20] ^= 1;
    expect((await getFile(id, 'thumb')).status).toBe(409);
    const r = (await record(id))!;
    expect([r.damaged, r.thumb_damaged]).toEqual([undefined, true]);
    expect((await getFile(id, 'thumb')).status).toBe(404);
    expect((await getFile(id)).status).toBe(200);
    expect((await on('t_coffee'))[0]).toMatchObject({ id, thumb: false });
    const { makePlan } = await import('@/lib/attachment-zip');
    expect((await makePlan(ctx, store, NOW)).volumes.flat().map((f) => f.id)).toEqual([id]);
  });

  test('a file marked damaged by a read that failed once is cleared by one that opens it whole', async () => {
    const id = await upload('t_coffee', jpeg(3000));
    const object = store.objects.get(objectsMod.objectPath(ctx, id, 0))!;
    const original = new Uint8Array(object.bytes);
    object.bytes[20] ^= 1;
    expect((await getFile(id)).status).toBe(409);
    expect((await record(id))!.damaged).toBe(true);
    object.bytes = original;
    expect((await getFile(id)).status).toBe(200);
    expect((await record(id))!.damaged).toBeUndefined();
  });
});

describe('moving and renaming', () => {
  test('moved to another transaction, with what it says; renamed; never past ten', async () => {
    const id = await upload('t_coffee', jpeg(3000));
    const moved = await (await patch(id, { transaction_id: 't_lunch' })).json();
    expect(moved.file.place).toEqual({ on: 'transaction', transaction_id: 't_lunch' });
    expect(moved.file.as_placed.amount).toBe(12);
    expect(await stores.placeStore.get(ctx, 't_coffee')).toBeNull();
    expect((await stores.placeStore.get(ctx, 't_lunch'))!.ids).toEqual([id]);
    expect((await (await patch(id, { name: '  Warranty\u0000/card ' })).json()).file.name).toBe('Warranty card');
    expect((await (await patch(id, { name: null })).json()).file.name).toBeNull();
    expect((await patch(id, { transaction_id: 't_nowhere' })).status).toBe(404);
    expect((await patch(id, { transaction_id: 't_lunch', name: 'x' })).status).toBe(400);
  });
});

describe('one account never reaches another’s', () => {
  test('another account’s ids are not found, and its files are in its own folder', async () => {
    const id = await upload('t_coffee', jpeg(3000));
    // The same id read in another account: nothing there.
    expect(await stores.attachmentStore.get(OTHER, id)).toBeNull();
    // A record copied into another account doesn't open there: its key is
    // bound to this account and this file.
    await fake.hset('test:containers', { [OTHER.container]: JSON.stringify({ status: 'active', primary: false, created_at: '2026-01-01T00:00:00.000Z' }) });
    await giveKey(OTHER.container);
    // Copied byte for byte, past the fake's own guard against a wrong Ctx.
    const copied = fake.hashes.get(ctxKey('attachments'))!.get(id)!;
    fake.checkCiphertext = false;
    fake.hashes.set(ctxKey('attachments', OTHER), new Map([[id, copied]]));
    fake.checkCiphertext = true;
    await expect(att.readFile(OTHER, id, 'file')).rejects.toThrow();
    for (const p of store.objects.keys()) expect(p.startsWith(objectsMod.containerFolder(ctx))).toBe(true);
  });
});

describe('where a file goes when its transaction changes', () => {
  test('a pending row that posts: to the posted row naming it, even while the upload was in progress', async () => {
    process.env.ATTACHMENTS_QUOTA_MB = '100';
    const photo = jpeg(PART_BYTES + 10);
    const start = await route.POST(new Request('http://localhost/api/attachments', { method: 'POST', body: JSON.stringify({ transaction_id: 't_pending', kind: 'image', bytes: photo.length, part_sha256: await partShas(photo, PART_BYTES) }) }));
    const { id } = await start.json();
    await putPart(id, '0', photo.subarray(0, PART_BYTES));
    const posted = row({ id: 't_posted', pending_from: 't_pending', amount: 5.25 });
    await att.settleAfterSync(ctx, { removed: new Set(['t_pending']), added: new Set(['t_posted']), rows: [posted as never], historyIn: true }, NOW);
    await putPart(id, '1', photo.subarray(PART_BYTES));
    const r = (await record(id))!;
    expect(r.place).toMatchObject({ on: 'transaction', transaction_id: 't_posted', content: contentKey('acc_chk', posted) });
    expect(r.as_placed!.amount).toBe(5.25);
    expect((await stores.placeStore.get(ctx, 't_posted'))!.ids).toEqual([id]);
    expect(await stores.placeStore.get(ctx, 't_pending')).toBeNull();
  });

  test('a posted row the bank re-posts under a new id follows it; one it removes leaves the file not on a transaction', async () => {
    const a = await upload('t_coffee', jpeg(3000));
    const b = await upload('t_lunch', jpeg(3000));
    const reposted = row({ id: 't_coffee2' });
    await att.settleAfterSync(ctx, { removed: new Set(['t_coffee', 't_lunch']), added: new Set(['t_coffee2']), rows: [reposted as never], historyIn: true }, NOW);
    expect((await record(a))!.place).toMatchObject({ on: 'transaction', transaction_id: 't_coffee2' });
    expect((await record(b))!.place).toEqual({ on: 'none', why: 'removed', since: new Date(NOW).toISOString(), was: { transaction_id: 't_lunch', account_id: 'acc_chk', content: contentKey('acc_chk', row({ id: 't_lunch', amount: 12, name: 'LUNCH PLACE' })) } });
    // Still listed, still counted, still openable.
    expect((await list()).files).toHaveLength(2);
    expect((await getFile(b)).status).toBe(200);
  });

  test('a posted row the bank removes never hands its receipt to an identical purchase stored before (review 3)', async () => {
    // Two coffees, the same day, amount and words, each with its receipt.
    await seedItem('item_chase', [{ id: 't_coffee' }, { id: 't_coffee_b' }, { id: 't_lunch', amount: 12, name: 'LUNCH PLACE' }]);
    const a = await upload('t_coffee', jpeg(3000));
    const b = await upload('t_coffee_b', jpeg(3000));
    // The bank removes the first, adding nothing: its receipt is let go,
    // never put beside the other's.
    await att.settleAfterSync(ctx, { removed: new Set(['t_coffee']), added: new Set(), rows: [row({ id: 't_coffee_b' })] as never, historyIn: true }, NOW);
    expect((await record(a))!.place).toMatchObject({ on: 'none', why: 'removed' });
    expect((await stores.placeStore.get(ctx, 't_coffee_b'))!.ids).toEqual([b]);
    // A re-post (added in the same sync) still takes it.
    const c2 = await upload('t_coffee_b', jpeg(3000));
    await att.settleAfterSync(ctx, { removed: new Set(['t_coffee_b']), added: new Set(['t_coffee_c']), rows: [row({ id: 't_coffee_c' })] as never, historyIn: true }, NOW);
    expect((await record(b))!.place).toMatchObject({ on: 'transaction', transaction_id: 't_coffee_c' });
    expect((await record(c2))!.place).toMatchObject({ on: 'transaction', transaction_id: 't_coffee_c' });
  });

  test('THE ACCEPTANCE: a receipt survives a re-link of its institution', async () => {
    const id = await upload('t_coffee', jpeg(3000));
    // Disconnected: it waits on the earlier account, by content.
    const stored = [row({ id: 't_coffee' }), row({ id: 't_lunch', amount: 12, name: 'LUNCH PLACE' })];
    expect(await att.retireAttachments(ctx, stored as never)).toBe(1);
    expect((await record(id))!.place).toEqual({ on: 'earlier', account_id: 'acc_chk', content: contentKey('acc_chk', stored[0]), alike: 1, pending: false });
    expect((await stores.placeStore.get(ctx, 'earlier:acc_chk'))!.ids).toEqual([id]);
    // Added back with new ids, and linked by the person.
    const fresh = [row({ id: 'n_coffee', account: 'acc_new', date: '2026-10-01' }), row({ id: 'n_old', account: 'acc_new', date: '2026-09-01', name: 'OLDER' })];
    // Before the link: nothing moves.
    expect(await att.placeWaiting(ctx, fresh as never, true, NOW)).toBe(0);
    await link('acc_chk', 'acc_new');
    // While its history is still coming: it waits.
    expect(await att.placeWaiting(ctx, fresh as never, false, NOW)).toBe(0);
    expect(await att.placeWaiting(ctx, fresh as never, true, NOW)).toBe(1);
    expect((await record(id))!.place).toMatchObject({ on: 'transaction', transaction_id: 'n_coffee', account_id: 'acc_new', carried: true });
    expect(await stores.placeStore.get(ctx, 'earlier:acc_chk')).toBeNull();
    // Done once: a later sync moves nothing.
    expect(await att.placeWaiting(ctx, fresh as never, true, NOW)).toBe(0);
  });

  test('two purchases that look the same never get a receipt guessed onto one of them', async () => {
    const id = await upload('t_coffee', jpeg(3000));
    // At the disconnect a second coffee was still pending, the same amount and words.
    const stored = [row({ id: 't_coffee' }), row({ id: 't_coffee_b', pending: true, date: '2026-10-02' })];
    await att.retireAttachments(ctx, stored as never);
    expect((await record(id))!.place).toMatchObject({ on: 'earlier', alike: 2 });
    await link('acc_chk', 'acc_new');
    const fresh = [row({ id: 'n1', account: 'acc_new', date: '2026-10-01' }), row({ id: 'n0', account: 'acc_new', date: '2026-09-01' })];
    expect(await att.placeWaiting(ctx, fresh as never, true, NOW)).toBe(0);
    // A row exactly like it twice on the new side: it waits too.
    const id2 = await upload('t_lunch', jpeg(3000));
    await att.retireAttachments(ctx, [row({ id: 't_lunch', amount: 12, name: 'LUNCH PLACE' })] as never);
    const twice = [row({ id: 'm1', account: 'acc_new', amount: 12, name: 'LUNCH PLACE' }), row({ id: 'm2', account: 'acc_new', amount: 12, name: 'LUNCH PLACE' }), row({ id: 'm0', account: 'acc_new', date: '2026-01-01' })];
    expect(await att.placeWaiting(ctx, twice as never, true, NOW)).toBe(0);
    expect((await record(id2))!.place.on).toBe('earlier');
  });

  test('forgetting the earlier account, deleting a row, emptying the account: kept, not on a transaction', async () => {
    const a = await upload('t_coffee', jpeg(3000));
    await att.retireAttachments(ctx, [row({ id: 't_coffee' })] as never);
    await att.forgetEarlierAttachments(ctx, 'acc_chk', NOW);
    expect((await record(a))!.place).toMatchObject({ on: 'none', why: 'forgotten', was: { transaction_id: null, account_id: 'acc_chk' } });
    const b = await upload('t_lunch', jpeg(3000));
    await att.releaseAttachments(ctx, ['t_lunch'], 'gone', NOW);
    expect((await record(b))!.place).toMatchObject({ on: 'none', why: 'gone', was: { transaction_id: 't_lunch' } });
    expect(await stores.placeStore.get(ctx, 't_lunch')).toBeNull();
    const d = await upload('t_coffee', jpeg(3000));
    expect(await att.releaseAllAttachments(ctx, NOW)).toBe(1);
    expect((await record(d))!.place).toMatchObject({ on: 'none', why: 'emptied', was: { transaction_id: 't_coffee' } });
    expect(await stores.placeStore.ids(ctx)).toEqual([]);
    // Every file still there, openable.
    for (const id of [a, b, d]) expect((await getFile(id)).status).toBe(200);
  });

  test('a placement step that fails marks the account for the sweep’s check, never fails its caller', async () => {
    const id = await upload('t_coffee', jpeg(3000));
    await fake.hset(ctxKey('account-links'), { acc_chk: 'not-ciphertext-at-all' });
    await att.settleAfterSync(ctx, { removed: new Set(), added: new Set(), rows: [row({ id: 'x', account: 'acc_new' })] as never, historyIn: true }, NOW);
    expect((await stores.sweepStateStore.get(ctx))!.check).toEqual({ since: new Date(NOW).toISOString() });
    expect((await record(id))!.place.on).toBe('transaction');
  });
});
