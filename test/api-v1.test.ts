import { describe, expect, test, mock, beforeEach, afterEach, beforeAll } from 'bun:test';
import './clerk-mock';
import { FakeRedis, storageMock, testKey, ctxKey, TEST_CTX, TEST_CONTAINER, registerTestContainer, unscopedDataKeys } from './fake-redis';

// The read-only API (app/api/v1, lib/api-read.ts): every endpoint's answer,
// from stored data alone, with hidden accounts and other people's data never
// in it, and Plaid never called.

process.env.PLAID_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');

// Plaid must never be reached: any use of the client is recorded, and fails.
const plaidTouched: string[] = [];
mock.module('@/lib/plaid', () => ({
  plaidClient: new Proxy(
    {},
    {
      get(_target, prop) {
        if (typeof prop === 'string') plaidTouched.push(prop);
        return async () => {
          throw new Error('Plaid must not be called by the API');
        };
      },
    }
  ),
}));

const fake = new FakeRedis({ deserialize: true });
mock.module('@/lib/storage', () => storageMock(fake));
afterEach(() => expect(unscopedDataKeys(fake)).toEqual([]));

const { encrypt } = await import('@/lib/crypto');
const { encodeJsonBlob } = await import('@/lib/blob');
const { saveItem } = await import('@/lib/storage');
const { saveManualAccount } = await import('@/lib/manual');
const { setAccountHidden } = await import('@/lib/hidden');
const { setOverride } = await import('@/lib/overrides');
const { setRename } = await import('@/lib/renames');
const { setBudgets } = await import('@/lib/budgets');
const { setExcluded } = await import('@/lib/txn-annotations');
const { manualTxnStore } = await import('@/lib/manual-txns');
const { syncsStore, noticesStore, warningsStore } = await import('@/lib/connection-records');
const { recordHoldings, observeHoldings } = await import('@/lib/holdings-history');
const { vendorKey } = await import('@/lib/transactions');
const { createToken, revokeToken, REQUESTS_PER_MINUTE } = await import('@/lib/api-tokens');
const { OPERATIONS } = await import('@/lib/api-ops');
const { forgetEpochs } = await import('@/lib/sessions');
const { config } = await import('@/proxy');

const routes: Record<string, any> = {};
for (const op of OPERATIONS) routes[op.name] = await import(`@/app/api/v1/${op.name}/route`);

const ctx = TEST_CTX;
const OTHER = { container: '9c1d2e3f-4a5b-4c6d-8e7f-0a1b2c3d4e5f' } as typeof TEST_CTX;
const DAY = 86_400_000;
/** A UTC day relative to now, so the transactions stay inside the window the
 *  app reads (the last 365 days) whenever the tests run. */
const daysAgo = (n: number) => new Date(Date.now() - n * DAY).toISOString().slice(0, 10);
const month = daysAgo(0).slice(0, 7);

// ---- A container with a bit of everything ----

const remembered = (accounts: Record<string, unknown>[]) =>
  encrypt(JSON.stringify(accounts.map((a) => ({ official_name: null, subtype: null, mask: null, limit: null, currency: 'USD', ...a }))));

function txn(id: string, account_id: string, daysBack: number, amount: number, over: Record<string, unknown> = {}) {
  return {
    transaction_id: id,
    pending_transaction_id: null,
    account_id,
    amount,
    iso_currency_code: 'USD',
    unofficial_currency_code: null,
    date: daysAgo(daysBack),
    authorized_date: null,
    authorized_datetime: null,
    datetime: null,
    name: id.toUpperCase(),
    merchant_name: null,
    merchant_entity_id: null,
    website: null,
    logo_url: null,
    personal_finance_category: null,
    personal_finance_category_icon_url: null,
    pending: false,
    payment_channel: 'in store',
    transaction_code: null,
    transaction_type: null,
    check_number: null,
    account_owner: null,
    location: null,
    payment_meta: null,
    counterparties: [],
    category: 'general merchandise',
    account_name: 'Checking',
    institution_name: 'Chase',
    ...over,
  };
}

