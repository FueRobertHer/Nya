'use client';

// A filter chip that chooses one of a few options (docs/design/design-system.md
// #badge-and-chip): the Activity tab's Tag and Receipt. A native select, so a
// phone opens its own picker, laid unseen over the chip's whole 44px hit area;
// the chip shows its name and what is chosen ("Tag: Groceries"), so it is
// never color alone, and is "on" while a choice other than the first is made.
// The select is named by the chip's word alone, which the shown text starts
// with (WCAG 2.5.3); the shown text is hidden from a screen reader, which
// reads the select's name and value instead.

import type { ReactNode } from 'react';

export default function ChipSelect({
  label,
  shown,
  on,
  value,
  onChange,
  children,
}: {
  /** The chip's word, and the select's name: "Tag". */
  label: string;
  /** What the chip shows: its word, and the choice when one is made. */
  shown: string;
  on: boolean;
  value: string;
  onChange: (value: string) => void;
  /** The options, the one that filters nothing first. */
  children: ReactNode;
}) {
  return (
    <label className="chip chip-select" data-on={on ? '' : undefined}>
      <span aria-hidden="true">{shown}</span>
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="m6 9 6 6 6-6" />
      </svg>
      <select value={value} onChange={(e) => onChange(e.target.value)} aria-label={label}>
        {children}
      </select>
    </label>
  );
}
