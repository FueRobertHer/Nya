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
// Written from /dev/flags in local development, by the admin on the admin
// page (app/api/admin/flags), and by an account's deletion, which takes it off
// every audience that names it (dropAccountFromFlags).

import { defineEnvironmentStore, StoredDataUnreadableError } from './repo';
import { isAudienceValue, isFlagKey, isFlagValue, type FlagValue } from './flags';
import { nextFlagValue, NoFlagChange } from './flag-change';
import type { ContainerId } from './containers';

/** How many changes the record keeps. */
export const FLAG_LOG_CAP = 500;

export const flagsStore = defineEnvironmentStore<FlagValue>('flags:values', {
  log: 'flags:log',
  what: 'feature switches',
  isValid: (v, id): v is FlagValue => isFlagValue(id, v),
  logCap: FLAG_LOG_CAP,
});

/** Takes a deleted account off every audience that names it
 *  (lib/account-deletion.ts, step 8b): one change each, recorded as made by
 *  the account's deletion, so the record says why its id went. The record keeps the
 *  changes that named it before, until they drop out of the last
 *  FLAG_LOG_CAP. A value that can't be read is left as it is, logged by key
 *  (the id of an account that is gone matches nobody); a storage failure
 *  throws, and running the deletion again finishes the rest. Returns how many
 *  it was taken off. */
export async function dropAccountFromFlags(container: ContainerId, now: number = Date.now()): Promise<number> {
  const { entries, unrecognised } = await flagsStore.getAllReport();
  for (const key of unrecognised) if (isFlagKey(key)) console.error(`Flags: the stored value of ${key} can't be read, so an account's deletion left it as it is.`);
  let dropped = 0;
  for (const [key, value] of entries) {
    if (!isFlagKey(key) || !isAudienceValue(value) || !value.containers.includes(container)) continue;
    try {
      await flagsStore.update(key, (current) => nextFlagValue(key, current, { op: 'remove-account', container }, now), 'account deletion', now);
      dropped++;
    } catch (err) {
      // Taken off meanwhile, by the admin or a deletion run at the same time.
      if (err instanceof NoFlagChange) continue;
      if (err instanceof StoredDataUnreadableError) {
        console.error(`Flags: the stored value of ${key} can't be read, so an account's deletion left it as it is.`);
        continue;
      }
      throw err;
    }
  }
  return dropped;
}
