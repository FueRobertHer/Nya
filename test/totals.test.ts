import { describe, expect, test } from 'bun:test';
import { spendingByCategory, summarize, tidy, categoryOf, type TotalsRow } from '@/lib/totals';
import { monthlyBillsTotal, type RecurringBill } from '@/lib/recurring';
import { countsInTotals } from '@/lib/spending';

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

describe('the bills’ monthly total', () => {
  const bill = (amount: number, currency: string | null): RecurringBill => ({
    name: 'x',
    institution: 'Chase',
    amount,
    currency,
    logo_url: null,
    lastDate: '2026-10-01',
    nextDate: '2026-11-01',
    monthsSeen: 3,
  });

  test('adds the bills in the budgets’ currency (and those that say none), and names the rest', () => {
    const { total, leftOut } = monthlyBillsTotal([bill(15.99, 'USD'), bill(9, null), bill(7, 'EUR'), bill(3, 'EUR'), bill(100, 'JPY')], 'USD');
    expect(total).toBeCloseTo(24.99, 10); // as summed: the screen formats it, the API tidies it
    expect(leftOut).toEqual([
      { currency: 'EUR', count: 2 },
      { currency: 'JPY', count: 1 },
    ]);
  });

  test('with no currency to keep, every bill is added', () => {
    expect(monthlyBillsTotal([bill(1, 'USD'), bill(2, 'EUR')], null)).toEqual({ total: 3, leftOut: [] });
  });
});
