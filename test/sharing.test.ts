import { describe, expect, test, mock, beforeEach, afterEach } from 'bun:test';
import { clerk } from './clerk-mock';
import { FakeRedis, storageMock, TEST_CTX, registerTestContainer, unscopedDataKeys, testKey } from './fake-redis';

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
  clerk.signedIn = user;
  return fn();
};
const invite = async (from: string, body: object = {}) => {
  const res = await as(from, () => route('connections/invite', 'POST', body));
  expect(res.status).toBe(200);
  return res.body.url.split('/connect/')[1] as string;
};
const accept = (who: string, token: string, label = '') => as(who, () => route('connections/accept', 'POST', { token, label }));
/** Connects two people the only way there is: an invite link, accepted. */
const connect = async (a: string, b: string) => {
  const res = await accept(b, await invite(a));
  expect(res.status).toBe(200);
  return res.body.id as string;
};
const connectionsOf = async (who: string) => (await as(who, () => route('connections', 'GET'))).body;
let pair = '';
const share = (accounts: Record<string, string>, id = pair) => as('user_owner', () => route('connections', 'PUT', { id, accounts }));
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
  await as('user_third', () => route('shared', 'GET')); // and so does a third person
  pair = await connect('user_owner', 'user_partner');
});
afterEach(() => {
  process.env = { ...saved };
});

describe('finding people: nobody can', () => {
  test('with no connection, nobody else in the app is listed or named anywhere', async () => {
    const third = await connectionsOf('user_third');
    expect(third).toMatchObject({ enabled: true, connections: [], blocked: [] });
    expect(JSON.stringify(third)).not.toMatch(/user_(owner|partner)/);
  });

  test('a connection shows only what I call them, never their id or name from Clerk', async () => {
    const mine = await connectionsOf('user_partner');
    expect(mine.connections).toEqual([{ id: pair, label: 'Someone', sharing: {} }]);
    expect(JSON.stringify(mine)).not.toContain('user_owner');
    await share({ acct_joint: 'balance' });
    expect(JSON.stringify(await sharedWithPartner())).not.toContain('user_owner');
  });
});

describe('connecting by invite link', () => {
  test('each side names the other: the sender suggests a name, the one accepting can change it', async () => {
    const token = await invite('user_owner', { from_name: 'Olive', their_label: 'Pat' });
    const { describeInvite } = await import('@/lib/sharing');
    expect(await describeInvite('user_third', token)).toEqual({ from_name: 'Olive', own: false });
    expect(await describeInvite('user_owner', token)).toEqual({ from_name: 'Olive', own: true });
    expect((await accept('user_third', token, '')).status).toBe(200);
    const theirs = (await connectionsOf('user_third')).connections;
    expect(theirs.map((c: any) => c.label)).toEqual(['Olive']);
    const mine = (await connectionsOf('user_owner')).connections.map((c: any) => c.label).sort();
    expect(mine).toEqual(['Pat', 'Someone']);
    const id = theirs[0].id;
    expect((await as('user_third', () => route('connections', 'PUT', { id, label: '  Aunt   Olive ' }))).status).toBe(200);
    expect((await connectionsOf('user_third')).connections[0].label).toBe('Aunt Olive');
  });

  test('a link works once, and only until it expires', async () => {
    const token = await invite('user_owner');
    const stored = [...(fake as any).strings.keys()].find((k: string) => k.includes(':invites:'));
    expect(await fake.ttl(stored)).toBe(72 * 3600);
    expect(stored).not.toContain(token); // kept hashed
    expect((await accept('user_third', token)).status).toBe(200);
    const again = await accept('user_partner', token);
    expect(again.status).toBe(409);
    expect(again.body.error).toBe('This invite link can’t be used. Ask for a new one.');
    // Expired looks just the same: the key is simply gone.
    const token2 = await invite('user_partner');
    await fake.del(...[...(fake as any).strings.keys()].filter((k: string) => k.includes(':invites:')));
    expect((await accept('user_third', token2)).body.error).toBe(again.body.error);
    expect((await accept('user_third', 'not a token!')).body.error).toBe(again.body.error);
  });

  test('my own link does nothing, and stays usable for them', async () => {
    const token = await invite('user_owner');
    expect((await accept('user_owner', token)).status).toBe(409);
    expect((await accept('user_third', token)).status).toBe(200);
  });

  test('connecting twice is refused, and there is only ever one connection per pair', async () => {
    const res = await accept('user_owner', await invite('user_partner'));
    expect(res.status).toBe(409);
    expect((await connectionsOf('user_owner')).connections).toHaveLength(1);
  });

  test('a link from someone no longer in the app can’t be used', async () => {
    const token = await invite('user_third');
    process.env.CLERK_ALLOWED_USER_IDS = 'user_owner,user_partner';
    expect((await accept('user_partner', token)).status).toBe(409);
  });
});

