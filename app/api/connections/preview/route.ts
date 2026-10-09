import { NextResponse } from 'next/server';
import { signedInCtx, containerUnavailable } from '@/lib/data-ctx';
import { previewShare, SharingRefused } from '@/lib/sharing';

// "What they see": exactly what the other person on one of my connections is
// shown of mine right now, from the same projection their own read gets
// (lib/sharing.ts previewShare). Read-only, and it records nothing in my
// access log. Never cached: a change I just saved must show at once.

/** ?id=<connection id> → { connection, view: { accounts, expires_at } | null, unreadable? } */
export async function GET(req: Request) {
  try {
    const me = await signedInCtx();
    if (!me) return NextResponse.json({ error: 'Sharing needs accounts (Clerk).' }, { status: 400 });
    const id = new URL(req.url).searchParams.get('id');
    if (!id || !/^[0-9a-f]{24}$/.test(id)) return NextResponse.json({ error: 'Expected ?id=<connection id>' }, { status: 400 });
    return NextResponse.json(await previewShare(me.userId, id), { headers: { 'Cache-Control': 'no-store' } });
  } catch (err) {
    if (err instanceof SharingRefused) return NextResponse.json({ error: err.message }, { status: 409 });
    const unavailable = containerUnavailable(err);
    if (unavailable) return unavailable;
    console.error('Preview failed', err instanceof Error ? err.name : err);
    return NextResponse.json({ error: 'Could not show what they see' }, { status: 500 });
  }
}
