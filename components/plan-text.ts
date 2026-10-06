// Formatting and wording for the Plan tab, kept apart from the components so
// the exact sentences beside each result can be tested (test/plan-tab.test.tsx).
// Imports nothing heavy: no engine, no data.

import type { RuleKind } from '@/lib/fire/rules';
import type { Method, Rebalance } from '@/lib/fire/simulate';

/** Whole currency units: plan figures are estimates, and cents would claim
 *  a precision they don't have. */
export function wholeMoney(n: number, currency: string | null): string {
  const value = Math.round(n) === 0 ? 0 : Math.round(n); // never "-$0"
  if (currency) {
    try {
      return new Intl.NumberFormat(undefined, { style: 'currency', currency, maximumFractionDigits: 0, minimumFractionDigits: 0 }).format(value);
    } catch {
      // An unknown code falls through to "$", like lib/format.ts.
    }
  }
  return (value < 0 ? '-$' : '$') + Math.abs(value).toLocaleString(undefined, { maximumFractionDigits: 0 });
}

/** A fraction as a percent with no trailing zeros: 0.04 "4%", 0.035 "3.5%", 0.0425 "4.25%". */
export function pct(f: number, maxDigits = 2): string {
  return `${Number((f * 100).toFixed(maxDigits))}%`;
}

/**
 * A success rate as a percent that never rounds into a claim: "100%" only when
 * every start lasted, "0%" only when none did. 0.996 is ">99%" at whole
 * percents, not "100%", and 0.004 is "<1%".
 */
export function successText(rate: number, digits = 0): string {
  if (rate >= 1) return '100%';
  if (rate <= 0) return '0%';
  const unit = 10 ** -digits;
  const v = Number((rate * 100).toFixed(digits));
  if (v >= 100) return `>${Number((100 - unit).toFixed(digits))}%`;
  if (v <= 0) return `<${unit}%`;
  return `${v}%`;
}

/** "Nov 1965" from "1965-11". */
export function monthName(ym: string): string {
  const [y, m] = ym.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString(undefined, { month: 'short', year: 'numeric', timeZone: 'UTC' });
}

/** "about 12.4 years", "under a year". */
export function yearsText(n: number): string {
  if (n <= 0) return 'none';
  if (n < 1) return 'under a year';
  return `about ${Number(n.toFixed(1))} years`;
}

export const RULE_NAMES: Record<RuleKind, string> = {
  constant: 'Constant (the 4% rule)',
  percent: 'Percent of portfolio',
  guardrails: 'Guardrails (Guyton-Klinger)',
  vpw: 'VPW (variable percentage)',
  'floor-ceiling': 'Floor and ceiling',
};

/** What each rule does, in a sentence or two (lib/fire/rules.ts has the exact definitions). */
export function ruleText(kind: RuleKind, opts: { rate: number; floor: number; ceiling: number; expectedReturn: number }): string {
  const r = pct(opts.rate);
  switch (kind) {
    case 'constant':
      return `The first year withdraws ${r} of the starting balance, and every later year the same amount in today's dollars, whatever the market does.`;
    case 'percent':
      return `Every year withdraws ${r} of the balance at the start of that year. It never runs out, but spending rises and falls with the market.`;
    case 'guardrails':
      return `Starts at ${r}, then keeps the amount steady in today's dollars, except: after a losing year it skips the raise for inflation while the withdrawal is above ${r} of the balance; above 120% of that rate it cuts 10% (not in the last 15 years); below 80% it raises 10%.`;
    case 'vpw':
      return `Each year withdraws the share an annuity would pay over the years left, at a ${pct(opts.expectedReturn)} expected real return (from your mix). Spending moves with the market, and the balance ends near zero by design.`;
    case 'floor-ceiling':
      return `Every year withdraws ${r} of the balance, but never less than ${pct(opts.floor, 0)} or more than ${pct(opts.ceiling, 0)} of the first year's amount, in today's dollars.`;
  }
}

export const METHOD_NAMES: Record<Method, string> = {
  historical: 'Historical cycles',
  'monte-carlo': 'Monte Carlo',
};

export const REBALANCE_TEXT: Record<Rebalance, string> = {
  annual: 'rebalanced every year',
  monthly: 'rebalanced every month',
  none: 'never rebalanced',
};

/** The definition shown beside every success rate. */
export function successDefinition(years: number): string {
  return `Success: the portfolio never ran out. Every year's withdrawal was paid in full for all ${years} years.`;
}

/** The statement that goes with every result. */
export const HYPOTHETICAL =
  "These results are hypothetical. They show how this plan would have fared in US market history from 1871 to 2023, or in sequences resampled from it, in today's dollars. They are not a prediction and not advice.";
