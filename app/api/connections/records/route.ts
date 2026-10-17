import { NextResponse } from 'next/server';
import { signedInCtx, containerUnavailable } from '@/lib/data-ctx';
import { connectionRecords, SharingRefused } from '@/lib/sharing';
import { timeZoneOf } from '@/lib/access-log';

// Both records of showings on one of my connections (lib/sharing.ts
// connectionRecords), for the drawer, when I open that connection: as days in
// my own time zone, the newest few, or all of them with all=1, never the
// records' rows, so the answer stays small however much a record holds. Its
// own request, apart from the connection list, so no record can stand
// between me and Remove or Block. Never cached: a showing counted just now
// shows at once.

/** ?id=<connection id>&tz=<IANA time zone>[&all=1] → { connection, record_id, record_since, shown_to_them, shown_to_me } */
export async function GET(req: Request) {
  try {
    const me = await signedInCtx();
    if (!me) return NextResponse.json({ error: 'Sharing needs accounts (Clerk).' }, { status: 400 });
    const params = new URL(req.url).searchParams;
    const id = params.get('id');
    const timeZone = timeZoneOf(params.get('tz'));
    if (!id || !/^[0-9a-f]{24}$/.test(id) || !timeZone) {
      return NextResponse.json({ error: 'Expected ?id=<connection id>&tz=<time zone>' }, { status: 400 });
    }
    const records = await connectionRecords(me.userId, me.ctx, id, { timeZone, all: params.get('all') === '1' });
    return NextResponse.json(records, { headers: { 'Cache-Control': 'no-store' } });
  } catch (err) {
    if (err instanceof SharingRefused) return NextResponse.json({ error: err.message }, { status: 409 });
    const unavailable = containerUnavailable(err);
    if (unavailable) return unavailable;
    console.error('Reading records of showings failed', err instanceof Error ? err.name : err);
    return NextResponse.json({ error: 'Could not read the records' }, { status: 500 });
  }
}
