import { describe, expect, test, mock, beforeEach, afterEach, afterAll } from 'bun:test';
import { FakeRedis, storageMock, testKey, ctxKey, TEST_CTX, unscopedDataKeys } from './fake-redis';
import { startRedis, upstashOn, type RealRedis } from './real-redis';

// Deserializing like Upstash: what production reads back.
const fake = new FakeRedis({ deserialize: true });
afterEach(() => expect(unscopedDataKeys(fake)).toEqual([]));
/** What redis() returns for the test running: the double, or a real server. */
let client: unknown = fake;
mock.module('@/lib/storage', () => ({ ...storageMock(fake), redis: () => client }));

const {
  downloadAllowed,
  takeDownload,
  downloadCount,
  passwordAttemptsExhausted,
  countWrongPassword,
  tokenFailuresExhausted,
  countTokenFailure,
  API_AUTH_MAX_FAILURES,
  API_AUTH_WINDOW_SECONDS,
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
    await fake.set(testKey('ratelimit:login:1.2.3.4'), String(LOGIN_MAX_FAILURES), { ex: LOGIN_WINDOW_SECONDS });
    expect((await login('hunter2')).status).toBe(429);
    fake.failNext('eval');
    expect((await login('hunter2')).status).toBe(200);
    // Nor is a check and a count that can't be made a reason to answer
    // anything but the password's own answer.
    fake.failNext('eval', 2);
    expect((await login('nope', '5.6.7.8')).status).toBe(401);
    expect(await fake.get(testKey('ratelimit:login:5.6.7.8'))).toBeNull();
  });

  test('a wrong password is counted with its window’s end in one step, so a request that dies part way leaves no count without one', async () => {
    const key = testKey('ratelimit:login:1.2.3.4');
    // Where a count sent as INCR and then EXPIRE lost its end: the second
    // request failing after the first had counted.
    fake.failNext('expire');
    expect((await login('nope')).status).toBe(401);
    expect([await fake.get(key), fake.ttls.get(key)]).toEqual([1, LOGIN_WINDOW_SECONDS]);
    // Later counts keep the window's end.
    fake.ttls.set(key, 120);
    expect((await login('nope')).status).toBe(401);
    expect([await fake.get(key), fake.ttls.get(key)]).toEqual([2, 120]);
    // Under a second left (TTL answers 0): that window is still running.
    fake.ttls.set(key, 0);
    expect((await login('nope')).status).toBe(401);
    expect(fake.ttls.get(key)).toBe(0);
  });

  test('an address shut out by a count with no end, as the code before this could leave one, is given a window and let in when it ends', async () => {
    const key = testKey('ratelimit:login:1.2.3.4');
    await fake.set(key, String(LOGIN_MAX_FAILURES));
    expect((await login('hunter2')).status).toBe(429);
    expect(fake.ttls.get(key)).toBe(LOGIN_WINDOW_SECONDS);
    // A count below the limit gets one from the next wrong password too.
    await fake.set(key, '3');
    expect((await login('nope')).status).toBe(401);
    expect([await fake.get(key), fake.ttls.get(key)]).toEqual([4, LOGIN_WINDOW_SECONDS]);
  });
});

describe('API tokens that don’t work, counted by address (lib/api-http.ts)', () => {
  const req = new Request('https://nya.test/api/v1/me', { headers: { 'x-forwarded-for': '203.0.113.7, 10.0.0.1' } });
  const key = testKey('ratelimit:api:203.0.113.7');

  test('each is counted with its window’s end in one step, so a request that dies part way leaves no count without one', async () => {
    // Where a count sent as INCR and then EXPIRE lost its end: the second
    // request failing after the first had counted. One script now, no EXPIRE.
    fake.failNext('expire');
    await countTokenFailure(req);
    expect([await fake.get(key), fake.ttls.get(key)]).toEqual([1, API_AUTH_WINDOW_SECONDS]);
    // Later counts keep the window's end.
    fake.ttls.set(key, 120);
    await countTokenFailure(req);
    expect([await fake.get(key), fake.ttls.get(key)]).toEqual([2, 120]);
  });

  test('a count left without an end is given a window by the next check, so an address is never shut out for good', async () => {
    await fake.set(key, String(API_AUTH_MAX_FAILURES));
    expect(fake.ttls.get(key) ?? -1).toBe(-1);
    expect(await tokenFailuresExhausted(req)).toBe(true);
    expect(fake.ttls.get(key)).toBe(API_AUTH_WINDOW_SECONDS);
    // Below the limit, and for another address, nothing is refused.
    await fake.set(key, String(API_AUTH_MAX_FAILURES - 1), { ex: 60 });
    expect(await tokenFailuresExhausted(req)).toBe(false);
    expect(await tokenFailuresExhausted(new Request('https://nya.test/', { headers: { 'x-forwarded-for': '198.51.100.1' } }))).toBe(false);
  });

  test('fails open: a count that can’t be read or made refuses nothing', async () => {
    await fake.set(key, String(API_AUTH_MAX_FAILURES), { ex: 60 });
    fake.failNext('eval');
    expect(await tokenFailuresExhausted(req)).toBe(false);
    fake.failNext('eval');
    await countTokenFailure(req);
    expect(Number(await fake.get(key))).toBe(API_AUTH_MAX_FAILURES);
  });
});

