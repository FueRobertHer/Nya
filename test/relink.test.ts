import { describe, expect, test, mock, beforeEach, afterEach, afterAll } from 'bun:test';
import { startRedis, type RealRedis } from './real-redis';
import { FakeRedis, storageMock, TEST_CTX, ctxKey, registerTestContainer, unscopedDataKeys } from './fake-redis';

// Disconnecting an institution and adding it back (#46), end to end through
// the routes: what the user set on the old accounts (hidden, categories)
// survives, but only takes effect on the new accounts once the user links
// them, and unlinking takes it away again. Nothing stored is rewritten.

const ctx = TEST_CTX;
process.env.PLAID_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');

const DAY = 86_400_000;
const daysAgo = (n: number) => new Date(Date.now() - n * DAY).toISOString().slice(0, 10);

// Each Item's transactions, by access token, as Plaid would send them.
const plaidTxns: Record<string, any[]> = {};
const plaidAccounts: Record<string, any[]> = {};
const removed: string[] = [];
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
    accountsGet: async (req: any) => ({ data: { accounts: plaidAccounts[req.access_token] ?? [] } }),
    linkTokenCreate: async (req: any) => ({ data: { link_token: 'link', user: req.user } }),
    itemRemove: async (req: any) => {
      removed.push(req.access_token);
      return { data: {} };
    },
  },
}));

const fake = new FakeRedis();
afterEach(() => expect(unscopedDataKeys(fake)).toEqual([]));
mock.module('@/lib/storage', () => storageMock(fake));

const { encrypt } = await import('@/lib/crypto');
const links = await import('@/lib/links');
const { rememberAccounts } = await import('@/lib/last-known');
const { setAccountHidden } = await import('@/lib/hidden');
const overrides = await import('@/lib/overrides');

const account = (id: string) => ({
  account_id: id,
  name: 'Checking',
  official_name: null,
  type: 'depository',
  subtype: 'checking',
  mask: '4821',
  balances: { available: 100, current: 100, limit: null, iso_currency_code: 'USD' },
});
const row = (id: string, account_id: string, over: Record<string, unknown> = {}) => ({
  transaction_id: id,
  account_id,
  amount: 4.5,
  iso_currency_code: 'USD',
  date: daysAgo(3),
  name: 'BLUE BOTTLE',
  merchant_name: 'Blue Bottle',
  pending: false,
  counterparties: [],
  personal_finance_category: { primary: 'FOOD_AND_DRINK', detailed: 'FOOD_AND_DRINK_COFFEE' },
  ...over,
});

/** An Item as it is after a successful load: stored, remembered, in the directory. */
async function addItem(item_id: string, account_id: string, txns: any[], seenOn = Date.now()) {
  const token = `token-${item_id}`;
  plaidTxns[token] = txns;
  plaidAccounts[token] = [account(account_id)];
  await fake.hset(ctxKey('plaid:items'), {
    [item_id]: JSON.stringify({ item_id, institution_name: 'Chase', encrypted_access_token: await encrypt(token) }),
  });
  const inst = { item_id, institution_name: 'Chase', institution_id: 'ins_3', error: null, accounts: [{ ...account(account_id), balance: 100 }] };
  await rememberAccounts(ctx, [inst as any]);
  await links.recordDirectory(ctx, [inst as any], seenOn);
}

const route = async (path: string, method: string, body?: unknown) => {
  const mod: any = await import(`@/app/api/${path}/route`);
  const url = `http://x/api/${path}${method === 'GET' ? '?refresh=1' : ''}`;
  const res = await mod[method](new Request(url, { method, body: body ? JSON.stringify(body) : undefined }));
  return { status: res.status, body: await res.json() };
};
const categoryOf = async (name: string) =>
  (await route('transactions', 'GET')).body.transactions.find((t: any) => t.transaction_id === name)?.category;
const excludedOf = async (name: string) =>
  (await route('transactions', 'GET')).body.transactions.find((t: any) => t.transaction_id === name)?.excluded;
const excludeRow = (transaction_id: string, excluded: boolean) => route('transaction-annotations', 'PATCH', { transaction_id, excluded });

beforeEach(async () => {
  fake.reset();
  removed.length = 0;
  (await import('@/lib/sessions')).forgetEpochs();
  await registerTestContainer(fake);
});

