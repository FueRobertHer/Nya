// lib/fire/rules.ts
//
// Withdrawal rules: how much a plan takes from the portfolio each year. Each
// rule is one small function of the year's state, so the engine
// (lib/fire/simulate.ts) can run any of them through the same years.
//
// Shared conventions:
//   - Everything is in today's dollars. "Constant" means constant in real
//     terms: the engine's returns are already net of inflation, so a rule
//     never adjusts for inflation itself (one exception, Guyton-Klinger's
//     skipped raise, is spelled out there).
//   - A rule decides the year's planned withdrawal ONCE, at the start of the
//     year, from the balance then, and the engine takes it all at once. Rates
//     are shares of the portfolio, before tax: with a flat tax, what is left
//     to spend is withdrawal * (1 - tax).
//   - The planned withdrawal is before other income and one-off expenses:
//     income pays part of it (the portfolio withdraws less), and a one-off
//     adds to it. So the rules see the plan's spending, not the income.
//
// Imports nothing: the Plan tab runs this in the browser.

/** A rule and its settings. Rates are fractions of the portfolio (0.04 is 4%). */
export type RuleSpec =
  | { kind: 'constant'; rate: number }
  | { kind: 'percent'; rate: number }
  | { kind: 'guardrails'; rate: number }
  | { kind: 'vpw'; expectedReturn: number }
  | { kind: 'floor-ceiling'; rate: number; floor: number; ceiling: number };

export type RuleKind = RuleSpec['kind'];

/** What a rule may look at when deciding a year's withdrawal. */
export type YearState = {
  /** Plan year, 0 for the first. */
  year: number;
  /** The plan's length in years. */
  years: number;
  /** The portfolio at the start of this year, before this year's withdrawal. */
  balance: number;
  /** The portfolio the plan started with. */
  startBalance: number;
  /** Last year's planned withdrawal; 0 in year 0. */
  previous: number;
  /** The first year's planned withdrawal; 0 in year 0. */
  initial: number;
  /** The portfolio's NOMINAL return over last year, after fees; 0 in year 0. */
  lastNominalReturn: number;
  /** Inflation over last year; 0 in year 0. */
  lastInflation: number;
};

/**
 * Constant real (the "4% rule" of Bengen 1994 and the Trinity study): the
 * first year withdraws `rate` of the starting portfolio, and every later year
 * the same amount in today's dollars, whatever the market does. The only rule
 * here that never looks at the balance again, which is why it can run out.
 */
export function constantReal(rate: number, s: YearState): number {
  return s.year === 0 ? rate * s.startBalance : s.initial;
}

/**
 * Percent of portfolio: every year withdraws `rate` of the balance at the
 * start of that year. It can never run the portfolio out, because it takes
 * less as the portfolio shrinks; the cost is spending that moves with the
 * market, and can fall a long way.
 */
export function percentOfPortfolio(rate: number, s: YearState): number {
  return rate * s.balance;
}

/** Guardrails sit this far either side of the initial withdrawal rate. */
export const GUARDRAIL_BAND = 0.2;
/** Crossing a guardrail cuts or raises the withdrawal by this much. */
export const GUARDRAIL_STEP = 0.1;
/** The cut (capital preservation) is not applied once this few years are left. */
export const GUARDRAIL_FINAL_YEARS = 15;

/**
 * Guyton-Klinger guardrails, after Guyton and Klinger, "Decision Rules and
 * Maximum Initial Withdrawal Rates" (Journal of Financial Planning, 2006).
 * This engine's version, in order, each year after the first:
 *
 *   1. Start from last year's withdrawal, kept constant in real terms (the
 *      usual raise for inflation).
 *   2. Skipped raise: if last year's portfolio return was negative (nominal,
 *      after fees) AND that withdrawal would now be more than `rate` of the
 *      balance (the current withdrawal rate is above the initial one), the
 *      nominal withdrawal is frozen instead of raised, so its real value falls
 *      by last year's inflation. After a year of deflation it simply stays
 *      the same in real terms, as it would without the rule.
 *   3. Capital preservation: if the withdrawal is now more than 120% of
 *      `rate` of the balance, cut it by 10%, unless 15 or fewer years are left
 *      (the paper drops this rule near the end).
 *   4. Prosperity: if it is under 80% of `rate` of the balance, raise it by
 *      10%.
 *
 * The first year withdraws `rate` of the portfolio. The paper's fourth rule
 * (which asset to sell) is replaced by the engine's own rebalancing.
 */
