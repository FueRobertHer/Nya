// lib/planned-store.ts
//
// The planned items (lib/planned.ts): what the person types for the forecast
// and the detected series they said aren't recurring, one encrypted JSON
// value per container, replaced whole on every save: a value store on the
// storage seam (lib/repo.ts).
//
// Reads are strict: a value that was saved but can't be used throws
// StoredDataUnreadableError, never "no items", because the next save sends
// every item and dismissal and would replace the real ones with what is on
// screen. Never saved reads as null, which the route answers as
// EMPTY_PLANNED. isPlanned checks the shape and types, not today's ranges,
// which parsePlanned checks when a save comes in (app/api/planned-items), and
// upgradePlanned brings a warning saved as a bare number into its shape.

import { defineValueStore } from './repo';
import { isPlanned, upgradePlanned, type Planned } from './planned';

export const plannedStore = defineValueStore<Planned>('planned-items', {
  what: 'planned items',
  isValid: isPlanned,
  exportable: true, // what the person typed and chose
  upgrade: upgradePlanned,
});
