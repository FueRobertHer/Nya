// A report for an accountant, as a page to print or save as a PDF (#43): the
// tax-year summary or a report on any dates (lib/report/build.ts), laid out
// for paper first by the print styles in app/globals.css ("Reports"), and
// readable on screen too.
//
// THE FIRST PAGE holds what a reader needs before any figure: the period and
// the time zone its days and times are read in, when the data is from,
// whether anything may be missing and why (the gaps, in plain words, at the
// top), every institution with its last sync and its gaps, the manual
// accounts with their last update, and the bottom line. Then the totals by
// category on a page of their own, the months, the categories the person
// marked, and the appendix, each starting a new page. A figure that may be
// short is marked in words, never by color alone, so it reads in black and
// white. A period with no transactions says so instead of tables of zeros.
//
// No hooks and no state: everything comes from the Report and its words
// (lib/report/words.ts), so the CSV says the same, and the markup renders the
// same in a test (test/report-view.test.tsx) as in the browser.

import { formatMoney } from '@/lib/format';
import type { Report, ReportMonth } from '@/lib/report/build';
import {
  appendixStatus,
  gapShort,
  MARKED_NOTE,
  NO_TRANSACTIONS_WORDS,
  sourceName,
  STATE_WORDS,
  statusHeadline,
  statusLines,
  totalsNote,
} from '@/lib/report/words';

/** "Jan 5, 2025": a calendar day as it is, never moved by a time zone. */
export function reportDay(day: string): string {
  const d = new Date(`${day}T00:00:00Z`);
  return Number.isNaN(d.getTime()) ? day : d.toLocaleDateString(undefined, { timeZone: 'UTC', month: 'short', day: 'numeric', year: 'numeric' });
}

