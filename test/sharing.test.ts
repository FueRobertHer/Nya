import { describe, expect, test, mock, beforeEach, afterEach } from 'bun:test';
import { FakeRedis, storageMock, TEST_CTX, registerTestContainer, unscopedDataKeys } from './fake-redis';

process.env.PLAID_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');

const DAY = 86_400_000;
const daysAgo = (n: number) => new Date(Date.now() - n * DAY).toISOString().slice(0, 10);

// Plaid, as it would answer each Item's sync.
const plaidTxns: Record<string, any[]> = {};
const plaidAccounts: Record<string, any[]> = {};
mock.module('@/lib/plaid', () => ({
  plaidClient: {
    transactionsSync: async (req: any) => ({
      data: {
        added: req.cursor ? [] : plaidTxns[req.access_token] ?? [],
        modified: [],
        removed: [],
        accounts: plaidAccounts[req.access_token] ?? [],
        next_cursor: 'c1',
        has_more: false,
        transactions_update_status: 'HISTORICAL_UPDATE_COMPLETE',
      },
    }),
  },
}));

// Clerk: who is signed in, and their names.
let signedIn: string | null = null;
mock.module('@clerk/nextjs/server', () => ({
  auth: async () => ({ userId: signedIn }),
  clerkMiddleware: (handler: any) => (req: any, event: any) => handler(async () => ({ userId: signedIn }), req, event),
}));
// Names, mocked at our own module: another file's mock of Clerk may be the
// one loaded, and its shape is not this file's to rely on.
mock.module('@/lib/people', () => ({
  displayNames: async (ids: string[]) =>
    Object.fromEntries(ids.map((id) => [id, ({ user_owner: 'Olive Owner', user_partner: 'Pat' } as Record<string, string>)[id] ?? 'Someone'])),
}));

const fake = new FakeRedis();
afterEach(() => expect(unscopedDataKeys(fake)).toEqual([]));
mock.module('@/lib/storage', () => storageMock(fake));

const { encrypt } = await import('@/lib/crypto');
const { rememberAccounts } = await import('@/lib/last-known');
const links = await import('@/lib/links');
const { saveManualAccount } = await import('@/lib/manual');
const { setAccountHidden } = await import('@/lib/hidden');
const { recordSnapshot } = await import('@/lib/history');
const { ctxKey } = await import('./fake-redis');

const account = (id: string, mask: string) => ({
  account_id: id,
  name: 'Checking',
  official_name: null,
  type: 'depository',
  subtype: 'checking',
  mask,
  balances: { available: 100, current: 100, limit: null, iso_currency_code: 'USD' },
});
const row = (id: string, account_id: string, date: string, amount = 4.5) => ({
  transaction_id: id,
  account_id,
  amount,
  iso_currency_code: 'USD',
  date,
  name: 'BLUE BOTTLE',
  merchant_name: 'Blue Bottle',
  pending: false,
  counterparties: [],
  personal_finance_category: { primary: 'FOOD_AND_DRINK', detailed: 'FOOD_AND_DRINK_COFFEE' },
});

/** The owner's bank, with two accounts: a joint checking and a personal card. */
async function ownerBank() {
  const token = 'token-item_a';
  plaidAccounts[token] = [account('acct_joint', '1111'), account('acct_mine', '2222')];
  plaidTxns[token] = [
    row('t_recent', 'acct_joint', daysAgo(3), 12),
    row('t_old', 'acct_joint', daysAgo(60), 99),
    row('t_private', 'acct_mine', daysAgo(2), 7),
  ];
  await fake.hset(ctxKey('plaid:items'), {
    item_a: JSON.stringify({ item_id: 'item_a', institution_name: 'Chase', encrypted_access_token: await encrypt(token) }),
  });
  const inst = {
    item_id: 'item_a',
    institution_name: 'Chase',
    institution_id: 'ins_3',
    error: null,
    accounts: [
      { ...account('acct_joint', '1111'), balance: 500 },
      { ...account('acct_mine', '2222'), balance: 70 },
    ],
  };
  await rememberAccounts(TEST_CTX, [inst as any]);
  await links.recordDirectory(TEST_CTX, [inst as any]);
  await recordSnapshot(TEST_CTX, 570, { acct_joint: 500, acct_mine: 70 });
  await saveManualAccount(TEST_CTX, {
    account_id: 'manual_house',
    name: 'House',
    institution_name: 'Manual',
    type: 'other',
    subtype: null,
    balance: 300000,
    updated_at: new Date().toISOString(),
  } as any);
}