describe('a re-link, end to end', () => {
  // The old Item: two coffees on different days, one recategorized by hand.
  const before = async () => {
    await addItem('item_old', 'acct_old', [row('t_a', 'acct_old'), row('t_b', 'acct_old', { date: daysAgo(5), amount: 6 })], Date.now() - DAY);
    await route('transactions', 'GET'); // first sync stores the rows
    expect((await route('recategorize', 'POST', { transaction_id: 't_a', category: 'treats' })).status).toBe(200);
    expect(await categoryOf('t_a')).toBe('treats');
  };
  // Re-added: the same purchases under new transaction and account ids.
  const readd = () =>
    addItem('item_new', 'acct_new', [row('n_a', 'acct_new'), row('n_b', 'acct_new', { date: daysAgo(5), amount: 6 })]);

  test('categories carry across once linked, the count is reported, and unlinking undoes it', async () => {
    await before();
    expect((await route('disconnect', 'POST', { item_id: 'item_old' })).status).toBe(200);
    await readd();

    // Not the same account until the user says so.
    expect(await categoryOf('n_a')).toBe('food and drink');

    const offer = await route('account-links', 'GET');
    expect(offer.body.suggestions.map((s: any) => [s.old, s.to])).toEqual([['acct_old', 'acct_new']]);
    expect((await route('account-links', 'POST', { action: 'link', old: 'acct_old', to: 'acct_new' })).status).toBe(200);

    expect(await categoryOf('n_a')).toBe('treats');
    expect(await categoryOf('n_b')).toBe('food and drink'); // never recategorized
    const listed = (await route('account-links', 'GET')).body.links;
    expect(listed.map((l: any) => l.categories)).toEqual([{ total: 1, carried: 1, ambiguous: 0 }]);

    await route('account-links', 'DELETE', { old: 'acct_old' });
    expect(await categoryOf('n_a')).toBe('food and drink');
  });

  // Plaid re-sends only so much history: older rows can't be matched, and the
  // count says so rather than claiming everything came across.
  test('reports rows the re-added account does not have as not carried', async () => {
    await before();
    await route('recategorize', 'POST', { transaction_id: 't_b', category: 'work' });
    await route('disconnect', 'POST', { item_id: 'item_old' });
    await addItem('item_new', 'acct_new', [row('n_a', 'acct_new')]); // t_b's twin not re-sent
    await route('account-links', 'POST', { action: 'link', old: 'acct_old', to: 'acct_new' });
    // Counted from the stored rows, so nothing is carried before the first sync.
    expect((await route('account-links', 'GET')).body.links[0].categories).toEqual({ total: 2, carried: 0, ambiguous: 0 });
    await route('transactions', 'GET');
    expect((await route('account-links', 'GET')).body.links[0].categories).toEqual({ total: 2, carried: 1, ambiguous: 0 });
  });

  test('a hidden account of a connected institution that stopped reporting is not called disconnected', async () => {
    await addItem('item_1', 'acct_1', []);
    // acct_closed was seen under item_1 but the bank no longer returns it.
    await links.recordDirectory(ctx, [{ item_id: 'item_1', institution_name: 'Chase', institution_id: 'ins_3', error: null, accounts: [{ ...account('acct_closed'), mask: '0001' }] } as any]);
    await rememberAccounts(ctx, [{ item_id: 'item_1', institution_name: 'Chase', error: null, accounts: [{ ...account('acct_1'), balance: 1 }] } as any]);
    await setAccountHidden(ctx, 'acct_closed', 'depository', true);
    expect((await links.getEffectiveHidden(ctx, { describe: true })).forClient).toEqual([
      { account_id: 'acct_closed', type: 'depository', label: 'Chase Checking ••0001', disconnected: false },
    ]);
  });

  test('exclusions carry across once linked, as categories do, and unlinking undoes it', async () => {
    await addItem('item_old', 'acct_old', [row('t_a', 'acct_old'), row('t_b', 'acct_old', { date: daysAgo(5), amount: 6 })], Date.now() - DAY);
    await route('transactions', 'GET');
    expect((await excludeRow('t_a', true)).status).toBe(200);
    expect(await excludedOf('t_a')).toBe(true);
    expect((await route('disconnect', 'POST', { item_id: 'item_old' })).status).toBe(200);
    // The old ids die with the Item, and so do their records: what carries is
    // kept by content, encrypted, under the earlier account.
    expect(await fake.hgetall(ctxKey('transaction-annotations'))).toBeNull();
    expect(await fake.hget(ctxKey('carried-annotations'), 'acct_old')).not.toBeNull();
    await readd();

    // Not the same account until the person says so.
    expect(await excludedOf('n_a')).toBeUndefined();
    expect((await route('account-links', 'POST', { action: 'link', old: 'acct_old', to: 'acct_new' })).status).toBe(200);
    expect(await excludedOf('n_a')).toBe(true);
    expect(await excludedOf('n_b')).toBeUndefined(); // never excluded

    await route('account-links', 'DELETE', { old: 'acct_old' });
    expect(await excludedOf('n_a')).toBeUndefined();
  });

  test('a disconnect that fails part way keeps every exclusion the Item had; the next one prunes them once it is gone', async () => {
    await addItem('item_old', 'acct_old', [row('t_a', 'acct_old')], Date.now() - DAY);
    await route('transactions', 'GET');
    await excludeRow('t_a', true);
    // The carry is recorded, then removing the Item fails.
    fake.failNext('hdel');
    const quiet = console.error;
    console.error = () => {};
    try {
      expect((await route('disconnect', 'POST', { item_id: 'item_old' })).status).toBe(500);
    } finally {
      console.error = quiet;
    }
    expect(await fake.hget(ctxKey('plaid:items'), 'item_old')).not.toBeNull();
    expect(await fake.hget(ctxKey('transaction-annotations'), 't_a')).not.toBeNull();
    expect(await excludedOf('t_a')).toBe(true);
    // Disconnected for good: pruned after the Item went, the carry recorded once.
    expect((await route('disconnect', 'POST', { item_id: 'item_old' })).status).toBe(200);
    expect(await fake.hgetall(ctxKey('transaction-annotations'))).toBeNull();
    await readd();
    await route('account-links', 'POST', { action: 'link', old: 'acct_old', to: 'acct_new' });
    expect(await excludedOf('n_a')).toBe(true);
  });

  test('what the person says on the new row itself wins over a carried exclusion', async () => {
    await addItem('item_old', 'acct_old', [row('t_a', 'acct_old')], Date.now() - DAY);
    await route('transactions', 'GET');
    await excludeRow('t_a', true);
    await route('disconnect', 'POST', { item_id: 'item_old' });
    await readd();
    await route('account-links', 'POST', { action: 'link', old: 'acct_old', to: 'acct_new' });
    expect(await excludedOf('n_a')).toBe(true);
    expect((await excludeRow('n_a', false)).body).toEqual({ transaction_id: 'n_a', excluded: false });
    expect(await excludedOf('n_a')).toBeUndefined();
  });

  test('identical rows excluded one way and not the other carry nothing, rather than guess', async () => {
    await addItem('item_old', 'acct_old', [row('t_a', 'acct_old'), row('t_a2', 'acct_old')], Date.now() - DAY);
    await route('transactions', 'GET');
    await excludeRow('t_a', true);
    await route('disconnect', 'POST', { item_id: 'item_old' });
    await addItem('item_new', 'acct_new', [row('n_a', 'acct_new')]);
    await route('account-links', 'POST', { action: 'link', old: 'acct_old', to: 'acct_new' });
    expect(await excludedOf('n_a')).toBeUndefined();
  });

  test('a category set on the new row itself wins over a carried one', async () => {
    await before();
    await route('disconnect', 'POST', { item_id: 'item_old' });
    await readd();
    await route('account-links', 'POST', { action: 'link', old: 'acct_old', to: 'acct_new' });
    await route('recategorize', 'POST', { transaction_id: 'n_a', category: 'work' });
    expect(await categoryOf('n_a')).toBe('work');
  });

  test('rows categorized differently under one key carry nothing, rather than guess', async () => {
    await addItem('item_old', 'acct_old', [row('t_a', 'acct_old'), row('t_a2', 'acct_old')], Date.now() - DAY);
    await route('transactions', 'GET');
    await route('recategorize', 'POST', { transaction_id: 't_a', category: 'treats' });
    await route('recategorize', 'POST', { transaction_id: 't_a2', category: 'work' });
    await route('disconnect', 'POST', { item_id: 'item_old' });
    await addItem('item_new', 'acct_new', [row('n_a', 'acct_new')]);
    await route('account-links', 'POST', { action: 'link', old: 'acct_old', to: 'acct_new' });
    expect(await categoryOf('n_a')).toBe('food and drink');
    expect((await route('account-links', 'GET')).body.links[0].categories).toEqual({ total: 0, carried: 0, ambiguous: 1 });
  });

  test('a hidden account stays hidden through the disconnect, is named on the Hidden card, and its re-added self is hidden once linked', async () => {
    await before();
    await setAccountHidden(ctx, 'acct_old', 'depository', true);
    await route('disconnect', 'POST', { item_id: 'item_old' });
    await readd();

    const { forClient, hidden } = await links.getEffectiveHidden(ctx, { describe: true });
    expect(forClient).toEqual([
      { account_id: 'acct_old', type: 'depository', label: 'Chase Checking ••4821', disconnected: true },
    ]);
    expect(hidden.has('acct_new')).toBe(false); // not the same account yet

    await route('account-links', 'POST', { action: 'link', old: 'acct_old', to: 'acct_new' });
    const after = await links.getEffectiveHidden(ctx, { describe: true });
    expect(after.hidden.has('acct_new')).toBe(true);
    expect(after.forClient.map((h) => h.account_id)).toEqual(['acct_new']);
    // Its rows are hidden with it.
    expect((await route('transactions', 'GET')).body.transactions).toEqual([]);
  });

  test('Unhide works on a disconnected account', async () => {
    await before();
    await setAccountHidden(ctx, 'acct_old', 'depository', true);
    await route('disconnect', 'POST', { item_id: 'item_old' });
    await readd();
    expect((await route('hidden-accounts', 'POST', { account_id: 'acct_old', hidden: false })).status).toBe(200);
    expect((await links.getEffectiveHidden(ctx, { describe: true })).forClient).toEqual([]);
  });

  test('a disconnect whose categories cannot be recorded still disconnects', async () => {
    await before();
    const hgetall = fake.hgetall.bind(fake);
    fake.hgetall = (async (key: string) => {
      if (key === ctxKey('txn-category-overrides')) throw new Error('down');
      return hgetall(key);
    }) as typeof fake.hgetall;
    try {
      expect((await route('disconnect', 'POST', { item_id: 'item_old' })).status).toBe(200);
    } finally {
      fake.hgetall = hgetall;
    }
    expect(await fake.hget(ctxKey('plaid:items'), 'item_old')).toBeNull();
    expect(removed).toEqual(['token-item_old']);
  });
});

