import { NextResponse } from 'next/server';
import { dataCtx, containerUnavailable } from '@/lib/data-ctx';
import { StoredDataUnreadableError, describeUnreadable } from '@/lib/repo';
import { dayIn, readZoneParams } from '@/lib/report/period';
import { readRunway } from '@/lib/report/runway-read';
import { loggable } from '@/lib/log-safe';

// The runway (lib/report/runway.ts): how long the person's cash would last at
// their recent spending, with and without their income, read in their time
// zone (tz, UTC when not given) for the report page (app/reports). It takes
// nothing else: the what-if is worked out on the page from what this answers,
// and is never sent here, so nothing of it can be stored. A scenario the
// person saves goes to app/api/runway-scenarios.
//
// From storage only, as a report reads (lib/report/runway-read.ts): it never
// calls Plaid and changes nothing, so no cache is cleared. Gated like the
// dashboard (proxy.ts).

export async function GET(req: Request) {
  const params = readZoneParams(new URL(req.url).searchParams, ['tz']);
  if ('error' in params) return NextResponse.json({ error: params.error }, { status: 400 });
  const now = Date.now();
  const today = dayIn(now, params.timeZone);
  if (!today) return NextResponse.json({ error: 'Today’s date couldn’t be read in that time zone.' }, { status: 400 });
  try {
    const ctx = await dataCtx(now);
    const runway = await readRunway(ctx, { today, timeZone: params.timeZone, now });
    return NextResponse.json({ runway }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (err) {
    const unavailable = containerUnavailable(err);
    if (unavailable) return unavailable;
    // Something it can't do without couldn't be read (the hidden accounts,
    // say): 409 and flagged, never a runway short of it.
    if (err instanceof StoredDataUnreadableError) {
      console.error('Runway: stored data unreadable:', describeUnreadable(err));
      return NextResponse.json({ error: err.message, unreadable: true }, { status: 409 });
    }
    console.error('Runway failed', loggable(err));
    return NextResponse.json({ error: 'Failed to work out the runway' }, { status: 500 });
  }
}