/** "Oct 10, 2026, 9:41 AM": an instant in the report's time zone. */
export function reportTime(iso: string, timeZone: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, { timeZone, month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
}

/** A month's name, and its days when the period covers only some of them. */
function monthName(m: ReportMonth): string {
  const name = new Date(`${m.month}-01T00:00:00Z`).toLocaleDateString(undefined, { timeZone: 'UTC', month: 'long', year: 'numeric' });
  const first = m.start.endsWith('-01');
  const lastDay = new Date(Date.UTC(Number(m.month.slice(0, 4)), Number(m.month.slice(5, 7)), 0)).toISOString().slice(0, 10);
  if (first && m.end === lastDay) return name;
  return `${name} (${Number(m.start.slice(8))} to ${Number(m.end.slice(8))})`;
}

export function reportHeading(report: Pick<Report, 'period'>): string {
  const { period } = report;
  return period.kind === 'year' ? `${period.start.slice(0, 4)} tax year summary` : `Report for ${reportDay(period.start)} to ${reportDay(period.end)}`;
}

export function ReportView({ report }: { report: Report }) {
  const { period, totals } = report;
  const tz = period.time_zone;
  const money = (n: number) => formatMoney(n, report.currency);
  const short = report.gaps.length > 0;
  const lines = statusLines(report, reportDay);
  const gapsOf = (item_id: string) => report.gaps.filter((g) => g.item_id === item_id).map((g) => gapShort(g, reportDay));
  const flag = short && <p className="report-flag">These figures may be incomplete: see what may be missing on the first page.</p>;

  return (
    <article className="report" aria-label={reportHeading(report)}>
      <section className="report-page report-first">
        <header className="report-head">
          <div className="report-kicker">Nya</div>
          <h1>{reportHeading(report)}</h1>
          <p className="report-meta">
            {reportDay(period.start)} to {reportDay(period.through)}
            {report.caveats.not_over && ` (the year runs to ${reportDay(period.end)})`}. Amounts in {report.currency ?? 'the currency the transactions are in'}
            {report.currencies.length > 1 && `; ${report.currencies.length - 1} other ${report.currencies.length === 2 ? 'currency is' : 'currencies are'} named below and left out`}.
          </p>
          <p className="report-meta">
            Data as of {reportTime(report.data_as_of, tz)}. Made {reportTime(report.generated_at, tz)}. Times and today’s date are in {tz}; a
            transaction’s date is its bank’s own day.
          </p>
        </header>

        <div className={`report-status${short || report.empty ? ' report-status-short' : ''}`} role="note">
          <p className="report-headline">{statusHeadline(report)}</p>
          {lines.length > 0 && (
            <ul>
              {lines.map((l, i) => (
                <li key={i}>{l}</li>
              ))}
            </ul>
          )}
        </div>

        {!report.empty && (
          <div className="report-bottom-line">
            <div>
              <div className="total-label">Money in</div>
              <div className="report-figure">{money(totals.money_in)}</div>
            </div>
            <div>
              <div className="total-label">Money out</div>
              <div className="report-figure">{money(totals.money_out)}</div>
            </div>
            <div>
              <div className="total-label">Net</div>
              <div className="report-figure">{money(totals.net)}</div>
            </div>
            <p className="report-note">
              {totals.counted} of {totals.transactions} transactions counted. {totalsNote(report)}
              {short && ' These figures may be incomplete.'}
            </p>
          </div>
        )}

        <section className="report-asof" aria-label="Where the data comes from">
          <h2>Where the data comes from</h2>
          {report.institutions.length === 0 && report.manual.length === 0 && <p className="report-note">Nothing is connected or tracked yet.</p>}
          {report.institutions.length > 0 && (
            <div className="report-scroll">
              <table className="report-table">
                <thead>
                  <tr>
                    <th>Connection</th>
                    <th>State</th>
                    <th>Transactions as of</th>
                    <th>In Nya from</th>
                    <th>May be missing</th>
                  </tr>
                </thead>
                <tbody>
                  {report.institutions.map((i) => {
                    const gaps = gapsOf(i.item_id);
                    return (
                      <tr key={i.item_id}>
                        <td>{i.institution_name}</td>
                        <td>
                          {i.no_transactions
                            ? NO_TRANSACTIONS_WORDS[i.no_transactions]
                            : i.problem
                              ? `${STATE_WORDS[i.problem.state] ?? 'Not updating'} since ${reportTime(i.problem.since, tz)}`
                              : i.records_unreadable
                                ? 'Its records couldn’t all be read'
                                : 'No problem recorded'}
                        </td>
                        <td>{i.no_transactions ? '' : i.synced_at ? reportTime(i.synced_at, tz) : 'Not known'}</td>
                        <td>{i.first_date ? reportDay(i.first_date) : ''}</td>
                        <td>{gaps.length > 0 ? gaps.join('. ') : i.no_transactions ? '' : 'Nothing known'}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
          {report.manual.length > 0 && (
            <>
              <h3>Manual accounts</h3>
              <div className="report-scroll">
                <table className="report-table">
                  <thead>
                    <tr>
                      <th>Account</th>
                      <th>Balance last updated</th>
                    </tr>
                  </thead>
                  <tbody>
                    {report.manual.map((m) => (
                      <tr key={m.account_id}>
                        <td>
                          {m.institution}: {m.name}
                        </td>
                        <td>{m.updated_at ? reportTime(m.updated_at, tz) : 'Not recorded'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="report-note">Transactions on a manual account are the ones you entered or imported: Nya can’t tell whether any are missing.</p>
            </>
          )}
          {report.removed.length > 0 && (
            <>
              <h3>Connections removed since</h3>
              <ul className="report-list">
                {report.removed.map((r, i) => (
                  <li key={i}>
                    {r.institution}: seen from {reportDay(r.first_seen)} to {reportDay(r.last_seen)}
                    {r.connected_again ? ', and connected again since' : ''}.
                  </li>
                ))}
              </ul>
            </>
          )}
        </section>
      </section>

      {!report.empty && (
        <section className="report-page" aria-label="Totals by category">
          <h2>Totals by category</h2>
          {flag}
          <h3>Money out</h3>
          <CategoryTable rows={report.money_out} money={money} empty="No money out in this period." />
          <h3>Money in</h3>
          <CategoryTable rows={report.money_in} money={money} empty="No money in in this period." />
          <p className="report-note">
            Money in counts a refund under its own category. {totalsNote(report)}
          </p>
        </section>
      )}

      {!report.empty && report.months.length > 1 && (
        <section className="report-page" aria-label="By month">
          <h2>By month</h2>
          {flag}
          <div className="report-scroll">
            <table className="report-table">
              <thead>
                <tr>
                  <th>Month</th>
                  <th className="num">Money in</th>
                  <th className="num">Money out</th>
                  <th className="num">Net</th>
                  <th className="num">Counted</th>
                  <th>Notes</th>
                </tr>
              </thead>
              <tbody>
                {report.months.map((m) => (
                  <tr key={m.month}>
                    <td>{monthName(m)}</td>
                    {m.future ? (
                      <>
                        <td className="num" colSpan={4}>
                          Still to come
                        </td>
                        <td />
                      </>
                    ) : (
                      <>
                        <td className="num">{money(m.money_in)}</td>
                        <td className="num">{money(m.money_out)}</td>
                        <td className="num">{money(m.net)}</td>
                        <td className="num">{m.transactions}</td>
                        <td>{m.gaps.length > 0 ? `May be missing transactions from ${m.gaps.join(', ')}` : m.uncertain ? 'May be incomplete' : ''}</td>
                      </>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {report.marked && (
        <section className="report-page" aria-label="Categories you marked for taxes">
          <h2>Categories you marked for taxes</h2>
          <p className="report-note">{MARKED_NOTE}</p>
          {flag}
          <div className="report-scroll">
            <table className="report-table">
              <thead>
                <tr>
                  <th>Category</th>
                  <th className="num">Money in</th>
                  <th className="num">Money out</th>
                  <th className="num">Counted</th>
                </tr>
              </thead>
              <tbody>
                {report.marked.categories.map((c) => (
                  <tr key={c.category}>
                    <td>{c.category}</td>
                    <td className="num">{money(c.money_in)}</td>
                    <td className="num">{money(c.money_out)}</td>
                    <td className="num">{c.transactions}</td>
                  </tr>
                ))}
                <tr className="report-total-row">
                  <td>All marked categories</td>
                  <td className="num">{money(report.marked.money_in)}</td>
                  <td className="num">{money(report.marked.money_out)}</td>
                  <td />
                </tr>
              </tbody>
            </table>
          </div>
        </section>
      )}

      {report.appendix && (
        <section className="report-page" aria-label="Appendix">
          <h2>Appendix: transactions in the categories you marked</h2>
          <p className="report-note">
            Oldest first, in each one’s own currency. Money out is shown as a minus.
            {report.appendix.excluded > 0 &&
              ` ${report.appendix.excluded} transaction${report.appendix.excluded === 1 ? '' : 's'} you excluded from budgets and reports ${report.appendix.excluded === 1 ? 'is' : 'are'} left out.`}
          </p>
          {report.appendix.total > report.appendix.rows.length && (
            <p className="report-flag">
              Showing the first {report.appendix.rows.length} of {report.appendix.total} transactions. The totals above count all of them; a shorter period lists
              them all.
            </p>
          )}
          {report.appendix.rows.length === 0 ? (
            <p className="report-note">No transactions in these categories in this period.</p>
          ) : (
            <div className="report-scroll">
              <table className="report-table report-appendix">
                <thead>
                  <tr>
                    <th>Date</th>
                    <th>Description</th>
                    <th>Category</th>
                    <th>Account</th>
                    <th className="num">Amount</th>
                    <th>Notes</th>
                  </tr>
                </thead>
                <tbody>
                  {report.appendix.rows.map((r, i) => {
                    const status = appendixStatus(r);
                    return (
                      <tr key={i}>
                        <td className="report-nowrap">{reportDay(r.date)}</td>
                        <td>{r.name}</td>
                        <td>{r.category}</td>
                        <td>
                          {r.institution}: {r.account} ({sourceName(r.source)})
                        </td>
                        <td className="num">{formatMoney(-r.amount, r.currency)}</td>
                        <td>{[status, r.note].filter(Boolean).join('. ')}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}
    </article>
  );
}

function CategoryTable({ rows, money, empty }: { rows: Report['money_out']; money: (n: number) => string; empty: string }) {
  if (rows.length === 0) return <p className="report-note">{empty}</p>;
  return (
    <div className="report-scroll">
      <table className="report-table">
        <thead>
          <tr>
            <th>Category</th>
            <th className="num">Amount</th>
            <th className="num">Transactions</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((c) => (
            <tr key={c.category}>
              <td>{c.category}</td>
              <td className="num">{money(c.amount)}</td>
              <td className="num">{c.transactions}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
