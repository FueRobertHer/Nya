import { NextResponse } from 'next/server';
import { containerUnavailable } from '@/lib/data-ctx';
import { adminCtx, notAdmin } from '@/lib/admin-items';
import { nightlyJobs, runNightlyBackup, takeRunLock } from '@/lib/backup';
import { runNightlySweep } from '@/lib/attachment-sweep';
import { runWords } from '@/lib/nightly-run-limit';

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
// One run at a time, of either job, whoever started it: a run takes the run
// lock its cron takes too (lib/nightly-run-limit.ts, lib/backup.ts
// takeRunLock), so while another run is
// going this answers 409, naming it. Never by the clock: once a run ends, it
// worked or failed, the next can start. A job that just worked waits a few
// minutes before it runs again (lib/backup.ts againAt), so a second click
// doesn't repeat it; one that failed can be run again at once.
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

const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

export async function POST(req: Request) {
  try {
    const admin = await adminCtx();
    if (!admin) return notAdmin();
    if (!(req.headers.get('content-type') ?? '').startsWith('application/json')) return NextResponse.json({ error: 'Send JSON' }, { status: 415 });
    const body = await req.json().catch(() => ({}));
    const job: unknown = body?.job;
    if (job !== 'backup' && job !== 'files') return NextResponse.json({ error: 'Unknown job' }, { status: 400 });
    // Taken before anything else, so two clicks racing never both start one,
    // and what decides whether to run is read with no other run going.
    const taken = await takeRunLock(job, 'hand');
    if ('busy' in taken) {
      return NextResponse.json({ error: `${capital(runWords(taken.busy))} is running now. Try again once it finishes.`, jobs: await nightlyJobs() }, { status: 409 });
    }
    let answer: { status: number; error?: string };
    try {
      const now = new Date();
      const again = (await nightlyJobs(now)).find((v) => v.job === job)?.again_at;
      if (again) {
        answer = { status: 409, error: `It worked a few minutes ago. ${tryIn(Date.parse(again) - now.getTime())}` };
      } else {
        const run = await JOBS[job](now);
        answer = run.status === 200 ? { status: 200 } : { status: run.status, error: typeof run.body.error === 'string' ? run.body.error : 'The run failed.' };
      }
    } finally {
      await taken.lock.release();
    }
    // Read once the lock is released, so the page shows nothing running.
    return NextResponse.json({ ...(answer.error !== undefined ? { error: answer.error } : {}), jobs: await nightlyJobs() }, { status: answer.status });
  } catch (err) {
    return fail(err);
  }
}
