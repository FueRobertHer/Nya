'use client';

// The fan chart for a simulated plan: the balance year by year as percentile
// bands across every start (or run). One hue, as on the other charts: the
// median a 2px accent line, the middle half (25th to 75th percentile) a
// darker wash, the middle 80% (10th to 90th) a lighter one. Dependency-free
// SVG in the same house style as NetWorthChart: hairline gridlines with clean
// tick values, labels in the muted text colour, and a readout row above the
// plot instead of a tooltip, since on a phone the finger covers the point
// being read. Scrubbing snaps to the nearest year. A table of the same
// figures sits behind "Show as a table" for anyone who can't read the plot.

import { useMemo, useRef, useState } from 'react';
import type { Bands } from '@/lib/fire/simulate';
import { compactMoney } from '@/lib/format';
import { wholeMoney } from './plan-text';

const W = 340;
const H = 160;
const PAD_LEFT = 8;
const PAD_RIGHT = 10;
const PAD_TOP = 12;
const PAD_BOTTOM = 20;

// 2-3 clean tick values (1/2/5 x 10^n steps) from 0 to max, as the other charts.
function niceTicks(max: number): number[] {
  const span = max || 1;
  const rough = span / 2.5;
  const mag = Math.pow(10, Math.floor(Math.log10(rough)));
  const norm = rough / mag;
  const step = (norm >= 5 ? 5 : norm >= 2 ? 2 : 1) * mag;
  const out: number[] = [];
  for (let v = 0; v <= max + 1e-9; v += step) out.push(v);
  return out;
}

