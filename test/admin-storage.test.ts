import { describe, expect, test, mock, beforeEach, afterEach } from 'bun:test';
import { clerk } from './clerk-mock';
import { FakeRedis, storageMock, TEST_CTX, ctxKey, testKey, registerTestContainer, unscopedDataKeys } from './fake-redis';

// The admin's view of storage across every account (lib/admin-storage.ts,
// /api/admin/storage): who may see it, that it reads sizes and counts and
// the plain-text records alone, never anyone's data, and that each
// container's numbers are its own.

process.env.PLAID_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
process.env.PLAID_CLIENT_ID ||= 'placeholder';
process.env.PLAID_SECRET ||= 'placeholder';

const fake = new FakeRedis({ deserialize: true });
/** Every command sent through redis(), with its arguments. */
const sent: [string, unknown[]][] = [];
const recorded = new Proxy(fake, {
  get(target, prop, receiver) {
    const value = Reflect.get(target, prop, receiver);
    if (typeof value !== 'function' || typeof prop !== 'string') return value;
    return (...args: unknown[]) => {
      sent.push([prop, args]);
      return value.apply(target, args);
    };
  },
});
afterEach(() => expect(unscopedDataKeys(fake)).toEqual([]));
mock.module('@/lib/storage', () => ({ ...storageMock(fake), redis: () => recorded, rawRedis: () => recorded }));

const { encrypt } = await import('@/lib/crypto');
const { saveItem } = await import('@/lib/storage');
const { readAdminStorage, MAX_PAGE } = await import('@/lib/admin-storage');
const { maxBlobChars } = await import('@/lib/blob');
const { forgetEpochs } = await import('@/lib/sessions');
const route = await import('@/app/api/admin/storage/route');
const { default: AdminStoragePage } = await import('@/app/admin/storage/page');

const admin = TEST_CTX;
const OTHER = { container: '7c1d9e4a-52b3-4f6e-9a08-3d2e1f0a9b8c' } as typeof admin;
const NOW = Date.parse('2026-10-22T12:00:00.000Z');

const saved = { ...process.env };
const errors = console.error;
beforeEach(async () => {
  fake.reset();
  sent.length = 0;
  forgetEpochs();
  console.error = () => {};
  await registerTestContainer(fake);
  await fake.hset(testKey('containers'), {
    [OTHER.container]: JSON.stringify({ status: 'active', primary: false, created_at: '2026-02-01T00:00:00.000Z' }),
  });
});
afterEach(() => {
  process.env = { ...saved };
  clerk.signedIn = null;
  console.error = errors;
});

/** Every key of a container and its bytes, as stored. */
function storedIn(ctx: typeof admin): { total: number; largest: number; keys: number } {
  const prefix = ctxKey('', ctx);
  let total = 0;
  let largest = 0;
  let keys = 0;
  for (const [key, value] of fake.strings) {
    if (!key.startsWith(prefix)) continue;
    keys++;
    total += Buffer.byteLength(value);
    largest = Math.max(largest, Buffer.byteLength(value));
  }
  for (const [key, h] of fake.hashes) {
    if (!key.startsWith(prefix) || h.size === 0) continue;
    keys++;
    for (const [f, v] of h) {
      total += Buffer.byteLength(f) + Buffer.byteLength(v);
      largest = Math.max(largest, Buffer.byteLength(v));
    }
  }
  return { total, largest, keys };
}

