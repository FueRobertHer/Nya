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
// what-if, its line is drawn over the forecast's in --text-2 dots (look and
// feel, step 4: not the warning colour, which is close to gold), with a
// legend of each line's dash, and the readout gives both. It is drawn at its own width
// (components/drawn-width.ts), in the shape it has always had, so its text is
// the 12px it says on a phone and on a wide card; the card's chart and the
// what-if sheet's each measure their own.
//
// No gridlines and no money on the plot (the screen review after step 5, as
// every net worth chart): the readout says the lowest point or the day under
// the finger, the label says where it starts, ends and dips, and every day
// is behind "Show as a table". Zero and the warning are named in words at
// their left end, never with an amount (the card's Warns below row says it).
// The line stays dashed: a forecast is all estimate, and says so.

import { useMemo, useState, type PointerEvent } from 'react';
import type { Forecast } from '@/lib/forecast';
import { formatDay, formatMoney, onDay, signedMoney, spoken } from '@/lib/format';
import { shownName } from '@/lib/merchant-name';
import { Masked } from './HideAmounts';
import { FALLBACK_WIDTH, useDrawnWidth } from './drawn-width';
import { LegendLine } from './LegendLine';

/** Its height for its width: 150 to 340, the shape it has always had. */
const ASPECT = 150 / FALLBACK_WIDTH;
const PAD_LEFT = 8;
const PAD_RIGHT = 10;
// Room over the line's top for its dot's ring.
const PAD_TOP = 8;
// Room under the baseline for the 12px dates.
const PAD_BOTTOM = 24;
// The forecast in gold (--data) dashes; a what-if in --text-2 dots, by dash as well
// as color (--warn is for caution, and is close to gold). Round caps
// lengthen each dash by the stroke's width, so "0 4" draws dots.
const MAIN = { color: 'var(--data)', dash: '5 4' };
const ALT = { color: 'var(--text-2)', dash: '0 4' };
/** A rule's name sits this far over it (its baseline), or under it by its
 *  12px height and as much again where there is no room over it. */
const RULE_LABEL_GAP = 4;
const RULE_LABEL_HEIGHT = 12;
/** Two names are at least this far apart, baseline to baseline. */
const RULE_LABEL_LINE = 14;

/** A day mid sentence: "today", "Nov 28", "Jan 3, 2027" (lib/format.ts formatDay). */
export function fmtDay(iso: string): string {
  return formatDay(iso, { sentence: true });
}

