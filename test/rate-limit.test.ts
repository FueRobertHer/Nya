import { describe, expect, test, mock, beforeEach, afterEach } from 'bun:test';
import { FakeRedis, storageMock, testKey, ctxKey, TEST_CTX, unscopedDataKeys } from './fake-redis';

// Deserializing like Upstash: what production reads back.
const fake = new FakeRedis({ deserialize: true });
afterEach(() => expect(unscopedDataKeys(fake)).toEqual([]));
mock.module('@/lib/storage', () => storageMock(fake));

const {
  downloadAllowed,
  takeDownload,
  downloadCount,
  passwordAttemptsExhausted,
  DOWNLOADS_PER_WINDOW,
  DOWNLOAD_WINDOW_SECONDS,
  LOGIN_MAX_FAILURES,
  LOGIN_WINDOW_SECONDS,
} = await import('@/lib/rate-limit');
const { classify } = await import('@/lib/reencrypt');
const { isEnvWide, createFirstContainer } = await import('@/lib/containers');
const { isExcluded } = await import('@/lib/export');
const { declaredStore } = await import('@/lib/stores');
const loginRoute = await import('@/app/api/login/route');

const saved = { ...process.env };
beforeEach(() => {
  fake.reset();
});
afterEach(() => {
  process.env = { ...saved };
});

const other = { container: '9c1d2e3f-4a5b-4c6d-8e7f-0a1b2c3d4e5f' } as typeof TEST_CTX;
/** Where the seam keeps the count: the store's name, inside the container. */
const countKey = ctxKey('download-count');

describe('downloads of my data, per container', () => {
  test(`${DOWNLOADS_PER_WINDOW} an hour, then refused with how long until the window ends`, async () => {
    for (let i = 0; i < DOWNLOADS_PER_WINDOW; i++) {
      expect(await downloadAllowed(TEST_CTX)).toEqual({ ok: true });
      expect(await takeDownload(TEST_CTX)).toEqual({ ok: true });
    }
    expect(await downloadAllowed(TEST_CTX)).toEqual({ ok: false, retryAfterSeconds: DOWNLOAD_WINDOW_SECONDS });
    // Counting decides, so a request that raced past the first check is refused too.
    expect(await takeDownload(TEST_CTX)).toEqual({ ok: false, retryAfterSeconds: DOWNLOAD_WINDOW_SECONDS });
    // Inside the container, with the window as its expiry.
    expect(fake.strings.get(countKey)).toBe(String(DOWNLOADS_PER_WINDOW + 1));
    expect(fake.ttls.get(countKey)).toBe(DOWNLOAD_WINDOW_SECONDS);
  });

  test('one person’s downloads never count against another’s', async () => {
    for (let i = 0; i < DOWNLOADS_PER_WINDOW; i++) await takeDownload(TEST_CTX);
    expect((await downloadAllowed(TEST_CTX)).ok).toBe(false);
    expect(await downloadAllowed(other)).toEqual({ ok: true });
  });

  test('a counter that lost its expiry gets one back, so it can never refuse for good', async () => {
    await fake.set(countKey, '2'); // counted, expiry never set
    expect(await takeDownload(TEST_CTX)).toEqual({ ok: true });
    expect(fake.ttls.get(countKey)).toBe(DOWNLOAD_WINDOW_SECONDS);
    // Even at the limit, where nothing more is counted: the check gives it one.
    await fake.set(countKey, String(DOWNLOADS_PER_WINDOW));
    expect(await downloadAllowed(TEST_CTX)).toEqual({ ok: false, retryAfterSeconds: DOWNLOAD_WINDOW_SECONDS });
    expect(fake.ttls.get(countKey)).toBe(DOWNLOAD_WINDOW_SECONDS);
  });

  test('a window under a second from ending is left to end, not given a fresh hour', async () => {
    for (let i = 0; i < DOWNLOADS_PER_WINDOW; i++) await takeDownload(TEST_CTX);
    // TTL answers 0 for under a second left.
    fake.ttls.set(countKey, 0);
    expect(await takeDownload(TEST_CTX)).toEqual({ ok: false, retryAfterSeconds: 1 });
    expect(fake.ttls.get(countKey)).toBe(0);
    expect(await downloadAllowed(TEST_CTX)).toEqual({ ok: false, retryAfterSeconds: 1 });
  });

  test('the time left is the counter’s own', async () => {
    for (let i = 0; i < DOWNLOADS_PER_WINDOW; i++) await takeDownload(TEST_CTX);
    fake.ttls.set(countKey, 120);
    expect(await downloadAllowed(TEST_CTX)).toEqual({ ok: false, retryAfterSeconds: 120 });
  });

  test('fails closed: a counter that can’t be read, counted or understood is an error, never a yes', async () => {
    fake.failNext('eval');
    await expect(downloadAllowed(TEST_CTX)).rejects.toThrow(/armed failure/);
    fake.failNext('eval');
    await expect(takeDownload(TEST_CTX)).rejects.toThrow(/armed failure/);
    await fake.set(countKey, 'not a count');
    await expect(downloadAllowed(TEST_CTX)).rejects.toThrow('could not be read');
    await expect(takeDownload(TEST_CTX)).rejects.toThrow('could not be read');
  });

  test('it is a counter store on the storage seam, in the container, and the service’s own bookkeeping', () => {
    expect(declaredStore('download-count')).toBe(downloadCount);
    expect(downloadCount).toMatchObject({ kind: 'counter', exportable: false, windowSeconds: DOWNLOAD_WINDOW_SECONDS });
    const scoped = `c:${TEST_CTX.container}:download-count`;
    expect(classify(scoped)).toBe('plain');
    expect(classify('download-count')).toBeNull(); // never outside a container
    expect(isEnvWide('download-count')).toBe(false);
    // Kept in backups like every store on the seam, with its expiry.
    expect(isExcluded(scoped)).toBe(false);
    // The login's limit is still the environment's own, and never inside one.
    expect(isEnvWide('ratelimit:login:1.2.3.4')).toBe(true);
    expect(classify(`c:${TEST_CTX.container}:ratelimit:login:1.2.3.4`)).toBeNull();
  });
});

