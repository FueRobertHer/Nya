'use client';

// The cash forecast as a line (lib/forecast.ts), in the house style of
// MonthFlowChart and NetWorthChart: dependency-free inline SVG, a readout row
// above the plot instead of a floating tooltip, scrubbed by pointer. The line
// is dashed throughout, as the net-worth chart draws its estimated stretch:
// every point on it is an estimate. Zero and the low-balance warning are
// drawn when the line comes near them, and the lowest point is marked. With
// a what-if, its line is drawn over the forecast's in the warning colour,
// with a legend, and the readout gives both.

import { useMemo, useRef, useState } from 'react';
import type { Forecast } from '@/lib/forecast';
import { compactMoney, formatMoney, signedMoney } from '@/lib/format';

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

export function fmtDay(iso: string): string {
  return new Date(`${iso}T00:00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export default function ForecastChart({
  forecast,
  whatIf = null,
  currency,
  threshold,
}: {
  forecast: Forecast;
  /** The same forecast with one more purchase, drawn over it. */
  whatIf?: Forecast | null;
  currency: string | null;
  /** The low-balance warning; 0 for none. */
  threshold: number;
}) {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const [active, setActive] = useState<number | null>(null);

  const geo = useMemo(() => {
    const series = [forecast, ...(whatIf ? [whatIf] : [])];
    const values = series.flatMap((f) => f.days.map((d) => d.balance));
    let lo = Math.min(...values);
    let hi = Math.max(...values);
    // Zero, and the warning, are drawn only when the line comes within a
    // fifth of the plot's height of them: room is kept for them then.
    const span = hi - lo || Math.max(Math.abs(hi), 1);
    const near = (v: number) => v >= lo - span * 0.2 && v <= hi + span * 0.2;
    const showZero = near(0);
    const showThreshold = threshold > 0 && near(threshold);
    if (showZero) {
      lo = Math.min(lo, 0);
      hi = Math.max(hi, 0);
    }
    if (showThreshold) {
      lo = Math.min(lo, threshold);
      hi = Math.max(hi, threshold);
    }
    const pad = (hi - lo || Math.max(Math.abs(hi), 1)) * 0.08;
    const bottom = lo - pad;
    const top = hi + pad;
    const n = forecast.days.length;
    const x = (i: number) => PAD_LEFT + (n <= 1 ? 0 : (i / (n - 1)) * (W - PAD_LEFT - PAD_RIGHT));
    const y = (v: number) => PAD_TOP + (1 - (v - bottom) / (top - bottom)) * (H - PAD_TOP - PAD_BOTTOM);
    const path = (f: Forecast) => f.days.map((d, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(d.balance).toFixed(1)}`).join('');
    return {
      x,
      y,
      ticks: niceTicks(bottom, top),
      main: path(forecast),
      alt: whatIf ? path(whatIf) : null,
      showZero,
      showThreshold,
    };
  }, [forecast, whatIf, threshold]);

  const { x, y, ticks, main, alt, showZero, showThreshold } = geo;
  const shownLow = (whatIf ?? forecast).lowest;
  const lowIndex = forecast.days.findIndex((d) => d.date === shownLow.date);

  function scrub(clientX: number) {
    const svg = svgRef.current;
    if (!svg) return;
    const rect = svg.getBoundingClientRect();
    const px = ((clientX - rect.left) / rect.width) * W;
    const n = forecast.days.length;
    const i = Math.round(((px - PAD_LEFT) / (W - PAD_LEFT - PAD_RIGHT)) * (n - 1));
    setActive(Math.max(0, Math.min(n - 1, i)));
  }

  const i = active;
  const day = i === null ? null : forecast.days[i];
  const altDay = i === null || !whatIf ? null : whatIf.days[i];
  const moves = day ? [...day.events, ...(altDay ? altDay.events.filter((e) => e.source === 'what-if') : [])] : [];
  const last = forecast.days[forecast.days.length - 1];
  const tone = (v: number) => (v < 0 ? 'var(--down)' : v < threshold ? 'var(--warn)' : undefined);

  return (
    <div>
      {whatIf && (
        <div className="chart-legend">
          <span className="chart-legend-item">
            <span className="chart-legend-dot" style={{ background: 'var(--accent)' }} />
            Forecast
          </span>
          <span className="chart-legend-item">
            <span className="chart-legend-dot" style={{ background: 'var(--warn)' }} />
            With the purchase
          </span>
        </div>
      )}
      <div className="chart-readout chart-readout-stable">
        {day ? (
          <>
            <span className="chart-readout-value" style={{ color: tone(altDay?.balance ?? day.balance) }}>
              {formatMoney(altDay?.balance ?? day.balance, currency)}
            </span>
            {altDay && <span className="chart-readout-date">without it {formatMoney(day.balance, currency)}</span>}
            <span className="chart-readout-date">
              {i === 0 ? 'today' : fmtDay(day.date)}, estimated
            </span>
          </>
        ) : (
          <>
            <span className="chart-readout-value" style={{ color: tone(shownLow.balance) }}>
              {formatMoney(shownLow.balance, currency)}
            </span>
            <span className="chart-readout-date">
              lowest, {shownLow.date === forecast.days[0].date ? 'today' : `on ${fmtDay(shownLow.date)}`} (estimated)
            </span>
          </>
        )}
      </div>

      <svg
        ref={svgRef}
        className="chart-svg"
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-label={`Estimated cash balance from ${formatMoney(forecast.days[0].balance, currency)} today to ${formatMoney(last.balance, currency)} on ${fmtDay(last.date)}, lowest ${formatMoney(shownLow.balance, currency)} on ${fmtDay(shownLow.date)}.`}
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
        {showZero && <line x1={PAD_LEFT} x2={W - PAD_RIGHT} y1={y(0)} y2={y(0)} stroke="var(--down)" strokeOpacity={0.6} strokeWidth={1} />}
        {showThreshold && (
          <line x1={PAD_LEFT} x2={W - PAD_RIGHT} y1={y(threshold)} y2={y(threshold)} stroke="var(--warn)" strokeOpacity={0.6} strokeWidth={1} strokeDasharray="2 3" />
        )}

        <path d={main} fill="none" stroke="var(--accent)" strokeWidth={2} strokeDasharray="5 4" strokeLinejoin="round" strokeLinecap="round" />
        {alt && <path d={alt} fill="none" stroke="var(--warn)" strokeWidth={2} strokeDasharray="5 4" strokeLinejoin="round" strokeLinecap="round" />}

        {lowIndex >= 0 && (
          <circle cx={x(lowIndex)} cy={y(shownLow.balance)} r={4} fill={tone(shownLow.balance) ?? 'var(--accent)'} stroke="var(--card)" strokeWidth={2} />
        )}
        {i !== null && (
          <>
            <line x1={x(i)} x2={x(i)} y1={PAD_TOP} y2={H - PAD_BOTTOM} stroke="#3a4150" strokeWidth={1} />
            <circle cx={x(i)} cy={y(day!.balance)} r={4} fill="var(--accent)" stroke="var(--card)" strokeWidth={2} />
            {altDay && <circle cx={x(i)} cy={y(altDay.balance)} r={4} fill="var(--warn)" stroke="var(--card)" strokeWidth={2} />}
          </>
        )}

        <text className="chart-xlabel" x={PAD_LEFT} y={H - 6}>
          Today
        </text>
        <text className="chart-xlabel" x={W - PAD_RIGHT} y={H - 6} textAnchor="end">
          {fmtDay(last.date)}
        </text>
      </svg>

      {/* What moves the scrubbed day, so a step in the line can be read. */}
      <div className="chart-readout-split">
        {day
          ? moves.length > 0
            ? moves.map((e) => `${e.name} ${signedMoney(e.amount, currency)}`).join(' · ')
            : 'Nothing expected that day'
          : 'Slide along the line to read a day'}
      </div>
    </div>
  );
}
