import { NextResponse } from 'next/server';
import { secretsMatch } from '@/lib/auth';
import { recordOutcome, runNightlyBackup } from '@/lib/backup';
import { runAsCron } from '@/lib/nightly-run-limit';

// Nightly off-site backup (lib/backup.ts), hit by Vercel Cron (vercel.json)
// after the snapshot and its catch-up, so the day's point is in it and the
// export doesn't run while the snapshot writes. Vercel runs crons only on the
// production deployment.
//
// Authenticated like /api/snapshot: Vercel sends `Authorization: Bearer
// ${CRON_SECRET}`; without it the route always 401s. Excluded from the
// session gate in proxy.ts.
//
// 500 on any failure, with the reason, so the cron shows red in Vercel; the
// outcome is recorded too, so the dashboard says when backups have stopped.
// Values are never logged: only the reason and the backup's name and size.
//
// First, every container whose key was destroyed by a deletion the day before
// is swept once more (lib/account-deletion.ts sweepDestroyedContainers), so a
// late write is never in tonight's archive. Best effort: a failure there is
// logged, and the backup goes on.
//
// The run itself is lib/backup.ts runNightlyBackup, which the admin can also
// start from the app (app/api/admin/jobs). Either way it runs under the one
// run lock (lib/nightly-run-limit.ts): a run already going is waited for, its
// wait taken off the time a failed backup has to be tried again in, and one
// that is still going after that fails tonight's backup, recorded.

export const maxDuration = 300;

export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret || !(await secretsMatch(req.headers.get('authorization') ?? '', `Bearer ${secret}`))) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const { status, body } = await runAsCron(
    'backup',
    (waited, log) => runNightlyBackup(new Date(), { waitedMs: waited, log }),
    (reason) => recordOutcome({ ok: false, reason })
  );
  return NextResponse.json(body, { status });
}
