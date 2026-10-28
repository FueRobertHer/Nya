import { NextResponse } from 'next/server';
import { containerUnavailable } from '@/lib/data-ctx';
import { adminCtx, notAdmin } from '@/lib/admin-items';
import { cronHoldUntil, nightlyJobs, runNightlyBackup } from '@/lib/backup';
import { runNightlySweep } from '@/lib/attachment-sweep';
import { manualRunCount } from '@/lib/nightly-run-limit';

// The admin's Nightly jobs page (/admin/jobs, app/admin-view/jobs): the
// backup (lib/backup.ts runNightlyBackup) and the clean-up of receipts and
// documents (lib/attachment-sweep.ts runNightlySweep), each as it last went,
// and a way to run one now. Behind the normal session gate, and then
// admin-only: anyone else gets the same 404 as a route that does not exist.
//
//   GET                              both jobs (lib/backup.ts nightlyJobs).
//   POST { job: "backup" | "files" } runs one exactly as its cron does,
//                                    outcome recorded the same way, then
//                                    answers as GET; when the run failed, its
//                                    reason in `error` (500).
//
// One run at a time, of either job: two at once would race over the same
// files and over the backups' record, which each reads and writes whole. So
// not while a nightly cron may be running (lib/backup.ts cronHoldUntil), nor
// within five minutes of another run started here (lib/nightly-run-limit.ts):
// either answers 409 and says when to try again.
//
// A demo account is never the admin (lib/admin-gate.ts), so none gets this
// far. The POST takes JSON only, so a form on another site can't send it.

// As the crons' own routes: a run takes up to their limit.
export const maxDuration = 300;

const JOBS = { backup: runNightlyBackup, files: runNightlySweep } as const;

async function fail(err: unknown): Promise<Response> {
  const unavailable = containerUnavailable(err);
  if (unavailable) return unavailable;
  console.error('Nightly jobs failed', err instanceof Error ? err.name : typeof err);
  return NextResponse.json({ error: 'Something went wrong' }, { status: 500 });
}

export async function GET() {
  try {
    if (!(await adminCtx())) return notAdmin();
    return NextResponse.json({ jobs: await nightlyJobs() });
  } catch (err) {
    return fail(err);
  }
}

const tryIn = (ms: number) => {
  const minutes = Math.max(1, Math.ceil(ms / 60_000));
  return `Try again in ${minutes} ${minutes === 1 ? 'minute' : 'minutes'}.`;
};

export async function POST(req: Request) {
  try {
    const admin = await adminCtx();
    if (!admin) return notAdmin();
    if (!(req.headers.get('content-type') ?? '').startsWith('application/json')) return NextResponse.json({ error: 'Send JSON' }, { status: 415 });
    const body = await req.json().catch(() => ({}));
    const job: unknown = body?.job;
    if (job !== 'backup' && job !== 'files') return NextResponse.json({ error: 'Unknown job' }, { status: 400 });
    const now = new Date();
    const until = await cronHoldUntil(now);
    if (until) {
      return NextResponse.json({ error: `A nightly job may be running now. ${tryIn(until.getTime() - now.getTime())}`, jobs: await nightlyJobs() }, { status: 409 });
    }
    // Counted before it runs, so two clicks racing never both start one.
    const started = await manualRunCount.take(admin);
    if (started.count > 1) {
      return NextResponse.json({ error: `A run started here may still be going. ${tryIn(started.secondsLeft * 1000)}`, jobs: await nightlyJobs() }, { status: 409 });
    }
    const run = await JOBS[job](now);
    const error = run.status === 200 ? {} : { error: typeof run.body.error === 'string' ? run.body.error : 'The run failed.' };
    return NextResponse.json({ ...error, jobs: await nightlyJobs() }, { status: run.status });
  } catch (err) {
    return fail(err);
  }
}