const route = async (path: string, method: string, body?: unknown) => {
  const mod: any = await import(`@/app/api/${path}/route`);
  const res = await mod[method](new Request(`http://x/api/${path}${method === 'GET' ? '?refresh=1' : ''}`, { method, body: body ? JSON.stringify(body) : undefined }));
  return { status: res.status, body: await res.json() };
};
const as = async <T>(user: string, fn: () => Promise<T>) => {
  signedIn = user;
  return fn();
};
const share = (to: string, accounts: Record<string, string>) => as('user_owner', () => route('sharing', 'PUT', { to, accounts }));
const sharedWithPartner = async () => (await as('user_partner', () => route('shared', 'GET'))).body.shared;

const saved = { ...process.env };
beforeEach(async () => {
  fake.reset();
  (await import('@/lib/sessions')).forgetEpochs();
  await registerTestContainer(fake);
  process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY = 'pk_test_x';
  process.env.CLERK_SECRET_KEY = 'sk_test_x';
  process.env.CLERK_ALLOWED_USER_IDS = 'user_owner,user_partner,user_third';
  await ownerBank();
  await as('user_owner', () => route('transactions', 'GET')); // the owner claims the data; rows stored
  await as('user_partner', () => route('shared', 'GET')); // the partner gets a container
});
afterEach(() => {
  process.env = { ...saved };
});

