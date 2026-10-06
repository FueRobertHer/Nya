'use client';

// The success-rate grid: the plan at several withdrawal rates (rows) and
// lengths (columns). A table first, since the numbers are the point, with a
// single-hue wash behind each cell (more success, more accent) as a heatmap
// cue; the figures, not the colour, carry the value. The plan's own cell is
// outlined. Each cell's title spells it out for a pointer or screen reader.
//
// For a rule that cannot run out by itself (percent of portfolio), every cell
// would read 100%, so the grid shows instead how far spending fell: the
// lowest year's spending as a share of the first year's, among the starts
// that lasted.

import type { GridCell } from '@/lib/fire/simulate';
import { pct, successText } from './plan-text';

export type GridMetric = 'success' | 'spending';

export default function PlanGrid({
  cells,
  rates,
  horizons,
  current,
  metric,
  pathsNoun,
}: {
  /** Null while it is still being worked out. */
  cells: GridCell[] | null;
  rates: number[];
  horizons: number[];
  /** The plan's own rate and length, outlined. */
  current: { rate: number; years: number };
  metric: GridMetric;
  /** "starts" or "runs", for the cell titles. */
  pathsNoun: string;
}) {
  const at = (rate: number, years: number) => cells?.find((c) => c.rate === rate && c.years === years) ?? null;

  function cell(rate: number, years: number) {
    const c = at(rate, years);
    const value = c ? (metric === 'success' ? c.successRate : c.lowestSpendingShare) : null;
    const own = Math.abs(rate - current.rate) < 1e-9 && years === current.years;
    let text = '…';
    let title = `${pct(rate)} for ${years} years: working it out`;
    if (c && value !== null) {
      text = metric === 'success' ? successText(value) : pct(value, 0);
      title =
        metric === 'success'
          ? `${pct(rate)} for ${years} years: ${successText(value, 1)} of ${c.paths.toLocaleString()} ${pathsNoun} lasted`
          : `${pct(rate)} for ${years} years: in the worst ${pathsNoun.replace(/s$/, '')} that lasted, the lowest year's spending was ${pct(value, 0)} of the first year's`;
    } else if (c) {
      text = '--';
      title = `${pct(rate)} for ${years} years: no ${pathsNoun} lasted`;
    }
    // More success (or less of a cut), more accent: 6% to 46% opacity.
    const shade = value === null ? 0 : 0.06 + 0.4 * Math.max(0, Math.min(1, value));
    return (
      <td
        key={years}
        className={`num plan-grid-cell${own ? ' own' : ''}`}
        style={{ background: `rgba(91, 141, 239, ${shade.toFixed(3)})` }}
        title={title}
        aria-label={title}
      >
        {text}
      </td>
    );
  }

  return (
    <table className="plan-grid">
      <thead>
        <tr>
          <th scope="col">Rate</th>
          {horizons.map((y) => (
            <th key={y} scope="col" className="num">
              {y} yrs
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rates.map((rate) => (
          <tr key={rate}>
            <th scope="row" className="plan-grid-rate">
              {pct(rate)}
            </th>
            {horizons.map((years) => cell(rate, years))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
