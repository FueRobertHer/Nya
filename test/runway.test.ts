import { describe, expect, test } from 'bun:test';
import { cashPosition, type ForecastInstitution } from '@/lib/forecast';
import { summarize } from '@/lib/totals';
import {
  buildRunwayInputs,
  DEFAULT_WHAT_IF,
  HORIZON_DAYS,
  MONTH_DAYS,
  monthsText,
  paymentsOutsideSpending,
  projectRunway,
  runwayWindow,
  windowSpending,
  type RunwayInputs,
  type RunwayWhatIf,
  type WindowSpending,
} from '@/lib/report/runway';
import { detectRecurring } from '@/lib/recurring';

// The runway's pure core (lib/report/runway.ts), held to a case worked out by
// hand: which months its spending is read over, the shared spending rule
// (transfers, exclusions, loan payments and another currency left out), the
// one-offs said, the loan's payment the forecast holds that the spending rule
// leaves out, a planned expense and planned income, income on, off and
// stopping on a day, spending lower by an amount, and the day it runs out,
// to the day. Its own clock: today is passed in, never read.

import { PLANNED, ROWS, START, TODAY, row } from './runway-fixture';

const position = (start = START) => ({
  currency: 'USD',
  balances: start,
  pending: { amount: 0, count: 0 },
  start,
  included: [
    { account_id: 'chk', name: 'Checking', institution: 'Chase', balance: start, manual: false },
    { account_id: 'sav', name: 'Savings', institution: 'Chase', balance: 0, manual: false },
  ],
  leftOut: [],
  noBalance: [],
});
const built = (over: Partial<Parameters<typeof buildRunwayInputs>[0]> = {}) =>
  buildRunwayInputs({ today: TODAY, position: position(), rows: ROWS, planned: PLANNED, dismissed: [], ...over });
const whatIf = (over: Partial<RunwayWhatIf> = {}): RunwayWhatIf => ({ ...DEFAULT_WHAT_IF, months: 3, ...over });

describe('the window', () => {
  test('the full calendar months before this one, never this month', () => {
    expect(runwayWindow(TODAY, 3)).toEqual({ months: 3, start: '2026-07-01', end: '2026-09-30', days: 92, list: ['2026-07', '2026-08', '2026-09'] });
    expect(runwayWindow(TODAY, 6)).toMatchObject({ start: '2026-04-01', end: '2026-09-30', days: 183 });
    expect(runwayWindow(TODAY, 12)).toMatchObject({ start: '2025-10-01', end: '2026-09-30', days: 365 });
    // Across a year, and a leap February.
    expect(runwayWindow('2027-01-05', 3)).toMatchObject({ start: '2026-10-01', end: '2026-12-31', days: 92 });
    expect(runwayWindow('2024-03-01', 3)).toMatchObject({ start: '2023-12-01', end: '2024-02-29', days: 91 });
  });
});

describe('the spending, by the shared rule', () => {
  test('money out and in are the Activity tab’s totals for the same months, transfers, exclusions, loan payments and another currency left out', () => {
    const w = windowSpending(ROWS, runwayWindow(TODAY, 3), 'USD');
    const s = summarize(ROWS, (d) => d >= '2026-07-01' && d <= '2026-09-30', 'USD');
    expect([w.money_out, w.money_in]).toEqual([s.money_out, s.money_in]);
    expect([w.money_out, w.money_in]).toEqual([9200, 6440]);
    expect(w.transactions).toBe(s.counted);
    expect(w.left_out).toEqual([{ currency: 'EUR', count: 1 }]);
    expect(w.left_out_text).toBe("1 transaction in EUR isn't in these totals, which are in USD.");
  });

  test('a one-off is said, never hidden: one large outflow at a merchant with nothing like it in the window', () => {
    const w = windowSpending(ROWS, runwayWindow(TODAY, 3), 'USD');
    // Half an average month is 9,200 / 92 x 30.4375 / 2 = 1,521.88: the
    // repair is over it; rent is too, but comes every month at that amount.
    expect(w.one_offs).toEqual([{ date: '2026-08-15', name: 'Midas', amount: 2000 }]);
    expect(w.one_offs_total).toBe(2000);
    // It stays in the spending.
    expect(w.money_out).toBe(9200);
    // Two of a similar size at one merchant are neither one-offs.
    const twice = windowSpending([...ROWS, row('repair-2', '2026-09-03', 1900, { name: 'Midas', vendor_key: 'midas' })], runwayWindow(TODAY, 3), 'USD');
    expect(twice.one_offs).toEqual([]);
    // A split transaction is one: its parts are added up before it is judged.
    const split = windowSpending(
      [
        ...ROWS.filter((t) => t.transaction_id !== 'repair'),
        row('repair:0', '2026-08-15', 1200, { name: 'Midas', vendor_key: 'midas', split_of: 'repair' }),
        row('repair:1', '2026-08-15', 800, { name: 'Midas', vendor_key: 'midas', split_of: 'repair', category: 'auto' }),
      ],
      runwayWindow(TODAY, 3),
      'USD'
    );
    expect(split.one_offs).toEqual([{ date: '2026-08-15', name: 'Midas', amount: 2000 }]);
  });

  test('the months that may be short are the window’s own', () => {
    const short = [
      { month: '2026-05', institutions: ['Citi'] },
      { month: '2026-08', institutions: ['Chase'] },
    ];
    expect(windowSpending(ROWS, runwayWindow(TODAY, 3), 'USD', short).short).toEqual([{ month: '2026-08', institutions: ['Chase'] }]);
    expect(windowSpending(ROWS, runwayWindow(TODAY, 6), 'USD', short).short).toEqual(short);
  });
});

