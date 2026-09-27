import { describe, expect, test, mock, beforeEach, afterEach } from 'bun:test';
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
    expect(listed.map((l: any) => l.categories)).toEqual([{ total: 1, carried: 1 }]);

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
    expect((await route('account-links', 'GET')).body.links[0].categories).toEqual({ total: 2, carried: 0 });
    await route('transactions', 'GET');
    expect((await route('account-links', 'GET')).body.links[0].categories).toEqual({ total: 2, carried: 1 });
  });

  test('a hidden account of a connected institution that stopped reporting is not called disconnected', async () => {
    await addItem('item_1', 'acct_1', []);
    // acct_closed was seen under item_1 but the bank no longer returns it.
    await links.recordDirectory(ctx, [{ item_id: 'item_1', institution_name: 'Chase', institution_id: 'ins_3', error: null, accounts: [{ ...account('acct_closed'), mask: '0001' }] } as any]);
    await rememberAccounts(ctx, [{ item_id: 'item_1', institution_name: 'Chase', error: null, accounts: [{ ...account('acct_1'), balance: 1 }] } as any]);
    await setAccountHidden(ctx, 'acct_closed', 'depository', true);
    expect((await links.getEffectiveHidden(ctx)).forClient).toEqual([
      { account_id: 'acct_closed', type: 'depository', label: 'Chase Checking ••0001', disconnected: false },
    ]);
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
    expect((await route('account-links', 'GET')).body.links[0].categories).toEqual({ total: 1, carried: 0 });
  });

  test('a hidden account stays hidden through the disconnect, is named on the Hidden card, and its re-added self is hidden once linked', async () => {
    await before();
    await setAccountHidden(ctx, 'acct_old', 'depository', true);
    await route('disconnect', 'POST', { item_id: 'item_old' });
    await readd();

    const { forClient, hidden } = await links.getEffectiveHidden(ctx);
    expect(forClient).toEqual([
      { account_id: 'acct_old', type: 'depository', label: 'Chase Checking ••4821', disconnected: true },
    ]);
    expect(hidden.has('acct_new')).toBe(false); // not the same account yet

    await route('account-links', 'POST', { action: 'link', old: 'acct_old', to: 'acct_new' });
    const after = await links.getEffectiveHidden(ctx);
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
    expect((await links.getEffectiveHidden(ctx)).forClient).toEqual([]);
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

  test('records only overridden, posted rows', async () => {
    await overrides.setOverride(ctx, 't1', 'treats');
    await overrides.setOverride(ctx, 't_pending', 'treats');
    const n = await overrides.retireOverrides(ctx, [
      stored({}),
      stored({ transaction_id: 't_pending', pending: true, date: '2026-09-02' }),
      stored({ transaction_id: 't_plain', date: '2026-09-03' }),
    ]);
    expect(n).toBe(1);
    expect([...(await overrides.getCarried(ctx)).values()]).toEqual([{ account_id: 'acct_old', category: 'treats' }]);
  });

  test('carries nothing until the account is linked, and follows a chain of links', () => {
    const carried = new Map([['acct_a|2026-09-01|450|nm:chase::blue bottle', { account_id: 'acct_a', category: 'treats' }]]);
    expect(overrides.carriedCategories(carried, new Map()).size).toBe(0);
    const chain = new Map([
      ['acct_a', { to: 'acct_b', linked_at: '2026-09-02', evidence: {} }],
      ['acct_b', { to: 'acct_c', linked_at: '2026-09-03', evidence: {} }],
    ]);
    expect([...overrides.carriedCategories(carried, chain)]).toEqual([['acct_c|2026-09-01|450|nm:chase::blue bottle', 'treats']]);
  });

  test('two earlier ids that disagree on a row carry nothing for it', () => {
    const rest = '|2026-09-01|450|nm:chase::blue bottle';
    const carried = new Map([
      [`acct_a${rest}`, { account_id: 'acct_a', category: 'treats' }],
      [`acct_b${rest}`, { account_id: 'acct_b', category: 'work' }],
    ]);
    const both = new Map([
      ['acct_a', { to: 'acct_c', linked_at: '2026-09-02', evidence: {} }],
      ['acct_b', { to: 'acct_c', linked_at: '2026-09-03', evidence: {} }],
    ]);
    expect(overrides.carriedCategories(carried, both).size).toBe(0);
  });
});
