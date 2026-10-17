import { describe, expect, test } from 'bun:test';
import { spendingByCategory, summarize, tidy, categoryOf, categoryTotals, recurringMonthly, countsInMonthly, type TotalsRow } from '@/lib/totals';
import { countsInTotals } from '@/lib/spending';
import { detectRecurring, scheduleDates, type RecurringRow } from '@/lib/recurring';

// Totals over transactions (lib/totals.ts), shared by the Budgets tab and the
// read-only API: the rules of lib/spending.ts, one currency per total, and
// what was left out named.

const row = (date: string, amount: number, over: Partial<TotalsRow> = {}): TotalsRow => ({
  date,
  amount,
  category: 'general merchandise',
  transaction_code: null,
  iso_currency_code: 'USD',
  ...over,
});

const ROWS: TotalsRow[] = [
  row('2026-10-02', 5.5, { category: 'food and drink' }),
  row('2026-10-02', 0.1, { category: 'food and drink' }),
  row('2026-10-02', 0.2, { category: 'food and drink' }),
  row('2026-10-03', 35, { category: 'bank fees' }), // a fee is spending
  row('2026-10-04', -3000, { category: 'income' }),
  row('2026-10-04', -20, { category: 'food and drink' }), // a refund is money in, not less spending
  row('2026-10-05', 500, { category: 'transfer out', transaction_code: 'transfer' }),
  row('2026-10-05', 100, { transaction_code: 'atm' }),
  row('2026-10-05', 400, { category: 'loan payments' }),
  row('2026-10-06', 2000, { excluded: true }),
  row('2026-10-06', 70, { excluded: null }), // couldn't be read: counted
  row('2026-10-07', 50, { iso_currency_code: 'EUR', category: 'travel' }),
  row('2026-10-07', 9, { iso_currency_code: null, category: null }), // no currency: the totals'
  row('2026-09-30', 999, { category: 'food and drink' }), // another month
];
const october = (d: string) => d.startsWith('2026-10');

describe('spending by category, as the Budgets tab counts it', () => {
  test('outflows that count, by category, "other" for none', () => {
    expect(spendingByCategory(ROWS, october, 'USD')).toEqual({
      'food and drink': 5.5 + 0.1 + 0.2,
      'bank fees': 35,
      'general merchandise': 70,
      other: 9,
    });
  });

  test('another currency’s total takes only that currency’s rows, and those that say none', () => {
    expect(spendingByCategory(ROWS, october, 'EUR')).toEqual({ travel: 50, other: 9 });
  });

  test('agrees with countsInTotals, row by row', () => {
    const counted = ROWS.filter((t) => october(t.date) && t.amount > 0 && countsInTotals(t, 'USD'));
    const total = Object.values(spendingByCategory(ROWS, october, 'USD')).reduce((a, b) => a + b, 0);
    expect(total).toBeCloseTo(counted.reduce((a, t) => a + t.amount, 0), 10);
  });
});

describe('a summary over a range', () => {
  test('money in, out and net; spending by category; and what was left out, each counted', () => {
    const s = summarize(ROWS, october, 'USD');
    expect(s).toEqual({
      currency: 'USD',
      money_in: 3020,
      money_out: 119.8,
      net: 2900.2,
      categories: [
        { category: 'general merchandise', spent: 70, transactions: 1 },
        { category: 'bank fees', spent: 35, transactions: 1 },
        { category: 'other', spent: 9, transactions: 1 },
        { category: 'food and drink', spent: 5.8, transactions: 3 },
      ],
      transactions: 13,
      counted: 8,
      transfers: 3,
      excluded: 1,
      exclusion_unknown: 1,
      left_out: [{ currency: 'EUR', count: 1 }],
      left_out_text: "1 transaction in EUR isn't in these totals, which are in USD.",
    });
  });

  test('cents add up without floating-point noise', () => {
    expect(summarize([row('2026-10-01', 0.1), row('2026-10-01', 0.2)], october, 'USD').money_out).toBe(0.3);
    expect(tidy(0.1 + 0.2)).toBe(0.3);
    expect(tidy(-0)).toBe(0);
    // A cryptocurrency's eight places survive.
    expect(tidy(0.12345678)).toBe(0.12345678);
  });

  test('rows filed into the person’s categories are totalled by category, and named by it, never by an id, whether a describer is given or not', () => {
    // As lib/category-store.ts files them: an id, the name now, and the words they came with.
    const filed = [
      row('2026-10-02', 30, { category: 'groceries', category_id: 'c-food', category_name: 'Food' }),
      row('2026-10-03', 20, { category: 'food and drink', category_id: 'c-food', category_name: 'Food' }),
      // Says nothing of its category: under the uncategorized one, with no name of its own.
      row('2026-10-04', 5, { category: null, category_id: 'c-other', category_name: null }),
      row('2026-10-04', 7, { category: 'other', category_id: 'c-other', category_name: 'Misc' }),
      row('2026-10-05', -12, { category: 'groceries', category_id: 'c-food', category_name: 'Food' }),
    ];
    expect(summarize(filed, october, 'USD').categories).toEqual([
      { category: 'Food', spent: 50, transactions: 2 },
      { category: 'Misc', spent: 12, transactions: 2 },
    ]);
    const totals = categoryTotals(filed, october, 'USD');
    expect(totals.out.map((c) => c.category)).toEqual(['Food', 'Misc']);
    expect(totals.in).toEqual([{ category: 'Food', amount: 12, transactions: 1 }]);
    // With a describer, its names.
    const described = summarize(filed, october, 'USD', (bucket) => ({ category: bucket.toUpperCase(), category_id: bucket, group_id: null, group: null }));
    expect(described.categories.map((c) => [c.category, c.category_id])).toEqual([
      ['C-FOOD', 'c-food'],
      ['C-OTHER', 'c-other'],
    ]);
  });

  test('an empty range is zeros, never an error', () => {
    expect(summarize(ROWS, (d) => d === '2027-01-01', 'USD')).toMatchObject({ money_in: 0, money_out: 0, net: 0, categories: [], transactions: 0, left_out: [], left_out_text: null });
  });

  test('with no currency anywhere, every row counts', () => {
    const rows = [row('2026-10-01', 10, { iso_currency_code: null }), row('2026-10-01', 5, { iso_currency_code: 'JPY' })];
    expect(summarize(rows, october, null)).toMatchObject({ currency: null, money_out: 15, left_out: [] });
  });

  test('categoryOf files a row without one under "other"', () => {
    expect(categoryOf({ category: null })).toBe('other');
    expect(categoryOf({ category: 'travel' })).toBe('travel');
  });
});

