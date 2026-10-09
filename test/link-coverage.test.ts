import { describe, expect, test, mock, beforeEach, afterEach } from 'bun:test';
import { FakeRedis, storageMock, TEST_CTX, ctxKey, registerTestContainer, unscopedDataKeys } from './fake-redis';

// Link coverage for brokerages and retirement plans: the second way to connect
// (a link token that asks for Investments), and every path an Item without
// Transactions goes through. An Item like that must never block a snapshot,
// never show a note, and never get a /transactions/sync call, since that call
// would add the product and start Plaid billing it (lib/item-products.ts).

const ctx = TEST_CTX;
process.env.PLAID_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');

const DAY = 86_400_000;
const daysAgo = (n: number) => new Date(Date.now() - n * DAY).toISOString().slice(0, 10);
const today = () => new Date().toISOString().slice(0, 10);

// What Plaid answers, by access token. mock.module is process-wide, so every
// call these paths can make is stubbed.
const plaid = {
  linkRequests: [] as any[],
  /** /item/get's Item at link time; missing means the lookup fails. */
  items: {} as Record<string, any>,
  accounts: {} as Record<string, any[]>,
  holdings: {} as Record<string, { holdings: any[]; securities: any[] }>,
  invRows: {} as Record<string, any[]>,
  /** Bank transactions, or an error code /transactions/sync answers with. */
  txns: {} as Record<string, any[] | string>,
  /** Every /transactions/sync call. */
  syncCalls: [] as { token: string; cursor?: string; options?: any }[],
  /** Every /accounts/get call, and the tokens it fails for. */
  accountsCalls: [] as string[],
  accountsFail: {} as Record<string, true>,
};
mock.module('@/lib/plaid', () => ({
  plaidClient: {
    linkTokenCreate: async (req: any) => {
      plaid.linkRequests.push(req);
      return { data: { link_token: 'link-token' } };
    },
    itemPublicTokenExchange: async (req: any) => ({
      data: { access_token: `token-${req.public_token}`, item_id: `item_${req.public_token}` },
    }),
    itemGet: async (req: any) => {
      const item = plaid.items[req.access_token];
      if (!item) throw { response: { data: { error_code: 'INTERNAL_SERVER_ERROR' } } };
      return { data: { item } };
    },
    accountsGet: async (req: any) => {
      plaid.accountsCalls.push(req.access_token);
      if (plaid.accountsFail[req.access_token]) throw { response: { data: { error_code: 'INSTITUTION_DOWN' } } };
      return { data: { item: { institution_id: 'ins_1' }, accounts: plaid.accounts[req.access_token] ?? [] } };
    },
    investmentsHoldingsGet: async (req: any) => ({
      data: { accounts: plaid.accounts[req.access_token] ?? [], ...(plaid.holdings[req.access_token] ?? { holdings: [], securities: [] }) },
    }),
    investmentsTransactionsGet: async (req: any) => {
      const rows = (plaid.invRows[req.access_token] ?? []).filter((r) => r.date >= req.start_date && r.date <= req.end_date);
      const offset = req.options?.offset ?? 0;
      return {
        data: {
          accounts: (plaid.accounts[req.access_token] ?? []).filter((a) => a.type === 'investment'),
          securities: [{ security_id: 's1', name: 'Target 2055', ticker_symbol: 'VFFVX' }],
          investment_transactions: rows.slice(offset, offset + (req.options?.count ?? 500)),
          total_investment_transactions: rows.length,
        },
      };
    },
    liabilitiesGet: async () => {
      throw { response: { data: { error_code: 'NO_LIABILITY_ACCOUNTS' } } };
    },
    transactionsSync: async (req: any) => {
      plaid.syncCalls.push({ token: req.access_token, cursor: req.cursor, options: req.options });
      const answer = plaid.txns[req.access_token];
      if (typeof answer === 'string') throw { response: { data: { error_code: answer } } };
      return {
        data: {
          added: req.cursor ? [] : answer ?? [],
          modified: [],
          removed: [],
          accounts: plaid.accounts[req.access_token] ?? [],
          next_cursor: 'cursor-1',
          has_more: false,
          transactions_update_status: 'HISTORICAL_UPDATE_COMPLETE',
        },
      };
    },
    itemRemove: async () => ({ data: {} }),
  },
}));

