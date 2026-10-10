import { NextResponse } from 'next/server';
import { dataCtx } from '@/lib/data-ctx';
import { connectionsStore, connectorAccountsStore } from '@/lib/connectors/store';
import { connectionView } from '@/lib/connectors/view';
import { othersOf } from '@/lib/connectors/manage';
import { requestsLeft, syncConnection, DAILY_REQUESTS } from '@/lib/connectors/sync';
import { connectorError, isConnectionId, readJson } from '@/lib/connectors/respond';

// The person's own Refresh of one SimpleFIN connection: one request for the
// recent window (lib/connectors/sync.ts), from the same day's budget as the
// daily update, so it is refused, saying when it comes back, once the day's
// requests are spent. SimpleFIN itself updates about once a day, so asking
// more often seldom brings anything new.

export const maxDuration = 60;

export async function POST(req: Request) {
  try {
    const ctx = await dataCtx();
    const body = await readJson(req);
    if (body instanceof NextResponse) return body;
    if (!isConnectionId(body.connection_id)) return NextResponse.json({ error: 'Invalid connection' }, { status: 400 });
    const result = await syncConnection(ctx, body.connection_id, { purpose: 'refresh' });
    const requests = await requestsLeft(ctx);
    if (result.skipped === 'gone') return NextResponse.json({ error: 'That connection no longer exists.' }, { status: 404 });
    if (result.skipped === 'budget') {
      const hours = requests ? Math.max(1, Math.ceil(requests.resets_in_seconds / 3600)) : null;
      return NextResponse.json(
        {
          error: `Nya has used today's ${DAILY_REQUESTS} requests to SimpleFIN${hours ? `; more are available in about ${hours} hour${hours === 1 ? '' : 's'}` : ''}. SimpleFIN updates about once a day, so the daily update brings what is new.`,
          requests,
        },
        { status: 429 }
      );
    }
    const [conn, accounts] = await Promise.all([connectionsStore.get(ctx, body.connection_id), connectorAccountsStore.getAll(ctx)]);
    const all = [...accounts.values()];
    return NextResponse.json({ connection: conn ? connectionView(body.connection_id, conn, all, await othersOf(ctx, body.connection_id, all)) : null, requests });
  } catch (err) {
    return connectorError(err, 'Failed to refresh from SimpleFIN');
  }
}
