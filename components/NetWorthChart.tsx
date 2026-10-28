'use client';

// Single-series net-worth-over-time line chart. Dependency-free inline SVG.
//
// Follows the house dataviz specs: 2px round-capped line in the accent hue,
// area wash at ~10% opacity, >=8px end-dot with a 2px surface ring, muted
// text tokens for all labels (never the series color), no legend for a
// single series. Every net worth chart (Home's hero, an account's sheet, a
// shared net worth) is drawn at its own width (components/drawn-width.ts),
// so its months are 12px, with no gridlines and no money on the plot (the
// screen review after step 5): its scale is in the readout, in the SVG's
// label (current, low and high) and in "Show as a table". Touch/pointer
// scrubbing snaps a crosshair to the nearest day; the readout lives in a row
// above the plot instead of a floating tooltip, since on a phone the finger
// covers exactly the point being read.
//
// Time ranges (lib/chart-range.ts): buttons under the plot pick a fixed range,
// and with nothing scrubbed the readout shows how much the range moved. Two
// fingers (or a mouse drag) MEASURE instead: the change between two days.
// Explanations of the lines sit behind an info button, not under every chart.
//
// Estimated points carry `estimated: true` and draw as a dashed segment, with
// an "estimated" readout suffix so the region reads as what it is: an
// estimate, not a recorded balance. They are either reconstructed from
// transaction history (see /api/backfill) or, in the net-worth total, a
// straight line across days nothing was recorded (bridgeInteriorEstimates in
// lib/history.ts). A segment joining two points more than a day apart draws
// dashed too, even between real points: every day it spans is unmeasured.
// When the range has no recorded stretch at all (no segment joins two
// recorded points, however far apart, as in a history estimated up to a
// recorded today), dashes would set nothing apart: the line is drawn solid,
// and the readout, the label and the info say once that it is estimated,
// so an estimate never reads as recorded. The look can change with the
// range: a range that reaches a recorded stretch is dashed and solid again.
// A run of recorded points that is dashed only for the days between them
// (a shared net worth, one point a week) stays dashed, whatever estimates
// sit among them.
//
// Notes on the timeline (#50, lib/timeline-notes.ts) mark their days: a
// dotted rule and a small marker, never a change to the line, so a step (an
// account that closed, a house bought) stays as it happened and says what it
// was. Scrubbing to a marked day puts its note in the readout, on the date's
// own line and cut to fit it, so the readout never grows under the finger;
// the whole note is in the list. For keyboard and screen reader, the notes in
// the range are listed under the chart as buttons that select their day, and
// the selection is announced.
//
// As Home's hero (`hero`, look and feel step 5) it runs edge to edge under
// the figure, its months kept inside the page's gutter and the today dot
// ringed in the page; a pointer's scrub moves the hero's figure
// (components/hero-scrub.ts) instead of the readout, which keeps the range's
// change. Elsewhere (an account's sheet, a shared net worth) it keeps to its
// card, in the shape it has always had, and the readout reads the day under
// the finger.

