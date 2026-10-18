import { describe, expect, test, mock, beforeEach, afterEach, setSystemTime } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { FakeRedis, storageMock, TEST_CTX, registerTestContainer, unscopedDataKeys } from './fake-redis';

// A student loan's accrued interest on Home (plan #19, lib/accrued-interest.ts):
// Plaid reports a loan's balance as its principal and the interest apart.
// The total stays the balances, as every other reader has it; a line under
// it says how much interest it leaves out, and a loan whose interest couldn't
// be read on this load is named, so a failed call moves no total and leaves
// no silence.

const ctx = TEST_CTX;
process.env.PLAID_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');

const fake = new FakeRedis({ deserialize: true });
afterEach(() => expect(unscopedDataKeys(fake)).toEqual([]));
mock.module('@/lib/storage', () => storageMock(fake));

const plaid = { institution_id: 'ins_1', accounts: [] as any[], student: [] as any[], liabilitiesFail: false, accountsFail: false };
mock.module('@/lib/plaid', () => ({
  plaidClient: {
    accountsGet: async () => {
      if (plaid.accountsFail) throw { response: { status: 500, data: { error_type: 'API_ERROR', error_code: 'INTERNAL_SERVER_ERROR' } } };
      return { data: { item: { institution_id: plaid.institution_id }, accounts: plaid.accounts } };
    },
    investmentsHoldingsGet: async () => ({ data: { accounts: [], holdings: [], securities: [] } }),
    liabilitiesGet: async () => {
      if (plaid.liabilitiesFail) throw { response: { status: 500, data: { error_type: 'API_ERROR', error_code: 'INTERNAL_SERVER_ERROR' } } };
      return { data: { liabilities: { credit: [], mortgage: [], student: plaid.student } } };
    },
    itemRemove: async () => ({ data: {} }),
  },
}));

const { encrypt } = await import('@/lib/crypto');
const { saveItem } = await import('@/lib/storage');
const { forgetEpochs } = await import('@/lib/sessions');
const { getHistory } = await import('@/lib/history');
const { MASK, setAmountsHidden } = await import('@/lib/format');
const netWorthRoute = await import('@/app/api/net-worth/route');
const { accruedApart, accruedLines, homeAccrued, SALLIE_MAE } = await import('@/lib/accrued-interest');
const { debtAccounts } = await import('@/lib/payoff');
const AccruedInterestNote = (await import('@/components/AccruedInterestNote')).default;

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
  Object.assign(plaid, { institution_id: 'ins_1', liabilitiesFail: false, accountsFail: false });
  plaid.accounts = [account('chk', 'depository', 'checking', 5000), account('stu', 'loan', 'student', 12_000)];
  plaid.student = [loan('stu', 612.4)];
  await saveItem(ctx, { item_id: 'item_nelnet', institution_name: 'Nelnet', encrypted_access_token: await encrypt(TEST_CTX, 'tok') });
});
afterEach(() => setAmountsHidden(false));

const load = async () => {
  const res = await netWorthRoute.GET(new Request('http://x/api/net-worth?refresh=1'));
  return { status: res.status, body: (await res.json()) as any };
};
const quietly = async <T,>(fn: () => Promise<T>): Promise<T> => {
  const saved = { error: console.error, warn: console.warn };
  console.error = () => {};
  console.warn = () => {};
  try {
    return await fn();
  } finally {
    Object.assign(console, saved);
  }
};
/** What Home shows under the total, as text, with which lines are amber. */
const home = (institutions: unknown) => {
  const html = renderToStaticMarkup(<AccruedInterestNote institutions={institutions as any} currency="USD" />);
  const lines = [...html.matchAll(/<div class="([^"]+)">(.*?)<\/div>/g)].map((m) => ({ amber: m[1].includes('stale'), text: m[2].replace(/<[^>]+>/g, '').replace(/&#x27;/g, "'") }));
  return lines;
};
const today = () => new Date().toISOString().slice(0, 10);
const LEFT_OUT_ONE = 'Leaves out $612.40 of accrued interest on a student loan, which Plaid reports apart from its balance. The payoff plan counts it, unless you leave it out there.';
const UNREAD_ONE = 'The accrued interest on your student loan at Nelnet couldn’t be read, so how much interest the total leaves out for it isn’t known.';

