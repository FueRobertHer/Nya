import { describe, expect, test } from 'bun:test';
import {
  addDays,
  cadenceLabel,
  dayIso,
  dayNumber,
  detectRecurring,
  dismissedSeries,
  expectedDates,
  monthlyFrom,
  olderRowsForDetection,
  perMonth,
  scheduleDates,
  upcomingBills,
  type RecurringRow,
  type RecurringSeries,
} from '@/lib/recurring';

// Recurring bills and income (lib/recurring.ts): each cadence found from the
// kind of sequence a bank really produces (weekend shifts, a skipped month, a
// 31st in a short month), the merchants that must NOT be called bills, and the
// date arithmetic the forecast and the calendar are built on.

function row(date: string, amount: number, over: Partial<RecurringRow> = {}): RecurringRow {
  return {
    date,
    name: 'Netflix',
    amount,
    institution_name: 'Chase',
    category: 'entertainment',
    transaction_code: null,
    iso_currency_code: 'USD',
    ...over,
  };
}

/** 0 is Sunday. */
const weekday = (iso: string) => new Date(`${iso}T00:00:00Z`).getUTCDay();

/** A bank posting a scheduled date that falls on a weekend: on the Monday
 *  after (a bill), or the Friday before (a paycheck). */
function shifted(iso: string, way: 'after' | 'before'): string {
  const w = weekday(iso);
  if (w === 6) return addDays(iso, way === 'after' ? 2 : -1);
  if (w === 0) return addDays(iso, way === 'after' ? 1 : -2);
  return iso;
}

/** `count` months of day `day` (the month's last day when shorter), from
 *  `from` (YYYY-MM). */
function monthly(from: string, count: number, day: number, every = 1): string[] {
  return scheduleDates({ unit: 'month', every, days: [day], month: from, slot: 0 }, '2100-01-01', count);
}

function everyDays(start: string, step: number, count: number): string[] {
  return Array.from({ length: count }, (_, i) => addDays(start, i * step));
}

const only = (rows: RecurringRow[]) => {
  const found = detectRecurring(rows);
  expect(found).toHaveLength(1);
  return found[0];
};