// Deserializing like Upstash, as production reads.
const fake = new FakeRedis({ deserialize: true });
// Nothing may be written outside a container (#53).
afterEach(() => expect(unscopedDataKeys(fake)).toEqual([]));
mock.module('@/lib/storage', () => storageMock(fake));

const { encrypt } = await import('@/lib/crypto');
const { saveItem, getItems } = await import('@/lib/storage');
const { rememberAccounts } = await import('@/lib/last-known');
const { getAccountHistory, getRealSnapshotDates, isBackfillDone } = await import('@/lib/history');
const { snapshotData } = await import('@/lib/snapshot-job');
const { readHoldingsRange } = await import('@/lib/holdings-history');
const { existingItemsAt } = await import('@/lib/existing-items');
const { transactionsBilledOf, transactionsBilled, holdsTransactionAccounts, isLinkKind } = await import('@/lib/item-products');

const checking = (id = 'acct_chk') => ({
  account_id: id,
  name: 'Checking',
  official_name: null,
  mask: '0001',
  type: 'depository',
  subtype: 'checking',
  balances: { current: 1000, available: 1000, limit: null, iso_currency_code: 'USD' },
});
const k401 = (id = 'acct_401k') => ({
  account_id: id,
  name: '401(k)',
  official_name: null,
  mask: '0002',
  type: 'investment',
  subtype: '401k',
  balances: { current: 50_000, available: null, limit: null, iso_currency_code: 'USD' },
});
const bankRow = (id: string, account_id: string, date = daysAgo(10)) => ({
  transaction_id: id,
  account_id,
  amount: 25,
  iso_currency_code: 'USD',
  date,
  name: 'GROCER',
  merchant_name: 'Grocer',
  pending: false,
  counterparties: [],
  personal_finance_category: { primary: 'FOOD_AND_DRINK', detailed: 'FOOD_AND_DRINK_GROCERIES' },
});
/** A paycheck contribution into a retirement account, as Plaid sends it. */
const contribution = (id: string, account_id: string, date: string) => ({
  investment_transaction_id: id,
  account_id,
  security_id: 's1',
  date,
  name: 'Contribution',
  quantity: 1,
  amount: -500,
  price: 500,
  fees: 0,
  type: 'cash',
  subtype: 'contribution',
  iso_currency_code: 'USD',
  unofficial_currency_code: null,
});

/**
 * A linked Item: stored with whether Plaid billed Transactions when it was
 * linked (left out for one linked before Nya recorded that), with its
 * accounts, and remembered as a dashboard load leaves it unless `remember` is
 * false.
 */
async function addItem(
  item_id: string,
  institution_name: string,
  accounts: any[],
  opts: { billed?: boolean | null; txns?: any[] | string; remember?: boolean } = {}
) {
  const token = `token-${item_id}`;
  plaid.accounts[token] = accounts;
  if (opts.txns !== undefined) plaid.txns[token] = opts.txns;
  await saveItem(ctx, {
    item_id,
    institution_name,
    encrypted_access_token: await encrypt(token),
    ...('billed' in opts ? { transactions_billed: opts.billed } : {}),
  });
  if (opts.remember !== false) await remember(item_id, institution_name, accounts);
}
async function remember(item_id: string, institution_name: string, accounts: any[]) {
  await rememberAccounts(ctx, [
    { item_id, institution_name, error: null, accounts: accounts.map((a) => ({ ...a, balance: a.balances.current })) } as any,
  ]);
}
/** A bank linked through the bank option, before Nya recorded what it bills. */
const addBank = () => addItem('item_bank', 'Bank', [checking()], { txns: [bankRow('t1', 'acct_chk'), bankRow('t2', 'acct_chk', daysAgo(20))] });
/** A 401(k) plan linked through the brokerage option: Investments only. */
const addRetirement = (opts: { remember?: boolean } = {}) =>
  addItem('item_ret', 'Empower', [k401()], { billed: false, ...opts });
const syncedTokens = () => plaid.syncCalls.map((c) => c.token);

async function route(path: string, method: string, body?: unknown, query = '') {
  const mod: any = await import(`@/app/api/${path}/route`);
  const init: RequestInit = { method };
  if (body !== undefined) init.body = typeof body === 'string' ? body : JSON.stringify(body);
  const res = await mod[method](new Request(`http://x/api/${path}${query}`, init));
  return { status: res.status, body: await res.json() };
}
const transactions = (fresh = true) => route('transactions', 'GET', undefined, fresh ? '?refresh=1' : '');