/** The axis's last day, "Nov 28", as a chart's axis names it. */
const axisDay = (iso: string) => new Date(`${iso}T00:00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });

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
  const [drawnRef, W] = useDrawnWidth<SVGSVGElement>();
  const H = Math.round(W * ASPECT);
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
    const plotW = W - PAD_LEFT - PAD_RIGHT;
    const plotH = H - PAD_TOP - PAD_BOTTOM;
    const x = (u: number) => PAD_LEFT + (n <= 0 ? 0 : (u / n) * plotW);
    const y = (v: number) => PAD_TOP + (1 - (v - bottom) / (top - bottom)) * plotH;
    const path = (f: Forecast) => points(f).map((v, k) => `${k === 0 ? 'M' : 'L'}${x(at(k)).toFixed(1)},${y(v).toFixed(1)}`).join('');
    // Each rule drawn is named at its left end: over it, unless that would
    // leave the plot's top, then under it. The warning's rule is above
    // zero's, so its name goes over and zero's under when the two are too
    // close for both over. Then, whatever the arrangement, the two names are
    // kept a line apart (RULE_LABEL_LINE, baseline to baseline): the lower
    // goes down, and where that would take it under the plot, both go up.
    const rules: { y: number; name: string }[] = [];
    if (showThreshold) rules.push({ y: y(threshold), name: 'Warning' });
    if (showZero) rules.push({ y: y(0), name: 'Zero' });
    const crowded = rules.length === 2 && rules[1].y - rules[0].y < RULE_LABEL_HEIGHT + RULE_LABEL_GAP * 2;
    const plotBottom = H - PAD_BOTTOM;
    const ruleLabels = rules
      .map((r, k) => {
        const over = r.y - RULE_LABEL_GAP;
        const under = r.y + RULE_LABEL_GAP + RULE_LABEL_HEIGHT;
        const roomOver = over - RULE_LABEL_HEIGHT >= 0;
        const below = (crowded && k === 1) || !roomOver;
        return { name: r.name, y: below && under <= plotBottom ? under : over };
      })
      .sort((a, b) => a.y - b.y);
    if (ruleLabels.length === 2 && ruleLabels[1].y - ruleLabels[0].y < RULE_LABEL_LINE) {
      ruleLabels[1].y = Math.min(ruleLabels[0].y + RULE_LABEL_LINE, plotBottom);
      ruleLabels[0].y = Math.min(ruleLabels[0].y, ruleLabels[1].y - RULE_LABEL_LINE);
    }
    return {
      x,
      y,
      plotW,
      main: path(forecast),
      alt: whatIf ? path(whatIf) : null,
      showZero,
      showThreshold,
      ruleLabels,
    };
  }, [forecast, whatIf, threshold, W, H]);

  const { x, y, plotW, main, alt, showZero, showThreshold, ruleLabels } = geo;
  // The table renders its rows only while it is open.
  const [tableOpen, setTableOpen] = useState(false);
  const shown = whatIf ?? forecast;
  const shownLow = shown.lowest;
  const today = forecast.days[0].date;
  // Now, when the lowest is the balance before anything expected today;
  // otherwise the low of its day, halfway through it.
  const lowNow = shownLow.date === today && shownLow.balance === shown.start;
  const lowDay = shown.days.findIndex((d) => d.date === shownLow.date);
  const lowAt = lowNow ? 0 : lowDay + 0.5;
  const lowWhen = lowNow ? 'now' : shownLow.date === today ? 'today' : `around ${fmtDay(shownLow.date)}`;

  function scrub(e: PointerEvent<SVGSVGElement>) {
    const rect = e.currentTarget.getBoundingClientRect();
    const px = ((e.clientX - rect.left) / rect.width) * W;
    const n = forecast.days.length;
    const i = Math.round(((px - PAD_LEFT) / plotW) * n);
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
            <LegendLine color={MAIN.color} dash={MAIN.dash} />
            Forecast
          </span>
          <span className="chart-legend-item">
            <LegendLine color={ALT.color} dash={ALT.dash} />
            With the purchase
          </span>
        </div>
      )}
      <div className="chart-readout chart-readout-stable">
        {value !== null ? (
          <>
            <span className="chart-readout-value" style={{ color: tone(altValue ?? value) }}>
              <Masked>{formatMoney(altValue ?? value, currency)}</Masked>
            </span>
            {altValue !== null && altValue !== value && (
              <span className="chart-readout-date">
                <Masked>{`without it ${formatMoney(value, currency)}`}</Masked>
              </span>
            )}
            <span className="chart-readout-date">{i === 0 ? 'now' : `${i === 1 ? 'end of today' : `end of ${fmtDay(day!.date)}`}, estimated`}</span>
          </>
        ) : (
          <>
            <span className="chart-readout-value" style={{ color: tone(shownLow.balance) }}>
              <Masked>{formatMoney(shownLow.balance, currency)}</Masked>
            </span>
            <span className="chart-readout-date">
              lowest, {lowWhen}
              {lowNow ? '' : ' (estimated)'}
            </span>
          </>
        )}
      </div>

      <svg
        ref={drawnRef}
        className="chart-svg at-width"
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-label={spoken(`Estimated cash balance from ${formatMoney(forecast.start, currency)} now to ${formatMoney(last.balance, currency)} ${onDay(fmtDay(last.date))}, lowest ${formatMoney(shownLow.balance, currency)} ${lowWhen}.`)}
        onPointerMove={scrub}
        onPointerDown={scrub}
        onPointerLeave={() => setActive(null)}
      >
        {showZero && <line x1={PAD_LEFT} x2={W - PAD_RIGHT} y1={y(0)} y2={y(0)} stroke="var(--down)" strokeOpacity={0.6} strokeWidth={1} />}
        {showThreshold && (
          <line x1={PAD_LEFT} x2={W - PAD_RIGHT} y1={y(threshold)} y2={y(threshold)} stroke="var(--warn)" strokeOpacity={0.6} strokeWidth={1} strokeDasharray="2 3" />
        )}
        <path d={main} fill="none" stroke={MAIN.color} strokeWidth={2} strokeDasharray={MAIN.dash} strokeLinejoin="round" strokeLinecap="round" />
        {alt && <path d={alt} fill="none" stroke={ALT.color} strokeWidth={2} strokeDasharray={ALT.dash} strokeLinejoin="round" strokeLinecap="round" />}

        {/* Each rule named in words at its left end, never an amount: over
            the lines, haloed in the card's color (.chart-rule-label), so a
            line crossing it never hides the word. */}
        {ruleLabels.map((r) => (
          <text key={r.name} className="chart-rule-label" x={PAD_LEFT} y={r.y}>
            {r.name}
          </text>
        ))}

        {(lowNow || lowDay >= 0) && (
          <circle cx={x(lowAt)} cy={y(shownLow.balance)} r={4} fill={tone(shownLow.balance) ?? (whatIf ? ALT : MAIN).color} stroke="var(--surface)" strokeWidth={2} />
        )}
        {i !== null && value !== null && (
          <>
            <line x1={x(i)} x2={x(i)} y1={PAD_TOP} y2={H - PAD_BOTTOM} stroke="var(--border-strong)" strokeWidth={1} />
            <circle cx={x(i)} cy={y(value)} r={4} fill={MAIN.color} stroke="var(--surface)" strokeWidth={2} />
            {altValue !== null && <circle cx={x(i)} cy={y(altValue)} r={4} fill={ALT.color} stroke="var(--surface)" strokeWidth={2} />}
          </>
        )}

        <text className="chart-xlabel" x={PAD_LEFT} y={H - 6}>
          Now
        </text>
        <text className="chart-xlabel" x={W - PAD_RIGHT} y={H - 6} textAnchor="end">
          {axisDay(last.date)}
        </text>
      </svg>

      {/* What moves the scrubbed day, so a step in the line can be read. */}
      <div className="chart-readout-split">
        <Masked>
          {day
            ? moves.length > 0
              ? `${moves
                  // One in another currency: its own amount, and what it counts as here.
                  .map((e) => (e.own ? `${shownName(e)} ${signedMoney(e.own.amount, e.own.currency)} (${signedMoney(e.amount, currency)})` : `${shownName(e)} ${signedMoney(e.amount, currency)}`))
                  .join(' · ')}${
                  (altDay ?? day).low < (altDay ?? day).balance && moves.some((e) => e.amount < 0)
                    ? ` · as low as ${formatMoney((altDay ?? day).low, currency)} before the money in`
                    : ''
                }`
              : 'Nothing expected that day'
            : i === 0
              ? 'The balance now, before anything expected today'
              : 'Slide along the line to read a day'}
        </Masked>
      </div>

      {/* The plot has no money on it: every day, for anyone who can't read
          the line. Its low (once the day's money out is counted, as the
          readout's lowest is) and its end; under a what-if, the line with the
          purchase and each day's end without it, as the readout gives them.
          Rows render only while it is open, and through Masked each time. */}
      <details className="plan-table-view" onToggle={(e) => setTableOpen(e.currentTarget.open)}>
        <summary>Show as a table</summary>
        {tableOpen && (
          <table>
            <caption>{whatIf ? 'With the purchase, and each day’s end without it. ' : ''}Every day after now is an estimate.</caption>
            <thead>
              <tr>
                <th scope="col">Day</th>
                <th scope="col" className="num">Low</th>
                <th scope="col" className="num">End of day</th>
                {whatIf && <th scope="col" className="num">Without it</th>}
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>Now</td>
                <td className="num">
                  <Masked>{formatMoney(shown.start, currency)}</Masked>
                </td>
                <td className="num">
                  <Masked>{formatMoney(shown.start, currency)}</Masked>
                </td>
                {whatIf && (
                  <td className="num">
                    <Masked>{formatMoney(forecast.start, currency)}</Masked>
                  </td>
                )}
              </tr>
              {shown.days.map((d, k) => (
                <tr key={d.date}>
                  <td>{formatDay(d.date)}</td>
                  <td className="num">
                    <Masked>{formatMoney(d.low, currency)}</Masked>
                  </td>
                  <td className="num">
                    <Masked>{formatMoney(d.balance, currency)}</Masked>
                  </td>
                  {whatIf && (
                    <td className="num">
                      <Masked>{formatMoney(forecast.days[k].balance, currency)}</Masked>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </details>
    </div>
  );
}
