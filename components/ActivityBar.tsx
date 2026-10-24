'use client';

// Activity's pinned bar (docs/design/information-architecture.md#activity):
// the month switcher, the tab's ⋯ (adding or importing transactions, when a
// manual account takes them), and its three segments. The segments follow
// the WAI-ARIA tabs pattern: one tab stop, the arrow keys, Home and End move
// between them and choose as they go. The month's arrows stay focusable at
// either end (aria-disabled, not disabled), so a press that reaches the end
// doesn't drop focus, and the month is announced as it changes.

import { useRef, type KeyboardEvent } from 'react';
import { Menu, type MenuItem } from './Menu';

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

const chevron = (d: string) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d={d} />
  </svg>
);
const LEFT = 'm15 18-6-6 6-6';
const RIGHT = 'm9 18 6-6-6-6';

export default function ActivityBar({
  month,
  onEarlier,
  onLater,
  segment,
  onSegment,
  menu,
}: {
  /** The month shown ("October 2026"), or null to leave the switcher out:
   *  on Shared, whose balances aren't by month, and before there is one. */
  month: string | null;
  /** Steps to the month before or after; left out at either end. */
  onEarlier?: () => void;
  onLater?: () => void;
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

  return (
    <div className="activity-bar">
      {(month !== null || menu.length > 0) && (
        <div className="activity-month">
          {month !== null && (
            <>
              <button type="button" className="secondary icon-btn" aria-label="Earlier month" aria-disabled={!onEarlier} onClick={onEarlier}>
                {chevron(LEFT)}
              </button>
              <h2 className="activity-month-name" aria-live="polite">
                {month}
              </h2>
              <button type="button" className="secondary icon-btn" aria-label="Later month" aria-disabled={!onLater} onClick={onLater}>
                {chevron(RIGHT)}
              </button>
            </>
          )}
          {menu.length > 0 && <Menu label="Activity options" items={menu} />}
        </div>
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