beforeEach(async () => {
  fake.reset();
  for (const key of Object.keys(plaid) as (keyof typeof plaid)[]) {
    const v = plaid[key];
    if (Array.isArray(v)) v.length = 0;
    else for (const k of Object.keys(v)) delete (v as Record<string, unknown>)[k];
  }
  (await import('@/lib/sessions')).forgetEpochs();
  await registerTestContainer(fake);
});

describe('which products an Item has', () => {
  test("whether Plaid bills Transactions, from its billed list; no list is unknown, never \"not billed\"", () => {
    expect(transactionsBilledOf({ billed_products: ['investments', 'transactions'] })).toBe(true);
    expect(transactionsBilledOf({ billed_products: ['investments', 'liabilities'], products: ['transactions'] })).toBe(false);
    expect(transactionsBilledOf({ billed_products: [] })).toBe(false);
    for (const item of [{}, { billed_products: 'transactions' }, { billed_products: null }, null, undefined, 'item']) {
      expect(transactionsBilledOf(item)).toBeNull();
    }
  });

  test('Transactions counts as billed on an Item linked before it was recorded, and otherwise only when recorded so', () => {
    // Linked when the bank option, which requires Transactions, was the only one.
    expect(transactionsBilled({})).toBe(true);
    expect(transactionsBilled({ transactions_billed: true })).toBe(true);
    expect(transactionsBilled({ transactions_billed: false })).toBe(false);
    // A failed lookup is not known to be billed.
    expect(transactionsBilled({ transactions_billed: null })).toBe(false);
  });

  test('only checking, savings and cards are worth starting Transactions for', () => {
    expect(holdsTransactionAccounts(['investment', 'depository'])).toBe(true);
    expect(holdsTransactionAccounts(['credit'])).toBe(true);
    for (const types of [[], ['investment'], ['loan'], ['other'], [null, undefined, 3]]) expect(holdsTransactionAccounts(types)).toBe(false);
  });

  test('the two kinds of link', () => {
    expect(isLinkKind('bank')).toBe(true);
    expect(isLinkKind('investments')).toBe(true);
    for (const v of ['Bank', 'brokerage', '', null, undefined, 1, ['bank']]) expect(isLinkKind(v)).toBe(false);
  });
});

describe('the link token', () => {
  test('with no body, the bank kind, as every client asked before there were two', async () => {
    for (const body of [undefined, '', {}, { kind: 'bank' }]) {
      plaid.linkRequests.length = 0;
      expect((await route('create-link-token', 'POST', body)).status).toBe(200);
      const [req] = plaid.linkRequests;
      expect(req.products).toEqual(['transactions']);
      expect(req.optional_products).toEqual(['investments', 'liabilities']);
      expect(req.required_if_supported_products).toBeUndefined();
      expect(req.transactions).toEqual({ days_requested: 730 });
      expect(req.country_codes).toEqual(['US']);
    }
  });

  test('the brokerage kind asks for Investments, and for Transactions only where an account supports it', async () => {
    expect((await route('create-link-token', 'POST', { kind: 'investments' })).status).toBe(200);
    const [req] = plaid.linkRequests;
    // Investments in `products` is what puts plans without Transactions on the list.
    expect(req.products).toEqual(['investments']);
    // Required if supported: Plaid adds and bills it only for an account type that supports it.
    expect(req.required_if_supported_products).toEqual(['transactions']);
    expect(req.optional_products).toEqual(['liabilities']);
    expect(req.transactions).toEqual({ days_requested: 730 });
    expect(req.country_codes).toEqual(['US']);
    expect(req.user).toEqual({ client_user_id: ctx.container });
    // Plaid refuses a product listed twice.
    const listed = [...req.products, ...req.required_if_supported_products, ...req.optional_products];
    expect(new Set(listed).size).toBe(listed.length);
  });

  test('anything else is refused before Plaid is asked', async () => {
    for (const body of [{ kind: 'stocks' }, { kind: 'Investments' }, { kind: 1 }, { kind: 'bank', extra: true }, [], 'null', 'nope', JSON.stringify({ kind: 'bank', pad: 'x'.repeat(300) })]) {
      expect((await route('create-link-token', 'POST', body)).status).toBe(400);
    }
    expect(plaid.linkRequests).toHaveLength(0);
  });
});

