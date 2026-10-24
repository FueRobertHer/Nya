// lib/nightly-run-limit.ts
//
// Runs of the nightly jobs the admin starts by hand (app/api/admin/jobs): one
// at a time, of either job. Two at once would race over the backups' record
// (lib/backup.ts recordOutcome and recordAttachmentSweep each read it and
// write it whole) and the clean-up's own notes, so one outcome could be lost.
// A run takes up to the route's maxDuration of 300 s, so a window longer
// than that, counted in the admin's container, lets one start and refuses the
// next until it has surely ended (the privacy page says how long it counts). A counter store on the seam: a
// plain count, never in the download.

import { defineCounterStore } from './repo';

/** Past the route's maxDuration of 300 s. */
export const MANUAL_RUN_WINDOW_SECONDS = 6 * 60;

export const manualRunCount = defineCounterStore('nightly-job-runs', { what: 'nightly jobs run by hand', windowSeconds: MANUAL_RUN_WINDOW_SECONDS });
