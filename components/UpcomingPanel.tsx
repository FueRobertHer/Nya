'use client';

// Budgets > Upcoming (rollout phase 6a3, docs/design/information-architecture.md
// #budgets): what is coming, top to bottom:
//
//   1. the segment's one notice (components/upcoming-notes.tsx): what the
//      bills, income, planned items and payments may be missing, said once;
//   2. the cash forecast (components/ForecastCard.tsx), with its range and
//      the notes about where it starts;
//   3. List or Calendar: two tabs over the same days (bills, income, planned
//      items and card payments due), the list (components/UpcomingList.tsx)
//      running as far ahead as the forecast does, the calendar
//      (components/CalendarView.tsx) a month a page. Both stay mounted, the
//      other hidden, so the calendar keeps its month and day across a switch;
//   4. Recurring (components/RecurringCard.tsx) and Planned
//      (components/PlannedCard.tsx), where the bills and items are managed.
//
// The panel holds the range and the choice of view, as the forecast held its
// range before: each starts afresh (30 days, List) when the Budgets tab mounts
// again. It works the forecast and its notes out once, for the card and for
// the notice.

import { useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import type { ListStatus } from '@/lib/whole-list-store';
import type { Txn } from './MonthBreakdown';
import type { RecurringSeries } from '@/lib/recurring';
import type { ForecastInstitution, ForecastRange } from '@/lib/forecast';
import type { Planned, PlannedItem } from '@/lib/planned';
import type { Incomplete, Stopped } from '@/lib/month-coverage';
import type { NoSpending, NoTransactionsView } from '@/lib/no-transactions';
import type { FxTable } from '@/lib/fx/rates';
import TotalCaveats from './TotalCaveats';
import { ForecastView, useForecast, type ForecastInput } from './ForecastCard';
import UpcomingList from './UpcomingList';
import CalendarView from './CalendarView';
import RecurringCard from './RecurringCard';
import PlannedCard from './PlannedCard';
import { segmentKey } from './ActivityBar';
import { useUpcomingNotes } from './upcoming-notes';

const NO_ITEMS: PlannedItem[] = [];

export type UpcomingView = 'list' | 'calendar';

export const UPCOMING_VIEWS: readonly { key: UpcomingView; label: string }[] = [
  { key: 'list', label: 'List' },
  { key: 'calendar', label: 'Calendar' },
];

/** The id of a view's tab, which its panel is labelled by. */
export const upcomingTabId = (v: UpcomingView) => `upcoming-tab-${v}`;
/** The id of a view's panel. */
export const upcomingPanelId = (v: UpcomingView) => `upcoming-panel-${v}`;

export default function UpcomingPanel({
  institutions,
  series,
  planned,
  plannedStatus,
  plannedDrawn,
  plannedError,
  plannedSaveError,
  onSavePlanned,
  dismissed,
  onDismiss,
  txns,
  failed,
  balancesAsOf,
  balancesSaved,
  incomplete,
  stopped,
  withoutTransactions,
  fx,
  today,
  currency,
  plannedCurrency,
  noSpending,
}: {
  /** Every institution as the dashboard last loaded it, for the forecast's
   *  cash accounts and the payments due on cards and loans. */
  institutions: ForecastInstitution[];
  /** The bills and income detected (lib/recurring.ts), for the forecast,
   *  the list, the calendar and Recurring alike. */
  series: RecurringSeries[];
  /** The planned items, dismissals and warning as the store holds them. */
  planned: Planned;
  /** Whether a change can be made to them: only once 'ready'. */
  plannedStatus: ListStatus;
  /** Whether they are shown: ready, or held through the store's reload after
   *  a refused save (components/BudgetsTab.tsx), so nothing drawn from them
   *  drops out meanwhile. */
  plannedDrawn: boolean;
  plannedError: string | null;
  plannedSaveError: string | null;
  onSavePlanned?: (next: Planned) => Promise<boolean>;
  /** The series marked not recurring (lib/recurring.ts dismissedSeries), and
   *  how a mark is saved or taken off. */
  dismissed: ReadonlySet<string>;
  onDismiss?: (series: RecurringSeries, dismiss: boolean) => Promise<boolean>;
  /** Null while transactions load, or when they couldn't be (`failed`). */
  txns: Txn[] | null;
  failed: boolean;
  /** When the balances were loaded, and whether they are the ones saved on
   *  this device from an earlier visit (components/Dashboard.tsx). */
  balancesAsOf: string | null;
  balancesSaved: boolean;
  incomplete: Incomplete[];
  stopped: Stopped[];
  withoutTransactions: NoTransactionsView;
  fx: FxTable | null;
  /** The viewer's day (lib/local-date.ts). */
  today: string;
  /** The totals' currency: the list's and the calendar's day figures, and
   *  Recurring's monthly ones. */
  currency: string | null;
  /** A new planned item's currency to start with: the forecast's. */
  plannedCurrency: string | null;
  /** No connection brings in transactions: what Recurring says instead. */
  noSpending: NoSpending | null;
}) {
  const [range, setRange] = useState<ForecastRange>(30);
  const [view, setView] = useState<UpcomingView>('list');
  const tabs = useRef<(HTMLButtonElement | null)[]>([]);

  const loading = txns === null && !failed;
  const items = plannedDrawn ? planned.items : NO_ITEMS;
  const input: ForecastInput = {
    institutions,
    series,
    planned,
    plannedDrawn,
    dismissed,
    today,
    range,
    txns: txns ?? undefined,
    fx,
    incomplete,
    stopped,
    withoutTransactions,
  };
  const work = useForecast(input);
  const { notice, start, badges } = useUpcomingNotes(input, work, { failed, loading });

  const at = UPCOMING_VIEWS.findIndex((v) => v.key === view);
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const to = segmentKey(e.key, at, UPCOMING_VIEWS.length);
    if (to === null) return;
    e.preventDefault();
    setView(UPCOMING_VIEWS[to].key);
    tabs.current[to]?.focus();
  };
  // The list's rows are plain, so its panel takes focus from the tabs (WAI-ARIA
  // tabs pattern); the calendar's first is its month's arrow.
  const tabpanel = (v: UpcomingView, body: ReactNode) => (
    <div id={upcomingPanelId(v)} role="tabpanel" aria-labelledby={upcomingTabId(v)} tabIndex={v === 'list' ? 0 : undefined} hidden={v !== view}>
      {body}
    </div>
  );

  return (
    <div className="stack loose">
      <TotalCaveats items={notice} />

      <ForecastView
        work={work}
        start={start}
        onRange={setRange}
        planned={planned}
        plannedStatus={plannedStatus}
        onSavePlanned={onSavePlanned}
        saveError={plannedSaveError}
        balancesAsOf={balancesAsOf}
        balancesSaved={balancesSaved}
        badge={badges.forecast}
      />

      <div className="segmented" role="tablist" aria-label="List or calendar" onKeyDown={onKeyDown}>
        {UPCOMING_VIEWS.map((v, i) => (
          <button
            key={v.key}
            ref={(el) => {
              tabs.current[i] = el;
            }}
            type="button"
            role="tab"
            id={upcomingTabId(v.key)}
            aria-selected={v.key === view}
            aria-controls={upcomingPanelId(v.key)}
            tabIndex={v.key === view ? 0 : -1}
            onClick={() => setView(v.key)}
          >
            {v.label}
          </button>
        ))}
      </div>
      {tabpanel(
        'list',
        <UpcomingList
          series={series}
          planned={items}
          dismissed={dismissed}
          institutions={institutions}
          today={today}
          days={range}
          currency={currency}
          fx={fx}
          badge={badges.list}
          states={{ failed, loading, plannedReady: plannedDrawn }}
          sayStates={!work.has}
        />
      )}
      {tabpanel(
        'calendar',
        <CalendarView
          txns={txns}
          failed={failed}
          series={series}
          planned={items}
          dismissed={dismissed}
          institutions={institutions}
          today={today}
          currency={currency}
          fx={fx}
          badge={badges.calendar}
        />
      )}

      <RecurringCard
        series={series}
        today={today}
        currency={currency}
        fx={fx}
        dismissed={dismissed}
        status={plannedStatus}
        saveError={plannedSaveError}
        onDismiss={onDismiss}
        noSpending={noSpending}
        loading={loading}
        failed={failed}
        // What may leave series out, as the list's; not while transactions
        // aren't in, which Recurring says in full itself.
        badge={failed || loading ? null : badges.list}
      />

      <PlannedCard
        planned={planned}
        status={plannedStatus}
        drawn={plannedDrawn}
        error={plannedError}
        saveError={plannedSaveError}
        onSave={onSavePlanned}
        today={today}
        currency={plannedCurrency}
      />
    </div>
  );
}
