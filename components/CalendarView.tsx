'use client';

// The calendar on Budgets > Upcoming (lib/calendar.ts), the List · Calendar
// control's second view: a month a page, each day with a figure and a dot
// for each kind of thing on it. Days gone by show what posted, as the
// Activity tab counts each day; from today on, the bills and income
// expected, the items planned, and the card and loan payments Plaid says are
// due. Tap a day for its list, rows under a bar for what posted, what is
// expected and what is due, as Activity lists a day (rollout phase 6a3).
// The two figures are never added together: one is the bank's record, the
// other an estimate, and the expected one counts what the forecast counts (a
// card's own charges are listed, not added). A cell's figure is its sign and
// whole units, from a thousand two figures and K, M, B or T ("+3.5K"), with
// no currency: the legend names it once, as a 320px phone's column has no
// room for it at 12px. The day's list has the cents. Its tab names it, so it
// has no heading of its own; the month's arrows stay focusable at either end
// (aria-disabled), as Activity's do.

import { useEffect, useMemo, useRef, useState } from 'react';
import type { Txn } from './MonthBreakdown';
import { addMonths, calendarMonth, duePayments, type CalendarEntry } from '@/lib/calendar';
import { cadenceLabel, type Cadence, type RecurringSeries } from '@/lib/recurring';
import { plannedCadenceLabel, type PlannedCadence, type PlannedItem } from '@/lib/planned';
import { amountsHidden, formatMoney, MASK, signedMoney, spoken } from '@/lib/format';
import type { ForecastInstitution } from '@/lib/forecast';
import { Masked } from './HideAmounts';
import { Notice } from './TotalCaveats';
import MonthStepper from './MonthStepper';
import { NoticeBadge, type UpcomingBadge } from './upcoming-notes';
import type { FxTable } from '@/lib/fx/rates';
import { shownName } from '@/lib/merchant-name';

const WEEKDAYS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
/** How far the calendar goes either way, in months: back over the year of
 *  transactions loaded, ahead as far as anyone plans. */
const MONTHS_BACK = 12;
const MONTHS_AHEAD = 12;

/** What a cell's figure from a thousand ends in: the app's words, English
 *  as the rest of it is. */
const SUFFIXES = ['K', 'M', 'B', 'T'];

/** "+3.5K", "-143": a day's figure in a cell, its sign and whole units (the
 *  day's list has the cents), from a thousand two significant figures and K,
 *  M, B or T, never a currency (the legend names it once). The digits and
 *  the decimal sign are the viewer's ("3,5K" in German). Not Intl's compact
 *  notation: in other languages it writes a thousand in full or as a word
 *  ("13.000", "13 mil"), too wide for the cell. */
function cellFigure(n: number): string {
  // Hidden amounts (lib/format.ts): the sign and the mask, never a size. The
  // sign is the amount's own, not its rounded figure's: a figure under 0.5
  // drawn with none would say how small it is.
  if (amountsHidden()) return `${n > 0 ? '+' : n < 0 ? '-' : ''}${MASK}`;
  const r = Math.round(Math.abs(n));
  const sign = r === 0 ? '' : n < 0 ? '-' : '+';
  if (r < 1000) return `${sign}${new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 }).format(r)}`;
  // The suffix is chosen after rounding: at two figures 995 and up is a
  // thousand, so 999,999 is "1M", never "1000K". Past T the figure grows.
  let tier = 0;
  while (tier < SUFFIXES.length - 1 && r >= 995 * 1000 ** (tier + 1)) tier++;
  // Carried up, it is 0.995 or more of the next suffix: 1, as two figures
  // round it, not left to how an engine rounds 0.995's binary form ("0.99").
  const figures = new Intl.NumberFormat(undefined, { maximumSignificantDigits: 2, useGrouping: false }).format(Math.max(1, r / 1000 ** (tier + 1)));
  return `${sign}${figures}${SUFFIXES[tier]}`;
}

/** "the Sapphire card", or "the Plaid Credit Card" for a name that already
 *  says it is one: never "the Plaid Credit Card card". */
const theCard = (name: string) => (/\bcard$/i.test(name.trim()) ? `the ${name.trim()}` : `the ${name} card`);

/** A row's line of parts, "Bill · Monthly · Due Oct 15, not in yet": each
 *  part starts with a capital, as a label of its own, whatever wrote it. */
export function metaLine(parts: readonly (string | null | false | undefined)[]): string {
  return parts
    .filter((p): p is string => !!p)
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
    .join(' · ');
}

