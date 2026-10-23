import { describe, expect, test, mock, beforeEach, afterEach } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { clerk } from './clerk-mock';
import { FakeRedis, storageMock, TEST_CTX, ctxKey, testKey, registerTestContainer, unscopedDataKeys } from './fake-redis';

// Your data (lib/inventory.ts, lib/inventory-read.ts, /api/data-inventory):
// every kind of thing Nya keeps about a person, from the same lists the
// download and the key inventory walk, counted and measured without reading
// a value, and what can't be read named, never shown as nothing.

process.env.PLAID_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
process.env.PLAID_CLIENT_ID ||= 'placeholder';
process.env.PLAID_SECRET ||= 'placeholder';

// Deserializing like Upstash: what production reads back.
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
const { encodeJsonBlob } = await import('@/lib/blob');
const { saveItem } = await import('@/lib/storage');
const { defineMapStore, forgetDeclaredStore } = await import('@/lib/repo');
const { declaredStores } = await import('@/lib/stores');
const { EXACT, PREFIXES } = await import('@/lib/key-families');
const { STORED_KEYS } = await import('@/lib/user-export');
const { RETENTION_ROWS, registryGaps, containerEntry, outsideEntry, families, keptRows } = await import('@/lib/inventory');
const { readInventory, windowWords } = await import('@/lib/inventory-read');
const { ownerContainer } = await import('@/lib/owners');
const { createInvite, acceptInvite } = await import('@/lib/sharing');
const { forgetEpochs } = await import('@/lib/sessions');
const route = await import('@/app/api/data-inventory/route');
const { default: PrivacyPage } = await import('@/app/privacy/page');

const ctx = TEST_CTX;
const OTHER = { container: '7c1d9e4a-52b3-4f6e-9a08-3d2e1f0a9b8c' } as typeof ctx;
const NOW = Date.parse('2026-10-22T12:00:00.000Z');
const OWN_KEY = 'k1-0a1b2c3d';

const saved = { ...process.env };
const errors = console.error;
beforeEach(async () => {
  fake.reset();
  sent.length = 0;
  forgetEpochs();
  console.error = () => {};
  await registerTestContainer(fake);
});
afterEach(() => {
  process.env = { ...saved };
  clerk.signedIn = null;
  console.error = errors;
});

type Inv = Awaited<ReturnType<typeof readInventory>>;
const rows = (inv: Inv) => inv.groups.flatMap((g) => g.rows);
const row = (inv: Inv, id: string) => {
  const r = rows(inv).find((x) => x.id === id);
  if (!r) throw new Error(`no row ${id}`);
  return r;
};
/** A hash's or string's bytes as stored: field names and values together. */
const bytesOf = (key: string): number => {
  const s = fake.strings.get(key);
  if (s !== undefined) return Buffer.byteLength(s);
  return [...(fake.hashes.get(key) ?? [])].reduce((n, [f, v]) => n + Buffer.byteLength(f) + Buffer.byteLength(v), 0);
};

