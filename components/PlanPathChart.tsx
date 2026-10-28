'use client';

// Your path's chart (rollout phase 8b): invested assets from today to the
// age you'd like to stop, growing a steady amount after inflation, with the
// FI number as a flat dashed line, a marker where the line reaches it, and
// the stop age. No band (Stress test keeps it) and no event pins. Its points
// are lib/fire/path.ts planPath's, the same figures as the FI card's rows, so
// the point at the stop age is the At age row's.
//
// Before today, once a plan is saved as your plan (rollout 8e,
// components/PlanProgress.tsx progressOverlay): invested assets as recorded
// since its start, a solid line, and where that plan had them on the same
// days, a dotted one, said in words under the chart, in the summary and in a
// table of their own. Both in each day's money, which is today's dollars on
// today, where the path starts.
//
// Drawn at its own width (components/drawn-width.ts), its ages 12px, spaced
// by their widths so none overlap. No amount is written on the plot, so
// nothing on it needs hiding; the summary a screen reader reads goes through
// spoken() and the table's figures through Masked, so hide amounts covers
// both. A table of every year sits behind "Show as a table".

import { useMemo } from 'react';
import type { PathPoint } from '@/lib/fire/path';
import { compactMoney, spoken } from '@/lib/format';
import { dayName, pct, wholeMoney } from './plan-text';
import { Masked } from './HideAmounts';
import type { ProgressOverlay } from './PlanProgress';
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
  /** What was recorded since the plan saved as your plan, and where it had
   *  you, before today (rollout 8e). */
  recorded?: ProgressOverlay | null;
};

/** Where everything goes, in viewBox units (CSS pixels at its width): plain
 *  numbers only, so it can be kept between renders. */
function geometry(p: Pick<PathChartProps, 'points' | 'today' | 'stopAge' | 'fiNumber' | 'fiAge' | 'recorded'>, W: number, H: number) {
  const { points, today, stopAge, fiNumber, fiAge, recorded = null } = p;
  const before = recorded ? [...recorded.recorded, ...recorded.planned] : [];
  const first = Math.min(today, points[0].age, ...before.map((q) => q.age));
  const last = Math.max(stopAge, points[points.length - 1].age);
  const top = Math.max(fiNumber ?? 0, ...points.map((q) => Math.max(q.balance, q.inHand ?? 0)), ...before.map((q) => q.balance), 1) * 1.08;
  const plotW = W - PAD_X * 2;
  const plotH = H - PAD_TOP - PAD_BOTTOM;
  const x = (age: number) => PAD_X + ((age - first) / Math.max(last - first, 1)) * plotW;
  const y = (v: number) => PAD_TOP + (1 - Math.max(0, v) / top) * plotH;
  const baseY = H - PAD_BOTTOM;
  // A year with money in (a windfall) steps straight up at its age, to what
  // is in hand once it has come in (lib/fire/path.ts). The lines before
  // today have none: what was recorded, and where the saved plan had it.
  const lineOf = (qs: readonly PathPoint[]) =>
    qs
      .map((q, i) => `${i === 0 ? 'M' : 'L'}${x(q.age).toFixed(1)},${y(q.balance).toFixed(1)}${q.inHand !== undefined ? `L${x(q.age).toFixed(1)},${y(q.inHand).toFixed(1)}` : ''}`)
      .join('');
  const line = lineOf(points);
  const recordedLine = recorded ? lineOf(recorded.recorded) : null;
  const plannedLine = recorded ? lineOf(recorded.planned) : null;
  const end = points[points.length - 1];
  const area = `${line}L${x(end.age).toFixed(1)},${baseY}L${x(points[0].age).toFixed(1)},${baseY}Z`;
  // The marker: where the line reaches the FI number, on the line; today's
  // balance when it is there already.
  let marker: { x: number; y: number } | null = null;
  if (fiNumber !== null && fiAge !== null && fiAge >= points[0].age && fiAge <= end.age) {
    // Today's balance below the FI number with money in today: on its step.
    marker = fiAge <= points[0].age && points[0].balance >= fiNumber ? { x: x(points[0].age), y: y(points[0].balance) } : { x: x(Math.max(fiAge, points[0].age)), y: y(fiNumber) };
  }
  // Ages: today's at the start, the stop age at its line, the FI age at the
  // marker when there is room for it between them.
  const span = (t: XLabel) => {
    const w = labelWidth(t.label);
    return t.anchor === 'start' ? [t.x, t.x + w] : t.anchor === 'end' ? [t.x - w, t.x] : [t.x - w / 2, t.x + w / 2];
  };
  const apart = (a: XLabel, b: XLabel) => span(b)[0] - span(a)[1] >= MIN_LABEL_GAP;
  // Today's age where the path starts; with lines before it, under it, and
  // the start's age at the left.
  // The start's whole age, never one that rounds up past where it is.
  const start: XLabel = recorded ? { x: x(first), label: `${Math.floor(first)}`, anchor: 'start' } : { x: x(today), label: `${today}`, anchor: 'start' };
  const stop: XLabel | null = stopAge > first ? { x: x(stopAge), label: `stop ${stopAge}`, anchor: 'end' } : null;
  const labels = [start];
  if (marker && fiAge !== null && Math.round(fiAge) !== today) {
    const fi: XLabel = { x: marker.x, label: `${Math.round(fiAge)}`, anchor: 'middle' };
    if (apart(start, fi) && (!stop || apart(fi, stop))) labels.push(fi);
  }
  if (stop && apart(start, stop)) labels.push(stop);
  const fiY = fiNumber !== null ? y(fiNumber) : null;
  if (recorded) {
    const now: XLabel = { x: x(today), label: `today ${today}`, anchor: 'middle' };
    if (apart(start, now) && labels.slice(1).every((l) => (l.x < now.x ? apart(l, now) : apart(now, l)))) labels.push(now);
  }
  return { x, y, baseY, line, area, marker, labels, fiY, stopX: stop ? x(stopAge) : null, crosses: marker !== null, recordedLine, plannedLine, todayX: recorded ? x(today) : null };
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
  const path = `${parts.join(', ')}, growing a steady ${pct(p.realReturn)} a year after inflation${p.withEvents ? ' with this scenario’s life events' : ''}.`;
  return p.recorded ? `${recordedWords(p.recorded, currency)} ${path}` : path;
}

