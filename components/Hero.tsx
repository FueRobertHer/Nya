// components/Hero.tsx
//
// The one figure on a screen (design-system.md "Hero"), on the page and never
// in a card: Home's net worth (components/NetWorthCard.tsx), the Plan's answer
// on Your path (components/PlanTab.tsx FiCard) and the runway's months on the
// report page (components/RunwayReport.tsx). Each draws the same shell: a
// label that is a real heading, the figure under it, a line under that, and
// then what qualifies it. The `.hero` class carries what they share in
// app/globals.css: the room under it, the figure at the hero size, and an edge
// on every notice that isn't critical, since a notice's fill is close to the
// canvas. What a hero holds, and its own rules, stay with its feature class.

import type { ReactNode } from 'react';

export function Hero({
  id,
  label,
  level = 2,
  focusable = false,
  figure,
  figureClass,
  line,
  top,
  className,
  children,
}: {
  /** The label's id, which names the section. */
  id: string;
  label: ReactNode;
  /** The label's heading level: 2 under a tab, 3 under the Plan bar's title. */
  level?: 2 | 3;
  /** The label is a place focus can be sent (Home's, when the last Needs
   *  attention row goes). */
  focusable?: boolean;
  figure: ReactNode;
  /** More classes on the figure: `negative`, `plan-answer`. */
  figureClass?: string;
  /** What sits right under the figure, in the same block. */
  line?: ReactNode;
  /** What comes before the label (an open scenario's tag); nothing when
   *  there is none. */
  top?: ReactNode;
  /** The feature's own class: `net-worth-hero`, `plan-hero`, `runway-hero`. */
  className: string;
  children?: ReactNode;
}) {
  const Label = level === 3 ? 'h3' : 'h2';
  return (
    <section className={`stack hero ${className}`} aria-labelledby={id}>
      {top}
      <div>
        <Label id={id} className="total-label" tabIndex={focusable ? -1 : undefined}>
          {label}
        </Label>
        <div className={`total-value${figureClass ? ` ${figureClass}` : ''}`}>{figure}</div>
        {line}
      </div>
      {children}
    </section>
  );
}
