import { describe, expect, test } from 'bun:test';
import { addMonths, calendarMonth, duePayments, monthDays, monthWeeks, upcomingDays, type CalendarTxn, type UpcomingDay } from '@/lib/calendar';
import { addDays, detectRecurring, scheduleDates, type RecurringRow } from '@/lib/recurring';
import type { PlannedItem } from '@/lib/planned';
import { ecbTable } from './fx-fixture';

// The calendar's month (lib/calendar.ts): its grid, each day's posted
// transactions and what is expected from today, and the two figures a day
// carries, never added together.

// On the checking account unless a test says otherwise: the expected figure
// counts what the forecast counts.
const row = (date: string, amount: number, over: Partial<RecurringRow> = {}): RecurringRow => ({
  date,
  name: 'Netflix',
  amount,
  institution_name: 'Chase',
  account_name: 'Checking',
  account_type: 'depository',
  category: 'entertainment',
  transaction_code: null,
  iso_currency_code: 'USD',
  ...over,
});
const monthly = (from: string, count: number, day: number) => scheduleDates({ unit: 'month', every: 1, days: [day], month: from, slot: 0 }, '2100-01-01', count);
const txn = (over: Partial<CalendarTxn>): CalendarTxn => ({ transaction_id: 't', date: '2026-10-05', name: 'Shop', amount: 10, pending: false, iso_currency_code: 'USD', ...over });

describe('the grid', () => {
  test('a week a row, Sunday first, padded at both ends', () => {
    // October 2026 starts on a Thursday and has 31 days.
    const weeks = monthWeeks('2026-10');
    expect(weeks).toHaveLength(5);
    expect(weeks[0]).toEqual([null, null, null, null, '2026-10-01', '2026-10-02', '2026-10-03']);
    expect(weeks[4]).toEqual(['2026-10-25', '2026-10-26', '2026-10-27', '2026-10-28', '2026-10-29', '2026-10-30', '2026-10-31']);
    // February 2026 starts on a Sunday: four full weeks.
    expect(monthWeeks('2026-02')).toHaveLength(4);
    expect(monthWeeks('2026-02')[0][0]).toBe('2026-02-01');
    // A leap February has its 29th.
    expect(monthDays('2028-02')).toHaveLength(29);
    expect(monthWeeks('2028-02').flat().filter(Boolean)).toHaveLength(29);
  });

  test('months step across a year end', () => {
    expect(addMonths('2026-12', 1)).toBe('2027-01');
    expect(addMonths('2026-01', -1)).toBe('2025-12');
    expect(addMonths('2026-10', 14)).toBe('2027-12');
  });
});

