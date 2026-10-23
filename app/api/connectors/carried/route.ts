import { NextResponse } from 'next/server';
import { dataCtx } from '@/lib/data-ctx';
import { isManualId } from '@/lib/manual';
import { connectorError, readJson } from '@/lib/connectors/respond';
import { undoCarryOn, CarryOnRefused } from '@/lib/connectors/continue';

// Undoing carrying on an account a restore brought back with an account
// tracked through a connection made since (lib/connectors/continue.ts,
// UNDO):
//
//   POST { account_id, confirm: true }
//                             the account back as it was, waiting for its
//                             connection; the rows the new provider added
//                             removed, with what was said about them; those
//                             it took over given back what they were
//
// Offered whether or not carrying on is turned on (RESTORE_CARRY_ON_ENABLED):
// a choice made must always be undoable. Every field is checked, and
// anything else refused. Errors as the other connector routes answer them
// (lib/connectors/respond.ts); 404 for an account that wasn't carried on.

export async function POST(req: Request) {
  try {
    const ctx = await dataCtx();
    const body = await readJson(req);
    if (body instanceof NextResponse) return body;
    const id = body.account_id;
    if (!Object.keys(body).every((k) => k === 'account_id' || k === 'confirm') || typeof id !== 'string' || id.length > 80 || !isManualId(id) || body.confirm !== true) {
      return NextResponse.json({ error: 'Send { account_id, confirm: true }.' }, { status: 400 });
    }
    const { removed } = await undoCarryOn(ctx, id);
    console.log(`Connectors: carrying an account on was undone, ${removed} row${removed === 1 ? '' : 's'} removed`);
    return NextResponse.json({ undone: true, removed });
  } catch (err) {
    if (err instanceof CarryOnRefused) return NextResponse.json({ error: err.message }, { status: err.status });
    return connectorError(err, 'Couldn’t undo carrying that account on');
  }
}
