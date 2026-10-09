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
const { slotOf, accessLogStore, pruneAccessLog } = await import('@/lib/access-log');

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
/** Shares with an end; with `accounts` null, changes only the end (a renewal). */
const shareUntil = (accounts: Record<string, string> | null, expires_at: unknown, id = pair) =>
  as('user_owner', () => route('connections', 'PUT', { id, ...(accounts ? { accounts } : {}), expires_at }));
/** An end `days` from now, an instant as the drawer sends it. */
const endIn = (days: number) => new Date(Date.now() + days * DAY).toISOString();
/** "What they see", as `who` asks for it. */
const previewOf = async (who: string, id = pair) => {
  const { GET } = await import('@/app/api/connections/preview/route');
  clerk.signedIn = who;
  const res = await GET(new Request(`http://x/api/connections/preview?id=${encodeURIComponent(id)}`));
  return { status: res.status, body: await res.json() };
};
/** A connection's log id: what both people's records of showings on it are
 *  kept under. Null before the first record, or once the connection is gone. */
const logIdOf = async (id = pair): Promise<string | null> => {
  const raw = await fake.hget<string>(testKey('connections'), `${id}|log`);
  return raw ? JSON.parse(raw).id : null;
};
/** The owner's record of showings on a connection, as stored. */
const ownerRecord = async (id = pair) => {
  const logId = await logIdOf(id);
  return logId ? accessLogStore.get(TEST_CTX, logId) : null;
};
/** Someone's container, as the owners map has it. */
const containerOf = async (who: string) => ({ container: await (await import('@/lib/owners')).ownerContainer(who) }) as any;
/** console.error, quietly, with what it was given. */
async function quietly<R>(fn: () => Promise<R>): Promise<{ result: R; logged: unknown[][] }> {
  const logged: unknown[][] = [];
  const errors = console.error;
  console.error = (...args: unknown[]) => void logged.push(args);
  try {
    return { result: await fn(), logged };
  } finally {
    console.error = errors;
  }
}

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
    const [conn] = mine.connections;
    expect(mine.connections).toEqual([
      {
        id: pair,
        label: 'Someone',
        introduced_as: null,
        since: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
        sharing: {},
        expires_at: null,
        // Its records of showings: a random id, begun when they connected, empty so far.
        record_id: expect.stringMatching(/^[0-9a-f]{32}$/),
        record_since: conn.since,
        shown_to_them: [],
        shown_to_me: [],
      },
    ]);
    expect(mine.damaged_records).toEqual([]);
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

  test('each sees how the other introduced themselves, and when they connected', async () => {
    const token = await invite('user_owner', { from_name: 'Olive' });
    expect((await as('user_third', () => route('connections/accept', 'POST', { token, label: 'Mom', my_name: 'Rob' }))).status).toBe(200);
    const theirs = (await connectionsOf('user_third')).connections[0];
    expect(theirs).toMatchObject({ label: 'Mom', introduced_as: 'Olive', since: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/) });
    // I left what I call them empty: their own introduction stands in.
    const mine = (await connectionsOf('user_owner')).connections.find((c: any) => c.id === theirs.id);
    expect(mine).toMatchObject({ label: 'Rob', introduced_as: 'Rob' });
  });

  test('a name that looks like data is kept as typed', async () => {
    for (const label of ['{"a":1}', '42', 'true', 'null']) {
      expect((await as('user_partner', () => route('connections', 'PUT', { id: pair, label }))).status).toBe(200);
      expect((await connectionsOf('user_partner')).connections[0].label).toBe(label);
    }
    // Typed when accepting, too.
    expect((await accept('user_third', await invite('user_owner'), '{"a":1}')).status).toBe(200);
    expect((await connectionsOf('user_third')).connections[0].label).toBe('{"a":1}');
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

  test('connecting twice is refused without using up the link, and there is only ever one connection per pair', async () => {
    const token = await invite('user_partner');
    expect((await accept('user_owner', token)).status).toBe(409);
    expect((await connectionsOf('user_owner')).connections).toHaveLength(1);
    expect((await accept('user_third', token)).status).toBe(200);
  });

  test('a new connection shares nothing, whatever an earlier one between the two left behind', async () => {
    // A save that landed just after a removal leaves a share with no connection.
    await share({ acct_joint: 'balance' });
    const { hgetall, hset } = { hgetall: fake.hgetall.bind(fake), hset: fake.hset.bind(fake) };
    const left = Object.entries((await hgetall<Record<string, string>>(testKey('connections')))!).filter(([f]) => f.includes('|share|'));
    await as('user_owner', () => route('connections', 'DELETE', { id: pair }));
    await hset(testKey('connections'), Object.fromEntries(left));
    expect(await sharedWithPartner()).toEqual([]);
    await connect('user_partner', 'user_owner');
    expect(await sharedWithPartner()).toEqual([]);
    expect((await connectionsOf('user_owner')).connections[0].sharing).toEqual({});
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
    // By institution, then name, each with its parts for the grouped list.
    expect(settings.accounts.map((a: any) => [a.institution, a.name, a.label])).toEqual([
      ['Chase', 'Checking ••1111', 'Chase Checking ••1111'],
      ['Chase', 'Checking ••2222', 'Chase Checking ••2222'],
      ['Manual', 'House', 'Manual House'],
    ]);
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

  test('an account hidden after it was shared is paused: a save meanwhile keeps it, unhiding resumes it', async () => {
    await share({ acct_joint: 'balance', acct_mine: 'balance' });
    await setAccountHidden(TEST_CTX, 'acct_mine', 'depository', true);
    const [from] = await sharedWithPartner();
    expect(from.accounts.map((a: any) => a.id)).toEqual(['acct_joint']);
    // The settings don't offer a hidden account, so a save leaves it out.
    const settings = await connectionsOf('user_owner');
    expect(settings.accounts.map((a: any) => a.id)).not.toContain('acct_mine');
    expect((await share({ acct_joint: 'transactions' })).status).toBe(200);
    await setAccountHidden(TEST_CTX, 'acct_mine', 'depository', false);
    const [after] = await sharedWithPartner();
    expect(after.accounts.map((a: any) => [a.id, a.level]).sort()).toEqual([['acct_joint', 'transactions'], ['acct_mine', 'balance']]);
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
    // A new link either way can't be used, with the same words as a dead link,
    // and isn't used up: to its sender it looks like one nobody answered.
    const { describeInvite } = await import('@/lib/sharing');
    for (const [from, to] of [['user_owner', 'user_partner'], ['user_partner', 'user_owner']]) {
      const token = await invite(from);
      const res = await accept(to, token);
      expect(res.status).toBe(409);
      expect(res.body.error).toBe('This invite link can’t be used. Ask for a new one.');
      expect(await describeInvite(from, token)).toMatchObject({ own: true });
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

  test('removing or blocking still ends everything both ways at once: shares with ends, previews, and both records of showings', async () => {
    const partnerCtx = await containerOf('user_partner');
    await saveManualAccount(partnerCtx, {
      account_id: 'manual_bike',
      name: 'Bike',
      institution_name: 'Manual',
      type: 'other',
      subtype: null,
      balance: 800,
      updated_at: new Date().toISOString(),
    } as any);
    for (const [who, block] of [['user_owner', false], ['user_partner', true]] as const) {
      // Each shares with the other, with an end, and each is shown the other's once.
      expect((await shareUntil({ acct_joint: 'balance' }, endIn(5))).status).toBe(200);
      const back = await as('user_partner', () => route('connections', 'PUT', { id: pair, accounts: { manual_bike: 'balance' }, expires_at: endIn(5) }));
      expect(back.status).toBe(200);
      expect(await sharedWithPartner()).toHaveLength(1);
      expect((await as('user_owner', () => route('shared', 'GET'))).body.shared).toHaveLength(1);
      const logId = (await logIdOf())!;
      expect([await accessLogStore.get(TEST_CTX, logId), await accessLogStore.get(partnerCtx, logId)].every((r) => r?.shown.length === 1)).toBe(true);

      expect((await as(who, () => route('connections', 'DELETE', { id: pair, block }))).status).toBe(200);
      // Nothing of either share is left: a block keeps only its record and the blocker's name for them.
      const left = await connectionFields();
      expect(left.filter((f) => f.includes('|share|') || f.endsWith('|log'))).toEqual([]);
      expect(await sharedWithPartner()).toEqual([]);
      expect((await as('user_owner', () => route('shared', 'GET'))).body.shared).toEqual([]);
      expect((await previewOf('user_owner')).status).toBe(409);
      expect((await previewOf('user_partner')).status).toBe(409);
      // Both records went with it, from both containers.
      expect([await accessLogStore.get(TEST_CTX, logId), await accessLogStore.get(partnerCtx, logId)]).toEqual([null, null]);
      if (block) break;
      pair = await connect('user_owner', 'user_partner');
      // Connected again: new records, under a new id.
      expect(await logIdOf()).not.toBe(logId);
    }
  });

  test('an account deleted takes both records of showings on its connections with it', async () => {
    const { dropConnectionsOf } = await import('@/lib/sharing');
    const partnerCtx = await containerOf('user_partner');
    await share({ acct_joint: 'balance' });
    await sharedWithPartner();
    const logId = (await logIdOf())!;
    await accessLogStore.set(partnerCtx, logId, { shown: [{ at: slotOf(Date.now()), times: 1, read: { manual_bike: 'balance' } }] });
    await dropConnectionsOf('user_partner');
    expect([await accessLogStore.get(TEST_CTX, logId), await accessLogStore.get(partnerCtx, logId)]).toEqual([null, null]);
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

describe('what they see: the preview', () => {
  /** What the partner is shown of the owner's, as the projection, without
   *  the partner's own name for the owner. */
  const partnerView = async () => {
    const shared = await sharedWithPartner();
    expect(shared.length).toBeLessThanOrEqual(1);
    if (shared.length === 0) return null;
    const { connection, label, ...view } = shared[0];
    expect(connection).toBe(pair);
    return view;
  };

  test('is exactly what they are shown, at every level, as-of dates and all', async () => {
    await share({ acct_joint: 'transactions', acct_mine: 'balance', manual_house: 'exists' });
    const res = await previewOf('user_owner');
    expect(res.status).toBe(200);
    const view = await partnerView();
    expect(res.body).toEqual({ connection: pair, view });
    expect(view!.accounts.map((a: any) => a.level).sort()).toEqual(['balance', 'exists', 'transactions']);
    const joint = view!.accounts.find((a: any) => a.id === 'acct_joint');
    expect(joint).toMatchObject({ balance: 500, as_of: new Date().toISOString().slice(0, 10) });
    expect(joint.transactions.map((t: any) => t.amount)).toEqual([12]);
    expect(view!.expires_at).toBeNull();
  });

  test('without what they call me, which is theirs, or anyone’s id', async () => {
    await share({ acct_joint: 'balance' });
    expect((await as('user_partner', () => route('connections', 'PUT', { id: pair, label: 'THEIR-NAME-FOR-ME' }))).status).toBe(200);
    expect((await sharedWithPartner())[0].label).toBe('THEIR-NAME-FOR-ME');
    const text = JSON.stringify((await previewOf('user_owner')).body);
    expect(text).not.toContain('THEIR-NAME-FOR-ME');
    expect(text).not.toMatch(/user_/);
  });

  test('leaves out what they are not shown: a hidden account, and everything once nothing is shared', async () => {
    await share({ acct_joint: 'balance', acct_mine: 'transactions' });
    await setAccountHidden(TEST_CTX, 'acct_mine', 'depository', true);
    const view = await partnerView();
    expect(view!.accounts.map((a: any) => a.id)).toEqual(['acct_joint']);
    expect((await previewOf('user_owner')).body.view).toEqual(view);
    await share({ acct_joint: 'none' });
    expect(await partnerView()).toBeNull();
    expect((await previewOf('user_owner')).body).toEqual({ connection: pair, view: null });
  });

  test('says the same as their read at any moment, before and after an end', async () => {
    const { sharedWithMe, previewShare } = await import('@/lib/sharing');
    const end = endIn(3);
    expect((await shareUntil({ acct_joint: 'transactions', manual_house: 'exists' }, end)).status).toBe(200);
    const at = Date.parse(end);
    for (const now of [Date.now(), at - 1, at, at + 1, at + 40 * DAY]) {
      const theirs = (await sharedWithMe('user_partner', now)).find((s) => s.connection === pair) ?? null;
      const mine = await previewShare('user_owner', pair, now);
      expect(mine.view).toEqual(theirs && { accounts: theirs.accounts, expires_at: theirs.expires_at });
      expect(mine.view === null).toBe(now >= at);
    }
  });

  test('for each connection, its own', async () => {
    const other = await connect('user_owner', 'user_third');
    await share({ acct_joint: 'balance' });
    await share({ manual_house: 'exists' }, other);
    const third = (await as('user_third', () => route('shared', 'GET'))).body.shared[0];
    expect((await previewOf('user_owner', other)).body.view).toEqual({ accounts: third.accounts, expires_at: null });
    expect((await previewOf('user_owner')).body.view.accounts.map((a: any) => a.id)).toEqual(['acct_joint']);
  });

  test('records nothing: my own preview is no showing to them', async () => {
    await share({ acct_joint: 'balance' });
    for (let i = 0; i < 3; i++) expect((await previewOf('user_owner')).status).toBe(200);
    expect(await ownerRecord()).toBeNull();
    expect(await fake.hgetall(ctxKey('sharing-access-log'))).toBeNull();
  });

  test('only of my own connection, and only while it is one', async () => {
    await share({ acct_joint: 'balance' });
    expect((await previewOf('user_third')).status).toBe(409);
    expect((await previewOf('user_owner', 'not-an-id')).status).toBe(400);
    expect((await previewOf('user_owner', 'a'.repeat(24))).status).toBe(409);
    expect((await as('user_partner', () => route('connections', 'DELETE', { id: pair, block: true }))).status).toBe(200);
    expect((await previewOf('user_owner')).status).toBe(409);
    expect((await previewOf('user_partner')).status).toBe(409);
  });

  test('when my shared data can’t be read they see nothing, and the preview says why', async () => {
    await share({ acct_joint: 'transactions' });
    await fake.set(ctxKey('txns:item_a'), 'garbage');
    const { result: theirs } = await quietly(() => sharedWithPartner());
    expect(theirs).toEqual([]);
    const { result: mine } = await quietly(() => previewOf('user_owner'));
    expect(mine).toEqual({ status: 200, body: { connection: pair, view: null, unreadable: true } });
  });

  test('when storage can’t be reached it says it couldn’t show it, never that they see nothing', async () => {
    await share({ acct_joint: 'transactions' });
    fake.failNext('get', 20); // the transaction store's read, among others
    const { result } = await quietly(() => previewOf('user_owner'));
    expect(result.status).toBe(500);
    expect(result.body).toEqual({ error: 'Could not show what they see' });
  });

  test('changes nothing in my container, old-shaped records included', async () => {
    await share({ acct_joint: 'balance' });
    await fake.hset(ctxKey('accounts:meta'), { acct_legacy: await encrypt(JSON.stringify({ account_id: 'acct_legacy', type: 'depository' })) });
    const before = await fake.hgetall<Record<string, string>>(ctxKey('accounts:meta'));
    expect((await previewOf('user_owner')).status).toBe(200);
    expect(await fake.hgetall<Record<string, string>>(ctxKey('accounts:meta'))).toEqual(before);
  });
});

describe('shares that end', () => {
  const stored = async () => JSON.parse((await fake.hgetall<Record<string, string>>(testKey('connections')))![`${pair}|share|user_owner`] as any);

  test('both sides see when: they, on what they are shown, and I, on the connection', async () => {
    const end = endIn(10);
    expect((await shareUntil({ acct_joint: 'balance' }, end)).status).toBe(200);
    expect((await sharedWithPartner())[0]).toMatchObject({ connection: pair, expires_at: end });
    expect((await connectionsOf('user_owner')).connections[0]).toMatchObject({ sharing: { acct_joint: 'balance' }, expires_at: end });
  });

  test('ends at its instant with nothing to do: shown just before, not at it, not after', async () => {
    const { sharedWithMe } = await import('@/lib/sharing');
    const end = endIn(2);
    await shareUntil({ acct_joint: 'transactions' }, end);
    const at = Date.parse(end);
    expect((await sharedWithMe('user_partner', at - 1)).map((s) => s.connection)).toEqual([pair]);
    expect(await sharedWithMe('user_partner', at)).toEqual([]);
    expect(await sharedWithMe('user_partner', at + 1)).toEqual([]);
    expect(await sharedWithMe('user_partner', at + 400 * DAY)).toEqual([]);
  });

  test('once ended, nothing of it is served, errors included, and nothing is read or recorded', async () => {
    await share({ acct_joint: 'transactions', manual_house: 'balance' });
    // Ended a minute ago, and its owner's transactions damaged: reading them would fail.
    const ended = new Date(Date.now() - 60_000).toISOString();
    await fake.hset(testKey('connections'), {
      [`${pair}|share|user_owner`]: JSON.stringify({ expiring: { acct_joint: 'transactions', manual_house: 'balance' }, expires_at: ended, updated_at: ended }),
    });
    await fake.set(ctxKey('txns:item_a'), 'garbage');
    const { result, logged } = await quietly(() => as('user_partner', () => route('shared', 'GET')));
    expect(result).toEqual({ status: 200, body: { shared: [] } });
    expect(logged).toEqual([]); // never read, so never failed
    expect(await ownerRecord()).toBeNull();
  });

  test('ending deletes nothing: the share stays as it was, and renewing brings it back', async () => {
    const { sharedWithMe } = await import('@/lib/sharing');
    const end = endIn(1);
    await shareUntil({ acct_joint: 'balance', manual_house: 'exists' }, end);
    await sharedWithMe('user_partner'); // one showing, recorded
    const after = Date.parse(end) + DAY;
    expect(await sharedWithMe('user_partner', after)).toEqual([]);
    // Still all there: the share, the connection, the record of the showing.
    expect((await connectionsOf('user_owner')).connections[0]).toMatchObject({ sharing: { acct_joint: 'balance', manual_house: 'exists' }, expires_at: end });
    expect((await ownerRecord())?.shown).toHaveLength(1);
    // Renewing changes only the end.
    const later = endIn(30);
    expect((await shareUntil(null, later)).status).toBe(200);
    const [back] = await sharedWithMe('user_partner', after);
    expect(back.accounts.map((a) => [a.id, a.level])).toEqual([
      ['acct_joint', 'balance'],
      ['manual_house', 'exists'],
    ]);
    expect(back.expires_at).toBe(later);
  });

  test('an end outlives a change of accounts, and null takes it away', async () => {
    const end = endIn(5);
    await shareUntil({ acct_joint: 'balance' }, end);
    expect((await share({ acct_joint: 'transactions' })).status).toBe(200);
    expect((await connectionsOf('user_owner')).connections[0]).toMatchObject({ sharing: { acct_joint: 'transactions' }, expires_at: end });
    expect((await shareUntil(null, null)).status).toBe(200);
    expect((await connectionsOf('user_owner')).connections[0]).toMatchObject({ sharing: { acct_joint: 'transactions' }, expires_at: null });
    expect((await sharedWithPartner())[0].expires_at).toBeNull();
    // Sharing nothing drops the end with the share.
    await shareUntil({ acct_joint: 'none' }, endIn(5));
    expect((await connectionsOf('user_owner')).connections[0]).toMatchObject({ sharing: {}, expires_at: null });
  });

  test('refuses an end that has passed, is more than two years away, or isn’t a time, and changes nothing', async () => {
    const { SHARE_END_MAX_DAYS } = await import('@/lib/share-rules');
    await shareUntil({ acct_joint: 'balance' }, endIn(5));
    const before = await stored();
    for (const bad of [
      new Date(Date.now() - 1000).toISOString(),
      endIn(SHARE_END_MAX_DAYS + 1),
      '2027-02-30T00:00:00.000Z', // no such day
      '2027-01-01',
      '2027-01-01T00:00:00Z', // not as the drawer writes it
      'next tuesday',
    ]) {
      const res = await shareUntil({ acct_joint: 'transactions' }, bad);
      expect([bad, res.status]).toEqual([bad, 409]);
      expect(await stored()).toEqual(before);
    }
    for (const wrong of [12345, {}, ['2027-01-01T00:00:00.000Z'], 'x'.repeat(41)]) {
      expect((await shareUntil({ acct_joint: 'transactions' }, wrong)).status).toBe(400);
    }
    expect(await stored()).toEqual(before);
    expect((await shareUntil(null, endIn(SHARE_END_MAX_DAYS - 1))).status).toBe(200);
  });

  test('renewing needs something shared', async () => {
    const res = await shareUntil(null, endIn(5));
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('You share nothing with them, so there is nothing to end or renew.');
    expect((await connectionsOf('user_owner')).connections[0].expires_at).toBeNull();
  });

  test('taking everything back never fails on the end date', async () => {
    for (const end of [new Date(Date.now() - 1000).toISOString(), 'next tuesday', endIn(5)]) {
      expect((await shareUntil({ acct_joint: 'balance' }, endIn(5))).status).toBe(200);
      const res = await shareUntil({ acct_joint: 'none' }, end);
      expect([end, res.status]).toEqual([end, 200]);
      expect((await connectionsOf('user_owner')).connections[0]).toMatchObject({ sharing: {}, expires_at: null });
      expect(await sharedWithPartner()).toEqual([]);
    }
  });

  test('nothing of a change is saved unless all of it can be', async () => {
    await shareUntil({ acct_joint: 'balance' }, endIn(5));
    const before = await stored();
    const res = await as('user_owner', () =>
      route('connections', 'PUT', { id: pair, label: 'Renamed', accounts: { acct_joint: 'transactions' }, expires_at: 'next tuesday' })
    );
    expect(res.status).toBe(409);
    expect(await stored()).toEqual(before);
    expect((await connectionsOf('user_owner')).connections[0].label).toBe('Someone');
  });

  test('is stored so a release from before end dates reads it as sharing nothing', async () => {
    await shareUntil({ acct_joint: 'balance' }, endIn(5));
    const withEnd = await stored();
    expect(withEnd).toEqual({ expiring: { acct_joint: 'balance' }, expires_at: expect.any(String), updated_at: expect.any(String) });
    // That release read a share only from "accounts", and found none here.
    expect(withEnd.accounts).toBeUndefined();
    // Without an end, as that release wrote it.
    await shareUntil(null, null);
    expect(Object.keys(await stored()).sort()).toEqual(['accounts', 'updated_at']);
  });

  test('a share from before end dates has no end, and one whose end can’t be read shows nothing', async () => {
    await fake.hset(testKey('connections'), {
      [`${pair}|share|user_owner`]: JSON.stringify({ accounts: { acct_joint: 'balance' }, updated_at: '2026-09-01T00:00:00.000Z' }),
    });
    expect((await sharedWithPartner())[0]).toMatchObject({ expires_at: null });
    for (const damaged of [
      { expiring: { acct_joint: 'balance' }, expires_at: 'soon', updated_at: 'x' },
      { expiring: { acct_joint: 'balance' }, updated_at: 'x' },
      { accounts: { acct_joint: 'balance' }, expiring: { acct_joint: 'balance' }, expires_at: endIn(5), updated_at: 'x' },
      { accounts: { acct_joint: 'balance' }, expires_at: endIn(5), updated_at: 'x' },
    ]) {
      await fake.hset(testKey('connections'), { [`${pair}|share|user_owner`]: JSON.stringify(damaged) });
      expect([damaged, await sharedWithPartner()]).toEqual([damaged, []]);
    }
  });
});

describe('records of showings', () => {
  const SLOT = 15 * 60_000;
  const DAMAGED = 'not-ciphertext-but-long-enough-to-be-tried';

  test('each read is counted for the owner, with the accounts and levels it returned, and both of them see it', async () => {
    const { sharedWithMe } = await import('@/lib/sharing');
    await share({ acct_joint: 'transactions', acct_mine: 'balance', manual_house: 'exists' });
    await setAccountHidden(TEST_CTX, 'acct_mine', 'depository', true); // paused: not shown, so not counted
    const now = Date.now();
    await sharedWithMe('user_partner', now);
    const expected = [{ at: slotOf(now), times: 1, read: { acct_joint: 'transactions' as const, manual_house: 'exists' as const } }];
    expect(await ownerRecord()).toEqual({ shown: expected });
    // The owner sees it on the connection; the partner sees the same record of showings to them.
    expect((await connectionsOf('user_owner')).connections[0].shown_to_them).toEqual(expected);
    expect((await connectionsOf('user_partner')).connections[0].shown_to_me).toEqual(expected);
    // And not the other way round: nothing of the partner's was shown to the owner.
    expect((await connectionsOf('user_owner')).connections[0].shown_to_me).toEqual([]);
  });

  test('ten in a quarter hour are one row with a count, at the widest level each account was shown at', async () => {
    const { sharedWithMe } = await import('@/lib/sharing');
    const t = Math.floor(Date.now() / SLOT) * SLOT + SLOT; // the start of the next quarter hour
    await share({ acct_joint: 'balance' });
    for (let i = 0; i < 9; i++) await sharedWithMe('user_partner', t + i * 60_000);
    await share({ acct_joint: 'transactions' });
    await sharedWithMe('user_partner', t + 14 * 60_000);
    await sharedWithMe('user_partner', t + SLOT);
    expect(await ownerRecord()).toEqual({
      shown: [
        { at: slotOf(t), times: 10, read: { acct_joint: 'transactions' } },
        { at: slotOf(t + SLOT), times: 1, read: { acct_joint: 'transactions' } },
      ],
    });
  });

  test('through the route too, and nothing for a share that shows nothing, or for the owner’s own reads', async () => {
    expect(await sharedWithPartner()).toEqual([]);
    expect(await fake.hgetall(ctxKey('sharing-access-log'))).toBeNull();
    await share({ acct_joint: 'balance' });
    for (let i = 0; i < 3; i++) await sharedWithPartner();
    const total = async () => (await ownerRecord())!.shown.reduce((n, s) => n + s.times, 0);
    expect(await total()).toBe(3);
    await as('user_owner', () => route('shared', 'GET'));
    expect(await total()).toBe(3);
  });

  test('kept 90 days at most: dropped by the next showing, or by the nightly pass', async () => {
    const { sharedWithMe, connectionLogIds } = await import('@/lib/sharing');
    const now = Date.now();
    await share({ acct_joint: 'balance' });
    const logId = (await logIdOf())!;
    const old = { at: slotOf(now - 91 * DAY), times: 7, read: { acct_joint: 'balance' as const } };
    await accessLogStore.set(TEST_CTX, logId, { shown: [old] });
    // Shown as nothing in the meantime.
    expect((await connectionsOf('user_owner')).connections[0].shown_to_them).toEqual([]);
    // Gone the next night, with nothing for anyone to do.
    await pruneAccessLog(TEST_CTX, now, connectionLogIds);
    expect(await ownerRecord()).toBeNull();
    // Or at the next showing.
    await accessLogStore.set(TEST_CTX, logId, { shown: [old] });
    await sharedWithMe('user_partner', now);
    expect((await ownerRecord())!.shown.map((s) => s.at)).toEqual([slotOf(now)]);
  });

  test('a connection’s log id is random, never derived from who is connected, and new each time they connect', async () => {
    const { connectionId } = await import('@/lib/sharing');
    await share({ acct_joint: 'balance' });
    await sharedWithPartner();
    const first = (await logIdOf())!;
    expect(first).toMatch(/^[0-9a-f]{32}$/);
    expect(first).not.toContain(connectionId('user_owner', 'user_partner'));
    // The only field name in the owner's container is that id.
    expect(Object.keys((await fake.hgetall(ctxKey('sharing-access-log')))!)).toEqual([first]);
    await as('user_owner', () => route('connections', 'DELETE', { id: pair }));
    await connect('user_partner', 'user_owner');
    expect(await logIdOf()).not.toBe(first);
    expect((await connectionsOf('user_owner')).connections[0]).toMatchObject({ shown_to_them: [], shown_to_me: [] });
  });

  test('a connection from before records gets its id at its first showing, and two at once agree on one', async () => {
    const { sharedWithMe } = await import('@/lib/sharing');
    await share({ acct_joint: 'balance' });
    await fake.hdel(testKey('connections'), `${pair}|log`); // as connections were before records
    expect((await connectionsOf('user_owner')).connections[0]).toMatchObject({ record_id: null, record_since: null, shown_to_them: [], shown_to_me: [] });
    const now = Date.now();
    await Promise.all([sharedWithMe('user_partner', now), sharedWithMe('user_partner', now)]);
    const logId = (await logIdOf())!;
    expect(logId).toMatch(/^[0-9a-f]{32}$/);
    expect(await accessLogStore.get(TEST_CTX, logId)).toEqual({ shown: [{ at: slotOf(now), times: 2, read: { acct_joint: 'balance' } }] });
    expect(Object.keys((await fake.hgetall(ctxKey('sharing-access-log')))!)).toEqual([logId]);
    expect((await connectionsOf('user_owner')).connections[0]).toMatchObject({ record_id: logId, record_since: new Date(now).toISOString() });
  });

  test('a removal that lands while a showing is being counted leaves no record behind', async () => {
    const { sharedWithMe } = await import('@/lib/sharing');
    await share({ acct_joint: 'balance' });
    const logId = (await logIdOf())!;
    const realEval = fake.eval.bind(fake);
    (fake as any).eval = async (script: string, keys: string[], args: string[]) => {
      const answer = await realEval(script, keys, args);
      // Between the count's read and its write: the whole removal runs, and
      // finds no record yet to delete.
      if (script.startsWith('-- nya:repo-read-entries') && keys[0] === ctxKey('sharing-access-log')) {
        (fake as any).eval = realEval;
        expect((await as('user_owner', () => route('connections', 'DELETE', { id: pair }))).status).toBe(200);
      }
      return answer;
    };
    try {
      expect(await sharedWithMe('user_partner')).toHaveLength(1);
    } finally {
      (fake as any).eval = realEval;
    }
    expect(await accessLogStore.get(TEST_CTX, logId)).toBeNull();
    expect(Object.keys((await fake.hgetall(ctxKey('sharing-access-log'))) ?? {})).toEqual([]);
  });

  test('a failing write never fails the read, and is logged', async () => {
    await share({ acct_joint: 'balance' });
    fake.failNext('eval'); // the record's own read
    const { result, logged } = await quietly(() => as('user_partner', () => route('shared', 'GET')));
    expect(result.status).toBe(200);
    expect(result.body.shared.map((s: any) => s.connection)).toEqual([pair]);
    expect(logged.map((l) => l[0])).toEqual(['A showing of shared data could not be recorded']);
    expect(await ownerRecord()).toBeNull();
  });

  test('a record that can’t be read says so on both sides, showings go unrecorded, and the owner can clear it', async () => {
    await share({ acct_joint: 'balance' });
    const logId = (await logIdOf())!;
    await fake.hset(ctxKey('sharing-access-log'), { [logId]: DAMAGED });
    const { result } = await quietly(() => sharedWithPartner());
    expect(result.map((s: any) => s.connection)).toEqual([pair]);
    expect((await connectionsOf('user_owner')).connections[0]).toMatchObject({ record_id: logId, shown_to_them: null, shown_to_them_problem: 'unreadable' });
    expect((await connectionsOf('user_partner')).connections[0]).toMatchObject({ shown_to_me: null, shown_to_me_problem: 'unreadable' });
    const clear = (who: string, id: string) => as(who, () => route('connections/access-log', 'DELETE', { id }));
    expect((await clear('user_owner', 'nope')).status).toBe(400);
    // Only the owner's own: the partner has no such record to clear.
    expect((await clear('user_partner', logId)).status).toBe(409);
    expect((await clear('user_owner', logId)).status).toBe(200);
    expect((await clear('user_owner', logId)).status).toBe(409); // nothing damaged left
    await sharedWithPartner();
    expect((await connectionsOf('user_owner')).connections[0].shown_to_them).toHaveLength(1);
    // A record that reads is never cleared.
    expect((await clear('user_owner', logId)).status).toBe(409);
    expect((await connectionsOf('user_owner')).connections[0].shown_to_them).toHaveLength(1);
  });

  test('a damaged record that belongs to no connection now is listed, and can be cleared', async () => {
    const stray = 'f'.repeat(32);
    await fake.hset(ctxKey('sharing-access-log'), { [stray]: DAMAGED });
    expect((await connectionsOf('user_owner')).damaged_records).toEqual([stray]);
    expect((await as('user_owner', () => route('connections/access-log', 'DELETE', { id: stray }))).status).toBe(200);
    expect((await connectionsOf('user_owner')).damaged_records).toEqual([]);
  });

  test('the nightly pass deletes a record whose connection has ended, and nothing while a connection can’t be read', async () => {
    const { connectionLogIds } = await import('@/lib/sharing');
    await share({ acct_joint: 'balance' });
    await sharedWithPartner();
    const logId = (await logIdOf())!;
    // Left by a removal that stopped part way.
    const stray = 'e'.repeat(32);
    const record = { shown: [{ at: slotOf(Date.now()), times: 1, read: { acct_joint: 'balance' as const } }] };
    await accessLogStore.set(TEST_CTX, stray, record);
    // A connection whose record can't be read could own it: kept.
    await fake.hset(testKey('connections'), { ['0'.repeat(24)]: 'not json' });
    expect(await connectionLogIds()).toBeNull();
    await pruneAccessLog(TEST_CTX, Date.now(), connectionLogIds);
    expect(await accessLogStore.get(TEST_CTX, stray)).toEqual(record);
    await fake.hdel(testKey('connections'), '0'.repeat(24));
    await pruneAccessLog(TEST_CTX, Date.now(), connectionLogIds);
    expect(Object.keys((await fake.hgetall(ctxKey('sharing-access-log')))!)).toEqual([logId]);
  });

  test('names the connection by what the owner calls them, never who they are', async () => {
    await share({ acct_joint: 'balance' });
    await as('user_owner', () => route('connections', 'PUT', { id: pair, label: 'Pat' }));
    await as('user_partner', () => route('connections', 'PUT', { id: pair, label: 'THEIR-NAME-FOR-ME' }));
    await sharedWithPartner();
    const mine = await connectionsOf('user_owner');
    expect(mine.connections[0]).toMatchObject({ label: 'Pat', shown_to_them: [expect.objectContaining({ times: 1 })] });
    expect(JSON.stringify(mine)).not.toMatch(/user_partner|THEIR-NAME-FOR-ME/);
    expect(JSON.stringify(await ownerRecord())).not.toMatch(/user_|THEIR-NAME-FOR-ME|Pat/);
  });

  test('is the only thing a read writes in the owner’s container, old-shaped records included', async () => {
    await share({ acct_joint: 'transactions', manual_house: 'balance' });
    // A remembered account in the shape from before per-item records, which
    // the owner's own loads tidy away and someone else's read must not.
    await fake.hset(ctxKey('accounts:meta'), { acct_legacy: await encrypt(JSON.stringify({ account_id: 'acct_legacy', type: 'depository' })) });
    const prefix = ctxKey('');
    const snapshot = () => {
      const out: Record<string, string> = {};
      for (const [k, v] of (fake as any).strings) if (k.startsWith(prefix)) out[k] = v;
      for (const [k, h] of (fake as any).hashes) if (k.startsWith(prefix)) for (const [f, v] of h) out[`${k} ${f}`] = v;
      return out;
    };
    const before = snapshot();
    expect(Object.keys(before)).toContain(`${ctxKey('accounts:meta')} acct_legacy`);
    await sharedWithPartner();
    const after = snapshot();
    const changed = Object.keys(after).filter((k) => after[k] !== before[k]);
    expect(changed).toEqual([`${ctxKey('sharing-access-log')} ${await logIdOf()}`]);
    expect(Object.keys(before).filter((k) => !(k in after))).toEqual([]);
  });
});