describe('linking records what Plaid bills', () => {
  test('from /item/get, beside the institution id, and only whether it bills Transactions', async () => {
    plaid.items['token-p1'] = { institution_id: 'ins_9', products: ['investments'], billed_products: ['investments', 'liabilities'] };
    plaid.items['token-p2'] = { institution_id: 'ins_3', products: ['transactions'], billed_products: ['transactions'] };
    expect((await route('exchange-public-token', 'POST', { public_token: 'p1', institution_name: 'Empower' })).status).toBe(200);
    expect((await route('exchange-public-token', 'POST', { public_token: 'p2', institution_name: 'Chase' })).status).toBe(200);
    const items = Object.fromEntries((await getItems(ctx)).map((i) => [i.item_id, i]));
    expect(items.item_p1).toMatchObject({ institution_id: 'ins_9', transactions_billed: false });
    expect(items.item_p2).toMatchObject({ institution_id: 'ins_3', transactions_billed: true });
    // The record is plain text, so Plaid's list itself (a loan here, say) isn't kept.
    expect(JSON.stringify(items)).not.toContain('liabilities');
  });

  test('unknown when the lookup fails, and the Item still links', async () => {
    expect((await route('exchange-public-token', 'POST', { public_token: 'p2', institution_name: 'Empower' })).status).toBe(200);
    expect(await getItems(ctx)).toMatchObject([{ item_id: 'item_p2', institution_id: null, transactions_billed: null }]);
  });

  test('an answer without the list is unknown too, never "not billed"', async () => {
    plaid.items['token-p3'] = { institution_id: 'ins_9' };
    await route('exchange-public-token', 'POST', { public_token: 'p3', institution_name: 'Empower' });
    expect((await getItems(ctx))[0].transactions_billed).toBeNull();
  });
});

