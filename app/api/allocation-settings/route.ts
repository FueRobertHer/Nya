import { NextResponse } from 'next/server';
import { dataCtx, containerUnavailable } from '@/lib/data-ctx';
import { StoredDataUnreadableError, StoreRefusedError, describeUnreadable } from '@/lib/repo';
import { allocationSettingsStore } from '@/lib/allocation-settings';
import { parseSettings } from '@/lib/allocation/settings';
import { loggable } from '@/lib/log-safe';

// The person's allocation settings (lib/allocation/settings.ts): tax buckets
// and splits they set, and their target. GET answers { settings: null } when
// nothing was ever saved; PUT replaces them whole (the Plan tab always sends
// all of them), after checking every field (parseSettings). They change
// nothing /api/net-worth or /api/transactions answer, so no cache is cleared.

/** The answer for an error, as every route on the storage seam gives it. */
function failure(err: unknown, doing: string): NextResponse {
  const unavailable = containerUnavailable(err);
  if (unavailable) return unavailable;
  if (err instanceof StoredDataUnreadableError) {
    console.error('Stored allocation settings unreadable:', describeUnreadable(err));
    // 409, not 500, and flagged: the client must not show no settings and
    // let the next save replace what is there.
    return NextResponse.json({ error: err.message, unreadable: true }, { status: 409 });
  }
  // Nothing was written (settings too large to store, say): the seam's message.
  if (err instanceof StoreRefusedError) return NextResponse.json({ error: err.message }, { status: err.status });
  console.error(`Allocation settings ${doing} failed`, loggable(err));
  return NextResponse.json({ error: `Failed to ${doing} allocation settings` }, { status: 500 });
}

export async function GET() {
  try {
    const ctx = await dataCtx();
    return NextResponse.json({ settings: await allocationSettingsStore.get(ctx) });
  } catch (err) {
    return failure(err, 'load');
  }
}

export async function PUT(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid settings' }, { status: 400 });
  }
  const parsed = parseSettings(typeof body === 'object' && body !== null ? (body as { settings?: unknown }).settings : undefined);
  if ('error' in parsed) return NextResponse.json({ error: `Invalid settings: ${parsed.error}` }, { status: 400 });
  try {
    const ctx = await dataCtx();
    await allocationSettingsStore.set(ctx, parsed.settings);
    return NextResponse.json({ settings: parsed.settings });
  } catch (err) {
    return failure(err, 'save');
  }
}
