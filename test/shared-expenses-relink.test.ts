import { describe, expect, test, mock, beforeEach, afterEach } from 'bun:test';
import { FakeRedis, storageMock, TEST_CTX, ctxKey, registerTestContainer, unscopedDataKeys } from './fake-redis';

// Shared expenses (#49) across a re-link, end to end through the routes. A
// disconnect records each shared or paying transaction's content key on its
// share or payment; once the re-added account is linked to the old one, each
// carries to the transaction there with the same key, one to one, so your
// part counts as it did and nothing counts whole on its own. One that
// doesn't match is gone, decided by the link: said on the card and in the
// notes, with the rows it could move to, each with its account, which the
// move sends and the server checks. Before the link, they wait, said too.

const ctx = TEST_CTX;
process.env.PLAID_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
const DAY = 86_400_000;
const daysAgo = (n: number) => new Date(Date.now() - n * DAY).toISOString().slice(0, 10);

const plaidTxns: Record<string, any[]> = {};
const plaidAccounts: Record<string, any[]> = {};
mock.module('@/lib/plaid', () => ({
  plaidClient: {
    transactionsSync: async (req: any) => ({
      data: {
        added: req.cursor ? [] : (plaidTxns[req.access_token] ?? []),
        modified: [],
        removed: [],
        accounts: plaidAccounts[req.access_token] ?? [],
        next_cursor: 'c1',
        has_more: false,
        transactions_update_status: 'HISTORICAL_UPDATE_COMPLETE',
      },
    }),
    accountsGet: async (req: any) => ({ data: { accounts: plaidAccounts[req.access_token] ?? [] } }),
    itemRemove: async () => ({ data: {} }),
  },
}));

const fake = new FakeRedis();
afterEach(() => expect(unscopedDataKeys(fake)).toEqual([]));
mock.module('@/lib/storage', () => storageMock(fake));

const { encrypt } = await import('@/lib/crypto');
const links = await import('@/lib/links');
const { rememberAccounts } = await import('@/lib/last-known');
const { expenseSharesStore, expensePaymentsStore } = await import('@/lib/shared-expenses/store');

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
  amount: 120,
  iso_currency_code: 'USD',
  date: daysAgo(10),
  name: 'JOES DINER',
  merchant_name: 'Joe’s Diner',
  pending: false,
  counterparties: [],
  personal_finance_category: { primary: 'FOOD_AND_DRINK', detailed: 'FOOD_AND_DRINK_RESTAURANT' },
  ...over,
});
const venmo = { name: 'VENMO CASHOUT', merchant_name: 'Venmo', amount: -35, date: daysAgo(3), personal_finance_category: { primary: 'TRANSFER_IN', detailed: 'TRANSFER_IN_ACCOUNT_TRANSFER' } };

/** An Item as it is after a successful load: stored, remembered, in the directory. */
async function addItem(item_id: string, account_id: string, txns: any[], seenOn = Date.now()) {
  const token = `token-${item_id}`;
  plaidTxns[token] = txns;
  plaidAccounts[token] = [account(account_id)];
  await fake.hset(ctxKey('plaid:items'), {
    [item_id]: JSON.stringify({ item_id, institution_name: 'Chase', encrypted_access_token: await encrypt(TEST_CTX, token) }),
  });
  const inst = { item_id, institution_name: 'Chase', institution_id: 'ins_3', error: null, accounts: [{ ...account(account_id), balance: 100 }] };
  await rememberAccounts(ctx, [inst as any]);
  await links.recordDirectory(ctx, [inst as any], seenOn);
}

