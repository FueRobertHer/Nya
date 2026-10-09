import { describe, expect, test } from 'bun:test';
import {
  addDays,
  cadenceLabel,
  dayNumber,
  detectRecurring,
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

  test('yearly, from two renewals a year apart, at a raised price', () => {
    const s = only([row('2024-11-03', 119, { name: 'Amazon Prime' }), row('2025-11-02', 139, { name: 'Amazon Prime' })]);
    expect(s.cadence).toBe('yearly');
    // Two seen: the latest is the price now.
    expect(s.amount).toBe(139);
    expect(s.nextDate).toBe('2026-11-02');
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