describe('sharing accounts on a connection', () => {
  test('nothing is shared until chosen, and the choice lists only my own shareable accounts', async () => {
    expect(await sharedWithPartner()).toEqual([]);
    const settings = await connectionsOf('user_owner');
    expect(settings.accounts.map((a: any) => a.id).sort()).toEqual(['acct_joint', 'acct_mine', 'manual_house']);
    expect(settings.connections[0].sharing).toEqual({});
  });

  test('that it exists: the account and nothing about its money', async () => {
    await share({ acct_joint: 'exists' });
    const [from] = await sharedWithPartner();
    expect(from.accounts).toEqual([{ id: 'acct_joint', label: expect.stringContaining('1111'), level: 'exists', balance: null, as_of: null, debt: false }]);
  });

  test('balance only: the account and its balance, no transactions, and nothing else', async () => {
    expect((await share({ acct_joint: 'balance' })).status).toBe(200);
    const shared = await sharedWithPartner();
    expect(shared).toHaveLength(1);
    expect(shared[0]).toMatchObject({ connection: pair, label: 'Someone' });
    expect(shared[0].accounts).toEqual([
      { id: 'acct_joint', label: expect.stringContaining('1111'), level: 'balance', balance: 500, as_of: new Date().toISOString().slice(0, 10), debt: false },
    ]);
  });

  test('with transactions: the last 30 days of that account only', async () => {
    await share({ acct_joint: 'transactions', manual_house: 'balance' });
    const [from] = await sharedWithPartner();
    const joint = from.accounts.find((a: any) => a.id === 'acct_joint');
    expect(joint.transactions.map((t: any) => t.amount)).toEqual([12]); // not the 60-day-old one
    expect(JSON.stringify(from)).not.toContain('t_private');
    expect(JSON.stringify(from)).not.toContain('acct_mine');
    expect(from.accounts.find((a: any) => a.id === 'manual_house')).toMatchObject({ id: 'manual_house', label: 'Manual House', level: 'balance', balance: 300000, debt: false });
  });

  test('each connection gets its own choice', async () => {
    const other = await connect('user_owner', 'user_third');
    await share({ acct_joint: 'balance' });
    await share({ manual_house: 'exists' }, other);
    expect((await sharedWithPartner())[0].accounts.map((a: any) => a.id)).toEqual(['acct_joint']);
    const third = (await as('user_third', () => route('shared', 'GET'))).body.shared;
    expect(third[0].accounts.map((a: any) => a.id)).toEqual(['manual_house']);
  });

  test('revoking takes effect at once', async () => {
    await share({ acct_joint: 'transactions' });
    expect(await sharedWithPartner()).toHaveLength(1);
    await share({ acct_joint: 'none' });
    expect(await sharedWithPartner()).toEqual([]);
  });

  test('an account hidden after it was shared stops being shared', async () => {
    await share({ acct_joint: 'balance', acct_mine: 'balance' });
    await setAccountHidden(TEST_CTX, 'acct_mine', 'depository', true);
    const [from] = await sharedWithPartner();
    expect(from.accounts.map((a: any) => a.id)).toEqual(['acct_joint']);
  });

  test('a hidden account can’t be shared at all', async () => {
    await setAccountHidden(TEST_CTX, 'acct_mine', 'depository', true);
    expect((await share({ acct_mine: 'balance' })).status).toBe(409);
  });

  test('refuses: someone else’s account, someone else’s connection, a bad level', async () => {
    // The partner tries to share the owner's account: not theirs.
    expect((await as('user_partner', () => route('connections', 'PUT', { id: pair, accounts: { acct_joint: 'balance' } }))).status).toBe(409);
    // A third person tries to use the owner and partner's connection.
    expect((await as('user_third', () => route('connections', 'PUT', { id: pair, accounts: {} }))).status).toBe(409);
    expect((await as('user_third', () => route('connections', 'DELETE', { id: pair }))).status).toBe(409);
    expect((await share({ acct_joint: 'everything' })).status).toBe(409);
    expect(await sharedWithPartner()).toEqual([]);
  });

  test('sharing goes one way: what I share doesn’t show me theirs', async () => {
    await share({ acct_joint: 'balance' });
    expect((await as('user_owner', () => route('shared', 'GET'))).body.shared).toEqual([]);
  });

  // One bank erroring for weeks keeps the full snapshot from being written;
  // the partial record still measures the healthy accounts every day.
  test('each balance is the account’s newest measured one, with its own date', async () => {
    const { recordPartialAccounts } = await import('@/lib/history');
    // An older full snapshot too: the newest measurement must win, not the first.
    await fake.hset(ctxKey('history:accounts'), { [daysAgo(20)]: await encrypt(JSON.stringify({ acct_joint: 111 })) });
    await recordPartialAccounts(TEST_CTX, { acct_joint: 640 });
    await share({ acct_joint: 'balance' });
    const [from] = await sharedWithPartner();
    expect(from.accounts[0]).toMatchObject({ balance: 640, as_of: new Date().toISOString().slice(0, 10) });
  });

  test('one sharer’s unreadable data hides only theirs', async () => {
    await share({ acct_joint: 'balance' });
    // A third person shares a manual account with the partner too.
    const third = await connect('user_third', 'user_partner');
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
    expect((await as('user_third', () => route('connections', 'PUT', { id: third, accounts: { manual_car: 'balance' } }))).status).toBe(200);
    // The owner's data breaks.
    await fake.set(ctxKey('txns:item_a'), 'garbage');
    await share({ acct_joint: 'transactions' });
    const errors = console.error;
    console.error = () => {};
    try {
      const shared = await sharedWithPartner();
      expect(shared.map((s: any) => s.connection)).toEqual([third]);
      expect(shared[0].accounts[0]).toMatchObject({ id: 'manual_car', balance: 9000, debt: true });
    } finally {
      console.error = errors;
    }
  });

  test('someone taken off the allowlist stops being shown what they shared', async () => {
    await share({ acct_joint: 'balance' });
    process.env.CLERK_ALLOWED_USER_IDS = 'user_partner';
    expect(await sharedWithPartner()).toEqual([]);
  });

  test('with the shared password there is nobody to connect with', async () => {
    delete process.env.CLERK_SECRET_KEY;
    expect((await route('connections', 'GET')).body).toEqual({ enabled: false });
    expect((await route('shared', 'GET')).body).toEqual({ shared: [] });
    expect((await route('connections', 'PUT', { id: pair, accounts: {} })).status).toBe(400);
    expect((await route('connections/invite', 'POST', {})).status).toBe(400);
  });
});

