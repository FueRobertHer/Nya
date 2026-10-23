import { describe, expect, test, mock, beforeEach, afterEach } from 'bun:test';
import { clerk } from './clerk-mock';
import { mockForFile } from './scoped-mock';
import { FakeRedis, storageMock, TEST_CTX, TEST_CONTAINER, registerTestContainer, unscopedDataKeys } from './fake-redis';

process.env.PLAID_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');

const removed: string[] = [];
let removeFails = false;
/** What Plaid answers instead, when set: an error in Plaid's own shape. */
let removeError: unknown = null;
mock.module('@/lib/plaid', () => ({
  plaidClient: {
    itemRemove: async (req: any) => {
      if (removeFails) throw new Error('plaid down');
      if (removeError) throw removeError;
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
await mockForFile('@/lib/clerk-users', () => ({
  deleteClerkUser: async (id: string) => {
    await duringDeleteUser();
    if (deleteUserFails) throw new Error('clerk down');
    deletedUsers.push(id);
  },
}));

const fake = new FakeRedis();
afterEach(() => expect(unscopedDataKeys(fake)).toEqual([]));
mock.module('@/lib/storage', () => storageMock(fake));

// Vercel Blob, kept in memory: where the key archives a deletion rewrites
// are kept (lib/key-archive.ts). Read back through the store's own URL with
// node's client, which is served from here too.
const blobs = new Map<string, { body: string; options: any }>();
await mockForFile('@vercel/blob', () => ({
  put: async (pathname: string, body: string, options: any) => {
    if (blobs.has(pathname) && !options.allowOverwrite) throw new Error('exists');
    blobs.set(pathname, { body, options });
    return { pathname };
  },
  get: async (pathname: string) =>
    blobs.has(pathname) ? { statusCode: 200, stream: new ReadableStream({}), headers: new Headers(), blob: { url: `https://store.blob.vercel-storage.com/${pathname}` } } : null,
  list: async ({ prefix }: { prefix: string }) => ({
    blobs: [...blobs.keys()].filter((p) => p.startsWith(prefix)).sort().map((pathname) => ({ pathname, uploadedAt: new Date() })),
    hasMore: false,
  }),
  del: async (pathnames: string[]) => {
    for (const p of pathnames) blobs.delete(p);
  },
}));

const { encrypt } = await import('@/lib/crypto');
const { encodeJsonBlob } = await import('@/lib/blob');
const { ownerContainer, ownersKey } = await import('@/lib/owners');
const { saveManualAccount } = await import('@/lib/manual');
const { registryKey } = await import('@/lib/containers');
const { myConnections } = await import('@/lib/sharing');
const { deleteAccount } = await import('@/lib/account-deletion');

/** Reads of the partner's history never answer, as a stalled database call
 *  doesn't. Returns the undo. */
const stallHistory = () => {
  const hgetall = fake.hgetall.bind(fake);
  (fake as any).hgetall = (key: string) => (key.includes(':history:') ? new Promise(() => {}) : hgetall(key));
  return () => void delete (fake as any).hgetall;
};

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
  blobs.clear();
  removed.length = 0;
  deletedUsers.length = 0;
  removeFails = false;
  removeError = null;
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
    item_p: JSON.stringify({ item_id: 'item_p', institution_name: 'Ally', encrypted_access_token: await encrypt(TEST_CTX, 'token-partner') }),
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
    await encodeJsonBlob(TEST_CTX, { schema_version: 2, cursor: 'c', accounts: { acc_p: { name: 'Checking', official_name: null, type: 'depository', subtype: 'checking', mask: '1', balances: null } }, txns: { t1: row('t1', '2026-01-01'), t2: row('t2', '2026-01-02') } })
  );
  await fake.hset(`test:c:${partner.container}:history:net-worth`, { '2026-01-01': await encrypt(TEST_CTX, '10'), '2026-01-02': await encrypt(TEST_CTX, '20') });
  await fake.hset(`test:c:${partner.container}:history:accounts`, { '2026-01-02': await encrypt(TEST_CTX, JSON.stringify({ acc_p: 10, manual_partner: 10 })) });
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
        earlier_accounts: 0,
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

  test('takes both records of showings on its connections with it, the one in the other person’s container too', async () => {
    // Each has been shown what the other shares: a record on each side.
    expect((await as('user_partner', () => route('shared', 'GET'))).body.shared).toHaveLength(1);
    const records = (container: string) => keysOf(container).filter((k: string) => k.endsWith(':sharing-access-log'));
    expect(records(TEST_CONTAINER)).toHaveLength(1);
    expect(records(partner.container)).toHaveLength(1);
    const ownerKeysBefore = keysOf(TEST_CONTAINER).filter((k: string) => !k.endsWith(':sharing-access-log')).sort();

    expect((await as('user_partner', () => route('account', 'DELETE', { confirm: 'DELETE' }))).status).toBe(200);
    expect(records(TEST_CONTAINER)).toEqual([]);
    expect(keysOf(partner.container)).toEqual([]);
    // And nothing else of the owner's.
    expect(keysOf(TEST_CONTAINER).sort()).toEqual(ownerKeysBefore);
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

  test('an account whose data belongs to another sign-in too can’t be deleted from the app', async () => {
    // The owners mapping edited by hand to give one container to two accounts (docs/authentication.md).
    await fake.hset(ownersKey(), { user_other: partner.container });
    expect((await as('user_partner', () => route('account', 'GET'))).body).toMatchObject({ enabled: true, can_delete: false, reason: expect.stringContaining('belongs to another sign-in too') });
    expect((await as('user_partner', () => route('account', 'DELETE', { confirm: 'DELETE' }))).status).toBe(409);
    expect(keysOf(partner.container).length).toBeGreaterThan(0);
    await fake.hdel(ownersKey(), 'user_other');
    expect((await as('user_partner', () => route('account', 'GET'))).body).toMatchObject({ can_delete: true });
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
    let firstTry: { status: number; body: any };
    try {
      firstTry = await as('user_partner', () => route('account', 'DELETE', { confirm: 'DELETE' }));
    } finally {
      console.error = errors;
    }
    // What it had done comes back, counts and all, for the retry's receipt.
    expect(firstTry.status).toBe(500);
    // Archived: its own requests and anyone it shared with reach nothing.
    const rec = JSON.parse((await fake.hget<string>(registryKey(), partner.container))!);
    expect(rec.status).toBe('archived');
    expect(firstTry.body.deleted_so_far).toMatchObject({ banks_disconnected: 1, accounts: 2, transactions: 2, sign_in_deleted: false });
    expect((await as('user_partner', () => route('shared', 'GET'))).status).toBe(503);
    expect((await as('user_owner', () => route('shared', 'GET'))).body.shared).toEqual([]);
    // Again: finished, and the receipt says an earlier attempt had begun. What
    // was stored isn't counted again (part of it may be gone): unavailable,
    // not a smaller number. The bank, which Plaid now no longer has, counts
    // as disconnected rather than as one Plaid wouldn't disconnect.
    removeError = { response: { data: { error_code: 'ITEM_NOT_FOUND' } } };
    const again = await as('user_partner', () => route('account', 'DELETE', { confirm: 'DELETE' }));
    expect(again.status).toBe(200);
    expect(again.body.receipt).toMatchObject({ found_data: true, resumed: true });
    expect(again.body.receipt.deleted).toMatchObject({ banks_disconnected: 1, banks_not_disconnected: 0, accounts: null, transactions: null, history_days: null });
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
      earlier_accounts: 0,
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

  test('a day of balances or a manual account that can’t be read is still counted: it is stored, and deleted', async () => {
    // A third day, damaged, and a second manual account, damaged: as the
    // download of my data reads them, named rather than stopping it.
    await fake.hset(`test:c:${partner.container}:history:net-worth`, { '2026-01-03': 'garbage-ciphertext' });
    await fake.hset(`test:c:${partner.container}:manual:accounts`, { manual_broken: 'garbage-ciphertext' });
    const res = await as('user_partner', () => route('account', 'DELETE', { confirm: 'DELETE' }));
    expect(res.status).toBe(200);
    expect(res.body.receipt.deleted).toMatchObject({ accounts: 3, transactions: 2, history_days: 3 });
    expect(keysOf(partner.container)).toEqual([]);
  });

  test('counting that stalls never stands between the person and their banks being disconnected', async () => {
    const undo = stallHistory();
    const said: string[] = [];
    const errors = console.error;
    console.error = (...a: unknown[]) => void said.push(a.map(String).join(' '));
    try {
      const result = await deleteAccount('user_partner', { removeItem: async (t) => void removed.push(t), countLimitMs: 50 });
      expect(removed).toEqual(['token-partner']);
      expect(keysOf(partner.container)).toEqual([]);
      expect(result.counts).toMatchObject({ banks_disconnected: 1, accounts: null, transactions: null, history_days: null });
    } finally {
      console.error = errors;
      undo();
    }
    expect(said).toEqual(['Account deletion: counting what was stored took longer than 0.05s, so the receipt goes without it']);
  });

  test('a retry doesn’t count again, so a stalled count can’t hold it up either', async () => {
    fake.failNext('del');
    const errors = console.error;
    console.error = () => {};
    try {
      expect((await as('user_partner', () => route('account', 'DELETE', { confirm: 'DELETE' }))).status).toBe(500);
    } finally {
      console.error = errors;
    }
    // With the full ten-second limit, a count would outlast this test's own time limit.
    const undo = stallHistory();
    try {
      const again = await as('user_partner', () => route('account', 'DELETE', { confirm: 'DELETE' }));
      expect(again.status).toBe(200);
      expect(again.body.receipt.deleted.accounts).toBeNull();
    } finally {
      undo();
    }
    expect(keysOf(partner.container)).toEqual([]);
  });

  test('a token from another Plaid environment is still a bank Plaid wouldn’t disconnect', async () => {
    removeError = { response: { data: { error_code: 'INVALID_ACCESS_TOKEN' } } };
    const errors = console.error;
    console.error = () => {};
    try {
      const res = await as('user_partner', () => route('account', 'DELETE', { confirm: 'DELETE' }));
      expect(res.body.receipt.deleted).toMatchObject({ banks_disconnected: 0, banks_not_disconnected: 1 });
    } finally {
      console.error = errors;
    }
  });

  test('the receipt’s backup date is the honest maximum, and says when backups have stopped', async () => {
    process.env.BLOB_READ_WRITE_TOKEN = 'token';
    // 31 days by the pruning rules, and a day for the cron's timing.
    expect((await as('user_partner', () => route('account', 'GET'))).body).toMatchObject({ can_delete: true, backup_days: 32 });
    const res = await as('user_partner', () => route('account', 'DELETE', { confirm: 'DELETE' }));
    const { deleted_at, backups } = res.body.receipt;
    expect(backups).toEqual({ kept: true, keep_days: 30, min_kept: 7, until: new Date(Date.parse(deleted_at) + 32 * 86_400_000).toISOString(), stopped: false });
  });

  test('with backups stopped, or kept for less than the newest seven', async () => {
    process.env.BLOB_READ_WRITE_TOKEN = 'token';
    process.env.BACKUP_KEEP_DAYS = '3';
    await fake.set('test:backups:status', JSON.stringify({ last_ok: null, last_failed: new Date().toISOString(), reason: 'x' }));
    const { deleted_at, backups } = (await as('user_partner', () => route('account', 'DELETE', { confirm: 'DELETE' }))).body.receipt;
    expect(backups).toMatchObject({ kept: true, keep_days: 3, until: new Date(Date.parse(deleted_at) + 8 * 86_400_000).toISOString(), stopped: true });
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


// A data key per container (docs/operations.md, "Per-container data keys"):
// an account born with one has it destroyed with it.
describe('an account with a data key of its own', () => {
  const MASTER = Buffer.alloc(32, 71).toString('base64');
  let third: { container: any };
  let keyThird = '';
  const map = () => fake.hashes.get('test:crypto:container-keys');
  const quiet = async <R>(fn: () => Promise<R>): Promise<R> => {
    const orig = console.error;
    console.error = () => {};
    try {
      return await fn();
    } finally {
      console.error = orig;
    }
  };
  /** The key archives, kept in memory, read back exactly. */
  const memoryStore = () => {
    const files = new Map<string, string>();
    return {
      files,
      put: async (p: string, body: string) => void files.set(p, body),
      get: async (p: string) => files.get(p) ?? null,
      list: async (prefix: string) => [...files.keys()].filter((p) => p.startsWith(prefix)).map((pathname) => ({ pathname, uploadedAt: new Date() })),
      del: async (ps: string[]) => void ps.forEach((p) => files.delete(p)),
    };
  };

  beforeEach(async () => {
    process.env.MASTER_KEY = MASTER;
    process.env.CLERK_ALLOWED_USER_IDS = 'user_owner,user_partner,user_third';
    (await import('@/lib/crypto')).forgetActiveKey();
    // Born with its key, in the step that registers it.
    third = { container: await ownerContainer('user_third') };
    keyThird = JSON.parse(map()!.get(third.container)!).key;
    await saveManualAccount(third as any, manual('manual_third'));
    await fake.hset(`test:c:${third.container}:plaid:items`, {
      item_t: JSON.stringify({ item_id: 'item_t', institution_name: 'Ally', encrypted_access_token: await encrypt(third as any, 'token-third') }),
    });
  });
  // The map entries are kept for a minute: never into the next test.
  afterEach(async () => (await import('@/lib/crypto')).forgetActiveKey());

  test('its key goes with it: out of the key store, with a tombstone and a marker, and the receipt says so', async () => {
    const res = await as('user_third', () => route('account', 'DELETE', { confirm: 'DELETE' }));
    expect(res.status).toBe(200);
    expect(removed).toEqual(['token-third']); // its bank's token read with the key, before it went
    expect(fake.hashes.get('test:crypto:keys')?.has(keyThird) ?? false).toBe(false);
    expect(JSON.parse(fake.hashes.get('test:crypto:destroyed')!.get(keyThird)!)).toEqual({ container: third.container, on: new Date().toISOString().slice(0, 10) });
    expect(JSON.parse(map()!.get(third.container)!)).toEqual({ destroyed: new Date().toISOString().slice(0, 10) });
    expect(keysOf(third.container)).toEqual([]);
    expect(await fake.hget(ownersKey(), 'user_third')).toBeNull(); // the marker gone with the sign-in
    // Born with its key and never under a shared one: no copy under a shared key.
    expect(res.body.receipt.keys).toEqual({ own_key: true, shared_from: null, key_in: null, key_backups: { none: true }, shared_until: null, key_until: null });
  });

  test('every kept key archive is rewritten without it, as the last step', async () => {
    const { runBackup } = await import('@/lib/backup');
    const { listGenerations, verifyKeyArchive } = await import('@/lib/key-archive');
    const store = memoryStore();
    process.env.BLOB_READ_WRITE_TOKEN = 'token';
    await quiet(() => runBackup(fake as any, store as any, new Date(Date.now() - 86_400_000)));
    const holds = async () => {
      const { generations } = await listGenerations(store as any);
      return verifyKeyArchive((await store.get(generations[0].pathname))!).keys.has(keyThird);
    };
    expect(await holds()).toBe(true);
    const result = await deleteAccount('user_third', { removeItem: async () => {}, keyArchives: store as any });
    expect(result.keys).toMatchObject({ own_key: true, key_backups: { rewritten_at: expect.any(String) } });
    expect(await holds()).toBe(false);
  });

  // A backup the release before took while rolled back (format 1) holds the
  // whole key store, this account's key included, until it is pruned.
  describe('after a rollback', () => {
    const later = async (keys: unknown) => {
      const { buildDeletionReceipt, receiptSections } = await import('@/lib/deletion-receipt');
      const { backupRetention } = await import('@/lib/backup');
      const receipt = buildDeletionReceipt({ counts: {} as any, found_data: true, resumed: false, deleted_at: new Date(), retention: backupRetention(), stopped: false, keys: keys as any, database_days: 0 });
      const day = (iso: string) => new Intl.DateTimeFormat('en-US', { dateStyle: 'long', timeZone: 'UTC' }).format(new Date(iso));
      return { text: receiptSections(receipt, { locale: 'en-US', timeZone: 'UTC' }).find((s) => s.title === 'Expires later')!.lines.join('\n'), until: day(receipt.keys!.key_until!) };
    };
    const rolledBack = async (store: ReturnType<typeof memoryStore>) => {
      const { backupFolder } = await import('@/lib/backup');
      const taken = new Date(Date.parse(JSON.parse(map()!.get(third.container)!).since) + 3_600_000);
      await store.put(`${backupFolder()}nya-${taken.toISOString().replace(/[:.]/g, '-')}.ndjson`, 'format 1');
      return taken.toISOString();
    };
    beforeEach(() => {
      process.env.BLOB_READ_WRITE_TOKEN = 'token';
    });

    test('noted by a nightly run: the receipt says the backup holds the key, until when, and that copies under a shared key can exist', async () => {
      const { runBackup } = await import('@/lib/backup');
      const store = memoryStore();
      const taken = await rolledBack(store);
      expect((await quiet(() => runBackup(fake as any, store as any, new Date()))).rollback_noted).toEqual([third.container]);
      const result = await deleteAccount('user_third', { removeItem: async () => {}, keyArchives: store as any });
      // Worded first: toMatchObject writes its matchers into what it is given.
      const { text, until } = await later(result.keys);
      expect(result.keys).toMatchObject({ own_key: true, key_in: taken, shared_from: expect.any(String), key_backups: { rewritten_at: expect.any(String) } });
      expect(text).toContain(`but a backup taken while an older version of Nya ran holds your key until ${until}: until then, every copy of your data can be decrypted with this server’s master key.`);
      expect(text).not.toContain('nothing encrypted under it can be decrypted');
      expect(text).not.toContain('Copies under a shared key: none');
    });

    test('deleted after rolling forward, before any nightly run: the deletion lists the backups itself', async () => {
      const store = memoryStore();
      const taken = await rolledBack(store);
      expect(JSON.parse(map()!.get(third.container)!).key_in).toBeUndefined(); // nothing noted it
      const result = await deleteAccount('user_third', { removeItem: async () => {}, keyArchives: store as any });
      const { text } = await later(result.keys);
      expect(result.keys).toMatchObject({ own_key: true, key_in: taken });
      expect(text).toContain('a backup taken while an older version of Nya ran holds your key until');
      expect(text).not.toContain('Copies under a shared key: none');
    });

    test('backups that can’t be listed: the receipt says what it couldn’t check', async () => {
      const store = { ...memoryStore(), list: async (prefix: string) => (prefix.startsWith('backups/') ? Promise.reject(new Error('blob down')) : []) };
      const result = await quiet(() => deleteAccount('user_third', { removeItem: async () => {}, keyArchives: store as any }));
      const { text } = await later(result.keys);
      expect(result.keys).toMatchObject({ own_key: true, key_in: 'unchecked' });
      expect(text).toContain('but whether a backup taken while an older version of Nya ran holds your key couldn’t be checked: if one does, every copy of your data can be decrypted with this server’s master key until');
    });
  });

  test('while it runs, no other tab gets the account a container, and a write that comes too late fails', async () => {
    const { ContainerKeyError } = await import('@/lib/crypto');
    let during: unknown[] = [];
    duringDeleteUser = async () => {
      during = [await ownerContainer('user_third').catch((e) => e), await encrypt(third as any, 'late').catch((e) => e)];
    };
    expect((await as('user_third', () => route('account', 'DELETE', { confirm: 'DELETE' }))).status).toBe(200);
    expect((during[0] as Error).message).toContain('being deleted');
    expect(during[1]).toBeInstanceOf(ContainerKeyError);
    expect(keysOf(third.container)).toEqual([]);
  });

  test('stopped after its key was destroyed, a retry finds its container again by the marker, and finishes', async () => {
    deleteUserFails = true;
    expect((await quiet(() => as('user_third', () => route('account', 'DELETE', { confirm: 'DELETE' })))).status).toBe(500);
    expect(await fake.hget<string>(ownersKey(), 'user_third')).toBe(`deleted:${third.container}`);
    expect(fake.hashes.get('test:crypto:keys')?.has(keyThird) ?? false).toBe(false);
    deleteUserFails = false;
    const retry = await as('user_third', () => route('account', 'DELETE', { confirm: 'DELETE' }));
    expect(retry.status).toBe(200);
    expect(deletedUsers).toEqual(['user_third']);
    expect(await fake.hget(ownersKey(), 'user_third')).toBeNull();
    // Its map entry was destroyed already: whether it had a key is told by the tombstone.
    expect(retry.body.receipt.keys).toMatchObject({ own_key: true });
  });

  test('the night after, its container is swept once more, and only once', async () => {
    const { sweepDestroyedContainers } = await import('@/lib/account-deletion');
    expect((await as('user_third', () => route('account', 'DELETE', { confirm: 'DELETE' }))).status).toBe(200);
    await fake.set(`test:c:${third.container}:snapshot:runs`, 'a late count');
    expect(await sweepDestroyedContainers(new Date())).toEqual([]); // not the same day
    const tomorrow = new Date(Date.now() + 86_400_000);
    expect(await sweepDestroyedContainers(tomorrow)).toEqual([third.container]);
    expect(keysOf(third.container)).toEqual([]);
    expect(JSON.parse(map()!.get(third.container)!)).toEqual({ destroyed: new Date().toISOString().slice(0, 10), swept: tomorrow.toISOString().slice(0, 10) });
    expect(await sweepDestroyedContainers(new Date(Date.now() + 2 * 86_400_000))).toEqual([]);
  });

  test('the page says the account’s data is under a key of its own; the owner’s, made before, isn’t yet', async () => {
    expect((await as('user_third', () => route('account', 'GET'))).body).toMatchObject({ can_delete: true, own_key: true, database_days: 0 });
    expect((await as('user_partner', () => route('account', 'GET'))).body).toMatchObject({ can_delete: true, own_key: false });
  });
});

describe('what the receipt says of a data key, from the map entry', () => {
  const now = new Date('2026-10-17T12:00:00.000Z');
  const since = '2026-09-01T00:00:00.000Z';
  const key = 'k1-00000001';

  test('born with it, given it by the pass, or none at all', async () => {
    const { keyFactsOf } = await import('@/lib/account-deletion');
    expect(keyFactsOf(null, false, now, [])).toEqual({ own_key: false, shared_from: now.toISOString(), key_in: null });
    expect(keyFactsOf({ key, since, moved: since }, false, now, [])).toEqual({ own_key: true, shared_from: null, key_in: null });
    expect(keyFactsOf({ key, since, moved: since, shared_in: '2026-10-02T16:00:00.000Z' }, false, now, [])).toEqual({ own_key: true, shared_from: '2026-10-02T16:00:00.000Z', key_in: null });
    // Moved by the pass: everything was under a shared key until it found nothing left.
    expect(keyFactsOf({ key, since, moved: '2026-09-05T00:00:00.000Z' }, false, now, [])).toEqual({ own_key: true, shared_from: '2026-09-05T00:00:00.000Z', key_in: null });
    expect(keyFactsOf({ key, since }, false, now, [])).toEqual({ own_key: true, shared_from: now.toISOString(), key_in: null });
    // Read too late (an earlier attempt destroyed it): the tombstone says it had a key, nothing says since when.
    expect(keyFactsOf({ destroyed: '2026-10-17' }, true, now, [])).toEqual({ own_key: true, shared_from: now.toISOString(), key_in: null });
    expect(keyFactsOf(undefined, false, now, [])).toEqual({ own_key: null, shared_from: now.toISOString(), key_in: null });
  });

  test('a backup an older version took after the key was made holds it, and `moved` no longer stands until the pass walks it again', async () => {
    const { keyFactsOf } = await import('@/lib/account-deletion');
    const rolled = ['2026-08-01T16:00:00.000Z', '2026-09-10T16:00:00.000Z'];
    // Noted by a nightly run or not: the newest after its key was made.
    expect(keyFactsOf({ key, since, moved: since }, false, now, rolled)).toEqual({ own_key: true, shared_from: now.toISOString(), key_in: '2026-09-10T16:00:00.000Z' });
    expect(keyFactsOf({ key, since, key_in: '2026-09-10T16:00:00.000Z' }, false, now, rolled)).toEqual({ own_key: true, shared_from: now.toISOString(), key_in: '2026-09-10T16:00:00.000Z' });
    // Noted, and walked again by the pass since: its `moved` stands.
    expect(keyFactsOf({ key, since, moved: '2026-09-12T00:00:00.000Z', key_in: '2026-09-10T16:00:00.000Z' }, false, now, rolled)).toEqual({ own_key: true, shared_from: '2026-09-12T00:00:00.000Z', key_in: '2026-09-10T16:00:00.000Z' });
    // Pruned since it was noted: nothing holds the key any more.
    expect(keyFactsOf({ key, since, moved: '2026-09-12T00:00:00.000Z', key_in: '2026-09-10T16:00:00.000Z' }, false, now, [])).toEqual({ own_key: true, shared_from: '2026-09-12T00:00:00.000Z', key_in: null });
    // One taken before the key was made doesn't hold it.
    expect(keyFactsOf({ key, since, moved: since }, false, now, ['2026-08-01T16:00:00.000Z'])).toEqual({ own_key: true, shared_from: null, key_in: null });
    // Read too late: the newest at all.
    expect(keyFactsOf({ destroyed: '2026-10-17' }, true, now, rolled)).toEqual({ own_key: true, shared_from: now.toISOString(), key_in: '2026-09-10T16:00:00.000Z' });
    // The backups couldn't be listed: unchecked, and `moved` doesn't stand.
    expect(keyFactsOf({ key, since, moved: since }, false, now, null)).toEqual({ own_key: true, shared_from: now.toISOString(), key_in: 'unchecked' });
    expect(keyFactsOf({ destroyed: '2026-10-17' }, true, now, null)).toEqual({ own_key: true, shared_from: now.toISOString(), key_in: 'unchecked' });
    expect(keyFactsOf(null, false, now, null)).toEqual({ own_key: false, shared_from: now.toISOString(), key_in: null });
  });
});
