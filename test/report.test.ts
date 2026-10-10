import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import MonthBreakdown from '@/components/MonthBreakdown';
import { badgeOf } from '@/components/ConnectionHealth';
import { formatMoney } from '@/lib/format';
import { summarize, categoryTotals } from '@/lib/totals';
import { HEALTH_STATES } from '@/lib/connection-state';
import type { Txn } from '@/lib/transactions';
import {
  readReportParams,
  resolvePeriod,
  periodMonths,
  dayIn,
  isTimeZone,
  MAX_RANGE_DAYS,
  type Period,
  type ReportRequest,
} from '@/lib/report/period';
import { buildReport, POST_DAYS, APPENDIX_LIMIT, type ReportInput, type SourceFacts, type Gap } from '@/lib/report/build';
import { gapSentences, statusHeadline, statusLines, caveatLines, totalsNote, STATE_WORDS, SYNC_REMEDY, appendixStatus, sourceName, reportTitle } from '@/lib/report/words';
import { reportCsv, reportFilename, REPORT_CSV_COLUMNS } from '@/lib/report/csv';
import { parseReportSettings, isReportSettings, REPORT_SETTINGS_LIMITS } from '@/lib/report/settings';
import { parseCsv } from './csv-parse';

// Reports for an accountant (#43), the pure core: the period a request asks
// for and its bounds (lib/report/period.ts); the report built from the
// Activity tab's rows (lib/report/build.ts), held to the Activity tab's own
// totals; every kind of gap and the months it touches; the empty period; the
// marked categories and their appendix; the words (lib/report/words.ts) and
// the CSV (lib/report/csv.ts); and the shape of the settings.

const NY = 'America/New_York';
/** 2026-10-10, mid-morning in New York. */
const NOW = Date.parse('2026-10-10T14:00:00.000Z');
const iso = (d: string) => d;

