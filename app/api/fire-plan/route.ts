import { NextResponse } from 'next/server';
import { dataCtx, containerUnavailable } from '@/lib/data-ctx';
import { StoredDataUnreadableError, StoreRefusedError, describeUnreadable } from '@/lib/repo';
import { firePlanStore } from '@/lib/fire-plan';
import { parsePlan } from '@/lib/fire/plan';

// The Plan tab's saved assumptions. GET answers { plan: null } when nothing
// was ever saved; PUT replaces the whole plan (the client always sends all of
// it), after checking every field (lib/fire/plan.ts parsePlan).

/** The answer for an error, as every route on the storage seam gives it. */
function failure(err: unknown, doing: string): NextResponse {
  const unavailable = containerUnavailable(err);
  if (unavailable) return unavailable;
  if (err instanceof StoredDataUnreadableError) {
    console.error('Stored plan assumptions unreadable:', describeUnreadable(err));
    // 409, not 500, and flagged: the client must not show the defaults and let
    // the next save replace what is there.
    return NextResponse.json({ error: err.message, unreadable: true }, { status: 409 });
  }
  // Nothing was written (a plan too large to store, say): the seam's message.
  if (err instanceof StoreRefusedError) return NextResponse.json({ error: err.message }, { status: err.status });
  console.error(err);
  return NextResponse.json({ error: `Failed to ${doing} plan assumptions` }, { status: 500 });
}

export async function GET() {
  try {
    const ctx = await dataCtx();
    return NextResponse.json({ plan: await firePlanStore.get(ctx) });
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
      return NextResponse.json({ error: 'Invalid plan' }, { status: 400 });
    }
    const parsed = parsePlan(typeof body === 'object' && body !== null ? (body as { plan?: unknown }).plan : undefined);
    if ('error' in parsed) return NextResponse.json({ error: `Invalid plan: ${parsed.error}` }, { status: 400 });
    await firePlanStore.set(ctx, parsed.plan);
    return NextResponse.json({ plan: parsed.plan });
  } catch (err) {
    return failure(err, 'save');
  }
}
