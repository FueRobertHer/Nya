import { describe, expect, test, mock, beforeEach, afterEach, afterAll } from 'bun:test';
import { FakeRedis, storageMock, TEST_CTX, ctxKey, testKey, registerTestContainer, unscopedDataKeys } from './fake-redis';
import { FakeObjects, jpeg, sha, MASTER } from './attachment-fixture';

// The life of receipts and documents past their upload (#47): the hooks in
// the code that changes transactions (a disconnect, a link, a forget, a
// deleted row, an emptied account) reached through that code itself; and
// the nightly sweep, above all that it can never delete a file whose record
// went missing (B1): only objects seen unnamed for the backups' window,
// never in an account being restored or while backups fail, never past the
// breaker. Plus the uploads it throws away, the deletes it finishes, the
// count it puts right, the index it repairs, the placements it checks, and a
// deleted account's folder.

process.env.PLAID_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
const fake = new FakeRedis({ deserialize: true });
mock.module('@/lib/storage', () => storageMock(fake));
mock.module('@/lib/plaid', () => ({ plaidClient: new Proxy({}, { get: () => async () => ({}) }) }));
afterEach(() => expect(unscopedDataKeys(fake)).toEqual([]));

const c = await import('@/lib/crypto');
const att = await import('@/lib/attachments');
const stores = await import('@/lib/attachment-stores');
const objectsMod = await import('@/lib/attachment-objects');
const sweep = await import('@/lib/attachment-sweep');
const backup = await import('@/lib/backup');
const { encodeJsonBlob } = await import('@/lib/blob');
const { forgetEpochs } = await import('@/lib/sessions');
const { sweepContainerExcept } = await import('@/lib/account-deletion');
const { disconnectItem } = await import('@/lib/disconnect-item');
const { linkAccounts } = await import('@/lib/links');
const { forgetSplitsAndGroups } = await import('@/lib/split-gone');
const { keptWhenEmptied } = await import('@/lib/user-restore/classes');

const ctx = TEST_CTX;
const store = new FakeObjects();
const saved = { ...process.env };
const DAY = 86_400_000;
const T0 = Date.parse('2026-10-01T18:00:00.000Z');

async function giveKey(container: string) {
  const p = await c.prepareContainerKey(container as never, { born: false });
  expect((await c.claimContainerKey(p!)).outcome).toBe('made');
}

const row = (id: string, over: Record<string, unknown> = {}) => ({
  transaction_id: id,
  pending_transaction_id: null,
  account_id: 'acc_chk',
  date: '2026-09-20',
  amount: 4.5,
  name: 'BLUE BOTTLE 123',
  merchant_name: 'Blue Bottle',
  merchant_entity_id: null,
  pending: false,
  counterparties: [],
  account_name: 'Checking',
  institution_name: 'Chase',
  iso_currency_code: 'USD',
  unofficial_currency_code: null,
  ...over,
});

async function seedItem(item: string, rows: ReturnType<typeof row>[], opts: { history_pending?: boolean } = {}) {
  await fake.hset(ctxKey('plaid:items'), { [item]: JSON.stringify({ item_id: item, institution_name: 'Chase', encrypted_access_token: await c.encrypt(ctx, 'tok') }) });
  const accounts = Object.fromEntries([...new Set(rows.map((r) => r.account_id as string))].map((a) => [a, { name: 'Checking', official_name: null, type: 'depository', subtype: 'checking', mask: '1', balances: null }]));
  await fake.set(ctxKey(`txns:${item}`), await encodeJsonBlob(ctx, { schema_version: 2, cursor: 'c', accounts, txns: Object.fromEntries(rows.map((r) => [r.transaction_id, r])), ...(opts.history_pending ? { history_pending: true } : {}) }));
}

/** A ready file on a transaction, uploaded through the library. */
async function attach(transaction_id: string, now = T0) {
  const photo = jpeg(3000);
  const { id } = await att.startUpload(ctx, { transaction_id, kind: 'image', bytes: photo.length, part_sha256: [await sha(photo)], thumb: null, name: null }, now);
  await att.receivePart(ctx, id, 0, photo, now);
  return id;
}