const route = async (path: string, method: string, body?: unknown) => {
  const mod: any = await import(`@/app/api/${path}/route`);
  const url = `http://x/api/${path}${method === 'GET' ? '?refresh=1' : ''}`;
  const res = await mod[method](new Request(url, { method, body: body ? JSON.stringify(body) : undefined }));
  return { status: res.status as number, body: await res.json() };
};
const listed = async () => (await route('transactions', 'GET')).body as { transactions: any[]; notes: string[]; shared_expenses: any };
const rowOf = (l: { transactions: any[] }, id: string) => l.transactions.find((t) => t.transaction_id === id);
const card = async () => (await route('shared-expenses', 'GET')).body;
const quietly = async <T>(fn: () => Promise<T>): Promise<T> => {
  const [error, warn] = [console.error, console.warn];
  console.error = console.warn = () => {};
  try {
    return await fn();
  } finally {
    [console.error, console.warn] = [error, warn];
  }
};

beforeEach(async () => {
  fake.reset();
  (await import('@/lib/sessions')).forgetEpochs();
  await registerTestContainer(fake);
});

/** The old connection: a $120 dinner shared half with Alex, a $40 lunch
 *  Alex owes $20 of, and Alex's $35 by Venmo confirmed against the dinner. */
async function before() {
  await addItem('item_old', 'acct_old', [row('t_d', 'acct_old'), row('t_l', 'acct_old', { amount: 40, date: daysAgo(8), name: 'CAFE 12', merchant_name: 'Cafe' }), row('t_v', 'acct_old', venmo)], Date.now() - DAY);
  await listed();
  const person = (await route('shared-expenses/people', 'POST', { name: 'Alex Smith' })).body.id as string;
  const dinner = await route('shared-expenses/shares', 'PUT', { transaction_id: 't_d', entries: [{ person, amount: 60 }] });
  expect(dinner.status).toBe(200);
  expect((await route('shared-expenses/shares', 'PUT', { transaction_id: 't_l', entries: [{ person, amount: 20 }] })).status).toBe(200);
  const entry = dinner.body.share.entries[0].id as string;
  expect((await route('shared-expenses/payments', 'POST', { transaction_id: 't_v', allocations: [{ item: entry, amount: 35 }] })).status).toBe(200);
  expect(rowOf(await listed(), 't_d').amount).toBe(60);
  return { person, entry };
}

/** Re-added: the same purchases under new ids, but the bank wrote the
 *  lunch's words differently this time. */
const readd = () =>
  addItem('item_new', 'acct_new', [row('n_d', 'acct_new'), row('n_l', 'acct_new', { amount: 40, date: daysAgo(8), name: 'CAFE 12 SAN FRANCISCO', merchant_name: 'Cafe' }), row('n_v', 'acct_new', venmo)]);

