import { describe, expect, test, mock, beforeEach, afterEach } from 'bun:test';
import { NextRequest } from 'next/server';
import { FakeRedis, storageMock, testKey, unscopedDataKeys } from './fake-redis';

const fake = new FakeRedis({ deserialize: true });
// Nothing may be written outside a container (#53).
afterEach(() => expect(unscopedDataKeys(fake)).toEqual([]));
mock.module('@/lib/storage', () => storageMock(fake));

const { createSessionToken, verifySessionToken, SESSION_COOKIE_NAME, SESSION_MAX_AGE_SECONDS } = await import('@/lib/auth');
const { currentEpoch, revokeAllSessions, sessionCurrent, forgetEpochs, CHECK_REUSE_MS, deploymentContainer } = await import('@/lib/sessions');
const { createFirstContainer, asContainerId } = await import('@/lib/containers');
const { proxy } = await import('@/proxy');
const loginRoute = await import('@/app/api/login/route');
const logoutRoute = await import('@/app/api/logout/route');

const saved = { ...process.env };
let container: ReturnType<typeof asContainerId>;

beforeEach(async () => {
  fake.reset();
  forgetEpochs();
  process.env.SESSION_SECRET = 'test-session-secret';
  process.env.APP_PASSWORD = 'hunter2';
  container = await createFirstContainer();
  process.env.CONTAINER_ID = container;
});
afterEach(() => {
  process.env = { ...saved };
});

async function sign(message: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode('test-session-secret'), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message)));
  return [...sig].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** A token in the format from before claims: "<issuedAt>.<hmac hex>". */
