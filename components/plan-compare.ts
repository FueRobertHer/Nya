// components/plan-compare.ts
//
// Compare mode's rows (components/PlanCompare.tsx draws them): two to four
// plans, the Plan and its scenarios, metric by metric, each against the
// first plan that could be worked out. No React here, so what each cell
// says can be tested on its own.
//
// Every plan is run with the Plan's method, the same market history and the
// same seed (one job each, lib/fire/jobs.ts, with no options of its own); an
// answer made otherwise (it can't be, today) is never put beside the others.
//
// What a row says when the plans differ in what they start with: the ending
// balance and spending depend on it, so an amount difference between plans
// that start with different balances, or where one starts with money it
// wouldn't have then (retiring before it reaches its FI number, say), would
// read as the scenario's doing. It isn't given; the cell says why instead.
// And a plan that starts with more than it would have says so in its own
// success cell, and in what a screen reader is given for it.

import type { SimResult } from '@/lib/fire/simulate';
import type { PlanFigures } from '@/lib/fire/plan-figures';
import type { Missing } from '@/lib/fire/plan';
import { startsWithText } from './plan-scenario-text';
import { successText, yearsToFiText } from './plan-text';
import { plainNumber } from '@/lib/format';

type Money = (n: number) => string;

/** What compare mode has for one plan. */
export type ColumnOutcome =
  /** Not worked out, and why, in words. */
  | { kind: 'not-run'; reason: string }
  /** Its figures, and its simulation's answer: still being worked out, or
   *  why there is none (the simulation can't start: `missing`), or the error. */
  | { kind: 'figures'; figures: PlanFigures; result: SimResult | 'pending' | { missing: Missing } | { error: string } };

export type CompareColumn = { id: string; name: string; isPlan: boolean; outcome: ColumnOutcome };

export type Cell = {
  id: string;
  name: string;
  /** What it says, or null when there is nothing (not worked out). */
  value: string | null;
  /** Against the first plan that could be worked out; null when it is that
   *  one, or when there is nothing to say. */
  diff: string | null;
  /** Said in the cell itself, for anyone reading only it. */
  caveat: string | null;
  pending: boolean;
};

export type RowKey = 'start' | 'lasted' | 'median' | 'worst' | 'fi' | 'spending';
export type CompareRow = { key: RowKey; label: string; cells: Cell[] };

const MISSING_TEXT: Record<Missing, string> = {
  spending: 'needs your annual spending',
  assets: 'needs your invested assets',
  balance: 'needs the balance to start with',
};

const resultOf = (c: CompareColumn): SimResult | null => {
  if (c.outcome.kind !== 'figures') return null;
  const r = c.outcome.result;
  return typeof r === 'object' && r !== null && 'successRate' in r ? r : null;
};

/** Whether two answers were made the same way: one method, one seed, one
 *  number of runs and blocks. */
export function sameWay(a: SimResult, b: SimResult): boolean {
  return a.method === b.method && a.seed === b.seed && a.runs === b.runs && a.blockMonths === b.blockMonths;
}

/** Why two plans' amounts can't be set against each other, or null when
 *  they can: they start with different balances, or one starts with money
 *  it wouldn't have then (a higher ending balance would read as safer). */
function apart(a: PlanFigures, b: PlanFigures): string | null {
  if (a.startsWith?.more || b.startsWith?.more) return 'not compared: one starts with money it wouldn’t have';
  const x = 'sim' in a.engine ? a.engine.sim.startBalance : null;
  const y = 'sim' in b.engine ? b.engine.sim.startBalance : null;
  return x !== null && y !== null && Math.abs(x - y) < 0.5 ? null : 'starts with a different balance';
}

/** "8.2 points lower", "the same". */
export function pointsText(d: number): string {
  const p = Number((Math.abs(d) * 100).toFixed(1));
  if (p === 0) return 'the same';
  return `${p} point${p === 1 ? '' : 's'} ${d > 0 ? 'higher' : 'lower'}`;
}

/** "$12,000 more", "the same". */
export function amountDiffText(d: number, money: Money): string {
  if (Math.round(d) === 0) return 'the same';
  return `${money(Math.abs(d))} ${d > 0 ? 'more' : 'less'}`;
}

/** "1.4 years later", "the same". */
export function yearsDiffText(d: number): string {
  const y = Number(Math.abs(d).toFixed(1));
  if (y === 0) return 'the same';
  return `${y} year${y === 1 ? '' : 's'} ${d > 0 ? 'later' : 'sooner'}`;
}

/** The FI date in words: years, the age then, and the year it falls in. */
export function fiDateText(f: PlanFigures, today: string): string {
  const years = f.view.yearsToFi;
  if (f.short) return 'none: a cost it can’t pay (below)';
  if (years === null || years === 0 || years === Infinity) return yearsToFiText(years);
  const year = Math.floor(Number(today.slice(0, 4)) + (Number(today.slice(5, 7)) - 1) / 12 + years);
  return `${yearsToFiText(years)}${f.view.fiAge !== null ? `, around age ${Math.round(f.view.fiAge)}` : ''} (around ${year})`;
}

