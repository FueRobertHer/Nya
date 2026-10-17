'use client';

// Hide amounts, on screen (components/hide-amounts.ts): the switch in the
// header, text that may hold hidden amounts as a screen reader says it, and
// the figures a report shows while it prints.

import { useEffect } from 'react';
import { flushSync } from 'react-dom';
import { MASK, spoken } from '@/lib/format';
import { setHideAmounts, showFigures, useAmountsHidden } from './hide-amounts';

const EYE = 'M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12ZM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z';
const EYE_OFF =
  'M9.9 4.24A9.1 9.1 0 0 1 12 4c6.5 0 10 8 10 8a18.5 18.5 0 0 1-2.16 3.19M6.6 6.6A18.4 18.4 0 0 0 2 12s3.5 8 10 8a9.7 9.7 0 0 0 5.4-1.6M14.12 14.12a3 3 0 1 1-4.24-4.24M2 2l20 20';

/**
 * The switch. Its name says what it does and stays the same; whether it is on
 * is its pressed state (and the eye, crossed out while amounts are hidden).
 */
export function HideAmountsToggle() {
  const hidden = useAmountsHidden();
  return (
    <button
      type="button"
      className="secondary icon-btn hide-amounts-btn"
      onClick={() => setHideAmounts(!hidden)}
      aria-pressed={hidden}
      aria-label="Hide amounts"
      title="Hide amounts"
    >
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d={hidden ? EYE_OFF : EYE} />
      </svg>
    </button>
  );
}

/**
 * Text that may hold hidden amounts, drawn as it is ("$••• of $•••") and
 * given to a screen reader with each one said as "hidden" ("hidden of
 * hidden"), never as a row of bullets. Text without one is drawn alone.
 */
export function Masked({ children }: { children: string | null | undefined }) {
  if (!children) return null;
  if (!children.includes(MASK)) return <>{children}</>;
  return (
    <>
      <span aria-hidden="true">{children}</span>
      <span className="visually-hidden">{spoken(children)}</span>
    </>
  );
}

/** What a screen reader is to be given for text that holds hidden amounts
 *  and can't hold markup (a select's option): its spoken words, as an
 *  aria-label, or nothing for text without one. */
export function spokenLabel(text: string): string | undefined {
  return text.includes(MASK) ? spoken(text) : undefined;
}

/**
 * The page's figures while the browser prints it, whatever the switch says:
 * printing a report is a deliberate act, and the paper or PDF has its
 * amounts. Drawn again at once, before the browser lays the print out, and
 * hidden again after.
 */
export function useFiguresWhenPrinted(): void {
  useEffect(() => {
    const before = () => flushSync(() => showFigures(true));
    const after = () => showFigures(false);
    window.addEventListener('beforeprint', before);
    window.addEventListener('afterprint', after);
    return () => {
      window.removeEventListener('beforeprint', before);
      window.removeEventListener('afterprint', after);
      showFigures(false);
    };
  }, []);
}
