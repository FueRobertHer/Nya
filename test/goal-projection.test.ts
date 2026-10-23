import { describe, expect, test } from 'bun:test';
import {
  addMonths,
  flowsFromBalances,
  flowsFromRows,
  isGrowth,
  lastDay,
  measuredRate,
  monthDiff,
  project,
  shouldHave,
  trailingMonths,
  MAX_PROJECTED_MONTHS,
  type AccountFlow,
  type FlowRow,
} from '@/lib/goal-projection';

// The projection of a goal (#42), checked against figures worked out by hand:
// what went in each month, the trailing average, the month it is reached in,
// and what a target date needs. Every amount is in cents, as money is.

const TODAY = '2026-10-10';
const MONTHS = trailingMonths(TODAY.slice(0, 7)); // Jul, Aug, Sep 2026
const SAV = new Set(['acc_sav']);

const row = (date: string, amount: number, over: Partial<FlowRow> = {}): FlowRow => ({ date, amount, pending: false, account_id: 'acc_sav', ...over });

/** A known history: Plaid's sign, so money in is negative. */
const HISTORY: FlowRow[] = [
  row('2026-06-28', -999), // before the months averaged
  row('2026-07-03', -250), // a transfer in from checking: a contribution
  row('2026-07-15', -125.5),
  row('2026-07-31', -1.23, { subcategory: 'interest earned' }),
  row('2026-08-03', -250),
  row('2026-08-20', 60.25), // money taken out
  row('2026-08-31', -1.27, { subcategory: 'interest earned' }),
  row('2026-09-03', -250),
  row('2026-09-18', -80.1),
  row('2026-09-30', -1.31, { subcategory: 'interest earned' }),
  row('2026-09-29', -999, { pending: true }), // not posted yet
  row('2026-08-10', -500, { account_id: 'acc_chk' }), // another account
  row('2026-10-03', -250), // this month: not complete, not averaged
];

describe('months', () => {
  test('the trailing complete months, oldest first, across a year', () => {
    expect(trailingMonths('2026-10')).toEqual(['2026-07', '2026-08', '2026-09']);
    expect(trailingMonths('2026-02')).toEqual(['2025-11', '2025-12', '2026-01']);
    expect(addMonths('2026-11', 3)).toBe('2027-02');
    expect(addMonths('2026-01', -1)).toBe('2025-12');
    expect(addMonths('2026-10', 9)).toBe('2027-07');
    expect(monthDiff('2026-10', '2027-03')).toBe(5);
    expect(monthDiff('2026-10', '2026-09')).toBe(-1);
    expect(lastDay('2026-02')).toBe('2026-02-28');
    expect(lastDay('2028-02')).toBe('2028-02-29');
  });
});

