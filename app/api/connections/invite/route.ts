import { NextResponse } from 'next/server';
import { signedInCtx, containerUnavailable } from '@/lib/data-ctx';
import { createInvite } from '@/lib/sharing';

// A new invite link (lib/sharing.ts): single use, short-lived. Whoever opens
// it and accepts is connected with me; nothing is shared until I choose.

/** { from_name?, their_label? } → { url, expires_at } */
export async function POST(req: Request) {
  try {
    const me = await signedInCtx();
    if (!me) return NextResponse.json({ error: 'Sharing needs accounts (Clerk).' }, { status: 400 });
    const body = (await req.json().catch(() => null)) ?? {};
    const { token, expires_at } = await createInvite(me.userId, { fromName: body.from_name, theirLabel: body.their_label });
    const url = `${new URL(req.url).origin}/connect/${token}`;
    return NextResponse.json({ url, expires_at }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (err) {
    const unavailable = containerUnavailable(err);
    if (unavailable) return unavailable;
    console.error('Invite failed', err instanceof Error ? err.name : err);
    return NextResponse.json({ error: 'Could not make an invite link' }, { status: 500 });
  }
}
