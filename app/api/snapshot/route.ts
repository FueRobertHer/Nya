import { NextResponse } from 'next/server';
import { secretsMatch } from '@/lib/auth';
import { finishMasterRotation } from '@/lib/crypto';
import { nothingSucceeded, readRegistry, runSnapshots, snapshotDate } from '@/lib/snapshot-job';

// Daily snapshot endpoint, hit by Vercel Cron (see vercel.json) so the
// net-worth chart stays gapless even on days the app isn't opened. It runs
// each container on its own (lib/snapshot-job.ts): the answer is 200 with a
// result per container, even when some failed, because a 500 invites a retry
// of the whole run. It answers 500 when nothing was snapshotted: the registry
// could not be read, holds no container, or every container that ran failed
// (the same body, so the cause is in the logs and the response alike). The
// catch-up cron (/api/snapshot/catchup, two hours later) runs the same job:
// containers already recorded that day are skipped.
//
// This route is excluded from the session gate in proxy.ts and instead
// authenticates the cron caller: Vercel sends `Authorization: Bearer
// ${CRON_SECRET}` automatically when a CRON_SECRET env var is set on the
// project. Without a valid secret the route always 401s.

export const maxDuration = 300;

export async function GET(req: Request) {
  const startedAt = Date.now();
  const secret = process.env.CRON_SECRET;
  if (!secret || !(await secretsMatch(req.headers.get('authorization') ?? '', `Bearer ${secret}`))) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // Finish a master key rotation if this deployment is the one it was
  // rotating to (lib/crypto.ts). Also happens on first use of a data key;
  // this makes sure it happens within a day even if none is used. Best
  // effort: a failure here must not cost the day's snapshot.
  await finishMasterRotation().catch((err) => console.error('Master rotation finish failed', err instanceof Error ? err.message : err));

  let registry;
  try {
    registry = await readRegistry();
  } catch (err) {
    console.error('Snapshot: the registry could not be read; nothing was snapshotted.', err instanceof Error ? err.message : err);
    return NextResponse.json({ error: 'The container registry could not be read; nothing was snapshotted.' }, { status: 500 });
  }

  if (registry.length === 0) {
    // Nobody can log in without one either (lib/sessions.ts), so this is a
    // setup that was never finished, not a quiet day.
    const error = 'No container exists yet, so nothing was snapshotted. Create one (see "Containers" in the README).';
    console.error(`Snapshot: ${error}`);
    return NextResponse.json({ error }, { status: 500 });
  }

  try {
    const report = await runSnapshots(registry, { scheduledFor: snapshotDate(startedAt), startedAt });
    return NextResponse.json(report, { status: nothingSucceeded(report) ? 500 : 200 });
  } catch (err) {
    // runSnapshots reports each container's failure itself; this is a bug.
    console.error('Snapshot run failed', err);
    return NextResponse.json({ error: 'Snapshot failed' }, { status: 500 });
  }
}
