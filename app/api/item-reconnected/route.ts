import { NextResponse } from 'next/server';
import { dataCtx, containerUnavailable } from '@/lib/data-ctx';
import { getItems } from '@/lib/storage';
import { clearRepaired } from '@/lib/connection-health';
import { clearCaches } from '@/lib/cache';
import { StoreRefusedError } from '@/lib/repo';
import { loggable } from '@/lib/log-safe';

// Called by the client after Link's update mode succeeds on an existing Item
// (Reconnect, or Enable payment details): the person has just signed in to the
// bank again, which is what Plaid says resolves a pending expiration or
// disconnect. Nothing is exchanged (the access token is unchanged); what
// changes is what Nya remembers about the connection's health. Plaid's warning
// and the email bookkeeping of the break are forgotten, so the card stops
// saying "Reconnect soon" and a later break gets a notice of its own
// (lib/connection-health.ts). The caches go too, so the reload that follows
// fetches.
//
// It only ever removes this container's own records of an Item it holds, so a
// call without a real reconnect costs the caller a warning they can see again
// at the next webhook, never anyone else's data. A warning cleared too eagerly
// is safe in the other direction as well: if the connection still ends, the
// fetch fails, and that is a break of its own.

const MAX_ID = 200;

export async function POST(req: Request) {
  try {
    const ctx = await dataCtx();
    const body = await req.json().catch(() => null);
    const item_id = body?.item_id;
    if (typeof item_id !== 'string' || item_id.length === 0 || item_id.length > MAX_ID) {
      return NextResponse.json({ error: 'Expected { item_id }' }, { status: 400 });
    }
    if (!(await getItems(ctx)).some((i) => i.item_id === item_id)) {
      return NextResponse.json({ error: 'Unknown item' }, { status: 404 });
    }
    await clearRepaired(ctx, item_id);
    await clearCaches(ctx);
    return NextResponse.json({ ok: true });
  } catch (err) {
    const unavailable = containerUnavailable(err);
    if (unavailable) return unavailable;
    if (err instanceof StoreRefusedError) return NextResponse.json({ error: err.message }, { status: err.status });
    console.error(loggable(err));
    return NextResponse.json({ error: 'Failed to record the reconnect' }, { status: 500 });
  }
}
