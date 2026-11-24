'use client';

// The success-rate grid: the plan at several withdrawal rates (rows) and
// lengths (columns). A table first, since the numbers are the point, with a
// neutral shade behind each cell (more success, darker in light and lighter
// in dark, from --elevated to --border-strong) as a heatmap cue; the
// figures, not the shade, carry the value. Brass is never behind a figure
// (the screen review): it only outlines the plan's own cell. Each cell's
// title spells it out for a pointer or screen reader.
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
//
// With each year's tax a cell runs a sample (lib/fire/simulate.ts), so the plan's
// own cell shows the answer above the grid once it has one (`ownCell`), and doesn't
// read 83 under a hero of 81.4. Column heads keep reading the sampled cells, so a
// head doesn't change as the answers arrive.
//
// The plan's own row is labeled as the stress test's sentence says its rate
// (saidRate, to a tenth, or the rate set): a rate worked out from your
// spending reads "2.4%" in both, never "2.37%" in the grid. The other rows
// are the grid's own rates.

import type { CSSProperties } from 'react';
import type { GridCell } from '@/lib/fire/simulate';
import { pct, saidRate, successText } from './plan-text';
import { plainNumber } from '@/lib/format';

/** A cell that couldn't be worked out. */
export type FailedCell = { rate: number | null; years: number };

/** Distance within which the plan's own rate replaces a standard grid row
 *  instead of adding a near-duplicate row (0.05 percentage points). */
const OWN_RATE_MERGE = 0.0005 + 1e-9;

/** The grid's rates with the plan's own among them: in place of the row its
 *  exact value would repeat (pct, as a standard row is labeled) or any
 *  standard row within OWN_RATE_MERGE (0.05%, so 2.99% replaces 3% instead of
 *  adding a near-duplicate row), still marked as the plan's own; else added in
 *  order. Matched on the exact value: the own row's label, said to a tenth
 *  (saidRate), only rounds to a standard row's within OWN_RATE_MERGE of it. */
export function withOwnRate(rates: readonly number[], own: number): number[] {
  const label = pct(own);
  const exact = rates.findIndex((v) => pct(v) === label);
  if (exact >= 0) return rates.map((v, i) => (i === exact ? own : v));
  let nearest = -1;
  let best = Infinity;
  for (let i = 0; i < rates.length; i++) {
    const diff = Math.abs(rates[i] - own);
    if (diff <= OWN_RATE_MERGE && diff < best) {
      best = diff;
      nearest = i;
    }
  }
  if (nearest >= 0) return rates.map((v, i) => (i === nearest ? own : v));
  return [...rates, own].sort((a, b) => a - b);
}

export default function PlanGrid({
  cells,
  failed = [],
  rates,
  horizons,
  current,
  ownCell = null,
  setRate = null,
  flexible,
  pathsNoun,
}: {
  /** Null, or missing some cells, while it is still being worked out. */
  cells: GridCell[] | null;
  /** Cells that couldn't be worked out: shown as such, not as pending. */
  failed?: FailedCell[];
  /** The rows: rates, or [null] for a rule without one (VPW). */
  rates: (number | null)[];
  horizons: number[];
  /** The plan's own cell, outlined. */
  current: { rate: number | null; years: number };
  /** What that cell says, when it isn't one of `cells`: the answer above the grid. */
  ownCell?: GridCell | null;
  /** The withdrawal rate the plan sets, by which its own row's rate is said as
   *  the stress test says it (saidRate); null labels it as the others are. */
  setRate?: number | null;
  /** Show the lowest year's spending under each success rate. */
  flexible: boolean;
  /** "starts" or "runs", for the cell titles. */
  pathsNoun: string;
}) {
  const at = (rate: number | null, years: number) =>
    cells?.find((c) => (rate === null ? c.rate === null : c.rate !== null && Math.abs(c.rate - rate) < 1e-9) && c.years === years) ?? null;
  const column = (years: number) => cells?.find((c) => c.years === years) ?? null;
  const sameRate = (a: number | null, b: number | null) => (a === null ? b === null : b !== null && Math.abs(a - b) < 1e-9);
  const didFail = (rate: number | null, years: number) => failed.some((f) => f.years === years && sameRate(f.rate, rate));
  const isOwnRate = (rate: number | null) => sameRate(rate, current.rate);
  const rateLabel = (rate: number | null) => (rate === null ? 'VPW' : setRate !== null && isOwnRate(rate) ? pct(saidRate(rate, setRate)) : pct(rate));
  const one = pathsNoun.replace(/s$/, '');

  function cell(rate: number | null, years: number) {
    const own = years === current.years && (rate === null ? current.rate === null : current.rate !== null && Math.abs(rate - current.rate) < 1e-9);
    const c = own && ownCell ? ownCell : at(rate, years);
    let title = `${rateLabel(rate)} for ${years} years: working it out`;
    let body: React.ReactNode = '…';
    if (!c && didFail(rate, years)) {
      title = `${rateLabel(rate)} for ${years} years: couldn't be worked out`;
      body = '--';
    } else if (c) {
      const low = c.lowestSpendingShare;
      title =
        `${rateLabel(rate)} for ${years} years: ${successText(c.successRate, 1)} of ${plainNumber(c.paths)} ${pathsNoun} lasted` +
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
    // More success, a stronger shade, from the faintest at 50% or less to
    // the strongest at 100%: below half every plan is a poor one, and spreading
    // the shades over 50% to 100% keeps 85% and 100% apart. The colors are
    // in app/globals.css (.plan-grid-cell.scored); the cell carries its share.
    const shade = c ? Math.max(0, Math.min(1, (c.successRate - 0.5) / 0.5)) : null;
    return (
      <td
        key={years}
        className={`num plan-grid-cell${own ? ' own' : ''}${shade !== null ? ' scored' : ''}`}
        style={shade !== null ? ({ '--shade': `${(shade * 100).toFixed(1)}%` } as CSSProperties) : undefined}
        title={title}
        aria-label={title}
      >
        {body}
      </td>
    );
  }

  return (
    <table className="plan-grid">
      <caption className="visually-hidden">Success rate by withdrawal rate and length</caption>
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