const CHASE_TXNS = [
  txn('t_coffee', 'acc_chk', 2, 5.5, { name: 'BLUE BOTTLE 123', merchant_name: 'Blue Bottle', merchant_entity_id: 'm_bb', category: 'food and drink' }),
  txn('t_rent', 'acc_chk', 3, 1200, { category: 'rent and utilities' }),
  txn('t_pay', 'acc_chk', 4, -3000, { category: 'income' }),
  txn('t_transfer', 'acc_chk', 5, 500, { category: 'transfer out', transaction_code: 'transfer' }),
  txn('t_atm', 'acc_chk', 5, 100, { category: 'general merchandise', transaction_code: 'atm' }),
  txn('t_fee', 'acc_chk', 6, 35, { category: 'bank fees' }),
  txn('t_loan', 'acc_chk', 6, 400, { category: 'loan payments' }),
  txn('t_paris', 'acc_card', 7, 50, { iso_currency_code: 'EUR', category: 'travel', account_name: 'Card' }),
  txn('t_card', 'acc_card', 8, 80, { category: 'general merchandise', account_name: 'Card' }),
  txn('t_big', 'acc_chk', 9, 2000, { category: 'general merchandise' }),
  txn('t_hidden', 'acc_save', 3, 999, { name: 'HIDDEN-ACCOUNT-ROW', account_name: 'Savings' }),
  // A pending charge its posted row has replaced: shown once.
  txn('t_pending', 'acc_chk', 1, 12, { pending: true, name: 'PENDING-SUPERSEDED' }),
  txn('t_posted', 'acc_chk', 1, 12, { pending_transaction_id: 't_pending', name: 'Posted lunch', category: 'food and drink' }),
  // Older than the window the app shows.
  txn('t_ancient', 'acc_chk', 400, 9, { name: 'ANCIENT' }),
  // A subscription, about monthly (31 days apart, so always in three months).
  ...[26, 57, 88].map((d, i) => txn(`t_flix${i}`, 'acc_chk', d, 15.99, { name: 'NETFLIX.COM', merchant_name: 'Netflix', category: 'entertainment' })),
];

const SYNCED_AT = new Date(Date.now() - 2 * 3600_000).toISOString();

