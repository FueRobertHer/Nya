'use client';

// Your path's chart (rollout phase 8b): invested assets from today to the
// age you'd like to stop, growing a steady amount after inflation, with the
// FI number as a flat dashed line, a marker where the line reaches it, and
// the stop age. No band (Drawdown keeps it) and no event pins. Its points
// are lib/fire/path.ts planPath's, the same figures as the FI card's rows, so
// the point at the stop age is the At age row's.
//
// Whole path (the tax plan's P, D13): the same line on past the stop to the
// plan's end, drawing the plan's spending at the same steady return
// (planPath's `after`), with a switch under the plot between the two ranges.
// The wash and the FI number's dashed line cover the saving years only; the
// FI number's name goes at its line's end, or, where the line is too short
// for it or the lines there would cross it, at its left end over the lines
// (.chart-rule-label, haloed in the page's color). Once the stop
// has come there are no saving years: the chart is the drawdown from today,
// with no switch and no FI number.
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
import type { PathAfter, PathPoint, PathRange } from '@/lib/fire/path';
import { onDay, spoken } from '@/lib/format';
import { dayLabel, dayName, leftOutText, pct, wholeMoney } from './plan-text';
import { Masked } from './HideAmounts';
import type { ProgressOverlay } from './PlanProgress';
import { Segmented } from './Segmented';
import { FALLBACK_WIDTH, MIN_LABEL_GAP, labelWidth, useDrawnWidth } from './drawn-width';

/** Its height for its width: 130 to 340. */
const ASPECT = 130 / FALLBACK_WIDTH;
const PAD_X = 2;
// Room over the top for the FI number's label when the line runs near it.
const PAD_TOP = 16;
// Room under the baseline for the 12px ages.
const PAD_BOTTOM = 24;
const FI_NAME = 'FI number';
// A rule's name sits this far over its line, and is this tall (as the cash
// forecast's, components/ForecastChart.tsx).
const RULE_LABEL_GAP = 4;
const RULE_LABEL_HEIGHT = 12;
// "stop 50" this far from its rule on Whole path.
const STOP_GAP = 4;

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
  /** The points are the walk's, with the plan's life events. */
  withEvents?: boolean;
  /** What moved the walk, in its words (components/plan-text.ts walkWords),
   *  when it isn't the plan's life events alone. */
  walkWords?: string | null;
  /** What was recorded since the plan saved as your plan, and where it had
   *  you, before today (rollout 8e). */
  recorded?: ProgressOverlay | null;
  /** The years after the stop (planPath's `after`), for Whole path. */
  after?: PathAfter | null;
  /** The range shown: to the stop when left out. */
  range?: PathRange;
  /** Offers the switch between the two ranges, where there are years on
   *  both sides of the stop. */
  onRange?: (range: PathRange) => void;
};

/** Whether the chart shows the whole path: asked for, with years after the
 *  stop to draw, or with none before it (the stop has come). A path that
 *  can't pay its first year after the stop still has one: its line ends at
 *  the stop, the axis runs on to the end, and the line under it says so. */
export function wholeShown(points: readonly PathPoint[], after: PathAfter | null | undefined, range: PathRange | undefined): boolean {
  if (!after || points.length + after.points.length < 3) return false;
  return range === 'whole' || points.length < 2;
}

/** Whether every line keeps to one side of the value `v` (at or above it, or
 *  at or below it) from x0 to x1, so a name on the other side is clear of
 *  them there. A line is straight between its points, so its points in the
 *  span and where it crosses the span's edges are enough. */
function keepsTo(lines: readonly (readonly PathPoint[])[], x: (age: number) => number, x0: number, x1: number, v: number, above: boolean): boolean {
  const ok = (b: number) => (above ? b >= v : b <= v);
  for (const qs of lines) {
    for (let i = 0; i < qs.length; i++) {
      const q = qs[i];
      const qx = x(q.age);
      // A windfall's step runs from the balance up to what is in hand.
      const from = q.inHand ?? q.balance;
      if (qx >= x0 && qx <= x1 && !(ok(q.balance) && ok(from))) return false;
      const next = qs[i + 1];
      if (!next) continue;
      const nx = x(next.age);
      for (const edge of [x0, x1]) if (qx < edge && nx > edge && !ok(from + ((next.balance - from) * (edge - qx)) / (nx - qx))) return false;
    }
  }
  return true;
}

/** Where everything goes, in viewBox units (CSS pixels at its width): plain
 *  numbers only, so it can be kept between renders. `after` only on Whole
 *  path. */
