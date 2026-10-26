// lib/fire/path.ts
//
// One plan's path: invested assets year by year from today, the balances the
// FI figures already rest on, for the chart on Your path (rollout 8b) to
// draw. From the same functions as the figures, so the point at the target
// age is the view's atTargetAge exactly:
//   - with life events that change the walk (lib/fire/events.ts), the walk's
//     own balances (walkPath, which walkBalanceAt reads);
//   - otherwise projectBalance at each whole year (lib/fire/fi.ts), the
//     closed form fiView projects the target age's balance with, stopping
//     where a year would end below zero (projectionShort), as the walk does.
// Nothing from nowhere: no point the figures couldn't also give, and none
// where the walk can't go on (a cost larger than the balance, or a year
// taking out more than there is).
//
// Arithmetic only, and nothing that touches storage: the Plan tab runs this
// in the browser.

import { projectBalance, projectionShort } from './fi';
import { hasWalk, walkPath, type Shortfall } from './events';
import { projectFrom } from './plan';
import type { PlanFigures } from './plan-figures';

export type PathPoint = { age: number; balance: number };

export type PlanPath = {
  /** From today's age, one a year, to the end asked for (the target age by
   *  default), or through the start of the year the walk can't go on. */
  points: PathPoint[];
  /** The age the plan stops working at (its target age). */
  stopAge: number;
  /** The view's: the FI number, and the age it is reached at (null when it
   *  never is, or isn't worked out). */
  fiNumber: number | null;
  fiAge: number | null;
  /** Where this path can't go on, within its own years. Not the figures'
   *  `short`, which is the FI date's: the walk to the FI number, which keeps
   *  going until it gets there and is only looked for with an FI number. */
  short: Shortfall | null;
  /** The points are the walk's, with the scenario's life events. Not the
   *  figures' `walked`, which says the FI date is (that needs an FI number;
   *  these points don't). */
  fromWalk: boolean;
};

/** The path from today, `years` whole years long (to the target age by
 *  default); null when there is nothing to project from (projectFrom).
 *  Throws on a length that isn't a whole number of years, 0 or more. */
export function planPath(f: PlanFigures, years?: number): PlanPath | null {
  if (years !== undefined && !(Number.isInteger(years) && years >= 0)) throw new RangeError(`A path is a whole number of years, 0 or more: ${years}`);
  const from = projectFrom(f.plan, f.view);
  if (from === null) return null;
  const age = f.plan.age as number;
  const n = years ?? from.years;
  const g = f.plan.realReturn;
  const walk = f.events !== null && hasWalk(f.events.walk) ? f.events.walk : null;
  let balances: number[];
  let short: Shortfall | null = null;
  if (walk !== null) {
    ({ balances, short } = walkPath(from.assets, from.savings, g, walk, n));
  } else {
    short = projectionShort(from.assets, from.savings, g, n);
    balances = [];
    for (let k = 0; k <= (short ? short.year : n); k++) balances.push(projectBalance(from.assets, from.savings, g, k));
  }
  return {
    points: balances.map((balance, k) => ({ age: age + k, balance })),
    stopAge: f.plan.targetAge as number,
    fiNumber: f.view.fiNumber,
    fiAge: f.view.fiAge,
    short,
    fromWalk: walk !== null,
  };
}
