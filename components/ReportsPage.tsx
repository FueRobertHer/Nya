'use client';

// The report page (app/reports, #43): pick a tax year or a range of days, read
// the report (components/ReportView.tsx), mark the categories that matter for
// taxes, then print it or save it as a PDF from the browser's print window, or
// download its totals as CSV. The report is made on the server
// (app/api/reports) from what Nya has stored, in this browser's time zone,
// which it says; the form checks the period by the server's own rules
// (lib/report/period.ts) before asking. Everything here but the report is for
// the screen only (no-print): the printed pages are the report alone.
//
// The period is kept in the address (?kind=year&year=2025), so a report can
// be bookmarked or opened again as it was; the time zone is not, since it is
// the reader's own.

import { useCallback, useEffect, useRef, useState } from 'react';
import { ReportView, reportHeading } from './ReportView';
import { Sheet } from './Sheet';
import type { Report } from '@/lib/report/build';
import { EARLIEST_REPORT_DAY, isTimeZone, resolvePeriod, type ReportRequest } from '@/lib/report/period';
import { categoryKey, REPORT_SETTINGS_LIMITS } from '@/lib/report/settings';
import { localDate } from '@/lib/local-date';

/** What the form holds. */
export type ReportForm = { kind: 'year' | 'range'; year: number; start: string; end: string; currency: string | null };

/** The browser's time zone, or UTC where it doesn't say one the report takes. */
function browserZone(): string {
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return isTimeZone(tz) ? tz : 'UTC';
}

/** The form as the address gives it, else last year (the tax year people most
 *  often report on) and, for a range, this year so far. */
export function formFrom(search: string, today: string): ReportForm {
  const q = new URLSearchParams(search);
  const year = Number(q.get('year'));
  const day = (v: string | null, fallback: string) => (v && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : fallback);
  const currency = q.get('currency');
  return {
    kind: q.get('kind') === 'range' ? 'range' : 'year',
    year: Number.isInteger(year) && year >= 2000 && year <= Number(today.slice(0, 4)) ? year : Number(today.slice(0, 4)) - 1,
    start: day(q.get('start'), `${today.slice(0, 4)}-01-01`),
    end: day(q.get('end'), today),
    currency: currency && /^[A-Z0-9]{2,16}$/.test(currency) ? currency : null,
  };
}

/** The query for a form: what the address keeps, and with `tz` and `format`,
 *  what app/api/reports takes. */
export function reportQuery(form: ReportForm, tz?: string, format?: 'csv'): string {
  const q = new URLSearchParams({ kind: form.kind });
  if (form.kind === 'year') q.set('year', String(form.year));
  else {
    q.set('start', form.start);
    q.set('end', form.end);
  }
  if (form.currency) q.set('currency', form.currency);
  if (tz) q.set('tz', tz);
  if (format) q.set('format', format);
  return q.toString();
}

const requestOf = (f: ReportForm): ReportRequest => (f.kind === 'year' ? { kind: 'year', year: f.year } : { kind: 'range', start: f.start, end: f.end });

