import { describe, expect, test, mock, beforeEach, afterEach, setSystemTime } from 'bun:test';
import { FakeRedis, storageMock, TEST_CTX, registerTestContainer, unscopedDataKeys } from './fake-redis';

// A student loan's accrued interest in today's net worth (plan #19,
// lib/accrued-interest.ts): Plaid reports a loan's balance as its principal
// and the interest apart. The total on Home counts the interest as owed, in a
// line of its own; the server, and with it the history layer and every point
// the chart draws, counts the balances alone.

const ctx = TEST_CTX;
process.env.PLAID_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');

const fake = new FakeRedis({ deserialize: true });
afterEach(() => expect(unscopedDataKeys(fake)).toEqual([]));
mock.module('@/lib/storage', () => storageMock(fake));

const plaid = { institution_id: 'ins_1', accounts: [] as any[], student: [] as any[] };
mock.module('@/lib/plaid', () => ({
  plaidClient: {
    accountsGet: async () => ({ data: { item: { institution_id: plaid.institution_id }, accounts: plaid.accounts } }),
    investmentsHoldingsGet: async () => ({ data: { accounts: [], holdings: [], securities: [] } }),
    liabilitiesGet: async () => ({ data: { liabilities: { credit: [], mortgage: [], student: plaid.student } } }),
    itemRemove: async () => ({ data: {} }),
  },
}));

const { encrypt } = await import('@/lib/crypto');
const { saveItem } = await import('@/lib/storage');
const { forgetEpochs } = await import('@/lib/sessions');
const { getHistory } = await import('@/lib/history');
const netWorthRoute = await import('@/app/api/net-worth/route');
const { accruedApart, accruedInterestOwed, accruedNote, NO_ACCRUED, SALLIE_MAE } = await import('@/lib/accrued-interest');
const { debtAccounts } = await import('@/lib/payoff');

const account = (account_id: string, type: string, subtype: string, current: number) => ({
  account_id,
  name: account_id,
  official_name: null,
  type,
  subtype,
  mask: '0001',
  balances: { available: null, current, limit: null, iso_currency_code: 'USD' },
});
const loan = (account_id: string, outstanding: number | null) => ({
  account_id,
  interest_rate_percentage: 5.5,
  minimum_payment_amount: 200,
  next_payment_due_date: '2026-11-01',
  last_payment_amount: 200,
  last_payment_date: '2026-10-01',
  is_overdue: false,
  expected_payoff_date: '2036-01-01',
  outstanding_interest_amount: outstanding,
});

beforeEach(async () => {
  setSystemTime();
  fake.reset();
  forgetEpochs();
  await registerTestContainer(fake);
  plaid.institution_id = 'ins_1';
  plaid.accounts = [account('chk', 'depository', 'checking', 5000), account('stu', 'loan', 'student', 12_000)];
  plaid.student = [loan('stu', 612.4)];
  await saveItem(ctx, { item_id: 'item_nelnet', institution_name: 'Nelnet', encrypted_access_token: await encrypt(TEST_CTX, 'tok') });
});

const load = async () => {
  const res = await netWorthRoute.GET(new Request('http://x/api/net-worth?refresh=1'));
  return { status: res.status, body: (await res.json()) as any };
};
const money = (n: number) => `$${n.toFixed(2)}`;

describe('what the server sends and records', () => {
  test('the balances alone: the total, today’s point and the recorded day; the interest rides on the loan’s row', async () => {
    const { status, body } = await load();
    expect(status).toBe(200);
    expect(body.netWorth).toBe(-7000);
    const today = new Date().toISOString().slice(0, 10);
    expect(body.history.at(-1)).toEqual({ date: today, value: -7000 });
    // Never in the history layer.
    expect(await getHistory(ctx)).toEqual([{ date: today, value: -7000 }]);
    const row = body.institutions[0].accounts.find((a: any) => a.account_id === 'stu');
    expect(row.liability).toMatchObject({ kind: 'student', outstanding_interest: 612.4 });
    // The page counts it, from the rows the total is made of.
    expect(accruedInterestOwed(body.institutions)).toEqual({ total: 612.4, loans: 1 });
    expect(body.netWorth - accruedInterestOwed(body.institutions).total).toBeCloseTo(-7612.4, 6);
  });

  test('Sallie Mae’s balance includes it already: nothing more is counted', async () => {
    plaid.institution_id = SALLIE_MAE;
    const { body } = await load();
    expect(accruedInterestOwed(body.institutions)).toEqual(NO_ACCRUED);
  });

  test('a hidden loan counts in nothing, its interest neither', async () => {
    const { setAccountHidden } = await import('@/lib/hidden');
    await setAccountHidden(ctx, 'stu', 'loan', true);
    const { body } = await load();
    expect(body.netWorth).toBe(5000);
    expect(accruedInterestOwed(body.institutions)).toEqual(NO_ACCRUED);
  });
});