describe('contributions from transactions', () => {
  test('each month’s net money in, transfers in counted, interest apart, pending and other accounts left out', () => {
    const flows = flowsFromRows(HISTORY, SAV, MONTHS, { start: '2026-01-02', currency: 'USD' });
    expect(flows).toEqual([
      { month: '2026-07', amount: 375.5, growth: 1.23 },
      { month: '2026-08', amount: 189.75, growth: 1.27 },
      { month: '2026-09', amount: 330.1, growth: 1.31 },
    ]);
  });

  test('the average of the three months, to the cent, with the interest it left out', () => {
    const flow: AccountFlow = { source: 'transactions', months: flowsFromRows(HISTORY, SAV, MONTHS, { start: '2026-01-02', currency: 'USD' }) };
    // (375.50 + 189.75 + 330.10) / 3 = 895.35 / 3 = 298.45
    expect(measuredRate(flow, 'USD')).toEqual({ average: 298.45, months: 3, source: 'transactions', uncertain: false, allUncertain: false, gaps: [], growth: 3.81 });
  });

  test('a month with no rows is zero, but a month before the data begins is unknown, and the first one says it is partial', () => {
    const rows = [row('2026-08-14', -100)];
    const flows = flowsFromRows(rows, SAV, MONTHS, { start: '2026-08-14', currency: 'USD' });
    expect(flows).toEqual([
      { month: '2026-07', amount: null },
      { month: '2026-08', amount: 100, gaps: [{ kind: 'begins', on: '2026-08-14' }] },
      { month: '2026-09', amount: 0 },
    ]);
    const rate = measuredRate({ source: 'transactions', months: flows }, 'USD')!;
    expect(rate.average).toBe(50); // (100 + 0) / 2: the known months only
    expect(rate.months).toBe(2);
    expect(rate.uncertain).toBe(true);
  });

  test('rows that begin on the first of a month leave it whole', () => {
    expect(flowsFromRows([row('2026-07-01', -10)], SAV, ['2026-07'], { start: '2026-07-01', currency: 'USD' })).toEqual([{ month: '2026-07', amount: 10 }]);
  });

  test('an earlier id of the same account counts, and nothing comes out as -0', () => {
    const rows = [row('2026-07-05', -20, { account_id: 'acc_old' }), row('2026-07-06', 20)];
    const flows = flowsFromRows(rows, new Set(['acc_sav', 'acc_old']), ['2026-07'], { start: null, currency: 'USD' });
    expect(flows).toEqual([{ month: '2026-07', amount: 0 }]);
    expect(Object.is(flows[0].amount, -0)).toBe(false);
  });

  test('interest and dividends, by Plaid’s category or a row’s own words', () => {
    expect(isGrowth({ subcategory: 'interest earned' })).toBe(true);
    expect(isGrowth({ subcategory: 'dividends' })).toBe(true);
    expect(isGrowth({ category: 'Interest' })).toBe(true);
    expect(isGrowth({ category: 'transfer in', subcategory: 'from savings' })).toBe(false);
    expect(isGrowth({ category: 'interest charge' })).toBe(false);
  });

  test('a category the person or a rule chose wins over Plaid’s label, as everywhere', () => {
    // Plaid calls it interest; the person re-filed it as a transfer in.
    expect(isGrowth({ subcategory: 'interest earned', category: 'income' })).toBe(true);
    expect(isGrowth({ subcategory: 'interest earned', category: 'transfer in', chosen: true })).toBe(false);
    // Filed as interest, it is interest, whatever Plaid said.
    expect(isGrowth({ subcategory: 'deposit', category: 'Interest', chosen: true })).toBe(true);
    const rows = [row('2026-07-03', -500, { subcategory: 'interest earned', category: 'transfer in', chosen: true }), row('2026-07-28', -1.25, { subcategory: 'interest earned', category: 'income' })];
    expect(flowsFromRows(rows, SAV, ['2026-07'], { start: null, currency: 'USD' })).toEqual([{ month: '2026-07', amount: 500, growth: 1.25 }]);
  });

  test('whole units for a currency without cents', () => {
    const rows = [row('2026-07-05', -1000.4), row('2026-07-06', -1000.4)];
    expect(flowsFromRows(rows, SAV, ['2026-07'], { start: null, currency: 'JPY' })).toEqual([{ month: '2026-07', amount: 2001 }]);
  });
});

describe('contributions from recorded balances', () => {
  // Measured balances only: the caller never passes an estimate.
  const points = [
    { date: '2026-06-27', value: 10_000 },
    { date: '2026-06-30', value: 10_050.25 }, // June's end
    { date: '2026-07-31', value: 10_400.75 },
    { date: '2026-08-15', value: 10_900 }, // not in August's last week
    { date: '2026-08-26', value: 10_650.5 }, // the last in August's last week
    { date: '2026-09-30', value: 11_000 },
  ];

  test('the change in the last balance of each month’s last week', () => {
    expect(flowsFromBalances(points, MONTHS, 'USD')).toEqual([
      { month: '2026-07', amount: 350.5 },
      { month: '2026-08', amount: 249.75 },
      { month: '2026-09', amount: 349.5 },
    ]);
  });

  test('a month whose end, or the end of the month before, has no recorded balance is unknown, never zero', () => {
    const gappy = points.filter((p) => p.date !== '2026-08-26');
    expect(flowsFromBalances(gappy, MONTHS, 'USD')).toEqual([
      { month: '2026-07', amount: 350.5 },
      { month: '2026-08', amount: null },
      { month: '2026-09', amount: null },
    ]);
    expect(measuredRate({ source: 'balances', months: flowsFromBalances(gappy, MONTHS, 'USD') }, 'USD')).toMatchObject({ average: 350.5, months: 1, source: 'balances' });
    expect(measuredRate({ source: 'balances', months: flowsFromBalances([], MONTHS, 'USD') }, 'USD')).toBeNull();
  });
});

