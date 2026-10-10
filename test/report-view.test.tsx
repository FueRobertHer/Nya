import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { NextRequest } from 'next/server';
import { ReportView, reportDay, reportTime, reportHeading, footerCss } from '@/components/ReportView';
import { MarkCategoriesView, formFrom, reportQuery, csvQuery } from '@/components/ReportsPage';
import ReportsEntry from '@/components/ReportsEntry';
import { buildReport, type ReportInput, type SourceFacts } from '@/lib/report/build';
import { resolvePeriod, type Period, type ReportRequest } from '@/lib/report/period';
import type { Txn } from '@/lib/transactions';

// The report as a printed page (components/ReportView.tsx), from its markup:
// the first page holds the period, the time zone, when the data is from,
// what may be missing (at the top, in plain words) and where the data comes
// from; every later part starts a page of its own; nothing to click is in it;
// a figure that may be short says so in words, so it reads in black and
// white; an empty period says so; the appendix says when it is cut short.
// And the print styles that do the paging (app/globals.css, "Reports"), the
// page's own pieces, and that the page is gated like the dashboard. A real
// print to PDF in Chromium checks the same (see the report of this work).

const NY = 'America/New_York';
const NOW = Date.parse('2026-10-10T14:00:00.000Z');
const period = (request: ReportRequest): Period => {
  const p = resolvePeriod(request, NY, NOW);
  if ('error' in p) throw new Error(p.error);
  return p;
};
const row = (id: string, date: string, amount: number, over: Partial<Txn> = {}): Txn => ({
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
});
const source = (over: Partial<SourceFacts> = {}): SourceFacts => ({
  item_id: 'item_chase',
  institution_name: 'Chase',
  institution_id: null,
  coverage: 'complete',
  synced_at: '2026-10-10T13:00:00.000Z',
  first_date: '2023-01-01',
  first_seen: null,
  never_synced: false,
  no_transactions: null,
  last_ok_at: '2026-10-10T13:00:00.000Z',
  problem: null,
  records_unreadable: false,
  holds: { investment: false, loans: false },
  ...over,
});
const ROWS: Txn[] = [
  row('Payroll', '2025-01-15', -4000, { category: 'income' }),
  row('Pharmacy', '2025-02-03', 42.5, { category: 'medical' }),
  row('Rent', '2025-02-01', 1500, { category: 'rent and utilities' }),
  row('Card payment', '2025-02-20', 300, { category: 'loan payments' }),
  row('Co-pay', '2025-03-03', 25, { category: 'medical', source: 'manual', account_name: 'Wallet', institution_name: 'Cash', note: 'receipt kept' }),
];
const input = (over: Partial<ReportInput> = {}): ReportInput => ({
  period: period({ kind: 'year', year: 2025 }),
  generatedAt: new Date(NOW).toISOString(),
  rows: ROWS,
  currency: null,
  sources: [source(), source({ item_id: 'item_citi', institution_name: 'Citi', synced_at: '2025-09-12T15:00:00.000Z', problem: { state: 'needs_reauth', since: '2025-09-13T13:00:00.000Z' } })],
  notes: [],
  manual: [{ account_id: 'manual_wallet', name: 'Wallet', institution: 'Cash', type: 'depository', updated_at: '2026-09-30T18:00:00.000Z' }],
  removed: [
    { institution_name: 'Wells Fargo', institution_id: null, first_seen: '2024-01-10', last_seen: '2025-06-30', accounts: [{ account_id: 'acc_wf', name: 'Way2Save', mask: '4321', type: 'depository' }] },
  ],
  removedUnreadable: 0,
  manualUnread: [],
  liveAccounts: [],
  links: new Map(),
  ownRead: { categories: true, names: true, exclusions: true },
  marked: ['medical'],
  markedUnreadable: false,
  hidden: false,
  healthUnread: false,
  ...over,
});

const html = (over: Partial<ReportInput> = {}) => renderToStaticMarkup(<ReportView report={buildReport(input(over))} />);
const text = (s: string) =>
  s
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ');
/** Each part of the report (a section that starts a page), in order: its
 *  class and its text. */
const parts = (s: string) =>
  [...s.matchAll(/<section class="(report-page[^"]*)"[^>]*>([\s\S]*?)(?=<section class="report-page|<\/article>)/g)].map((m) => ({ cls: m[1], text: text(m[2]) }));

