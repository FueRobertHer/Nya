// lib/fire-plan.ts
//
// The Plan tab's saved assumptions (lib/fire/plan.ts), one encrypted JSON
// value per container, replaced whole on every save: a value store on the
// storage seam (lib/repo.ts). It holds what the person chose and typed: ages,
// rates, the mix, other income, one-off expenses, and any figure they typed
// over one Nya measures.
//
// Reads are strict: a value that was saved but can't be used throws
// StoredDataUnreadableError, never "no plan", because the next save sends the
// whole plan and would replace the real one with defaults. Never saved reads
// as null, which the Plan tab shows as the defaults.
//
// The key name is the one the store had before it moved onto the seam, and
// the value is written the same way (encrypted JSON, not bound to a context,
// not compressed), so every plan saved before reads back unchanged. Reads take
// any plan any release saved: isFirePlan checks the shape and types, not
// today's ranges, and upgradePlan fills in a field added since. The ranges are
// checked when a plan is saved (parsePlan, in the route).

import { defineValueStore } from './repo';
import { isFirePlan, upgradePlan, type FirePlan } from './fire/plan';
import { isPlanCurrencyRecord, type PlanCurrencyRecord } from './fire/plan-currency';

export const firePlanStore = defineValueStore<FirePlan>('fire-plan', {
  what: 'plan assumptions',
  isValid: isFirePlan,
  exportable: true, // what the person chose and typed
  upgrade: upgradePlan,
});

// The currency the plan's typed figures are in (lib/fire/plan-currency.ts),
// one encrypted value beside the plan: a store of its own because FirePlan's
// shape is closed, and a field there would make the release before refuse
// the whole plan. It holds the currency and the plan's typed amounts as the
// save that wrote it left them, so a read tells it from a plan changed since
// (by the release before after a rollback, say) and then asks instead.
// Strict, as the plan is: a damaged record is replaced only on the person's
// answer, and a later release's is never written over (app/api/fire-plan).
export const planCurrencyStore = defineValueStore<PlanCurrencyRecord>('fire-plan-currency', {
  what: 'records of your plan’s currency',
  isValid: isPlanCurrencyRecord,
  exportable: true, // what the person typed their figures in
});
