import { describe, expect, test, mock, beforeEach, afterEach } from 'bun:test';
import { FakeRedis, storageMock, TEST_CTX, ctxKey, registerTestContainer, unscopedDataKeys } from './fake-redis';

// Every key a container can hold has one class for a restore
// (lib/user-restore/classes.ts), and the scan of an account (empty.ts) reads
// a container by them.

process.env.PLAID_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
const fake = new FakeRedis({ deserialize: true });
afterEach(() => expect(unscopedDataKeys(fake)).toEqual([]));
mock.module('@/lib/storage', () => storageMock(fake));

const { classOfKey, unclassified, FAMILY_CLASSES, STORE_CLASSES } = await import('@/lib/user-restore/classes');
const { scanAccount, inUseMessage } = await import('@/lib/user-restore/empty');
const { declaredStores } = await import('@/lib/stores');
const { EXACT, PREFIXES } = await import('@/lib/key-families');
const { encrypt } = await import('@/lib/crypto');
const ctx = TEST_CTX;

beforeEach(async () => {
  fake.reset();
  await registerTestContainer(fake);
});

describe('the classes', () => {
  test('every key family and every declared store has exactly one', () => {
    expect(unclassified()).toEqual([]);
  });

  test('nothing classed that doesn’t exist: every entry names a family or a store', () => {
    const families = new Set([...Object.keys(EXACT), ...PREFIXES.map(([p]) => p)]);
    for (const f of Object.keys(FAMILY_CLASSES)) expect(families.has(f)).toBe(true);
    const stores = new Set(declaredStores().map((s) => s.name));
    for (const s of Object.keys(STORE_CLASSES)) expect(stores.has(s)).toBe(true);
  });

  test('every counter store is machinery by its kind, named or not', () => {
    for (const s of declaredStores()) {
      if (s.kind === 'counter' || s.kind === 'counter-map') {
        expect(classOfKey(`c:${TEST_CTX.container}:${s.name}`).cls).toBe('machinery');
        expect(Object.hasOwn(STORE_CLASSES, s.name)).toBe(false);
      }
    }
  });

  test('a key nothing names is data, never nothing', () => {
    expect(classOfKey(`c:${TEST_CTX.container}:something-new`)).toEqual({ family: null, cls: 'data' });
  });

  test('prefixes and exact names', () => {
    expect(classOfKey(`c:${TEST_CTX.container}:txns:item1`)).toEqual({ family: 'txns:', cls: 'data' });
    expect(classOfKey(`c:${TEST_CTX.container}:cache:net-worth`)).toEqual({ family: 'cache:', cls: 'machinery' });
    expect(classOfKey(`c:${TEST_CTX.container}:categories`)).toEqual({ family: 'categories', cls: 'setting' });
    expect(classOfKey(`c:${TEST_CTX.container}:user-restore`)).toEqual({ family: 'user-restore', cls: 'record' });
  });
});

describe('the scan', () => {
  test('a new account is empty', async () => {
    expect(await scanAccount(ctx)).toEqual({ empty: true, record: false, found: [], unseen: false, settings: [], banks: [], credentials: { plaid: 0, simplefin: 0 } });
  });

  test('machinery and the person’s tokens are ignored; settings are listed, and the account is still empty', async () => {
    await fake.set(ctxKey('cache:net-worth'), 'x');
    await fake.set(ctxKey('sessions:epoch'), '1');
    await fake.set(ctxKey('download-count'), '1');
    await fake.hset(ctxKey('api-tokens'), { t1: 'x' });
    await fake.set(ctxKey('categories'), 'x');
    await fake.set(ctxKey('fire-plan'), 'x');
    const scan = await scanAccount(ctx);
    expect(scan.empty).toBe(true);
    expect(scan.settings).toEqual(['categories', 'fire-plan']);
  });

  test('the person’s money makes it in use, said in words, with the banks by name', async () => {
    await fake.hset(ctxKey('plaid:items'), { item1: JSON.stringify({ item_id: 'item1', institution_name: 'Chase', encrypted_access_token: await encrypt(ctx, 'tok') }) });
    await fake.hset(ctxKey('history:net-worth'), { '2026-10-01': await encrypt(ctx, '100') });
    await fake.hset(ctxKey('manual:accounts'), { manual_1: 'x' });
    const scan = await scanAccount(ctx);
    expect(scan.empty).toBe(false);
    expect(scan.found).toEqual(['linked banks', 'manual accounts', 'balance history']);
    expect(scan.banks).toEqual(['Chase']);
    expect(scan.credentials).toEqual({ plaid: 1, simplefin: 0 });
    const message = inUseMessage(scan);
    expect(message).toContain('linked banks (Chase), manual accounts and balance history');
    expect(message).not.toContain('item1');
  });

  test('a key nothing names refuses, and the words say only emptying or whoever runs the copy can clear it', async () => {
    await fake.set(ctxKey('left-by-an-old-version'), 'x');
    const scan = await scanAccount(ctx);
    expect(scan.empty).toBe(false);
    expect(scan.unseen).toBe(true);
    expect(inUseMessage(scan)).toContain('ask whoever runs this copy');
  });

  test('a restore’s record is not data, but the account isn’t empty for another', async () => {
    await fake.set(ctxKey('user-restore'), 'x');
    const scan = await scanAccount(ctx);
    expect(scan).toMatchObject({ empty: false, record: true, found: [] });
  });

  test('another container’s keys are never seen', async () => {
    const other = { container: '2b6f0cc9-1e1f-4a3b-9c1e-7d3e5b1a0c42' } as typeof ctx;
    await fake.hset(`${ctxKey('x').split(':c:')[0]}:c:${other.container}:history:net-worth`, { '2026-10-01': 'x' });
    expect((await scanAccount(ctx)).empty).toBe(true);
  });
});
