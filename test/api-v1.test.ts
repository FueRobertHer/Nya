import { describe, expect, test, mock, beforeEach, afterEach, beforeAll } from 'bun:test';
import './clerk-mock';
import { FakeRedis, storageMock, ctxKey, TEST_CONTAINER, registerTestContainer, unscopedDataKeys } from './fake-redis';

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

const { ctx, OTHER, DAY, daysAgo, SYNCED_AT, seedPerson, seedOther, connectWithoutTransactions } = await import('./api-fixture');
const { createToken, revokeToken, REQUESTS_PER_MINUTE } = await import('@/lib/api-tokens');
const { OPERATIONS } = await import('@/lib/api-ops');
const { forgetEpochs } = await import('@/lib/sessions');
const { config } = await import('@/proxy');

const routes: Record<string, any> = {};
for (const op of OPERATIONS) routes[op.name] = await import(`@/app/api/v1/${op.name}/route`);

const month = daysAgo(0).slice(0, 7);

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
  await seedPerson(fake);
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
    await seedOther(fake);
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
      { institution: 'Chase', synced_at: SYNCED_AT, complete: true, no_transactions: null },
      { institution: 'Broker', synced_at: null, complete: true, no_transactions: null },
      { institution: 'NewBank', synced_at: null, complete: false, no_transactions: null },
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

describe('connections that bring in no transactions (lib/item-products.ts)', () => {
  const INVESTMENTS = { item_id: 'item_fidelity', name: 'Fidelity', accounts: [{ account_id: 'acc_401k', type: 'investment' }] };
  const REFUSED = { item_id: 'item_cu', name: 'CreditUnion', accounts: [{ account_id: 'acc_cu', type: 'depository' }], refused: { code: 'PRODUCTS_NOT_SUPPORTED' } };
  const UNALLOWED = { item_id: 'item_ally', name: 'Ally', accounts: [{ account_id: 'acc_ally', type: 'depository' }], refused: { code: 'ADDITIONAL_CONSENT_REQUIRED' } };
  const sourceOf = (body: any, name: string) => body.sources.find((s: any) => s.institution === name);

  test('each is named in sources, with why, from what is stored, and Plaid is never asked', async () => {
    for (const c of [INVESTMENTS, REFUSED, UNALLOWED]) await connectWithoutTransactions(fake, c);
    for (const name of ['transactions', 'categories', 'budgets', 'spending', 'recurring']) {
      const { body } = await call(name);
      expect([name, sourceOf(body, 'Fidelity')]).toEqual([name, { institution: 'Fidelity', synced_at: null, complete: true, no_transactions: 'investment_accounts' }]);
      expect([name, sourceOf(body, 'CreditUnion').no_transactions, sourceOf(body, 'Ally').no_transactions]).toEqual([name, 'refused', 'no_consent']);
      // One that brings its transactions in says so too.
      expect([name, sourceOf(body, 'Chase').no_transactions]).toEqual([name, null]);
    }
  });

  test('a bank account or card whose transactions don’t come in is named as missing from a list, and as not counted in a total', async () => {
    for (const c of [INVESTMENTS, REFUSED, UNALLOWED]) await connectWithoutTransactions(fake, c);
    const list = (await call('transactions')).body.notes;
    expect(list).toContain("Plaid doesn't provide transactions for the bank or card accounts at CreditUnion, so they can't be shown.");
    expect(list).toContain(
      "You didn't allow Nya to see transactions from the bank or card accounts at Ally, so they can't be shown. To bring them in, choose Allow transactions on the Accounts tab."
    );
    for (const name of ['spending', 'budgets', 'recurring']) {
      const notes: string[] = (await call(name)).body.notes;
      expect([name, notes.includes("Plaid doesn't provide transactions for the bank or card accounts at CreditUnion, so they aren't counted.")]).toEqual([name, true]);
      expect([name, notes.some((n) => n.startsWith("You didn't allow Nya to see transactions from the bank or card accounts at Ally, so they aren't counted."))]).toEqual([name, true]);
    }
    // Investment accounts beside a bank that brings transactions in leave nothing out: nothing is said.
    expect(list.join(' ')).not.toContain('Fidelity');
  });

  test('a refusal stands as long as a sync would let it: once it lapses, the connection is only not loaded yet', async () => {
    await connectWithoutTransactions(fake, { ...REFUSED, refused: { code: 'PRODUCTS_NOT_SUPPORTED', at: new Date(Date.now() - 31 * DAY).toISOString() } });
    const { body } = await call('spending');
    expect(sourceOf(body, 'CreditUnion')).toEqual({ institution: 'CreditUnion', synced_at: null, complete: false, no_transactions: null });
    expect(body.notes).toContain('CreditUnion: no transactions stored yet; open the app to load them');
  });

  test('when no connection brings any in, and nothing was entered by hand, it says so instead of a zero', async () => {
    fake.reset();
    await registerTestContainer(fake);
    token = (await createToken(ctx, 'Tests')).token;
    await connectWithoutTransactions(fake, INVESTMENTS);
    const { body } = await call('spending');
    expect(body.money_out).toBe(0);
    expect(body.notes).toEqual(['Your connected accounts are investment accounts, so no bank or card transactions come in. To see spending, connect a bank or card.']);
    expect((await call('transactions')).body.notes).toEqual(body.notes);
    // A bank account or card that doesn't bring them in is named, with what would.
    await connectWithoutTransactions(fake, UNALLOWED);
    expect((await call('budgets')).body.notes).toEqual([
      "You didn't allow Nya to see transactions from the bank or card accounts at Ally, so no bank or card transactions come in. To see spending, choose Allow transactions on the Accounts tab.",
    ]);
  });
});

