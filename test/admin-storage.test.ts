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
const { saveItem, getItems } = await import('@/lib/storage');
const { readAdminStorage, MAX_PAGE } = await import('@/lib/admin-storage');
const { maxBlobChars } = await import('@/lib/blob');
const { forgetEpochs } = await import('@/lib/sessions');
const route = await import('@/app/api/admin/storage/route');
const unused = await import('@/app/api/admin/unused/route');
const { default: AdminStoragePage, generateMetadata } = await import('@/app/admin-view/storage/page');
const jobsPage = await import('@/app/admin-view/jobs/page');
const { proxy } = await import('@/proxy');
const { isAdminSignIn } = await import('@/lib/admin-gate');
const { isAdmin, adminCtx } = await import('@/lib/admin-items');
const { NextRequest } = await import('next/server');

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
  // Demo accounts (lib/demo.ts) off unless a test turns them on, whatever
  // .env files bun loaded.
  delete process.env.VERCEL_ENV;
  delete process.env.DEMO_USER_IDS;
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

  test('one step that fails: what its keys hold is unknown, said as such, never 0 or nothing refused', async () => {
    await saveItem(admin, { item_id: 'item1', institution_name: 'Chase', encrypted_access_token: await encrypt(admin, 'access-1') });
    await fake.set(ctxKey('txns:item1'), 'x'.repeat(5000));
    await fake.set(ctxKey('txns-blocked:item1'), JSON.stringify({ at: '2026-10-21T08:00:00.000Z', chars: 9_000_000 }));
    await fake.hset(ctxKey('connector-connections'), { c1: await encrypt(admin, '{}') });
    // The walk works; the step measuring the admin's keys doesn't.
    fake.failNext('eval');
    const [mine, theirs] = (await readAdminStorage(admin, { now: NOW })).containers;
    expect(mine.storage!.unmeasured).toBeGreaterThan(0);
    expect(mine.items!.map((i) => [i.item_id, i.txns_chars, i.invtxns_chars, i.blocked, i.unsaved])).toEqual([['item1', null, null, null, null]]);
    expect([mine.connectors, mine.orphaned]).toEqual([null, null]);
    expect(theirs.connectors).toEqual({ connections: 0, with_credential: 0, accounts: 0 });
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

  test('the page: anyone else’s request goes on to no route, as any missing path does; the admin’s to where it lives', async () => {
    process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY = 'pk_test_x';
    process.env.CLERK_SECRET_KEY = 'sk_test_x';
    process.env.CLERK_ALLOWED_USER_IDS = 'user_a,user_b';
    await fake.hset(testKey('owners'), { user_a: admin.container, user_b: OTHER.container });
    const open = (path: string) => proxy(new NextRequest(`https://nya.test${path}`, { headers: { accept: 'text/html' } }), {} as any);
    /** Whether it was rewritten, and where to, and the page's policy beside it. */
    const where = async (path: string) => {
      const res = await open(path);
      expect(res.headers.get('content-security-policy-report-only') ?? res.headers.get('content-security-policy')).toContain('nonce-');
      return res.headers.get('x-middleware-rewrite');
    };
    clerk.signedIn = 'user_b';
    // Untouched, exactly as a path that does not exist: no route answers it.
    for (const path of ['/admin/storage', '/admin/storage/x', '/admin/jobs', '/admin', '/no-such-page']) expect([path, await where(path)]).toEqual([path, null]);
    // Where the page lives, asked for directly: a path no route matches.
    for (const path of ['/admin-view/storage', '/admin-view/jobs', '/admin-view']) expect([path, await where(path)]).toEqual([path, 'https://nya.test/__nya-no-such-page__']);
    // Other pages are untouched.
    expect(await where('/your-data')).toBeNull();
    expect(await where('/administer')).toBeNull();
    clerk.signedIn = 'user_a';
    expect(await where('/admin/storage')).toBe('https://nya.test/admin-view/storage');
    expect(await where('/admin/storage?x=1')).toBe('https://nya.test/admin-view/storage?x=1');
    expect(await where('/admin-view/storage')).toBeNull();
    expect(await where('/admin/jobs')).toBe('https://nya.test/admin-view/jobs');
  });

  test('the proxy’s gate decides as the admin’s routes do, reading only', async () => {
    process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY = 'pk_test_x';
    process.env.CLERK_SECRET_KEY = 'sk_test_x';
    await fake.hset(testKey('owners'), { user_a: admin.container, user_b: OTHER.container });
    expect([await isAdminSignIn('user_a'), await isAdmin(admin)]).toEqual([true, true]);
    expect([await isAdminSignIn('user_b'), await isAdmin(OTHER)]).toEqual([false, false]);
    const before = JSON.stringify([...fake.hashes.get(testKey('owners'))!]);
    expect(await isAdminSignIn('user_new')).toBe(false); // no container made for them
    expect(JSON.stringify([...fake.hashes.get(testKey('owners'))!])).toBe(before);
    expect(await isAdminSignIn(null)).toBe(false); // with Clerk on, someone must be signed in
    // With the shared password, the one person is the admin, while there is a container.
    delete process.env.CLERK_SECRET_KEY;
    forgetEpochs();
    expect(await isAdminSignIn(null)).toBe(true);
    fake.reset();
    forgetEpochs();
    expect(await isAdminSignIn(null)).toBe(false);
  });

  /** Preview with its demo accounts on (lib/demo.ts): Clerk on, user_demo is Alex. */
  function demosOn() {
    process.env.VERCEL_ENV = 'preview';
    process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY = 'pk_test_x';
    process.env.CLERK_SECRET_KEY = 'sk_test_x';
    process.env.CLERK_ALLOWED_USER_IDS = 'user_a,user_b';
    process.env.DEMO_USER_IDS = 'user_demo:Alex';
  }
  /** The reads of the whole owners map sent so far. */
  const ownersReads = () => sent.filter(([command, args]) => command === 'hgetall' && args[0] === testKey('owners')).length;

  test('a demo account that owns the deployment’s container is not the admin, and while it does, nobody is', async () => {
    demosOn();
    await seed();
    await fake.hset(testKey('owners'), { user_demo: admin.container, user_b: OTHER.container });
    expect([await isAdminSignIn('user_demo'), await isAdmin(admin)]).toEqual([false, false]);
    expect([await isAdminSignIn('user_b'), await isAdmin(OTHER)]).toEqual([false, false]);
    expect(await isAdminSignIn(null)).toBe(false); // Clerk is on

    // Everywhere the admin's things are, the demo gets what anyone else gets.
    clerk.signedIn = 'user_demo';
    expect(await adminCtx()).toBeNull();
    const open = (path: string) => proxy(new NextRequest(`https://nya.test${path}`, { headers: { accept: 'text/html' } }), {} as any);
    // Passed on untouched (not turned away for some other reason): no rewrite and no redirect.
    for (const path of ['/admin/storage', '/admin/jobs']) {
      const res = await open(path);
      expect([path, res.headers.get('x-middleware-rewrite'), res.headers.get('location')]).toEqual([path, null, null]);
    }
    expect((await open('/admin-view/storage')).headers.get('x-middleware-rewrite')).toBe('https://nya.test/__nya-no-such-page__');
    expect((await route.GET(new Request('http://x/api/admin/storage'))).status).toBe(404);
    await expect(AdminStoragePage()).rejects.toMatchObject({ digest: 'NEXT_HTTP_ERROR_FALLBACK;404' });
    await expect(jobsPage.default()).rejects.toMatchObject({ digest: 'NEXT_HTTP_ERROR_FALLBACK;404' });
    const items = JSON.stringify(await getItems(admin));
    expect((await unused.GET()).status).toBe(404);
    expect((await unused.POST()).status).toBe(404);
    const del = await unused.DELETE(new Request('http://x/api/admin/unused', { method: 'DELETE', body: JSON.stringify({ container: admin.container, item_id: 'item1' }) }));
    expect(del.status).toBe(404);
    expect(JSON.stringify(await getItems(admin))).toBe(items);

    // A demo account elsewhere changes nothing for the owner of the deployment's container.
    fake.hashes.delete(testKey('owners'));
    await fake.hset(testKey('owners'), { user_a: admin.container, user_demo: OTHER.container });
    expect([await isAdminSignIn('user_a'), await isAdmin(admin)]).toEqual([true, true]);
    expect([await isAdminSignIn('user_demo'), await isAdmin(OTHER)]).toEqual([false, false]);
  });

  test('a container mapped by hand to a real account and a demo one: nobody is the admin, the real one included', async () => {
    demosOn();
    await fake.hset(testKey('owners'), { user_a: admin.container, user_demo: admin.container });
    expect([await isAdminSignIn('user_a'), await isAdmin(admin)]).toEqual([false, false]);
    expect(await isAdminSignIn('user_demo')).toBe(false);
  });

  test('with demo accounts on, a container nobody is mapped to is not the admin’s: an empty list of owners is a read to doubt', async () => {
    demosOn();
    await fake.hset(testKey('owners'), { user_b: OTHER.container });
    expect(await isAdmin(admin)).toBe(false);
    // The same mapping without demo accounts: the deployment's container, as ever.
    delete process.env.DEMO_USER_IDS;
    expect(await isAdmin(admin)).toBe(true);
  });

  test('owners that can’t be read: nobody is the admin, and the routes answer their usual 404, not an error', async () => {
    demosOn();
    await fake.hset(testKey('owners'), { user_a: admin.container });
    // Only the owners map fails; the registry (also a whole-hash read) still answers.
    const real = fake.hgetall.bind(fake);
    (fake as any).hgetall = async (key: string) => {
      if (key === testKey('owners')) throw new Error('Redis is down');
      return real(key);
    };
    try {
      expect([await isAdminSignIn('user_a'), await isAdmin(admin)]).toEqual([false, false]);
      clerk.signedIn = 'user_a';
      expect(await adminCtx()).toBeNull();
      const res = await route.GET(new Request('http://x/api/admin/storage'));
      expect([res.status, await res.json()]).toEqual([404, { error: 'Not found' }]);
      expect((await unused.GET()).status).toBe(404);
    } finally {
      delete (fake as any).hgetall;
    }
  });

  test('no read of the owners map where demo accounts can’t exist, nor for a container that isn’t the deployment’s', async () => {
    // Production, with DEMO_USER_IDS set there by mistake: it does nothing.
    demosOn();
    process.env.VERCEL_ENV = 'production';
    await fake.hset(testKey('owners'), { user_a: admin.container, user_b: OTHER.container });
    sent.length = 0;
    expect([await isAdminSignIn('user_a'), await isAdmin(admin)]).toEqual([true, true]);
    expect(ownersReads()).toBe(0);
    // Preview, asked about anyone else's container.
    process.env.VERCEL_ENV = 'preview';
    expect([await isAdminSignIn('user_b'), await isAdmin(OTHER)]).toEqual([false, false]);
    expect(ownersReads()).toBe(0);
  });

  test('the page too: anyone else gets the 404 page, the admin the view', async () => {
    process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY = 'pk_test_x';
    process.env.CLERK_SECRET_KEY = 'sk_test_x';
    process.env.CLERK_ALLOWED_USER_IDS = 'user_a,user_b';
    await fake.hset(testKey('owners'), { user_a: admin.container, user_b: OTHER.container });
    clerk.signedIn = 'user_b';
    await expect(AdminStoragePage()).rejects.toMatchObject({ digest: 'NEXT_HTTP_ERROR_FALLBACK;404' });
    // Its title and description are never made for them either.
    await expect(generateMetadata()).rejects.toMatchObject({ digest: 'NEXT_HTTP_ERROR_FALLBACK;404' });
    clerk.signedIn = null;
    await expect(AdminStoragePage()).rejects.toMatchObject({ digest: 'NEXT_HTTP_ERROR_FALLBACK;404' });
    await expect(generateMetadata()).rejects.toMatchObject({ digest: 'NEXT_HTTP_ERROR_FALLBACK;404' });
    clerk.signedIn = 'user_a';
    expect(await AdminStoragePage()).toBeTruthy();
    expect((await generateMetadata()).title).toBe('Storage across accounts · Nya');
  });

  test('the Nightly jobs page is gated the same way', async () => {
    process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY = 'pk_test_x';
    process.env.CLERK_SECRET_KEY = 'sk_test_x';
    process.env.CLERK_ALLOWED_USER_IDS = 'user_a,user_b';
    await fake.hset(testKey('owners'), { user_a: admin.container, user_b: OTHER.container });
    for (const who of ['user_b', null]) {
      clerk.signedIn = who;
      await expect(jobsPage.default()).rejects.toMatchObject({ digest: 'NEXT_HTTP_ERROR_FALLBACK;404' });
      await expect(jobsPage.generateMetadata()).rejects.toMatchObject({ digest: 'NEXT_HTTP_ERROR_FALLBACK;404' });
    }
    clerk.signedIn = 'user_a';
    expect(await jobsPage.default()).toBeTruthy();
    expect((await jobsPage.generateMetadata()).title).toBe('Nightly jobs · Nya');
  });
});
