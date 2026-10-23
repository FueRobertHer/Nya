// lib/plan-scenarios.ts
//
// The Plan scenarios the person saved (lib/fire/scenarios.ts): a map store on
// the storage seam (lib/repo.ts), one entry per scenario, by a random id
// (crypto.randomUUID()), so saving or deleting one never reads or rewrites
// another. Each holds what the scenario changes from the Plan, its name and
// the currency its amounts were typed in, never a figure: everything is
// worked out again in the browser from the day's data whenever one is shown.
//
// Reads are strict: a scenario that was saved but can't be used is named by
// getAllReport (an unreadable one may be offered for deletion, once the
// person confirms; one a later version saved never is), never read as none,
// because the Plan tab edits and deletes from the same list. Edits go through
// update, the seam's compare-and-set, against the version (`rev`) the page
// loaded, so two devices never lose a save without a word
// (app/api/plan-scenarios).

import { defineMapStore } from './repo';
import { isPlanScenario, type PlanScenario } from './fire/scenarios';

export const planScenariosStore = defineMapStore<PlanScenario>('plan-scenarios', {
  what: 'saved plan scenarios',
  isValid: isPlanScenario,
  exportable: true, // what the person chose to keep
});
