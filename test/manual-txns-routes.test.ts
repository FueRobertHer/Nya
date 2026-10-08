import { describe, expect, test, mock, beforeEach, afterEach } from 'bun:test';
import { FakeRedis, storageMock, TEST_CTX, ctxKey, registerTestContainer, unscopedDataKeys } from './fake-redis';

// The routes behind manual transactions and exclusions, called as the app
// calls them: app/api/manual-transactions, app/api/transaction-annotations,
// app/api/recategorize on a manual row, the manual account's DELETE, and the
// merge into app/api/transactions.

process.env.PLAID_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');

// What /transactions/sync answers, for the merge. Declared before mock.module,
// which is hoisted above the imports below it.
let plaidRows: Record<string, unknown>[] = [];
mock.module('@/lib/plaid', () => ({
  plaidClient: {
    transactionsSync: async () => ({
      data: {
        added: plaidRows,
        modified: [],
        removed: [],
        accounts: [{ account_id: 'acct_chk', name: 'Checking', official_name: null, type: 'depository', subtype: 'checking', mask: '0001', balances: { current: 1000, available: 1000, limit: null, iso_currency_code: 'USD' } }],
        next_cursor: 'cursor-1',
        has_more: false,
        transactions_update_status: 'HISTORICAL_UPDATE_COMPLETE',
      },
    }),
  },
}));

// Deserializing like Upstash: what production reads back.
const fake = new FakeRedis({ deserialize: true });
afterEach(() => expect(unscopedDataKeys(fake)).toEqual([]));
mock.module('@/lib/storage', () => storageMock(fake));

const { encrypt } = await import('@/lib/crypto');
const { forgetEpochs } = await import('@/lib/sessions');
const { saveManualAccount, getManualAccount } = await import('@/lib/manual');
const { setAccountHidden } = await import('@/lib/hidden');
const { setOverride } = await import('@/lib/overrides');
const { readCache, writeCache, clearTransactionsCache, CacheKey } = await import('@/lib/cache');
const { manualTxnStore, addManualTxn, newManualTxn, newManualTxnId } = await import('@/lib/manual-txns');
const { txnAnnotationStore, MAX_ANNOTATIONS } = await import('@/lib/txn-annotations');
const manualTxns = await import('@/app/api/manual-transactions/route');
const annotations = await import('@/app/api/transaction-annotations/route');
const transactions = await import('@/app/api/transactions/route');
const recategorize = await import('@/app/api/recategorize/route');
const manualAccounts = await import('@/app/api/manual-accounts/route');
type ManualAccount = import('@/lib/manual').ManualAccount;

const ctx = TEST_CTX;
const OTHER = { container: '3f0b8c1e-6d2a-4b5c-9e7f-0a1b2c3d4e5f' } as typeof TEST_CTX;

const WALLET: ManualAccount = {
  account_id: 'manual_wallet-1',
  name: 'Wallet',
  institution_name: 'Cash',
  type: 'depository',
  subtype: null,
  balance: 200,
  updated_at: '2026-10-01T12:00:00.000Z',
};
const CARD: ManualAccount = {
  account_id: 'manual_card-1',
  name: 'Travel card',
  institution_name: 'Credit Union',
  type: 'credit',
  subtype: 'credit card',
  balance: 500,
  updated_at: '2026-10-01T12:00:00.000Z',
};

const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);
const FIELDS = { date: daysAgo(2), amount: 12.5, currency: 'USD', name: 'Blue Bottle', category: 'food and drink', note: null };

type Handler = (req: Request) => Promise<Response>;
/** Calls a route as the browser would, with a JSON body (or raw text). */
async function call(handler: Handler, method: string, body?: unknown, raw?: string): Promise<{ status: number; body: any }> {
  const res = await handler(
    new Request('http://localhost/api/test', {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: raw ?? (body === undefined ? undefined : JSON.stringify(body)),
    })
  );
  return { status: res.status, body: await res.json() };
}
const post = (body: unknown) => call(manualTxns.POST, 'POST', body);
const patch = (body: unknown) => call(manualTxns.PATCH, 'PATCH', body);
const del = (body: unknown) => call(manualTxns.DELETE, 'DELETE', body);
const exclude = (body: unknown) => call(annotations.PATCH, 'PATCH', body);
const list = async (refresh = false) => {
  const res = await transactions.GET(new Request(`http://localhost/api/transactions${refresh ? '?refresh=1' : ''}`));
  return { status: res.status, body: await res.json() };
};

