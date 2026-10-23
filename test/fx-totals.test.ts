import { describe, expect, test } from 'bun:test';
import { ecbTable } from './fx-fixture';
import { convertedText, leftOutWhy, totalsIn } from '@/lib/fx/totals';
import { countsInTotals, leftOutByCurrency, leftOutText } from '@/lib/spending';

// The one seam for totals of flows (lib/fx/totals.ts): without a home
// currency, today's rows and currency exactly; with one, each row in another
// currency a copy at its own day's rate, what has no rate left in its own and
// named, and the rules of lib/spending.ts counting the copies as before. The
// ECB's rates of 10 to 14 Sep 2026 (test/fx-fixture.ts): 1 EUR = 1.1616,
// 1.1592 and 1.1551 USD.

type Row = {
  transaction_id: string;
  date: string;
  amount: number;
  iso_currency_code: string | null;
  unofficial_currency_code?: string | null;
  transaction_code: string | null;
  category: string | null;
  account_id?: string;
  split_of?: string;
  split_parent?: { amount: number; note: string | null };
};
const row = (id: string, date: string, amount: number, currency: string | null, over: Partial<Row> = {}): Row => ({
  transaction_id: id,
  date,
  amount,
  iso_currency_code: currency,
  transaction_code: null,
  category: 'food and drink',
  ...over,
});

const ROWS: Row[] = [
  row('eur', '2026-09-14', 20, 'EUR'),
  row('usd1', '2026-09-11', 12.34, 'USD'),
  row('usd2', '2026-09-14', 100, 'USD'),
  row('pay', '2026-09-10', -2500, 'USD', { category: 'income' }),
  row('btc', '2026-09-14', 0.01, null, { unofficial_currency_code: 'BTC' }),
  row('move', '2026-09-14', 50, 'USD', { transaction_code: 'transfer' }),
];

describe('without a home currency', () => {
  test('the rows and the currency as today: the one most rows are in, nothing converted', () => {
    const t = totalsIn(ROWS, ecbTable({ home: null }));
    expect(t).toEqual({ currency: 'USD', rows: ROWS, conversion: null });
    expect(totalsIn(ROWS, null).currency).toBe('USD');
  });
});

