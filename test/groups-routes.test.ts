import { describe, expect, test, mock, beforeEach, afterEach } from 'bun:test';
import { FakeRedis, storageMock, TEST_CTX, ctxKey, registerTestContainer, unscopedDataKeys } from './fake-redis';

// Groups of transactions that net out (#39), end to end through the routes: a
// $120 dinner and the $60 paid back count once, as $60, in the group's
// category, the two listed inside it; a trip and its reimbursement net to
// nothing; the route refuses what can't be one group (pending, split, in
// another group, more than one currency, a split's part) and answers the
// seam's errors in the seam's way; what was said about a transaction in a
// group doesn't change its net; a transaction the bank removes leaves its
// group, which says so; one on a hidden account is left out of the net and
// counted; ungrouping puts the transactions back exactly; what can't be read
// is never taken for nothing; and one container never sees another's.

const ctx = TEST_CTX;
const OTHER = { container: '9c1d2e3f-4a5b-4c6d-8e7f-0a1b2c3d4e5f' } as typeof TEST_CTX;
process.env.PLAID_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
delete process.env.MAX_TXN_BLOB_CHARS;
const DAY = 86_400_000;
const daysAgo = (n: number) => new Date(Date.now() - n * DAY).toISOString().slice(0, 10);

const first: any[] = [];
let next: { added: any[]; modified: any[]; removed: { transaction_id: string }[] } = { added: [], modified: [], removed: [] };
let cursor = 0;
mock.module('@/lib/plaid', () => ({
  plaidClient: {
    transactionsSync: async (req: any) => {
      const page = req.cursor ? next : { added: first, modified: [], removed: [] };
      if (req.cursor) next = { added: [], modified: [], removed: [] };
      return {
        data: { ...page, accounts: [account('acct_a', 'Card', 'credit'), account('acct_b', 'Checking', 'depository')], next_cursor: `c${++cursor}`, has_more: false, transactions_update_status: 'HISTORICAL_UPDATE_COMPLETE' },
      };
    },
  },
}));

const fake = new FakeRedis();
afterEach(() => expect(unscopedDataKeys(fake)).toEqual([]));
mock.module('@/lib/storage', () => storageMock(fake));

const { encrypt } = await import('@/lib/crypto');
const { rememberAccounts } = await import('@/lib/last-known');
const { saveManualAccount } = await import('@/lib/manual');
const { addManualTxn, newManualTxn } = await import('@/lib/manual-txns');
const { setAccountHidden } = await import('@/lib/hidden');
const { groupStore } = await import('@/lib/groups');
const { summarize } = await import('@/lib/totals');
const { GROUP_PREFIX, bankRows } = await import('@/lib/split-rows');
const { detectRecurring } = await import('@/lib/recurring');

function account(id: string, name: string, type: string) {
  return { account_id: id, name, official_name: null, type, subtype: null, mask: '4821', balances: { available: null, current: 100, limit: null, iso_currency_code: 'USD' } };
}
const plaidRow = (id: string, over: Record<string, unknown> = {}) => ({
  transaction_id: id,
  account_id: 'acct_a',
  amount: 120,
  iso_currency_code: 'USD',
  date: daysAgo(10),
  name: 'BISTRO 22',
  merchant_name: 'Bistro',
  pending: false,
  counterparties: [],
  personal_finance_category: { primary: 'FOOD_AND_DRINK', detailed: 'FOOD_AND_DRINK_RESTAURANT' },
  ...over,
});