function geometry(p: Pick<PathChartProps, 'points' | 'today' | 'stopAge' | 'fiNumber' | 'fiAge' | 'recorded'> & { after: PathAfter | null }, W: number, H: number) {
  const { points, today, stopAge, fiAge, recorded = null, after } = p;
  // No saving years (the stop has come): no FI number to reach.
  const saving = points.length >= 2;
  const fiNumber = after && !saving ? null : p.fiNumber;
  const all = after ? [...points, ...after.points.slice(1)] : points;
  const before = recorded ? [...recorded.recorded, ...recorded.planned] : [];
  const first = Math.min(today, points[0].age, ...before.map((q) => q.age));
  const last = after ? Math.max(after.endAge, all[all.length - 1].age) : Math.max(stopAge, points[points.length - 1].age);
  const top = Math.max(fiNumber ?? 0, ...all.map((q) => Math.max(q.balance, q.inHand ?? 0)), ...before.map((q) => q.balance), 1) * 1.08;
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
  const line = lineOf(all);
  const recordedLine = recorded ? lineOf(recorded.recorded) : null;
  const plannedLine = recorded ? lineOf(recorded.planned) : null;
  // The wash under the saving years only.
  const end = points[points.length - 1];
  const area = saving || !after ? `${lineOf(points)}L${x(end.age).toFixed(1)},${baseY}L${x(points[0].age).toFixed(1)},${baseY}Z` : null;
  // The marker: where the line reaches the FI number, on the line, by the
  // stop; today's balance when it is there already.
  let marker: { x: number; y: number } | null = null;
  if (fiNumber !== null && fiAge !== null && fiAge >= points[0].age && fiAge <= end.age) {
    // Today's balance below the FI number with money in today: on its step.
    marker = fiAge <= points[0].age && points[0].balance >= fiNumber ? { x: x(points[0].age), y: y(points[0].balance) } : { x: x(Math.max(fiAge, points[0].age)), y: y(fiNumber) };
  }
  const span = (t: XLabel) => {
    const w = labelWidth(t.label);
    return t.anchor === 'start' ? [t.x, t.x + w] : t.anchor === 'end' ? [t.x - w, t.x] : [t.x - w / 2, t.x + w / 2];
  };
  const apart = (a: XLabel, b: XLabel) => span(b)[0] - span(a)[1] >= MIN_LABEL_GAP;
  const clear = (a: XLabel, b: XLabel) => (span(a)[0] <= span(b)[0] ? apart(a, b) : apart(b, a));
  // Today's age where the path starts; with lines before it, under it, and
  // the start's age at the left.
  // The start's whole age, never one that rounds up past where it is.
  const start: XLabel = recorded ? { x: x(first), label: `${Math.floor(first)}`, anchor: 'start' } : { x: x(today), label: `${today}`, anchor: 'start' };
  const fi: XLabel | null = marker && fiAge !== null && Math.round(fiAge) !== today ? { x: marker.x, label: `${Math.round(fiAge)}`, anchor: 'middle' } : null;
  const now: XLabel | null = recorded ? { x: x(today), label: `today ${today}`, anchor: 'middle' } : null;
  let labels: XLabel[];
  if (!after) {
    // Ages: today's at the start, the stop age at its line, the FI age at the
    // marker when there is room for it between them.
    const stop: XLabel | null = stopAge > first ? { x: x(stopAge), label: `stop ${stopAge}`, anchor: 'end' } : null;
    labels = [start];
    if (fi && apart(start, fi) && (!stop || apart(fi, stop))) labels.push(fi);
    if (stop && apart(start, stop)) labels.push(stop);
    if (now && apart(start, now) && labels.slice(1).every((l) => (l.x < now.x ? apart(l, now) : apart(now, l)))) labels.push(now);
  } else {
    // The stop after its rule (before it where that would run past the
    // right edge), the end at the right. The start's age always stays, as
    // To 50's does; where two others would crowd, the FI age goes first,
    // then today, the end, and the stop last.
    let stop: XLabel | null = null;
    if (stopAge > first) {
      const sx = x(stopAge);
      stop = { x: sx + STOP_GAP, label: `stop ${stopAge}`, anchor: 'start' };
      if (span(stop)[1] > W - PAD_X) stop = { x: sx - STOP_GAP, label: stop.label, anchor: 'end' };
    }
    const endAt: XLabel = { x: W - PAD_X, label: `${after.endAge}`, anchor: 'end' };
    labels = [start];
    for (const l of [stop, endAt, now, fi]) if (l && labels.every((k) => clear(k, l))) labels.push(l);
    labels.sort((a, b) => span(a)[0] - span(b)[0]);
  }
  const fiY = fiNumber !== null ? y(fiNumber) : null;
  // The FI number's line: across the plot to the stop; on Whole path, the
  // saving years only. Its name at that end, or at its left end over the
  // lines where the line is shorter than the name. On Whole path the scale
  // runs to the plan's end, so the name's width is a few years and the line
  // often sits low: the name stays at the line's end only where the lines
  // keep to its other side there (above it while the name is under it,
  // below it while the name is above it), else it goes at the left end too.
  const fiX2 = after ? x(stopAge) : W - PAD_X;
  let fiName: { x: number; y: number; rule: boolean } | null = null;
  if (fiY !== null && fiNumber !== null) {
    const under = marker !== null && fiY + 14 <= baseY - 4;
    const nameW = labelWidth(FI_NAME);
    const lines = recorded ? [points, recorded.recorded, recorded.planned] : [points];
    if (fiX2 - PAD_X >= nameW && (!after || keepsTo(lines, x, fiX2 - nameW, fiX2, fiNumber, under))) fiName = { x: fiX2, y: under ? fiY + 14 : fiY - 5, rule: false };
    else fiName = { x: PAD_X, y: fiY - RULE_LABEL_GAP - RULE_LABEL_HEIGHT >= 0 ? fiY - RULE_LABEL_GAP : fiY + RULE_LABEL_GAP + RULE_LABEL_HEIGHT, rule: true };
  }
  return { x, y, baseY, line, area, marker, labels, fiY, fiX2, fiName, stopX: stopAge > first ? x(stopAge) : null, recordedLine, plannedLine, todayX: recorded ? x(today) : null };
}

