// A card that opens and closes on its title (docs/design/design-system.md#card):
// the title is a heading holding one button, so a screen reader can jump to it
// by heading and hear whether it is open. A count and one status badge may
// follow the title; nothing else in the header is a control.

import type { ReactNode } from 'react';

export function CollapsibleHeader({
  title,
  count,
  status,
  open,
  onToggle,
  controls,
}: {
  title: string;
  /** How many it holds, as a neutral badge. */
  count?: number;
  /** One status badge after the count, such as "1 to confirm". */
  status?: ReactNode;
  open: boolean;
  onToggle: () => void;
  /** The id of what it opens. */
  controls?: string;
}) {
  return (
    <div className="card-header">
      <h2>
        <button type="button" className="section-toggle" aria-expanded={open} aria-controls={open ? controls : undefined} onClick={onToggle}>
          <span>{title}</span>
          {count !== undefined && <span className="badge">{count}</span>}
          {status}
          <svg className={`section-chevron${open ? ' open' : ''}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="m6 9 6 6 6-6" />
          </svg>
        </button>
      </h2>
    </div>
  );
}
