import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { NextResponse } from 'next/server';
import { clerk } from './clerk-mock';
import { mockForFile } from './scoped-mock';
import { FakeRedis, storageMock, testKey, TEST_CTX, TEST_CONTAINER } from './fake-redis';

// The admin page's change to a feature switch (app/api/admin/flags): the
// admin alone, from this site's own page, a change the flag's kind takes, a
// fresh sign-in everywhere but Preview and a local next dev, and one write
// with its change recorded by the admin's container (lib/flag-store.ts),
// over test/fake-redis.ts.

const fake = new FakeRedis({ deserialize: true });
mock.module('@/lib/storage', () => storageMock(fake));

const { ContainerError } = await import('@/lib/containers');
let admin: 'yes' | 'no' | 'outage' = 'yes';
await mockForFile('@/lib/admin-items', () => ({
  adminCtx: async () => {
    if (admin === 'outage') throw new ContainerError('The container registry can’t be read.');
    return admin === 'yes' ? TEST_CTX : null;
  },
  notAdmin: () => NextResponse.json({ error: 'Not found' }, { status: 404 }),
}));

const { PUT } = await import('@/app/api/admin/flags/route');
const { flagCache } = await import('@/lib/flag-cache');
const { cachedFlags } = await import('@/lib/flag-read');

const OTHER = '9c1d2e3f-4a5b-4c6d-8e7f-0a1b2c3d4e5f';
const GONE = '7a1d2e3f-4a5b-4c6d-8e7f-0a1b2c3d4e5f';
const AT = '2026-11-01T12:00:00.000Z';

const register = (container: string, status: 'active' | 'restoring' | 'archived' = 'active') =>
  fake.hset(testKey('containers'), { [container]: JSON.stringify({ status, primary: false, created_at: '2026-01-01T00:00:00.000Z' }) });

const put = (body: unknown, headers: Record<string, string> = {}) =>
  PUT(
    new Request('https://nya.test/api/admin/flags', {
      method: 'PUT',
      headers: { 'content-type': 'application/json', origin: 'https://nya.test', 'x-forwarded-for': '203.0.113.9', ...headers },
      body: JSON.stringify(body),
    })
  );
const values = () => fake.hashes.get(testKey('flags:values'));
const record = () => [...(fake.hashes.get(testKey('flags:log'))?.values() ?? [])].map((v) => JSON.parse(String(v)));
const stored = (key: string) => JSON.parse(String(values()!.get(key)));

const saved = { ...process.env };
beforeEach(async () => {
  fake.reset();
  flagCache.forget();
  admin = 'yes';
  process.env = { ...saved };
  // Preview, without Clerk: no fresh sign-in asked for unless a test says so.
  process.env.VERCEL_ENV = 'preview';
  delete process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;
  delete process.env.CLERK_SECRET_KEY;
  process.env.APP_PASSWORD = 'hunter2';
  process.env.SESSION_SECRET = 'test-session-secret';
  clerk.signedIn = null;
  clerk.reverified = true;
  await register(TEST_CONTAINER);
  await register(OTHER);
});
afterEach(() => {
  process.env = { ...saved };
  clerk.signedIn = null;
  clerk.reverified = true;
});

describe('who and from where', () => {
  test('anyone but the admin gets a 404, and nothing is read or written', async () => {
    admin = 'no';
    const res = await put({ key: 'ops', change: { op: 'choose', choice: 'on' } });
    expect(res.status).toBe(404);
    expect(values()).toBeUndefined();
  });

  test('a registry that can’t be read is a 503, as the admin’s other routes answer', async () => {
    admin = 'outage';
    expect((await put({ key: 'ops', change: { op: 'choose', choice: 'on' } })).status).toBe(503);
  });

  test('another site, no origin at all, another site’s fetch, or not JSON: 403', async () => {
    const change = { key: 'ops', change: { op: 'choose', choice: 'on' } };
    expect((await put(change, { origin: 'https://elsewhere.example' })).status).toBe(403);
    expect((await put(change, { 'sec-fetch-site': 'cross-site' })).status).toBe(403);
    expect((await put(change, { 'content-type': 'text/plain' })).status).toBe(403);
    const noOrigin = new Request('https://nya.test/api/admin/flags', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(change) });
    expect((await PUT(noOrigin)).status).toBe(403);
    expect(values()).toBeUndefined();
  });
});

describe('what may be changed', () => {
  test('refuses an unknown key, a change the kind doesn’t take, a bad entry, and an account not in use: 400', async () => {
    await register(GONE, 'archived');
    const refused = [
      { key: 'no-such-switch', change: { op: 'choose', choice: 'on' } },
      { key: 'ops', change: { op: 'choose', choice: 'everyone' } },
      { key: 'sign-in', change: { op: 'choose', choice: 'everyone' } },
      { key: 'csp', change: { op: 'add-account', container: OTHER } },
      { key: 'lunchflow', change: { op: 'add-person', entry: 'jane@example.com' } },
      { key: 'sign-in', change: { op: 'add-person', entry: 'jane' } },
      { key: 'sign-in', change: { op: 'add-person', entry: 'a@b.c,d@e.f' } },
      { key: 'sign-in', change: { op: 'add-person', entry: `user_${'a'.repeat(400)}` } },
      { key: 'lunchflow', change: { op: 'add-account', container: GONE } },
      { key: 'lunchflow', change: { op: 'add-account', container: '1b2c3d4e-5f6a-4b7c-8d9e-0f1a2b3c4d5e' } }, // in no registry
      { key: 'ops', change: { op: 'choose', choice: 'on' }, password: 42 },
    ];
    for (const body of refused) expect([body, (await put(body)).status]).toEqual([body, 400]);
    expect(values()).toBeUndefined();
  });

  test('a thousand-and-first person is refused, and the list is left as it is', async () => {
    const ids = Array.from({ length: 1000 }, (_, i) => `user_${i}`);
    await fake.hset(testKey('flags:values'), { 'sign-in': JSON.stringify({ ids, emails: [], updatedAt: AT }) });
    const res = await put({ key: 'sign-in', change: { op: 'add-person', entry: 'user_new' } });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('The list holds at most 1000 user ids.');
    expect(stored('sign-in').ids).toHaveLength(1000);
    expect(record()).toEqual([]);
  });
});