async function seedPerson() {
  await saveItem(ctx, { item_id: 'item_chase', institution_name: 'Chase', encrypted_access_token: await encrypt('access-sandbox-secret') });
  await saveItem(ctx, { item_id: 'item_broker', institution_name: 'Broker', encrypted_access_token: await encrypt('access-sandbox-secret-2') });
  await saveItem(ctx, { item_id: 'item_new', institution_name: 'NewBank', encrypted_access_token: await encrypt('access-sandbox-secret-3') });
  await fake.hset(ctxKey('accounts:meta'), {
    item_chase: await remembered([
      { account_id: 'acc_chk', name: 'Checking', type: 'depository', subtype: 'checking', mask: '1111' },
      { account_id: 'acc_card', name: 'Card', type: 'credit', subtype: 'credit card', mask: '2222', limit: 5000 },
      { account_id: 'acc_save', name: 'Savings', type: 'depository', subtype: 'savings', mask: '3333' },
    ]),
    item_broker: await remembered([{ account_id: 'acc_ira', name: 'IRA', type: 'investment', subtype: 'ira', mask: '4444' }]),
  });
  // Balances as recorded: two full days, and a newer partial one for checking
  // (the broker failed that day).
  const map = (m: Record<string, number>) => encrypt(JSON.stringify(m));
  await fake.hset(ctxKey('history:accounts'), {
    [daysAgo(3)]: await map({ acc_chk: 1000, acc_card: 250, acc_save: 5000, acc_ira: 20000, manual_house: 300000 }),
    [daysAgo(2)]: await map({ acc_chk: 1200, acc_card: 300, acc_save: 5000, acc_ira: 20500, manual_house: 300000 }),
  });
  await fake.hset(ctxKey('history:accounts:partial'), { [daysAgo(1)]: await map({ acc_chk: 1250, acc_card: 310 }) });
  await fake.hset(ctxKey('history:net-worth'), {
    [daysAgo(3)]: await encrypt(String(1000 - 250 + 5000 + 20000 + 300000)),
    [daysAgo(2)]: await encrypt(String(1200 - 300 + 5000 + 20500 + 300000)),
  });
  await fake.hset(ctxKey('history:net-worth:est'), { [daysAgo(10)]: await encrypt('320000') });
  await fake.hset(ctxKey('history:accounts:est'), { [daysAgo(10)]: await map({ acc_chk: 900 }) });
  await fake.hset(ctxKey('snapshot:taken'), { [daysAgo(2)]: `${daysAgo(2)}T13:00:41.000Z` });

  const accounts = {
    acc_chk: { name: 'Checking', official_name: null, type: 'depository', subtype: 'checking', mask: '1111', balances: null },
    acc_card: { name: 'Card', official_name: null, type: 'credit', subtype: 'credit card', mask: '2222', balances: null },
    acc_save: { name: 'Savings', official_name: null, type: 'depository', subtype: 'savings', mask: '3333', balances: null },
  };
  await fake.set(
    ctxKey('txns:item_chase'),
    await encodeJsonBlob({ schema_version: 2, cursor: 'c1', accounts, txns: Object.fromEntries(CHASE_TXNS.map((t) => [t.transaction_id, t])), synced_at: SYNCED_AT })
  );
  // The broker's store was last saved before sync times were kept.
  await fake.set(ctxKey('txns:item_broker'), await encodeJsonBlob({ schema_version: 2, cursor: 'c2', accounts: {}, txns: {} }));

  await setAccountHidden(ctx, 'acc_save', 'depository', true);
  await setOverride(ctx, 't_rent', 'housing');
  await setRename(ctx, vendorKey({ merchant_entity_id: 'm_bb', merchant_name: 'Blue Bottle', name: 'BLUE BOTTLE 123', institution_name: 'Chase' }), 'Coffee place');
  await setExcluded(ctx, 't_big', true);

  const updated = new Date(Date.now() - 5 * 3600_000).toISOString();
  await saveManualAccount(ctx, { account_id: 'manual_house', name: 'House', institution_name: 'Property', type: 'other', subtype: null, balance: 300000, updated_at: updated });
  await saveManualAccount(ctx, { account_id: 'manual_wallet', name: 'Wallet', institution_name: 'Cash', type: 'depository', subtype: 'cash', balance: 40, updated_at: updated });
  const now = new Date().toISOString();
  await manualTxnStore.set(ctx, 'manual_wallet', {
    version: 1,
    rows: [
      { id: 'manual-txn:5a0c1d2e-3f40-4a5b-8c6d-7e8f9a0b1c2d', account_id: 'manual_wallet', date: daysAgo(1), amount: 25, currency: 'USD', name: 'Farmers market', category: 'food and drink', note: 'apples', source: 'manual', source_id: null, created_at: now, updated_at: now },
    ],
  });

  await setBudgets(ctx, { 'food and drink': 100, housing: 1500, travel: 200 });

  await syncsStore.set(ctx, 'item_chase', { at: SYNCED_AT });
  await noticesStore.set(ctx, 'item_broker', { episode: 'e1', since: `${daysAgo(1)}T13:00:00.000Z`, state: 'needs_reauth', notified_at: null, reminded_at: null });
  await warningsStore.set(ctx, 'item_chase', {
    kind: 'pending_expiration',
    received_at: SYNCED_AT,
    ends_at: new Date(Date.now() + 5 * DAY).toISOString(),
    ends_estimated: false,
    reason: null,
  });

  const accountsSeen = [{ account_id: 'acc_ira', type: 'investment', balance: 20500 }];
  await recordHoldings(ctx, [
    {
      error: null,
      accounts: accountsSeen,
      holdings_observed: observeHoldings({
        accounts: accountsSeen,
        holdings: [{ account_id: 'acc_ira', security_id: 'sec_vti', quantity: 80, institution_price: 250, institution_price_as_of: daysAgo(1), institution_value: 20000, cost_basis: 15000, iso_currency_code: 'USD', unofficial_currency_code: null }],
        securities: [{ security_id: 'sec_vti', ticker_symbol: 'VTI', name: 'Vanguard Total Stock Market ETF', type: 'etf', is_cash_equivalent: false }],
      })!,
    },
  ]);
}

/** Someone else's container: none of it may ever show for the first one's token. */
async function seedOther() {
  await fake.hset(testKey('containers'), { [OTHER.container]: JSON.stringify({ status: 'active', primary: false, created_at: '2026-02-01T00:00:00.000Z' }) });
  await saveItem(OTHER, { item_id: 'item_other', institution_name: 'OtherBank', encrypted_access_token: await encrypt('access-sandbox-other') });
  await fake.hset(ctxKey('accounts:meta', OTHER), { item_other: await remembered([{ account_id: 'acc_other', name: 'OTHER-SECRET-ACCOUNT', type: 'depository' }]) });
  await fake.set(
    ctxKey('txns:item_other', OTHER),
    await encodeJsonBlob({ schema_version: 2, cursor: 'c', accounts: {}, txns: { t_o: txn('t_o', 'acc_other', 1, 77, { name: 'OTHER-SECRET-TXN', institution_name: 'OtherBank' }) } })
  );
  await setBudgets(OTHER, { 'OTHER-SECRET-BUDGET': 5 });
}

