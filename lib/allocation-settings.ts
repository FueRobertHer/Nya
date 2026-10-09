// lib/allocation-settings.ts
//
// The person's allocation settings (lib/allocation/settings.ts): the tax
// bucket they set for an account, the split they set for a fund or for an
// account's unlisted money, and their target allocation. One encrypted JSON
// value per container, replaced whole on every save: a value store on the
// storage seam (lib/repo.ts), since one person edits them at a time, from
// the Plan tab.
//
// Reads are strict: settings that were saved but can't be used throw
// StoredDataUnreadableError, never "no settings", because the next save
// sends all of them and would replace the real ones with only the change.
// Never saved reads as null, which the tab shows as no choices made.
//
// Reads take any settings any release saved: isAllocationSettings checks the
// shape and types, closed (a field a later release adds is not dropped by
// this one's saves; it reads as unrecognised instead), not today's formats,
// sums and limits, which parseSettings checks when they are saved (in the
// route). Version 1 is the first shape, so there is nothing to upgrade yet:
// a later shape bumps `v` and gives this store an `upgrade`.

import { defineValueStore } from './repo';
import { isAllocationSettings, type AllocationSettings } from './allocation/settings';

export const allocationSettingsStore = defineValueStore<AllocationSettings>('allocation-settings', {
  what: 'allocation settings',
  isValid: isAllocationSettings,
  exportable: true, // what the person chose
});
