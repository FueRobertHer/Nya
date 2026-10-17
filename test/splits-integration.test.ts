import { describe, expect, test, mock, beforeEach, afterEach } from 'bun:test';
import './clerk-mock';
import { FakeRedis, storageMock, ctxKey, registerTestContainer, unscopedDataKeys } from './fake-redis';

// Splits and groups (#39) where they meet what landed beside them:
//   - accounts that end (#50): a split transaction, or a group's transaction,
//     on an account dated from its end is left out like any row there, parts
//     and nets alike, in the Activity tab, the read-only API and a report; a
//     group with one there nets only those still counting, and says so;
//   - goals (#42): an account's contributions count a split transaction once,
//     and a group's transactions each on its own account at its own amount,
//     never the group's net on one of them;
//   - budget rollover (#37): carries and the income pool count parts by their
//     categories and a group's net in its category, a past month agrees with
//     the Activity tab, and splitting or grouping in a past month changes the
//     carry at once.

process.env.PLAID_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');

// Nothing here may reach Plaid: everything is read from what is stored.
const plaidTouched: string[] = [];
mock.module('@/lib/plaid', () => ({
  plaidClient: new Proxy(
    {},
    {
      get(_target, prop) {
        if (typeof prop === 'string') plaidTouched.push(prop);
        return async () => {
          throw new Error('Plaid must not be called');
        };
      },
    }
  ),
}));

const fake = new FakeRedis({ deserialize: true });
mock.module('@/lib/storage', () => storageMock(fake));
afterEach(() => {
  expect(unscopedDataKeys(fake)).toEqual([]);
  expect(plaidTouched).toEqual([]);
});

const { ctx, txn } = await import('./api-fixture');
const { encrypt } = await import('@/lib/crypto');
const { encodeJsonBlob } = await import('@/lib/blob');
const { saveItem } = await import('@/lib/storage');
const { forgetEpochs } = await import('@/lib/sessions');
const { syncsStore } = await import('@/lib/connection-records');
const { rememberAccounts } = await import('@/lib/last-known');
const { markEnded } = await import('@/lib/lifecycle');
const { ensureTaxonomy } = await import('@/lib/category-store');
const { splitStore } = await import('@/lib/splits');
const { groupStore } = await import('@/lib/groups');
const { assembleBankRows, finishActivity } = await import('@/lib/activity');
const { summarize, spendingByCategory } = await import('@/lib/totals');
const { totalsCurrency } = await import('@/lib/spending');
const { filedId, indexTaxonomy } = await import('@/lib/categories');
const { readSpending, readBudgets } = await import('@/lib/api-read');
const { readReport } = await import('@/lib/report/read');
const { resolvePeriod } = await import('@/lib/report/period');
const { addMonths } = await import('@/lib/rollover');
const { setBudgets } = await import('@/lib/budgets');
const { trailingMonths } = await import('@/lib/goal-projection');
const { entryNotice } = await import('@/components/SplitRows');
const budgetsRoute = await import('@/app/api/budgets/route');
const monthRoute = await import('@/app/api/budgets/month/route');
const rolloverRoute = await import('@/app/api/budgets/rollover/route');
const splitsRoute = await import('@/app/api/transaction-splits/route');
const groupsRoute = await import('@/app/api/transaction-groups/route');
const progressRoute = await import('@/app/api/goals/progress/route');
type Taxonomy = import('@/lib/categories').Taxonomy;

const NOW = new Date().toISOString().slice(0, 7);
const M = (n: number) => addMonths(NOW, n);
const on = (n: number, day = 10) => `${M(n)}-${String(day).padStart(2, '0')}`;
const lastDay = (m: string) => new Date(Date.UTC(Number(m.slice(0, 4)), Number(m.slice(5, 7)), 0)).toISOString().slice(0, 10);
const at = new Date().toISOString();

