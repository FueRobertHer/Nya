import { describe, expect, test } from 'bun:test';
import { buildForecast, cashPosition, countsInForecast, forecastEvents, forecastNotes, withPurchase, type ForecastEvent, type ForecastInstitution, type PendingRow } from '@/lib/forecast';
import { addDays, detectRecurring, scheduleDates, type RecurringRow } from '@/lib/recurring';
import type { PlannedItem } from '@/lib/planned';
import { localDate } from '@/lib/local-date';

// The cash forecast (lib/forecast.ts): where it starts, the day-by-day
// arithmetic and the lowest point, what moves it and what it leaves out, the
// what-if, and the viewer's own day as day zero.

// On the checking account unless a test says otherwise: the forecast counts
// only what leaves or reaches cash.
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

const ev = (date: string, amount: number, over: Partial<ForecastEvent> = {}): ForecastEvent => ({ date, amount, name: 'x', source: amount < 0 ? 'bill' : 'income', ref: 'r', ...over });

const plannedItem = (over: Partial<PlannedItem> = {}): PlannedItem => ({
  id: 'p1',
  name: 'Car registration',
  kind: 'expense',
  amount: 212.5,
  currency: 'USD',
  date: '2026-10-20',
  cadence: 'once',
  ...over,
});

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

describe('where it starts', () => {
  test('the cash accounts: not cards, loans or investments, and not hidden ones', () => {
    const p = cashPosition([
      inst({
        accounts: [
          acct({ account_id: 'chk', balance: 1200.1 }),
          acct({ account_id: 'sav', name: 'Savings', subtype: 'savings', balance: 3000.2 }),
          acct({ account_id: 'card', name: 'Sapphire', type: 'credit', balance: 640 }),
          acct({ account_id: 'ira', name: 'IRA', type: 'investment', balance: 50_000 }),
          acct({ account_id: 'old', name: 'Old checking', balance: 9999, hidden: true }),
        ],
      }),
      inst({ institution_name: 'Cash', manual: true, accounts: [acct({ account_id: 'wallet', name: 'Wallet', subtype: 'cash', balance: 60, currency: null, updated_at: '2026-10-01T12:00:00Z' })] }),
    ]);
    expect(p.currency).toBe('USD');
    expect(p.included.map((a) => a.account_id)).toEqual(['chk', 'sav', 'wallet']);
    // To the cent, not 4260.300000000001.
    expect(p.start).toBe(4260.3);
    expect(p.included[2]).toMatchObject({ manual: true, updated_at: '2026-10-01T12:00:00Z' });
  });

  test('one currency: the one most cash accounts are in; the rest are left out and counted', () => {
    const p = cashPosition([
      inst({
        accounts: [
          acct({ account_id: 'a', balance: 100 }),
          acct({ account_id: 'b', balance: 200 }),
          acct({ account_id: 'eur', balance: 5000, currency: 'EUR' }),
          acct({ account_id: 'gbp', balance: 7000, currency: 'GBP' }),
          acct({ account_id: 'eur2', balance: 1, currency: 'EUR' }),
        ],
      }),
    ]);
    expect(p.currency).toBe('USD');
    expect(p.start).toBe(300);
    expect(p.leftOut).toEqual([
      { currency: 'EUR', count: 2 },
      { currency: 'GBP', count: 1 },
    ]);
  });

  test('an account without a balance is named, not counted as zero', () => {
    const p = cashPosition([inst({ accounts: [acct(), acct({ account_id: 'x', name: 'Savings', balance: null })] })]);
    expect(p.start).toBe(1000);
    expect(p.noBalance).toEqual([{ name: 'Savings', institution: 'Chase' }]);
  });

  test('no cash accounts: nothing to start from', () => {
    expect(cashPosition([inst({ accounts: [acct({ type: 'credit' })] })])).toEqual({
      currency: null,
      balances: 0,
      pending: { amount: 0, count: 0 },
      start: 0,
      included: [],
      leftOut: [],
      noBalance: [],
    });
  });

  describe('less what is still pending on them', () => {
    const pending = (amount: number, over: Partial<PendingRow> = {}): PendingRow => ({
      date: '2026-10-08',
      name: 'Whole Foods',
      amount,
      pending: true,
      account_name: 'Checking',
      account_type: 'depository',
      institution_name: 'Chase',
      iso_currency_code: 'USD',
      transaction_code: null,
      category: 'food and drink',
      ...over,
    });
    const chase = () => [inst({ accounts: [acct({ balance: 1200 }), acct({ account_id: 'sav', name: 'Savings', balance: 500 }), acct({ account_id: 'card', name: 'Sapphire', type: 'credit', balance: 300 })] })];

    test('a bank leaves pending charges out of its balance, but they are spent', () => {
      // The reviewer's case: 1,200 in checking, 900 pending, rent of 1,000 in three days.
      const p = cashPosition([inst({ accounts: [acct({ balance: 1200 })] })], [pending(400), pending(500, { name: 'Target' })]);
      expect(p).toMatchObject({ balances: 1200, pending: { amount: 900, count: 2 }, start: 300 });
      const f = buildForecast(p.start, [ev('2026-10-12', -1000)], '2026-10-09', 30, 0, 'USD');
      expect(f.lowest).toEqual({ date: '2026-10-12', balance: -700 });
      expect(f.belowZero).toBe('2026-10-12');
    });

    test('not posted rows, deposits, a card\'s charges, another currency or another account', () => {
      const p = cashPosition(chase(), [
        pending(40, { pending: false }),
        // A deposit isn't money to spend yet; a paycheck pending stays expected.
        pending(-2000, { name: 'Payroll', category: 'income' }),
        pending(75, { account_name: 'Sapphire', account_type: 'credit' }),
        pending(10, { iso_currency_code: 'EUR' }),
        pending(12, { institution_name: 'Ally' }),
        pending(9.99, { account_name: 'Savings' }),
      ]);
      expect(p.pending).toEqual({ amount: 9.99, count: 1 });
      expect(p.start).toBe(1690.01);
    });

    test('a transfer between two of them, pending on both sides, moves nothing; one to elsewhere is spent', () => {
      const p = cashPosition(chase(), [
        pending(250, { name: 'Transfer to savings', category: 'transfer out' }),
        pending(-250, { name: 'Transfer from checking', category: 'transfer in', account_name: 'Savings', date: '2026-10-09' }),
        pending(100, { name: 'To brokerage', category: 'transfer out' }),
      ]);
      expect(p.pending).toEqual({ amount: 100, count: 1 });
    });
  });
});