// The scripts on a real Redis, where one is installed (as in CI): the double
// has no clock, so the windows' ends are checked here.
const hasRedis = Bun.which('redis-server') !== null;
describe.skipIf(!hasRedis && !process.env.CI)('wrong passwords, on a real Redis', () => {
  let real: RealRedis | null = null;
  let upstash: ReturnType<typeof upstashOn>;
  const send = (command: string, args: string[]) => real!.client.send(command, args);
  const req = new Request('http://x/api/login', { headers: { 'x-forwarded-for': '1.2.3.4' } });
  const key = testKey('ratelimit:login:1.2.3.4');
  /** Waits for the key's window to end, a few seconds at most. */
  const ended = async () => {
    for (let i = 0; i < 100 && Number(await send('EXISTS', [key])) === 1; i++) await Bun.sleep(25);
    expect(Number(await send('EXISTS', [key]))).toBe(0);
  };

  beforeEach(async () => {
    real ??= await startRedis();
    await send('FLUSHALL', []);
    upstash = upstashOn(real.client);
    client = upstash;
  });
  afterEach(() => {
    client = fake;
  });
  afterAll(() => {
    real?.stop();
    real = null;
  });

  test('an API token that doesn’t work is counted with its window’s end in one request, too', async () => {
    const apiReq = new Request('https://nya.test/api/v1/me', { headers: { 'x-forwarded-for': '203.0.113.7' } });
    const apiKey = testKey('ratelimit:api:203.0.113.7');
    upstash.sent.length = 0;
    await countTokenFailure(apiReq);
    expect(upstash.sent).toEqual(['eval']);
    expect([await send('GET', [apiKey]), Number(await send('TTL', [apiKey]))]).toEqual(['1', API_AUTH_WINDOW_SECONDS]);
    await send('PERSIST', [apiKey]);
    expect(await tokenFailuresExhausted(apiReq)).toBe(false);
    expect(Number(await send('TTL', [apiKey]))).toBe(API_AUTH_WINDOW_SECONDS);
  });

  test('each wrong password is counted with its window’s end in one request', async () => {
    expect(await passwordAttemptsExhausted(req)).toBe(false);
    expect(await send('EXISTS', [key])).toBe(0); // a check writes nothing where nothing is counted
    upstash.sent.length = 0;
    await countWrongPassword(req);
    expect(upstash.sent).toEqual(['eval']);
    expect([await send('GET', [key]), Number(await send('TTL', [key]))]).toEqual(['1', LOGIN_WINDOW_SECONDS]);
    // A window part way through keeps its end.
    await send('EXPIRE', [key, '100']);
    for (let i = 1; i < LOGIN_MAX_FAILURES; i++) await countWrongPassword(req);
    expect(await send('GET', [key])).toBe(String(LOGIN_MAX_FAILURES));
    expect(Number(await send('TTL', [key]))).toBeLessThanOrEqual(100);
    expect(await passwordAttemptsExhausted(req)).toBe(true);
  });

  test('a count left without an end is given a whole window by the next check or count', async () => {
    await send('SET', [key, String(LOGIN_MAX_FAILURES)]);
    expect(Number(await send('TTL', [key]))).toBe(-1);
    expect(await passwordAttemptsExhausted(req)).toBe(true);
    expect(Number(await send('TTL', [key]))).toBe(LOGIN_WINDOW_SECONDS);
    await send('SET', [key, '3']);
    await countWrongPassword(req);
    expect([await send('GET', [key]), Number(await send('TTL', [key]))]).toEqual(['4', LOGIN_WINDOW_SECONDS]);
  });

  test('a window under a second from ending keeps its end, and once it has ended the address is let in and counted afresh', async () => {
    // Under half a second left, which TTL answers as 0.
    await send('SET', [key, String(LOGIN_MAX_FAILURES - 1), 'PX', '450']);
    await countWrongPassword(req);
    expect(await send('GET', [key])).toBe(String(LOGIN_MAX_FAILURES));
    expect(Number(await send('PTTL', [key]))).toBeLessThanOrEqual(450);
    expect(await passwordAttemptsExhausted(req)).toBe(true);
    expect(Number(await send('PTTL', [key]))).toBeLessThanOrEqual(450);
    await ended();
    expect(await passwordAttemptsExhausted(req)).toBe(false);
    await countWrongPassword(req);
    expect([await send('GET', [key]), Number(await send('TTL', [key]))]).toEqual(['1', LOGIN_WINDOW_SECONDS]);
  });
});
