import { NextResponse } from 'next/server';
import { containerUnavailable } from '@/lib/data-ctx';
import { adminCtx, notAdmin } from '@/lib/admin-items';
import { attachmentSweepProblem, backupNotice, cronHoldUntil, runNightlyBackup } from '@/lib/backup';
import { runNightlySweep } from '@/lib/attachment-sweep';

// The admin runs a nightly job again from Home's Admin card, after it failed:
// the backup (lib/backup.ts runNightlyBackup) or the clean-up of receipts and
// documents (lib/attachment-sweep.ts runNightlySweep), exactly as its cron
// does, outcome recorded the same way. Behind the normal session gate, and
// then admin-only: anyone else gets the same 404 as a route that does not
// exist.
//
//   POST { job: "backup" | "files" }
//
// Answers with what the dashboard now says of both jobs (backup_problem,
// attachments_problem, as /api/net-worth sends them), so the card and the
// Net worth card's line update without a reload; and, when the run failed,
// its reason in `error` (500).
//
// Not while the job's own cron may be running (lib/backup.ts cronHoldUntil):
// two runs at once would race over the same files and records. That answers
// 409 and says when to try again. The button is held while a run is going,
// so the card doesn't start a second one either.

// As the crons' own routes: a run takes up to their limit.
export const maxDuration = 300;

const JOBS = { backup: runNightlyBackup, files: runNightlySweep } as const;

export async function POST(req: Request) {
  try {
    const admin = await adminCtx();
    if (!admin) return notAdmin();
    const body = await req.json().catch(() => ({}));
    const job: unknown = body?.job;
    if (job !== 'backup' && job !== 'files') return NextResponse.json({ error: 'Unknown job' }, { status: 400 });
    const now = new Date();
    const until = await cronHoldUntil(job, now);
    if (until) {
      const minutes = Math.max(1, Math.ceil((until.getTime() - now.getTime()) / 60_000));
      return NextResponse.json({ error: `Its nightly run may still be going. Try again in ${minutes} ${minutes === 1 ? 'minute' : 'minutes'}.` }, { status: 409 });
    }
    const run = await JOBS[job](now);
    const [backup_problem, attachments_problem] = await Promise.all([backupNotice(), attachmentSweepProblem()]);
    const error = run.status === 200 ? {} : { error: typeof run.body.error === 'string' ? run.body.error : 'The run failed.' };
    return NextResponse.json({ ...error, backup_problem, attachments_problem }, { status: run.status });
  } catch (err) {
    const unavailable = containerUnavailable(err);
    if (unavailable) return unavailable;
    console.error('Running a nightly job failed', err instanceof Error ? err.name : typeof err);
    return NextResponse.json({ error: 'Running the job failed' }, { status: 500 });
  }
}