describe('day by day', () => {
  test('each day is the one before it plus that day\'s amounts, and the lowest point is the first day it is reached', () => {
    const f = buildForecast(
      1000,
      [ev('2026-10-12', -15.49), ev('2026-10-15', 2000), ev('2026-10-16', -1500), ev('2026-10-20', -1100), ev('2026-10-25', -400.01)],
      '2026-10-09',
      30
    );
    expect(f.days).toHaveLength(31);
    expect(f.days[0]).toEqual({ date: '2026-10-09', low: 1000, balance: 1000, events: [] });
    const at = (d: string) => f.days.find((x) => x.date === d)!.balance;
    expect(at('2026-10-11')).toBe(1000);
    expect(at('2026-10-12')).toBe(984.51);
    expect(at('2026-10-15')).toBe(2984.51);
    expect(at('2026-10-16')).toBe(1484.51);
    expect(at('2026-10-20')).toBe(384.51);
    expect(at('2026-10-25')).toBe(-15.5);
    expect(f.lowest).toEqual({ date: '2026-10-25', balance: -15.5 });
    expect(f.belowZero).toBe('2026-10-25');
    expect(f.end).toBe(-15.5);
    expect(f.days[30].date).toBe('2026-11-08');
  });

  test('on a day with money in and out, the money out is counted first: the dip is the one to plan for', () => {
    // Rent and pay both expected on the 15th: which comes first isn't known.
    const f = buildForecast(300, [ev('2026-10-15', 2000), ev('2026-10-15', -1500)], '2026-10-09', 30, 100);
    const day = f.days.find((d) => d.date === '2026-10-15')!;
    expect(day).toMatchObject({ low: -1200, balance: 800 });
    expect(f.lowest).toEqual({ date: '2026-10-15', balance: -1200 });
    expect(f.belowZero).toBe('2026-10-15');
    expect(f.belowThreshold).toBe('2026-10-15');
    // A day with money in only never dips.
    expect(buildForecast(300, [ev('2026-10-15', 2000)], '2026-10-09', 30).days[6]).toMatchObject({ low: 300, balance: 2300 });
  });

  test('counted in cents: a hundred dimes are exactly ten dollars', () => {
    const f = buildForecast(0.3, Array.from({ length: 100 }, () => ev('2026-10-10', 0.1)), '2026-10-09', 30);
    expect(f.end).toBe(10.3);
    expect(buildForecast(0.1, [ev('2026-10-09', 0.2)], '2026-10-09', 0).days[0].balance).toBe(0.3);
  });

  test("counted in the currency's own minor unit: fils for KWD, whole yen", () => {
    // 10.125 KWD is ten dinars and 125 fils, not 10.13.
    const kwd = buildForecast(100, [ev('2026-10-10', -10.125), ev('2026-10-11', -0.001)], '2026-10-09', 30, 0, 'KWD');
    expect(kwd.end).toBe(89.874);
    expect(buildForecast(1000, [ev('2026-10-10', -333)], '2026-10-09', 30, 0, 'JPY').end).toBe(667);
  });

  test('with nothing going out, the lowest point is today, and ties go to the earliest day', () => {
    const f = buildForecast(500, [ev('2026-10-15', 100), ev('2026-10-16', -100)], '2026-10-09', 30);
    expect(f.lowest).toEqual({ date: '2026-10-09', balance: 500 });
    expect(f.belowZero).toBeNull();
  });

  test('the balance now counts: a paycheck expected today has not come yet', () => {
    const f = buildForecast(100, [ev('2026-10-09', 2000), ev('2026-10-10', -50)], '2026-10-09', 30);
    expect(f.start).toBe(100);
    expect(f.days[0].balance).toBe(2100);
    expect(f.lowest).toEqual({ date: '2026-10-09', balance: 100 });
    // Overdrawn now: below zero today, whatever comes in later.
    const over = buildForecast(-20, [ev('2026-10-09', 500)], '2026-10-09', 30, 100);
    expect(over.belowZero).toBe('2026-10-09');
    expect(over.belowThreshold).toBe('2026-10-09');
    expect(over.lowest).toEqual({ date: '2026-10-09', balance: -20 });
  });

  test('the warning: the first day below it, apart from below zero', () => {
    const f = buildForecast(300, [ev('2026-10-12', -250), ev('2026-10-20', -100)], '2026-10-09', 30, 100);
    expect(f.belowThreshold).toBe('2026-10-12');
    expect(f.belowZero).toBe('2026-10-20');
    expect(buildForecast(300, [ev('2026-10-12', -250)], '2026-10-09', 30, 0).belowThreshold).toBeNull();
  });

  test('today\'s own amounts count today, and nothing outside the range counts', () => {
    const f = buildForecast(100, [ev('2026-10-09', -40), ev('2026-10-08', -1000), ev('2026-11-09', -1000)], '2026-10-09', 30);
    expect(f.days[0].balance).toBe(60);
    expect(f.end).toBe(60);
  });

  test('ranges of 60 and 90 days, across a year end', () => {
    expect(buildForecast(0, [], '2026-12-01', 60).days.at(-1)!.date).toBe('2027-01-30');
    expect(buildForecast(0, [], '2026-12-01', 90).days).toHaveLength(91);
  });
});

