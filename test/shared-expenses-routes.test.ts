import { describe, expect, test, mock, beforeEach, afterEach } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { FakeRedis, storageMock, TEST_CTX, ctxKey, registerTestContainer, unscopedDataKeys } from './fake-redis';

// Shared expenses (#49), end to end through the routes: someone added, one of
// your transactions shared, an IOU you owe for something, a payment confirmed
// that pays both back; the Activity tab's own read counts your part and
// nothing twice; every route checks what it is told against what is stored
// and answers the seam's errors in the seam's way; what can't be read is
// never taken for nothing; one container never sees another's; no read ever
// writes; and nothing but the edits module writes the stores.

const ctx = TEST_CTX;
const OTHER = { container: '9c1d2e3f-4a5b-4c6d-8e7f-0a1b2c3d4e5f' } as typeof TEST_CTX;
process.env.PLAID_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
delete process.env.MAX_TXN_BLOB_CHARS;
const DAY = 86_400_000;
const daysAgo = (n: number) => new Date(Date.now() - n * DAY).toISOString().slice(0, 10);

const first: any[] = [];
let cursor = 0;
mock.module('@/lib/plaid', () => ({
  plaidClient: {
    transactionsSync: async (req: any) => ({
      data: {
        added: req.cursor ? [] : first,
        modified: [],
        removed: [],
        accounts: [account('acct_card', 'credit'), account('acct_check', 'depository')],
        next_cursor: `c${++cursor}`,
        has_more: false,
        transactions_update_status: 'HISTORICAL_UPDATE_COMPLETE',
      },
    }),
  },
}));

const fake = new FakeRedis();
afterEach(() => expect(unscopedDataKeys(fake)).toEqual([]));
mock.module('@/lib/storage', () => storageMock(fake));

const { encrypt } = await import('@/lib/crypto');
const { rememberAccounts } = await import('@/lib/last-known');
const { summarize } = await import('@/lib/totals');
const { groupStore } = await import('@/lib/groups');
const store = await import('@/lib/shared-expenses/store');

