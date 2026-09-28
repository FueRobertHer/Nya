import { describe, expect, test, mock, beforeEach, afterEach } from 'bun:test';
import { clerk } from './clerk-mock';
import { FakeRedis, storageMock, registerTestContainer } from './fake-redis';

// Tickets, mocked at our own module, not Clerk's.
const tickets: string[] = [];
let ticketFails = false;
mock.module('@/lib/clerk-tickets', () => ({
  signInTicket: async (id: string) => {
    if (ticketFails) throw new Error('clerk down');
    tickets.push(id);
    return `ticket-for-${id}`;
  },
}));

const fake = new FakeRedis();
mock.module('@/lib/storage', () => storageMock(fake));

const { demoUsers, isDemoUser, demoEnvironment } = await import('@/lib/demo');
const { clerkUserAllowed } = await import('@/lib/auth-mode');
const { deletionCheck } = await import('@/lib/account-deletion');
const { POST } = await import('@/app/api/demo/sign-in/route');

const saved = { ...process.env };
beforeEach(async () => {
  fake.reset();
  tickets.length = 0;
  ticketFails = false;
  clerk.signedIn = null;
  await registerTestContainer(fake);
  process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY = 'pk_test_x';
  process.env.CLERK_SECRET_KEY = 'sk_test_x';
  process.env.CLERK_ALLOWED_USER_IDS = 'user_owner';
  process.env.DEMO_USER_IDS = 'user_alex:Alex, user_sam:Sam, not-an-id, user_third';
  (process.env as any).VERCEL_ENV = 'preview';
});
afterEach(() => {
  process.env = { ...saved };
});

const signIn = (user: string, ip = '1.2.3.4') => {
  const form = new FormData();
  form.set('user', user);
  return POST(new Request('https://nya.test/api/demo/sign-in', { method: 'POST', body: form, headers: { 'x-forwarded-for': ip } }));
};

describe('demo accounts', () => {
  test('listed with labels on Preview; entries that are not user ids are skipped', () => {
    expect(demoUsers()).toEqual([
      { id: 'user_alex', label: 'Alex' },
      { id: 'user_sam', label: 'Sam' },
      { id: 'user_third', label: 'Demo 4' },
    ]);
  });

  test('nowhere but Preview (or local development): on Production the variable does nothing', async () => {
    (process.env as any).VERCEL_ENV = 'production';
    expect(demoEnvironment()).toBe(false);
    expect(demoUsers()).toEqual([]);
    expect(isDemoUser('user_alex')).toBe(false);
    expect(await clerkUserAllowed('user_alex')).toBe(false);
    expect((await signIn('user_alex')).status).toBe(404);
    expect(tickets).toEqual([]);
  });

  test('nothing without Clerk', () => {
    delete process.env.CLERK_SECRET_KEY;
    expect(demoUsers()).toEqual([]);
  });

  test('let in without being on the allowlist', async () => {
    expect(await clerkUserAllowed('user_alex')).toBe(true);
    expect(await clerkUserAllowed('user_stranger')).toBe(false);
  });

  test('can’t be deleted', async () => {
    expect(await deletionCheck('user_alex')).toMatchObject({ allowed: false, reason: expect.stringContaining('demo account') });
    expect(await deletionCheck('user_owner')).toEqual({ allowed: true });
  });
});

describe('the demo sign-in', () => {
  test('sends a demo account to Clerk’s sign-in with a ticket', async () => {
    const res = await signIn('user_sam');
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('https://nya.test/sign-in?__clerk_ticket=ticket-for-user_sam');
    expect(tickets).toEqual(['user_sam']);
  });

  test('only ever as a listed demo account', async () => {
    for (const user of ['user_owner', 'user_stranger', '']) {
      expect((await signIn(user)).status).toBe(400);
    }
    expect(tickets).toEqual([]);
  });

  test('limited per address', async () => {
    for (let i = 0; i < 20; i++) expect((await signIn('user_alex')).status).toBe(303);
    expect((await signIn('user_alex')).status).toBe(429);
    expect((await signIn('user_alex', '5.6.7.8')).status).toBe(303);
  });

  test('Clerk failing sends them back to sign in, saying so', async () => {
    ticketFails = true;
    const errors = console.error;
    console.error = () => {};
    try {
      const res = await signIn('user_alex');
      expect(res.status).toBe(303);
      expect(res.headers.get('location')).toBe('https://nya.test/sign-in?demo=unavailable');
    } finally {
      console.error = errors;
    }
  });
});
