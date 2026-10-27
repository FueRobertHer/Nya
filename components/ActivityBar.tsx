'use client';

// Activity's pinned bar (docs/design/information-architecture.md#activity):
// the month (components/MonthStepper.tsx), the tab's ⋯ (adding or importing
// transactions, when a manual account takes them), and its three segments.
// The segments follow the WAI-ARIA tabs pattern: one tab stop, the arrow
// keys, Home and End move between them and choose as they go.

import { useRef, type KeyboardEvent } from 'react';
import { Menu, type MenuItem } from './Menu';
import MonthStepper, { chevron, LEFT, RIGHT } from './MonthStepper';

export type ActivitySegment = 'transactions' | 'spending' | 'shared';

export const ACTIVITY_SEGMENTS: readonly { key: ActivitySegment; label: string }[] = [
  { key: 'transactions', label: 'Transactions' },
  { key: 'spending', label: 'Spending' },
  { key: 'shared', label: 'Shared' },
];

/** The id of a segment's tab, which its panel is labelled by. */
export const segmentTabId = (s: ActivitySegment) => `activity-tab-${s}`;
/** The id of the panel every segment is drawn in. */
export const ACTIVITY_PANEL = 'activity-panel';

/** Which segment a key moves to from `at`, wrapping; null for other keys. */
export function segmentKey(key: string, at: number, count: number): number | null {
  if (key === 'ArrowRight') return (at + 1) % count;
  if (key === 'ArrowLeft') return (at - 1 + count) % count;
  if (key === 'Home') return 0;
  if (key === 'End') return count - 1;
  return null;
}

/** The arrows' icons, drawn by MonthStepper, which the app's other arrows use. */
export { chevron, LEFT, RIGHT };

/** Activity's month: what it shows, the months with transactions it steps
 *  through and lists, and where its return button goes. */
export type ActivityMonth = {
  /** YYYY-MM. */
  value: string;
  /** Newest first. */
  months: readonly string[];
  label: (m: string) => string;
  optionLabel: (m: string) => string;
  onMonth: (m: string) => void;
  back: { label: string; onBack: () => void } | null;
};

export default function ActivityBar({
  month,
  segment,
  onSegment,
  menu,
  monthPending = false,
}: {
  /** The month shown, or null to leave the stepper out: on Shared, whose
   *  balances aren't by month, and before there is one. */
  month: ActivityMonth | null;
  /** With no month yet, while the transactions load: the stepper drawn
   *  with a placeholder for its name, so it doesn't push the list down when
   *  the month arrives (components/LoadingSkeletons.tsx). */
  monthPending?: boolean;
  segment: ActivitySegment;
  onSegment: (s: ActivitySegment) => void;
  /** The ⋯'s items; none leaves it out. */
  menu: MenuItem[];
}) {
  const tabs = useRef<(HTMLButtonElement | null)[]>([]);
  const at = ACTIVITY_SEGMENTS.findIndex((s) => s.key === segment);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const to = segmentKey(e.key, at, ACTIVITY_SEGMENTS.length);
    if (to === null) return;
    e.preventDefault();
    onSegment(ACTIVITY_SEGMENTS[to].key);
    tabs.current[to]?.focus();
  };

  const dots = menu.length > 0 ? <Menu label="Activity options" items={menu} /> : null;
  return (
    <div className="activity-bar">
      {month !== null || monthPending ? (
        // The same elements pending or not, so focus on an arrow survives
        // the month arriving.
        <MonthStepper
          month={month?.value ?? null}
          months={month?.months ?? []}
          label={month?.label ?? String}
          optionLabel={month?.optionLabel}
          onMonth={month?.onMonth ?? (() => {})}
          back={month?.back ?? null}
          skeleton="activity-skeleton-month"
          end={dots}
        />
      ) : (
        dots && <div className="activity-month">{dots}</div>
      )}
      <div className="segmented" role="tablist" aria-label="Activity" onKeyDown={onKeyDown}>
        {ACTIVITY_SEGMENTS.map((s, i) => (
          <button
            key={s.key}
            ref={(el) => {
              tabs.current[i] = el;
            }}
            type="button"
            role="tab"
            id={segmentTabId(s.key)}
            aria-selected={s.key === segment}
            aria-controls={ACTIVITY_PANEL}
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