describe('the registry', () => {
  test('every key family and every declared store has one entry, and no entry names one that is gone', () => {
    expect(registryGaps()).toEqual({ missing: [], stale: [] });
    expect(declaredStores().length).toBeGreaterThan(50);
  });

  test('a store declared without an entry is missing from it, so this test fails until one is written', () => {
    defineMapStore('inventory-test-new-store', { what: 'test things', isValid: (v: unknown): v is unknown => true, exportable: true });
    try {
      expect(registryGaps().missing).toEqual(['inventory-test-new-store']);
    } finally {
      forgetDeclaredStore('inventory-test-new-store');
    }
    expect(registryGaps().missing).toEqual([]);
  });

  test('each family lives in the container or outside it, never both, as lib/containers.ts says', async () => {
    const { isEnvWide } = await import('@/lib/containers');
    for (const f of families()) {
      expect([f, containerEntry(f) !== null, outsideEntry(f) !== null]).toEqual([f, !isEnvWide(f), isEnvWide(f)]);
    }
  });

  test("what the download does with each family in a container comes from the download's own list", () => {
    for (const f of families().filter((f) => containerEntry(f) !== null)) {
      expect([f, STORED_KEYS.some(([k]) => k === f)]).toEqual([f, true]);
    }
  });

  test('every retention row an entry names is a row of the privacy page’s table, word for word', () => {
    process.env.MASTER_KEY = Buffer.alloc(32, 9).toString('base64');
    process.env.BLOB_READ_WRITE_TOKEN = 'vercel_blob_rw_placeholder';
    const html = renderToStaticMarkup(PrivacyPage());
    for (const title of RETENTION_ROWS) expect([title, html.includes(`<th scope="row">${title}</th>`)]).toEqual([title, true]);
    const named = new Set([...families(), ...declaredStores().map((s) => s.name), 'fx:ecb'].flatMap((n) => keptRows(containerEntry(n) ?? outsideEntry(n)!)));
    expect([...named].filter((r) => !(RETENTION_ROWS as readonly string[]).includes(r))).toEqual([]);
  });

  test('every count that limits how often is kept for an hour or a day, as the privacy page says of them', () => {
    for (const s of declaredStores()) {
      if (s.kind !== 'counter' && s.kind !== 'counter-map') continue;
      if (!keptRows(containerEntry(s.name)!).includes('Counts that limit how often you can do something')) continue;
      expect([s.name, [3600, 86_400].includes(s.windowSeconds)]).toEqual([s.name, true]);
    }
  });

  test('a window in words', () => {
    expect([windowWords(3600), windowWords(86_400), windowWords(600), windowWords(60), windowWords(7200), windowWords(45)]).toEqual([
      'an hour',
      'a day',
      '10 minutes',
      'a minute',
      '2 hours',
      '45 seconds',
    ]);
  });
});

