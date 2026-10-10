import { NextResponse } from 'next/server';
import { dataCtx } from '@/lib/data-ctx';
import { connect, othersOf, reconnect } from '@/lib/connectors/manage';
import { connectionsStore, connectorAccountsStore } from '@/lib/connectors/store';
import { connectionView, offersIn } from '@/lib/connectors/view';
import { requestsLeft } from '@/lib/connectors/sync';
import { isConnectorKind } from '@/lib/connectors/types';
import { MAX_TOKEN_CHARS } from '@/lib/connectors/simplefin';
import { connectorError, isConnectionId, readJson } from '@/lib/connectors/respond';

// Connecting to SimpleFIN: the person pastes a Setup Token, which Nya claims
// once for the Access URL it keeps (lib/connectors/manage.ts connect), and
// the answer lists the accounts SimpleFIN offers, with their balances, to
// choose from (those balances are never stored). With `connection_id`, a new
// token for a connection SimpleFIN no longer accepts: the same accounts and
// history carry on. A token is spent once claimed, whatever happens after, so
// a failure after the claim says the connection is made.

export const maxDuration = 60;

export async function POST(req: Request) {
  try {
    const ctx = await dataCtx();
    const body = await readJson(req);
    if (body instanceof NextResponse) return body;
    if (!isConnectorKind(body.connector)) return NextResponse.json({ error: 'Unknown connector' }, { status: 400 });
    if (typeof body.token !== 'string' || !body.token.trim()) return NextResponse.json({ error: 'Paste the Setup Token from SimpleFIN' }, { status: 400 });
    if (body.token.length > MAX_TOKEN_CHARS + 200) return NextResponse.json({ error: 'That is too long to be a SimpleFIN Setup Token' }, { status: 400 });
    if (body.connection_id !== undefined && !isConnectionId(body.connection_id)) return NextResponse.json({ error: 'Invalid connection' }, { status: 400 });

    const connection_id = body.connection_id ?? null;
    const result = connection_id ? await reconnect(ctx, connection_id, body.token) : null;
    const made = connection_id ? null : await connect(ctx, body.connector, body.token);
    const id = connection_id ?? made!.connection_id;
    const outcome = result ?? made!.result;
    const [conn, accounts, requests] = await Promise.all([connectionsStore.get(ctx, id), connectorAccountsStore.getAll(ctx), requestsLeft(ctx)]);
    const tracked = new Set(conn?.tracked.map((t) => t.remote_id) ?? []);
    const all = [...accounts.values()];
    const others = await othersOf(ctx, id, all);
    return NextResponse.json({
      connection_id: id,
      connection: conn ? connectionView(id, conn, all, others) : null,
      offers: outcome.answer ? offersIn(outcome.answer, tracked, conn, others) : [],
      skipped: outcome.skipped,
      requests,
    });
  } catch (err) {
    return connectorError(err, 'Failed to connect to SimpleFIN');
  }
}