describe('transactions from an Item without Transactions', () => {
  test('no call, no note, no rows, and the payload is cached as clean', async () => {
    await addBank();
    await addRetirement();
    const res = await transactions();
    expect(res.status).toBe(200);
    expect(res.body.notes).toEqual([]);
    expect(res.body.transactions.map((t: any) => [t.transaction_id, t.institution_name])).toEqual([
      ['t1', 'Bank'],
      ['t2', 'Bank'],
    ]);
    expect(syncedTokens()).toEqual(['token-item_bank']);
    // Clean, so the next load is served from the cache with no Plaid call.
    const again = await transactions(false);
    expect(again.body.from_cache).toBe(true);
    expect(syncedTokens()).toEqual(['token-item_bank']);
  });

  test('remembered accounts decide it, with no Plaid call at all', async () => {
    await addRetirement();
    await transactions();
    expect(plaid.syncCalls).toHaveLength(0);
    expect(plaid.accountsCalls).toHaveLength(0);
  });

  test('before a load has remembered its accounts, or when that record is unreadable, a fresh account list does', async () => {
    await addRetirement({ remember: false });
    expect((await transactions()).body).toMatchObject({ transactions: [], notes: [] });
    await remember('item_ret', 'Empower', [k401()]);
    await fake.hset(ctxKey('accounts:meta'), { item_ret: 'not ciphertext' });
    expect((await transactions()).body).toMatchObject({ transactions: [], notes: [] });
    // /accounts/get, which Plaid doesn't bill, twice; never /transactions/sync.
    expect(plaid.accountsCalls).toEqual(['token-item_ret', 'token-item_ret']);
    expect(plaid.syncCalls).toHaveLength(0);
  });

  test('so a connection linked a moment ago gets its transactions on the very first load', async () => {
    // Its lookup at link time failed, and no balance load has run yet.
    await addItem('item_cu', 'Credit union', [checking('acct_cu')], { billed: null, remember: false, txns: [bankRow('u1', 'acct_cu')] });
    expect((await transactions()).body.transactions.map((t: any) => t.transaction_id)).toEqual(['u1']);
    expect(plaid.syncCalls).toEqual([{ token: 'token-item_cu', cursor: undefined, options: { days_requested: 730 } }]);
  });

  test('and when no account list can be had, the first call waits for a later load, quietly', async () => {
    await addItem('item_cu', 'Credit union', [checking('acct_cu')], { billed: null, remember: false, txns: [bankRow('u1', 'acct_cu')] });
    plaid.accountsFail['token-item_cu'] = true;
    expect((await transactions()).body).toMatchObject({ transactions: [], notes: [] });
    expect(plaid.syncCalls).toHaveLength(0);
  });

  test('a brokerage connection that holds a checking account starts Transactions, asking for two years', async () => {
    await addItem('item_fid', 'Fidelity', [k401(), checking('acct_cma')], { billed: false, txns: [bankRow('c1', 'acct_cma')] });
    const first = await transactions();
    expect(first.body.notes).toEqual([]);
    expect(first.body.transactions.map((t: any) => t.transaction_id)).toEqual(['c1']);
    expect(plaid.syncCalls).toEqual([{ token: 'token-item_fid', cursor: undefined, options: { days_requested: 730 } }]);
    // From then on an ordinary sync: billing has started, and the ask is Plaid's to ignore.
    await transactions();
    expect(plaid.syncCalls[1]).toEqual({ token: 'token-item_fid', cursor: 'cursor-1', options: undefined });
  });

  test('once started, it keeps syncing, and showing what it stored, after the checking account goes', async () => {
    await addItem('item_fid', 'Fidelity', [k401(), checking('acct_cma')], { billed: false, txns: [bankRow('c1', 'acct_cma')] });
    await transactions();
    plaid.accounts['token-item_fid'] = [k401()];
    await remember('item_fid', 'Fidelity', [k401()]);
    const res = await transactions();
    expect(res.body.transactions.map((t: any) => t.transaction_id)).toEqual(['c1']);
    expect(plaid.syncCalls).toHaveLength(2);
  });

  test('an Item whose link-time lookup failed gets the same care', async () => {
    await addItem('item_a', 'Plan', [k401()], { billed: null });
    expect((await transactions()).body.notes).toEqual([]);
    expect(plaid.syncCalls).toHaveLength(0);
    await addItem('item_b', 'Credit union', [checking('acct_b')], { billed: null, txns: [bankRow('b1', 'acct_b')] });
    expect((await transactions()).body.transactions.map((t: any) => t.transaction_id)).toEqual(['b1']);
    expect(syncedTokens()).toEqual(['token-item_b']);
  });

  test("one that can't have Transactions after all is quiet, and asked again only on a later uncached load", async () => {
    for (const code of ['PRODUCTS_NOT_SUPPORTED', 'ADDITIONAL_CONSENT_REQUIRED']) {
      fake.reset();
      plaid.syncCalls.length = 0;
      (await import('@/lib/sessions')).forgetEpochs();
      await registerTestContainer(fake);
      await addItem('item_ret', 'Plan', [k401(), checking('acct_cash')], { billed: false, txns: code });
      const res = await transactions();
      expect(res.body).toMatchObject({ transactions: [], notes: [] });
      expect(plaid.syncCalls).toHaveLength(1);
      expect((await transactions(false)).body.from_cache).toBe(true);
      expect(plaid.syncCalls).toHaveLength(1);
      // Nothing was stored for it, so nothing reads as synced.
      expect(fake.strings.has(ctxKey('txns:item_ret'))).toBe(false);
    }
  });

  test('on an Item that has Transactions the same answer is a fault, and says so', async () => {
    await addItem('item_bank', 'Bank', [checking()], { txns: 'PRODUCTS_NOT_SUPPORTED' });
    expect((await transactions()).body.notes).toEqual(['Bank: could not fetch transactions']);
    await addItem('item_bank', 'Bank', [checking()], { billed: true, txns: 'ADDITIONAL_CONSENT_REQUIRED' });
    expect((await transactions()).body.notes).toEqual(['Bank: could not fetch transactions']);
  });

  test('an Item linked before Nya recorded what it bills syncs as it always did', async () => {
    await addItem('item_old', 'Brokerage', [k401()], { txns: [] });
    expect((await transactions()).body.notes).toEqual([]);
    expect(plaid.syncCalls).toEqual([{ token: 'token-item_old', cursor: undefined, options: undefined }]);
  });
});

