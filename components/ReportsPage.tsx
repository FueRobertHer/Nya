'use client';

// The report page (app/reports): three reports, chosen at the top. For an
// accountant (#43): pick a tax year or a range of days, read the report
// (components/ReportView.tsx), mark the categories that matter for taxes,
// then print it or save it as a PDF from the browser's print window, or
// download its totals as CSV. The runway (components/RunwayReport.tsx) and
// year over year (components/YearOverYearReport.tsx) each read and print
// their own, and `?report=runway` or `?report=year-over-year` in the address
// opens one. The report is made on the server
// (app/api/reports) from what Nya has stored, in this browser's time zone,
// which it says; the form checks the period by the server's own rules
// (lib/report/period.ts) before asking. Everything here but the report is for
// the screen only (no-print): the printed pages are the report alone.
//
// The period is kept in the address (?kind=year&year=2025), so a report can
// be bookmarked or opened again as it was; the time zone is not, since it is
// the reader's own.
//
// ACCOUNTS YOU STOPPED TRACKING. Reports read what Nya keeps of each account a
// SimpleFIN connection fed that the person let go (connector-ended), to say a
// period may be missing its transactions. Here, and only here, the person can
// see those records and forget one (app/api/connectors/ended), after which
// reports no longer mention it. The sheets that let accounts go point here
// (components/Connectors.tsx EndedPointer): `?stopped` in the address opens
// the list once it has loaded.

import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { ReportView } from './ReportView';
import RunwayReport from './RunwayReport';
import YearOverYearReport from './YearOverYearReport';
import { Sheet } from './Sheet';
import { Segmented } from './Segmented';
import { Menu, type MenuItem, type MenuLink } from './Menu';
import { PageHeader } from './PageHeader';
import type { Report, ReportCategory } from '@/lib/report/build';
import { EARLIEST_REPORT_DAY, isTimeZone, resolvePeriod, type ReportRequest } from '@/lib/report/period';
import { categoryKey, REPORT_SETTINGS_LIMITS } from '@/lib/report/settings';
import { localDate } from '@/lib/local-date';
import { formatInstantDay, onDay } from '@/lib/format';
import { HideAmountsToggle, useFiguresWhenPrinted } from './HideAmounts';
import { useAmountsHidden } from './hide-amounts';
import { ReportSkeleton } from './LoadingSkeletons';
import { Notice } from './TotalCaveats';
import FieldError from './FieldError';

/** The accountant's report's ⋯: its CSV, a file to save (disabled until a
 *  report is on screen), marking categories, and the accounts you stopped
 *  tracking when there are any. */
export function accountantMenu(
  report: Report | null,
  loading: boolean,
  stoppedCount: number,
  setMarking: (open: boolean) => void,
  setStoppedOpen: (open: boolean) => void
): (MenuItem | MenuLink)[] {
  const ready = !!report && !loading;
  const items: (MenuItem | MenuLink)[] = [
    report && !loading
      ? { label: 'Download as CSV', href: `/api/reports?${csvQuery(report)}`, download: true }
      : { label: 'Download as CSV', onSelect: () => {}, disabled: true },
    { label: 'Mark categories', onSelect: () => setMarking(true), disabled: !ready },
  ];
  if (stoppedCount > 0) items.push({ label: `Accounts you stopped tracking (${stoppedCount})`, onSelect: () => setStoppedOpen(true) });
  return items;
}

/** What the form holds. */
export type ReportForm = { kind: 'year' | 'range'; year: number; start: string; end: string; currency: string | null };

/** The browser's time zone, or UTC where it doesn't say one the report takes. */
function browserZone(): string {
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return isTimeZone(tz) ? tz : 'UTC';
}

/** The reports the page offers, as the address names them. */
export type ReportChoice = 'accountant' | 'runway' | 'year-over-year';
/** Which report shows: tabs over the one panel the report is drawn in. */
const reportTabId = (c: ReportChoice) => `report-tab-${c}`;
const REPORT_PANEL = 'report-panel';