describe('the printed report', () => {
  test('the first page: the period, the time zone, when the data is from, what may be missing, and where the data comes from', () => {
    const [first] = parts(html());
    expect(first.cls).toBe('report-page report-first');
    expect(first.text).toContain('2025 tax year summary');
    expect(first.text).toContain('Jan 1, 2025 to Dec 31, 2025');
    expect(first.text).toContain(`Times and today’s date are in ${NY}`);
    expect(first.text).toContain('Data as of Sep 12, 2025, 11:00 AM, the oldest of the connections’ times below.');
    // The gaps, in plain words, before any figure.
    expect(first.text).toContain('This report may be incomplete:');
    expect(first.text).toContain('Citi hasn’t synced since Sep 12, 2025, so this report may be missing some of its transactions.');
    expect(first.text).toContain('Wells Fargo (Way2Save ••4321) was removed on or after Jun 30, 2025');
    expect(first.text.indexOf('This report may be incomplete')).toBeLessThan(first.text.indexOf('Money in'));
    // Every institution, its state, its last sync and its gaps; the manual
    // accounts with their last update; the removed connection.
    expect(first.text).toContain('Citi Needs reconnecting since Sep 13, 2025');
    expect(first.text).toContain('Hasn’t synced since Sep 12, 2025');
    expect(first.text).toContain('Chase No problem recorded');
    expect(first.text).toContain('Cash: Wallet None in this period Sep 30, 2026');
    expect(first.text).toContain('Wells Fargo: seen from Jan 10, 2024 to Jun 30, 2025; not connected again: Way2Save ••4321.');
    // And the bottom line, marked as possibly incomplete in words.
    expect(first.text).toContain('Money in $4,000.00 Money out $1,567.50 Net $2,432.50');
    expect(first.text).toContain('These figures may be incomplete.');
  });

  test('every later part starts a page of its own: the categories, the months, the marked categories, the appendix', () => {
    const later = parts(html()).slice(1);
    expect(later.map((p) => p.cls)).toEqual(['report-page', 'report-page', 'report-page', 'report-page']);
    expect(later.map((p) => p.text.trim().split(' ').slice(0, 3).join(' '))).toEqual(['Totals by category', 'By month These', 'Categories you marked', 'Appendix: transactions in']);
    const [categories, months, marked, appendix] = later;
    expect(categories.text).toContain('These figures may be incomplete: see what may be missing on the first page.');
    expect(categories.text).toContain('rent and utilities $1,500.00 1');
    expect(categories.text).toContain('income $4,000.00 1');
    // A card's payment is no category's money out.
    expect(categories.text).not.toContain('loan payments $');
    // Twelve months, each saying what it may be missing, in words.
    expect(months.text).toContain('Jan 2025 $4,000.00 $0.00 $4,000.00 1 May be missing transactions from Wells Fargo');
    expect(months.text).toContain('Oct 2025 $0.00 $0.00 $0.00 0 May be missing transactions from Citi');
    expect(marked.text).toContain('You marked these categories as ones that matter for your taxes. Nya doesn’t judge how any of them is taxed');
    expect(marked.text).toContain('medical $0.00 $67.50 2');
    expect(appendix.text).toContain('Feb 3, 2025 Pharmacy medical Chase: Checking (from the bank) -$42.50');
    expect(appendix.text).toContain('Mar 3, 2025 Co-pay medical Cash: Wallet (entered by hand) -$25.00 receipt kept');
  });

  test('nothing to click or navigate: the report is the page', () => {
    const s = html();
    for (const tag of ['<nav', '<button', '<form', '<a ', '<input', '<select']) expect(s).not.toContain(tag);
  });

  test('a year still running, and days still settling, say so on the first page', () => {
    const [first] = parts(html({ period: period({ kind: 'year', year: 2026 }), rows: [row('a', '2026-10-01', 5)] }));
    expect(first.text).toContain('2026 tax year summary');
    expect(first.text).toContain('Jan 1, 2026 to Oct 10, 2026 (the year runs to Dec 31, 2026)');
    expect(first.text).toContain('2026 isn’t over: this report covers Jan 1, 2026 to Oct 10, 2026.');
    expect(first.text).toContain('Banks can take a few days to post a transaction');
    const months = parts(html({ period: period({ kind: 'year', year: 2026 }), rows: [row('a', '2026-10-01', 5)] }))[2];
    expect(months.text).toContain('Oct 2026 (1 to 10)');
    expect(months.text).toContain('Nov 2026 Still to come');
  });

  test('when a connection’s last sync isn’t known, the report claims no as-of time', () => {
    const [first] = parts(html({ sources: [source({ synced_at: null })] }));
    expect(first.text).toContain('When some of its data is from isn’t known: see the connections below.');
    expect(first.text).not.toContain('Data as of');
    expect(first.text).toContain('When Chase last synced isn’t known');
  });

  test('nothing known to be missing says exactly that, and no figure is flagged', () => {
    const s = html({ sources: [source()], removed: [] });
    expect(text(s)).toContain('Nothing is known to be missing from this period.');
    expect(text(s)).not.toContain('may be incomplete');
    expect(s).not.toContain('report-status-short');
  });

  test('an empty period says so, and shows no tables of zeros', () => {
    const s = html({ rows: [], sources: [source({ first_date: '2026-02-01' })], removed: [], marked: null });
    expect(text(s)).toContain('There are no transactions in this period, and some may be missing:');
    expect(text(s)).toContain('Chase’s transactions in Nya begin on Feb 1, 2026');
    expect(parts(s).length).toBe(1);
    expect(text(s)).not.toContain('Money out');
    expect(text(s)).not.toContain('$0.00');
  });

  test('an appendix cut short says how many it lists of how many, and that the totals count them all', () => {
    const many = Array.from({ length: 9 }, (_, i) => row(`Visit ${i}`, `2025-04-0${i + 1}`, 10, { category: 'medical' }));
    const appendix = parts(html({ rows: many, appendixLimit: 4 })).at(-1)!;
    expect(appendix.text).toContain('Showing the first 4 of 9 transactions. The totals above count all of them; a shorter period lists them all.');
    expect((appendix.text.match(/Visit \d/g) ?? []).length).toBe(4);
  });

  test('a date range is titled by its days', () => {
    const r = buildReport(input({ period: period({ kind: 'range', start: '2025-02-01', end: '2025-03-31' }) }));
    expect(reportHeading(r)).toBe('Report for Feb 1, 2025 to Mar 31, 2025');
    expect(reportDay('2025-12-31')).toBe('Dec 31, 2025');
    // An instant in the report's own time zone, whatever the machine's.
    expect(reportTime('2026-01-01T02:30:00.000Z', NY)).toContain('Dec 31, 2025');
  });
});

