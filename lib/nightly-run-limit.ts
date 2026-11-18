// lib/nightly-run-limit.ts
//
// One nightly job at a time, whoever starts it: the backup and the clean-up of
// receipts and documents, from their crons (app/api/backup,
// app/api/attachments/sweep) or from the admin's Run now (app/api/admin/jobs).
// Two at once would race over the backups' record (lib/backup.ts
// recordOutcome and recordAttachmentSweep each read it and write it whole), so
// one outcome could be lost, and two runs of one job would work over the same
// files.
//
// Every run holds the run lock (lib/backup.ts takeRunLock, beside the backups'
// record) and lets it go when it ends, whether it worked or failed. So Run now
// waits only while a run is actually going, never on the clock: a run that
// failed in a minute can be run again at once.
//
// A cron that finds a run going waits for it (CRON_WAIT_MS: a run takes
// seconds), then fails and records why rather than skip in silence, so the
// dashboard and the Nightly jobs page say so, and Run now runs it.

import { takeRunLock, type NightlyJob, type RunAnswer, type RunHolder } from './backup';

/** How long a cron waits for a run already going. A run takes seconds, and
 *  the backup's step limits (240 s), this wait and recording its outcome
 *  (15 s) still fit inside maxDuration. */
export const CRON_WAIT_MS = 30_000;

const JOB_NAMES: Record<NightlyJob, string> = { backup: 'the nightly backup', files: 'the clean-up of receipts and documents' };

/** Which run is going, in words: "the nightly backup (started by its cron)". */
export function runWords(holder: RunHolder | null): string {
  if (!holder) return 'another nightly job';
  return `${JOB_NAMES[holder.job]} (started ${holder.by === 'cron' ? 'by its cron' : 'from the Nightly jobs page'})`;
}

/**
 * A cron's run (app/api/backup, app/api/attachments/sweep): under the run lock,
 * after waiting up to `waitMs` for a run already going. `run` is told how long
 * that wait took, so a run with a time budget can take it off. When the lock
 * stays held, `recordBusy` records why, and the cron answers 500 with it, so it
 * shows red in Vercel too.
 */
export async function runAsCron(
  job: NightlyJob,
  run: (waitedMs: number) => Promise<RunAnswer>,
  recordBusy: (reason: string) => Promise<void>,
  waitMs = CRON_WAIT_MS
): Promise<RunAnswer> {
  const started = Date.now();
  const taken = await takeRunLock(job, 'cron', waitMs);
  if ('busy' in taken) {
    const reason = `Not run: ${runWords(taken.busy)} was still going after ${Math.round(waitMs / 1000)}s. Run it again from the Nightly jobs page.`;
    console.error(`Nightly ${job} not run`, reason);
    await recordBusy(reason);
    return { status: 500, body: { error: reason } };
  }
  try {
    return await run(Date.now() - started);
  } finally {
    await taken.lock.release();
  }
}