describe('each cadence, from what a bank posts', () => {
  test('monthly, on the 12th, posted on the Monday after a weekend', () => {
    const dates = monthly('2025-10', 12, 12).map((d) => shifted(d, 'after'));
    // A weekend 12th really occurs in this year: the shifts are being tested.
    expect(dates.some((d) => d.slice(8) !== '12')).toBe(true);
    const s = only(dates.map((d) => row(d, 15.49)));
    expect(s.cadence).toBe('monthly');
    expect(s.kind).toBe('bill');
    expect(s.amount).toBe(15.49);
    expect(s.seen).toBe(12);
    expect(s.lastDate).toBe(dates[11]);
    // Expected on the 12th itself: the schedule, not the shifted posting.
    expect(s.nextDate).toBe('2026-10-12');
  });

  test('monthly with a month skipped is still monthly, and still expected the month after', () => {
    const dates = monthly('2025-11', 11, 3).filter((d) => !d.startsWith('2026-04'));
    const s = only(dates.map((d) => row(d, 72.4, { name: 'Comcast', category: 'rent and utilities' })));
    expect(s.cadence).toBe('monthly');
    expect(s.seen).toBe(10);
    expect(s.nextDate).toBe('2026-10-03');
  });

  test('three months with one skipped is enough', () => {
    const s = only(['2026-06-15', '2026-07-15', '2026-09-15'].map((d) => row(d, 9.99)));
    expect(s.cadence).toBe('monthly');
    expect(s.nextDate).toBe('2026-10-15');
  });

  test('weekly, every Tuesday, one posted a day late after a holiday', () => {
    const dates = everyDays('2026-06-02', 7, 16);
    dates[5] = addDays(dates[5], 1);
    const s = only(dates.map((d) => row(d, 59.99, { name: 'HelloFresh', category: 'food and drink' })));
    expect(s.cadence).toBe('weekly');
    expect(s.nextDate).toBe(addDays(dates[15], 7));
    expect(weekday(s.nextDate)).toBe(2);
  });

  test('every two weeks: a paycheck, a Thursday when Friday was a holiday', () => {
    const dates = everyDays('2026-01-09', 14, 20);
    dates[12] = addDays(dates[12], -1);
    const pay = [1843.12, 1843.12, 1851.4, 1843.12, 1838.9];
    const s = only(dates.map((d, i) => row(d, -pay[i % pay.length], { name: 'ACME PAYROLL', category: 'income' })));
    expect(s.kind).toBe('income');
    expect(s.cadence).toBe('biweekly');
    expect(s.amount).toBe(1843.12);
    expect(s.nextDate).toBe(addDays(dates[19], 14));
  });

  test('twice a month on the 1st and the 15th, paid the Friday before a weekend', () => {
    const dates = scheduleDates({ unit: 'month', every: 1, days: [1, 15], month: '2026-03', slot: 0 }, '2026-09-30').map((d) =>
      shifted(d, 'before')
    );
    // Some fall back into the month before: Aug 1, 2026 is a Saturday.
    expect(dates).toContain('2026-07-31');
    const s = only(dates.map((d) => row(d, -2100, { name: 'Payroll', category: 'income' })));
    expect(s.cadence).toBe('semimonthly');
    expect(s.schedule).toMatchObject({ unit: 'month', every: 1, days: [1, 15] });
    expect(s.nextDate).toBe('2026-10-01');
    expect(scheduleDates(s.schedule, '2026-11-30')).toEqual(['2026-10-01', '2026-10-15', '2026-11-01', '2026-11-15']);
  });

  test('twice a month on the 15th and the last day', () => {
    const dates = scheduleDates({ unit: 'month', every: 1, days: [15, 31], month: '2026-01', slot: 0 }, '2026-06-30');
    const s = only(dates.map((d) => row(d, -1500, { name: 'Payroll', category: 'income' })));
    expect(s.cadence).toBe('semimonthly');
    expect(s.schedule).toMatchObject({ days: [15, 31] });
    expect(scheduleDates(s.schedule, '2026-09-30')).toEqual(['2026-07-15', '2026-07-31', '2026-08-15', '2026-08-31', '2026-09-15', '2026-09-30']);
  });

  test('every four weeks is not monthly: thirteen a year', () => {
    const dates = everyDays('2025-11-06', 28, 12);
    const s = only(dates.map((d) => row(d, 42, { name: 'Gym', category: 'personal care' })));
    expect(s.cadence).toBe('four-weekly');
    expect(s.nextDate).toBe(addDays(dates[11], 28));
  });

  test('every two months, a water bill', () => {
    const dates = monthly('2025-10', 6, 20, 2).map((d) => shifted(d, 'after'));
    const s = only(dates.map((d) => row(d, 88.1, { name: 'City Water', category: 'rent and utilities' })));
    expect(s.cadence).toBe('bimonthly');
    expect(s.nextDate).toBe('2026-10-20');
  });

  test('every three months, an insurance premium', () => {
    const dates = monthly('2025-10', 4, 28, 3);
    const s = only(dates.map((d) => row(d, 312, { name: 'State Farm', category: 'general services' })));
    expect(s.cadence).toBe('quarterly');
    expect(s.nextDate).toBe('2026-10-28');
  });

  test('twice a year, from two premiums, and from four', () => {
    const two = only(['2026-01-10', '2026-07-10'].map((d) => row(d, 640, { name: 'Progressive', category: 'general services' })));
    expect(two.cadence).toBe('semiannual');
    expect(two.nextDate).toBe('2027-01-10');
    const four = only(['2024-07-12', '2025-01-10', '2025-07-11', '2026-01-09'].map((d) => row(d, 655, { name: 'Progressive' })));
    expect(four.cadence).toBe('semiannual');
    expect(four.seen).toBe(4);
  });

  test('yearly, from two renewals a year apart at exactly the same price', () => {
    const s = only([row('2024-11-03', 139, { name: 'Amazon Prime' }), row('2025-11-02', 139, { name: 'Amazon Prime' })]);
    expect(s.cadence).toBe('yearly');
    expect(s.amount).toBe(139);
    expect(s.nextDate).toBe('2026-11-02');
  });

  test('two renewals are too little for a yearly charge at a raised price, or at a restaurant', () => {
    expect(detectRecurring([row('2024-11-03', 119, { name: 'Amazon Prime' }), row('2025-11-02', 139, { name: 'Amazon Prime' })])).toEqual([]);
    // Within 2% isn't the same amount for two: two visits a year apart.
    expect(detectRecurring([row('2025-04-23', 268.9, { name: 'Shop 1292' }), row('2025-10-22', 269.22, { name: 'Shop 1292' })])).toEqual([]);
    // Even at the same amount, a restaurant or a gas station is chance.
    for (const category of ['food and drink', 'transportation'])
      expect(detectRecurring([row('2025-03-10', 64, { name: 'Nopa', category }), row('2026-03-12', 64, { name: 'Nopa', category })])).toEqual([]);
    // Twice a year from two, with nothing else from the merchant between.
    expect(only([row('2026-01-10', 640, { name: 'Progressive', category: 'general services' }), row('2026-07-10', 640, { name: 'Progressive', category: 'general services' })]).cadence).toBe('semiannual');
    expect(detectRecurring([row('2026-01-10', 640, { name: 'Progressive' }), row('2026-04-02', 35, { name: 'Progressive' }), row('2026-07-10', 640, { name: 'Progressive' })])).toEqual([]);
  });

  test('a cadence is labelled, and comes to a monthly figure', () => {
    expect(cadenceLabel('biweekly')).toBe('Every 2 weeks');
    expect(cadenceLabel('semimonthly')).toBe('Twice a month');
    expect(perMonth({ amount: 12, cadence: 'monthly' })).toBeCloseTo(12, 10);
    expect(perMonth({ amount: 120, cadence: 'yearly' })).toBeCloseTo(10, 10);
    expect(perMonth({ amount: 10, cadence: 'weekly' })).toBeCloseTo((10 * 365.25) / 12 / 7, 10);
    expect(perMonth({ amount: 100, cadence: 'semimonthly' })).toBeCloseTo(200, 10);
  });
});