describe('what the forecast changes', () => {
  test('a loan’s payment from cash is added; rent, already in the spending, and a card’s payment are not', () => {
    const card = ['07', '08', '09', '10'].map((m) => row(`card-${m}`, `2026-${m}-12`, 450, { name: 'Card payment', vendor_key: 'cardpay', category: 'loan payments', subcategory: 'credit card payment' }));
    const rows = [...ROWS, ...card];
    const series = detectRecurring(rows);
    const outside = paymentsOutsideSpending(series, rows);
    expect(outside.map((s) => [s.name, s.amount, s.nextDate])).toEqual([['Home Loans', 800, '2026-11-05']]);
    // Rent is a bill detection finds, and the spending counts it already.
    expect(series.some((s) => s.name === 'Landlord' && s.kind === 'bill')).toBe(true);
    // The card's payment is a bill that pays a card.
    expect(series.find((s) => s.name === 'Card payment')?.paysCard).toBe(true);
  });

  test('a loan payment filed under a spending category counts in the spending, so it isn’t added; nor is one marked not recurring', () => {
    const filed = ROWS.map((t) => (t.name === 'Home Loans' ? { ...t, category_kind: 'expense' as const } : t));
    expect(paymentsOutsideSpending(detectRecurring(filed), filed)).toEqual([]);
    const series = detectRecurring(ROWS);
    const mortgage = series.find((s) => s.name === 'Home Loans')!;
    expect(paymentsOutsideSpending(series, ROWS, new Set([mortgage.id]))).toEqual([]);
    expect(built({ dismissed: [mortgage.id] }).outside).toEqual([]);
  });

  test('the inputs list what they add, in the runway’s currency, and name what they leave out', () => {
    const b = built();
    expect(b.currency).toBe('USD');
    expect(b.outside).toEqual([{ name: 'Home Loans', institution: 'Chase', account: 'Checking', amount: 800, cadence: 'monthly', next: '2026-11-05' }]);
    expect(b.planned).toEqual([
      { name: 'Car registration', kind: 'expense', amount: 300, cadence: 'once', next: '2026-12-01' },
      { name: 'Tax refund', kind: 'income', amount: 1000, cadence: 'once', next: '2027-03-15' },
    ]);
    expect(b.events_left_out).toEqual([{ currency: 'EUR', count: 1 }]);
    // Monthly, for ten years: about 120 payments.
    expect(b.events.filter((e) => e.name === 'Home Loans').length).toBe(120);
    // Planned items can't be read: none are in it.
    expect(built({ planned: null }).planned).toEqual([]);
  });
});