/** What the chart shows, in words, for a screen reader: built when drawn,
 *  never kept, so hide amounts says "hidden" for every figure in it. */
function summary(p: PathChartProps, stopped: boolean, after: PathAfter | null): string {
  const { points, stopAge, fiNumber, fiAge, currency } = p;
  const start = points[0];
  const end = points[points.length - 1];
  const events = p.walkWords ? ` with ${p.walkWords}` : p.withEvents || after?.withEvents ? ' with this plan’s items' : '';
  const wrap = (path: string) => (p.recorded ? `${recordedWords(p.recorded, currency)} ${path}` : path);
  const last = after ? after.points[after.points.length - 1] : null;
  const tail = after ? (after.runsOutAt !== null ? `run out at ${after.runsOutAt}` : `about ${wholeMoney((last as PathPoint).balance, currency)} at ${after.endAge}`) : '';
  if (after && points.length < 2) {
    const went = after.runsOutAt !== null ? `and ${tail}` : `to ${tail}`;
    return wrap(`Invested assets go from ${wholeMoney(start.balance, currency)} at ${start.age}, drawing your spending, ${went}, at a steady ${pct(p.realReturn)} a year after inflation${events}.`);
  }
  const parts = [`Invested assets ${end.balance >= start.balance ? 'grow' : 'fall'} from ${wholeMoney(start.balance, currency)} at ${start.age}`];
  if (fiNumber !== null && start.balance >= fiNumber) parts.push(`already above the ${wholeMoney(fiNumber, currency)} FI number`);
  else if (fiNumber !== null && fiAge !== null && fiAge <= end.age) parts.push(`reach the ${wholeMoney(fiNumber, currency)} FI number around ${Math.round(fiAge)}`);
  else if (fiNumber !== null && points.every((q) => q.balance < fiNumber)) parts.push(`stay under the ${wholeMoney(fiNumber, currency)} FI number`);
  parts.push(stopped ? `and the projection stops at ${end.age}, before ${stopAge}` : `and are about ${wholeMoney(end.balance, currency)} at ${stopAge}`);
  if (after) return wrap(`${parts.join(', ')}, then, drawing your spending, ${tail}, at a steady ${pct(p.realReturn)} a year after inflation${events}.`);
  return wrap(`${parts.join(', ')}, growing a steady ${pct(p.realReturn)} a year after inflation${events}.`);
}

/** The lines before today, in words: from the start to the newest day
 *  recorded, and where the plan had you then. */
function recordedWords(r: ProgressOverlay, currency: string | null): string {
  const first = r.recorded[0];
  const last = r.recorded[r.recorded.length - 1];
  const planned = r.planned[r.planned.length - 1];
  return `Since ${dayName(r.from)}, invested assets as recorded went from ${wholeMoney(first.balance, currency)} to ${wholeMoney(last.balance, currency)} ${onDay(dayName(r.days[r.days.length - 1]))}, where your plan from ${dayName(r.savedDay)} had ${wholeMoney(planned.balance, currency)}.`;
}

