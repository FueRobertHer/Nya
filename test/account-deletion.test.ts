import { describe, expect, test, mock, beforeEach, afterEach } from 'bun:test';
import { clerk } from './clerk-mock';
import { FakeRedis, storageMock, TEST_CTX, TEST_CONTAINER, registerTestContainer, unscopedDataKeys } from './fake-redis';

process.env.PLAID_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');

const removed: string[] = [];
let removeFails = false;
mock.module('@/lib/plaid', () => ({
  plaidClient: {
    itemRemove: async (req: any) => {
      if (removeFails) throw new Error('plaid down');
      removed.push(req.access_token);
      return { data: {} };
    },
  },
}));

const deletedUsers: string[] = [];
// Deleting the Clerk user, mocked at our own module: another file's mock of
// Clerk may be the one loaded, and its shape is not this file's to rely on.
let deleteUserFails = false;
let duringDeleteUser: () => Promise<void> = async () => {};
mock.module('@/lib/clerk-users', () => ({
  deleteClerkUser: async (id: string) => {
    await duringDeleteUser();
    if (deleteUserFails) throw new Error('clerk down');
    deletedUsers.push(id);
  },
}));
mock.module('@/lib/people', () => ({ displayNames: async (ids: string[]) => Object.fromEntries(ids.map((id) => [id, id])) }));

const fake = new FakeRedis();
afterEach(() => expect(unscopedDataKeys(fake)).toEqual([]));
mock.module('@/lib/storage', () => storageMock(fake));

const { encrypt } = await import('@/lib/crypto');
const { ownerContainer, ownersKey } = await import('@/lib/owners');
const { saveManualAccount } = await import('@/lib/manual');
const { registryKey } = await import('@/lib/containers');
const { outgoing } = await import('@/lib/sharing');

const route = async (path: string, method: string, body?: unknown) => {
  const mod: any = await import(`@/app/api/${path}/route`);
  const res = await mod[method](new Request(`http://x/api/${path}`, { method, body: body ? JSON.stringify(body) : undefined }));
  return { status: res.status, body: await res.json() };
};
const as = async <T>(user: string, fn: () => Promise<T>) => {
  clerk.signedIn = user;
  return fn();
};
const manual = (id: string) =>
  ({ account_id: id, name: id, institution_name: 'Manual', type: 'depository', subtype: null, balance: 10, updated_at: new Date().toISOString() }) as any;

let partner: { container: any };
const saved = { ...process.env };
beforeEach(async () => {
  fake.reset();
  removed.length = 0;
  deletedUsers.length = 0;
  removeFails = false;
  deleteUserFails = false;
  duringDeleteUser = async () => {};
  (await import('@/lib/sessions')).forgetEpochs();
  await registerTestContainer(fake);
  process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY = 'pk_test_x';
  process.env.CLERK_SECRET_KEY = 'sk_test_x';
  process.env.CLERK_ALLOWED_USER_IDS = 'user_owner,user_partner';
  // The owner, with data; the partner, with a bank, a manual account, and sharing both ways.
  await ownerContainer('user_owner');
  await saveManualAccount(TEST_CTX, manual('manual_owner'));
  partner = { container: await ownerContainer('user_partner') };
  await saveManualAccount(partner as any, manual('manual_partner'));
  await fake.hset(`test:c:${partner.container}:plaid:items`, {
    item_p: JSON.stringify({ item_id: 'item_p', institution_name: 'Ally', encrypted_access_token: await encrypt('token-partner') }),
  });
  await as('user_owner', () => route('sharing', 'PUT', { to: 'user_partner', accounts: { manual_owner: 'balance' } }));
  await as('user_partner', () => route('sharing', 'PUT', { to: 'user_owner', accounts: { manual_partner: 'balance' } }));
});
afterEach(() => {
  process.env = { ...saved };
});

const keysOf = (container: string) =>
  [...(fake as any).strings.keys(), ...(fake as any).hashes.keys()].filter((k: string) => k.startsWith(`test:c:${container}:`));