async function seed() {
  await saveItem(admin, { item_id: 'item1', institution_name: 'Chase', encrypted_access_token: await encrypt(admin, 'access-1'), transactions_billed: true });
  await saveItem(admin, { item_id: 'item2', institution_name: 'Schwab', encrypted_access_token: await encrypt(admin, 'access-2') });
  await fake.set(ctxKey('txns:item1'), await encrypt(admin, 'x'.repeat(900)));
  await fake.set(ctxKey('invtxns:item2'), await encrypt(admin, 'y'.repeat(200)));
  await fake.set(ctxKey('txns-blocked:item1'), JSON.stringify({ chars: 9_000_000 }));
  await fake.set(ctxKey('txns:gone'), await encrypt(admin, 'z'.repeat(50))); // a disconnect left it
  await fake.hset(ctxKey('snapshot:item-usage'), {
    item1: JSON.stringify({ first_seen: '2026-08-01T00:00:00.000Z', error_since: '2026-08-02T00:00:00.000Z', hidden_since: null, checked_at: '2026-10-21T08:00:00.000Z', flagged: 'refused', confirmed_run: 'r1' }),
  });
  await fake.hset(ctxKey('snapshot:runs'), {
    '2026-10-20': JSON.stringify({ status: 'recorded', at: '2026-10-20T08:00:00.000Z', attempts: 1 }),
    '2026-10-21': JSON.stringify({ status: 'failed', reason: 'Plaid: ITEM_LOGIN_REQUIRED', at: '2026-10-21T08:00:00.000Z', attempts: 2 }),
  });
  await fake.hset(ctxKey('connector-connections'), { c1: await encrypt(admin, '{}'), c2: await encrypt(admin, '{}') });
  await fake.hset(ctxKey('connector-secrets'), { c1: await encrypt(admin, 'https://user:pass@bridge.example') });
  await fake.hset(ctxKey('connector-accounts'), { manual_a: await encrypt(admin, '{}'), manual_b: await encrypt(admin, '{}'), manual_c: await encrypt(admin, '{}') });
  await fake.hset(ctxKey('history:net-worth'), { '2026-10-01': await encrypt(admin, '12345.67') });

  await saveItem(OTHER, { item_id: 'theirs', institution_name: 'Ally', encrypted_access_token: await encrypt(OTHER, 'access-3') });
  await fake.set(ctxKey('txns:theirs', OTHER), await encrypt(OTHER, 'w'.repeat(5000)));
}