let token = '';
let otherToken = '';
const saved = { ...process.env };
beforeEach(async () => {
  fake.reset();
  forgetEpochs();
  delete process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;
  delete process.env.CLERK_SECRET_KEY;
  delete process.env.CONTAINER_ID;
  await registerTestContainer(fake);
  await seedPerson();
  token = (await createToken(ctx, 'Tests')).token;
  plaidTouched.length = 0;
});
afterEach(() => {
  process.env = { ...saved };
  // Whatever the test did, Plaid was never asked.
  expect(plaidTouched).toEqual([]);
});

const call = async (name: string, query = '', headers: Record<string, string> = { authorization: `Bearer ${token}` }) => {
  const res: Response = await routes[name].GET(new Request(`https://nya.test/api/v1/${name}${query ? `?${query}` : ''}`, { headers }));
  return { res, body: (await res.json()) as any };
};
const quietly = async <T>(fn: () => Promise<T>): Promise<T> => {
  const [error, warn] = [console.error, console.warn];
  console.error = console.warn = () => {};
  try {
    return await fn();
  } finally {
    [console.error, console.warn] = [error, warn];
  }
};

describe('getting in', () => {
  test('every endpoint needs a token: a session cookie alone reaches nothing', async () => {
    for (const op of OPERATIONS) {
      for (const headers of [{} as Record<string, string>, { cookie: 'nwt_session=v1.anything.sig' }, { authorization: 'Bearer nya_nope' }, { authorization: `Basic ${token}` }]) {
        const { res, body } = await call(op.name, '', headers);
        expect([op.name, res.status, body]).toEqual([op.name, 401, { error: { code: 'unauthorized', message: 'A valid API token is needed, sent as Authorization: Bearer <token>.' } }]);
        expect(res.headers.get('www-authenticate')).toStartWith('Bearer realm="Nya"');
        expect(res.headers.get('cache-control')).toBe('no-store');
      }
    }
  });

  test('a revoked token is refused at once', async () => {
    const made = await createToken(ctx, 'Brief');
    expect((await call('me', '', { authorization: `Bearer ${made.token}` })).res.status).toBe(200);
    await revokeToken(ctx, made.info.id);
    expect((await call('me', '', { authorization: `Bearer ${made.token}` })).res.status).toBe(401);
  });

  test('another person’s token reads only their own container', async () => {
    await seedOther();
    process.env.CONTAINER_ID = OTHER.container; // their deployment, with the shared password
    forgetEpochs();
    otherToken = (await createToken(OTHER, 'Theirs')).token;
    const theirs = await call('transactions', '', { authorization: `Bearer ${otherToken}` });
    expect(theirs.res.status).toBe(200);
    expect(theirs.body.transactions.map((t: any) => t.id)).toEqual(['t_o']);
    const text = JSON.stringify((await call('accounts', '', { authorization: `Bearer ${otherToken}` })).body);
    expect(text).toContain('OTHER-SECRET-ACCOUNT');
    expect(text).not.toContain('Checking');
    // And this deployment's own token, from the container it no longer serves, is refused.
    expect((await call('me')).res.status).toBe(401);
  });

  test(`${REQUESTS_PER_MINUTE} requests a minute per token, then 429 with when to try again`, async () => {
    for (let i = 0; i < REQUESTS_PER_MINUTE; i++) {
      const res: Response = await routes.me.GET(new Request('https://nya.test/api/v1/me', { headers: { authorization: `Bearer ${token}` } }));
      expect(res.status).toBe(200);
      expect(res.headers.get('ratelimit-remaining')).toBe(String(REQUESTS_PER_MINUTE - 1 - i));
    }
    const { res, body } = await call('accounts');
    expect(res.status).toBe(429);
    expect(body.error.code).toBe('rate_limited');
    expect(Number(res.headers.get('retry-after'))).toBeGreaterThan(0);
    // Another token has its own count.
    const fresh = (await createToken(ctx, 'Other script')).token;
    expect((await call('me', '', { authorization: `Bearer ${fresh}` })).res.status).toBe(200);
  });

  test('parameters are checked strictly: an unknown one, a repeated one, or a bad value is a 400 with the stable shape', async () => {
    for (const [name, query] of [
      ['accounts', 'includeHidden=true'],
      ['accounts', 'include_hidden=yes'],
      ['accounts', 'include_hidden=true&include_hidden=false'],
      ['transactions', 'from=2026-02-30'],
      ['transactions', 'from=2026-10-09&to=2026-10-01'],
      ['transactions', 'limit=0'],
      ['transactions', 'limit=501'],
      ['transactions', 'min_amount=ten'],
      ['transactions', 'min_amount=10&max_amount=5'],
      ['transactions', 'cursor=!!!'],
      ['transactions', 'cursor=bm90IGEgY3Vyc29y'],
      ['transactions', `q=${'x'.repeat(101)}`],
      ['budgets', 'month=2026-13'],
      ['spending', 'month=2026-10&from=2026-10-01'],
      ['spending', 'currency=dollars'],
      ['balance-history', 'interval=year'],
      ['me', 'x=1'],
    ]) {
      const { res, body } = await call(name, query);
      expect([name, query, res.status, body.error?.code, typeof body.error?.message]).toEqual([name, query, 400, 'invalid_request', 'string']);
    }
  });

  test('every other method is refused as read only, in the same shape', async () => {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE'] as const) {
      const res: Response = await routes.accounts[method](new Request('https://nya.test/api/v1/accounts', { method }));
      expect(res.status).toBe(405);
      expect(res.headers.get('allow')).toBe('GET');
      expect((await res.json()).error.code).toBe('method_not_allowed');
    }
  });

  test('a failure says nothing of its internals', async () => {
    fake.failNext('hgetall', 3);
    const { res, body } = await quietly(() => call('accounts'));
    expect([500, 503]).toContain(res.status);
    expect(Object.keys(body)).toEqual(['error']);
    expect(JSON.stringify(body)).not.toMatch(/armed failure|at |stack|redis/i);
  });
});

