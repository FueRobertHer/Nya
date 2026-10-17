import { describe, expect, test, mock, beforeEach, afterEach } from 'bun:test';
import { FakeRedis, storageMock, TEST_CTX, ctxKey, registerTestContainer, unscopedDataKeys } from './fake-redis';

// The review queue and merchants' defaults end to end, through the routes and
// the Activity tab's own read: what needs review on the day the queue starts
// and after; approving as shown, in bulk, and undoing it; a rule added later,
// a merchant's default and the bank's new category never moving an approved
// transaction, only offered; the bank's new amount putting it back in the
// queue; a pending transaction's approval carried to the posted one; splits
// and groups counted as transactions; an approval that can't be read never
// taken for none, refused over, and removed only once asked; the defaults set
// by two of the last three categorizations, in their place against rules and
// the person's own, undone exactly, held to by a category's delete and moved
// by its merge; the read-only API's fields; the download's; the routes'
// checks; and one container never seeing another's.

const ctx = TEST_CTX;
const OTHER = { container: '9c1d2e3f-4a5b-4c6d-8e7f-0a1b2c3d4e5f' } as typeof TEST_CTX;
process.env.PLAID_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
delete process.env.MAX_TXN_BLOB_CHARS;
const DAY = 86_400_000;
const daysAgo = (n: number) => new Date(Date.now() - n * DAY).toISOString().slice(0, 10);
const TODAY = daysAgo(0);
const DAMAGED = 'not-ciphertext-but-long-enough-to-be-tried';

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
const { addManualTxn, newManualTxn } = await import('@/lib/manual-txns');
const { approvalStore } = await import('@/lib/review-store');
const { vendorDefaultsStore } = await import('@/lib/vendor-default-store');
const { approvalInputOf, countToReview } = await import('@/lib/review-layer');
const { bankRows } = await import('@/lib/split-rows');
const { queryTransactions } = await import('@/lib/api-read');
const { collectUserData, buildUserExport, transactionsCsv } = await import('@/lib/user-export');

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
  pending_transaction_id: null,
  counterparties: [],
  personal_finance_category: { primary: 'GENERAL_MERCHANDISE', detailed: 'GENERAL_MERCHANDISE_SUPERSTORES' },
  ...over,
});

const route = async (path: string, method: string, body?: unknown, raw?: string) => {
  const mod: any = await import(`@/app/api/${path}/route`);
  const res = await mod[method](new Request(`http://x/api/${path}`, { method, body: raw ?? (body !== undefined ? JSON.stringify(body) : undefined) }));
  return { status: res.status, body: await res.json() };
};
type Listed = { transactions: any[]; notes: string[]; review: { on: boolean; since: string | null; unread: boolean; unknown: number } };
const listed = async () => (await route('transactions', 'GET')).body as Listed;
const resync = async () => {
  const mod: any = await import('@/app/api/transactions/route');
  const res = await mod.GET(new Request('http://x/api/transactions?refresh=1'));
  return (await res.json()) as Listed;
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
const start = (since?: string) => route('review', 'POST', { action: 'start', today: TODAY, ...(since ? { since } : {}) });
/** Each transaction as the Activity tab has it whole (bankRows), by id. */
const wholeById = (rows: any[]) => new Map(bankRows(rows).map((t: any) => [t.transaction_id, t]));
/** Approves these transactions as the list shows them, as the page does. */
const approveShown = async (ids: string[]) => {
  const whole = wholeById((await listed()).transactions);
  return route('review', 'POST', { action: 'approve', items: ids.map((id) => approvalInputOf(whole.get(id))) });
};
const find = (rows: any[], id: string) => rows.find((t) => t.transaction_id === id);

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
    plaidRow('t_pending', { name: 'GAS STATION', merchant_name: 'Shell', amount: 40, pending: true, date: daysAgo(1), personal_finance_category: { primary: 'TRANSPORTATION', detailed: null } })
  );
  next = { added: [], modified: [], removed: [] };
  (await import('@/lib/sessions')).forgetEpochs();
  await registerTestContainer(fake);
  await fake.hset(ctxKey('plaid:items'), { item_a: JSON.stringify({ item_id: 'item_a', institution_name: 'Chase', encrypted_access_token: await encrypt(ctx, 'token-a') }) });
  await rememberAccounts(ctx, [{ item_id: 'item_a', institution_name: 'Chase', institution_id: null, error: null, accounts: [{ ...account('acct_a'), balance: 100 }] } as any]);
  await saveManualAccount(ctx, { account_id: MANUAL, name: 'Cash', institution_name: 'Wallet', type: 'depository', subtype: 'cash', balance: 50 } as any);
  const t = newManualTxn(MANUAL, { date: daysAgo(2), name: 'Farmers market', amount: 30, currency: 'USD', category: null, note: null });
  await addManualTxn(ctx, t);
  typed = t.id;
  const i = { ...newManualTxn(MANUAL, { date: daysAgo(4), name: 'HARDWARE STORE', amount: 64.5, currency: 'USD', category: null, note: null }), source: 'import:ofx', source_id: 'FITID-77' };
  await addManualTxn(ctx, i);
  imported = i.id;
  categories = (await route('categories', 'GET')).body.categories;
});

