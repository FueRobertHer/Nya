'use client';

// Year over year on the report page (app/reports, lib/report/
// year-over-year.ts): this year so far against the same days of last year,
// this month against the same days a year ago, each month against the same
// month last year, and money in and out by category group and category, with
// the change in amount and percent. A month that may be short of
// transactions says so in words, never by color alone, so it reads in black
// and white; printable like the other reports. Read on the server
// (app/api/reports/year-over-year) from what Nya has stored, in this
// browser's time zone.

import { useCallback, useEffect, useRef, useState } from 'react';
import { Masked } from './HideAmounts';
import { reportDay, reportTime } from './ReportView';
import { browserZone } from './RunwayReport';
import { formatMoney, signedMoney } from '@/lib/format';
import { gapSentences, reportConvertedText, scopeLine } from '@/lib/report/words';
import type { Change, YoyCategory, YoyCompare, YoyGroup, YoyPeriod } from '@/lib/report/year-over-year';
import type { YearOverYearReport as Yoy } from '@/lib/report/year-over-year-read';
import { joinNames } from '@/lib/month-coverage';

/** "Oct 2026": a month's name. */
const monthWords = (month: string) => new Date(`${month}-01T00:00:00Z`).toLocaleDateString(undefined, { timeZone: 'UTC', month: 'short', year: 'numeric' });
/** "Jan 1 to Oct 22, 2026". */
const spanWords = (p: Pick<YoyPeriod, 'start' | 'end'>) => `${reportDay(p.start)} to ${reportDay(p.end)}`;

/** A change in percent, in words: "+12.5%", "new" when last year's was
 *  zero and this year's isn't, nothing when both are. */
export function pctWords(c: Change): string {
  if (c.pct !== null) return `${c.pct > 0 ? '+' : ''}${c.pct.toFixed(1)}%`;
  return c.this === 0 ? '' : 'new';
}

/** "st", "nd", "rd" or "th", for a day of the month. */
const ordinal = (n: number) => (n % 10 === 1 && n !== 11 ? 'st' : n % 10 === 2 && n !== 12 ? 'nd' : n % 10 === 3 && n !== 13 ? 'rd' : 'th');

/** What may make a stretch short, in words, or nothing. */
const shortWords = (p: YoyShort) => (p.uncertain ? `may be short${p.institutions.length > 0 ? ` of ${joinNames(p.institutions)}` : ''}` : '');
type YoyShort = Pick<YoyPeriod, 'uncertain' | 'institutions'>;

/** What the comparison can't see, in words: either year's gaps, what was left
 *  out for another currency, and what no report holds. */
export function yoyCaveats(r: Yoy): string[] {
  const lines = gapSentences(r.gaps, reportDay);
  if (r.left_out_text.this) lines.push(`This year: ${r.left_out_text.this}`);
  if (r.left_out_text.last) lines.push(`Last year: ${r.left_out_text.last}`);
  if (r.caveats.hidden) lines.push('Hidden accounts are left out.');
  if (r.caveats.names_unread) lines.push('Your names for merchants couldn’t be read, so the bank’s are shown.');
  lines.push(...r.caveats.notes);
  const scope = scopeLine(r.caveats.scope);
  if (scope) lines.push(scope);
  return lines;
}

/** The figures of a comparison, side by side. */
function Compare({ title, compare, currency }: { title: string; compare: YoyCompare; currency: string | null }) {
  const money = (n: number) => formatMoney(n, currency);
  const block = (label: string, c: Change) => (
    <div>
      <div className="total-label">{label}</div>
      <div className="report-figure">
        <Masked>{money(c.this)}</Masked>
      </div>
      <div className="report-note">
        <Masked>{`last year ${money(c.last)}; ${signedMoney(c.change, currency, { always: true })}${pctWords(c) ? ` (${pctWords(c)})` : ''}`}</Masked>
      </div>
    </div>
  );
  const notes = [shortWords(compare.this) && `This year ${shortWords(compare.this)}.`, shortWords(compare.last) && `Last year ${shortWords(compare.last)}.`].filter(Boolean);
  return (
    <>
      <h3>{title}</h3>
      <div className="report-bottom-line">
        {block('Money in', compare.money_in)}
        {block('Money out', compare.money_out)}
        {block('Net', compare.net)}
        <p className="report-note">
          {spanWords(compare.this)}, against {spanWords(compare.last)}.{notes.length > 0 ? ` ${notes.join(' ')}` : ''}
        </p>
      </div>
    </>
  );
}