describe('me', () => {
  test('the token and when the data began, never a sign-in id or email', async () => {
    const { res, body } = await call('me');
    expect(res.status).toBe(200);
    expect(body).toEqual({
      api_version: '1',
      // As it stood before this request: never used.
      token: { label: 'Tests', hint: token.slice(0, 12), created_at: expect.any(String), last_used_at: null },
      data_since: '2026-01-01T00:00:00.000Z',
      rate_limit: { requests: REQUESTS_PER_MINUTE, per_seconds: 60 },
    });
    expect(JSON.stringify(body)).not.toContain(TEST_CONTAINER);
    // The next one sees the first.
    expect((await call('me')).body.token.last_used_at).toEqual(expect.any(String));
  });
});

describe('accounts', () => {
  test('linked and manual, each with its newest measured balance and as of when; hidden ones left out', async () => {
    const { res, body } = await call('accounts');
    expect(res.status).toBe(200);
    const byId = Object.fromEntries(body.accounts.map((a: any) => [a.id, a]));
    expect(Object.keys(byId).sort()).toEqual(['acc_card', 'acc_chk', 'acc_ira', 'manual_house', 'manual_wallet']);
    // The partial day is newer than the last recorded one, and has no snapshot moment.
    expect(byId.acc_chk).toMatchObject({ source: 'plaid', institution: 'Chase', name: 'Checking', type: 'depository', subtype: 'checking', mask: '1111', balance: 1250, currency: 'USD', is_debt: false, hidden: false, as_of: daysAgo(1), as_of_time: null });
    expect(byId.acc_card).toMatchObject({ balance: 310, is_debt: true, credit_limit: 5000, as_of: daysAgo(1) });
    // The broker failed on the newest day: its last recorded balance, with the moment it was taken.
    expect(byId.acc_ira).toMatchObject({ balance: 20500, as_of: daysAgo(2), as_of_time: `${daysAgo(2)}T13:00:41.000Z` });
    expect(byId.manual_house).toMatchObject({ source: 'manual', institution: 'Property', balance: 300000, currency: 'USD', connection: null, mask: null });
    // What is known of each connection, from what was recorded.
    expect(byId.acc_chk.connection).toEqual({ last_ok_at: SYNCED_AT, problem: null, ends_at: expect.any(String) });
    expect(byId.acc_ira.connection).toEqual({ last_ok_at: null, problem: { state: 'needs_reauth', since: `${daysAgo(1)}T13:00:00.000Z` }, ends_at: null });
    // A connection never loaded is said, not passed over.
    expect(body.notes).toEqual(['NewBank: its accounts haven’t been loaded yet; open the app to load them']);
  });

  test('with include_hidden, hidden accounts too, marked', async () => {
    const { body } = await call('accounts', 'include_hidden=true');
    expect(body.accounts.find((a: any) => a.id === 'acc_save')).toMatchObject({ hidden: true, balance: 5000 });
  });

  test('a connection whose record can’t be read is said, and the rest are listed', async () => {
    await fake.hset(ctxKey('accounts:meta'), { item_broker: 'not-ciphertext-but-long-enough-to-be-tried' });
    const { body } = await call('accounts');
    expect(body.accounts.map((a: any) => a.id)).not.toContain('acc_ira');
    expect(body.notes).toContain('Broker: its accounts couldn’t be read, so they aren’t listed');
  });
});