describe('what needs review', () => {
  test('on day one, nothing already there; from then on, what arrives', async () => {
    const off = await listed();
    expect(off.review).toEqual({ on: false, since: null, unread: false, unknown: 0 });
    expect(off.transactions.some((t) => t.needs_review)).toBe(false);
    expect(await start()).toEqual({ status: 200, body: { review: { on: true, since: TODAY } } });
    const dayOne = await listed();
    expect(dayOne.review).toEqual({ on: true, since: TODAY, unread: false, unknown: 0 });
    expect(countToReview(dayOne.transactions)).toBe(0);
    // A transaction the bank sends today, and last month's that arrives late.
    next = { added: [plaidRow('t_today', { date: TODAY, amount: 12 }), plaidRow('t_late', { date: daysAgo(30), amount: 13 })], modified: [], removed: [] };
    const after = await resync();
    expect(after.transactions.filter((t) => t.needs_review).map((t) => t.transaction_id)).toEqual(['t_today']);
  });

  test('started a week back: the bank’s, SimpleFIN’s and a file’s since then, never one entered by hand', async () => {
    expect((await start(daysAgo(7))).status).toBe(200);
    const rows = (await listed()).transactions;
    expect(rows.filter((t) => t.needs_review).map((t) => t.transaction_id).sort()).toEqual([imported, 't_coffee', 't_costco', 't_pending'].sort());
    expect(find(rows, typed).needs_review).toBeUndefined();
    // Off: nothing needs review, and approvals stay.
    expect((await approveShown(['t_costco'])).status).toBe(200);
    expect((await route('review', 'POST', { action: 'stop' })).body).toEqual({ review: { on: false, since: daysAgo(7) } });
    const off = (await listed()).transactions;
    expect(off.some((t) => t.needs_review)).toBe(false);
    expect(find(off, 't_costco').reviewed_at).toBeDefined();
  });
});

