import { NextResponse } from 'next/server';
import { ContainerError, resolveCtx } from '@/lib/containers';
import { readRuns } from '@/lib/snapshot-job';

// The last 30 days of the daily snapshot's outcomes for this deployment's
// container (lib/snapshot-job.ts), newest first. Behind the session gate.

export async function GET() {
  try {
    return NextResponse.json({ runs: await readRuns(await resolveCtx()) });
  } catch (err) {
    if (err instanceof ContainerError) return NextResponse.json({ error: err.message }, { status: 503 });
    console.error('Snapshot runs read failed', err instanceof Error ? err.name : err);
    return NextResponse.json({ error: 'Could not read snapshot runs' }, { status: 500 });
  }
}
