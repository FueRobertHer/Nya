import { NextResponse } from 'next/server';
import { signedInCtx, containerUnavailable } from '@/lib/data-ctx';
import { acceptInvite, AlreadyConnected, SharingRefused } from '@/lib/sharing';

/** What the invite page shows when accepting fails for a reason of Nya's own.
 *  The same words whatever failed: the sender's side can fail here too, and
 *  only for a real link. */
const FAILED = 'Nya couldn’t connect you just now. Try again in a few minutes.';

/** { token, label, my_name? } → { id }: uses an invite link and connects me
 *  with its sender. `label` is what I'll call them, `my_name` how I introduce
 *  myself to them. A refusal is a 409 with its words (`connected` when we
 *  already are, which isn't a failure). */
export async function POST(req: Request) {
  let me: Awaited<ReturnType<typeof signedInCtx>>;
  try {
    me = await signedInCtx();
  } catch (err) {
    // My own data out of reach (a restore running, its key missing): said in
    // its own words, which are about me.
    return containerUnavailable(err) ?? failed(err);
  }
  if (!me) return NextResponse.json({ error: 'Sharing needs accounts (Clerk).' }, { status: 400 });
  const body = await req.json().catch(() => null);
  if (!body || typeof body.token !== 'string') return NextResponse.json({ error: 'Expected { token, label }' }, { status: 400 });
  try {
    return NextResponse.json(await acceptInvite(me.userId, body.token, body.label, body.my_name));
  } catch (err) {
    if (err instanceof AlreadyConnected) return NextResponse.json({ error: err.message, connected: true }, { status: 409 });
    if (err instanceof SharingRefused) return NextResponse.json({ error: err.message }, { status: 409 });
    // Not containerUnavailable: past this point a container error is the
    // sender's (their registry entry unreadable), and its words would name
    // their container to whoever holds the link.
    return failed(err);
  }
}

function failed(err: unknown) {
  console.error('Accepting an invite failed', err instanceof Error ? err.name : err);
  return NextResponse.json({ error: FAILED }, { status: 500 });
}