describe('review: the page says what it can’t show', () => {
  test('marked categories that couldn’t be read are said on the first page, never silently missing', () => {
    const [first, ...rest] = parts(html({ marked: null, markedUnreadable: true }));
    expect(first.text).toContain('The categories you marked for taxes couldn’t be read, so their group and their transactions are left out of this report.');
    expect(rest.some((p) => p.text.includes('Categories you marked'))).toBe(false);
  });

  test('when a connection couldn’t be loaded, the page claims no as-of time, and says so', () => {
    const [first] = parts(html({ sources: [source({ coverage: 'missing', synced_at: null })], notes: ['Chase: stored transactions could not be read'] }));
    expect(first.text).toContain('When some of its data is from isn’t known: see the connections below.');
    expect(first.text).not.toContain('Data as of');
  });

  test('what the report covers is on the first page when an account holds investments', () => {
    const [first] = parts(html({ sources: [source({ holds: { investment: true, loans: false } })] }));
    expect(first.text).toContain('Activity inside investment accounts, such as trades, dividends and interest, isn’t in it.');
  });

  test('a zero amount is never written as minus zero', () => {
    const appendix = parts(html({ rows: [row('Zero fee', '2025-02-02', 0, { category: 'medical' })] })).at(-1)!;
    expect(appendix.text).toContain('Zero fee medical Chase: Checking (from the bank) $0.00');
    expect(appendix.text).not.toContain('-$0.00');
  });

  test('every printed page carries the report and its period, beside its number', () => {
    const s = html();
    expect(s).toContain('<style>@media print { @page { @bottom-left { content: "Nya · 2025 tax year summary · Jan 1, 2025 to Dec 31, 2025"; } } }</style>');
    const range = buildReport(input({ period: period({ kind: 'range', start: '2025-02-01', end: '2025-03-31' }) }));
    expect(footerCss(range)).toContain('content: "Nya · Report for Feb 1, 2025 to Mar 31, 2025"');
    expect(printRule('@bottom-right')).toContain('content: "Page " counter(page) " of " counter(pages)');
  });

  test('the CSV link asks for the report on screen, whatever the form says since', () => {
    const r = buildReport(input({ period: period({ kind: 'range', start: '2025-02-01', end: '2025-03-31' }) }));
    expect(csvQuery(r)).toBe('kind=range&start=2025-02-01&end=2025-03-31&currency=USD&tz=America%2FNew_York&format=csv');
    expect(csvQuery(buildReport(input()))).toBe('kind=year&year=2025&currency=USD&tz=America%2FNew_York&format=csv');
  });
});