/** Every key the fake holds, with its value(s) as stored. */
function snapshot(): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of (fake as any).strings as Map<string, string>) out[k] = v;
  for (const [k, h] of (fake as any).hashes as Map<string, Map<string, string>>) out[k] = Object.fromEntries(h);
  return out;
}

/** Runs `fn` with console output collected instead of printed. */
async function quietly<T>(fn: () => Promise<T>): Promise<T> {
  const saved = [console.error, console.warn, console.log];
  console.error = console.warn = console.log = () => {};
  try {
    return await fn();
  } finally {
    [console.error, console.warn, console.log] = saved;
  }
}

beforeEach(async () => {
  fake.reset();
  forgetEpochs();
  await registerTestContainer(fake);
  plaidRows = [];
  for (const a of [WALLET, CARD]) await saveManualAccount(ctx, a);
});

describe('adding a transaction', () => {
  test('stores the row, drops the cached transactions, and touches nothing else: no balance, no history', async () => {
    await writeCache(ctx, CacheKey.Transactions, { transactions: [], notes: [], as_of: 'then' });
    await writeCache(ctx, CacheKey.NetWorth, { institutions: [] });
    const before = snapshot();
    const { status, body } = await post({ account_id: WALLET.account_id, ...FIELDS, note: 'team coffee' });
    expect(status).toBe(200);
    expect(body.balance_updated).toBe(false);
    expect(body.transaction).toMatchObject({ account_id: WALLET.account_id, ...FIELDS, note: 'team coffee', source: 'manual', source_id: null });
    expect(body.transaction.id).toStartWith('manual-txn:');
    expect((await manualTxnStore.get(ctx, WALLET.account_id))!.rows).toEqual([body.transaction]);

    // What changed: the book was written and the transactions cache dropped.
    // The manual balance, the history layer and the backfill flag were not.
    const after = snapshot();
    const changed = [...new Set([...Object.keys(before), ...Object.keys(after)])].filter(
      (k) => JSON.stringify(before[k]) !== JSON.stringify(after[k])
    );
    expect(changed.sort()).toEqual([ctxKey('cache:transactions'), ctxKey('manual-transactions')].sort());
    expect(await getManualAccount(ctx, WALLET.account_id)).toEqual(WALLET);
    expect(await readCache(ctx, CacheKey.NetWorth)).not.toBeNull();
  });

  test('the id, source and times are the server’s, whatever the request says', async () => {
    const { body } = await post({
      account_id: WALLET.account_id,
      ...FIELDS,
      id: 'manual-txn:chosen-by-the-client',
      source: 'import:csv',
      source_id: 'FITID-1',
      created_at: '2001-01-01T00:00:00.000Z',
    });
    expect(body.transaction.id).not.toBe('manual-txn:chosen-by-the-client');
    expect(body.transaction).toMatchObject({ source: 'manual', source_id: null });
    expect(body.transaction.created_at).not.toBe('2001-01-01T00:00:00.000Z');
  });

  test('every field is validated before anything is written', async () => {
    const bad: [unknown, number, string][] = [
      [{ ...FIELDS }, 400, 'Choose one of your manual accounts'],
      [{ account_id: 'acct_chk', ...FIELDS }, 400, 'Choose one of your manual accounts'],
      [{ account_id: 'manual_nope', ...FIELDS }, 404, 'That account no longer exists'],
      [{ account_id: WALLET.account_id, ...FIELDS, amount: '12.50' }, 400, 'Enter an amount'],
      [{ account_id: WALLET.account_id, ...FIELDS, amount: 0 }, 400, 'Enter an amount other than zero'],
      [{ account_id: WALLET.account_id, ...FIELDS, amount: 2e12 }, 400, 'That amount is too large'],
      [{ account_id: WALLET.account_id, ...FIELDS, date: '2026-02-30' }, 400, 'That date is not a real day'],
      [{ account_id: WALLET.account_id, ...FIELDS, date: daysAgo(-400) }, 400, "The date can't be more than a year from today"],
      [{ account_id: WALLET.account_id, ...FIELDS, name: '' }, 400, 'Enter who was paid, or who paid you'],
      [{ account_id: WALLET.account_id, ...FIELDS, currency: 'XYZ' }, 400, 'Enter a currency as its three-letter code, like USD or EUR'],
      [{ account_id: WALLET.account_id, ...FIELDS, update_balance: true }, 400, 'Invalid balance update'],
      [{ account_id: WALLET.account_id, ...FIELDS, update_balance: { from: '200' } }, 400, 'Invalid balance update'],
      [[FIELDS], 400, 'Invalid request'],
    ];
    for (const [body, status, error] of bad) {
      expect([body, await post(body)]).toEqual([body, { status, body: { error } }]);
    }
    expect(await call(manualTxns.POST, 'POST', undefined, '{not json')).toEqual({ status: 400, body: { error: 'Invalid request' } });
    expect(await call(manualTxns.POST, 'POST', undefined, JSON.stringify({ ...FIELDS, note: 'x'.repeat(9000) }))).toEqual({
      status: 413,
      body: { error: 'Request too large' },
    });
    expect(await manualTxnStore.count(ctx)).toBe(0);
  });

  test('another container’s account is not one of yours', async () => {
    const theirs = { ...WALLET, account_id: 'manual_theirs-1' };
    await saveManualAccount(OTHER, theirs);
    expect(await post({ account_id: theirs.account_id, ...FIELDS })).toEqual({ status: 404, body: { error: 'That account no longer exists' } });
    expect(await manualTxnStore.count(OTHER)).toBe(0);
    expect(await manualTxnStore.count(ctx)).toBe(0);
  });

  describe('and updating the balance, when asked', () => {
    test('records it as the Update form does: the balance moved the way the money went, stamped, the estimate to rebuild, every cache dropped', async () => {
      await fake.set(ctxKey('history:backfill-done'), '9');
      await writeCache(ctx, CacheKey.NetWorth, { institutions: [] });
      const spent = await post({ account_id: WALLET.account_id, ...FIELDS, update_balance: { from: 200 } });
      expect(spent.status).toBe(200);
      expect(spent.body).toMatchObject({ balance_updated: true, balance: 187.5 });
      const wallet = (await getManualAccount(ctx, WALLET.account_id))!;
      expect(wallet.balance).toBe(187.5);
      expect(wallet.updated_at).not.toBe(WALLET.updated_at);
      expect(await fake.get(ctxKey('history:backfill-done'))).toBeNull();
      expect(await readCache(ctx, CacheKey.NetWorth)).toBeNull();
      // The route writes no history itself: the reload of net worth that
      // follows records today's balance, as after any typed balance.
      expect(Object.keys(snapshot()).filter((k) => k.startsWith(ctxKey('history:')))).toEqual([]);

      // On a card, a purchase raises what is owed and a payment lowers it.
      expect((await post({ account_id: CARD.account_id, ...FIELDS, update_balance: { from: 500 } })).body.balance).toBe(512.5);
      expect((await post({ account_id: CARD.account_id, ...FIELDS, amount: -100, update_balance: { from: 512.5 } })).body.balance).toBe(412.5);
      expect((await getManualAccount(ctx, CARD.account_id))!.balance).toBe(412.5);
    });

    test('a balance that changed since the form opened is never overwritten: nothing is saved, and the reply says what it is now', async () => {
      const { status, body } = await post({ account_id: WALLET.account_id, ...FIELDS, update_balance: { from: 150 } });
      expect(status).toBe(409);
      expect(body.balance).toBe(200);
      expect(body.error).toContain("Wallet's balance changed to $200.00 since this form opened, so nothing was saved");
      expect(await manualTxnStore.count(ctx)).toBe(0);
      expect(await getManualAccount(ctx, WALLET.account_id)).toEqual(WALLET);
    });

    test('a transaction in another currency can’t move a balance kept in dollars', async () => {
      const { status, body } = await post({ account_id: WALLET.account_id, ...FIELDS, currency: 'EUR', update_balance: { from: 200 } });
      expect(status).toBe(400);
      expect(body.error).toBe("Wallet's balance is kept in USD, so a transaction in EUR can't update it.");
      expect(await manualTxnStore.count(ctx)).toBe(0);
      // Without the update, it is saved in its own currency.
      expect((await post({ account_id: WALLET.account_id, ...FIELDS, currency: 'EUR' })).body.transaction.currency).toBe('EUR');
    });

    test('an amount owed is never taken below zero', async () => {
      const { status, body } = await post({ account_id: CARD.account_id, ...FIELDS, amount: -600, update_balance: { from: 500 } });
      expect(status).toBe(400);
      expect(body.error).toStartWith('That would make the amount owed on Travel card negative');
      expect(await manualTxnStore.count(ctx)).toBe(0);
      expect((await getManualAccount(ctx, CARD.account_id))!.balance).toBe(500);
    });
  });
});

