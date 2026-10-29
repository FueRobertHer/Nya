'use client';

// Budgets > Upcoming's list (rollout phase 6a3, docs/design/information-
// architecture.md#budgets), the List · Calendar control's first view: from
// today to the forecast's range's end, each day with a bill, income, a
// planned item or a card or loan payment due on it, as Activity lists its
// days (components/MonthBreakdown.tsx): a bar with the day and its expected
// figure, then a plain row for each, in the calendar's own words and by its
// rules (lib/calendar.ts upcomingDays, components/CalendarView.tsx EntryRow).
// Its tab names it, so it has no heading of its own. Its rows open nothing:
// Recurring and Planned, below it, are where they are changed.
//
// What hasn't loaded leaves entries out, so an empty list says "nothing
// expected" only when nothing is missing. With a forecast, Upcoming's notice
// at the top says what is missing; with none (no cash accounts), the list
// says it itself, as the calendar and Recurring do.

import { Fragment, useMemo } from 'react';
import { duePayments, upcomingDays } from '@/lib/calendar';
import { addDays, type RecurringSeries } from '@/lib/recurring';
import type { PlannedItem } from '@/lib/planned';
import type { ForecastInstitution } from '@/lib/forecast';
import { formatDay, signedMoney } from '@/lib/format';
import type { FxTable } from '@/lib/fx/rates';
import { Masked } from './HideAmounts';
import { Notice } from './TotalCaveats';
import { EntryRow } from './CalendarView';
import { NoticeBadge, type UpcomingBadge } from './upcoming-notes';

/** "Today", or "Sat, Oct 24": a day's bar (lib/format.ts formatDay), on the
 *  list's own today. */
function dayName(iso: string, today: string): string {
  return formatDay(iso, { weekday: 'short', now: new Date(`${today}T12:00:00`) });
}

export default function UpcomingList({
  series,
  planned,
  dismissed,
  institutions,
  today,
  days,
  currency,
  fx = null,
  badge = null,
  states,
  sayStates,
}: {
  series: RecurringSeries[];
  /** The planned items as the dashboard holds them (empty until loaded). */
  planned: PlannedItem[];
  dismissed: ReadonlySet<string>;
  /** For the payments due on cards and loans (lib/calendar.ts duePayments). */
  institutions: ForecastInstitution[];
  today: string;
  /** The range's length in days (30, 60 or 90): the list runs from today to today + days. */
  days: number;
  /** The totals' currency, as the calendar's day figures. */
  currency: string | null;
  fx?: FxTable | null;
  badge?: UpcomingBadge;
  /** What hasn't loaded: transactions (still loading, or couldn't be) and the
   *  planned items (not yet drawn). An empty list says "Nothing expected in
   *  the next N days." only when nothing is missing. */
  states: { failed: boolean; loading: boolean; plannedReady: boolean };
  /** True when there is no forecast to say the load states at the top (no
   *  cash accounts): the list then says them itself. */
  sayStates: boolean;
}) {
  const dues = useMemo(() => duePayments(institutions), [institutions]);
  const list = useMemo(
    () => upcomingDays({ today, until: addDays(today, days), series, planned, dismissed, dues, currency, fx }),
    [today, days, series, planned, dismissed, dues, currency, fx]
  );
  const missing = states.failed || states.loading || !states.plannedReady;

  return (
    <div className="card stack upcoming-list">
      {badge && <NoticeBadge tone={badge} />}
      {/* With no forecast above to say them: Recurring's words when
          transactions couldn't be loaded, the calendar's while they load,
          the forecast's for the planned items. */}
      {sayStates && states.failed && <Notice level="critical">Transactions couldn&apos;t be loaded, so no bills or income can be found.</Notice>}
      {sayStates && states.loading && <Notice level="caution">Transactions are still loading.</Notice>}
      {sayStates && !states.plannedReady && (
        <Notice level="caution">Your planned items aren&apos;t loaded, so they aren&apos;t in this, and bills you marked not recurring may be.</Notice>
      )}

      {list.length === 0 ? (
        <p className="empty-note">{missing ? 'Nothing to list yet.' : `Nothing expected in the next ${days} days.`}</p>
      ) : (
        <ul className="list-rows">
          {list.map((d) => (
            <Fragment key={d.date}>
              <li className="txn-day">
                <span>{dayName(d.date, today)}</span>
                {d.expected !== null && (
                  <span className="money">
                    <Masked>{signedMoney(d.expected, currency)}</Masked>
                  </span>
                )}
              </li>
              {d.entries.map((e) => (
                <EntryRow key={`${e.kind}-${e.ref}`} entry={e} currency={currency} badgeDue />
              ))}
            </Fragment>
          ))}
        </ul>
      )}

      <p className="helper">
        From today, what is expected to leave or reach your checking and savings, an estimate, as the forecast counts it; a card&apos;s own charges and the
        payments due on cards and loans are listed, not added.
      </p>
    </div>
  );
}