describe('deleting my account', () => {
  test('disconnects my banks, deletes everything of mine, ends sharing, and leaves the owner untouched', async () => {
    const ownerKeysBefore = keysOf(TEST_CONTAINER).sort();
    expect(keysOf(partner.container).length).toBeGreaterThan(0);

    const res = await as('user_partner', () => route('account', 'DELETE', { confirm: 'DELETE' }));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ deleted: true, disconnected: 1 });
    expect(removed).toEqual(['token-partner']);
    expect(keysOf(partner.container)).toEqual([]);
    expect(await fake.hget(registryKey(), partner.container)).toBeNull();
    expect(await fake.hget(ownersKey(), 'user_partner')).toBeNull();
    expect(await outgoing('user_owner')).toEqual({});
    expect(await outgoing('user_partner')).toEqual({});
    expect(deletedUsers).toEqual(['user_partner']);
    // The owner's data and container are as they were.
    expect(keysOf(TEST_CONTAINER).sort()).toEqual(ownerKeysBefore);
    expect(String(await fake.hget(ownersKey(), 'user_owner'))).toBe(TEST_CONTAINER);
  });

  test('needs DELETE typed out', async () => {
    expect((await as('user_partner', () => route('account', 'DELETE', { confirm: 'yes' }))).status).toBe(400);
    expect(keysOf(partner.container).length).toBeGreaterThan(0);
  });

  test('the primary account can’t be deleted from the app', async () => {
    expect((await as('user_owner', () => route('account', 'GET'))).body).toMatchObject({ enabled: true, can_delete: false });
    const res = await as('user_owner', () => route('account', 'DELETE', { confirm: 'DELETE' }));
    expect(res.status).toBe(409);
    expect(keysOf(TEST_CONTAINER).length).toBeGreaterThan(0);
    expect((await as('user_partner', () => route('account', 'GET'))).body).toMatchObject({ enabled: true, can_delete: true });
  });

  test('a bank Plaid won’t disconnect doesn’t stop the rest', async () => {
    removeFails = true;
    const errors = console.error;
    console.error = () => {};
    try {
      expect((await as('user_partner', () => route('account', 'DELETE', { confirm: 'DELETE' }))).status).toBe(200);
    } finally {
      console.error = errors;
    }
    expect(keysOf(partner.container)).toEqual([]);
  });

  test('stopped part way, it can’t be reached meanwhile, and running it again finishes', async () => {
    fake.failNext('del');
    const errors = console.error;
    console.error = () => {};
    try {
      expect((await as('user_partner', () => route('account', 'DELETE', { confirm: 'DELETE' }))).status).toBe(500);
    } finally {
      console.error = errors;
    }
    // Archived: its own requests and anyone it shared with reach nothing.
    const rec = JSON.parse((await fake.hget<string>(registryKey(), partner.container))!);
    expect(rec.status).toBe('archived');
    expect((await as('user_partner', () => route('shared', 'GET'))).status).toBe(503);
    expect((await as('user_owner', () => route('shared', 'GET'))).body.shared).toEqual([]);
    // Again: finished.
    expect((await as('user_partner', () => route('account', 'DELETE', { confirm: 'DELETE' }))).status).toBe(200);
    expect(keysOf(partner.container)).toEqual([]);
    expect(await fake.hget(registryKey(), partner.container)).toBeNull();
  });

  test('a sign-in Clerk won’t delete is reported, and running it again deletes it', async () => {
    deleteUserFails = true;
    const errors = console.error;
    console.error = () => {};
    try {
      expect((await as('user_partner', () => route('account', 'DELETE', { confirm: 'DELETE' }))).status).toBe(500);
    } finally {
      console.error = errors;
    }
    expect(keysOf(partner.container)).toEqual([]);
    expect(deletedUsers).toEqual([]);
    deleteUserFails = false;
    expect((await as('user_partner', () => route('account', 'DELETE', { confirm: 'DELETE' }))).status).toBe(200);
    expect(deletedUsers).toEqual(['user_partner']);
    expect(await fake.hget(ownersKey(), 'user_partner')).toBeNull();
  });

  test('a write that lands after the first sweep is swept too', async () => {
    duringDeleteUser = async () => void (await fake.set(`test:c:${partner.container}:budgets`, 'late'));
    expect((await as('user_partner', () => route('account', 'DELETE', { confirm: 'DELETE' }))).status).toBe(200);
    expect(keysOf(partner.container)).toEqual([]);
  });

  test('with the shared password there are no accounts to delete', async () => {
    delete process.env.CLERK_SECRET_KEY;
    expect((await route('account', 'GET')).body).toEqual({ enabled: false });
    expect((await route('account', 'DELETE', { confirm: 'DELETE' })).status).toBe(400);
  });

  test('signed out, nothing happens', async () => {
    expect((await as(null as any, () => route('account', 'DELETE', { confirm: 'DELETE' }))).status).toBe(401);
    expect(String(await fake.hget(ownersKey(), 'user_partner'))).toBe(String(partner.container));
  });
});

