import { describe, expect, test } from 'bun:test';
import { addMonths, calendarMonth, duePayments, monthDays, monthWeeks, type CalendarTxn } from '@/lib/calendar';
import { detectRecurring, scheduleDates, type RecurringRow } from '@/lib/recurring';
import type { PlannedItem } from '@/lib/planned';

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
