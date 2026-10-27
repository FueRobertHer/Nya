'use client';

// The one control that changes the month in view (look and feel, step 2b):
// Activity's, Budgets' (Month) and the calendar's. Bare arrows either side,
// labelled "Earlier month" and "Later month", that stay focusable at either
// end (aria-disabled, not disabled) so a press that reaches the end doesn't
// drop focus; the month's name, announced as it changes, with a native
// select laid unseen over it (and the chevron that says it opens) to jump to
// any month; and, away from the month the caller returns to, a ghost button
// that returns there. The select's name holds the month it lies over (WCAG
// 2.5.3), so "October 2026" spoken or clicked by voice reaches it.
//
// At 320px the return button doesn't fit beside the name, so it wraps under
// it (app/globals.css .month-stepper-mid), with the arrows kept on the first
// line, where a second tap finds them again.

import { useRef, type ReactNode, type RefObject } from 'react';

/** An arrow's icon, by its path; ActivityBar passes these on to the rest of
 *  the app's arrows. */
export const chevron = (d: string) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d={d} />
  </svg>
);
export const LEFT = 'm15 18-6-6 6-6';
export const RIGHT = 'm9 18 6-6-6-6';
const DOWN = 'm6 9 6 6 6-6';

export default function MonthStepper({
  month,
  months,
  label,
  optionLabel = label,
  onMonth,
  back = null,
  heading = 'h2',
  titleId,
  listLabel = 'Month to show',
  disabled = false,
  skeleton,
  end,
}: {
  /** The month shown, YYYY-MM; null while it is still coming: a placeholder
   *  in its name's place, in the same elements, so nothing moves when it
   *  arrives. */
  month: string | null;
  /** The months the arrows step through and the list offers, newest first. */
  months: readonly string[];
  /** A month in words, for its name. */
  label: (m: string) => string;
  /** A month in words in the list, when it says more ("(this month)"). */
  optionLabel?: (m: string) => string;
  onMonth: (m: string) => void;
  /** Away from where the caller returns to: the button's words and what it
   *  does. Focus goes to the list (or the name) first, since the button goes. */
  back?: { label: string; onBack: () => void } | null;
  /** The name's element: a heading on a tab's bar, a span in a card. */
  heading?: 'h2' | 'span';
  /** The name's id, for a jump to land on (Budgets' month). */
  titleId?: string;
  /** What the list is, before the month it lies over. */
  listLabel?: string;
  /** Nothing to choose yet: the arrows say so and the list waits. */
  disabled?: boolean;
  /** The placeholder's class, sized as the name it stands for. */
  skeleton?: string;
  /** What follows the later arrow on the same line (Activity's ⋯). */
  end?: ReactNode;
}) {
  const title = useRef<HTMLElement | null>(null);
  const list = useRef<HTMLSelectElement | null>(null);
  const at = month === null ? -1 : months.indexOf(month);
  const live = month !== null && !disabled;
  const earlier = live && at >= 0 && at < months.length - 1 ? months[at + 1] : null;
  const later = live && at > 0 ? months[at - 1] : null;
  const listed = live && months.length > 1 && at >= 0;
  const Title = heading;

  return (
    <div className="month-stepper">
      <button type="button" className="icon-btn" aria-label="Earlier month" aria-disabled={earlier === null} onClick={earlier === null ? undefined : () => onMonth(earlier)}>
        {chevron(LEFT)}
      </button>
      <div className="month-stepper-mid">
        <div className="month-stepper-name">
          <Title
            ref={title as RefObject<never>}
            id={titleId}
            className="month-stepper-title"
            tabIndex={-1}
            aria-live="polite"
          >
            {month === null ? <span className={`skeleton${skeleton ? ` ${skeleton}` : ''}`} aria-hidden="true" /> : label(month)}
          </Title>
          {listed && (
            <>
              {chevron(DOWN)}
              <select ref={list} value={month} onChange={(e) => onMonth(e.target.value)} aria-label={`${listLabel}: ${label(month)}`}>
                {months.map((m) => (
                  <option key={m} value={m}>
                    {optionLabel(m)}
                  </option>
                ))}
              </select>
            </>
          )}
        </div>
        {back && (
          <button
            type="button"
            className="btn ghost month-stepper-back"
            onClick={() => {
              // Before the button goes, or focus would fall to the page.
              (list.current ?? title.current)?.focus();
              back.onBack();
            }}
          >
            {back.label}
          </button>
        )}
      </div>
      <button type="button" className="icon-btn" aria-label="Later month" aria-disabled={later === null} onClick={later === null ? undefined : () => onMonth(later)}>
        {chevron(RIGHT)}
      </button>
      {end}
    </div>
  );
}