describe('what moves it', () => {
  test('only cash: a card\'s own charges are never taken out beside the card\'s payment', () => {
    // The reviewer's case: Netflix and Spotify on a card, and the card's
    // autopay of exactly those from checking. Only the autopay leaves cash.
    const months = ['2026-03', '2026-04', '2026-05', '2026-06', '2026-07', '2026-08', '2026-09'];
    const card = { account_name: 'Sapphire', account_type: 'credit' };
    const rows = months.flatMap((m) => [
      row(`${m}-12`, 15.49, card),
      row(`${m}-20`, 10.99, { name: 'Spotify', ...card }),
      row(`${m}-25`, -26.48, { name: 'Payment Thank You', category: 'loan payments', ...card }),
      row(`${m}-25`, 26.48, { name: 'CHASE CREDIT CRD AUTOPAY', category: 'loan payments', subcategory: 'credit card payment' }),
      // A statement credit on the card is not income at all: money in on a
      // card pays it off or refunds a purchase.
      row(`${m}-03`, -5, { name: 'Card perk credit', category: 'income', ...card }),
    ]);
    const s = detectRecurring(rows);
    expect(s.map((x) => [x.name, x.accountType])).toEqual([
      ['CHASE CREDIT CRD AUTOPAY', 'depository'],
      ['Netflix', 'credit'],
      ['Spotify', 'credit'],
    ]);
    expect(s.map(countsInForecast)).toEqual([true, false, false]);
    // The autopay pays the card its side shows the payment received on.
    expect(s[0]).toMatchObject({ paysCard: true, paysCardOf: { institution: 'Chase', account: 'Sapphire' } });
    const { events } = forecastEvents({ series: s, planned: [], currency: 'USD', today: '2026-10-09', until: '2026-11-08' });
    expect(events.map((e) => [e.date, e.name, e.amount])).toEqual([['2026-10-25', 'CHASE CREDIT CRD AUTOPAY', -26.48]]);
    expect(buildForecast(1000, events, '2026-10-09', 30, 0, 'USD').end).toBe(973.52);
  });

  test('a series on an account of unknown type, varying pay and pay that stopped are left out and named', () => {
    const unknown = detectRecurring(monthly('2026-04', 6, 12).map((d) => row(d, 15.49, { account_type: null })));
    const gigs = [800, 2900, 1200, 2600, 900, 3000, 1100, 2500, 950, 2800, 1000, 2700].map((a, i) => row(addDays('2026-04-24', i * 14), -a, { name: 'Gig pay', category: 'income' }));
    const varies = detectRecurring(gigs);
    expect(varies[0].agreement).toBe('varies');
    const gone = detectRecurring(monthly('2026-03', 5, 1).map((d) => row(d, -3000, { name: 'Old job', category: 'income' })));
    const out = forecastEvents({ series: [...unknown, ...varies, ...gone], planned: [], currency: 'USD', today: '2026-10-09', until: '2026-11-08' });
    expect(out.events).toEqual([]);
    expect(out.unplaced.map((x) => x.name)).toEqual(['Netflix']);
    expect(out.varied.map((x) => x.name)).toEqual(['Gig pay']);
    expect(out.lapsed.map((x) => x.name)).toEqual(['Old job']);
  });

  const series = () => [
    ...detectRecurring(monthly('2026-04', 6, 12).map((d) => row(d, 15.49))),
    ...detectRecurring(monthly('2026-04', 6, 1).map((d) => row(d, -3000, { name: 'Payroll', category: 'income' }))),
  ];

  test('detected bills out and income in, on their dates, and planned items', () => {
    const { events, leftOut } = forecastEvents({ series: series(), planned: [plannedItem()], currency: 'USD', today: '2026-10-09', until: '2026-11-08' });
    expect(events.map((e) => [e.date, e.amount, e.source])).toEqual([
      ['2026-10-12', -15.49, 'bill'],
      ['2026-10-20', -212.5, 'planned'],
      ['2026-11-01', 3000, 'income'],
    ]);
    expect(leftOut).toEqual([]);
  });

  test('a bill late within its tolerance counts today; one past it is taken as skipped', () => {
    const late = forecastEvents({ series: series(), planned: [], currency: 'USD', today: '2026-10-14', until: '2026-11-13' }).events;
    expect(late[0]).toMatchObject({ date: '2026-10-14', due: '2026-10-12', late: true, amount: -15.49 });
    const skipped = forecastEvents({ series: series(), planned: [], currency: 'USD', today: '2026-10-20', until: '2026-11-19' }).events;
    expect(skipped.map((e) => e.date)).toEqual(['2026-11-01', '2026-11-12']);
  });

  test('a dismissed series, and one that ended, move nothing', () => {
    const s = series();
    const netflix = s.find((x) => x.name === 'Netflix')!;
    const { events } = forecastEvents({ series: s, planned: [], dismissed: new Set([netflix.id]), currency: 'USD', today: '2026-10-09', until: '2026-11-08' });
    expect(events.map((e) => e.name)).toEqual(['Payroll']);
    // Two months on with nothing arriving, both have ended.
    expect(forecastEvents({ series: s, planned: [], currency: 'USD', today: '2026-12-20', until: '2027-01-19' }).events).toEqual([]);
  });

  test('another currency is left out and counted; a series that names none is taken to be in the forecast\'s', () => {
    const s = [
      ...detectRecurring(monthly('2026-04', 6, 5).map((d) => row(d, 9, { name: 'Cloud', iso_currency_code: 'EUR' }))),
      ...detectRecurring(monthly('2026-04', 6, 7).map((d) => row(d, 30, { name: 'Old row', iso_currency_code: null }))),
    ];
    const { events, leftOut } = forecastEvents({
      series: s,
      planned: [plannedItem({ currency: 'GBP' }), plannedItem({ id: 'p2', currency: 'USD', date: '2026-10-21' })],
      currency: 'USD',
      today: '2026-10-09',
      until: '2026-11-08',
    });
    // The old row's Oct 7 is two days late: today, then Nov 7.
    expect(events.map((e) => [e.name, e.date])).toEqual([
      ['Old row', '2026-10-09'],
      ['Car registration', '2026-10-21'],
      ['Old row', '2026-11-07'],
    ]);
    expect(leftOut).toEqual([
      { currency: 'EUR', count: 1 },
      { currency: 'GBP', count: 1 },
    ]);
    // With no currency on any cash account, everything counts.
    expect(forecastEvents({ series: s, planned: [], currency: null, today: '2026-10-09', until: '2026-11-08' }).leftOut).toEqual([]);
  });

  test('a repeating planned item falls on each of its days in range', () => {
    const { events } = forecastEvents({
      series: [],
      planned: [plannedItem({ kind: 'income', amount: 400, cadence: 'biweekly', date: '2026-09-25', name: 'Room let' })],
      currency: 'USD',
      today: '2026-10-09',
      until: '2026-11-08',
    });
    expect(events.map((e) => [e.date, e.amount])).toEqual([
      ['2026-10-09', 400],
      ['2026-10-23', 400],
      ['2026-11-06', 400],
    ]);
  });
});

