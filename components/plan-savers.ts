// components/plan-savers.ts
//
// Every way the Plan tab can save something, in one place, so that with a
// scenario open nothing the tab does can reach the real Plan, and with the
// Plan open nothing reaches a scenario. components/PlanTab.tsx takes every
// saver from here and saves through nothing else (test/plan-savers.test.ts
// reads it to hold that).
//
// The paths:
//   - form: every form in the drawer (ages, figures, assumptions, the
//     simulation, income and one-offs);
//   - allocationMix: "Use my allocation" on the allocation card;
//   - method: the History and Monte Carlo switch on "Will it last?";
//   - repair: "Save it this way" on the card for a saved Plan this release
//     can't take as it is; it always saves the repaired Plan, never the plan
//     on screen;
//   - allocationSettings: the allocation card's own settings (target, fund
//     and account splits, tax buckets), which it saves itself.
// With a scenario open, the forms and Use my allocation save to it; the
// method and the allocation settings are the same for every plan and the
// repair is the Plan's own, so those have no saver (their controls are
// disabled, with the reason). No React here.

import type { FirePlan } from '@/lib/fire/plan';
import type { Method } from '@/lib/fire/simulate';

/** A save: true once the server has it, false when it wasn't saved, or the
 *  reason in words when it was refused before it was sent. */
export type Save = (next: FirePlan) => Promise<boolean | string>;

export type PlanSavers = {
  form: Save;
  allocationMix: (next: FirePlan) => Promise<boolean>;
  /** Null: the method can't be changed here. */
  method: ((m: Method) => void) | null;
  /** Null: there is no repair to save here. */
  repair: (() => void) | null;
  /** Whether the allocation card's own settings may be saved here. */
  allocationSettings: boolean;
};

export function planSavers(o: {
  /** The open scenario's saver, or null with the Plan open. */
  scenario: Save | null;
  /** The Plan's own store: true once saved, or why it wasn't sent. */
  savePlan: Save;
  /** The Plan as the tab shows it (the repaired one while a repair waits). */
  plan: FirePlan;
  /** The repaired Plan, while a saved one this release can't take waits. */
  repaired: FirePlan | null;
}): PlanSavers {
  if (o.scenario) {
    const save = o.scenario;
    return {
      form: save,
      allocationMix: async (next) => (await save(next)) === true,
      method: null,
      repair: null,
      allocationSettings: false,
    };
  }
  const { savePlan, plan, repaired } = o;
  return {
    form: savePlan,
    allocationMix: async (next) => (await savePlan(next)) === true,
    method: (method) => void savePlan({ ...plan, method }),
    repair: repaired ? () => void savePlan(repaired) : null,
    allocationSettings: true,
  };
}
