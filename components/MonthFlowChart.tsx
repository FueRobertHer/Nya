'use client';

// Two-series line chart for a period (a month, or the months the Activity
// tab's Spending is set to): cumulative income (up hue) and cumulative spend
// (down hue) running day by day, so you can read where in the period
// spending overtook (or stayed under) income. Dependency-free
// inline SVG, same house style as NetWorthChart, but with two series it
// carries a small legend, and the scrub readout shows both values at once.
//
// Transfers and loan payments are excluded (same rule as the rest of the
// Activity tab, lib/spending.ts) so credit-card payments don't double-count,
// and so is anything the person excluded or in another currency than the
// tab's totals (the Activity tab names what that left out). For a period
// that holds today the x-axis stops at today rather than trailing a flat line
// to its end (a row dated later in it counts in the period's totals, not
// here).

import { useMemo, useRef, useState } from 'react';
import { type Txn } from './MonthBreakdown';
import { countsInTotals, totalsCurrency } from '@/lib/spending';
import { formatMoney, compactMoney, spoken } from '@/lib/format';
import { Masked } from './HideAmounts';
import { lastDayOf } from '@/lib/cash-flow';
import { localDate } from '@/lib/local-date';

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

/** The calendar day after `day`. */
const nextDay = (day: string): string => new Date(Date.parse(`${day}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);

export default function MonthFlowChart({
  txns,
  month,
  from: givenFrom,
  to: givenTo,
  currency: given,
}: {
  txns: Txn[];
  /** A whole month (YYYY-MM), or the period's first and last days. */
  month?: string;
  from?: string;
  to?: string;
  /** The currency of the totals it sits with; else the one most of `txns` are in. */
  currency?: string | null;
}) {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const [active, setActive] = useState<number | null>(null);
  const currency = useMemo(() => (given !== undefined ? given : totalsCurrency(txns)), [given, txns]);

  const today = localDate();
  const first = givenFrom ?? `${month}-01`;
  const last = givenTo ?? lastDayOf(month ?? today.slice(0, 7));
  const geo = useMemo(() => {
    // Don't trail a flat line into the future for a period that holds today.
    const toDate = first <= today && today < last;
    const end = toDate ? today : last;

    // Per-day money in / out, then a running total across the period.
    const days: string[] = [];
    for (let d = first; d <= end; d = nextDay(d)) days.push(d);
    if (days.length === 0) days.push(first);
    const at = new Map(days.map((d, i) => [d, i]));
    const inByDay = new Array(days.length).fill(0);
    const outByDay = new Array(days.length).fill(0);
    for (const t of txns) {
      if (!countsInTotals(t, currency)) continue;
      const i = at.get(t.date);
      if (i === undefined) continue;
      if (t.amount < 0) inByDay[i] += -t.amount;
      else outByDay[i] += t.amount;
    }

    const cumIn: number[] = [];
    const cumOut: number[] = [];
    let ri = 0;
    let ro = 0;
    for (let i = 0; i < days.length; i++) {
      ri += inByDay[i];
      ro += outByDay[i];
      cumIn.push(ri);
      cumOut.push(ro);
    }

    const hi = Math.max(ri, ro, 1);
    const padV = hi * 0.06;
    const lo = 0;
    const top = hi + padV;

    const spanD = days.length - 1 || 1;
    const x = (i: number) => PAD_LEFT + (i / spanD) * (W - PAD_LEFT - PAD_RIGHT);
    const yScale = (v: number) => PAD_TOP + (1 - (v - lo) / (top - lo)) * (H - PAD_TOP - PAD_BOTTOM);

    const xs = days.map((_, i) => x(i));
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
      toDate,
      totalIn: ri,
      totalOut: ro,
    };
  }, [txns, first, last, today, currency]);

  const { days, cumIn, cumOut, xs, y, inPath, outPath, baseY, ticks, toDate, totalIn, totalOut } = geo;
  const lastAt = days.length - 1;
  // With the year when the period reaches into another year than today's.
  const withYear = first.slice(0, 4) !== today.slice(0, 4) || last.slice(0, 4) !== today.slice(0, 4);

  function dayLabel(day: string): string {
    return new Date(`${day}T12:00:00Z`).toLocaleDateString(undefined, {
      month: 'short',
      day: 'numeric',
      ...(withYear ? { year: 'numeric' as const } : {}),
      timeZone: 'UTC',
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

  const i = active ?? lastAt;

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
          <Masked>{formatMoney(cumIn[i], currency)}</Masked>
        </span>
        <span className="chart-readout-value" style={{ color: 'var(--down)' }}>
          <Masked>{formatMoney(cumOut[i], currency)}</Masked>
        </span>
        <span className="chart-readout-date">
          {active !== null || !toDate ? `through ${dayLabel(days[i])}` : 'to date'}
        </span>
      </div>

      <svg
        ref={svgRef}
        className="chart-svg"
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-label={spoken(`Cumulative income and spending for ${dayLabel(days[0])} to ${dayLabel(days[lastAt])}. Income ${formatMoney(totalIn, currency)}, spending ${formatMoney(totalOut, currency)}.`)}
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
          {dayLabel(days[0])}
        </text>
        <text className="chart-xlabel" x={W - PAD_RIGHT} y={H - 6} textAnchor="end">
          {dayLabel(days[lastAt])}
        </text>
      </svg>
    </div>
  );
}
