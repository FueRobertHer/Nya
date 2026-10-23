import { NextResponse } from 'next/server';
import { signedInCtx } from '@/lib/data-ctx';
import { myConnections, removeConnection, saveConnection, shareableAccounts, SharingRefused, waitingAccounts } from '@/lib/sharing';
import { investmentAccountIds, shareableGoals } from '@/lib/share-views';
import { viewsChangeProblem } from '@/lib/share-kinds';
import { storeFailure } from '@/lib/store-failure';

// My connections and what I share on each (lib/sharing.ts). Only with Clerk
// on: the shared password has one user and nobody to connect with. No record
// of showings is read here, so none can stand between me and Remove or
// Block: the drawer asks for each connection's records on their own
// (connections/records), and for the damaged ones apart (connections/access-log).
// Nor can my goals: they are listed for the goals kind of share when they can
// be read, and otherwise the drawer says they can't be.

async function handle(fn: () => Promise<NextResponse>, what: string): Promise<NextResponse> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof SharingRefused) return NextResponse.json({ error: err.message }, { status: 409 });
    // The storage seam's answers (lib/store-failure.ts): no container 503,
    // stored data that can't be read 409 (flagged), a refused write its own.
    return storeFailure(err, `Could not ${what} connections`);
  }
}

export async function GET() {
  return handle(async () => {
    const me = await signedInCtx();
    if (!me) return NextResponse.json({ enabled: false });
    const [mine, shareable, waiting] = await Promise.all([myConnections(me.userId), shareableAccounts(me.ctx), waitingAccounts(me.ctx)]);
    // A shared account that is only waiting for its balance is listed too,
    // marked, so its share can be ended (lib/sharing.ts saveConnection).
    const shared = waiting.filter((w) => mine.connections.some((c) => c.sharing[w.id]));
    const byText = (a: string, b: string) => a.localeCompare(b);
    const listed = [...shareable, ...shared].sort((a, b) => byText(a.institution, b.institution) || byText(a.name, b.name) || byText(a.id, b.id));
    // Which are investment accounts, for the drawer's warnings about what
    // holdings shared as percentages give away beside one's balance.
    const investment = await investmentAccountIds(me.ctx, listed.map((a) => a.id));
    const accounts = listed.map((a) => (investment.has(a.id) ? { ...a, investment: true } : a));
    // The goals I could share. A display read: goals that can't be read are
    // left out and said (goals_unreadable), never a reason the drawer can't
    // open; a save that adds one reads them strictly.
    const goals = await shareableGoals(me.ctx).catch((err) => {
      console.error('Sharing: goals could not be read for the drawer', err instanceof Error ? err.name : err);
      return null;
    });
    return NextResponse.json(
      { enabled: true, connections: mine.connections, blocked: mine.blocked, accounts, goals: goals ?? [], ...(goals === null ? { goals_unreadable: true } : {}) },
      { headers: { 'Cache-Control': 'no-store' } }
    );
  }, 'read');
}

/** { id, label?, accounts?, views?, expires_at? }: renames a connection (what
 *  I call them), replaces what I share on it ({ "<account id>": "exists" |
 *  "balance" | "transactions" | "none" }), replaces the other kinds I share
 *  ({ net_worth?, spending?, holdings?, budgets?, goals? }, each a setting or
 *  null, lib/share-kinds.ts), and sets when that ends: an ISO time ahead, or
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
      (body.label !== undefined || body.accounts !== undefined || body.views !== undefined || body.expires_at !== undefined) &&
      (body.accounts === undefined || (body.accounts && typeof body.accounts === 'object' && !Array.isArray(body.accounts))) &&
      (body.expires_at === undefined || body.expires_at === null || (typeof body.expires_at === 'string' && body.expires_at.length <= 40));
    if (!valid) return NextResponse.json({ error: 'Expected { id, label?, accounts?, views?, expires_at? }' }, { status: 400 });
    // Every kind, every level and every goal id, checked as a shape before
    // anything is read (lib/share-kinds.ts): what this release doesn't know
    // is refused, never saved to be read as something else.
    const viewsProblem = body.views === undefined ? null : viewsChangeProblem(body.views);
    if (viewsProblem) return NextResponse.json({ error: `${viewsProblem}.` }, { status: 400 });
    // All of it or none: checked whole before anything is saved.
    await saveConnection(me.ctx, me.userId, body.id, { label: body.label, accounts: body.accounts, views: body.views, expires_at: body.expires_at });
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
