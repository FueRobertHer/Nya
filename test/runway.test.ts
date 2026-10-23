import { describe, expect, test } from 'bun:test';
import type { Txn } from '@/lib/transactions';
import { cashPosition, type ForecastInstitution } from '@/lib/forecast';
import { summarize } from '@/lib/totals';
import type { PlannedItem } from '@/lib/planned';
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
} from '@/lib/report/runway';
import { detectRecurring } from '@/lib/recurring';

// The runway's pure core (lib/report/runway.ts), held to a case worked out by
// hand: which months its spending is read over, the shared spending rule
// (transfers, exclusions, loan payments and another currency left out), the
// one-offs said, the loan's payment the forecast holds that the spending rule
// leaves out, a planned expense and planned income, income on, off and
// stopping on a day, spending lower by an amount, and the day it runs out,
// to the day. Its own clock: today is passed in, never read.

const TODAY = '2026-10-22';

function row(id: string, date: string, amount: number, over: Partial<Txn> = {}): Txn {
  return {
    transaction_id: id,
    date,
    name: id,
    amount,
    pending: false,
    account_name: 'Checking',
    account_type: 'depository',
    institution_name: 'Chase',
    category: 'general merchandise',
    iso_currency_code: 'USD',
    unofficial_currency_code: null,
    vendor_key: id,
    logo_url: null,
    category_icon_url: null,
    subcategory: null,
    category_confidence: null,
    transaction_code: null,
    payment_channel: null,
    datetime: null,
    website: null,
    check_number: null,
    account_owner: null,
    city: null,
    region: null,
    counterparty: null,
    payment_processor: null,
    payment_reference: null,
    ...over,
  };
}

/**
 * Three months, July to September 2026 (92 days), by hand:
 *   money out that counts: rent 3 x 1,500 + groceries 9 x 300 + a car repair
 *   of 2,000 = 9,200.00, so 100.00 a day exactly;
 *   money in that counts: pay 3 x 2,000 + a refund of 440 = 6,440.00, so
 *   70.00 a day exactly;
 *   left out: a TV the person excluded, a move to savings, cash taken out,
 *   the mortgage's 800 a month (a loan payment, a transfer to every total),
 *   and a meal in euros.
 * The mortgage is paid from checking on the 5th, from April on: detection
 * finds it, and it is next due on Nov 5.
 */
const ROWS: Txn[] = [
  ...['07', '08', '09'].map((m) => row(`rent-${m}`, `2026-${m}-01`, 1500, { name: 'Landlord', vendor_key: 'landlord', category: 'rent and utilities' })),
  ...['07-03', '07-10', '07-24', '08-07', '08-14', '08-28', '09-04', '09-11', '09-25'].map((d) => row(`groceries-${d}`, `2026-${d}`, 300, { name: 'Grocer', vendor_key: 'grocer', category: 'food and drink' })),
  row('repair', '2026-08-15', 2000, { name: 'Midas', vendor_key: 'midas' }),
  ...['07', '08', '09'].map((m) => row(`pay-${m}`, `2026-${m}-15`, -2000, { name: 'Employer', vendor_key: 'employer', category: 'income' })),
  row('refund', '2026-08-20', -440, { name: 'Shop refund', vendor_key: 'shop' }),
  row('tv', '2026-07-20', 1200, { name: 'TV store', vendor_key: 'tv', excluded: true }),
  row('to-savings', '2026-08-02', 1000, { name: 'To savings', category: 'transfer out', transaction_code: 'transfer' }),
  row('atm', '2026-09-02', 200, { name: 'ATM', transaction_code: 'atm' }),
  row('paris', '2026-09-20', 90, { name: 'Bistro', iso_currency_code: 'EUR', category: 'food and drink' }),
  ...['04', '05', '06', '07', '08', '09', '10'].map((m) => row(`mortgage-${m}`, `2026-${m}-05`, 800, { name: 'Home Loans', vendor_key: 'homeloans', category: 'loan payments' })),
];

/** 12,000.00 of cash: checking and savings at Chase. */
const START = 12000;

const PLANNED: PlannedItem[] = [
  { id: 'reg', name: 'Car registration', kind: 'expense', amount: 300, currency: 'USD', date: '2026-12-01', cadence: 'once' },
  { id: 'refund', name: 'Tax refund', kind: 'income', amount: 1000, currency: 'USD', date: '2027-03-15', cadence: 'once' },
  { id: 'euro', name: 'Paris trip', kind: 'expense', amount: 900, currency: 'EUR', date: '2027-01-10', cadence: 'once' },
];

const position = (start = START) => ({ currency: 'USD', balances: start, pending: { amount: 0, count: 0 }, start, included: [], leftOut: [], noBalance: [] });
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
    // The day before it is still at zero.
    const chart = new Map(p.chart.map((c) => [c.date, c]));
    expect(chart.get('2027-01-24')!.without).toBe(-100);
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
    // A day already gone stops nothing more than no income does.
    expect(projectRunway(built(), whatIf({ income_until: '2026-10-01' })).with_income).toEqual(p.without_income);
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

describe('the edges', () => {
  const inputs = (over: Partial<RunwayInputs> = {}): RunwayInputs => ({
    today: TODAY,
    currency: 'USD',
    start: 1000,
    windows: [{ months: 6, start: '2026-04-01', end: '2026-09-30', days: 183, money_out: 0, money_in: 0, transactions: 0, one_offs: [], one_offs_total: 0, left_out: [], left_out_text: null, short: [] }],
    events: [],
    ...over,
  });

  test('below zero now runs out today, lasting no days', () => {
    const p = projectRunway(inputs({ start: -5 }), DEFAULT_WHAT_IF);
    expect(p.without_income).toMatchObject({ runs_out: TODAY, days: 0, months: 0, outcome: 'runs_out', lowest: { date: TODAY, balance: -5 } });
  });

  test('nothing spent and nothing expected is covered; income above spending grows', () => {
    expect(projectRunway(inputs(), DEFAULT_WHAT_IF).without_income).toMatchObject({ runs_out: null, days: null, months: null, outcome: 'covered' });
    const w = inputs().windows[0];
    const p = projectRunway(inputs({ windows: [{ ...w, money_out: 1830, money_in: 3660 }] }), DEFAULT_WHAT_IF);
    expect(p.with_income.outcome).toBe('covered');
    expect(p.without_income.outcome).toBe('runs_out');
    // 10.00 a day: 1,000 lasts 100 days.
    expect(p.without_income).toMatchObject({ days: 100, runs_out: '2027-01-31' });
  });

  test('more than ten years: going down, but not below zero within the horizon', () => {
    const w = inputs().windows[0];
    // 1.83 over 183 days is 0.01 a day: 1,000 lasts 100,000 days.
    const p = projectRunway(inputs({ windows: [{ ...w, money_out: 1.83 }] }), DEFAULT_WHAT_IF);
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