describe('carry-over edge cases', () => {
  const before = async (rows: any[] = [row('t_a', 'acct_old')]) => {
    await addItem('item_old', 'acct_old', rows, Date.now() - DAY);
    await route('transactions', 'GET');
  };

  // The earlier id is reporting again: the link is paused, and a paused link
  // must not carry anything.
  test('a paused link carries nothing', async () => {
    await before();
    await route('recategorize', 'POST', { transaction_id: 't_a', category: 'treats' });
    await route('disconnect', 'POST', { item_id: 'item_old' });
    await addItem('item_new', 'acct_new', [row('n_a', 'acct_new')]);
    await route('account-links', 'POST', { action: 'link', old: 'acct_old', to: 'acct_new' });
    expect(await categoryOf('n_a')).toBe('treats');
    // The old institution is added back as it was: acct_old is live again.
    await addItem('item_old2', 'acct_old', [row('t_a', 'acct_old')]);
    expect(await categoryOf('n_a')).toBe('food and drink');
  });

  // Without the live accounts a paused link looks active, so nothing carries.
  test('nothing carries when the live accounts can’t be read', async () => {
    await before();
    await route('recategorize', 'POST', { transaction_id: 't_a', category: 'treats' });
    await route('disconnect', 'POST', { item_id: 'item_old' });
    await addItem('item_new', 'acct_new', [row('n_a', 'acct_new')]);
    await route('account-links', 'POST', { action: 'link', old: 'acct_old', to: 'acct_new' });
    await addItem('item_old2', 'acct_old', [row('t_a', 'acct_old')]); // paused
    const hgetall = fake.hgetall.bind(fake);
    fake.hgetall = (async (key: string) => {
      if (key === ctxKey('accounts:meta')) throw new Error('down');
      return hgetall(key);
    }) as typeof fake.hgetall;
    try {
      expect(await categoryOf('n_a')).toBe('food and drink');
    } finally {
      fake.hgetall = hgetall;
    }
  });

  test('the count leaves out rows past the lookback and rows with a category of their own', async () => {
    await before([row('t_a', 'acct_old'), row('t_old', 'acct_old', { date: daysAgo(400) }), row('t_own', 'acct_old', { amount: 9 })]);
    for (const id of ['t_a', 't_old', 't_own']) await route('recategorize', 'POST', { transaction_id: id, category: 'treats' });
    await route('disconnect', 'POST', { item_id: 'item_old' });
    await addItem('item_new', 'acct_new', [row('n_a', 'acct_new'), row('n_old', 'acct_new', { date: daysAgo(400) }), row('n_own', 'acct_new', { amount: 9 })]);
    await route('account-links', 'POST', { action: 'link', old: 'acct_old', to: 'acct_new' });
    await route('recategorize', 'POST', { transaction_id: 'n_own', category: 'work' });
    await route('transactions', 'GET');
    expect((await route('account-links', 'GET')).body.links[0].categories).toEqual({ total: 3, carried: 1, ambiguous: 0 });
  });

  test('the Accounts tab reads no transaction store when no link carries anything', async () => {
    await before();
    await route('disconnect', 'POST', { item_id: 'item_old' });
    await addItem('item_new', 'acct_new', [row('n_a', 'acct_new')]);
    await route('account-links', 'POST', { action: 'link', old: 'acct_old', to: 'acct_new' });
    const get = fake.get.bind(fake);
    const read: string[] = [];
    fake.get = (async (key: string) => {
      read.push(key);
      return get(key);
    }) as typeof fake.get;
    try {
      await route('account-links', 'GET');
    } finally {
      fake.get = get;
    }
    expect(read.filter((k) => k.includes(':txns:'))).toEqual([]);
    // Nor what the count would need next.
    const hgetall = fake.hgetall.bind(fake);
    const hashes: string[] = [];
    fake.hgetall = (async (key: string) => {
      hashes.push(key);
      return hgetall(key);
    }) as typeof fake.hgetall;
    try {
      await route('account-links', 'GET');
    } finally {
      fake.hgetall = hgetall;
    }
    expect(hashes).not.toContain(ctxKey('txn-category-overrides'));
  });

  test('an unreadable carry record shows Plaid’s category, and the page still loads', async () => {
    await before();
    await route('recategorize', 'POST', { transaction_id: 't_a', category: 'treats' });
    await route('disconnect', 'POST', { item_id: 'item_old' });
    await addItem('item_new', 'acct_new', [row('n_a', 'acct_new')]);
    await route('account-links', 'POST', { action: 'link', old: 'acct_old', to: 'acct_new' });
    await fake.hset(ctxKey('txn-category-carry'), { acct_old: 'garbage' });
    expect(await categoryOf('n_a')).toBe('food and drink');
  });

  test('the transactions path doesn’t read the directory for hidden labels', async () => {
    await before();
    await setAccountHidden(ctx, 'acct_old', 'depository', true);
    await route('disconnect', 'POST', { item_id: 'item_old' });
    await addItem('item_new', 'acct_new', []);
    const { forClient } = await links.getEffectiveHidden(ctx);
    expect(forClient).toEqual([{ account_id: 'acct_old', type: 'depository' }]);
  });
});