describe('ending a connection', () => {
  const connectionFields = async () => Object.keys((await fake.hgetall(testKey('connections'))) ?? {});

  test('either side removes it, and every share both ways ends in one write', async () => {
    await share({ acct_joint: 'balance' });
    const back = await as('user_partner', () => route('connections', 'PUT', { id: pair, accounts: {} }));
    expect(back.status).toBe(200);
    expect((await as('user_partner', () => route('connections', 'DELETE', { id: pair }))).status).toBe(200);
    expect(await sharedWithPartner()).toEqual([]);
    expect((await connectionsOf('user_owner')).connections).toEqual([]);
    expect(await connectionFields()).toEqual([]);
    // And they can connect again with a new link.
    await connect('user_partner', 'user_owner');
  });

  test('blocking: gone for both, and no link between them connects them again', async () => {
    await share({ acct_joint: 'balance' });
    expect((await as('user_partner', () => route('connections', 'DELETE', { id: pair, block: true }))).status).toBe(200);
    expect(await sharedWithPartner()).toEqual([]);
    // The one blocked sees it simply gone, the same as a removal.
    expect(await connectionsOf('user_owner')).toMatchObject({ connections: [], blocked: [] });
    expect((await connectionsOf('user_partner')).blocked).toEqual([{ id: pair, label: 'Someone' }]);
    // A new link either way can't be used, with the same words as a dead link.
    const either = [await accept('user_partner', await invite('user_owner')), await accept('user_owner', await invite('user_partner'))];
    for (const res of either) {
      expect(res.status).toBe(409);
      expect(res.body.error).toBe('This invite link can’t be used. Ask for a new one.');
    }
    // Only the one who blocked can lift it; then a new link works.
    expect((await as('user_owner', () => route('connections', 'DELETE', { id: pair }))).status).toBe(409);
    expect((await as('user_partner', () => route('connections', 'DELETE', { id: pair }))).status).toBe(200);
    await connect('user_owner', 'user_partner');
  });

  test('a block that stops part way has already ended the sharing', async () => {
    await share({ acct_joint: 'balance' });
    fake.failNext('hdel');
    const errors = console.error;
    console.error = () => {};
    try {
      expect((await as('user_partner', () => route('connections', 'DELETE', { id: pair, block: true }))).status).toBe(500);
    } finally {
      console.error = errors;
    }
    expect(await sharedWithPartner()).toEqual([]);
    expect((await as('user_owner', () => route('shared', 'GET'))).body.shared).toEqual([]);
  });

  test('every connection someone is in can be dropped at once (their account is going away)', async () => {
    const { dropConnectionsOf } = await import('@/lib/sharing');
    await connect('user_third', 'user_partner');
    await connect('user_third', 'user_owner');
    await share({ acct_joint: 'balance' });
    await dropConnectionsOf('user_partner');
    expect(await sharedWithPartner()).toEqual([]);
    expect((await connectionsOf('user_owner')).connections.map((c: any) => c.label)).toEqual(['Someone']);
    expect((await connectionsOf('user_third')).connections).toHaveLength(1);
  });
});
