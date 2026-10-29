// components/chart-keys.ts
//
// Reading a chart by the keys, as the net worth chart does
// (components/NetWorthChart.tsx): the plot is a slider (role="slider", in the
// tab order) named by the chart's own summary in words. The left and right
// arrows (and down and up) move the point it reads one at a time, Home and
// End go to the first and last, and Escape or leaving the plot (blur) puts
// it back where it rests. It drives the same state a pointer's scrub drives,
// so the readout over the chart moves exactly as it does under a finger.
//
// Escape with nothing moved is left to the page, so a sheet around the chart
// still closes on it. The slider's value (aria-valuenow, aria-valuetext)
// follows the point only once the keys rest (SETTLE_MS), so a screen reader
// says the new reading once movement stops, not at every step. How to use it
// is a visually hidden line the plot is described by (`helpId`); the focus
// ring is the app's own (:focus-visible in app/globals.css).

import { useEffect, useId, useState, type KeyboardEvent } from 'react';
import { spoken } from '@/lib/format';

/** How long the point on the plot rests before the slider's value follows
 *  it, so a screen reader says the reading once, when movement stops. */
export const SETTLE_MS = 500;

/** "Left and right arrows move from month to month, Home and End go to the
 *  first and last month, and Escape goes back to the latest." */
export function keysHelp(unit: string, back = 'the latest', ends = `the first and last ${unit}`): string {
  return `Left and right arrows move from ${unit} to ${unit}, Home and End go to ${ends}, and Escape goes back to ${back}.`;
}

export function useChartKeys({
  count,
  active,
  setActive,
  say,
  rest,
}: {
  /** How many points the keys move between (0 to count - 1). */
  count: number;
  /** The point a pointer or the keys are on, or null at rest. */
  active: number | null;
  setActive: (i: number | null) => void;
  /** The reading at a point, in words, as the readout says it. */
  say: (i: number) => string;
  /** Where the chart rests with nothing chosen (its readout's own point):
   *  the last, unless said. */
  rest?: number;
}) {
  const helpId = useId();
  // The point the slider's value says (null: where it rests), once the
  // point on the plot has rested SETTLE_MS.
  const [settled, setSettled] = useState<number | null>(null);
  useEffect(() => {
    const t = setTimeout(() => setSettled(active), SETTLE_MS);
    return () => clearTimeout(t);
  }, [active]);

  const last = Math.max(0, count - 1);
  const clamp = (i: number) => Math.max(0, Math.min(last, i));
  const home = clamp(rest ?? last);
  const said = settled === null ? home : clamp(settled);

  function onKeyDown(e: KeyboardEvent<SVGSVGElement>) {
    if (count === 0) return;
    const from = active === null ? home : clamp(active);
    let to: number;
    switch (e.key) {
      case 'ArrowLeft':
      case 'ArrowDown':
        to = Math.max(0, from - 1);
        break;
      case 'ArrowRight':
      case 'ArrowUp':
        to = Math.min(last, from + 1);
        break;
      case 'Home':
        to = 0;
        break;
      case 'End':
        to = last;
        break;
      case 'Escape':
        // Nothing to put back: the key is the page's (a sheet closes).
        if (active === null) return;
        e.preventDefault();
        e.stopPropagation();
        setActive(null);
        return;
      default:
        return;
    }
    e.preventDefault();
    setActive(to);
  }

  return {
    /** Spread on the plot's <svg>, after its role="slider" (written out
     *  there, so a scan of the source sees its text is the slider's, said
     *  by its label and value) and with its aria-label. */
    slider: {
      tabIndex: 0,
      'aria-describedby': helpId,
      'aria-valuemin': 1,
      'aria-valuemax': Math.max(1, count),
      'aria-valuenow': said + 1,
      'aria-valuetext': count > 0 ? spoken(say(said)) : undefined,
      onKeyDown,
      onBlur: () => setActive(null),
    },
    /** The id of the visually hidden line saying how to use it. */
    helpId,
  };
}
