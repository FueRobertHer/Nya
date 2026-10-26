// lib/saved-plan.ts
//
// The plan the person said is their plan (lib/fire/saved-plan.ts), one
// encrypted JSON value per container, replaced whole on every save: a value
// store on the storage seam (lib/repo.ts). It holds the Plan's assumptions as
// they were that day, the savings the Plan used, its currency, an inflation
// rate and the day, never a figure worked out from them.
//
// Reads are strict, as the Plan's are: one that was saved but can't be used
// is said (an unreadable one may be deleted once the person confirms; one a
// later version saved never is), never read as none. A save is a
// compare-and-set against the version the page loaded (app/api/saved-plan).

import { defineValueStore } from './repo';
import { isSavedPlan, upgradeSavedPlan, type SavedPlan } from './fire/saved-plan';

export const savedPlanStore = defineValueStore<SavedPlan>('fire-plan-saved', {
  what: 'the plan you saved as your plan',
  isValid: isSavedPlan,
  upgrade: upgradeSavedPlan,
  exportable: true, // what the person chose to keep
});
