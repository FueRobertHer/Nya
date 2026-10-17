import { NextResponse } from 'next/server';
import { signedInCtx, containerUnavailable } from '@/lib/data-ctx';
import { sharedWithMe } from '@/lib/sharing';

// What my connections share with me, read-only and already filtered to what
// they chose (lib/sharing.ts). Never cached: a revoke must take effect at once.
// Each share it returns is counted as shown in its sharer's record, which both
// of us see (lib/sharing.ts recordShowing), so the app asks for it only when
// that part of the Accounts tab is on screen (components/Sharing.tsx).

export async function GET() {
  try {
    const me = await signedInCtx();
    if (!me) return NextResponse.json({ shared: [] });
    return NextResponse.json({ shared: await sharedWithMe(me.userId) }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (err) {
    const unavailable = containerUnavailable(err);
    if (unavailable) return unavailable;
    console.error('Shared read failed', err instanceof Error ? err.name : err);
    return NextResponse.json({ error: 'Could not read what is shared with you' }, { status: 500 });
  }
}