describe('editing and deleting a transaction', () => {
  async function added(over: Record<string, unknown> = {}) {
    return (await post({ account_id: WALLET.account_id, ...FIELDS, ...over })).body.transaction;
  }

  test('an edit changes only what it carries, and never the balance', async () => {
    const t = await added({ note: 'team coffee' });
    await writeCache(ctx, CacheKey.Transactions, { transactions: [], notes: [], as_of: 'then' });
    const { status, body } = await patch({ id: t.id, amount: -20, name: 'Refund', note: null, category: 'Income' });
    expect(status).toBe(200);
    expect(body.transaction).toMatchObject({ id: t.id, amount: -20, name: 'Refund', note: null, category: 'income', date: t.date, created_at: t.created_at });
    expect((await manualTxnStore.get(ctx, WALLET.account_id))!.rows).toEqual([body.transaction]);
    expect(await readCache(ctx, CacheKey.Transactions)).toBeNull();
    expect(await getManualAccount(ctx, WALLET.account_id)).toEqual(WALLET);
  });

  test('a new account moves it, keeping its id', async () => {
    const t = await added();
    const { body } = await patch({ id: t.id, account_id: CARD.account_id });
    expect(body.transaction).toMatchObject({ id: t.id, account_id: CARD.account_id });
    expect(await manualTxnStore.has(ctx, WALLET.account_id)).toBe(false);
    expect((await manualTxnStore.get(ctx, CARD.account_id))!.rows.map((r) => r.id)).toEqual([t.id]);
  });

  test('refused when malformed, empty, or aimed at an account or row that isn’t there', async () => {
    const t = await added();
    const bad: [unknown, number, string][] = [
      [{ id: 'lPNjeW1nR6CDn5okmGQ6hEpMo4lLNoSrzqDje', amount: 1 }, 400, 'Invalid transaction id'],
      [{ id: t.id }, 400, 'Nothing to change'],
      [{ id: t.id, amount: 0 }, 400, 'Enter an amount other than zero'],
      [{ id: t.id, account_id: 'manual_nope' }, 404, 'That account no longer exists'],
      [{ id: newManualTxnId(), amount: 1 }, 404, 'That transaction no longer exists'],
    ];
    for (const [body, status, error] of bad) expect([body, await patch(body)]).toEqual([body, { status, body: { error } }]);
    expect((await manualTxnStore.get(ctx, WALLET.account_id))!.rows).toEqual([t]);
  });

  test('a delete removes the row and the exclusion on it; deleting it again is no error', async () => {
    const t = await added();
    const kept = await added({ name: 'Bakery' });
    expect((await exclude({ transaction_id: t.id, excluded: true })).status).toBe(200);
    await writeCache(ctx, CacheKey.Transactions, { transactions: [], notes: [], as_of: 'then' });
    expect(await del({ id: t.id })).toEqual({ status: 200, body: { success: true, deleted: true } });
    expect((await manualTxnStore.get(ctx, WALLET.account_id))!.rows).toEqual([kept]);
    expect(await txnAnnotationStore.has(ctx, t.id)).toBe(false);
    expect(await readCache(ctx, CacheKey.Transactions)).toBeNull();
    expect(await del({ id: t.id })).toEqual({ status: 200, body: { success: true, deleted: false } });
    expect(await del({ id: 'not-an-id' })).toEqual({ status: 400, body: { error: 'Invalid transaction id' } });
  });

  test('another container’s row can be neither changed nor deleted from here', async () => {
    const theirs = newManualTxn('manual_theirs-1', FIELDS);
    await addManualTxn(OTHER, theirs);
    expect((await patch({ id: theirs.id, amount: 1 })).status).toBe(404);
    expect((await del({ id: theirs.id })).body.deleted).toBe(false);
    expect((await manualTxnStore.get(OTHER, 'manual_theirs-1'))!.rows).toEqual([theirs]);
  });

  test('a book that can’t be read is never written over: 409, flagged, naming it', async () => {
    const t = await added();
    await fake.hset(ctxKey('manual-transactions'), { [CARD.account_id]: 'not-ciphertext-but-long-enough-to-be-tried' });
    // The row is in a book that reads, so it can still be changed.
    expect((await patch({ id: t.id, amount: 2 })).status).toBe(200);
    // One that isn't found might be in the unreadable book.
    const r = await quietly(() => patch({ id: newManualTxnId(), amount: 2 }));
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ unreadable: true, unreadable_ids: [CARD.account_id], unrecognised_ids: [] });
    expect(r.body.error).toBe('Your saved manual transactions could not be read, so they were left untouched.');
    expect((await quietly(() => del({ id: newManualTxnId() }))).status).toBe(409);
    expect(fake.hashes.get(ctxKey('manual-transactions'))!.get(CARD.account_id)).toBe('not-ciphertext-but-long-enough-to-be-tried');
  });

  test('recategorizing a manual row changes the row itself, with no override written', async () => {
    const t = await added();
    expect(await call(recategorize.POST, 'POST', { transaction_id: t.id, category: 'Travel' })).toEqual({ status: 200, body: { success: true } });
    expect((await manualTxnStore.get(ctx, WALLET.account_id))!.rows[0].category).toBe('travel');
    expect(fake.hashes.get(ctxKey('txn-category-overrides'))).toBeUndefined();
    expect((await call(recategorize.POST, 'POST', { transaction_id: newManualTxnId(), category: 'travel' })).status).toBe(404);
    expect((await call(recategorize.POST, 'POST', { transaction_id: 'manual-txn:has space', category: 'travel' })).status).toBe(400);
    // A Plaid row's category is still an override, as before.
    expect((await call(recategorize.POST, 'POST', { transaction_id: 'plaid_txn_1', category: 'travel' })).status).toBe(200);
    expect(fake.hashes.get(ctxKey('txn-category-overrides'))!.has('plaid_txn_1')).toBe(true);
  });

  test('deleting a manual account deletes its transactions and what was said about them, and nothing of another account’s', async () => {
    const t = await added();
    const other = (await post({ account_id: CARD.account_id, ...FIELDS })).body.transaction;
    for (const id of [t.id, other.id, 'plaid_txn_1']) await exclude({ transaction_id: id, excluded: true });
    const res = await call(manualAccounts.DELETE, 'DELETE', { account_id: WALLET.account_id });
    expect(res).toEqual({ status: 200, body: { success: true } });
    expect(await getManualAccount(ctx, WALLET.account_id)).toBeNull();
    expect(await manualTxnStore.has(ctx, WALLET.account_id)).toBe(false);
    expect(await txnAnnotationStore.has(ctx, t.id)).toBe(false);
    expect((await manualTxnStore.get(ctx, CARD.account_id))!.rows).toEqual([other]);
    expect(await txnAnnotationStore.has(ctx, other.id)).toBe(true);
    expect(await txnAnnotationStore.has(ctx, 'plaid_txn_1')).toBe(true);
  });
});

