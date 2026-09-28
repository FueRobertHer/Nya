import { NextResponse } from 'next/server';
import { signedInCtx, containerUnavailable } from '@/lib/data-ctx';
import { outgoing, people, setGrant, shareableAccounts, SharingRefused } from '@/lib/sharing';
import { displayNames } from '@/lib/people';

// What I share and with whom (lib/sharing.ts). Only with Clerk on: the shared
// password has one user and nobody to share with.

export async function GET() {
  try {
    const me = await signedInCtx();
    if (!me) return NextResponse.json({ enabled: false });
    const [others, mine, out] = await Promise.all([people(me.userId), shareableAccounts(me.ctx), outgoing(me.userId)]);
    const names = await displayNames(others);
    return NextResponse.json({
      enabled: true,
      people: others.map((id) => ({ id, name: names[id] })),
      accounts: mine,
      sharing: out,
    });
  } catch (err) {
    const unavailable = containerUnavailable(err);
    if (unavailable) return unavailable;
    console.error('Sharing read failed', err instanceof Error ? err.name : err);
    return NextResponse.json({ error: 'Could not read sharing' }, { status: 500 });
  }
}

/** { to: "<user id>", accounts: { "<account id>": "balance" | "transactions" | "none" } }
 *  Replaces what I share with that person. */
export async function PUT(req: Request) {
  try {
    const me = await signedInCtx();
    if (!me) return NextResponse.json({ error: 'Sharing needs accounts (Clerk).' }, { status: 400 });
    const body = await req.json().catch(() => null);
    if (!body || typeof body.to !== 'string' || !body.accounts || typeof body.accounts !== 'object') {
      return NextResponse.json({ error: 'Expected { to, accounts }' }, { status: 400 });
    }
    await setGrant(me.ctx, me.userId, body.to, body.accounts);
    return NextResponse.json({ saved: true });
  } catch (err) {
    if (err instanceof SharingRefused) return NextResponse.json({ error: err.message }, { status: 409 });
    const unavailable = containerUnavailable(err);
    if (unavailable) return unavailable;
    console.error('Sharing write failed', err instanceof Error ? err.name : err);
    return NextResponse.json({ error: 'Could not save sharing' }, { status: 500 });
  }
}