describe('forgetting an earlier account', () => {
  const enc = async (m: unknown) => encrypt(JSON.stringify(m));
  const layers = ['history:accounts', 'history:accounts:est', 'history:accounts:est:ext', 'history:accounts:partial', 'history:accounts:est:flatd'];
  const readMap = async (key: string, date: string) => {
    const { decrypt } = await import('@/lib/crypto');
    return JSON.parse(await decrypt((await fake.hget<string>(ctxKey(key), date))!));
  };
  const forget = (old: string) => route('account-links', 'POST', { action: 'forget', old });

  // An institution disconnected, with history in every layer, a name, a
  // carried category and a declined offer; and a connected account alongside.
  const setup = async () => {
    await addItem('item_old', 'acct_old', [row('t_a', 'acct_old')], Date.now() - DAY);
    await route('transactions', 'GET');
    await route('recategorize', 'POST', { transaction_id: 't_a', category: 'treats' });
    await route('transaction-annotations', 'PATCH', { transaction_id: 't_a', excluded: true });
    await route('disconnect', 'POST', { item_id: 'item_old' });
    await addItem('item_new', 'acct_other', []);
    for (const key of layers) await fake.hset(ctxKey(key), { '2026-01-01': await enc({ acct_old: 100, acct_other: 5 }) });
    await fake.set(ctxKey('history:accounts:est:flat'), await enc({ acct_old: 7, acct_other: 1 }));
    await fake.hset(ctxKey('history:net-worth'), { '2026-01-01': await encrypt('105') });
    await links.dismissPair(ctx, 'acct_old', 'acct_other');
  };

  test('deletes its balances, name, carried categories, dismissals and stale records, and leaves the totals', async () => {
    await setup();
    // A load that raced the disconnect wrote the old Item's record back.
    await rememberAccounts(ctx, [{ item_id: 'item_old', institution_name: 'Chase', error: null, accounts: [{ ...account('acct_old'), balance: 1 }] } as any]);
    const listed = (await route('account-links', 'GET')).body.earlier;
    expect(listed.map((e: any) => [e.id, e.label, e.hidden])).toEqual([['acct_old', 'Chase Checking ••4821', false]]);
    const totalBefore = await fake.hget<string>(ctxKey('history:net-worth'), '2026-01-01');

    expect((await forget('acct_old')).body).toEqual({ forgotten: true, unreadable_days: 0 });
    for (const key of layers) expect(await readMap(key, '2026-01-01')).toEqual({ acct_other: 5 });
    const { decrypt } = await import('@/lib/crypto');
    expect(JSON.parse(await decrypt((await fake.get<string>(ctxKey('history:accounts:est:flat')))!))).toEqual({ acct_other: 1 });
    expect(await fake.hget(ctxKey('accounts:directory'), 'acct_old')).toBeNull();
    expect(await fake.hget(ctxKey('txn-category-carry'), 'acct_old')).toBeNull();
    expect(await fake.hget(ctxKey('carried-annotations'), 'acct_old')).toBeNull();
    expect(await fake.hgetall(ctxKey('account-links:dismissed'))).toBeNull();
    expect(await fake.hget(ctxKey('accounts:meta'), 'item_old')).toBeNull();
    expect(await fake.hget(ctxKey('accounts:meta'), 'item_new')).not.toBeNull();
    expect(await fake.hget<string>(ctxKey('history:net-worth'), '2026-01-01')).toBe(totalBefore!);
    expect(await fake.get(ctxKey('account-links:lock'))).toBeNull(); // released
    expect((await route('account-links', 'GET')).body.earlier).toEqual([]);
  });

  // The bank stopped returning a card, but the institution is still
  // connected: its transactions are still stored there.
  test('not an account of an institution that is still connected', async () => {
    await setup();
    await links.recordDirectory(ctx, [{ item_id: 'item_new', institution_name: 'Chase', institution_id: 'ins_3', error: null, accounts: [{ ...account('acct_closed'), mask: '0001' }] } as any]);
    await rememberAccounts(ctx, [{ item_id: 'item_new', institution_name: 'Chase', error: null, accounts: [{ ...account('acct_other'), balance: 1 }] } as any]);
    expect((await route('account-links', 'GET')).body.earlier.map((e: any) => e.id)).toEqual(['acct_old']);
    expect((await forget('acct_closed')).status).toBe(409);
  });

  test('an account known only from balances is checked against the connected stores', async () => {
    await setup();
    await fake.hset(ctxKey('history:accounts'), { '2025-01-01': await enc({ ancient: 3 }) });
    // Still in a connected Item's transaction store: refused.
    const { readStoredTxns } = await import('@/lib/transactions');
    await addItem('item_keeps', 'ancient_live', [row('k1', 'ancient')]);
    await route('transactions', 'GET');
    expect((await readStoredTxns(ctx, 'item_keeps')).map((t) => t.account_id)).toContain('ancient');
    const refused = await forget('ancient');
    expect(refused.status).toBe(409);
    expect(refused.body.error).toContain('still connected');
    // An unreadable store is not an absent one.
    await fake.set(ctxKey('txns:item_keeps'), 'garbage');
    expect((await forget('ancient')).status).toBe(500);
    expect(await readMap('history:accounts', '2025-01-01')).toEqual({ ancient: 3 });
  });

  test('refuses a current, linked or unknown account', async () => {
    await setup();
    expect((await forget('acct_other')).status).toBe(409); // live
    expect((await forget('made-up')).status).toBe(409);
    await links.linkAccounts(ctx, 'acct_old', 'acct_other', {});
    expect((await forget('acct_old')).status).toBe(409); // linked
    expect(await readMap('history:accounts', '2026-01-01')).toEqual({ acct_old: 100, acct_other: 5 });
  });

  // Hidden: forgetting folds it out of the stored totals, point by point,
  // and nothing about it is left anywhere.
  const series = async () => {
    const { getHistory } = await import('@/lib/history');
    return getHistory(ctx, (await links.getEffectiveHidden(ctx)).hidden);
  };
  const withEstimated = async () => {
    await fake.hset(ctxKey('history:net-worth:est'), { '2025-12-01': await encrypt('50') });
    await fake.hset(ctxKey('history:accounts:est'), { '2025-12-01': await enc({ acct_old: 40, acct_other: 10 }) });
    await fake.hset(ctxKey('history:accounts:est:flatd'), { '2025-12-01': await enc({}) });
  };
  const storedTotal = async (key: string, date: string) => {
    const { decrypt } = await import('@/lib/crypto');
    const blob = await fake.hget<string>(ctxKey(key), date);
    return blob ? Number(await decrypt(blob)) : null;
  };
  const leftovers = async () => {
    const keys = [...(fake as any).strings.keys(), ...(fake as any).hashes.keys()] as string[];
    return keys.filter((k) => k.includes('history:forgotten') || k.includes('history:forgetting:'));
  };

  test('a hidden account is folded out of the stored totals, and nothing about it is left', async () => {
    await setup();
    await withEstimated();
    await setAccountHidden(ctx, 'acct_old', 'depository', true);
    const before = await series();
    expect((await route('account-links', 'GET')).body.earlier.map((e: any) => e.hidden)).toEqual([true]);

    expect((await forget('acct_old')).status).toBe(200);
    const { hidden } = await links.getEffectiveHidden(ctx);
    expect(hidden.size).toBe(0); // its hidden entry went with it
    expect(await series()).toEqual(before);
    expect(await storedTotal('history:net-worth', '2026-01-01')).toBe(5);
    expect(await storedTotal('history:net-worth:est', '2025-12-01')).toBe(10);
    expect(await leftovers()).toEqual([]);
  });

  // At every step the chart is what it was: a point is either untouched (and
  // the still-hidden account is subtracted) or folded (and it is gone).
  test('the chart is the same after every step of a forget', async () => {
    await setup();
    await withEstimated();
    await setAccountHidden(ctx, 'acct_old', 'depository', true);
    const before = await series();
    const evalOrig = fake.eval.bind(fake);
    const seen: unknown[] = [];
    fake.eval = (async (script: string, keys: string[], args: string[]) => {
      const out = await evalOrig(script, keys, args);
      if (script.startsWith('-- nya:history-fold')) seen.push(await series());
      return out;
    }) as typeof fake.eval;
    try {
      await forget('acct_old');
    } finally {
      fake.eval = evalOrig;
    }
    expect(seen.length).toBeGreaterThan(1);
    for (const s of seen) expect(s).toEqual(before);
  });

  test('a forget that stops part way is right while stopped, can’t be unhidden, and folds once on a retry', async () => {
    await setup();
    await withEstimated();
    await setAccountHidden(ctx, 'acct_old', 'depository', true);
    const before = await series();
    const evalOrig = fake.eval.bind(fake);
    let folds = 0;
    fake.eval = (async (script: string, keys: string[], args: string[]) => {
      if (script.startsWith('-- nya:history-fold') && ++folds === 2) throw new Error('down');
      return evalOrig(script, keys, args);
    }) as typeof fake.eval;
    try {
      expect((await forget('acct_old')).status).toBe(500);
    } finally {
      fake.eval = evalOrig;
    }
    expect(await series()).toEqual(before);
    const unhide = await route('hidden-accounts', 'POST', { account_id: 'acct_old', hidden: false });
    expect(unhide.status).toBe(409);
    expect(unhide.body.error).toContain('being forgotten');
    expect((await forget('acct_old')).status).toBe(200);
    expect(await series()).toEqual(before);
    expect(await storedTotal('history:net-worth', '2026-01-01')).toBe(5);
    expect(await storedTotal('history:net-worth:est', '2025-12-01')).toBe(10);
    expect(await leftovers()).toEqual([]);
  });

  // A retry works only on the points not yet folded: a flat-only estimate
  // folded before the stop keeps its place on the chart, and isn't redone.
  test('a retry skips the points already folded', async () => {
    await setup();
    await fake.hset(ctxKey('history:net-worth:est'), { '2025-12-15': await encrypt('40') });
    await fake.hset(ctxKey('history:accounts:est:flatd'), { '2025-12-15': await enc({ acct_old: 40 }) });
    await withEstimated();
    await setAccountHidden(ctx, 'acct_old', 'depository', true);
    const before = await series();
    expect(before.find((p) => p.date === '2025-12-15')!.value).toBe(0);
    const evalOrig = fake.eval.bind(fake);
    let failed = false;
    fake.eval = (async (script: string, keys: string[], args: string[]) => {
      if (!failed && script.startsWith('-- nya:history-fold') && args[0] === '2025-12-01') {
        failed = true;
        // Once the flat-only point beside it (same batch) has been folded.
        const folded = () => [...(fake as any).hashes.entries()].some(([k, h]: [string, Map<string, string>]) => k.includes('history:forgetting:') && h.has('e:2025-12-15'));
        for (let i = 0; i < 100 && !folded(); i++) await Bun.sleep(5);
        throw new Error('down');
      }
      return evalOrig(script, keys, args);
    }) as typeof fake.eval;
    try {
      expect((await forget('acct_old')).status).toBe(500);
    } finally {
      fake.eval = evalOrig;
    }
    expect(await storedTotal('history:net-worth:est', '2025-12-15')).toBe(0);
    // Still a point while stopped: its breakdown names the account, at 0.
    expect(await readMap('history:accounts:est:flatd', '2025-12-15')).toEqual({ acct_old: 0 });
    expect(await series()).toEqual(before);
    const refolded: string[] = [];
    fake.eval = (async (script: string, keys: string[], args: string[]) => {
      if (script.startsWith('-- nya:history-fold')) refolded.push(args[1]);
      return evalOrig(script, keys, args);
    }) as typeof fake.eval;
    try {
      expect((await forget('acct_old')).status).toBe(200);
    } finally {
      fake.eval = evalOrig;
    }
    expect(refolded).not.toContain('e:2025-12-15');
    expect(refolded).toContain('e:2025-12-01');
    expect(await storedTotal('history:net-worth:est', '2025-12-15')).toBe(0);
    expect(await storedTotal('history:net-worth:est', '2025-12-01')).toBe(10);
  });

  // Estimated points that read the single pre-per-date flat record: split
  // per date first, so each can be folded on its own.
  test('points that read the old single flat record are folded too', async () => {
    await setup(); // the legacy record holds acct_old: 7
    await fake.hset(ctxKey('history:net-worth:est'), { '2025-11-01': await encrypt('20') });
    await setAccountHidden(ctx, 'acct_old', 'depository', true);
    const before = await series();
    expect(before.find((p) => p.date === '2025-11-01')!.value).toBe(13);
    await forget('acct_old');
    expect(await series()).toEqual(before);
    expect(await storedTotal('history:net-worth:est', '2025-11-01')).toBe(13);
    expect(await readMap('history:accounts:est:flatd', '2025-11-01')).toEqual({ acct_other: 1 });
  });

  // A point the chart dropped while it was hidden (no breakdown that day):
  // deleted within the account's life, kept outside it, where it can't be.
  test('a point dropped while hidden is deleted within its life, and kept outside it', async () => {
    await setup();
    await fake.hset(ctxKey('history:net-worth'), { '2026-02-01': await encrypt('999'), '2025-06-01': await encrypt('77') });
    // An estimate the real point hid: it can't show once the real one goes.
    await fake.hset(ctxKey('history:net-worth:est'), { '2026-02-01': await encrypt('888') });
    await fake.hset(ctxKey('history:accounts:est'), { '2026-02-01': await enc({ acct_other: 888 }) });
    await setAccountHidden(ctx, 'acct_old', 'depository', true);
    const dates = (h: { date: string }[]) => h.map((p) => p.date);
    expect(dates(await series())).not.toContain('2026-02-01');
    await forget('acct_old');
    expect(await fake.hget(ctxKey('history:net-worth'), '2026-02-01')).toBeNull();
    expect(await fake.hget(ctxKey('history:net-worth:est'), '2026-02-01')).toBeNull();
    expect(dates(await series())).not.toContain('2026-02-01');
    expect(await storedTotal('history:net-worth', '2025-06-01')).toBe(77);
    expect(dates(await series())).toContain('2025-06-01');
  });

  // Today's total recorded again after the forget doesn't have it either.
  test('today recorded again after a forget is right', async () => {
    await setup();
    const today = new Date().toISOString().slice(0, 10);
    await fake.hset(ctxKey('history:net-worth'), { [today]: await encrypt('105') });
    await fake.hset(ctxKey('history:accounts'), { [today]: await enc({ acct_old: 100, acct_other: 5 }) });
    await setAccountHidden(ctx, 'acct_old', 'depository', true);
    await forget('acct_old');
    expect((await series()).find((p) => p.date === today)!.value).toBe(5);
    const { recordSnapshot } = await import('@/lib/history');
    await recordSnapshot(ctx, 5, { acct_other: 5 });
    expect((await series()).find((p) => p.date === today)!.value).toBe(5);
  });

  test('two forgotten hidden accounts on one day are both folded out', async () => {
    await setup();
    await fake.hset(ctxKey('history:accounts'), { '2026-01-01': await enc({ acct_old: 100, acct_two: 30, acct_other: 5 }) });
    await fake.hset(ctxKey('history:net-worth'), { '2026-01-01': await encrypt('135') });
    await links.recordDirectory(ctx, [{ item_id: 'item_two', institution_name: 'Ally', institution_id: 'ins_9', error: null, accounts: [{ ...account('acct_two'), mask: '2222' }] } as any], Date.now() - DAY);
    await setAccountHidden(ctx, 'acct_old', 'depository', true);
    await setAccountHidden(ctx, 'acct_two', 'depository', true);
    expect((await forget('acct_old')).status).toBe(200);
    expect((await forget('acct_two')).status).toBe(200);
    expect(await storedTotal('history:net-worth', '2026-01-01')).toBe(5);
  });

  test('an old flat record that can’t be read for now stops a forget before any change', async () => {
    await setup();
    await fake.set(ctxKey('history:accounts:est:flat'), 'v2.k99-00000000.-.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA');
    expect((await forget('acct_old')).status).toBe(500);
    expect(await readMap('history:accounts', '2026-01-01')).toEqual({ acct_old: 100, acct_other: 5 });
  });

  test('a map that can’t be read for now stops the fold before any point changes', async () => {
    await setup();
    await setAccountHidden(ctx, 'acct_old', 'depository', true);
    await fake.hset(ctxKey('history:accounts'), { '2025-12-30': 'v2.k99-00000000.-.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' });
    await fake.hset(ctxKey('history:net-worth'), { '2025-12-30': await encrypt('7') });
    expect((await forget('acct_old')).status).toBe(500);
    expect(await storedTotal('history:net-worth', '2026-01-01')).toBe(105);
  });

  test('hiding, unhiding and dismissing wait for a change in progress', async () => {
    await setup();
    await fake.set(ctxKey('account-links:lock'), 'another request', { nx: true, ex: 300 });
    expect((await route('hidden-accounts', 'POST', { account_id: 'acct_other', hidden: true })).status).toBe(409);
    expect((await route('account-links', 'POST', { action: 'dismiss', old: 'acct_old', to: 'acct_other' })).status).toBe(409);
    expect((await route('account-links', 'DELETE', { old: 'acct_old' })).status).toBe(409);
    await fake.del(ctxKey('account-links:lock'));
  });

  test('a map rewritten meanwhile is re-read, never written over', async () => {
    await setup();
    const evalOrig = fake.eval.bind(fake);
    let raced = false;
    fake.eval = (async (script: string, keys: string[], args: string[]) => {
      if (!raced && script.startsWith('-- nya:history-cas-field') && keys[0] === ctxKey('history:accounts:est')) {
        raced = true; // a backfill rewrites the date first
        await fake.hset(ctxKey('history:accounts:est'), { '2026-01-01': await enc({ acct_old: 100, acct_other: 6 }) });
      }
      return evalOrig(script, keys, args);
    }) as typeof fake.eval;
    try {
      await forget('acct_old');
    } finally {
      fake.eval = evalOrig;
    }
    expect(await readMap('history:accounts:est', '2026-01-01')).toEqual({ acct_other: 6 });
  });

  // Written back by a same-day partial record while the forget ran.
  test('today is scrubbed again at the end', async () => {
    await setup();
    const today = new Date().toISOString().slice(0, 10);
    const hdel = fake.hdel.bind(fake);
    fake.hdel = (async (key: string, ...fields: string[]) => {
      if (key === ctxKey('txn-category-carry')) await fake.hset(ctxKey('history:accounts:partial'), { [today]: await enc({ acct_old: 1, acct_other: 2 }) });
      return hdel(key, ...fields);
    }) as typeof fake.hdel;
    try {
      await forget('acct_old');
    } finally {
      fake.hdel = hdel;
    }
    expect(await readMap('history:accounts:partial', today)).toEqual({ acct_other: 2 });
  });

  // No one can decrypt it, so nothing in it can be read: it doesn't hold the
  // rest back.
  test('a map no one can decrypt is left as it is, and the rest is forgotten', async () => {
    await setup();
    await fake.hset(ctxKey('history:accounts'), { '2025-12-31': 'garbage' });
    expect((await forget('acct_old')).body).toEqual({ forgotten: true, unreadable_days: 1 });
    expect(await fake.hget(ctxKey('accounts:directory'), 'acct_old')).toBeNull();
    expect((await route('account-links', 'GET')).body.earlier).toEqual([]);
  });

  test('one change at a time: a link during a forget is refused, and the lock is released after', async () => {
    await setup();
    await fake.set(ctxKey('account-links:lock'), 'another request', { nx: true, ex: 300 });
    const refused = await forget('acct_old');
    expect(refused.status).toBe(409);
    expect(refused.body.error).toContain('in progress');
    expect((await route('account-links', 'POST', { action: 'link', old: 'acct_old', to: 'acct_other' })).status).toBe(409);
    await fake.del(ctxKey('account-links:lock'));
    expect((await forget('acct_old')).status).toBe(200);
  });

  test('lists nothing to forget when the live accounts can’t be read', async () => {
    await setup();
    const hgetall = fake.hgetall.bind(fake);
    fake.hgetall = (async (key: string) => {
      if (key === ctxKey('accounts:meta')) throw new Error('down');
      return hgetall(key);
    }) as typeof fake.hgetall;
    try {
      expect((await route('account-links', 'GET')).body.earlier).toEqual([]);
    } finally {
      fake.hgetall = hgetall;
    }
  });

  // A retry works out the account's life again: a point folded before the
  // stop must still count toward it, or a day inside it reads as outside.
  test('a retry sees the same life, so a day it can’t tell inside it is still deleted', async () => {
    await setup();
    await fake.hset(ctxKey('history:net-worth'), { '2025-10-01': await encrypt('11'), '2025-10-15': await encrypt('99') });
    await fake.hset(ctxKey('history:accounts'), { '2025-10-01': await enc({ acct_old: 10, acct_other: 1 }) });
    await setAccountHidden(ctx, 'acct_old', 'depository', true);
    const evalOrig = fake.eval.bind(fake);
    let failed = false;
    fake.eval = (async (script: string, keys: string[], args: string[]) => {
      if (!failed && script.startsWith('-- nya:history-fold') && args[0] === '2025-10-15') {
        failed = true;
        const folded = () => [...(fake as any).hashes.entries()].some(([k, h]: [string, Map<string, string>]) => k.includes('history:forgetting:') && h.has('r:2025-10-01'));
        for (let i = 0; i < 100 && !folded(); i++) await Bun.sleep(5);
        throw new Error('down');
      }
      return evalOrig(script, keys, args);
    }) as typeof fake.eval;
    try {
      expect((await forget('acct_old')).status).toBe(500);
    } finally {
      fake.eval = evalOrig;
    }
    expect(await storedTotal('history:net-worth', '2025-10-15')).toBe(99);
    expect((await forget('acct_old')).status).toBe(200);
    expect(await fake.hget(ctxKey('history:net-worth'), '2025-10-15')).toBeNull();
    expect(await storedTotal('history:net-worth', '2025-10-01')).toBe(1);
  });

  // A failed point must not end the request (and free the lock) while the
  // rest of its batch is still writing.
  test('a failure is reported only once every point of its batch has settled', async () => {
    await setup();
    await withEstimated();
    await setAccountHidden(ctx, 'acct_old', 'depository', true);
    const evalOrig = fake.eval.bind(fake);
    let running = 0;
    fake.eval = (async (script: string, keys: string[], args: string[]) => {
      if (!script.startsWith('-- nya:history-fold')) return evalOrig(script, keys, args);
      if (args[0] === '2026-01-01') {
        for (let i = 0; i < 100 && running === 0; i++) await Bun.sleep(1); // another point is writing
        throw new Error('down');
      }
      running++;
      try {
        await Bun.sleep(50);
        return await evalOrig(script, keys, args);
      } finally {
        running--;
      }
    }) as typeof fake.eval;
    try {
      expect((await forget('acct_old')).status).toBe(500);
      expect(running).toBe(0);
    } finally {
      fake.eval = evalOrig;
    }
  });

  // Every point folded, then the last step fails: the progress is already
  // gone, and a retry changes no total a second time.
  test('a forget that fails after the fold leaves no progress behind and folds nothing twice', async () => {
    await setup();
    await withEstimated();
    await setAccountHidden(ctx, 'acct_old', 'depository', true);
    const hdel = fake.hdel.bind(fake);
    let failed = false;
    fake.hdel = (async (key: string, ...fields: string[]) => {
      if (!failed && key === ctxKey('hidden:accounts')) {
        failed = true;
        throw new Error('down');
      }
      return hdel(key, ...fields);
    }) as typeof fake.hdel;
    try {
      expect((await forget('acct_old')).status).toBe(500);
    } finally {
      fake.hdel = hdel;
    }
    expect(failed).toBe(true);
    expect(await leftovers()).toEqual([]);
    expect((await forget('acct_old')).status).toBe(200);
    expect(await storedTotal('history:net-worth', '2026-01-01')).toBe(5);
    expect(await storedTotal('history:net-worth:est', '2025-12-01')).toBe(10);
  });

  test('an account being forgotten can’t be linked, and keeps its mark through a re-hide', async () => {
    await setup();
    await setAccountHidden(ctx, 'acct_old', 'depository', true);
    const { getHiddenAccounts, markForgetting } = await import('@/lib/hidden');
    await markForgetting(ctx, 'acct_old', (await getHiddenAccounts(ctx)).get('acct_old')!, 'tag-1');
    const link = await route('account-links', 'POST', { action: 'link', old: 'acct_old', to: 'acct_other' });
    expect(link.status).toBe(409);
    expect(await fake.hgetall(ctxKey('account-links'))).toBeNull();
    await setAccountHidden(ctx, 'acct_old', 'depository', true);
    expect((await getHiddenAccounts(ctx)).get('acct_old')!.forget_tag).toBe('tag-1');
    // The other side of a link, too.
    await setAccountHidden(ctx, 'acct_other', 'depository', true);
    await markForgetting(ctx, 'acct_other', (await getHiddenAccounts(ctx)).get('acct_other')!, 'tag-2');
    await fake.hset(ctxKey('hidden:accounts'), { acct_old: await encrypt(JSON.stringify({ type: 'depository', hidden_at: 'x' })) });
    expect((await route('account-links', 'POST', { action: 'link', old: 'acct_old', to: 'acct_other' })).status).toBe(409);
  });

  test('a forget that fails still clears the cached payloads', async () => {
    await setup();
    await setAccountHidden(ctx, 'acct_old', 'depository', true);
    const { writeCache, readCache, CacheKey } = await import('@/lib/cache');
    await writeCache(ctx, CacheKey.NetWorth, { stale: true });
    const evalOrig = fake.eval.bind(fake);
    fake.eval = (async (script: string, keys: string[], args: string[]) => {
      if (script.startsWith('-- nya:history-fold')) throw new Error('down');
      return evalOrig(script, keys, args);
    }) as typeof fake.eval;
    try {
      expect((await forget('acct_old')).status).toBe(500);
    } finally {
      fake.eval = evalOrig;
    }
    expect(await readCache(ctx, CacheKey.NetWorth)).toBeNull();
  });

  // A backfill and a snapshot write each date's breakdown before its total:
  // a fold reading between them sees a new breakdown beside an old total,
  // which its compare-and-set refuses, never an old breakdown it would trust.
  test('backfill and snapshots write the breakdowns before the totals', async () => {
    await addItem('item_a', 'acct_a', [row('a1', 'acct_a', { date: daysAgo(20) })]);
    await route('transactions', 'GET');
    const order: string[] = [];
    const note = (key: string) => {
      const name = key.slice(key.indexOf(':history:') + 1);
      if (name.startsWith('history:') && order.at(-1) !== name) order.push(name);
    };
    const hset = fake.hset.bind(fake);
    const set = fake.set.bind(fake);
    fake.hset = (async (key: string, fields: any) => (note(key), hset(key, fields))) as typeof fake.hset;
    fake.set = (async (key: string, ...a: any[]) => (note(key), (set as any)(key, ...a))) as typeof fake.set;
    try {
      const res = await route('backfill', 'POST');
      expect(res.body.backfilled).toBeGreaterThan(0);
      const at = (name: string) => order.indexOf(name);
      expect(at('history:net-worth:est')).toBeGreaterThan(at('history:accounts:est'));
      expect(at('history:net-worth:est')).toBeGreaterThan(at('history:accounts:est:flatd'));
      order.length = 0;
      const { recordSnapshot } = await import('@/lib/history');
      await recordSnapshot(ctx, 100, { acct_a: 100 });
      expect(order.indexOf('history:net-worth')).toBeGreaterThan(order.indexOf('history:accounts'));
      expect(order.indexOf('history:accounts')).toBeGreaterThanOrEqual(0);
    } finally {
      fake.hset = hset;
      fake.set = set;
    }
  });

  // A backfill that fetched from an institution disconnected (and maybe an
  // account of it forgotten) while it ran writes nothing.
  test('a backfill whose institution was disconnected meanwhile writes nothing', async () => {
    await addItem('item_a', 'acct_a', [row('a1', 'acct_a', { date: daysAgo(20) })]);
    await route('transactions', 'GET');
    const plaid: any = (await import('@/lib/plaid')).plaidClient;
    const balances = plaid.accountsGet;
    plaid.accountsGet = async (req: any) => {
      await route('disconnect', 'POST', { item_id: 'item_a' });
      return balances(req);
    };
    try {
      expect((await route('backfill', 'POST')).body).toEqual({ skipped: true, reason: 'institutions changed' });
    } finally {
      plaid.accountsGet = balances;
    }
    expect(await fake.hgetall(ctxKey('history:net-worth:est'))).toBeNull();
    expect(await fake.hgetall(ctxKey('history:accounts:est'))).toBeNull();
  });

  // Backups are environment-wide, but the dashboard is where anyone looks.
  test('the dashboard payload says when the nightly backup failed', async () => {
    const { recordOutcome } = await import('@/lib/backup');
    expect((await route('net-worth', 'GET')).body.backup_problem).toBeNull();
    await recordOutcome({ ok: false, reason: 'down' });
    expect((await route('net-worth', 'GET')).body.backup_problem).toEqual({ last_ok: null, reason: 'down' });
  });

  // The chart reads through a cache of decrypted maps: a forgotten account's
  // balances must not come back from it, or stay in memory.
  test('the chart never serves a map from before it was rewritten', async () => {
    await setup();
    const { getHistory, isDecryptedCached } = await import('@/lib/history');
    await setAccountHidden(ctx, 'acct_other', 'depository', true); // reads the maps through the cache
    const oldBlob = (await fake.hget<string>(ctxKey('history:accounts'), '2026-01-01'))!;
    const hiddenOther = (await links.getEffectiveHidden(ctx)).hidden;
    expect((await getHistory(ctx, hiddenOther)).find((p) => p.date === '2026-01-01')!.value).toBe(100);
    expect(isDecryptedCached(oldBlob)).toBe(true);
    await forget('acct_old');
    expect(isDecryptedCached(oldBlob)).toBe(false);
    expect((await getHistory(ctx, hiddenOther)).find((p) => p.date === '2026-01-01')!.value).toBe(100);
    const { getAccountHistory } = await import('@/lib/history');
    expect(await getAccountHistory(ctx, 'acct_old', [])).toEqual([]);
  });
});

