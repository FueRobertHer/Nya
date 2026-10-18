import { NextResponse } from 'next/server';
import { dataCtx } from '@/lib/data-ctx';
import { connect, othersOf, reconnect } from '@/lib/connectors/manage';
import { connectionsStore, connectorAccountsStore } from '@/lib/connectors/store';
import { connectionView, offersIn } from '@/lib/connectors/view';
import { requestsLeft } from '@/lib/connectors/sync';
import { CONNECTOR_WORDS, isConnectorKind } from '@/lib/connectors/types';
import { connectorOf } from '@/lib/connectors/registry';
import { connectorError, isConnectionId, readJson } from '@/lib/connectors/respond';

// Connecting a service the person brings: SimpleFIN, where they paste a Setup
// Token, which Nya claims once for the Access URL it keeps, or Lunch Flow,
// where they paste an API key, which Nya checks once and keeps
// (lib/connectors/manage.ts connect). The answer lists the accounts the
// service offers, with their balances, to choose from (those balances are
// never stored). With `connection_id`, a new token or key for a connection
// the service no longer accepts: the same accounts and history carry on. A
// SimpleFIN token is spent once claimed, whatever happens after, so a failure
// after the claim says the connection is made.

export const maxDuration = 60;

export async function POST(req: Request) {
  try {
    const ctx = await dataCtx();
    const body = await readJson(req);
    if (body instanceof NextResponse) return body;
    if (!isConnectorKind(body.connector)) return NextResponse.json({ error: 'Unknown connector' }, { status: 400 });
    const { label, credential } = CONNECTOR_WORDS[body.connector];
    if (typeof body.token !== 'string' || !body.token.trim()) return NextResponse.json({ error: `Paste the ${credential} from ${label}` }, { status: 400 });
    if (body.token.length > connectorOf(body.connector).maxInputChars) return NextResponse.json({ error: `That is too long to be a ${label} ${credential}` }, { status: 400 });
    if (body.connection_id !== undefined && !isConnectionId(body.connection_id)) return NextResponse.json({ error: 'Invalid connection' }, { status: 400 });

    const connection_id = body.connection_id ?? null;
    const result = connection_id ? await reconnect(ctx, connection_id, body.token, Date.now(), body.connector) : null;
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
    return connectorError(err, 'Failed to connect');
  }
}