describe('net worth', () => {
  test('now, per currency, and the newest recorded point, with hidden accounts subtracted', async () => {
    const { body } = await call('net-worth');
    expect(body.totals).toEqual([{ currency: 'USD', assets: 1250 + 20500 + 300000 + 40, debts: 310, net_worth: 1250 + 20500 + 300000 + 40 - 310, accounts: 5 }]);
    expect(body.accounts_without_balance).toBe(0);
    expect(body.balances_from <= body.balances_to).toBe(true);
    // Recorded, the hidden savings subtracted, as the chart subtracts it.
    expect(body.recorded).toEqual({ date: daysAgo(2), value: 1200 - 300 + 20500 + 300000, currency: 'USD', mixed_currencies: false });
  });
});

describe('balance history', () => {
  test('net worth: recorded points only by default, estimated ones flagged when asked', async () => {
    let { body } = await call('balance-history');
    expect(body.points).toEqual([
      { date: daysAgo(3), value: 1000 - 250 + 20000 + 300000, estimated: false },
      { date: daysAgo(2), value: 1200 - 300 + 20500 + 300000, estimated: false },
    ]);
    ({ body } = await call('balance-history', 'include_estimated=true&include_hidden=true'));
    expect(body.points[0]).toEqual({ date: daysAgo(10), value: 320000, estimated: true });
  });

  test('one account, following the same precedence as its chart; a hidden one is a 404 unless asked for', async () => {
    let { res, body } = await call('balance-history', 'account_id=acc_chk&include_estimated=true');
    expect(body.points).toEqual([
      { date: daysAgo(10), value: 900, estimated: true },
      { date: daysAgo(3), value: 1000, estimated: false },
      { date: daysAgo(2), value: 1200, estimated: false },
      { date: daysAgo(1), value: 1250, estimated: false },
    ]);
    expect(body.currency).toBe('USD');
    ({ res, body } = await call('balance-history', 'account_id=acc_save'));
    expect([res.status, body.error.code]).toEqual([404, 'not_found']);
    ({ res } = await call('balance-history', 'account_id=acc_save&include_hidden=true'));
    expect(res.status).toBe(200);
  });

  test('a month at a time: the last point of each', async () => {
    const { body } = await call('balance-history', 'account_id=acc_chk&interval=month');
    expect(body.points.at(-1)).toEqual({ date: daysAgo(1), value: 1250, estimated: false });
    expect(new Set(body.points.map((p: any) => p.date.slice(0, 7))).size).toBe(body.points.length);
  });
});

