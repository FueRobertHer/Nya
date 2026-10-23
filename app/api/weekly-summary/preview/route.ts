import { NextResponse } from 'next/server';
import { dataCtx } from '@/lib/data-ctx';
import { storeFailure } from '@/lib/store-failure';
import { canonicalTimeZone } from '@/lib/report/period';
import type { Weekday } from '@/lib/weekly-summary/settings';
import { previewWeekly } from '@/lib/weekly-summary/send-now';

// The weekly summary as it would go out this week (lib/weekly-summary/
// send-now.ts previewWeekly), for the Weekly summary card's sheet: the same
// text the daily job would send, for the day and time zone the sheet shows,
// saved or not.
//
//   GET ?weekday=0..6&time_zone=<IANA>  { send_day, first, last, subject, text }
//
// Read only, from what is stored: nothing is written, Plaid is never called,
// and what can't be read is left out of the text and said there, as the
// email says it. Behind the session gate.

export async function GET(req: Request) {
  const q = new URL(req.url).searchParams;
  const weekday = q.get('weekday') ?? '';
  const zone = canonicalTimeZone(q.get('time_zone'));
  if (!/^[0-6]$/.test(weekday)) return NextResponse.json({ error: 'weekday must be a whole number from 0 (Sunday) to 6 (Saturday).' }, { status: 400 });
  if (!zone) return NextResponse.json({ error: 'time_zone must be a time zone such as America/New_York.' }, { status: 400 });
  try {
    const ctx = await dataCtx();
    return NextResponse.json(await previewWeekly(ctx, { weekday: Number(weekday) as Weekday, time_zone: zone }), { headers: { 'Cache-Control': 'no-store' } });
  } catch (err) {
    return storeFailure(err, 'Could not work out the weekly summary.');
  }
}
