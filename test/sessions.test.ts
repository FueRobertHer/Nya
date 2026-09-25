import { describe, expect, test, mock, beforeEach, afterEach } from 'bun:test';
import { NextRequest } from 'next/server';
import { FakeRedis, storageMock, testKey } from './fake-redis';

const fake = new FakeRedis({ deserialize: true });
mock.module('@/lib/storage', () => storageMock(fake));

const { createSessionToken, verifySessionToken, SESSION_COOKIE_NAME, SESSION_MAX_AGE_SECONDS } = await import('@/lib/auth');
const { currentEpoch, revokeAllSessions, sessionCurrent, forgetEpochs, EPOCH_REUSE_MS } = await import('@/lib/sessions');
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
    expect(await verifySessionToken(`${v}.${body}.${sig.slice(0, -1)}0`)).toBeNull();
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
    expect(await sessionCurrent(before)).toBe(false); // this instance, at once

    const after = (await verifySessionToken(await createSessionToken({ container, epoch: 1 })))!;
    expect(await sessionCurrent(after)).toBe(true);
  });

  test('another instance sees it within the reuse window', async () => {
    const t0 = Date.now();
    const s = (await verifySessionToken(await createSessionToken({ container, epoch: 0 })))!;
    expect(await sessionCurrent(s, t0)).toBe(true);
    await fake.incr(testKey(`c:${container}:sessions:epoch`)); // revoked elsewhere
    expect(await sessionCurrent(s, t0 + 1)).toBe(true); // still reusing what it read
    expect(await sessionCurrent(s, t0 + EPOCH_REUSE_MS + 1)).toBe(false);
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

  test('refuses when there is no container, and never creates one', async () => {
    fake.reset();
    delete process.env.CONTAINER_ID;
    const res = await quiet(() => login());
    expect(res.status).toBe(503);
    expect((await res.json()).error).toContain('No container');
    expect(await fake.hgetall(testKey('containers'))).toBeNull();
  });

  test('refuses when CONTAINER_ID names a different container', async () => {
    process.env.CONTAINER_ID = crypto.randomUUID();
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

  test('a plain logout ends only this one', async () => {
    const phone = await createSessionToken({ container, epoch: 0 });
    const laptop = await createSessionToken({ container, epoch: 0 });
    await logout(laptop);
    expect(await currentEpoch(container)).toBe(0);
    expect((await proxy(new NextRequest('http://localhost/api/budgets', { headers: { cookie: `${SESSION_COOKIE_NAME}=${phone}` } }))).status).toBe(200);
  });
});