describe('recurring bills and holdings', () => {
  /** The fixture's Netflix charges as the app's own detection reads them
   *  (lib/recurring.ts), to hold the API to what the app shows. */
  const appNetflix = async () => {
    const { detectRecurring } = await import('@/lib/recurring');
    const rows = [88, 57, 26].map((d) => ({
      date: daysAgo(d),
      name: 'Netflix',
      amount: 15.99,
      institution_name: 'Chase',
      account_name: 'Checking',
      account_type: 'depository',
      category: 'entertainment',
      transaction_code: null,
      iso_currency_code: 'USD',
    }));
    return detectRecurring(rows)[0];
  };
  /** Rows typed on the fixture's manual wallet, in US dollars. */
  const typed = async (rows: { name: string; amount: number; days: number; category: string }[]) => {
    const { manualTxnStore } = await import('@/lib/manual-txns');
    const now = new Date().toISOString();
    const before = (await manualTxnStore.get(ctx, 'manual_wallet'))!;
    await manualTxnStore.set(ctx, 'manual_wallet', {
      ...before,
      rows: [
        ...before.rows,
        ...rows.map((r, i) => ({
          id: `manual-txn:${String(i + 100).padStart(8, '0')}-0000-4000-8000-000000000000`,
          account_id: 'manual_wallet',
          date: daysAgo(r.days),
          amount: r.amount,
          currency: 'USD',
          name: r.name,
          category: r.category,
          note: null,
          source: 'manual',
          source_id: null,
          created_at: now,
          updated_at: now,
        })),
      ],
    });
  };

  test('recurring bills are detected from the stored rows as the app detects them, each with its cadence and next date', async () => {
    const { expectedDates } = await import('@/lib/recurring');
    const { res, body } = await call('recurring');
    expect(res.status).toBe(200);
    // The next date the app shows for it: within the week.
    const next = expectedDates(await appNetflix(), daysAgo(0), daysAgo(-400)).dates[0].date;
    expect(next > daysAgo(0) && next <= daysAgo(-7)).toBe(true);
    expect(body).toMatchObject({
      bills: [
        {
          name: 'Netflix',
          institution: 'Chase',
          account: 'Checking',
          amount: 15.99,
          currency: 'USD',
          cadence: 'monthly',
          last_date: daysAgo(26),
          next_date: next,
          due_soon: true,
          ended: false,
          pays_card: false,
        },
      ],
      monthly_total: { currency: 'USD', amount: 15.99, left_out: [] },
      due_soon_days: 7,
    });
  });

  test('a yearly bill is found from the rows before the window, and one that may have ended is listed but not counted', async () => {
    await typed([
      // A domain renewed a year apart: its first charge is older than the window.
      { name: 'Domain', amount: 12, days: 400, category: 'general services' },
      { name: 'Domain', amount: 12, days: 35, category: 'general services' },
      // A gym that stopped charging months ago.
      ...[200, 169, 138].map((days) => ({ name: 'Gym', amount: 30, days, category: 'personal care' })),
    ]);
    const { body } = await call('recurring');
    const by = (name: string) => body.bills.find((b: { name: string }) => b.name === name);
    expect(by('Domain')).toMatchObject({ cadence: 'yearly', amount: 12, last_date: daysAgo(35), due_soon: false, ended: false });
    expect(by('Gym')).toMatchObject({ cadence: 'monthly', amount: 30, last_date: daysAgo(138), due_soon: false, ended: true });
    expect(by('Gym').next_date < daysAgo(0)).toBe(true);
    // Netflix, and the domain at a twelfth of its price; never the gym.
    expect(body.monthly_total).toEqual({ currency: 'USD', amount: 16.99, left_out: [] });
  });

  test('a bill marked not recurring is never named, nor counted; marks that can’t be read are said', async () => {
    const { plannedStore } = await import('@/lib/planned-store');
    await plannedStore.set(ctx, { version: 1, items: [], dismissed: [(await appNetflix()).id], threshold: null });
    const { body } = await call('recurring');
    expect(body.bills).toEqual([]);
    expect(body.monthly_total).toEqual({ currency: 'USD', amount: 0, left_out: [] });
    expect(body.notes.join(' ')).not.toContain('not recurring');
    // Damaged: every bill is listed, and the notes say why.
    await fake.set(ctxKey('planned-items'), 'not encrypted');
    const after = (await call('recurring')).body;
    expect(after.bills.map((b: { name: string }) => b.name)).toEqual(['Netflix']);
    expect(after.notes).toContain('Bills marked not recurring: couldn’t be read, so any you marked are listed and counted in monthly_total');
  });

  test('the monthly total adds the bills in the totals’ currency, and names those in others, as the Budgets tab does', async () => {
    const { manualTxnStore } = await import('@/lib/manual-txns');
    const now = new Date().toISOString();
    const charge = (n: number, name: string, amount: number, currency: string, days: number) => ({
      id: `manual-txn:${String(n).padStart(8, '0')}-0000-4000-8000-000000000000`,
      account_id: 'manual_wallet',
      date: daysAgo(days),
      amount,
      currency,
      name,
      category: 'entertainment',
      note: null,
      source: 'manual',
      source_id: null,
      created_at: now,
      updated_at: now,
    });
    const before = (await manualTxnStore.get(ctx, 'manual_wallet'))!;
    let n = 0;
    const monthly = (name: string, amount: number, currency: string) => [20, 51, 82].map((d) => charge(++n, name, amount, currency, d));
    await manualTxnStore.set(ctx, 'manual_wallet', {
      ...before,
      rows: [...before.rows, ...monthly('Radio', 9.99, 'EUR'), ...monthly('Papers', 4, 'EUR'), ...monthly('Gym', 1200, 'JPY')],
    });
    const { body } = await call('recurring');
    expect(body.bills.map((b: { name: string; currency: string }) => [b.name, b.currency])).toEqual([
      ['Gym', 'JPY'],
      ['Netflix', 'USD'],
      ['Radio', 'EUR'],
      ['Papers', 'EUR'],
    ]);
    expect(body.monthly_total).toEqual({ currency: 'USD', amount: 15.99, left_out: [{ currency: 'EUR', count: 2 }, { currency: 'JPY', count: 1 }] });
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
