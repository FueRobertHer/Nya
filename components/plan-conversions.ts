// components/plan-conversions.ts
//
// The words of How you draw and Compare conversions (components/PlanHowYouDraw.tsx),
// and of a copy that differs in them (components/plan-diff.ts). Neutral: each rule
// says what it does, what it comes to, and never that it is better than another (the
// tax plan's D4). What holds an amount is drawn through Masked by the view.

import type { Drawdown } from '@/lib/fire/drawdown';
import type { Strategy } from '@/lib/fire/tax/rules';
import { pct } from './plan-text';

type Money = (n: number) => string;
type Rule = Strategy['conversions'];

export const ORDER_WORDS: Record<Strategy['order'], string> = {
  standard: 'Taxable, then tax-deferred, then Roth',
  'roth-before-deferred': 'Taxable, then Roth, then tax-deferred',
};

/** A rule's short name: a row of Compare, and a copy's name. */
export function ruleName(rule: Rule, money: Money): string {
  switch (rule.kind) {
    case 'none':
      return 'None';
    case 'bracket':
      return `Fill ${pct(rule.top)}`;
    case 'aca-then-bracket':
      return `ACA limit, then ${pct(rule.top)}`;
    case 'fixed':
      return `${money(rule.yearly)} a year`;
  }
}

/** The rule in a line, to the age it runs. */
export function ruleSentence(strategy: Pick<Strategy, 'conversions' | 'convertUntil'>, defaultUntil: number | null, money: Money): string {
  const rule = strategy.conversions;
  const age = strategy.convertUntil ?? defaultUntil;
  const until = age === null ? '' : `, until ${age}`;
  switch (rule.kind) {
    case 'none':
      return 'None';
    case 'bracket':
      return `Fill the ${pct(rule.top)} bracket${until}`;
    case 'aca-then-bracket':
      return `Up to the ACA limit, then the ${pct(rule.top)} bracket${until}`;
    case 'fixed':
      return `${money(rule.yearly)} a year${until}`;
  }
}

/** Where a run ends: what is left, or when it runs short. */
export const endWords = (d: Pick<Drawdown, 'runsOutAt' | 'leftAtEnd'>, money: Money) => (d.runsOutAt !== null ? `Runs short at ${d.runsOutAt}` : money(d.leftAtEnd));

/** The age a run ends at. */
export const endAgeOf = (d: Pick<Drawdown, 'years'>): number | null => {
  const last = d.years[d.years.length - 1];
  return last ? last.age + 1 : null;
};

/** What a run moved to Roth. */
export const convertedIn = (d: Pick<Drawdown, 'years'>) => d.years.reduce((n, y) => n + y.conversion, 0);

/** The last age it moved anything. */
const lastConverting = (d: Pick<Drawdown, 'years'>) => d.years.reduce<number | null>((n, y) => (y.conversion >= 0.5 ? y.age : n), null);

/** The sheet's preview, as the rule is changed. */
export function previewLine(rule: Drawdown, none: Drawdown, money: Money): string {
  const moved = convertedIn(rule);
  const last = lastConverting(rule);
  const end = (d: Drawdown, age: number | null) => (d.runsOutAt !== null ? `it runs short at ${d.runsOutAt}` : `${money(d.leftAtEnd)} left${age === null ? '' : ` at ${age}`} after tax`);
  const about = moved >= 0.5 && last !== null ? `about ${money(Math.round(moved / 1000) * 1000)} converted by ${last}, ` : 'nothing converted, ';
  const age = endAgeOf(rule);
  return `With this rule: ${about}tax and health costs ${money(rule.taxAndHealth)} in all, and ${end(rule, age)}. With none: ${money(none.taxAndHealth)} and ${none.runsOutAt !== null ? `runs short at ${none.runsOutAt}` : money(none.leftAtEnd)}.`;
}

/** A copy's name after its rule, with a number if that is taken. */
export function copyNameFor(rule: Rule, money: Money, taken: readonly string[]): string {
  const base = ruleName(rule, money);
  if (!taken.includes(base)) return base;
  for (let n = 2; ; n++) {
    const name = `${base} ${n}`;
    if (!taken.includes(name)) return name;
  }
}

/** How a copy's order and conversions differ from your plan's, a sentence each. */
export function strategyDiffParts(main: Strategy, copy: Strategy, defaultUntil: number | null, money: Money): string[] {
  const parts: string[] = [];
  if (copy.order !== main.order) parts.push(`Order: ${ORDER_WORDS[copy.order]} (your plan: ${ORDER_WORDS[main.order]})`);
  const said = (s: Strategy) => ruleSentence(s, defaultUntil, money);
  if (said(copy) !== said(main)) parts.push(`Roth conversions: ${said(copy)} (your plan: ${said(main)})`);
  return parts;
}