export default function PlanPathChart(props: PathChartProps) {
  const { points, today, stopAge, fiNumber, fiAge, realReturn, currency, withEvents = false, walkWords = null, recorded = null, range, onRange } = props;
  const whole = wholeShown(points, props.after, range);
  const after = whole ? (props.after as PathAfter) : null;
  const [drawnRef, W] = useDrawnWidth<SVGSVGElement>();
  const H = Math.round(W * ASPECT);
  const geo = useMemo(() => geometry({ points, today, stopAge, fiNumber, fiAge, recorded, after }, W, H), [points, today, stopAge, fiNumber, fiAge, recorded, after, W, H]);
  const stopped = points[points.length - 1].age < stopAge;
  const rows = after ? [...points, ...after.points.slice(1)] : points;
  const switchable = onRange !== undefined && points.length >= 2 && wholeShown(points, props.after, 'whole');
  const leftOut = after ? leftOutText(after.leftOut) : null;
  return (
    <div className="plan-path">
      <svg ref={drawnRef} className="chart-svg at-width" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={spoken(summary(props, stopped, after))}>
        {/* The wash first: it is solid (gold drawn see-through over the
            light canvas turns a grey beige), so the axis, the FI line and
            its label go over it. */}
        {geo.area && <path d={geo.area} fill="var(--data-tint)" />}
        <line x1={PAD_X} x2={W - PAD_X} y1={geo.baseY} y2={geo.baseY} stroke="var(--border-subtle)" strokeWidth={1} />
        {geo.fiY !== null && (
          <>
            <line x1={PAD_X} x2={geo.fiX2} y1={geo.fiY} y2={geo.fiY} stroke="var(--text-3)" strokeWidth={1} strokeDasharray="4 4" />
            {/* Under the line where the path has crossed it (it runs above
                there) and there is room above the axis, over it otherwise. */}
            {geo.fiName && !geo.fiName.rule && (
              <text className="chart-xlabel" x={geo.fiName.x} y={geo.fiName.y} textAnchor="end">
                {FI_NAME}
              </text>
            )}
          </>
        )}
        <path d={geo.line} fill="none" stroke="var(--data)" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
        {geo.stopX !== null && <line x1={geo.stopX} x2={geo.stopX} y1={PAD_TOP} y2={geo.baseY} stroke="var(--text-3)" strokeWidth={1} />}
        {geo.todayX !== null && <line x1={geo.todayX} x2={geo.todayX} y1={PAD_TOP} y2={geo.baseY} stroke="var(--border-subtle)" strokeWidth={1} />}
        {geo.plannedLine && <path d={geo.plannedLine} fill="none" stroke="var(--text-2)" strokeWidth={2} strokeDasharray="2 4" strokeLinecap="round" />}
        {geo.recordedLine && <path d={geo.recordedLine} fill="none" stroke="var(--text-1)" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />}
        {geo.marker && <circle cx={geo.marker.x} cy={geo.marker.y} r={4} fill="var(--pos)" stroke="var(--surface)" strokeWidth={2} />}
        {/* A short line's name, at its left end: over everything, haloed in
            the card's color, so no line crossing it hides the word. */}
        {geo.fiName?.rule && (
          <text className="chart-rule-label" x={geo.fiName.x} y={geo.fiName.y}>
            {FI_NAME}
          </text>
        )}
        {geo.labels.map((t) => (
          <text key={t.label} className="chart-xlabel" x={t.x} y={H - 6} textAnchor={t.anchor}>
            {t.label}
          </text>
        ))}
      </svg>
      {switchable && (
        <Segmented
          compact
          className="chart-range-switch"
          label="Range"
          value={whole ? 'whole' : 'stop'}
          onChange={onRange}
          options={[
            ['stop', `To ${stopAge}`],
            ['whole', 'Whole path'],
          ]}
        />
      )}
      <div className="as-of">
        {`At a steady ${pct(realReturn)} a year after inflation${walkWords ? `, with ${walkWords}` : withEvents || after?.withEvents ? ', with this plan’s items' : ''}. Real markets don’t move steadily; Drawdown shows how much that matters.`}
      </div>
      {leftOut && <div className="as-of">{leftOut}</div>}
      {after && after.runsOutAt !== null && <div className="as-of">{`On this steady path your invested assets run out at ${after.runsOutAt}.`}</div>}
      {recorded && (
        <div className="as-of">{`Before today: your invested assets as recorded since ${dayName(recorded.from)} (the solid line), and where your plan from ${dayName(recorded.savedDay)} had them (the dotted line), in each day’s money. Progress, below, says more.`}</div>
      )}
      <details className="plan-table-view">
        <summary>Show as a table</summary>
        <table>
          <caption className="visually-hidden">Invested assets by age</caption>
          <thead>
            <tr>
              <th scope="col">Age</th>
              <th scope="col" className="num">Invested</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((q) => (
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
            <caption className="visually-hidden">Recorded and planned since your plan</caption>
            <thead>
              <tr>
                <th scope="col">Since your plan</th>
                <th scope="col" className="num">Recorded</th>
                <th scope="col" className="num">Your plan</th>
              </tr>
            </thead>
            <tbody>
              {recorded.days.map((d, i) => (
                <tr key={d}>
                  <td>{dayLabel(d)}</td>
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
