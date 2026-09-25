'use client';

// Single-series net-worth-over-time line chart. Dependency-free inline SVG.
//
// Follows the house dataviz specs: 2px round-capped line in the accent hue,
// area wash at ~10% opacity, >=8px end-dot with a 2px surface ring, hairline
// solid gridlines with clean tick values, muted text tokens for all labels
// (never the series color), no legend for a single series. Touch/pointer
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

import { useId, useMemo, useRef, useState } from 'react';
import { formatMoney, compactMoney } from '@/lib/format';
import {
  availableRanges,
  axisTicks,
  initialRange,
  rangeLabel,
  sliceRange,
  type RangeKey,
  type RangeSet,
} from '@/lib/chart-range';

export type HistoryPoint = { date: string; value: number; estimated?: boolean };
type Baseline = { date: string; value: number }[] | null;

const W = 340;
const H = 150;
const PAD_LEFT = 8;
const PAD_RIGHT = 10;
const PAD_TOP = 12;
const PAD_BOTTOM = 20;
const DAY_MS = 24 * 60 * 60 * 1000;
/** Closest two axis labels may sit, in viewBox units, before one is dropped. */
const MIN_LABEL_GAP = 30;

// Every figure prints in the series' own currency. No currency (the net-worth
// total, which has none of its own) formats as "$", as it always did.

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

