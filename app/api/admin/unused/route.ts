import { NextResponse } from 'next/server';
import { containerUnavailable } from '@/lib/data-ctx';
import { adminCtx, notAdmin, listFlagged, checkAll, removeFlagged } from '@/lib/admin-items';
import { unusedDays } from '@/lib/item-usage';

// The admin's list of connections that cost money and do nothing, across every
// account (lib/admin-items.ts). Behind the normal session gate, and then
// admin-only: anyone else gets the same 404 as a route that does not exist.
//
//   GET     what the last check flagged. Reads stored records only.
//   POST    runs the check on every account now, then answers as GET. Removes
//           nothing.
//   DELETE  { container, item_id } disconnects one flagged connection, after
//           checking again that it is still unused.

// Checking runs Plaid calls one connection at a time, up to 45s each.
export const maxDuration = 300;

async function fail(err: unknown, what: string): Promise<Response> {
  const unavailable = containerUnavailable(err);
  if (unavailable) return unavailable;
  console.error(`${what} failed`, err instanceof Error ? err.name : typeof err);
  return NextResponse.json({ error: `${what} failed` }, { status: 500 });
}

async function listing(admin: NonNullable<Awaited<ReturnType<typeof adminCtx>>>) {
  return NextResponse.json({ flag_after_days: unusedDays(), items: await listFlagged(admin) });
}

export async function GET() {
  try {
    const admin = await adminCtx();
    if (!admin) return notAdmin();
    return await listing(admin);
  } catch (err) {
    return fail(err, 'Reading unused connections');
  }
}

export async function POST() {
  try {
    const admin = await adminCtx();
    if (!admin) return notAdmin();
    await checkAll();
    return await listing(admin);
  } catch (err) {
    return fail(err, 'Checking connections');
  }
}

export async function DELETE(req: Request) {
  try {
    const admin = await adminCtx();
    if (!admin) return notAdmin();
    const body = await req.json().catch(() => ({}));
    const result = await removeFlagged(body?.container, body?.item_id);
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
    return await listing(admin);
  } catch (err) {
    return fail(err, 'Disconnecting');
  }
}