describe('the runway, to the day', () => {
  // Without income, everything in: 12,000 less 100.00 a day from tomorrow,
  // less 800 on each 5th from Nov 5 (days 14, 44, 75, 106 from today) and
  // 300 on Dec 1 (day 40). From day 75 to 105 that is 12,000 - 2,400 - 300
  // - 100 x d = 9,300 - 100 x d: zero on day 93 (Jan 23, 2027), below zero on
  // day 94 (Jan 24). It lasts 93 days: 93 / 30.4375 = 3.06 months.
  test('without income: runs out on Jan 24, 2027, lasting 93 days', () => {
    const p = projectRunway(built(), whatIf());
    expect(p.window.months).toBe(3);
    expect(p.without_income).toMatchObject({ income: { kind: 'none' }, runs_out: '2027-01-24', days: 93, outcome: 'runs_out' });
    expect(p.without_income.months).toBeCloseTo(93 / MONTH_DAYS, 10);
    expect(monthsText(p.without_income.months!)).toBe('3.0');
    expect(p.without_income.spending_per_month).toBeCloseTo(100 * MONTH_DAYS, 6);
    expect(p.without_income.income_per_month).toBe(0);
    // The day before it is still at zero; the lowest is the day it runs out,
    // never the balance ten years on.
    const chart = new Map(p.chart.map((c) => [c.date, c]));
    expect(chart.get('2027-01-24')!.without).toBe(-100);
    expect(p.without_income.lowest).toEqual({ date: '2027-01-24', balance: -100 });
  });

  // With income, 70.00 a day: a net 30.00 a day, the same payments, and the
  // tax refund of 1,000 on Mar 15 (day 144). On day 226 (Jun 5, 2027, the
  // eighth payment): 12,000 - 30 x 226 - 8 x 800 - 300 + 1,000 = -480; on
  // day 225: 12,000 - 6,750 - 5,600 - 300 + 1,000 = 350.
  test('with income: runs out on Jun 5, 2027, the day of a payment', () => {
    const p = projectRunway(built(), whatIf());
    expect(p.with_income).toMatchObject({ income: { kind: 'ongoing' }, runs_out: '2027-06-05', days: 225, outcome: 'runs_out' });
    expect(p.with_income.income_per_month).toBeCloseTo(70 * MONTH_DAYS, 6);
    const chart = new Map(p.chart.map((c) => [c.date, c]));
    expect(chart.get('2027-06-05')!.with).toBe(-480);
  });

  test('planned items left out: Jan 27 without income (9,600 - 100 x 97 < 0), May 24 with it', () => {
    const p = projectRunway(built(), whatIf({ planned: false }));
    expect(p.without_income.runs_out).toBe('2027-01-27');
    expect(p.with_income.runs_out).toBe('2027-05-24');
  });

  test('income stopping on Dec 31: 70 days of it, the refund after it not in', () => {
    // 12,000 + 70 x 70 - 300 = 16,600, less 100 a day and 800 a payment: on
    // day 134 (Mar 5, the fifth payment) 16,600 - 13,400 - 4,000 = -800; on
    // day 133, 16,600 - 13,300 - 3,200 = 100.
    const p = projectRunway(built(), whatIf({ income_until: '2026-12-31' }));
    expect(p.with_income).toMatchObject({ income: { kind: 'until', date: '2026-12-31' }, runs_out: '2027-03-05', days: 133 });
    // Without income is the same either way.
    expect(p.without_income.runs_out).toBe('2027-01-24');
    // A day already gone stops nothing more than no income does, and the
    // line keeps the day it stopped on.
    const gone = projectRunway(built(), whatIf({ income_until: '2026-10-01' })).with_income;
    expect(gone.income).toEqual({ kind: 'until', date: '2026-10-01' });
    expect({ ...gone, income: p.without_income.income }).toEqual(p.without_income);
  });

  test('spending lower by 304.38 a month is about 10.00 a day less: Feb 3 without income', () => {
    // A month's 3,043.75 less 304.38 is 2,739.37, so 90.00 a day all but a
    // sixtieth of a cent: 9,300 - 90 x d is 30.00 on day 103 and below zero
    // first on day 104 (Feb 3, 2027).
    const p = projectRunway(built(), whatIf({ lower_by: 304.38 }));
    expect(p.without_income.runs_out).toBe('2027-02-03');
    expect(p.without_income.spending_per_month).toBe(2739.37);
    // Never below nothing: lower by more than the spending is no spending.
    const none = projectRunway(built(), whatIf({ lower_by: 1e6 }));
    expect(none.without_income.spending_per_month).toBe(0);
  });

  test('one-offs left out: 7,200 over 92 days, Feb 8 without income', () => {
    // 8,500 - 78.26 x d: 47.83 on day 108, -30.43 on day 109 (Feb 8, 2027).
    const p = projectRunway(built(), whatIf({ leave_out_one_offs: true }));
    expect(p.without_income.runs_out).toBe('2027-02-08');
    expect(p.chart.find((c) => c.date === '2027-02-08')!.without).toBe(-30.43);
  });

  test('another window reads its own months', () => {
    // Six months: the same 9,200 over 183 days, so less a day.
    const p = projectRunway(built(), whatIf({ months: 6 }));
    expect(p.window).toMatchObject({ months: 6, start: '2026-04-01', days: 183, money_out: 9200 });
    expect(p.without_income.spending_per_month).toBeCloseTo((9200 / 183) * MONTH_DAYS, 6);
  });
});

/** A window's figures, as windowSpending gives them: some spending to go by,
 *  `spending` and `income` as the runway takes them. */
const win = (over: Partial<WindowSpending> = {}): WindowSpending => ({
  months: 6,
  start: '2026-04-01',
  end: '2026-09-30',
  days: 183,
  money_out: 0,
  money_in: 0,
  transactions: 1,
  refunds: 0,
  infrequent: 0,
  card_payments: [],
  card_payments_total: 0,
  transfers_out: 0,
  transfers_out_own: 0,
  transfers_out_unsure: 0,
  cash_out: 0,
  spending: 0,
  income: 0,
  one_offs: [],
  one_offs_total: 0,
  one_offs_in: [],
  one_offs_in_total: 0,
  left_out: [],
  left_out_text: null,
  short: [],
  ...over,
});