beforeEach(async () => {
  fake.reset();
  forgetEpochs();
  delete process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;
  delete process.env.CLERK_SECRET_KEY;
  delete process.env.CONTAINER_ID;
  await registerTestContainer(fake);
  plaidTouched.length = 0;
});

const ACCOUNTS = {
  acc_chk: { name: 'Checking', official_name: null, type: 'depository', subtype: 'checking', mask: '1111', balances: null },
  acc_sav: { name: 'Savings', official_name: null, type: 'depository', subtype: 'savings', mask: '3333', balances: null },
  acc_card: { name: 'Card', official_name: null, type: 'credit', subtype: 'credit card', mask: '2222', balances: null },
};

/** Chase: checking, savings and a card, as a sync leaves them and as the
 *  dashboard recorded them. */
async function seed(rows: ReturnType<typeof txn>[]) {
  await saveItem(ctx, { item_id: 'item_bank', institution_name: 'Chase', encrypted_access_token: await encrypt('access-sandbox-x') });
  await fake.set(
    ctxKey('txns:item_bank'),
    await encodeJsonBlob({ schema_version: 2, cursor: 'c1', accounts: ACCOUNTS, txns: Object.fromEntries(rows.map((t) => [t.transaction_id, t])), synced_at: at })
  );
  await syncsStore.set(ctx, 'item_bank', { at });
  await rememberAccounts(ctx, [
    { item_id: 'item_bank', accounts: Object.entries(ACCOUNTS).map(([account_id, a]) => ({ account_id, name: a.name, mask: a.mask, type: a.type })), error: null },
  ]);
  await fake.hset(ctxKey('accounts:meta'), {
    item_bank: await encrypt(
      JSON.stringify(Object.entries(ACCOUNTS).map(([account_id, a]) => ({ account_id, name: a.name, official_name: null, type: a.type, subtype: a.subtype, mask: a.mask, limit: null, currency: 'USD' })))
    ),
  });
}
const row = (id: string, account_id: keyof typeof ACCOUNTS, date: string, amount: number, category: string, over: Record<string, unknown> = {}) =>
  txn(id, account_id, 1, amount, { date, category, institution_name: 'Chase', account_name: ACCOUNTS[account_id].name, ...over });

let taxonomy: Taxonomy;
const cat = (name: string) => taxonomy.categories.find((c) => c.name === name)!.id;
const split = (id: string, amount: number, parts: [string, number][]) =>
  splitStore.set(ctx, id, { version: 1, amount, currency: 'USD', parts: parts.map(([c, a], i) => ({ id: `${id}-p${i}`, amount: a, category_id: cat(c) })), updated_at: at });
const group = (id: string, name: string, category: string, members: string[], date: string) =>
  groupStore.set(ctx, id, { version: 1, name, category_id: cat(category), members, date, currency: 'USD', created_at: at, updated_at: at });

/** The Activity tab's rows, as its route finishes them (without syncing). */
async function activityRows() {
  const bank = await assembleBankRows(ctx, { sync: false, readOnly: true });
  return (await finishActivity(ctx, bank.payload, bank.hidden)).transactions;
}