describe('excluding a transaction', () => {
  test('sets and clears the flag on any transaction, Plaid’s or manual, and drops the cached transactions', async () => {
    await writeCache(ctx, CacheKey.Transactions, { transactions: [], notes: [], as_of: 'then' });
    expect(await exclude({ transaction_id: 'plaid_txn_1', excluded: true })).toEqual({ status: 200, body: { transaction_id: 'plaid_txn_1', excluded: true } });
    expect(await txnAnnotationStore.get(ctx, 'plaid_txn_1')).toMatchObject({ excluded: true });
    expect(await readCache(ctx, CacheKey.Transactions)).toBeNull();
    // Cleared, nothing is left to say: no record at all.
    expect(await exclude({ transaction_id: 'plaid_txn_1', excluded: false })).toEqual({ status: 200, body: { transaction_id: 'plaid_txn_1', excluded: false } });
    expect(await txnAnnotationStore.has(ctx, 'plaid_txn_1')).toBe(false);
    // A manual row's id is a transaction id like any other.
    const id = newManualTxnId();
    expect((await exclude({ transaction_id: id, excluded: true })).body.excluded).toBe(true);
  });

  test('what a later release says about a transaction survives an edit here', async () => {
    await fake.hset(ctxKey('transaction-annotations'), {
      plaid_txn_1: await encrypt(JSON.stringify({ excluded: true, note: 'birthday dinner', updated_at: '2026-10-01T00:00:00.000Z' })),
    });
    await exclude({ transaction_id: 'plaid_txn_1', excluded: false });
    const kept = await txnAnnotationStore.get(ctx, 'plaid_txn_1');
    expect(kept).toMatchObject({ note: 'birthday dinner' });
    expect(kept!.excluded).toBeUndefined();
  });

  test('refused when malformed', async () => {
    const bad: [unknown, string][] = [
      [{ transaction_id: 'has space', excluded: true }, 'Invalid transaction id'],
      [{ transaction_id: 'x'.repeat(201), excluded: true }, 'Invalid transaction id'],
      [{ transaction_id: '__proto__', excluded: true }, 'Invalid transaction id'],
      [{ transaction_id: 7, excluded: true }, 'Invalid transaction id'],
      [{ transaction_id: 'plaid_txn_1', excluded: 'yes' }, 'Say whether to exclude it'],
      [{ transaction_id: 'plaid_txn_1' }, 'Say whether to exclude it'],
    ];
    for (const [body, error] of bad) expect([body, await exclude(body)]).toEqual([body, { status: 400, body: { error } }]);
    expect(await call(annotations.PATCH, 'PATCH', undefined, 'nope')).toEqual({ status: 400, body: { error: 'Invalid request' } });
    expect(await txnAnnotationStore.count(ctx)).toBe(0);
  });

  test('a record that can’t be read is refused, never replaced', async () => {
    await fake.hset(ctxKey('transaction-annotations'), { plaid_txn_1: 'not-ciphertext-but-long-enough-to-be-tried' });
    const r = await quietly(() => exclude({ transaction_id: 'plaid_txn_1', excluded: false }));
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ unreadable: true, unreadable_ids: ['plaid_txn_1'] });
    expect(fake.hashes.get(ctxKey('transaction-annotations'))!.get('plaid_txn_1')).toBe('not-ciphertext-but-long-enough-to-be-tried');
  });

  test('past the limit a new one is refused; one already there can still change', async () => {
    const hash = new Map<string, string>();
    for (let i = 0; i < MAX_ANNOTATIONS; i++) hash.set(`t${i}`, 'x');
    hash.set('t0', await encrypt(JSON.stringify({ excluded: true, updated_at: '2026-10-01T00:00:00.000Z' })));
    (fake as any).hashes.set(ctxKey('transaction-annotations'), hash);
    const r = await exclude({ transaction_id: 'one_more', excluded: true });
    expect(r).toEqual({ status: 400, body: { error: 'At most 20,000 transactions can be excluded. Include some again first.' } });
    expect((await exclude({ transaction_id: 't0', excluded: false })).status).toBe(200);
  });

  test('each container keeps its own', async () => {
    await exclude({ transaction_id: 'plaid_txn_1', excluded: true });
    expect(await txnAnnotationStore.has(OTHER, 'plaid_txn_1')).toBe(false);
  });
});