describe('the estimated backfill', () => {
  const flows = (account_id: string) => [contribution('i1', account_id, daysAgo(15)), contribution('i2', account_id, daysAgo(45))];

  test('an Item without Transactions never holds it up, and its account is walked from its own flows', async () => {
    await addBank();
    await addRetirement();
    plaid.invRows['token-item_ret'] = flows('acct_401k');
    const res = await route('backfill', 'POST');
    expect(res.status).toBe(200);
    expect(res.body.backfilled).toBeGreaterThan(0);
    expect(res.body.investments_pending).toBe(false);
    expect(await isBackfillDone(ctx)).toBe(true);
    expect(syncedTokens()).toEqual(['token-item_bank']);
    // Its balance before the latest contribution is reconstructed, as an estimate.
    const history = await getAccountHistory(ctx, 'acct_401k');
    expect(history.length).toBeGreaterThan(0);
    expect(history.every((p) => p.estimated)).toBe(true);
    expect(history.find((p) => p.date === daysAgo(16))?.value).toBe(49_500);
    expect(history.find((p) => p.date === daysAgo(14))?.value).toBe(50_000);
  });

  test('a retirement-only person gets a whole estimated series from investment flows', async () => {
    await addRetirement();
    plaid.invRows['token-item_ret'] = flows('acct_401k');
    const res = await route('backfill', 'POST');
    expect(res.body.backfilled).toBeGreaterThan(0);
    expect(await isBackfillDone(ctx)).toBe(true);
    expect(plaid.syncCalls).toHaveLength(0);
  });

  test('a cash account with no stream is held flat: no series of its own, and no total past what is known', async () => {
    await addItem('item_ret', 'Plan', [k401(), checking('acct_cash')], { billed: false, txns: 'PRODUCTS_NOT_SUPPORTED' });
    plaid.invRows['token-item_ret'] = flows('acct_401k');
    const res = await route('backfill', 'POST');
    expect(res.status).toBe(200);
    expect(await isBackfillDone(ctx)).toBe(true);
    // Like a dormant checking account: its past balance is unknown, so no totals.
    expect(res.body.backfilled).toBe(0);
    expect(await getAccountHistory(ctx, 'acct_cash')).toEqual([]);
    // The retirement account still gets its own series.
    expect((await getAccountHistory(ctx, 'acct_401k')).length).toBeGreaterThan(0);
  });

  test('beside a bank with a stream, it still gets no series of its own, and counts in the total at today’s balance', async () => {
    await addBank();
    await addItem('item_ret', 'Plan', [k401(), checking('acct_cash')], { billed: false, txns: 'PRODUCTS_NOT_SUPPORTED' });
    const res = await route('backfill', 'POST');
    expect(res.body.backfilled).toBeGreaterThan(0);
    // An empty stream would have drawn it as a balance that never moved.
    expect(await getAccountHistory(ctx, 'acct_cash')).toEqual([]);
    expect((await getAccountHistory(ctx, 'acct_chk')).length).toBeGreaterThan(0);
    // Held flat in the total: before the bank's one purchase 10 days ago, the
    // total is both checking accounts and the 401(k), the bank's walked back.
    const { getHistory } = await import('@/lib/history');
    const total = (await getHistory(ctx)).find((p) => p.date === daysAgo(12));
    expect(total?.value).toBe(1025 + 1000 + 50_000);
  });
});

