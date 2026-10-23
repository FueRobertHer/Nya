// lib/report/runway-scenario-store.ts
//
// The runway scenarios the person saved (lib/report/runway-scenarios.ts): a
// map store on the storage seam (lib/repo.ts), one entry per scenario, by a
// random id (crypto.randomUUID()), so saving or deleting one never reads or
// rewrites another, and one person on two devices never loses a save.
//
// Reads are strict: a scenario that was saved but can't be used is named by
// getAllReport (an unreadable one may be offered for deletion, once the
// person confirms; an unrecognised one never is), never read as none. Nothing
// else reads them: the runway itself stores nothing (app/api/reports/runway).

import { defineMapStore } from '../repo';
import { isRunwayScenario, type RunwayScenario } from './runway-scenarios';

export const runwayScenariosStore = defineMapStore<RunwayScenario>('runway-scenarios', {
  what: 'saved runway scenarios',
  isValid: isRunwayScenario,
  exportable: true, // what the person chose to keep
});