/** The lines before today, in words: from the start to the newest day
 *  recorded, and where the plan had you then. */
function recordedWords(r: ProgressOverlay, currency: string | null): string {
  const first = r.recorded[0];
  const last = r.recorded[r.recorded.length - 1];
  const planned = r.planned[r.planned.length - 1];
  return `Since ${dayName(r.from)}, invested assets as recorded went from ${compactMoney(first.balance, currency)} to ${compactMoney(last.balance, currency)} on ${dayName(r.days[r.days.length - 1])}, where your plan from ${dayName(r.savedDay)} had ${compactMoney(planned.balance, currency)}.`;
}

export default function PlanPathChart(props: PathChartProps) {
  const { points, today, stopAge, fiNumber, fiAge, realReturn, currency, withEvents = false, recorded = null } = props;
  const [drawnRef, W] = useDrawnWidth<SVGSVGElement>();
  const H = Math.round(W * ASPECT);
  const geo = useMemo(() => geometry({ points, today, stopAge, fiNumber, fiAge, recorded }, W, H), [points, today, stopAge, fiNumber, fiAge, recorded, W, H]);
  const stopped = points[points.length - 1].age < stopAge;
  return (
    <div className="plan-path">
      <svg ref={drawnRef} className="chart-svg at-width" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={spoken(summary(props, stopped))}>
        {/* The wash first: it is solid (gold drawn see-through over the
            light canvas turns a grey beige), so the axis, the FI line and
            its label go over it. */}
        <path d={geo.area} fill="var(--data-tint)" />
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
        <path d={geo.line} fill="none" stroke="var(--data)" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
        {geo.stopX !== null && <line x1={geo.stopX} x2={geo.stopX} y1={PAD_TOP} y2={geo.baseY} stroke="var(--text-3)" strokeWidth={1} />}
        {geo.todayX !== null && <line x1={geo.todayX} x2={geo.todayX} y1={PAD_TOP} y2={geo.baseY} stroke="var(--border-subtle)" strokeWidth={1} />}
        {geo.plannedLine && <path d={geo.plannedLine} fill="none" stroke="var(--text-2)" strokeWidth={2} strokeDasharray="2 4" strokeLinecap="round" />}
        {geo.recordedLine && <path d={geo.recordedLine} fill="none" stroke="var(--text-1)" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />}
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
      {recorded && (
        <div className="as-of">{`Before today: your invested assets as recorded since ${dayName(recorded.from)} (the solid line), and where your plan from ${dayName(recorded.savedDay)} had them (the dotted line), in each day’s money. Progress, below, says more.`}</div>
      )}
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
                  <Masked>{q.inHand === undefined ? wholeMoney(q.balance, currency) : `${wholeMoney(q.balance, currency)}, then ${wholeMoney(q.inHand, currency)} once that year’s windfall is in and its costs are paid`}</Masked>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {recorded && (
          <table>
            <thead>
              <tr>
                <th>Since your plan</th>
                <th className="num">Recorded</th>
                <th className="num">Your plan</th>
              </tr>
            </thead>
            <tbody>
              {recorded.days.map((d, i) => (
                <tr key={d}>
                  <td>{dayName(d)}</td>
                  <td className="num">
                    <Masked>{wholeMoney(recorded.recorded[i].balance, currency)}</Masked>
                  </td>
                  <td className="num">
                    <Masked>{wholeMoney(recorded.planned[i].balance, currency)}</Masked>
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