export function guytonKlinger(rate: number, s: YearState): number {
  if (s.year === 0) return rate * s.balance;
  let w = s.previous;
  if (s.lastNominalReturn < 0 && w > rate * s.balance) w /= 1 + Math.max(0, s.lastInflation);
  if (w > rate * (1 + GUARDRAIL_BAND) * s.balance && s.years - s.year > GUARDRAIL_FINAL_YEARS) {
    w *= 1 - GUARDRAIL_STEP;
  } else if (w < rate * (1 - GUARDRAIL_BAND) * s.balance) {
    w *= 1 + GUARDRAIL_STEP;
  }
  return w;
}

/** Expected real returns VPW plans with, by asset class (this engine's
 *  assumption: modest long-run figures, below the averages of the 1871 to
 *  2023 history, which were about 6.9% for stocks and 2.5% for bonds). */
export const VPW_EXPECTED = { stocks: 0.05, bonds: 0.02, cash: 0 } as const;

/** VPW's expected return for an allocation: the weighted average of VPW_EXPECTED. */
export function vpwExpectedReturn(a: { stocks: number; bonds: number; cash: number }): number {
  return a.stocks * VPW_EXPECTED.stocks + a.bonds * VPW_EXPECTED.bonds + a.cash * VPW_EXPECTED.cash;
}

/**
 * The share of the portfolio VPW withdraws with `yearsLeft` years to go
 * (this one included): the first payment of an annuity that pays the same
 * real amount at the start of each remaining year and ends at zero, if the
 * portfolio earns `expectedReturn`:
 *
 *   share = g / ((1 + g)(1 - (1 + g)^-n)),  or 1/n when g = 0.
 *
 * With one year left the share is 100%: VPW spends the portfolio down by the
 * end of the plan on purpose.
 */
export function vpwShare(expectedReturn: number, yearsLeft: number): number {
  if (yearsLeft <= 1) return 1;
  const g = expectedReturn;
  if (Math.abs(g) < 1e-12) return 1 / yearsLeft;
  return g / ((1 + g) * (1 - (1 + g) ** -yearsLeft));
}

/**
 * Variable percentage withdrawal (VPW, the Bogleheads method): each year
 * withdraws vpwShare of the balance, recomputed for the years left. Spending
 * rises and falls with the market, rises as the plan nears its end, and the
 * portfolio reaches zero exactly at the end, by design.
 */
export function variablePercentage(expectedReturn: number, s: YearState): number {
  return vpwShare(expectedReturn, s.years - s.year) * s.balance;
}

/**
 * Floor and ceiling: each year withdraws `rate` of the balance (as percent of
 * portfolio), but never less than `floor` times the first year's withdrawal
 * and never more than `ceiling` times it, both in today's dollars. The floor
 * protects spending in bad markets, at the price of being able to run out;
 * the ceiling saves part of the good years for later.
 */
export function floorAndCeiling(rate: number, floor: number, ceiling: number, s: YearState): number {
  const base = rate * s.balance;
  if (s.year === 0) return base;
  return Math.min(Math.max(base, floor * s.initial), ceiling * s.initial);
}

/** The planned withdrawal for the year under a rule. */
export function plannedWithdrawal(rule: RuleSpec, s: YearState): number {
  switch (rule.kind) {
    case 'constant':
      return constantReal(rule.rate, s);
    case 'percent':
      return percentOfPortfolio(rule.rate, s);
    case 'guardrails':
      return guytonKlinger(rule.rate, s);
    case 'vpw':
      return variablePercentage(rule.expectedReturn, s);
    case 'floor-ceiling':
      return floorAndCeiling(rule.rate, rule.floor, rule.ceiling, s);
  }
}

/** The same rule at another withdrawal rate, for the success grid; null for
 *  VPW, which has no rate (its share comes from the years left). */
export function withRate(rule: RuleSpec, rate: number): RuleSpec | null {
  return rule.kind === 'vpw' ? null : { ...rule, rate };
}

/** Whether a rule's own withdrawals can empty the portfolio. Percent of
 *  portfolio and VPW only take a share of what is there (a one-off expense
 *  larger than the balance can still empty it). */
export function canRunOut(kind: RuleKind): boolean {
  return kind === 'constant' || kind === 'guardrails' || kind === 'floor-ceiling';
}