describe('the rule', () => {
  test('a student loan’s positive interest, apart from a balance that doesn’t hold it', () => {
    expect(accruedApart('student', 'ins_1', 612.4)).toBe(612.4);
    expect(accruedApart('student', null, 612.4)).toBe(612.4);
    expect(accruedApart('student', SALLIE_MAE, 612.4)).toBeNull();
    for (const kind of ['credit', 'mortgage', null, undefined]) expect(accruedApart(kind, 'ins_1', 612.4)).toBeNull();
    for (const outstanding of [0, -5, Number.NaN, Number.POSITIVE_INFINITY, null, undefined, '612.40']) {
      expect(accruedApart('student', 'ins_1', outstanding)).toBeNull();
    }
  });

  test('summed over the rows the total counts: never a hidden one, nor one without a balance; in cents', () => {
    const row = (account_id: string, outstanding: number | null, over: Record<string, unknown> = {}) => ({
      account_id,
      balance: 1000,
      liability: { kind: 'student', outstanding_interest: outstanding },
      ...over,
    });
    const owed = accruedInterestOwed([
      { institution_id: 'ins_1', accounts: [row('a', 0.1), row('b', 0.2), row('hid', 50, { hidden: true }), row('nobal', 50, { balance: null }), row('none', null)] },
      { institution_id: SALLIE_MAE, accounts: [row('sm', 99)] },
      { accounts: [row('c', 100), { account_id: 'card', balance: 300, liability: { kind: 'credit' } }, { account_id: 'chk', balance: 10 }] },
    ]);
    expect(owed).toEqual({ total: 100.3, loans: 3 });
    expect(accruedInterestOwed([])).toEqual(NO_ACCRUED);
  });

  test('the payoff planner plans on the same figure', () => {
    const debts = debtAccounts([
      {
        institution_name: 'Nelnet',
        institution_id: 'ins_1',
        accounts: [{ account_id: 'stu', name: 'Loan', type: 'loan', subtype: 'student', balance: 12_000, liability: { kind: 'student', apr: 5.5, outstanding_interest: 612.4 } }],
      },
      {
        institution_name: 'Sallie Mae',
        institution_id: SALLIE_MAE,
        accounts: [{ account_id: 'sm', name: 'Loan', type: 'loan', subtype: 'student', balance: 8000, liability: { kind: 'student', apr: 5.5, outstanding_interest: 99 } }],
      },
    ] as any);
    expect(debts.map((d: any) => [d.id, d.accruedInterestCents])).toEqual([
      ['stu', 61_240],
      ['sm', null],
    ]);
  });
});

describe('the line under the total', () => {
  const one = { total: 612.4, loans: 1 };
  test('how much, and where it comes from', () => {
    expect(accruedNote(one, { chart: false, chartToday: false, delta: false }, money)).toBe(
      'Counts $612.40 of accrued interest on a student loan as owed: Plaid reports it apart from the loan’s balance.'
    );
    expect(accruedNote({ total: 1200, loans: 2 }, { chart: false, chartToday: false, delta: false }, money)).toBe(
      'Counts $1200.00 of accrued interest on 2 student loans as owed: Plaid reports it apart from the loans’ balances.'
    );
  });

  test('with the chart: that it counts the balances alone, and by how much its point for today is above the total', () => {
    expect(accruedNote(one, { chart: true, chartToday: true, delta: false }, money)).toBe(
      'Counts $612.40 of accrued interest on a student loan as owed: Plaid reports it apart from the loan’s balance. The chart counts the balances alone, as every day is recorded, so its point for today is $612.40 above this total.'
    );
    expect(accruedNote(one, { chart: true, chartToday: true, delta: true }, money)).toBe(
      'Counts $612.40 of accrued interest on a student loan as owed: Plaid reports it apart from the loan’s balance. The chart and the change above count the balances alone, as every day is recorded, so the chart’s point for today is $612.40 above this total.'
    );
    // A chart that ends on an earlier day (today's total wasn't recorded).
    expect(accruedNote(one, { chart: true, chartToday: false, delta: true }, money)).toEndWith(
      'The chart and the change above count the balances alone, as every day is recorded.'
    );
  });

  test('nothing to say without any, and never an em or en dash', () => {
    expect(accruedNote(NO_ACCRUED, { chart: true, chartToday: true, delta: true }, money)).toBeNull();
    for (const opts of [
      { chart: false, chartToday: false, delta: false },
      { chart: true, chartToday: true, delta: true },
      { chart: true, chartToday: false, delta: false },
    ]) {
      expect(accruedNote({ total: 5, loans: 3 }, opts, money)).not.toMatch(/[\u2013\u2014]/);
    }
  });
});
