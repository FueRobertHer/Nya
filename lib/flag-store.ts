// lib/flag-store.ts
//
// Where the feature switches' values live (lib/flags.ts is what each one is):
// an environment store on the storage seam (lib/repo.ts
// defineEnvironmentStore), plain JSON, a field per flag at flags:values, and
// the last 500 changes at flags:log, each saying when, which flag, from what,
// to what and who made it. Backed up and restored with the rest of the
// environment. Read per field, leniently (lib/flag-read.ts): a field for a
// flag this release doesn't know is skipped, so a rollback ignores a newer
// flag rather than refusing the map.
//
// Written only from /dev/flags in local development (F1); from F2, by the
// admin on the admin page.

import { defineEnvironmentStore } from './repo';
import { isFlagValue, type FlagValue } from './flags';

/** How many changes the record keeps. */
export const FLAG_LOG_CAP = 500;

export const flagsStore = defineEnvironmentStore<FlagValue>('flags:values', {
  log: 'flags:log',
  what: 'feature switches',
  isValid: (v, id): v is FlagValue => isFlagValue(id, v),
  logCap: FLAG_LOG_CAP,
});