describe('what is not a bill', () => {
  test('a grocery store visited every week at varying amounts', () => {
    const amounts = [82.13, 140.7, 66.2, 118.45, 95.1, 151.33, 72.9, 128.6, 101.2, 88.75, 160.05, 79.4];
    const rows = everyDays('2026-06-06', 7, 12).map((d, i) => row(d, amounts[i], { name: "Trader Joe's", category: 'food and drink' }));
    expect(detectRecurring(rows)).toEqual([]);
  });

  test('a coffee shop most weekdays, at the same price', () => {
    const rows: RecurringRow[] = [];
    for (let d = dayNumber('2026-04-01'); d < dayNumber('2026-10-01'); d++) {
      const iso = addDays('1970-01-01', d);
      if (weekday(iso) !== 0 && weekday(iso) !== 6 && d % 3 !== 0) rows.push(row(iso, 4.75, { name: 'Blue Bottle', category: 'food and drink' }));
    }
    expect(detectRecurring(rows)).toEqual([]);
  });

  test("a doctor's copay at no regular interval", () => {
    const rows = ['2025-11-04', '2026-01-22', '2026-02-09', '2026-05-30', '2026-08-14'].map((d) => row(d, 30, { name: 'City Clinic', category: 'medical' }));
    expect(detectRecurring(rows)).toEqual([]);
  });

  test('a restaurant visited at random, however well its last visits line up', () => {
    // The last three are a month apart, but the visits before them kept no
    // schedule, so this is not a schedule that changed.
    const rows = ['2026-02-11', '2026-03-27', '2026-04-03', '2026-07-01', '2026-08-01', '2026-09-01'].map((d) =>
      row(d, 48, { name: 'Nopa', category: 'food and drink' })
    );
    expect(detectRecurring(rows)).toEqual([]);
  });

  test('two charges are not a monthly bill yet, and a pending one does not count', () => {
    expect(detectRecurring(['2026-08-03', '2026-09-03'].map((d) => row(d, 15)))).toEqual([]);
    expect(detectRecurring([row('2026-07-03', 15), row('2026-08-03', 15), row('2026-09-03', 15, { pending: true })])).toEqual([]);
  });

  test('money moved between accounts, or excluded, is never a bill or income', () => {
    const dates = monthly('2026-03', 6, 1);
    expect(detectRecurring(dates.map((d) => row(d, 500, { name: 'Transfer to savings', category: 'transfer out' })))).toEqual([]);
    expect(detectRecurring(dates.map((d) => row(d, -500, { name: 'From checking', category: 'transfer in' })))).toEqual([]);
    expect(detectRecurring(dates.map((d) => row(d, 500, { name: 'Online transfer', category: null, transaction_code: 'transfer' })))).toEqual([]);
    expect(detectRecurring(dates.map((d) => row(d, 200, { name: 'ATM', transaction_code: 'atm' })))).toEqual([]);
    // A card payment received on the card's side earns nothing.
    expect(detectRecurring(dates.map((d) => row(d, -350, { name: 'Payment thank you', category: 'loan payments' })))).toEqual([]);
    // Excluded ones are left out: four of six still make a bill.
    const some = dates.map((d, i) => row(d, 15, { excluded: i < 2 ? true : undefined }));
    expect(only(some).seen).toBe(4);
  });

  test('a loan payment and a bank fee are bills, as before', () => {
    const dates = monthly('2026-04', 6, 1);
    expect(only(dates.map((d) => row(d, 1850, { name: 'Mortgage', category: 'loan payments' }))).cadence).toBe('monthly');
    expect(only(dates.map((d) => row(d, 12, { name: 'Maintenance fee', category: 'bank fees', transaction_code: 'bank charge' }))).cadence).toBe('monthly');
  });

  test('a bill whose amount swings is not detected, but one bonus paycheck or prorated bill is forgiven', () => {
    const swings = [60, 180, 75, 160, 90, 140];
    expect(detectRecurring(monthly('2026-04', 6, 9).map((d, i) => row(d, swings[i], { name: 'PG&E' })))).toEqual([]);
    const pay = everyDays('2026-03-06', 14, 12).map((d, i) => row(d, i === 7 ? -4200 : -1900, { name: 'Payroll', category: 'income' }));
    expect(only(pay).amount).toBe(1900);
    const internet = monthly('2026-01', 9, 20).map((d, i) => row(d, i === 0 ? 31.4 : 70, { name: 'Sonic' }));
    expect(only(internet).amount).toBe(70);
  });

  test('a small subscription moved by cents of tax is still one bill', () => {
    const amounts = [10.79, 10.81, 10.79, 10.83, 10.79];
    expect(only(monthly('2026-05', 5, 22).map((d, i) => row(d, amounts[i], { name: 'Spotify' }))).cadence).toBe('monthly');
  });

  test('at the fewest charges, the same amount means exactly the same; a varying amount needs one more', () => {
    const three = (amounts: number[]) => monthly('2026-06', amounts.length, 22).map((d, i) => row(d, amounts[i], { name: 'Joe\'s Deli' }));
    expect(detectRecurring(three([12.45, 12.45, 12.45]))).toHaveLength(1);
    expect(detectRecurring(three([10.79, 10.81, 10.79]))).toEqual([]);
    expect(detectRecurring(three([10.79, 10.81, 10.79, 10.83]))).toHaveLength(1);
    // A phone bill with its taxes: similar, from four.
    expect(detectRecurring(three([64.2, 71.9, 66.4]))).toEqual([]);
    expect(only(three([64.2, 71.9, 66.4, 69.1])).agreement).toBe('similar');
  });
});