// 2-3 clean tick values (1/2/5 x 10^n steps) inside [min, max].
function niceTicks(min: number, max: number): number[] {
  const span = max - min || 1;
  const rough = span / 2.5;
  const mag = Math.pow(10, Math.floor(Math.log10(rough)));
  const norm = rough / mag;
  const step = (norm >= 5 ? 5 : norm >= 2 ? 2 : 1) * mag;
  const out: number[] = [];
  for (let v = Math.ceil(min / step) * step; v <= max + 1e-9; v += step) out.push(v);
  return out;
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
  /** A debt: its change has no percentage, which would read as a return. */
  owed?: boolean;
}) {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const [active, setActive] = useState<number | null>(null);
  const [measure, setMeasure] = useState<[number, number] | null>(null);
  const [picked, setPicked] = useState<RangeKey | null>(forcedRange ?? null);
  const [showInfo, setShowInfo] = useState(false);
  const infoId = useId();
  // Pointers down on the plot (id -> clientX), and where a mouse drag began.
  const pointers = useRef(new Map<number, number>());
  const dragFrom = useRef<number | null>(null);

  const ranges = useMemo(() => availableRanges(allPoints, rangeSet), [allPoints, rangeSet]);
  const range = picked && ranges.includes(picked) ? picked : initialRange(ranges, rangeSet);
  const points = useMemo(() => sliceRange(allPoints, range), [allPoints, range]);
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

    const spanT = maxT - minT || 1;
    const x = (t: number) => PAD_LEFT + ((t - minT) / spanT) * (W - PAD_LEFT - PAD_RIGHT);
    const y = (v: number) => PAD_TOP + (1 - (v - lo) / (hi - lo)) * (H - PAD_TOP - PAD_BOTTOM);

    const xs = ts.map(x);
    const pt = (i: number) => `${xs[i].toFixed(1)},${y(vals[i]).toFixed(1)}`;

    // Split the line into solid (real) and dashed (estimated) runs. A segment
    // touching an estimated point draws dashed, so the style changes exactly
    // at the boundary between reconstructed and recorded history. So does one
    // that skips days: a solid line across a three-week hole would claim
    // three weeks of measurements that were never taken.
    const runs: { est: boolean; d: string }[] = [];
    let hasGap = false;
    for (let i = 1; i < points.length; i++) {
      const gap = ts[i] - ts[i - 1] > DAY_MS;
      if (gap) hasGap = true;
      const est = !!(points[i].estimated || points[i - 1].estimated || gap);
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

    // Time axis: labels at recognisable dates, anchored so none runs off the
    // plot, and dropped where two would collide.
    const xTicks: { x: number; label: string; anchor: 'start' | 'middle' | 'end' }[] = [];
    for (const t of axisTicks(points[0].date, points[points.length - 1].date)) {
      const tx = x(Date.parse(`${t.date}T00:00:00Z`));
      if (tx < PAD_LEFT || tx > W - PAD_RIGHT) continue;
      if (xTicks.length > 0 && tx - xTicks[xTicks.length - 1].x < MIN_LABEL_GAP) continue;
      const anchor = tx < PAD_LEFT + 16 ? 'start' : tx > W - PAD_RIGHT - 16 ? 'end' : 'middle';
      xTicks.push({ x: tx, label: t.label, anchor });
    }

    const outline = points.map((_, i) => `${i === 0 ? 'M' : 'L'}${pt(i)}`).join('');
    const baseY = H - PAD_BOTTOM;
    const area = `${outline}L${xs[xs.length - 1].toFixed(1)},${baseY}L${xs[0].toFixed(1)},${baseY}Z`;
    return { vals, xs, y, runs, area, baseY, ticks: niceTicks(lo, hi), xTicks, hasGap, base, basePath, baseStart };
  }, [points, baseline]);

  const { vals, xs, y, runs, area, baseY, ticks, xTicks, hasGap, base, basePath, baseStart } = geo;
  const last = points.length - 1;
  const hasEstimated = points.some((p) => p.estimated) || hasGap;
  // Dates carry the year once the range crosses one, or "Mar 3" is ambiguous.
  const withYear = points[0].date.slice(0, 4) !== points[last].date.slice(0, 4);
  const day = (i: number) => fmtDay(points[i].date, withYear);

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
   *  estimate. No percentage for a debt, or from a zero or negative start. */
  function change(i: number, j: number): { text: string; approx: boolean } {
    const d = vals[j] - vals[i];
    const pct = !owed && vals[i] > 0 ? ` (${d < 0 ? '-' : '+'}${Math.abs((d / vals[i]) * 100).toFixed(1)}%)` : '';
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

  const notes: string[] = [];
  if (baseStart >= 0) {
    notes.push(`Grey line: the balance on ${day(baseStart)} plus money added since. The gap above it is growth.`);
  }
  if (hasEstimated) notes.push('Dashed: estimated, from transactions or across days with no data.');
  if (rangeChange.approx) notes.push('≈: the change starts or ends on an estimated balance.');
  notes.push('Touch with two fingers, or drag with a mouse, to compare two days.');

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

  /** Two indices in order, or null when they're the same day. */
  function pair(a: number, b: number): [number, number] | null {
    return a === b ? null : a < b ? [a, b] : [b, a];
  }

  // Touch: one finger scrubs, two measure between them.
  function fromTouches() {
    const at = [...pointers.current.values()].map(indexAt);
    if (at.length >= 2) {
      const m = pair(at[0], at[1]);
      setMeasure(m);
      setActive(m ? null : at[0]);
    } else if (at.length === 1) {
      setMeasure(null);
      setActive(at[0]);
    } else {
      setMeasure(null);
      setActive(null);
    }
  }

  function onPointerDown(e: React.PointerEvent<SVGSVGElement>) {
    if (e.pointerType === 'mouse') {
      dragFrom.current = indexAt(e.clientX);
      e.currentTarget.setPointerCapture?.(e.pointerId);
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
      if (dragFrom.current !== null && e.buttons & 1) {
        // Dragging with the button held: measure from where it went down.
        const m = pair(dragFrom.current, i);
        setMeasure(m);
        setActive(m ? null : i);
      } else {
        setActive(i);
      }
      return;
    }
    if (!pointers.current.has(e.pointerId)) return;
    pointers.current.set(e.pointerId, e.clientX);
    fromTouches();
  }

  function onPointerEnd(e: React.PointerEvent<SVGSVGElement>) {
    if (e.pointerType === 'mouse') {
      dragFrom.current = null;
      setMeasure(null);
      return;
    }
    pointers.current.delete(e.pointerId);
    fromTouches();
  }

  function onPointerLeave(e: React.PointerEvent<SVGSVGElement>) {
    // A captured mouse drag keeps its events; a plain hover ends here. Touch
    // ends in onPointerEnd.
    if (e.pointerType === 'mouse' && dragFrom.current === null) setActive(null);
  }

  function pickRange(key: RangeKey) {
    setPicked(key);
    setActive(null);
    setMeasure(null);
  }

  let readValue: string;
  let readDate: string;
  if (measure) {
    readValue = change(measure[0], measure[1]).text;
    readDate = `${day(measure[0])} to ${day(measure[1])}`;
  } else if (active !== null) {
    readValue = formatMoney(vals[active], currency);
    readDate = `${day(active)}${points[active].estimated ? ' · estimated' : ''}`;
  } else {
    readValue = rangeChange.text;
    readDate = rangeLabel(range, points[0].date);
  }

  return (
    <div>
      <div className="chart-readout">
        <span className="chart-readout-value">{readValue}</span>
        <span className="chart-readout-date">{readDate}</span>
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
      {splitText && <div className="chart-readout-split">{splitText}</div>}

      <svg
        ref={svgRef}
        className="chart-svg"
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-label={`${label} from ${day(0)} to ${day(last)}. Currently ${formatMoney(vals[last], currency)}. Low ${formatMoney(Math.min(...vals), currency)}, high ${formatMoney(Math.max(...vals), currency)}.`}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerEnd}
        onPointerCancel={onPointerEnd}
        onPointerLeave={onPointerLeave}
      >
        {/* recessive hairline gridlines with clean tick values */}
        {ticks.map((t) => (
          <g key={t}>
            <line x1={PAD_LEFT} x2={W - PAD_RIGHT} y1={y(t)} y2={y(t)} stroke="#262a33" strokeWidth={1} />
            <text className="chart-tick" x={PAD_LEFT} y={y(t) - 3}>
              {compactMoney(t, currency)}
            </text>
          </g>
        ))}

        {/* the measured stretch, shaded between its two days */}
        {measure && (
          <rect
            x={xs[measure[0]]}
            y={PAD_TOP}
            width={xs[measure[1]] - xs[measure[0]]}
            height={baseY - PAD_TOP}
            fill="var(--accent)"
            opacity={0.12}
          />
        )}

        <path d={area} fill="var(--accent)" opacity={0.1} />
        {basePath && (
          <path
            className="chart-baseline"
            d={basePath}
            fill="none"
            stroke="var(--muted)"
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

        {/* crosshairs: one while scrubbing, two while measuring */}
        {(measure ?? (active !== null ? [active] : [])).map((i) => (
          <line key={i} x1={xs[i]} x2={xs[i]} y1={PAD_TOP} y2={baseY} stroke="#3a4150" strokeWidth={1} />
        ))}

        {/* end-dot (or the active or measured dots) with a 2px surface ring */}
        {(measure ?? [active ?? last]).map((i) => (
          <circle key={i} cx={xs[i]} cy={y(vals[i])} r={4} fill="var(--accent)" stroke="var(--card)" strokeWidth={2} />
        ))}

        {/* time axis */}
        {xTicks.map((t) => (
          <text key={t.x} className="chart-xlabel" x={t.x} y={H - 6} textAnchor={t.anchor}>
            {t.label}
          </text>
        ))}
      </svg>

      {ranges.length > 1 && (
        <div className="chart-ranges" role="group" aria-label="Time range">
          {ranges.map((key) => (
            <button
              key={key}
              type="button"
              className="chart-range"
              aria-pressed={key === range}
              onClick={() => pickRange(key)}
            >
              {RANGE_TEXT[key]}
            </button>
          ))}
        </div>
      )}

      {/* In the markup even while closed (hidden), so it is one tap to show and
          the page never shifts while loading it. */}
      <div id={infoId} className="chart-info" hidden={!showInfo}>
        {notes.map((n) => (
          <p key={n}>{n}</p>
        ))}
      </div>
    </div>
  );
}