describe('the decrypted-map cache', () => {
  test('keeps what was used most recently within its byte budget', async () => {
    const { getHistory, isDecryptedCached, setDecryptedBudget } = await import('@/lib/history');
    const enc = async (m: unknown) => encrypt(JSON.stringify(m));
    for (const d of ['2026-01-01', '2026-01-02', '2026-01-03']) {
      await fake.hset(ctxKey('history:net-worth'), { [d]: await encrypt('10') });
      await fake.hset(ctxKey('history:accounts'), { [d]: await enc({ a: 1, [d]: 1 }) });
    }
    const blob = async (d: string) => (await fake.hget<string>(ctxKey('history:accounts'), d))!;
    const one = (await blob('2026-01-01')).length * 6;
    setDecryptedBudget(one * 2 + 10); // room for two
    try {
      const hidden = new Map([['a', { type: 'depository', hidden_at: 'x' }]]);
      await getHistory(ctx, hidden);
      const cached = await Promise.all(['2026-01-01', '2026-01-02', '2026-01-03'].map(async (d) => isDecryptedCached(await blob(d))));
      expect(cached.filter(Boolean).length).toBe(2);
    } finally {
      setDecryptedBudget(16 * 1024 * 1024);
    }
  });
});

describe('the decrypted-map cache order', () => {
  test('a map used again is kept over one used longer ago', async () => {
    const { decryptMapForTest, isDecryptedCached, setDecryptedBudget } = await import('@/lib/history');
    const [a, b, c] = await Promise.all([1, 2, 3].map((n) => encrypt(JSON.stringify({ x: n }))));
    setDecryptedBudget(a.length * 6 * 2 + 10); // room for two
    try {
      await decryptMapForTest(a);
      await decryptMapForTest(b);
      await decryptMapForTest(a); // used again
      await decryptMapForTest(c);
      expect([isDecryptedCached(a), isDecryptedCached(b), isDecryptedCached(c)]).toEqual([true, false, true]);
    } finally {
      setDecryptedBudget(16 * 1024 * 1024);
    }
  });
});