describe('a day\'s entries and figures', () => {
  const series = () => [
    ...detectRecurring(monthly('2026-04', 6, 12).map((d) => row(d, 15.49))),
    ...detectRecurring(monthly('2026-04', 6, 15).map((d) => row(d, -2500, { name: 'Payroll', category: 'income' }))),
    ...detectRecurring(monthly('2026-04', 6, 15).map((d) => row(d, 9, { name: 'Cloud', iso_currency_code: 'EUR' }))),
  ];
  const planned: PlannedItem[] = [{ id: 'p1', name: 'Car registration', kind: 'expense', amount: 212.5, currency: 'USD', date: '2026-10-20', cadence: 'once' }];
  const month = (over: Partial<Parameters<typeof calendarMonth>[0]> = {}) =>
    calendarMonth({ month: '2026-10', today: '2026-10-09', txns: [], series: series(), planned, currency: 'USD', ...over });

  test('a past day: what posted, as the Activity tab counts it, in one currency', () => {
    const m = month({
      txns: [
        txn({ transaction_id: 'a', amount: 40 }),
        txn({ transaction_id: 'b', amount: -100, name: 'Refund' }),
        txn({ transaction_id: 'c', amount: 25, excluded: true }),
        txn({ transaction_id: 'd', amount: 3000, iso_currency_code: 'JPY' }),
        txn({ transaction_id: 'e', amount: 5, pending: true }),
      ],
    });
    const day = m.days.get('2026-10-05')!;
    expect(day.posted).toBe(55);
    expect(day.expected).toBeNull();
    expect(day.entries.map((e) => [e.ref, e.amount, !!e.uncounted])).toEqual([
      ['a', -40, false],
      ['b', 100, false],
      ['c', -25, true],
      ['d', -3000, true],
      ['e', -5, false],
    ]);
    expect(day.entries.find((e) => e.ref === 'e')!.pending).toBe(true);
  });

  test('from today on: the bills, income and planned items expected, the late one today', () => {
    const m = month({ today: '2026-10-14' });
    // Netflix was due on the 12th: two days late, so expected today.
    const today = m.days.get('2026-10-14')!;
    expect(today.entries.map((e) => [e.name, e.amount, e.late ?? false, e.due])).toEqual([['Netflix', -15.49, true, '2026-10-12']]);
    expect(today.expected).toBe(-15.49);
    // Payroll in and the EUR bill on the 15th: only the one in the figure's currency is added.
    const fifteenth = m.days.get('2026-10-15')!;
    expect(fifteenth.entries.map((e) => [e.name, e.amount, !!e.uncounted])).toEqual([
      ['Payroll', 2500, false],
      ['Cloud', -9, true],
    ]);
    expect(fifteenth.expected).toBe(2500);
    expect(m.days.get('2026-10-20')!.entries.map((e) => [e.source, e.name])).toEqual([['planned', 'Car registration']]);
    // Nothing is expected on a day gone by.
    expect(m.days.get('2026-10-12')!.entries).toEqual([]);
  });

  test('a day with both keeps the two figures apart', () => {
    const m = month({ today: '2026-10-12', txns: [txn({ date: '2026-10-12', amount: 6.5, name: 'Coffee' })] });
    const day = m.days.get('2026-10-12')!;
    expect(day.posted).toBe(-6.5);
    expect(day.expected).toBe(-15.49);
  });

  test('a month gone by has only what posted; one ahead only what is expected', () => {
    const past = calendarMonth({ month: '2026-09', today: '2026-10-09', txns: [txn({ date: '2026-09-12', amount: 15.49 })], series: series(), planned, currency: 'USD' });
    expect([...past.days.values()].flatMap((d) => d.entries.map((e) => e.kind))).toEqual(['posted']);
    const ahead = calendarMonth({ month: '2026-12', today: '2026-10-09', txns: [], series: series(), planned, currency: 'USD' });
    expect([...ahead.days.values()].flatMap((d) => d.entries.map((e) => `${e.date} ${e.name}`))).toEqual([
      '2026-12-12 Netflix',
      '2026-12-15 Payroll',
      '2026-12-15 Cloud',
    ]);
  });

  test('what the forecast leaves out is listed with why, never added: a card\'s charge, an account of unknown type, varying pay', () => {
    const card = detectRecurring(monthly('2026-04', 6, 18).map((d) => row(d, 10.99, { name: 'Spotify', account_name: 'Sapphire', account_type: 'credit' })));
    const unknown = detectRecurring(monthly('2026-04', 6, 18).map((d) => row(d, 40, { name: 'Gym', account_name: '', account_type: null })));
    const gigs = [800, 2900, 1200, 2600, 900, 3000, 1100, 2500, 950, 2800, 1000, 2700];
    const varies = detectRecurring(gigs.map((a, i) => row(scheduleDates({ unit: 'day', every: 14, start: '2026-04-24' }, '2100-01-01', 12)[i], -a, { name: 'Gig pay', category: 'income' })));
    const m = calendarMonth({ month: '2026-10', today: '2026-10-09', txns: [], series: [...card, ...unknown, ...varies], planned: [], currency: 'USD' });
    const day = m.days.get('2026-10-18')!;
    expect(day.entries.map((e) => [e.name, e.off, e.account, e.accountType])).toEqual([
      ['Gym', 'unknown-account', undefined, null],
      ['Spotify', 'not-cash', 'Sapphire', 'credit'],
    ]);
    expect(day.expected).toBeNull();
    expect(m.days.get('2026-10-09')!.entries.map((e) => [e.name, e.off])).toEqual([['Gig pay', 'varies']]);
    expect(m.days.get('2026-10-09')!.expected).toBeNull();
  });

  test("figures are added in the currency's own minor unit", () => {
    const kwd = calendarMonth({
      month: '2026-10',
      today: '2026-10-09',
      txns: [txn({ amount: 10.125, iso_currency_code: 'KWD' }), txn({ transaction_id: 'u', amount: 0.001, iso_currency_code: 'KWD' })],
      series: [],
      planned: [],
      currency: 'KWD',
    });
    expect(kwd.days.get('2026-10-05')!.posted).toBe(-10.126);
  });

  test('a dismissed series isn\'t on it', () => {
    const s = series();
    const m = calendarMonth({ month: '2026-10', today: '2026-10-09', txns: [], series: s, planned: [], dismissed: new Set([s[0].id]), currency: 'USD' });
    expect([...m.days.values()].flatMap((d) => d.entries.map((e) => e.name))).not.toContain('Netflix');
  });

  test('a card\'s payment due is marked on its day and never added', () => {
    const dues = duePayments([
      {
        institution_name: 'Chase',
        accounts: [
          { account_id: 'card', name: 'Sapphire', type: 'credit', currency: 'USD', liability: { minimum_payment: 35, next_due_date: '2026-10-22' } },
          { account_id: 'old', name: 'Old card', type: 'credit', currency: 'USD', hidden: true, liability: { minimum_payment: 25, next_due_date: '2026-10-23' } },
          { account_id: 'chk', name: 'Checking', type: 'depository', currency: 'USD' },
          { account_id: 'loan', name: 'Car loan', type: 'loan', currency: 'USD', liability: { minimum_payment: null, next_due_date: '2026-10-02' } },
        ],
      },
    ]);
    expect(dues.map((d) => d.account_id)).toEqual(['card', 'loan']);
    const m = month({ dues, planned: [] });
    const day = m.days.get('2026-10-22')!;
    expect(day.entries).toEqual([{ kind: 'due', date: '2026-10-22', name: 'Sapphire', amount: -35, currency: 'USD', ref: 'card', uncounted: true }]);
    expect(day.expected).toBeNull();
    // A due date already gone by isn't shown as coming.
    expect(m.days.get('2026-10-02')!.entries).toEqual([]);
  });
});