describe('transactions', () => {
  test('as the Activity tab shows them: renames, categories, exclusions and manual rows applied; hidden and superseded left out', async () => {
    const { res, body } = await call('transactions');
    expect(res.status).toBe(200);
    const ids = body.transactions.map((t: any) => t.id);
    expect(ids).not.toContain('t_hidden');
    expect(ids).not.toContain('t_pending');
    expect(ids).not.toContain('t_ancient');
    expect(JSON.stringify(body)).not.toContain('HIDDEN-ACCOUNT-ROW');
    const byId = Object.fromEntries(body.transactions.map((t: any) => [t.id, t]));
    expect(byId.t_coffee).toMatchObject({ name: 'Coffee place', amount: 5.5, currency: 'USD', category: 'food and drink', account_id: 'acc_chk', account_name: 'Checking', institution: 'Chase', source: 'plaid', excluded: false, is_transfer: false, pending: false, hidden: false });
    expect(byId.t_rent.category).toBe('housing');
    expect(byId.t_big.excluded).toBe(true);
    expect(byId.t_transfer.is_transfer).toBe(true);
    expect(byId.t_atm.is_transfer).toBe(true);
    expect(byId.t_loan.is_transfer).toBe(true);
    expect(byId.t_fee.is_transfer).toBe(false); // a bank's fee is spending
    expect(byId['manual-txn:5a0c1d2e-3f40-4a5b-8c6d-7e8f9a0b1c2d']).toMatchObject({ name: 'Farmers market', source: 'manual', account_id: 'manual_wallet', note: 'apples', institution: 'Cash' });
    // Newest first, and as of when each institution's were last synced.
    const dates = body.transactions.map((t: any) => t.date);
    expect(dates).toEqual([...dates].sort().reverse());
    expect(body.sources).toEqual([
      { institution: 'Chase', synced_at: SYNCED_AT, complete: true },
      { institution: 'Broker', synced_at: null, complete: true },
      { institution: 'NewBank', synced_at: null, complete: false },
    ]);
    expect(body.notes).toEqual(['NewBank: no transactions stored yet; open the app to load them']);
    expect(body).toMatchObject({ has_more: false, next_cursor: null, from: daysAgo(30), to: daysAgo(0) });
  });

  test('pages that never repeat or skip a row, bound to their query', async () => {
    const all = (await call('transactions')).body.transactions.map((t: any) => t.id);
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const { body } = await call('transactions', `limit=3${cursor ? `&cursor=${cursor}` : ''}`);
      seen.push(...body.transactions.map((t: any) => t.id));
      expect(body.transactions.length).toBeLessThanOrEqual(3);
      cursor = body.next_cursor;
      if (cursor) {
        // Not for another query.
        const { res } = await call('transactions', `limit=3&q=coffee&cursor=${cursor}`);
        expect(res.status).toBe(400);
      }
    } while (cursor);
    expect(seen).toEqual(all);
  });

  test('filtered by text, category, amount and account', async () => {
    const ids = async (query: string) => (await call('transactions', query)).body.transactions.map((t: any) => t.id).sort();
    expect(await ids('q=COFFEE')).toEqual(['t_coffee']);
    expect(await ids('q=apples')).toEqual(['manual-txn:5a0c1d2e-3f40-4a5b-8c6d-7e8f9a0b1c2d']);
    expect(await ids('category=Housing')).toEqual(['t_rent']);
    expect(await ids('min_amount=1000')).toEqual(['t_big', 't_rent']);
    expect(await ids('max_amount=-1')).toEqual(['t_pay']);
    expect(await ids('account_id=acc_card')).toEqual(['t_card', 't_paris']);
    expect(await ids('account_id=acc_save')).toEqual([]);
    expect(await ids('account_id=acc_save&include_hidden=true')).toEqual(['t_hidden']);
    expect(await ids(`from=${daysAgo(3)}&to=${daysAgo(2)}`)).toEqual(['t_coffee', 't_rent']);
  });
});

describe('categories, budgets and spending', () => {
  test('the categories in use, with whether each has a budget or is a transfer', async () => {
    const { body } = await call('categories');
    const byName = Object.fromEntries(body.categories.map((c: any) => [c.name, c]));
    expect(byName.housing).toMatchObject({ transactions: 1, budgeted: true, transfer: false });
    expect(byName['transfer out'].transfer).toBe(true);
    expect(byName['loan payments'].transfer).toBe(true);
    expect(byName['food and drink'].transactions).toBe(3);
  });

  test('budgets: the month’s spending as the Budgets tab counts it', async () => {
    const { body } = await call('budgets');
    expect(body.month).toBe(month);
    expect(body.currency).toBe('USD');
    const byCat = Object.fromEntries(body.budgets.map((b: any) => [b.category, b]));
    // Every row here is in the last nine days, so this month's are those on or after its first.
    const inMonth = (d: number) => daysAgo(d) >= `${month}-01`;
    const food = (inMonth(2) ? 5.5 : 0) + (inMonth(1) ? 12 + 25 : 0);
    expect(byCat['food and drink']).toEqual({ category: 'food and drink', budget: 100, spent: food, remaining: 100 - food, spent_share: Math.round((food / 100) * 1000) / 1000 });
    expect(byCat.housing.spent).toBe(inMonth(3) ? 1200 : 0);
    // The EUR charge is named, not added.
    expect(byCat.travel.spent).toBe(0);
    if (inMonth(7)) expect(body.left_out).toEqual([{ currency: 'EUR', count: 1 }]);
    expect(JSON.stringify(body)).not.toContain('OTHER-SECRET');
  });

  test('spending: bank fees count, transfers, cash, loan payments and exclusions don’t, and other currencies are named', async () => {
    const { body } = await call('spending', `from=${daysAgo(9)}&to=${daysAgo(0)}`);
    expect(body.currency).toBe('USD');
    expect(body.money_in).toBe(3000);
    expect(body.money_out).toBe(5.5 + 1200 + 35 + 80 + 12 + 25);
    expect(body.net).toBe(3000 - (5.5 + 1200 + 35 + 80 + 12 + 25));
    expect(body.categories).toEqual([
      { category: 'housing', spent: 1200, transactions: 1 },
      { category: 'general merchandise', spent: 80, transactions: 1 },
      { category: 'food and drink', spent: 42.5, transactions: 3 },
      { category: 'bank fees', spent: 35, transactions: 1 },
    ]);
    expect(body).toMatchObject({ excluded: 1, transfers: 3, exclusion_unknown: 0, left_out: [{ currency: 'EUR', count: 1 }] });
    expect(body.left_out_text).toBe("1 transaction in EUR isn't in these totals, which are in USD.");
    // Totalled in another currency on request.
    const eur = (await call('spending', `from=${daysAgo(9)}&currency=EUR`)).body;
    expect([eur.currency, eur.money_out]).toEqual(['EUR', 50]);
  });
});