function row(id: string, date: string, amount: number, over: Partial<Txn> = {}): Txn {
  return {
    transaction_id: id,
    date,
    name: id,
    amount,
    pending: false,
    account_name: 'Checking',
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

const period = (request: ReportRequest, tz = NY, now = NOW): Period => {
  const p = resolvePeriod(request, tz, now);
  if ('error' in p) throw new Error(p.error);
  return p;
};
const YEAR_2025 = period({ kind: 'year', year: 2025 });

/** A healthy institution whose transactions were brought in well after 2025. */
const chase = (over: Partial<SourceFacts> = {}): SourceFacts => ({
  item_id: 'item_chase',
  institution_name: 'Chase',
  institution_id: 'ins_3',
  coverage: 'complete',
  synced_at: '2026-10-10T13:00:00.000Z',
  first_date: '2023-04-01',
  no_transactions: null,
  last_ok_at: '2026-10-10T13:00:00.000Z',
  problem: null,
  records_unreadable: false,
  ...over,
});

const input = (over: Partial<ReportInput> = {}): ReportInput => ({
  period: YEAR_2025,
  generatedAt: new Date(NOW).toISOString(),
  rows: [],
  currency: null,
  sources: [chase()],
  notes: [],
  manual: [],
  removed: [],
  removedUnreadable: 0,
  marked: null,
  markedUnreadable: false,
  hidden: false,
  healthUnread: false,
  ...over,
});

/** A month of the Activity tab's rows, every rule exercised: pay, spending in
 *  three categories, a refund, a transfer, cash taken out, a card's payment, a
 *  bank's fee, one excluded, one whose exclusion couldn't be read, one in
 *  another currency, one with no currency, a pending charge, and rows entered
 *  by hand and imported from a file. */
const MARCH: Txn[] = [
  row('pay', '2025-03-01', -5000, { category: 'income', transaction_code: 'payroll' }),
  row('rent', '2025-03-01', 1800, { category: 'rent and utilities' }),
  row('grocer', '2025-03-04', 212.37, { category: 'food and drink' }),
  row('cafe', '2025-03-05', 6.5, { category: 'food and drink' }),
  row('doctor', '2025-03-07', 140, { category: 'medical' }),
  row('refund', '2025-03-08', -40, { category: 'general merchandise' }),
  row('to-savings', '2025-03-09', 1000, { category: 'transfer out', transaction_code: 'transfer' }),
  row('atm', '2025-03-10', 200, { category: 'general merchandise', transaction_code: 'atm' }),
  row('card-payment', '2025-03-11', 650, { category: 'loan payments' }),
  row('fee', '2025-03-12', 35, { category: 'bank fees' }),
  row('tv', '2025-03-14', 1200, { category: 'general merchandise', excluded: true }),
  row('unknown', '2025-03-15', 80, { category: 'medical', excluded: null }),
  row('paris', '2025-03-16', 90, { category: 'travel', iso_currency_code: 'EUR' }),
  row('old', '2025-03-17', 12, { iso_currency_code: null }),
  row('pending', '2025-03-18', 23.45, { category: 'food and drink', pending: true }),
  row('manual-txn:cash', '2025-03-19', 15, { category: 'medical', source: 'manual', account_id: 'manual_wallet', account_name: 'Wallet', institution_name: 'Cash', note: 'co-pay' }),
  row('manual-txn:ofx', '2025-03-20', 55.1, { category: 'medical', source: 'import:ofx', account_id: 'manual_cu', account_name: 'Share draft', institution_name: 'Credit Union' }),
];

describe('the period', () => {
  test('a year, a range, and the time zone, read field by field', () => {
    const q = (s: string) => readReportParams(new URLSearchParams(s));
    expect(q('year=2025&tz=America/New_York')).toEqual({ request: { kind: 'year', year: 2025 }, timeZone: NY, currency: null, format: 'json' });
    expect(q('kind=range&start=2026-01-01&end=2026-03-31&currency=EUR&format=csv')).toEqual({
      request: { kind: 'range', start: '2026-01-01', end: '2026-03-31' },
      timeZone: 'UTC',
      currency: 'EUR',
      format: 'csv',
    });
    const refused: [string, string][] = [
      ['year=2025&year=2024', 'more than once'],
      ['year=2025&debug=1', 'Unknown parameter "debug"'],
      ['kind=week', 'kind must be'],
      ['year=25', 'year must be a year'],
      ['year=2025&start=2025-01-01', 'A year takes no start or end'],
      ['kind=range&start=2025-02-30&end=2025-03-01', 'each a date written YYYY-MM-DD'],
      ['kind=range&start=2025-01-01', 'each a date written YYYY-MM-DD'],
      ['kind=range&year=2025&start=2025-01-01&end=2025-02-01', 'not a year'],
      ['year=2025&tz=Mars/Olympus', 'tz must be a time zone'],
      ['year=2025&tz=../../etc', 'tz must be a time zone'],
      ['year=2025&currency=usd', 'currency must be'],
      ['year=2025&format=pdf', 'format must be'],
    ];
    for (const [s, reason] of refused) {
      const r = q(s);
      expect('error' in r && r.error).toContain(reason);
    }
  });

  test('time zones and days are read on the person’s calendar', () => {
    expect(isTimeZone(NY)).toBe(true);
    expect(isTimeZone('UTC')).toBe(true);
    expect(isTimeZone('Nowhere/Special')).toBe(false);
    expect(isTimeZone('')).toBe(false);
    // 02:30 UTC on the 1st is still the evening before in New York.
    expect(dayIn('2026-01-01T02:30:00.000Z', NY)).toBe('2025-12-31');
    expect(dayIn('2026-01-01T02:30:00.000Z', 'UTC')).toBe('2026-01-01');
    expect(dayIn('2026-01-01T02:30:00.000Z', 'Asia/Tokyo')).toBe('2026-01-01');
    expect(dayIn('not a time', NY)).toBeNull();
  });

  test('a year: from 2000 to this one, and this one only through today', () => {
    expect(YEAR_2025).toEqual({ kind: 'year', start: '2025-01-01', end: '2025-12-31', through: '2025-12-31', today: '2026-10-10', time_zone: NY });
    expect(period({ kind: 'year', year: 2026 })).toMatchObject({ start: '2026-01-01', end: '2026-12-31', through: '2026-10-10' });
    expect(resolvePeriod({ kind: 'year', year: 2027 }, NY, NOW)).toEqual({ error: 'Choose a year from 2000 to 2026.' });
    expect(resolvePeriod({ kind: 'year', year: 1999 }, NY, NOW)).toEqual({ error: 'Choose a year from 2000 to 2026.' });
    // New Year's Eve evening in New York is already the new year in UTC: the
    // person's own year is the one that counts.
    const eve = Date.parse('2027-01-01T03:00:00.000Z');
    expect(resolvePeriod({ kind: 'year', year: 2027 }, NY, eve)).toEqual({ error: 'Choose a year from 2000 to 2026.' });
    expect(period({ kind: 'year', year: 2026 }, NY, eve)).toMatchObject({ through: '2026-12-31', today: '2026-12-31' });
    expect(period({ kind: 'year', year: 2027 }, 'UTC', eve)).toMatchObject({ through: '2027-01-01' });
  });

  test('a range: in order, from 2000, ending today at the latest, at most two years long', () => {
    expect(period({ kind: 'range', start: '2026-01-01', end: '2026-10-10' })).toMatchObject({ start: '2026-01-01', end: '2026-10-10', through: '2026-10-10' });
    const range = (start: string, end: string) => resolvePeriod({ kind: 'range', start, end }, NY, NOW);
    expect(range('2026-03-01', '2026-02-01')).toEqual({ error: 'The range ends before it starts.' });
    expect(range('2026-10-01', '2026-10-11')).toEqual({ error: 'A range can’t end after today (2026-10-10).' });
    expect(range('1999-12-31', '2000-06-30')).toEqual({ error: 'A range can’t start before 2000-01-01.' });
    // Two years, a leap day included, is the most.
    expect('error' in range('2023-10-10', '2025-10-09')).toBe(false);
    expect(range('2023-10-09', '2025-10-10')).toEqual({ error: `A range can be at most two years long (${MAX_RANGE_DAYS} days).` });
    expect(range('2026-02-30', '2026-03-01')).toMatchObject({ error: expect.stringContaining('YYYY-MM-DD') });
  });

  test('its months: a year has twelve, a range starts and ends where it does', () => {
    expect(periodMonths(YEAR_2025).map((m) => m.month)).toEqual(Array.from({ length: 12 }, (_, i) => `2025-${String(i + 1).padStart(2, '0')}`));
    expect(periodMonths(YEAR_2025)[1]).toEqual({ month: '2025-02', start: '2025-02-01', end: '2025-02-28' });
    expect(periodMonths(period({ kind: 'range', start: '2024-02-15', end: '2024-04-10' }))).toEqual([
      { month: '2024-02', start: '2024-02-15', end: '2024-02-29' },
      { month: '2024-03', start: '2024-03-01', end: '2024-03-31' },
      { month: '2024-04', start: '2024-04-01', end: '2024-04-10' },
    ]);
  });
});

/** The figures the Activity tab shows for the only month it is given. */
function activityTab(txns: Txn[]) {
  const html = renderToStaticMarkup(createElement(MonthBreakdown, { txns, notes: [], loading: false, onRecategorize: () => {}, onRename: () => {} }));
  const figure = (label: string) => new RegExp(`total-label">${label}</div><div class="summary-value[^"]*">([^<]*)<`).exec(html)?.[1];
  const top = html.slice(html.indexOf('Top spending'));
  const categories = [...top.matchAll(/class="cat-name">([^<]*)<\/span>.*?class="cat-val">([^<]*)</g)].map((m) => [m[1], m[2]]);
  const note = /class="chart-note">(.*?)<\/div>/.exec(html)?.[1].replace(/<!-- -->/g, '').replace(/&#x27;/g, "'") ?? '';
  return { in: figure('In'), out: figure('Out'), net: figure('Net'), categories, note };
}

describe('the totals are the Activity tab’s', () => {
  test('a month’s money in, out and net, and its top categories, match the Activity tab for the same rows', () => {
    const tab = activityTab(MARCH);
    const r = buildReport(input({ rows: MARCH, period: period({ kind: 'range', start: '2025-03-01', end: '2025-03-31' }) }));
    expect(r.currency).toBe('USD');
    const money = (n: number) => formatMoney(n, r.currency);
    expect(tab.in).toBe(money(r.totals.money_in));
    expect(tab.out).toBe(money(r.totals.money_out));
    expect(tab.net).toBe(money(r.totals.net));
    // The Activity tab shows the top five; the report lists them all, in the same order.
    expect(tab.categories).toEqual(r.money_out.slice(0, 5).map((c) => [c.category, money(c.amount)]));
    // What each leaves out, and why, agrees too.
    expect(tab.note).toContain(`and ${r.totals.excluded} transaction you left out`);
    expect(tab.note).toContain(`Whether you excluded ${r.totals.exclusion_unknown} transaction couldn't be read`);
    expect(tab.note).toContain(r.totals.left_out_text!);
    // And the month's row in a year's report is the same month.
    const year = buildReport(input({ rows: MARCH }));
    const march = year.months.find((m) => m.month === '2025-03')!;
    expect([march.money_in, march.money_out, march.net]).toEqual([r.totals.money_in, r.totals.money_out, r.totals.net]);
  });

  test('with the Activity tab’s currency, a month matches it however the other months’ currencies run', () => {
    // A year mostly in euros, then a month mostly in dollars: the tab totals
    // every month in euros (the currency most of its rows are in); a report on
    // that month alone would pick dollars, and given euros, agrees with the tab.
    const year = [
      ...Array.from({ length: 8 }, (_, i) => row(`eu${i}`, `2025-0${1 + (i % 2)}-1${i}`, 10 + i, { iso_currency_code: 'EUR' })),
      row('us1', '2025-03-02', 100),
      row('us2', '2025-03-03', 50),
      row('eu-march', '2025-03-04', 7, { iso_currency_code: 'EUR' }),
      row('eu-refund', '2025-03-05', -3, { iso_currency_code: 'EUR' }),
    ];
    const tab = activityTab(year);
    const march = period({ kind: 'range', start: '2025-03-01', end: '2025-03-31' });
    expect(buildReport(input({ rows: year, period: march })).currency).toBe('USD');
    const r = buildReport(input({ rows: year, period: march, currency: 'EUR' }));
    const money = (n: number) => formatMoney(n, 'EUR');
    expect([tab.in, tab.out, tab.net]).toEqual([money(r.totals.money_in), money(r.totals.money_out), money(r.totals.net)]);
    expect(r.totals.left_out_text).toBe("2 transactions in USD aren't in these totals, which are in EUR.");
    expect(tab.note).toContain(r.totals.left_out_text!);
  });

  test('every rule, figure by figure: transfers, cash and card payments never count, exclusions are left out and counted, one currency', () => {
    const r = buildReport(input({ rows: MARCH }));
    // In: pay and the refund. Out: everything spent in USD (or no currency),
    // the pending charge, the fee, the row whose exclusion couldn't be read,
    // and the rows entered by hand or imported; not the transfer, the cash,
    // the card payment, the excluded TV or the euros.
    expect(r.totals.money_in).toBe(5040);
    expect(r.totals.money_out).toBe(2379.42);
    expect(r.totals.net).toBe(2660.58);
    expect(r.totals).toMatchObject({ transactions: 17, transfers: 3, excluded: 1, exclusion_unknown: 1, left_out: [{ currency: 'EUR', count: 1 }] });
    expect(r.totals.left_out_text).toBe("1 transaction in EUR isn't in these totals, which are in USD.");
    expect(r.money_in).toEqual([
      { category: 'income', amount: 5000, transactions: 1 },
      { category: 'general merchandise', amount: 40, transactions: 1 },
    ]);
    expect(r.money_out.find((c) => c.category === 'medical')).toEqual({ category: 'medical', amount: 290.1, transactions: 4 });
    expect(r.money_out.map((c) => c.category)).not.toContain('transfer out');
    expect(r.money_out.map((c) => c.category)).not.toContain('loan payments');
    expect(r.money_out.map((c) => c.category)).not.toContain('travel');
    // The same functions every other total uses, so the API's /spending agrees too.
    const s = summarize(MARCH, () => true, 'USD');
    expect(r.money_out.map((c) => ({ category: c.category, spent: c.amount, transactions: c.transactions }))).toEqual(s.categories);
    expect(categoryTotals(MARCH, () => true, 'USD').in).toEqual(r.money_in);
  });

  test('the currency: the one most of the period’s transactions are in, another of them when asked, never one it hasn’t', () => {
    const rows = [row('a', '2025-05-01', 10, { iso_currency_code: 'EUR' }), row('b', '2025-05-02', 20, { iso_currency_code: 'EUR' }), row('c', '2025-05-03', 30)];
    const euro = buildReport(input({ rows }));
    expect(euro.currency).toBe('EUR');
    expect(euro.totals.money_out).toBe(30);
    expect(euro.currencies).toEqual([
      { currency: 'EUR', transactions: 2 },
      { currency: 'USD', transactions: 1 },
    ]);
    expect(euro.totals.left_out_text).toBe("1 transaction in USD isn't in these totals, which are in EUR.");
    const dollars = buildReport(input({ rows, currency: 'USD' }));
    expect([dollars.currency, dollars.totals.money_out]).toEqual(['USD', 30]);
    expect(dollars.totals.left_out_text).toBe("2 transactions in EUR aren't in these totals, which are in USD.");
    expect(buildReport(input({ rows, currency: 'JPY' })).currency).toBe('EUR');
  });

  test('only the period’s rows: a row after it (or after today, in a year still running) is left out', () => {
    const rows = [row('dec31', '2025-12-31', 10), row('jan1', '2026-01-01', 99), row('nov30', '2024-11-30', 99)];
    expect(buildReport(input({ rows })).totals.money_out).toBe(10);
    const thisYear = period({ kind: 'year', year: 2026 });
    const r = buildReport(input({ period: thisYear, rows: [row('a', '2026-10-10', 5), row('tomorrow', '2026-10-11', 7)] }));
    expect(r.totals.money_out).toBe(5);
    expect(r.months.filter((m) => m.future).map((m) => m.month)).toEqual(['2026-11', '2026-12']);
    expect(r.months.find((m) => m.month === '2026-10')).toMatchObject({ start: '2026-10-01', end: '2026-10-10', future: false });
  });
});

const sentencesOf = (gaps: Gap[]) => gapSentences(gaps, iso);

describe('gaps: what the period may be missing, and the months each touches', () => {
  test('nothing missing: synced after the period, history from before it', () => {
    const r = buildReport(input({ rows: MARCH }));
    expect(r.gaps).toEqual([]);
    expect(statusHeadline(r)).toBe('Nothing is known to be missing from this period.');
    expect(r.months.every((m) => !m.uncertain)).toBe(true);
    expect(r.data_as_of).toBe('2026-10-10T13:00:00.000Z');
  });

  test('stale: last synced before the period’s transactions could all be in, or not known when', () => {
    const r = buildReport(input({ rows: MARCH, sources: [chase({ synced_at: '2025-09-12T15:00:00.000Z' })] }));
    expect(r.gaps).toEqual([{ kind: 'stale', item_id: 'item_chase', institution: 'Chase', since: '2025-09-12' }]);
    expect(sentencesOf(r.gaps)).toEqual(['Chase hasn’t synced since 2025-09-12, so this report may be missing some of its transactions.']);
    expect(statusLines(r, iso)).toContain(SYNC_REMEDY);
    // September (partly) and every month after it, not before.
    expect(r.months.filter((m) => m.uncertain).map((m) => m.month)).toEqual(['2025-09', '2025-10', '2025-11', '2025-12']);
    expect(r.months.find((m) => m.month === '2025-10')!.gaps).toEqual(['Chase']);
    // Synced on the last day, or a day after: banks post late, so not yet all in.
    for (const at of ['2025-12-31T20:00:00.000Z', '2026-01-02T20:00:00.000Z']) {
      expect(buildReport(input({ sources: [chase({ synced_at: at })] })).gaps.map((g) => g.kind)).toEqual(['stale']);
    }
    // POST_DAYS after it: all in.
    expect(buildReport(input({ sources: [chase({ synced_at: `2026-01-0${1 + POST_DAYS}T20:00:00.000Z` })] })).gaps).toEqual([]);
    // Read on the person's calendar: 03:00 UTC on Jan 3 is still Jan 2 in New York.
    expect(buildReport(input({ sources: [chase({ synced_at: '2026-01-03T03:00:00.000Z' })] })).gaps.map((g) => g.kind)).toEqual(['stale']);
    const utc = period({ kind: 'year', year: 2025 }, 'UTC');
    expect(buildReport(input({ period: utc, sources: [chase({ synced_at: '2026-01-03T03:00:00.000Z' })] })).gaps).toEqual([]);
    // Not known: every month.
    const unknown = buildReport(input({ sources: [chase({ synced_at: null })] }));
    expect(sentencesOf(unknown.gaps)).toEqual(['When Chase last synced isn’t known, so this report may be missing some of its transactions.']);
    expect(unknown.months.every((m) => m.uncertain)).toBe(true);
    // And the report's as-of isn't claimed: one connection's time is unknown.
    expect(unknown.data_as_of).toBeNull();
    expect(buildReport(input({ sources: [chase({ synced_at: null }), chase({ item_id: 'i2', institution_name: 'Citi' })] })).data_as_of).toBeNull();
    // With no connection's transactions in it, the data is as of when it was read.
    expect(buildReport(input({ sources: [] })).data_as_of).toBe(new Date(NOW).toISOString());
  });

  test('a period that ends today: synced today is all there can be, and the last days may still change', () => {
    const now = period({ kind: 'range', start: '2026-09-01', end: '2026-10-10' });
    const today = buildReport(input({ period: now, sources: [chase({ synced_at: '2026-10-10T13:00:00.000Z' })] }));
    expect(today.gaps).toEqual([]);
    expect(today.caveats.settling).toBe(true);
    expect(caveatLines(today, iso)).toContain('Banks can take a few days to post a transaction, so the last days of this period may still change.');
    // Yesterday evening (New York) is a day short.
    expect(buildReport(input({ period: now, sources: [chase({ synced_at: '2026-10-10T02:00:00.000Z' })] })).gaps).toMatchObject([{ kind: 'stale', since: '2026-10-09' }]);
    // A year still running says what it covers.
    const thisYear = buildReport(input({ period: period({ kind: 'year', year: 2026 }) }));
    expect(thisYear.caveats.not_over).toBe(true);
    expect(caveatLines(thisYear, iso)[0]).toBe('2026 isn’t over: this report covers 2026-01-01 to 2026-10-10.');
    expect(buildReport(input()).caveats).toMatchObject({ not_over: false, settling: false });
  });

  test('missing: its transactions couldn’t be read, or none are stored yet; the read’s own note is kept on it', () => {
    const r = buildReport(
      input({
        sources: [chase({ coverage: 'missing', synced_at: null, first_date: null }), chase({ item_id: 'item_citi', institution_name: 'Citi', coverage: 'missing', synced_at: null })],
        notes: ['Chase: stored transactions could not be read', 'Citi: no transactions stored yet; open the app to load them'],
      })
    );
    expect(r.gaps.map((g) => g.kind)).toEqual(['missing', 'missing']);
    expect(sentencesOf(r.gaps)).toEqual(['Doesn’t include Chase and Citi: their transactions couldn’t be loaded, so this report may be incomplete.']);
    expect(r.institutions.map((i) => i.note)).toEqual(['Chase: stored transactions could not be read', 'Citi: no transactions stored yet; open the app to load them']);
    expect(r.months.every((m) => m.uncertain && m.gaps.join() === 'Chase,Citi')).toBe(true);
  });

  test('importing: older transactions still arriving, said instead of a late start', () => {
    const r = buildReport(input({ sources: [chase({ coverage: 'importing', first_date: '2025-06-01' })] }));
    expect(r.gaps).toEqual([{ kind: 'importing', item_id: 'item_chase', institution: 'Chase' }]);
    expect(sentencesOf(r.gaps)).toEqual(['Chase is still importing older transactions, so this report may be incomplete.']);
  });

  test('begins late: history in Nya starting after the period does, said with a condition, never as fact', () => {
    const r = buildReport(input({ sources: [chase({ first_date: '2025-03-03' })] }));
    expect(r.gaps).toEqual([{ kind: 'begins_late', item_id: 'item_chase', institution: 'Chase', first: '2025-03-03' }]);
    expect(sentencesOf(r.gaps)).toEqual([
      'Chase’s transactions in Nya begin on 2025-03-03: if its accounts were open before then, this report is missing their earlier transactions.',
    ]);
    expect(r.months.filter((m) => m.uncertain).map((m) => m.month)).toEqual(['2025-01', '2025-02', '2025-03']);
    // Beginning after the whole period: every month.
    expect(buildReport(input({ sources: [chase({ first_date: '2026-02-01' })] })).months.every((m) => m.uncertain)).toBe(true);
    // From the first day on: nothing missing.
    expect(buildReport(input({ sources: [chase({ first_date: '2025-01-01' })] })).gaps).toEqual([]);
  });

  test('no transactions: a bank account or card Plaid doesn’t provide, or the person didn’t allow, is a gap; investments only are not', () => {
    const r = buildReport(
      input({
        rows: MARCH,
        sources: [
          chase(),
          chase({ item_id: 'i_acme', institution_name: 'Acme CU', no_transactions: 'refused', first_date: null, synced_at: null }),
          chase({ item_id: 'i_fid', institution_name: 'Fidelity', no_transactions: 'no_consent', first_date: null, synced_at: null }),
          chase({ item_id: 'i_vg', institution_name: 'Vanguard', no_transactions: 'investment_accounts', first_date: null, synced_at: null }),
          chase({ item_id: 'i_loan', institution_name: 'Nelnet', no_transactions: 'no_cash_accounts', first_date: null, synced_at: null }),
        ],
      })
    );
    expect(r.gaps.map((g) => [g.kind, g.institution])).toEqual([
      ['refused', 'Acme CU'],
      ['no_consent', 'Fidelity'],
    ]);
    expect(sentencesOf(r.gaps)).toEqual([
      'Doesn’t include the bank or card accounts at Acme CU: Plaid doesn’t provide their transactions, so this report may be incomplete.',
      'Doesn’t include the bank or card accounts at Fidelity: you didn’t allow Nya to see their transactions, so this report may be incomplete. To bring them in, choose Allow transactions on the Accounts tab.',
    ]);
    // Listed all the same, with why.
    expect(r.institutions.map((i) => [i.institution_name, i.no_transactions])).toEqual([
      ['Acme CU', 'refused'],
      ['Chase', null],
      ['Fidelity', 'no_consent'],
      ['Nelnet', 'no_cash_accounts'],
      ['Vanguard', 'investment_accounts'],
    ]);
    // Their sync times never set the report's as-of.
    expect(r.data_as_of).toBe('2026-10-10T13:00:00.000Z');
  });

  test('removed: a connection whose history may have reached the period, unless the institution was connected again', () => {
    const removed = [
      // Removed mid-year.
      { institution_name: 'Citi', institution_id: 'ins_5', first_seen: '2024-01-10', last_seen: '2025-06-30' },
      // Removed before the year began: never in it.
      { institution_name: 'Old Bank', institution_id: 'ins_9', first_seen: '2020-01-01', last_seen: '2024-12-30' },
      // Linked long after, its history couldn't reach back.
      { institution_name: 'New Bank', institution_id: 'ins_7', first_seen: '2028-06-01', last_seen: '2028-07-01' },
      // Removed, and Chase connected again since (the same institution).
      { institution_name: 'Chase', institution_id: 'ins_3', first_seen: '2022-01-01', last_seen: '2025-02-01' },
      // Linked after the year, its history reaching back into it: may be missing.
      { institution_name: 'Ally', institution_id: null, first_seen: '2026-03-01', last_seen: '2026-08-01' },
    ];
    const r = buildReport(input({ removed }));
    expect(r.removed).toEqual([
      { institution: 'Citi', first_seen: '2024-01-10', last_seen: '2025-06-30', connected_again: false },
      { institution: 'Chase', first_seen: '2022-01-01', last_seen: '2025-02-01', connected_again: true },
      { institution: 'Ally', first_seen: '2026-03-01', last_seen: '2026-08-01', connected_again: false },
    ]);
    expect(r.gaps.map((g) => g.institution)).toEqual(['Ally', 'Citi']);
    expect(sentencesOf(r.gaps.filter((g) => g.institution === 'Citi'))).toEqual([
      'Citi was removed on or after 2025-06-30, and the transactions it brought in went with it, so this report may be missing some of them.',
    ]);
    // Citi's months run to its removal; Ally's (removed after the year) are all.
    expect(r.months.find((m) => m.month === '2025-06')!.gaps).toEqual(['Ally', 'Citi']);
    expect(r.months.find((m) => m.month === '2025-07')!.gaps).toEqual(['Ally']);
    // Connected again by name, when the ids aren't known.
    const byName = buildReport(input({ removed: [{ institution_name: ' chase ', institution_id: null, first_seen: '2024-01-01', last_seen: '2025-05-01' }] }));
    expect(byName.removed[0].connected_again).toBe(true);
    expect(byName.gaps).toEqual([]);
    // A directory that couldn't be read is said.
    expect(caveatLines(buildReport(input({ removed: null })), iso)).toContain('Whether a connection was removed during this period couldn’t all be read.');
    expect(buildReport(input({ removedUnreadable: 2 })).caveats.removed_unread).toBe(true);
  });

  test('unreadable: whatever else the read couldn’t read, in its own words, touching every month', () => {
    const r = buildReport(input({ notes: ['Cash: transactions entered for Wallet couldn’t be read'] }));
    expect(r.gaps).toEqual([{ kind: 'unreadable', item_id: null, institution: null, note: 'Cash: transactions entered for Wallet couldn’t be read' }]);
    expect(sentencesOf(r.gaps)).toEqual(['Cash: transactions entered for Wallet couldn’t be read.']);
    expect(r.months.every((m) => m.uncertain && m.gaps.length === 0)).toBe(true);
  });

  test('a note is a bank’s own only when its gap says it: a manual account under the same name is never swallowed', () => {
    const manualNote = 'Chase: transactions entered for Cash envelope couldn’t be read';
    // Chase's transactions are all here: the note is the manual account's.
    const fine = buildReport(input({ notes: [manualNote] }));
    expect(fine.gaps).toEqual([{ kind: 'unreadable', item_id: null, institution: null, note: manualNote }]);
    expect(fine.institutions[0].note).toBeNull();
    // Chase's own couldn't be read too: one note is its own, the other a gap.
    const both = buildReport(input({ sources: [chase({ coverage: 'missing' })], notes: ['Chase: stored transactions could not be read', manualNote] }));
    expect(both.gaps.map((g) => g.kind)).toEqual(['missing', 'unreadable']);
    expect(both.institutions[0].note).toBe('Chase: stored transactions could not be read');
    expect(sentencesOf(both.gaps)[1]).toBe('Chase: transactions entered for Cash envelope couldn’t be read.');
  });

  test('every kind at once, in a fixed order, the headline saying the report may be incomplete', () => {
    const r = buildReport(
      input({
        rows: MARCH,
        sources: [
          chase({ synced_at: '2025-11-01T12:00:00.000Z' }),
          chase({ item_id: 'i2', institution_name: 'Citi', coverage: 'missing' }),
          chase({ item_id: 'i3', institution_name: 'Ally', coverage: 'importing' }),
          chase({ item_id: 'i4', institution_name: 'Amex', first_date: '2025-05-05' }),
          chase({ item_id: 'i5', institution_name: 'Acme', no_transactions: 'refused' }),
          chase({ item_id: 'i6', institution_name: 'Fid', no_transactions: 'no_consent' }),
        ],
        removed: [{ institution_name: 'Gone', institution_id: null, first_seen: '2024-01-01', last_seen: '2025-04-01' }],
        notes: ['Manual accounts: transactions entered for them couldn’t be read'],
      })
    );
    expect(r.gaps.map((g) => g.kind)).toEqual(['missing', 'removed', 'refused', 'no_consent', 'stale', 'importing', 'begins_late', 'unreadable']);
    expect(statusHeadline(r)).toBe('This report may be incomplete:');
    expect(statusLines(r, iso).length).toBe(9);
  });
});

describe('an empty period', () => {
  test('says there are no transactions, rather than showing zeros as if complete', () => {
    const r = buildReport(input({ sources: [chase({ first_date: '2026-02-01' })] }));
    expect(r.empty).toBe(true);
    expect(statusHeadline(r)).toBe('There are no transactions in this period, and some may be missing:');
    expect(statusHeadline(buildReport(input()))).toBe('There are no transactions in this period.');
  });

  test('with only investment accounts connected, says so in the app’s words', () => {
    const r = buildReport(input({ sources: [chase({ no_transactions: 'investment_accounts', first_date: null })] }));
    expect(r.no_spending).toEqual({ lead: 'Your connected accounts are investment accounts', remedy: 'connect a bank or card' });
    expect(statusLines(r, iso)).toContain('Your connected accounts are investment accounts, so no bank or card transactions come in. To see spending, connect a bank or card.');
    // Rows entered by hand: there is spending, and nothing says otherwise.
    expect(buildReport(input({ rows: [MARCH[15]], sources: [chase({ no_transactions: 'investment_accounts' })] })).no_spending).toBeNull();
  });
});

describe('the categories marked for taxes', () => {
  const medical = (over: Partial<ReportInput> = {}) => buildReport(input({ rows: MARCH, marked: ['medical', 'loan payments', 'travel', 'charity'], ...over }));

  test('a group of their own, in the person’s order, summed by the same rules', () => {
    const r = medical();
    expect(r.marked!.categories).toEqual([
      { category: 'medical', money_in: 0, money_out: 290.1, transactions: 4 },
      // A card's payment is never spending, marked or not.
      { category: 'loan payments', money_in: 0, money_out: 0, transactions: 0 },
      // Euros aren't in a report in dollars.
      { category: 'travel', money_in: 0, money_out: 0, transactions: 0 },
      // Marked, with nothing in the period.
      { category: 'charity', money_in: 0, money_out: 0, transactions: 0 },
    ]);
    expect([r.marked!.money_in, r.marked!.money_out]).toEqual([0, 290.1]);
    expect(r.categories).toContain('charity');
    expect(r.caveats.marked).toBe('set');
  });

  test('their transactions listed, oldest first, with where each came from and why any isn’t counted; what the person excluded left out and counted', () => {
    const rows = [...MARCH, row('xray', '2025-03-21', 300, { category: 'medical', excluded: true })];
    const r = medical({ rows });
    const a = r.appendix!;
    expect(a.rows.map((x) => x.name)).toEqual(['doctor', 'card-payment', 'unknown', 'paris', 'manual-txn:cash', 'manual-txn:ofx']);
    expect(a).toMatchObject({ total: 6, limit: APPENDIX_LIMIT, excluded: 1 });
    const by = (name: string) => a.rows.find((x) => x.name === name)!;
    expect(by('card-payment')).toMatchObject({ not_counted: 'transfer', source: 'plaid' });
    expect(by('paris')).toMatchObject({ not_counted: 'currency', currency: 'EUR' });
    expect(by('unknown')).toMatchObject({ not_counted: null, exclusion_unknown: true });
    expect(by('manual-txn:cash')).toMatchObject({ source: 'manual', account: 'Wallet', institution: 'Cash', note: 'co-pay' });
    expect(by('manual-txn:ofx').source).toBe('import:ofx');
    expect([sourceName('plaid'), sourceName('manual'), sourceName('import:ofx')]).toEqual(['from the bank', 'entered by hand', 'imported from OFX']);
    expect(appendixStatus(by('card-payment'))).toBe('Not counted: a transfer or loan payment');
    expect(appendixStatus(by('paris'))).toBe('Not counted: in EUR');
    expect(appendixStatus(by('unknown'))).toBe('Whether you excluded it couldn’t be read');
    expect(appendixStatus(by('doctor'))).toBeNull();
    // What is listed and counted adds up to the group's totals.
    const counted = a.rows.filter((x) => x.not_counted === null).reduce((n, x) => n + x.amount, 0);
    expect(counted).toBeCloseTo(r.marked!.money_out, 8);
  });

  test('bounded: past the limit, the first ones are listed and the rest counted', () => {
    const many = Array.from({ length: 30 }, (_, i) => row(`m${String(i).padStart(2, '0')}`, `2025-04-${String(1 + (i % 28)).padStart(2, '0')}`, 10, { category: 'medical' }));
    const r = buildReport(input({ rows: many, marked: ['medical'], appendixLimit: 12 }));
    expect(r.appendix!.rows.length).toBe(12);
    expect(r.appendix!.total).toBe(30);
    expect(r.marked!.categories[0]).toMatchObject({ money_out: 300, transactions: 30 });
  });

  test('none marked, or marked categories that couldn’t be read: no group, and the reason kept', () => {
    expect(buildReport(input({ rows: MARCH })).marked).toBeNull();
    expect(buildReport(input({ rows: MARCH, marked: [] })).caveats.marked).toBe('none');
    const unread = buildReport(input({ rows: MARCH, marked: null, markedUnreadable: true }));
    expect([unread.marked, unread.appendix, unread.caveats.marked]).toEqual([null, null, 'unreadable']);
  });
});

describe('the words', () => {
  test('the title, and what the totals leave out, as the Activity tab says it', () => {
    expect(reportTitle({ period: YEAR_2025 }, iso)).toBe('2025 tax year');
    expect(reportTitle({ period: period({ kind: 'range', start: '2026-01-01', end: '2026-03-31' }) }, iso)).toBe('2026-01-01 to 2026-03-31');
    const r = buildReport(input({ rows: MARCH }));
    expect(totalsNote(r)).toBe(
      'Transfers, cash withdrawals and loan payments (paying a card off among them) aren’t counted as money in or out, and 1 transaction you excluded from budgets and reports is left out. Whether you excluded 1 transaction couldn’t be read, so it counts here. 1 transaction in EUR isn\'t in these totals, which are in USD.'
    );
    expect(caveatLines(buildReport(input({ hidden: true, healthUnread: true })), iso)).toEqual([
      'Accounts you hid are left out, as everywhere in Nya.',
      'How each bank connection is doing couldn’t be read, so what is said of each may be missing something.',
    ]);
  });

  test('a connection’s state in the words of its Connection health badge', () => {
    for (const state of HEALTH_STATES) {
      expect(STATE_WORDS[state]).toBe(badgeOf({ state, cause: 'ok', side: 'none', action: 'none', last_ok_at: null }));
    }
  });

  test('never a word suggesting what is deductible or taxable', () => {
    const r = buildReport(input({ rows: MARCH, marked: ['medical'] }));
    const all = [...statusLines(r, iso), totalsNote(r), reportCsv(r)].join(' ').toLowerCase();
    for (const word of ['deduct', 'write-off', 'write off', 'tax-free', 'taxable']) expect(all).not.toContain(word);
  });
});

describe('the CSV', () => {
  test('the same totals, months, group and notes, one table, with a byte order mark', () => {
    const r = buildReport(input({ rows: MARCH, marked: ['medical'], sources: [chase({ synced_at: '2025-09-12T15:00:00.000Z' })] }));
    const text = reportCsv(r);
    expect(text.startsWith('﻿')).toBe(true);
    const rows = parseCsv(text.slice(1));
    expect(rows[0]).toEqual([...REPORT_CSV_COLUMNS]);
    const of = (section: string) => rows.filter((x) => x[0] === section);
    expect(of('report')[0].slice(0, 2)).toEqual(['report', '2025 tax year']);
    expect(of('time_zone')[0][1]).toBe(NY);
    expect(of('status')[0][1]).toBe('This report may be incomplete:');
    expect(of('gap').map((x) => x[1])).toEqual([
      'Chase hasn’t synced since 2025-09-12, so this report may be missing some of its transactions.',
      SYNC_REMEDY,
    ]);
    expect(of('total')[0].slice(2, 7)).toEqual([String(r.totals.money_in), String(r.totals.money_out), String(r.totals.net), String(r.totals.counted), 'USD']);
    expect(of('money_out').map((x) => [x[1], x[3]])).toEqual(r.money_out.map((c) => [c.category, String(c.amount)]));
    expect(of('money_in').map((x) => [x[1], x[2]])).toEqual(r.money_in.map((c) => [c.category, String(c.amount)]));
    expect(of('month').length).toBe(12);
    expect(of('month').find((x) => x[1] === '2025-10')![7]).toBe('May be missing transactions from Chase');
    expect(of('month').find((x) => x[1] === '2025-01')![7]).toBe('');
    expect(of('marked')[0].slice(1, 6)).toEqual(['medical', '0', '290.1', '', '4']);
    expect(of('institution')[0][7]).toContain('transactions last brought in 2025-09-12T15:00:00.000Z');
    expect(reportFilename(r)).toBe('nya-report-2025.csv');
    expect(reportFilename({ period: period({ kind: 'range', start: '2026-01-01', end: '2026-03-31' }) })).toBe('nya-report-2026-01-01-to-2026-03-31.csv');
  });

  test('a category or a name that a spreadsheet would run as a formula is written as text', () => {
    const rows = [row('evil', '2025-02-01', 10, { category: '=hyperlink("http://x")' }), row('pay', '2025-02-02', -5, { category: '@sum(a1)' })];
    const text = reportCsv(buildReport(input({ rows, sources: [chase({ institution_name: '+Bank' })] })));
    const parsed = parseCsv(text.slice(1));
    expect(parsed.find((x) => x[0] === 'money_out')![1]).toBe('\'=hyperlink("http://x")');
    expect(parsed.find((x) => x[0] === 'money_in')![1]).toBe("'@sum(a1)");
    expect(parsed.find((x) => x[0] === 'institution')![1]).toBe("'+Bank");
    // Amounts stay numbers: a negative net is a number, not text.
    const net = parsed.find((x) => x[0] === 'total')![4];
    expect(net).toBe('-5');
  });
});

describe('the settings', () => {
  test('a save is filed as the app files categories, within limits, none twice', () => {
    expect(parseReportSettings({ v: 1, marked: ['  Medical ', 'charitable   giving'] })).toEqual({ settings: { v: 1, marked: ['medical', 'charitable giving'] } });
    const refused: [unknown, string][] = [
      [null, 'must be an object'],
      [[], 'must be an object'],
      [{ v: 2, marked: [] }, 'v must be 1'],
      [{ v: 1 }, 'marked must be a list'],
      [{ v: 1, marked: [], extra: 1 }, 'unknown field "extra"'],
      [{ v: 1, marked: [7] }, 'marked[0] must be text'],
      [{ v: 1, marked: ['   '] }, 'must be a category of 1 to 60 characters'],
      [{ v: 1, marked: ['x'.repeat(61)] }, 'must be a category of 1 to 60 characters'],
      [{ v: 1, marked: ['a\u0007b'] }, 'must be a category'],
      [{ v: 1, marked: ['Medical', 'medical'] }, 'marked[1] names a category already marked'],
      [{ v: 1, marked: Array.from({ length: REPORT_SETTINGS_LIMITS.marked + 1 }, (_, i) => `c${i}`) }, `at most ${REPORT_SETTINGS_LIMITS.marked}`],
    ];
    for (const [raw, reason] of refused) {
      const r = parseReportSettings(raw);
      expect('error' in r && r.error).toContain(reason);
    }
  });

  test('a stored value reads back by its shape alone, closed to fields this release doesn’t know', () => {
    expect(isReportSettings({ v: 1, marked: [] })).toBe(true);
    // Saved under a later, larger limit: still read.
    expect(isReportSettings({ v: 1, marked: Array.from({ length: 150 }, (_, i) => `c${i}`) })).toBe(true);
    expect(isReportSettings({ v: 1, marked: [], groups: [] })).toBe(false);
    expect(isReportSettings({ v: 2, marked: [] })).toBe(false);
    expect(isReportSettings({ v: 1, marked: [1] })).toBe(false);
  });
});