describe('with one', () => {
  const fx = { ...ecbTable({ home: 'EUR' }), fetch: { at: '2026-09-14T16:30:00.000Z', ok: true, newest: '2026-09-14', last_ok: '2026-09-14T16:30:00.000Z' } };
  const NOW = Date.parse('2026-09-14T18:00:00Z');

  test('each row in another currency at its own day’s rate, rounded once, saying what it was', () => {
    const t = totalsIn(ROWS, fx, { now: NOW });
    expect(t.currency).toBe('EUR');
    const by = new Map(t.rows.map((r: any) => [r.transaction_id, r]));
    expect(by.get('eur')).toBe(ROWS[0]);
    expect(by.get('usd1')).toMatchObject({ amount: 10.65, iso_currency_code: 'EUR', converted: { amount: 12.34, currency: 'USD' } }); // 12.34 / 1.1592
    expect(by.get('usd2')).toMatchObject({ amount: 86.57, iso_currency_code: 'EUR' }); // 100 / 1.1551
    expect(by.get('pay')).toMatchObject({ amount: -2152.2 }); // -2,500 / 1.1616
    // A transfer is still one: only the amount and currency change.
    expect(countsInTotals(by.get('move') as any, 'EUR')).toBe(false);
    // No rate: as it is, so the rules name it, and why.
    expect(by.get('btc')).toBe(ROWS[4]);
    expect(leftOutByCurrency(t.rows as any, 'EUR')).toEqual([{ currency: 'BTC', count: 1 }]);
    expect(t.conversion).toEqual({
      into: 'EUR',
      from: [{ currency: 'USD', count: 4 }],
      days: { first: '2026-09-10', last: '2026-09-14' },
      own: [],
      unrated: [{ currency: 'BTC', why: 'not-published', unrated: 'BTC' }],
      assumed: 0,
      stale: false,
    });
    // Rates older than they should be are said to be, once a row after them
    // was converted at them; a row on a day the ECB published has its own.
    expect(totalsIn(ROWS, fx, { now: NOW + 3 * 86_400_000 }).conversion?.stale).toBe(false);
    const later = [...ROWS, row('late', '2026-09-16', 5, 'USD')];
    expect(totalsIn(later, fx, { now: NOW + 3 * 86_400_000 }).conversion?.stale).toBe(true);
    expect(totalsIn(later, fx, { now: NOW }).conversion?.stale).toBe(false);
  });

  test('a converted total is its rows converted, to the cent', () => {
    const t = totalsIn(ROWS, fx);
    const spent = t.rows.filter((r) => r.amount > 0 && countsInTotals(r as any, 'EUR')).reduce((s, r) => s + r.amount, 0);
    // 20 + 12.34 / 1.1592 + 100 / 1.1551
    expect(Math.round(spent * 100) / 100).toBe(20 + 10.65 + 86.57);
  });

  test('the notes say what was converted, and why what wasn’t has no rate; never an amount', () => {
    const t = totalsIn(ROWS, fx);
    expect(convertedText(t.conversion)).toBe('Converted into EUR at each day’s ECB rate: 4 transactions in USD.');
    const left = leftOutText(leftOutByCurrency(t.rows as any, 'EUR'), 'EUR');
    expect(leftOutWhy(left, t.conversion)).toBe('1 transaction in BTC isn’t in these totals, which are in EUR: there is no rate for BTC on those days.'.replace('isn’t', "isn't"));
    expect(convertedText(totalsIn(ROWS.slice(0, 1), fx).conversion)).toBeNull();
    // An own rate is said to be the person's.
    const own = ecbTable({ home: 'EUR', own: [{ currency: 'BTC', rate: '61000', quote: 'USD', from: null, set_at: '2026-09-01T10:00:00.000Z' }] });
    const priced = totalsIn(ROWS, own);
    expect(priced.rows.find((r) => r.transaction_id === 'btc')).toMatchObject({ amount: 528.09, iso_currency_code: 'EUR' }); // 0.01 × 61,000 / 1.1551
    expect(convertedText(priced.conversion)).toBe('Converted into EUR at each day’s ECB rate, and your own rate for BTC: 4 transactions in USD and 1 in BTC.');
  });

  test('a row that says no currency is in its account’s, else in the totals’, and counted', () => {
    const rows = [row('a', '2026-09-14', 100, null, { account_id: 'acc_usd' }), row('b', '2026-09-14', 5, null, { account_id: 'acc_unknown' })];
    const t = totalsIn(rows, fx, { accountCurrency: (r) => (r.account_id === 'acc_usd' ? 'USD' : null) });
    expect(t.rows.map((r) => [r.amount, r.iso_currency_code])).toEqual([
      [86.57, 'EUR'],
      [5, null],
    ]);
    expect(t.conversion?.assumed).toBe(1);
  });

  test('a split’s parts each converted, and their whole what they came to', () => {
    const parent = { amount: 10, note: null };
    const parts = [3.33, 3.33, 3.34].map((a, i) => row(`p${i}`, '2026-09-14', a, 'USD', { split_of: 'w', split_parent: parent }));
    const t = totalsIn(parts, fx);
    expect(t.rows.map((r) => r.amount)).toEqual([2.88, 2.88, 2.89]);
    // 8.65, never the whole converted on its own (8.66).
    expect(t.rows.map((r) => r.split_parent?.amount)).toEqual([8.65, 8.65, 8.65]);
    expect(t.conversion?.from).toEqual([{ currency: 'USD', count: 1 }]);
  });

  test('into the currency most rows are in (the budgets’): the rest converted into it', () => {
    const t = totalsIn(ROWS, fx, { into: 'most' });
    expect(t.currency).toBe('USD');
    expect(t.rows.find((r) => r.transaction_id === 'eur')).toMatchObject({ amount: 23.1, iso_currency_code: 'USD' }); // 20 × 1.1551
    // Decided over a window when asked.
    expect(totalsIn(ROWS, fx, { into: 'most', over: ROWS.slice(0, 1) }).currency).toBe('EUR');
  });

  test('a day in a year Nya has no rates for: rates it doesn’t have yet, never no rate', () => {
    const t = totalsIn([row('old', '2003-05-02', 10, 'USD')], fx);
    expect(t.conversion?.unrated).toEqual([{ currency: 'USD', why: 'not-fetched', unrated: 'USD' }]);
    expect(leftOutWhy('1 transaction in USD isn’t in these totals, which are in EUR.', t.conversion)).toBe(
      '1 transaction in USD isn’t in these totals, which are in EUR: Nya doesn’t have the ECB’s rates for those days yet.'
    );
  });
});
