'use client';

// The fan chart for a simulated plan: the balance year by year as percentile
// bands across every start (or run). One hue, as on the other charts: the
// median a 2px --data (gold) line, the middle half (25th to 75th percentile)
// a darker wash, the middle 80% (10th to 90th) the solid --data-tint. The
// bands are drawn before the gridlines, which a solid band would hide. Dependency-free
// SVG in the same house style as NetWorthChart: hairline gridlines with clean
// tick values, labels in the muted text colour, and a readout row above the
// plot instead of a tooltip, since on a phone the finger covers the point
// being read. Scrubbing snaps to the nearest year, and the keys move it a
// year at a time (components/chart-keys.ts). A table of the same
// figures sits behind "Show as a table" for anyone who can't read the plot.
// It is drawn at its own width (components/drawn-width.ts, rollout phase 6d),
// in the shape it has always had, so its figures and ages are the 12px they
// say on a phone and on a wide card.

import { useMemo, useState, type PointerEvent } from 'react';
import type { Bands } from '@/lib/fire/simulate';
import { compactMoney, spoken } from '@/lib/format';
import { wholeMoney } from './plan-text';
import { Masked } from './HideAmounts';
import { FALLBACK_WIDTH, MIN_LABEL_GAP, labelWidth, useDrawnWidth } from './drawn-width';
import { keysHelp, useChartKeys } from './chart-keys';

/** Its height for its width: 160 to 340, the shape it has always had. */
const ASPECT = 160 / FALLBACK_WIDTH;
const PAD_RIGHT = 10;
// Room over the top tick for half its 12px figure, which is centred on it.
const PAD_TOP = 12;
// Room under the baseline for the 12px ages.
const PAD_BOTTOM = 24;

// A money tick's 12px figure's width, roughly, from its value alone (never
// from the figure as written, which hide amounts masks, so the chart's shape
// is the same either way): a sign ("$", or "CA$" and the like for another
// currency), the digits before the point, one after it when there is one, and
// K, M or B ("$1.5M" is about 36px).
function tickWidth(value: number, currency: string | null): number {
  const unit = value >= 1e9 ? 1e9 : value >= 1e6 ? 1e6 : value >= 1e3 ? 1e3 : 1;
  const tenths = Math.round((value / unit) * 10);
  const whole = Math.floor(tenths / 10);
  const digits = whole < 1 ? 1 : Math.floor(Math.log10(whole)) + 1;
  const sign = currency === null || currency === 'USD' ? 7 : 21;
  return sign + digits * 7 + (tenths % 10 !== 0 ? 10 : 0) + (unit > 1 ? 7 : 0);
}

// Neighbouring gridlines are at least this far apart, in CSS pixels, so their
// 12px figures, each centred on its line, never touch (and the ages along the
// bottom MIN_LABEL_GAP apart, edge to edge).
const MIN_TICK_GAP = 20;

type XTick = { x: number; label: string; anchor: 'start' | 'middle' | 'end' };

