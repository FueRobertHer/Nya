'use client';

// Two-series line chart for a period (a month, or the months the Activity
// tab's Spending is set to): cumulative income (up hue) and cumulative spend
// (down hue) running day by day, so you can read where in the period
// spending overtook (or stayed under) income. Dependency-free
// inline SVG, same house style as NetWorthChart, but with two series it
// carries a small legend, and the scrub readout shows both values at once.
// It is drawn at its own width (components/drawn-width.ts), in today's
// shape, so its text is the 12px it says on a phone and on a wide card.
//
// Transfers and loan payments are excluded (same rule as the rest of the
// Activity tab, lib/spending.ts) so credit-card payments don't double-count,
// and so is anything the person excluded or in another currency than the
// tab's totals (the Activity tab names what that left out). For a period
// that holds today the x-axis stops at today rather than trailing a flat line
// to its end (a row dated later in it counts in the period's totals, not
// here). Every day's two running totals sit behind "Show as a table", for
// anyone who can't read the lines. The plot is read by the keys too
// (components/chart-keys.ts): the arrows move the readout a day at a time.

import { useMemo, useState, type PointerEvent } from 'react';
import { type Txn } from './MonthBreakdown';
import { countsInTotals, totalsCurrency } from '@/lib/spending';
import { formatDay, formatMoney, compactMoney, spoken } from '@/lib/format';
import { Masked } from './HideAmounts';
import { lastDayOf } from '@/lib/cash-flow';
import { localDate } from '@/lib/local-date';
import { FALLBACK_WIDTH, useDrawnWidth } from './drawn-width';
import { keysHelp, useChartKeys } from './chart-keys';

/** Its height for its width: 150 to 340, the shape it has always had. */
const ASPECT = 150 / FALLBACK_WIDTH;
const PAD_LEFT = 8;
const PAD_RIGHT = 10;
// Room over the top tick for its 12px figure.
const PAD_TOP = 14;
// Room under the baseline's dots for the 12px dates.
const PAD_BOTTOM = 24;

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
  const [drawnRef, W] = useDrawnWidth<SVGSVGElement>();
  const H = Math.round(W * ASPECT);
  const [active, setActive] = useState<number | null>(null);
  // The table renders its rows only while it is open.
  const [tableOpen, setTableOpen] = useState(false);
  const currency = useMemo(() => (given !== undefined ? given : totalsCurrency(txns)), [given, txns]);

  const today = localDate();
  const whole = month ?? today.slice(0, 7);
  const first = givenFrom ?? `${whole}-01`;
  const last = givenTo ?? lastDayOf(whole);
  const geo = useMemo(() => {
    // Don't trail a flat line into the future for a period that holds today.
    const toDate = first <= today && today <= last;
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
  }, [txns, first, last, today, currency, W, H]);

  const { days, cumIn, cumOut, xs, y, inPath, outPath, baseY, ticks, toDate, totalIn, totalOut } = geo;
  const lastAt = days.length - 1;
  // With the year when the period reaches into another year than today's.
  const withYear = first.slice(0, 4) !== today.slice(0, 4) || last.slice(0, 4) !== today.slice(0, 4);

  // A day read on screen: "Today", "Oct 5", "Oct 5, 2025" (lib/format.ts
  // formatDay, on `today`'s calendar); `sentence` in the middle of one.
  const now = new Date(`${today}T12:00:00`);
  const dayLabel = (day: string, sentence = false) => formatDay(day, { now, sentence });

  /** The axis's ends, as a chart's axis names them. */
  function axisDay(day: string): string {
    return new Date(`${day}T12:00:00Z`).toLocaleDateString(undefined, {
      month: 'short',
      day: 'numeric',
      ...(withYear ? { year: 'numeric' as const } : {}),
      timeZone: 'UTC',
    });
  }

  function scrub(e: PointerEvent<SVGSVGElement>) {
    const rect = e.currentTarget.getBoundingClientRect();
    const px = ((e.clientX - rect.left) / rect.width) * W;
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
  const keys = useChartKeys({
    count: days.length,
    active,
    setActive,
    say: (k) => `In ${formatMoney(cumIn[k], currency)}, out ${formatMoney(cumOut[k], currency)}, through ${dayLabel(days[k], true)}`,
  });

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
          {active !== null || !toDate ? `through ${dayLabel(days[i], true)}` : 'to date'}
        </span>
      </div>

      <svg
        ref={drawnRef}
        className="chart-svg at-width"
        viewBox={`0 0 ${W} ${H}`}
        role="slider"
        {...keys.slider}
        aria-label={spoken(`Cumulative income and spending for ${dayLabel(days[0], true)} to ${dayLabel(days[lastAt], true)}. Income ${formatMoney(totalIn, currency)}, spending ${formatMoney(totalOut, currency)}.`)}
        onPointerMove={scrub}
        onPointerDown={scrub}
        onPointerLeave={() => setActive(null)}
      >
        {ticks.map((t) => (
          <g key={t}>
            <line x1={PAD_LEFT} x2={W - PAD_RIGHT} y1={y(t)} y2={y(t)} stroke="var(--border-subtle)" strokeWidth={1} />
            <text className="chart-tick" x={PAD_LEFT} y={y(t) - 3}>
              {compactMoney(t, currency)}
            </text>
          </g>
        ))}

        <path d={outPath} fill="none" stroke="var(--down)" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
        <path d={inPath} fill="none" stroke="var(--up)" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />

        {active !== null && (
          <line x1={xs[i]} x2={xs[i]} y1={PAD_TOP} y2={baseY} stroke="var(--border-strong)" strokeWidth={1} />
        )}

        <circle cx={xs[i]} cy={y(cumOut[i])} r={4} fill="var(--down)" stroke="var(--card)" strokeWidth={2} />
        <circle cx={xs[i]} cy={y(cumIn[i])} r={4} fill="var(--up)" stroke="var(--card)" strokeWidth={2} />

        <text className="chart-xlabel" x={PAD_LEFT} y={H - 6}>
          {axisDay(days[0])}
        </text>
        <text className="chart-xlabel" x={W - PAD_RIGHT} y={H - 6} textAnchor="end">
          {axisDay(days[lastAt])}
        </text>
      </svg>
      <p id={keys.helpId} className="visually-hidden">
        {keysHelp('day')}
      </p>

      {/* Every day's running totals, oldest first as the lines run. Rows
          render only while it is open, and through Masked each time, so hide
          amounts masks them. */}
      <details className="plan-table-view" onToggle={(e) => setTableOpen(e.currentTarget.open)}>
        <summary>Show as a table</summary>
        {tableOpen && (
          <table>
            <caption>Each day’s totals include the days before it.</caption>
            <thead>
              <tr>
                <th scope="col">Day</th>
                <th scope="col" className="num">
                  In
                </th>
                <th scope="col" className="num">
                  Out
                </th>
              </tr>
            </thead>
            <tbody>
              {days.map((d, k) => (
                <tr key={d}>
                  <td>{dayLabel(d)}</td>
                  <td className="num">
                    <Masked>{formatMoney(cumIn[k], currency)}</Masked>
                  </td>
                  <td className="num">
                    <Masked>{formatMoney(cumOut[k], currency)}</Masked>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </details>
    </div>
  );
}