describe('reading it', () => {
  test('an empty account: every kind listed, each holding nothing, as read', async () => {
    const inv = await readInventory(ctx, { userId: null, now: NOW });
    expect(inv.as_of).toBe('2026-10-22T12:00:00.000Z');
    expect(inv.measured).toBe(true);
    expect(inv.unknown).toBeNull();
    expect(inv.key).toEqual({ own: false, since: null, moved: null });
    const yours = rows(inv).filter((r) => r.where === 'yours');
    expect(yours.length).toBe(families().filter((f) => containerEntry(f) !== null).length + declaredStores().length);
    for (const r of yours) expect([r.id, r.status, r.count, r.chars]).toEqual([r.id, 'read', 0, 0]);
    // The account's own record, outside the container, is counted for it.
    expect(row(inv, 'containers')).toMatchObject({ where: 'environment', status: 'read', count: 1, chars: null });
    // With the shared password there are no people: nothing of sharing, nor a sign-in.
    for (const id of ['owners', 'connections', 'invites:', 'grants']) expect(rows(inv).some((r) => r.id === id)).toBe(false);
    // What is about nobody by name is said apart, and not counted.
    expect(inv.elsewhere.map((r) => [r.id, r.status])).toEqual([
      ['ratelimit:', 'not-counted'],
      ['backups:', 'not-counted'],
      ['fx:ecb', 'not-counted'],
    ]);
  });

  test('counts and sizes as stored, the older stores’ and the seam’s, and the key each value claims', async () => {
    await fake.hset(ctxKey('history:net-worth'), {
      '2026-10-01': await encrypt(ctx, '100'),
      '2026-10-02': await encrypt(ctx, '110'),
      '2026-10-03': await encrypt(ctx, '120'),
    });
    await fake.set(ctxKey('txns:item1'), await encodeJsonBlob(ctx, { txns: {}, accounts: {} }));
    await fake.set(ctxKey('txns:item2'), await encodeJsonBlob(ctx, { txns: { a: 1 }, accounts: {} }));
    await saveItem(ctx, { item_id: 'item1', institution_name: 'Chase', encrypted_access_token: await encrypt(ctx, 'access-sandbox-1') });
    await fake.hset(ctxKey('timeline-notes'), { n1: await encrypt(ctx, '{}'), n2: await encrypt(ctx, '{}') });
    await fake.set(ctxKey('download-count'), '2');
    await fake.hset(ctxKey('history:backfill-pending'), { tries: '1' });

    const inv = await readInventory(ctx, { userId: null, now: NOW });
    expect(row(inv, 'history:net-worth')).toMatchObject({
      status: 'read',
      count: 3,
      chars: bytesOf(ctxKey('history:net-worth')),
      encryption: { kind: 'encrypted', own: 0, shared: 3, unclear: 0, not_ciphertext: 0 },
      download: { included: true, text: 'In your download, under net_worth_history (recorded).' },
      kept: ['Your data'],
      plain: 'The days with a balance, as field names.',
    });
    expect(row(inv, 'txns:')).toMatchObject({ count: 2, chars: bytesOf(ctxKey('txns:item1')) + bytesOf(ctxKey('txns:item2')), unit: ['bank connection', 'bank connections'] });
    expect(row(inv, 'plaid:items')).toMatchObject({ count: 1, chars: bytesOf(ctxKey('plaid:items')), encryption: { kind: 'token' } });
    expect(row(inv, 'timeline-notes')).toMatchObject({
      count: 2,
      chars: bytesOf(ctxKey('timeline-notes')),
      encryption: { kind: 'encrypted', shared: 2 },
      download: { included: true, text: 'In your download, under timeline-notes.' },
    });
    expect(row(inv, 'download-count')).toMatchObject({
      count: 1,
      chars: 1,
      encryption: { kind: 'plain' },
      download: { included: false },
      kept: ['Counts that limit how often you can do something'],
      kept_detail: 'Each count lasts an hour from the first.',
    });
    expect(row(inv, 'history:backfill-pending')).toMatchObject({ count: 1, encryption: { kind: 'plain' }, download: { included: false, text: 'Not in your download: a retry count for the estimate.' } });
    // A store the download carries under another part's name says so.
    expect(row(inv, 'budget-set').download).toEqual({ included: true, text: 'In your download, under budgets.' });
    expect(row(inv, 'api-tokens').download.text).toContain('never the hash');
    expect(row(inv, 'connector-secrets').download).toEqual({ included: false, text: 'Not in your download: a credential, not your data.' });
  });

  test('whether the nightly backups copy each kind comes from the backup’s own lists', async () => {
    const { isExcluded } = await import('@/lib/export');
    delete process.env.BLOB_READ_WRITE_TOKEN;
    expect((await readInventory(ctx, { userId: null, now: NOW })).backups).toBe('none');
    process.env.BLOB_READ_WRITE_TOKEN = 'vercel_blob_rw_placeholder';
    process.env.BACKUP_KEEP_DAYS = 'a month';
    expect((await readInventory(ctx, { userId: null, now: NOW })).backups).toBe('invalid');
    delete process.env.BACKUP_KEEP_DAYS;
    const inv = await readInventory(ctx, { userId: null, now: NOW });
    expect(inv.backups).toBe('kept');
    for (const r of [...rows(inv), ...inv.elsewhere]) expect([r.id, r.backed_up]).toEqual([r.id, !isExcluded(r.id) && r.id !== 'fx:ecb']);
    expect(['history:net-worth', 'txns:', 'goals'].map((id) => row(inv, id).backed_up)).toEqual([true, true, true]);
    expect(['api-tokens', 'connector-secrets', 'cache:', 'snapshot:'].map((id) => row(inv, id).backed_up)).toEqual([false, false, false, false]);
  });

  test('under the account’s own key, or one this copy shares, told apart by what each value claims', async () => {
    await fake.hset(testKey('crypto:container-keys'), { [ctx.container]: JSON.stringify({ key: OWN_KEY, since: '2026-02-01T00:00:00.000Z' }) });
    await fake.hset(ctxKey('manual:accounts'), {
      m1: `v2.${OWN_KEY}.-.${'A'.repeat(48)}`,
      m2: `v2.${OWN_KEY}.-.${'B'.repeat(48)}`,
      m3: await encrypt(OTHER, 'still under the original key'),
      m4: 'damaged, not ciphertext',
    });
    const inv = await readInventory(ctx, { userId: null, now: NOW });
    expect(inv.key).toEqual({ own: true, since: '2026-02-01T00:00:00.000Z', moved: null });
    expect(row(inv, 'manual:accounts')).toMatchObject({ status: 'read', count: 4, encryption: { kind: 'encrypted', own: 2, shared: 1, unclear: 0, not_ciphertext: 1 } });
    expect(row(inv, 'crypto:')).toMatchObject({ where: 'environment', status: 'read', count: 1 });
  });

  test('a key nothing names is counted as such, never left out; a family kept for the whole environment found inside the container is one', async () => {
    await fake.set(ctxKey('something-a-later-version-writes'), 'abc');
    await fake.hset(ctxKey('connections'), { x: 'y' });
    const inv = await readInventory(ctx, { userId: null, now: NOW });
    expect(inv.unknown).toEqual({ keys: 2, chars: 3 + 2 });
  });
});