describe('linking a bank', () => {
  // Plaid expects one id per end user; the container's says nothing about who.
  test('names the account’s container to Plaid, never a shared id', async () => {
    const { TEST_CONTAINER } = await import('./fake-redis');
    expect((await route('create-link-token', 'POST')).body.user).toEqual({ client_user_id: TEST_CONTAINER });
  });
});

describe('a user with nothing connected', () => {
  // Coming back after a lapse: every institution was disconnected, and the
  // hidden accounts still need their names on the Hidden card.
  test('sees hidden disconnected accounts by name', async () => {
    await addItem('item_old', 'acct_old', [], Date.now() - DAY);
    await setAccountHidden(ctx, 'acct_old', 'depository', true);
    await route('disconnect', 'POST', { item_id: 'item_old' });
    const { forClient, liveOk } = await links.getEffectiveHidden(ctx, { describe: true });
    expect(liveOk).toBe(true);
    expect(forClient).toEqual([{ account_id: 'acct_old', type: 'depository', label: 'Chase Checking ••4821', disconnected: true }]);
  });
});

describe('overrides left behind', () => {
  test('a disconnect prunes overrides no stored Item has, unless a store is behind', async () => {
    await addItem('item_a', 'acct_a', [row('a1', 'acct_a')], Date.now() - DAY);
    await addItem('item_b', 'acct_b', [row('b1', 'acct_b', { amount: 7 })]);
    await route('transactions', 'GET');
    await overrides.setOverride(ctx, 'b1', 'kept');
    await overrides.setOverride(ctx, 'gone_long_ago', 'orphan');
    await fake.set(ctxKey('txns-blocked:item_b'), JSON.stringify({ at: 'x', chars: 9 }));
    await route('disconnect', 'POST', { item_id: 'item_a' });
    expect(await fake.hget(ctxKey('txn-category-overrides'), 'gone_long_ago')).not.toBeNull(); // item_b is behind
    await fake.del(ctxKey('txns-blocked:item_b'));
    await addItem('item_c', 'acct_c', []);
    await route('disconnect', 'POST', { item_id: 'item_c' });
    expect(await fake.hget(ctxKey('txn-category-overrides'), 'gone_long_ago')).toBeNull();
    expect(await fake.hget(ctxKey('txn-category-overrides'), 'b1')).not.toBeNull();
  });
});

