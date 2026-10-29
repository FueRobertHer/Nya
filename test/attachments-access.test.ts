import { describe, expect, test, mock, beforeEach, afterEach, afterAll } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { clerk } from './clerk-mock';
import { FakeRedis, storageMock, TEST_CTX, registerTestContainer, testKey, unscopedDataKeys } from './fake-redis';
import { FakeObjects, jpeg, sha, partShas, MASTER } from './attachment-fixture';

// Who reaches receipts and documents (#47), through the routes as signed in
// with Clerk: the person whose files they are, and no one else. Another
// account's session finds none of them, by any route; the Activity list
// marks which of the person's own rows have one, and says whether they can
// be added; no other reader of transactions (the API, a share, a report) is
// ever given that mark (review S15).

process.env.PLAID_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
mock.module('@/lib/plaid', () => ({
  plaidClient: new Proxy(
    {},
    {
      get: () => async () => {
        throw new Error('Plaid must not be called');
      },
    }
  ),
}));
const fake = new FakeRedis({ deserialize: true });
mock.module('@/lib/storage', () => storageMock(fake));
afterEach(() => expect(unscopedDataKeys(fake)).toEqual([]));

const c = await import('@/lib/crypto');
const objectsMod = await import('@/lib/attachment-objects');
const { PART_BYTES } = await import('@/lib/attachment-crypto');
const { forgetEpochs } = await import('@/lib/sessions');
const { saveManualAccount } = await import('@/lib/manual');
const { addManualTxn, newManualTxn } = await import('@/lib/manual-txns');
const { markAttached } = await import('@/lib/activity');
const route = await import('@/app/api/attachments/route');
const one = await import('@/app/api/attachments/[id]/route');
const parts = await import('@/app/api/attachments/[id]/parts/[part]/route');
const file = await import('@/app/api/attachments/[id]/file/route');
const thumb = await import('@/app/api/attachments/[id]/thumb/route');
const download = await import('@/app/api/attachments/download/route');
const transactions = await import('@/app/api/transactions/route');

const OTHER = { container: '7e2f1a3b-4c5d-4e6f-8a7b-9c0d1e2f3a4b' } as typeof TEST_CTX;
const store = new FakeObjects();
const saved = { ...process.env };

async function giveKey(container: string) {
  const p = await c.prepareContainerKey(container as never, { born: false });
  expect((await c.claimContainerKey(p!)).outcome).toBe('made');
}

const as = async <T>(user: string, fn: () => Promise<T>) => {
  clerk.signedIn = user;
  return fn();
};

let coffee = '';
let lunch = '';

async function upload(transaction_id: string, body: Uint8Array) {
  const th = jpeg(900, 'THUMB');
  const start = await route.POST(
    new Request('http://localhost/api/attachments', {
      method: 'POST',
      body: JSON.stringify({ transaction_id, kind: 'image', bytes: body.length, part_sha256: await partShas(body, PART_BYTES), thumb: { bytes: th.length, sha256: await sha(th) } }),
    })
  );
  const started = await start.json();
  expect(start.status).toBe(200);
  for (let i = 0; i * PART_BYTES < body.length; i++) {
    const res = await parts.PUT(new Request('http://x', { method: 'PUT', body: body.subarray(i * PART_BYTES, (i + 1) * PART_BYTES) as BodyInit }), { params: Promise.resolve({ id: started.id, part: String(i) }) });
    expect(res.status).toBe(200);
  }
  const res = await parts.PUT(new Request('http://x', { method: 'PUT', body: th as BodyInit }), { params: Promise.resolve({ id: started.id, part: 't' }) });
  expect(res.status).toBe(200);
  return started.id as string;
}

const params = (id: string) => ({ params: Promise.resolve({ id }) });
const load = async () => (await (await transactions.GET(new Request('http://localhost/api/transactions'))).json()) as any;

