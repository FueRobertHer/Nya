import { describe, expect, test, mock, beforeEach, afterEach } from 'bun:test';
import { FakeRedis, storageMock, TEST_CTX, ctxKey, registerTestContainer, unscopedDataKeys } from './fake-redis';

// The history before the loaded year that /api/transactions sends for
// recurring detection (`recurring_history`): a yearly charge is seen twice
// only in two years, so the rows it needs go beside the year's, with the same
// categories, renames, exclusions and hidden accounts as every other row.

process.env.PLAID_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');

let plaidRows: Record<string, unknown>[] = [];
mock.module('@/lib/plaid', () => ({
  plaidClient: {
    transactionsSync: async () => ({
      data: {
        added: plaidRows,
        modified: [],
        removed: [],
        accounts: [
          { account_id: 'acct_chk', name: 'Checking', official_name: null, type: 'depository', subtype: 'checking', mask: '0001', balances: { current: 1000, available: 1000, limit: null, iso_currency_code: 'USD' } },
          { account_id: 'acct_biz', name: 'Business', official_name: null, type: 'depository', subtype: 'checking', mask: '0002', balances: { current: 50, available: 50, limit: null, iso_currency_code: 'USD' } },
        ],
        next_cursor: 'cursor-1',
        has_more: false,
        transactions_update_status: 'HISTORICAL_UPDATE_COMPLETE',
      },
    }),
  },
}));

const fake = new FakeRedis({ deserialize: true });
afterEach(() => expect(unscopedDataKeys(fake)).toEqual([]));
mock.module('@/lib/storage', () => storageMock(fake));

const { encrypt } = await import('@/lib/crypto');
const { forgetEpochs } = await import('@/lib/sessions');
const { saveManualAccount } = await import('@/lib/manual');
const { setAccountHidden } = await import('@/lib/hidden');
const { setOverride } = await import('@/lib/overrides');
const { setRename } = await import('@/lib/renames');
const { writeCache, CacheKey } = await import('@/lib/cache');
const { detectRecurring } = await import('@/lib/recurring');
const transactions = await import('@/app/api/transactions/route');
const manualTxns = await import('@/app/api/manual-transactions/route');
const annotations = await import('@/app/api/transaction-annotations/route');

const ctx = TEST_CTX;
const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);

const plaid = (over: Record<string, unknown>) => ({
  transaction_id: 'p1',
  account_id: 'acct_chk',
  amount: 139,
  iso_currency_code: 'USD',
  date: daysAgo(30),
  name: 'AMZN PRIME*1A2B',
  merchant_name: 'Amazon Prime',
  pending: false,
  counterparties: [],
  ...over,
});

const list = async (refresh = true) => (await transactions.GET(new Request(`http://localhost/api/transactions${refresh ? '?refresh=1' : ''}`))).json();
const call = async (handler: (req: Request) => Promise<Response>, method: string, body: unknown) =>
  (await handler(new Request('http://localhost/api/test', { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }))).json();
const ids = (rows: { transaction_id: string }[]) => rows.map((t) => t.transaction_id).sort();

beforeEach(async () => {
  fake.reset();
  forgetEpochs();
  await registerTestContainer(fake);
  await fake.hset(ctxKey('plaid:items'), { item_a: JSON.stringify({ item_id: 'item_a', institution_name: 'Big Bank', encrypted_access_token: await encrypt('access-token') }) });
  plaidRows = [
    // Prime, yearly: once this year, once the year before.
    plaid({ transaction_id: 'prime_now', date: daysAgo(30) }),
    plaid({ transaction_id: 'prime_then', date: daysAgo(395) }),
    // Older than detection looks.
    plaid({ transaction_id: 'prime_long_ago', date: daysAgo(900) }),
    // Monthly: judged on this year alone, so none of its older rows are sent.
    ...Array.from({ length: 24 }, (_, i) => plaid({ transaction_id: `netflix_${i}`, date: daysAgo(10 + 30 * i), amount: 15.49, name: 'NETFLIX.COM', merchant_name: 'Netflix' })),
    // Nothing this year: a series that ended.
    plaid({ transaction_id: 'delta_then', date: daysAgo(500), amount: 450, name: 'DELTA AIR', merchant_name: 'Delta' }),
    // Money moved, before the year: never a series.
    plaid({ transaction_id: 'move_then', date: daysAgo(420), amount: 139, category: undefined, transaction_code: 'transfer' }),
    // A hidden account's.
    plaid({ transaction_id: 'biz_now', account_id: 'acct_biz', date: daysAgo(40), amount: 99, name: 'ADOBE', merchant_name: 'Adobe' }),
    plaid({ transaction_id: 'biz_then', account_id: 'acct_biz', date: daysAgo(405), amount: 99, name: 'ADOBE', merchant_name: 'Adobe' }),
  ];
});