describe('approving', () => {
  test('approved as shown, in bulk, and undone back to needing review', async () => {
    await start(daysAgo(7));
    const approved = await approveShown(['t_costco', 't_coffee', imported]);
    expect(approved.status).toBe(200);
    expect(approved.body.approved).toBe(3);
    const rows = (await listed()).transactions;
    expect(rows.filter((t) => t.needs_review).map((t) => t.transaction_id)).toEqual(['t_pending']);
    expect(find(rows, 't_costco').reviewed_at).toBe(approved.body.approved_at);
    const undo = await route('review', 'POST', {
      action: 'undo',
      items: approved.body.previous.map((p: any) => ({ transaction_id: p.transaction_id, approved_at: approved.body.approved_at, previous: p.previous })),
    });
    expect(undo).toEqual({ status: 200, body: { restored: 3 } });
    expect(countToReview((await listed()).transactions)).toBe(4);
    expect(await approvalStore.count(ctx)).toBe(0);
  });

  test('a rule added later never moves an approved transaction: it stays, the rule’s category offered; the rest follow the rule', async () => {
    await start(daysAgo(7));
    await listed();
    next = { added: [plaidRow('t_costco2', { amount: 80, date: daysAgo(2) })], modified: [], removed: [] };
    await resync();
    expect((await approveShown(['t_costco'])).status).toBe(200);
    // Before it is saved, the preview says so.
    const rule = { conditions: [{ field: 'name', op: 'contains', value: 'costco' }], actions: { set_category: catId('travel') } };
    expect((await route('rules/preview', 'POST', { rule })).body).toMatchObject({ matches: 2, keep_category: 0, keep_approved: 1 });
    const made = await route('rules', 'POST', { action: 'add', rule });
    expect(made.status).toBe(200);
    const rows = (await listed()).transactions;
    const kept = find(rows, 't_costco');
    expect([kept.category_name, kept.category_by_rule, kept.review_suggestion]).toEqual([
      'general merchandise',
      undefined,
      { category_id: catId('travel'), by: 'rule', rule_id: made.body.rules.rules[0].id },
    ]);
    expect([find(rows, 't_costco2').category_name, find(rows, 't_costco2').category_by_rule]).toEqual(['travel', true]);
    // Taking the offer is approving it as it would be filed now.
    const whole = wholeById(rows);
    const accept = { ...approvalInputOf(whole.get('t_costco')), category_id: catId('travel') };
    expect((await route('review', 'POST', { action: 'approve', items: [accept] })).status).toBe(200);
    const taken = find((await listed()).transactions, 't_costco');
    expect([taken.category_name, taken.review_suggestion]).toEqual(['travel', undefined]);
  });

  test('a sync that brings the bank’s new category or name never moves an approved transaction: the category is offered, the name shown beside', async () => {
    await start(daysAgo(7));
    expect((await approveShown(['t_coffee'])).status).toBe(200);
    next = {
      added: [],
      modified: [plaidRow('t_coffee', { name: 'BLUE BOTTLE', merchant_name: 'Blue Bottle Coffee', amount: 5.25, date: daysAgo(5), personal_finance_category: { primary: 'GENERAL_MERCHANDISE', detailed: null } })],
      removed: [],
    };
    const coffee = find((await resync()).transactions, 't_coffee');
    expect([coffee.category_name, coffee.review_suggestion, coffee.needs_review]).toEqual(['food and drink', { category_id: catId('general merchandise'), by: 'bank' }, undefined]);
    expect([coffee.name, coffee.approved_name]).toEqual(['Blue Bottle Coffee', 'Blue Bottle']);
  });

  test('the bank’s new amount puts it back in the queue, saying from what; a split shows the difference as a part', async () => {
    await start(daysAgo(7));
    await listed();
    const parts = [
      { amount: 100, category_id: catId('food and drink') },
      { amount: 50, category_id: catId('home improvement') },
    ];
    expect((await route('transaction-splits', 'PUT', { transaction_id: 't_costco', parts })).status).toBe(200);
    expect((await approveShown(['t_costco'])).status).toBe(200);
    let split = (await listed()).transactions.filter((t) => t.split_of === 't_costco');
    expect(split.every((t) => t.reviewed_at && !t.needs_review)).toBe(true);
    next = { added: [], modified: [plaidRow('t_costco', { amount: 162.5 })], removed: [] };
    split = (await resync()).transactions.filter((t) => t.split_of === 't_costco');
    expect(split.map((t) => t.amount)).toEqual([100, 50, 12.5]);
    expect(split.every((t) => t.needs_review === true && t.review_changed?.amount === 150 && t.reviewed_at === undefined)).toBe(true);
    // One transaction to review, however many parts.
    expect(countToReview(split)).toBe(1);
  });

  test('a pending transaction approved, then posted with a new id: the same transaction, still approved; at another amount, back in the queue', async () => {
    await start(daysAgo(7));
    expect((await approveShown(['t_pending'])).status).toBe(200);
    expect(await approvalStore.get(ctx, 't_pending')).toMatchObject({ pending: true, amount: 40 });
    next = { added: [plaidRow('t_posted', { name: 'GAS STATION', merchant_name: 'Shell', amount: 40, date: daysAgo(1), pending_transaction_id: 't_pending', personal_finance_category: { primary: 'TRANSPORTATION', detailed: null } })], modified: [], removed: [{ transaction_id: 't_pending' }] };
    const rows = (await resync()).transactions;
    expect(find(rows, 't_posted')).toMatchObject({ reviewed_at: expect.any(String) });
    expect(find(rows, 't_posted').needs_review).toBeUndefined();
    // Moved to the posted one, once the sync saved the pending one's removal.
    expect(await approvalStore.has(ctx, 't_pending')).toBe(false);
    expect(await approvalStore.get(ctx, 't_posted')).toMatchObject({ pending: true, amount: 40 });

    // Another, posting with a tip.
    next = { added: [plaidRow('t_dinner_p', { name: 'DINER', merchant_name: 'Diner', amount: 30, pending: true, date: daysAgo(1) })], modified: [], removed: [] };
    await resync();
    expect((await approveShown(['t_dinner_p'])).status).toBe(200);
    next = { added: [plaidRow('t_dinner', { name: 'DINER', merchant_name: 'Diner', amount: 36, date: daysAgo(1), pending_transaction_id: 't_dinner_p' })], modified: [], removed: [{ transaction_id: 't_dinner_p' }] };
    const tipped = find((await resync()).transactions, 't_dinner');
    expect([tipped.needs_review, tipped.review_changed]).toEqual([true, { amount: 30, currency: 'USD' }]);
  });

  test('a new amount never takes the category it was approved under: one held against a rule, and a dinner recategorized while pending that posts with a tip', async () => {
    await start(daysAgo(7));
    // Held against a rule made later; then the bank adds a dollar.
    expect((await approveShown(['t_costco'])).status).toBe(200);
    const made = await route('rules', 'POST', { action: 'add', rule: { conditions: [{ field: 'name', op: 'contains', value: 'costco' }], actions: { set_category: catId('travel') } } });
    expect(made.status).toBe(200);
    next = { added: [], modified: [plaidRow('t_costco', { amount: 151 })], removed: [] };
    const costco = find((await resync()).transactions, 't_costco');
    expect([costco.category_name, costco.category_by_rule, costco.needs_review, costco.review_changed, costco.review_suggestion]).toEqual([
      'general merchandise',
      undefined,
      true,
      { amount: 150, currency: 'USD' },
      { category_id: catId('travel'), by: 'rule', rule_id: made.body.rules.rules[0].id },
    ]);
    // Card Mode on a pending charge: its category chosen, then approved as
    // filed now; it posts at 60 with its new id, in one sync.
    next = { added: [plaidRow('p_dinner', { name: 'SQ *NOPALITO', merchant_name: 'Nopalito', amount: 50, pending: true, date: daysAgo(1), personal_finance_category: { primary: 'GENERAL_MERCHANDISE', detailed: null } })], modified: [], removed: [] };
    await resync();
    expect((await route('recategorize', 'POST', { transaction_id: 'p_dinner', category_id: catId('food and drink') })).status).toBe(200);
    expect((await approveShown(['p_dinner'])).status).toBe(200);
    next = {
      added: [plaidRow('t_dinner', { name: 'SQ *NOPALITO', merchant_name: 'Nopalito', amount: 60, date: daysAgo(0), pending_transaction_id: 'p_dinner', personal_finance_category: { primary: 'GENERAL_MERCHANDISE', detailed: null } })],
      modified: [],
      removed: [{ transaction_id: 'p_dinner' }],
    };
    const dinner = find((await resync()).transactions, 't_dinner');
    expect([dinner.category_name, dinner.needs_review, dinner.review_changed, dinner.review_suggestion]).toEqual([
      'food and drink',
      true,
      { amount: 50, currency: 'USD' },
      { category_id: catId('general merchandise'), by: 'bank' },
    ]);
  });

  test('a rule’s preview counts only the approved ones it would really leave: not those under its own category, nor one approved with none', async () => {
    await start(daysAgo(7));
    const coffee = wholeById((await listed()).transactions).get('t_coffee');
    expect((await approveShown(['t_coffee'])).status).toBe(200);
    const rule = (set_category: string) => ({ conditions: [{ field: 'name', op: 'contains', value: 'blue bottle' }], actions: { set_category } });
    expect((await route('rules/preview', 'POST', { rule: rule(coffee.category_id) })).body).toMatchObject({ matches: 1, keep_approved: 0 });
    expect((await route('rules/preview', 'POST', { rule: rule(catId('travel')) })).body).toMatchObject({ matches: 1, keep_approved: 1 });
    // Approved with no category, the rule fills it: nothing is left.
    expect((await route('review', 'POST', { action: 'approve', items: [{ ...approvalInputOf(coffee), category_id: categories.uncategorized }] })).status).toBe(200);
    expect((await route('rules/preview', 'POST', { rule: rule(catId('travel')) })).body).toMatchObject({ matches: 1, keep_approved: 0 });
  });

  test('a recategorize updates the approval a row holds through another: its pending one’s, carried on to it', async () => {
    await start(daysAgo(7));
    expect((await approveShown(['t_pending'])).status).toBe(200);
    // Posted, the pending one still stored (a later sync removes it).
    next = { added: [plaidRow('t_post', { name: 'GAS STATION', merchant_name: 'Shell', amount: 40, date: daysAgo(1), pending_transaction_id: 't_pending', personal_finance_category: { primary: 'TRANSPORTATION', detailed: null } })], modified: [], removed: [] };
    const posted = find((await resync()).transactions, 't_post');
    expect([posted.review_via, typeof posted.reviewed_at]).toEqual(['t_pending', 'string']);
    expect((await route('recategorize', 'POST', { transaction_id: 't_post', category_id: catId('travel'), review_via: 't_pending' })).status).toBe(200);
    expect((await approvalStore.get(ctx, 't_pending'))!.category_id).toBe(catId('travel'));
    next = { added: [], modified: [], removed: [{ transaction_id: 't_pending' }] };
    await resync();
    expect((await approvalStore.get(ctx, 't_post'))!.category_id).toBe(catId('travel'));
    // Checked: an approval's id, never a part's, and never beside a restore.
    expect((await route('recategorize', 'POST', { transaction_id: 't_post', category_id: catId('travel'), review_via: 'split:x' })).status).toBe(400);
    expect((await route('recategorize', 'POST', { transaction_id: 't_post', restore: { category: null }, review_via: 't_pending' })).status).toBe(400);
  });

  test('the person’s own edit of a row from a file carries its approval: never back in the queue as if the bank had changed it', async () => {
    await start(daysAgo(7));
    expect((await approveShown([imported])).status).toBe(200);
    const edit = await route('manual-transactions', 'PATCH', { id: imported, account_id: MANUAL, amount: 46.5 });
    expect(edit.status).toBe(200);
    const row = wholeById((await listed()).transactions).get(imported);
    expect([row.amount, row.needs_review, row.review_changed, typeof row.reviewed_at]).toEqual([46.5, undefined, undefined, 'string']);
    expect(await approvalStore.get(ctx, imported)).toMatchObject({ amount: 46.5, currency: 'USD' });
  });

  test('approvals near the most kept: the queue says how many, and making room forgets the oldest, once confirmed', async () => {
    await start(daysAgo(7));
    expect((await route('review', 'GET')).body).toEqual({ review: { on: true, since: daysAgo(7) }, approvals: { kept: 0, max: 50_000, room: 10_000 } });
    expect((await approveShown(['t_costco'])).status).toBe(200);
    expect((await approveShown(['t_coffee'])).status).toBe(200);
    expect((await route('review', 'GET')).body.approvals.kept).toBe(2);
    expect((await route('review', 'POST', { action: 'make-room' })).status).toBe(400);
    const made = await route('review', 'POST', { action: 'make-room', confirm: true });
    expect([made.status, made.body.removed, typeof made.body.through]).toEqual([200, 2, 'string']);
    expect((await route('review', 'GET')).body.approvals.kept).toBe(0);
    // Their transactions stay, back in the queue.
    expect(find((await listed()).transactions, 't_coffee').needs_review).toBe(true);
  });

  test('a group’s transactions are approved each; the bank removing one takes its approval with it', async () => {
    await start(daysAgo(7));
    await listed();
    const grouped = await route('transaction-groups', 'POST', { name: 'Errands', category_id: catId('general merchandise'), members: ['t_costco', 't_coffee'] });
    expect(grouped.status).toBe(200);
    let rows = (await listed()).transactions;
    const group = rows.find((t) => t.group_members);
    expect(countToReview([group])).toBe(2);
    expect((await approveShown(['t_coffee'])).status).toBe(200);
    rows = (await listed()).transactions;
    expect(rows.find((t) => t.group_members).group_members.map((m: any) => [m.transaction_id, !!m.needs_review])).toEqual([
      ['t_coffee', false],
      ['t_costco', true],
    ]);
    next = { added: [], modified: [], removed: [{ transaction_id: 't_coffee' }] };
    await resync();
    expect(await approvalStore.has(ctx, 't_coffee')).toBe(false);
  });
});