function account(id: string, type: string) {
  return { account_id: id, name: type === 'credit' ? 'Card' : 'Checking', official_name: null, type, subtype: type === 'credit' ? 'credit card' : 'checking', mask: '4821', balances: { available: null, current: 100, limit: null, iso_currency_code: 'USD' } };
}
const plaidRow = (id: string, over: Record<string, unknown> = {}) => ({
  transaction_id: id,
  account_id: 'acct_card',
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

const route = async (path: string, method: string, body?: unknown) => {
  const mod: any = await import(`@/app/api/${path}/route`);
  const res = await mod[method](new Request(`http://x/api/${path}`, { method, body: body !== undefined ? JSON.stringify(body) : undefined }));
  return { status: res.status as number, body: await res.json() };
};
const listed = async () => (await route('transactions', 'GET')).body as { transactions: any[]; notes: string[] };
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
const recent = (d: string) => d >= daysAgo(30);

let categories: any;
const catId = (name: string) => categories.categories.find((c: any) => c.name === name).id;

beforeEach(async () => {
  fake.reset();
  first.length = 0;
  first.push(
    plaidRow('t_dinner'),
    plaidRow('t_venmo', { account_id: 'acct_check', amount: -35, date: daysAgo(3), name: 'VENMO CASHOUT', merchant_name: 'Venmo', personal_finance_category: { primary: 'TRANSFER_IN', detailed: 'TRANSFER_IN_ACCOUNT_TRANSFER' } }),
    plaidRow('t_refund', { account_id: 'acct_card', amount: -20, date: daysAgo(4), name: 'TARGET', merchant_name: 'Target', personal_finance_category: { primary: 'GENERAL_MERCHANDISE', detailed: 'GENERAL_MERCHANDISE_SUPERSTORES' } }),
    plaidRow('t_pending', { amount: 40, pending: true, date: daysAgo(1), name: 'SHELL' })
  );
  (await import('@/lib/sessions')).forgetEpochs();
  await registerTestContainer(fake);
  await fake.hset(ctxKey('plaid:items'), { item_a: JSON.stringify({ item_id: 'item_a', institution_name: 'Chase', encrypted_access_token: await encrypt(ctx, 'token-a') }) });
  await rememberAccounts(ctx, [{ item_id: 'item_a', institution_name: 'Chase', institution_id: null, error: null, accounts: [{ ...account('acct_card', 'credit'), balance: 100 }, { ...account('acct_check', 'depository'), balance: 900 }] } as any]);
  categories = (await route('categories', 'GET')).body.categories;
});

/** Alex, a dinner shared half with them, and an IOU you owe for groceries. */
async function seeded() {
  await listed();
  const alex = await route('shared-expenses/people', 'POST', { name: 'Alex Smith', venmo: '@alex-s', app: 'venmo' });
  expect(alex.status).toBe(200);
  const person = alex.body.id;
  const shared = await route('shared-expenses/shares', 'PUT', { transaction_id: 't_dinner', entries: [{ person, amount: 60, how: { kind: 'half' } }] });
  expect(shared.status).toBe(200);
  const entry = shared.body.share.entries[0].id;
  const owed = await route('shared-expenses/ious', 'POST', { person, direction: 'by_you', amount: 25, currency: 'USD', date: daysAgo(5), what: 'Groceries Alex bought', category_id: catId('food and drink') });
  expect(owed.status).toBe(200);
  return { person, entry, iou: owed.body.id as string };
}

describe('the loop, through the routes', () => {
  test('share, IOU, a payment confirmed: your part counts, nothing twice, and the balance closes', async () => {
    const before = summarize((await listed()).transactions, recent, 'USD');
    const { person, entry, iou } = await seeded();

    const shown = await listed();
    const dinner = shown.transactions.find((t) => t.transaction_id === 't_dinner');
    expect([dinner.amount, dinner.shared_was, dinner.shared.people]).toEqual([60, 120, [{ person, item: entry, amount: 60 }]]);
    expect(shown.transactions.find((t) => t.transaction_id === `share:${entry}`)).toMatchObject({ amount: 60, excluded: true });
    expect(shown.transactions.find((t) => t.transaction_id === `iou:${iou}`)).toMatchObject({ amount: 25, category_name: 'food and drink' });
    const during = summarize(shown.transactions, recent, 'USD');
    // The dinner at your part, and your part of the groceries: 120 - 60 + 25.
    expect(during.money_out).toBe(before.money_out - 60 + 25);
    expect(during.shared).toBe(1);

    const c = await card();
    expect(c.people.map((p: any) => [p.name, p.venmo])).toEqual([['Alex Smith', 'alex-s']]);
    expect(c.balances[person]).toEqual([{ currency: 'USD', amount: 35, open: 2, oldest: daysAgo(10), over: 0 }]);

    // Alex's $35 by Venmo pays back the dinner and takes off the groceries.
    const paid = await route('shared-expenses/payments', 'POST', { transaction_id: 't_venmo', allocations: [{ item: entry, amount: 60 }, { item: iou, amount: 25 }] });
    expect(paid.status).toBe(200);
    expect((await route('shared-expenses/payments', 'POST', { transaction_id: 't_venmo', allocations: [{ item: entry, amount: 60 }, { item: iou, amount: 25 }] })).status).toBe(409);
    const after = await listed();
    const totals = summarize(after.transactions, recent, 'USD');
    expect([totals.money_in, totals.money_out]).toEqual([before.money_in, during.money_out]);
    expect((await card()).balances[person]).toEqual([]);

    // Reopened: open again, and the row counts as the bank shows it.
    expect((await route('shared-expenses/payments', 'DELETE', { transaction_id: 't_venmo' })).status).toBe(200);
    expect((await card()).balances[person][0].amount).toBe(35);
  });

  test('with counting as the bank shows it, every total is what it was', async () => {
    const before = summarize((await listed()).transactions, recent, 'USD');
    await seeded();
    expect((await route('shared-expenses', 'PUT', { counting: 'bank' })).status).toBe(200);
    const after = summarize((await listed()).transactions, recent, 'USD');
    expect([after.money_in, after.money_out, after.transactions]).toEqual([before.money_in, before.money_out, before.transactions]);
  });

  test('settled outside your accounts, let go, taken back', async () => {
    const { person, entry } = await seeded();
    const closed = await route('shared-expenses/close', 'POST', { kind: 'outside', items: [{ item: entry, amount: 60 }], date: daysAgo(2), note: 'cash' });
    expect(closed.status).toBe(200);
    expect((await card()).balances[person]).toEqual([{ currency: 'USD', amount: -25, open: 1, oldest: daysAgo(5), over: 0 }]);
    expect((await route('shared-expenses/close', 'POST', { kind: 'outside', items: [{ item: entry, amount: 1 }], date: daysAgo(2) })).status).toBe(409);
    expect((await route('shared-expenses/close', 'DELETE', { item: entry, event: closed.body.event })).status).toBe(200);
    // Let go of half the dinner: it becomes yours on its day.
    await route('shared-expenses/close', 'POST', { kind: 'forgiven', items: [{ item: entry, amount: 30 }], date: daysAgo(2) });
    const dinner = (await listed()).transactions.find((t) => t.transaction_id === 't_dinner');
    expect(dinner.amount).toBe(90);
  });

  test('forget keeps the money: the name and handle go, the balance stays', async () => {
    const { person } = await seeded();
    expect((await route('shared-expenses/people', 'PATCH', { id: person, action: 'forget' })).status).toBe(200);
    const c = await card();
    expect(c.people).toEqual([expect.objectContaining({ id: person, name: null, venmo: null, removed: true })]);
    expect(c.balances[person][0].amount).toBe(35);
    // Archiving needs everything settled.
    expect((await route('shared-expenses/people', 'PATCH', { id: person, action: 'archive' })).status).toBe(409);
    // Nothing new with someone forgotten.
    expect((await route('shared-expenses/ious', 'POST', { person, direction: 'to_you', amount: 5, currency: 'USD', date: daysAgo(1), what: 'x' })).status).toBe(409);
  });
});

describe('every route checks what it is told against what is stored', () => {
  test('a share: posted, money out, in a currency, not grouped or paying, no more than the transaction', async () => {
    const { person } = await seeded();
    const put = (transaction_id: string, entries: unknown, extra: Record<string, unknown> = {}) => route('shared-expenses/shares', 'PUT', { transaction_id, entries, ...extra });
    expect((await put('t_pending', [{ person, amount: 10 }])).status).toBe(409);
    expect((await put('t_refund', [{ person, amount: 10 }])).status).toBe(409);
    expect((await put('t_nowhere', [{ person, amount: 10 }])).status).toBe(404);
    expect((await put('t_dinner', [{ person, amount: 130 }])).status).toBe(400);
    expect((await put('t_dinner', [{ person, amount: 10.001 }])).status).toBe(400);
    expect((await put('t_dinner', [{ person: 'nobody-like-this', amount: 10 }])).status).toBe(404);
    expect((await put('share:abc', [{ person, amount: 10 }])).status).toBe(400);
    expect((await put('t_dinner', [{ person, amount: 10 }], { later: true })).status).toBe(400);
    // Opened on an older version: refused, nothing lost.
    expect((await put('t_dinner', [{ person, amount: 10 }], { updated_at: '2000-01-01T00:00:00.000Z' })).status).toBe(409);
    // Grouped: the group says how it counts, both ways.
    await groupStore.set(ctx, 'g1', { version: 1, name: 'Night out', category_id: catId('food and drink'), members: ['t_refund', 't_venmo'], date: daysAgo(4), currency: 'USD', created_at: new Date().toISOString(), updated_at: new Date().toISOString() });
    expect((await route('shared-expenses/payments', 'POST', { transaction_id: 't_venmo', allocations: [{ item: 'x1', amount: 1 }] })).status).toBe(409);
    const grouping = await route('transaction-groups', 'POST', { name: 'Dinner and more', category_id: catId('food and drink'), members: ['t_dinner', 't_refund'] });
    expect(grouping.body.error).toContain('Shared expenses');
    expect(grouping.status).toBe(409);
    // Split while shared whole: refused.
    const split = await route('transaction-splits', 'PUT', { transaction_id: 't_dinner', parts: [{ amount: 100, category_id: catId('food and drink') }, { amount: 20, category_id: catId('food and drink') }] });
    expect(split.status).toBe(409);
    expect(split.body.error).toContain('Shared expenses');
    // A row the read layer made is no transaction to annotate.
    expect((await route('transaction-annotations', 'PATCH', { transaction_id: 'share:abc', excluded: true })).status).toBe(400);
  });

  test('a payment: never more than is open, the right way round, never on a shared row, never once dismissed', async () => {
    const { entry, iou } = await seeded();
    const pay = (transaction_id: string, allocations: unknown) => route('shared-expenses/payments', 'POST', { transaction_id, allocations });
    expect((await pay('t_venmo', [{ item: entry, amount: 61 }])).status).toBe(409);
    expect((await pay('t_venmo', [{ item: iou, amount: 25 }])).status).toBe(409); // money in can't pay what you owe alone
    expect((await pay('t_venmo', [{ item: entry, amount: 40 }])).status).toBe(409); // more than the payment
    expect((await pay('t_dinner', [{ item: entry, amount: 10 }])).status).toBe(409); // shared
    expect((await pay('t_pending', [{ item: entry, amount: 10 }])).status).toBe(409);
    expect((await pay('t_venmo', [{ item: 'gone-item', amount: 10 }])).status).toBe(409);
    expect((await route('shared-expenses/payments', 'PATCH', { action: 'dismiss', transaction_id: 't_venmo' })).status).toBe(200);
    expect((await pay('t_venmo', [{ item: entry, amount: 35 }])).status).toBe(409);
    expect((await route('shared-expenses/payments', 'PATCH', { action: 'undismiss', transaction_id: 't_venmo' })).status).toBe(200);
    expect((await pay('t_venmo', [{ item: entry, amount: 35 }])).status).toBe(200);
    // What a payment names stays: the share can't stop, nor go below what it
    // paid back. The IOU it doesn't name can go.
    expect((await route('shared-expenses/shares', 'DELETE', { transaction_id: 't_dinner' })).status).toBe(409);
    expect((await route('shared-expenses/shares', 'PUT', { transaction_id: 't_dinner', entries: [{ person: (await card()).people[0].id, amount: 20 }] })).status).toBe(409);
    expect((await route('shared-expenses/ious', 'DELETE', { id: iou })).status).toBe(200);
  });

  test('an IOU a payment names can’t be removed, nor one something settled; once reopened it can', async () => {
    const { entry, iou } = await seeded();
    // Alex's $35 pays back the dinner's 60 and takes off the 25 you owe.
    expect((await route('shared-expenses/payments', 'POST', { transaction_id: 't_venmo', allocations: [{ item: entry, amount: 60 }, { item: iou, amount: 25 }] })).status).toBe(200);
    const refused = await route('shared-expenses/ious', 'DELETE', { id: iou });
    expect(refused.status).toBe(409);
    expect(refused.body.error).toMatch(/payment/i);
    expect(await store.expenseIousStore.get(ctx, iou)).not.toBeNull();
    expect((await route('shared-expenses/payments', 'DELETE', { transaction_id: 't_venmo' })).status).toBe(200);
    // Settled outside your accounts instead: refused again, until reopened.
    const closed = await route('shared-expenses/close', 'POST', { kind: 'outside', items: [{ item: iou, amount: 25 }], date: daysAgo(1) });
    expect(closed.status).toBe(200);
    expect((await route('shared-expenses/ious', 'DELETE', { id: iou })).status).toBe(409);
    expect((await route('shared-expenses/close', 'DELETE', { item: iou, event: closed.body.event })).status).toBe(200);
    expect((await route('shared-expenses/ious', 'DELETE', { id: iou })).status).toBe(200);
    expect(await store.expenseIousStore.get(ctx, iou)).toBeNull();
  });

  test('people: a name once, handles as handles, and only what is known', async () => {
    await listed();
    expect((await route('shared-expenses/people', 'POST', { name: 'Sam' })).status).toBe(200);
    expect((await route('shared-expenses/people', 'POST', { name: ' sam ' })).status).toBe(409);
    expect((await route('shared-expenses/people', 'POST', { name: 'Kim', venmo: '5551234567' })).status).toBe(400);
    expect((await route('shared-expenses/people', 'POST', { name: 'Kim', email: 'k@example.com' })).status).toBe(400);
    expect((await route('shared-expenses/people', 'POST', { name: '' })).status).toBe(400);
    expect((await route('shared-expenses/ious', 'POST', { person: (await card()).people[0].id, direction: 'by_you', amount: 5, currency: 'USD', date: daysAgo(1), what: 'Pay', category_id: catId('income') })).status).toBe(400);
  });
});

describe('what can’t be read is never taken for nothing', () => {
  test('a damaged share: the card shows no balance as a figure, the transaction counts whole, and nothing is written over it', async () => {
    const { person } = await seeded();
    await fake.hset(ctxKey('expense-shares'), { t_dinner: 'not-encrypted' });
    const c = await quietly(card);
    expect(c.balances).toBeNull();
    expect(c.unread['expense-shares'].unreadable).toEqual(['t_dinner']);
    const shown = await quietly(listed);
    expect(shown.transactions.find((t: any) => t.transaction_id === 't_dinner').amount).toBe(120);
    expect(shown.notes.some((n: string) => n.includes('How you shared 1 transaction couldn’t be read'))).toBe(true);
    const over = await quietly(() => route('shared-expenses/shares', 'PUT', { transaction_id: 't_dinner', entries: [{ person, amount: 10 }] }));
    expect([over.status, over.body.unreadable]).toEqual([409, true]);
    // Removed only once confirmed, and only what is damaged.
    const removed = await route('shared-expenses', 'POST', { action: 'remove-unreadable', store: 'shares', ids: ['t_dinner', 't_other'] });
    expect(removed.body.removed).toBe(1);
  });
});

describe('isolation, and reads that never write', () => {
  test('another container sees nothing of this one’s, and this one nothing of the other’s', async () => {
    await seeded();
    expect(await store.expensePeopleStore.count(OTHER)).toBe(0);
    expect(await store.expenseSharesStore.count(OTHER)).toBe(0);
    expect((await store.expensePeopleStore.getAll(ctx)).size).toBe(1);
  });

  test('reading the card, the transactions and the API changes no store of shared expenses', async () => {
    await seeded();
    const keys = ['expense-settings', 'expense-people', 'expense-shares', 'expense-ious', 'expense-payments', 'expense-dismissed'].map((k) => ctxKey(k));
    const snapshot = async () => JSON.stringify(await Promise.all(keys.map(async (k) => [await fake.hgetall(k), await fake.get(k).catch(() => null)])));
    const before = await snapshot();
    await listed();
    await card();
    await listed();
    expect(await snapshot()).toBe(before);
  });

  test('only lib/shared-expenses/edits.ts writes the stores (a scan of the source)', () => {
    const root = join(import.meta.dir, '..');
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(join(root, dir))) {
        const path = join(dir, name);
        if (name === 'node_modules' || name.startsWith('.')) continue;
        if (statSync(join(root, path)).isDirectory()) walk(path);
        else if (/\.(ts|tsx)$/.test(name)) files.push(path);
      }
    };
    for (const dir of ['lib', 'app', 'components']) walk(dir);
    const writes = /\bexpense(Settings|People|Shares|Ious|Payments|Dismissed)Store\.(set|setMany|update|updateMany|remove|replaceUnreadable)\(/;
    const writers = files.filter((f) => writes.test(readFileSync(join(root, f), 'utf8')));
    expect(writers).toEqual(['lib/shared-expenses/edits.ts']);
  });
});

describe('the write paths, each through its route', () => {
  test('a person: edited, archived only once settled, given nothing new while archived, brought back, forgotten, their shared expenses removed', async () => {
    const { person, entry, iou } = await seeded();
    const patch = (body: Record<string, unknown>) => route('shared-expenses/people', 'PATCH', { id: person, ...body });
    expect((await patch({ action: 'edit', name: 'Alex S.', venmo: '@alexs', cashtag: '$alexcash' })).body.person).toMatchObject({ name: 'Alex S.', venmo: 'alexs', cashtag: 'alexcash' });
    expect((await patch({ action: 'edit', venmo: 'not a handle!' })).status).toBe(400);
    // Something is open: no archive.
    expect((await patch({ action: 'archive' })).status).toBe(409);
    // Settled both ways, then archived: nothing new for them until brought back.
    const settled = await route('shared-expenses/close', 'POST', { kind: 'outside', items: [{ item: entry, amount: 60 }, { item: iou, amount: 25 }], date: daysAgo(1) });
    expect(settled.status).toBe(200);
    expect((await patch({ action: 'archive' })).status).toBe(200);
    const refusedShare = await route('shared-expenses/shares', 'PUT', { transaction_id: 't_refund', entries: [{ person, amount: 5 }] });
    expect(refusedShare.status).toBe(409);
    const refusedIou = await route('shared-expenses/ious', 'POST', { person, direction: 'to_you', amount: 40, currency: 'USD', date: daysAgo(5), what: 'Tickets' });
    expect(refusedIou.status).toBe(409);
    expect(refusedIou.body.error).toContain('bring them back first');
    // The dinner's share, left as it is, can still be edited for its title.
    expect((await route('shared-expenses/shares', 'PUT', { transaction_id: 't_dinner', what: 'Dinner at Joe’s', entries: [{ person, amount: 60 }] })).status).toBe(200);
    expect((await patch({ action: 'unarchive' })).status).toBe(200);
    expect((await route('shared-expenses/ious', 'POST', { person, direction: 'to_you', amount: 40, currency: 'USD', date: daysAgo(5), what: 'Tickets' })).status).toBe(200);
    // Forgotten: the name and handles go, every amount stays.
    const before = (await card()).balances[person];
    expect((await patch({ action: 'forget' })).body.person).toEqual(expect.not.objectContaining({ name: expect.anything() }));
    const after = await card();
    expect(after.people.find((p: any) => p.id === person)).toMatchObject({ name: null, venmo: null, cashtag: null, removed: true });
    expect(after.balances[person]).toEqual(before);
    // A forgotten person's part left as it is goes through an edit of the others.
    expect((await route('shared-expenses/shares', 'PUT', { transaction_id: 't_dinner', what: 'Dinner', entries: [{ person, amount: 60 }] })).status).toBe(200);
    expect((await route('shared-expenses/shares', 'PUT', { transaction_id: 't_dinner', entries: [{ person, amount: 50 }] })).status).toBe(409);
    // Their shared expenses removed: refused while a payment names one of
    // them, then done (what settled them outside your accounts goes too).
    const pay = await route('shared-expenses/payments', 'POST', { transaction_id: 't_venmo', allocations: [{ item: iou, amount: 25 }, { item: (await card()).items.find((i: any) => i.what === 'Tickets').id, amount: 40 }] });
    expect(pay.status).toBe(409); // the groceries were settled outside: nothing open of them
    const tickets = (await card()).items.find((i: any) => i.what === 'Tickets').id;
    expect((await route('shared-expenses/payments', 'POST', { transaction_id: 't_venmo', allocations: [{ item: tickets, amount: 35 }] })).status).toBe(200);
    expect((await patch({ action: 'remove-expenses' })).status).toBe(409);
    expect((await route('shared-expenses/payments', 'DELETE', { transaction_id: 't_venmo' })).status).toBe(200);
    const removed = await patch({ action: 'remove-expenses' });
    expect(removed.status).toBe(200);
    expect(removed.body).toEqual({ shares: 1, ious: 2 });
    expect(await store.expenseSharesStore.get(ctx, 't_dinner')).toBeNull();
  });

  test('a request sent through the handoff is recorded on the person, the latest kept', async () => {
    const { person, entry } = await seeded();
    const ask = (over: Record<string, unknown> = {}) => route('shared-expenses/people', 'PATCH', { id: person, action: 'request', direction: 'to_you', amount: 35, currency: 'USD', via: 'venmo', items: [entry], ...over });
    expect((await ask()).status).toBe(200);
    expect((await ask({ via: 'carrier-pigeon' })).status).toBe(400);
    expect((await ask({ items: ['not an id!'] })).status).toBe(400);
    const p = (await card()).people.find((x: any) => x.id === person);
    expect(p.requests.map((r: any) => [r.direction, r.amount, r.via, r.items])).toEqual([['to_you', 35, 'venmo', [entry]]]);
    await route('shared-expenses/people', 'PATCH', { id: person, action: 'forget' });
    expect((await ask()).status).toBe(409);
  });

  test('sharing many at once, from a tag: each answered, one refused on its own', async () => {
    await listed();
    const person = (await route('shared-expenses/people', 'POST', { name: 'Sam Lee' })).body.id;
    const many = await route('shared-expenses/shares', 'PATCH', { action: 'many', person, ids: ['t_dinner', 't_refund'], how: { kind: 'half' } });
    expect(many.status).toBe(200);
    expect(many.body.results.map((r: any) => [r.id, r.ok])).toEqual([
      ['t_dinner', true],
      ['t_refund', false],
    ]);
    expect((await store.expenseSharesStore.get(ctx, 't_dinner'))!.entries.map((e) => e.amount)).toEqual([60]);
    expect((await route('shared-expenses/shares', 'PATCH', { action: 'many', person, ids: ['t_dinner'], how: { kind: 'amount' } })).status).toBe(400);
  });

  test('an entry id the request names is never taken: an IOU’s id can’t make two items one', async () => {
    await listed();
    const person = (await route('shared-expenses/people', 'POST', { name: 'Alex Smith' })).body.id;
    const iou = (await route('shared-expenses/ious', 'POST', { person, direction: 'to_you', amount: 40, currency: 'USD', date: daysAgo(5), what: 'Tickets' })).body.id;
    const s = await route('shared-expenses/shares', 'PUT', { transaction_id: 't_dinner', entries: [{ id: iou, person, amount: 60 }] });
    expect(s.status).toBe(200);
    expect(s.body.share.entries[0].id).not.toBe(iou);
    const c = await card();
    expect(c.items).toHaveLength(2);
    expect(c.balances[person][0].amount).toBe(100);
  });

  test('a request too large is 413, one that isn’t JSON 400, and with no container to reach, 503, nothing written', async () => {
    await listed();
    const raw = async (path: string, method: string, body: string) => {
      const mod: any = await import(`@/app/api/${path}/route`);
      const res = await mod[method](new Request(`http://x/api/${path}`, { method, body }));
      return res.status as number;
    };
    expect(await raw('shared-expenses/people', 'POST', JSON.stringify({ name: 'x'.repeat(40_000) }))).toBe(413);
    expect(await raw('shared-expenses/shares', 'PUT', '{not json')).toBe(400);
    fake.reset();
    (await import('@/lib/sessions')).forgetEpochs();
    for (const [path, method, body] of [
      ['shared-expenses', 'GET', undefined],
      ['shared-expenses/people', 'POST', { name: 'Alex' }],
      ['shared-expenses/shares', 'PUT', { transaction_id: 't_dinner', entries: [] }],
      ['shared-expenses/ious', 'POST', { person: 'p' }],
      ['shared-expenses/payments', 'POST', { transaction_id: 't_venmo', allocations: [] }],
      ['shared-expenses/close', 'POST', { kind: 'outside' }],
    ] as const) {
      expect([path, (await quietly(() => route(path, method, body))).status]).toEqual([path, 503]);
    }
    expect([...((fake as any).hashes as Map<string, unknown>).keys()].filter((k) => k.includes('expense-'))).toEqual([]);
  });
});