const record = (id: string) => stores.attachmentStore.get(ctx, id);
const objectIds = () => new Set([...store.objects.keys()].map((p) => objectsMod.parseObjectPath(ctx, p)?.id));

beforeEach(async () => {
  fake.reset();
  store.reset();
  c.forgetActiveKey();
  c.forgetContainerKey();
  forgetEpochs();
  objectsMod.setAttachmentObjectsForTests(store);
  process.env.MASTER_KEY = MASTER;
  process.env.ATTACHMENTS_QUOTA_MB = '100';
  process.env.BLOB_READ_WRITE_TOKEN = 'vercel_blob_rw_store1_x';
  delete process.env.BACKUP_KEEP_DAYS;
  await registerTestContainer(fake);
  await giveKey(ctx.container);
  await seedItem('item_chase', [row('t_coffee'), row('t_lunch', { amount: 12, name: 'LUNCH' })]);
});
afterEach(() => {
  process.env = { ...saved };
  c.forgetContainerKey();
});
afterAll(() => objectsMod.setAttachmentObjectsForTests(undefined));

describe('the hooks, through the code that changes transactions', () => {
  test('a disconnect keeps the receipt waiting; linking the re-added account puts it back; a forget keeps it', async () => {
    const id = await attach('t_coffee');
    await disconnectItem(ctx, 'item_chase', undefined);
    expect((await record(id))!.place).toMatchObject({ on: 'earlier', account_id: 'acc_chk' });
    expect(objectIds().has(id)).toBe(true);
    await seedItem('item_new', [row('n_coffee', { account_id: 'acc_new' }), row('n_old', { account_id: 'acc_new', date: '2026-01-01', name: 'OLD' })]);
    await linkAccounts(ctx, 'acc_chk', 'acc_new', {}, T0);
    expect((await record(id))!.place).toMatchObject({ on: 'transaction', transaction_id: 'n_coffee', carried: true });

    const other = await attach('n_old');
    await disconnectItem(ctx, 'item_new', undefined);
    await att.forgetEarlierAttachments(ctx, 'acc_new', T0);
    expect((await record(other))!.place).toMatchObject({ on: 'none', why: 'forgotten' });
  });

  test('while the re-added account’s history is still coming, a link leaves it waiting', async () => {
    const id = await attach('t_coffee');
    await disconnectItem(ctx, 'item_chase', undefined);
    await seedItem('item_new', [row('n_coffee', { account_id: 'acc_new' }), row('n_old', { account_id: 'acc_new', date: '2026-01-01' })], { history_pending: true });
    await linkAccounts(ctx, 'acc_chk', 'acc_new', {}, T0);
    expect((await record(id))!.place.on).toBe('earlier');
  });

  test('a row that goes through forgetSplitsAndGroups leaves its files kept, on no transaction', async () => {
    const id = await attach('t_lunch');
    await forgetSplitsAndGroups(ctx, ['t_lunch']);
    expect((await record(id))!.place).toMatchObject({ on: 'none', why: 'gone' });
  });

  test('emptying the account, or undoing a restore, keeps every file, each on no transaction (S8)', async () => {
    const id = await attach('t_coffee');
    for (const name of ['attachments', 'attachment-usage', 'attachment-sweep']) expect([name, keptWhenEmptied(`c:${ctx.container}:${name}`)]).toEqual([name, true]);
    expect(keptWhenEmptied(`c:${ctx.container}:attachment-places`)).toBe(false);
    await sweepContainerExcept(ctx, keptWhenEmptied);
    expect((await record(id))!.place).toMatchObject({ on: 'none', why: 'emptied', was: { transaction_id: 't_coffee' } });
    expect(objectIds().has(id)).toBe(true);
    expect(await stores.placeStore.ids(ctx)).toEqual([]);
    // A caller that didn't keep the records: their files go with them.
    await sweepContainerExcept(ctx, () => false);
    expect(store.objects.size).toBe(0);
  });

  test('the account’s deletion step: every object of its folder, and only its folder', async () => {
    await attach('t_coffee');
    await store.put(`${objectsMod.environmentFolder()}5d1c7e2a-9b3f-4c6d-8e1a-2b3c4d5e6f70/x/0`, new Uint8Array(1));
    expect(await att.deleteContainerFiles(ctx)).toEqual({ deleted: 1, left: 0 });
    expect([...store.objects.keys()]).toEqual([`${objectsMod.environmentFolder()}5d1c7e2a-9b3f-4c6d-8e1a-2b3c4d5e6f70/x/0`]);
    store.fail.add('list');
    expect(await att.deleteContainerFiles(ctx)).toBeNull();
    objectsMod.setAttachmentObjectsForTests(null);
    expect(await att.deleteContainerFiles(ctx)).toBeUndefined();
  });
});

