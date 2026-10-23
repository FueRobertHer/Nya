import { NextResponse } from 'next/server';
import { dataCtx } from '@/lib/data-ctx';
import { storeFailure } from '@/lib/store-failure';
import { canonicalTimeZone } from '@/lib/report/period';
import { isWeekday } from '@/lib/weekly-summary/settings';
import { sendNow } from '@/lib/weekly-summary/send-now';
import { SENDS_NOW_PER_DAY } from '@/lib/weekly-summary/store';

// "Send me one now" (lib/weekly-summary/send-now.ts sendNow): this week's
// summary, as the preview shows it, emailed now to whom the daily job writes
// to, at most SENDS_NOW_PER_DAY a day. Behind the session gate.
//
//   POST { weekday, time_zone }  { sent: true, send_day }
//     409 { error }  this copy of Nya can't send one, or there is nobody to
//                    send it to (a demo account, an address not verified)
//     429 { error }  the day's sends are used up; Retry-After says when
//     502 { error }  the email service didn't take it

export async function POST(req: Request) {
  const body = (await req.json().catch(() => undefined)) as Record<string, unknown> | undefined;
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some((k) => k !== 'weekday' && k !== 'time_zone')) {
    return NextResponse.json({ error: 'Send { weekday, time_zone }.' }, { status: 400 });
  }
  const zone = canonicalTimeZone(body.time_zone);
  if (!isWeekday(body.weekday)) return NextResponse.json({ error: 'weekday must be a whole number from 0 (Sunday) to 6 (Saturday).' }, { status: 400 });
  if (!zone) return NextResponse.json({ error: 'time_zone must be a time zone such as America/New_York.' }, { status: 400 });
  try {
    const ctx = await dataCtx();
    const result = await sendNow(ctx, { weekday: body.weekday, time_zone: zone });
    switch (result.kind) {
      case 'sent':
        return NextResponse.json({ sent: true, send_day: result.send_day });
      case 'unable':
        return NextResponse.json({ error: result.why }, { status: 409 });
      case 'no-recipient':
        return NextResponse.json({ error: 'Nobody to send it to: your sign-in’s email address isn’t verified, or this account is never emailed.' }, { status: 409 });
      case 'limited':
        return NextResponse.json(
          { error: `You can send yourself ${SENDS_NOW_PER_DAY} a day. Try again tomorrow.` },
          { status: 429, headers: { 'Retry-After': String(result.retryAfterSeconds) } }
        );
      case 'failed':
        return NextResponse.json({ error: 'The email service didn’t take it. Try again in a minute.' }, { status: 502 });
    }
  } catch (err) {
    return storeFailure(err, 'Could not send the weekly summary.');
  }
}
