// components/plan-conversions.ts
//
// The words of How you draw and Compare conversions (components/PlanHowYouDraw.tsx),
// and of a copy that differs in them (components/plan-diff.ts). Neutral: each rule
// says what it does, what it comes to, and never that it is better than another (the
// tax plan's D4). What holds an amount is drawn through Masked by the view.

import type { Drawdown } from '@/lib/fire/drawdown';
import type { TaxChoices } from '@/lib/fire/tax-choices';
import { nameTaken, SCENARIO_NAME_MAX } from '@/lib/fire/plan-list';
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
      return `Fill the ${pct(rule.top)} bracket`;
    case 'aca-then-bracket':
      return `ACA limit, then the ${pct(rule.top)} bracket`;
    case 'fixed':
      return 'A fixed amount';
  }
}

/** A rule with no amount in it: a sheet's title, which is read out whole, and a copy's name,
 *  so with room for a number after it it has to fit a plan's name (SCENARIO_NAME_MAX).
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

/** What a run lives on, in all: its years' living spending. */
const livedOn = (d: Pick<Drawdown, 'years'>) => d.years.reduce((n, y) => n + y.living, 0);

/** Runs that live on different amounts, a dollar or more apart in all, so what each
 *  leaves doesn't compare like with like. Only a withdrawal rule that spends with the
 *  balance does that: on the Constant rule each run lives on the same, whatever it pays
 *  in tax (lib/fire/drawdown.ts grosses its spending up by the run's own share). */
export function spendDifferently(runs: readonly Pick<Drawdown, 'years'>[]): boolean {
  const lived = runs.map(livedOn);
  return lived.length > 1 && Math.max(...lived) - Math.min(...lived) >= 1;
}

/** What a plan comes to with a rule in it, once used: its own figures, not a row's run
 *  held at the plan's stop and start. `retry` asks again, where it failed for a search
 *  that couldn't be run. */
export type UsedFigures = { drawn: Drawdown | null; stop: number | null; start: number | null; working: boolean; failed: boolean; retry: (() => void) | null };

/** The figures the plan shown has now. */
export type NowFigures = { drawn: Drawdown; stop: number | null; start: number | null };

/** How a rule once used stands to its run held where the plan is (a row, the preview):
 *  `ready`, its figures once worked out; the stop and start where each moved, by a
 *  dollar or more, as [now, once used]; and whether it differs from the held run. */
export function onceUsed(held: { left: number; cost: number; short: number | null }, now: NowFigures | null, answer: UsedFigures) {
  const ready = !answer.working && !answer.failed ? answer.drawn : null;
  const moved = (a: number | null, b: number | null): [number, number] | null => (a !== null && b !== null && Math.abs(a - b) >= 1 ? [a, b] : null);
  const stop = now ? moved(now.stop, answer.stop) : null;
  const start = now ? moved(now.start, answer.start) : null;
  const differs = ready !== null && (Math.abs(ready.leftAtEnd - held.left) >= 1 || Math.abs(ready.taxAndHealth - held.cost) >= 1 || ready.runsOutAt !== held.short || stop !== null || start !== null);
  return { ready, stop, start, differs };
}

/** What moved, as Tune's sheet and the preview name it: "stops at 57, not 54, and
 *  starts from $X, not $Y". Empty where neither did. */
export function movedWords(a: { stop: [number, number] | null; start: [number, number] | null }, money: Money): string {
  const stop = a.stop && `stops at ${a.stop[1]}, not ${a.stop[0]}`;
  const start = a.start && `starts from ${money(a.start[1])}, not ${money(a.start[0])}`;
  return [stop, start].filter((x) => x !== null).join(', and ');
}

/** Under Compare's table on a withdrawal rule other than Constant, in place of Tune's
 *  line: what the rows hold, without saying they compare like with like, since the line
 *  at the card's foot says such rules spend differently. */