describe('the projection, by hand', () => {
  const measured = measuredRate({ source: 'transactions', months: flowsFromRows(HISTORY, SAV, MONTHS, { start: '2026-01-02', currency: 'USD' }) }, 'USD');
  const base = { target: 5000, saved: 2345.67, measured, shared: false, today: TODAY, currency: 'USD' };

  test('without a date: (5000.00 - 2345.67) / 298.45 = 8.89, so nine more months: July 2027', () => {
    expect(project(base)).toEqual({
      status: 'on_track',
      remaining: 2654.33,
      rate: 298.45,
      rateFrom: 'contributions',
      completion: '2027-07',
      monthsLeft: 9,
      beyond: false,
      needed: null,
      short: null,
      datePassed: false,
    });
  });

  test('a date it can’t make: March 2027 is five months away, so 2654.33 / 5 = 530.87 a month, 232.42 short', () => {
    expect(project({ ...base, targetDate: '2027-03-31' })).toMatchObject({ status: 'behind', needed: 530.87, short: 232.42, completion: '2027-07', datePassed: false });
  });

  test('a date it makes early: December 2027 needs 189.60 a month, 108.85 less than goes in', () => {
    expect(project({ ...base, targetDate: '2027-12-01' })).toMatchObject({ status: 'on_track', needed: 189.6, short: -108.85, completion: '2027-07' });
  });

  test('exactly on time is on track', () => {
    // 2654.33 / 9 = 294.93 needed; 298.45 goes in, done in the ninth month.
    expect(project({ ...base, targetDate: '2027-07-15' })).toMatchObject({ status: 'on_track', completion: '2027-07', needed: 294.93 });
  });

  test('a date that has passed says so, with when it will be reached', () => {
    expect(project({ ...base, targetDate: '2026-06-30' })).toMatchObject({ status: 'behind', datePassed: true, completion: '2027-07', needed: 2654.33 });
  });

  test('met: complete, with nothing left and no projection', () => {
    expect(project({ ...base, saved: 5000 })).toMatchObject({ status: 'complete', remaining: 0, completion: null, rate: null });
    expect(project({ ...base, saved: 5000.01, targetDate: '2026-01-01' })).toMatchObject({ status: 'complete', datePassed: true });
  });

  test('a few cents short is one more month, never a fraction of one', () => {
    expect(project({ ...base, saved: 4999.95 })).toMatchObject({ status: 'on_track', remaining: 0.05, monthsLeft: 1, completion: '2026-11' });
  });

  test('no contributions in three months says so instead of projecting, with or without a monthly target', () => {
    const none = { average: 0, months: 3, source: 'transactions' as const, uncertain: false, allUncertain: false, gaps: [], growth: 0 };
    expect(project({ ...base, measured: none })).toMatchObject({ status: 'no_recent_contributions', completion: null, monthsLeft: null });
    expect(project({ ...base, measured: none, monthlyTarget: 200 })).toMatchObject({ status: 'no_recent_contributions', completion: null });
    // Money taken out: still none, never a date in the past or at infinity.
    expect(project({ ...base, measured: { ...none, average: -120.5 } })).toMatchObject({ status: 'no_recent_contributions', rate: -120.5, completion: null });
  });

  test('months that may all be short never say nothing went in: no rate, or the monthly target', () => {
    const gap = { kind: 'stopped' as const, institution: 'Chase', since: null };
    const short = measuredRate({ source: 'transactions', months: MONTHS.map((month) => ({ month, amount: 0, gaps: [gap] })) }, 'USD')!;
    expect(short).toMatchObject({ average: 0, uncertain: true, allUncertain: true });
    expect(project({ ...base, measured: short })).toMatchObject({ status: 'no_rate', rate: null, completion: null });
    expect(project({ ...base, measured: short, monthlyTarget: 200 })).toMatchObject({ status: 'on_track', rate: 200, rateFrom: 'monthly_target' });
    // Something did come in: a lower bound, used, and said to be uncertain.
    const some = measuredRate({ source: 'transactions', months: MONTHS.map((month) => ({ month, amount: 100, gaps: [gap] })) }, 'USD')!;
    expect(project({ ...base, measured: some })).toMatchObject({ rate: 100, rateFrom: 'contributions' });
    // One month that can say so is enough.
    const one = measuredRate({ source: 'transactions', months: [{ month: MONTHS[0], amount: 0 }, { month: MONTHS[1], amount: 0, gaps: [gap] }] }, 'USD')!;
    expect(one.allUncertain).toBe(false);
    expect(project({ ...base, measured: one }).status).toBe('no_recent_contributions');
  });

  test('with no history, the monthly target is the rate, labelled as such', () => {
    // 2654.33 / 200 = 13.27, so fourteen months: December 2027.
    expect(project({ ...base, measured: null, monthlyTarget: 200 })).toMatchObject({ status: 'on_track', rate: 200, rateFrom: 'monthly_target', monthsLeft: 14, completion: '2027-12' });
    expect(project({ ...base, measured: null })).toMatchObject({ status: 'no_rate', rate: null, completion: null });
  });

  test('history comes first: the monthly target is only the fallback', () => {
    expect(project({ ...base, monthlyTarget: 1000 })).toMatchObject({ rate: 298.45, rateFrom: 'contributions' });
  });

  test('an account other goals share is projected at this goal’s own monthly target, or not at all', () => {
    expect(project({ ...base, shared: true })).toMatchObject({ status: 'no_rate', rate: null });
    expect(project({ ...base, shared: true, monthlyTarget: 300 })).toMatchObject({ status: 'on_track', rate: 300, rateFrom: 'monthly_target', monthsLeft: 9 });
  });

  test('a rate too slow to matter says not within fifty years, never a date centuries out', () => {
    const slow = { average: 0.01, months: 3, source: 'transactions' as const, uncertain: false, allUncertain: false, gaps: [], growth: 0 };
    const p = project({ ...base, measured: slow });
    expect(p).toMatchObject({ beyond: true, completion: null });
    expect(p.monthsLeft).toBeGreaterThan(MAX_PROJECTED_MONTHS);
  });

  test('a currency without cents rounds what is needed up to a whole unit', () => {
    const yen = { average: 30_000, months: 3, source: 'transactions' as const, uncertain: false, allUncertain: false, gaps: [], growth: 0 };
    // 1,000,000 left over 7 months (to May 2027) is 142,857.14, so 142,858 a month.
    expect(project({ target: 1_500_000, saved: 500_000, measured: yen, shared: false, today: TODAY, currency: 'JPY', targetDate: '2027-05-20' })).toMatchObject({
      needed: 142_858,
      short: 112_858,
      monthsLeft: 34,
    });
  });
});