describe('in /api/transactions', () => {
  const ITEM = async () => ({ item_id: 'item_a', institution_name: 'Big Bank', encrypted_access_token: await encrypt('access-token') });
  const plaid = (over: Record<string, unknown>) => ({
    transaction_id: 'p1',
    account_id: 'acct_chk',
    amount: 40,
    iso_currency_code: 'USD',
    date: daysAgo(1),
    name: 'GROCER 123',
    merchant_name: 'Grocer',
    pending: false,
    counterparties: [],
    ...over,
  });

  beforeEach(async () => {
    await fake.hset(ctxKey('plaid:items'), { item_a: JSON.stringify(await ITEM()) });
  });

  test('manual rows sit among Plaid’s, newest first, labelled with their account, and a hidden account’s are left out', async () => {
    plaidRows = [plaid({ transaction_id: 'p_new', date: daysAgo(1) }), plaid({ transaction_id: 'p_old', date: daysAgo(5), datetime: `${daysAgo(5)}T10:00:00Z` })];
    const a = (await post({ account_id: WALLET.account_id, ...FIELDS, date: daysAgo(3), name: 'Market' })).body.transaction;
    const b = (await post({ account_id: WALLET.account_id, ...FIELDS, date: daysAgo(5), name: 'Bakery' })).body.transaction;
    await post({ account_id: CARD.account_id, ...FIELDS, name: 'On the hidden card' });
    await setAccountHidden(ctx, CARD.account_id, 'credit', true);
    const { status, body } = await list(true);
    expect(status).toBe(200);
    expect(body.transactions.map((t: any) => t.transaction_id)).toEqual(['p_new', a.id, 'p_old', b.id]);
    expect(body.transactions[1]).toMatchObject({ name: 'Market', account_name: 'Wallet', institution_name: 'Cash', source: 'manual', account_id: WALLET.account_id, pending: false });
    expect(body.transactions[0].source).toBeUndefined();
    expect(body.notes).toEqual([]);
  });

  test('an override or rename never lands on a manual row; its own category and payee stand', async () => {
    plaidRows = [plaid({ transaction_id: 'p1' })];
    const t = (await post({ account_id: WALLET.account_id, ...FIELDS })).body.transaction;
    await setOverride(ctx, t.id, 'travel'); // as if written before this existed
    await setOverride(ctx, 'p1', 'shopping');
    const { body } = await list(true);
    const byId = Object.fromEntries(body.transactions.map((x: any) => [x.transaction_id, x]));
    expect(byId[t.id]).toMatchObject({ category: 'food and drink', name: 'Blue Bottle', vendor_key: '' });
    expect(byId.p1.category).toBe('shopping');
  });

  test('excluded rows are marked and still listed; one whose exclusion can’t be read is marked unknown and the payload isn’t cached', async () => {
    plaidRows = [plaid({ transaction_id: 'p1' }), plaid({ transaction_id: 'p2', date: daysAgo(2) })];
    const t = (await post({ account_id: WALLET.account_id, ...FIELDS })).body.transaction;
    await exclude({ transaction_id: 'p1', excluded: true });
    await exclude({ transaction_id: t.id, excluded: true });
    let { body } = await list(true);
    const flags = () => Object.fromEntries(body.transactions.map((x: any) => [x.transaction_id, x.excluded]));
    expect(flags()).toEqual({ p1: true, p2: undefined, [t.id]: true });
    expect(await readCache(ctx, CacheKey.Transactions)).not.toBeNull();

    await fake.hset(ctxKey('transaction-annotations'), { p2: 'not-ciphertext-but-long-enough-to-be-tried' });
    await clearTransactionsCache(ctx);
    ({ body } = await list());
    expect(flags()).toEqual({ p1: true, p2: null, [t.id]: true });
    expect(body.notes).toEqual([]);
    // Not cached, so the next load reads it again.
    expect(await readCache(ctx, CacheKey.Transactions)).toBeNull();
    expect((await list()).body.from_cache).toBe(false);
  });

  test('a manual account whose rows can’t be read is named in a note, Plaid’s rows still show, and nothing is cached', async () => {
    plaidRows = [plaid({ transaction_id: 'p1' })];
    await fake.hset(ctxKey('manual-transactions'), { [WALLET.account_id]: 'not-ciphertext-but-long-enough-to-be-tried' });
    const { body } = await quietly(() => list(true));
    expect(body.transactions.map((t: any) => t.transaction_id)).toEqual(['p1']);
    expect(body.notes).toEqual(["Cash: transactions entered for Wallet couldn't be read"]);
    expect(await readCache(ctx, CacheKey.Transactions)).toBeNull();
  });

  test('every write clears the cached payload, so the next load shows it', async () => {
    plaidRows = [plaid({ transaction_id: 'p1' })];
    expect((await list()).body.from_cache).toBe(false);
    expect((await list()).body.from_cache).toBe(true);
    const t = (await post({ account_id: WALLET.account_id, ...FIELDS })).body.transaction;
    let { body } = await list();
    expect(body.from_cache).toBe(false);
    expect(body.transactions.map((x: any) => x.transaction_id)).toContain(t.id);
    expect((await list()).body.from_cache).toBe(true);
    await patch({ id: t.id, name: 'Renamed' });
    ({ body } = await list());
    expect(body.transactions.find((x: any) => x.transaction_id === t.id).name).toBe('Renamed');
    await exclude({ transaction_id: t.id, excluded: true });
    ({ body } = await list());
    expect(body.transactions.find((x: any) => x.transaction_id === t.id).excluded).toBe(true);
    await del({ id: t.id });
    ({ body } = await list());
    expect(body.transactions.map((x: any) => x.transaction_id)).toEqual(['p1']);
  });
});
