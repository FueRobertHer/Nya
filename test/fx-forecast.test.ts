import { describe, expect, test } from 'bun:test';
import { ecbTable } from './fx-fixture';
import { cashPosition, forecastConvertedText, forecastEvents, forecastNotes, type ForecastInstitution, type PendingRow } from '@/lib/forecast';
import { calendarMonth, type CalendarTxn } from '@/lib/calendar';
import { detectRecurring, scheduleDates, type RecurringRow } from '@/lib/recurring';
import type { PlannedItem } from '@/lib/planned';
import { convert } from '@/lib/fx/rates';

// The cash forecast and the calendar with a home currency (lib/forecast.ts,
// lib/calendar.ts): the forecast keeps its currency, its cash accounts' main
// one, which the warning typed is in, and converts what is in another into it
// at the newest rates (a day to come has no rate of its own); a posted row on
// the calendar at its own day's rate. Each still listed in its own currency;
// what has no rate is left out and named, with why. The ECB's newest rates
// (14 Sep 2026, test/fx-fixture.ts): 1 EUR = 1.1551 USD and 0.85598 GBP.

const FX = ecbTable({ home: 'EUR' });
const TODAY = '2026-10-09';
const cents = (n: number) => Math.round(n * 100) / 100;

const acct = (over: Partial<ForecastInstitution['accounts'][number]> = {}) => ({
  account_id: 'chk',
  name: 'Checking',
  type: 'depository',
  subtype: 'checking',
  balance: 1000,
  currency: 'USD',
  ...over,
});
const inst = (over: Partial<ForecastInstitution> = {}): ForecastInstitution => ({ institution_name: 'Chase', item_id: 'item_1', accounts: [acct()], ...over });
const INSTITUTIONS = [
  inst({
    accounts: [
      acct(),
      acct({ account_id: 'eur', name: 'Girokonto', balance: 500, currency: 'EUR' }),
      acct({ account_id: 'btc', name: 'Wallet', balance: 1, currency: 'BTC' }),
    ],
  }),
];
const pending = (amount: number, over: Partial<PendingRow> = {}): PendingRow => ({
  date: '2026-10-08',
  name: 'Café',
  amount,
  pending: true,
  account_name: 'Girokonto',
  account_type: 'depository',
  institution_name: 'Chase',
  iso_currency_code: 'EUR',
  transaction_code: null,
  category: 'food and drink',
  ...over,
});

describe('where it starts', () => {
  test('without a home currency, as before: the others left out and named', () => {
    const p = cashPosition(INSTITUTIONS, [pending(10)]);
    expect(p.currency).toBe('USD');
    expect(p.start).toBe(1000);
    expect(p.leftOut).toEqual([
      { currency: 'BTC', count: 1 },
      { currency: 'EUR', count: 1 },
    ]);
    expect(p.conversion).toBeUndefined();
  });

  test('with one: each balance and what is pending on it at the newest rates, to the cent', () => {
    const p = cashPosition(INSTITUTIONS, [pending(10)], { fx: FX, today: TODAY });
    expect(p.currency).toBe('USD');
    // 500 × 1.1551 = 577.55; the pending 10 × 1.1551 = 11.55.
    expect(p.balances).toBe(cents(1000 + 577.55));
    expect(p.pending).toEqual({ amount: 11.55, count: 1 });
    expect(p.start).toBe(cents(1000 + 577.55 - 11.55));
    // Listed as the account shows it, in its own currency.
    expect(p.included.find((a) => a.account_id === 'eur')).toMatchObject({ balance: 500, currency: 'EUR' });
    expect(p.leftOut).toEqual([{ currency: 'BTC', count: 1 }]);
    expect(p.conversion).toEqual({ into: 'USD', from: [{ currency: 'EUR', count: 1 }], own: [], unrated: [{ currency: 'BTC', why: 'not-published', unrated: 'BTC' }] });
    const notes = forecastNotes({ institutions: INSTITUTIONS, position: p, eventsLeftOut: [], today: TODAY, days: { day: (d) => d, instant: (d) => d, snapshot: (d) => d } });
    expect(notes).toContain("1 cash account in BTC isn't in this forecast, which is in USD: there is no rate for BTC.");
  });
});

