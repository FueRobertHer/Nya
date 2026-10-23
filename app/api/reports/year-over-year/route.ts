import { NextResponse } from 'next/server';
import { dataCtx, containerUnavailable } from '@/lib/data-ctx';
import { StoredDataUnreadableError, describeUnreadable } from '@/lib/repo';
import { dayIn, readZoneParams } from '@/lib/report/period';
import { readYearOverYear } from '@/lib/report/year-over-year-read';
import { loggable } from '@/lib/log-safe';

// Year over year (lib/report/year-over-year.ts): this year so far against the
// same days of last year, read in the person's time zone (tz, UTC when not
// given), in one currency (currency, else the one most of the two years'
// transactions are in), for the report page (app/reports). Every parameter is
// checked before anything is read.
//
// From storage only, as a report reads (lib/report/year-over-year-read.ts):
// it never calls Plaid and changes nothing, so no cache is cleared. Gated
// like the dashboard (proxy.ts).

export async function GET(req: Request) {
  const params = readZoneParams(new URL(req.url).searchParams, ['tz', 'currency']);
  if ('error' in params) return NextResponse.json({ error: params.error }, { status: 400 });
  const now = Date.now();
  const today = dayIn(now, params.timeZone);
  if (!today) return NextResponse.json({ error: 'Today’s date couldn’t be read in that time zone.' }, { status: 400 });
  try {
    const ctx = await dataCtx(now);
    const report = await readYearOverYear(ctx, { today, timeZone: params.timeZone, currency: params.currency, now });
    return NextResponse.json({ report }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (err) {
    const unavailable = containerUnavailable(err);
    if (unavailable) return unavailable;
    if (err instanceof StoredDataUnreadableError) {
      console.error('Year over year: stored data unreadable:', describeUnreadable(err));
      return NextResponse.json({ error: err.message, unreadable: true }, { status: 409 });
    }
    console.error('Year over year failed', loggable(err));
    return NextResponse.json({ error: 'Failed to compare the years' }, { status: 500 });
  }
}
