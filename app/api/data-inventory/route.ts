import { NextResponse } from 'next/server';
import { dataCtx, signedInCtx, containerUnavailable } from '@/lib/data-ctx';
import { StoredDataUnreadableError, StoreRefusedError } from '@/lib/repo';
import { readInventory } from '@/lib/inventory-read';

// Your data (app/your-data): everything Nya keeps about the signed-in person,
// kind by kind, counted and measured now, never a value (lib/inventory-read.ts).
// Their own container only, resolved here once; behind the session gate.
// Takes no options: a query string is refused, so nothing can ask it about
// another container. What can't be read is named in the answer, never left
// out or shown as nothing; only a failure to resolve the container fails the
// request (503), as everywhere.

export async function GET(req: Request) {
  if (new URL(req.url).search !== '') return NextResponse.json({ error: 'This takes no options.' }, { status: 400 });
  try {
    const signed = await signedInCtx();
    const ctx = signed ? signed.ctx : await dataCtx();
    return NextResponse.json(await readInventory(ctx, { userId: signed?.userId ?? null }), { headers: { 'Cache-Control': 'no-store' } });
  } catch (err) {
    const unavailable = containerUnavailable(err);
    if (unavailable) return unavailable;
    if (err instanceof StoredDataUnreadableError) return NextResponse.json({ error: err.message, unreadable: true }, { status: 409 });
    if (err instanceof StoreRefusedError) return NextResponse.json({ error: err.message }, { status: err.status });
    console.error('Your data: the list could not be made', err instanceof Error ? err.name : typeof err);
    return NextResponse.json({ error: 'Could not list what Nya keeps just now.' }, { status: 500 });
  }
}
