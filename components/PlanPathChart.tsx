'use client';

// Your path's chart (rollout phase 8b): invested assets from today to the
// age you'd like to stop, growing a steady amount after inflation, with the
// FI number as a flat dashed line, a marker where the line reaches it, and
// the stop age. One line, as decided: no band (Stress test keeps it), no
// history and no event pins. Its points are lib/fire/path.ts planPath's, the
// same figures as the FI card's rows, so the point at the stop age is the At
// age row's.
//
// Drawn at its own width (components/drawn-width.ts), its ages 12px, spaced
// by their widths so none overlap. No amount is written on the plot, so
// nothing on it needs hiding; the summary a screen reader reads goes through
// spoken() and the table's figures through Masked, so hide amounts covers
// both. A table of every year sits behind "Show as a table".

import { useMemo } from 'react';
import type { PathPoint } from '@/lib/fire/path';
import { compactMoney, spoken } from '@/lib/format';
import { pct, wholeMoney } from './plan-text';
import { Masked } from './HideAmounts';
import { FALLBACK_WIDTH, MIN_LABEL_GAP, labelWidth, useDrawnWidth } from './drawn-width';

/** Its height for its width: 130 to 340. */
const ASPECT = 130 / FALLBACK_WIDTH;
const PAD_X = 2;
// Room over the top for the FI number's label when the line runs near it.
const PAD_TOP = 16;
// Room under the baseline for the 12px ages.
const PAD_BOTTOM = 24;

type XLabel = { x: number; label: string; anchor: 'start' | 'middle' | 'end' };

export type PathChartProps = {
  /** The plan's path, a year a point, from today (planPath's points). */
  points: readonly PathPoint[];
  /** Today's age: where "today" is on the axis, apart from where the
   *  points start (another series may start before it). */
  today: number;
  stopAge: number;
  fiNumber: number | null;
  /** The age FI is reached at, as worked out (not rounded). */
  fiAge: number | null;
  realReturn: number;
  currency: string | null;
  /** The points are the walk's, with a scenario's life events. */
  withEvents?: boolean;
};

/** Where everything goes, in viewBox units (CSS pixels at its width): plain
 *  numbers only, so it can be kept between renders. */
function geometry(p: Pick<PathChartProps, 'points' | 'today' | 'stopAge' | 'fiNumber' | 'fiAge'>, W: number, H: number) {
  const { points, today, stopAge, fiNumber, fiAge } = p;
  const first = Math.min(today, points[0].age);
  const last = Math.max(stopAge, points[points.length - 1].age);
  const top = Math.max(fiNumber ?? 0, ...points.map((q) => q.balance), 1) * 1.08;
  const plotW = W - PAD_X * 2;
  const plotH = H - PAD_TOP - PAD_BOTTOM;
  const x = (age: number) => PAD_X + ((age - first) / Math.max(last - first, 1)) * plotW;
  const y = (v: number) => PAD_TOP + (1 - Math.max(0, v) / top) * plotH;
  const baseY = H - PAD_BOTTOM;
  const line = points.map((q, i) => `${i === 0 ? 'M' : 'L'}${x(q.age).toFixed(1)},${y(q.balance).toFixed(1)}`).join('');
  const end = points[points.length - 1];
  const area = `${line}L${x(end.age).toFixed(1)},${baseY}L${x(points[0].age).toFixed(1)},${baseY}Z`;
  // The marker: where the line reaches the FI number, on the line; today's
  // balance when it is there already.
  let marker: { x: number; y: number } | null = null;
  if (fiNumber !== null && fiAge !== null && fiAge >= points[0].age && fiAge <= end.age) {
    marker = fiAge <= points[0].age ? { x: x(points[0].age), y: y(points[0].balance) } : { x: x(fiAge), y: y(fiNumber) };
  }
  // Ages: today's at the start, the stop age at its line, the FI age at the
  // marker when there is room for it between them.
  const span = (t: XLabel) => {
    const w = labelWidth(t.label);
    return t.anchor === 'start' ? [t.x, t.x + w] : t.anchor === 'end' ? [t.x - w, t.x] : [t.x - w / 2, t.x + w / 2];
  };
  const apart = (a: XLabel, b: XLabel) => span(b)[0] - span(a)[1] >= MIN_LABEL_GAP;
  const start: XLabel = { x: x(today), label: `${today}`, anchor: 'start' };
  const stop: XLabel | null = stopAge > first ? { x: x(stopAge), label: `stop ${stopAge}`, anchor: 'end' } : null;
  const labels = [start];
  if (marker && fiAge !== null && Math.round(fiAge) !== today) {
    const fi: XLabel = { x: marker.x, label: `${Math.round(fiAge)}`, anchor: 'middle' };
    if (apart(start, fi) && (!stop || apart(fi, stop))) labels.push(fi);
  }
  if (stop && apart(start, stop)) labels.push(stop);
  const fiY = fiNumber !== null ? y(fiNumber) : null;
  return { x, y, baseY, line, area, marker, labels, fiY, stopX: stop ? x(stopAge) : null, crosses: marker !== null };
}