describe("Upcoming's list: the calendar's days from today to the range's end", () => {
  const series = () => [
    ...detectRecurring(monthly('2026-04', 6, 12).map((d) => row(d, 15.49))),
    ...detectRecurring(monthly('2026-04', 6, 15).map((d) => row(d, -2500, { name: 'Payroll', category: 'income' }))),
    ...detectRecurring(monthly('2026-04', 6, 15).map((d) => row(d, 9, { name: 'Cloud', iso_currency_code: 'EUR' }))),
  ];
  const planned: PlannedItem[] = [{ id: 'p1', name: 'Car registration', kind: 'expense', amount: 212.5, currency: 'USD', date: '2026-10-20', cadence: 'once' }];
  const dues = duePayments([
    {
      institution_name: 'Chase',
      accounts: [
        { account_id: 'card', name: 'Sapphire', type: 'credit', currency: 'USD', liability: { minimum_payment: 35, next_due_date: '2026-11-03' } },
        { account_id: 'loan', name: 'Car loan', type: 'loan', currency: 'USD', liability: { minimum_payment: null, next_due_date: '2026-10-02' } },
      ],
    },
  ]);
  type Opts = Parameters<typeof upcomingDays>[0];
  const upcoming = (over: Partial<Opts> = {}) => upcomingDays({ today: '2026-10-14', until: addDays('2026-10-14', 30), series: series(), planned, dues, currency: 'USD', ...over });
  /** What the calendar shows on the same days: every month the range spans,
   *  each read as the calendar reads it, paged to one by one. */
  const calendar = (o: Opts): UpcomingDay[] => {
    const months: string[] = [];
    for (let m = o.today.slice(0, 7); m <= o.until.slice(0, 7); m = addMonths(m, 1)) months.push(m);
    return months
      .flatMap((month) => [...calendarMonth({ month, today: o.today, txns: [], series: o.series, planned: o.planned, dismissed: o.dismissed, dues: o.dues, currency: o.currency, fx: o.fx }).days.values()])
      .filter((d) => d.date >= o.today && d.date <= o.until && d.entries.length > 0)
      .map((d) => ({ date: d.date, entries: d.entries, expected: d.expected }));
  };

  test("the same entries and figures as the calendar, across a month's end, the late one today", () => {
    const opts: Opts = { today: '2026-10-14', until: '2026-11-13', series: series(), planned, dues, currency: 'USD' };
    const days = upcomingDays(opts);
    expect(days).toEqual(calendar(opts));
    expect(days.map((d) => [d.date, d.entries.map((e) => e.name), d.expected])).toEqual([
      // Netflix was due on the 12th: two days late, so expected today.
      ['2026-10-14', ['Netflix'], -15.49],
      ['2026-10-15', ['Payroll', 'Cloud'], 2500],
      ['2026-10-20', ['Car registration'], -212.5],
      // Past the month's end, and the card's payment, listed but never in the figure.
      ['2026-11-03', ['Sapphire'], null],
      ['2026-11-12', ['Netflix'], -15.49],
    ]);
    expect(days[0].entries[0]).toMatchObject({ late: true, due: '2026-10-12' });
    expect(days[3].entries).toEqual([{ kind: 'due', date: '2026-11-03', name: 'Sapphire', amount: -35, currency: 'USD', ref: 'card', uncounted: true }]);
  });

  test("the range's last day is in it, the day after isn't, and nothing before today is", () => {
    expect(upcoming({ until: '2026-11-12' }).at(-1)!.date).toBe('2026-11-12');
    expect(upcoming({ until: '2026-11-11' }).at(-1)!.date).toBe('2026-11-03');
    // The loan's payment was due on the 2nd: gone by, not listed.
    expect(upcoming().flatMap((d) => d.entries.map((e) => e.ref))).not.toContain('loan');
    expect(upcoming().every((d) => d.date >= '2026-10-14')).toBe(true);
    expect(upcoming({ until: '2026-10-13' })).toEqual([]);
  });

  test('ninety days ahead: four months read, across a year end, entry for entry as the calendar, each once', () => {
    const opts: Opts = { today: '2026-10-14', until: addDays('2026-10-14', 90), series: series(), planned, dues, currency: 'USD' };
    const days = upcomingDays(opts);
    expect(days).toEqual(calendar(opts));
    expect(days.map((d) => d.date)).toEqual([
      '2026-10-14',
      '2026-10-15',
      '2026-10-20',
      '2026-11-03',
      '2026-11-12',
      '2026-11-15',
      '2026-12-12',
      '2026-12-15',
      '2027-01-12',
    ]);
    expect(new Set(days.map((d) => d.date)).size).toBe(days.length);
    // Sixty days, the middle range, the same way.
    const sixty: Opts = { ...opts, until: addDays('2026-10-14', 60) };
    expect(upcomingDays(sixty)).toEqual(calendar(sixty));
    expect(upcomingDays(sixty).at(-1)!.date).toBe('2026-12-12');
  });

  test('from mid December, into the next year', () => {
    // Seen through November, so still expected: the bill on the 12th two days late today.
    const recent = [
      ...detectRecurring(monthly('2026-06', 6, 12).map((d) => row(d, 15.49))),
      ...detectRecurring(monthly('2026-06', 6, 15).map((d) => row(d, -2500, { name: 'Payroll', category: 'income' }))),
    ];
    const fee: PlannedItem = { id: 'p2', name: 'Renewal', kind: 'expense', amount: 99, currency: 'USD', date: '2027-01-02', cadence: 'once' };
    const due = duePayments([
      { institution_name: 'Chase', accounts: [{ account_id: 'card', name: 'Sapphire', type: 'credit', currency: 'USD', liability: { minimum_payment: 35, next_due_date: '2027-01-05' } }] },
    ]);
    const opts: Opts = { today: '2026-12-14', until: addDays('2026-12-14', 30), series: recent, planned: [fee], dues: due, currency: 'USD' };
    expect(opts.until).toBe('2027-01-13');
    const days = upcomingDays(opts);
    expect(days).toEqual(calendar(opts));
    expect(days.map((d) => [d.date, d.entries.map((e) => e.name)])).toEqual([
      ['2026-12-14', ['Netflix']],
      ['2026-12-15', ['Payroll']],
      ['2027-01-02', ['Renewal']],
      ['2027-01-05', ['Sapphire']],
      ['2027-01-12', ['Netflix']],
    ]);
    expect(days[0].entries[0]).toMatchObject({ late: true, due: '2026-12-12' });
  });

  test("a range that ends on a month's 1st reads that month for its one day", () => {
    const first: PlannedItem[] = [
      { id: 'p3', name: 'Tuition', kind: 'expense', amount: 800, currency: 'USD', date: '2026-11-01', cadence: 'once' },
      { id: 'p4', name: 'Insurance', kind: 'expense', amount: 120, currency: 'USD', date: '2026-11-02', cadence: 'once' },
    ];
    const opts: Opts = { today: '2026-10-14', until: '2026-11-01', series: series(), planned: first, dues, currency: 'USD' };
    const days = upcomingDays(opts);
    expect(days).toEqual(calendar(opts));
    expect(days.at(-1)).toEqual({ date: '2026-11-01', entries: [expect.objectContaining({ name: 'Tuition', amount: -800 })], expected: -800 });
    expect(days.flatMap((d) => d.entries.map((e) => e.name))).not.toContain('Insurance');
  });

  test('a today in a month with nothing in it: the first entries are next month', () => {
    const later: PlannedItem[] = [{ id: 'p5', name: 'Gym', kind: 'expense', amount: 45, currency: 'USD', date: '2026-11-03', cadence: 'monthly' }];
    const opts: Opts = { today: '2026-10-25', until: addDays('2026-10-25', 60), series: [], planned: later, currency: 'USD' };
    const days = upcomingDays(opts);
    expect(days).toEqual(calendar(opts));
    expect(days.map((d) => [d.date, d.expected])).toEqual([
      ['2026-11-03', -45],
      ['2026-12-03', -45],
    ]);
  });

  test("a series marked not recurring isn't on it", () => {
    const s = series();
    expect(upcoming({ series: s, dismissed: new Set([s[0].id]) }).flatMap((d) => d.entries.map((e) => e.name))).not.toContain('Netflix');
  });

  test('another currency is listed, not added; with a home currency it is converted at the newest rates, as the calendar does', () => {
    const cloud = (o: Partial<Opts>) => upcoming(o).find((d) => d.date === '2026-10-15')!;
    const without = cloud({});
    expect(without.entries.find((e) => e.name === 'Cloud')).toMatchObject({ amount: -9, currency: 'EUR', uncounted: true, off: 'currency' });
    expect(without.expected).toBe(2500);
    const opts: Opts = { today: '2026-10-14', until: '2026-11-13', series: series(), planned, dues, currency: 'USD', fx: ecbTable({ home: 'EUR' }) };
    const withRates = upcomingDays(opts);
    expect(withRates).toEqual(calendar(opts));
    const converted = withRates.find((d) => d.date === '2026-10-15')!;
    // 9 EUR at 1.1551 is $10.40, in the day's figure; still listed in EUR.
    expect(converted.entries.find((e) => e.name === 'Cloud')).toMatchObject({ amount: -9, currency: 'EUR', figure: expect.any(Number) });
    expect(converted.expected).toBe(2500 - 10.4);
  });

  test('nothing expected, nothing listed', () => {
    expect(upcomingDays({ today: '2026-10-14', until: '2026-11-13', series: [], planned: [], currency: 'USD' })).toEqual([]);
  });
});
