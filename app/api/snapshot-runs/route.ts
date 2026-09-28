import { NextResponse } from 'next/server';
import { dataCtx, containerUnavailable } from '@/lib/data-ctx';
import { readRuns } from '@/lib/snapshot-job';

// The last 30 days of the daily snapshot's outcomes for the caller's container
// (lib/snapshot-job.ts), newest first. Behind the session gate.

export async function GET() {
  try {
    const ctx = await dataCtx();
    return NextResponse.json({ runs: await readRuns(ctx) });
  } catch (err) {
    const unavailable = containerUnavailable(err);
    if (unavailable) return unavailable;
    console.error('Snapshot runs read failed', err instanceof Error ? err.name : err);
    return NextResponse.json({ error: 'Could not read snapshot runs' }, { status: 500 });
  }
}
