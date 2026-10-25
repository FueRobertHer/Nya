'use client';

// The Budgets tab's pinned bar (docs/design/information-architecture.md#budgets):
// its heading over its three segments, Month, Upcoming and Goals. On Month the
// heading is the month shown, with arrows to the month either side and, when
// there are earlier months, a native select laid unseen over the name to jump
// further back (up to ten years: a step at a time would read each month from
// the server). The select's name holds the month it lies over (WCAG 2.5.3), so
// "October 2026" spoken or clicked by voice reaches it. Only the month's name is announced as it changes; a segment's
// own name isn't, since choosing the segment already says it. The segments
// are tabs, as Activity's are (components/ActivityBar.tsx).

import { useRef, type KeyboardEvent, type Ref } from 'react';
import { chevron, LEFT, RIGHT, segmentKey } from './ActivityBar';

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

const DOWN = 'm6 9 6 6 6-6';

export type MonthPick = {
  /** The month shown, YYYY-MM. */
  value: string;
  /** The months to choose from, newest first, each with its words. */
  options: readonly { value: string; label: string }[];
  onChange: (month: string) => void;
};

export default function BudgetsBar({
  ref,
  segment,
  onSegment,
  month,
  onEarlier,
  onLater,
  pick,
}: {
  ref?: Ref<HTMLDivElement>;
  segment: BudgetsSegment;
  onSegment: (s: BudgetsSegment) => void;
  /** The month shown, in words ("October 2026"). */
  month: string;
  /** Steps to the month before or after; left out at either end. */
  onEarlier?: () => void;
  onLater?: () => void;
  /** Every month to choose from, when there is more than one. */
  pick?: MonthPick | null;
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
      <div className="budgets-heading">
        {segment === 'month' ? (
          <>
            <button type="button" className="secondary icon-btn" aria-label="Earlier month" aria-disabled={!onEarlier} onClick={onEarlier}>
              {chevron(LEFT)}
            </button>
            <div className="budgets-month-pick">
              <h2 key="month" id={BUDGETS_MONTH_TITLE} className="budgets-title" tabIndex={-1} aria-live="polite">
                {month}
              </h2>
              {pick && (
                <>
                  {chevron(DOWN)}
                  <select value={pick.value} onChange={(e) => pick.onChange(e.target.value)} aria-label={`Month to show: ${month}`}>
                    {pick.options.map((o) => (
                      <option key={o.value} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                </>
              )}
            </div>
            <button type="button" className="secondary icon-btn" aria-label="Later month" aria-disabled={!onLater} onClick={onLater}>
              {chevron(RIGHT)}
            </button>
          </>
        ) : (
          <h2 key={segment} className="budgets-title">
            {BUDGETS_SEGMENTS[at].label}
          </h2>
        )}
      </div>
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
