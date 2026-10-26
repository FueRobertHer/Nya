// components/drawn-width.ts
//
// A chart drawn at its own width (rollout phase 5d). An SVG's text scales
// with its viewBox, so a chart on a fixed 340-wide viewBox draws its 12px
// text at 8.8px on a 320px phone and at 25px on a wide card. A chart that
// sizes its viewBox to the width it is drawn at has one viewBox unit to a
// CSS pixel, so its text, strokes and dots are the size they say.
//
// MEASURED BEFORE PAINT. The width is read in a layout effect as the element
// mounts, so a chart that appears (its data loaded, its segment shown) is
// laid out at its own width before it is first painted; a ResizeObserver
// follows it after that (a rotated phone, a resized window). The width is
// rounded down to a whole pixel, so text never draws a hair under its size,
// and a width of 0 (an element not laid out) keeps the last one.
//
// THE FALLBACK where nothing can be measured (the server, a static render,
// the test DOM): 340, the width the charts were drawn at before, unless a
// DrawnWidth provider above says the width to draw at (a static render of a
// chart at a phone's width, or a wide card's).

import { createContext, useCallback, useContext, useLayoutEffect, useState } from 'react';

/** The width charts are drawn at where none can be measured. */
export const FALLBACK_WIDTH = 340;

/** A 12px label's width, roughly: tabular digits and currency signs about
 *  7px, a space 3px, a letter 6.5px ("age 55" is about 36px). For spacing a
 *  chart's labels so none overlap. */
export function labelWidth(text: string): number {
  let w = 0;
  for (const c of text) w += /[0-9$]/.test(c) ? 7 : c === ' ' ? 3 : 6.5;
  return w;
}

/** A chart's labels along its axis are at least this far apart, edge to edge. */
export const MIN_LABEL_GAP = 6;

/** The width to draw at until one is measured, for what is below it. */
export const DrawnWidth = createContext(FALLBACK_WIDTH);

/** A ref for the element a chart is drawn in, and its width in whole CSS
 *  pixels (DrawnWidth's until it is measured). A callback ref, so an element
 *  that mounts later (after an empty state) is measured too. */
export function useDrawnWidth<T extends Element>(): [(el: T | null) => void, number] {
  const fallback = useContext(DrawnWidth);
  const [el, setEl] = useState<T | null>(null);
  const [width, setWidth] = useState(fallback);
  const ref = useCallback((node: T | null) => setEl(node), []);

  useLayoutEffect(() => {
    if (!el) return;
    const take = (w: number) => {
      const whole = Math.floor(w);
      if (whole > 0) setWidth(whole);
    };
    take(el.getBoundingClientRect().width);
    if (typeof ResizeObserver === 'undefined') return;
    const watch = new ResizeObserver((entries) => {
      for (const e of entries) take(e.contentRect.width);
    });
    watch.observe(el);
    return () => watch.disconnect();
  }, [el]);

  return [ref, width];
}