describe('a fresh sign-in', () => {
  const choose = { key: 'ops', change: { op: 'choose', choice: 'on' } };

  test('in Production, with Clerk, a sign-in not recent enough gets Clerk’s hint and changes nothing', async () => {
    process.env.VERCEL_ENV = 'production';
    process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY = 'pk_test_placeholder';
    process.env.CLERK_SECRET_KEY = 'sk_test_placeholder';
    clerk.signedIn = 'user_admin';
    clerk.reverified = false;
    let res = await put(choose);
    expect(res.status).toBe(403);
    expect((await res.json()).clerk_error).toMatchObject({ type: 'forbidden', reason: 'reverification-error' });
    expect(values()).toBeUndefined();
    clerk.reverified = true;
    res = await put(choose);
    expect(res.status).toBe(200);
    expect(stored('ops')).toMatchObject({ on: true });
  });

  test('with the app password: off Vercel under next start too, the password again, every change', async () => {
    delete process.env.VERCEL_ENV;
    (process.env as Record<string, string>).NODE_ENV = 'production';
    let res = await put(choose);
    expect(res.status).toBe(403);
    expect((await res.json()).wrong_password).toBe(true);
    expect((await put({ ...choose, password: 'nope' })).status).toBe(403);
    expect(values()).toBeUndefined();
    expect((await put({ ...choose, password: 'hunter2' })).status).toBe(200);
    expect((await put({ key: 'lunchflow', change: { op: 'add-account', container: OTHER } })).status).toBe(403);
    expect((await put({ key: 'lunchflow', change: { op: 'add-account', container: OTHER }, password: 'hunter2' })).status).toBe(200);
  });

  test('Preview needs none', async () => {
    expect((await put(choose)).status).toBe(200);
  });
});

describe('the change', () => {
  test('lands with its change recorded by the admin’s container, and answers the row; this server sees it at once', async () => {
    expect((await cachedFlags()).flags.size).toBe(0);
    const res = await put({ key: 'plan-child-accounts', change: { op: 'choose', choice: 'admin' } });
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect((await res.json()).row).toMatchObject({ key: 'plan-child-accounts', name: 'Child’s accounts out of invested assets', stored: 'admin', containers: [] });
    expect(stored('plan-child-accounts')).toMatchObject({ on: 'admin', containers: [] });
    expect(record()).toEqual([expect.objectContaining({ key: 'plan-child-accounts', from: null, to: expect.objectContaining({ on: 'admin' }), by: TEST_CONTAINER })]);
    expect((await cachedFlags()).flags.get('plan-child-accounts')).toMatchObject({ on: 'admin' });
  });

  test('accounts and people, one recorded change each', async () => {
    expect((await put({ key: 'lunchflow', change: { op: 'add-account', container: OTHER } })).status).toBe(200);
    expect(stored('lunchflow')).toMatchObject({ on: 'nobody', containers: [OTHER] });
    const res = await put({ key: 'sign-in', change: { op: 'add-person', entry: 'Jane@Example.com' } });
    expect((await res.json()).row).toMatchObject({ people: 1, emails: ['jane@example.com'] });
    expect((await put({ key: 'sign-in', change: { op: 'remove-person', entry: 'jane@example.com' } })).status).toBe(200);
    expect(stored('sign-in')).toMatchObject({ ids: [], emails: [] });
    expect(record()).toHaveLength(3);
  });

  test('a change that changes nothing writes nothing and answers 200, even with nothing stored', async () => {
    let res = await put({ key: 'lunchflow', change: { op: 'remove-account', container: OTHER } });
    expect(res.status).toBe(200);
    expect((await res.json()).row).toMatchObject({ key: 'lunchflow', stored: null });
    expect(values()).toBeUndefined();
    expect((await put({ key: 'sign-in', change: { op: 'remove-person', entry: 'user_a' } })).status).toBe(200);
    expect((await put({ key: 'ops', change: { op: 'choose', choice: 'on' } })).status).toBe(200);
    const before = String(values()!.get('ops'));
    res = await put({ key: 'ops', change: { op: 'choose', choice: 'on' } });
    expect((await res.json()).row).toMatchObject({ stored: 'on' });
    expect(String(values()!.get('ops'))).toBe(before);
    expect(record()).toHaveLength(1);
  });

  test('a stored value it can’t read is never written over: 409', async () => {
    await fake.hset(testKey('flags:values'), { lunchflow: 'not json' });
    const res = await put({ key: 'lunchflow', change: { op: 'add-account', container: OTHER } });
    expect(res.status).toBe(409);
    expect((await res.json()).unreadable).toBe(true);
    expect(values()!.get('lunchflow')).toBe('not json');
  });

  test('a variable still set doesn’t stop a stored change; the row says it decides', async () => {
    process.env.LUNCHFLOW_ENABLED = '1';
    const res = await put({ key: 'lunchflow', change: { op: 'choose', choice: 'admin' } });
    expect((await res.json()).row).toMatchObject({ stored: 'admin', variableSet: true, variableChoice: 'everyone' });
  });
});