describe('the view', () => {
  test('every account by its id, with its Items, blobs, connections, storage and last snapshot, each its own', async () => {
    await seed();
    const view = await readAdminStorage(admin, { now: NOW });
    expect(view).toMatchObject({ as_of: '2026-10-22T12:00:00.000Z', ceiling_chars: maxBlobChars(), total: 2, next: null });
    const [mine, theirs] = view.containers;
    expect(mine).toMatchObject({ container: admin.container, you: true, status: 'active', created_at: '2026-01-01T00:00:00.000Z' });
    expect(theirs).toMatchObject({ container: OTHER.container, you: false, created_at: '2026-02-01T00:00:00.000Z' });

    const stored = storedIn(admin);
    expect(mine.storage).toEqual({ keys: stored.keys, total_chars: stored.total, largest_chars: stored.largest, unmeasured: 0 });
    expect(mine.items).toEqual([
      {
        item_id: 'item1',
        institution_name: 'Chase',
        transactions_billed: true,
        txns_chars: fake.strings.get(ctxKey('txns:item1'))!.length,
        invtxns_chars: 0,
        blocked: true,
        unsaved: false,
        usage: { flagged: 'refused', refused_since: '2026-08-02T00:00:00.000Z', hidden_since: null, checked_at: '2026-10-21T08:00:00.000Z' },
        usage_unreadable: false,
      },
      {
        item_id: 'item2',
        institution_name: 'Schwab',
        transactions_billed: null,
        txns_chars: 0,
        invtxns_chars: fake.strings.get(ctxKey('invtxns:item2'))!.length,
        blocked: false,
        unsaved: false,
        usage: null,
        usage_unreadable: false,
      },
    ]);
    expect(mine.orphaned).toEqual([{ item_id: 'gone', txns_chars: fake.strings.get(ctxKey('txns:gone'))!.length, invtxns_chars: 0 }]);
    expect(mine.connectors).toEqual({ connections: 2, with_credential: 1, accounts: 3 });
    expect(mine.snapshot).toEqual({ date: '2026-10-21', status: 'failed', reason: 'Plaid: ITEM_LOGIN_REQUIRED', at: '2026-10-21T08:00:00.000Z', attempts: 2 });

    const theirsStored = storedIn(OTHER);
    expect(theirs.storage).toEqual({ keys: theirsStored.keys, total_chars: theirsStored.total, largest_chars: theirsStored.largest, unmeasured: 0 });
    expect(theirs.items!.map((i) => [i.item_id, i.txns_chars])).toEqual([['theirs', fake.strings.get(ctxKey('txns:theirs', OTHER))!.length]]);
    expect(theirs.connectors).toEqual({ connections: 0, with_credential: 0, accounts: 0 });
    expect(theirs.snapshot).toBeNull();
    expect(theirs.orphaned).toEqual([]);
  });

  test('a page at a time, in id order, after a cursor', async () => {
    const first = await readAdminStorage(admin, { limit: 1, now: NOW });
    expect(first.containers.map((c) => c.container)).toEqual([admin.container]);
    expect(first.next).toBe(admin.container);
    expect(first.total).toBe(2);
    const second = await readAdminStorage(admin, { after: first.next, limit: 1, now: NOW });
    expect(second.containers.map((c) => c.container)).toEqual([OTHER.container]);
    expect(second.next).toBeNull();
    expect((await readAdminStorage(admin, { after: OTHER.container })).containers).toEqual([]);
  });

  test('nothing is decrypted, and no value read but the plain-text records it shows; nothing is written', async () => {
    await seed();
    sent.length = 0;
    // Under another key, anything decrypted would fail.
    process.env.PLAID_ENCRYPTION_KEY = Buffer.alloc(32, 8).toString('base64');
    const view = await readAdminStorage(admin, { now: NOW });
    expect(view.containers.every((c) => c.storage !== null && c.items !== null)).toBe(true);

    const touched = new Set<string>();
    for (const [command, args] of sent) {
      if (command === 'eval') {
        const script = String(args[0]).split('\n', 1)[0];
        expect(script).toBe('-- nya:repo-measure-keys');
        expect((args[2] as string[])[0]).toBe('0'); // no heads either
        continue;
      }
      const key = typeof args[0] === 'string' ? args[0] : '';
      for (const ctx of [admin, OTHER]) if (key.startsWith(ctxKey('', ctx))) touched.add(`${command} ${key.slice(ctxKey('', ctx).length)}`);
    }
    // The Items' records are read too, through getItems, which the double
    // answers itself: plain text but for the token, which is never opened.
    expect([...touched].sort()).toEqual(['hgetall snapshot:item-usage', 'hgetall snapshot:runs']);
    const writes = ['set', 'hset', 'hsetnx', 'del', 'hdel', 'incr', 'expire', 'rename', 'getdel'];
    expect(sent.filter(([command]) => writes.includes(command))).toEqual([]);
    // No amount, and no credential, in the answer.
    expect(JSON.stringify(view)).not.toMatch(/12345|bridge\.example|access-/);
  });

  test('a walk that fails: every account’s sizes and markers unknown, said as such, never zero, and its records still read', async () => {
    await seed();
    fake.failNext('scan');
    const view = await readAdminStorage(admin, { now: NOW });
    for (const c of view.containers) {
      expect([c.storage, c.connectors, c.orphaned]).toEqual([null, null, null]);
      for (const i of c.items!) expect([i.txns_chars, i.invtxns_chars, i.blocked, i.unsaved]).toEqual([null, null, null, null]);
    }
    // The Items, their checks and the snapshot are read apart from the walk.
    expect(view.containers[0].items!.map((i) => [i.item_id, i.usage?.flagged ?? null])).toEqual([
      ['item1', 'refused'],
      ['item2', null],
    ]);
    expect(view.containers[0].snapshot?.date).toBe('2026-10-21');
  });

  test('records that can’t be read are said so: an Item’s check, and the newest snapshot run, never an older one in its place', async () => {
    await seed();
    await fake.hset(ctxKey('snapshot:item-usage'), { item2: 'not a record' });
    await fake.hset(ctxKey('snapshot:runs'), { '2026-10-22': 'not a run' });
    const [mine] = (await readAdminStorage(admin, { now: NOW })).containers;
    expect(mine.items!.find((i) => i.item_id === 'item2')).toMatchObject({ usage: null, usage_unreadable: true });
    expect(mine.items!.find((i) => i.item_id === 'item1')).toMatchObject({ usage_unreadable: false });
    expect([mine.snapshot, mine.snapshot_unreadable]).toEqual([null, true]);
  });

  test('one walk for the whole page, however many accounts are on it', async () => {
    await seed();
    sent.length = 0;
    await readAdminStorage(admin, { limit: 1, now: NOW });
    const one = sent.filter(([command]) => command === 'scan').length;
    sent.length = 0;
    await readAdminStorage(admin, { now: NOW });
    expect(sent.filter(([command]) => command === 'scan').length).toBe(one);
    expect(route.maxDuration).toBe(300);
  });
});