describe('a re-link carries what is shared and paid', () => {
  test('recorded at the disconnect; waiting, and said, until linked; then carried one to one, and one that doesn’t match is gone, said, and moved', async () => {
    const { person, entry } = await before();
    expect((await quietly(() => route('disconnect', 'POST', { item_id: 'item_old' }))).status).toBe(200);
    // Each kept under the old transaction, its content key recorded.
    expect((await expenseSharesStore.get(ctx, 't_d'))!.carry_key).toMatch(/^acct_old\|/);
    expect((await expensePaymentsStore.get(ctx, 't_v'))!.carry_key).toMatch(/^acct_old\|/);
    await readd();

    // Before the link: not the same account until the person says so. The
    // new rows count as the bank shows them, and what waits is said.
    const waiting = await listed();
    expect(rowOf(waiting, 'n_d').amount).toBe(120);
    expect(waiting.shared_expenses.away).toEqual({ shares: ['t_d', 't_l'], payments: ['t_v'] });
    expect(waiting.shared_expenses.gone).toEqual({ shares: [], payments: [] });
    expect(waiting.notes.join(' ')).toContain('on an account you disconnected: once you add the bank back and link the account, they carry');
    // Nothing is owed differently meanwhile.
    expect((await card()).balances[person]).toEqual([{ currency: 'USD', amount: 45, open: 2, oldest: daysAgo(10), over: 0 }]);

    expect((await route('account-links', 'POST', { action: 'link', old: 'acct_old', to: 'acct_new' })).status).toBe(200);
    const linked = await listed();
    // The dinner at your part again, Alex's part beside it; the payment too.
    const dinner = rowOf(linked, 'n_d');
    expect([dinner.amount, dinner.shared_was, dinner.shared_carried_from, dinner.shared.people]).toEqual([60, 120, 't_d', [{ person, item: entry, amount: 60 }]]);
    expect(rowOf(linked, `share:${entry}`)).toMatchObject({ amount: 60, excluded: true });
    const pay = rowOf(linked, 'n_v');
    expect([pay.amount, pay.settles.kept_under]).toEqual([0, 't_v']);
    // The lunch's words changed: it didn't carry, so it is gone, never silent.
    expect(rowOf(linked, 'n_l').amount).toBe(40);
    expect(linked.shared_expenses.gone).toEqual({ shares: ['t_l'], payments: [] });
    expect(linked.shared_expenses.away).toEqual({ shares: [], payments: [] });
    expect(linked.shared_expenses.moves.shares.t_l).toEqual([{ transaction_id: 'n_l', account_id: 'acct_new' }]);
    expect(linked.notes.join(' ')).toContain('1 shared transaction isn’t in your accounts any more: see Shared expenses.');

    // Move: refused when the account sent isn't the transaction's, and to
    // money in; accepted as the card sends it.
    expect((await route('shared-expenses/shares', 'PATCH', { action: 'move', transaction_id: 't_l', to: 'n_l', account: 'acct_old' })).status).toBe(409);
    expect((await route('shared-expenses/shares', 'PATCH', { action: 'move', transaction_id: 't_l', to: 'n_l' })).status).toBe(400);
    expect((await route('shared-expenses/shares', 'PATCH', { action: 'move', transaction_id: 't_l', to: 'n_v', account: 'acct_new' })).status).toBe(409);
    // Never onto a row the link carried a share to, though nothing is
    // stored under its id; nor onto one this container doesn't hold.
    const onto = await route('shared-expenses/shares', 'PATCH', { action: 'move', transaction_id: 't_l', to: 'n_d', account: 'acct_new' });
    expect([onto.status, onto.body.error]).toEqual([409, 'That transaction is shared already.']);
    expect((await route('shared-expenses/shares', 'PATCH', { action: 'move', transaction_id: 't_l', to: 'n_nowhere', account: 'acct_new' })).status).toBe(404);
    const moved = await route('shared-expenses/shares', 'PATCH', { action: 'move', transaction_id: 't_l', to: 'n_l', account: 'acct_new' });
    expect(moved.status).toBe(200);
    expect(moved.body.share).toMatchObject({ account_id: 'acct_new', amount_was: 40 });
    const after = await listed();
    expect(rowOf(after, 'n_l').amount).toBe(20);
    expect(after.shared_expenses.gone).toEqual({ shares: [], payments: [] });
    // Nothing was owed differently at any step.
    expect((await card()).balances[person]).toEqual([{ currency: 'USD', amount: 45, open: 2, oldest: daysAgo(10), over: 0 }]);
  });

  test('a payment that doesn’t carry is gone and said; it moves only to money in that nothing else holds', async () => {
    const { person } = await before();
    await quietly(() => route('disconnect', 'POST', { item_id: 'item_old' }));
    // The cashout's words changed this time; a $35 purchase beside it.
    await addItem('item_new', 'acct_new', [
      row('n_d', 'acct_new'),
      row('n_l', 'acct_new', { amount: 40, date: daysAgo(8), name: 'CAFE 12', merchant_name: 'Cafe' }),
      row('n_v', 'acct_new', { ...venmo, name: 'VENMO CASHOUT 4821' }),
      row('n_x', 'acct_new', { amount: 35, date: daysAgo(3), name: 'BOOKSHOP', merchant_name: 'Bookshop' }),
    ]);
    await route('account-links', 'POST', { action: 'link', old: 'acct_old', to: 'acct_new' });
    const linked = await listed();
    expect(linked.shared_expenses.gone).toEqual({ shares: [], payments: ['t_v'] });
    expect(linked.shared_expenses.moves.payments.t_v).toEqual([{ transaction_id: 'n_v', account_id: 'acct_new' }]);
    // The cashout counts as the bank shows it until it is moved.
    expect(rowOf(linked, 'n_v').settles).toBeUndefined();
    // Refused: money out, a row a share carried to, the wrong account.
    const move = (to: string, account = 'acct_new') => route('shared-expenses/payments', 'PATCH', { action: 'move', transaction_id: 't_v', to, account });
    expect((await move('n_x')).status).toBe(409);
    expect(((await move('n_d')).body as any).error).toBe('That transaction is shared already.');
    expect((await move('n_v', 'acct_old')).status).toBe(409);
    expect((await move('n_v')).status).toBe(200);
    const after = await listed();
    expect(after.shared_expenses.gone).toEqual({ shares: [], payments: [] });
    expect(rowOf(after, 'n_v').settles).toMatchObject({ rest: 0 });
    expect((await card()).balances[person]).toEqual([{ currency: 'USD', amount: 45, open: 2, oldest: daysAgo(10), over: 0 }]);
  });

  test('a carried share edited from its new row moves onto it in the same step', async () => {
    const { person } = await before();
    await quietly(() => route('disconnect', 'POST', { item_id: 'item_old' }));
    await readd();
    await route('account-links', 'POST', { action: 'link', old: 'acct_old', to: 'acct_new' });
    await listed();
    const kept = (await expenseSharesStore.get(ctx, 't_d'))!;
    const saved = await route('shared-expenses/shares', 'PUT', { transaction_id: 'n_d', carried_from: 't_d', entries: [{ person, amount: 50 }], updated_at: kept.updated_at });
    expect(saved.status).toBe(200);
    expect(await expenseSharesStore.get(ctx, 't_d')).toBeNull();
    const now = (await expenseSharesStore.get(ctx, 'n_d'))!;
    // The entry kept its id (the payment names it) and the new account.
    expect([now.account_id, now.entries[0].id, now.entries[0].amount]).toEqual(['acct_new', kept.entries[0].id, 50]);
    expect(rowOf(await listed(), 'n_d').amount).toBe(70);
  });

  test('keep: a gone share stays in the balance, no longer said to be gone', async () => {
    await before();
    await quietly(() => route('disconnect', 'POST', { item_id: 'item_old' }));
    await readd();
    await route('account-links', 'POST', { action: 'link', old: 'acct_old', to: 'acct_new' });
    expect((await listed()).shared_expenses.gone.shares).toEqual(['t_l']);
    expect((await route('shared-expenses/shares', 'PATCH', { action: 'keep', transaction_id: 't_l' })).status).toBe(200);
    const after = await listed();
    expect(after.shared_expenses.gone.shares).toEqual([]);
    expect(after.notes.join(' ')).not.toContain('isn’t in your accounts any more');
  });

  test('two identical rows on the new account: nothing guesses, the share is gone and said', async () => {
    await before();
    await quietly(() => route('disconnect', 'POST', { item_id: 'item_old' }));
    await addItem('item_new', 'acct_new', [row('n_d', 'acct_new'), row('n_d2', 'acct_new')]);
    await route('account-links', 'POST', { action: 'link', old: 'acct_old', to: 'acct_new' });
    const l = await listed();
    expect(rowOf(l, 'n_d').amount).toBe(120);
    expect(rowOf(l, 'n_d2').amount).toBe(120);
    expect(l.shared_expenses.gone.shares).toContain('t_d');
    expect(l.shared_expenses.moves.shares.t_d.map((m: any) => m.transaction_id).sort()).toEqual(['n_d', 'n_d2']);
    // Either can be moved to: what carries to neither holds neither.
    expect((await route('shared-expenses/shares', 'PATCH', { action: 'move', transaction_id: 't_d', to: 'n_d2', account: 'acct_new' })).status).toBe(200);
    const moved = await listed();
    expect([rowOf(moved, 'n_d').amount, rowOf(moved, 'n_d2').amount]).toEqual([120, 60]);
    expect(moved.shared_expenses.gone.shares).not.toContain('t_d');
  });
});