// 2-3 clean tick values (1/2/5 x 10^n steps) from 0 to max, as the other
// charts, on a plot `height` tall. Where they would be closer than
// MIN_TICK_GAP (a phone's short plot), the step goes on up the same sequence
// until they aren't.
function niceTicks(max: number, height: number): number[] {
  const span = max || 1;
  const rough = span / 2.5;
  let mag = Math.pow(10, Math.floor(Math.log10(rough)));
  const norm = rough / mag;
  let lead = norm >= 5 ? 5 : norm >= 2 ? 2 : 1;
  // 1 to 2, 2 to 5, 5 to 10.
  while (height > 0 && ((lead * mag) / span) * height < MIN_TICK_GAP) {
    if (lead === 5) mag *= 10;
    lead = lead === 1 ? 2 : lead === 2 ? 5 : 1;
  }
  const step = lead * mag;
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
  const [drawnRef, W] = useDrawnWidth<SVGSVGElement>();
  const H = Math.round(W * ASPECT);
  const [active, setActive] = useState<number | null>(null);
  const years = bands.p50.length - 1;

  const geo = useMemo(() => {
    const max = Math.max(...bands.p90, 1);
    const top = max * 1.06;
    const plotH = H - PAD_TOP - PAD_BOTTOM;
    const ticks = niceTicks(max, plotH * (max / top));
    // A gutter for the money axis, as wide as its widest figure: the bands
    // fill the plot right down to $0 at its left edge, where figures drawn
    // inside it (as on the other charts) would sit on top of them.
    const padLeft = Math.ceil(Math.max(...ticks.map((t) => tickWidth(t, currency)))) + 8;
    const plotW = W - padLeft - PAD_RIGHT;
    const x = (y: number) => padLeft + (y / Math.max(years, 1)) * plotW;
    const yv = (v: number) => PAD_TOP + (1 - v / top) * plotH;
    const xs = bands.p50.map((_, i) => x(i));
    const pt = (i: number, v: number) => `${xs[i].toFixed(1)},${yv(v).toFixed(1)}`;
    // A band is its upper edge left to right, then its lower edge back.
    const band = (hi: number[], lo: number[]) =>
      `M${hi.map((v, i) => pt(i, v)).join('L')}L${lo
        .map((v, i) => pt(i, v))
        .reverse()
        .join('L')}Z`;
    // An age every 5, 10 or 20 years, the first step that leaves room between
    // their 12px labels ("age 55" is wider than "60"), and the plan's last age
    // at the end. A tick that would crowd the last one is left out.
    const label = (y: number) => (startAge !== null ? `${y === 0 ? 'age ' : ''}${startAge + y}` : `${y === 0 ? 'year ' : ''}${y}`);
    const span = (t: XTick) => {
      const w = labelWidth(t.label);
      return t.anchor === 'start' ? [t.x, t.x + w] : t.anchor === 'end' ? [t.x - w, t.x] : [t.x - w / 2, t.x + w / 2];
    };
    const apart = (a: XTick, b: XTick) => span(b)[0] - span(a)[1] >= MIN_LABEL_GAP;
    const last: XTick = { x: x(years), label: startAge !== null ? `${startAge + years}` : `${years}`, anchor: 'end' };
    let xTicks: XTick[] = [];
    for (const step of [5, 10, 20]) {
      xTicks = [];
      for (let y = 0; y < years; y += step) xTicks.push({ x: x(y), label: label(y), anchor: y === 0 ? 'start' : 'middle' });
      while (xTicks.length > 1 && !apart(xTicks[xTicks.length - 1], last)) xTicks.pop();
      if (xTicks.every((t, k) => k === 0 || apart(xTicks[k - 1], t))) break;
    }
    if (xTicks.length > 0 && !apart(xTicks[xTicks.length - 1], last)) xTicks.pop();
    xTicks.push(last);
    return {
      xs,
      yv,
      padLeft,
      outer: band(bands.p90, bands.p10),
      inner: band(bands.p75, bands.p25),
      median: bands.p50.map((v, i) => `${i === 0 ? 'M' : 'L'}${pt(i, v)}`).join(''),
      ticks,
      xTicks,
      baseY: H - PAD_BOTTOM,
    };
  }, [bands, years, startAge, currency, W, H]);

  const { xs, yv, padLeft, outer, inner, median, ticks, xTicks, baseY } = geo;
  const i = active ?? years;
  const when = (y: number) => (startAge !== null ? `age ${startAge + y}` : `year ${y}`);
  const whenLong = (y: number) =>
    y === years ? `at the end (${when(y)})` : y === 0 ? `at the start (${when(0)})` : `at ${when(y)}`;

  const keys = useChartKeys({
    count: years + 1,
    active,
    setActive,
    say: (k) => `Median ${wholeMoney(bands.p50[k], currency)} ${whenLong(k)}, middle 80% ${wholeMoney(bands.p10[k], currency)} to ${wholeMoney(bands.p90[k], currency)}`,
  });

  function scrub(e: PointerEvent<SVGSVGElement>) {
    const rect = e.currentTarget.getBoundingClientRect();
    const px = ((e.clientX - rect.left) / rect.width) * W;
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
        <span className="chart-readout-value">
          <Masked>{`Median ${wholeMoney(bands.p50[i], currency)}`}</Masked>
        </span>
        <span className="chart-readout-date">
          <Masked>{`${whenLong(i)} · middle 80%: ${wholeMoney(bands.p10[i], currency)} to ${wholeMoney(bands.p90[i], currency)}`}</Masked>
        </span>
      </div>

      <svg
        ref={drawnRef}
        className="chart-svg at-width"
        viewBox={`0 0 ${W} ${H}`}
        role="slider"
        {...keys.slider}
        aria-label={spoken(
          `Balance over ${years} years in today's dollars. At the end: median ${wholeMoney(bands.p50[years], currency)}, middle 80% ${wholeMoney(bands.p10[years], currency)} to ${wholeMoney(bands.p90[years], currency)}.`
        )}
        onPointerMove={scrub}
        onPointerDown={scrub}
        onPointerLeave={() => setActive(null)}
      >
        <path d={outer} fill="var(--data-tint)" />
        <path d={inner} fill="var(--data)" opacity={0.22} />
        {ticks.map((t) => (
          <g key={t}>
            <line x1={padLeft} x2={W - PAD_RIGHT} y1={yv(t)} y2={yv(t)} stroke="var(--border-subtle)" strokeWidth={1} />
            <text className="chart-tick" x={padLeft - 6} y={yv(t)} textAnchor="end" dominantBaseline="middle">
              {compactMoney(t, currency)}
            </text>
          </g>
        ))}
        <path d={median} fill="none" stroke="var(--data)" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />

        {active !== null && <line x1={xs[i]} x2={xs[i]} y1={PAD_TOP} y2={baseY} stroke="var(--border-strong)" strokeWidth={1} />}
        <circle cx={xs[i]} cy={yv(bands.p50[i])} r={4} fill="var(--data)" stroke="var(--card)" strokeWidth={2} />

        {xTicks.map((t) => (
          <text key={`${t.x}-${t.label}`} className="chart-xlabel" x={t.x} y={H - 6} textAnchor={t.anchor}>
            {t.label}
          </text>
        ))}
      </svg>
      <p id={keys.helpId} className="visually-hidden">
        {keysHelp('year', 'the end', 'the start and the end')}
      </p>

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
          <caption className="visually-hidden">The range of outcomes: the 10th percentile, the median and the 90th</caption>
          <thead>
            <tr>
              <th scope="col">{startAge !== null ? 'Age' : 'Year'}</th>
              <th scope="col" className="num">10th</th>
              <th scope="col" className="num">Median</th>
              <th scope="col" className="num">90th</th>
            </tr>
          </thead>
          <tbody>
            {tableYears.map((y) => (
              <tr key={y}>
                <td>{startAge !== null ? startAge + y : y}</td>
                <td className="num"><Masked>{wholeMoney(bands.p10[y], currency)}</Masked></td>
                <td className="num"><Masked>{wholeMoney(bands.p50[y], currency)}</Masked></td>
                <td className="num"><Masked>{wholeMoney(bands.p90[y], currency)}</Masked></td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </div>
  );
}