const CHOICES: { choice: ReportChoice; label: string }[] = [
  // Short, so the three fit one line at 320px (measured: "Year over year"
  // wraps there): the accountant's report covers a tax year or any dates,
  // and Yearly compares this year with last.
  { choice: 'accountant', label: 'Accountant' },
  { choice: 'runway', label: 'Runway' },
  { choice: 'year-over-year', label: 'Yearly' },
];

/** The report the address asks for (`?report=`), else the accountant's. */
export function reportChoice(search: string): ReportChoice {
  const r = new URLSearchParams(search).get('report');
  return r === 'runway' || r === 'year-over-year' ? r : 'accountant';
}

/** Whether the address asks for the accounts you stopped tracking
 *  (`?stopped`, the link from where accounts are let go). */
export function asksStopped(search: string): boolean {
  return new URLSearchParams(search).has('stopped');
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

/** The CSV of the report on screen, from its own period, currency and time
 *  zone: never from a form changed since it was made. */
export function csvQuery(report: Pick<Report, 'period' | 'currency'>): string {
  const { period } = report;
  const form: ReportForm = { kind: period.kind, year: Number(period.start.slice(0, 4)), start: period.start, end: period.end, currency: report.currency };
  return reportQuery(form, period.time_zone, 'csv');
}

export default function ReportsPage() {
  // On screen the report follows the switch to hide amounts
  // (components/hide-amounts.ts), drawn again when it changes; printed, it
  // has its figures, since printing a report is a deliberate act.
  useAmountsHidden();
  useFiguresWhenPrinted();
  const [form, setForm] = useState<ReportForm | null>(null);
  const [zone, setZone] = useState('UTC');
  const [today, setToday] = useState('');
  const [report, setReport] = useState<Report | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [marking, setMarking] = useState(false);
  const [stopped, setStopped] = useState<StoppedList | null>(null);
  const [stoppedOpen, setStoppedOpen] = useState(false);
  const [forgetting, setForgetting] = useState(false);
  const [stoppedError, setStoppedError] = useState<string | null>(null);
  const [which, setWhich] = useState<ReportChoice | null>(null);
  // Only the latest request's answer is shown: one asked for earlier may come back later.
  const latest = useRef(0);

  /** The accounts you stopped tracking, as stored: none shown when they can't
   *  be listed. `open`: shown at once, when there are any (asked for by the
   *  address). */
  const loadStopped = useCallback(async (open = false) => {
    try {
      const res = await fetch('/api/connectors/ended');
      const body = await res.json().catch(() => null);
      const list = res.ok && body && Array.isArray(body.accounts) ? (body as StoppedList) : null;
      setStopped(list);
      if (open && list && list.accounts.length + list.unreadable.length > 0) setStoppedOpen(true);
    } catch {
      setStopped(null);
    }
  }, []);

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
      if (n !== latest.current) return;
      // Never the last report under the new period's controls.
      setReport(null);
      setError('The report couldn’t be made. Check your connection and try again.');
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
    // Read before load() rewrites the address to the form's.
    const opening = asksStopped(window.location.search);
    const choice = reportChoice(window.location.search);
    setZone(tz);
    setToday(day);
    setForm(f);
    setWhich(choice);
    if (choice === 'accountant') void load(f, tz);
    void loadStopped(opening);
  }, [load, loadStopped]);

  const choose = (next: ReportChoice) => {
    setWhich(next);
    if (next !== 'accountant') window.history.replaceState(null, '', `/reports?report=${next}`);
    else if (form && !report) void load(form, zone);
    else if (form) window.history.replaceState(null, '', `/reports?${reportQuery(form)}`);
  };

  const forget = async (id: string, label: string) => {
    const sure = window.confirm(
      `Forget ${label}? Reports will no longer say what may be missing because you stopped tracking it. Its past balances stay in your net-worth history.`
    );
    if (!sure) return;
    setForgetting(true);
    setStoppedError(null);
    try {
      const res = await fetch('/api/connectors/ended', { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ account_id: id }) });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) setStoppedError(typeof body.error === 'string' ? body.error : 'It couldn’t be forgotten.');
      else {
        await loadStopped();
        if (form) void load(form, zone);
      }
    } catch {
      setStoppedError('It couldn’t be forgotten. Check your connection and try again.');
    } finally {
      setForgetting(false);
    }
  };
  const stoppedCount = stopped ? stopped.accounts.length + stopped.unreadable.length : 0;

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
      <div className="no-print">
        {/* Back to Activity, where Reports is opened from (lib/dashboard-tab.ts). */}
        <PageHeader back="/?tab=activity" end={<HideAmountsToggle />} />
      </div>
      <div className="no-print">
        <h1>Reports</h1>
        <p className="sub">
          A summary of a tax year, or of any dates, for your accountant; how long your cash would last; and this year against last. Each says what it may be
          missing. Print one, or save it as a PDF.
        </p>
        {which && (
          <Segmented
            className="report-choice"
            label="Which report"
            value={which}
            onChange={choose}
            options={CHOICES.map((c) => [c.choice, c.label] as const)}
            tabs={{ id: reportTabId, panel: REPORT_PANEL }}
          />
        )}
      </div>

      {/* The report the tabs above show; a panel once they are there. */}
      <div id={REPORT_PANEL} role={which ? 'tabpanel' : undefined} aria-labelledby={which ? reportTabId(which) : undefined}>
        {which === 'runway' && <RunwayReport />}
        {which === 'year-over-year' && <YearOverYearReport />}

        {form && which === 'accountant' && (
          <div className="card no-print report-controls">
            <Segmented
              className="report-kind"
              label="Kind of report"
              value={form.kind}
              onChange={(kind) => make({ kind, currency: null })}
              options={[
                ['year', 'Tax year'],
                ['range', 'Date range'],
              ]}
            />
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
                {/* Tonal: Print is the one filled button in this card. */}
                <button className="btn secondary btn-block" onClick={() => make({ currency: null })} disabled={loading}>
                  Make report
                </button>
              </div>
            )}
            {report && (report.currencies.length > 1 || (!!report.home && report.currencies.some((c) => c.currency !== report.home))) && (
              <label className="field">
                Currency
                <select value={form.currency ?? report.currency ?? ''} onChange={(e) => make({ currency: e.target.value })}>
                  {/* With a home currency: it first, then the period's, any of
                      them converted into (lib/report/build.ts). */}
                  {report.home && !report.currencies.some((c) => c.currency === report.home) && (
                    <option value={report.home}>{report.home} (your home currency)</option>
                  )}
                  {report.currencies.map((c) => (
                    <option key={c.currency} value={c.currency}>
                      {c.currency} ({c.transactions} transaction{c.transactions === 1 ? '' : 's'}){c.currency === report.home ? ', your home currency' : ''}
                    </option>
                  ))}
                </select>
              </label>
            )}
            {error && (
              <Notice level="critical" role="alert">
                {error}
              </Notice>
            )}
            {/* Print is the one button; the rest are under the report's ⋯
                (the CSV as a link to save, so it needs no script). */}
            <div className="btn-row report-actions">
              <Menu label="More for this report" items={accountantMenu(report, loading, stoppedCount, setMarking, setStoppedOpen)} />
              <button className="btn" onClick={() => window.print()} disabled={!report || loading}>
                Print or save as PDF
              </button>
            </div>
            <p className="panel-note">
              To save a PDF, choose Save as PDF in the print window. Days and times are read in {zone}. The report reads what Nya has stored, so open Nya first to
              bring your connections up to date.
            </p>
          </div>
        )}

        {which === 'accountant' && loading && !report && <ReportSkeleton title={null} status="Making the report" />}
        {which === 'accountant' && report && (
          <div className={loading ? 'report-loading' : undefined} aria-busy={loading}>
            <ReportView report={report} />
          </div>
        )}
      </div>

      {stopped && (
        <Sheet open={stoppedOpen} title="Accounts you stopped tracking" onClose={() => setStoppedOpen(false)}>
          <StoppedAccountsView list={stopped} busy={forgetting} error={stoppedError} onForget={(id, label) => void forget(id, label)} />
        </Sheet>
      )}

      {report && (
        <Sheet open={marking} title="Categories for taxes" onClose={() => setMarking(false)}>
          <MarkCategories
            categories={report.categories}
            marked={report.marked?.categories.map((c) => c.key) ?? []}
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

/** The accounts a SimpleFIN or Lunch Flow connection fed that you let go, as
 *  app/api/connectors/ended lists them. */
export type StoppedList = {
  accounts: { account_id: string; name: string; institution_name: string; connector: string; ended_at: string; kept: boolean }[];
  /** Records that can't be read, by id: they can be forgotten. */
  unreadable: string[];
  /** Records a newer version of Nya saved, counted: never offered. */
  unrecognised: number;
};

/** "Sep 3", "today": the local day an instant fell on, mid sentence. */
const shownDay = (iso: string) => formatInstantDay(iso, { sentence: true }) ?? iso;

/** The records of accounts you stopped tracking, each with Forget. */
export function StoppedAccountsView({
  list,
  busy,
  error,
  onForget,
}: {
  list: StoppedList;
  busy: boolean;
  error: string | null;
  onForget: (account_id: string, label: string) => void;
}) {
  return (
    <div className="sheet-form">
      <p className="panel-note">
        Accounts SimpleFIN or Lunch Flow kept up to date that you stopped tracking or disconnected. Nya keeps each one’s name, its bank and when, so a report on a period
        it was tracked in can say what may be missing. Forget one and reports no longer mention it; its past balances stay in your net-worth history.
      </p>
      {list.accounts.map((a) => (
        <div key={a.account_id} className="peer-row">
          <span>
            {a.institution_name} {a.name}
            <span className="type-tag" style={{ display: 'block' }}>
              {a.kept ? 'Kept as a manual account' : 'Deleted'} {onDay(shownDay(a.ended_at))}, through {a.connector}
            </span>
          </span>
          <button className="link-btn danger-link" disabled={busy} onClick={() => onForget(a.account_id, `${a.institution_name} ${a.name}`)}>
            Forget
          </button>
        </div>
      ))}
      {list.unreadable.map((id) => (
        <div key={id} className="peer-row">
          <span>A record that can’t be read</span>
          <button className="link-btn danger-link" disabled={busy} onClick={() => onForget(id, 'this record that can’t be read')}>
            Forget
          </button>
        </div>
      ))}
      {list.unrecognised > 0 && (
        <p className="panel-note">
          {list.unrecognised === 1 ? 'One more was' : `${list.unrecognised} more were`} saved by a newer version of Nya, so {list.unrecognised === 1 ? 'it' : 'they'}{' '}
          can’t be shown or forgotten here.
        </p>
      )}
      {error && (
        <Notice level="critical" role="alert">
          {error}
        </Notice>
      )}
    </div>
  );
}

/** The sheet that marks categories: every category in the report's period,
 *  and every one already marked, by name. A mark is saved as the category's
 *  words (its `key`, which a rename never changes), the list whole
 *  (app/api/report-settings). */
export function MarkCategories({
  categories,
  marked,
  unreadable,
  onSaved,
}: {
  categories: ReportCategory[];
  /** The keys marked now. */
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
  categories: ReportCategory[];
  /** The keys chosen. */
  chosen: string[];
  unreadable: boolean;
  saving: boolean;
  error: string | null;
  onToggle: (category: string) => void;
  onSave: () => void;
}) {
  const overId = useId();
  if (unreadable) {
    return (
      <Notice level="critical" role="alert">
        The categories you marked before couldn’t be read, so they can’t be changed here: saving now would replace them. Nothing has been lost; this needs
        fixing on the server.
      </Notice>
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
        <fieldset className="report-marks" disabled={saving} aria-label="Categories" aria-invalid={over} aria-describedby={over ? overId : undefined}>
          {categories.map((c) => (
            <label key={c.key} className="report-mark">
              <input type="checkbox" checked={chosen.includes(c.key)} onChange={() => onToggle(c.key)} />
              <span>{c.name}</span>
            </label>
          ))}
        </fieldset>
      )}
      {over && <FieldError id={overId}>At most {REPORT_SETTINGS_LIMITS.marked} categories can be marked.</FieldError>}
      {error && (
        <Notice level="critical" role="alert">
          {error}
        </Notice>
      )}
      <button onClick={onSave} disabled={saving || over}>
        {saving ? 'Saving…' : 'Save'}
      </button>
    </div>
  );
}
