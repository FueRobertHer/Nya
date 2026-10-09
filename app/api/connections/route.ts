import { NextResponse } from 'next/server';
import { signedInCtx, containerUnavailable } from '@/lib/data-ctx';
import { myConnections, myRecords, removeConnection, saveConnection, shareableAccounts, SharingRefused } from '@/lib/sharing';

// My connections and what I share on each (lib/sharing.ts), with both
// records of showings on each (lib/access-log.ts): when what I share was
// shown to them, and when what they share was shown to me. Only with Clerk on:
// the shared password has one user and nobody to connect with.

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
    const [mine, accounts, records] = await Promise.all([myConnections(me.userId), shareableAccounts(me.ctx), myRecords(me.userId, me.ctx)]);
    // Each by what I call them, never by who they are: a record holds only
    // the connection's log id.
    const connections = mine.connections.map((c) => ({ ...c, ...records.connections.get(c.id) }));
    return NextResponse.json(
      { enabled: true, connections, blocked: mine.blocked, accounts, damaged_records: records.damaged },
      { headers: { 'Cache-Control': 'no-store' } }
    );
  }, 'read');
}

/** { id, label?, accounts?, expires_at? }: renames a connection (what I call
 *  them), replaces what I share on it ({ "<account id>": "exists" | "balance" |
 *  "transactions" | "none" }), and sets when that ends: an ISO time ahead, or
 *  null for no end. Whatever is left out stays as it is, and nothing is saved
 *  unless all of it can be. */
export async function PUT(req: Request) {
  return handle(async () => {
    const me = await signedInCtx();
    if (!me) return NextResponse.json({ error: 'Sharing needs accounts (Clerk).' }, { status: 400 });
    const body = await req.json().catch(() => null);
    const valid =
      body &&
      typeof body.id === 'string' &&
      (body.label !== undefined || body.accounts !== undefined || body.expires_at !== undefined) &&
      (body.accounts === undefined || (body.accounts && typeof body.accounts === 'object' && !Array.isArray(body.accounts))) &&
      (body.expires_at === undefined || body.expires_at === null || (typeof body.expires_at === 'string' && body.expires_at.length <= 40));
    if (!valid) return NextResponse.json({ error: 'Expected { id, label?, accounts?, expires_at? }' }, { status: 400 });
    // All of it or none: checked whole before anything is saved.
    await saveConnection(me.ctx, me.userId, body.id, { label: body.label, accounts: body.accounts, expires_at: body.expires_at });
    return NextResponse.json({ saved: true });
  }, 'save');
}

/** { id, block? }: removes a connection, ending every share both ways, and
 *  deleting both records of showings on it. With block, they can't connect
 *  with me again until I remove the block the same way. */
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