/** What the chart shows, in words, for a screen reader: built when drawn,
 *  never kept, so hide amounts says "hidden" for every figure in it. */
function summary(p: PathChartProps, stopped: boolean): string {
  const { points, stopAge, fiNumber, fiAge, currency } = p;
  const start = points[0];
  const end = points[points.length - 1];
  const parts = [`Invested assets ${end.balance >= start.balance ? 'grow' : 'fall'} from ${compactMoney(start.balance, currency)} at ${start.age}`];
  if (fiNumber !== null && start.balance >= fiNumber) parts.push(`already above the ${compactMoney(fiNumber, currency)} FI number`);
  else if (fiNumber !== null && fiAge !== null && fiAge <= end.age) parts.push(`reach the ${compactMoney(fiNumber, currency)} FI number around ${Math.round(fiAge)}`);
  else if (fiNumber !== null && points.every((q) => q.balance < fiNumber)) parts.push(`stay under the ${compactMoney(fiNumber, currency)} FI number`);
  parts.push(stopped ? `and the projection stops at ${end.age}, before ${stopAge}` : `and are about ${compactMoney(end.balance, currency)} at ${stopAge}`);
  return `${parts.join(', ')}, growing a steady ${pct(p.realReturn)} a year after inflation${p.withEvents ? ' with this scenario’s life events' : ''}.`;
}

export default function PlanPathChart(props: PathChartProps) {
  const { points, today, stopAge, fiNumber, fiAge, realReturn, currency, withEvents = false } = props;
  const [drawnRef, W] = useDrawnWidth<SVGSVGElement>();
  const H = Math.round(W * ASPECT);
  const geo = useMemo(() => geometry({ points, today, stopAge, fiNumber, fiAge }, W, H), [points, today, stopAge, fiNumber, fiAge, W, H]);
  const stopped = points[points.length - 1].age < stopAge;
  return (
    <div className="plan-path">
      <svg ref={drawnRef} className="chart-svg at-width" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={spoken(summary(props, stopped))}>
        <line x1={PAD_X} x2={W - PAD_X} y1={geo.baseY} y2={geo.baseY} stroke="var(--border-subtle)" strokeWidth={1} />
        {geo.fiY !== null && (
          <>
            <line x1={PAD_X} x2={W - PAD_X} y1={geo.fiY} y2={geo.fiY} stroke="var(--text-3)" strokeWidth={1} strokeDasharray="4 4" />
            {/* Under the line where the path has crossed it (it runs above
                there) and there is room above the axis, over it otherwise. */}
            <text className="chart-xlabel" x={W - PAD_X} y={geo.crosses && geo.fiY + 14 <= geo.baseY - 4 ? geo.fiY + 14 : geo.fiY - 5} textAnchor="end">
              FI number
            </text>
          </>
        )}
        <path d={geo.area} fill="var(--accent)" opacity={0.12} />
        <path d={geo.line} fill="none" stroke="var(--accent)" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
        {geo.stopX !== null && <line x1={geo.stopX} x2={geo.stopX} y1={PAD_TOP} y2={geo.baseY} stroke="var(--text-3)" strokeWidth={1} />}
        {geo.marker && <circle cx={geo.marker.x} cy={geo.marker.y} r={4} fill="var(--pos)" stroke="var(--surface)" strokeWidth={2} />}
        {geo.labels.map((t) => (
          <text key={t.label} className="chart-xlabel" x={t.x} y={H - 6} textAnchor={t.anchor}>
            {t.label}
          </text>
        ))}
      </svg>
      <div className="as-of">
        {`At a steady ${pct(realReturn)} a year after inflation${withEvents ? ', with this scenario’s life events' : ''}. Real markets don’t move steadily; Stress test shows how much that matters.`}
      </div>
      <details className="plan-table-view">
        <summary>Show as a table</summary>
        <table>
          <thead>
            <tr>
              <th>Age</th>
              <th className="num">Invested</th>
            </tr>
          </thead>
          <tbody>
            {points.map((q) => (
              <tr key={q.age}>
                <td>{q.age === stopAge ? `${q.age} (stop)` : q.age}</td>
                <td className="num">
                  <Masked>{wholeMoney(q.balance, currency)}</Masked>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </div>
  );
}