describe('the what-if', () => {
  const base = [ev('2026-10-15', 2000), ev('2026-10-20', -1800)];

  test('one purchase, and the new lowest point', () => {
    const before = buildForecast(500, base, '2026-10-09', 30);
    expect(before.lowest).toEqual({ date: '2026-10-09', balance: 500 });
    const after = buildForecast(500, withPurchase(base, { amount: 900, date: '2026-10-12' }), '2026-10-09', 30);
    expect(after.lowest).toEqual({ date: '2026-10-12', balance: -400 });
    expect(after.belowZero).toBe('2026-10-12');
    expect(after.end).toBe(-200);
    // The purchase is a day's own amount, named.
    expect(after.days[3].events).toEqual([{ date: '2026-10-12', amount: -900, name: 'What if', source: 'what-if', ref: 'what-if' }]);
  });

  test('after payday it moves the end, and the lowest point only if it goes lower', () => {
    const after = buildForecast(500, withPurchase(base, { amount: 100, date: '2026-10-16' }), '2026-10-09', 30);
    expect(after.lowest).toEqual({ date: '2026-10-09', balance: 500 });
    expect(after.end).toBe(600);
    const big = buildForecast(500, withPurchase(base, { amount: 2400, date: '2026-10-16' }), '2026-10-09', 30);
    expect(big.lowest).toEqual({ date: '2026-10-20', balance: -1700 });
  });

  test('an amount typed as negative is still money out', () => {
    expect(buildForecast(0, withPurchase([], { amount: -50, date: '2026-10-09' }), '2026-10-09', 30).end).toBe(-50);
  });
});

