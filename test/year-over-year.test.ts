import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import MonthBreakdown from '@/components/MonthBreakdown';
import { formatMoney } from '@/lib/format';
import { summarize } from '@/lib/totals';
import type { Txn } from '@/lib/transactions';
import { buildYearOverYear, change, yearBefore, yoyCurrency, yoySpans } from '@/lib/report/year-over-year';
import { categoriesFor } from './category-fixture';

// Year over year's pure core (lib/report/year-over-year.ts): the days each
// year and month is compared on, every figure held to the Activity tab's own
// month totals to the cent and a year's to its months added up, money in and
// out by group and category with the change in amount and percent, transfers,
// exclusions and another currency left out, and the months that may be short
// marked. Its own clock: today is passed in.

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

/** Both years, every rule exercised: pay, groceries, rent, a refund, a move
 *  to savings, a loan payment, cash taken out, an exclusion, a meal in euros,
 *  and rows after the same day last year that this year can't be held to. */
const ROWS: Txn[] = [
  row('pay-25', '2025-01-15', -3000, { category: 'income' }),
  row('food-25-jan', '2025-01-20', 400, { category: 'food and drink' }),
  row('rent-25', '2025-03-01', 1500, { category: 'rent and utilities' }),
  row('food-25-oct', '2025-10-10', 250, { category: 'food and drink' }),
  row('food-25-late', '2025-10-25', 99, { category: 'food and drink' }),
  row('gift-25-dec', '2025-12-12', 999),
  row('pay-26', '2026-01-15', -3200, { category: 'income' }),
  row('food-26-jan', '2026-01-20', 500, { category: 'food and drink' }),
  row('rent-26', '2026-03-01', 1600, { category: 'rent and utilities' }),
  row('refund-26', '2026-03-09', -20),
  row('savings-26', '2026-03-10', 700, { category: 'transfer out', transaction_code: 'transfer' }),
  row('loan-26', '2026-03-12', 400, { category: 'loan payments' }),
  row('atm-26', '2026-03-13', 60, { transaction_code: 'atm' }),
  row('tv-26', '2026-03-14', 900, { excluded: true }),
  row('paris-26', '2026-03-15', 45, { category: 'food and drink', iso_currency_code: 'EUR' }),
  row('food-26-oct', '2026-10-05', 300, { category: 'food and drink' }),
];

const { taxonomy } = categoriesFor({}, { words: ['food and drink', 'rent and utilities', 'income', 'general merchandise'] });
const yoy = (over: Partial<Parameters<typeof buildYearOverYear>[0]> = {}) => buildYearOverYear({ rows: ROWS, taxonomy, currency: 'USD', today: TODAY, ...over });

/** The figures the Activity tab shows for the only month it is given. */
function activityTab(txns: Txn[]) {
  const html = renderToStaticMarkup(createElement(MonthBreakdown, { txns, notes: [], loading: false, onRecategorize: () => {}, onRename: () => {} }));
  const figure = (label: string) => new RegExp(`total-label">${label}</div><div class="summary-value[^"]*">([^<]*)<`).exec(html)?.[1];
  return { in: figure('In'), out: figure('Out'), net: figure('Net') };
}

describe('the days compared', () => {
  test('a year before, February 29 the 28th', () => {
    expect(yearBefore('2026-10-22')).toBe('2025-10-22');
    expect(yearBefore('2024-02-29')).toBe('2023-02-28');
    expect(yearBefore('2025-03-01')).toBe('2024-03-01');
  });

  test('this year so far against the same days last year, each month whole but this one', () => {
    const s = yoySpans(TODAY);
    expect(s.year).toEqual({ this: { start: '2026-01-01', end: '2026-10-22' }, last: { start: '2025-01-01', end: '2025-10-22' } });
    expect(s.month).toEqual({ this: { start: '2026-10-01', end: '2026-10-22' }, last: { start: '2025-10-01', end: '2025-10-22' } });
    expect(s.months.map((m) => m.month)).toEqual(['2026-01', '2026-02', '2026-03', '2026-04', '2026-05', '2026-06', '2026-07', '2026-08', '2026-09', '2026-10']);
    expect(s.months[1]).toEqual({ month: '2026-02', this: { start: '2026-02-01', end: '2026-02-28' }, last: { start: '2025-02-01', end: '2025-02-28' } });
    // A leap February a year after: the whole of it, against the whole of the last.
    expect(yoySpans('2025-03-02').months[1]).toEqual({ month: '2025-02', this: { start: '2025-02-01', end: '2025-02-28' }, last: { start: '2024-02-01', end: '2024-02-29' } });
    // On January 1st, one day against one day.
    expect(yoySpans('2027-01-01').year).toEqual({ this: { start: '2027-01-01', end: '2027-01-01' }, last: { start: '2026-01-01', end: '2026-01-01' } });
  });
});