describe('where it should be by now', () => {
  test('on the line from what it held when the date was set to the target on the date, by days', () => {
    // 282 of 365 days: 1000.00 + 4000.00 × 282 / 365 = 4090.41
    expect(shouldHave({ date: '2026-01-01', amount: 1000 }, 5000, '2027-01-01', TODAY, 'USD')).toBe(4090.41);
  });

  test('the start before it begins, the target once the date has passed', () => {
    expect(shouldHave({ date: '2026-10-10', amount: 1000 }, 5000, '2027-01-01', '2026-10-01', 'USD')).toBe(1000);
    expect(shouldHave({ date: '2026-01-01', amount: 1000 }, 5000, '2026-06-01', TODAY, 'USD')).toBe(5000);
  });

  test('nothing to show without a date, a start, a known start, or with a start already at the target', () => {
    expect(shouldHave(undefined, 5000, '2027-01-01', TODAY, 'USD')).toBeNull();
    expect(shouldHave({ date: '2026-01-01', amount: null }, 5000, '2027-01-01', TODAY, 'USD')).toBeNull();
    expect(shouldHave({ date: '2026-01-01', amount: 1000 }, 5000, undefined, TODAY, 'USD')).toBeNull();
    expect(shouldHave({ date: '2026-01-01', amount: 6000 }, 5000, '2027-01-01', TODAY, 'USD')).toBeNull();
  });
});