/** Why an expected amount isn't in its day's figure (lib/calendar.ts). */
function offText(e: CalendarEntry): string | null {
  switch (e.off) {
    case 'currency':
      return `in ${e.currency}, not in the day's figure`;
    case 'not-cash':
      return e.accountType === 'credit'
        ? `on ${e.account ? theCard(e.account) : 'a card'}, not in the day's figure: the card's payment is what leaves cash`
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

/** Why a posted row is quieter: pending, excluded, or in another currency,
 *  and so not in the day's figure. */
function postedTags(e: CalendarEntry, currency: string | null): string {
  return metaLine([
    e.pending ? 'pending' : null,
    // One charge, split (#39): what of it the day's figure counts when a part is left out.
    e.parts ? `split into ${e.parts}` : null,
    e.counted !== undefined ? `${signedMoney(e.counted, e.currency ?? currency)} of it in the day's figure` : null,
    // In another currency, converted (with a home currency).
    e.figure !== undefined ? `${signedMoney(e.figure, currency)} in the day's figure` : null,
    // Counted through its group, on the group's earlier day (#39).
    e.group
      ? `in the group “${e.group.name}”, counted on ${new Date(`${e.group.date}T00:00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}, not in the day's figure`
      : null,
    e.excluded ? "excluded, not in the day's figure" : null,
    !e.excluded && e.uncounted && e.currency ? `in ${e.currency}, not in the day's figure` : null,
  ]);
}

/** An expected entry's words: what it is and how often, then that it is
 *  late, why it isn't in the day's figure, or what it counts as there. */
function ExpectedWords({ e, currency }: { e: CalendarEntry; currency: string | null }) {
  return (
    <>
      {metaLine([
        e.source === 'planned' ? 'planned' : e.source === 'income' ? 'income' : 'bill',
        cadenceText(e.cadence, e.source),
        e.late && e.due ? `due ${fmtDay(e.due)}, not in yet` : null,
        offText(e),
      ])}
      {e.figure !== undefined ? <Masked>{` · ${metaLine([`${signedMoney(e.figure, currency)} in the day's figure, at today's rates`])}`}</Masked> : ''}
    </>
  );
}

/** One entry of a day's list, as a row that opens nothing: its name, the
 *  calendar's words for it, and its amount, quieter when it isn't in the
 *  day's figure. Upcoming's list (components/UpcomingList.tsx) draws the
 *  same rows, with a Due badge on a payment due, which has no "Payment due"
 *  bar over it there. */
export function EntryRow({ entry: e, currency, badgeDue = false }: { entry: CalendarEntry; currency: string | null; badgeDue?: boolean }) {
  // A payment due is its minimum's size: what is owed, not money moving yet.
  const amount = e.amount === null ? '' : e.kind === 'due' ? formatMoney(Math.abs(e.amount), e.currency ?? currency) : signedMoney(e.amount, e.currency ?? currency);
  const tags = e.kind === 'posted' ? postedTags(e, currency) : '';
  return (
    <li>
      <div className="list-row upcoming-row">
        <span className="list-row-text">
          <span className="list-row-title">{shownName(e)}</span>
          {e.kind === 'expected' && (
            <span className="list-row-sub">
              <span>
                <ExpectedWords e={e} currency={currency} />
              </span>
            </span>
          )}
          {e.kind === 'due' && (
            <span className="list-row-sub">
              {badgeDue && <span className="badge warn">Due</span>}
              <span>{e.amount === null ? 'Due, minimum not reported' : 'Minimum due, not in the figures'}</span>
            </span>
          )}
          {tags !== '' && (
            <span className="list-row-sub">
              <span>
                <Masked>{tags}</Masked>
              </span>
            </span>
          )}
        </span>
        {e.amount !== null && (
          <span className={`list-row-value upcoming-amount${e.amount > 0 ? ' inflow' : ''}${e.uncounted ? ' uncounted' : ''}`}>
            <Masked>{amount}</Masked>
          </span>
        )}
      </div>
    </li>
  );
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
  fx = null,
  badge = null,
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
  /** With a home currency, what converts an entry in another currency into
   *  the day figures' (lib/calendar.ts). */
  fx?: FxTable | null;
  /** What Upcoming's notice says may leave entries out of it, as a badge at
   *  its top (components/upcoming-notes.tsx). */
  badge?: UpcomingBadge;
}) {
  const thisMonth = today.slice(0, 7);
  const [month, setMonth] = useState(thisMonth);
  const [selected, setSelected] = useState<string | null>(today);
  // This month goes once pressed: focus moves to today's cell, where it took
  // you, rather than to nothing.
  const todayCell = useRef<HTMLButtonElement | null>(null);
  const toToday = useRef(false);
  useEffect(() => {
    if (!toToday.current) return;
    toToday.current = false;
    todayCell.current?.focus();
  }, [month]);

  const dues = useMemo(() => duePayments(institutions), [institutions]);
  const view = useMemo(
    () => calendarMonth({ month, today, txns: txns ?? NO_TXNS, series, planned, dismissed, dues, currency, fx }),
    [month, today, txns, series, planned, dismissed, dues, currency, fx]
  );
  // Days gone by can't say what posted until transactions are in.
  const unknownPast = txns === null;
  const pastNote = failed ? "Transactions couldn't be loaded, so what posted isn't shown." : 'Transactions are still loading.';

  // Its months, newest first: a few back, a few ahead.
  const months = useMemo(
    () => Array.from({ length: MONTHS_BACK + MONTHS_AHEAD + 1 }, (_, i) => addMonths(thisMonth, MONTHS_AHEAD - i)),
    [thisMonth]
  );
  const go = (next: string) => {
    setMonth(next);
    setSelected(next === thisMonth ? today : null);
  };

  const day = selected && selected.startsWith(month) ? view.days.get(selected) : undefined;
  const posted = day?.entries.filter((e) => e.kind === 'posted') ?? [];
  const expected = day?.entries.filter((e) => e.kind === 'expected') ?? [];
  const due = day?.entries.filter((e) => e.kind === 'due') ?? [];

  return (
    <div className="card stack">
      {badge && <NoticeBadge tone={badge} />}

      {/* Its own month, not the tabs': it runs ahead into months to come.
          Its list is named apart from Budgets' bar, which is on the page too. */}
      <MonthStepper
        month={month}
        months={months}
        label={monthTitle}
        optionLabel={(m) => (m === thisMonth ? `${monthTitle(m)} (this month)` : monthTitle(m))}
        onMonth={go}
        heading="span"
        listLabel="Calendar month"
        back={
          month !== thisMonth
            ? {
                label: 'This month',
                onBack: () => {
                  toToday.current = true;
                  setMonth(thisMonth);
                  setSelected(today);
                },
              }
            : null
        }
      />

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
              ref={date === today ? todayCell : undefined}
              className={`cal-day${date === today ? ' today' : ''}${date === selected ? ' selected' : ''}${past ? ' past' : ''}`}
              onClick={() => setSelected(date)}
              aria-pressed={date === selected}
              aria-label={spoken(label)}
            >
              <span className="cal-num">{Number(date.slice(8))}</span>
              <span className={`cal-fig${figure === null ? '' : figure > 0 ? ' in' : figure < 0 ? ' out' : ''}${estimated ? ' estimated' : ''}`}>
                <Masked>{figure === null ? '' : cellFigure(figure)}</Masked>
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

      {unknownPast && month <= thisMonth && <Notice level={failed ? 'critical' : 'caution'}>{pastNote}</Notice>}

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
        <span className="cal-legend-note">{currency ? `Day figures in ${currency}, rounded` : 'Day figures rounded'}</span>
      </div>

      {day && (
        <div className="cal-detail stack tight">
          <div className="card-header">
            <h3>{dayTitle(day.date)}</h3>
          </div>
          {day.entries.length === 0 && (
            <p className="empty-note">{day.date < today ? (unknownPast ? pastNote : 'Nothing posted.') : 'Nothing expected.'}</p>
          )}
          {day.entries.length > 0 && day.date <= today && unknownPast && <p className="empty-note">{pastNote}</p>}
          {day.entries.length > 0 && (
            <ul className="list-rows">
              {posted.length > 0 && (
                <li className="txn-day">
                  <span>
                    Posted{day.posted !== null && <> · <Masked>{signedMoney(day.posted, currency)}</Masked></>}
                  </span>
                </li>
              )}
              {posted.map((e) => (
                <EntryRow key={`p-${e.ref}`} entry={e} currency={currency} />
              ))}
              {expected.length > 0 && (
                <li className="txn-day">
                  <span>
                    Expected{day.expected !== null && <> · <Masked>{signedMoney(day.expected, currency)}</Masked></>}
                  </span>
                </li>
              )}
              {expected.map((e) => (
                <EntryRow key={`e-${e.ref}`} entry={e} currency={currency} />
              ))}
              {due.length > 0 && (
                <li className="txn-day">
                  <span>Payment due</span>
                </li>
              )}
              {due.map((e) => (
                <EntryRow key={`d-${e.ref}`} entry={e} currency={currency} />
              ))}
            </ul>
          )}
        </div>
      )}

      <p className="helper">
        Days gone by show what posted. From today, what is expected to leave or reach your checking and savings, an estimate, as the
        forecast counts it; a card&apos;s own charges and the payments due on cards and loans are listed, not added.
      </p>
    </div>
  );
}
