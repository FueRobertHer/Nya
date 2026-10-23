import { describe, expect, test, mock, beforeEach, afterEach } from 'bun:test';
import { FakeRedis, storageMock, TEST_CTX, testKey, unscopedDataKeys } from './fake-redis';

// Who is emailed about a container's connections (lib/notice-recipients.ts):
// with Clerk, the owner's primary address if Clerk verified it; with the shared
// password, NOTIFY_EMAIL, for the deployment's own container only. Never a
// guess, and never somebody else's container.

const ctx = TEST_CTX;
const OTHER = { container: '7c1e0f3a-9b2d-4c5e-8f6a-0b1c2d3e4f5a' } as typeof TEST_CTX;
const fake = new FakeRedis({ deserialize: true });
afterEach(() => expect(unscopedDataKeys(fake)).toEqual([]));
mock.module('@/lib/storage', () => storageMock(fake));

const { noticeRecipients, primaryVerifiedOf, notifyEmails, sendsEmail } = await import('@/lib/notice-recipients');
const { ownersOf, ownersByContainer } = await import('@/lib/owners');

const saved = { ...process.env };
beforeEach(() => {
  fake.reset();
  for (const k of ['NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY', 'CLERK_SECRET_KEY', 'CLERK_ALLOWED_USER_IDS', 'NOTIFY_EMAIL', 'CONTAINER_ID', 'DEMO_USER_IDS', 'VERCEL_ENV', 'RESEND_API_KEY', 'MAIL_FROM']) delete process.env[k];
});
afterEach(() => {
  process.env = { ...saved };
});

const clerkOn = () => {
  process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY = 'pk_test_x';
  process.env.CLERK_SECRET_KEY = 'sk_test_x';
  process.env.CLERK_ALLOWED_USER_IDS = 'user_owner, user_partner, user_unverified';
};
const emails: Record<string, string | null> = { user_owner: 'owner@example.com', user_partner: 'partner@example.com', user_unverified: null };
const primaryEmail = async (id: string) => emails[id] ?? null;

describe('with Clerk', () => {
  test('the primary verified address of each account that owns the container, and nobody else', async () => {
    clerkOn();
    process.env.NOTIFY_EMAIL = 'ops@example.com'; // ignored with Clerk: it would get every account's notices
    await fake.hset(testKey('owners'), { user_owner: ctx.container, user_other: OTHER.container });
    expect(await ownersOf(ctx.container)).toEqual(['user_owner']);
    expect(await noticeRecipients(ctx, { primaryEmail })).toEqual(['owner@example.com']);
  });

  test('a container mapped by hand to two accounts tells both, once each; an unverified primary gets nothing', async () => {
    clerkOn();
    expect(await noticeRecipients(ctx, { owners: async () => ['user_owner', 'user_partner', 'user_unverified'], primaryEmail })).toEqual([
      'owner@example.com',
      'partner@example.com',
    ]);
    expect(await noticeRecipients(ctx, { owners: async () => ['user_unverified'], primaryEmail })).toEqual([]);
    expect(await noticeRecipients(ctx, { owners: async () => [], primaryEmail })).toEqual([]);
  });

  test("Preview's demo accounts are never emailed", async () => {
    clerkOn();
    process.env.VERCEL_ENV = 'preview';
    process.env.DEMO_USER_IDS = 'user_owner:Alex';
    expect(await noticeRecipients(ctx, { owners: async () => ['user_owner'], primaryEmail })).toEqual([]);
  });

  // Review nit: someone taken off the allowlist can't sign in to act on it.
  test('an account no longer on the allowlist is not emailed', async () => {
    clerkOn();
    const owners = async () => ['user_owner', 'user_partner'];
    process.env.CLERK_ALLOWED_USER_IDS = 'user_owner';
    expect(await noticeRecipients(ctx, { owners, primaryEmail })).toEqual(['owner@example.com']);
    delete process.env.CLERK_ALLOWED_USER_IDS;
    expect(await noticeRecipients(ctx, { owners, primaryEmail })).toEqual([]);
    // Whatever the allowlist says, through the same check the proxy makes.
    const asked: string[] = [];
    await noticeRecipients(ctx, { owners, primaryEmail, allowed: async (id) => (asked.push(id), id === 'user_partner') });
    expect(asked).toEqual(['user_owner', 'user_partner']);
  });

  test('the owners of every container come from one read of the mapping', async () => {
    await fake.hset(testKey('owners'), { user_b: ctx.container, user_a: ctx.container, user_c: OTHER.container, user_x: 'not-a-container' });
    const all = await ownersByContainer();
    expect(Object.fromEntries(all)).toEqual({ [ctx.container]: ['user_a', 'user_b'], [OTHER.container]: ['user_c'] });
    expect(await ownersOf(OTHER.container)).toEqual(['user_c']);
  });

  test('an owner mapping that cannot be read is an error, never an empty list taken as nobody', async () => {
    clerkOn();
    fake.failNext('hgetall');
    await expect(noticeRecipients(ctx, { primaryEmail })).rejects.toThrow();
  });

  test('the primary address counts only once Clerk has verified it', () => {
    const user = (status: string | null, primary = 'e1') => ({
      primaryEmailAddressId: primary,
      emailAddresses: [
        { id: 'e0', emailAddress: 'other@example.com', verification: { status: 'verified' } },
        { id: 'e1', emailAddress: 'me@example.com', verification: status ? { status } : null },
      ],
    });
    expect(primaryVerifiedOf(user('verified'))).toBe('me@example.com');
    expect(primaryVerifiedOf(user('unverified'))).toBeNull();
    expect(primaryVerifiedOf(user(null))).toBeNull();
    // Another verified address is not the primary one.
    expect(primaryVerifiedOf({ ...user('verified'), primaryEmailAddressId: null })).toBeNull();
  });
});

