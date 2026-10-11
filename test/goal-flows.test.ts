import { describe, expect, test, mock, beforeEach, afterEach } from 'bun:test';
import './clerk-mock';
import { FakeRedis, storageMock, ctxKey, TEST_CTX, registerTestContainer, unscopedDataKeys } from './fake-redis';

// The months behind a goal's pace (#42), read from stored data through the
// Activity tab's own assembly: what went into each account, transfers in
// counted and interest apart, from transactions where Nya has them and from
// the recorded balance where it doesn't, never an estimate, with what may be
// missing said. Plaid is never asked.

process.env.PLAID_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');

const plaidTouched: string[] = [];
mock.module('@/lib/plaid', () => ({
  plaidClient: new Proxy(
    {},
    {
      get(_target, prop) {
        if (typeof prop === 'string') plaidTouched.push(prop);
        return async () => {
          throw new Error('Plaid must not be called for goals');
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

const { encrypt } = await import('@/lib/crypto');
const { encodeJsonBlob } = await import('@/lib/blob');
const { saveItem } = await import('@/lib/storage');
const { saveManualAccount } = await import('@/lib/manual');
const { setAccountHidden } = await import('@/lib/hidden');
const { manualTxnStore } = await import('@/lib/manual-txns');
const { noticesStore, syncsStore } = await import('@/lib/connection-records');
const links = await import('@/lib/links');
const { txn } = await import('./api-fixture');
const { trailingMonths, addMonths } = await import('@/lib/goal-projection');
const route = await import('@/app/api/goals/progress/route');

const ctx = TEST_CTX;
const OTHER = { container: '9c1d2e3f-4a5b-4c6d-8e7f-0a1b2c3d4e5f' } as typeof TEST_CTX;
const THIS_MONTH = new Date().toISOString().slice(0, 7);
const [M1, M2, M3] = trailingMonths(THIS_MONTH);
const PRIOR = addMonths(M1, -1);
const lastDayOf = (m: string) => new Date(Date.UTC(Number(m.slice(0, 4)), Number(m.slice(5, 7)), 0)).toISOString().slice(0, 10);

const remembered = (accounts: Record<string, unknown>[]) =>
  encrypt(JSON.stringify(accounts.map((a) => ({ official_name: null, subtype: null, mask: null, limit: null, currency: 'USD', ...a }))));
const row = (id: string, account_id: string, date: string, amount: number, over: Record<string, unknown> = {}) =>
  txn(id, account_id, 0, amount, { date, institution_name: 'Chase', account_name: account_id, ...over });
const blob = (rows: ReturnType<typeof row>[]) =>
  encodeJsonBlob({ schema_version: 2, cursor: 'c', accounts: {}, txns: Object.fromEntries(rows.map((t) => [t.transaction_id, t])), synced_at: new Date().toISOString() });

beforeEach(async () => {
  fake.reset();
  plaidTouched.length = 0;
  (await import('@/lib/sessions')).forgetEpochs();
  await registerTestContainer(fake);
  await saveItem(ctx, { item_id: 'item_chase', institution_name: 'Chase', encrypted_access_token: await encrypt('access-sandbox-chase') });
  await saveItem(ctx, { item_id: 'item_broker', institution_name: 'Broker', encrypted_access_token: await encrypt('access-sandbox-broker'), transactions_billed: false });
  await fake.hset(ctxKey('accounts:meta'), {
    item_chase: await remembered([
      { account_id: 'acc_sav', name: 'Savings', type: 'depository', subtype: 'savings' },
      { account_id: 'acc_quiet', name: 'Quiet savings', type: 'depository', subtype: 'savings' },
      { account_id: 'acc_card', name: 'Card', type: 'credit' },
      { account_id: 'acc_hid', name: 'Hidden savings', type: 'depository' },
    ]),
    item_broker: await remembered([{ account_id: 'acc_ira', name: 'IRA', type: 'investment', subtype: 'ira' }]),
  });
  // Savings, with cents: a transfer in each month, a withdrawal, interest,
  // a pending deposit and this month's transfer, neither counted.
  await fake.set(
    ctxKey('txns:item_chase'),
    await blob([
      row('t_first', 'acc_sav', `${PRIOR}-02`, -1),
      row('t1', 'acc_sav', `${M1}-03`, -250, { category: 'transfer in', transaction_code: 'transfer' }),
      row('t2', 'acc_sav', `${M1}-15`, -125.5, { category: 'income' }),
      row('i1', 'acc_sav', `${M1}-28`, -1.23, { category: 'income', personal_finance_category: { primary: 'INCOME', detailed: 'INCOME_INTEREST_EARNED', confidence_level: 'HIGH' } }),
      row('t3', 'acc_sav', `${M2}-03`, -250, { category: 'transfer in', transaction_code: 'transfer' }),
      row('t4', 'acc_sav', `${M2}-20`, 60.25, { category: 'transfer out' }),
      row('t5', 'acc_sav', `${M3}-03`, -250, { category: 'transfer in', transaction_code: 'transfer' }),
      row('t6', 'acc_sav', `${M3}-18`, -80.1),
      row('t_pending', 'acc_sav', `${M3}-27`, -999, { pending: true }),
      row('t_now', 'acc_sav', `${THIS_MONTH}-01`, -250),
      row('t_card', 'acc_card', `${M2}-04`, 45),
      row('t_hid', 'acc_hid', `${M2}-04`, -77),
    ])
  );
  await setAccountHidden(ctx, 'acc_hid', 'depository', true);
  // The IRA brings no transactions: its recorded balances at each month's end,
  // and one in the middle of a month, which ends nothing.
  const map = (m: Record<string, number>) => encrypt(JSON.stringify(m));
  await fake.hset(ctxKey('history:accounts'), {
    [lastDayOf(PRIOR)]: await map({ acc_ira: 20_000, acc_sav: 9000, acc_quiet: 500 }),
    [lastDayOf(M1)]: await map({ acc_ira: 20_350.5, acc_sav: 9375.5, acc_quiet: 500 }),
    [`${M2}-10`]: await map({ acc_ira: 99_999 }),
    [lastDayOf(M2)]: await map({ acc_ira: 20_600.25, acc_sav: 9565.25, acc_quiet: 500 }),
    [lastDayOf(M3)]: await map({ acc_ira: 20_949.75, acc_sav: 9895.35, acc_quiet: 500 }),
  });
  await fake.hset(ctxKey('history:accounts:est'), { [lastDayOf(M2)]: await map({ acc_ira: 12_345 }) });
  const at = new Date().toISOString();
  await saveManualAccount(ctx, { account_id: 'manual_jar', name: 'Jar', institution_name: 'Home', type: 'depository', subtype: null, balance: 340.25, updated_at: at });
  await saveManualAccount(ctx, { account_id: 'manual_tin', name: 'Tin', institution_name: 'Home', type: 'depository', subtype: null, balance: 90, updated_at: at });
  await manualTxnStore.set(ctx, 'manual_jar', {
    version: 1,
    rows: [`${M2}-09`, `${M3}-09`].map((date, i) => ({
      id: `manual-txn:5a0c1d2e-3f40-4a5b-8c6d-7e8f9a0b1c2${i}`,
      account_id: 'manual_jar',
      date,
      amount: -20.25,
      currency: 'USD',
      name: 'Coins',
      category: null,
      note: null,
      source: 'manual',
      source_id: null,
      created_at: at,
      updated_at: at,
    })),
  });
});

const progress = async (query = `month=${THIS_MONTH}`) => {
  const res: Response = await route.GET(new Request(`http://x/api/goals/progress?${query}`));
  return { status: res.status, body: (await res.json()) as any };
};

describe('the months behind each account’s pace', () => {
  test('transactions: the net money in each complete month, to the cent, transfers in counted, interest apart', async () => {
    const { status, body } = await progress();
    expect(status).toBe(200);
    expect(body.months).toEqual([M1, M2, M3]);
    expect(body.flows.acc_sav).toEqual({
      source: 'transactions',
      months: [
        { month: M1, amount: 375.5, growth: 1.23 },
        { month: M2, amount: 189.75 },
        { month: M3, amount: 330.1 },
      ],
    });
  });

  test('a quiet account at a bank that brings transactions in: nothing went in, which is known', async () => {
    expect((await progress()).body.flows.acc_quiet).toEqual({
      source: 'transactions',
      months: [
        { month: M1, amount: 0 },
        { month: M2, amount: 0 },
        { month: M3, amount: 0 },
      ],
    });
  });

  test('an account whose rows Nya doesn’t have: the change in its recorded balance at each month’s end, never an estimate', async () => {
    expect((await progress()).body.flows.acc_ira).toEqual({
      source: 'balances',
      months: [
        { month: M1, amount: 350.5 },
        { month: M2, amount: 249.75 },
        { month: M3, amount: 349.5 },
      ],
    });
  });

  test('a manual account: its own rows when it has some; its balance history when it has none (unknown here)', async () => {
    const { flows } = (await progress()).body;
    expect(flows.manual_jar).toEqual({
      source: 'transactions',
      months: [
        { month: M1, amount: null },
        { month: M2, amount: 20.25, gaps: [{ kind: 'begins', on: `${M2}-09` }] },
        { month: M3, amount: 20.25 },
      ],
    });
    expect(flows.manual_tin).toEqual({
      source: 'balances',
      months: [
        { month: M1, amount: null },
        { month: M2, amount: null },
        { month: M3, amount: null },
      ],
    });
  });

  test('no card or loan, and no hidden account', async () => {
    const { flows } = (await progress()).body;
    expect(flows.acc_card).toBeUndefined();
    expect(flows.acc_hid).toBeUndefined();
  });

  test('a connection that stopped syncing marks the months it may be missing', async () => {
    const lastOk = `${M2}-15T12:00:00.000Z`;
    await syncsStore.set(ctx, 'item_chase', { at: lastOk });
    await noticesStore.set(ctx, 'item_chase', { episode: 'e1', since: lastOk, state: 'needs_reauth', notified_at: null, reminded_at: null });
    const months = (await progress()).body.flows.acc_sav.months;
    expect(months[0].gaps).toBeUndefined();
    expect(months[1].gaps).toEqual([{ kind: 'stopped', institution: 'Chase', since: lastOk }]);
    expect(months[2].gaps).toEqual([{ kind: 'stopped', institution: 'Chase', since: lastOk }]);
  });

  test('an account reconnected under a new id reads its earlier id’s balances too', async () => {
    await fake.hset(ctxKey('accounts:meta'), {
      item_broker: await remembered([{ account_id: 'acc_ira2', name: 'IRA', type: 'investment', subtype: 'ira' }]),
    });
    await links.linkAccounts(ctx, 'acc_ira', 'acc_ira2', {});
    const { flows } = (await progress()).body;
    expect(flows.acc_ira).toBeUndefined();
    expect(flows.acc_ira2.months.map((m: any) => m.amount)).toEqual([350.5, 249.75, 349.5]);
  });

  test('the viewer’s month, a month either side of the server’s, and nothing further', async () => {
    expect((await progress(`month=${addMonths(THIS_MONTH, -1)}`)).body.months).toEqual(trailingMonths(addMonths(THIS_MONTH, -1)));
    expect((await progress('')).body.months).toEqual([M1, M2, M3]);
    for (const bad of [`month=${addMonths(THIS_MONTH, 2)}`, 'month=2026-13', 'month=soon']) {
      expect((await progress(bad)).status).toBe(400);
    }
  });

  test('another person’s rows and balances never count', async () => {
    await saveItem(OTHER, { item_id: 'item_other', institution_name: 'Chase', encrypted_access_token: await encrypt('access-sandbox-other') });
    await fake.hset(ctxKey('accounts:meta', OTHER), { item_other: await remembered([{ account_id: 'acc_sav', name: 'Savings', type: 'depository' }]) });
    await fake.set(ctxKey('txns:item_other', OTHER), await blob([row('o1', 'acc_sav', `${M1}-04`, -1_000_000)]));
    expect((await progress()).body.flows.acc_sav.months[0].amount).toBe(375.5);
  });
});
