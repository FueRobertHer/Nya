// lib/fire/compare-conversions.ts
//
// Compare conversions (the tax plan's D4): each rule's drawdown from the plan's own
// start, in its own order, each at the tax and health its own years come to. The rules
// are side by side, and nothing here says one is better than another.
//
// Each row is a whole drawdown, so a page asks only while Compare is on screen.

import type { Drawdown } from './drawdown';
import { detailWork, type DetailedInput } from './plan-detail';
import type { PlanFigures } from './plan-figures';
import type { Strategy } from './tax/rules';

export type CompareRow = {
  key: string;
  strategy: Strategy;
  /** The rule this plan has. */
  mine: boolean;
  drawn: Drawdown;
};

type Rule = Strategy['conversions'];

const STANDING: readonly { key: string; rule: Rule }[] = [
  { key: 'none', rule: { kind: 'none' } },
  { key: 'fill-10', rule: { kind: 'bracket', top: 0.1 } },
  { key: 'fill-12', rule: { kind: 'bracket', top: 0.12 } },
  { key: 'fill-22', rule: { kind: 'bracket', top: 0.22 } },
];

const ACA_RULE: { key: string; rule: Rule } = { key: 'aca-12', rule: { kind: 'aca-then-bracket', top: 0.12 } };

/** The same conversions, whatever the order. */
export const sameRule = (a: Strategy, b: Strategy) => JSON.stringify([a.conversions, a.convertUntil]) === JSON.stringify([b.conversions, b.convertUntil]);

/** The plan's own start under another rule; null where its start can't run. */
export function conversionRun(f: PlanFigures, input: DetailedInput, strategy: Strategy): Drawdown | null {
  return detailWork({ ...input, strategy }).startRun(f);
}

/**
 * The rules' rows: None, three brackets, the ACA rule while someone is on the ACA at
 * some year of the run, and the plan's own where it is none of those. The plan's own
 * row is `own`, the drawdown its figures already ran, when given, so it can't differ.
 */
export function compareRows(f: PlanFigures, input: DetailedInput, own: Drawdown | null = null): CompareRow[] {
  const mine = input.strategy;
  const rowOf = (key: string, strategy: Strategy): CompareRow | null => {
    const isMine = sameRule(strategy, mine);
    const drawn = isMine && own ? own : conversionRun(f, input, strategy);
    return drawn === null ? null : { key, strategy, mine: isMine, drawn };
  };
  const rule = (x: { key: string; rule: Rule }) => rowOf(x.key, { order: mine.order, conversions: x.rule, convertUntil: null });
  const rows = STANDING.flatMap((x) => rule(x) ?? []);
  if ((rows[0]?.drawn.aca.on ?? 0) > 0) rows.push(...[rule(ACA_RULE)].flatMap((r) => r ?? []));
  if (rows.length > 0 && !rows.some((r) => r.mine)) rows.push(...[rowOf('own', mine)].flatMap((r) => r ?? []));
  return rows;
}
