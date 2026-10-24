// The "Why?" disclosure (docs/design/design-system.md#helper-text-and-disclosure):
// a ghost button that opens an explanation in place, so a screen keeps one line
// of helper text and the paragraph behind it is a tap away. A <details>, so it
// works with no script, from the keyboard and with a screen reader as it is.

import type { ReactNode } from 'react';

export function Why({ label = 'Why?', children }: { label?: string; children: ReactNode }) {
  return (
    <details className="why">
      <summary>{label}</summary>
      <div className="why-body">{children}</div>
    </details>
  );
}
