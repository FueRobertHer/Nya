import { describe, expect, test, mock, beforeEach, afterEach } from 'bun:test';
import { FakeRedis, storageMock, TEST_CTX, ctxKey, registerTestContainer, unscopedDataKeys } from './fake-redis';

// The routes behind manual transactions and exclusions, called as the app
// calls them: app/api/manual-transactions, app/api/transaction-annotations,
// app/api/recategorize on a manual row, the manual account's DELETE, and the
// merge into app/api/transactions after its cache of Plaid's rows.

process.env.PLAID_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');

// What /transactions/sync answers, for the merge. Declared before mock.module,
// which is hoisted above the imports below it.
let plaidRows: Record<string, unknown>[] = [];
let syncs = 0;
// Plaid's error code for the next syncs, as when a connection needs reconnecting.
let plaidError: string | null = null;
mock.module('@/lib/plaid', () => ({
  plaidClient: {
    transactionsSync: async () => {
      syncs++;
      if (plaidError) throw { response: { data: { error_code: plaidError } } };
      return {
        data: {
          added: plaidRows,
          modified: [],
          removed: [],
          accounts: [{ account_id: 'acct_chk', name: 'Checking', official_name: null, type: 'depository', subtype: 'checking', mask: '0001', balances: { current: 1000, available: 1000, limit: null, iso_currency_code: 'USD' } }],
          next_cursor: 'cursor-1',
          has_more: false,
          transactions_update_status: 'HISTORICAL_UPDATE_COMPLETE',
        },
      };
    },
  },
}));

// Deserializing like Upstash: what production reads back.
const fake = new FakeRedis({ deserialize: true });
afterEach(() => expect(unscopedDataKeys(fake)).toEqual([]));
mock.module('@/lib/storage', () => storageMock(fake));

const { encrypt } = await import('@/lib/crypto');
const { forgetEpochs } = await import('@/lib/sessions');
const { saveManualAccount, getManualAccount, setManualBalance } = await import('@/lib/manual');
const { setAccountHidden } = await import('@/lib/hidden');
const { setOverride } = await import('@/lib/overrides');
const { readCache, writeCache, clearTransactionsCache, CacheKey } = await import('@/lib/cache');
const { manualTxnStore, addManualTxn, newManualTxn, newManualTxnId, findManualTxn } = await import('@/lib/manual-txns');
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
  syncs = 0;
  plaidError = null;
  delete (fake as any).eval; // a test's atNextScript left armed
  delete (fake as any).hdel;
  for (const a of [WALLET, CARD]) await saveManualAccount(ctx, a);
});

/** Runs `meanwhile` once, just before the next run of the seam's script
 *  `name` reaches storage (after `skip` runs of it), as another device would;
 *  or, with `fail`, makes it fail, as a storage blip would. */
function atNextScript(name: string, opts: { meanwhile?: () => Promise<unknown>; fail?: boolean; skip?: number }) {
  const original = fake.eval.bind(fake);
  let skip = opts.skip ?? 0;
  (fake as any).eval = async (script: string, keys: string[], args: string[]) => {
    if (script.split('\n', 1)[0] !== `-- nya:${name}`) return original(script, keys, args);
    if (skip-- > 0) return original(script, keys, args);
    delete (fake as any).eval;
    if (opts.fail) throw new Error('storage blip');
    await opts.meanwhile?.();
    return original(script, keys, args);
  };
}

/** The keys whose stored value differs between two snapshots. */
const changedKeys = (before: Record<string, unknown>, after: Record<string, unknown>) =>
  [...new Set([...Object.keys(before), ...Object.keys(after)])].filter((k) => JSON.stringify(before[k]) !== JSON.stringify(after[k])).sort();

