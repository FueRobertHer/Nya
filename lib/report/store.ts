// lib/report/store.ts
//
// The person's report settings (lib/report/settings.ts): the categories they
// marked as mattering for taxes. One encrypted JSON value per container,
// replaced whole on every save: a value store on the storage seam
// (lib/repo.ts), since one person edits them at a time, from the report page.
//
// Reads are strict: settings that were saved but can't be used throw
// StoredDataUnreadableError, never "none marked", because the next save sends
// the whole list and would replace the real one with only the change. Never
// saved reads as null. A report reads them for display only and, when they
// can't be read, says so and leaves the group out (lib/report/read.ts); the
// seam refuses to save over them (app/api/report-settings).
//
// Reads take any settings any release saved: isReportSettings checks the shape
// and types, closed, not today's limits, which parseReportSettings checks when
// they are saved (in the route). Version 1 is the first shape, so there is
// nothing to upgrade yet: a later shape bumps `v` and gives this store an
// `upgrade`.

import { defineValueStore } from '../repo';
import { isReportSettings, type ReportSettings } from './settings';

export const reportSettingsStore = defineValueStore<ReportSettings>('report-settings', {
  what: 'report settings',
  isValid: isReportSettings,
  exportable: true, // what the person chose
});