const route = async (path: string, method: string, body?: unknown, raw?: string) => {
  const mod: any = await import(`@/app/api/${path}/route`);
  const res = await mod[method](new Request(`http://x/api/${path}`, { method, body: raw ?? (body !== undefined ? JSON.stringify(body) : undefined) }));
  return { status: res.status, body: await res.json() };
};
const listed = async () => (await route('transactions', 'GET')).body as { transactions: any[]; notes: string[] };
const resync = async () => {
  const mod: any = await import('@/app/api/transactions/route');
  return (await (await mod.GET(new Request('http://x/api/transactions?refresh=1'))).json()) as { transactions: any[]; notes: string[] };
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
const make = (members: string[], over: Record<string, unknown> = {}) => route('transaction-groups', 'POST', { name: 'Dinner with Sam', category_id: catId('food and drink'), members, ...over });
const window = (rows: any[]) => summarize(rows, () => true, 'USD');

let categories: any;
const catId = (name: string) => categories.categories.find((c: any) => c.name === name).id;
const MANUAL = 'manual_6b1f3e2a-1c4d-4e5f-8a9b-0c1d2e3f4a5b';
let cash = '';

beforeEach(async () => {
  fake.reset();
  first.length = 0;
  first.push(
    plaidRow('t_dinner'),
    plaidRow('t_venmo', { amount: -60, date: daysAgo(6), name: 'VENMO CASHOUT', merchant_name: null, account_id: 'acct_b', personal_finance_category: { primary: 'TRANSFER_IN', detailed: 'TRANSFER_IN_ACCOUNT_TRANSFER' } }),
    plaidRow('t_flight', { amount: 500.25, date: daysAgo(30), name: 'AIRLINE', merchant_name: 'Airline', personal_finance_category: { primary: 'TRAVEL', detailed: 'TRAVEL_FLIGHTS' } }),
    plaidRow('t_reimb', { amount: -500.25, date: daysAgo(20), name: 'EMPLOYER EXPENSES', merchant_name: null, account_id: 'acct_b', personal_finance_category: { primary: 'INCOME', detailed: 'INCOME_OTHER_INCOME' } }),
    plaidRow('t_pending', { amount: 33, date: daysAgo(1), pending: true, name: 'TAXI', merchant_name: 'Taxi' }),
    plaidRow('t_euro', { amount: 40, iso_currency_code: 'EUR', date: daysAgo(9), name: 'CAFE PARIS', merchant_name: 'Cafe' }),
    plaidRow('t_old', { amount: 15, date: daysAgo(400), name: 'OLD', merchant_name: 'Old' })
  );
  next = { added: [], modified: [], removed: [] };
  (await import('@/lib/sessions')).forgetEpochs();
  await registerTestContainer(fake);
  await fake.hset(ctxKey('plaid:items'), { item_a: JSON.stringify({ item_id: 'item_a', institution_name: 'Chase', encrypted_access_token: await encrypt('token-a') }) });
  await rememberAccounts(ctx, [
    { item_id: 'item_a', institution_name: 'Chase', institution_id: null, error: null, accounts: [{ ...account('acct_a', 'Card', 'credit'), balance: 100 }, { ...account('acct_b', 'Checking', 'depository'), balance: 100 }] } as any,
  ]);
  await saveManualAccount(ctx, { account_id: MANUAL, name: 'Cash', institution_name: 'Wallet', type: 'depository', subtype: 'cash', balance: 50 } as any);
  const t = newManualTxn(MANUAL, { date: daysAgo(8), name: 'Sam paid cash', amount: -20, currency: 'USD', category: null, note: null });
  await addManualTxn(ctx, t);
  cash = t.id;
  categories = (await route('categories', 'GET')).body.categories;
  await listed();
});

describe('a group counts once, at its net', () => {
  test('a $120 dinner and $60 paid back are $60 in the group’s category, the two inside it; ungrouping puts them back exactly', async () => {
    const before = await listed();
    const made = await make(['t_dinner', 't_venmo']);
    expect(made.status).toBe(200);
    expect(made.body.group).toMatchObject({ version: 1, name: 'Dinner with Sam', members: ['t_dinner', 't_venmo'], date: daysAgo(10), currency: 'USD' });
    const rows = (await listed()).transactions;
    expect(rows.some((t) => t.transaction_id === 't_dinner' || t.transaction_id === 't_venmo')).toBe(false);
    const g = rows.find((t) => t.transaction_id === `${GROUP_PREFIX}${made.body.id}`);
    expect(g).toMatchObject({ amount: 60, date: daysAgo(10), name: 'Dinner with Sam', category_name: 'food and drink', account_name: 'Card', group_id: made.body.id });
    expect(g.group_members.map((t: any) => [t.transaction_id, t.amount, t.category_name])).toEqual([
      ['t_dinner', 120, 'food and drink'],
      ['t_venmo', -60, 'transfer in'],
    ]);
    // The money out drops by what was paid back; nothing counts twice.
    expect(window(rows).money_out).toBe(window(before.transactions).money_out - 60);
    const food = (r: any[]) => window(r).categories.find((c) => c.category === 'food and drink')!.spent;
    expect(food(rows)).toBe(food(before.transactions) - 60);

    const ungrouped = await route('transaction-groups', 'DELETE', { id: made.body.id });
    expect(ungrouped).toEqual({ status: 200, body: { id: made.body.id, removed: true } });
    expect((await listed()).transactions).toEqual(before.transactions);
  });

  test('a trip and its reimbursement net to nothing, on different accounts and days', async () => {
    const made = await make(['t_flight', 't_reimb'], { name: 'Work trip', category_id: catId('travel') });
    expect(made.status).toBe(200);
    const rows = (await listed()).transactions;
    const g = rows.find((t) => t.group_id === made.body.id);
    expect([g.amount, g.date, g.group_members.length]).toEqual([0, daysAgo(30), 2]);
    expect(rows.some((t) => t.transaction_id === 't_reimb')).toBe(false);
  });

  test('a manual row joins a bank’s; its group is changed, renamed and refiled; a transaction comes in and goes out', async () => {
    const made = await make(['t_dinner', 't_venmo']);
    const id = made.body.id;
    const added = await route('transaction-groups', 'PATCH', { id, add: [cash], name: 'Dinner, all paid back', category_id: catId('entertainment') });
    expect(added.status).toBe(200);
    expect(added.body.group).toMatchObject({ name: 'Dinner, all paid back', members: ['t_dinner', 't_venmo', cash], category_id: catId('entertainment') });
    let g = (await listed()).transactions.find((t) => t.group_id === id);
    expect([g.amount, g.category_name, g.group_members.length]).toEqual([40, 'entertainment', 3]);
    expect((await route('transaction-groups', 'PATCH', { id, remove: ['t_venmo'] })).status).toBe(200);
    g = (await listed()).transactions.find((t) => t.group_id === id);
    expect(g.amount).toBe(100);
    expect((await listed()).transactions.some((t) => t.transaction_id === 't_venmo')).toBe(true);
    const tooFew = await route('transaction-groups', 'PATCH', { id, remove: ['t_dinner'] });
    expect(tooFew.status).toBe(400);
    expect(tooFew.body.error).toContain('ungroup it');
  });
});

describe('what the route refuses, with nothing saved', () => {
  test('pending, another currency, a split one, one in another group, a split’s part, too few, a category none has, one not stored', async () => {
    expect((await make(['t_dinner', 't_pending'])).status).toBe(409);
    const mixed = await make(['t_dinner', 't_euro']);
    expect(mixed.status).toBe(409);
    expect(mixed.body.error).toContain('more than one currency');
    // Split first: its parts count on their own.
    const split = await route('transaction-splits', 'PUT', { transaction_id: 't_flight', parts: [{ amount: 400.25, category_id: catId('travel') }, { amount: 100, category_id: catId('food and drink') }] });
    expect(split.status).toBe(200);
    const splitOne = await make(['t_flight', 't_reimb']);
    expect(splitOne.status).toBe(409);
    expect(splitOne.body.error).toBe('“Airline” is split, and its parts count on their own, so a group would count it twice. Unsplit it first.');
    const part = (await listed()).transactions.find((t) => t.split_of === 't_flight').transaction_id;
    expect((await make([part, 't_reimb'])).status).toBe(400);
    expect((await make(['t_dinner'])).status).toBe(400);
    expect((await make(['t_dinner', 't_venmo'], { category_id: 'no-such-category' })).status).toBe(404);
    expect((await make(['t_dinner', 't_nobody'])).status).toBe(404);
    expect((await make(['t_dinner', 't_old'])).status).toBe(409);
    expect((await make(['t_dinner', 't_venmo'], { name: '   ' })).status).toBe(400);
    expect((await make(['t_dinner', 't_venmo'], { name: 'x'.repeat(61) })).status).toBe(400);
    expect((await route('transaction-groups', 'POST', undefined, '{nope')).status).toBe(400);
    expect((await route('transaction-groups', 'POST', undefined, JSON.stringify({ name: 'x', members: [], pad: 'x'.repeat(20_000) }))).status).toBe(413);
    expect(await groupStore.count(ctx)).toBe(0);
    // In a group, a transaction can't be split, nor join another group.
    const g = await make(['t_dinner', 't_venmo']);
    expect(g.status).toBe(200);
    const again = await make(['t_venmo', cash]);
    expect(again.status).toBe(409);
    expect(again.body.error).toContain('is already in the group “Dinner with Sam”');
    const splitGrouped = await route('transaction-splits', 'PUT', { transaction_id: 't_dinner', parts: [{ amount: 100, category_id: catId('travel') }, { amount: 20, category_id: catId('food and drink') }] });
    expect(splitGrouped.status).toBe(409);
    expect(splitGrouped.body.error).toContain('is in a group');
    expect((await route('transaction-groups', 'PATCH', { id: 'no-such-group', name: 'x' })).status).toBe(404);
    expect((await route('transaction-groups', 'PATCH', { id: 'has space', name: 'x' })).status).toBe(400);
  });
});

describe('what reaches a group, and what it says', () => {
  test('a rule’s hide or category, and an exclusion, on one of its transactions don’t change its net or category', async () => {
    const made = await make(['t_dinner', 't_venmo']);
    await route('rules', 'POST', { action: 'add', rule: { conditions: [{ field: 'name', op: 'contains', value: 'venmo' }], actions: { hide: true, set_category: catId('travel') } } });
    await route('transaction-annotations', 'PATCH', { transaction_id: 't_dinner', excluded: true });
    const g = (await listed()).transactions.find((t) => t.group_id === made.body.id);
    expect([g.amount, g.category_name, g.excluded]).toEqual([60, 'food and drink', undefined]);
    // Its transactions are shown as they are, what was said about them included.
    expect(g.group_members.map((t: any) => t.excluded)).toEqual([true, true]);
  });

  test('tags on its transactions are on its row', async () => {
    const made = await make(['t_dinner', 't_venmo']);
    const tagged = await route('transaction-annotations', 'PATCH', { transaction_id: 't_venmo', new_tag: 'Sam' });
    const g = (await listed()).transactions.find((t) => t.group_id === made.body.id);
    expect(g.tags).toEqual([tagged.body.created_tag.id]);
  });

  test('one on an account hidden since is left out of the net, and counted as not here', async () => {
    const made = await make(['t_dinner', 't_venmo']);
    await setAccountHidden(ctx, 'acct_b', 'depository', true);
    const g = (await resync()).transactions.find((t) => t.group_id === made.body.id);
    expect([g.amount, g.group_missing, g.group_members.length]).toEqual([120, 1, 1]);
  });

  test('one the bank removes leaves the group, which says so; one deleted by hand goes too, and a group left with none goes', async () => {
    const made = await make(['t_dinner', 't_venmo', cash]);
    next = { added: [], modified: [], removed: [{ transaction_id: 't_venmo' }] };
    const g = (await resync()).transactions.find((t) => t.group_id === made.body.id);
    expect([g.amount, g.group_removed, g.group_members.length]).toEqual([100, 1, 2]);
    expect((await groupStore.get(ctx, made.body.id))).toMatchObject({ members: ['t_dinner', cash], removed: 1 });
    expect((await route('manual-transactions', 'DELETE', { id: cash, account_id: MANUAL })).status).toBe(200);
    expect((await groupStore.get(ctx, made.body.id))).toMatchObject({ members: ['t_dinner'], removed: 2 });
    next = { added: [], modified: [], removed: [{ transaction_id: 't_dinner' }] };
    await resync();
    expect(await groupStore.get(ctx, made.body.id)).toBeNull();
  });

  test('recurring detection still sees each transaction in a group on its own', async () => {
    const made = await make(['t_dinner', 't_venmo']);
    const rows = (await listed()).transactions;
    const whole = bankRows(rows);
    expect(whole.filter((t: any) => t.group_id === made.body.id).map((t: any) => t.transaction_id)).toEqual(['t_dinner', 't_venmo']);
    expect(detectRecurring(rows)).toEqual(detectRecurring(whole));
  });
});

describe('what can’t be read is never taken for nothing', () => {
  test('a group that can’t be read: its transactions count on their own, with a note; the routes answer 409 and leave it', async () => {
    await fake.hset(ctxKey('transaction-groups'), { 'g-damaged': 'not-ciphertext-but-long-enough-to-be-tried' });
    const body = await quietly(() => listed());
    expect(body.notes).toContain('1 of your groups couldn’t be read, so its transactions count on their own until it can be.');
    expect(body.transactions.some((t) => t.transaction_id === 't_dinner')).toBe(true);
    expect((await quietly(() => route('transaction-groups', 'PATCH', { id: 'g-damaged', name: 'x' }))).status).toBe(409);
    expect((await quietly(() => route('transaction-groups', 'DELETE', { id: 'g-damaged' }))).status).toBe(409);
    // A group that might hold them stops a new one, and a split of one.
    const made = await quietly(() => make(['t_dinner', 't_venmo']));
    expect(made.status).toBe(409);
    expect(made.body.unreadable).toBe(true);
    const split = await quietly(() => route('transaction-splits', 'PUT', { transaction_id: 't_dinner', parts: [{ amount: 100, category_id: catId('travel') }, { amount: 20, category_id: catId('food and drink') }] }));
    expect(split.status).toBe(409);
    expect(fake.hashes.get(ctxKey('transaction-groups'))!.get('g-damaged')).toBe('not-ciphertext-but-long-enough-to-be-tried');
  });

  test('a split that can’t be read stops grouping that transaction (409)', async () => {
    await fake.hset(ctxKey('transaction-splits'), { t_dinner: 'not-ciphertext-but-long-enough-to-be-tried' });
    const made = await quietly(() => make(['t_dinner', 't_venmo']));
    expect(made.status).toBe(409);
    expect(await groupStore.count(ctx)).toBe(0);
  });
});

describe('containers', () => {
  test('a group is kept in its own container, and another container’s never shows', async () => {
    const at = new Date().toISOString();
    await groupStore.set(OTHER, 'g-other', { version: 1, name: 'Theirs', category_id: catId('travel'), members: ['t_dinner', 't_venmo'], date: daysAgo(10), currency: 'USD', created_at: at, updated_at: at });
    expect((await listed()).transactions.some((t) => t.group_id)).toBe(false);
    const made = await make(['t_dinner', 't_venmo']);
    expect(fake.hashes.get(ctxKey('transaction-groups'))!.has(made.body.id)).toBe(true);
    expect((await groupStore.getAll(OTHER)).size).toBe(1);
  });
});
