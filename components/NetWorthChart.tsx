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
// Backfilled points (reconstructed from transaction history, see
// /api/backfill) carry `estimated: true` and draw as a dashed segment, with
// a caption and an "estimated" readout suffix so the region reads as what it
// is: an estimate, not a recorded balance.

import { useMemo, useRef, useState } from 'react';

export type HistoryPoint = { date: string; value: number; estimated?: boolean };

const W = 340;
const H = 150;
const PAD_LEFT = 8;
const PAD_RIGHT = 10;
const PAD_TOP = 12;
const PAD_BOTTOM = 20;

function fullUsd(n: number): string {
  return (n < 0 ? '-$' : '$') + Math.abs(n).toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

// Compact currency for axis ticks: $12.5K / -$1.2M
function compactUsd(n: number): string {
  const sign = n < 0 ? '-' : '';
  const abs = Math.abs(n);
  if (abs >= 1e6) return `${sign}$${(abs / 1e6).toFixed(1)}M`;
  if (abs >= 1e3) return `${sign}$${(abs / 1e3).toFixed(1)}K`;
  return `${sign}$${Math.round(abs)}`;
}

function fmtDay(iso: string): string {
  return new Date(`${iso}T00:00:00`).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
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

export default function NetWorthChart({
  points,
  label = 'Net worth',
}: {
  points: HistoryPoint[];
  label?: string;
}) {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const [active, setActive] = useState<number | null>(null);

  // Geometry depends only on the data -- memoized so per-pointermove
  // re-renders during scrubbing don't recompute every path.
  const geo = useMemo(() => {
    // points arrive date-sorted ascending from the API
    const ts = points.map((p) => new Date(`${p.date}T00:00:00Z`).getTime());
    const vals = points.map((p) => p.value);
    const minT = ts[0];
    const maxT = ts[ts.length - 1];
    let lo = Math.min(...vals);
    let hi = Math.max(...vals);
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
    // at the boundary between reconstructed and recorded history.
    const runs: { est: boolean; d: string }[] = [];
    for (let i = 1; i < points.length; i++) {
      const est = !!(points[i].estimated || points[i - 1].estimated);
      const prev = runs[runs.length - 1];
      if (prev && prev.est === est) prev.d += `L${pt(i)}`;
      else runs.push({ est, d: `M${pt(i - 1)}L${pt(i)}` });
    }

    const outline = points.map((_, i) => `${i === 0 ? 'M' : 'L'}${pt(i)}`).join('');
    const baseY = H - PAD_BOTTOM;
    const area = `${outline}L${xs[xs.length - 1].toFixed(1)},${baseY}L${xs[0].toFixed(1)},${baseY}Z`;
    return { vals, xs, y, runs, area, baseY, ticks: niceTicks(lo, hi) };
  }, [points]);

  const { vals, xs, y, runs, area, baseY, ticks } = geo;
  const last = points.length - 1;
  const hasEstimated = points.some((p) => p.estimated);

  function scrub(clientX: number) {
    const svg = svgRef.current;
    if (!svg) return;
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
    setActive(best);
  }

  return (
    <div>
      <div className="chart-readout">
        {active !== null ? (
          <>
            <span className="chart-readout-value">{fullUsd(vals[active])}</span>
            <span className="chart-readout-date">
              {fmtDay(points[active].date)}
              {points[active].estimated ? ' · estimated' : ''}
            </span>
          </>
        ) : (
          <span className="chart-readout-date">
            {fmtDay(points[0].date)} – {fmtDay(points[last].date)}
          </span>
        )}
      </div>

      <svg
        ref={svgRef}
        className="chart-svg"
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-label={`${label} from ${fmtDay(points[0].date)} to ${fmtDay(points[last].date)}. Currently ${fullUsd(vals[last])}. Low ${fullUsd(Math.min(...vals))}, high ${fullUsd(Math.max(...vals))}.`}
        onPointerMove={(e) => scrub(e.clientX)}
        onPointerDown={(e) => scrub(e.clientX)}
        onPointerLeave={() => setActive(null)}
      >
        {/* recessive hairline gridlines with clean tick values */}
        {ticks.map((t) => (
          <g key={t}>
            <line x1={PAD_LEFT} x2={W - PAD_RIGHT} y1={y(t)} y2={y(t)} stroke="#262a33" strokeWidth={1} />
            <text className="chart-tick" x={PAD_LEFT} y={y(t) - 3}>
              {compactUsd(t)}
            </text>
          </g>
        ))}

        <path d={area} fill="var(--accent)" opacity={0.1} />
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

        {/* crosshair snapped to the nearest day while scrubbing */}
        {active !== null && (
          <line
            x1={xs[active]}
            x2={xs[active]}
            y1={PAD_TOP}
            y2={baseY}
            stroke="#3a4150"
            strokeWidth={1}
          />
        )}

        {/* end-dot (or active dot) with a 2px surface ring */}
        <circle
          cx={xs[active ?? last]}
          cy={y(vals[active ?? last])}
          r={4}
          fill="var(--accent)"
          stroke="var(--card)"
          strokeWidth={2}
        />

        {/* first/last date labels */}
        <text className="chart-xlabel" x={PAD_LEFT} y={H - 6}>
          {fmtDay(points[0].date)}
        </text>
        <text className="chart-xlabel" x={W - PAD_RIGHT} y={H - 6} textAnchor="end">
          {fmtDay(points[last].date)}
        </text>
      </svg>

      {hasEstimated && (
        <div className="chart-note">Dashed segment is estimated from transaction history.</div>
      )}
    </div>
  );
}
