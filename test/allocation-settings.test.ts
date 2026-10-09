import { describe, expect, test, mock, beforeEach, afterEach } from 'bun:test';
import { clerk } from './clerk-mock';
import { FakeRedis, storageMock, TEST_CTX, TEST_CONTAINER, ctxKey, registerTestContainer, unscopedDataKeys, testKey } from './fake-redis';
import type { AllocationSettings } from '@/lib/allocation/settings';

// The allocation settings: a value store on the storage seam, and the route
// that reads and saves it, answering errors as every seam route does.

process.env.PLAID_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');

const fake = new FakeRedis({ deserialize: true });
afterEach(() => expect(unscopedDataKeys(fake)).toEqual([]));
mock.module('@/lib/storage', () => storageMock(fake));

const { encrypt, decrypt } = await import('@/lib/crypto');
const { StoredDataUnreadableError, UnreadableValueError } = await import('@/lib/repo');
const { allocationSettingsStore } = await import('@/lib/allocation-settings');
const { declaredStore } = await import('@/lib/stores');
const { classify } = await import('@/lib/reencrypt');
const route = await import('@/app/api/allocation-settings/route');
const { forgetEpochs } = await import('@/lib/sessions');

const KEY = ctxKey('allocation-settings');
const env = { ...process.env };

beforeEach(async () => {
  fake.reset();
  forgetEpochs();
  clerk.signedIn = null;
  await registerTestContainer(fake);
});
afterEach(() => {
  process.env = { ...env };
});

const saved: AllocationSettings = {
  v: 1,
  buckets: [{ account_id: 'acc_401k', bucket: 'roth' }],
  funds: [
    { ticker: 'VFIFX', split: { 'us-stocks': 54, 'intl-stocks': 36, bonds: 10 } },
    { name: 'Target Retirement 2050 Trust II', split: { stocks: 90, bonds: 10 } },
  ],
  accounts: [{ account_id: 'manual_1', split: { cash: 100 } }],
  target: { stocks: 80, bonds: 20 },
};

const put = (body: unknown) => route.PUT(new Request('http://x', { method: 'PUT', body: typeof body === 'string' ? body : JSON.stringify(body) }));
const get = () => route.GET();
const quiet = async <T>(f: () => Promise<T>): Promise<T> => {
  const orig = console.error;
  console.error = () => {};
  try {
    return await f();
  } finally {
    console.error = orig;
  }
};

describe('the store', () => {
  test('is declared on the seam, exportable, and on the key inventory as one string inside a container', () => {
    const store = declaredStore('allocation-settings');
    expect(store).toMatchObject({ kind: 'value', exportable: true, what: 'allocation settings' });
    expect(classify(KEY.replace(/^[^:]+:(?=c:)/, ''))).toBe('string');
    expect(classify('allocation-settings')).toBeNull();
  });

  test('keeps the settings encrypted, as saved, and never saved reads as null', async () => {
    expect(await allocationSettingsStore.get(TEST_CTX)).toBeNull();
    await allocationSettingsStore.set(TEST_CTX, saved);
    const raw = await fake.get<string>(KEY);
    expect(typeof raw).toBe('string');
    expect(raw).not.toContain('VFIFX');
    expect(JSON.parse(await decrypt(raw as string))).toEqual(saved);
    expect(await allocationSettingsStore.get(TEST_CTX)).toEqual(saved);
  });

  test('damaged bytes are unreadable, a later release’s settings are not understood, and neither reads as none', async () => {
    await fake.set(KEY, 'not-ciphertext-at-all-but-long-enough');
    const damaged = await allocationSettingsStore.get(TEST_CTX).catch((e: unknown) => e);
    expect(damaged).toBeInstanceOf(UnreadableValueError);
    expect((damaged as InstanceType<typeof UnreadableValueError>).unrecognised).toBe(false);
    for (const later of [{ ...saved, v: 2 }, { ...saved, rebalance: 'yearly' }, { ...saved, target: { gold: 100 } }]) {
      await fake.set(KEY, await encrypt(JSON.stringify(later)));
      const e = await allocationSettingsStore.get(TEST_CTX).catch((err: unknown) => err);
      expect(e).toBeInstanceOf(StoredDataUnreadableError);
      expect((e as InstanceType<typeof UnreadableValueError>).unrecognised).toBe(true);
    }
  });

  test('saving over an unreadable value is refused, and it is left as it was', async () => {
    await fake.set(KEY, 'unreadable-but-recoverable');
    await expect(allocationSettingsStore.set(TEST_CTX, saved)).rejects.toBeInstanceOf(StoredDataUnreadableError);
    expect(await fake.get<string>(KEY)).toBe('unreadable-but-recoverable');
  });
});