describe('what can’t be read', () => {
  test('an approval that can’t be read: its review not known, never "needs review"; approving it refused; removed only once asked', async () => {
    await start(daysAgo(7));
    await fake.hset(ctxKey('transaction-approvals'), { t_costco: DAMAGED });
    const read = await quietly(listed);
    expect([find(read.transactions, 't_costco').needs_review, find(read.transactions, 't_costco').review_unknown]).toEqual([undefined, true]);
    expect(read.notes.some((n) => n.startsWith('Your approval of 1 transaction couldn’t be read'))).toBe(true);
    expect(read.review.unknown).toBe(1);
    const refused = await quietly(() => approveShown(['t_costco']));
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({ unreadable: true, unreadable_ids: ['t_costco'] });
    expect(fake.hashes.get(ctxKey('transaction-approvals'))!.get('t_costco')).toBe(DAMAGED);
    expect((await route('review', 'POST', { action: 'repair' })).status).toBe(400);
    expect(await route('review', 'POST', { action: 'repair', confirm: true })).toEqual({ status: 200, body: { removed: 1, settings: false, unrecognised: 0 } });
    expect(find((await listed()).transactions, 't_costco').needs_review).toBe(true);
  });

  test('settings that can’t be read mark nothing, say so, and are never saved over', async () => {
    await fake.set(ctxKey('review-settings'), DAMAGED);
    const read = await quietly(listed);
    expect(read.review).toEqual({ on: false, since: null, unread: true, unknown: 0 });
    expect(read.notes).toContain('Your review queue’s settings couldn’t be read, so nothing is marked to review until they can be.');
    expect(read.transactions.some((t) => t.needs_review)).toBe(false);
    expect((await quietly(() => route('review', 'GET'))).body).toMatchObject({ unreadable: true, repairable: true });
    expect((await quietly(start)).status).toBe(409);
    expect(fake.strings.get(ctxKey('review-settings'))).toBe(DAMAGED);
  });
});

