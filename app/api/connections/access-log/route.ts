import { NextResponse } from 'next/server';
import { signedInCtx, containerUnavailable } from '@/lib/data-ctx';
import { clearUnreadableAccessLog } from '@/lib/access-log';

// One of my records of showings (lib/access-log.ts), cleared when it can't be
// read: while it can't be, showings on its connection go unrecorded. Only a
// damaged record is ever cleared, and only after I confirm
// (components/Sharing.tsx), whether or not its connection is still there; one
// that reads, or that this version doesn't recognise, is left as it is.

/** { id } (the record's log id) → { cleared: true }, or 409 with nothing changed. */
export async function DELETE(req: Request) {
  try {
    const me = await signedInCtx();
    if (!me) return NextResponse.json({ error: 'Sharing needs accounts (Clerk).' }, { status: 400 });
    const body = await req.json().catch(() => null);
    if (!body || typeof body.id !== 'string' || !/^[0-9a-f]{32}$/.test(body.id)) {
      return NextResponse.json({ error: 'Expected { id }' }, { status: 400 });
    }
    if (!(await clearUnreadableAccessLog(me.ctx, body.id))) {
      return NextResponse.json({ error: 'That record isn’t damaged, so it was left as it is.' }, { status: 409 });
    }
    return NextResponse.json({ cleared: true });
  } catch (err) {
    const unavailable = containerUnavailable(err);
    if (unavailable) return unavailable;
    console.error('Clearing an access log failed', err instanceof Error ? err.name : err);
    return NextResponse.json({ error: 'Could not clear the record' }, { status: 500 });
  }
}