describe('day zero is the viewer\'s day', () => {
  /** The calendar day of an instant in a time zone, as a browser there has it. */
  const dayIn = (at: Date, timeZone: string) => at.toLocaleDateString('en-CA', { timeZone });

  test('late in the evening it is still that day, whatever UTC says', () => {
    // Built from local parts, so this holds in whatever zone the tests run in.
    const evening = new Date(2026, 9, 9, 22, 30);
    const today = localDate(evening);
    expect(today).toBe('2026-10-09');
    // A bill due on the 10th is tomorrow, not today.
    const f = buildForecast(100, [ev('2026-10-10', -80)], today, 30);
    expect(f.days[0]).toMatchObject({ date: '2026-10-09', balance: 100 });
    expect(f.days[1]).toMatchObject({ date: '2026-10-10', balance: 20 });
  });

  test('in California UTC is already the 10th; the forecast starts on the 9th there', () => {
    // 22:30 in Los Angeles on Oct 9 is 05:30 UTC on Oct 10.
    const at = new Date('2026-10-10T05:30:00Z');
    expect(at.toISOString().slice(0, 10)).toBe('2026-10-10');
    const today = dayIn(at, 'America/Los_Angeles');
    expect(today).toBe('2026-10-09');
    expect(buildForecast(100, [ev('2026-10-10', -80)], today, 30).days[0].balance).toBe(100);
  });

  test('in Auckland UTC is still the 9th; a bill due on the 9th is a day late there, so it counts today', () => {
    // 09:30 in Auckland on Oct 10 is 20:30 UTC on Oct 9.
    const at = new Date('2026-10-09T20:30:00Z');
    const today = dayIn(at, 'Pacific/Auckland');
    expect(today).toBe('2026-10-10');
    const s = detectRecurring(monthly('2026-05', 5, 9).map((d) => row(d, 15.49)));
    const { events } = forecastEvents({ series: s, planned: [], currency: 'USD', today, until: '2026-11-09' });
    expect(events[0]).toMatchObject({ date: '2026-10-10', due: '2026-10-09', late: true });
    // On UTC's day it would have been due today, not late.
    expect(forecastEvents({ series: s, planned: [], currency: 'USD', today: '2026-10-09', until: '2026-11-09' }).events[0]).toMatchObject({ date: '2026-10-09' });
  });
});

