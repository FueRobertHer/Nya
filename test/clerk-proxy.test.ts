import { describe, expect, test, mock, beforeEach, afterEach } from 'bun:test';
import { clerk } from './clerk-mock';
import { NextRequest } from 'next/server';

// An account's verified emails, mocked at our own module, not Clerk's.
const emailsOf: Record<string, string[]> = {};
const unverifiedOf: Record<string, string[]> = {};
let lookups = 0;
let lookupFails = false;
mock.module('@/lib/clerk-emails', () => ({
  emailAddresses: async (id: string) => {
    lookups++;
    if (lookupFails) throw new Error('clerk down');
    return [
      ...(emailsOf[id] ?? []).map((address) => ({ address, verified: true })),
      ...(unverifiedOf[id] ?? []).map((address) => ({ address, verified: false })),
    ];
  },
}));

const { proxy } = await import('@/proxy');
const { clerkEnabled, clerkUserAllowed, forgetEmails, EMAILS_REUSE_MS, EMAILS_STALE_MS } = await import('@/lib/auth-mode');

const saved = { ...process.env };
beforeEach(() => {
  clerk.signedIn = null;
  for (const k of Object.keys(emailsOf)) delete emailsOf[k];
  for (const k of Object.keys(unverifiedOf)) delete unverifiedOf[k];
  lookups = 0;
  lookupFails = false;
  forgetEmails();
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
    clerk.signedIn = 'user_owner'; // a Clerk session means nothing then
    expect((await call('/api/net-worth')).status).toBe(401);
    expect((await call('/')).headers.get('location')).toBe('https://nya.test/login');
  });
});

describe('with Clerk on', () => {
  test('signed out: pages go to sign-in, the API answers 401', async () => {
    expect((await call('/')).headers.get('location')).toBe('https://nya.test/sign-in');
    // Anywhere else, they come back there once signed in (an invite link).
    expect((await call('/connect/abc')).headers.get('location')).toBe('https://nya.test/sign-in?redirect_url=%2Fconnect%2Fabc');
    expect((await call('/api/net-worth')).status).toBe(401);
  });

  test('sign-in and the not-allowed page stay open', async () => {
    for (const path of ['/sign-in', '/sign-in/factor-one', '/not-allowed']) {
      const res = await call(path);
      expect(res.status).toBe(200);
      expect(res.headers.get('location')).toBeNull();
    }
  });

  test('so do the security and privacy pages, and the password login (which sends people to sign-in)', async () => {
    for (const path of ['/security', '/privacy', '/login']) {
      const res = await call(path);
      expect(res.status).toBe(200);
      expect(res.headers.get('location')).toBeNull();
    }
    expect((await call('/security/x')).headers.get('location')).toBe('https://nya.test/sign-in?redirect_url=%2Fsecurity%2Fx');
  });

  test("pages get the policy, with Clerk's host from the publishable key; the API gets none", async () => {
    process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY = `pk_live_${btoa('clerk.nya.example.com$').replace(/=+$/, '')}`;
    for (const path of ['/sign-in', '/security']) {
      const policy = (await call(path)).headers.get('content-security-policy-report-only');
      expect(policy).toContain('https://clerk.nya.example.com');
      expect(policy).toContain('https://challenges.cloudflare.com');
    }
    clerk.signedIn = 'user_owner';
    const page = await call('/');
    expect(page.status).toBe(200);
    const policy = page.headers.get('content-security-policy-report-only')!;
    expect(page.headers.get('x-middleware-request-x-nonce')).toBe(/'nonce-([^']+)'/.exec(policy)![1]);
    const api = await call('/api/net-worth');
    expect(api.status).toBe(200);
    expect(api.headers.get('content-security-policy-report-only')).toBeNull();
    expect(api.headers.get('content-security-policy')).toBeNull();
  });

  test('an allowed account gets in', async () => {
    clerk.signedIn = 'user_partner';
    expect((await call('/')).status).toBe(200);
    expect((await call('/api/net-worth')).status).toBe(200);
  });

  test('a signed-in account not on the list is turned away', async () => {
    clerk.signedIn = 'user_stranger';
    expect((await call('/')).headers.get('location')).toBe('https://nya.test/not-allowed');
    expect((await call('/api/net-worth')).status).toBe(403);
  });

  test('no allowlist lets nobody in', async () => {
    delete process.env.CLERK_ALLOWED_USER_IDS;
    clerk.signedIn = 'user_owner';
    expect((await call('/api/net-worth')).status).toBe(403);
    process.env.CLERK_ALLOWED_USER_IDS = ' , ';
    expect(await clerkUserAllowed('')).toBe(false);
    expect((await call('/api/net-worth')).status).toBe(403);
  });

  test('a lookalike id is not a match', async () => {
    expect(await clerkUserAllowed('user_own')).toBe(false);
    expect(await clerkUserAllowed('user_owner,user_partner')).toBe(false);
  });
});