describe('a merchant’s default', () => {
  const recat = (id: string, category: string, today = TODAY) =>
    route('recategorize', 'POST', { transaction_id: id, category_id: catId(category), vendor_key: 'nm:chase::costco', name: 'Costco', today });

  test('set when two of the last three agree; it files the merchant’s new transactions, under rules and the person’s own', async () => {
    await listed();
    next = { added: [plaidRow('t_costco2', { amount: 80, date: daysAgo(2) })], modified: [], removed: [] };
    await resync();
    const one = await recat('t_costco', 'food and drink');
    expect(one.status).toBe(200);
    expect(one.body).toMatchObject({ success: true, previous: { category: null }, vendor: { changed: false, previous: null } });
    const two = await recat('t_costco2', 'food and drink');
    expect(two.body.vendor).toMatchObject({ changed: true, entry: { default: { category_id: catId('food and drink'), since: TODAY } } });
    // A new Costco transaction today: filed by the default, and said so.
    next = { added: [plaidRow('t_costco3', { amount: 20, date: TODAY })], modified: [], removed: [] };
    let rows = (await resync()).transactions;
    expect([find(rows, 't_costco3').category_name, find(rows, 't_costco3').filed_by_default]).toEqual(['food and drink', { id: two.body.vendor.entry.id, agree: 2 }]);
    // The Defaults list.
    expect((await route('vendor-defaults', 'GET')).body.defaults).toEqual([
      { id: two.body.vendor.entry.id, name: 'Costco', category_id: catId('food and drink'), since: TODAY, agree: 2, set_at: two.body.vendor.entry.default.set_at },
    ]);
    // A rule beats it; the person's own beats both.
    const made = await route('rules', 'POST', { action: 'add', rule: { conditions: [{ field: 'name', op: 'equals', value: 'costco' }, { field: 'amount', op: 'lt', value: 25 }], actions: { set_category: catId('travel') } } });
    expect(made.status).toBe(200);
    rows = (await listed()).transactions;
    expect([find(rows, 't_costco3').category_name, find(rows, 't_costco3').filed_by_default]).toEqual(['travel', undefined]);
    expect((await route('recategorize', 'POST', { transaction_id: 't_costco3', category_id: catId('transportation') })).status).toBe(200);
    expect(find((await listed()).transactions, 't_costco3').category_name).toBe('transportation');
    // Cleared: it files nothing, and its categorizations are forgotten.
    expect((await route('vendor-defaults', 'DELETE', { id: two.body.vendor.entry.id })).status).toBe(200);
    expect((await route('vendor-defaults', 'DELETE', { id: two.body.vendor.entry.id })).status).toBe(404);
    expect((await vendorDefaultsStore.get(ctx))!.vendors).toEqual([]);
  });

  test('an approved transaction stays where it was approved when a default forms, offered it', async () => {
    await start(daysAgo(7));
    await listed();
    next = { added: [plaidRow('t_costco2', { amount: 80, date: daysAgo(2) }), plaidRow('t_costco4', { amount: 70, date: daysAgo(1) })], modified: [], removed: [] };
    await resync();
    expect((await approveShown(['t_costco4'])).status).toBe(200);
    // The default's day is set back a week, so it reaches the approved one.
    await recat('t_costco', 'food and drink', daysAgo(0));
    await recat('t_costco2', 'food and drink', daysAgo(0));
    const state = (await vendorDefaultsStore.get(ctx))!;
    await vendorDefaultsStore.set(ctx, { ...state, vendors: state.vendors.map((e) => ({ ...e, default: { ...e.default!, since: daysAgo(7) } })) });
    const kept = find((await listed()).transactions, 't_costco4');
    expect([kept.category_name, kept.filed_by_default, kept.review_suggestion]).toEqual(['general merchandise', undefined, { category_id: catId('food and drink'), by: 'default' }]);
  });

  test('Card Mode’s undo puts the category and the merchant’s categorizations back exactly', async () => {
    await listed();
    // Chosen once by hand before: an override to put back.
    await route('recategorize', 'POST', { transaction_id: 't_coffee', category_id: catId('general merchandise') });
    const changed = await route('recategorize', 'POST', { transaction_id: 't_coffee', category_id: catId('travel'), vendor_key: 'nm:chase::blue bottle', name: 'Blue Bottle', today: TODAY });
    expect(changed.body.previous).toEqual({ category: 'general merchandise' });
    expect((await route('recategorize', 'POST', { transaction_id: 't_coffee', restore: changed.body.previous })).status).toBe(200);
    expect(find((await listed()).transactions, 't_coffee').category_name).toBe('general merchandise');
    expect((await route('vendor-defaults', 'POST', { action: 'restore', after: changed.body.vendor.entry, previous: changed.body.vendor.previous })).body).toEqual({ restored: true });
    expect((await vendorDefaultsStore.get(ctx))!.vendors).toEqual([]);
    // None before: the person's choice comes off, and the bank's shows again.
    const fresh = await route('recategorize', 'POST', { transaction_id: 't_costco', category_id: catId('travel') });
    expect(fresh.body.previous).toEqual({ category: null });
    expect((await route('recategorize', 'POST', { transaction_id: 't_costco', restore: { category: null } })).status).toBe(200);
    expect(find((await listed()).transactions, 't_costco').category_name).toBe('general merchandise');
    // A manual row's own category, put back on the row.
    const manual = await route('recategorize', 'POST', { transaction_id: imported, account_id: MANUAL, category_id: catId('travel') });
    expect(manual.body.previous).toEqual({ category: null });
    expect((await route('recategorize', 'POST', { transaction_id: imported, account_id: MANUAL, restore: { category: null } })).status).toBe(200);
    expect(find((await listed()).transactions, imported).category).toBeNull();
    // An undo says only what to put back.
    expect((await route('recategorize', 'POST', { transaction_id: 't_costco', restore: { category: 'x', extra: 1 } })).status).toBe(400);
    expect((await route('recategorize', 'POST', { transaction_id: 't_costco', category_id: catId('travel'), restore: { category: null } })).status).toBe(400);
    expect((await route('recategorize', 'POST', { transaction_id: 't_costco', category_id: catId('travel'), vendor_key: 'costco' })).status).toBe(400);
  });

  test('its category can’t be deleted while it is one; merged, the default follows it', async () => {
    await listed();
    const made = await route('categories', 'POST', { action: 'add-category', name: 'Warehouse', group: categories.categories.find((c: any) => c.name === 'general merchandise').group });
    expect(made.status).toBe(200);
    categories = made.body.categories;
    await recat('t_costco', 'Warehouse');
    await recat('t_costco', 'Warehouse');
    // Moved off it: two of the last three still agree, so the default stays.
    await recat('t_costco', 'travel');
    expect((await vendorDefaultsStore.get(ctx))!.vendors[0].default!.category_id).toBe(catId('Warehouse'));
    const refused = await route('categories', 'POST', { action: 'delete-category', id: catId('Warehouse') });
    expect(refused.status).toBe(409);
    expect(refused.body.error).toBe("Warehouse is used by the default for 1 merchant, so it can't be deleted. Clear that default under Defaults first, or merge it into another category.");
    const merged = await route('categories', 'POST', { action: 'merge', id: catId('Warehouse'), into: catId('general merchandise') });
    expect(merged.status).toBe(200);
    expect((await route('vendor-defaults', 'GET')).body.defaults[0].category_id).toBe(categories.categories.find((c: any) => c.name === 'general merchandise').id);
  });
});

