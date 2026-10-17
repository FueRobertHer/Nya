import { NextResponse } from 'next/server';
import { dataCtx } from '@/lib/data-ctx';
import { connectionsStore, connectorAccountsStore } from '@/lib/connectors/store';
import { accountView, connectionView } from '@/lib/connectors/view';
import { requestsLeft, DAILY_REQUESTS } from '@/lib/connectors/sync';
import { confirmSigns, disconnect, keepRefusal, MAX_CONNECTIONS } from '@/lib/connectors/manage';
import { OWED_SIGNS, type OwedSign } from '@/lib/connectors/store';
import { isManualId } from '@/lib/manual';
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
    // Each connection's offers say when another connection tracks them.
    const othersOf = (id: string) => all.filter((a) => a.connection_id !== id).map((account) => ({ account, host: connections.get(account.connection_id)?.host ?? null }));
    return NextResponse.json({
      connections: [...connections].map(([id, c]) => connectionView(id, c, all, othersOf(id))),
      orphaned: [...orphaned].map(([connection_id, list]) => ({ connection_id, accounts: list.map(accountView) })),
      requests: requests ? { ...requests, limit: DAILY_REQUESTS } : null,
      max_connections: MAX_CONNECTIONS,
    });
  } catch (err) {
    return connectorError(err, 'Failed to load your SimpleFIN connections');
  }
}

/** Disconnects one connection: `keep` (the default) keeps its accounts as
 *  manual accounts, with their history and transactions; false removes them.
 *  Keeping a card or a loan whose positive balance waits for the person's
 *  answer is refused (409) before anything is saved, so `sign` brings that
 *  answer with the request, as the accounts route takes it. */
export async function DELETE(req: Request) {
  try {
    const ctx = await dataCtx();
    const body = await readJson(req);
    if (body instanceof NextResponse) return body;
    if (!isConnectionId(body.connection_id)) return NextResponse.json({ error: 'Invalid connection' }, { status: 400 });
    if (body.keep !== undefined && typeof body.keep !== 'boolean') return NextResponse.json({ error: 'Say whether to keep the accounts' }, { status: 400 });
    const sign = body.sign === undefined ? [] : body.sign;
    const isAnswer = (x: unknown): x is { account_id: string; sign: OwedSign } => {
      const a = x as { account_id?: unknown; sign?: unknown } | null;
      return typeof a === 'object' && a !== null && typeof a.account_id === 'string' && a.account_id.length <= 80 && isManualId(a.account_id) && (OWED_SIGNS as readonly unknown[]).includes(a.sign);
    };
    if (!Array.isArray(sign) || sign.length > 100 || !sign.every(isAnswer)) return NextResponse.json({ error: 'Invalid answers about balances' }, { status: 400 });
    const keep = body.keep !== false;
    const theirs = [...(await connectorAccountsStore.getAll(ctx)).values()].filter((a) => a.connection_id === body.connection_id);
    if (!sign.every((s) => theirs.some((a) => a.account_id === s.account_id))) {
      return NextResponse.json({ error: 'That account is not one this connection tracks' }, { status: 400 });
    }
    // Refused before anything is saved, the answers this request brings counted in.
    const refused = keep ? keepRefusal(theirs, { signs: new Map(sign.map((s) => [s.account_id, s.sign])) }) : null;
    if (refused) return NextResponse.json({ error: refused }, { status: 409 });
    if (sign.length > 0) await confirmSigns(ctx, sign);
    const released = await disconnect(ctx, body.connection_id, keep);
    return NextResponse.json({ success: true, kept: released.kept.length, removed: released.removed.length, nothing_to_keep: released.nothing_to_keep });
  } catch (err) {
    return connectorError(err, 'Failed to disconnect');
  }
}