describe('the evidence a series is judged on', () => {
  test('a due date moved from the 5th to the 20th is still a monthly bill, expected on the 20th', () => {
    const rows = [...monthly('2025-10', 6, 5), ...monthly('2026-04', 6, 20)].map((d) => row(d, 64.99, { name: 'Verizon' }));
    const s = only(rows);
    expect(s.cadence).toBe('monthly');
    expect(s.nextDate).toBe('2026-10-20');
    expect(s.seen).toBe(6);
  });

  test('a paycheck moved from every two weeks to twice a month', () => {
    const before = everyDays('2025-12-05', 14, 10);
    const after = scheduleDates({ unit: 'month', every: 1, days: [15, 31], month: '2026-05', slot: 0 }, '2026-09-30');
    const s = only([...before, ...after].map((d) => row(d, -2000, { name: 'Payroll', category: 'income' })));
    expect(s.cadence).toBe('semimonthly');
    expect(s.nextDate).toBe('2026-10-15');
  });

  test('a price rise is the amount from then on', () => {
    const rows = monthly('2025-10', 12, 14).map((d, i) => row(d, i < 9 ? 15.49 : 17.99));
    const s = only(rows);
    expect(s.amount).toBe(17.99);
  });

  test('a big price change is the series going on at its new price, never a charge that came "not in yet"', () => {
    // The reviewer's cases: a promotion ending (9.99 to 15.99), insurance 50 to 80.
    const stream = only(monthly('2025-11', 12, 7).map((d, i) => row(d, i >= 10 ? 15.99 : 9.99, { name: 'StreamCo' })));
    expect(stream).toMatchObject({ amount: 15.99, previousAmount: 9.99, seen: 12, lastDate: '2026-10-07', nextDate: '2026-11-07' });
    expect(expectedDates(stream, '2026-10-09', '2026-12-31').status).toBe('due');
    const insure = only(['2026-06-07', '2026-07-07', '2026-08-07', '2026-09-07', '2026-10-07'].map((d, i) => row(d, i < 3 ? 50 : 80, { name: 'InsureCo' })));
    expect(insure).toMatchObject({ amount: 80, previousAmount: 50, nextDate: '2026-11-07' });
    // One charge at a new price: until a second, the series is the old
    // price's, but that charge counts for its date.
    const once = only(monthly('2025-11', 11, 7).map((d, i) => row(d, i === 10 ? 15.99 : 9.99, { name: 'StreamCo' })));
    expect(once).toMatchObject({ amount: 9.99, lastDate: '2026-09-07', nextDate: '2026-10-07' });
    expect(expectedDates(once, '2026-09-20', '2026-10-31')).toEqual({ status: 'due', dates: [{ date: '2026-10-07', due: '2026-10-07', late: false }] });
  });

  test('Apple billing two subscriptions and the odd app is two bills', () => {
    const dates = monthly('2026-01', 9, 7);
    const rows = [
      ...dates.map((d) => row(d, 2.99, { name: 'Apple' })),
      ...dates.map((d) => row(addDays(d, 10), 10.99, { name: 'Apple' })),
      row('2026-03-02', 4.99, { name: 'Apple' }),
      row('2026-06-25', 0.99, { name: 'Apple' }),
    ];
    const found = detectRecurring(rows);
    expect(found.map((s) => [s.cadence, s.amount])).toEqual([
      ['monthly', 10.99],
      ['monthly', 2.99],
    ]);
    expect(new Set(found.map((s) => s.id)).size).toBe(2);
    expect(found.find((s) => s.amount === 2.99)!.nextDate).toBe('2026-10-07');
  });

  test('a gym membership beside the odd smoothie is one bill', () => {
    const rows = [...monthly('2026-01', 9, 1).map((d) => row(d, 40, { name: 'Gym' })), row('2026-02-13', 7.5, { name: 'Gym' }), row('2026-06-20', 7.5, { name: 'Gym' })];
    const s = only(rows);
    expect(s.amount).toBe(40);
    expect(s.seen).toBe(9);
  });

  test('the same subscription at two institutions, or in two currencies, is two', () => {
    const dates = monthly('2026-04', 6, 3);
    const two = detectRecurring([...dates.map((d) => row(d, 15)), ...dates.map((d) => row(d, 15, { institution_name: 'Amex' }))]);
    expect(two.map((s) => s.institution).sort()).toEqual(['Amex', 'Chase']);
    expect(two.every((s) => s.cadence === 'monthly')).toBe(true);
    const currencies = detectRecurring([...dates.map((d) => row(d, 10)), ...dates.map((d) => row(d, 9, { iso_currency_code: 'EUR' }))]);
    expect(currencies.map((s) => [s.amount, s.currency])).toEqual([
      [10, 'USD'],
      [9, 'EUR'],
    ]);
  });

  test('a bill paid a week early is not expected again on top of itself', () => {
    // Due the 20th; October's was paid on the 13th.
    const rows = [...monthly('2026-04', 6, 20), '2026-10-13'].map((d) => row(d, 64.99, { name: 'Verizon' }));
    const s = only(rows);
    expect(s.lastDate).toBe('2026-10-13');
    expect(s.seen).toBe(7);
    expect(s.nextDate).toBe('2026-11-20');
  });

  test('an extra charge is not taken for next month\'s bill paid early', () => {
    // The reviewer's case: a water bill of 50 on the 1st, and a 45 repair fee
    // on Sep 20. October's bill is still expected.
    const water = (extra: [string, number]) =>
      only([...['2026-03-01', '2026-04-01', '2026-05-01', '2026-06-01', '2026-07-01', '2026-08-01', '2026-09-01'].map((d) => row(d, 50, { name: 'City Water' })), row(extra[0], extra[1], { name: 'City Water' })]);
    for (const extra of [
      ['2026-09-20', 45],
      // At the bill's own amount, but eleven days early: more than twice the tolerance.
      ['2026-09-20', 50],
      // Early by more than the tolerance, at another amount.
      ['2026-09-25', 45],
    ] as [string, number][]) {
      const s = water(extra);
      expect(s.nextDate).toBe('2026-10-01');
      expect(expectedDates(s, '2026-09-25', '2026-11-24').dates.map((d) => d.date)).toEqual(['2026-10-01', '2026-11-01']);
    }
    // Six days early at its amount, with nothing else: paid early.
    expect(water(['2026-09-25', 50]).nextDate).toBe('2026-11-01');
    // Within the tolerance it is on time, whatever its amount: that date's.
    expect(water(['2026-09-28', 45]).nextDate).toBe('2026-11-01');
  });

  test('two cards at one bank are two series, whether charged on one day or two', () => {
    // The reviewer's case: two people, each with Netflix on their own Chase card.
    const months = ['2026-03', '2026-04', '2026-05', '2026-06', '2026-07', '2026-08', '2026-09'];
    const card = (date: string, account_name: string) => row(date, 15.49, { account_name, account_type: 'credit' });
    const sameDay = detectRecurring(months.flatMap((m) => [card(`${m}-05`, 'Card A'), card(`${m}-05`, 'Card B')]));
    expect(sameDay.map((s) => [s.account, s.cadence, s.seen])).toEqual([
      ['Card A', 'monthly', 7],
      ['Card B', 'monthly', 7],
    ]);
    const twoDays = detectRecurring(months.flatMap((m) => [card(`${m}-05`, 'Card A'), card(`${m}-20`, 'Card B')]));
    expect(twoDays.map((s) => [s.account, s.cadence, s.nextDate])).toEqual([
      ['Card A', 'monthly', '2026-10-05'],
      ['Card B', 'monthly', '2026-10-20'],
    ]);
    expect(new Set(twoDays.map((s) => s.id)).size).toBe(2);
  });

  test('a charge still pending counts for its date; a deposit still pending does not', () => {
    const rows = monthly('2026-04', 6, 12).map((d) => row(d, 15.49));
    const s = only([...rows, row('2026-10-12', 15.49, { pending: true })]);
    expect(s).toMatchObject({ lastDate: '2026-10-12', pending: true, seen: 6, nextDate: '2026-11-12' });
    expect(expectedDates(s, '2026-10-14', '2026-11-30').dates.map((d) => d.date)).toEqual(['2026-11-12']);
    // Pending at a new price, from a merchant with one series: still that date's.
    expect(only([...rows, row('2026-10-12', 17.99, { pending: true })]).nextDate).toBe('2026-11-12');
    // A paycheck still pending isn't added where the forecast starts, so it
    // stays expected.
    const pay = monthly('2026-04', 6, 1).map((d) => row(d, -3000, { name: 'Payroll', category: 'income' }));
    const p = only([...pay, row('2026-10-01', -3000, { name: 'Payroll', category: 'income', pending: true })]);
    expect(p.nextDate).toBe('2026-10-01');
    expect(p.pending).toBeUndefined();
  });

  test('pay that varies is found every time, around its median, from its first deposit in the window', () => {
    // The reviewer's case: hourly pay every two weeks, 1,200 to 1,800, ten seeds.
    for (let s = 1; s <= 10; s++) {
      let seed = s * 31337;
      const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff), seed / 0x7fffffff);
      const rows: RecurringRow[] = [];
      for (let d = dayNumber('2025-10-03'); d < dayNumber('2026-10-09'); d += 14)
        rows.push(row(dayIso(d), -Math.round((1200 + rand() * 600) * 100) / 100, { name: 'HOURLY PAY', category: 'income' }));
      const pay = only(rows);
      expect(pay).toMatchObject({ kind: 'income', cadence: 'biweekly', agreement: 'median', firstDate: '2026-02-06', nextDate: '2026-10-16' });
      expect(pay.amount).toBeGreaterThan(1200);
      expect(pay.amount).toBeLessThan(1800);
      expect(expectedDates(pay, '2026-10-09', '2026-11-08').status).toBe('due');
    }
    // A bill is never judged that loosely: the same swings, charged.
    let seed = 31337;
    const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff), seed / 0x7fffffff);
    const charges = everyDays('2025-10-03', 14, 27).map((d) => row(d, Math.round((1200 + rand() * 600) * 100) / 100, { name: 'Contractor' }));
    expect(detectRecurring(charges)).toEqual([]);
  });

  test('a raise in steady pay is followed as a price change is', () => {
    const pay = everyDays('2026-03-27', 14, 13).map((d, i) => row(d, i < 10 ? -2000 : -2200, { name: 'Payroll', category: 'income' }));
    expect(only(pay)).toMatchObject({ cadence: 'biweekly', agreement: 'same', amount: 2200, previousAmount: 2000 });
  });

  test('pay on a schedule at amounts too varied to forecast is listed as varying', () => {
    const gigs = [800, 2900, 1200, 2600, 900, 3000, 1100, 2500, 950, 2800, 1000, 2700];
    const s = only(everyDays('2026-04-24', 14, 12).map((d, i) => row(d, -gigs[i], { name: 'Gig pay', category: 'income' })));
    expect(s).toMatchObject({ agreement: 'varies', cadence: 'biweekly', nextDate: '2026-10-09' });
  });

  test('a payment that pays a card off is marked so', () => {
    const rows = monthly('2026-04', 6, 25).map((d) => row(d, 35, { name: 'CHASE CREDIT CRD AUTOPAY', category: 'loan payments', subcategory: 'credit card payment' }));
    expect(only(rows).paysCard).toBe(true);
    expect(only(monthly('2026-04', 6, 1).map((d) => row(d, 1850, { name: 'Mortgage', category: 'loan payments', subcategory: 'mortgage payment' }))).paysCard).toBeUndefined();
  });

  test('a dismissal holds as new charges come in, amounts move and a series is found anew', () => {
    // Apple: iCloud and a music plan under one name, and the odd app.
    const apple = (months: number, music: number) => {
      const dates = monthly('2026-01', months, 7);
      return [
        ...dates.map((d) => row(d, 2.99, { name: 'Apple' })),
        ...dates.map((d) => row(addDays(d, 10), music, { name: 'Apple' })),
        row('2026-03-02', 4.99, { name: 'Apple' }),
      ];
    };
    const before = detectRecurring(apple(6, 10.99));
    const icloud = before.find((s) => s.amount === 2.99)!;
    const saved = [icloud.id];
    // A month on, and the music plan's price up a dollar: the dismissal still
    // names iCloud, and only iCloud.
    const after = detectRecurring(apple(7, 11.99));
    const gone = dismissedSeries(after, saved);
    expect([...gone.keys()].map((id) => after.find((s) => s.id === id)!.amount)).toEqual([2.99]);
    expect(gone.get([...gone.keys()][0])).toBe(saved[0]);
    // A utility bill whose amount moves every month keeps its dismissal too.
    const bill = (amounts: number[]) => detectRecurring(monthly('2026-01', amounts.length, 9).map((d, i) => row(d, amounts[i], { name: 'PG&E' })));
    const first = bill([80, 92, 85, 88]);
    const later = bill([80, 92, 85, 88, 97, 93]);
    expect(first[0].id).not.toBe(later[0].id);
    expect([...dismissedSeries(later, [first[0].id]).keys()]).toEqual([later[0].id]);
    // A dismissal names one series: two saved are two.
    expect(dismissedSeries(after, [icloud.id, icloud.id.replace(/\|299$/, '|1099')]).size).toBe(2);
  });

  test('bills come first, then income, each largest first', () => {
    const dates = monthly('2026-04', 6, 1);
    const found = detectRecurring([
      ...dates.map((d) => row(d, -3000, { name: 'Payroll', category: 'income' })),
      ...dates.map((d) => row(d, 15, { name: 'Netflix' })),
      ...dates.map((d) => row(d, 1500, { name: 'Rent', category: 'rent and utilities' })),
      ...dates.map((d) => row(d, -12, { name: 'Interest', category: 'income' })),
    ]);
    expect(found.map((s) => s.name)).toEqual(['Rent', 'Netflix', 'Payroll', 'Interest']);
  });
});

