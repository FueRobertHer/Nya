import { describe, expect, test, mock, beforeEach, afterEach } from 'bun:test';
import { FakeRedis, storageMock, TEST_CTX, ctxKey, registerTestContainer, unscopedDataKeys } from './fake-redis';

// Split transactions (#39), end to end through the routes: a split saved by
// app/api/transaction-splits shows on the Activity tab's own read as its
// parts, every total counting them and never the transaction; a part changed
// on its own; unsplit puts the transaction back exactly; the routes check
// what they are told (a pending transaction, parts that don't add up, a
// category none has, a part's id) and answer the seam's errors in the seam's
// way; the bank changing the amount shows the difference as a part of its
// own, and removing the transaction takes its split with it; rules, tags and
// an exclusion on the transaction reach its parts as lib/split-rows.ts says;
// a manual row and an imported one split alike and go with their row; what
// can't be read is never taken for nothing; and one container never sees
// another's.

const ctx = TEST_CTX;
const OTHER = { container: '9c1d2e3f-4a5b-4c6d-8e7f-0a1b2c3d4e5f' } as typeof TEST_CTX;
process.env.PLAID_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
delete process.env.MAX_TXN_BLOB_CHARS;
const DAY = 86_400_000;
const daysAgo = (n: number) => new Date(Date.now() - n * DAY).toISOString().slice(0, 10);

