// components/plan-conversions.ts
//
// The words of How you draw and Compare conversions (components/PlanHowYouDraw.tsx),
// and of a copy that differs in them (components/plan-diff.ts). Neutral: each rule
// says what it does, what it comes to, and never that it is better than another (the
// tax plan's D4). What holds an amount is drawn through Masked by the view.

import type { Drawdown } from '@/lib/fire/drawdown';
import type { TaxChoices } from '@/lib/fire/tax-choices';
import { nameTaken } from '@/lib/fire/plan-list';
import type { Strategy } from '@/lib/fire/tax/rules';
import { pct } from './plan-text';

type Money = (n: number) => string;
type Rule = Strategy['conversions'];

export const ORDER_WORDS: Record<Strategy['order'], string> = {
  standard: 'Taxable, then tax-deferred, then Roth',
  'roth-before-deferred': 'Taxable, then Roth, then tax-deferred',
};

const untilWords = (until: number | null) => (until === null ? '' : `, until ${until}`);

function bareTitle(rule: Rule): string {
  switch (rule.kind) {
    case 'none':
      return 'None';
    case 'bracket':
      return `Fill ${pct(rule.top)}`;
    case 'aca-then-bracket':
      return `ACA limit, then ${pct(rule.top)}`;
    case 'fixed':
      return 'A fixed amount';
  }
}

/** A rule with no amount in it: a sheet's title, which is read out whole, and a copy's name.
 *  An age set is said, so the rule isn't taken for the same rule to its usual age. */
export const ruleTitle = (rule: Rule, until: number | null = null) => `${bareTitle(rule)}${untilWords(until)}`;

/** A rule's short name, as a row of Compare has it. */
export const ruleName = (rule: Rule, money: Money, until: number | null = null) => (rule.kind === 'fixed' ? `${money(rule.yearly)} a year${untilWords(until)}` : ruleTitle(rule, until));

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
  const about = moved >= 0.5 && last !== null ? `about ${money(moved < 1000 ? moved : Math.round(moved / 1000) * 1000)} converted by ${last}, ` : 'nothing converted, ';
  const age = endAgeOf(rule);
  return `With this rule: ${about}tax and health costs ${money(rule.taxAndHealth)} in all, and ${end(rule, age)}. With none: ${money(none.taxAndHealth)} and ${none.runsOutAt !== null ? `runs short at ${none.runsOutAt}` : money(none.leftAtEnd)}.`;
}

/** A copy's name after its rule, with a number if that is taken. */
export function copyNameFor(rule: Rule, plans: readonly { id: string; name: string }[]): string {
  const base = ruleTitle(rule);
  if (!nameTaken(plans, base)) return base;
  for (let n = 2; ; n++) {
    const name = `${base} ${n}`;
    if (!nameTaken(plans, name)) return name;
  }
}

/** A copy's choices beside your plan's, and the age a rule runs to by default. */
export type ChoicesBeside = { mine: TaxChoices; copy: TaxChoices; until: number | null };

/** How a copy's choices differ from your plan's, in words. */
export function choicesDiffParts({ mine, copy, until }: ChoicesBeside, money: Money): string[] {
  const rest = (c: TaxChoices) => JSON.stringify({ ...c, strategy: null });
  return [...strategyDiffParts(mine.strategy, copy.strategy, until, money), ...(rest(copy) !== rest(mine) ? ['Other settings differ'] : [])];
}

/** How a copy's order and conversions differ from your plan's, a sentence each. */
export function strategyDiffParts(main: Strategy, copy: Strategy, defaultUntil: number | null, money: Money): string[] {
  const parts: string[] = [];
  if (copy.order !== main.order) parts.push(`Order: ${ORDER_WORDS[copy.order]} (your plan: ${ORDER_WORDS[main.order]})`);
  const said = (s: Strategy) => ruleSentence(s, defaultUntil, money);
  if (said(copy) !== said(main)) parts.push(`Roth conversions: ${said(copy)} (your plan: ${said(main)})`);
  return parts;
}