describe('dates: month ends and leap years', () => {
  test('a bill on the 31st is on each short month\'s last day, and back on the 31st', () => {
    expect(scheduleDates(monthlyFrom('2026-01-31', 1), '2026-06-30')).toEqual([
      '2026-01-31',
      '2026-02-28',
      '2026-03-31',
      '2026-04-30',
      '2026-05-31',
      '2026-06-30',
    ]);
    // In a leap year February has its 29th.
    expect(scheduleDates(monthlyFrom('2028-01-31', 1), '2028-03-31')).toEqual(['2028-01-31', '2028-02-29', '2028-03-31']);
  });

  test('detected from its postings, a 31st bill is expected on the 31st after a 30-day month', () => {
    const dates = monthly('2025-12', 10, 31);
    expect(dates).toContain('2026-02-28');
    const s = only(dates.map((d) => row(d, 99, { name: 'Rent' })));
    expect(s.cadence).toBe('monthly');
    // The last was Sep 30 (Sep has 30 days); October has a 31st.
    expect(s.lastDate).toBe('2026-09-30');
    expect(s.nextDate).toBe('2026-10-31');
    expect(scheduleDates(s.schedule, '2027-03-31')).toEqual(['2026-10-31', '2026-11-30', '2026-12-31', '2027-01-31', '2027-02-28', '2027-03-31']);
  });

  test('a yearly charge on February 29th is on the 28th in other years', () => {
    expect(scheduleDates(monthlyFrom('2028-02-29', 12), '2032-12-31')).toEqual(['2028-02-29', '2029-02-28', '2030-02-28', '2031-02-28', '2032-02-29']);
    const s = only([row('2024-02-29', 49, { name: 'Domain' }), row('2025-02-28', 49, { name: 'Domain' })]);
    expect(s.cadence).toBe('yearly');
    expect(s.nextDate).toBe('2026-02-28');
    expect(scheduleDates(s.schedule, '2028-12-31')).toEqual(['2026-02-28', '2027-02-28', '2028-02-29']);
  });

  test('every two weeks across a year end and a leap day', () => {
    expect(scheduleDates({ unit: 'day', every: 14, start: '2027-12-24' }, '2028-03-10')).toEqual([
      '2027-12-24',
      '2028-01-07',
      '2028-01-21',
      '2028-02-04',
      '2028-02-18',
      '2028-03-03',
    ]);
  });

  test('days are counted on the calendar, so a daylight-saving change never moves one', () => {
    // US clocks changed on Mar 8 and Nov 1, 2026; Europe's on Mar 29 and Oct 25.
    for (const [a, b] of [
      ['2026-03-07', '2026-03-08'],
      ['2026-03-08', '2026-03-09'],
      ['2026-10-25', '2026-10-26'],
      ['2026-10-31', '2026-11-01'],
    ])
      expect(dayNumber(b) - dayNumber(a)).toBe(1);
    expect(addDays('2026-03-07', 7)).toBe('2026-03-14');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2028-02-28', 1)).toBe('2028-02-29');
    expect(addDays('2027-02-28', 1)).toBe('2027-03-01');
  });
});