describe('everywhere else', () => {
  test('the read-only API: needs_review and reviewed_at on every transaction', async () => {
    await start(daysAgo(7));
    await listed();
    expect((await approveShown(['t_costco'])).status).toBe(200);
    const page = await queryTransactions(ctx, { from: daysAgo(30), to: TODAY, limit: 50 } as any);
    const byId = new Map(page.transactions.map((t) => [t.id, t]));
    expect([byId.get('t_costco')!.needs_review, typeof byId.get('t_costco')!.reviewed_at]).toEqual([false, 'string']);
    expect([byId.get('t_coffee')!.needs_review, byId.get('t_coffee')!.reviewed_at]).toEqual([true, null]);
    expect(byId.get(typed)!.needs_review).toBe(false);
  });

  test('the download: both stores in the file, and an approved transaction filed in the CSV as the app files it', async () => {
    await start(daysAgo(7));
    await listed();
    expect((await approveShown(['t_costco'])).status).toBe(200);
    await route('rules', 'POST', { action: 'add', rule: { conditions: [{ field: 'name', op: 'contains', value: 'costco' }], actions: { set_category: catId('travel') } } });
    await route('recategorize', 'POST', { transaction_id: 't_coffee', category_id: catId('travel'), vendor_key: 'nm:chase::blue bottle', name: 'Blue Bottle', today: TODAY });
    const doc: any = buildUserExport(await collectUserData({ ctx, userId: null }), new Date());
    expect(doc['transaction-approvals'].map((e: any) => e.id)).toEqual(['t_costco']);
    expect(doc['review-settings']).toMatchObject({ on: true, since: daysAgo(7) });
    expect(doc['vendor-defaults'].vendors[0]).toMatchObject({ vendor_key: 'nm:chase::blue bottle', votes: [{ category_id: catId('travel') }] });
    const csv = [...transactionsCsv(doc)].join('');
    const lines = csv.replace(/^﻿/, '').split('\r\n');
    const header = lines[0].split(',');
    const costco = lines.find((l) => l.includes(',t_costco,'))!.split(',');
    expect(costco[header.indexOf('nya_category')]).toBe('general merchandise');
  });

  test('the routes check what they are told, and one container never sees another’s', async () => {
    const bad = (body: unknown, raw?: string) => route('review', 'POST', body, raw);
    expect((await bad({ action: 'nope' })).status).toBe(400);
    expect((await bad({ action: 'stop', since: TODAY })).status).toBe(400);
    expect((await bad({ action: 'start', today: TODAY, since: daysAgo(40) })).status).toBe(400);
    expect((await bad({ action: 'start', today: TODAY, since: 'soon' })).status).toBe(400);
    expect((await bad({ action: 'approve', items: [{ transaction_id: 't_costco' }] })).status).toBe(400);
    expect((await bad({ action: 'approve', items: [{ ...approvalInputOf({ transaction_id: 'split:p1', amount: 1, iso_currency_code: 'USD', unofficial_currency_code: null, category_id: undefined, name: 'x', pending: false }) }] })).status).toBe(400);
    expect((await bad({ action: 'undo', items: [{ transaction_id: 't_costco', approved_at: 'then', previous: null }] })).status).toBe(400);
    expect((await bad(undefined, '{not json')).status).toBe(400);
    expect((await bad(undefined, JSON.stringify({ action: 'approve', items: [], pad: 'x'.repeat(300_000) }))).status).toBe(413);
    expect((await route('vendor-defaults', 'DELETE', { id: 'has space' })).status).toBe(400);
    expect((await route('vendor-defaults', 'POST', { action: 'restore', after: { id: 'x' }, previous: null })).status).toBe(400);
    expect(await approvalStore.count(ctx)).toBe(0);

    await start(daysAgo(7));
    await listed();
    expect((await approveShown(['t_costco'])).status).toBe(200);
    expect(await approvalStore.count(OTHER)).toBe(0);
    expect((await (await import('@/lib/review-store')).readReviewSettings(OTHER)).settings).toBeNull();
  });
});