describe('the edges', () => {
  const inputs = (over: Partial<RunwayInputs> = {}): RunwayInputs => ({
    today: TODAY,
    currency: 'USD',
    start: 1000,
    has_cash: true,
    windows: [win()],
    events: [],
    ...over,
  });

  test('below zero now runs out today, lasting no days', () => {
    const p = projectRunway(inputs({ start: -5 }), DEFAULT_WHAT_IF);
    expect(p.without_income).toMatchObject({ runs_out: TODAY, days: 0, months: 0, outcome: 'runs_out', lowest: { date: TODAY, balance: -5 } });
  });

  test('nothing spent and nothing expected is covered; income above spending grows', () => {
    expect(projectRunway(inputs(), DEFAULT_WHAT_IF).without_income).toMatchObject({ runs_out: null, days: null, months: null, outcome: 'covered' });
    const p = projectRunway(inputs({ windows: [win({ spending: 1830, income: 3660 })] }), DEFAULT_WHAT_IF);
    expect(p.with_income.outcome).toBe('covered');
    expect(p.without_income.outcome).toBe('runs_out');
    // 10.00 a day: 1,000 lasts 100 days.
    expect(p.without_income).toMatchObject({ days: 100, runs_out: '2027-01-31' });
  });

  test('more than ten years: going down, but not below zero within the horizon', () => {
    // 1.83 over 183 days is 0.01 a day: 1,000 lasts 100,000 days.
    const p = projectRunway(inputs({ windows: [win({ spending: 1.83 })] }), DEFAULT_WHAT_IF);
    expect(p.without_income).toMatchObject({ runs_out: null, outcome: 'beyond' });
    // The chart then shows a year.
    expect(p.chart.at(-1)!.date).toBe('2027-10-22');
    expect(p.chart.length).toBeLessThanOrEqual(121);
  });

  test('the chart runs a little past the later day it runs out, and holds both days', () => {
    const p = projectRunway(built(), whatIf());
    const dates = p.chart.map((c) => c.date);
    expect(dates[0]).toBe(TODAY);
    expect(dates).toContain('2027-01-24');
    expect(dates).toContain('2027-06-05');
    // 226 days x 1.2, rounded up: day 272.
    expect(dates.at(-1)).toBe('2027-07-21');
    expect(p.chart[0]).toEqual({ date: TODAY, without: START, with: START });
  });

  test('an event past the horizon, or before today, moves nothing', () => {
    const far = { date: '2040-01-01', amount: -1e9, name: 'Far', source: 'planned' as const, ref: 'far' };
    const past = { date: '2026-10-01', amount: -1e9, name: 'Past', source: 'planned' as const, ref: 'past' };
    expect(projectRunway(inputs({ events: [far, past] }), DEFAULT_WHAT_IF).without_income.outcome).toBe('covered');
    expect(HORIZON_DAYS).toBe(3653);
  });
});

describe('cash, as the forecast starts from it', () => {
  test('checking, savings and cash on hand, not hidden, in one currency, less what is pending; never a card or an investment account', () => {
    const institutions: ForecastInstitution[] = [
      {
        institution_name: 'Chase',
        accounts: [
          { account_id: 'chk', name: 'Checking', type: 'depository', subtype: 'checking', balance: 7000, currency: 'USD' },
          { account_id: 'sav', name: 'Savings', type: 'depository', subtype: 'savings', balance: 5000, currency: 'USD' },
          { account_id: 'hid', name: 'Hidden', type: 'depository', subtype: 'savings', balance: 9999, currency: 'USD', hidden: true },
          { account_id: 'card', name: 'Card', type: 'credit', subtype: 'credit card', balance: 600, currency: 'USD' },
        ],
      },
      { institution_name: 'Vanguard', accounts: [{ account_id: 'ira', name: 'IRA', type: 'investment', subtype: 'ira', balance: 50000, currency: 'USD' }] },
      { institution_name: 'N26', accounts: [{ account_id: 'eur', name: 'Konto', type: 'depository', subtype: 'checking', balance: 3000, currency: 'EUR' }] },
    ];
    const pending = [{ ...row('lunch', TODAY, 25.5, { pending: true }), account_name: 'Checking', institution_name: 'Chase' }];
    const p = cashPosition(institutions, pending);
    expect(p).toMatchObject({ currency: 'USD', balances: 12000, pending: { amount: 25.5, count: 1 }, start: 11974.5, leftOut: [{ currency: 'EUR', count: 1 }] });
    expect(p.included.map((a) => a.name)).toEqual(['Checking', 'Savings']);
    const b = built({ position: p });
    expect(b.start).toBe(11974.5);
  });
});