describe('what is expected from today', () => {
  const netflix = (): RecurringSeries => only(monthly('2026-04', 6, 12).map((d) => row(d, 15.49)));

  test('the dates through a horizon', () => {
    const s = netflix();
    expect(s.nextDate).toBe('2026-10-12');
    const e = expectedDates(s, '2026-10-09', '2026-12-31');
    expect(e.status).toBe('due');
    expect(e.dates.map((d) => d.date)).toEqual(['2026-10-12', '2026-11-12', '2026-12-12']);
  });

  test('late within its tolerance: expected today, not dropped', () => {
    const s = netflix();
    const e = expectedDates(s, '2026-10-15', '2026-11-30');
    expect(e.status).toBe('late');
    expect(e.dates[0]).toEqual({ date: '2026-10-15', due: '2026-10-12', late: true });
    expect(e.dates.map((d) => d.date)).toEqual(['2026-10-15', '2026-11-12']);
  });

  test('past its tolerance it was skipped, and two missed in a row end it', () => {
    const s = netflix();
    const skipped = expectedDates(s, '2026-10-20', '2026-11-30');
    expect(skipped.status).toBe('due');
    expect(skipped.dates.map((d) => d.date)).toEqual(['2026-11-12']);
    expect(expectedDates(s, '2026-11-20', '2027-01-31')).toEqual({ status: 'ended', dates: [] });
  });

  test('a yearly charge one renewal past due has ended', () => {
    const s = only([row('2024-03-03', 139, { name: 'Prime' }), row('2025-03-03', 139, { name: 'Prime' })]);
    expect(expectedDates(s, '2026-10-09', '2026-12-31').status).toBe('ended');
  });

  test('upcoming bills count from the viewer\'s day, soonest first, without income or what was dismissed', () => {
    const rent = only(monthly('2026-04', 6, 1).map((d) => row(d, 1500, { name: 'Rent' })));
    const all = [netflix(), rent, only(monthly('2026-04', 6, 10).map((d) => row(d, -2000, { name: 'Payroll', category: 'income' })))];
    expect(upcomingBills(all, 7, '2026-09-28').map((u) => [u.series.name, u.date])).toEqual([['Rent', '2026-10-01']]);
    expect(upcomingBills(all, 7, '2026-09-28', new Set([rent.id]))).toEqual([]);
    // Rent's Oct 1 not in by the 4th: late, within its 4 days, so expected
    // today. Netflix's 12th is a day too far.
    expect(upcomingBills(all, 7, '2026-10-04')).toEqual([{ series: rent, date: '2026-10-04', due: '2026-10-01', late: true }]);
    // Past its 4 days it was skipped, and next is Nov 1; the 12th is in reach.
    expect(upcomingBills(all, 7, '2026-10-06').map((u) => [u.series.name, u.date])).toEqual([['Netflix', '2026-10-12']]);
    expect(upcomingBills(all, 7, '2026-10-09').map((u) => [u.series.name, u.date])).toEqual([['Netflix', '2026-10-12']]);
  });
});

describe('the history before the loaded year', () => {
  test('only rare merchants also seen this year are sent', () => {
    const recent = [row('2026-03-01', 139, { name: 'Prime' }), row('2026-09-01', 15)];
    const older = [
      row('2025-03-02', 139, { name: 'Prime' }),
      // Seen too often to need older rows: judged on the loaded year.
      ...monthly('2024-10', 6, 1).map((d) => row(d, 15)),
      // Nothing this year: a series that ended.
      row('2025-04-01', 60, { name: 'Old gym' }),
      // Can't belong to a series at all.
      row('2025-05-01', 800, { name: 'Prime', category: 'transfer out' }),
    ];
    expect(olderRowsForDetection(recent, older)).toEqual([older[0]]);
  });

  test('with them, a yearly charge is found', () => {
    const recent = [row('2026-03-01', 139, { name: 'Prime' })];
    const older = [row('2025-03-02', 139, { name: 'Prime' })];
    expect(detectRecurring(recent)).toEqual([]);
    expect(only([...recent, ...olderRowsForDetection(recent, older)]).cadence).toBe('yearly');
  });
});