import { useCallback, useContext, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { formatMoney, spoken } from '@/lib/format';
import { Masked } from './HideAmounts';
import { Segmented } from './Segmented';
import { MIN_LABEL_GAP as LABEL_GAP, labelWidth, useDrawnWidth } from './drawn-width';
import { HeroScrub } from './hero-scrub';
import {
  availableRanges,
  axisTickLadder,
  initialRange,
  rangeLabel,
  sliceRange,
  touchGesture,
  type RangeKey,
  type RangeSet,
} from '@/lib/chart-range';

export type HistoryPoint = { date: string; value: number; estimated?: boolean };
type Baseline = { date: string; value: number }[] | null;
/** A note on the timeline: its day, and what it says. */
export type ChartNote = { date: string; text: string };

/** The plot's box, at the width it is drawn at: `inset` is how far in from
 *  either side the months keep. */
type Frame = { W: number; H: number; left: number; right: number; top: number; bottom: number; inset: number; hero: boolean };
/** A card's chart keeps the shape it has always had (150 to 340), its
 *  months inside its own box, which sits inside the card's padding. */
const cardFrame = (W: number): Frame => ({ W, H: Math.round((W * 150) / 340), left: 8, right: 10, top: 8, bottom: 20, inset: 0, hero: false });
/** The hero's line runs from the screen's edge to the today dot's ring (4 +
 *  2), 120px of plot over 20 for the months, which keep to the page's
 *  gutter, in line with the text above. */
const heroFrame = (W: number): Frame => ({ W, H: 140, left: 2, right: 8, top: 8, bottom: 20, inset: 16, hero: true });
/** How far sideways a finger on the hero goes before it scrubs, in CSS
 *  pixels: less, and it may be the start of a scroll. */
const SIDEWAYS = 6;
const DAY_MS = 24 * 60 * 60 * 1000;
/** The gap a step of month labels needs between neighbours, edge to edge,
 *  to be chosen: twice the least, since a label drawn in Red Hat at 12px can
 *  run wider than labelWidth's estimate. */
const AXIS_GAP = 2 * LABEL_GAP;

// Every figure prints in the series' own currency. No currency (a shared
// net-worth total, which has none of its own) formats as "$", as it always
// did; Home's hero passes the currency its figure is in.

// Signed, for money added and growth: "+$1,200.00" / "-$80.00".
function signed(n: number, currency?: string | null): string {
  return (n < 0 ? '-' : '+') + formatMoney(Math.abs(n), currency);
}

function fmtDay(iso: string, withYear = false): string {
  return new Date(`${iso}T00:00:00`).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    ...(withYear ? { year: 'numeric' } : {}),
  });
}

const RANGE_TEXT: Record<RangeKey, string> = {
  '1M': '1M',
  '3M': '3M',
  '6M': '6M',
  YTD: 'YTD',
  '1Y': '1Y',
  '3Y': '3Y',
  '5Y': '5Y',
  ALL: 'All',
};

