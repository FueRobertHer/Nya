// components/plan-tune.ts
//
// The words of Tune to a goal (components/PlanTune.tsx). Neutral: each row says what its
// setting comes to and what it crosses, and nothing is called best or recommended (the
// tax plan's D4). What holds an amount is drawn through Masked by the view. A lawyer
// reads these before this ships: test/plan-tune.test.ts holds the words kept out.

import type { Strategy } from '@/lib/fire/tax/rules';
import type { TunedRow, TuneGoal, TuneLimit } from '@/lib/fire/tune';
import { healthPace } from './plan-drawdown';
import { endWords, movedWords, ORDER_WORDS, ruleName } from './plan-conversions';

type Money = (n: number) => string;

export const TUNE_TITLE = 'Tune to a goal';
export const TUNE_ROW_SUB = 'Each rule’s settings worked out for a goal you pick';
export const TUNE_HELPER = 'Pick what matters to you, then Tune. Nya tries each rule’s settings and shows each rule tuned for that goal. It doesn’t recommend one, and nothing changes until you choose.';
/** In the row's place, on a spending rule whose spending moves with the setting. */
export const TUNE_NEEDS_CONSTANT = 'Tune to a goal needs the Constant withdrawal rule. Other rules spend differently under each setting, so what’s left wouldn’t compare like with like.';
export const TUNE_GOAL_LEGEND = 'Your goal';
export const TUNE_LIMITS_LEGEND = 'Limits, if any';
export const TUNE_FAILED = 'This couldn’t be tuned. Try again.';
export const TUNE_BUSY = 'Tuning…';
export const TUNE_GONE = 'These can’t be tuned right now.';
export const TUNE_SORT = 'Sort by your goal';
export const TUNE_SORTED = 'Sorted by your goal because you asked. Nothing here is called best.';
export const TUNE_HOLDS = 'Each rule here keeps your stop, your start and what’s timed on them where they are now, so the rules compare like with like. A rule’s own sheet shows what it comes to once used.';
export const TUNE_ONLY_ORDER = 'Required withdrawals have started, so the order is all there is to tune.';
export const TUNE_IRMAA_UNKNOWN = 'Medicare’s first years here have no income from two years before to read, so no surcharge is counted in them.';

const ageWords = (endAge: number | null) => (endAge === null ? 'at the end' : `at ${endAge}`);

export const goalName = (goal: TuneGoal, endAge: number | null) => (goal === 'left' ? `Most left ${ageWords(endAge)}, after tax` : 'Least tax and health costs');

export const tunedHeading = (goal: TuneGoal, endAge: number | null) => (goal === 'left' ? `Tuned for the most left ${ageWords(endAge)}` : 'Tuned for the least tax and health costs');

export const LIMIT_NAMES: Record<TuneLimit, string> = {
  aca: 'Stay under the ACA limit',
  irmaa: 'Stay out of IRMAA’s surcharges',
  'bracket-22': 'No higher than the 22% bracket',
};

const yearsWords = (n: number) => (n === 1 ? '1 year' : `${n} years`);

const LIMIT_NOTES: Record<TuneLimit, (years: string) => string> = {
  aca: (years) => `Crosses the ACA limit in ${years}`,
  irmaa: (years) => `Pays IRMAA’s surcharge in ${years}`,
  'bracket-22': (years) => `Goes past the 22% bracket in ${years}`,
};

const ORDER_SHORT: Record<Strategy['order'], string> = {
  standard: 'Tax-deferred before Roth',
  'roth-before-deferred': 'Roth before tax-deferred',
};

/** A row's rule, at its setting: an end at the run's first age is that age only. The ACA
 *  rule goes on filling to its floor past its age, so it is never "only". */
export function tunedName(s: Strategy, first: number | null, money: Money): string {
  if (s.conversions.kind === 'none') return ruleName(s.conversions, money);
  if (s.conversions.kind !== 'aca-then-bracket' && s.convertUntil !== null && s.convertUntil === first) return `${ruleName(s.conversions, money)}, at ${first} only`;
  return ruleName(s.conversions, money, s.convertUntil);
}

/** What a row says under its name: its order where it isn't the plan's, what it crosses,
 *  and where it comes to no better than None. Empty where there is nothing to add. */
export function tunedNote(row: Pick<TunedRow, 'run' | 'crossing' | 'beatsNone'>, own: Strategy, goal: TuneGoal): string {
  const parts = [
    ...(row.run.strategy.order !== own.order ? [ORDER_SHORT[row.run.strategy.order]] : []),
    ...row.crossing.map((c) => LIMIT_NOTES[c.limit](yearsWords(c.years))),
    ...(row.beatsNone === false ? [goal === 'left' ? 'leaves no more than None' : 'costs no less than None'] : []),
  ];
  const line = parts.join(' · ');
  return line.charAt(0).toUpperCase() + line.slice(1);
}

/** Said on a tuned figure, on the table and on a row's own sheet. */
export const tunedFor = (lawYear: number, healthGrowth: number) => `Tuned for the goal you set, under these assumptions. Hypothetical, ${lawYear} tax law, steady growth, health costs ${healthPace(healthGrowth)}. Not tax advice.`;

export const tapLine = (copyOpen: boolean) => `Tap a rule for ${copyOpen ? 'Use in this copy' : 'Use in your plan'} or Try it in a copy.`;

/** What the plan has now, under the table, on the goal's figure. */
export function ownLine(a: { goal: TuneGoal; own: Strategy; until: number; left: number; cost: number; short: number | null; copyOpen: boolean }, money: Money): string {
  const none = a.own.conversions.kind === 'none';
  const age = a.own.convertUntil ?? a.until;
  const who = none ? `With None, ${a.copyOpen ? 'this copy' : 'your plan'}` : `${a.copyOpen ? 'This copy’s' : 'Your plan’s'} rule, until ${age},`;
  if (a.goal === 'cost') return `${who} costs ${money(a.cost)} in tax and health.`;
  return a.short !== null ? `${who} runs short at ${a.short}.` : `${who} leaves ${endWords({ runsOutAt: null, leftAtEnd: a.left }, money)}.`;
}

/** A row's order, where it isn't the plan's. */
export const orderLine = (order: Strategy['order'], own: Strategy['order'], copyOpen: boolean) => `Order: ${ORDER_WORDS[order]} (${copyOpen ? 'this copy' : 'your plan'}: ${ORDER_WORDS[own]})`;

export const useLabel = (copyOpen: boolean) => (copyOpen ? 'Use in this copy' : 'Use in your plan');
export const hasThisRule = (copyOpen: boolean) => (copyOpen ? 'This copy has this rule.' : 'Your plan has this rule.');
export const comesToTheSame = (copyOpen: boolean) => `This comes to the same as ${copyOpen ? 'this copy' : 'your plan'}.`;
export const usedFailed = (copyOpen: boolean) => `This couldn’t be worked out once used, so ${useLabel(copyOpen)} and Try it in a copy are off.`;

/** Why a rule's own sheet differs from its row, naming what moved where it can. */
export function movedLine(a: { stop: [number, number] | null; start: [number, number] | null; copyOpen: boolean }, money: Money): string {
  const who = a.copyOpen ? 'this copy' : 'your plan';
  const moved = movedWords(a, money);
  return moved ? `Once used, ${who} ${moved}, so this differs from the table.` : `Once used, more of ${who} moves with this rule, so this differs from the table.`;
}
