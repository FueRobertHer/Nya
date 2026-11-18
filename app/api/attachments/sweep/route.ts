import { NextResponse } from 'next/server';
import { secretsMatch } from '@/lib/auth';
import { recordSweepFailed, runNightlySweep, SWEEP_BUDGET_MS } from '@/lib/attachment-sweep';
import { runAsCron } from '@/lib/nightly-run-limit';

// The nightly clean-up of receipts and documents (lib/attachment-sweep.ts),
// hit by Vercel Cron (vercel.json) after the backup and the day's other jobs.
// Vercel runs crons only on the production deployment.
//
// Authenticated like /api/backup: Vercel sends `Authorization: Bearer
// ${CRON_SECRET}`; without it the route always 401s. Excluded from the
// session gate in proxy.ts.
//
// 500 on a failure, with the reason, so the cron shows red in Vercel; the
// outcome is recorded too (lib/backup.ts recordAttachmentSweep), so the
// dashboard says when the sweep has failed, held back, or stopped. Logs carry
// counts and account ids, never a file's name or anything in it.
//
// The run itself is lib/attachment-sweep.ts runNightlySweep, which the admin
// can also start from the app (app/api/admin/jobs). Either way it runs under
// the one run lock (lib/nightly-run-limit.ts): a run already going is waited
// for, its wait taken off the sweep's time budget, and one that is still going
// after that fails tonight's sweep, recorded.

export const maxDuration = 300;

export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret || !(await secretsMatch(req.headers.get('authorization') ?? '', `Bearer ${secret}`))) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const { status, body } = await runAsCron(
    'files',
    (waited) => runNightlySweep(new Date(), { budgetMs: SWEEP_BUDGET_MS - waited }),
    (reason) => recordSweepFailed(reason)
  );
  return NextResponse.json(body, { status });
}