describe('accounts that end (#50)', () => {
  const L = M(-1);
  const d = (day: number) => `${L}-${String(day).padStart(2, '0')}`;
  const CARD = { type: 'credit', label: { name: 'Card', institution: 'Chase', mask: '2222' }, item_id: 'item_bank' };

  /** The card closed on the 10th of last month: a dinner on it before, and a
   *  shop split and a late lunch grouped with its payback after. */
  async function endedCard() {
    await seed([
      row('pay', 'acc_chk', d(2), -1000, 'income'),
      row('dinner', 'acc_card', d(5), 120, 'food and drink'),
      row('payback', 'acc_chk', d(12), -60, 'transfer in'),
      row('shop', 'acc_card', d(12), 90, 'general merchandise'),
      row('late', 'acc_card', d(14), 40, 'food and drink'),
      row('back', 'acc_chk', d(15), -20, 'transfer in'),
    ]);
    taxonomy = await ensureTaxonomy(ctx);
    await split('shop', 90, [
      ['food and drink', 60],
      ['home improvement', 30],
    ]);
    await group('g-dinner', 'Dinner with Sam', 'food and drink', ['dinner', 'payback'], d(5));
    await group('g-late', 'Late lunch', 'food and drink', ['late', 'back'], d(14));
    await markEnded(ctx, 'acc_card', { state: 'closed', on: d(10) }, CARD);
  }

  test('the Activity tab leaves out a split transaction and a group’s transaction dated from the end; the group nets what still counts, and says why one is missing', async () => {
    await endedCard();
    const rows = await activityRows();
    expect(rows.some((t) => t.split_of === 'shop' || t.transaction_id === 'shop')).toBe(false);
    const late = rows.find((t) => t.group_id === 'g-late' && t.group_members)!;
    expect(late).toMatchObject({ amount: -20, group_missing: 1 });
    expect(late.group_members!.map((t) => t.transaction_id)).toEqual(['back']);
    expect(entryNotice(late as any)).toBe(
      '1 of its transactions isn’t here (the bank removed it, its account is hidden or ended, or it couldn’t be loaded), so it isn’t counted.'
    );
    // The dinner, before the end, still nets with its payback.
    expect(rows.find((t) => t.group_id === 'g-dinner' && t.group_members)).toMatchObject({ amount: 60 });
  });

  test('a report on the month, the API and the Activity tab agree, and the report counts what it leaves out once per transaction', async () => {
    await endedCard();
    const p = resolvePeriod({ kind: 'range', start: d(1), end: lastDay(L) }, 'UTC', Date.now());
    if ('error' in p) throw new Error(p.error);
    const report = await readReport(ctx, p, { currency: 'USD' });
    const tab = summarize(await activityRows(), (day) => day >= p.start && day <= p.through, 'USD');
    // 1000 in; out, the dinner's net of 60, and in, the late lunch's payback of 20.
    expect([tab.money_in, tab.money_out]).toEqual([1000 + 20, 60]);
    expect([report.totals.money_in, report.totals.money_out, report.totals.transactions, report.totals.counted]).toEqual([tab.money_in, tab.money_out, tab.transactions, tab.counted]);
    const api = await readSpending(ctx, { from: p.start, to: p.through, currency: 'USD' });
    expect([api.money_in, api.money_out, api.counted]).toEqual([tab.money_in, tab.money_out, tab.counted]);
    // The shop, split in two, and the late lunch: two transactions left out.
    expect(report.ended.find((e) => e.account === 'Card ••2222' || e.account.includes('Card'))).toMatchObject({ not_counted: 2 });
  });
});

describe('goals (#42): what went into each account', () => {
  const [M1, M2, M3] = trailingMonths(NOW);

  test('a split deposit counts once, and a group’s transactions each on its own account at its own amount, never the group’s net', async () => {
    await seed([
      row('first', 'acc_chk', `${M1}-01`, -1, 'transfer in'),
      row('first-sav', 'acc_sav', `${M1}-01`, -1, 'transfer in'),
      // Savings: 300 in, split by the person into two kinds of money in.
      row('deposit', 'acc_sav', `${M1}-05`, -300, 'transfer in'),
      // A dinner on the card, and the payback into checking, grouped.
      row('dinner', 'acc_card', `${M2}-04`, 120, 'food and drink'),
      row('payback', 'acc_chk', `${M2}-06`, -60, 'transfer in'),
      row('rent', 'acc_chk', `${M3}-01`, 500, 'rent and utilities'),
    ]);
    taxonomy = await ensureTaxonomy(ctx);
    const read = async () => {
      const res: Response = await progressRoute.GET(new Request(`http://x/api/goals/progress?month=${NOW}`));
      expect(res.status).toBe(200);
      return (await res.json()) as any;
    };
    const before = await read();
    await split('deposit', -300, [
      ['transfer in', -200],
      ['income', -100],
    ]);
    await group('g-dinner', 'Dinner with Sam', 'food and drink', ['dinner', 'payback'], `${M2}-04`);
    const after = await read();
    expect(after.flows).toEqual(before.flows);
    expect(after.flows.acc_sav.months.find((m: any) => m.month === M1)).toMatchObject({ amount: 301 });
    // The payback went into checking, whatever the group nets on the card.
    expect(after.flows.acc_chk.months.find((m: any) => m.month === M2)).toMatchObject({ amount: 60 });
    expect(after.flows.acc_card).toBeUndefined();
  });
});

