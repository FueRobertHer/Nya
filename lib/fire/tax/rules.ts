// lib/fire/tax/rules.ts
//
// What a plan's Roth conversion rule asks of one year: the ceiling its withdrawals
// stay under, what its conversions fill up to, and a fixed amount. All the rules are
// ceilings (the tax plan's D4), so the year (lib/fire/tax/year.ts) has one solver for
// them, and none of them is said to be better than another.
//
//   - None: nothing, the default.
//   - Fill a bracket: to the age set, up to the bracket's top on ordinary taxable
//     income, taxable Social Security included, as the law fills brackets. Gains stack
//     above it, so a conversion can push gains out of the 0% band: the year says so on
//     its gains line.
//   - Up to the ACA limit, then a bracket: to the age set, while anyone is on the ACA,
//     MAGI up to the limit less a margin, so rounding never crosses it; otherwise the
//     bracket. Past the age set, while anyone is on the ACA, conversions still fill to
//     the income under which coverage is full price (the floor): filling a year to the
//     limit clears it, and without that a run that has spent the rest falls to Roth,
//     MAGI near zero, and full price under the work rule.
//   - A fixed amount a year: to the age set, under no ceiling.
//
// A rule caps the whole year's income, not only the conversion, so what spending draws
// from tax-deferred money counts against it first. Arithmetic only.

import type { TaxChoices } from '../tax-choices';
import type { Owner } from '../tax-facts';
import { acaLimit, fullPriceUnder, onAcaThisYear, type AcaYear } from './health';
import type { Filing, TaxLaw } from './law/types';
import type { Ceiling } from './year';

export type Strategy = TaxChoices['strategy'];

/** Dollars inside the ACA's lines a rule stays. */
export const ACA_MARGIN = 500;

/** No rule: the standard order, no conversions. */
export const NO_STRATEGY: Strategy = { order: 'standard', conversions: { kind: 'none' }, convertUntil: null };

export type YearRule = { ceiling: Ceiling | null; fill: Ceiling | null; fixed: number };

const NOTHING: YearRule = { ceiling: null, fill: null, fixed: 0 };

/** The top of the ordinary bracket at `rate`: where a bracket ends in taxable income. */
export function bracketTop(law: TaxLaw, filing: Filing, rate: number): number {
  const brackets = law.brackets.ordinary[filing];
  return (brackets.find((b) => b.rate === rate) ?? brackets[brackets.length - 1]).upTo;
}

/** The age, yours, a rule runs until when none is set: the year before the earlier
 *  owner's RMDs, the partner's RMD age put in your age. */
export function defaultUntil(rmdAges: Record<Owner, number>, today: { age: number; partnerAge: number | null }): number {
  const partner = today.partnerAge === null ? rmdAges.you : rmdAges.partner + today.age - today.partnerAge;
  return Math.min(rmdAges.you, partner) - 1;
}

/** What the rule asks of the year you are `age` in, the age set being `until`. */
export function yearRule(strategy: Strategy, until: number, age: number, year: AcaYear, law: TaxLaw): YearRule {
  const rule = strategy.conversions;
  const running = age <= until;
  const toBracket = (rate: number): YearRule => {
    const line: Ceiling = { on: 'ordinary', at: bracketTop(law, year.filing, rate) };
    return { ceiling: line, fill: line, fixed: 0 };
  };
  switch (rule.kind) {
    case 'none':
      return NOTHING;
    case 'fixed':
      return running ? { ceiling: null, fill: null, fixed: rule.yearly } : NOTHING;
    case 'bracket':
      return running ? toBracket(rule.top) : NOTHING;
    case 'aca-then-bracket': {
      if (!onAcaThisYear(year)) return running ? toBracket(rule.top) : NOTHING;
      if (running) {
        const line: Ceiling = { on: 'magi', at: acaLimit(year, law) - ACA_MARGIN };
        return { ceiling: line, fill: line, fixed: 0 };
      }
      const floor = fullPriceUnder(year, law);
      return floor === null ? NOTHING : { ceiling: null, fill: { on: 'magi', at: floor + ACA_MARGIN }, fixed: 0 };
    }
  }
}