describe('the route', () => {
  test('loads null before anything is saved, then what was saved', async () => {
    expect(await (await get()).json()).toEqual({ settings: null });
    const res = await put({ settings: saved });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ settings: saved });
    expect(await (await get()).json()).toEqual({ settings: saved });
  });

  test('saves the clean copy: tickers upper case, names trimmed', async () => {
    const res = await put({ settings: { ...saved, funds: [{ ticker: 'vfifx', split: { bonds: 100 } }, { name: '  A  Trust ', split: { cash: 100 } }] } });
    expect(res.status).toBe(200);
    expect((await allocationSettingsStore.get(TEST_CTX))!.funds).toEqual([
      { ticker: 'VFIFX', split: { bonds: 100 } },
      { name: 'A Trust', split: { cash: 100 } },
    ]);
  });

  test('refuses invalid settings with the reason, and stores nothing', async () => {
    const cases: [unknown, string][] = [
      [{ settings: { ...saved, funds: [{ ticker: 'VTI', split: { 'us-stocks': 99 } }] } }, 'adds up to 99%'],
      [{ settings: { ...saved, funds: [{ ticker: 'NOT A TICKER', split: { stocks: 100 } }] } }, 'ticker symbol'],
      [{ settings: { ...saved, target: { stocks: 50, 'us-stocks': 50 } } }, 'one or the other'],
      [{ settings: { ...saved, buckets: Array.from({ length: 201 }, (_, i) => ({ account_id: `a${i}`, bucket: 'roth' })) } }, 'at most 200'],
      [{ settings: { ...saved, extra: true } }, 'unknown field'],
      [{}, 'must be an object'],
      [{ settings: null }, 'must be an object'],
    ];
    for (const [body, reason] of cases) {
      const res = await put(body);
      expect(res.status).toBe(400);
      expect((await res.json()).error).toContain(reason);
    }
    expect((await put('{not json')).status).toBe(400);
    expect((await put(null)).status).toBe(400);
    expect(await fake.get(KEY)).toBeNull();
  });

  test('an unreadable store is a flagged 409 on load and on save, and is left alone', async () => {
    await fake.set(KEY, 'unreadable');
    const loaded = await quiet(() => get());
    expect(loaded.status).toBe(409);
    expect(await loaded.json()).toMatchObject({ unreadable: true, error: expect.stringContaining('allocation settings') });
    const res = await quiet(() => put({ settings: saved }));
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ unreadable: true });
    expect(await fake.get<string>(KEY)).toBe('unreadable');
  });

  test('settings a later release saved are a flagged 409 too, and are not replaced', async () => {
    const later = await encrypt(JSON.stringify({ ...saved, v: 2 }));
    await fake.set(KEY, later);
    expect((await quiet(() => get())).status).toBe(409);
    expect((await quiet(() => put({ settings: saved }))).status).toBe(409);
    expect(await fake.get<string>(KEY)).toBe(later);
  });

  test('a database failure is a 500 without the flag', async () => {
    fake.failNext('get');
    const res = await quiet(() => get());
    expect(res.status).toBe(500);
    expect((await res.json()).unreadable).toBeUndefined();
    fake.failNext('set');
    const saving = await quiet(() => put({ settings: saved }));
    expect(saving.status).toBe(500);
    expect(await saving.json()).toEqual({ error: 'Failed to save allocation settings' });
  });

  test('settings too large to store are refused whole, with the seam’s reason, and nothing is written', async () => {
    const before = process.env.MAX_TXN_BLOB_CHARS;
    process.env.MAX_TXN_BLOB_CHARS = '100';
    try {
      const res = await quiet(() => put({ settings: saved }));
      expect(res.status).toBe(413);
      expect((await res.json()).error).toContain('too large to save');
      expect(await fake.get(KEY)).toBeNull();
    } finally {
      if (before === undefined) delete process.env.MAX_TXN_BLOB_CHARS;
      else process.env.MAX_TXN_BLOB_CHARS = before;
    }
  });

  test('with no container to reach, a 503 with the reason, and nothing read or written', async () => {
    fake.reset();
    forgetEpochs();
    const loaded = await quiet(() => get());
    expect(loaded.status).toBe(503);
    expect((await quiet(() => put({ settings: saved }))).status).toBe(503);
    expect([...fake.strings.keys()].filter((k) => k.includes('allocation-settings'))).toEqual([]);
  });

  test('each account reads and saves its own settings only', async () => {
    process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY = 'pk_test_x';
    process.env.CLERK_SECRET_KEY = 'sk_test_x';
    clerk.signedIn = 'user_owner';
    expect((await put({ settings: saved })).status).toBe(200);
    clerk.signedIn = 'user_partner';
    expect(await (await get()).json()).toEqual({ settings: null });
    const theirs: AllocationSettings = { v: 1, buckets: [], funds: [], accounts: [], target: { bonds: 100 } };
    expect((await put({ settings: theirs })).status).toBe(200);
    expect(await (await get()).json()).toEqual({ settings: theirs });
    clerk.signedIn = 'user_owner';
    expect(await (await get()).json()).toEqual({ settings: saved });
    // Each under its own container's key, and nowhere else.
    const keys = [...fake.strings.keys()].filter((k) => k.endsWith(':allocation-settings')).sort();
    expect(keys.length).toBe(2);
    expect(keys).toContain(testKey(`c:${TEST_CONTAINER}:allocation-settings`));
    expect(keys.every((k) => k.startsWith(testKey('c:')))).toBe(true);
    // Signed out: nobody's.
    clerk.signedIn = null;
    expect((await quiet(() => get())).status).toBe(503);
  });
});