describe('the daily snapshot', () => {
  const positions = () => ({
    holdings: [
      {
        account_id: 'acct_401k',
        security_id: 's1',
        quantity: 100,
        institution_price: 500,
        institution_price_as_of: today(),
        institution_value: 50_000,
        cost_basis: 40_000,
        iso_currency_code: 'USD',
        unofficial_currency_code: null,
      },
    ],
    securities: [{ security_id: 's1', name: 'Target 2055', ticker_symbol: 'VFFVX', type: 'mutual fund', is_cash_equivalent: false }],
  });

  test('an Item without Transactions never keeps the day from being recorded, and its positions are kept', async () => {
    await addBank();
    await addRetirement();
    plaid.holdings['token-item_ret'] = positions();
    expect(await snapshotData(ctx)).toEqual({ status: 'recorded' });
    expect((await getRealSnapshotDates(ctx)).has(today())).toBe(true);
    const [day] = await readHoldingsRange(ctx, today(), today());
    expect(day.accounts.map((a) => [a.account_id, a.positions.map((p) => p.ticker)])).toEqual([['acct_401k', ['VFFVX']]]);
    expect(plaid.syncCalls).toHaveLength(0);
  });

  test('nor on a dashboard load, where its card has no error', async () => {
    await addBank();
    await addRetirement();
    plaid.holdings['token-item_ret'] = positions();
    const res = await route('net-worth', 'GET', undefined, '?refresh=1');
    const card = res.body.institutions.find((i: any) => i.item_id === 'item_ret');
    expect(card).toMatchObject({ error: null, needs_reauth: false });
    expect(card.unconfirmed_missing).toBeUndefined();
    expect(card.holdings).toHaveLength(1);
    expect(res.body.history.at(-1)).toMatchObject({ date: today() });
    expect(plaid.syncCalls).toHaveLength(0);
  });

  test('connection health shows it healthy, and no month is named incomplete for it', async () => {
    await addBank();
    await addRetirement();
    const res = await route('net-worth', 'GET', undefined, '?refresh=1');
    const card = res.body.institutions.find((i: any) => i.item_id === 'item_ret');
    expect(card.health).toMatchObject({ state: 'healthy', cause: 'ok', action: 'none' });
    expect(card.health.last_ok_at).not.toBeNull();
    // Having no transactions is not having them missing (lib/month-coverage.ts).
    const txns = await transactions();
    expect(txns.body.incomplete).toEqual([]);
    expect(txns.body.notes).toEqual([]);
  });
});

describe('update mode on a brokerage connection', () => {
  test('payment details, account selection and reconnecting ask nothing of Transactions', async () => {
    await addRetirement();
    expect((await route('create-update-link-token', 'POST', { item_id: 'item_ret', add_liabilities: true })).status).toBe(200);
    expect((await route('create-update-link-token', 'POST', { item_id: 'item_ret', select_accounts: true })).status).toBe(200);
    expect((await route('create-update-link-token', 'POST', { item_id: 'item_ret' })).status).toBe(200);
    const [liabilities, picker, reconnect] = plaid.linkRequests;
    expect(liabilities).toMatchObject({ access_token: 'token-item_ret', products: ['liabilities'] });
    expect(picker).toMatchObject({ access_token: 'token-item_ret', update: { account_selection_enabled: true } });
    expect(picker.products).toBeUndefined();
    expect(reconnect.products).toBeUndefined();
    for (const req of plaid.linkRequests) {
      expect(req.transactions).toBeUndefined();
      expect(req.required_if_supported_products).toBeUndefined();
    }
  });
});

describe('one connection per login, whichever way it was made', () => {
  // Matched on the institution alone: adding accounts to the Item already
  // there brings in what they need (holdings for an investment account, and
  // Transactions, started on first use, for a checking account), where a second
  // Item would duplicate any account both share.
  test('a checking account added to a brokerage connection through the picker brings its transactions', async () => {
    await addItem('item_fid', 'Fidelity', [k401()], { billed: false, txns: [bankRow('c1', 'acct_cma')] });
    await transactions();
    expect(plaid.syncCalls).toHaveLength(0);
    // "Add accounts to existing connection", then the picker adds the cash account.
    const picker = await route('create-update-link-token', 'POST', { item_id: 'item_fid', select_accounts: true });
    plaid.accounts['token-item_fid'] = [k401(), checking('acct_cma')];
    const updated = await route('item-accounts-updated', 'POST', { item_id: 'item_fid', opened_at: picker.body.opened_at });
    expect(updated.body).toEqual({ added: 1, removed: 0 });
    expect((await transactions()).body.transactions.map((t: any) => t.transaction_id)).toEqual(['c1']);
    expect(plaid.syncCalls).toEqual([{ token: 'token-item_fid', cursor: undefined, options: { days_requested: 730 } }]);
  });

  test('a brokerage connection is found for the bank option, and the other way round', () => {
    const items = [
      { item_id: 'item_fid', institution_name: 'Fidelity', institution_id: 'ins_12' },
      { item_id: 'item_bank', institution_name: 'Chase', institution_id: 'ins_3' },
    ];
    expect(existingItemsAt(items, { institution_id: 'ins_12', name: 'Fidelity' }).map((i) => i.item_id)).toEqual(['item_fid']);
    expect(existingItemsAt(items, { institution_id: 'ins_3', name: 'Chase' }).map((i) => i.item_id)).toEqual(['item_bank']);
  });
});