export default function PlanFanChart({
  bands,
  startAge,
  currency,
}: {
  /** Balance percentiles at the start of each year and at the end (years + 1 points). */
  bands: Bands;
  /** Labels the axis with ages when known, plan years otherwise. */
  startAge: number | null;
  currency: string | null;
}) {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const [active, setActive] = useState<number | null>(null);
  const years = bands.p50.length - 1;

  const geo = useMemo(() => {
    const top = Math.max(...bands.p90, 1) * 1.06;
    const x = (y: number) => PAD_LEFT + (y / Math.max(years, 1)) * (W - PAD_LEFT - PAD_RIGHT);
    const yv = (v: number) => PAD_TOP + (1 - v / top) * (H - PAD_TOP - PAD_BOTTOM);
    const xs = bands.p50.map((_, i) => x(i));
    const pt = (i: number, v: number) => `${xs[i].toFixed(1)},${yv(v).toFixed(1)}`;
    // A band is its upper edge left to right, then its lower edge back.
    const band = (hi: number[], lo: number[]) =>
      `M${hi.map((v, i) => pt(i, v)).join('L')}L${lo
        .map((v, i) => pt(i, v))
        .reverse()
        .join('L')}Z`;
    const step = years <= 20 ? 5 : 10;
    const xTicks: { x: number; label: string; anchor: 'start' | 'middle' | 'end' }[] = [];
    for (let y = 0; y <= years; y += step) {
      const tx = x(y);
      const anchor = y === 0 ? 'start' : years - y < step / 2 ? 'end' : 'middle';
      const label = startAge !== null ? `${y === 0 ? 'age ' : ''}${startAge + y}` : `${y === 0 ? 'year ' : ''}${y}`;
      // The last tick would crowd the plan's end; the end label replaces it.
      if (y > 0 && years - y < step / 2) continue;
      xTicks.push({ x: tx, label, anchor });
    }
    xTicks.push({
      x: x(years),
      label: startAge !== null ? `${startAge + years}` : `${years}`,
      anchor: 'end',
    });
    return {
      xs,
      yv,
      outer: band(bands.p90, bands.p10),
      inner: band(bands.p75, bands.p25),
      median: bands.p50.map((v, i) => `${i === 0 ? 'M' : 'L'}${pt(i, v)}`).join(''),
      ticks: niceTicks(top / 1.06),
      xTicks,
      baseY: H - PAD_BOTTOM,
    };
  }, [bands, years, startAge]);

  const { xs, yv, outer, inner, median, ticks, xTicks, baseY } = geo;
  const i = active ?? years;
  const when = (y: number) => (startAge !== null ? `age ${startAge + y}` : `year ${y}`);
  const whenLong = (y: number) =>
    y === years ? `at the end (${when(y)})` : y === 0 ? `at the start (${when(0)})` : `at ${when(y)}`;

  function scrub(clientX: number) {
    const svg = svgRef.current;
    if (!svg) return;
    const rect = svg.getBoundingClientRect();
    const px = ((clientX - rect.left) / rect.width) * W;
    let best = 0;
    let bestDist = Infinity;
    for (let k = 0; k < xs.length; k++) {
      const d = Math.abs(xs[k] - px);
      if (d < bestDist) {
        bestDist = d;
        best = k;
      }
    }
    setActive(best);
  }

  const tableYears: number[] = [];
  for (let y = 0; y < years; y += 5) tableYears.push(y);
  tableYears.push(years);

  return (
    <div>
      <div className="chart-readout chart-readout-stable">
        <span className="chart-readout-value">Median {wholeMoney(bands.p50[i], currency)}</span>
        <span className="chart-readout-date">
          {whenLong(i)} · middle 80%: {wholeMoney(bands.p10[i], currency)} to {wholeMoney(bands.p90[i], currency)}
        </span>
      </div>

      <svg
        ref={svgRef}
        className="chart-svg"
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-label={`Balance over ${years} years in today's dollars. At the end: median ${wholeMoney(bands.p50[years], currency)}, middle 80% ${wholeMoney(bands.p10[years], currency)} to ${wholeMoney(bands.p90[years], currency)}.`}
        onPointerMove={(e) => scrub(e.clientX)}
        onPointerDown={(e) => scrub(e.clientX)}
        onPointerLeave={() => setActive(null)}
      >
        {ticks.map((t) => (
          <g key={t}>
            <line x1={PAD_LEFT} x2={W - PAD_RIGHT} y1={yv(t)} y2={yv(t)} stroke="#262a33" strokeWidth={1} />
            <text className="chart-tick" x={PAD_LEFT} y={yv(t) - 3}>
              {compactMoney(t, currency)}
            </text>
          </g>
        ))}

        <path d={outer} fill="var(--accent)" opacity={0.12} />
        <path d={inner} fill="var(--accent)" opacity={0.22} />
        <path d={median} fill="none" stroke="var(--accent)" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />

        {active !== null && <line x1={xs[i]} x2={xs[i]} y1={PAD_TOP} y2={baseY} stroke="#3a4150" strokeWidth={1} />}
        <circle cx={xs[i]} cy={yv(bands.p50[i])} r={4} fill="var(--accent)" stroke="var(--card)" strokeWidth={2} />

        {xTicks.map((t) => (
          <text key={`${t.x}-${t.label}`} className="chart-xlabel" x={t.x} y={H - 6} textAnchor={t.anchor}>
            {t.label}
          </text>
        ))}
      </svg>

      <div className="chart-legend plan-legend">
        <span className="chart-legend-item">
          <span className="plan-legend-line" />
          Median
        </span>
        <span className="chart-legend-item">
          <span className="plan-legend-swatch inner" />
          Middle half
        </span>
        <span className="chart-legend-item">
          <span className="plan-legend-swatch outer" />
          Middle 80%
        </span>
      </div>

      <details className="plan-table-view">
        <summary>Show as a table</summary>
        <table>
          <thead>
            <tr>
              <th>{startAge !== null ? 'Age' : 'Year'}</th>
              <th className="num">10th</th>
              <th className="num">Median</th>
              <th className="num">90th</th>
            </tr>
          </thead>
          <tbody>
            {tableYears.map((y) => (
              <tr key={y}>
                <td>{startAge !== null ? startAge + y : y}</td>
                <td className="num">{wholeMoney(bands.p10[y], currency)}</td>
                <td className="num">{wholeMoney(bands.p50[y], currency)}</td>
                <td className="num">{wholeMoney(bands.p90[y], currency)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </div>
  );
}
