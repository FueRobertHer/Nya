// lib/report/csv.ts
//
// A report's totals as one CSV file (app/api/reports?format=csv), for a
// spreadsheet: the same figures as the printed page, from the same Report
// (lib/report/build.ts), and the same words for what it may be missing
// (lib/report/words.ts), so the file never reads as more complete than the
// page. Written with lib/csv.ts: RFC 4180, a byte order mark, and the guard
// against formula injection (a merchant or category can come from a bank or a
// file).
//
// One table, a row per figure: `section` says what the row is (the report,
// its status and gaps, the totals, each category's money in or out, each
// month, the marked categories, each institution and manual account), `name`
// which one, then the amounts (positive sums, in `currency`), how many
// transactions they count, and a note. Days are written YYYY-MM-DD.

import { csvRow, UTF8_BOM, type CsvValue } from '../csv';
import type { Report } from './build';
import { caveatLines, NO_TRANSACTIONS_WORDS, problemLines, reportTitle, STATE_WORDS, statusHeadline, totalsNote } from './words';

export const REPORT_CSV_COLUMNS = ['section', 'name', 'money_in', 'money_out', 'net', 'transactions', 'currency', 'note'] as const;

const iso = (day: string) => day;

/** The file's name: the year, or the range's days. */
export function reportFilename(report: Pick<Report, 'period'>): string {
  const { period } = report;
  return period.kind === 'year' ? `nya-report-${period.start.slice(0, 4)}.csv` : `nya-report-${period.start}-to-${period.end}.csv`;
}

export function reportCsv(report: Report): string {
  const c = report.currency;
  const rows: CsvValue[][] = [];
  const line = (section: string, name: CsvValue, money_in: CsvValue = null, money_out: CsvValue = null, net: CsvValue = null, transactions: CsvValue = null, note: CsvValue = null) =>
    rows.push([section, name, money_in, money_out, net, transactions, money_in !== null || money_out !== null || net !== null ? c : null, note]);

  const { period } = report;
  line('report', reportTitle(report, iso), null, null, null, null, `From ${period.start} to ${period.through}`);
  line('time_zone', period.time_zone, null, null, null, null, 'Transaction dates are the bank’s own days; times and today are read in this time zone.');
  line('generated_at', report.generated_at);
  line('data_as_of', report.data_as_of, null, null, null, null, 'The oldest time an institution’s transactions were last brought in');
  line('status', statusHeadline(report));
  for (const g of problemLines(report, iso)) line('gap', g);
  for (const n of caveatLines(report, iso)) line('caveat', n);

  const t = report.totals;
  line('total', 'Everything counted', t.money_in, t.money_out, t.net, t.counted, totalsNote(report));
  for (const x of report.money_in) line('money_in', x.category, x.amount, null, null, x.transactions);
  for (const x of report.money_out) line('money_out', x.category, null, x.amount, null, x.transactions);
  for (const m of report.months) {
    if (m.future) {
      line('month', m.month, null, null, null, null, 'Still to come');
      continue;
    }
    const note = m.gaps.length > 0 ? `May be missing transactions from ${m.gaps.join(', ')}` : m.uncertain ? 'May be incomplete: see the gaps' : null;
    line('month', m.month, m.money_in, m.money_out, m.net, m.transactions, m.start.slice(8) === '01' && m.end === lastDay(m.month) ? note : [`${m.start} to ${m.end}`, note].filter(Boolean).join('. '));
  }
  if (report.marked) {
    for (const x of report.marked.categories) line('marked', x.category, x.money_in, x.money_out, null, x.transactions);
    line('marked_total', 'Marked categories', report.marked.money_in, report.marked.money_out, null, null, 'Categories you marked as mattering for your taxes. Nya doesn’t judge how any of them is taxed.');
  }
  for (const i of report.institutions) {
    const parts = i.no_transactions
      ? [NO_TRANSACTIONS_WORDS[i.no_transactions]]
      : [
          i.problem ? `${STATE_WORDS[i.problem.state] ?? i.problem.state} since ${i.problem.since}` : null,
          i.synced_at ? `transactions last brought in ${i.synced_at}` : 'when its transactions were last brought in isn’t known',
          i.first_date ? `transactions in Nya from ${i.first_date}` : null,
        ];
    line('institution', i.institution_name, null, null, null, null, parts.filter(Boolean).join('; '));
  }
  for (const m of report.manual) {
    line('manual_account', `${m.institution}: ${m.name}`, null, null, null, null, m.updated_at ? `Balance last updated ${m.updated_at}` : 'When its balance was last updated isn’t recorded');
  }
  for (const r of report.removed) {
    line('removed_connection', r.institution, null, null, null, null, `Seen from ${r.first_seen} to ${r.last_seen}${r.connected_again ? ', and connected again since' : ''}`);
  }
  return UTF8_BOM + csvRow(REPORT_CSV_COLUMNS) + rows.map(csvRow).join('');
}

/** The last day of a "YYYY-MM". */
function lastDay(month: string): string {
  const [y, m] = month.split('-').map(Number);
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
}
