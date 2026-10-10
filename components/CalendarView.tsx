'use client';

// The calendar on the Budgets tab (lib/calendar.ts): a month a page, each day
// with a figure and a dot for each kind of thing on it. Days gone by show what
// posted, as the Activity tab counts each day; from today on, the bills and
// income expected, the items planned, and the card and loan payments Plaid
// says are due. Tap a day for its list. The two figures are never added
// together: one is the bank's record, the other an estimate, and the expected
// one counts what the forecast counts (a card's own charges are listed, not
// added). A cell's figure is in whole units, a thousand and up shortened, so
// it fits a phone's narrow column; the day's list has the cents.

import { useMemo, useState } from 'react';
import type { Txn } from './MonthBreakdown';
import { addMonths, calendarMonth, duePayments, type CalendarEntry } from '@/lib/calendar';
import { cadenceLabel, type Cadence, type RecurringSeries } from '@/lib/recurring';
import { plannedCadenceLabel, type PlannedCadence, type PlannedItem } from '@/lib/planned';
import { compactMoney, formatMoney, signedMoney } from '@/lib/format';
import type { ForecastInstitution } from '@/lib/forecast';

const WEEKDAYS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
/** How far the calendar goes either way, in months: back over the year of
 *  transactions loaded, ahead as far as anyone plans. */
const MONTHS_BACK = 12;
const MONTHS_AHEAD = 12;

/** "+$1.2K", "-$143": a day's figure in a cell, in whole units (the day's
 *  list has the cents), a thousand and up shortened. */
function cellFigure(n: number, currency: string | null): string {
  const abs = Math.abs(n);
  const sign = Math.round(abs) === 0 ? '' : n < 0 ? '-' : '+';
  if (abs >= 1000) return `${sign}${compactMoney(abs, currency)}`;
  if (currency) {
    try {
      return `${sign}${new Intl.NumberFormat(undefined, { style: 'currency', currency, maximumFractionDigits: 0, minimumFractionDigits: 0 }).format(Math.round(abs))}`;
    } catch {
      return `${sign}${Math.round(abs)} ${currency}`;
    }
  }
  return `${sign}$${Math.round(abs)}`;
}

/** Why an expected amount isn't in its day's figure (lib/calendar.ts). */
function offText(e: CalendarEntry): string | null {
  switch (e.off) {
    case 'currency':
      return `in ${e.currency}, not in the day's figure`;
    case 'not-cash':
      return e.accountType === 'credit'
        ? `on ${e.account ? `the ${e.account} card` : 'a card'}, not in the day's figure: the card's payment is what leaves cash`
        : `on ${e.account || 'an account'}, not a cash account, not in the day's figure`;
    case 'unknown-account':
      return "on an account of unknown type, not in the day's figure";
    case 'varies':
      return "its amount varies, not in the day's figure";
    default:
      return null;
  }
}

function monthTitle(month: string): string {
  return new Date(`${month}-01T00:00:00`).toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
}

function dayTitle(iso: string): string {
  return new Date(`${iso}T00:00:00`).toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
}