describe('adding a transaction', () => {
  test('stores the row under the id the form made, and touches nothing else: no balance, no history, no cache', async () => {
    await writeCache(ctx, CacheKey.Transactions, { plaid_only: true, transactions: [], notes: [], as_of: 'then' });
    await writeCache(ctx, CacheKey.NetWorth, { institutions: [] });
    const before = snapshot();
    const id = newManualTxnId();
    const { status, body } = await post({ id, account_id: WALLET.account_id, ...FIELDS, note: 'team coffee' });
    expect(status).toBe(200);
    expect(body).toMatchObject({ added: true, balance_updated: false });
    // As the Activity tab shows it, for the page to put in its list.
    expect(body.transaction).toMatchObject({
      transaction_id: id,
      account_id: WALLET.account_id,
      account_name: 'Wallet',
      institution_name: 'Cash',
      date: FIELDS.date,
      amount: 12.5,
      iso_currency_code: 'USD',
      name: 'Blue Bottle',
      note: 'team coffee',
      source: 'manual',
      pending: false,
    });
    const [stored] = (await manualTxnStore.get(ctx, WALLET.account_id))!.rows;
    expect(stored).toMatchObject({ id, account_id: WALLET.account_id, ...FIELDS, note: 'team coffee', source: 'manual', source_id: null });
    expect(stored.balance_update).toBeUndefined();

    // Filed into the person's categories, as the list files it.
    expect(body.transaction).toMatchObject({ category: FIELDS.category, category_name: FIELDS.category, category_kind: 'expense' });
    expect(body.transaction.category_id).toEqual(expect.any(String));

    // Only the book changed, and the categories, made on this first read of
    // them (lib/category-store.ts): the balance, the history layer, the
    // backfill flag and every cache are as they were.
    expect(changedKeys(before, snapshot())).toEqual([ctxKey('categories'), ctxKey('manual-transactions')]);
    expect(await getManualAccount(ctx, WALLET.account_id)).toEqual(WALLET);
  });

  test('sent again after its answer was lost, it is one row: the answer is the row as saved, and nothing is written', async () => {
    const id = newManualTxnId();
    const first = await post({ id, account_id: WALLET.account_id, ...FIELDS });
    const before = snapshot();
    const again = await post({ id, account_id: WALLET.account_id, ...FIELDS });
    expect(again.status).toBe(200);
    expect(again.body).toEqual({ ...first.body, added: false });
    expect(changedKeys(before, snapshot())).toEqual([]);
    expect((await manualTxnStore.get(ctx, WALLET.account_id))!.rows).toHaveLength(1);
    // Even once it has moved to another account since.
    await patch({ id, account_id: WALLET.account_id, move_to: CARD.account_id });
    const late = await post({ id, account_id: WALLET.account_id, ...FIELDS });
    expect(late.body).toMatchObject({ added: false, transaction: { transaction_id: id, account_id: CARD.account_id, account_name: 'Travel card' } });
    expect(await manualTxnStore.count(ctx)).toBe(1);
  });

  test('the source and times are the server’s, whatever the request says; without an id it makes one', async () => {
    const { body } = await post({ account_id: WALLET.account_id, ...FIELDS, source: 'import:csv', source_id: 'FITID-1', created_at: '2001-01-01T00:00:00.000Z' });
    expect(body.transaction.transaction_id).toStartWith('manual-txn:');
    const { row } = (await findManualTxn(ctx, body.transaction.transaction_id))!;
    expect(row).toMatchObject({ source: 'manual', source_id: null });
    expect(row.created_at).not.toBe('2001-01-01T00:00:00.000Z');
  });

  test('every field is validated before anything is written', async () => {
    const dayAfterTomorrow = new Date(Date.now() + 2 * 86_400_000).toISOString().slice(0, 10);
    const bad: [unknown, number, string][] = [
      [{ ...FIELDS }, 400, 'Choose one of your manual accounts'],
      [{ account_id: 'acct_chk', ...FIELDS }, 400, 'Choose one of your manual accounts'],
      [{ account_id: 'manual_nope', ...FIELDS }, 404, 'That account no longer exists'],
      [{ id: 'plaid_txn_1', account_id: WALLET.account_id, ...FIELDS }, 400, 'Invalid transaction id'],
      [{ account_id: WALLET.account_id, ...FIELDS, amount: '12.50' }, 400, 'Enter an amount'],
      [{ account_id: WALLET.account_id, ...FIELDS, amount: 0 }, 400, 'Enter an amount other than zero'],
      [{ account_id: WALLET.account_id, ...FIELDS, amount: 2e12 }, 400, 'That amount is too large'],
      [{ account_id: WALLET.account_id, ...FIELDS, amount: 12.505 }, 400, 'An amount in USD has at most 2 decimal places'],
      [{ account_id: WALLET.account_id, ...FIELDS, amount: 1e-7 }, 400, 'An amount in USD has at most 2 decimal places'],
      [{ account_id: WALLET.account_id, ...FIELDS, amount: 12.5, currency: 'JPY' }, 400, 'An amount in JPY is a whole number'],
      [{ account_id: WALLET.account_id, ...FIELDS, date: '2026-02-30' }, 400, 'That date is not a real day'],
      [{ account_id: WALLET.account_id, ...FIELDS, date: dayAfterTomorrow }, 400, "The date can't be in the future"],
      [{ account_id: WALLET.account_id, ...FIELDS, name: '' }, 400, 'Enter who was paid, or who paid you'],
      [{ account_id: WALLET.account_id, ...FIELDS, currency: 'XYZ' }, 400, 'Enter a currency as its three-letter code, like USD or EUR'],
      [{ account_id: WALLET.account_id, ...FIELDS, update_balance: true }, 400, 'Invalid balance update'],
      [{ account_id: WALLET.account_id, ...FIELDS, update_balance: { from: 200 } }, 400, 'Invalid balance update'],
      [{ account_id: WALLET.account_id, ...FIELDS, update_balance: { from: '200', to: 187.5 } }, 400, 'Invalid balance update'],
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
    // Tomorrow is taken: a clock in a time zone ahead of the server's is there already.
    const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
    expect((await post({ account_id: WALLET.account_id, ...FIELDS, date: tomorrow })).status).toBe(200);
  });

  test('another container’s account is not one of yours', async () => {
    const theirs = { ...WALLET, account_id: 'manual_theirs-1' };
    await saveManualAccount(OTHER, theirs);
    expect(await post({ account_id: theirs.account_id, ...FIELDS })).toEqual({ status: 404, body: { error: 'That account no longer exists' } });
    expect(await manualTxnStore.count(OTHER)).toBe(0);
    expect(await manualTxnStore.count(ctx)).toBe(0);
  });

  test('an account deleted while the add was saved keeps no book behind', async () => {
    // The whole deletion lands between the add reading the account and writing its row.
    atNextScript('repo-update-entries', { meanwhile: () => call(manualAccounts.DELETE, 'DELETE', { account_id: WALLET.account_id }) });
    expect(await post({ account_id: WALLET.account_id, ...FIELDS })).toEqual({ status: 404, body: { error: 'That account no longer exists' } });
    expect(await manualTxnStore.count(ctx)).toBe(0);
  });

  describe('and updating the balance, when asked', () => {
    const SPENT = { from: 200, to: 187.5 };

    test('moves it from the figure the form showed to the one it said, as the Update form records it: stamped, the estimate to rebuild, net worth’s cache dropped', async () => {
      await fake.set(ctxKey('history:backfill-done'), '9');
      await writeCache(ctx, CacheKey.NetWorth, { institutions: [] });
      await writeCache(ctx, CacheKey.Transactions, { plaid_only: true, transactions: [], notes: [], as_of: 'then' });
      const id = newManualTxnId();
      const spent = await post({ id, account_id: WALLET.account_id, ...FIELDS, update_balance: SPENT });
      expect(spent.status).toBe(200);
      expect(spent.body).toMatchObject({ added: true, balance_updated: true, balance: 187.5 });
      const wallet = (await getManualAccount(ctx, WALLET.account_id))!;
      expect(wallet.balance).toBe(187.5);
      expect(wallet.updated_at).not.toBe(WALLET.updated_at);
      expect(await fake.get(ctxKey('history:backfill-done'))).toBeNull();
      expect(await readCache(ctx, CacheKey.NetWorth)).toBeNull();
      // Plaid's cached rows don't hold a manual balance: they stay.
      expect(await readCache(ctx, CacheKey.Transactions)).not.toBeNull();
      // Noted on the row, so it is never moved twice.
      expect((await findManualTxn(ctx, id))!.row.balance_update).toEqual({ ...SPENT, account_id: WALLET.account_id });
      // The route writes no history itself: the reload of net worth that
      // follows records today's balance, as after any typed balance.
      expect(Object.keys(snapshot()).filter((k) => k.startsWith(ctxKey('history:')))).toEqual([]);

      // On a card, a purchase raises what is owed and a payment lowers it.
      expect((await post({ account_id: CARD.account_id, ...FIELDS, update_balance: { from: 500, to: 512.5 } })).body.balance).toBe(512.5);
      expect((await post({ account_id: CARD.account_id, ...FIELDS, amount: -100, update_balance: { from: 512.5, to: 412.5 } })).body.balance).toBe(412.5);
      expect((await getManualAccount(ctx, CARD.account_id))!.balance).toBe(412.5);
    });

    test('sent again after its answer was lost, it moves the balance once', async () => {
      const id = newManualTxnId();
      expect((await post({ id, account_id: WALLET.account_id, ...FIELDS, update_balance: SPENT })).status).toBe(200);
      const again = await post({ id, account_id: WALLET.account_id, ...FIELDS, update_balance: SPENT });
      expect(again).toMatchObject({ status: 200, body: { added: false, balance_updated: true, balance: 187.5 } });
      expect((await getManualAccount(ctx, WALLET.account_id))!.balance).toBe(187.5);
      expect((await manualTxnStore.get(ctx, WALLET.account_id))!.rows).toHaveLength(1);
      // Even with the balance typed back to what the form showed since: this add has moved it.
      await setManualBalance(ctx, WALLET.account_id, 200);
      expect((await post({ id, account_id: WALLET.account_id, ...FIELDS, update_balance: SPENT })).body.added).toBe(false);
      expect((await getManualAccount(ctx, WALLET.account_id))!.balance).toBe(200);
    });

    test('when the balance couldn’t be saved, the reply says the row was; sending it again finishes the move, once', async () => {
      const id = newManualTxnId();
      atNextScript('repo-update-entry', { fail: true });
      const first = await quietly(() => post({ id, account_id: WALLET.account_id, ...FIELDS, update_balance: SPENT }));
      expect(first.status).toBe(500);
      expect(first.body).toMatchObject({ saved: true, balance_updated: false, transaction: { transaction_id: id } });
      expect(first.body.error).toBe("The transaction was saved, but Wallet's balance may not have been updated. Check it on the account.");
      expect((await getManualAccount(ctx, WALLET.account_id))!.balance).toBe(200);
      const retry = await post({ id, account_id: WALLET.account_id, ...FIELDS, update_balance: SPENT });
      expect(retry).toMatchObject({ status: 200, body: { added: false, balance_updated: true, balance: 187.5 } });
      expect((await post({ id, account_id: WALLET.account_id, ...FIELDS, update_balance: SPENT })).body.balance).toBe(187.5);
      expect((await getManualAccount(ctx, WALLET.account_id))!.balance).toBe(187.5);
    });

    test('moved, but noting it on the row failed: the reply says what is true, and sending it again moves it no further', async () => {
      await fake.set(ctxKey('history:backfill-done'), '9');
      await writeCache(ctx, CacheKey.NetWorth, { institutions: [] });
      const id = newManualTxnId();
      // The add's own write is the first of these; the note's is the second.
      atNextScript('repo-update-entries', { fail: true, skip: 1 });
      const first = await quietly(() => post({ id, account_id: WALLET.account_id, ...FIELDS, update_balance: SPENT }));
      expect(first).toMatchObject({ status: 200, body: { added: true, balance_updated: true, balance: 187.5 } });
      // As after any balance update: the estimate to rebuild, net worth's cache dropped.
      expect(await fake.get(ctxKey('history:backfill-done'))).toBeNull();
      expect(await readCache(ctx, CacheKey.NetWorth)).toBeNull();
      expect((await findManualTxn(ctx, id))!.row.balance_update).toBeUndefined();
      // The account's own record of the move answers the resend.
      const again = await post({ id, account_id: WALLET.account_id, ...FIELDS, update_balance: SPENT });
      expect(again.body).toMatchObject({ added: false, balance_updated: true, balance: 187.5 });
      expect((await getManualAccount(ctx, WALLET.account_id))!.balance).toBe(187.5);
      expect((await findManualTxn(ctx, id))!.row.balance_update).toEqual({ ...SPENT, account_id: WALLET.account_id });
    });

    test('two adds of the same amount at the same moment each move the balance once, or say they didn’t', async () => {
      const a = newManualTxnId();
      const b = newManualTxnId();
      // B is checked and saved, then A lands whole, then B's move: B's form
      // showed $200, the balance is A's $187.50, and only A moved it.
      let first: { status: number; body: any } | null = null;
      atNextScript('repo-update-entry', { meanwhile: async () => (first = await post({ id: a, account_id: WALLET.account_id, ...FIELDS, update_balance: SPENT })) });
      const second = await post({ id: b, account_id: WALLET.account_id, ...FIELDS, name: 'Pharmacy', update_balance: SPENT });
      expect(first!).toMatchObject({ status: 200, body: { balance_updated: true, balance: 187.5 } });
      expect(second).toMatchObject({ status: 409, body: { saved: true, balance_updated: false } });
      expect(second.body.error).toBe("The transaction was saved, but Wallet's balance changed meanwhile, so it wasn't updated. Check it on the account.");
      expect((await getManualAccount(ctx, WALLET.account_id))!.balance).toBe(187.5);
      expect((await findManualTxn(ctx, a))!.row.balance_update).toEqual({ ...SPENT, account_id: WALLET.account_id });
      expect((await findManualTxn(ctx, b))!.row.balance_update).toBeUndefined();
      // Sent again, B is still not A's move.
      expect((await post({ id: b, account_id: WALLET.account_id, ...FIELDS, name: 'Pharmacy', update_balance: SPENT })).body.balance_updated).toBe(false);
      expect((await getManualAccount(ctx, WALLET.account_id))!.balance).toBe(187.5);
    });

    test('sent again with a corrected amount after its answer was lost: refused with what was saved, the row and balance left as they agree', async () => {
      const id = newManualTxnId();
      await post({ id, account_id: WALLET.account_id, ...FIELDS, amount: 50, update_balance: { from: 200, to: 150 } });
      const corrected = await post({ id, account_id: WALLET.account_id, ...FIELDS, amount: 55, update_balance: { from: 200, to: 145 } });
      expect(corrected).toMatchObject({ status: 409, body: { saved: true, added: false, balance_updated: true, balance: 150, transaction: { amount: 50 } } });
      expect(corrected.body.error).toBe(
        "This transaction was saved already, for $50.00 on Wallet, and Wallet's balance moved to $150.00 with it, so nothing more was changed. To change it, edit the transaction, then update the balance from the account."
      );
      expect((await findManualTxn(ctx, id))!.row.amount).toBe(50);
      expect((await getManualAccount(ctx, WALLET.account_id))!.balance).toBe(150);
      // Unticked on the second try, the same: the balance moved with the first.
      expect((await post({ id, account_id: WALLET.account_id, ...FIELDS, amount: 55 })).status).toBe(409);
    });

    test('sent again on another account after its answer was lost: refused with what was saved, so the row stays where its balance moved', async () => {
      const JAR: ManualAccount = { ...WALLET, account_id: 'manual_jar-1', name: 'Jar', balance: 80 };
      await saveManualAccount(ctx, JAR);
      const id = newManualTxnId();
      await post({ id, account_id: WALLET.account_id, ...FIELDS, amount: 50, update_balance: { from: 200, to: 150 } }); // answer lost
      // The form switched to Jar, which unticks the balance, and Add tapped again.
      const moved = await post({ id, account_id: JAR.account_id, ...FIELDS, amount: 50 });
      expect(moved).toMatchObject({ status: 409, body: { saved: true, added: false, balance_updated: true, balance: 150, transaction: { account_id: WALLET.account_id } } });
      expect(moved.body.error).toBe(
        "This transaction was saved already, for $50.00 on Wallet, and Wallet's balance moved to $150.00 with it, so nothing more was changed. To change it, edit the transaction, then update the balance from the account."
      );
      // Ticked again on Jar, the same.
      expect((await post({ id, account_id: JAR.account_id, ...FIELDS, amount: 50, update_balance: { from: 80, to: 30 } })).status).toBe(409);
      expect((await findManualTxn(ctx, id))!.account_id).toBe(WALLET.account_id);
      expect((await getManualAccount(ctx, WALLET.account_id))!.balance).toBe(150);
      expect((await getManualAccount(ctx, JAR.account_id))!.balance).toBe(80);
      // With no balance in it, a resend on another account is the form's to move with an edit.
      const plain = newManualTxnId();
      await post({ id: plain, account_id: WALLET.account_id, ...FIELDS });
      expect((await post({ id: plain, account_id: JAR.account_id, ...FIELDS })).body).toMatchObject({ added: false, transaction: { account_id: WALLET.account_id } });
    });

    test('saved by a send whose balance move failed, then sent again corrected: refused, the balance untouched', async () => {
      const id = newManualTxnId();
      atNextScript('repo-update-entry', { fail: true });
      await quietly(() => post({ id, account_id: WALLET.account_id, ...FIELDS, amount: 50, update_balance: { from: 200, to: 150 } }));
      const corrected = await post({ id, account_id: WALLET.account_id, ...FIELDS, amount: 55, update_balance: { from: 200, to: 145 } });
      expect(corrected).toMatchObject({ status: 409, body: { saved: true, balance_updated: false } });
      expect(corrected.body.error).toBe(
        "This transaction was saved already, for $50.00 on Wallet, so nothing more was changed and the balance wasn't updated. To change it, edit the transaction, then update the balance from the account."
      );
      expect((await getManualAccount(ctx, WALLET.account_id))!.balance).toBe(200);
      // Without a balance in it, a corrected resend is the form's to fix with an edit.
      const plain = newManualTxnId();
      await post({ id: plain, account_id: WALLET.account_id, ...FIELDS, amount: 50 });
      expect((await post({ id: plain, account_id: WALLET.account_id, ...FIELDS, amount: 55 })).body).toMatchObject({ added: false, transaction: { amount: 50 } });
    });

    test('sent again after the account’s type changed, its row saved by the first send: says it was saved, and leaves the balance', async () => {
      const id = newManualTxnId();
      atNextScript('repo-update-entry', { fail: true });
      await quietly(() => post({ id, account_id: WALLET.account_id, ...FIELDS, update_balance: SPENT }));
      await saveManualAccount(ctx, { ...WALLET, type: 'credit' });
      const again = await post({ id, account_id: WALLET.account_id, ...FIELDS, update_balance: SPENT });
      expect(again).toMatchObject({ status: 409, body: { saved: true, added: false, balance_updated: false, transaction: { transaction_id: id } } });
      expect(again.body.error).toBe("The transaction was saved already, but Wallet changed since this form opened, so its balance wasn't updated. Check it on the account.");
      expect(await manualTxnStore.count(ctx)).toBe(1);
      expect((await getManualAccount(ctx, WALLET.account_id))!.balance).toBe(200);
    });

    test('a balance that changed since the form opened is never overwritten: nothing is saved, and the reply says what it is now', async () => {
      const { status, body } = await post({ account_id: WALLET.account_id, ...FIELDS, update_balance: { from: 150, to: 137.5 } });
      expect(status).toBe(409);
      expect(body.balance).toBe(200);
      expect(body.error).toContain("Wallet's balance changed to $200.00 since this form opened, so nothing was saved");
      expect(await manualTxnStore.count(ctx)).toBe(0);
      expect(await getManualAccount(ctx, WALLET.account_id)).toEqual(WALLET);
    });

    test('a figure this transaction doesn’t make of the one shown is refused: an account whose type changed would move the other way', async () => {
      // The form showed a held balance; on another device it became a card since.
      await saveManualAccount(ctx, { ...WALLET, type: 'credit' });
      const { status, body } = await post({ account_id: WALLET.account_id, ...FIELDS, update_balance: SPENT });
      expect(status).toBe(409);
      expect(body.error).toBe('Wallet changed since this form opened, so nothing was saved. Check it and save again.');
      expect(await manualTxnStore.count(ctx)).toBe(0);
      expect((await getManualAccount(ctx, WALLET.account_id))!.balance).toBe(200);
    });

    test('a balance changed between the check and the move is left as it is: the row is saved, and the reply says the balance wasn’t updated', async () => {
      atNextScript('repo-update-entry', { meanwhile: () => setManualBalance(ctx, WALLET.account_id, 175) });
      const { status, body } = await post({ account_id: WALLET.account_id, ...FIELDS, update_balance: SPENT });
      expect(status).toBe(409);
      expect(body).toMatchObject({ saved: true, balance_updated: false });
      expect(body.error).toBe("The transaction was saved, but Wallet's balance changed meanwhile, so it wasn't updated. Check it on the account.");
      expect((await getManualAccount(ctx, WALLET.account_id))!.balance).toBe(175);
      expect(await manualTxnStore.count(ctx)).toBe(1);
    });

    test('a transaction in another currency can’t move a balance kept in dollars', async () => {
      const { status, body } = await post({ account_id: WALLET.account_id, ...FIELDS, currency: 'EUR', update_balance: SPENT });
      expect(status).toBe(400);
      expect(body.error).toBe("Wallet's balance is kept in USD, so a transaction in EUR can't update it.");
      expect(await manualTxnStore.count(ctx)).toBe(0);
      // Without the update, it is saved in its own currency.
      expect((await post({ account_id: WALLET.account_id, ...FIELDS, currency: 'EUR' })).body.transaction.iso_currency_code).toBe('EUR');
    });

    test('an amount owed is never taken below zero', async () => {
      const { status, body } = await post({ account_id: CARD.account_id, ...FIELDS, amount: -600, update_balance: { from: 500, to: -100 } });
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

  test('an edit changes only what it carries, never the balance, and drops no cache', async () => {
    const t = await added({ note: 'team coffee' });
    await writeCache(ctx, CacheKey.Transactions, { plaid_only: true, transactions: [], notes: [], as_of: 'then' });
    const { status, body } = await patch({ id: t.transaction_id, account_id: WALLET.account_id, amount: -20, name: 'Refund', note: null, category: 'Income' });
    expect(status).toBe(200);
    expect(body.transaction).toMatchObject({ transaction_id: t.transaction_id, amount: -20, name: 'Refund', note: null, category: 'income', date: t.date, account_name: 'Wallet' });
    const { row } = (await findManualTxn(ctx, t.transaction_id))!;
    expect(row).toMatchObject({ amount: -20, name: 'Refund', note: null, category: 'income' });
    expect(await readCache(ctx, CacheKey.Transactions)).not.toBeNull();
    expect(await getManualAccount(ctx, WALLET.account_id)).toEqual(WALLET);
  });

  test('move_to moves it, keeping its id', async () => {
    const t = await added();
    const { body } = await patch({ id: t.transaction_id, account_id: WALLET.account_id, move_to: CARD.account_id });
    expect(body.transaction).toMatchObject({ transaction_id: t.transaction_id, account_id: CARD.account_id, account_name: 'Travel card' });
    expect(await manualTxnStore.has(ctx, WALLET.account_id)).toBe(false);
    expect((await manualTxnStore.get(ctx, CARD.account_id))!.rows.map((r) => r.id)).toEqual([t.transaction_id]);
  });

  test('with the account the page shows it on, only that book is read', async () => {
    const t = await added();
    await fake.hset(ctxKey('manual-transactions'), { [CARD.account_id]: 'not-ciphertext-but-long-enough-to-be-tried' });
    expect((await patch({ id: t.transaction_id, account_id: WALLET.account_id, amount: 2 })).status).toBe(200);
    expect((await del({ id: t.transaction_id, account_id: WALLET.account_id })).body).toEqual({ success: true, deleted: true });
  });

  test('refused when malformed, empty, or aimed at an account or row that isn’t there', async () => {
    const t = await added();
    const id = t.transaction_id;
    const gone = 'That transaction was deleted or moved since this page loaded. Reload to see it.';
    const bad: [unknown, number, string][] = [
      [{ id: 'lPNjeW1nR6CDn5okmGQ6hEpMo4lLNoSrzqDje', amount: 1 }, 400, 'Invalid transaction id'],
      [{ id, account_id: 'acct_chk', amount: 1 }, 400, 'Invalid account id'],
      [{ id }, 400, 'Nothing to change'],
      [{ id, amount: 0 }, 400, 'Enter an amount other than zero'],
      [{ id, amount: 1.001 }, 400, 'An amount in USD has at most 2 decimal places'],
      // The currency alone, against the amount stored (12.50).
      [{ id, account_id: WALLET.account_id, currency: 'JPY' }, 400, 'An amount in JPY is a whole number'],
      [{ id, move_to: 'manual_nope' }, 404, 'That account no longer exists'],
      [{ id: newManualTxnId(), amount: 1 }, 404, gone],
      // Not where the page shows it: moved or deleted on another device.
      [{ id, account_id: CARD.account_id, amount: 1 }, 404, gone],
    ];
    for (const [body, status, error] of bad) expect([body, await patch(body)]).toEqual([body, { status, body: { error } }]);
    expect((await findManualTxn(ctx, id))!.row).toMatchObject({ amount: 12.5, currency: 'USD' });
  });

  test('a move into an account deleted meanwhile takes the row with it', async () => {
    const t = await added();
    atNextScript('repo-update-entries', {
      meanwhile: async () => {
        await call(manualAccounts.DELETE, 'DELETE', { account_id: CARD.account_id });
      },
    });
    expect(await patch({ id: t.transaction_id, account_id: WALLET.account_id, move_to: CARD.account_id })).toEqual({
      status: 404,
      body: { error: 'That account no longer exists' },
    });
    expect(await manualTxnStore.count(ctx)).toBe(0);
  });

  test('a delete removes the row and the exclusion on it; deleting it again is no error', async () => {
    const t = await added();
    const kept = await added({ name: 'Bakery' });
    expect((await exclude({ transaction_id: t.transaction_id, excluded: true })).status).toBe(200);
    expect(await del({ id: t.transaction_id, account_id: WALLET.account_id })).toEqual({ status: 200, body: { success: true, deleted: true } });
    expect((await manualTxnStore.get(ctx, WALLET.account_id))!.rows.map((r) => r.id)).toEqual([kept.transaction_id]);
    expect(await txnAnnotationStore.has(ctx, t.transaction_id)).toBe(false);
    expect(await del({ id: t.transaction_id })).toEqual({ status: 200, body: { success: true, deleted: false } });
    expect(await del({ id: 'not-an-id' })).toEqual({ status: 400, body: { error: 'Invalid transaction id' } });
    expect(await del({ id: kept.transaction_id, account_id: 'acct_chk' })).toEqual({ status: 400, body: { error: 'Invalid account id' } });
  });

  test('another container’s row can be neither changed nor deleted from here', async () => {
    const theirs = newManualTxn('manual_theirs-1', FIELDS);
    await addManualTxn(OTHER, theirs);
    expect((await patch({ id: theirs.id, amount: 1 })).status).toBe(404);
    expect((await patch({ id: theirs.id, account_id: 'manual_theirs-1', amount: 1 })).status).toBe(404);
    expect((await del({ id: theirs.id })).body.deleted).toBe(false);
    expect((await manualTxnStore.get(OTHER, 'manual_theirs-1'))!.rows).toEqual([theirs]);
  });

  test('a book that can’t be read is never written over: 409, flagged, naming it', async () => {
    const t = await added();
    await fake.hset(ctxKey('manual-transactions'), { [CARD.account_id]: 'not-ciphertext-but-long-enough-to-be-tried' });
    // The row is in a book that reads, so it can still be changed.
    expect((await patch({ id: t.transaction_id, amount: 2 })).status).toBe(200);
    // One that isn't found might be in the unreadable book.
    const r = await quietly(() => patch({ id: newManualTxnId(), amount: 2 }));
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ unreadable: true, unreadable_ids: [CARD.account_id], unrecognised_ids: [] });
    expect(r.body.error).toBe('Your saved manual transactions could not be read, so they were left untouched.');
    expect((await quietly(() => del({ id: newManualTxnId() }))).status).toBe(409);
    // Named as on the unreadable book: refused the same way.
    expect((await quietly(() => patch({ id: t.transaction_id, account_id: CARD.account_id, amount: 3 }))).status).toBe(409);
    expect(fake.hashes.get(ctxKey('manual-transactions'))!.get(CARD.account_id)).toBe('not-ciphertext-but-long-enough-to-be-tried');
  });

  test('recategorizing a manual row changes the row itself, with no override written and no cache dropped', async () => {
    const t = await added();
    await writeCache(ctx, CacheKey.Transactions, { plaid_only: true, transactions: [], notes: [], as_of: 'then' });
    const recat = (body: unknown) => call(recategorize.POST, 'POST', body);
    expect(await recat({ transaction_id: t.transaction_id, account_id: WALLET.account_id, category: 'Travel' })).toEqual({ status: 200, body: { success: true } });
    expect((await findManualTxn(ctx, t.transaction_id))!.row.category).toBe('travel');
    expect(fake.hashes.get(ctxKey('txn-category-overrides'))).toBeUndefined();
    expect(await readCache(ctx, CacheKey.Transactions)).not.toBeNull();
    // Without the account, it is found all the same.
    expect((await recat({ transaction_id: t.transaction_id, category: 'food and drink' })).status).toBe(200);
    expect((await recat({ transaction_id: t.transaction_id, account_id: CARD.account_id, category: 'travel' })).status).toBe(404);
    expect((await recat({ transaction_id: t.transaction_id, account_id: 'acct_chk', category: 'travel' })).status).toBe(400);
    expect((await recat({ transaction_id: newManualTxnId(), category: 'travel' })).status).toBe(404);
    expect((await recat({ transaction_id: 'manual-txn:has space', category: 'travel' })).status).toBe(400);
    // A Plaid row's category is still an override, and its cached copy goes.
    expect((await recat({ transaction_id: 'plaid_txn_1', category: 'travel' })).status).toBe(200);
    expect(fake.hashes.get(ctxKey('txn-category-overrides'))!.has('plaid_txn_1')).toBe(true);
    expect(await readCache(ctx, CacheKey.Transactions)).toBeNull();
  });

  test('deleting a manual account deletes its transactions and what was said about them, and nothing of another account’s', async () => {
    const t = await added();
    const other = (await post({ account_id: CARD.account_id, ...FIELDS })).body.transaction;
    for (const id of [t.transaction_id, other.transaction_id, 'plaid_txn_1']) await exclude({ transaction_id: id, excluded: true });
    const res = await call(manualAccounts.DELETE, 'DELETE', { account_id: WALLET.account_id });
    expect(res).toEqual({ status: 200, body: { success: true } });
    expect(await getManualAccount(ctx, WALLET.account_id)).toBeNull();
    expect(await manualTxnStore.has(ctx, WALLET.account_id)).toBe(false);
    expect(await txnAnnotationStore.has(ctx, t.transaction_id)).toBe(false);
    expect((await manualTxnStore.get(ctx, CARD.account_id))!.rows.map((r) => r.id)).toEqual([other.transaction_id]);
    expect(await txnAnnotationStore.has(ctx, other.transaction_id)).toBe(true);
    expect(await txnAnnotationStore.has(ctx, 'plaid_txn_1')).toBe(true);
  });

  test('a manual account can be marked as cash on hand, and back: depository with the subtype cash', async () => {
    const { isCashOnHand, CASH_SUBTYPE } = await import('@/lib/balance');
    const added = await call(manualAccounts.POST, 'POST', { name: 'Wallet', institution_name: 'Cash', type: 'depository', subtype: CASH_SUBTYPE, balance: 40 });
    expect(added.status).toBe(200);
    expect(added.body.account).toMatchObject({ type: 'depository', subtype: 'cash' });
    expect(isCashOnHand(added.body.account)).toBe(true);
    // An existing checking account is not cash until it says so, and can be told so.
    expect(isCashOnHand(WALLET)).toBe(false);
    const marked = await call(manualAccounts.PATCH, 'PATCH', { ...WALLET, subtype: CASH_SUBTYPE });
    expect(isCashOnHand(marked.body.account)).toBe(true);
    const back = await call(manualAccounts.PATCH, 'PATCH', { ...WALLET, subtype: null });
    expect(isCashOnHand(back.body.account)).toBe(false);
    expect(isCashOnHand({ type: 'credit', subtype: CASH_SUBTYPE })).toBe(false);
  });

  test('an add landing while the account is deleted is swept up after it', async () => {
    // Between the deletion's first sweep and the account going, an add writes the book again.
    const hdel = fake.hdel.bind(fake);
    (fake as any).hdel = async (key: string, ...fields: string[]) => {
      if (key === ctxKey('manual:accounts')) {
        delete (fake as any).hdel;
        await addManualTxn(ctx, newManualTxn(WALLET.account_id, FIELDS));
      }
      return hdel(key, ...fields);
    };
    expect((await call(manualAccounts.DELETE, 'DELETE', { account_id: WALLET.account_id })).status).toBe(200);
    expect(await manualTxnStore.has(ctx, WALLET.account_id)).toBe(false);
  });
});

describe('excluding a transaction', () => {
  test('sets the flag on any transaction, Plaid’s or manual, and including it again is recorded too; no cache is dropped', async () => {
    await writeCache(ctx, CacheKey.Transactions, { plaid_only: true, transactions: [], notes: [], as_of: 'then' });
    expect(await exclude({ transaction_id: 'plaid_txn_1', excluded: true })).toEqual({ status: 200, body: { transaction_id: 'plaid_txn_1', excluded: true } });
    expect(await txnAnnotationStore.get(ctx, 'plaid_txn_1')).toMatchObject({ excluded: true });
    expect(await readCache(ctx, CacheKey.Transactions)).not.toBeNull();
    // Put back: said, and kept, so it beats an exclusion carried across a re-link (and later a rule).
    expect(await exclude({ transaction_id: 'plaid_txn_1', excluded: false })).toEqual({ status: 200, body: { transaction_id: 'plaid_txn_1', excluded: false } });
    expect(await txnAnnotationStore.get(ctx, 'plaid_txn_1')).toMatchObject({ excluded: false });
    // A manual row's id is a transaction id like any other.
    const id = newManualTxnId();
    expect((await exclude({ transaction_id: id, excluded: true })).body.excluded).toBe(true);
  });

  test('what a later release says about a transaction survives an edit here', async () => {
    await fake.hset(ctxKey('transaction-annotations'), {
      plaid_txn_1: await encrypt(JSON.stringify({ excluded: true, note: 'birthday dinner', updated_at: '2026-10-01T00:00:00.000Z' })),
    });
    await exclude({ transaction_id: 'plaid_txn_1', excluded: false });
    expect(await txnAnnotationStore.get(ctx, 'plaid_txn_1')).toMatchObject({ note: 'birthday dinner', excluded: false });
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
    expect(r).toEqual({ status: 400, body: { error: 'At most 20,000 transactions can be excluded or included by hand. Clear some first.' } });
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
  const ids = (body: any) => body.transactions.map((t: any) => t.transaction_id);

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
    expect(ids(body)).toEqual(['p_new', a.transaction_id, 'p_old', b.transaction_id]);
    // Each manual row exactly as its add answered it.
    expect(body.transactions[1]).toEqual(a);
    expect(body.transactions[0].source).toBeUndefined();
    expect(body.transactions[0].unofficial_currency_code).toBeNull();
    expect(body.notes).toEqual([]);
  });

  test('an override or rename never lands on a manual row; its own category and payee stand', async () => {
    plaidRows = [plaid({ transaction_id: 'p1' })];
    const t = (await post({ account_id: WALLET.account_id, ...FIELDS })).body.transaction;
    await setOverride(ctx, t.transaction_id, 'travel'); // as if written before this existed
    await setOverride(ctx, 'p1', 'shopping');
    const { body } = await list(true);
    const byId = Object.fromEntries(body.transactions.map((x: any) => [x.transaction_id, x]));
    expect(byId[t.transaction_id]).toMatchObject({ category: 'food and drink', name: 'Blue Bottle', vendor_key: '' });
    expect(byId.p1.category).toBe('shopping');
  });

  test('only Plaid’s rows are cached: an add, an edit, an exclusion and a delete each show on the next load, with no sync', async () => {
    plaidRows = [plaid({ transaction_id: 'p1' })];
    expect((await list()).body.from_cache).toBe(false);
    expect(syncs).toBe(1);
    const t = (await post({ account_id: WALLET.account_id, ...FIELDS })).body.transaction;
    let { body } = await list();
    expect(body.from_cache).toBe(true);
    expect(ids(body)).toEqual(['p1', t.transaction_id]);
    await patch({ id: t.transaction_id, account_id: WALLET.account_id, name: 'Renamed' });
    ({ body } = await list());
    expect(body.transactions.find((x: any) => x.transaction_id === t.transaction_id).name).toBe('Renamed');
    await exclude({ transaction_id: t.transaction_id, excluded: true });
    await exclude({ transaction_id: 'p1', excluded: true });
    ({ body } = await list());
    expect(body.transactions.map((x: any) => x.excluded)).toEqual([true, true]);
    await exclude({ transaction_id: 'p1', excluded: false });
    await del({ id: t.transaction_id, account_id: WALLET.account_id });
    ({ body } = await list());
    expect(body.from_cache).toBe(true);
    expect(ids(body)).toEqual(['p1']);
    expect(body.transactions[0].excluded).toBeUndefined();
    // Every one of those loads came from the cache: Plaid was asked once.
    expect(syncs).toBe(1);
  });

  test('a manual account hidden after Plaid’s rows were cached is left out all the same', async () => {
    plaidRows = [plaid({ transaction_id: 'p1' })];
    await post({ account_id: CARD.account_id, ...FIELDS, name: 'On the card' });
    expect((await list()).body.transactions).toHaveLength(2);
    await setAccountHidden(ctx, CARD.account_id, 'credit', true);
    const { body } = await list();
    expect(body.from_cache).toBe(true);
    expect(ids(body)).toEqual(['p1']);
  });

  test('a payload cached before this release, which held the manual rows, is a miss: they are never shown twice', async () => {
    plaidRows = [plaid({ transaction_id: 'p1' })];
    const t = (await post({ account_id: WALLET.account_id, ...FIELDS })).body.transaction;
    await writeCache(ctx, CacheKey.Transactions, { transactions: [plaid({ transaction_id: 'p_stale' }), t], notes: [], as_of: 'then' });
    const { body } = await list();
    expect(body.from_cache).toBe(false);
    expect(ids(body)).toEqual(['p1', t.transaction_id]);
  });

  test('excluded rows are marked and still listed; one whose record can’t be read is marked unknown, and the cache is kept all the same', async () => {
    plaidRows = [plaid({ transaction_id: 'p1' }), plaid({ transaction_id: 'p2', date: daysAgo(2) })];
    const t = (await post({ account_id: WALLET.account_id, ...FIELDS, date: daysAgo(3) })).body.transaction;
    await exclude({ transaction_id: 'p1', excluded: true });
    await exclude({ transaction_id: t.transaction_id, excluded: true });
    await fake.hset(ctxKey('transaction-annotations'), { p2: 'not-ciphertext-but-long-enough-to-be-tried' });
    let { body } = await list(true);
    const flags = () => Object.fromEntries(body.transactions.map((x: any) => [x.transaction_id, x.excluded]));
    expect(flags()).toEqual({ p1: true, p2: null, [t.transaction_id]: true });
    expect(body.notes).toEqual([]);
    // Cached anyway: the record is read again on every load, the sync isn't.
    ({ body } = await list());
    expect(body.from_cache).toBe(true);
    expect(flags()).toEqual({ p1: true, p2: null, [t.transaction_id]: true });
  });

  test('an institution that couldn’t be read is named as incomplete, beside the manual rows, which never are; nothing is cached', async () => {
    plaidRows = [plaid({ transaction_id: 'p1' })];
    const t = (await post({ account_id: WALLET.account_id, ...FIELDS })).body.transaction;
    plaidError = 'ITEM_LOGIN_REQUIRED';
    const { body } = await quietly(() => list(true));
    expect(body.incomplete).toEqual([{ institution_name: 'Big Bank', coverage: 'missing' }]);
    expect(body.notes).toEqual([expect.stringContaining('Big Bank')]);
    expect(ids(body)).toEqual([t.transaction_id]);
    expect((await quietly(() => list())).body.from_cache).toBe(false);
    // Once it answers again, nothing is incomplete, and that answer is cached.
    plaidError = null;
    expect((await list()).body).toMatchObject({ incomplete: [], from_cache: false });
    expect((await list()).body).toMatchObject({ incomplete: [], from_cache: true });
  });

  test('a manual account whose rows can’t be read is named in a note, Plaid’s rows still show and are still cached', async () => {
    plaidRows = [plaid({ transaction_id: 'p1' })];
    await fake.hset(ctxKey('manual-transactions'), { [WALLET.account_id]: 'not-ciphertext-but-long-enough-to-be-tried' });
    let { body } = await quietly(() => list(true));
    expect(ids(body)).toEqual(['p1']);
    expect(body.notes).toEqual(["Cash: transactions entered for Wallet couldn't be read"]);
    ({ body } = await quietly(() => list()));
    expect(body.from_cache).toBe(true);
    expect(body.notes).toEqual(["Cash: transactions entered for Wallet couldn't be read"]);
  });
});