describe('what it says it may be missing', () => {
  const days = { snapshot: (d: string) => `snap ${d}`, instant: (iso: string) => `day ${iso.slice(0, 10)}`, day: (d: string) => `on ${d}` };
  const notes = (institutions: ForecastInstitution[], extra: Partial<Parameters<typeof forecastNotes>[0]> = {}) =>
    forecastNotes({ institutions, position: cashPosition(institutions), eventsLeftOut: [], today: '2026-10-09', days, ...extra });

  test('nothing, when nothing is wrong', () => {
    expect(notes([inst()])).toEqual([]);
  });

  test('a balance recovered from an earlier day, and an institution not reached', () => {
    expect(notes([inst({ error: 'x', needs_reauth: true, stale_as_of: '2026-10-03' })])).toEqual(['Chase needs reconnecting, so this starts from its balances on snap 2026-10-03.']);
    expect(notes([inst(), inst({ institution_name: 'Ally', error: 'x', accounts: [] })])).toEqual(["Ally couldn't be reached, so any checking or savings there isn't in this forecast."]);
    // Its accounts remembered: the cash ones are named, the rest needn't be.
    expect(
      notes([
        inst(),
        inst({ institution_name: 'Ally', error: 'x', accounts: [], unshown_accounts: [{ name: 'Joint checking', type: 'depository' }, { name: 'Ally card', type: 'credit' }] }),
      ])
    ).toEqual(["Ally couldn't be reached, so Joint checking there isn't in this forecast."]);
    expect(notes([inst(), inst({ institution_name: 'Ally', error: 'x', accounts: [], unshown_accounts: [{ name: 'Ally card', type: 'credit' }] })])).toEqual([]);
  });

  test('checking or savings a bank could not show, or that stopped reporting', () => {
    // Recovered, short its savings, named.
    expect(
      notes([inst({ error: 'x', stale_as_of: '2026-10-03', stale_missing: 1, unshown_accounts: [{ name: 'Savings', type: 'depository' }] })])
    ).toEqual([
      "Chase couldn't refresh, so this starts from its balances on snap 2026-10-03.",
      "Savings at Chase couldn't be shown, so its balance isn't in this forecast.",
    ]);
    // A payload from before the names were sent: counted.
    expect(notes([inst({ error: 'x', stale_as_of: '2026-10-03', stale_missing: 2 })])[1]).toBe("2 accounts at Chase couldn't be shown, so any cash in them isn't in this forecast.");
    // Missing from an otherwise good fetch.
    expect(notes([inst({ unconfirmed_missing: 1 })])).toEqual(["1 account at Chase stopped reporting, so any cash in it isn't in this forecast."]);
  });

  test("a card's payment due that the forecast doesn't hold is named, with its statement balance", () => {
    const sapphire = { account_id: 'card', name: 'Sapphire', type: 'credit', balance: 812.4, currency: 'USD', liability: { minimum_payment: 40, next_due_date: '2026-10-22', last_statement_balance: 812.4 } };
    const withCard = [inst({ accounts: [acct(), sapphire] })];
    const cardNotes = (series: Parameters<typeof forecastNotes>[0]['series']) =>
      forecastNotes({ institutions: withCard, position: cashPosition(withCard), eventsLeftOut: [], series, until: '2026-11-08', today: '2026-10-09', days });
    const none = { known: new Set<string>(), unknown: [] as number[] };
    const named =
      "Sapphire's payment, statement balance $812.40, is due on 2026-10-22 and isn't in this forecast, since it changes each month. Add it as a planned expense if you'll pay it from checking.";
    expect(cardNotes({ cardsPaid: none })).toEqual([named]);
    // Held: a payment detected from checking to that card.
    expect(cardNotes({ cardsPaid: { known: new Set(['Chase|Sapphire']), unknown: [] } })).toEqual([]);
    // A payment held to a card it can't tell mutes only a card it could be:
    // one near this card's statement or minimum.
    expect(cardNotes({ cardsPaid: { known: new Set(), unknown: [800] } })).toEqual([]);
    expect(cardNotes({ cardsPaid: { known: new Set(), unknown: [40] } })).toEqual([]);
    expect(cardNotes({ cardsPaid: { known: new Set(), unknown: [150] } })).toEqual([named]);
    // Due after the forecast's end, or nothing owed: not said.
    expect(forecastNotes({ institutions: withCard, position: cashPosition(withCard), eventsLeftOut: [], series: { cardsPaid: none }, until: '2026-10-20', today: '2026-10-09', days })).toEqual([]);
    const withLiability = (liability: object) => [inst({ accounts: [acct(), { ...sapphire, liability: { ...sapphire.liability, ...liability } }] })];
    const notesFor = (institutions: ForecastInstitution[], planned: PlannedItem[] = []) =>
      forecastNotes({ institutions, position: cashPosition(institutions), eventsLeftOut: [], series: { cardsPaid: none }, until: '2026-11-08', today: '2026-10-09', days, planned });
    expect(notesFor(withLiability({ last_statement_balance: 0 }))).toEqual([]);
    // The statement paid in full since it was issued: nothing left to plan.
    expect(notesFor(withLiability({ last_payment_amount: 812.4, last_payment_date: '2026-10-03', last_statement_issue_date: '2026-09-30' }))).toEqual([]);
    // Paid in part since: what is left of it.
    expect(notesFor(withLiability({ last_payment_amount: 400, last_payment_date: '2026-10-03', last_statement_issue_date: '2026-09-30' }))).toEqual([
      "Sapphire's payment, $412.40 left of its statement, is due on 2026-10-22 and isn't in this forecast, since it changes each month. Add it as a planned expense if you'll pay it from checking.",
    ]);
    // A payment before the statement was on an earlier one.
    expect(notesFor(withLiability({ last_payment_amount: 812.4, last_payment_date: '2026-09-25', last_statement_issue_date: '2026-09-30' }))).toEqual([named]);
    // Once planned, as the note asks, it isn't asked again.
    const payment = plannedItem({ name: 'Sapphire payment', amount: 812.4, date: '2026-10-22' });
    expect(notesFor(withCard, [payment])).toEqual([]);
    expect(notesFor(withCard, [{ ...payment, amount: 40, date: '2026-10-20' }])).toEqual([]);
    // Planned far from its due date, or for another amount: still said.
    expect(notesFor(withCard, [{ ...payment, date: '2026-11-05' }])).toEqual([named]);
    expect(notesFor(withCard, [{ ...payment, amount: 2000 }])).toEqual([named]);
  });

  test('pay that stopped coming or varies too much, and a series on an account of unknown type', () => {
    const pay = detectRecurring(monthly('2026-03', 6, 1).map((d) => row(d, -3000, { category: 'income' })))[0];
    const one = (name: string) => ({ ...pay, name, lastDate: '2026-08-01' });
    expect(notes([inst()], { series: { lapsed: [one('Old job')], varied: [one('Gig pay')], unplaced: [one('Netflix'), one('Spotify')] } })).toEqual([
      "Old job hasn't come since on 2026-08-01, so it isn't in this forecast. If it still comes, add it as planned income.",
      'Gig pay comes on a schedule, but its amount varies too much to forecast, so it isn\'t in this. Add what you expect as planned income.',
      "Netflix and Spotify are on an account whose type isn't known, so they aren't in this forecast.",
    ]);
  });

  test('a connection that stopped syncing, or whose transactions are missing or arriving', () => {
    expect(
      notes([inst()], {
        stopped: [{ institution_name: 'Chase', last_ok_at: '2026-10-01T12:00:00Z' }],
        incomplete: [{ institution_name: 'Ally', coverage: 'missing' }, { institution_name: 'Citi', coverage: 'importing' }],
      })
    ).toEqual([
      "Transactions from Ally couldn't be loaded, so bills and income there may be missing.",
      "Chase hasn't synced since day 2026-10-01, so bills and income there may be missing or out of date.",
      'Citi is still importing older transactions, so some bills may not be found yet.',
    ]);
  });

  test('transactions that never come in', () => {
    expect(notes([inst()], { refused: ['Ally'], unallowed: ['Citi'] })).toEqual([
      "Plaid doesn't provide transactions for the bank or card accounts at Ally, so their bills and income aren't in this forecast.",
      "You didn't allow Nya to see transactions from the bank or card accounts at Citi, so their bills and income aren't in this forecast.",
    ]);
  });

  test('a typed balance a week old, and what was left out', () => {
    const wallet = inst({ institution_name: 'Cash', manual: true, accounts: [acct({ account_id: 'w', name: 'Wallet', updated_at: '2026-09-20T12:00:00Z' })] });
    const fresh = inst({ institution_name: 'Cash', manual: true, accounts: [acct({ account_id: 'w', name: 'Wallet', updated_at: '2026-10-05T12:00:00Z' })] });
    expect(notes([wallet])).toEqual(["Wallet's balance was last updated on day 2026-09-20."]);
    expect(notes([fresh])).toEqual([]);
    expect(
      notes([inst({ accounts: [acct(), acct({ account_id: 'e', currency: 'EUR' }), acct({ account_id: 'n', name: 'Savings', balance: null })] })], {
        eventsLeftOut: [{ currency: 'EUR', count: 2 }],
      })
    ).toEqual([
      "Savings at Chase has no balance to start from, so it isn't in this forecast.",
      "1 cash account in EUR isn't in this forecast, which is in USD.",
      "2 expected amounts in EUR aren't in this forecast, which is in USD.",
    ]);
  });

});
