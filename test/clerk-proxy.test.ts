import { describe, expect, test, mock, beforeEach, afterEach } from 'bun:test';
import { NextRequest } from 'next/server';

// Clerk's middleware, reduced to what the proxy uses: it hands the callback an
// auth() that says who is signed in.
let signedIn: string | null = null;
mock.module('@clerk/nextjs/server', () => ({
  clerkMiddleware: (handler: any) => (req: any, event: any) => handler(async () => ({ userId: signedIn }), req, event),
}));

const { proxy } = await import('@/proxy');
const { clerkEnabled, clerkUserAllowed } = await import('@/lib/auth-mode');

const saved = { ...process.env };
beforeEach(() => {
  signedIn = null;
  process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY = 'pk_test_x';
  process.env.CLERK_SECRET_KEY = 'sk_test_x';
  process.env.CLERK_ALLOWED_USER_IDS = 'user_owner, user_partner';
});
afterEach(() => {
  process.env = { ...saved };
});

const call = (path: string) => proxy(new NextRequest(`https://nya.test${path}`), {} as any);

describe('which sign-in is used', () => {
  test('Clerk only when both keys are set', () => {
    expect(clerkEnabled()).toBe(true);
    delete process.env.CLERK_SECRET_KEY;
    expect(clerkEnabled()).toBe(false);
    process.env.CLERK_SECRET_KEY = 'sk';
    delete process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;
    expect(clerkEnabled()).toBe(false);
  });

  test('without Clerk keys, the shared password still guards everything', async () => {
    delete process.env.CLERK_SECRET_KEY;
    signedIn = 'user_owner'; // a Clerk session means nothing then
    expect((await call('/api/net-worth')).status).toBe(401);
    expect((await call('/')).headers.get('location')).toBe('https://nya.test/login');
  });
});

describe('with Clerk on', () => {
  test('signed out: pages go to sign-in, the API answers 401', async () => {
    expect((await call('/')).headers.get('location')).toBe('https://nya.test/sign-in');
    expect((await call('/api/net-worth')).status).toBe(401);
  });

  test('sign-in and the not-allowed page stay open', async () => {
    for (const path of ['/sign-in', '/sign-in/factor-one', '/not-allowed']) {
      const res = await call(path);
      expect(res.status).toBe(200);
      expect(res.headers.get('location')).toBeNull();
    }
  });

  test('an allowed account gets in', async () => {
    signedIn = 'user_partner';
    expect((await call('/')).status).toBe(200);
    expect((await call('/api/net-worth')).status).toBe(200);
  });

  test('a signed-in account not on the list is turned away', async () => {
    signedIn = 'user_stranger';
    expect((await call('/')).headers.get('location')).toBe('https://nya.test/not-allowed');
    expect((await call('/api/net-worth')).status).toBe(403);
  });

  test('no allowlist lets nobody in', async () => {
    delete process.env.CLERK_ALLOWED_USER_IDS;
    signedIn = 'user_owner';
    expect((await call('/api/net-worth')).status).toBe(403);
    process.env.CLERK_ALLOWED_USER_IDS = ' , ';
    expect(clerkUserAllowed('')).toBe(false);
    expect((await call('/api/net-worth')).status).toBe(403);
  });

  test('a lookalike id is not a match', () => {
    expect(clerkUserAllowed('user_own')).toBe(false);
    expect(clerkUserAllowed('user_owner,user_partner')).toBe(false);
  });
});