beforeEach(async () => {
  fake.reset();
  store.reset();
  c.forgetActiveKey();
  c.forgetContainerKey();
  forgetEpochs();
  objectsMod.setAttachmentObjectsForTests(store);
  process.env.MASTER_KEY = MASTER;
  process.env.ATTACHMENTS_QUOTA_MB = '1';
  process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY = 'pk_test_x';
  process.env.CLERK_SECRET_KEY = 'sk_test_x';
  process.env.CLERK_ALLOWED_USER_IDS = 'user_owner,user_other';
  await registerTestContainer(fake);
  await fake.hset(testKey('containers'), { [OTHER.container]: JSON.stringify({ status: 'active', primary: false, created_at: '2026-02-01T00:00:00.000Z' }) });
  await fake.hset(testKey('owners'), { user_owner: TEST_CTX.container, user_other: OTHER.container });
  await giveKey(TEST_CTX.container);
  await giveKey(OTHER.container);
  // The owner's wallet, with two purchases; the other account has one of
  // its own, so it is no empty account that finds nothing.
  const at = '2026-09-01T00:00:00.000Z';
  await saveManualAccount(TEST_CTX, { account_id: 'manual_cash', name: 'Wallet', institution_name: 'Cash', type: 'depository', subtype: null, balance: 100, updated_at: at });
  coffee = (await addManualTxn(TEST_CTX, newManualTxn('manual_cash', { amount: 4.5, currency: 'USD', name: 'Blue Bottle', category: 'food and drink', note: null, date: '2026-09-11' }))).row.id;
  lunch = (await addManualTxn(TEST_CTX, newManualTxn('manual_cash', { amount: 12, currency: 'USD', name: 'Lunch place', category: 'food and drink', note: null, date: '2026-09-12' }))).row.id;
  await saveManualAccount(OTHER, { account_id: 'manual_other', name: 'Purse', institution_name: 'Cash', type: 'depository', subtype: null, balance: 10, updated_at: at });
  await addManualTxn(OTHER, newManualTxn('manual_other', { amount: 3, currency: 'USD', name: 'Tea', category: 'food and drink', note: null, date: '2026-09-11' }));
});
afterEach(() => {
  process.env = { ...saved };
  clerk.signedIn = null;
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

describe('another account’s session', () => {
  test('finds none of the owner’s files, by any route, and changes none', async () => {
    const id = await as('user_owner', () => upload(coffee, jpeg(3000, 'OWNER-RECEIPT')));
    await as('user_other', async () => {
      for (const res of [await file.GET(new Request(`http://x/api/attachments/${id}/file`), params(id)), await thumb.GET(new Request(`http://x/api/attachments/${id}/thumb`), params(id))]) {
        expect(res.status).toBe(404);
        expect(await res.text()).not.toContain('OWNER-RECEIPT');
      }
      expect((await one.PATCH(new Request('http://x', { method: 'PATCH', body: JSON.stringify({ name: 'mine now' }) }), params(id))).status).toBe(404);
      expect((await one.PATCH(new Request('http://x', { method: 'PATCH', body: JSON.stringify({ transaction_id: coffee }) }), params(id))).status).toBe(404);
      expect((await one.DELETE(new Request('http://x', { method: 'DELETE' }), params(id))).status).toBe(404);
      // A part sent to the owner's upload id: no upload there.
      expect((await parts.PUT(new Request('http://x', { method: 'PUT', body: new Uint8Array(10) as BodyInit }), { params: Promise.resolve({ id, part: '0' }) })).status).toBe(404);
      // The owner's transaction id, asked for by name: nothing on it here.
      expect((await (await route.GET(new Request(`http://x/api/attachments?ids=${coffee}`))).json()).files).toEqual([]);
      expect((await (await route.GET(new Request('http://x/api/attachments'))).json()).files).toEqual([]);
      // Nor attaching to the owner's transaction from here: it isn't one of theirs.
      const start = await route.POST(new Request('http://x', { method: 'POST', body: JSON.stringify({ transaction_id: coffee, kind: 'image', bytes: 10, part_sha256: ['0'.repeat(64)] }) }));
      expect(start.status).toBe(404);
      // And the ZIP plan holds nothing of the owner's.
      const plan = await (await download.GET()).json();
      expect(plan.volumes).toEqual([]);
      // Their Activity has no mark from the owner's.
      expect((await load()).transactions.every((t: any) => t.attached === undefined)).toBe(true);
    });
    // The owner's file is as it was.
    await as('user_owner', async () => {
      const res = await file.GET(new Request(`http://x/api/attachments/${id}/file`), params(id));
      expect(res.status).toBe(200);
      expect(Buffer.from(await res.arrayBuffer()).toString('latin1')).toContain('OWNER-RECEIPT');
    });
  });
});

describe('the Activity list', () => {
  test('marks the person’s own rows that have one, and says whether adding is on', async () => {
    await as('user_owner', async () => {
      let body = await load();
      expect(body.attachments).toEqual({ connected: true, uploads: true });
      expect(body.transactions.some((t: any) => 'attached' in t)).toBe(false);
      await upload(coffee, jpeg(3000));
      body = await load();
      const row = (id: string) => body.transactions.find((t: any) => t.transaction_id === id);
      expect(row(coffee).attached).toBe(true);
      expect(row(coffee).attached_on).toEqual([coffee]);
      expect('attached' in row(lunch)).toBe(false);
      // Off without the quota setting: still shown, not offered.
      delete process.env.ATTACHMENTS_QUOTA_MB;
      body = await load();
      expect(body.attachments).toEqual({ connected: true, uploads: false });
      expect(row(coffee).attached).toBe(true);
      // Without a file store, nothing at all is offered.
      objectsMod.setAttachmentObjectsForTests(null);
      expect((await load()).attachments).toEqual({ connected: false, uploads: false });
    });
  });

  test('a demo account (off production, shared by everyone) is never offered adding, and is refused it', async () => {
    process.env.VERCEL_ENV = 'preview';
    process.env.DEMO_USER_IDS = 'user_owner:Sam';
    await as('user_owner', async () => {
      expect((await load()).attachments).toEqual({ connected: true, uploads: false });
      const start = await route.POST(new Request('http://x', { method: 'POST', body: JSON.stringify({ transaction_id: coffee, kind: 'image', bytes: 10, part_sha256: ['0'.repeat(64)] }) }));
      expect(start.status).toBe(403);
    });
  });

  test('an index that can’t be read: every row says it isn’t known, never "none"', () => {
    const rows = [{ transaction_id: 'a', pending: false }, { transaction_id: 'b', pending: true }] as any[];
    markAttached(rows, new Map(), null);
    expect(rows.map((r) => r.attached)).toEqual([null, null]);
  });

  test('a posted row shows the files of the imported rows it stands for; a pending one stands for none yet', () => {
    const rows = [
      { transaction_id: 'posted', pending: false },
      { transaction_id: 'pending', pending: true },
      { transaction_id: 'plain', pending: false },
    ] as any[];
    markAttached(rows, new Map([['posted', ['imported-1']], ['pending', ['imported-2']]]), new Set(['imported-1', 'imported-2']));
    expect(rows.map((r) => [r.attached, r.attached_on])).toEqual([[true, ['imported-1']], [undefined, undefined], [undefined, undefined]]);
  });

  test('a group’s row has them when one of its transactions does', async () => {
    await as('user_owner', async () => {
      await upload(lunch, jpeg(3000));
      const groups = await import('@/app/api/transaction-groups/route');
      const category_id = (await load()).categories.categories[0].id;
      const made = await groups.POST(new Request('http://x', { method: 'POST', body: JSON.stringify({ name: 'Day out', members: [coffee, lunch], category_id }) }));
      if (made.status !== 200) throw new Error(JSON.stringify(await made.json()));
      const body = await load();
      const group = body.transactions.find((t: any) => Array.isArray(t.group_members));
      expect(group.attached).toBe(true);
      expect(group.attached_on).toEqual([lunch]);
      expect(group.group_members.find((m: any) => m.transaction_id === lunch).attached).toBe(true);
      expect('attached' in group.group_members.find((m: any) => m.transaction_id === coffee)).toBe(false);
    });
  });
});

describe('no other reader of transactions is given the mark', () => {
  // Every caller of finishActivity, the one place rows are marked: only the
  // person's own Activity route asks for it.
  const ROOT = join(import.meta.dir, '..');
  const sources = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      if (name === 'node_modules' || name.startsWith('.')) return [];
      return statSync(path).isDirectory() ? sources(path) : /\.(ts|tsx)$/.test(name) ? [path] : [];
    });

  test('only app/api/transactions passes `attached`', () => {
    const callers = [...sources(join(ROOT, 'lib')), ...sources(join(ROOT, 'app'))].filter((f) => /\bfinishActivity\(/.test(readFileSync(f, 'utf8')));
    expect(callers.length).toBeGreaterThan(1);
    const marking = callers.filter((f) => /finishActivity\([^;]*\battached\s*:/s.test(readFileSync(f, 'utf8').replace(/\/\/.*$/gm, '')));
    expect(marking.map((f) => relative(ROOT, f).replaceAll('\\', '/'))).toEqual(['app/api/transactions/route.ts']);
  });

  test('and nothing but it and the attachment routes reads which transactions have one', () => {
    const readers = [...sources(join(ROOT, 'lib')), ...sources(join(ROOT, 'app'))]
      .filter((f) => /\battachedIds\(/.test(readFileSync(f, 'utf8')))
      .map((f) => relative(ROOT, f).replaceAll('\\', '/'))
      .sort();
    expect(readers).toEqual(['app/api/transactions/route.ts', 'lib/attachments.ts']);
  });
});
