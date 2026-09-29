import { NextResponse } from 'next/server';
import { signedInCtx, containerUnavailable } from '@/lib/data-ctx';
import { myConnections, removeConnection, renameConnection, setShare, shareableAccounts, SharingRefused } from '@/lib/sharing';

// My connections and what I share on each (lib/sharing.ts). Only with Clerk
// on: the shared password has one user and nobody to connect with.

async function handle(fn: () => Promise<NextResponse>, what: string): Promise<NextResponse> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof SharingRefused) return NextResponse.json({ error: err.message }, { status: 409 });
    const unavailable = containerUnavailable(err);
    if (unavailable) return unavailable;
    console.error(`Connections ${what} failed`, err instanceof Error ? err.name : err);
    return NextResponse.json({ error: `Could not ${what} connections` }, { status: 500 });
  }
}

export async function GET() {
  return handle(async () => {
    const me = await signedInCtx();
    if (!me) return NextResponse.json({ enabled: false });
    const [mine, accounts] = await Promise.all([myConnections(me.userId), shareableAccounts(me.ctx)]);
    return NextResponse.json({ enabled: true, ...mine, accounts }, { headers: { 'Cache-Control': 'no-store' } });
  }, 'read');
}

/** { id, label?, accounts? }: renames a connection (what I call them) and/or
 *  replaces what I share on it: { "<account id>": "exists" | "balance" | "transactions" | "none" }. */
export async function PUT(req: Request) {
  return handle(async () => {
    const me = await signedInCtx();
    if (!me) return NextResponse.json({ error: 'Sharing needs accounts (Clerk).' }, { status: 400 });
    const body = await req.json().catch(() => null);
    const valid =
      body && typeof body.id === 'string' && (body.label !== undefined || body.accounts !== undefined) && (body.accounts === undefined || (body.accounts && typeof body.accounts === 'object'));
    if (!valid) return NextResponse.json({ error: 'Expected { id, label?, accounts? }' }, { status: 400 });
    if (body.label !== undefined) await renameConnection(me.userId, body.id, body.label);
    if (body.accounts !== undefined) await setShare(me.ctx, me.userId, body.id, body.accounts);
    return NextResponse.json({ saved: true });
  }, 'save');
}

/** { id, block? }: removes a connection, ending every share both ways. With
 *  block, they can't connect with me again until I remove the block the same way. */
export async function DELETE(req: Request) {
  return handle(async () => {
    const me = await signedInCtx();
    if (!me) return NextResponse.json({ error: 'Sharing needs accounts (Clerk).' }, { status: 400 });
    const body = await req.json().catch(() => null);
    if (!body || typeof body.id !== 'string') return NextResponse.json({ error: 'Expected { id, block? }' }, { status: 400 });
    await removeConnection(me.userId, body.id, { block: body.block === true });
    return NextResponse.json({ removed: true });
  }, 'remove');
}