async function legacyToken(issuedAt = Date.now()): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode('test-session-secret'), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(String(issuedAt))));
  return `${issuedAt}.${[...sig].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
}

const quiet = async <T>(fn: () => Promise<T>) => {
  const orig = console.error;
  console.error = () => {};
  try {
    return await fn();
  } finally {
    console.error = orig;
  }
};

describe('tokens', () => {
  test('carry the container and epoch, and verify', async () => {
    const token = await createSessionToken({ container, epoch: 3 });
    expect(token.startsWith('v1.')).toBe(true);
    expect(await verifySessionToken(token)).toMatchObject({ container, epoch: 3, legacy: false });
  });

  test('any change to the claims or the signature is rejected', async () => {
    const token = await createSessionToken({ container, epoch: 3 });
    const [v, body, sig] = token.split('.');
    const claims = JSON.parse(atob(body.replace(/-/g, '+').replace(/_/g, '/')));
    const forged = btoa(JSON.stringify({ ...claims, epoch: 99 })).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    expect(await verifySessionToken(`${v}.${forged}.${sig}`)).toBeNull();
    // Change the last character to one it is not (a fixed "0" would be no
    // change at all one time in sixteen).
    const flipped = sig.slice(0, -1) + (sig.endsWith('0') ? '1' : '0');
    expect(await verifySessionToken(`${v}.${body}.${flipped}`)).toBeNull();
    expect(await verifySessionToken(`${v}.${body}`)).toBeNull();
    expect(await verifySessionToken('')).toBeNull();
    expect(await verifySessionToken(null)).toBeNull();
  });

  test('an unknown or future version is rejected, not misparsed', async () => {
    const token = await createSessionToken({ container, epoch: 0 });
    expect(await verifySessionToken(token.replace(/^v1\./, 'v2.'))).toBeNull();
    expect(await verifySessionToken(`v0.${token.slice(3)}`)).toBeNull();
    // Properly signed under the secret, claims that would otherwise pass, but
    // labelled a version this code does not know: still rejected.
    const body = token.split('.')[1];
    for (const v of ['v2', 'v10', 'V1']) {
      expect(await verifySessionToken(`${v}.${body}.${await sign(`${v}.${body}`)}`)).toBeNull();
    }
    expect(await verifySessionToken(`v1.${body}.${await sign(`v1.${body}`)}`)).not.toBeNull(); // the signer is right
  });

  test('expire server-side, whatever the cookie says', async () => {
    const t0 = Date.now();
    const token = await createSessionToken({ container, epoch: 0 }, t0);
    expect(await verifySessionToken(token, t0 + SESSION_MAX_AGE_SECONDS * 1000 - 1)).not.toBeNull();
    expect(await verifySessionToken(token, t0 + SESSION_MAX_AGE_SECONDS * 1000 + 1)).toBeNull();
    expect(await verifySessionToken(token, t0 - 1)).toBeNull(); // issued in the future
  });

  test('changing the password ends every session', async () => {
    const token = await createSessionToken({ container, epoch: 0 });
    process.env.APP_PASSWORD = 'correct horse';
    expect(await verifySessionToken(token)).toBeNull();
  });

  test('a different signing secret rejects them', async () => {
    const token = await createSessionToken({ container, epoch: 0 });
    process.env.SESSION_SECRET = 'another';
    expect(await verifySessionToken(token)).toBeNull();
  });

  test('tokens from before claims are accepted until they expire', async () => {
    expect(await verifySessionToken(await legacyToken())).toMatchObject({ container: null, epoch: 0, legacy: true });
    const old = Date.now() - SESSION_MAX_AGE_SECONDS * 1000 - 1;
    expect(await verifySessionToken(await legacyToken(old))).toBeNull();
    const t = await legacyToken();
    expect(await verifySessionToken(`${t.split('.')[0]}.${'0'.repeat(64)}`)).toBeNull();
  });
});

describe('revocation', () => {
  test('starts at epoch 0; signing out everywhere ends older sessions, immediately', async () => {
    expect(await currentEpoch(container)).toBe(0);
    const before = (await verifySessionToken(await createSessionToken({ container, epoch: 0 })))!;
    expect(await sessionCurrent(before)).toBe(true);

    expect(await revokeAllSessions(container)).toBe(1);
    // At once in the same module; in production the proxy keeps its own copy,
    // so there it takes up to CHECK_REUSE_MS.
    expect(await sessionCurrent(before)).toBe(false);

    const after = (await verifySessionToken(await createSessionToken({ container, epoch: 1 })))!;
    expect(await sessionCurrent(after)).toBe(true);
  });

  test('another instance sees it within the reuse window', async () => {
    const t0 = Date.now();
    const s = (await verifySessionToken(await createSessionToken({ container, epoch: 0 })))!;
    expect(await sessionCurrent(s, t0)).toBe(true);
    await fake.incr(testKey(`c:${container}:sessions:epoch`)); // revoked elsewhere
    expect(await sessionCurrent(s, t0 + 1)).toBe(true); // still reusing what it read
    expect(await sessionCurrent(s, t0 + CHECK_REUSE_MS + 1)).toBe(false);
  });

  test('ends old-format sessions too', async () => {
    const legacy = (await verifySessionToken(await legacyToken()))!;
    expect(await sessionCurrent(legacy)).toBe(true);
    await revokeAllSessions(container);
    expect(await sessionCurrent(legacy)).toBe(false);
  });

  test('is per container', async () => {
    const other = asContainerId(crypto.randomUUID());
    await revokeAllSessions(other);
    const s = (await verifySessionToken(await createSessionToken({ container, epoch: 0 })))!;
    expect(await sessionCurrent(s)).toBe(true);
  });

  test('if the database cannot be reached, the request is let through', async () => {
    const s = (await verifySessionToken(await createSessionToken({ container, epoch: 0 })))!;
    fake.failNext('get');
    expect(await quiet(() => sessionCurrent(s))).toBe(true);
  });
});

describe("a session only counts in this deployment's container", () => {
  const entry = (status: string) => JSON.stringify({ status, primary: true, created_at: 'x' });

  test('old-format sessions are ended by sign out everywhere even with CONTAINER_ID unset', async () => {
    delete process.env.CONTAINER_ID;
    forgetEpochs();
    const legacy = (await verifySessionToken(await legacyToken()))!;
    expect(await sessionCurrent(legacy)).toBe(true);
    await revokeAllSessions(container);
    forgetEpochs();
    expect(await sessionCurrent(legacy)).toBe(false);
  });

  test('an old-format session can sign out everywhere', async () => {
    delete process.env.CONTAINER_ID;
    const res = await logoutRoute.POST(
      new NextRequest('http://localhost/api/logout', {
        method: 'POST',
        headers: { cookie: `${SESSION_COOKIE_NAME}=${await legacyToken()}`, 'content-type': 'application/json' },
        body: JSON.stringify({ everywhere: true }),
      })
    );
    expect(res.status).toBe(200);
    expect(await currentEpoch(container, Date.now(), { fresh: true })).toBe(1);
  });

  test('a token naming another container is refused', async () => {
    const other = asContainerId(crypto.randomUUID());
    const s = (await verifySessionToken(await createSessionToken({ container: other, epoch: 0 })))!;
    expect(await sessionCurrent(s)).toBe(false);
  });

  test('after CONTAINER_ID moves to another container, older tokens stop working', async () => {
    const s = (await verifySessionToken(await createSessionToken({ container, epoch: 0 })))!;
    const next = asContainerId(crypto.randomUUID());
    await fake.hset(testKey('containers'), { [next]: entry('active') });
    process.env.CONTAINER_ID = next;
    expect(await sessionCurrent(s)).toBe(false);
  });

  test('no session works while the container is not usable', async () => {
    const s = (await verifySessionToken(await createSessionToken({ container, epoch: 0 })))!;
    const legacy = (await verifySessionToken(await legacyToken()))!;
    await fake.hset(testKey('containers'), { [container]: entry('restoring') });
    expect(await sessionCurrent(s)).toBe(false);
    expect(await sessionCurrent(legacy)).toBe(false);
    expect(await deploymentContainer()).toMatchObject({ kind: 'unusable' });
  });

  test('with no container at all, only an old-format session passes, unchecked', async () => {
    const s = (await verifySessionToken(await createSessionToken({ container, epoch: 0 })))!;
    fake.reset();
    delete process.env.CONTAINER_ID;
    forgetEpochs();
    expect(await deploymentContainer()).toEqual({ kind: 'none' });
    expect(await sessionCurrent((await verifySessionToken(await legacyToken()))!)).toBe(true);
    expect(await sessionCurrent(s)).toBe(false);
  });

  test('a damaged stored epoch refuses sessions rather than letting them through', async () => {
    const s = (await verifySessionToken(await createSessionToken({ container, epoch: 0 })))!;
    await fake.set(testKey(`c:${container}:sessions:epoch`), 'garbage');
    expect(await quiet(() => sessionCurrent(s))).toBe(false);
  });

  test('a signed-out old-format session stays signed out after the container changes', async () => {
    const legacy = (await verifySessionToken(await legacyToken(Date.now() - 1000)))!;
    await revokeAllSessions(container);
    // A restore replaced the registry, and a new container was created, as the
    // restore's refusal message says to.
    await fake.del(testKey('containers'));
    forgetEpochs();
    const next = await createFirstContainer();
    process.env.CONTAINER_ID = next;
    expect(await sessionCurrent(legacy)).toBe(false);

    // Or no container at all: still refused.
    fake.hashes.delete(testKey('containers'));
    delete process.env.CONTAINER_ID;
    forgetEpochs();
    expect(await sessionCurrent(legacy)).toBe(false);

    // An old-format token issued after the cutoff is not affected by it.
    expect(await sessionCurrent((await verifySessionToken(await legacyToken(Date.now() + 1)))!)).toBe(true);
  });

  test('a damaged registry refuses sessions instead of waving them through', async () => {
    const s = (await verifySessionToken(await createSessionToken({ container, epoch: 0 })))!;
    await fake.hset(testKey('containers'), { [crypto.randomUUID()]: '{"status":"bogus"}' });
    expect(await quiet(() => sessionCurrent(s))).toBe(false);
  });

  test('an outage is remembered briefly, and logged again after it recovers', async () => {
    const s = (await verifySessionToken(await createSessionToken({ container, epoch: 0 })))!;
    const logged: string[] = [];
    const orig = console.error;
    console.error = (...a: unknown[]) => logged.push(a.join(' '));
    try {
      const t0 = Date.now();
      fake.failNext('hgetall');
      expect(await sessionCurrent(s, t0)).toBe(true);
      const ops = fake.ops;
      expect(await sessionCurrent(s, t0 + 1)).toBe(true);
      expect(fake.ops).toBe(ops); // not asked again during the outage window

      expect(await sessionCurrent(s, t0 + CHECK_REUSE_MS + 1)).toBe(true); // recovered
      fake.failNext('hgetall');
      expect(await sessionCurrent(s, t0 + 3 * CHECK_REUSE_MS)).toBe(true);
    } finally {
      console.error = orig;
    }
    expect(logged.filter((l) => l.includes('unavailable'))).toHaveLength(2);
  });
});

describe('login', () => {
  const login = (password = 'hunter2') =>
    loginRoute.POST(new Request('http://x/api/login', { method: 'POST', body: JSON.stringify({ password }) }));
  const cookieOf = (res: Response) => /nwt_session=([^;]+)/.exec(res.headers.get('set-cookie') ?? '')?.[1];

  test('issues a session for the one active container, at its current epoch', async () => {
    await revokeAllSessions(container);
    await revokeAllSessions(container);
    const res = await login();
    expect(res.status).toBe(200);
    expect(await verifySessionToken(decodeURIComponent(cookieOf(res)!))).toMatchObject({ container, epoch: 2 });
  });

  test('a new session starts on the current epoch, even if this instance read an older one', async () => {
    await currentEpoch(container); // cached: 0
    await fake.incr(testKey(`c:${container}:sessions:epoch`)); // another instance revoked
    const res = await login();
    const s = (await verifySessionToken(decodeURIComponent(cookieOf(res)!)))!;
    expect(s.epoch).toBe(1);
  });

  test('refuses when there is no container, and never creates one', async () => {
    fake.reset();
    delete process.env.CONTAINER_ID;
    const res = await quiet(() => login());
    expect(res.status).toBe(503);
    const { error } = await res.json();
    expect(error).toContain('No container');
    expect(error).toContain('/api/ops/containers'); // says how to fix it
    expect(await fake.hgetall(testKey('containers'))).toBeNull();
  });

  test('refuses when CONTAINER_ID names a different container', async () => {
    process.env.CONTAINER_ID = crypto.randomUUID();
    expect((await quiet(() => login())).status).toBe(503);
  });

  test('with two active containers, logs in to the one CONTAINER_ID names', async () => {
    const second = asContainerId(crypto.randomUUID());
    await fake.hset(testKey('containers'), { [second]: JSON.stringify({ status: 'active', primary: false, created_at: 'x' }) });
    process.env.CONTAINER_ID = second;
    forgetEpochs();
    const res = await login();
    expect(res.status).toBe(200);
    expect(await verifySessionToken(decodeURIComponent(cookieOf(res)!))).toMatchObject({ container: second });

    delete process.env.CONTAINER_ID; // then there is no way to choose
    forgetEpochs();
    expect((await quiet(() => login())).status).toBe(503);
  });

  test('a wrong password is still a 401', async () => {
    expect((await login('nope')).status).toBe(401);
  });
});

describe('the gate', () => {
  const request = (path: string, token?: string) =>
    new NextRequest(`http://localhost${path}`, token ? { headers: { cookie: `${SESSION_COOKIE_NAME}=${token}` } } : {});

  test('lets a current session through, and turns a revoked one away', async () => {
    const token = await createSessionToken({ container, epoch: 0 });
    expect((await proxy(request('/api/budgets', token))).status).toBe(200);
    expect((await proxy(request('/', token))).status).toBe(200);

    await revokeAllSessions(container);
    expect((await proxy(request('/api/budgets', token))).status).toBe(401);
    const page = await proxy(request('/', token));
    expect(page.status).toBe(307);
    expect(page.headers.get('location')).toContain('/login');
  });

  test('turns away no cookie and a forged one', async () => {
    expect((await proxy(request('/api/budgets'))).status).toBe(401);
    expect((await proxy(request('/api/budgets', 'v1.e30.00'))).status).toBe(401);
  });
});