describe('overrides on rows not yet stored', () => {
  // A sync whose write failed still shows its rows; a category set on one
  // must survive another institution's disconnect.
  test('a store behind after a failed write keeps its categories through a prune', async () => {
    await addItem('item_a', 'acct_a', [row('a1', 'acct_a')], Date.now() - DAY);
    const set = fake.set.bind(fake);
    let failing = true;
    fake.set = (async (key: string, value: string, opts?: any) => {
      if (failing && key === ctxKey('txns:item_a')) throw new Error('down');
      return set(key, value, opts);
    }) as typeof fake.set;
    try {
      expect(await categoryOf('a1')).toBe('food and drink'); // shown, not stored
    } finally {
      fake.set = set;
      failing = false;
    }
    await route('recategorize', 'POST', { transaction_id: 'a1', category: 'treats' });
    await addItem('item_b', 'acct_b', []);
    await route('disconnect', 'POST', { item_id: 'item_b' });
    expect(await fake.hget(ctxKey('txn-category-overrides'), 'a1')).not.toBeNull();
    // The next write lands and clears the mark.
    await route('transactions', 'GET');
    expect(await fake.get(ctxKey('txns-unsaved:item_a'))).toBeNull();
  });

  // A category set while the prune reads the stores is on a row the store
  // it reads next will have: it must never be taken for an orphan.
  test('a category set while a prune runs is kept', async () => {
    await addItem('item_a', 'acct_a', [row('a1', 'acct_a')], Date.now() - DAY);
    await route('transactions', 'GET');
    const get = fake.get.bind(fake);
    let once = true;
    fake.get = (async (key: string) => {
      if (once && key === ctxKey('txns:item_a')) {
        once = false;
        await overrides.setOverride(ctx, 'just_now', 'treats');
      }
      return get(key);
    }) as typeof fake.get;
    try {
      await overrides.pruneOrphanOverrides(ctx, ['item_a']);
    } finally {
      fake.get = get;
    }
    expect(await fake.hget(ctxKey('txn-category-overrides'), 'just_now')).not.toBeNull();
  });
});

