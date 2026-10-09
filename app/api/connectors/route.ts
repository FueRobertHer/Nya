import { NextResponse } from 'next/server';
import { dataCtx } from '@/lib/data-ctx';
import { connectionsStore, connectorAccountsStore } from '@/lib/connectors/store';
import { accountView, connectionView } from '@/lib/connectors/view';
import { requestsLeft, DAILY_REQUESTS } from '@/lib/connectors/sync';
import { disconnect, MAX_CONNECTIONS } from '@/lib/connectors/manage';
import { connectorError, isConnectionId, readJson } from '@/lib/connectors/respond';

// The connections to SimpleFIN the person made (lib/connectors/): GET lists
// them for the Accounts tab, with their accounts, what the latest request
// came to in SimpleFIN's own words, and how many of the day's requests are
// left; DELETE disconnects one (lib/connectors/manage.ts disconnect), keeping
// its accounts as manual accounts unless asked to remove them. Never the
// Access URL.

export const maxDuration = 60;

export async function GET() {
  try {
    const ctx = await dataCtx();
    const [connections, accounts, requests] = await Promise.all([connectionsStore.getAll(ctx), connectorAccountsStore.getAll(ctx), requestsLeft(ctx)]);
    const all = [...accounts.values()];
    // Accounts whose connection is gone (a disconnect that stopped part way):
    // listed by the connection they had, so they can be let go too.
    const orphaned = new Map<string, typeof all>();
    for (const a of all) if (!connections.has(a.connection_id)) orphaned.set(a.connection_id, [...(orphaned.get(a.connection_id) ?? []), a]);
    return NextResponse.json({
      connections: [...connections].map(([id, c]) => connectionView(id, c, all)),
      orphaned: [...orphaned].map(([connection_id, list]) => ({ connection_id, accounts: list.map(accountView) })),
      requests: requests ? { ...requests, limit: DAILY_REQUESTS } : null,
      max_connections: MAX_CONNECTIONS,
    });
  } catch (err) {
    return connectorError(err, 'Failed to load your SimpleFIN connections');
  }
}

/** Disconnects one connection: `keep` (the default) keeps its accounts as
 *  manual accounts, with their history and transactions; false removes them. */
export async function DELETE(req: Request) {
  try {
    const ctx = await dataCtx();
    const body = await readJson(req);
    if (body instanceof NextResponse) return body;
    if (!isConnectionId(body.connection_id)) return NextResponse.json({ error: 'Invalid connection' }, { status: 400 });
    if (body.keep !== undefined && typeof body.keep !== 'boolean') return NextResponse.json({ error: 'Say whether to keep the accounts' }, { status: 400 });
    const released = await disconnect(ctx, body.connection_id, body.keep !== false);
    return NextResponse.json({ success: true, kept: released.kept.length, removed: released.removed.length });
  } catch (err) {
    return connectorError(err, 'Failed to disconnect');
  }
}
