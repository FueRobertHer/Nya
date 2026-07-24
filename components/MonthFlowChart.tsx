'use client';

// Two-series line chart for a single month: cumulative income (up hue) and
// cumulative spend (down hue) running day by day, so you can read where in
// the month spending overtook (or stayed under) income. Dependency-free
// inline SVG, same house style as NetWorthChart — but with two series it
// carries a small legend, and the scrub readout shows both values at once.
//
// Transfers and loan payments are excluded (same rule as the rest of the
// Activity tab) so credit-card payments don't double-count. For the current
// month the x-axis stops at today rather than trailing a flat line to
// month-end.

import { useMemo, useRef, useState } from 'react';
import { isTransfer, type Txn } from './MonthBreakdown';
import { formatMoney, compactMoney, dominantCurrency } from '@/lib/format';

const W = 340;
const H = 150;
const PAD_LEFT = 8;
const PAD_RIGHT = 10;
const PAD_TOP = 12;
const PAD_BOTTOM = 20;

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

export default function MonthFlowChart({ txns, month }: { txns: Txn[]; month: string }) {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const [active, setActive] = useState<number | null>(null);
  const currency = useMemo(() => dominantCurrency(txns), [txns]);

  const geo = useMemo(() => {
    const [y, m] = month.split('-').map(Number);
    const daysInMonth = new Date(y, m, 0).getDate();
    // Don't trail a flat line into the future for the current month.
    const now = new Date();
    const isCurrent = now.getFullYear() === y && now.getMonth() + 1 === m;
    const lastDay = isCurrent ? Math.min(now.getDate(), daysInMonth) : daysInMonth;

    // Per-day money in / out, then a running total across the month.
    const inByDay = new Array(lastDay + 1).fill(0);
    const outByDay = new Array(lastDay + 1).fill(0);
    for (const t of txns) {
      if (isTransfer(t)) continue;
      const day = Number(t.date.slice(8, 10));
      if (day < 1 || day > lastDay) continue;
      if (t.amount < 0) inByDay[day] += -t.amount;
      else outByDay[day] += t.amount;
    }

    const days: number[] = [];
    const cumIn: number[] = [];
    const cumOut: number[] = [];
    let ri = 0;
    let ro = 0;
    for (let d = 1; d <= lastDay; d++) {
      ri += inByDay[d];
      ro += outByDay[d];
      days.push(d);
      cumIn.push(ri);
      cumOut.push(ro);
    }

    const hi = Math.max(ri, ro, 1);
    const padV = hi * 0.06;
    const lo = 0;
    const top = hi + padV;

    const spanD = lastDay - 1 || 1;
    const x = (d: number) => PAD_LEFT + ((d - 1) / spanD) * (W - PAD_LEFT - PAD_RIGHT);
    const yScale = (v: number) => PAD_TOP + (1 - (v - lo) / (top - lo)) * (H - PAD_TOP - PAD_BOTTOM);

    const xs = days.map(x);
    const line = (vals: number[]) =>
      vals.map((v, i) => `${i === 0 ? 'M' : 'L'}${xs[i].toFixed(1)},${yScale(v).toFixed(1)}`).join('');

    return {
      days,
      cumIn,
      cumOut,
      xs,
      y: yScale,
      inPath: line(cumIn),
      outPath: line(cumOut),
      baseY: H - PAD_BOTTOM,
      ticks: niceTicks(lo, top),
      lastDay,
      monthYear: { y, m },
      totalIn: ri,
      totalOut: ro,
    };
  }, [txns, month]);

  const { days, cumIn, cumOut, xs, y, inPath, outPath, baseY, ticks, lastDay, monthYear, totalIn, totalOut } = geo;
  const last = days.length - 1;

  function dayLabel(d: number): string {
    return new Date(monthYear.y, monthYear.m - 1, d).toLocaleDateString(undefined, {
      month: 'short',
      day: 'numeric',
    });
  }

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

  const i = active ?? last;

  return (
    <div>
      <div className="chart-legend">
        <span className="chart-legend-item">
          <span className="chart-legend-dot" style={{ background: 'var(--up)' }} />
          In
        </span>
        <span className="chart-legend-item">
          <span className="chart-legend-dot" style={{ background: 'var(--down)' }} />
          Out
        </span>
      </div>

      <div className="chart-readout">
        <span className="chart-readout-value" style={{ color: 'var(--up)' }}>
          {formatMoney(cumIn[i], currency)}
        </span>
        <span className="chart-readout-value" style={{ color: 'var(--down)' }}>
          {formatMoney(cumOut[i], currency)}
        </span>
        <span className="chart-readout-date">
          {active !== null ? `through ${dayLabel(days[i])}` : `month to date`}
        </span>
      </div>

      <svg
        ref={svgRef}
        className="chart-svg"
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-label={`Cumulative income and spending for ${dayLabel(1)} to ${dayLabel(lastDay)}. Income ${formatMoney(totalIn, currency)}, spending ${formatMoney(totalOut, currency)}.`}
        onPointerMove={(e) => scrub(e.clientX)}
        onPointerDown={(e) => scrub(e.clientX)}
        onPointerLeave={() => setActive(null)}
      >
        {ticks.map((t) => (
          <g key={t}>
            <line x1={PAD_LEFT} x2={W - PAD_RIGHT} y1={y(t)} y2={y(t)} stroke="#262a33" strokeWidth={1} />
            <text className="chart-tick" x={PAD_LEFT} y={y(t) - 3}>
              {compactMoney(t, currency)}
            </text>
          </g>
        ))}

        <path d={outPath} fill="none" stroke="var(--down)" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
        <path d={inPath} fill="none" stroke="var(--up)" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />

        {active !== null && (
          <line x1={xs[i]} x2={xs[i]} y1={PAD_TOP} y2={baseY} stroke="#3a4150" strokeWidth={1} />
        )}

        <circle cx={xs[i]} cy={y(cumOut[i])} r={4} fill="var(--down)" stroke="var(--card)" strokeWidth={2} />
        <circle cx={xs[i]} cy={y(cumIn[i])} r={4} fill="var(--up)" stroke="var(--card)" strokeWidth={2} />

        <text className="chart-xlabel" x={PAD_LEFT} y={H - 6}>
          {dayLabel(1)}
        </text>
        <text className="chart-xlabel" x={W - PAD_RIGHT} y={H - 6} textAnchor="end">
          {dayLabel(lastDay)}
        </text>
      </svg>
    </div>
  );
}