describe('what recurring series come to in a month, as the Budgets tab and the API add it', () => {
  const TODAY = '2026-10-09';
  const monthly = (from: string, count: number, day: number) =>
    scheduleDates({ unit: 'month', every: 1, days: [day], month: from, slot: 0 }, TODAY, count);
  const charge = (date: string, name: string, amount: number, over: Partial<RecurringRow> = {}): RecurringRow => ({
    date,
    name,
    amount,
    institution_name: 'Chase',
    account_name: 'Checking',
    account_type: 'depository',
    category: 'entertainment',
    transaction_code: null,
    iso_currency_code: 'USD',
    ...over,
  });
  const series = detectRecurring([
    // Monthly, still coming: in, at its price.
    ...monthly('2026-04', 6, 14).map((d) => charge(d, 'Netflix', 15.99)),
    // Weekly: about 4.35 times its price a month.
    ...['2026-08-07', '2026-08-14', '2026-08-21', '2026-08-28', '2026-09-04', '2026-09-11', '2026-09-18', '2026-09-25', '2026-10-02', '2026-10-09'].map((d) =>
      charge(d, 'Laundry', 10, { category: 'general services' })
    ),
    // Stopped in the spring: may have ended, so not in.
    ...monthly('2026-01', 4, 3).map((d) => charge(d, 'Gym', 30, { category: 'personal care' })),
    // A card's payment: its card's charges are counted where they are charged.
    ...monthly('2026-04', 6, 25).map((d) => charge(d, 'CHASE CREDIT CRD AUTOPAY', 300, { category: 'loan payments', subcategory: 'credit card payment' })),
    // In euros: left out, and named.
    ...monthly('2026-04', 6, 20).map((d) => charge(d, 'Radio', 9.99, { iso_currency_code: 'EUR' })),
  ]).filter((s) => s.kind === 'bill');

  test('those still coming, at their monthly worth, in one currency; the rest named', () => {
    const name = (n: string) => series.find((s) => s.name === n)!;
    expect(countsInMonthly(name('Netflix'), TODAY)).toBe(true);
    expect(countsInMonthly(name('Gym'), TODAY)).toBe(false);
    expect(countsInMonthly(name('CHASE CREDIT CRD AUTOPAY'), TODAY)).toBe(false);
    const { total, leftOut } = recurringMonthly(series, TODAY, 'USD');
    expect(tidy(total)).toBe(tidy(15.99 + (10 * 365.25) / 12 / 7));
    expect(leftOut).toEqual([{ currency: 'EUR', count: 1 }]);
    // In euros instead: only the radio, and the dollars named.
    expect(recurringMonthly(series, TODAY, 'EUR')).toEqual({ total: 9.99, leftOut: [{ currency: 'USD', count: 2 }] });
  });

  test('pay that varies too much to forecast is never in it', () => {
    const steady = series.find((s) => s.name === 'Netflix')!;
    expect(countsInMonthly({ ...steady, agreement: 'varies' }, TODAY)).toBe(false);
    expect(recurringMonthly([{ ...steady, agreement: 'varies' }], TODAY, 'USD')).toEqual({ total: 0, leftOut: [] });
  });
});