describe('what can’t be read is named, never shown as nothing', () => {
  test('a step of the measure that fails: each kind it held is unreadable, its count and size null', async () => {
    await fake.hset(ctxKey('history:net-worth'), { '2026-10-01': await encrypt(ctx, '100') });
    await fake.hset(ctxKey('manual:accounts'), { m1: await encrypt(ctx, '{}') });
    fake.failNext('eval');
    const inv = await readInventory(ctx, { userId: null, now: NOW });
    expect(inv.measured).toBe(true);
    for (const id of ['history:net-worth', 'manual:accounts']) {
      expect(row(inv, id)).toMatchObject({ status: 'unreadable', count: null, chars: null });
    }
    // Kinds it found nothing of are still known to hold nothing.
    expect(row(inv, 'goals')).toMatchObject({ status: 'read', count: 0 });
  });

  test('a container that can’t be walked: every kind in it unreadable, none of them zero', async () => {
    await fake.hset(ctxKey('history:net-worth'), { '2026-10-01': await encrypt(ctx, '100') });
    fake.failNext('scan');
    const inv = await readInventory(ctx, { userId: null, now: NOW });
    expect(inv.measured).toBe(false);
    expect(inv.unknown).toBeNull();
    const yours = rows(inv).filter((r) => r.where === 'yours');
    expect(yours.length).toBeGreaterThan(80);
    for (const r of yours) expect([r.id, r.status, r.count, r.chars]).toEqual([r.id, 'unreadable', null, null]);
    // What is read apart from the walk still is.
    expect(row(inv, 'containers')).toMatchObject({ status: 'read', count: 1 });
  });

  test('a data key entry that can’t be read: the key is unknown and its row unreadable, never "no key"', async () => {
    await fake.hset(testKey('crypto:container-keys'), { [ctx.container]: 'not an entry' });
    const inv = await readInventory(ctx, { userId: null, now: NOW });
    expect(inv.key).toBeNull();
    expect(row(inv, 'crypto:')).toMatchObject({ status: 'unreadable', count: null });
  });

  test('an unknown key that couldn’t be measured: counted, its size not', async () => {
    await fake.set(ctxKey('something-new'), 'abc');
    fake.failNext('eval');
    const inv = await readInventory(ctx, { userId: null, now: NOW });
    expect(inv.unknown).toEqual({ keys: 1, chars: null });
  });
});