describe('the sweep, per account', () => {
  test('throws away uploads a day past their expiry, finishes deletes, and puts the count and the index right', async () => {
    const ready = await attach('t_coffee');
    const photo = jpeg(3000);
    const { id: stale } = await att.startUpload(ctx, { transaction_id: 't_lunch', kind: 'image', bytes: photo.length, part_sha256: [await sha(photo)], thumb: null, name: null }, T0);
    const gone = await attach('t_lunch');
    store.fail.add('del');
    await att.deleteAttachment(ctx, gone);
    store.fail.clear();
    // A lost index entry, and a lost count.
    await stores.placeStore.remove(ctx, 't_coffee');
    await stores.usageStore.remove(ctx);
    const result = await sweep.runAttachmentSweep(new Date(T0 + att.UPLOAD_MS + 2 * DAY));
    expect([result.uploads_discarded, result.deletes_finished]).toEqual([1, 1]);
    expect([await record(stale), await record(gone)]).toEqual([null, null]);
    expect((await stores.placeStore.get(ctx, 't_coffee'))!.ids).toEqual([ready]);
    expect(await stores.usageStore.get(ctx)).toMatchObject({ files: 1 });
    expect([...objectIds()]).toEqual([ready]);
    const status = (await backup.readAttachmentSweep())!;
    expect([status.last_ok !== null, status.cursor, status.last_failed]).toEqual([true, null, null]);
  });

  test('the placement check: a marked account, a pending id that posted, a row the bank removed, one that kept its id', async () => {
    const onPending = await attach('t_lunch');
    // The sync that should have moved it didn't: the stored rows now hold the
    // posted row naming the pending one, and nothing named t_lunch.
    await seedItem('item_chase', [row('t_coffee'), row('t_posted', { pending_transaction_id: 't_lunch', amount: 12, name: 'LUNCH' })]);
    const removed = await attach('t_coffee');
    await seedItem('item_chase', [row('t_posted', { pending_transaction_id: 't_lunch', amount: 12, name: 'LUNCH' })]);
    await att.markForCheck(ctx, T0);
    const result = await sweep.runAttachmentSweep(new Date(T0 + DAY));
    expect(result.placements_moved).toBe(2);
    expect((await record(onPending))!.place).toMatchObject({ on: 'transaction', transaction_id: 't_posted' });
    expect((await record(removed))!.place).toMatchObject({ on: 'none', why: 'removed' });
    expect((await stores.sweepStateStore.get(ctx))!.check).toBeUndefined();
  });

  test('a store of transactions that can’t be read: nothing moves, and the marker stays', async () => {
    const id = await attach('t_coffee');
    await fake.set(ctxKey('txns:item_chase'), 'not-ciphertext-at-all-but-long');
    await att.markForCheck(ctx, T0);
    await sweep.runAttachmentSweep(new Date(T0 + DAY));
    expect((await record(id))!.place).toMatchObject({ on: 'transaction', transaction_id: 't_coffee' });
    expect((await stores.sweepStateStore.get(ctx))!.check).toBeDefined();
  });

  test('a run out of time carries on from where it stopped', async () => {
    await attach('t_coffee');
    const r1 = await sweep.runAttachmentSweep(new Date(T0), { budgetMs: -1 });
    expect([r1.finished, r1.containers]).toEqual([false, 0]);
    const r2 = await sweep.runAttachmentSweep(new Date(T0));
    expect([r2.finished, r2.containers]).toEqual([true, 1]);
  });
});