describe('sign out everywhere', () => {
  const logout = (token: string, body?: unknown) =>
    logoutRoute.POST(
      new NextRequest('http://localhost/api/logout', {
        method: 'POST',
        headers: { cookie: `${SESSION_COOKIE_NAME}=${token}`, 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      })
    );

  test("ends the other device's session too", async () => {
    const phone = await createSessionToken({ container, epoch: 0 });
    const laptop = await createSessionToken({ container, epoch: 0 });

    const res = await logout(laptop, { everywhere: true });
    expect(res.status).toBe(200);
    expect(res.headers.get('set-cookie')).toContain('Max-Age=0');
    expect((await proxy(new NextRequest('http://localhost/api/budgets', { headers: { cookie: `${SESSION_COOKIE_NAME}=${phone}` } }))).status).toBe(401);
  });

  test('with the database down, says so rather than that it failed to sign out', async () => {
    const laptop = await createSessionToken({ container, epoch: 0 });
    forgetEpochs();
    fake.failNext('hgetall');
    const res = await quiet(() => logout(laptop, { everywhere: true }));
    expect(res.status).toBe(503);
    expect((await res.json()).error).toContain('database is unavailable');
  });

  test('a damaged registry is named as such, not as an outage', async () => {
    const laptop = await createSessionToken({ container, epoch: 0 });
    await fake.hset(testKey('containers'), { [crypto.randomUUID()]: '{"status":"bogus"}' });
    forgetEpochs();
    const res = await quiet(() => logout(laptop, { everywhere: true }));
    expect(res.status).toBe(409);
    expect((await res.json()).error).toContain('unreadable');
  });

  test('with no container yet, it still ends old-format sessions everywhere', async () => {
    fake.reset();
    delete process.env.CONTAINER_ID;
    forgetEpochs();
    const old = await legacyToken(Date.now() - 1000);
    const other = (await verifySessionToken(await legacyToken(Date.now() - 2000)))!;
    expect(await sessionCurrent(other)).toBe(true);

    const res = await logout(old, { everywhere: true });
    expect(res.status).toBe(200);
    expect(await sessionCurrent(other)).toBe(false);
  });

  test('a plain logout ends only this one', async () => {
    const phone = await createSessionToken({ container, epoch: 0 });
    const laptop = await createSessionToken({ container, epoch: 0 });
    await logout(laptop);
    expect(await currentEpoch(container)).toBe(0);
    expect((await proxy(new NextRequest('http://localhost/api/budgets', { headers: { cookie: `${SESSION_COOKIE_NAME}=${phone}` } }))).status).toBe(200);
  });
});
