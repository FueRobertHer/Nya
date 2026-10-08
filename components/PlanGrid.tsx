'use client';

// The success-rate grid: the plan at several withdrawal rates (rows) and
// lengths (columns). A table first, since the numbers are the point, with a
// single-hue wash behind each cell (more success, more accent) as a heatmap
// cue; the figures, not the colour, carry the value. The plan's own cell is
// outlined, and each cell's title spells it out for a pointer or screen reader.
//
// A flexible rule (guardrails, percent of portfolio, VPW, floor and ceiling)
// buys its success by cutting spending, so its cells carry a second figure:
// the lowest year's spending as a share of the first year's, in the worst
// start that lasted. VPW has no rate to vary, so it gets one row.
//
// Historical columns cover different starts: a plan of 50 years can only
// start up to 1973, one of 60 years up to 1963, so each column head says
// where its starts end, and the line under the grid says why a longer column
// can read safer than a shorter one.

import type { GridCell } from '@/lib/fire/simulate';
import { pct, successText } from './plan-text';

export default function PlanGrid({
  cells,
  rates,
  horizons,
  current,
  flexible,
  pathsNoun,
}: {
  /** Null, or missing some cells, while it is still being worked out. */
  cells: GridCell[] | null;
  /** The rows: rates, or [null] for a rule without one (VPW). */
  rates: (number | null)[];
  horizons: number[];
  /** The plan's own cell, outlined. */
  current: { rate: number | null; years: number };
  /** Show the lowest year's spending under each success rate. */
  flexible: boolean;
  /** "starts" or "runs", for the cell titles. */
  pathsNoun: string;
}) {
  const at = (rate: number | null, years: number) =>
    cells?.find((c) => (rate === null ? c.rate === null : c.rate !== null && Math.abs(c.rate - rate) < 1e-9) && c.years === years) ?? null;
  const column = (years: number) => cells?.find((c) => c.years === years) ?? null;
  const rateLabel = (rate: number | null) => (rate === null ? 'VPW' : pct(rate));
  const one = pathsNoun.replace(/s$/, '');

  function cell(rate: number | null, years: number) {
    const c = at(rate, years);
    const own = years === current.years && (rate === null ? current.rate === null : current.rate !== null && Math.abs(rate - current.rate) < 1e-9);
    let title = `${rateLabel(rate)} for ${years} years: working it out`;
    let body: React.ReactNode = '…';
    if (c) {
      const low = c.lowestSpendingShare;
      title =
        `${rateLabel(rate)} for ${years} years: ${successText(c.successRate, 1)} of ${c.paths.toLocaleString()} ${pathsNoun} lasted` +
        (flexible
          ? low === null
            ? ', and none was left to measure spending in'
            : `; in the worst ${one} that lasted, the lowest year's spending was ${successText(low)} of the first year's`
          : '');
      body = (
        <>
          {successText(c.successRate)}
          {flexible && <span className="plan-grid-low">{low === null ? '--' : `low ${successText(low)}`}</span>}
        </>
      );
    }
    // More success, more accent, from faint at 50% or less to strongest at
    // 100%: below half every plan is a poor one, and spreading the shades over
    // 50% to 100% keeps 85% and 100% apart.
    const shade = c ? 0.06 + 0.4 * Math.max(0, Math.min(1, (c.successRate - 0.5) / 0.5)) : 0;
    return (
      <td
        key={years}
        className={`num plan-grid-cell${own ? ' own' : ''}`}
        style={{ background: `rgba(91, 141, 239, ${shade.toFixed(3)})` }}
        title={title}
        aria-label={title}
      >
        {body}
      </td>
    );
  }

  return (
    <table className="plan-grid">
      <thead>
        <tr>
          <th scope="col">Rate</th>
          {horizons.map((y) => {
            const c = column(y);
            const span = c?.firstStart && c.lastStart ? `${c.paths.toLocaleString()} starts, ${c.firstStart} to ${c.lastStart}` : undefined;
            return (
              <th key={y} scope="col" className="num" title={span}>
                {y} yrs
                {c?.lastStart && <span className="plan-grid-span">to {c.lastStart.slice(0, 4)}</span>}
              </th>
            );
          })}
        </tr>
      </thead>
      <tbody>
        {rates.map((rate) => (
          <tr key={rate ?? 'none'}>
            <th scope="row" className="plan-grid-rate">
              {rateLabel(rate)}
            </th>
            {horizons.map((years) => cell(rate, years))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