export default function NetWorthChart({
  points: allPoints,
  label = 'Net worth',
  baselineFor,
  currency,
  rangeSet = 'balance',
  initialRange: forcedRange,
  owed = false,
  reserveSplit = false,
  notes,
  hero = false,
}: {
  points: HistoryPoint[];
  label?: string;
  /** ISO currency of the series (an account's), for every figure the chart prints. */
  currency?: string | null;
  /** The balance at the start of the points given plus money added since, by
   *  date (lib/growth.ts), drawn as a thin grey line; the balance above it is
   *  growth. Called with the points of the selected range, so the split counts
   *  from the range's start. Must be stable (useCallback). */
  baselineFor?: ((points: HistoryPoint[]) => Baseline) | null;
  /** Which ranges to offer: months for balances, years for investments. */
  rangeSet?: RangeSet;
  /** Open on this range instead of the set's usual one (a preview shows All). */
  initialRange?: RangeKey;
  /** A debt: its change has no percentage, which would read as a return.
   *  Nor does an investment's: its change includes money added, and the
   *  added and growth line says how much of it is growth. */
  owed?: boolean;
  /** Keep the added-and-growth line's space even while it has nothing to say
   *  (the account's transactions are still loading): it appears in the same
   *  place instead of pushing the chart down when they arrive. */
  reserveSplit?: boolean;
  /** Notes on the timeline, marked on their days (see the header). */
  notes?: readonly ChartNote[];
  /** Home's hero: edge to edge, its scrub moving the figure above (see the
   *  header). */
  hero?: boolean;
}) {
  const svgRef = useRef<SVGSVGElement | null>(null);
  // Drawn at its own width, in the hero's frame or a card's.
  const [drawnRef, drawnW] = useDrawnWidth<SVGSVGElement>();
  const frame = useMemo(() => (hero ? heroFrame(drawnW) : cardFrame(drawnW)), [hero, drawnW]);
  const { W, H } = frame;
  // The SVG itself is the one measured: the hero's is wider than its box, by
  // the bleed.
  const plotRef = useCallback(
    (el: SVGSVGElement | null) => {
      svgRef.current = el;
      drawnRef(el);
    },
    [drawnRef],
  );
  const report = useContext(HeroScrub);
  // A pointer on the plot (a finger, a pen, a mouse over it): only its day
  // moves the hero's figure, never one a note chosen from the list selects.
  const [scrubbing, setScrubbing] = useState(false);
  // The table renders its rows only while it is open.
  const [tableOpen, setTableOpen] = useState(false);
  const [activeState, setActive] = useState<number | null>(null);
  const [measureState, setMeasure] = useState<[number, number] | null>(null);
  const [picked, setPicked] = useState<RangeKey | null>(forcedRange ?? null);
  const [showInfo, setShowInfo] = useState(false);
  // The note last chosen from the list, for the announcement.
  const [chosenNote, setChosenNote] = useState<number | null>(null);
  const infoId = useId();
  // Pointers down on the plot (id -> clientX), and where a mouse drag began.
  const pointers = useRef(new Map<number, number>());
  const dragFrom = useRef<number | null>(null);
  // Where the first finger or pen went down, to tell a scrub from a scroll.
  const touchFrom = useRef<{ x: number; y: number } | null>(null);

  const ranges = useMemo(() => availableRanges(allPoints, rangeSet), [allPoints, rangeSet]);
  const range =
    picked && ranges.includes(picked)
      ? picked
      : initialRange(ranges, rangeSet, allPoints[allPoints.length - 1]?.date ?? '');
  const points = useMemo(() => sliceRange(allPoints, range), [allPoints, range]);

  // Scrubbed and measured days are indices into `points`: new points (a
  // reload, or another range) make them point at other days, or past the end.
  // Cleared here, during render, so this render never reads a stale one.
  const [gesturePoints, setGesturePoints] = useState(points);
  let active = activeState;
  let measure = measureState;
  if (gesturePoints !== points) {
    setGesturePoints(points);
    setActive(null);
    setMeasure(null);
    setChosenNote(null);
    active = null;
    measure = null;
  }
  const baseline = useMemo(() => (baselineFor ? baselineFor(points) : null), [baselineFor, points]);

  // Geometry depends only on the data -- memoized so per-pointermove
  // re-renders during scrubbing don't recompute every path.
  const geo = useMemo(() => {
    // points arrive date-sorted ascending from the API
    const ts = points.map((p) => new Date(`${p.date}T00:00:00Z`).getTime());
    const vals = points.map((p) => p.value);
    // Aligned to the balance points by date; null before the baseline starts.
    const byDate = new Map((baseline ?? []).map((b) => [b.date, b.value] as const));
    const base = points.map((p) => byDate.get(p.date) ?? null);
    const inRange = [...vals, ...base.filter((b): b is number => b !== null)];
    const minT = ts[0];
    const maxT = ts[ts.length - 1];
    let lo = Math.min(...inRange);
    let hi = Math.max(...inRange);
    if (lo === hi) {
      // Flat series: open up a band so the line sits mid-chart.
      const bump = Math.abs(lo) * 0.05 + 1;
      lo -= bump;
      hi += bump;
    }
    const padV = (hi - lo) * 0.06;
    lo -= padV;
    hi += padV;

    const { left, right, top, bottom } = frame;
    const spanT = maxT - minT || 1;
    const x = (t: number) => left + ((t - minT) / spanT) * (W - left - right);
    const y = (v: number) => top + (1 - (v - lo) / (hi - lo)) * (H - top - bottom);

    const xs = ts.map(x);
    const pt = (i: number) => `${xs[i].toFixed(1)},${y(vals[i]).toFixed(1)}`;

    // Split the line into solid (real) and dashed (estimated) runs. A segment
    // touching an estimated point draws dashed, so the style changes exactly
    // at the boundary between reconstructed and recorded history. So does one
    // that skips days: a solid line across a three-week hole would claim
    // three weeks of measurements that were never taken.
    //
    // Unless no stretch of the range is recorded (`uniform`, see the header):
    // no segment, of any length, joins two recorded points. A segment between
    // two recorded points is recorded at both its ends, so a line of recorded
    // points a week apart never qualifies through an estimated week (or an
    // estimated Sunday beside a recorded Monday). Then the line is one solid
    // run, said in words instead.
    const gaps = points.map((_, i) => i > 0 && ts[i] - ts[i - 1] > DAY_MS);
    const touches = (i: number) => !!(points[i].estimated || points[i - 1].estimated);
    let recordedSegment = false;
    for (let i = 1; i < points.length; i++) if (!touches(i)) recordedSegment = true;
    const uniform = points.length > 1 && !recordedSegment;
    const runs: { est: boolean; d: string }[] = [];
    const hasGap = gaps.some(Boolean);
    for (let i = 1; i < points.length; i++) {
      const est = !uniform && (touches(i) || gaps[i]);
      const prev = runs[runs.length - 1];
      if (prev && prev.est === est) prev.d += `L${pt(i)}`;
      else runs.push({ est, d: `M${pt(i - 1)}L${pt(i)}` });
    }

    // One path: the baseline has a value for every point from its start on.
    const baseStart = base.findIndex((b) => b !== null);
    const basePath =
      baseStart < 0
        ? ''
        : base
            .map((b, i) => (b === null ? '' : `${i === baseStart ? 'M' : 'L'}${xs[i].toFixed(1)},${y(b).toFixed(1)}`))
            .join('');

    // Time axis: 12px labels at recognisable dates, each kept inside the
    // frame's inset (the hero's page gutter; a card's own box), anchored so
    // none runs past it. Of the ladder of whole steps (every month, every
    // two...), the densest whose labels all sit AXIS_GAP apart by their
    // widths, so every month that fits is labelled and they stay evenly
    // spaced; a label whose day falls outside the inset is left out, not
    // moved, and a step left with none is passed over. Where no step fits,
    // the sparsest, dropping any label that would crowd the one before it.
    type XTick = { x: number; label: string; anchor: 'start' | 'middle' | 'end' };
    const fromX = Math.max(frame.inset, left);
    const toX = Math.min(W - frame.inset, W - right);
    const place = (step: { date: string; label: string }[], drop: boolean): XTick[] | null => {
      const out: XTick[] = [];
      let lastEnd = -Infinity;
      for (const t of step) {
        const tx = x(Date.parse(`${t.date}T00:00:00Z`));
        if (tx < fromX || tx > toX) continue;
        const w = labelWidth(t.label);
        const anchor = tx - w / 2 < frame.inset ? 'start' : tx + w / 2 > W - frame.inset ? 'end' : 'middle';
        const from = anchor === 'start' ? tx : anchor === 'end' ? tx - w : tx - w / 2;
        if (from - lastEnd < AXIS_GAP) {
          // An end label, pushed in from the edge, that crowds the one
          // before it is left out: the step is still evenly spaced. So is a
          // first label pushed in from the start, when it crowds this one.
          if (anchor === 'end') continue;
          if (out.length === 1 && out[0].anchor === 'start') out.pop();
          else if (!drop) return null;
          else continue;
        }
        lastEnd = from + w;
        out.push({ x: tx, label: t.label, anchor });
      }
      return out;
    };
    const ladder = axisTickLadder(points[0].date, points[points.length - 1].date);
    let xTicks: XTick[] = [];
    for (const step of ladder) {
      const fits = place(step, false);
      if (fits && fits.length > 0) {
        xTicks = fits;
        break;
      }
    }
    if (xTicks.length === 0 && ladder.length > 0) xTicks = place(ladder[ladder.length - 1], true) ?? [];

    const outline = points.map((_, i) => `${i === 0 ? 'M' : 'L'}${pt(i)}`).join('');
    const baseY = H - bottom;
    const area = `${outline}L${xs[xs.length - 1].toFixed(1)},${baseY}L${xs[0].toFixed(1)},${baseY}Z`;
    return { vals, xs, y, runs, uniform, area, baseY, xTicks, hasGap, base, basePath, baseStart };
  }, [points, baseline, frame, W, H]);

  // The notes in the range, a day each (several notes on one day join), each
  // at the point on its day, or the first one after it: where its step shows.
  const marked = useMemo(() => {
    if (!notes || notes.length === 0 || points.length === 0) return [];
    const first = points[0].date;
    const lastDay = points[points.length - 1].date;
    const byDay = new Map<string, string[]>();
    for (const n of notes) if (n.date >= first && n.date <= lastDay) byDay.set(n.date, [...(byDay.get(n.date) ?? []), n.text]);
    return [...byDay]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([date, texts]) => ({ date, text: texts.join('; '), index: Math.max(0, points.findIndex((p) => p.date >= date)) }));
  }, [notes, points]);
  /** The note text on a point, if any. */
  const noteOn = (i: number) => {
    const here = marked.filter((m) => m.index === i);
    return here.length > 0 ? here.map((m) => m.text).join('; ') : null;
  };

  const { vals, xs, y, runs, uniform, area, baseY, xTicks, hasGap, base, basePath, baseStart } = geo;
  const last = points.length - 1;
  const hasEstimated = points.some((p) => p.estimated) || hasGap;
  // Dates carry the year once the range crosses one, or "Mar 3" is ambiguous.
  const withYear = points[0].date.slice(0, 4) !== points[last].date.slice(0, 4);
  const day = (i: number) => fmtDay(points[i].date, withYear);
  // A line drawn solid because none of it is recorded says so in words,
  // true to the days that are: a recorded today, or a few recorded days.
  let estimatedWords = '';
  if (uniform) {
    const recorded = points.flatMap((p, i) => (p.estimated ? [] : [i]));
    const except = recorded.length === 0 ? '' : recorded.length === 1 ? `, except ${day(recorded[0])}` : `, except ${recorded.length} recorded days`;
    // Not "from transactions": a day bridged between two others is a
    // straight line across days with no data (lib/history.ts).
    estimatedWords = `Estimated, not recorded${except}.`;
  }

  /**
   * Money added and growth from the baseline's start to point i, or null.
   *
   * Null on an estimated point: that value is the balance walked back from
   * whenever backfill last ran, with no market movement in it, so "growth"
   * there would be whatever the walk left behind. The summary with nothing
   * scrubbed uses the last REAL point for the same reason.
   */
  function split(i: number): { added: number; growth: number } | null {
    const b = base[i];
    if (b === null || baseStart < 0 || points[i].estimated) return null;
    return { added: b - (base[baseStart] as number), growth: vals[i] - b };
  }
  /** The same between two points, for a measurement. */
  function splitBetween(i: number, j: number): { added: number; growth: number } | null {
    const bi = base[i];
    const bj = base[j];
    if (bi === null || bj === null || points[i].estimated || points[j].estimated) return null;
    const added = bj - bi;
    return { added, growth: vals[j] - vals[i] - added };
  }
  /** "+$2,340.00 (+4.1%)", marked approximate when it starts or ends on an
   *  estimate. No percentage for a debt or an investment (see `owed`), or
   *  from a zero or negative start. */
  function change(i: number, j: number): { text: string; approx: boolean } {
    const d = vals[j] - vals[i];
    const pct = !owed && rangeSet !== 'investment' && vals[i] > 0 ? ` (${d < 0 ? '-' : '+'}${Math.abs((d / vals[i]) * 100).toFixed(1)}%)` : '';
    const approx = !!(points[i].estimated || points[j].estimated);
    return { text: `${approx ? '≈ ' : ''}${signed(d, currency)}${pct}`, approx };
  }

  // The last real point the baseline reaches: it can stop short of the end
  // when the flows are only known up to an earlier day.
  let lastReal = last;
  while (lastReal > 0 && (points[lastReal].estimated || base[lastReal] === null)) lastReal--;
  const rangeChange = change(0, last);

  let splitText = '';
  if (measure) {
    const s = splitBetween(measure[0], measure[1]);
    if (s) splitText = `${signed(s.added, currency)} added · ${signed(s.growth, currency)} growth`;
  } else {
    const s = split(active ?? lastReal);
    if (s) {
      splitText =
        (active === null ? `${day(baseStart)} to ${day(lastReal)}: ` : '') +
        `${signed(s.added, currency)} added · ${signed(s.growth, currency)} growth`;
    }
  }

  const info: string[] = [];
  if (baseStart >= 0) {
    info.push(`Grey line: the balance on ${day(baseStart)} plus money added since. The gap above it is growth.`);
  }
  if (uniform) info.push(`${estimatedWords} No stretch of this range is recorded, so the line is solid.`);
  else if (hasEstimated) info.push('Dashed: estimated, from transactions or across days with no data.');
  if (rangeChange.approx) info.push('≈: the change starts or ends on an estimated balance.');
  if (marked.length > 0) info.push('Dotted lines mark your notes: touch the day to read one, or pick it from the list below.');
  info.push('Touch with two fingers, or drag with a mouse, to compare two days.');

  function indexAt(clientX: number): number {
    const svg = svgRef.current;
    if (!svg) return 0;
    const rect = svg.getBoundingClientRect();
    const px = ((clientX - rect.left) / rect.width) * W;
    let best = 0;
    let bestDist = Infinity;
    for (let i = 0; i < xs.length; i++) {
      const d = Math.abs(xs[i] - px);
      if (d < bestDist) {
        bestDist = d;
        best = i;
      }
    }
    return best;
  }

  // Touch and pen: one finger scrubs, two measure between them.
  function fromTouches() {
    const g = touchGesture([...pointers.current.values()].map(indexAt));
    setActive(g.active);
    setMeasure(g.measure);
  }

  function onPointerDown(e: React.PointerEvent<SVGSVGElement>) {
    // Only the main mouse button; a right-click opens the menu, not a drag.
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    setChosenNote(null);
    // A mouse scrubs at once. A finger or a pen on the hero may be starting
    // to scroll the page (pan-y), which the browser cancels a few pixels
    // later: it moves the figure only once it goes sideways (onPointerMove).
    if (e.pointerType === 'mouse') setScrubbing(true);
    else if (pointers.current.size === 0) touchFrom.current = { x: e.clientX, y: e.clientY };
    // Captured by the chart itself, for every kind of pointer: otherwise a
    // touch is captured by the dot or crosshair it landed on, which is
    // replaced as it moves, and a finger lifted off the chart would never
    // report its pointerup and stay "down" for good.
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      // No active pointer to capture (a synthetic event): nothing to keep.
    }
    if (e.pointerType === 'mouse') {
      e.preventDefault(); // no text selection while dragging
      dragFrom.current = indexAt(e.clientX);
      setMeasure(null);
      setActive(dragFrom.current);
      return;
    }
    pointers.current.set(e.pointerId, e.clientX);
    fromTouches();
  }

  function onPointerMove(e: React.PointerEvent<SVGSVGElement>) {
    if (e.pointerType === 'mouse') {
      const i = indexAt(e.clientX);
      // A drag begun before the points changed started on another chart.
      if (dragFrom.current !== null && dragFrom.current > last) dragFrom.current = null;
      if (dragFrom.current !== null && e.buttons & 1) {
        // Dragging with the button held: measure from where it went down.
        const g = touchGesture([dragFrom.current, i]);
        setMeasure(g.measure);
        setActive(g.active);
      } else {
        setActive(i);
      }
      setScrubbing(true);
      return;
    }
    if (!pointers.current.has(e.pointerId)) return;
    pointers.current.set(e.pointerId, e.clientX);
    fromTouches();
    // Sideways past a few pixels: a scrub, not the start of a scroll.
    const from = touchFrom.current;
    if (from && !scrubbing) {
      const dx = Math.abs(e.clientX - from.x);
      if (dx >= SIDEWAYS && dx > Math.abs((e.clientY ?? from.y) - from.y)) setScrubbing(true);
    }
  }

  function onPointerEnd(e: React.PointerEvent<SVGSVGElement>) {
    if (e.pointerType === 'mouse') {
      dragFrom.current = null;
      setMeasure(null);
      return;
    }
    if (!pointers.current.delete(e.pointerId)) return; // already ended
    fromTouches();
    if (pointers.current.size === 0) {
      setScrubbing(false);
      touchFrom.current = null;
    }
  }

  function onPointerLeave(e: React.PointerEvent<SVGSVGElement>) {
    // A captured mouse drag keeps its events; a plain hover ends here. Touch
    // ends in onPointerEnd.
    if (e.pointerType === 'mouse' && dragFrom.current === null) {
      setActive(null);
      setScrubbing(false);
    }
  }

  function pickRange(key: RangeKey) {
    setPicked(key);
    setActive(null);
    setMeasure(null);
    setChosenNote(null);
    setScrubbing(false);
  }

  /** A note chosen from the list: its day is scrubbed to, and announced. */
  function chooseNote(i: number) {
    setMeasure(null);
    setActive(marked[i].index);
    setChosenNote(i);
    setScrubbing(false);
  }

  // The hero's figure follows a pointer's day (never a measurement's, which
  // is too long for its line, nor a note chosen from the list), in the same
  // frame as the plot; gone when the pointer is, or the chart.
  const heroDay = hero && scrubbing && !measure && active !== null && points[active] ? active : null;
  const heroValue = heroDay === null ? null : vals[heroDay];
  const heroText = heroDay === null ? '' : day(heroDay);
  const heroEstimated = heroDay !== null && !!points[heroDay].estimated;
  const heroNote = heroDay === null ? null : noteOn(heroDay);
  useLayoutEffect(() => {
    if (!hero || !report) return;
    report(heroValue === null ? null : { value: heroValue, day: heroText, estimated: heroEstimated, note: heroNote });
    return () => report(null);
  }, [hero, report, heroValue, heroText, heroEstimated, heroNote]);
  // In the hero, the readout keeps the range's change while a pointer moves
  // the figure; a note chosen from the list still reads its day here.
  const readActive = hero && scrubbing ? null : active;

  let readValue: string;
  let readDate: string;
  let readNote: string | null = null;
  if (measure) {
    readValue = change(measure[0], measure[1]).text;
    readDate = `${day(measure[0])} to ${day(measure[1])}`;
  } else if (readActive !== null) {
    readValue = formatMoney(vals[readActive], currency);
    readNote = noteOn(readActive);
    readDate = `${day(readActive)}${points[readActive].estimated ? ' · estimated' : ''}`;
  } else {
    readValue = rangeChange.text;
    // Said once here when the line is solid for being all an estimate.
    readDate = `${rangeLabel(range, points[0].date, points[last].date)}${uniform ? ' · estimated' : ''}`;
  }

  return (
    <div>
      <div className="chart-readout chart-readout-stable">
        <span className="chart-readout-value">
          <Masked>{readValue}</Masked>
        </span>
        {readNote ? (
          <span className="chart-readout-date chart-readout-noted">
            <span className="chart-readout-day">{readDate}</span>
            <span className="chart-readout-note">{`\u00a0·\u00a0${readNote}`}</span>
          </span>
        ) : (
          <span className="chart-readout-date">{readDate}</span>
        )}
        <button
          type="button"
          className="chart-info-btn"
          aria-label="About this chart"
          aria-expanded={showInfo}
          aria-controls={infoId}
          onClick={() => setShowInfo((s) => !s)}
        >
          <svg viewBox="0 0 16 16" aria-hidden="true">
            <circle cx="8" cy="8" r="6.5" fill="none" stroke="currentColor" strokeWidth="1.3" />
            <circle cx="8" cy="5" r="0.9" fill="currentColor" />
            <path d="M8 7.2v4.3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
          </svg>
        </button>
      </div>
      {/* The line keeps its height whenever the chart can show it at all, so
          scrubbing to a day without a split (or the data arriving late) moves
          nothing below it. */}
      {(splitText || reserveSplit || baselineFor) && (
        <div className="chart-readout-split">{splitText ? <Masked>{splitText}</Masked> : <>&nbsp;</>}</div>
      )}

      <svg
        ref={plotRef}
        className={hero ? 'chart-svg at-width hero-chart' : 'chart-svg at-width'}
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-label={spoken(
          `${label} from ${day(0)} to ${day(last)}. Currently ${formatMoney(vals[last], currency)}. Low ${formatMoney(Math.min(...vals), currency)}, high ${formatMoney(Math.max(...vals), currency)}.${marked.length > 0 ? ` ${marked.length === 1 ? 'One note is' : `${marked.length} notes are`} marked, listed below the chart.` : ''}${uniform ? ` ${estimatedWords}` : ''}`
        )}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerEnd}
        onPointerCancel={onPointerEnd}
        onLostPointerCapture={onPointerEnd}
        onPointerLeave={onPointerLeave}
      >
        {/* No gridlines and no money on the plot: the scale is in the
            readout, the label and the table. */}
        {/* the measured stretch, shaded between its two days */}
        {measure && (
          <rect
            x={xs[measure[0]]}
            y={frame.top}
            width={xs[measure[1]] - xs[measure[0]]}
            height={baseY - frame.top}
            fill="var(--accent)"
            opacity={0.12}
          />
        )}

        <path d={area} fill="var(--accent)" opacity={hero ? 0.12 : 0.1} />
        {basePath && (
          <path
            className="chart-baseline"
            d={basePath}
            fill="none"
            stroke="var(--text-2)"
            strokeWidth={1.25}
            strokeLinejoin="round"
            strokeLinecap="round"
          />
        )}
        {runs.map((run, i) => (
          <path
            key={i}
            d={run.d}
            fill="none"
            stroke="var(--accent)"
            strokeWidth={2}
            strokeLinejoin="round"
            strokeLinecap="round"
            strokeDasharray={run.est ? '5 4' : undefined}
            opacity={run.est ? 0.75 : 1}
          />
        ))}

        {/* notes: a dotted rule on each marked day, and a small marker at
            its foot; the chosen one's in full. The line itself is untouched. */}
        {marked.map((m) => {
          const on = active === m.index;
          return (
            <g key={m.date} className="chart-note-mark" opacity={on ? 1 : 0.6}>
              <line x1={xs[m.index]} x2={xs[m.index]} y1={frame.top} y2={baseY} stroke="var(--warn)" strokeWidth={1} strokeDasharray="1 3" />
              <path d={`M${xs[m.index].toFixed(1)},${baseY - 7}l3.5,3.5l-3.5,3.5l-3.5,-3.5Z`} fill="var(--warn)" />
            </g>
          );
        })}

        {/* crosshairs: one while scrubbing, two while measuring */}
        {(measure ?? (active !== null ? [active] : [])).map((i) => (
          <line key={i} x1={xs[i]} x2={xs[i]} y1={frame.top} y2={baseY} stroke="var(--border-strong)" strokeWidth={1} />
        ))}

        {/* end-dot (or the active or measured dots) with a 2px ring in what
            is behind it: the card, or the page under the hero */}
        {(measure ?? [active ?? last]).map((i) => (
          <circle key={i} cx={xs[i]} cy={y(vals[i])} r={4} fill="var(--accent)" stroke={hero ? 'var(--canvas)' : 'var(--surface)'} strokeWidth={2} />
        ))}

        {/* time axis */}
        {xTicks.map((t) => (
          <text key={t.x} className="chart-xlabel" x={t.x} y={H - 6} textAnchor={t.anchor}>
            {t.label}
          </text>
        ))}
      </svg>

      {ranges.length > 1 && (
        <Segmented compact className="chart-range-switch" label="Time range" value={range} onChange={pickRange} options={ranges.map((key) => [key, RANGE_TEXT[key]] as const)} />
      )}

      {/* The notes in the range, for a keyboard and a screen reader: each
          selects its day, as scrubbing to it does. */}
      {marked.length > 0 && (
        <ul className="chart-notes" aria-label="Notes on this chart">
          {marked.map((m, i) => (
            <li key={m.date}>
              <button type="button" className="chart-note-btn" aria-pressed={active === m.index} onClick={() => chooseNote(i)} onFocus={() => chooseNote(i)}>
                <span className="chart-note-day">{fmtDay(m.date, withYear)}</span> {m.text}
              </button>
            </li>
          ))}
        </ul>
      )}
      <p className="visually-hidden" aria-live="polite">
        {chosenNote !== null && marked[chosenNote] && points[marked[chosenNote].index]
          ? spoken(`${fmtDay(marked[chosenNote].date, true)}: ${marked[chosenNote].text}. ${label} ${formatMoney(vals[marked[chosenNote].index], currency)} on ${day(marked[chosenNote].index)}.`)
          : ''}
      </p>

      {/* The plot has no money on it: every point in the range, newest
          first, for anyone who can't read the line. Its rows render only
          while it is open, and through Masked each time (never memoized as
          text), so hide amounts masks them. */}
      <details className="plan-table-view" onToggle={(e) => setTableOpen(e.currentTarget.open)}>
        <summary>Show as a table</summary>
        {tableOpen && (
          <table>
            <thead>
              <tr>
                <th>Day</th>
                <th className="num">{label}</th>
              </tr>
            </thead>
            <tbody>
              {points
                .map((p, i) => (
                  <tr key={p.date}>
                    <td>
                      {day(i)}
                      {p.estimated ? ' · estimated' : ''}
                    </td>
                    <td className="num">
                      <Masked>{formatMoney(p.value, currency)}</Masked>
                    </td>
                  </tr>
                ))
                .reverse()}
            </tbody>
          </table>
        )}
      </details>

      {/* In the markup even while closed (hidden), so it is one tap to show and
          the page never shifts while loading it. */}
      <div id={infoId} className="chart-info" hidden={!showInfo}>
        {info.map((n) => (
          <p key={n}>{n}</p>
        ))}
      </div>
    </div>
  );
}
