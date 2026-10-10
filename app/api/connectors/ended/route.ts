import { NextResponse } from 'next/server';
import { dataCtx } from '@/lib/data-ctx';
import { endedAccountsStore } from '@/lib/connectors/store';
import { forgetEnded } from '@/lib/connectors/manage';
import { connectorOf } from '@/lib/connectors/registry';
import { isManualId } from '@/lib/manual';
import { connectorError, readJson } from '@/lib/connectors/respond';

// The accounts a SimpleFIN connection fed that the person stopped tracking or
// disconnected (connector-ended, lib/connectors/store.ts), which reports read
// to say what a period may be missing: GET lists them, with when and how each
// was let go, and DELETE forgets one at the person's word (lib/connectors/
// manage.ts forgetEnded), after which reports no longer mention it.

export async function GET() {
  try {
    const ctx = await dataCtx();
    // LENIENT, for this list only, which nothing writes on: one that can't be
    // read is listed by id, to forget; one this version doesn't recognise is
    // counted, and never offered.
    const { entries, unreadable, unrecognised } = await endedAccountsStore.getAllReport(ctx);
    const accounts = [...entries]
      .map(([account_id, e]) => ({
        account_id,
        name: e.name,
        institution_name: e.institution_name,
        connector: connectorOf(e.connector).label,
        ended_at: e.ended_at,
        kept: e.kept,
      }))
      .sort((a, b) => (a.ended_at < b.ended_at ? 1 : a.ended_at > b.ended_at ? -1 : a.name.localeCompare(b.name)));
    return NextResponse.json({ accounts, unreadable, unrecognised: unrecognised.length }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (err) {
    return connectorError(err, 'Failed to list the accounts you stopped tracking');
  }
}

/** { account_id }: forgets that account's record. */
export async function DELETE(req: Request) {
  try {
    const ctx = await dataCtx();
    const body = await readJson(req);
    if (body instanceof NextResponse) return body;
    const id = body.account_id;
    if (typeof id !== 'string' || id.length > 80 || !isManualId(id)) return NextResponse.json({ error: 'Invalid account' }, { status: 400 });
    return NextResponse.json({ forgotten: await forgetEnded(ctx, id) });
  } catch (err) {
    return connectorError(err, 'Failed to forget that account');
  }
}