describe('what leaves cash that the Activity tab leaves out', () => {
  const ten = () => position(10000);
  const rent = ['07', '08', '09'].map((m) => row(`rent-${m}`, `2026-${m}-01`, 1000, { name: 'Landlord', vendor_key: 'landlord', category: 'rent and utilities' }));
  const amex = (amounts = [1500, 1500, 1500, 1500]) =>
    ['07', '08', '09', '10'].map((m, i) =>
      row(`amex-${m}`, `2026-${m}-12`, amounts[i], { name: 'AMEX EPAYMENT', vendor_key: 'amex', category: 'loan payments', subcategory: 'credit card payment' })
    );
  const onAmex = (amounts = [1500, 1500, 1500, 1500]) =>
    ['07', '08', '09', '10'].map((m, i) =>
      row(`amex-in-${m}`, `2026-${m}-14`, -amounts[i], { name: 'PAYMENT RECEIVED', account_name: 'Amex', account_type: 'credit', institution_name: 'Amex', category: 'loan payments' })
    );

  test('a payment to a card Nya doesn’t see is spending: 1,500 a month to an unlinked Amex, beside 1,000 of rent', () => {
    const b = buildRunwayInputs({ today: TODAY, position: ten(), rows: [...amex(), ...rent], planned: [], dismissed: [] });
    const w = b.windows.find((x) => x.months === 3)!;
    expect(w.card_payments).toEqual([{ name: 'AMEX EPAYMENT', account: 'Checking', amount: 4500, count: 3 }]);
    expect([w.money_out, w.card_payments_total, w.spending]).toEqual([3000, 4500, 7500]);
    // 7,500 over 92 days is 81.52 a day: 10,000 is 54.35 on day 122 and below
    // zero on day 123 (Feb 22, 2027). Without the payments it lasted 306 days.
    const p = projectRunway(b, whatIf());
    expect([p.without_income.runs_out, p.without_income.days]).toEqual(['2027-02-22', 122]);
  });

  test('one that changes every month counts as it was paid; one that lands on a card in Nya stays out, the card’s charges counted there', () => {
    const varies = buildRunwayInputs({ today: TODAY, position: ten(), rows: [...amex([1500, 1820, 960, 1300]), ...rent], planned: [], dismissed: [] });
    expect(varies.windows.find((x) => x.months === 3)!.card_payments_total).toBe(4280);
    const linked = buildRunwayInputs({ today: TODAY, position: ten(), rows: [...amex(), ...onAmex(), ...rent], planned: [], dismissed: [] });
    const w = linked.windows.find((x) => x.months === 3)!;
    expect([w.card_payments, w.spending]).toEqual([[], 3000]);
    // Nor is a payment to a card in Nya a move out of cash.
    expect([w.transfers_out, w.cash_out]).toEqual([0, 0]);
  });

  test('transfers out and cash taken out are named, and counted only in the what-if; a move to another cash account is neither', () => {
    const rows = [
      ...['07', '08', '09'].map((m) => row(`zelle-${m}`, `2026-${m}-02`, 1200, { name: 'ZELLE TO J SMITH', category: 'transfer out', transaction_code: 'transfer' })),
      ...['07', '08', '09'].map((m) => row(`atm-${m}`, `2026-${m}-05`, 200, { name: 'ATM', transaction_code: 'atm' })),
      row('to-savings', '2026-07-10', 500, { name: 'To savings', category: 'transfer out', transaction_code: 'transfer' }),
      row('into-savings', '2026-07-11', -500, { name: 'From checking', account_name: 'Savings', category: 'transfer in', transaction_code: 'transfer' }),
      ...['07', '08', '09'].map((m) => row(`grocer-${m}`, `2026-${m}-20`, 920, { name: 'Grocer', vendor_key: 'grocer', category: 'food and drink' })),
    ];
    const b = buildRunwayInputs({ today: TODAY, position: ten(), rows, planned: [], dismissed: [] });
    const w = b.windows.find((x) => x.months === 3)!;
    expect([w.spending, w.transfers_out, w.cash_out]).toEqual([2760, 3600, 600]);
    const plain = projectRunway(b, whatIf());
    const counted = projectRunway(b, whatIf({ count_moved_out: true }));
    expect(plain.without_income.spending_per_month).toBeCloseTo((2760 / 92) * MONTH_DAYS, 2);
    expect(counted.without_income.spending_per_month).toBeCloseTo((6960 / 92) * MONTH_DAYS, 2);
  });

  test('a bill less often than monthly is added on its dates, never averaged, and never a one-off', () => {
    const weeks = Array.from({ length: 56 }, (_, i) => {
      const d = new Date(Date.UTC(2025, 8, 1) + i * 7 * 86_400_000).toISOString().slice(0, 10);
      return row(`g${i}`, d, 100, { name: 'Grocer', vendor_key: 'grocer', category: 'food and drink' });
    });
    const insurance = ['2023-11-15', '2024-11-15', '2025-11-15'].map((d) => row(`ins-${d}`, d, 1800, { name: 'Insurer', vendor_key: 'ins', category: 'insurance' }));
    const b = buildRunwayInputs({ today: TODAY, position: ten(), rows: [...weeks, ...insurance], planned: [], dismissed: [] });
    expect(b.infrequent).toEqual([{ name: 'Insurer', institution: 'Chase', account: 'Checking', amount: 1800, cadence: 'yearly', next: '2026-11-15' }]);
    expect(b.events.filter((e) => e.name === 'Insurer').slice(0, 2).map((e) => [e.date, e.amount])).toEqual([
      ['2026-11-15', -1800],
      ['2027-11-15', -1800],
    ]);
    const twelve = b.windows.find((x) => x.months === 12)!;
    // In the twelve months: taken out of the average, and not a one-off.
    expect([twelve.money_out, twelve.infrequent, twelve.spending]).toEqual([twelve.money_out, 1800, twelve.money_out - 1800]);
    expect(twelve.one_offs).toEqual([]);
    // In six, not in the spending, and still due next month: the line takes
    // 1,800 on Nov 15.
    const six = projectRunway(b, whatIf({ months: 6 }));
    expect(six.window.infrequent).toBe(0);
    // 26 weeks of 100 over 183 days is 14.21 a day: without the premium the
    // 10,000 would last 703 days; 1,800 each November is over 120 days less.
    const before = projectRunway({ ...b, events: b.events.filter((e) => e.name !== 'Insurer') }, whatIf({ months: 6 }));
    expect(before.without_income.days! - six.without_income.days!).toBeGreaterThan(120);
  });

  test('a refund lowers the spending in both lines; a one-off inflow is said, and left out with the one-offs', () => {
    const rows = [
      ...ROWS,
      row('return', '2026-08-03', -300, { name: 'Shop return', vendor_key: 'shop', category: 'general merchandise' }),
      row('bonus', '2026-09-15', -5000, { name: 'Employer', vendor_key: 'employer', category: 'income' }),
    ];
    const b = buildRunwayInputs({ today: TODAY, position: position(), rows, planned: PLANNED, dismissed: [] });
    const w = b.windows.find((x) => x.months === 3)!;
    expect([w.refunds, w.spending, w.money_in, w.income]).toEqual([300, 8900, 11740, 11440]);
    expect(w.one_offs_in).toEqual([{ date: '2026-09-15', name: 'Employer', amount: 5000 }]);
    const p = projectRunway(b, whatIf());
    expect(p.without_income.spending_per_month).toBeCloseTo((8900 / 92) * MONTH_DAYS, 2);
    const out = projectRunway(b, whatIf({ leave_out_one_offs: true }));
    expect(out.with_income.income_per_month).toBeCloseTo((6440 / 92) * MONTH_DAYS, 2);
    expect(out.without_income.spending_per_month).toBeCloseTo(((8900 - 2000) / 92) * MONTH_DAYS, 2);
  });
});

