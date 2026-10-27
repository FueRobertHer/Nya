'use client';

// The underline switch (.segmented) for a value or a few views of one thing.
// Setting a value it is a radio group; switching views (`tabs`) it is a
// tablist whose tabs control one panel. Either way it is one tab stop: the
// arrow keys (up and left back, down and right on), Home and End move
// between the items and choose as they go, as Activity's and Budgets' bars
// do (components/ActivityBar.tsx).

import { useRef, type KeyboardEvent } from 'react';
import { segmentKey } from './ActivityBar';

export function Segmented<T extends string | number>({
  options,
  value,
  onChange,
  label,
  compact = false,
  disabled = false,
  tabs,
  className,
}: {
  /** Each item's value and its words. */
  options: readonly (readonly [T, string])[];
  value: T;
  onChange: (v: T) => void;
  /** What the group is, for a screen reader. */
  label: string;
  /** A chart's range: smaller labels, narrower items (.segmented.compact). */
  compact?: boolean;
  disabled?: boolean;
  /** Switching views: each tab's id, and the id of the panel they control. */
  tabs?: { id: (v: T) => string; panel: string };
  className?: string;
}) {
  const buttons = useRef<(HTMLButtonElement | null)[]>([]);
  const at = options.findIndex(([v]) => v === value);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (disabled) return;
    const key = e.key === 'ArrowUp' ? 'ArrowLeft' : e.key === 'ArrowDown' ? 'ArrowRight' : e.key;
    // With none chosen, the keys start from the first, which holds the tab stop.
    const to = segmentKey(key, Math.max(at, 0), options.length);
    if (to === null) return;
    e.preventDefault();
    // A key that lands where it is (Home on the first) chooses nothing anew:
    // a choice may load something again.
    if (to !== at) onChange(options[to][0]);
    buttons.current[to]?.focus();
  };

  return (
    <div
      className={['segmented', compact ? 'compact' : null, className].filter(Boolean).join(' ')}
      role={tabs ? 'tablist' : 'radiogroup'}
      aria-label={label}
      onKeyDown={onKeyDown}
    >
      {options.map(([v, text], i) => (
        <button
          key={String(v)}
          ref={(el) => {
            buttons.current[i] = el;
          }}
          type="button"
          role={tabs ? 'tab' : 'radio'}
          id={tabs?.id(v)}
          aria-controls={tabs?.panel}
          aria-selected={tabs ? v === value : undefined}
          aria-checked={tabs ? undefined : v === value}
          // The chosen item takes the tab stop; with none chosen, the first.
          tabIndex={v === value || (at < 0 && i === 0) ? 0 : -1}
          disabled={disabled}
          onClick={() => onChange(v)}
        >
          {text}
        </button>
      ))}
    </div>
  );
}