describe('what moves it', () => {
  const row = (date: string, amount: number, over: Partial<RecurringRow> = {}): RecurringRow => ({
    date,
    name: 'Miete',
    amount,
    institution_name: 'Chase',
    account_name: 'Girokonto',
    account_type: 'depository',
    category: 'rent and utilities',
    transaction_code: null,
    iso_currency_code: 'EUR',
    ...over,
  });
  const monthly = (from: string, count: number, day: number) => scheduleDates({ unit: 'month', every: 1, days: [day], month: from, slot: 0 }, '2100-01-01', count);
  const rent = detectRecurring(monthly('2026-04', 6, 15).map((d) => row(d, 900)));
  const fee: PlannedItem = { id: 'p1', name: 'Licence', kind: 'expense', amount: 100, currency: 'GBP', date: '2026-10-20', cadence: 'once' };
  const coin: PlannedItem = { id: 'p2', name: 'Coin', kind: 'expense', amount: 1, currency: 'BTC', date: '2026-10-21', cadence: 'once' };

  test('each bill, income or planned item in another currency at the newest rates, listed in its own', () => {
    const out = forecastEvents({ series: rent, planned: [fee, coin], currency: 'USD', today: TODAY, until: '2026-11-08', fx: FX });
    const gbp = convert(FX, 100, 'GBP', 'USD', '2026-10-09');
    if (!gbp.ok) throw new Error('expected a rate');
    expect(out.events.map((e) => [e.date, e.amount, e.own])).toEqual([
      ['2026-10-15', -1039.59, { amount: -900, currency: 'EUR' }], // 900 × 1.1551
      ['2026-10-20', -gbp.amount, { amount: -100, currency: 'GBP' }],
    ]);
    expect(out.leftOut).toEqual([{ currency: 'BTC', count: 1 }]);
    expect(out.conversion?.from).toEqual([
      { currency: 'EUR', count: 1 },
      { currency: 'GBP', count: 1 },
    ]);
    expect(forecastConvertedText(cashPosition(INSTITUTIONS, [], { fx: FX, today: TODAY }).conversion, out.conversion)).toBe(
      'Converted into USD at today’s ECB rates: 1 cash account in EUR, 1 expected amount in EUR and 1 in GBP.'
    );
    // Without one: as before.
    const before = forecastEvents({ series: rent, planned: [fee], currency: 'USD', today: TODAY, until: '2026-11-08' });
    expect(before.events).toEqual([]);
    expect(before.conversion).toBeNull();
  });
});

describe('the calendar', () => {
  const txn = (over: Partial<CalendarTxn>): CalendarTxn => ({ transaction_id: 't', date: '2026-09-11', name: 'Shop', amount: 10, pending: false, iso_currency_code: 'USD', ...over });
  const rows = [txn({ transaction_id: 'a', amount: 10 }), txn({ transaction_id: 'b', amount: 20, iso_currency_code: 'EUR' })];

  test('a posted row in another currency at its own day’s rate in the day’s figure, listed in its own', () => {
    const m = calendarMonth({ month: '2026-09', today: TODAY, txns: rows, series: [], planned: [], currency: 'USD', fx: FX });
    const day = m.days.get('2026-09-11')!;
    // 20 × 1.1592 = 23.18 on the 11th.
    expect(day.posted).toBe(cents(-10 - 23.18));
    expect(day.entries.find((e) => e.ref === 'b')).toMatchObject({ amount: -20, currency: 'EUR', figure: -23.18 });
    // Without one: listed, not added.
    const before = calendarMonth({ month: '2026-09', today: TODAY, txns: rows, series: [], planned: [], currency: 'USD' }).days.get('2026-09-11')!;
    expect(before.posted).toBe(-10);
    expect(before.entries.find((e) => e.ref === 'b')).toMatchObject({ uncounted: true });
  });

  test('an expected amount in another currency at the newest rates; one with no rate listed, not added', () => {
    const fee: PlannedItem = { id: 'p1', name: 'Licence', kind: 'expense', amount: 100, currency: 'EUR', date: '2026-10-20', cadence: 'once' };
    const coin: PlannedItem = { id: 'p2', name: 'Coin', kind: 'expense', amount: 1, currency: 'BTC', date: '2026-10-20', cadence: 'once' };
    const day = calendarMonth({ month: '2026-10', today: TODAY, txns: [], series: [], planned: [fee, coin], currency: 'USD', fx: FX }).days.get('2026-10-20')!;
    expect(day.expected).toBe(-115.51); // 100 × 1.1551
    expect(day.entries.find((e) => e.ref === 'p2')).toMatchObject({ uncounted: true, off: 'currency' });
  });
});

describe('the recurring card’s note', () => {
  test('what the monthly figures converted, never an amount', async () => {
    const { monthlyConvertedText } = await import('@/components/RecurringCard');
    expect(
      monthlyConvertedText(
        { into: 'USD', from: [{ currency: 'EUR', count: 2 }], own: [], unrated: [] },
        { into: 'USD', from: [{ currency: 'GBP', count: 1 }], own: ['ARS'], unrated: [] }
      )
    ).toBe('The monthly figures count 2 bills in EUR and 1 deposit in GBP converted into USD at today’s ECB rates, and your own rate for ARS.');
    expect(monthlyConvertedText({ into: 'USD', from: [], own: [], unrated: [] }, null)).toBeNull();
  });
});
