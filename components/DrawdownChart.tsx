'use client';

// Year by year's chart (the tax plan's T3): the balances by bucket from the start to
// the plan's end, stacked, each in the color Portfolio gives its bucket, with marks at
// your 59½, 65, Social Security's start and the RMD age. A mark's name goes on the
// first row where it clears those before it, so none is lost at 320px. No amount is
// written on the plot; the summary and the table say them, through spoken() and Masked.

import { useMemo } from 'react';
import { BUCKET_NAMES } from '@/lib/allocation/buckets';
import type { BucketBalances, DrawdownYear } from '@/lib/fire/drawdown';
import { spoken } from '@/lib/format';
import { BUCKET_COLORS } from './allocation-text';
import { FALLBACK_WIDTH, MIN_LABEL_GAP, labelWidth, useDrawnWidth } from './drawn-width';
import { Masked } from './HideAmounts';

const ASPECT = 130 / FALLBACK_WIDTH;
const PAD_X = 2;
const PAD_BOTTOM = 24;
const MARK_ROW = 14;

const LAYERS = [
  { key: 'taxable', slot: 'taxable' },
  { key: 'deferred', slot: 'tax-deferred' },
  { key: 'roth', slot: 'roth' },
  { key: 'hsa', slot: 'hsa' },
] as const;

/** `label` names it; `short` is what fits on an axis of ages. */
export type DrawdownMark = { age: number; label: string; short: string };

/** Each mark's row, the fewest the names need. */
export function markRows(marks: readonly { x: number; label: string }[]): number[] {
  const ends: number[] = [];
  return marks.map((m) => {
    const w = labelWidth(m.label);
    let row = ends.findIndex((end) => m.x >= end + MIN_LABEL_GAP);
    if (row < 0) row = ends.length;
    ends[row] = m.x + w;
    return row;
  });
}

type Point = { age: number; balances: BucketBalances };

/** A year a point, its opening balances, then the last year's close. */
export function chartPoints(years: readonly DrawdownYear[]): Point[] {
  const points = years.map((y) => ({ age: y.age, balances: y.start }));
  const last = years[years.length - 1];
  if (last) points.push({ age: last.age + 1, balances: last.end });
  return points;
}

const totalOf = (b: BucketBalances) => b.taxable + b.deferred + b.roth + b.hsa;

export default function DrawdownChart({ years, marks, money }: { years: readonly DrawdownYear[]; marks: readonly DrawdownMark[]; money: (n: number) => string }) {
  const [drawnRef, W] = useDrawnWidth<SVGSVGElement>();
  const points = useMemo(() => chartPoints(years), [years]);
  const first = points[0]?.age ?? 0;
  const last = points[points.length - 1]?.age ?? 1;
  const plotW = W - PAD_X * 2;
  const x = (age: number) => PAD_X + ((age - first) / Math.max(last - first, 1)) * plotW;
  // A name near the right edge ends there, and its row is found from where it starts.
  const shown = marks
    .filter((m) => m.age > first && m.age < last)
    .map((m) => ({ ...m, at: x(m.age), x: Math.min(x(m.age), W - PAD_X - labelWidth(m.label)) }));
  const rows = markRows(shown);
  const padTop = (rows.length > 0 ? Math.max(...rows) + 1 : 0) * MARK_ROW + 4;
  const H = Math.round(W * ASPECT) + padTop;
  const baseY = H - PAD_BOTTOM;
  const top = Math.max(1, ...points.map((p) => totalOf(p.balances))) * 1.05;
  const y = (v: number) => baseY - (Math.max(0, v) / top) * (baseY - padTop);

  // Each layer between the sum of those under it and the sum with it.
  const areas = LAYERS.map((layer, i) => {
    const under = LAYERS.slice(0, i);
    const low = (b: BucketBalances) => under.reduce((n, l) => n + b[l.key], 0);
    const upper = points.map((p) => `${x(p.age).toFixed(1)},${y(low(p.balances) + p.balances[layer.key]).toFixed(1)}`);
    const lower = [...points].reverse().map((p) => `${x(p.age).toFixed(1)},${y(low(p.balances)).toFixed(1)}`);
    const held = points.some((p) => p.balances[layer.key] >= 0.5);
    return { ...layer, held, d: `M${upper.join('L')}L${lower.join('L')}Z` };
  }).filter((a) => a.held);

  const end = points[points.length - 1];
  const start = points[0];
  const summary = start && end ? `Invested assets by tax bucket, ${money(totalOf(start.balances))} at ${start.age} and ${money(totalOf(end.balances))} at ${end.age}, at a steady growth.` : 'Invested assets by tax bucket.';
  const held = areas.map((a) => a.key);
  return (
    <div className="plan-path">
      <svg ref={drawnRef} className="chart-svg at-width" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={spoken(summary)}>
        {areas.map((a) => (
          <path key={a.key} d={a.d} fill={BUCKET_COLORS[a.slot]} />
        ))}
        <line x1={PAD_X} x2={W - PAD_X} y1={baseY} y2={baseY} stroke="var(--border-subtle)" strokeWidth={1} />
        {shown.map((m, i) => (
          <g key={m.label}>
            <line x1={m.at} x2={m.at} y1={(rows[i] + 1) * MARK_ROW} y2={baseY} stroke="var(--text-3)" strokeWidth={1} />
            <text className="chart-xlabel" x={m.x} y={(rows[i] + 1) * MARK_ROW - 3}>
              {m.label}
            </text>
          </g>
        ))}
        <text className="chart-xlabel" x={PAD_X} y={H - 6}>
          {first}
        </text>
        <text className="chart-xlabel" x={W - PAD_X} y={H - 6} textAnchor="end">
          {last}
        </text>
      </svg>
      <div className="chart-legend chart-legend-wrap">
        {areas.map((a) => (
          <span key={a.key} className="chart-legend-item">
            <i className="chart-legend-dot" style={{ background: BUCKET_COLORS[a.slot] }} aria-hidden="true" />
            {BUCKET_NAMES[a.slot]}
          </span>
        ))}
      </div>
      <details className="plan-table-view">
        <summary>Show as a table</summary>
        <div className="plan-table-scroll">
          <table>
            <caption className="visually-hidden">Invested assets by tax bucket, by age</caption>
            <thead>
              <tr>
                <th scope="col">Age</th>
                {LAYERS.filter((l) => held.includes(l.key)).map((l) => (
                  <th key={l.key} scope="col" className="num">
                    {BUCKET_NAMES[l.slot]}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {points.map((p) => (
                <tr key={p.age}>
                  <td>{p.age}</td>
                  {LAYERS.filter((l) => held.includes(l.key)).map((l) => (
                    <td key={l.key} className="num">
                      <Masked>{money(p.balances[l.key])}</Masked>
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </div>
  );
}