describe('recording categories on disconnect', () => {
  const stored = (over: Record<string, unknown>) =>
    ({
      transaction_id: 't1',
      account_id: 'acct_old',
      amount: 4.5,
      date: '2026-09-01',
      name: 'BLUE BOTTLE',
      merchant_name: 'Blue Bottle',
      merchant_entity_id: null,
      institution_name: 'Chase',
      pending: false,
      ...over,
    }) as any;
  const KEY = 'acct_old|2026-09-01|450|blue bottle';

  test('records only overridden, posted rows, one encrypted record per account', async () => {
    await overrides.setOverride(ctx, 't1', 'treats');
    await overrides.setOverride(ctx, 't_pending', 'treats');
    const n = await overrides.retireOverrides(ctx, [
      stored({}),
      stored({ transaction_id: 't_pending', pending: true, date: '2026-09-02' }),
      stored({ transaction_id: 't_plain', date: '2026-09-03' }),
    ]);
    expect(n).toBe(1);
    expect([...(await overrides.getCarried(ctx))]).toEqual([['acct_old', { [KEY]: 'treats' }]]);
    // The Item's own overrides go: their categories live on in the record.
    expect(await fake.hget(ctxKey('txn-category-overrides'), 't1')).toBeNull();
    expect(await fake.hget(ctxKey('txn-category-overrides'), 't_pending')).toBeNull();
    // Filed under the account id: no date, amount or merchant in the clear.
    const raw = (await fake.hgetall<Record<string, string>>(ctxKey('txn-category-carry')))!;
    expect(Object.keys(raw)).toEqual(['acct_old']);
    expect(Object.values(raw)[0]).not.toContain('blue');
  });

  // Only one of two identical rows was recategorized: which new row is "it"
  // can't be told, so neither gets the category.
  test('an identical row left as it was makes the key ambiguous', async () => {
    await overrides.setOverride(ctx, 't1', 'treats');
    await overrides.retireOverrides(ctx, [stored({}), stored({ transaction_id: 't_twin' })]);
    expect([...(await overrides.getCarried(ctx))]).toEqual([['acct_old', { [KEY]: null }]]);
  });

  test('a later retirement of the same account merges, and a disagreement becomes ambiguous', async () => {
    await overrides.setOverride(ctx, 't1', 'treats');
    await overrides.retireOverrides(ctx, [stored({})]);
    await overrides.setOverride(ctx, 't9', 'work');
    await overrides.setOverride(ctx, 't10', 'rent');
    await overrides.retireOverrides(ctx, [stored({ transaction_id: 't9' }), stored({ transaction_id: 't10', date: '2026-09-05' })]);
    expect((await overrides.getCarried(ctx)).get('acct_old')).toEqual({ [KEY]: null, 'acct_old|2026-09-05|450|blue bottle': 'rent' });
  });

  // Plaid's enrichment can change between Items; the bank's descriptor doesn't.
  test('the key ignores the merchant Plaid enriched a row to', async () => {
    const { contentKey } = await import('@/lib/transactions');
    const a = contentKey('x', stored({ merchant_name: null, merchant_entity_id: null }));
    const b = contentKey('x', stored({ merchant_name: 'Blue Bottle Coffee', merchant_entity_id: 'm_1', institution_name: 'Chase Bank' }));
    expect(a).toBe(b);
    expect(contentKey('x', stored({ name: '  Blue   BOTTLE ' }))).toBe(a);
  });

  test('carries nothing until the account is linked, and follows a chain of links', () => {
    const carried = new Map([['acct_a', { 'acct_a|2026-09-01|450|blue bottle': 'treats' }]]);
    expect(overrides.carriedCategories(carried, new Map()).size).toBe(0);
    const chain = new Map([
      ['acct_a', { to: 'acct_b', linked_at: '2026-09-02', evidence: {} }],
      ['acct_b', { to: 'acct_c', linked_at: '2026-09-03', evidence: {} }],
    ]);
    expect([...overrides.carriedCategories(carried, chain)]).toEqual([['acct_c|2026-09-01|450|blue bottle', 'treats']]);
  });

  test('two earlier ids that disagree on a row carry nothing for it, and agreeing ones carry', () => {
    const rest = '|2026-09-01|450|blue bottle';
    const both = new Map([
      ['acct_a', { to: 'acct_c', linked_at: '2026-09-02', evidence: {} }],
      ['acct_b', { to: 'acct_c', linked_at: '2026-09-03', evidence: {} }],
    ]);
    const disagree = new Map<string, Record<string, string | null>>([
      ['acct_a', { [`acct_a${rest}`]: 'treats' }],
      ['acct_b', { [`acct_b${rest}`]: 'work' }],
    ]);
    expect(overrides.carriedCategories(disagree, both).size).toBe(0);
    const agree = new Map<string, Record<string, string | null>>([
      ['acct_a', { [`acct_a${rest}`]: 'treats' }],
      ['acct_b', { [`acct_b${rest}`]: 'treats' }],
    ]);
    expect(overrides.carriedCategories(agree, both).size).toBe(1);
  });
});

const hasRedis = Bun.which('redis-server') !== null;
describe.skipIf(!hasRedis && !process.env.CI)('the history compare-and-set scripts, on a real Redis', () => {
  let real: RealRedis | null = null;
  let r: InstanceType<typeof Bun.RedisClient>;
  const evalScript = (script: string, keys: string[], args: string[]) => r.send('EVAL', [script, String(keys.length), ...keys, ...args]);

  beforeEach(async () => {
    if (!real) {
      real = await startRedis();
      r = real.client;
    }
    await r.send('FLUSHALL', []);
  });
  afterAll(() => {
    real?.stop();
    real = null;
  });

  test('the account-links lock is released only by the request holding it', async () => {
    const { RELEASE_LOCK: script } = await import('@/lib/links');
    await r.send('SET', ['lock', 'mine']);
    expect(await evalScript(script, ['lock'], ['theirs'])).toBe(0);
    expect(await r.send('GET', ['lock'])).toBe('mine');
    expect(await evalScript(script, ['lock'], ['mine'])).toBe(1);
    expect(await r.send('EXISTS', ['lock'])).toBe(0);
  });

  test('a point folds in one step, only while total and maps hold what was read', async () => {
    const { HISTORY_FOLD, HISTORY_SET_IF_ABSENT } = await import('@/lib/history');
    await r.send('HSET', ['tot', 'd', 't0']);
    await r.send('HSET', ['m1', 'd', 'a0']);
    const fold = (total: string, newTotal: string, m1: [string, string], m2: [string, string]) =>
      evalScript(HISTORY_FOLD, ['tot', 'prog', 'm1', 'm2'], ['d', 'r:d', total, newTotal, ...m1, ...m2]);
    expect(await fold('other', 't1', ['a0', 'a1'], ['', ''])).toBe(0);
    expect(await fold('t0', 't1', ['a0', 'a1'], ['x', ''])).toBe(0); // m2 isn't there
    expect(await r.send('HGET', ['tot', 'd'])).toBe('t0');
    expect(await r.send('EXISTS', ['prog'])).toBe(0);
    expect(await fold('t0', 't1', ['a0', 'a1'], ['', ''])).toBe(1);
    expect(await r.send('HGET', ['tot', 'd'])).toBe('t1');
    expect(await r.send('HGET', ['m1', 'd'])).toBe('a1');
    expect(await r.send('HEXISTS', ['m2', 'd'])).toBe(0);
    expect(await r.send('HGET', ['prog', 'r:d'])).toBe('1');
    expect(await fold('t1', '-', ['a1', 'a1'], ['', ''])).toBe(2); // folded already: nothing
    expect(await r.send('HGET', ['tot', 'd'])).toBe('t1');
    const foldAgain = (field: string, total: string, newTotal: string, m1: [string, string]) =>
      evalScript(HISTORY_FOLD, ['tot', 'prog', 'm1', 'm2'], ['d', field, total, newTotal, ...m1, '', '']);
    expect(await foldAgain('e:d', 't1', '-', ['a1', 'a1'])).toBe(1); // delete, maps as they are
    expect(await r.send('HEXISTS', ['tot', 'd'])).toBe(0);
    expect(await r.send('HGET', ['m1', 'd'])).toBe('a1');
    expect(await evalScript(HISTORY_SET_IF_ABSENT, ['h'], ['f', 'v1'])).toBe(1);
    expect(await evalScript(HISTORY_SET_IF_ABSENT, ['h'], ['f', 'v2'])).toBe(0);
    expect(await r.send('HGET', ['h', 'f'])).toBe('v1');
  });

  test('a field or value is rewritten only while it still holds what was read', async () => {
    const { HISTORY_CAS_FIELD, HISTORY_CAS_VALUE } = await import('@/lib/history');
    await r.send('HSET', ['h', 'd', 'old']);
    expect(await evalScript(HISTORY_CAS_FIELD, ['h'], ['d', 'other', 'new'])).toBe(0);
    expect(await r.send('HGET', ['h', 'd'])).toBe('old');
    expect(await evalScript(HISTORY_CAS_FIELD, ['h'], ['d', 'old', 'new'])).toBe(1);
    expect(await r.send('HGET', ['h', 'd'])).toBe('new');
    await r.send('SET', ['s', 'old']);
    expect(await evalScript(HISTORY_CAS_VALUE, ['s'], ['other', 'new'])).toBe(0);
    expect(await evalScript(HISTORY_CAS_VALUE, ['s'], ['old', 'new'])).toBe(1);
    expect(await r.send('GET', ['s'])).toBe('new');
  });
});
