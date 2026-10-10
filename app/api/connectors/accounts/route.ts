import { NextResponse } from 'next/server';
import { dataCtx } from '@/lib/data-ctx';
import { connectionsStore, connectorAccountsStore } from '@/lib/connectors/store';
import { connectionView } from '@/lib/connectors/view';
import { requestsLeft } from '@/lib/connectors/sync';
import { confirmSigns, othersOf, releaseAccounts, retypeAccounts, trackAccounts, MAX_CONNECTOR_ACCOUNTS, type TrackChoice } from '@/lib/connectors/manage';
import { OWED_SIGNS, type OwedSign } from '@/lib/connectors/store';
import { isManualId, MANUAL_TYPES, type ManualType } from '@/lib/manual';
import { connectorError, isConnectionId, readJson } from '@/lib/connectors/respond';

// Choosing which of a SimpleFIN connection's accounts to track, and what kind
// each is (lib/connectors/manage.ts), in one request: `retype` changes what
// kind tracked ones are, then `sign` records how to read a card's or a loan's
// balance (`as_reported`, or `owed_positive` when the server reports what is
// owed as positive), then `stop` lets accounts go (kept as manual accounts
// unless `keep` is false; keeping one whose sign still waits is refused, so
// its answer comes in `sign` first), then `track` adds accounts the
// connection offers and fetches their recent transactions. Every account
// named must be this connection's.

export const maxDuration = 60;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isType = (v: unknown): v is ManualType => typeof v === 'string' && (MANUAL_TYPES as readonly string[]).includes(v);
const isAccountId = (v: unknown): v is string => typeof v === 'string' && v.length <= 80 && isManualId(v);
const isRemoteId = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 200;
const isSign = (v: unknown): v is OwedSign => typeof v === 'string' && (OWED_SIGNS as readonly string[]).includes(v);

/** A list of at most MAX_CONNECTOR_ACCOUNTS items each `ok`, or null. */
function listOf<T>(v: unknown, ok: (x: unknown) => x is T): T[] | null {
  if (v === undefined) return [];
  if (!Array.isArray(v) || v.length > MAX_CONNECTOR_ACCOUNTS || !v.every(ok)) return null;
  return v;
}

export async function PUT(req: Request) {
  try {
    const ctx = await dataCtx();
    const body = await readJson(req);
    if (body instanceof NextResponse) return body;
    if (!isConnectionId(body.connection_id)) return NextResponse.json({ error: 'Invalid connection' }, { status: 400 });
    const track = listOf(body.track, (x): x is TrackChoice => isRecord(x) && isRemoteId(x.remote_id) && isType(x.type));
    const retype = listOf(body.retype, (x): x is { account_id: string; type: ManualType } => isRecord(x) && isAccountId(x.account_id) && isType(x.type));
    const sign = listOf(body.sign, (x): x is { account_id: string; sign: OwedSign } => isRecord(x) && isAccountId(x.account_id) && isSign(x.sign));
    if (track === null) return NextResponse.json({ error: 'Invalid accounts to track' }, { status: 400 });
    if (retype === null) return NextResponse.json({ error: 'Invalid account kinds' }, { status: 400 });
    if (sign === null) return NextResponse.json({ error: 'Invalid answers about balances' }, { status: 400 });
    let stop: { account_ids: string[]; keep: boolean } | null = null;
    if (body.stop !== undefined) {
      const s = body.stop;
      const ids = isRecord(s) ? listOf(s.account_ids, isAccountId) : null;
      if (!isRecord(s) || ids === null || (s.keep !== undefined && typeof s.keep !== 'boolean')) {
        return NextResponse.json({ error: 'Invalid accounts to stop tracking' }, { status: 400 });
      }
      stop = { account_ids: ids, keep: s.keep !== false };
    }
    if (new Set(track.map((t) => t.remote_id)).size !== track.length) return NextResponse.json({ error: 'An account is chosen twice' }, { status: 400 });

    // Every account named must be one this connection feeds.
    const accounts = await connectorAccountsStore.getAll(ctx);
    const mine = (id: string) => accounts.get(id)?.connection_id === body.connection_id;
    if (![...retype.map((r) => r.account_id), ...sign.map((r) => r.account_id), ...(stop?.account_ids ?? [])].every(mine)) {
      return NextResponse.json({ error: 'That account is not one this connection tracks' }, { status: 400 });
    }

    const retyped = retype.length > 0 ? await retypeAccounts(ctx, retype) : 0;
    const signed = sign.length > 0 ? await confirmSigns(ctx, sign) : 0;
    const released = stop && stop.account_ids.length > 0 ? await releaseAccounts(ctx, stop.account_ids, stop.keep) : { kept: [], removed: [], nothing_to_keep: [] };
    const fetched = track.length > 0 ? await trackAccounts(ctx, body.connection_id, track) : null;

    const [conn, now, requests] = await Promise.all([connectionsStore.get(ctx, body.connection_id), connectorAccountsStore.getAll(ctx), requestsLeft(ctx)]);
    const all = [...now.values()];
    return NextResponse.json({
      connection: conn ? connectionView(body.connection_id, conn, all, await othersOf(ctx, body.connection_id, all)) : null,
      kept: released.kept.length,
      removed: released.removed.length,
      nothing_to_keep: released.nothing_to_keep,
      retyped,
      signed,
      tracked: track.length,
      skipped: fetched?.skipped ?? null,
      requests,
    });
  } catch (err) {
    return connectorError(err, 'Failed to save your SimpleFIN accounts');
  }
}
