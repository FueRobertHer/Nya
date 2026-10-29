import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { NextRequest } from 'next/server';
import { ReportView, reportDay, reportTime, reportHeading, footerCss } from '@/components/ReportView';
import { MarkCategoriesView, formFrom, reportQuery, csvQuery, accountantMenu } from '@/components/ReportsPage';
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
    expect(categories.text).toContain('Rent and utilities $1,500.00 1');
    expect(categories.text).toContain('Income $4,000.00 1');
    // A card's payment is no category's money out.
    expect(categories.text).not.toContain('Loan payments $');
    // Twelve months, each saying what it may be missing, in words.
    expect(months.text).toContain('Jan 2025 $4,000.00 $0.00 $4,000.00 1 May be missing transactions from Wells Fargo');
    expect(months.text).toContain('Oct 2025 $0.00 $0.00 $0.00 0 May be missing transactions from Citi');
    expect(marked.text).toContain('You marked these categories as ones that matter for your taxes. Nya doesn’t judge how any of them is taxed');
    expect(marked.text).toContain('Medical $0.00 $67.50 2');
    expect(appendix.text).toContain('Feb 3, 2025 Pharmacy Medical Chase: Checking (from the bank) −$42.50');
    expect(appendix.text).toContain('Mar 3, 2025 Co-pay Medical Cash: Wallet (entered by hand) −$25.00 receipt kept');
  });

  test('an account that ended is named among the sources, as closed, no longer yours or not followed on its day, and its gaps said with the rest', () => {
    const ended = [
      { ids: ['acc_chk'], account: 'Checking ••1111', institution: 'Chase', item_id: 'item_chase', type: 'depository', state: 'closed' as const, assumed: false, end: '2025-02-15' },
      { ids: ['acc_sav'], account: 'Savings ••3333', institution: 'Chase', item_id: 'item_chase', type: 'depository', state: 'untracked' as const, assumed: false, end: '2025-06-01' },
      { ids: ['acc_dc'], account: 'Double Cash ••5555', institution: 'Citi', item_id: 'item_citi', type: 'credit', state: 'closed' as const, assumed: true, end: '2025-08-01' },
    ];
    const rows = [...ROWS.map((r) => ({ ...r, account_id: r.source ? 'manual_wallet' : 'acc_chk' })), row('Late fee', '2025-03-01', 9, { account_id: 'acc_chk' })];
    const s = html({ rows, ended });
    const [first] = parts(s);
    expect(first.text).toContain('Accounts that ended Account Ended In this report');
    expect(first.text).toContain('Chase: Checking ••1111 Closed on Feb 15, 2025 Counted through Feb 14, 2025; 2 transactions dated from then are in Nya and left out');
    expect(first.text).toContain('Chase: Savings ••3333 Not followed from Jun 1, 2025 Counted through May 31, 2025');
    expect(first.text).toContain('Citi: Double Cash ••5555 Assumed closed on Aug 1, 2025 Counted through Jul 31, 2025');
    expect(first.text).toContain('Not followed: it is still yours, but you stopped following it');
    // The gaps in plain words at the top, and in each connection's row.
    expect(first.text).toContain('Nya took it as closed on Aug 1, 2025: if it is still open, its transactions from then aren’t here.');
    expect(first.text).toContain('You stopped following Savings ••3333 at Chase from Jun 1, 2025: it is still yours, but its transactions from then aren’t in this report.');
    expect(first.text).toContain('Savings ••3333 not followed from Jun 1, 2025');
    expect(first.text).toContain('Double Cash ••5555 assumed closed on Aug 1, 2025');
    // The checking account's rows from its end day on (the card payment, and
    // the late fee, which would count) aren't in the bottom line, and it says so.
    expect(first.text).toContain('Money in $4,000.00 Money out $1,567.50 Net $2,432.50');
    expect(first.text).toContain('2 transactions on an account that had ended by their date are left out, as everywhere in Nya.');
  });

  test('a connection whose accounts had all ended before the period says so in its row, where its gaps would be', () => {
    const [first] = parts(html({ sources: [source(), source({ item_id: 'item_citi', institution_name: 'Citi', synced_at: '2024-03-02T15:00:00.000Z', ended_by: '2024-02-01' })] }));
    expect(first.text).toContain('Citi No problem recorded Mar 2, 2024, 10:00 AM Jan 1, 2023 Its accounts had all ended by Feb 1, 2024: nothing of it is in this period');
    expect(first.text).not.toContain('Citi hasn’t synced since');
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

  test("a transaction named by the bank's own text reads readably, under its category as the app writes it", () => {
    const appendix = parts(html({ rows: [row('CVS PHARMACY #123', '2025-02-02', 12, { category: 'medical', name_from_bank: true })] })).at(-1)!;
    expect(appendix.text).toContain('Feb 2, 2025 CVS Pharmacy #123 Medical Chase: Checking (from the bank) −$12.00');
  });

  test('a zero amount is never written as minus zero', () => {
    const appendix = parts(html({ rows: [row('Zero fee', '2025-02-02', 0, { category: 'medical' })] })).at(-1)!;
    expect(appendix.text).toContain('Zero fee Medical Chase: Checking (from the bank) $0.00');
    expect(appendix.text).not.toContain('−$0.00');
  });

  test('every printed page carries the report and its period, beside its number', () => {
    const s = html();
    expect(s).toContain('<style>@media print { @page { @bottom-left { content: "Nya · 2025 tax year summary · Jan 1, 2025 to Dec 31, 2025"; } } }</style>');
    const range = buildReport(input({ period: period({ kind: 'range', start: '2025-02-01', end: '2025-03-31' }) }));
    expect(footerCss(range)).toContain('content: "Nya · Report for Feb 1, 2025 to Mar 31, 2025"');
    expect(printRule('@bottom-right')).toContain('content: "Page " counter(page) " of " counter(pages)');
  });

  test('on a phone’s screen, each source’s cell names its column, so the tables can stack into rows', () => {
    const s = html();
    const tables = [...s.matchAll(/<table class="report-table report-sources">([\s\S]*?)<\/table>/g)].map((m) => m[1]);
    // Connections and manual accounts here.
    expect(tables.length).toBe(2);
    for (const t of tables) {
      const heads = [...t.matchAll(/<th>([^<]*)<\/th>/g)].map((m) => m[1].replace(/&#x27;/g, "'"));
      for (const r of t.matchAll(/<tr>([\s\S]*?)<\/tr>/g)) {
        if (r[1].startsWith('<th>')) continue;
        const labels = [...r[1].matchAll(/<td data-label="([^"]*)"/g)].map((m) => m[1]);
        expect(labels).toEqual(heads);
      }
    }
    // And the accounts that ended: every cell of the three tables carries one.
    const source = readFileSync(join(import.meta.dir, '..', 'components', 'ReportView.tsx'), 'utf8');
    const sources = source.slice(source.indexOf('<section className="report-asof"'), source.indexOf('{report.removed.length > 0'));
    expect(sources.match(/report-table report-sources/g)?.length).toBe(3);
    expect(sources).not.toContain('<td>');
  });

  test('the CSV under the report’s ⋯ is a link to save the report on screen; marking and stopped accounts beside it', () => {
    const r = buildReport(input());
    const calls: string[] = [];
    const items = accountantMenu(r, false, 2, () => calls.push('mark'), () => calls.push('stopped'));
    expect(items[0]).toEqual({ label: 'Download as CSV', href: `/api/reports?${csvQuery(r)}`, download: true });
    expect(items.slice(1).map((i) => i.label)).toEqual(['Mark categories', 'Accounts you stopped tracking (2)']);
    for (const i of items.slice(1)) if ('onSelect' in i) i.onSelect();
    expect(calls).toEqual(['mark', 'stopped']);
    // While it loads, or before there is one, the CSV waits and so does marking.
    const waiting = accountantMenu(r, true, 0, () => {}, () => {});
    expect(waiting.map((i) => [i.label, 'href' in i, 'disabled' in i && !!i.disabled])).toEqual([
      ['Download as CSV', false, true],
      ['Mark categories', false, true],
    ]);
    expect(accountantMenu(null, false, 0, () => {}, () => {})[0]).not.toHaveProperty('href');
  });

  test('the CSV link asks for the report on screen, whatever the form says since', () => {
    const r = buildReport(input({ period: period({ kind: 'range', start: '2025-02-01', end: '2025-03-31' }) }));
    expect(csvQuery(r)).toBe('kind=range&start=2025-02-01&end=2025-03-31&currency=USD&tz=America%2FNew_York&format=csv');
    expect(csvQuery(buildReport(input()))).toBe('kind=year&year=2025&currency=USD&tz=America%2FNew_York&format=csv');
  });
});

/** The rules of a selector inside `@media print` in app/globals.css, in
 *  order (the last one wins where they set the same thing). */
function printRules(selector: string): string[] {
  const css = readFileSync(join(import.meta.dir, '..', 'app', 'globals.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const at = css.indexOf('@media print');
  expect(at).toBeGreaterThan(-1);
  // One space for any run of them, so a selector list can span lines.
  const block = css.slice(at).replace(/\s+/g, ' ');
  const re = new RegExp(`(?:^|[}\\s])${selector.replace(/[.+*()[\]]/g, '\\$&')}\\s*\\{([^}]*)\\}`, 'g');
  return [...block.matchAll(re)].map((m) => m[1].replace(/\s+/g, ' ').trim());
}

/** The first rule of a selector inside `@media print`. */
const printRule = (selector: string): string => printRules(selector)[0] ?? '';

describe('the phone styles', () => {
  test('the sources stack into rows on a screen 480px wide or less, never in print', () => {
    const css = readFileSync(join(import.meta.dir, '..', 'app', 'globals.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    const at = css.indexOf('@media screen and (max-width: 480px)');
    expect(at).toBeGreaterThan(-1);
    // Before the print block, which the print tests read from the first one.
    expect(at).toBeLessThan(css.indexOf('@media print'));
    const block = css.slice(at, css.indexOf('@media print'));
    expect(block).toMatch(/\.report-sources td::before\s*\{[^}]*content: attr\(data-label\)/);
    expect(printRules('.report-sources td')).toEqual([]);
  });
});

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
    // The light theme, then black and white over it, for the root with a
    // theme chosen or without (phase 7).
    const [light, root] = printRules(':root:not([data-theme]), :root[data-theme]');
    expect(light).toContain('--canvas: #f4f5f8');
    for (const d of ['--text-1: #000', '--canvas: #fff', '--surface: #fff', '--warn: #000']) expect(root).toContain(d);
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
      <MarkCategoriesView
        categories={[
          { key: 'charity', name: 'charity' },
          { key: 'medical', name: 'Doctors and dentists' },
        ]}
        chosen={['medical']}
        unreadable={false}
        saving={false}
        error={null}
        onToggle={() => {}}
        onSave={() => {}}
      />
    );
    expect(s.match(/type="checkbox"/g)?.length).toBe(2);
    // Shown by its name now, chosen by its key.
    expect(s).toMatch(/checked=""[^>]*\/><span>Doctors and dentists/);
    expect(text(s)).toContain('You choose: Nya doesn’t say how any category is taxed.');
    for (const word of ['deduct', 'write-off', 'taxable']) expect(text(s).toLowerCase()).not.toContain(word);
    const unreadable = renderToStaticMarkup(
      <MarkCategoriesView categories={[{ key: 'medical', name: 'medical' }]} chosen={[]} unreadable saving={false} error={null} onToggle={() => {}} onSave={() => {}} />
    );
    expect(text(unreadable)).toContain('couldn’t be read, so they can’t be changed here');
    expect(unreadable).not.toContain('<button');
  });

  test('found from Activity, and only there: at the foot of Spending', () => {
    expect(renderToStaticMarkup(<ReportsEntry />)).toContain('href="/reports"');
    const read = (f: string) => readFileSync(join(import.meta.dir, '..', 'components', f), 'utf8');
    expect(read('Dashboard.tsx')).not.toContain('<ReportsEntry');
    const activity = read('MonthBreakdown.tsx');
    // Three: in Spending's branch, and on Spending while the list loads and
    // when there is none, since reports need no transactions.
    expect(activity.match(/<ReportsEntry \/>/g)?.length).toBe(3);
    expect(activity.match(/\{segment === "spending" && <ReportsEntry \/>\}/g)?.length).toBe(2);
    const spending = activity.slice(activity.indexOf('segment === "spending" ? ('), activity.indexOf('{summaryCard}', activity.indexOf(') : (', activity.indexOf('segment === "spending" ? ('))));
    expect(spending).toContain('<ReportsEntry />');
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
