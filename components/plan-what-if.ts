// components/plan-what-if.ts
//
// The What if… card's templates and words (rollout phase 8c,
// components/PlanWhatIf.tsx): a life choice as a template for a kind of life
// event (lib/fire/events.ts), the name a scenario made from one takes, and
// how a scenario moves the FI age against your plan. A template fills in
// nothing but the event's name: every amount, age and length is the
// person's own. Kept apart from the component so the exact sentences can be
// tested. Every amount goes through the `money` a caller gives.

import { eventSpan, type LifeEvent, type LifeEventKind } from '@/lib/fire/events';
import type { PlanFigures } from '@/lib/fire/plan-figures';
import { nameTaken, SCENARIO_NAME_MAX } from '@/lib/fire/scenarios';
import { shortText } from './plan-scenario-text';

type Money = (n: number) => string;

export type WhatIfTemplate = {
  id: string;
  kind: LifeEventKind;
  /** The chip's words, and the sheet's title. */
  label: string;
  /** The event's name, as the form starts it. */
  name: string;
  /** "Buy a home at 38": the scenario's name, from the event's age. */
  scenarioName: (age: number) => string;
};

/** The kinds that exist, as life choices. A kind may have more than one. */
export const WHAT_IF_TEMPLATES: readonly WhatIfTemplate[] = [
  { id: 'home', kind: 'house', label: 'Buy a home', name: 'Buying a home', scenarioName: (age) => `Buy a home at ${age}` },
  { id: 'big-expense', kind: 'spending', label: 'Travel or a big expense', name: 'Travel or a big expense', scenarioName: (age) => `Travel or a big expense at ${age}` },
  { id: 'child', kind: 'child', label: 'A child', name: 'A child', scenarioName: (age) => `A child at ${age}` },
  { id: 'career-break', kind: 'sabbatical', label: 'A career break', name: 'A career break', scenarioName: (age) => `A career break at ${age}` },
  { id: 'part-time', kind: 'part-time', label: 'Part-time work', name: 'Part-time work', scenarioName: (age) => `Part-time work from ${age}` },
  { id: 'spending', kind: 'spending', label: 'A change in spending', name: 'A change in spending', scenarioName: (age) => `A change in spending at ${age}` },
];

/** The scenario's name for an event from a template: its own, or with
 *  " (2)", " (3)"... when another scenario has it already. */
export function whatIfName(template: WhatIfTemplate, event: LifeEvent, others: readonly { id: string; name: string }[]): string {
  const base = template.scenarioName(eventSpan(event).from).slice(0, SCENARIO_NAME_MAX);
  if (!nameTaken(others, base)) return base;
  for (let n = 2; ; n++) {
    const tail = ` (${n})`;
    const name = base.slice(0, SCENARIO_NAME_MAX - tail.length) + tail;
    if (!nameTaken(others, name)) return name;
  }
}

/** When a plan reaches its FI number, as the card says it. */
export type FiWhen =
  | { kind: 'age'; age: number }
  | { kind: 'now' }
  | { kind: 'never' }
  | { kind: 'short'; figures: PlanFigures }
  | { kind: 'none' }
  /** Not worked out at all: another currency, a rule it breaks now, lasting
   *  changes below zero. */
  | { kind: 'not-run' };

/** A plan's FI age, rounded as the FI card rounds it. */
export function fiWhen(f: PlanFigures | null): FiWhen {
  if (!f) return { kind: 'not-run' };
  if (f.short) return { kind: 'short', figures: f };
  const years = f.view.yearsToFi;
  if (years === Infinity) return { kind: 'never' };
  if (years === 0) return { kind: 'now' };
  if (f.view.fiAge !== null) return { kind: 'age', age: Math.round(f.view.fiAge) };
  return { kind: 'none' };
}

/** "3 years later", "2 years sooner", "as in your plan": from the ages as
 *  said, so the words add up. */
function moveText(age: number, planAge: number): string {
  const d = age - planAge;
  if (d === 0) return 'as in your plan';
  const n = Math.abs(d);
  return `${n} year${n === 1 ? '' : 's'} ${d > 0 ? 'later' : 'sooner'}`;
}

/** A scenario's line in the card: "FI around 42, 3 years later". No amount
 *  in it. */
export function lifeChoiceText(when: FiWhen, plan: FiWhen): string {
  switch (when.kind) {
    case 'age':
      return `FI around ${when.age}${plan.kind === 'age' ? `, ${moveText(when.age, plan.age)}` : plan.kind === 'never' ? ', where your plan doesn’t get there at this rate' : ''}`;
    case 'now':
      return plan.kind === 'now' ? 'At FI now, as in your plan' : 'At FI now';
    case 'never':
      return 'No FI at this rate';
    case 'short':
      return when.figures.short?.kind === 'cost' ? 'No FI date: a cost it can’t pay from its investments' : 'No FI date: a year takes out more than there is';
    case 'none':
      return 'No FI age worked out';
    case 'not-run':
      return 'Not worked out: open it to see why';
  }
}

/** What a template's draft does, said in its sheet as it is typed: null
 *  while the form can't be saved (`missing`: a field is empty, else one is
 *  out of range). Part-time work counts from the stop age, never in the FI
 *  date: when it leaves the age where it is, it says why. */
export function previewText(when: FiWhen | null, plan: FiWhen, money: Money, kind: LifeEventKind | null = null, missing = true): string {
  if (when === null) return missing ? 'Fill in the figures to see how it moves your FI age.' : 'Once the figures are in range, this says how they move your FI age.';
  if (when.kind === 'age' && plan.kind === 'age') {
    if (when.age !== plan.age) return `In this what-if, FI moves from around ${plan.age} to around ${when.age} (${moveText(when.age, plan.age)}).`;
    return kind === 'part-time'
      ? `In this what-if, FI stays around ${plan.age}, as in your plan: part-time work counts from your stop age on, in Will it last?, not in when you reach FI.`
      : `In this what-if, FI stays around ${plan.age}, as in your plan.`;
  }
  if (when.kind === 'short' && when.figures.short) {
    const why = shortText(when.figures.short, when.figures.plan.age, money);
    return `In this what-if, ${why.charAt(0).toLowerCase()}${why.slice(1)}`;
  }
  if (when.kind === 'not-run') return 'In this what-if, the figures can’t be worked out: its lasting change takes your spending in retirement below zero.';
  return `In this what-if: ${lifeChoiceText(when, plan)}.`;
}
