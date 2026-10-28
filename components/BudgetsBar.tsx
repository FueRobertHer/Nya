'use client';

// The Budgets tab's pinned bar (docs/design/information-architecture.md#budgets):
// its heading over its three segments, Month, Upcoming and Goals. On Month
// the heading is the month (components/MonthStepper.tsx): its arrows, its
// name with the list of months laid over it (back to the first month with
// transactions, ten years at most, or to the month Activity brought: a step
// at a time would read each month from the server), and This month when
// another month shows. Only the month's name is announced as it changes. On
// Upcoming and Goals, which aren't by month, the row stays as tall and shows
// nothing (the screen review after step 5: the tab's name there only said
// again what the tab under it says, and the segments moved without a row):
// its heading, the segment's name, is read by a screen reader alone, so the
// cards under it still sit under a heading. The segments are tabs, as
// Activity's are (components/ActivityBar.tsx).

import { useRef, type KeyboardEvent, type Ref } from 'react';
import { segmentKey } from './ActivityBar';
import MonthStepper from './MonthStepper';

export type BudgetsSegment = 'month' | 'upcoming' | 'goals';

export const BUDGETS_SEGMENTS: readonly { key: BudgetsSegment; label: string }[] = [
  { key: 'month', label: 'Month' },
  { key: 'upcoming', label: 'Upcoming' },
  { key: 'goals', label: 'Goals' },
];

/** The id of a segment's tab, which its panel is labelled by. */
export const budgetsTabId = (s: BudgetsSegment) => `budgets-tab-${s}`;
/** The id of a segment's panel. Each segment keeps its own, mounted, so a
 *  switch loses nothing typed in another. */
export const budgetsPanelId = (s: BudgetsSegment) => `budgets-panel-${s}`;
/** The month's heading: where Home's budget alerts land (components/attention.ts). */
export const BUDGETS_MONTH_TITLE = 'budgets-month-title';

/** The month on Month: the one shown, the months to step through and list,
 *  and This month while another shows. */
export type BudgetsMonth = {
  /** YYYY-MM. */
  value: string;
  /** Newest first. */
  months: readonly string[];
  label: (m: string) => string;
  optionLabel: (m: string) => string;
  onMonth: (m: string) => void;
  /** Until the budgets are there to show: the arrows say so, and the list waits. */
  disabled: boolean;
  back: { label: string; onBack: () => void } | null;
};

export default function BudgetsBar({
  ref,
  segment,
  onSegment,
  month,
}: {
  ref?: Ref<HTMLDivElement>;
  segment: BudgetsSegment;
  onSegment: (s: BudgetsSegment) => void;
  /** The month on Month; null while the dashboard loads, drawn with a
   *  placeholder for its name (components/LoadingSkeletons.tsx). */
  month: BudgetsMonth | null;
}) {
  const tabs = useRef<(HTMLButtonElement | null)[]>([]);
  const at = BUDGETS_SEGMENTS.findIndex((s) => s.key === segment);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const to = segmentKey(e.key, at, BUDGETS_SEGMENTS.length);
    if (to === null) return;
    e.preventDefault();
    onSegment(BUDGETS_SEGMENTS[to].key);
    tabs.current[to]?.focus();
  };

  return (
    <div className="budgets-bar" ref={ref}>
      {segment === 'month' ? (
        <MonthStepper
          key="month"
          month={month?.value ?? null}
          months={month?.months ?? []}
          label={month?.label ?? String}
          optionLabel={month?.optionLabel}
          onMonth={month?.onMonth ?? (() => {})}
          disabled={month?.disabled ?? true}
          back={month?.back ?? null}
          titleId={BUDGETS_MONTH_TITLE}
          skeleton="budgets-skeleton-month"
        />
      ) : (
        <div className="budgets-heading">
          <h2 key={segment} className="visually-hidden">
            {BUDGETS_SEGMENTS[at].label}
          </h2>
        </div>
      )}
      <div className="segmented" role="tablist" aria-label="Budgets" onKeyDown={onKeyDown}>
        {BUDGETS_SEGMENTS.map((s, i) => (
          <button
            key={s.key}
            ref={(el) => {
              tabs.current[i] = el;
            }}
            type="button"
            role="tab"
            id={budgetsTabId(s.key)}
            aria-selected={s.key === segment}
            aria-controls={budgetsPanelId(s.key)}
            tabIndex={s.key === segment ? 0 : -1}
            onClick={() => onSegment(s.key)}
          >
            {s.label}
          </button>
        ))}
      </div>
    </div>
  );
}