export default function ReportsPage() {
  const [form, setForm] = useState<ReportForm | null>(null);
  const [zone, setZone] = useState('UTC');
  const [today, setToday] = useState('');
  const [report, setReport] = useState<Report | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [marking, setMarking] = useState(false);
  // Only the latest request's answer is shown: one asked for earlier may come back later.
  const latest = useRef(0);

  const load = useCallback(async (f: ReportForm, tz: string) => {
    const checked = resolvePeriod(requestOf(f), tz, Date.now());
    if ('error' in checked) {
      setError(checked.error);
      return;
    }
    const n = ++latest.current;
    setLoading(true);
    setError(null);
    window.history.replaceState(null, '', `/reports?${reportQuery(f)}`);
    try {
      const res = await fetch(`/api/reports?${reportQuery(f, tz)}`);
      const body = await res.json().catch(() => ({}));
      if (n !== latest.current) return;
      if (!res.ok) {
        setReport(null);
        setError(typeof body.error === 'string' ? body.error : 'The report couldn’t be made.');
      } else {
        setReport(body.report as Report);
        // The currency the report chose, so the picker shows it.
        setForm((cur) => (cur ? { ...cur, currency: (body.report as Report).currency } : cur));
      }
    } catch {
      if (n === latest.current) setError('The report couldn’t be made. Check your connection and try again.');
    } finally {
      if (n === latest.current) setLoading(false);
    }
  }, []);

  // The address and the browser's calendar are only known here, after the
  // first render, which is the same on the server and in the browser.
  useEffect(() => {
    const tz = browserZone();
    const day = localDate();
    const f = formFrom(window.location.search, day);
    setZone(tz);
    setToday(day);
    setForm(f);
    void load(f, tz);
  }, [load]);

  const thisYear = today ? Number(today.slice(0, 4)) : 0;
  const years = thisYear ? Array.from({ length: thisYear - 1999 }, (_, i) => thisYear - i) : [];
  const change = (patch: Partial<ReportForm>) => setForm((f) => (f ? { ...f, ...patch } : f));
  const make = (patch: Partial<ReportForm> = {}) => {
    if (!form) return;
    const next = { ...form, ...patch };
    setForm(next);
    void load(next, zone);
  };

  return (
    <main className="wrap report-wrap">
      <nav className="report-nav no-print" aria-label="Back to Nya">
        <a href="/">← Nya</a>
      </nav>
      <div className="no-print">
        <h1>Reports</h1>
        <p className="sub">
          A summary of a tax year, or of any dates, by category and by month, with what it may be missing. Print it, or save it as a PDF, for your
          accountant.
        </p>
      </div>

      {form && (
        <div className="card no-print report-controls">
          <div className="button-pair report-kind" role="group" aria-label="Kind of report">
            <button className={form.kind === 'year' ? '' : 'secondary'} aria-pressed={form.kind === 'year'} onClick={() => make({ kind: 'year', currency: null })}>
              Tax year
            </button>
            <button className={form.kind === 'range' ? '' : 'secondary'} aria-pressed={form.kind === 'range'} onClick={() => make({ kind: 'range', currency: null })}>
              Date range
            </button>
          </div>
          {form.kind === 'year' ? (
            <label className="field">
              Calendar year
              <select value={form.year} onChange={(e) => make({ year: Number(e.target.value), currency: null })}>
                {years.map((y) => (
                  <option key={y} value={y}>
                    {y}
                    {y === thisYear ? ' (so far)' : ''}
                  </option>
                ))}
              </select>
            </label>
          ) : (
            <div className="report-dates">
              <label className="field">
                From
                <input type="date" min={EARLIEST_REPORT_DAY} max={today} value={form.start} onChange={(e) => change({ start: e.target.value })} />
              </label>
              <label className="field">
                To
                <input type="date" min={EARLIEST_REPORT_DAY} max={today} value={form.end} onChange={(e) => change({ end: e.target.value })} />
              </label>
              <button onClick={() => make({ currency: null })} disabled={loading}>
                Make report
              </button>
            </div>
          )}
          {report && report.currencies.length > 1 && (
            <label className="field">
              Currency
              <select value={form.currency ?? report.currency ?? ''} onChange={(e) => make({ currency: e.target.value })}>
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
            {report && !loading ? (
              <a className="report-link-button" href={`/api/reports?${reportQuery(form, zone, 'csv')}`} download>
                Download as CSV
              </a>
            ) : (
              <button className="secondary" disabled>
                Download as CSV
              </button>
            )}
            <button className="secondary" onClick={() => setMarking(true)} disabled={!report || loading}>
              Mark categories
            </button>
          </div>
          <p className="panel-note">
            To save a PDF, choose Save as PDF in the print window. Days and times are read in {zone}. The report reads what Nya has stored, so open Nya first to
            bring your connections up to date.
          </p>
        </div>
      )}

      {loading && !report && <div className="spinner no-print" role="status" aria-label="Making the report" />}
      {report && (
        <div className={loading ? 'report-loading' : undefined} aria-busy={loading} aria-label={reportHeading(report)}>
          <ReportView report={report} />
        </div>
      )}

      {report && (
        <Sheet open={marking} title="Categories for taxes" onClose={() => setMarking(false)}>
          <MarkCategories
            categories={report.categories}
            marked={report.marked?.categories.map((c) => c.category) ?? []}
            unreadable={report.caveats.marked === 'unreadable'}
            onSaved={() => {
              setMarking(false);
              if (form) void load(form, zone);
            }}
          />
        </Sheet>
      )}
    </main>
  );
}

/** The sheet that marks categories: every category in the report's period,
 *  and every one already marked. Saved whole (app/api/report-settings). */
export function MarkCategories({
  categories,
  marked,
  unreadable,
  onSaved,
}: {
  categories: string[];
  marked: string[];
  unreadable: boolean;
  onSaved: () => void;
}) {
  const [chosen, setChosen] = useState<string[]>(marked);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const toggle = (c: string) => setChosen((cur) => (cur.includes(c) ? cur.filter((x) => x !== c) : [...cur, c]));

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch('/api/report-settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ settings: { v: 1, marked: chosen.map(categoryKey) } }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) setError(typeof body.error === 'string' ? body.error : 'Your choices couldn’t be saved.');
      else onSaved();
    } catch {
      setError('Your choices couldn’t be saved. Check your connection and try again.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <MarkCategoriesView
      categories={categories}
      chosen={chosen}
      unreadable={unreadable}
      saving={saving}
      error={error}
      onToggle={toggle}
      onSave={() => void save()}
    />
  );
}

export function MarkCategoriesView({
  categories,
  chosen,
  unreadable,
  saving,
  error,
  onToggle,
  onSave,
}: {
  categories: string[];
  chosen: string[];
  unreadable: boolean;
  saving: boolean;
  error: string | null;
  onToggle: (category: string) => void;
  onSave: () => void;
}) {
  if (unreadable) {
    return (
      <p className="error">
        The categories you marked before couldn’t be read, so they can’t be changed here: saving now would replace them. Nothing has been lost; this needs
        fixing on the server.
      </p>
    );
  }
  const over = chosen.length > REPORT_SETTINGS_LIMITS.marked;
  return (
    <div className="sheet-form">
      <p className="panel-note">
        Mark the categories that matter for your taxes. They get a group of their own in every report, with their transactions listed for your
        accountant. You choose: Nya doesn’t say how any category is taxed.
      </p>
      {categories.length === 0 ? (
        <p className="empty-note">There are no categories in this period yet.</p>
      ) : (
        <fieldset className="report-marks" disabled={saving} aria-label="Categories">
          {categories.map((c) => (
            <label key={c} className="report-mark">
              <input type="checkbox" checked={chosen.includes(c)} onChange={() => onToggle(c)} />
              <span>{c}</span>
            </label>
          ))}
        </fieldset>
      )}
      {over && <p className="error">At most {REPORT_SETTINGS_LIMITS.marked} categories can be marked.</p>}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <button onClick={onSave} disabled={saving || over}>
        {saving ? 'Saving…' : 'Save'}
      </button>
    </div>
  );
}