// What Plaid sends: the first sync, then whatever a test puts in `next`.
const first: any[] = [];
let next: { added: any[]; modified: any[]; removed: { transaction_id: string }[] } = { added: [], modified: [], removed: [] };
let cursor = 0;
mock.module('@/lib/plaid', () => ({
  plaidClient: {
    transactionsSync: async (req: any) => {
      const page = req.cursor ? next : { added: first, modified: [], removed: [] };
      if (req.cursor) next = { added: [], modified: [], removed: [] };
      return {
        data: {
          ...page,
          accounts: [account('acct_a')],
          next_cursor: `c${++cursor}`,
          has_more: false,
          transactions_update_status: 'HISTORICAL_UPDATE_COMPLETE',
        },
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
const { addManualTxn, newManualTxn, manualTxnStore } = await import('@/lib/manual-txns');
const { splitStore, saveSplit, changePart, removeSplit, checkParts } = await import('@/lib/splits');
const { rulesStore } = await import('@/lib/rules');
const { summarize } = await import('@/lib/totals');
const { PART_PREFIX, REMAINDER_PREFIX } = await import('@/lib/split-rows');
const { groupStore } = await import('@/lib/groups');
const { unreadNotesOf, unreadTransactions } = await import('@/lib/fire/inputs');

function account(id: string) {
  return {
    account_id: id,
    name: 'Card',
    official_name: null,
    type: 'credit',
    subtype: 'credit card',
    mask: '4821',
    balances: { available: null, current: 100, limit: 5000, iso_currency_code: 'USD' },
  };
}
const plaidRow = (id: string, over: Record<string, unknown> = {}) => ({
  transaction_id: id,
  account_id: 'acct_a',
  amount: 150,
  iso_currency_code: 'USD',
  date: daysAgo(3),
  name: 'COSTCO WHSE #123',
  merchant_name: 'Costco',
  pending: false,
  counterparties: [],
  personal_finance_category: { primary: 'GENERAL_MERCHANDISE', detailed: 'GENERAL_MERCHANDISE_SUPERSTORES' },
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
  const res = await mod.GET(new Request('http://x/api/transactions?refresh=1'));
  return (await res.json()) as { transactions: any[]; notes: string[] };
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
const splitPut = (transaction_id: string, parts: unknown) => route('transaction-splits', 'PUT', { transaction_id, parts });

let categories: any;
const catId = (name: string) => categories.categories.find((c: any) => c.name === name).id;
const MANUAL = 'manual_6b1f3e2a-1c4d-4e5f-8a9b-0c1d2e3f4a5b';
let typed = '';
let imported = '';

beforeEach(async () => {
  fake.reset();
  first.length = 0;
  first.push(
    plaidRow('t_costco'),
    plaidRow('t_coffee', { name: 'BLUE BOTTLE', merchant_name: 'Blue Bottle', amount: 5.25, date: daysAgo(5), personal_finance_category: { primary: 'FOOD_AND_DRINK', detailed: 'FOOD_AND_DRINK_COFFEE' } }),
    plaidRow('t_pending', { name: 'GAS STATION', merchant_name: 'Shell', amount: 40, pending: true, date: daysAgo(1) })
  );
  next = { added: [], modified: [], removed: [] };
  (await import('@/lib/sessions')).forgetEpochs();
  await registerTestContainer(fake);
  await fake.hset(ctxKey('plaid:items'), { item_a: JSON.stringify({ item_id: 'item_a', institution_name: 'Chase', encrypted_access_token: await encrypt(ctx, 'token-a') }) });
  await rememberAccounts(ctx, [{ item_id: 'item_a', institution_name: 'Chase', institution_id: null, error: null, accounts: [{ ...account('acct_a'), balance: 100 }] } as any]);
  await saveManualAccount(ctx, { account_id: MANUAL, name: 'Cash', institution_name: 'Wallet', type: 'depository', subtype: 'cash', balance: 50 } as any);
  const t = newManualTxn(MANUAL, { date: daysAgo(2), name: 'Farmers market', amount: 30, currency: 'USD', category: null, note: 'eggs and flowers' });
  await addManualTxn(ctx, t);
  typed = t.id;
  const i = { ...newManualTxn(MANUAL, { date: daysAgo(4), name: 'HARDWARE STORE', amount: 64.5, currency: 'USD', category: null, note: null }), source: 'import:ofx', source_id: 'FITID-77' };
  await addManualTxn(ctx, i);
  imported = i.id;
  categories = (await route('categories', 'GET')).body.categories;
});

const costcoSplit = () => [
  { amount: 100.01, category_id: catId('food and drink'), note: 'groceries' },
  { amount: 30, category_id: catId('home improvement') },
  { amount: 19.99, category_id: catId('transportation') },
];
const totalsOf = (rows: any[]) => summarize(rows, (d) => d === daysAgo(3), 'USD');

describe('a split, saved through the route, read as its parts', () => {
  test('the transaction shows as its parts, every total the same; a part changed on its own; unsplit puts it back exactly', async () => {
    const before = await listed();
    const whole = before.transactions.find((t) => t.transaction_id === 't_costco');
    expect(whole).toBeDefined();

    const saved = await splitPut('t_costco', costcoSplit());
    expect(saved.status).toBe(200);
    expect(saved.body.split).toMatchObject({ version: 1, amount: 150, currency: 'USD' });
    expect(saved.body.split.parts.map((p: any) => p.amount)).toEqual([100.01, 30, 19.99]);

    const after = await listed();
    expect(after.transactions.find((t) => t.transaction_id === 't_costco')).toBeUndefined();
    const parts = after.transactions.filter((t) => t.split_of === 't_costco');
    expect(parts.map((t) => [t.transaction_id.startsWith(PART_PREFIX), t.amount, t.category_name, t.name, t.date])).toEqual([
      [true, 100.01, 'food and drink', 'Costco', daysAgo(3)],
      [true, 30, 'home improvement', 'Costco', daysAgo(3)],
      [true, 19.99, 'transportation', 'Costco', daysAgo(3)],
    ]);
    expect(parts[0].note).toBe('groceries');
    // Money out the same to the cent; only where it is filed moves.
    expect(totalsOf(after.transactions).money_out).toBe(totalsOf(before.transactions).money_out);
    expect(totalsOf(after.transactions).categories.map((c) => c.category).sort()).toEqual(['food and drink', 'home improvement', 'transportation']);

    // One part's category, its amounts left alone.
    const part = saved.body.split.parts[1];
    const changed = await route('transaction-splits', 'PATCH', { transaction_id: 't_costco', part_id: part.id, category_id: catId('general merchandise'), excluded: true });
    expect(changed.status).toBe(200);
    const again = (await listed()).transactions.find((t) => t.transaction_id === `${PART_PREFIX}${part.id}`);
    expect(again).toMatchObject({ category_name: 'general merchandise', excluded: true, split_excluded: true, amount: 30 });

    // Unsplit: the transaction, exactly as it was.
    const removed = await route('transaction-splits', 'DELETE', { transaction_id: 't_costco' });
    expect(removed).toEqual({ status: 200, body: { transaction_id: 't_costco', removed: true } });
    expect((await listed()).transactions.find((t) => t.transaction_id === 't_costco')).toEqual(whole);
    expect(await splitStore.get(ctx, 't_costco')).toBeNull();
  });

  test('an edit opened on a split another device changed since is refused, and nothing it made there is lost', async () => {
    await listed();
    // Opened when it wasn't split; split on another device meanwhile.
    const first = await route('transaction-splits', 'PUT', { transaction_id: 't_costco', parts: costcoSplit(), updated_at: null });
    expect(first.status).toBe(200);
    const late = await route('transaction-splits', 'PUT', { transaction_id: 't_costco', parts: costcoSplit(), updated_at: null });
    expect([late.status, late.body.error]).toEqual([409, 'This split was changed on another device since you opened it. Close it and open it again to see the change.']);
    // The parts carry the split's time, which an edit sends back.
    const seen = (await listed()).transactions.find((t) => t.split_of === 't_costco').split_updated_at;
    expect(seen).toBe(first.body.split.updated_at);
    const part = first.body.split.parts[0];
    await route('transaction-splits', 'PATCH', { transaction_id: 't_costco', part_id: part.id, note: 'changed elsewhere' });
    const stale = await route('transaction-splits', 'PUT', { transaction_id: 't_costco', parts: costcoSplit(), updated_at: seen });
    expect(stale.status).toBe(409);
    expect((await route('transaction-splits', 'DELETE', { transaction_id: 't_costco', updated_at: seen })).status).toBe(409);
    expect((await splitStore.get(ctx, 't_costco'))!.parts[0].note).toBe('changed elsewhere');
    // From what is there now, it saves; and one that says nothing still does.
    const now = (await splitStore.get(ctx, 't_costco'))!.updated_at;
    expect((await route('transaction-splits', 'PUT', { transaction_id: 't_costco', parts: costcoSplit(), updated_at: now })).status).toBe(200);
    expect((await route('transaction-splits', 'DELETE', { transaction_id: 't_costco' })).status).toBe(200);
    expect((await route('transaction-splits', 'PUT', { transaction_id: 't_costco', parts: costcoSplit(), updated_at: 'not a time' })).status).toBe(400);
  });

  test('changes saved in one millisecond still move the split on, so an edit opened before them is refused', async () => {
    const at = new Date('2026-10-28T12:00:00.000Z');
    const parent = { amount: 150, currency: 'USD', pending: false };
    const parts = checkParts(costcoSplit(), parent);
    const saved = await saveSplit(ctx, 't_costco', parent, parts, at, null);
    const changed = (await changePart(ctx, 't_costco', saved.parts[0].id, { note: 'changed elsewhere' }, at))!;
    expect(changed.updated_at > saved.updated_at).toBe(true);
    await expect(saveSplit(ctx, 't_costco', parent, parts, at, saved.updated_at)).rejects.toMatchObject({ status: 409 });
    await expect(removeSplit(ctx, 't_costco', saved.updated_at)).rejects.toMatchObject({ status: 409 });
    expect((await splitStore.get(ctx, 't_costco'))!.parts[0].note).toBe('changed elsewhere');
    // From what is there now it saves, and moves on again in the same millisecond.
    const again = await saveSplit(ctx, 't_costco', parent, parts, at, changed.updated_at);
    expect(again.updated_at > changed.updated_at).toBe(true);
    // A clock behind the stored time never stamps it backward.
    const earlier = await saveSplit(ctx, 't_costco', parent, parts, new Date('2026-10-28T11:00:00.000Z'), again.updated_at);
    expect(earlier.updated_at > again.updated_at).toBe(true);
  });

  test('a manual row and an imported one split as a bank’s does, and their splits go with their row', async () => {
    expect((await splitPut(typed, [{ amount: 20, category_id: catId('food and drink') }, { amount: 10, category_id: catId('general merchandise') }])).status).toBe(200);
    expect((await splitPut(imported, [{ amount: 60, category_id: catId('home improvement') }, { amount: 4.5, category_id: catId('general merchandise') }])).status).toBe(200);
    const rows = (await listed()).transactions;
    expect(rows.filter((t) => t.split_of === typed).map((t) => [t.amount, t.source, t.account_id])).toEqual([
      [20, 'manual', MANUAL],
      [10, 'manual', MANUAL],
    ]);
    expect(rows.filter((t) => t.split_of === imported).map((t) => [t.amount, t.source])).toEqual([
      [60, 'import:ofx'],
      [4.5, 'import:ofx'],
    ]);
    // Its note stays on the transaction, not on each part.
    expect(rows.find((t) => t.split_of === typed).split_parent.note).toBe('eggs and flowers');
    // Deleted, it takes its split with it.
    const deleted = await route('manual-transactions', 'DELETE', { id: typed, account_id: MANUAL });
    expect(deleted.status).toBe(200);
    expect(await splitStore.get(ctx, typed)).toBeNull();
    expect(await splitStore.get(ctx, imported)).not.toBeNull();
  });
});

describe('what the route refuses, with nothing saved', () => {
  test('a pending transaction (409), parts that don’t add up (400), a category none has (404), one not stored (404)', async () => {
    await listed();
    const pending = await splitPut('t_pending', [{ amount: 20, category_id: catId('food and drink') }, { amount: 20, category_id: catId('transportation') }]);
    expect(pending.status).toBe(409);
    expect(pending.body.error).toContain('pending');
    const short = await splitPut('t_costco', [{ amount: 100, category_id: catId('food and drink') }, { amount: 49.98, category_id: catId('transportation') }]);
    expect(short).toEqual({ status: 400, body: { error: 'The parts add up to $149.98, not the transaction’s $150.00: $0.02 is left over.' } });
    const gone = await splitPut('t_costco', [{ amount: 100, category_id: catId('food and drink') }, { amount: 50, category_id: 'no-such-category' }]);
    expect(gone.status).toBe(404);
    const missing = await splitPut('t_nobody', [{ amount: 100, category_id: catId('food and drink') }, { amount: 50, category_id: catId('transportation') }]);
    expect(missing.status).toBe(404);
    expect(await splitStore.count(ctx)).toBe(0);
  });

  test('ids and input: a part’s or a group’s id, a bad id, no parts, bad JSON, too large', async () => {
    const parts = [{ amount: 100, category_id: catId('food and drink') }, { amount: 50, category_id: catId('transportation') }];
    expect((await splitPut(`${PART_PREFIX}abc`, parts)).status).toBe(400);
    expect((await splitPut('group:abc', parts)).status).toBe(400);
    expect((await splitPut('has space', parts)).status).toBe(400);
    expect((await splitPut('manual-txn:', parts)).status).toBe(400);
    expect((await route('transaction-splits', 'PUT', { transaction_id: 't_costco' })).status).toBe(400);
    expect((await route('transaction-splits', 'PUT', undefined, '{not json')).status).toBe(400);
    expect((await route('transaction-splits', 'PUT', undefined, JSON.stringify({ transaction_id: 't_costco', parts, pad: 'x'.repeat(40_000) }))).status).toBe(413);
    expect((await route('transaction-splits', 'PATCH', { transaction_id: 't_costco', part_id: 'no-part', excluded: true })).status).toBe(404);
    expect((await route('transaction-splits', 'PATCH', { transaction_id: 't_costco', part_id: 'p', excluded: 'yes' })).status).toBe(400);
    expect((await route('transaction-splits', 'PATCH', { transaction_id: 't_costco', part_id: 'p' })).status).toBe(400);
    expect(await splitStore.count(ctx)).toBe(0);
  });
});

describe('the bank’s later changes', () => {
  test('a new amount shows the difference as a part of its own, filed as the transaction is; the total is the bank’s', async () => {
    await listed();
    expect((await splitPut('t_costco', costcoSplit())).status).toBe(200);
    next = { added: [], modified: [plaidRow('t_costco', { amount: 162.5 })], removed: [] };
    const rows = (await resync()).transactions;
    const parts = rows.filter((t) => t.split_of === 't_costco');
    expect(parts.map((t) => t.amount)).toEqual([100.01, 30, 19.99, 12.5]);
    expect(parts[3]).toMatchObject({ transaction_id: `${REMAINDER_PREFIX}t_costco`, split_remainder: { was: 150 }, category_name: 'general merchandise', split_count: 4 });
    expect(totalsOf(rows).money_out).toBe(162.5);
  });

  test('a transaction the bank removes takes its split with it, once the sync saves the removal', async () => {
    await listed();
    expect((await splitPut('t_costco', costcoSplit())).status).toBe(200);
    next = { added: [], modified: [], removed: [{ transaction_id: 't_costco' }] };
    const rows = (await resync()).transactions;
    expect(rows.some((t) => t.split_of === 't_costco' || t.transaction_id === 't_costco')).toBe(false);
    expect(await splitStore.get(ctx, 't_costco')).toBeNull();
  });

  test('pending to posted: a pending transaction can’t be split, and its posted one, with a new id, can', async () => {
    await listed();
    expect((await splitPut('t_pending', [{ amount: 20, category_id: catId('food and drink') }, { amount: 20, category_id: catId('transportation') }])).status).toBe(409);
    next = { added: [plaidRow('t_posted', { pending: false, pending_transaction_id: 't_pending', name: 'GAS STATION', merchant_name: 'Shell', amount: 40, date: daysAgo(1) })], modified: [], removed: [{ transaction_id: 't_pending' }] };
    const rows = (await resync()).transactions;
    expect(rows.filter((t) => t.name === 'Shell').map((t) => t.transaction_id)).toEqual(['t_posted']);
    expect((await splitPut('t_posted', [{ amount: 25, category_id: catId('transportation') }, { amount: 15, category_id: catId('food and drink') }])).status).toBe(200);
    const shell = (await listed()).transactions.filter((t) => t.name === 'Shell');
    expect(shell.map((t) => t.amount)).toEqual([25, 15]);
  });
});

describe('the transaction’s own layers reach its parts', () => {
  test('a rule’s hide takes every part out; its name shows on each; its category never lands on a part', async () => {
    await listed();
    expect((await splitPut('t_costco', costcoSplit())).status).toBe(200);
    const made = await route('rules', 'POST', {
      action: 'add',
      rule: { conditions: [{ field: 'name', op: 'contains', value: 'costco' }], actions: { set_category: catId('travel'), set_name: 'Costco Wholesale', hide: true } },
    });
    expect(made.status).toBe(200);
    const parts = (await listed()).transactions.filter((t) => t.split_of === 't_costco');
    expect(parts.map((t) => [t.name, t.excluded, t.excluded_by_rule, t.category_name])).toEqual([
      ['Costco Wholesale', true, true, 'food and drink'],
      ['Costco Wholesale', true, true, 'home improvement'],
      ['Costco Wholesale', true, true, 'transportation'],
    ]);
    // The whole transaction keeps what the rule made it, for what reads it whole.
    expect(parts[0].split_parent).toMatchObject({ category_name: 'travel', category_by_rule: true, excluded: true, excluded_by_rule: true });
    expect(totalsOf((await listed()).transactions).money_out).toBe(0);
    await rulesStore.remove(ctx);
  });

  test('tags and an exclusion on the transaction reach every part; its note stays on it', async () => {
    await listed();
    expect((await splitPut('t_costco', costcoSplit())).status).toBe(200);
    const tagged = await route('transaction-annotations', 'PATCH', { transaction_id: 't_costco', new_tag: 'Trip', note: 'the big shop' });
    expect(tagged.status).toBe(200);
    let parts = (await listed()).transactions.filter((t) => t.split_of === 't_costco');
    expect(parts.every((t) => t.tags?.length === 1 && t.tags[0] === tagged.body.created_tag.id)).toBe(true);
    expect(parts.map((t) => t.note)).toEqual(['groceries', undefined, undefined]);
    expect(parts[0].split_parent.note).toBe('the big shop');
    expect((await route('transaction-annotations', 'PATCH', { transaction_id: 't_costco', excluded: true })).status).toBe(200);
    parts = (await listed()).transactions.filter((t) => t.split_of === 't_costco');
    expect(parts.map((t) => t.excluded)).toEqual([true, true, true]);
    expect(totalsOf((await listed()).transactions).money_out).toBe(0);
  });
});

describe('a part’s category', () => {
  test('one a part is under can’t be deleted; merged into another, the part follows it', async () => {
    await listed();
    const shopping = categories.groups.find((g: any) => g.name === 'Shopping').id;
    const made = await route('categories', 'POST', { action: 'add-category', name: 'Kids', group: shopping });
    expect(made.status).toBe(200);
    const kids = made.body.categories.categories.find((c: any) => c.name === 'Kids').id;
    expect((await splitPut('t_costco', [{ amount: 120, category_id: catId('food and drink') }, { amount: 30, category_id: kids }])).status).toBe(200);
    const refused = await route('categories', 'POST', { action: 'delete-category', id: kids });
    expect(refused.status).toBe(409);
    expect(refused.body.error).toContain('Kids is used by 1 transaction');
    const merged = await route('categories', 'POST', { action: 'merge', id: kids, into: catId('general merchandise') });
    expect(merged.status).toBe(200);
    const part = (await listed()).transactions.find((t) => t.split_of === 't_costco' && t.amount === 30);
    expect(part).toMatchObject({ category_id: catId('general merchandise'), category_name: 'general merchandise' });
    // Stored as it was: the merge is followed on read, nothing rewritten.
    expect((await splitStore.get(ctx, 't_costco'))!.parts[1].category_id).toBe(kids);
  });

  test('splits that can’t be read stop a category’s delete, rather than let one go a part may use', async () => {
    await listed();
    const shopping = categories.groups.find((g: any) => g.name === 'Shopping').id;
    const kids = (await route('categories', 'POST', { action: 'add-category', name: 'Kids', group: shopping })).body.categories.categories.find((c: any) => c.name === 'Kids').id;
    await fake.hset(ctxKey('transaction-splits'), { t_costco: 'not-ciphertext-but-long-enough-to-be-tried' });
    const refused = await quietly(() => route('categories', 'POST', { action: 'delete-category', id: kids }));
    expect(refused.status).toBe(409);
    expect(refused.body.unreadable).toBe(true);
  });
});

describe('what can’t be read is never taken for nothing', () => {
  test('a split that can’t be read: the transaction shows whole and counts, with a note; the routes answer 409 and leave it as it was', async () => {
    await listed();
    await fake.hset(ctxKey('transaction-splits'), { t_costco: 'not-ciphertext-but-long-enough-to-be-tried' });
    const body = await quietly(() => listed());
    expect(body.transactions.find((t) => t.transaction_id === 't_costco')).toMatchObject({ amount: 150, split_unread: true });
    expect(body.notes).toContain('How you split 1 transaction couldn’t be read, so it shows whole until it can be.');
    const put = await quietly(() => splitPut('t_costco', costcoSplit()));
    expect(put.status).toBe(409);
    expect(put.body).toMatchObject({ unreadable: true, unreadable_ids: ['t_costco'] });
    const del = await quietly(() => route('transaction-splits', 'DELETE', { transaction_id: 't_costco' }));
    expect(del.status).toBe(409);
    expect(fake.hashes.get(ctxKey('transaction-splits'))!.get('t_costco')).toBe('not-ciphertext-but-long-enough-to-be-tried');
  });

  test('the Plan is told only the notes that say transactions are missing, never a split’s, a group’s or a rule’s', async () => {
    await listed();
    // A split that can't be read, a group whose transactions' currencies
    // differ, and a bank whose credentials can't be read.
    await fake.hset(ctxKey('transaction-splits'), { t_costco: 'not-ciphertext-but-long-enough-to-be-tried' });
    const at = new Date().toISOString();
    await groupStore.set(ctx, 'g-mixed', { version: 1, name: 'Trip', category_id: catId('travel'), members: ['t_coffee', typed], date: daysAgo(5), currency: 'USD', created_at: at, updated_at: at });
    await manualTxnStore.update(ctx, MANUAL, (book) => ({ ...book!, rows: book!.rows.map((r) => (r.id === typed ? { ...r, currency: 'EUR' } : r)) }));
    await fake.hset(ctxKey('plaid:items'), { item_b: JSON.stringify({ item_id: 'item_b', institution_name: 'Amex', encrypted_access_token: 'not-ciphertext' }) });
    const body = (await quietly(() => resync())) as unknown as { notes: string[]; unread_notes: string[] };
    expect(body.notes).toContain('How you split 1 transaction couldn’t be read, so it shows whole until it can be.');
    expect(body.notes.some((n) => n.startsWith('The transactions in 1 of your groups are in more than one currency now'))).toBe(true);
    expect(body.unread_notes).toEqual(['Amex: could not decrypt stored credentials']);
    // So the Plan says Amex's transactions couldn't all be read, and nothing of the others.
    expect(unreadTransactions(unreadNotesOf(body))).toEqual([{ institution: 'Amex', reason: 'could not decrypt stored credentials' }]);
    // Of an answer with nothing missing, nothing.
    await fake.hdel(ctxKey('plaid:items'), 'item_b');
    expect(unreadTransactions(unreadNotesOf(await quietly(() => resync())))).toEqual([]);
  });

  test('a split saved in a shape this release doesn’t know is unrecognised: never applied half, never removed', async () => {
    await listed();
    const later = { version: 1, amount: 150, currency: 'USD', parts: [{ id: 'a', amount: 150, category_id: catId('travel'), tax: 3 }], updated_at: new Date().toISOString() };
    await fake.hset(ctxKey('transaction-splits'), { t_costco: await encrypt(ctx, JSON.stringify(later)) });
    const body = await quietly(() => listed());
    expect(body.transactions.find((t) => t.transaction_id === 't_costco')).toMatchObject({ amount: 150, split_unread: true });
    const del = await quietly(() => route('transaction-splits', 'DELETE', { transaction_id: 't_costco' }));
    expect(del.status).toBe(409);
    expect(del.body).toMatchObject({ unreadable: true, unrecognised_ids: ['t_costco'] });
    expect(fake.hashes.get(ctxKey('transaction-splits'))!.has('t_costco')).toBe(true);
  });

  test('a store of transactions that can’t be read stops a split of a transaction it could hold (409), never “not stored”', async () => {
    await listed();
    await fake.set(ctxKey('txns:item_a'), 'damaged');
    const put = await quietly(() => splitPut('t_costco', costcoSplit()));
    expect(put.status).toBe(409);
    expect(put.body.error).toContain('Chase');
    expect(await splitStore.count(ctx)).toBe(0);
  });

  test('storage failing is a server error, never an empty answer', async () => {
    await listed();
    fake.failNext('eval');
    const put = await quietly(() => splitPut('t_costco', costcoSplit()));
    expect(put.status).toBe(500);
  });
});

describe('pruning what went with its transaction', () => {
  test('the splits and groups are read before the stores, so one set on a row stored meanwhile is never taken for an orphan', async () => {
    const { pruneSplitsAndGroups } = await import('@/lib/split-gone');
    const { groupStore } = await import('@/lib/groups');
    const at = new Date().toISOString();
    const record = (amount: number) => ({ version: 1 as const, amount, currency: 'USD', parts: [{ id: 'a', amount: amount / 2, category_id: catId('food and drink') }, { id: 'b', amount: amount / 2, category_id: catId('travel') }], updated_at: at });
    const group = (members: string[]) => ({ version: 1 as const, name: 'G', category_id: catId('food and drink'), members, date: daysAgo(3), currency: 'USD', created_at: at, updated_at: at });
    await splitStore.set(ctx, 't_gone', record(10));
    await groupStore.set(ctx, 'g_old', group(['t_gone', 't_kept']));
    await pruneSplitsAndGroups(ctx, async () => {
      // While the stores are read, a row is stored and split and grouped.
      await splitStore.set(ctx, 't_new', record(20));
      await groupStore.set(ctx, 'g_new', group(['t_new', 't_new2']));
      return new Set(['t_kept']);
    });
    expect(await splitStore.get(ctx, 't_gone')).toBeNull();
    expect((await groupStore.get(ctx, 'g_old'))!.members).toEqual(['t_kept']);
    expect(await splitStore.get(ctx, 't_new')).not.toBeNull();
    expect((await groupStore.get(ctx, 'g_new'))!.members).toEqual(['t_new', 't_new2']);
    // A store that can't be read, or is behind: nothing goes.
    await pruneSplitsAndGroups(ctx, async () => null);
    expect(await splitStore.get(ctx, 't_new')).not.toBeNull();
  });
});

describe('what a disconnect would take', () => {
  test('how many of a connection’s transactions are split and grouped, for its confirmation to say first', async () => {
    const { groupStore } = await import('@/lib/groups');
    await listed();
    expect((await splitPut('t_costco', costcoSplit())).status).toBe(200);
    await groupStore.set(ctx, 'g1', { version: 1, name: 'Market run', category_id: catId('food and drink'), members: ['t_coffee', typed], date: daysAgo(5), currency: 'USD', created_at: new Date().toISOString(), updated_at: new Date().toISOString() });
    const asked = async (query: string) => {
      const mod: any = await import('@/app/api/transaction-splits/route');
      const res: Response = await mod.GET(new Request(`http://x/api/transaction-splits${query}`));
      return { status: res.status, body: await res.json() };
    };
    // The coffee is the bank's; the farmers market, a manual row, stays.
    expect(await asked('?item_id=item_a')).toEqual({ status: 200, body: { split: 1, grouped: 1, shared: 0 } });
    expect(await asked('?item_id=item_none')).toEqual({ status: 200, body: { split: 0, grouped: 0, shared: 0 } });
    expect((await asked('')).status).toBe(400);
    expect((await asked('?item_id=no%20spaces')).status).toBe(400);
    // Splits that can't be read are never counted as none.
    await fake.hset(ctxKey('transaction-splits'), { t_coffee: 'not-encrypted' });
    const unread = await quietly(() => asked('?item_id=item_a'));
    expect([unread.status, unread.body.unreadable]).toEqual([409, true]);
  });
});

describe('a currency without an ISO code', () => {
  test('a transaction in BTC splits to the eighth place, as the sheet reads what is typed, and is saved as typed', async () => {
    const { leftToSplit } = await import('@/components/SplitSheet');
    first.push(plaidRow('t_btc', { amount: 233.5, iso_currency_code: null, unofficial_currency_code: 'BTC', name: 'COINBASE', merchant_name: 'Coinbase' }));
    await listed();
    const typed = leftToSplit(233.5, [{ amount: '77.83333333' }, { amount: '155.66666667' }], 'BTC');
    expect(typed.left).toBe(0);
    const res = await splitPut('t_btc', [
      { amount: typed.parsed[0], category_id: catId('food and drink') },
      { amount: typed.parsed[1], category_id: catId('travel') },
    ]);
    expect(res.status).toBe(200);
    const parts = (await listed()).transactions.filter((t) => t.split_of === 't_btc');
    expect(parts.map((t) => [t.amount, t.unofficial_currency_code])).toEqual([
      [77.83333333, 'BTC'],
      [155.66666667, 'BTC'],
    ]);
    // A ninth place is refused, saying the unit.
    const finer = await splitPut('t_btc', [
      { amount: 77.833333331, category_id: catId('food and drink') },
      { amount: 155.666666669, category_id: catId('travel') },
    ]);
    expect([finer.status, finer.body.error]).toEqual([400, 'A part’s amount can’t be finer than BTC\u00a00.00000001.']);
  });
});

describe('containers', () => {
  test('a split is kept in its own container, and another container’s never shows', async () => {
    await listed();
    await splitStore.set(OTHER, 't_costco', { version: 1, amount: 150, currency: 'USD', parts: [{ id: 'x1', amount: 75, category_id: catId('travel') }, { id: 'x2', amount: 75, category_id: catId('travel') }], updated_at: new Date().toISOString() });
    expect((await listed()).transactions.find((t) => t.transaction_id === 't_costco')).toBeDefined();
    expect((await splitPut('t_costco', costcoSplit())).status).toBe(200);
    expect(fake.hashes.get(ctxKey('transaction-splits'))!.has('t_costco')).toBe(true);
    expect((await splitStore.get(OTHER, 't_costco'))!.parts.map((p) => p.id)).toEqual(['x1', 'x2']);
  });
});