describe('the history before the loaded year', () => {
  test('carries the rows a yearly charge needs, beside the year, never in it', async () => {
    const body = await list();
    expect(ids(body.recurring_history)).toEqual(['biz_then', 'prime_then']);
    expect(body.transactions.map((t: { transaction_id: string }) => t.transaction_id)).not.toContain('prime_then');
    expect(body.transactions.every((t: { date: string }) => t.date >= daysAgo(366))).toBe(true);
    // Compact: what detection reads.
    expect(body.recurring_history.find((t: { transaction_id: string }) => t.transaction_id === 'prime_then')).toEqual({
      transaction_id: 'prime_then',
      date: daysAgo(395),
      name: 'Amazon Prime',
      amount: 139,
      account_name: 'Checking',
      account_type: 'depository',
      institution_name: 'Big Bank',
      category: null,
      subcategory: null,
      iso_currency_code: 'USD',
      unofficial_currency_code: null,
      transaction_code: null,
      vendor_key: 'nm:big bank::amazon prime',
      logo_url: null,
    });
    // With it, Prime is found as yearly; without it, it can't be.
    const prime = (rows: unknown[]) => detectRecurring(rows as never).filter((s) => s.name === 'Amazon Prime');
    expect(prime(body.transactions)).toEqual([]);
    expect(prime([...body.transactions, ...body.recurring_history]).map((s) => s.cadence)).toEqual(['yearly']);
  });

  test('a hidden account\'s are left out, as its rows this year are', async () => {
    await setAccountHidden(ctx, 'acct_biz', 'depository', true);
    const body = await list();
    expect(ids(body.recurring_history)).toEqual(['prime_then']);
  });

  test('a category and a rename apply to them as to every row', async () => {
    await setRename(ctx, 'nm:big bank::amazon prime', 'Prime membership');
    let body = await list();
    expect(body.recurring_history.find((t: { transaction_id: string }) => t.transaction_id === 'prime_then').name).toBe('Prime membership');
    // Recategorized as money moved, it can't belong to a series, so it isn't sent.
    await setOverride(ctx, 'prime_then', 'transfer out');
    body = await list();
    expect(ids(body.recurring_history)).toEqual(['biz_then']);
  });

  test('an excluded one is not sent, and detection leaves it out', async () => {
    await call(annotations.PATCH, 'PATCH', { transaction_id: 'prime_then', excluded: true });
    const body = await list();
    expect(ids(body.recurring_history)).toEqual(['biz_then']);
    expect(detectRecurring([...body.transactions, ...body.recurring_history]).filter((s) => s.name === 'Amazon Prime')).toEqual([]);
  });

  test('chosen once exclusions are applied: an excluded row never keeps the others from being sent', async () => {
    // Four older charges at a renewal's price is one too many to send; with
    // one of them excluded, the other three go, from the cache as fresh.
    plaidRows.push(
      plaid({ transaction_id: 'dom_now', date: daysAgo(20), amount: 18, name: 'DOMAINS', merchant_name: 'Domains' }),
      ...[400, 430, 460, 490].map((d) => plaid({ transaction_id: `dom_${d}`, date: daysAgo(d), amount: 18, name: 'DOMAINS', merchant_name: 'Domains' }))
    );
    expect(ids((await list()).recurring_history).filter((id: string) => id.startsWith('dom'))).toEqual([]);
    await call(annotations.PATCH, 'PATCH', { transaction_id: 'dom_400', excluded: true });
    expect(ids((await list(false)).recurring_history).filter((id: string) => id.startsWith('dom'))).toEqual(['dom_430', 'dom_460', 'dom_490']);
    expect(ids((await list()).recurring_history).filter((id: string) => id.startsWith('dom'))).toEqual(['dom_430', 'dom_460', 'dom_490']);
  });

  test('from the cache too; a payload cached before rows carried their account is synced again', async () => {
    await list();
    let body = await list(false);
    expect(body.from_cache).toBe(true);
    expect(ids(body.recurring_history)).toEqual(['biz_then', 'prime_then']);
    expect(body.transactions.every((t: { account_type?: string }) => t.account_type === 'depository')).toBe(true);
    await writeCache(ctx, CacheKey.Transactions, { plaid_only: true, transactions: [], notes: [], as_of: 'then' });
    body = await list(false);
    expect(body.from_cache).toBe(false);
    expect(ids(body.recurring_history)).toEqual(['biz_then', 'prime_then']);
  });

  test('a manual account\'s rows from before the year are sent the same way', async () => {
    await saveManualAccount(ctx, { account_id: 'manual_wallet-1', name: 'Wallet', institution_name: 'Cash', type: 'depository', subtype: null, balance: 200, updated_at: '2026-10-01T12:00:00.000Z' });
    const add = (date: string) => call(manualTxns.POST, 'POST', { account_id: 'manual_wallet-1', date, amount: 60, currency: 'USD', name: 'Fishing licence', category: 'general services', note: null });
    await add(daysAgo(20));
    await add(daysAgo(385));
    const body = await list();
    const licence = body.recurring_history.filter((t: { name: string }) => t.name === 'Fishing licence');
    expect(licence).toHaveLength(1);
    expect(licence[0].date).toBe(daysAgo(385));
    expect(body.transactions.filter((t: { name: string }) => t.name === 'Fishing licence')).toHaveLength(1);
    expect(detectRecurring([...body.transactions, ...body.recurring_history]).find((s) => s.name === 'Fishing licence')?.cadence).toBe('yearly');
  });
});