function fmtDay(iso: string): string {
  return new Date(`${iso}T00:00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function cadenceText(c: Cadence | PlannedCadence | undefined, source: CalendarEntry['source']): string {
  if (!c) return '';
  if (source === 'planned') return plannedCadenceLabel(c as PlannedCadence);
  return cadenceLabel(c as Cadence);
}

/** What a dot on a day stands for. */
function dotsOf(entries: CalendarEntry[]): string[] {
  const kinds = new Set<string>();
  for (const e of entries) {
    if (e.kind === 'due') kinds.add('due');
    else if (e.kind === 'expected') kinds.add(e.source === 'planned' ? 'planned' : e.source === 'income' ? 'income' : 'bill');
  }
  return ['income', 'bill', 'planned', 'due'].filter((k) => kinds.has(k));
}

const NO_TXNS: Txn[] = [];

export default function CalendarView({
  txns,
  failed = false,
  series,
  planned,
  dismissed,
  institutions,
  today,
  currency,
}: {
  /** Null while transactions load, or when they couldn't be (`failed`). */
  txns: Txn[] | null;
  failed?: boolean;
  series: RecurringSeries[];
  planned: PlannedItem[];
  /** The series the person said aren't recurring (lib/recurring.ts
   *  dismissedSeries). */
  dismissed: ReadonlySet<string>;
  /** For the payments due on cards and loans. */
  institutions: ForecastInstitution[];
  /** The viewer's day (lib/local-date.ts). */
  today: string;
  /** The day figures' currency: the totals'. */
  currency: string | null;
}) {
  const thisMonth = today.slice(0, 7);
  const [month, setMonth] = useState(thisMonth);
  const [selected, setSelected] = useState<string | null>(today);

  const dues = useMemo(() => duePayments(institutions), [institutions]);
  const view = useMemo(
    () => calendarMonth({ month, today, txns: txns ?? NO_TXNS, series, planned, dismissed, dues, currency }),
    [month, today, txns, series, planned, dismissed, dues, currency]
  );
  // Days gone by can't say what posted until transactions are in.
  const unknownPast = txns === null;
  const pastNote = failed ? "Transactions couldn't be loaded, so what posted isn't shown." : 'Transactions are still loading.';

  const first = addMonths(thisMonth, -MONTHS_BACK);
  const last = addMonths(thisMonth, MONTHS_AHEAD);
  const go = (n: number) => {
    const next = addMonths(month, n);
    if (next < first || next > last) return;
    setMonth(next);
    setSelected(next === thisMonth ? today : null);
  };

  const day = selected && selected.startsWith(month) ? view.days.get(selected) : undefined;
  const posted = day?.entries.filter((e) => e.kind === 'posted') ?? [];
  const expected = day?.entries.filter((e) => e.kind === 'expected') ?? [];
  const due = day?.entries.filter((e) => e.kind === 'due') ?? [];

  const amountOf = (e: CalendarEntry) => (e.amount === null ? '' : signedMoney(e.amount, e.currency ?? currency));
  // Why a posted row is quieter: pending, excluded, or in another currency,
  // and so not in the day's figure.
  const postedTags = (e: CalendarEntry) =>
    [
      e.pending ? 'pending' : null,
      e.excluded ? "excluded, not in the day's figure" : null,
      !e.excluded && e.uncounted && e.currency ? `in ${e.currency}, not in the day's figure` : null,
    ]
      .filter(Boolean)
      .join(' · ');

  return (
    <div className="card">
      <div className="inst-header">
        <div className="inst-name">Calendar</div>
        {month !== thisMonth && (
          <button
            className="link-btn"
            onClick={() => {
              setMonth(thisMonth);
              setSelected(today);
            }}
          >
            Today
          </button>
        )}
      </div>

      <div className="cal-head">
        <button className="cal-nav" onClick={() => go(-1)} disabled={month <= first} aria-label="Previous month">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="m15 18-6-6 6-6" />
          </svg>
        </button>
        <div className="cal-title" aria-live="polite">
          {monthTitle(month)}
        </div>
        <button className="cal-nav" onClick={() => go(1)} disabled={month >= last} aria-label="Next month">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="m9 18 6-6-6-6" />
          </svg>
        </button>
      </div>

      <div className="cal-grid">
        {WEEKDAYS.map((w, i) => (
          <div className="cal-dow" key={i} title={WEEKDAY_NAMES[i]} aria-hidden="true">
            {w}
          </div>
        ))}
        {view.weeks.flat().map((date, i) => {
          if (!date) return <div className="cal-pad" key={`pad-${i}`} />;
          const d = view.days.get(date)!;
          const past = date < today;
          const figure = past ? d.posted : date === today ? (d.posted ?? d.expected) : d.expected;
          const estimated = !past && !(date === today && d.posted !== null);
          const dots = dotsOf(d.entries);
          const label = [
            dayTitle(date),
            d.posted !== null ? `posted ${signedMoney(d.posted, currency)}` : null,
            d.expected !== null ? `expected ${signedMoney(d.expected, currency)}` : null,
            dots.length > 0 && d.expected === null ? 'something expected' : null,
          ]
            .filter(Boolean)
            .join(', ');
          return (
            <button
              key={date}
              className={`cal-day${date === today ? ' today' : ''}${date === selected ? ' selected' : ''}${past ? ' past' : ''}`}
              onClick={() => setSelected(date)}
              aria-pressed={date === selected}
              aria-label={label}
            >
              <span className="cal-num">{Number(date.slice(8))}</span>
              <span className={`cal-fig${figure === null ? '' : figure > 0 ? ' in' : figure < 0 ? ' out' : ''}${estimated ? ' estimated' : ''}`}>
                {figure === null ? '' : cellFigure(figure, currency)}
              </span>
              <span className="cal-dots" aria-hidden="true">
                {dots.map((k) => (
                  <span key={k} className={`cal-dot ${k}`} />
                ))}
              </span>
            </button>
          );
        })}
      </div>

      {unknownPast && month <= thisMonth && <p className={failed ? 'error' : 'stale-note'}>{pastNote}</p>}

      <div className="cal-legend" aria-hidden="true">
        <span>
          <span className="cal-dot income" /> Income
        </span>
        <span>
          <span className="cal-dot bill" /> Bill
        </span>
        <span>
          <span className="cal-dot planned" /> Planned
        </span>
        <span>
          <span className="cal-dot due" /> Payment due
        </span>
      </div>

      {day && (
        <div className="cal-detail">
          <div className="inst-header">
            <div className="inst-name">{dayTitle(day.date)}</div>
          </div>
          {day.entries.length === 0 && (
            <p className="empty-note">{day.date < today ? (unknownPast ? pastNote : 'Nothing posted.') : 'Nothing expected.'}</p>
          )}
          {day.entries.length > 0 && day.date <= today && unknownPast && <p className="empty-note">{pastNote}</p>}
          {posted.length > 0 && (
            <>
              <div className="recurring-section">
                Posted{day.posted !== null && <span> · {signedMoney(day.posted, currency)}</span>}
              </div>
              <table>
                <tbody>
                  {posted.map((e) => (
                    <tr key={`p-${e.ref}`} className={e.uncounted ? 'cal-uncounted' : undefined}>
                      <td>
                        {e.name}
                        {postedTags(e) && <div className="type-tag">{postedTags(e)}</div>}
                      </td>
                      <td className={`num${(e.amount ?? 0) > 0 ? ' inflow' : ''}`}>{amountOf(e)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}
          {expected.length > 0 && (
            <>
              <div className="recurring-section">
                Expected{day.expected !== null && <span> · {signedMoney(day.expected, currency)}</span>}
              </div>
              <table>
                <tbody>
                  {expected.map((e) => (
                    <tr key={`e-${e.ref}`} className={e.uncounted ? 'cal-uncounted' : undefined}>
                      <td>
                        {e.name}
                        <div className="type-tag">
                          {e.source === 'planned' ? 'planned' : e.source === 'income' ? 'income' : 'bill'} · {cadenceText(e.cadence, e.source)}
                          {e.late && e.due ? ` · due ${fmtDay(e.due)}, not in yet` : ''}
                          {offText(e) ? ` · ${offText(e)}` : ''}
                        </div>
                      </td>
                      <td className={`num${(e.amount ?? 0) > 0 ? ' inflow' : ''}`}>{amountOf(e)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}
          {due.length > 0 && (
            <>
              <div className="recurring-section">Payment due</div>
              <table>
                <tbody>
                  {due.map((e) => (
                    <tr key={`d-${e.ref}`} className="cal-uncounted">
                      <td>
                        {e.name}
                        <div className="type-tag">{e.amount === null ? 'due, minimum not reported' : 'minimum due, not in the figures'}</div>
                      </td>
                      <td className="num">{e.amount === null ? '' : formatMoney(Math.abs(e.amount), e.currency ?? currency)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}
        </div>
      )}

      <div className="chart-note">
        Days gone by show what posted. From today, what is expected to leave or reach your checking and savings, an estimate, as the
        forecast counts it; a card&apos;s own charges and the payments due on cards and loans are listed, not added.
      </div>
    </div>
  );
}
