import { NextResponse } from 'next/server';
import { ContainerError } from '@/lib/containers';
import { deploymentContainer } from '@/lib/sessions';
import { readRuns } from '@/lib/snapshot-job';

// The last 30 days of the daily snapshot's outcomes for this deployment's
// container (lib/snapshot-job.ts), newest first: the container the job runs
// and sessions belong to, by the same rule. Behind the session gate.

export async function GET() {
  try {
    const dep = await deploymentContainer();
    if (dep.kind !== 'container') {
      return NextResponse.json({ error: dep.kind === 'none' ? 'No container exists yet.' : dep.reason }, { status: 503 });
    }
    return NextResponse.json({ runs: await readRuns({ container: dep.container }) });
  } catch (err) {
    if (err instanceof ContainerError) return NextResponse.json({ error: err.message }, { status: 503 });
    console.error('Snapshot runs read failed', err instanceof Error ? err.name : err);
    return NextResponse.json({ error: 'Could not read snapshot runs' }, { status: 500 });
  }
}