describe('the route', () => {
  const get = (q = '') => route.GET(new Request(`http://x/api/admin/storage${q}`));

  test('answers the admin', async () => {
    await seed();
    const res = await get('?limit=1');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.containers.map((c: { container: string }) => c.container)).toEqual([admin.container]);
    expect(body.next).toBe(admin.container);
    const rest = await (await get(`?after=${admin.container}`)).json();
    expect(rest.containers.map((c: { container: string }) => c.container)).toEqual([OTHER.container]);
  });

  test('checks every parameter', async () => {
    for (const q of ['?after=nope', '?after=', '?limit=0', `?limit=${MAX_PAGE + 1}`, '?limit=x', '?limit=1.5', '?limit=01', '?limit=1&limit=2', '?container=x', `?after=${admin.container}&after=${OTHER.container}`]) {
      const res = await get(q);
      expect([q, res.status]).toEqual([q, 400]);
    }
    for (const q of ['', '?limit=1', `?limit=${MAX_PAGE}`, `?after=${OTHER.container}&limit=5`]) expect([q, (await get(q)).status]).toEqual([q, 200]);
  });

  test('refuses everyone else with a 404, before looking at what they sent, and reads none of anyone’s storage for them', async () => {
    await seed();
    process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY = 'pk_test_x';
    process.env.CLERK_SECRET_KEY = 'sk_test_x';
    process.env.CLERK_ALLOWED_USER_IDS = 'user_a,user_b';
    // user_a owns the deployment's own container, so is the admin.
    await fake.hset(testKey('owners'), { user_a: admin.container, user_b: OTHER.container });
    clerk.signedIn = 'user_b';
    sent.length = 0;
    for (const q of ['', '?limit=1', '?after=nope', '?container=x']) {
      const res = await get(q);
      expect([q, res.status, await res.json()]).toEqual([q, 404, { error: 'Not found' }]);
    }
    expect(sent.filter(([command]) => command === 'scan' || command === 'eval')).toEqual([]);
    expect(sent.some(([, args]) => typeof args[0] === 'string' && args[0].startsWith(ctxKey('', admin)))).toBe(false);

    clerk.signedIn = 'user_a';
    expect((await get()).status).toBe(200);
  });

  test('the page too: anyone else gets the 404 page, the admin the view', async () => {
    process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY = 'pk_test_x';
    process.env.CLERK_SECRET_KEY = 'sk_test_x';
    process.env.CLERK_ALLOWED_USER_IDS = 'user_a,user_b';
    await fake.hset(testKey('owners'), { user_a: admin.container, user_b: OTHER.container });
    clerk.signedIn = 'user_b';
    await expect(AdminStoragePage()).rejects.toMatchObject({ digest: 'NEXT_HTTP_ERROR_FALLBACK;404' });
    clerk.signedIn = null;
    await expect(AdminStoragePage()).rejects.toMatchObject({ digest: 'NEXT_HTTP_ERROR_FALLBACK;404' });
    clerk.signedIn = 'user_a';
    expect(await AdminStoragePage()).toBeTruthy();
  });
});