/** One measure month by month. */
function MonthTable({ r, measure, label }: { r: Yoy; measure: 'money_in' | 'money_out' | 'net'; label: string }) {
  const money = (n: number) => formatMoney(n, r.currency);
  return (
    <>
      <h3>{label}</h3>
      <div className="report-scroll">
        <table className="report-table">
          <thead>
            <tr>
              <th>Month</th>
              <th className="num">This year</th>
              <th className="num">Last year</th>
              <th className="num">Change</th>
              <th>Notes</th>
            </tr>
          </thead>
          <tbody>
            {r.months.map((m) => {
              const c = m[measure];
              const notes = [shortWords(m.this) && `This year ${shortWords(m.this)}`, shortWords(m.last) && `Last year ${shortWords(m.last)}`].filter(Boolean);
              return (
                <tr key={m.month}>
                  <td className="report-nowrap">
                    {monthWords(m.month)}
                    {m.month === r.month.month ? ` (to the ${Number(m.this.end.slice(8))}${ordinal(Number(m.this.end.slice(8)))})` : ''}
                  </td>
                  <td className="num">
                    <Masked>{money(c.this)}</Masked>
                  </td>
                  <td className="num">
                    <Masked>{money(c.last)}</Masked>
                  </td>
                  <td className="num">
                    <Masked>{`${signedMoney(c.change, r.currency, { always: true })}${pctWords(c) ? ` ${pctWords(c)}` : ''}`}</Masked>
                  </td>
                  <td>{notes.join('. ')}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </>
  );
}

/** Money in or out by group, each with its categories under it. */
function GroupTable({ r, measure, label }: { r: Yoy; measure: 'money_in' | 'money_out'; label: string }) {
  const money = (n: number) => formatMoney(n, r.currency);
  const groups = r.groups.filter((g) => g[measure].this !== 0 || g[measure].last !== 0);
  const row = (c: YoyCategory | YoyGroup, group: boolean) => (
    <tr key={`${group ? 'g' : 'c'}:${c.id ?? c.name}`} className={group ? 'report-total-row' : undefined}>
      <td className={group ? undefined : 'yoy-category'}>{c.name}</td>
      <td className="num">
        <Masked>{money(c[measure].this)}</Masked>
      </td>
      <td className="num">
        <Masked>{money(c[measure].last)}</Masked>
      </td>
      <td className="num">
        <Masked>{signedMoney(c[measure].change, r.currency, { always: true })}</Masked>
      </td>
      <td className="num">{pctWords(c[measure])}</td>
    </tr>
  );
  return (
    <>
      <h3>{label}</h3>
      {groups.length === 0 ? (
        <p className="report-note">None in either year.</p>
      ) : (
        <div className="report-scroll">
          <table className="report-table">
            <thead>
              <tr>
                <th>Group and category</th>
                <th className="num">This year</th>
                <th className="num">Last year</th>
                <th className="num">Change</th>
                <th className="num">%</th>
              </tr>
            </thead>
            <tbody>
              {groups.flatMap((g) => [row(g, true), ...g.categories.filter((c) => c[measure].this !== 0 || c[measure].last !== 0).map((c) => row(c, false))])}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

/** Year over year as a page to read and print. No hooks and no state. */
export function YearOverYearView({ report: r }: { report: Yoy }) {
  const caveats = yoyCaveats(r);
  // With a home currency: what was converted into the comparison's currency.
  const converted = reportConvertedText({ conversion: r.conversion ?? null }, reportDay);
  return (
    <article className="report yoy-report" aria-label="Year over year">
      <section className="report-page report-first">
        <header className="report-head">
          <div className="report-kicker">Nya</div>
          <h1>Year over year</h1>
          <p className="report-meta">
            {spanWords(r.year.this)}, against the same days of {r.year.last.start.slice(0, 4)}. Amounts in {r.currency ?? 'the currency the transactions are in'}
            {!r.conversion && r.currencies.length > 1 && `; ${r.currencies.length - 1} other ${r.currencies.length === 2 ? 'currency is' : 'currencies are'} named below and left out`}.
            {converted ? ` ${converted}` : ''}
          </p>
          <p className="report-meta">
            {r.data_as_of ? `Data as of ${reportTime(r.data_as_of, r.time_zone)}. ` : ''}Made {reportTime(r.generated_at, r.time_zone)}. Times and today’s date are in {r.time_zone};
            a transaction’s date is its bank’s own day.
          </p>
        </header>
        <div className={`report-status${caveats.length > 0 ? ' report-status-short' : ''}`} role="note">
          <p className="report-headline">{caveats.length > 0 ? 'These figures may be incomplete:' : 'Nothing is known to be missing from either year.'}</p>
          {caveats.length > 0 && (
            <ul>
              {caveats.map((c, i) => (
                <li key={i}>{c}</li>
              ))}
            </ul>
          )}
        </div>
        {r.empty ? (
          <p className="report-note">There are no transactions in either year to compare.</p>
        ) : (
          <>
            <Compare title="This year so far" compare={r.year} currency={r.currency} />
            <Compare title={`${monthWords(r.month.month)} so far`} compare={r.month} currency={r.currency} />
            <p className="report-note">
              Counted as the Activity tab counts a month: transfers between your accounts, cash withdrawals, loan payments and what you excluded aren’t in
              either year.
            </p>
          </>
        )}
      </section>

      {!r.empty && (
        <section className="report-page" aria-label="By month">
          <h2>By month</h2>
          <p className="report-note">Each month against the same month last year; this one through the same day.</p>
          <MonthTable r={r} measure="money_out" label="Money out" />
          <MonthTable r={r} measure="money_in" label="Money in" />
          <MonthTable r={r} measure="net" label="Net" />
        </section>
      )}

      {!r.empty && (
        <section className="report-page" aria-label="By category">
          <h2>By category group and category</h2>
          <p className="report-note">This year so far against the same days of last year, each category in the group it is in now.</p>
          <GroupTable r={r} measure="money_out" label="Money out" />
          <GroupTable r={r} measure="money_in" label="Money in" />
        </section>
      )}
    </article>
  );
}

export default function YearOverYearReport() {
  const [report, setReport] = useState<Yoy | null>(null);
  const [currency, setCurrency] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  // Only the latest request's answer is shown.
  const latest = useRef(0);

  const load = useCallback(async (asked: string | null) => {
    const n = ++latest.current;
    setLoading(true);
    setError(null);
    try {
      const q = new URLSearchParams({ tz: browserZone() });
      if (asked) q.set('currency', asked);
      const res = await fetch(`/api/reports/year-over-year?${q}`);
      const body = await res.json().catch(() => ({}));
      if (n !== latest.current) return;
      if (res.ok && body.report) {
        setReport(body.report as Yoy);
        setCurrency((body.report as Yoy).currency);
      } else {
        setReport(null);
        setError(typeof body.error === 'string' ? body.error : 'The years couldn’t be compared.');
      }
    } catch {
      if (n !== latest.current) return;
      setReport(null);
      setError('The years couldn’t be compared. Check your connection and try again.');
    } finally {
      if (n === latest.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(null);
  }, [load]);

  return (
    <>
      <div className="card no-print report-controls">
        {report && report.currencies.length > 1 && (
          <label className="field">
            Currency
            <select
              value={currency ?? ''}
              onChange={(e) => {
                setCurrency(e.target.value);
                void load(e.target.value);
              }}
            >
              {report.currencies.map((c) => (
                <option key={c.currency} value={c.currency}>
                  {c.currency} ({c.transactions} transaction{c.transactions === 1 ? '' : 's'})
                </option>
              ))}
            </select>
          </label>
        )}
        {error && (
          <div className="error" role="alert">
            {error}
          </div>
        )}
        <div className="action-row report-actions">
          <button className="secondary" onClick={() => window.print()} disabled={!report || loading}>
            Print or save as PDF
          </button>
        </div>
        <p className="panel-note">This compares what Nya has stored, so open Nya first to bring your connections up to date.</p>
      </div>
      {loading && !report && <div className="spinner no-print" role="status" aria-label="Comparing the years" />}
      {report && (
        <div className={loading ? 'report-loading' : undefined} aria-busy={loading}>
          <YearOverYearView report={report} />
        </div>
      )}
    </>
  );
}