describe('numbers only', () => {
  test('nothing is decrypted, no value is read, and nothing is written', async () => {
    await fake.hset(ctxKey('history:net-worth'), { '2026-10-01': await encrypt(ctx, '100') });
    await fake.set(ctxKey('goals'), await encrypt(ctx, '[{"name":"Trip"}]'));
    await fake.set(ctxKey('txns:item1'), await encodeJsonBlob(ctx, { txns: {}, accounts: {} }));
    await fake.hset(ctxKey('timeline-notes'), { n1: await encrypt(ctx, '{"text":"moved house"}') });
    sent.length = 0;
    // Under another key, anything decrypted would fail, and its row with it.
    process.env.PLAID_ENCRYPTION_KEY = Buffer.alloc(32, 8).toString('base64');
    const inv = await readInventory(ctx, { userId: null, now: NOW });
    for (const id of ['history:net-worth', 'goals', 'txns:', 'timeline-notes']) expect(row(inv, id).status).toBe('read');

    const prefix = ctxKey('');
    const touched = sent.flatMap(([command, args]) => {
      if (command === 'eval') return (args[1] as string[]).filter((k) => k.startsWith(prefix)).map((k) => [String(args[0]).split('\n', 1)[0], k] as const);
      return typeof args[0] === 'string' && args[0].startsWith(prefix) ? [[command, args[0]] as const] : [];
    });
    // Inside the container, only the seam's measure, which returns no value.
    expect([...new Set(touched.map(([how]) => how))]).toEqual(['-- nya:repo-measure-keys']);
    const writes = ['set', 'hset', 'hsetnx', 'del', 'hdel', 'incr', 'expire', 'rename', 'getdel'];
    expect(sent.filter(([command]) => writes.includes(command))).toEqual([]);
    // And the answer holds no stored text: no merchant, note or goal.
    expect(JSON.stringify(inv)).not.toMatch(/Trip|moved house/);
  });
});

describe('the route', () => {
  const get = (q = '') => route.GET(new Request(`http://x/api/data-inventory${q}`));

  test('answers the signed-in person’s own list', async () => {
    await fake.hset(ctxKey('history:net-worth'), { '2026-10-01': await encrypt(ctx, '100') });
    const res = await get();
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    const inv = await res.json();
    expect(row(inv, 'history:net-worth')).toMatchObject({ status: 'read', count: 1 });
  });

  test('takes no options: a query string is refused, never read as another container', async () => {
    for (const q of ['?container=7c1d9e4a-52b3-4f6e-9a08-3d2e1f0a9b8c', '?x', '?']) {
      const res = await get(q);
      expect([q, res.status]).toEqual([q, q === '?' ? 200 : 400]);
    }
  });

  test('a container that is not available is a 503, as everywhere', async () => {
    await registerTestContainer(fake, 'restoring');
    forgetEpochs();
    expect((await get()).status).toBe(503);
  });

  test('with Clerk, each person sees their own container only, their sign-in and their connections', async () => {
    process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY = 'pk_test_x';
    process.env.CLERK_SECRET_KEY = 'sk_test_x';
    process.env.CLERK_ALLOWED_USER_IDS = 'user_a,user_b';
    await ownerContainer('user_a'); // claims the test container
    const theirs = { container: await ownerContainer('user_b') };
    await fake.hset(ctxKey('history:net-worth'), { '2026-10-01': await encrypt(ctx, '1'), '2026-10-02': await encrypt(ctx, '2') });
    await fake.hset(ctxKey('history:net-worth', theirs), { '2026-10-01': await encrypt(theirs as typeof ctx, '9') });
    const { token } = await createInvite('user_a', { fromName: 'Ann', theirLabel: 'Bea' });
    await acceptInvite('user_b', token, 'Ann');

    clerk.signedIn = 'user_b';
    const b = await (await get()).json();
    expect(row(b, 'history:net-worth').count).toBe(1);
    expect(row(b, 'owners')).toMatchObject({ status: 'read', count: 1 });
    expect(row(b, 'connections')).toMatchObject({ status: 'read', count: 1, download: { included: true } });
    expect(row(b, 'invites:')).toMatchObject({ status: 'not-counted', count: null });
    expect(row(b, 'connections').seen).toEqual(['People you share with, only what you choose to share']);

    clerk.signedIn = 'user_a';
    const a = await (await get()).json();
    expect(row(a, 'history:net-worth').count).toBe(2);
    expect(row(a, 'connections').count).toBe(1);
  });
});

// Every family is on one list or the other: a reminder of what the lists are.
test('the lists the registry covers', () => {
  expect(families().length).toBe(Object.keys(EXACT).length + PREFIXES.length);
});