describe('to the cent, by the Activity tab’s rule', () => {
  test('each month is the Activity tab’s month, both years', () => {
    const y = yoy();
    const money = (n: number) => formatMoney(n, 'USD');
    for (const m of y.months) {
      for (const side of ['this', 'last'] as const) {
        const span = m[side];
        const rows = ROWS.filter((t) => t.date >= span.start && t.date <= span.end);
        if (rows.length === 0) {
          expect([m.month, side, span.money_in, span.money_out, span.net]).toEqual([m.month, side, 0, 0, 0]);
          continue;
        }
        const tab = activityTab(rows);
        expect([m.month, side, tab.in, tab.out, tab.net]).toEqual([m.month, side, money(span.money_in), money(span.money_out), money(span.net)]);
      }
    }
    // March 2026 by hand: rent 1,600 out, a refund of 20 in; the move to
    // savings, the loan payment, the cash, the TV excluded and the meal in
    // euros left out.
    const march = y.months.find((m) => m.month === '2026-03')!;
    expect([march.this.money_in, march.this.money_out, march.this.net]).toEqual([20, 1600, -1580]);
  });

  test('a year is its months added up, and summarize’s over the same days', () => {
    const y = yoy();
    for (const side of ['this', 'last'] as const) {
      const sum = (k: 'money_in' | 'money_out' | 'net') => Math.round(y.months.reduce((n, m) => n + m[side][k], 0) * 100) / 100;
      expect([y.year[side].money_in, y.year[side].money_out, y.year[side].net]).toEqual([sum('money_in'), sum('money_out'), sum('net')]);
      const s = summarize(ROWS, (d) => d >= y.year[side].start && d <= y.year[side].end, 'USD');
      expect([y.year[side].money_in, y.year[side].money_out, y.year[side].transactions]).toEqual([s.money_in, s.money_out, s.counted]);
    }
    // 2026 so far: 3,220 in, 2,400 out. The same days of 2025: 3,000 in,
    // 2,150 out (the 99 on Oct 25 and the 999 in December are after them).
    expect([y.year.this.money_in, y.year.this.money_out]).toEqual([3220, 2400]);
    expect([y.year.last.money_in, y.year.last.money_out]).toEqual([3000, 2150]);
    expect(y.year.money_out).toEqual({ this: 2400, last: 2150, change: 250, pct: 11.6 });
    expect(y.year.net).toEqual({ this: 820, last: 850, change: -30, pct: -3.5 });
  });

  test('this month so far against the same days a year ago', () => {
    const y = yoy();
    expect(y.month.month).toBe('2026-10');
    expect(y.month.money_out).toEqual({ this: 300, last: 250, change: 50, pct: 20 });
    expect(y.months.at(-1)!.money_out).toEqual(y.month.money_out);
  });

  test('another currency is left out of each year and named, never converted', () => {
    const y = yoy();
    expect(y.left_out.this).toEqual([{ currency: 'EUR', count: 1 }]);
    expect(y.left_out.last).toEqual([]);
    expect(y.left_out_text.this).toBe("1 transaction in EUR isn't in these totals, which are in USD.");
    // Counted as the totals count: the transactions that would count but for
    // their currency, so never the move to savings, the loan payment, the cash
    // taken out or the TV excluded, and a split one once.
    expect(y.currencies).toEqual([
      { currency: 'USD', transactions: 9 },
      { currency: 'EUR', transactions: 1 },
    ]);
    const split = [row('shop-a', '2026-04-02', 30, { split_of: 'shop', category: 'food and drink' }), row('shop-b', '2026-04-02', 20, { split_of: 'shop' })];
    expect(yoy({ rows: [...ROWS, ...split] }).currencies[0]).toEqual({ currency: 'USD', transactions: 10 });
    expect(yoyCurrency(ROWS, TODAY, 'EUR')).toBe('EUR');
    expect(yoyCurrency(ROWS, TODAY, 'JPY')).toBe('USD');
    expect(yoyCurrency(ROWS, TODAY, null)).toBe('USD');
    const euros = yoy({ currency: 'EUR' });
    expect(euros.year.this.money_out).toBe(45);
  });
});

