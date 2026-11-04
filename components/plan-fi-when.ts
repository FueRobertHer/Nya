// components/plan-fi-when.ts
//
// When a plan reaches FI, as the FI card's headline says it, and against
// another plan's ("FI around 42, 3 years later"): the Plans sheet's rows, how
// a copy differs (components/plan-diff.ts), the Timeline's FI marker and the
// item sheet's preview (components/plan-items.ts). Moved here from the What
// if… card's words when E2 retired it. No amount in any of it.

import type { PlanFigures } from '@/lib/fire/plan-figures';
import { fiHeadline } from './plan-text';

/** When a plan reaches its FI number, as the card says it. */
export type FiWhen =
  | { kind: 'age'; age: number }
  | { kind: 'now' }
  | { kind: 'never' }
  | { kind: 'short'; figures: PlanFigures }
  /** The FI card's own headline, with no age to set against another: "In
   *  11.4 years", "Not before age 100 at this savings rate". */
  | { kind: 'said'; text: string }
  | { kind: 'none' }
  /** Not worked out at all: another currency, a rule it breaks now, lasting
   *  changes below zero. */
  | { kind: 'not-run' };

/** A plan's FI age as the FI card's headline says it (components/plan-text.ts
 *  fiHeadline): rounded, and past age 100 not an age at all. */
export function fiWhen(f: PlanFigures | null): FiWhen {
  if (!f) return { kind: 'not-run' };
  if (f.short) return { kind: 'short', figures: f };
  const h = fiHeadline(f.view, { age: f.plan.age, stopAge: f.view.stopAge, stopAtFi: f.plan.stopAtFi });
  switch (h.kind) {
    case 'age':
      return { kind: 'age', age: h.age as number };
    case 'there':
      return { kind: 'now' };
    case 'never':
      return { kind: 'never' };
    case 'years':
    case 'later':
      return { kind: 'said', text: h.headline };
    default:
      return { kind: 'none' };
  }
}

/** "3 years later", "2 years sooner", "as in your plan": from the ages as
 *  said, so the words add up. */
export function moveText(age: number, planAge: number): string {
  const d = age - planAge;
  if (d === 0) return 'as in your plan';
  const n = Math.abs(d);
  return `${n} year${n === 1 ? '' : 's'} ${d > 0 ? 'later' : 'sooner'}`;
}

/** A plan's FI age against your plan's: "FI around 42, 3 years later". No
 *  amount in it. */
export function lifeChoiceText(when: FiWhen, plan: FiWhen): string {
  switch (when.kind) {
    case 'age':
      return `FI around ${when.age}${plan.kind === 'age' ? `, ${moveText(when.age, plan.age)}` : plan.kind === 'never' ? ', where your plan isn’t reached at this savings rate' : ''}`;
    case 'now':
      return plan.kind === 'now' ? 'You’re at FI, as in your plan' : 'You’re at FI';
    case 'never':
      return 'Not reached at this savings rate';
    case 'said':
      return when.text;
    case 'short':
      return when.figures.short?.kind === 'cost' ? 'No FI date: a cost it can’t pay from its investments' : 'No FI date: a year takes out more than there is';
    case 'none':
      return 'No FI age worked out';
    case 'not-run':
      return 'Not worked out: open it to see why';
  }
}