describe('sharing accounts with someone', () => {
  test('nothing is shared until chosen, and the choice lists only my own shareable accounts', async () => {
    expect(await sharedWithPartner()).toEqual([]);
    const settings = (await as('user_owner', () => route('sharing', 'GET'))).body;
    expect(settings.enabled).toBe(true);
    expect(settings.people).toEqual([{ id: 'user_partner', name: 'Pat' }]);
    expect(settings.accounts.map((a: any) => a.id).sort()).toEqual(['acct_joint', 'acct_mine', 'manual_house']);
    expect(settings.sharing).toEqual({});
  });

  test('balance only: the account and its balance, no transactions, and nothing else', async () => {
    expect((await share('user_partner', { acct_joint: 'balance' })).status).toBe(200);
    const shared = await sharedWithPartner();
    expect(shared).toHaveLength(1);
    expect(shared[0]).toMatchObject({ from: 'user_owner', name: 'Olive Owner' });
    expect(shared[0].accounts).toEqual([
      { id: 'acct_joint', label: expect.stringContaining('1111'), level: 'balance', balance: 500, as_of: new Date().toISOString().slice(0, 10), debt: false },
    ]);
  });

  test('with transactions: the last 30 days of that account only', async () => {
    await share('user_partner', { acct_joint: 'transactions', manual_house: 'balance' });
    const [from] = await sharedWithPartner();
    const joint = from.accounts.find((a: any) => a.id === 'acct_joint');
    expect(joint.transactions.map((t: any) => t.amount)).toEqual([12]); // not the 60-day-old one
    expect(JSON.stringify(from)).not.toContain('t_private');
    expect(JSON.stringify(from)).not.toContain('acct_mine');
    expect(from.accounts.find((a: any) => a.id === 'manual_house')).toMatchObject({ id: 'manual_house', label: 'Manual House', level: 'balance', balance: 300000, debt: false });
  });

  test('revoking takes effect at once', async () => {
    await share('user_partner', { acct_joint: 'transactions' });
    expect(await sharedWithPartner()).toHaveLength(1);
    await share('user_partner', { acct_joint: 'none' });
    expect(await sharedWithPartner()).toEqual([]);
  });

  test('an account hidden after it was shared stops being shared', async () => {
    await share('user_partner', { acct_joint: 'balance', acct_mine: 'balance' });
    await setAccountHidden(TEST_CTX, 'acct_mine', 'depository', true);
    const [from] = await sharedWithPartner();
    expect(from.accounts.map((a: any) => a.id)).toEqual(['acct_joint']);
  });

  test('a hidden account can’t be shared at all', async () => {
    await setAccountHidden(TEST_CTX, 'acct_mine', 'depository', true);
    expect((await share('user_partner', { acct_mine: 'balance' })).status).toBe(409);
  });

  test('refuses: someone else’s account, sharing with yourself, a stranger, a bad level', async () => {
    // The partner tries to share the owner's account: not theirs.
    expect((await as('user_partner', () => route('sharing', 'PUT', { to: 'user_owner', accounts: { acct_joint: 'balance' } }))).status).toBe(409);
    expect((await share('user_owner', { acct_joint: 'balance' })).status).toBe(409);
    expect((await share('user_stranger', { acct_joint: 'balance' })).status).toBe(409);
    expect((await share('user_partner', { acct_joint: 'everything' })).status).toBe(409);
    expect(await sharedWithPartner()).toEqual([]);
  });

  test('sharing goes one way: what I share doesn’t show me theirs', async () => {
    await share('user_partner', { acct_joint: 'balance' });
    expect((await as('user_owner', () => route('shared', 'GET'))).body.shared).toEqual([]);
  });

  test('with the shared password there is nobody to share with', async () => {
    delete process.env.CLERK_SECRET_KEY;
    expect((await route('sharing', 'GET')).body).toEqual({ enabled: false });
    expect((await route('shared', 'GET')).body).toEqual({ shared: [] });
    expect((await route('sharing', 'PUT', { to: 'user_partner', accounts: {} })).status).toBe(400);
  });

  test('every grant to or from someone can be dropped at once', async () => {
    const { dropGrantsOf, outgoing } = await import('@/lib/sharing');
    await share('user_partner', { acct_joint: 'balance' });
    await dropGrantsOf('user_partner');
    expect(await outgoing('user_owner')).toEqual({});
    expect(await sharedWithPartner()).toEqual([]);
  });

  // One bank erroring for weeks keeps the full snapshot from being written;
  // the partial record still measures the healthy accounts every day.
  test('each balance is the account’s newest measured one, with its own date', async () => {
    const { recordPartialAccounts } = await import('@/lib/history');
    // An older full snapshot too: the newest measurement must win, not the first.
    await fake.hset(ctxKey('history:accounts'), { [daysAgo(20)]: await encrypt(JSON.stringify({ acct_joint: 111 })) });
    await recordPartialAccounts(TEST_CTX, { acct_joint: 640 });
    await share('user_partner', { acct_joint: 'balance' });
    const [from] = await sharedWithPartner();
    expect(from.accounts[0]).toMatchObject({ balance: 640, as_of: new Date().toISOString().slice(0, 10) });
  });

  test('one sharer’s unreadable data hides only theirs', async () => {
    await share('user_partner', { acct_joint: 'balance' });
    // A third person shares a manual account with the partner too.
    await as('user_third', () => route('shared', 'GET'));
    const { ownerContainer } = await import('@/lib/owners');
    const thirdCtx = { container: await ownerContainer('user_third') };
    await saveManualAccount(thirdCtx as any, {
      account_id: 'manual_car',
      name: 'Car',
      institution_name: 'Manual',
      type: 'loan',
      subtype: null,
      balance: 9000,
      updated_at: new Date().toISOString(),
    } as any);
    expect((await as('user_third', () => route('sharing', 'PUT', { to: 'user_partner', accounts: { manual_car: 'balance' } }))).status).toBe(200);
    // The owner's data breaks.
    await fake.set(ctxKey('txns:item_a'), 'garbage');
    await share('user_partner', { acct_joint: 'transactions' });
    const errors = console.error;
    console.error = () => {};
    try {
      const shared = await sharedWithPartner();
      expect(shared.map((s: any) => s.from)).toEqual(['user_third']);
      expect(shared[0].accounts[0]).toMatchObject({ id: 'manual_car', balance: 9000, debt: true });
    } finally {
      console.error = errors;
    }
  });

  test('someone taken off the allowlist is no longer offered, and what they shared stops', async () => {
    await as('user_partner', () => route('sharing', 'PUT', { to: 'user_owner', accounts: {} }));
    await share('user_partner', { acct_joint: 'balance' });
    process.env.CLERK_ALLOWED_USER_IDS = 'user_partner';
    const { people, sharedWithMe } = await import('@/lib/sharing');
    expect(await people('user_partner')).toEqual([]);
    expect(await sharedWithMe('user_partner')).toEqual([]);
  });
});