describe('by group and category', () => {
  test('money in and out, with the change in amount and percent, each group adding up to the year', () => {
    const y = yoy();
    const byName = new Map(y.groups.map((g) => [g.name, g]));
    expect(byName.get('Food')!.money_out).toEqual({ this: 800, last: 650, change: 150, pct: 23.1 });
    expect(byName.get('Housing')!.money_out).toEqual({ this: 1600, last: 1500, change: 100, pct: 6.7 });
    expect(byName.get('Income')!.money_in).toEqual({ this: 3200, last: 3000, change: 200, pct: 6.7 });
    // Last year nothing: new, never an infinite rise.
    expect(byName.get('Shopping')!.money_in).toEqual({ this: 20, last: 0, change: 20, pct: null });
    // Transfers never count.
    expect(byName.has('Transfers')).toBe(false);
    const total = (k: 'money_in' | 'money_out', side: 'this' | 'last') => y.groups.reduce((n, g) => n + g[k][side], 0);
    expect([total('money_in', 'this'), total('money_out', 'this'), total('money_in', 'last'), total('money_out', 'last')]).toEqual([3220, 2400, 3000, 2150]);
    // Each group is its categories added up, named as they are now.
    for (const g of y.groups) {
      expect(g.categories.reduce((n, c) => n + c.money_out.this, 0)).toBe(g.money_out.this);
      expect(g.categories.reduce((n, c) => n + c.money_in.last, 0)).toBe(g.money_in.last);
    }
    expect(byName.get('Food')!.categories.map((c) => [c.name, c.transactions])).toEqual([['food and drink', { this: 2, last: 2 }]]);
    // In the person's order of groups.
    const order = new Map(taxonomy.groups.map((g) => [g.id, g.order]));
    const orders = y.groups.map((g) => order.get(g.id!)!);
    expect(orders).toEqual([...orders].sort((a, b) => a - b));
  });

  test('a category renamed or moved since last year is compared as it is now', () => {
    const food = taxonomy.categories.find((c) => c.name === 'food and drink')!;
    const moved = { ...taxonomy, categories: taxonomy.categories.map((c) => (c.id === food.id ? { ...c, name: 'Groceries', group: taxonomy.groups.find((g) => g.name === 'Housing')!.id } : c)) };
    const y = buildYearOverYear({ rows: ROWS, taxonomy: moved, currency: 'USD', today: TODAY });
    const housing = y.groups.find((g) => g.name === 'Housing')!;
    expect(housing.categories.map((c) => c.name).sort()).toEqual(['Groceries', 'rent and utilities']);
    expect(housing.money_out).toEqual({ this: 2400, last: 2150, change: 250, pct: 11.6 });
  });

  test('without categories, the rows’ own words, under one group', () => {
    const y = yoy({ taxonomy: null });
    expect(y.groups.map((g) => [g.name, g.id])).toEqual([['All categories', null]]);
    expect(y.groups[0].categories.map((c) => c.name).sort()).toEqual(['food and drink', 'general merchandise', 'income', 'rent and utilities']);
  });
});

describe('months that may be short', () => {
  test('are marked on their own and on every total that adds one up', () => {
    const short = new Map([
      ['2025-03', { uncertain: true, institutions: ['Citi'] }],
      ['2026-10', { uncertain: true, institutions: ['Chase'] }],
    ]);
    const y = yoy({ short });
    const march = y.months.find((m) => m.month === '2026-03')!;
    expect(march.this).toMatchObject({ uncertain: false, institutions: [] });
    expect(march.last).toMatchObject({ uncertain: true, institutions: ['Citi'] });
    expect(y.month.this).toMatchObject({ uncertain: true, institutions: ['Chase'] });
    expect(y.year.this).toMatchObject({ uncertain: true, institutions: ['Chase'] });
    expect(y.year.last).toMatchObject({ uncertain: true, institutions: ['Citi'] });
    expect(yoy().year.this.uncertain).toBe(false);
  });

  test('nothing in either year says so', () => {
    expect(yoy({ rows: [] }).empty).toBe(true);
    expect(yoy().empty).toBe(false);
  });

  test('the change, in amount and percent', () => {
    expect(change(110, 100)).toEqual({ this: 110, last: 100, change: 10, pct: 10 });
    expect(change(-50, 100)).toEqual({ this: -50, last: 100, change: -150, pct: -150 });
    // Over a negative net, a rise is a rise.
    expect(change(-50, -100)).toEqual({ this: -50, last: -100, change: 50, pct: 50 });
    expect(change(0, 0)).toEqual({ this: 0, last: 0, change: 0, pct: null });
    expect(change(0.1 + 0.2, 0.1)).toEqual({ this: 0.3, last: 0.1, change: 0.2, pct: 200 });
  });
});