describe('with the shared password', () => {
  const deployment = async () => ({ kind: 'container' as const, container: ctx.container });

  test('NOTIFY_EMAIL, for the deployment’s own container', async () => {
    process.env.NOTIFY_EMAIL = 'me@example.com';
    expect(await noticeRecipients(ctx, { deployment })).toEqual(['me@example.com']);
    process.env.NOTIFY_EMAIL = ' me@example.com, you@example.com ,not-an-address';
    expect(await noticeRecipients(ctx, { deployment })).toEqual(['me@example.com', 'you@example.com']);
  });

  test('nobody for another container in the registry, or with NOTIFY_EMAIL unset', async () => {
    process.env.NOTIFY_EMAIL = 'me@example.com';
    expect(await noticeRecipients(OTHER, { deployment })).toEqual([]);
    expect(await noticeRecipients(ctx, { deployment: async () => ({ kind: 'none' as const }) })).toEqual([]);
    delete process.env.NOTIFY_EMAIL;
    expect(await noticeRecipients(ctx, { deployment })).toEqual([]);
    expect(notifyEmails()).toEqual([]);
  });
});

// Review nit: with the shared password and no NOTIFY_EMAIL, mail set up sends
// nothing, so the public pages must not name an email service for it.
test('this copy sends email only with mail set up and someone to write to', () => {
  expect(sendsEmail()).toBe(false);
  process.env.RESEND_API_KEY = 're_test_key';
  process.env.MAIL_FROM = 'Nya <alerts@example.com>';
  expect(sendsEmail()).toBe(false); // the shared password, and no NOTIFY_EMAIL
  process.env.NOTIFY_EMAIL = 'not-an-address';
  expect(sendsEmail()).toBe(false);
  process.env.NOTIFY_EMAIL = 'me@example.com';
  expect(sendsEmail()).toBe(true);
  delete process.env.NOTIFY_EMAIL;
  clerkOn();
  expect(sendsEmail()).toBe(true); // each account's own address
  delete process.env.MAIL_FROM;
  expect(sendsEmail()).toBe(false);
});
