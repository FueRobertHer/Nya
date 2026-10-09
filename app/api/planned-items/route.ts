import { NextResponse } from 'next/server';
import { dataCtx, containerUnavailable } from '@/lib/data-ctx';
import { StoredDataUnreadableError, StoreRefusedError, describeUnreadable } from '@/lib/repo';
import { plannedStore } from '@/lib/planned-store';
import { EMPTY_PLANNED, parsePlanned } from '@/lib/planned';

// The forecast's planned items, the detected bills and income said not to be
// recurring, and the low-balance warning (lib/planned.ts). GET answers the
// empty plan when nothing was ever saved; PUT replaces the whole value (the
// client always sends all of it, through lib/whole-list-store.ts), after
// checking every field. The forecast itself is worked out in the browser and
// never stored.

/** The answer for an error, as every route on the storage seam gives it. */
function failure(err: unknown, doing: string): NextResponse {
  const unavailable = containerUnavailable(err);
  if (unavailable) return unavailable;
  if (err instanceof StoredDataUnreadableError) {
    console.error('Stored planned items unreadable:', describeUnreadable(err));
    // 409, not 500, and flagged: the client must not show "none" and let the
    // next save replace what is there.
    return NextResponse.json({ error: err.message, unreadable: true }, { status: 409 });
  }
  // Nothing was written (too large to store, say): the seam's message.
  if (err instanceof StoreRefusedError) return NextResponse.json({ error: err.message }, { status: err.status });
  console.error(err);
  return NextResponse.json({ error: `Failed to ${doing} planned items` }, { status: 500 });
}

export async function GET() {
  try {
    const ctx = await dataCtx();
    return NextResponse.json({ planned: (await plannedStore.get(ctx)) ?? EMPTY_PLANNED });
  } catch (err) {
    return failure(err, 'load');
  }
}

export async function PUT(req: Request) {
  try {
    const ctx = await dataCtx();
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ error: 'Invalid planned items' }, { status: 400 });
    }
    const parsed = parsePlanned(typeof body === 'object' && body !== null ? (body as { planned?: unknown }).planned : undefined);
    if ('error' in parsed) return NextResponse.json({ error: parsed.error }, { status: 400 });
    await plannedStore.set(ctx, parsed.ok);
    return NextResponse.json({ planned: parsed.ok });
  } catch (err) {
    return failure(err, 'save');
  }
}