describe('recurring bills and holdings', () => {
  test('recurring bills are detected from the stored rows, each with its estimated next date', async () => {
    const { res, body } = await call('recurring');
    expect(res.status).toBe(200);
    const next = new Date(Date.parse(`${daysAgo(26)}T00:00:00Z`) + 31 * DAY).toISOString().slice(0, 10);
    expect(body).toMatchObject({
      bills: [{ name: 'Netflix', institution: 'Chase', amount: 15.99, currency: 'USD', last_date: daysAgo(26), next_date: next, months_seen: 3, due_soon: true }],
      monthly_total: { currency: 'USD', amount: 15.99, left_out: [] },
      due_soon_days: 7,
    });
  });

  test('holdings: the latest recorded positions, with the day they were recorded', async () => {
    const { body } = await call('holdings');
    expect(body.accounts).toEqual([
      {
        account_id: 'acc_ira',
        name: 'IRA',
        institution: 'Broker',
        as_of: daysAgo(0),
        observed_at: expect.any(String),
        recorded_since: daysAgo(0),
        positions: [
          { security_id: 'sec_vti', ticker: 'VTI', name: 'Vanguard Total Stock Market ETF', type: 'etf', cash_equivalent: false, quantity: 80, price: 250, price_as_of: daysAgo(1), value: 20000, cost_basis: 15000, currency: 'USD' },
        ],
      },
    ]);
  });
});

describe('the session gate', () => {
  const gated = (path: string) => new RegExp(`^${config.matcher[0]}$`).test(path);

  test('skips every API endpoint exactly, and nothing that merely starts like one', () => {
    for (const op of OPERATIONS) {
      expect([op.name, gated(`/api/v1/${op.name}`)]).toEqual([op.name, false]);
      for (const near of [`/api/v1/${op.name}/x`, `/api/v1/${op.name}s`, `/api/v1/${op.name}x`]) expect([near, gated(near)]).toEqual([near, true]);
    }
    for (const path of ['/api/v1', '/api/v1/', '/api/v1/other', '/api/v2/accounts', '/api/api-tokens']) expect([path, gated(path)]).toEqual([path, true]);
  });
});

describe('nothing is written but the token’s own bookkeeping', () => {
  test('a read of every endpoint changes no stored data', async () => {
    const snapshot = () =>
      JSON.stringify([
        [...fake.strings.entries()].sort(),
        [...fake.hashes.entries()].filter(([k]) => !k.endsWith(':api-tokens') && !k.endsWith(':api-requests')).map(([k, h]) => [k, [...h].sort()]).sort(),
      ]);
    const before = snapshot();
    for (const op of OPERATIONS) expect([op.name, (await call(op.name)).res.status]).toEqual([op.name, 200]);
    expect(snapshot()).toBe(before);
  });
});

beforeAll(() => {
  // Each endpoint's route file exists for every operation (imported above).
  expect(Object.keys(routes).sort()).toEqual(OPERATIONS.map((o) => o.name).sort());
});