/** The rules of a selector inside `@media print` in app/globals.css. */
function printRule(selector: string): string {
  const css = readFileSync(join(import.meta.dir, '..', 'app', 'globals.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const at = css.indexOf('@media print');
  expect(at).toBeGreaterThan(-1);
  const block = css.slice(at);
  const m = new RegExp(`(?:^|[}\\s])${selector.replace(/[.+*()[\]]/g, '\\$&')}\\s*\\{([^}]*)\\}`).exec(block);
  return m?.[1].replace(/\s+/g, ' ').trim() ?? '';
}

describe('the print styles', () => {
  test('page breaks between parts, never inside a row; the header of a long table on every page', () => {
    expect(printRule('.report-page + .report-page')).toContain('break-before: page');
    expect(printRule('.report tr')).toContain('break-inside: avoid');
    expect(printRule('.report thead')).toContain('display: table-header-group');
    expect(printRule('.report-status')).toContain('break-inside: avoid');
  });

  test('the report alone, black on white, at the paper’s own size', () => {
    expect(printRule('.sheet-backdrop')).toContain('display: none !important');
    expect(printRule('body')).toContain('background: #fff');
    const root = printRule(':root');
    for (const d of ['--text: #000', '--bg: #fff', '--card: #fff', '--warn: #000']) expect(root).toContain(d);
    // No fixed paper size: A4 or Letter, as the print window says.
    expect(printRule('@page')).not.toMatch(/(^|;)\s*size\s*:/);
  });
});

describe('the page around it', () => {
  test('the form comes from the address, else last year; the query asks for what the form says', () => {
    expect(formFrom('', '2026-10-10')).toEqual({ kind: 'year', year: 2025, start: '2026-01-01', end: '2026-10-10', currency: null });
    expect(formFrom('?kind=range&start=2026-01-01&end=2026-03-31&currency=EUR', '2026-10-10')).toMatchObject({ kind: 'range', start: '2026-01-01', end: '2026-03-31', currency: 'EUR' });
    expect(formFrom('?year=2031&currency=<x>', '2026-10-10')).toMatchObject({ year: 2025, currency: null });
    const form = formFrom('?kind=range&start=2026-01-01&end=2026-03-31', '2026-10-10');
    expect(reportQuery(form)).toBe('kind=range&start=2026-01-01&end=2026-03-31');
    expect(reportQuery({ ...form, kind: 'year', year: 2024, currency: 'USD' }, NY, 'csv')).toBe('kind=year&year=2024&currency=USD&tz=America%2FNew_York&format=csv');
  });

  test('marking categories: the person chooses, and nothing suggests how any is taxed', () => {
    const s = renderToStaticMarkup(
      <MarkCategoriesView categories={['charity', 'medical']} chosen={['medical']} unreadable={false} saving={false} error={null} onToggle={() => {}} onSave={() => {}} />
    );
    expect(s.match(/type="checkbox"/g)?.length).toBe(2);
    expect(s).toMatch(/checked=""[^>]*\/><span>medical/);
    expect(text(s)).toContain('You choose: Nya doesn’t say how any category is taxed.');
    for (const word of ['deduct', 'write-off', 'taxable']) expect(text(s).toLowerCase()).not.toContain(word);
    const unreadable = renderToStaticMarkup(<MarkCategoriesView categories={['medical']} chosen={[]} unreadable saving={false} error={null} onToggle={() => {}} onSave={() => {}} />);
    expect(text(unreadable)).toContain('couldn’t be read, so they can’t be changed here');
    expect(unreadable).not.toContain('<button');
  });

  test('found from Activity and from Manage', () => {
    expect(renderToStaticMarkup(<ReportsEntry />)).toContain('href="/reports"');
    const dashboard = readFileSync(join(import.meta.dir, '..', 'components', 'Dashboard.tsx'), 'utf8');
    expect(dashboard).toContain("{tab === 'activity' && <ReportsEntry />}");
    expect(dashboard).toContain('{manageMode && <ReportsEntry />}');
  });

  test('gated like the dashboard: signed out, the page sends to the login and the data is refused', async () => {
    const { proxy } = await import('@/proxy');
    const saved = { ...process.env };
    delete process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;
    delete process.env.CLERK_SECRET_KEY;
    try {
      expect((await proxy(new NextRequest('https://nya.test/reports?year=2025'))).headers.get('location')).toBe('https://nya.test/login');
      expect((await proxy(new NextRequest('https://nya.test/api/reports?year=2025'))).status).toBe(401);
      expect((await proxy(new NextRequest('https://nya.test/api/report-settings'))).status).toBe(401);
    } finally {
      process.env = saved;
    }
  });
});
