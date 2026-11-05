// components/plan-savers.ts
//
// Every way the Plan tab can save something, in one place, so that with a
// copy open nothing the tab does can reach your plan but on purpose (Also
// change it in), and with your plan open nothing reaches a copy unasked.
// components/PlanTab.tsx takes every saver from here and saves through
// nothing else (test/plan-savers.test.ts reads it to hold that).
//
// The paths:
//   - form: every form in the drawer (Household, figures, the Assumptions
//     sheet, which holds the method and the mix since rollout 6d; the
//     allocation card's "Use my allocation" opens that sheet) and the
//     Timeline's items,
//     with the plans checked in Also change it in;
//   - repair: "Save it this way" on the card for a saved plan this release
//     can't take as it is; it always saves the repaired plan, never the plan
//     on screen;
//   - allocationSettings: the allocation card's own settings (target, fund
//     and account splits, tax buckets), which it saves itself;
//   - taxFacts: what is said about an account or a person (the tax facts), which
//     the Invested assets sheet saves through /api/plan-facts;
//   - more: Household, Health coverage and Assumptions in a detailed plan, which
//     say more than the plan and save it all in one request.
// With a copy open, the forms save to it (the method, the same for every
// plan, is a field the sheet disables there); the allocation settings and the
// tax facts are the same for every plan and the repair is your plan's own, so
// those have no saver (their controls are disabled, with the reason). No React
// here.

import type { FirePlanV2 } from '@/lib/fire/plan-v2';
import type { MoreSave } from './PlanForms';

/** A save: true once the server has it, false when it wasn't saved, or the
 *  reason in words when it was refused before it was sent. `also`: the
 *  other plans the same change goes to, saved with it, all or none. */
export type Save = (next: FirePlanV2, also?: readonly string[]) => Promise<boolean | string>;

/** A save with what it says beside the plan (the tax plan's Saves): the plan's tax
 *  choices and, on your plan, the household, in one request. */
export type SaveMore = (next: FirePlanV2, more: MoreSave, also?: readonly string[]) => Promise<boolean | string>;

export type PlanSavers = {
  form: Save;
  more: SaveMore;
  /** Null: there is no repair to save here. */
  repair: (() => void) | null;
  /** Whether the allocation card's own settings may be saved here. */
  allocationSettings: boolean;
  /** Whether the tax facts may be saved here. */
  taxFacts: boolean;
};

export function planSavers(o: {
  /** The open copy's saver, or null with your plan open. */
  copy: Save | null;
  /** Your plan's own saver: true once saved, or why it wasn't sent. */
  savePlan: Save;
  /** The repaired plan, while a saved one this release can't take waits. */
  repaired: FirePlanV2 | null;
  /** The plan shown's, with what it says beside the plan: to a copy, the copy alone. */
  more: SaveMore;
}): PlanSavers {
  if (o.copy) {
    const save = o.copy;
    return {
      form: save,
      more: o.more,
      repair: null,
      allocationSettings: false,
      taxFacts: false,
    };
  }
  const { savePlan, repaired } = o;
  return {
    form: savePlan,
    more: o.more,
    repair: repaired ? () => void savePlan(repaired) : null,
    allocationSettings: true,
    taxFacts: true,
  };
}
