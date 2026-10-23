'use client';

// The runway as two lines (lib/report/runway.ts): the cash going forward
// without income and with it, in the house style of ForecastChart and
// NetWorthChart: dependency-free inline SVG, a readout row above the plot
// instead of a floating tooltip, scrubbed by pointer. Both lines are dashed
// throughout, as every estimate is drawn: only the first point, the cash now,
// is measured. Zero is drawn when either line comes near it, and the day each
// runs out is marked.

import { useMemo, useRef, useState } from 'react';
import type { RunwayProjection } from '@/lib/report/runway';
import { compactMoney, formatMoney, spoken } from '@/lib/format';
import { Masked } from './HideAmounts';
import { reportDay } from './ReportView';

const W = 340;
const H = 150;
const PAD_LEFT = 8;
const PAD_RIGHT = 10;
const PAD_TOP = 12;
const PAD_BOTTOM = 20;

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

/** Whole days from one calendar day to another. */
const daysBetween = (from: string, to: string) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);

export default function RunwayChart({ projection, currency }: { projection: RunwayProjection; currency: string | null }) {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const [active, setActive] = useState<number | null>(null);
  const points = projection.chart;
  const today = points[0].date;
  const days = (date: string) => daysBetween(today, date);
  const spanDays = Math.max(1, days(points[points.length - 1].date));

  const geo = useMemo(() => {
    const days = (date: string) => daysBetween(points[0].date, date);
    const values = points.flatMap((p) => [p.without, p.with]);
    let lo = Math.min(...values);
    let hi = Math.max(...values);
    const span = hi - lo || Math.max(Math.abs(hi), 1);
    const showZero = 0 >= lo - span * 0.2 && 0 <= hi + span * 0.2;
    if (showZero) {
      lo = Math.min(lo, 0);
      hi = Math.max(hi, 0);
    }
    const pad = (hi - lo || Math.max(Math.abs(hi), 1)) * 0.08;
    const bottom = lo - pad;
    const top = hi + pad;
    const x = (d: number) => PAD_LEFT + (d / spanDays) * (W - PAD_LEFT - PAD_RIGHT);
    const y = (v: number) => PAD_TOP + (1 - (v - bottom) / (top - bottom)) * (H - PAD_TOP - PAD_BOTTOM);
    const path = (key: 'without' | 'with') => points.map((p, k) => `${k === 0 ? 'M' : 'L'}${x(days(p.date)).toFixed(1)},${y(p[key]).toFixed(1)}`).join('');
    return { x, y, ticks: niceTicks(bottom, top), without: path('without'), with: path('with'), showZero };
  }, [points, spanDays]);

  const { x, y, ticks, showZero } = geo;
  const marks = [
    { date: projection.without_income.runs_out, key: 'without' as const, color: 'var(--down)' },
    { date: projection.with_income.runs_out, key: 'with' as const, color: 'var(--warn)' },
  ].filter((m): m is { date: string; key: 'without' | 'with'; color: string } => m.date !== null && points.some((p) => p.date === m.date));

  function scrub(clientX: number) {
    const svg = svgRef.current;
    if (!svg) return;
    const rect = svg.getBoundingClientRect();
    const px = ((clientX - rect.left) / rect.width) * W;
    const d = ((px - PAD_LEFT) / (W - PAD_LEFT - PAD_RIGHT)) * spanDays;
    let best = 0;
    for (let k = 1; k < points.length; k++) if (Math.abs(days(points[k].date) - d) < Math.abs(days(points[best].date) - d)) best = k;
    setActive(best);
  }

  const shown = active === null ? null : points[active];
  const last = points[points.length - 1];
  const tone = (v: number) => (v < 0 ? 'var(--down)' : undefined);

  return (
    <div className="runway-chart">
      <div className="chart-legend">
        <span className="chart-legend-item">
          <span className="chart-legend-dot" style={{ background: 'var(--accent)' }} />
          With income
        </span>
        <span className="chart-legend-item">
          <span className="chart-legend-dot" style={{ background: 'var(--down)' }} />
          Without income
        </span>
      </div>
      <div className="chart-readout chart-readout-stable">
        {shown ? (
          <>
            <span className="chart-readout-value" style={{ color: tone(shown.with) }}>
              <Masked>{formatMoney(shown.with, currency)}</Masked>
            </span>
            <span className="chart-readout-date">
              <Masked>{`without income ${formatMoney(shown.without, currency)}`}</Masked>
            </span>
            <span className="chart-readout-date">{shown.date === today ? 'now' : `${reportDay(shown.date)}, estimated`}</span>
          </>
        ) : (
          <>
            <span className="chart-readout-value">
              <Masked>{formatMoney(points[0].with, currency)}</Masked>
            </span>
            <span className="chart-readout-date">now; slide along the lines to read a day</span>
          </>
        )}
      </div>

      <svg
        ref={svgRef}
        className="chart-svg"
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-label={spoken(
          `Estimated cash from ${formatMoney(points[0].with, currency)} now to ${formatMoney(last.with, currency)} with income and ${formatMoney(last.without, currency)} without it on ${reportDay(last.date)}.`
        )}
        onPointerMove={(e) => scrub(e.clientX)}
        onPointerDown={(e) => scrub(e.clientX)}
        onPointerLeave={() => setActive(null)}
      >
        {ticks.map((t) => (
          <g key={t}>
            <line x1={PAD_LEFT} x2={W - PAD_RIGHT} y1={y(t)} y2={y(t)} stroke="var(--line, #262a33)" strokeWidth={1} />
            <text className="chart-tick" x={PAD_LEFT} y={y(t) - 3}>
              {compactMoney(t, currency)}
            </text>
          </g>
        ))}
        {showZero && <line x1={PAD_LEFT} x2={W - PAD_RIGHT} y1={y(0)} y2={y(0)} stroke="var(--down)" strokeOpacity={0.6} strokeWidth={1} />}
        <path d={geo.with} fill="none" stroke="var(--accent)" strokeWidth={2} strokeDasharray="5 4" strokeLinejoin="round" strokeLinecap="round" />
        <path d={geo.without} fill="none" stroke="var(--down)" strokeWidth={2} strokeDasharray="5 4" strokeLinejoin="round" strokeLinecap="round" />
        {marks.map((m) => {
          const p = points.find((q) => q.date === m.date)!;
          return <circle key={m.key} cx={x(days(m.date))} cy={y(p[m.key])} r={4} fill={m.color} stroke="var(--card)" strokeWidth={2} />;
        })}
        {shown && <line x1={x(days(shown.date))} x2={x(days(shown.date))} y1={PAD_TOP} y2={H - PAD_BOTTOM} stroke="#3a4150" strokeWidth={1} />}
        <text className="chart-xlabel" x={PAD_LEFT} y={H - 6}>
          Now
        </text>
        <text className="chart-xlabel" x={W - PAD_RIGHT} y={H - 6} textAnchor="end">
          {reportDay(last.date)}
        </text>
      </svg>
    </div>
  );
}
