// components/plan-savers.ts
//
// Every way the Plan tab can save something, in one place, so that with a
// scenario open nothing the tab does can reach the real Plan, and with the
// Plan open nothing reaches a scenario. components/PlanTab.tsx takes every
// saver from here and saves through nothing else (test/plan-savers.test.ts
// reads it to hold that).
//
// The paths:
//   - form: every form in the drawer (ages, figures, the Assumptions sheet,
//     which holds the method and the mix since rollout 6d, income and
//     one-offs; the allocation card's "Use my allocation" opens that sheet);
//   - repair: "Save it this way" on the card for a saved Plan this release
//     can't take as it is; it always saves the repaired Plan, never the plan
//     on screen;
//   - allocationSettings: the allocation card's own settings (target, fund
//     and account splits, tax buckets), which it saves itself.
// With a scenario open, the forms save to it (the method, the same for
// every plan, is a field the sheet disables there, and recordSave refuses
// it); the allocation settings are the same for every plan and the repair
// is the Plan's own, so those have no saver (their controls are disabled,
// with the reason). No React here.

import type { FirePlan } from '@/lib/fire/plan';

/** A save: true once the server has it, false when it wasn't saved, or the
 *  reason in words when it was refused before it was sent. */
export type Save = (next: FirePlan) => Promise<boolean | string>;

export type PlanSavers = {
  form: Save;
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
  /** The repaired Plan, while a saved one this release can't take waits. */
  repaired: FirePlan | null;
}): PlanSavers {
  if (o.scenario) {
    const save = o.scenario;
    return {
      form: save,
      repair: null,
      allocationSettings: false,
    };
  }
  const { savePlan, repaired } = o;
  return {
    form: savePlan,
    repair: repaired ? () => void savePlan(repaired) : null,
    allocationSettings: true,
  };
}
