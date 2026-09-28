import { NextResponse } from 'next/server';
import { signedInCtx, containerUnavailable } from '@/lib/data-ctx';
import { acceptInvite, SharingRefused } from '@/lib/sharing';

/** { token, label } → { id }: uses an invite link and connects me with its
 *  sender. `label` is what I'll call them. */
export async function POST(req: Request) {
  try {
    const me = await signedInCtx();
    if (!me) return NextResponse.json({ error: 'Sharing needs accounts (Clerk).' }, { status: 400 });
    const body = await req.json().catch(() => null);
    if (!body || typeof body.token !== 'string') return NextResponse.json({ error: 'Expected { token, label }' }, { status: 400 });
    return NextResponse.json(await acceptInvite(me.userId, body.token, body.label));
  } catch (err) {
    if (err instanceof SharingRefused) return NextResponse.json({ error: err.message }, { status: 409 });
    const unavailable = containerUnavailable(err);
    if (unavailable) return unavailable;
    console.error('Accepting an invite failed', err instanceof Error ? err.name : err);
    return NextResponse.json({ error: 'Could not accept the invite' }, { status: 500 });
  }
}
