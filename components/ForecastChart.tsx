'use client';

// The cash forecast as a line (lib/forecast.ts), in the house style of
// MonthFlowChart and NetWorthChart: dependency-free inline SVG, a readout row
// above the plot instead of a floating tooltip, scrubbed by pointer. It starts
// at the balance now; each day then has two points, its low (once its money
// out is counted, before its money in) halfway through it and its end, so a
// day with rent and pay both expected shows the dip it may hold. The line is
// dashed throughout, as the net-worth chart draws its estimated stretch: every
// point after the first is an estimate. Zero and the low-balance warning are
// drawn when the line comes near them, and the lowest point is marked. With a
// what-if, its line is drawn over the forecast's in the warning colour, with a
// legend, and the readout gives both.

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

  // Point 0 is now; day d's low is at d + 0.5 and its end at d + 1, on a scale
  // of whole days.
  const points = (f: Forecast) => [f.start, ...f.days.flatMap((d) => [d.low, d.balance])];
  const at = (k: number) => (k === 0 ? 0 : k / 2);

  const geo = useMemo(() => {
    const series = [forecast, ...(whatIf ? [whatIf] : [])];
    const values = series.flatMap(points);
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
    const x = (u: number) => PAD_LEFT + (n <= 0 ? 0 : (u / n) * (W - PAD_LEFT - PAD_RIGHT));
    const y = (v: number) => PAD_TOP + (1 - (v - bottom) / (top - bottom)) * (H - PAD_TOP - PAD_BOTTOM);
    const path = (f: Forecast) => points(f).map((v, k) => `${k === 0 ? 'M' : 'L'}${x(at(k)).toFixed(1)},${y(v).toFixed(1)}`).join('');
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
  const shown = whatIf ?? forecast;
  const shownLow = shown.lowest;
  const today = forecast.days[0].date;
  // Now, when the lowest is the balance before anything expected today;
  // otherwise the low of its day, halfway through it.
  const lowNow = shownLow.date === today && shownLow.balance === shown.start;
  const lowDay = shown.days.findIndex((d) => d.date === shownLow.date);
  const lowAt = lowNow ? 0 : lowDay + 0.5;
  const lowWhen = lowNow ? 'now' : shownLow.date === today ? 'today' : `around ${fmtDay(shownLow.date)}`;

  function scrub(clientX: number) {
    const svg = svgRef.current;
    if (!svg) return;
    const rect = svg.getBoundingClientRect();
    const px = ((clientX - rect.left) / rect.width) * W;
    const n = forecast.days.length;
    const i = Math.round(((px - PAD_LEFT) / (W - PAD_LEFT - PAD_RIGHT)) * n);
    setActive(Math.max(0, Math.min(n, i)));
  }

  const i = active;
  // The scrubbed point: now (0), or the end of day i - 1.
  const day = i === null || i === 0 ? null : forecast.days[i - 1];
  const altDay = i === null || i === 0 || !whatIf ? null : whatIf.days[i - 1];
  const value = i === null ? null : i === 0 ? forecast.start : day!.balance;
  const altValue = i === null || !whatIf ? null : i === 0 ? whatIf.start : altDay!.balance;
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
        {value !== null ? (
          <>
            <span className="chart-readout-value" style={{ color: tone(altValue ?? value) }}>
              {formatMoney(altValue ?? value, currency)}
            </span>
            {altValue !== null && altValue !== value && <span className="chart-readout-date">without it {formatMoney(value, currency)}</span>}
            <span className="chart-readout-date">{i === 0 ? 'now' : `${i === 1 ? 'end of today' : `end of ${fmtDay(day!.date)}`}, estimated`}</span>
          </>
        ) : (
          <>
            <span className="chart-readout-value" style={{ color: tone(shownLow.balance) }}>
              {formatMoney(shownLow.balance, currency)}
            </span>
            <span className="chart-readout-date">
              lowest, {lowWhen}
              {lowNow ? '' : ' (estimated)'}
            </span>
          </>
        )}
      </div>

      <svg
        ref={svgRef}
        className="chart-svg"
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-label={`Estimated cash balance from ${formatMoney(forecast.start, currency)} now to ${formatMoney(last.balance, currency)} on ${fmtDay(last.date)}, lowest ${formatMoney(shownLow.balance, currency)} ${lowWhen}.`}
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

        {(lowNow || lowDay >= 0) && (
          <circle cx={x(lowAt)} cy={y(shownLow.balance)} r={4} fill={tone(shownLow.balance) ?? 'var(--accent)'} stroke="var(--card)" strokeWidth={2} />
        )}
        {i !== null && value !== null && (
          <>
            <line x1={x(i)} x2={x(i)} y1={PAD_TOP} y2={H - PAD_BOTTOM} stroke="#3a4150" strokeWidth={1} />
            <circle cx={x(i)} cy={y(value)} r={4} fill="var(--accent)" stroke="var(--card)" strokeWidth={2} />
            {altValue !== null && <circle cx={x(i)} cy={y(altValue)} r={4} fill="var(--warn)" stroke="var(--card)" strokeWidth={2} />}
          </>
        )}

        <text className="chart-xlabel" x={PAD_LEFT} y={H - 6}>
          Now
        </text>
        <text className="chart-xlabel" x={W - PAD_RIGHT} y={H - 6} textAnchor="end">
          {fmtDay(last.date)}
        </text>
      </svg>

      {/* What moves the scrubbed day, so a step in the line can be read. */}
      <div className="chart-readout-split">
        {day
          ? moves.length > 0
            ? `${moves.map((e) => `${e.name} ${signedMoney(e.amount, currency)}`).join(' · ')}${
                (altDay ?? day).low < (altDay ?? day).balance && moves.some((e) => e.amount < 0)
                  ? ` · as low as ${formatMoney((altDay ?? day).low, currency)} before the money in`
                  : ''
              }`
            : 'Nothing expected that day'
          : i === 0
            ? 'The balance now, before anything expected today'
            : 'Slide along the line to read a day'}
      </div>
    </div>
  );
}