describe('the sweep across the store: never a file whose record could come back (B1)', () => {
  const night = (n: number) => new Date(T0 + n * DAY);

  /** Runs the store-wide pass on night n (it runs weekly: the record of the
   *  last listing is cleared so each night lists). */
  async function nightly(n: number) {
    const status = await backup.readAttachmentSweep();
    if (status) await backup.recordAttachmentSweep({ ...status, listed_at: null });
    await backup.recordOutcome({ ok: true }, night(n));
    return sweep.runAttachmentSweep(night(n));
  }

  test('records wiped (an operator restore mid-way, a bad migration): nothing is deleted until 31 days after the objects were first seen unnamed', async () => {
    const ids = [await attach('t_coffee'), await attach('t_lunch')];
    // Many files, so the breaker's share isn't what holds it back.
    for (let i = 0; i < 10; i++) ids.push(await attach(i < 5 ? 't_coffee' : 't_lunch'));
    for (const id of ids) await stores.attachmentStore.remove(ctx, id);
    // Keep one record, so this is no account with none at all.
    const kept = await attach('t_lunch');
    process.env.BACKUP_KEEP_DAYS = '30';
    for (let n = 1; n <= 31; n++) {
      await nightly(n);
      expect([n, ids.every((id) => objectIds().has(id))]).toEqual([n, true]);
    }
    // Seen first on night 1: 31 days later they can go, but twelve of
    // thirteen files at once is past the breaker, so still nothing.
    const r = await nightly(32);
    expect(r.held).toBe(1);
    expect(ids.every((id) => objectIds().has(id))).toBe(true);
    expect((await backup.attachmentSweepProblem(night(32)))?.held).toBe(true);
    expect(objectIds().has(kept)).toBe(true);
  });

  test('a few orphans, past the window, go; one named again before then is forgotten and kept', async () => {
    const keep = [];
    for (let i = 0; i < 10; i++) keep.push(await attach('t_coffee'));
    const orphan = await attach('t_lunch');
    const back = await attach('t_lunch');
    const backRecord = (await fake.hget<unknown>(ctxKey('attachments'), back))!;
    await stores.attachmentStore.remove(ctx, orphan, back);
    process.env.BACKUP_KEEP_DAYS = '3';
    await nightly(1);
    // The record comes back (a restore of last night's backup).
    await fake.hset(ctxKey('attachments'), { [back]: backRecord as string });
    await nightly(2);
    expect(Object.keys((await stores.sweepStateStore.get(ctx))!.unnamed)).toEqual([orphan]);
    await nightly(4);
    expect(objectIds().has(orphan)).toBe(true);
    await nightly(5);
    expect(objectIds().has(orphan)).toBe(false);
    expect(objectIds().has(back)).toBe(true);
    for (const id of keep) expect(objectIds().has(id)).toBe(true);
  });

  test('an unreadable record still names its file', async () => {
    const ids = [];
    for (let i = 0; i < 10; i++) ids.push(await attach('t_coffee'));
    await fake.hset(ctxKey('attachments'), { [ids[0]]: 'damaged-not-ciphertext-at-all' });
    process.env.BACKUP_KEEP_DAYS = '1';
    for (let n = 1; n <= 6; n++) await nightly(n);
    expect(objectIds().has(ids[0])).toBe(true);
  });

  test('an account with objects and no record at all: the breaker, never a delete', async () => {
    const id = await attach('t_coffee');
    await stores.attachmentStore.remove(ctx, id);
    process.env.BACKUP_KEEP_DAYS = '1';
    for (let n = 1; n <= 6; n++) await nightly(n);
    expect(objectIds().has(id)).toBe(true);
  });

  test('never while an account is being restored, nor while backups fail, nor in an account not active', async () => {
    const ids = [];
    for (let i = 0; i < 10; i++) ids.push(await attach('t_coffee'));
    const orphan = await attach('t_lunch');
    await stores.attachmentStore.remove(ctx, orphan);
    process.env.BACKUP_KEEP_DAYS = '1';
    // Another account being restored: no pass at all.
    await fake.hset(testKey('containers'), { '5d1c7e2a-9b3f-4c6d-8e1a-2b3c4d5e6f70': JSON.stringify({ status: 'restoring', primary: false, created_at: '2026-01-01T00:00:00.000Z' }) });
    for (let n = 1; n <= 5; n++) await nightly(n);
    expect(objectIds().has(orphan)).toBe(true);
    expect(await stores.sweepStateStore.get(ctx).then((s) => s?.unnamed ?? {})).toEqual({});
    await fake.hdel(testKey('containers'), '5d1c7e2a-9b3f-4c6d-8e1a-2b3c4d5e6f70');
    // Backups failing: no pass.
    for (let n = 6; n <= 10; n++) {
      const status = await backup.readAttachmentSweep();
      if (status) await backup.recordAttachmentSweep({ ...status, listed_at: null });
      await backup.recordOutcome({ ok: false, reason: 'down' }, night(n));
      await sweep.runAttachmentSweep(night(n));
    }
    expect(objectIds().has(orphan)).toBe(true);
    // This account archived (being deleted): its folder isn't the pass's.
    await registerTestContainer(fake, 'archived');
    for (let n = 11; n <= 15; n++) await nightly(n);
    expect(objectIds().has(orphan)).toBe(true);
  });

  test('a deleted account’s folder is emptied; one neither listed nor deleted is left alone', async () => {
    const DELETED = '5d1c7e2a-9b3f-4c6d-8e1a-2b3c4d5e6f70';
    const UNKNOWN = '7e8f9a0b-1c2d-4e3f-9a4b-5c6d7e8f9a0b';
    await store.put(`${objectsMod.environmentFolder()}${DELETED}/a/0`, new Uint8Array(3));
    await store.put(`${objectsMod.environmentFolder()}${UNKNOWN}/a/0`, new Uint8Array(3));
    await fake.hset(c.tombstonesKey(), { 'k9-deadbeef': JSON.stringify({ container: DELETED, on: '2026-09-01' }) });
    const r = await nightly(1);
    expect(r.deleted_folders).toBe(1);
    expect([...store.objects.keys()]).toEqual([`${objectsMod.environmentFolder()}${UNKNOWN}/a/0`]);
  });

  test('runs weekly, not nightly', async () => {
    await attach('t_coffee');
    await backup.recordOutcome({ ok: true }, night(1));
    const first = await sweep.runAttachmentSweep(night(1));
    const second = await sweep.runAttachmentSweep(night(2));
    await backup.recordOutcome({ ok: true }, night(8));
    const eighth = await sweep.runAttachmentSweep(night(8));
    expect([first.listed, second.listed, eighth.listed]).toEqual([true, false, true]);
  });
});

describe('the cron route', () => {
  test('refuses without the cron secret, and runs with it', async () => {
    process.env.CRON_SECRET = 'cron-secret';
    const route = await import('@/app/api/attachments/sweep/route');
    expect((await route.GET(new Request('http://localhost/api/attachments/sweep'))).status).toBe(401);
    const res = await route.GET(new Request('http://localhost/api/attachments/sweep', { headers: { authorization: 'Bearer cron-secret' } }));
    expect(res.status).toBe(200);
    expect((await res.json()).finished).toBe(true);
  });
});