describe('emails on the allowlist', () => {
  beforeEach(() => {
    process.env.CLERK_ALLOWED_USER_IDS = 'user_owner, Partner@Example.com';
  });

  test('an account with that verified email gets in, in any case', async () => {
    emailsOf.user_partner = ['partner@example.COM'];
    clerk.signedIn = 'user_partner';
    expect((await call('/')).status).toBe(200);
    expect((await call('/api/net-worth')).status).toBe(200);
  });

  test('an unverified address is not enough', async () => {
    unverifiedOf.user_stranger = ['partner@example.com'];
    clerk.signedIn = 'user_stranger';
    expect((await call('/api/net-worth')).status).toBe(403);
  });

  test('an account without it is turned away', async () => {
    emailsOf.user_stranger = ['stranger@example.com', 'partner@example.com.evil'];
    clerk.signedIn = 'user_stranger';
    expect((await call('/api/net-worth')).status).toBe(403);
  });

  test('a listed id needs no lookup, and matching both an id and an email is fine', async () => {
    emailsOf.user_owner = ['partner@example.com'];
    expect(await clerkUserAllowed('user_owner')).toBe(true);
    expect(lookups).toBe(0);
    process.env.CLERK_ALLOWED_USER_IDS = 'user_partner, partner@example.com';
    emailsOf.user_partner = ['partner@example.com'];
    expect(await clerkUserAllowed('user_partner')).toBe(true);
  });

  test('without email entries, nobody is looked up', async () => {
    process.env.CLERK_ALLOWED_USER_IDS = 'user_owner';
    expect(await clerkUserAllowed('user_stranger')).toBe(false);
    expect(lookups).toBe(0);
  });

  test('a lookup is reused for a minute, then asked again', async () => {
    emailsOf.user_partner = ['partner@example.com'];
    expect(await clerkUserAllowed('user_partner', 1_000)).toBe(true);
    expect(await clerkUserAllowed('user_partner', 1_000 + EMAILS_REUSE_MS - 1)).toBe(true);
    expect(lookups).toBe(1);
    // The email is removed from the account: gone once the minute is up.
    emailsOf.user_partner = [];
    expect(await clerkUserAllowed('user_partner', 1_000 + EMAILS_REUSE_MS)).toBe(false);
    expect(lookups).toBe(2);
  });

  test('requests asking at once share one lookup', async () => {
    emailsOf.user_partner = ['partner@example.com'];
    const answers = await Promise.all([1, 2, 3].map(() => clerkUserAllowed('user_partner', 1_000)));
    expect(answers).toEqual([true, true, true]);
    expect(lookups).toBe(1);
  });

  test('while Clerk is down, an answer up to ten minutes old still counts', async () => {
    emailsOf.user_partner = ['partner@example.com'];
    expect(await clerkUserAllowed('user_partner', 1_000)).toBe(true);
    lookupFails = true;
    const errors = console.error;
    console.error = () => {};
    try {
      expect(await clerkUserAllowed('user_partner', 1_000 + EMAILS_STALE_MS - 1)).toBe(true);
      expect(await clerkUserAllowed('user_partner', 1_000 + EMAILS_STALE_MS)).toBe(false);
    } finally {
      console.error = errors;
    }
  });

  test('a failed lookup turns them away, and is not remembered', async () => {
    emailsOf.user_partner = ['partner@example.com'];
    lookupFails = true;
    const errors = console.error;
    console.error = () => {};
    try {
      expect(await clerkUserAllowed('user_partner')).toBe(false);
    } finally {
      console.error = errors;
    }
    lookupFails = false;
    expect(await clerkUserAllowed('user_partner')).toBe(true);
  });
});
