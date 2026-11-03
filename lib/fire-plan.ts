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
import { eager } from './eager';
import type { Ctx } from './containers';
import { isStoredPlan, upgradeStoredPlan, type StoredPlan } from './fire/plan-v2';
import { hasTypedAmounts, isPlanCurrencyRecord, recordedCurrency, type PlanCurrencyRecord } from './fire/plan-currency';

// Either version reads, and each stays the version it was stored as
// (lib/fire/plan-v2.ts upgradeStoredPlan); this release writes version 1
// only (app/api/fire-plan, and a restore, refuse version 2).
export const firePlanStore = defineValueStore<StoredPlan>('fire-plan', {
  what: 'plan assumptions',
  isValid: isStoredPlan,
  exportable: true, // what the person chose and typed
  upgrade: upgradeStoredPlan,
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

/** Why a currency record there doesn't hold: it can't be read, or a newer
 *  release wrote it. */
export type CurrencyProblem = 'unreadable' | 'newer' | null;

/** The record as it reads: strict about deployment problems, but a record
 *  that can't be used is said, never thrown, so the plan still loads (the
 *  page then asks which currency the figures are in). */
export async function readCurrencyRecord(ctx: Ctx): Promise<{ record: PlanCurrencyRecord | null; problem: CurrencyProblem }> {
  const r = await planCurrencyStore.getReport(ctx);
  return { record: r.value, problem: r.unrecognised ? 'newer' : r.unreadable ? 'unreadable' : null };
}

/** A record there, for typed amounts it isn't of. */
const isStale = (plan: StoredPlan | null, record: PlanCurrencyRecord | null) => !!plan && !!record && hasTypedAmounts(plan) && recordedCurrency(plan, record) === null;

/** What the Plan is told of its plan: { plan, currency } (null and null when
 *  nothing was ever saved); `currency` is the recorded one when the record
 *  holds for the plan, else null, and `currency_problem` says why a record
 *  there doesn't: "stale" (a record of other amounts, its currency in
 *  `currency_was`), "unreadable" or "newer". */
export function planAnswer(plan: StoredPlan | null, record: PlanCurrencyRecord | null, problem: CurrencyProblem) {
  if (problem) return { plan, currency: null, currency_problem: problem };
  if (isStale(plan, record)) return { plan, currency: null, currency_problem: 'stale', currency_was: record!.currency };
  return { plan, currency: recordedCurrency(plan, record) };
}

/** The saved plan and its currency, as planAnswer says them: the two reads
 *  begun together, so they share a round trip. A plan that can't be read
 *  throws (StoredDataUnreadableError), as the plan store does. */
export async function readPlanAnswer(ctx: Ctx) {
  const plan = eager(firePlanStore.get(ctx));
  const record = eager(readCurrencyRecord(ctx));
  const stored = await plan;
  const { record: there, problem } = await record;
  return planAnswer(stored, there, problem);
}