describe('Home, from what the server sends', () => {
  test('the total is the balances, as recorded; the line says how much interest it leaves out', async () => {
    const { status, body } = await load();
    expect(status).toBe(200);
    expect(body.netWorth).toBe(-7000);
    expect(body.history.at(-1)).toEqual({ date: today(), value: -7000 });
    expect(await getHistory(ctx)).toEqual([{ date: today(), value: -7000 }]);
    expect(body.institutions[0].accounts.find((a: any) => a.account_id === 'stu').liability).toMatchObject({ kind: 'student', outstanding_interest: 612.4 });
    expect(home(body.institutions)).toEqual([{ amber: false, text: LEFT_OUT_ONE }]);
  });

  test('the liabilities call fails: the total doesn’t move, and the line says the interest couldn’t be read', async () => {
    plaid.liabilitiesFail = true;
    const { status, body } = await quietly(load);
    expect(status).toBe(200);
    expect(body.netWorth).toBe(-7000);
    expect(await getHistory(ctx)).toEqual([{ date: today(), value: -7000 }]);
    expect(home(body.institutions)).toEqual([{ amber: true, text: UNREAD_ONE }]);
  });

  test('a servicer’s row with no interest on it: said the same way', async () => {
    plaid.student = [loan('stu', null)];
    const { body } = await load();
    expect(body.netWorth).toBe(-7000);
    expect(home(body.institutions)).toEqual([{ amber: true, text: UNREAD_ONE }]);
  });

  test('a bank that can’t be reached: its loan shows its last known balance, and its interest is said as not read', async () => {
    await load();
    plaid.accountsFail = true;
    const { status, body } = await quietly(load);
    expect(status).toBe(200);
    expect(body.institutions[0].error).not.toBeNull();
    expect(body.netWorth).toBe(-7000);
    expect(body.institutions[0].accounts.find((a: any) => a.account_id === 'stu')).toMatchObject({ balance: 12_000, stale: true });
    expect(home(body.institutions)).toEqual([{ amber: true, text: UNREAD_ONE }]);
  });

  test('Sallie Mae’s balance includes it already, and a hidden loan counts in nothing: no line', async () => {
    plaid.institution_id = SALLIE_MAE;
    expect(home((await load()).body.institutions)).toEqual([]);
    plaid.institution_id = 'ins_1';
    const { setAccountHidden } = await import('@/lib/hidden');
    await setAccountHidden(ctx, 'stu', 'loan', true);
    const { body } = await load();
    expect(body.netWorth).toBe(5000);
    expect(home(body.institutions)).toEqual([]);
  });

  test('with amounts hidden, the figure is masked, and said as hidden', async () => {
    const { body } = await load();
    const g = globalThis as Record<string, unknown>;
    g.window = {};
    try {
      setAmountsHidden(true);
    } finally {
      delete g.window;
    }
    const html = renderToStaticMarkup(<AccruedInterestNote institutions={body.institutions} currency="USD" />);
    expect(html).toContain(`Leaves out $${MASK} of accrued interest`);
    expect(html).toContain('Leaves out hidden of accrued interest');
    expect(html).not.toContain('612');
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

  test('over the rows the total counts: reported interest summed in cents, the rest of the student loans named as unread', () => {
    const row = (outstanding: unknown, over: Record<string, unknown> = {}) => ({
      type: 'loan',
      subtype: 'student',
      balance: 1000,
      liability: { kind: 'student', outstanding_interest: outstanding },
      ...over,
    });
    const view = homeAccrued([
      {
        institution_name: 'Nelnet',
        institution_id: 'ins_1',
        accounts: [
          row(0.1),
          row(0.2),
          // Known to be none: nothing left out, nothing unread.
          row(0),
          row(null),
          row(-3),
          // Terms that didn't come: the liabilities call failed, or the row
          // is a last known one.
          row(undefined, { liability: undefined }),
          row(50, { hidden: true }),
          row(50, { balance: null }),
          { type: 'credit', subtype: 'credit card', balance: 300, liability: { kind: 'credit' } },
          { type: 'depository', subtype: 'checking', balance: 10 },
        ],
      },
      // Plaid's terms say it is a student loan, whatever its subtype says.
      { institution_name: 'MOHELA', accounts: [row(100, { subtype: null }), row(undefined, { liability: undefined })] },
      { institution_name: 'Sallie Mae', institution_id: SALLIE_MAE, accounts: [row(99), row(undefined, { liability: undefined })] },
      { institution_name: 'Home', manual: true, accounts: [row(undefined, { liability: undefined })] },
      { institution_name: 'Bridge', connector: 'simplefin', accounts: [row(undefined, { liability: undefined })] },
    ] as any);
    expect(view).toEqual({
      total: 100.3,
      loans: 3,
      unread: [
        { institution: 'Nelnet', loans: 3 },
        { institution: 'MOHELA', loans: 1 },
      ],
    });
    expect(homeAccrued([])).toEqual({ total: 0, loans: 0, unread: [] });
  });

  test('the payoff plan plans on the same figure, and keeps its own choice to leave it out', () => {
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

describe('the lines', () => {
  const money = (n: number) => `$${n.toFixed(2)}`;
  const lines = (total: number, loans: number, unread: { institution: string; loans: number }[] = []) => accruedLines({ total, loans, unread }, money);

  test('how much the total leaves out, on how many loans, as a figure owed, never signed', () => {
    expect(lines(612.4, 1)).toEqual({ leftOut: LEFT_OUT_ONE, unread: null });
    expect(lines(1200, 2).leftOut).toBe(
      'Leaves out $1200.00 of accrued interest on 2 student loans, which Plaid reports apart from their balances. The payoff plan counts it, unless you leave it out there.'
    );
  });

  test('loans whose interest couldn’t be read: named by where they are, alone or beside the ones that could', () => {
    expect(lines(0, 0, [{ institution: 'Nelnet', loans: 1 }])).toEqual({ leftOut: null, unread: UNREAD_ONE });
    expect(lines(0, 0, [{ institution: 'Nelnet', loans: 2 }, { institution: 'MOHELA', loans: 1 }]).unread).toBe(
      'The accrued interest on 3 student loans at Nelnet and MOHELA couldn’t be read, so how much interest the total leaves out for them isn’t known.'
    );
    expect(lines(612.4, 1, [{ institution: 'MOHELA', loans: 1 }])).toEqual({
      leftOut: LEFT_OUT_ONE,
      unread: 'The accrued interest on another student loan at MOHELA couldn’t be read, so how much interest the total leaves out for it isn’t known.',
    });
    expect(lines(612.4, 1, [{ institution: 'MOHELA', loans: 2 }]).unread).toStartWith('The accrued interest on 2 other student loans at MOHELA');
  });

  test('nothing to say without any, and never an em or en dash', () => {
    expect(lines(0, 0)).toEqual({ leftOut: null, unread: null });
    const all = lines(5, 3, [{ institution: 'Nelnet', loans: 2 }]);
    expect(`${all.leftOut} ${all.unread}`).not.toMatch(/[\u2013\u2014]/);
  });
});