describe('wrong passwords, shared by the login', () => {
  const login = (password: string, ip = '1.2.3.4') =>
    loginRoute.POST(
      new Request('http://x/api/login', { method: 'POST', headers: { 'x-forwarded-for': ip }, body: JSON.stringify({ password }) })
    );

  beforeEach(async () => {
    process.env.SESSION_SECRET = 'test-session-secret';
    process.env.APP_PASSWORD = 'hunter2';
    (await import('@/lib/sessions')).forgetEpochs();
    process.env.CONTAINER_ID = await createFirstContainer();
  });

  test(`${LOGIN_MAX_FAILURES} wrong passwords per IP, then refused even with the right one`, async () => {
    for (let i = 0; i < LOGIN_MAX_FAILURES; i++) expect((await login('nope')).status).toBe(401);
    expect(fake.ttls.get(testKey('ratelimit:login:1.2.3.4'))).toBe(LOGIN_WINDOW_SECONDS);
    expect((await login('hunter2')).status).toBe(429);
    // Another IP is its own count.
    expect((await login('hunter2', '5.6.7.8')).status).toBe(200);
  });

  test('the right password clears the count', async () => {
    for (let i = 0; i < LOGIN_MAX_FAILURES - 1; i++) await login('nope');
    expect((await login('hunter2')).status).toBe(200);
    expect(await fake.get(testKey('ratelimit:login:1.2.3.4'))).toBeNull();
    expect(await passwordAttemptsExhausted(new Request('http://x', { headers: { 'x-forwarded-for': '1.2.3.4' } }))).toBe(false);
  });

  test('fails open when Redis can’t be read, as the login always has', async () => {
    fake.failNext('get');
    expect(await passwordAttemptsExhausted(new Request('http://x'))).toBe(false);
  });
});