describe('what each payment and move out of cash is matched to', () => {
  /** Checking and savings at Chase, and savings at Ally, in the cash; a
   *  Sapphire card in Nya. */
  const cash = (more: { account_id: string; name: string; institution: string; manual?: boolean; subtype?: string }[] = []) => ({
    ...position(10000),
    included: [
      { account_id: 'chk', name: 'Checking', institution: 'Chase', balance: 10000, manual: false },
      { account_id: 'sav', name: 'Savings', institution: 'Chase', balance: 0, manual: false },
      { account_id: 'ally', name: 'Ally Savings', institution: 'Ally', balance: 0, manual: false },
      ...more.map((a) => ({ balance: 0, manual: false, ...a })),
    ],
  });
  const rent = ['07', '08', '09'].map((m) => row(`rent-${m}`, `2026-${m}-01`, 1000, { name: 'Landlord', vendor_key: 'landlord', category: 'rent and utilities' }));
  const pay = (id: string, date: string, amount: number, over: Record<string, unknown> = {}) =>
    row(id, date, amount, { name: 'CHASE CARD AUTOPAY', vendor_key: 'chase-card', category: 'loan payments', subcategory: 'credit card payment', ...over });
  const receipt = (id: string, date: string, amount: number, over: Record<string, unknown> = {}) =>
    row(id, date, -amount, { name: 'PAYMENT THANK YOU', vendor_key: 'thanks', account_name: 'Sapphire', account_type: 'credit', category: 'loan payments', ...over });
  const three = (rows: ReturnType<typeof row>[], today = TODAY, more: Parameters<typeof cash>[0] = [], short: { month: string; institutions: string[] }[] = []) =>
    buildRunwayInputs({ today, position: cash(more), rows, planned: [], dismissed: [], short }).windows.find((w) => w.months === 3)!;

  test('a card in Nya paid on the window’s last day: its receipt pending, or not in yet, is still that card’s', () => {
    const paid = [pay('p7', '2026-07-30', 2000), receipt('r7', '2026-07-31', 2000), pay('p8', '2026-08-30', 2000), receipt('r8', '2026-08-31', 2000), pay('p9', '2026-09-30', 2000)];
    const pending = three([...rent, ...paid, receipt('r9', '2026-10-01', 2000, { pending: true })], '2026-10-02');
    expect([pending.card_payments, pending.spending]).toEqual([[], 3000]);
    // Oct 1: the receipt isn't in yet, and its payments have been landing on
    // Sapphire, so it is on its way.
    const early = three([...rent, ...paid], '2026-10-01');
    expect([early.card_payments, early.spending]).toEqual([[], 3000]);
    // Three weeks on, with Sapphire up to date, it would have arrived: it pays
    // a card Nya doesn't see.
    const later = three([...rent, ...paid, row('lunch', '2026-10-20', 12, { name: 'Lunch', account_name: 'Sapphire', account_type: 'credit', category: 'food and drink' })], '2026-10-21');
    expect(later.card_payments).toEqual([{ name: 'CHASE CARD AUTOPAY', account: 'Checking', amount: 2000, count: 1 }]);
  });

  test('each receipt is one payment’s: of two autopays of 250, the one with no receipt pays a card Nya doesn’t see', () => {
    const rows = [...rent];
    for (const m of ['07', '08', '09']) {
      rows.push(pay(`a${m}`, `2026-${m}-10`, 250), receipt(`ra${m}`, `2026-${m}-11`, 250));
      rows.push(pay(`b${m}`, `2026-${m}-12`, 250, { name: 'CITI AUTOPAY', vendor_key: 'citi' }));
    }
    const w = three(rows);
    expect([w.card_payments, w.spending]).toEqual([[{ name: 'CITI AUTOPAY', account: 'Checking', amount: 750, count: 3 }], 3750]);
    // The nearest in days is the pair, whichever is paid first.
    const before = rows.map((t) => (t.name === 'CITI AUTOPAY' ? { ...t, date: t.date.replace(/-12$/, '-09') } : t));
    expect(three(before).card_payments).toEqual([{ name: 'CITI AUTOPAY', account: 'Checking', amount: 750, count: 3 }]);
  });

  test('a refund on a card in Nya is never a payment’s receipt', () => {
    const rows = [...rent, ...['07', '08', '09'].map((m) => pay(`b${m}`, `2026-${m}-12`, 120, { name: 'CITI AUTOPAY', vendor_key: 'citi' }))];
    rows.push(row('return', '2026-08-14', -120, { name: 'AMAZON REFUND', account_name: 'Sapphire', account_type: 'credit', category: 'general merchandise' }));
    expect(three(rows).card_payments).toEqual([{ name: 'CITI AUTOPAY', account: 'Checking', amount: 360, count: 3 }]);
  });

  test('a payment in a series that pays a card in Nya is that card’s, its receipt missing a month', () => {
    const rows = [
      ...rent,
      ...['06', '07', '08', '09'].map((m) => pay(`p${m}`, `2026-${m}-28`, 1800)),
      receipt('r06', '2026-06-29', 1800),
      receipt('r08', '2026-08-29', 1800),
      receipt('r09', '2026-09-29', 1800),
    ];
    expect(detectRecurring(rows).find((x) => x.name === 'CHASE CARD AUTOPAY')?.paysCardOf).toEqual({ institution: 'Chase', account: 'Sapphire' });
    expect(three(rows).card_payments).toEqual([]);
  });

  test('a move to your own savings is one, by ACH over five business days or pending at the month’s start', () => {
    const out = (id: string, date: string) => row(id, date, 3000, { name: 'TRANSFER TO ALLY', category: 'transfer out', transaction_code: 'transfer' });
    const arrive = (id: string, date: string, over: Record<string, unknown> = {}) =>
      row(id, date, -3000, { name: 'FROM CHASE', account_name: 'Ally Savings', institution_name: 'Ally', category: 'transfer in', transaction_code: 'transfer', ...over });
    // Friday Sep 4 to Friday Sep 11.
    expect(three([...rent, out('o', '2026-09-04'), arrive('i', '2026-09-11')]).transfers_out).toBe(0);
    expect(three([...rent, out('o', '2026-09-30'), arrive('i', '2026-10-01', { pending: true })], '2026-10-02').transfers_out).toBe(0);
    // Not in yet: it may have arrived.
    expect(three([...rent, out('o', '2026-09-30')], '2026-10-01')).toMatchObject({ transfers_out: 3000, transfers_out_unsure: 3000 });
    // Each arrival is one move's: two moves of 3,000, one arrival.
    expect(three([...rent, out('o1', '2026-08-04'), out('o2', '2026-08-05'), arrive('i', '2026-08-06')])).toMatchObject({ transfers_out: 3000, transfers_out_unsure: 0 });
  });

  test('accounts are told apart by id: a move between two accounts of one name at one bank is no move out', () => {
    const twins = {
      ...position(10000),
      included: [
        { account_id: 'tc1', name: 'Total Checking', institution: 'Chase', balance: 5000, manual: false },
        { account_id: 'tc2', name: 'Total Checking', institution: 'Chase', balance: 5000, manual: false },
      ],
    };
    const rows = [
      ...rent.map((t) => ({ ...t, account_id: 'tc1', account_name: 'Total Checking' })),
      row('o', '2026-08-04', 700, { name: 'ONLINE TRANSFER', account_id: 'tc1', account_name: 'Total Checking', category: 'transfer out', transaction_code: 'transfer' }),
      row('i', '2026-08-04', -700, { name: 'ONLINE TRANSFER', account_id: 'tc2', account_name: 'Total Checking', category: 'transfer in', transaction_code: 'transfer' }),
    ];
    const w = (accounts?: string[]) => buildRunwayInputs({ today: TODAY, position: twins, rows, planned: [], dismissed: [], accounts }).windows.find((x) => x.months === 3)!;
    expect(w(['tc1', 'tc2']).transfers_out).toBe(0);
    // Told by name alone, the two sides look like one account's.
    expect(w().transfers_out).toBe(700);
  });

  test('a move to your health savings account leaves the cash, to an account of yours; one where Nya can’t see may have arrived', () => {
    const out = (id: string, date: string, amount: number, name: string) => row(id, date, amount, { name, category: 'transfer out', transaction_code: 'transfer' });
    const hsa = [out('h', '2026-08-03', 500, 'TO HSA'), row('h-in', '2026-08-05', -500, { name: 'Contribution', account_name: 'Health', institution_name: 'HSA Bank', category: 'transfer in', transaction_code: 'transfer' })];
    expect(three([...rent, ...hsa])).toMatchObject({ transfers_out: 500, transfers_out_own: 500, transfers_out_unsure: 0 });
    const zelle = out('z', '2026-08-10', 700, 'ZELLE TO J SMITH');
    expect(three([...rent, zelle])).toMatchObject({ transfers_out: 700, transfers_out_own: 0, transfers_out_unsure: 0 });
    // A savings account typed by hand with no transactions may hold it; cash
    // on hand can't.
    expect(three([...rent, zelle], TODAY, [{ account_id: 'm', name: 'Credit union', institution: 'Manual', manual: true, subtype: 'savings' }])).toMatchObject({ transfers_out: 700, transfers_out_unsure: 700 });
    expect(three([...rent, zelle], TODAY, [{ account_id: 'w', name: 'Wallet', institution: 'Cash', manual: true, subtype: 'cash' }])).toMatchObject({ transfers_out: 700, transfers_out_unsure: 0 });
    // So may Ally, whose transactions may be missing that month, and not in
    // the month it is up to date.
    const ally = [{ month: '2026-08', institutions: ['Ally'] }];
    expect(three([...rent, zelle], TODAY, [], ally)).toMatchObject({ transfers_out: 700, transfers_out_unsure: 700 });
    expect(three([...rent, { ...zelle, date: '2026-07-10' }], TODAY, [], ally)).toMatchObject({ transfers_out: 700, transfers_out_unsure: 0 });
  });
});

describe('when there is no runway to give', () => {
  test('no cash to start from: no day, whatever the spending', () => {
    const none = { ...position(0), included: [] };
    const p = projectRunway(buildRunwayInputs({ today: TODAY, position: none, rows: ROWS, planned: [], dismissed: [] }), whatIf());
    for (const line of [p.without_income, p.with_income]) expect(line).toMatchObject({ outcome: 'no_cash', runs_out: null, days: null, months: null });
  });

  test('cash, but no spending in the window to go by: no day, never "doesn’t run out"', () => {
    const p = projectRunway(buildRunwayInputs({ today: TODAY, position: position(5000), rows: [], planned: [], dismissed: [] }), whatIf());
    for (const line of [p.without_income, p.with_income]) expect(line).toMatchObject({ outcome: 'no_spending', runs_out: null, days: null });
  });
});
