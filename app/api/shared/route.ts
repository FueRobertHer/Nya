import { NextResponse } from 'next/server';
import { signedInCtx, containerUnavailable } from '@/lib/data-ctx';
import { sharedWithMe } from '@/lib/sharing';
import { displayNames } from '@/lib/people';

// What others share with me, read-only and already filtered to what they
// granted (lib/sharing.ts). Never cached: a revoke must take effect at once.

export async function GET() {
  try {
    const me = await signedInCtx();
    if (!me) return NextResponse.json({ shared: [] });
    const shared = await sharedWithMe(me.userId);
    const names = await displayNames(shared.map((s) => s.from));
    return NextResponse.json(
      { shared: shared.map((s) => ({ ...s, name: names[s.from] })) },
      { headers: { 'Cache-Control': 'no-store' } }
    );
  } catch (err) {
    const unavailable = containerUnavailable(err);
    if (unavailable) return unavailable;
    console.error('Shared read failed', err instanceof Error ? err.name : err);
    return NextResponse.json({ error: 'Could not read what is shared with you' }, { status: 500 });
  }
}