export const COMPARE_HOLDS = 'Each rule here keeps your stop, your start and what’s timed on them where they are now. A rule’s own sheet shows what it comes to once used.';

/** In its place, where the withdrawal rule spends differently under each rule. */
export const COMPARE_SPENDS = 'Each rule here keeps your stop, your start and what’s timed on them where they are now, but your withdrawal rule spends differently under each, so what’s left doesn’t compare like with like. A rule’s own sheet shows what it comes to once used.';

/** Under the preview's table, where this rule and None spend differently. */
export const PREVIEW_SPENDS = 'Your withdrawal rule spends differently under this rule and None, so what’s left doesn’t compare like with like.';

/** A rule's sheet from Compare, where it couldn't be worked out once used. */
export const RULE_USED_FAILED = 'This couldn’t be worked out once used, so Try it in a copy is off.';

/** The preview, where what Save gives couldn't be worked out. */
export const SAVED_FAILED = 'What this rule comes to once saved couldn’t be worked out.';

/** Why the preview isn't what Save gives, what moved, and what Save gives. */
export function savedLine(a: { stop: [number, number] | null; start: [number, number] | null; copyOpen: boolean; drawn: Pick<Drawdown, 'leftAtEnd' | 'taxAndHealth' | 'runsOutAt' | 'years'> }, money: Money): string {
  const who = a.copyOpen ? 'this copy' : 'your plan';
  const moved = movedWords(a, money);
  const age = endAgeOf(a.drawn);
  const end = a.drawn.runsOutAt !== null ? `runs short at ${a.drawn.runsOutAt}` : `leaves ${money(a.drawn.leftAtEnd)}${age === null ? '' : ` at ${age}`}`;
  return `Once saved, ${moved ? `${who} ${moved}` : `more of ${who} moves with this rule`}, so it differs from the table: it ${end} and costs ${money(a.drawn.taxAndHealth)} in tax and health.`;
}

/** The sheet's preview, as the rule is changed: this rule beside none. */
export function previewRows(rule: Drawdown, none: Drawdown, money: Money): [string, string, string][] {
  const moved = convertedIn(rule);
  const last = lastConverting(rule);
  const about = moved >= 0.5 && last !== null ? `About ${money(moved < 1000 ? moved : Math.round(moved / 1000) * 1000)}, by ${last}` : money(0);
  const age = endAgeOf(rule);
  return [
    ['Converted', about, money(0)],
    ['Tax and health, in all', money(rule.taxAndHealth), money(none.taxAndHealth)],
    [age === null ? 'Left, after tax' : `Left at ${age}, after tax`, endWords(rule, money), endWords(none, money)],
  ];
}

export const RULES_DIFFER_LABEL = 'Why do the rules differ?';

/** Why the rules come to different figures, about no rule in particular (D4): true with
 *  or without a Medicaid line, since it says only what happens unless Medicaid covers you. */
export function rulesDifferText(a: { onAca: boolean; acaLaw: TaxChoices['health']['acaLaw'] }): string {
  const early = !a.onAca ? 'More income early pays more tax now' : a.acaLaw === 'enhanced' ? 'More income early can mean a smaller credit' : 'More income early can pass the ACA limit';
  const low = a.onAca ? ' Later, drawing mostly Roth, income can fall too low for a credit, and unless Medicaid covers you then, coverage is counted at full price.' : '';
  return `Conversions move income between years. ${early} and can empty tax-deferred money early.${low} Less income early can leave larger required withdrawals later.`;
}

/** A copy's name after its rule, with a number if that is taken, and the age it runs to
 *  where a plan's name still has room for that and a number. */
export function copyNameFor(rule: Rule, plans: readonly { id: string; name: string }[], until: number | null = null): string {
  const aged = ruleTitle(rule, until);
  const base = `${aged} 99`.length <= SCENARIO_NAME_MAX ? aged : ruleTitle(rule);
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