describe('budget rollover (#37)', () => {
  const call = async (res: Response | Promise<Response>) => {
    const r = await res;
    return { status: r.status, body: (await r.json()) as any };
  };
  const month = (m = NOW, today = NOW, extra = '') => call(monthRoute.GET(new Request(`http://x/api/budgets/month?month=${m}&today=${today}${extra}`)));
  const post = (body: unknown) => call(rolloverRoute.POST(new Request('http://x/api/budgets/rollover', { method: 'POST', body: JSON.stringify(body) })));
  const send = (route: any, method: string, body: unknown) => call(route[method](new Request('http://x', { method, body: JSON.stringify(body) })));

  test('a split and a group in a past month change the carry and the pool at once, by their categories, as the Activity tab counts the month', async () => {
    await setBudgets(ctx, { 'food and drink': 100 });
    await seed([
      row('pay', 'acc_chk', on(-1, 1), -1000, 'income'),
      row('lunch', 'acc_chk', on(-1, 3), 70, 'food and drink'),
      row('dinner', 'acc_chk', on(-1, 5), 20, 'food and drink'),
      row('payback', 'acc_chk', on(-1, 6), -10, 'transfer in'),
    ]);
    taxonomy = (await call(budgetsRoute.GET())).body.categories;
    const food = cat('food and drink');
    expect((await post({ action: 'rollover', kind: 'category', id: food, on: true, from: M(-1), month: NOW })).status).toBe(200);
    expect((await post({ action: 'income', enabled: true, start: M(-1), month: NOW })).status).toBe(200);
    const before = (await month()).body;
    // 100 less 90; 1000 in, 90 out (the payback is a transfer, counted as neither).
    expect(before.carries.categories[food].carry).toBe(10);
    expect(before.pool.available).toBe(910);

    // Twenty of the lunch was a book.
    const lunch = await send(splitsRoute, 'PUT', {
      transaction_id: 'lunch',
      parts: [
        { amount: 50, category_id: food },
        { amount: 20, category_id: cat('entertainment') },
      ],
    });
    expect(lunch.status).toBe(200);
    expect((await month()).body.carries.categories[food].carry).toBe(30);
    // The dinner and what was paid back for it, grouped under food: 10 net.
    const dinner = await send(groupsRoute, 'POST', { name: 'Dinner', category_id: food, members: ['dinner', 'payback'] });
    expect(dinner.status).toBe(200);
    const after = (await month()).body;
    expect(after.carries.categories[food].carry).toBe(40);
    // 1000 in; out, the lunch's 70 and the dinner's net of 10.
    expect(after.pool.available).toBe(920);

    // The past month as the view, the API and the Activity tab count it.
    const rows = await activityRows();
    const ix = indexTaxonomy(taxonomy);
    const currency = totalsCurrency(rows);
    const tab = spendingByCategory(rows, (day) => day.slice(0, 7) === M(-1), currency, (r) => filedId(ix, r));
    const view = (await month(M(-1))).body;
    const api = (await readBudgets(ctx, { month: M(-1) })).budgets.find((b) => b.category_id === food)!;
    expect([view.spent[food], api.spent, tab[food]]).toEqual([60, 60, 60]);
    expect(view.spent[cat('entertainment')]).toBe(20);
    const flows = summarize(rows, (day) => day.slice(0, 7) === M(-1), currency);
    expect([flows.money_in, flows.money_out]).toEqual([1000, 80]);
  });
});
