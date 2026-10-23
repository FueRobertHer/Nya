import { NextResponse } from 'next/server';
import { containerUnavailable } from '@/lib/data-ctx';
import { StoredDataUnreadableError, StoreRefusedError } from '@/lib/repo';
import { isContainerId } from '@/lib/containers';
import { adminCtx, notAdmin } from '@/lib/admin-items';
import { readAdminStorage, MAX_PAGE } from '@/lib/admin-storage';

// The admin's view of storage across every account (lib/admin-storage.ts):
// each container's Plaid Items and their state, its connections, its blobs
// against the ceiling, what it stores in all and its last snapshot. Sizes and
// counts, and the plain text it names: nothing of anyone's data is decrypted.
// Behind the normal session gate, and then admin-only: anyone else gets the
// JSON 404 the admin's other route answers, before anything they sent is
// looked at.
//
//   GET ?after=<container id>&limit=<1..MAX_PAGE>   a page, in id order.

// One walk of the database's keyspace for the page, then a Lua step per
// hundred of each account's keys: on a large database that is many requests
// one after another, so the host is given as long as the admin's other route.
export const maxDuration = 300;

/** The page asked for, or why the query can't be one. Every parameter is
 *  checked: known names only, each at most once. */
function pageOf(url: URL): { after: string | null; limit: number | undefined } | string {
  const names = [...url.searchParams.keys()];
  if (names.some((n) => n !== 'after' && n !== 'limit')) return 'Only after and limit are accepted.';
  if (new Set(names).size !== names.length) return 'Each of after and limit may be given once.';
  const after = url.searchParams.get('after');
  if (after !== null && !isContainerId(after)) return 'after must be an account id from an earlier page.';
  const limit = url.searchParams.get('limit');
  if (limit !== null && (!/^[1-9][0-9]{0,2}$/.test(limit) || Number(limit) > MAX_PAGE)) return `limit must be a whole number from 1 to ${MAX_PAGE}.`;
  return { after, limit: limit === null ? undefined : Number(limit) };
}

export async function GET(req: Request) {
  try {
    const admin = await adminCtx();
    if (!admin) return notAdmin();
    const page = pageOf(new URL(req.url));
    if (typeof page === 'string') return NextResponse.json({ error: page }, { status: 400 });
    return NextResponse.json(await readAdminStorage(admin, page), { headers: { 'Cache-Control': 'no-store' } });
  } catch (err) {
    const unavailable = containerUnavailable(err);
    if (unavailable) return unavailable;
    if (err instanceof StoredDataUnreadableError) return NextResponse.json({ error: err.message, unreadable: true }, { status: 409 });
    if (err instanceof StoreRefusedError) return NextResponse.json({ error: err.message }, { status: err.status });
    console.error('Admin storage failed', err instanceof Error ? err.name : typeof err);
    return NextResponse.json({ error: 'Reading storage failed' }, { status: 500 });
  }
}