/** Compare mode's rows, and the plan the differences are against. */
export function compareRows(columns: readonly CompareColumn[], money: Money, today: string): { rows: CompareRow[]; against: CompareColumn | null } {
  const against = columns.find((c) => resultOf(c) !== null) ?? null;
  const base = against ? resultOf(against) : null;
  const baseFigures = against && against.outcome.kind === 'figures' ? against.outcome.figures : null;

  const cell = (c: CompareColumn, f: (fig: PlanFigures, r: SimResult | null) => { value: string | null; diff?: string | null; caveat?: string | null }, needsResult = true): Cell => {
    const empty = { id: c.id, name: c.name, value: null, diff: null, caveat: null, pending: false };
    if (c.outcome.kind === 'not-run') return { ...empty, value: 'not worked out (below)' };
    const r = c.outcome.result;
    if (needsResult && r === 'pending') return { ...empty, pending: true };
    if (needsResult && typeof r === 'object' && r !== null && 'missing' in r) return { ...empty, value: MISSING_TEXT[r.missing] };
    if (needsResult && typeof r === 'object' && r !== null && 'error' in r) return { ...empty, value: 'couldn’t be worked out' };
    const result = resultOf(c);
    if (needsResult && result && base && !sameWay(result, base)) return { ...empty, value: 'worked out another way, so not compared' };
    const out = f(c.outcome.figures, result);
    return { ...empty, value: out.value, diff: c === against ? null : (out.diff ?? null), caveat: out.caveat ?? null };
  };

  const amountRow = (key: RowKey, label: string, pick: (r: SimResult) => number): CompareRow => ({
    key,
    label,
    cells: columns.map((c) =>
      cell(c, (fig, r) => {
        const v = pick(r as SimResult);
        if (!base || !baseFigures) return { value: money(v) };
        return { value: money(v), diff: apart(fig, baseFigures) ?? amountDiffText(v - pick(base), money) };
      })
    ),
  });

  // The age every plan worked out ends at, when they all end at one.
  const ages = columns.flatMap((c) => {
    if (c.outcome.kind !== 'figures' || !('sim' in c.outcome.figures.engine)) return [];
    const { startAge, sim } = c.outcome.figures.engine;
    return [startAge === null ? null : startAge + sim.years];
  });
  const endsAt = ages.length > 0 && ages.every((a) => a !== null && a === ages[0]) ? ages[0] : null;

  const rows: CompareRow[] = [
    {
      key: 'start',
      label: 'Starts with',
      cells: columns.map((c) =>
        cell(
          c,
          (fig) => (fig.startsWith ? { value: startsWithText(fig.startsWith, money) } : { value: 'nothing yet' }),
          false
        )
      ),
    },
    {
      key: 'lasted',
      label: 'Lasted',
      cells: columns.map((c) =>
        cell(c, (fig, r) => {
          const res = r as SimResult;
          const caveat = fig.startsWith?.more ? 'It starts with money it wouldn’t have then, so this is too high.' : null;
          return { value: `${successText(res.successRate, 1)} of ${plainNumber(res.paths)} ${res.method === 'historical' ? 'historical starts' : 'runs'}`, diff: base ? pointsText(res.successRate - base.successRate) : null, caveat };
        })
      ),
    },
    amountRow('median', endsAt !== null ? `Ending balance at ${endsAt}, median` : 'Ending balance, median', (r) => r.ending.p50),
    amountRow('worst', endsAt !== null ? `Ending balance at ${endsAt}, the 10% worst` : 'Ending balance, the 10% worst', (r) => r.ending.p10),
    {
      key: 'fi',
      label: 'FI date',
      cells: columns.map((c) =>
        cell(
          c,
          (fig) => {
            const value = fiDateText(fig, today);
            const y = fig.view.yearsToFi;
            const b = baseFigures?.view.yearsToFi ?? null;
            const diff = baseFigures && y !== null && b !== null && Number.isFinite(y) && Number.isFinite(b) && !fig.short && !baseFigures.short ? yearsDiffText(y - b) : null;
            return { value, diff };
          },
          false
        )
      ),
    },
    {
      key: 'spending',
      label: 'Spending in retirement, the first year',
      cells: columns.map((c) =>
        cell(c, (fig, r) => {
          const res = r as SimResult;
          const flexible = fig.plan.rule !== 'constant';
          const low = flexible && res.lowestSpending ? `, the lowest year ${money(res.lowestSpending.amount)}` : flexible ? ', and no start lasted' : '';
          const value = `${money(res.firstYearSpending)} a year after tax${low}`;
          if (!base || !baseFigures) return { value };
          return { value, diff: apart(fig, baseFigures) ?? amountDiffText(res.firstYearSpending - base.firstYearSpending, money) };
        })
      ),
    },
  ];
  return { rows, against };
}

/** When the plans run different lengths in historical cycles, each has its
 *  own starts: the words for that, or null. */
export function startsLine(columns: readonly CompareColumn[]): { name: string; years: number; paths: number; lastStart: string | null }[] | null {
  const shown = columns.flatMap((c) => {
    const r = resultOf(c);
    return r && r.method === 'historical' ? [{ name: c.name, years: r.years, paths: r.paths, lastStart: r.lastStart }] : [];
  });
  if (shown.length < 2 || shown.every((s) => s.years === shown[0].years)) return null;
  return shown;
}
