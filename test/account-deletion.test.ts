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

const fake = new FakeRedis();
afterEach(() => expect(unscopedDataKeys(fake)).toEqual([]));
mock.module('@/lib/storage', () => storageMock(fake));

const { encrypt } = await import('@/lib/crypto');
const { encodeJsonBlob } = await import('@/lib/blob');
const { ownerContainer, ownersKey } = await import('@/lib/owners');
const { saveManualAccount } = await import('@/lib/manual');
const { registryKey } = await import('@/lib/containers');
const { myConnections } = await import('@/lib/sharing');

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
  // Two transactions on one account, and two days of history: what the receipt counts.
  const row = (id: string, date: string) => ({
    transaction_id: id,
    pending_transaction_id: null,
    account_id: 'acc_p',
    date,
    amount: 5,
    name: 'COFFEE',
    merchant_name: null,
    merchant_entity_id: null,
    pending: false,
    counterparties: [],
    account_name: 'Checking',
    institution_name: 'Ally',
  });
  await fake.set(
    `test:c:${partner.container}:txns:item_p`,
    await encodeJsonBlob({ schema_version: 2, cursor: 'c', accounts: { acc_p: { name: 'Checking', official_name: null, type: 'depository', subtype: 'checking', mask: '1', balances: null } }, txns: { t1: row('t1', '2026-01-01'), t2: row('t2', '2026-01-02') } })
  );
  await fake.hset(`test:c:${partner.container}:history:net-worth`, { '2026-01-01': await encrypt('10'), '2026-01-02': await encrypt('20') });
  await fake.hset(`test:c:${partner.container}:history:accounts`, { '2026-01-02': await encrypt(JSON.stringify({ acc_p: 10, manual_partner: 10 })) });
  const link = await as('user_owner', () => route('connections/invite', 'POST', {}));
  const { id } = (await as('user_partner', () => route('connections/accept', 'POST', { token: link.body.url.split('/connect/')[1] }))).body;
  await as('user_owner', () => route('connections', 'PUT', { id, accounts: { manual_owner: 'balance' } }));
  await as('user_partner', () => route('connections', 'PUT', { id, accounts: { manual_partner: 'balance' } }));
  expect((await as('user_owner', () => route('shared', 'GET'))).body.shared).toHaveLength(1);
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
    // The receipt counts what was there, and what each step did.
    expect(res.body.receipt).toMatchObject({
      found_data: true,
      resumed: false,
      includes_earlier_attempt: false,
      deleted: {
        banks_disconnected: 1,
        banks_not_disconnected: 0,
        accounts: 2, // the linked one and the manual one
        transactions: 2,
        investment_transactions: 0,
        history_days: 2,
        connections_ended: 1,
        sign_in_deleted: true,
      },
      // No blob store in the test environment: no backups to outlast it.
      backups: { kept: false },
    });
    expect(Date.parse(res.body.receipt.deleted_at)).toBeGreaterThan(0);
    expect(removed).toEqual(['token-partner']);
    expect(keysOf(partner.container)).toEqual([]);
    expect(await fake.hget(registryKey(), partner.container)).toBeNull();
    expect(await fake.hget(ownersKey(), 'user_partner')).toBeNull();
    expect(await myConnections('user_owner')).toEqual({ connections: [], blocked: [] });
    expect(await myConnections('user_partner')).toEqual({ connections: [], blocked: [] });
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
      const res = await as('user_partner', () => route('account', 'DELETE', { confirm: 'DELETE' }));
      expect(res.status).toBe(200);
      // Counted apart, so the receipt can point to the Plaid Portal for it.
      expect(res.body.receipt.deleted).toMatchObject({ banks_disconnected: 0, banks_not_disconnected: 1 });
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
    // Again: finished, and the receipt says an earlier attempt had started.
    const again = await as('user_partner', () => route('account', 'DELETE', { confirm: 'DELETE' }));
    expect(again.status).toBe(200);
    expect(again.body.receipt).toMatchObject({ found_data: true, resumed: true });
    expect(keysOf(partner.container)).toEqual([]);
    expect(await fake.hget(registryKey(), partner.container)).toBeNull();
  });

  test('a sign-in Clerk won’t delete is reported, and running it again deletes it', async () => {
    deleteUserFails = true;
    const errors = console.error;
    console.error = () => {};
    let first: { status: number; body: any };
    try {
      first = await as('user_partner', () => route('account', 'DELETE', { confirm: 'DELETE' }));
    } finally {
      console.error = errors;
    }
    expect(first.status).toBe(500);
    // What it did delete comes back, for the retry's receipt to count.
    expect(first.body.deleted_so_far).toEqual({
      banks_disconnected: 1,
      banks_not_disconnected: 0,
      accounts: 2,
      transactions: 2,
      investment_transactions: 0,
      history_days: 2,
      connections_ended: 1,
      sign_in_deleted: false,
    });
    expect(keysOf(partner.container)).toEqual([]);
    expect(deletedUsers).toEqual([]);
    deleteUserFails = false;
    const retry = await as('user_partner', () => route('account', 'DELETE', { confirm: 'DELETE' }));
    expect(retry.status).toBe(200);
    expect(retry.body.receipt).toMatchObject({
      found_data: false,
      deleted: { banks_disconnected: 0, accounts: 0, transactions: 0, connections_ended: 0, sign_in_deleted: true },
    });
    expect(deletedUsers).toEqual(['user_partner']);
    expect(await fake.hget(ownersKey(), 'user_partner')).toBeNull();
  });

  test('a write that lands after the first sweep is swept too', async () => {
    duringDeleteUser = async () => void (await fake.set(`test:c:${partner.container}:budgets`, 'late'));
    expect((await as('user_partner', () => route('account', 'DELETE', { confirm: 'DELETE' }))).status).toBe(200);
    expect(keysOf(partner.container)).toEqual([]);
  });

  test('what can’t be counted is still deleted, and the receipt says it wasn’t counted', async () => {
    await fake.set(`test:c:${partner.container}:txns:item_p`, 'garbage-ciphertext');
    const errors = console.error;
    console.error = () => {};
    let res: { status: number; body: any };
    try {
      res = await as('user_partner', () => route('account', 'DELETE', { confirm: 'DELETE' }));
    } finally {
      console.error = errors;
    }
    expect(res.status).toBe(200);
    expect(res.body.receipt.deleted).toMatchObject({ banks_disconnected: 1, accounts: null, transactions: null, history_days: null, sign_in_deleted: true });
    expect(keysOf(partner.container)).toEqual([]);
  });

  test('the receipt’s backup date is the honest maximum, and says when backups have stopped', async () => {
    process.env.BLOB_READ_WRITE_TOKEN = 'token';
    expect((await as('user_partner', () => route('account', 'GET'))).body).toMatchObject({ can_delete: true, backup_days: 31 });
    const res = await as('user_partner', () => route('account', 'DELETE', { confirm: 'DELETE' }));
    const { deleted_at, backups } = res.body.receipt;
    expect(backups).toEqual({ kept: true, keep_days: 30, min_kept: 7, until: new Date(Date.parse(deleted_at) + 31 * 86_400_000).toISOString(), stopped: false });
  });

  test('with backups stopped, or kept for less than the newest seven', async () => {
    process.env.BLOB_READ_WRITE_TOKEN = 'token';
    process.env.BACKUP_KEEP_DAYS = '3';
    await fake.set('test:backups:status', JSON.stringify({ last_ok: null, last_failed: new Date().toISOString(), reason: 'x' }));
    const { deleted_at, backups } = (await as('user_partner', () => route('account', 'DELETE', { confirm: 'DELETE' }))).body.receipt;
    expect(backups).toMatchObject({ kept: true, keep_days: 3, until: new Date(Date.parse(deleted_at) + 7 * 86_400_000).toISOString(), stopped: true });
  });

  test('a backup setting that can’t be read gives no date at all', async () => {
    process.env.BLOB_READ_WRITE_TOKEN = 'token';
    process.env.BACKUP_KEEP_DAYS = 'thirty';
    expect((await as('user_partner', () => route('account', 'GET'))).body.backup_days).toBeNull();
    expect((await as('user_partner', () => route('account', 'DELETE', { confirm: 'DELETE' }))).body.receipt.backups).toBeNull();
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

