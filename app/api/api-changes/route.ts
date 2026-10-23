import { NextResponse } from 'next/server';
import { dataCtx, containerUnavailable } from '@/lib/data-ctx';
import { StoredDataUnreadableError, StoreRefusedError, UnreadableEntriesError, describeUnreadable } from '@/lib/repo';
import { changeStore, forgetChange, forgetTokenChanges, isChangeId, listChanges, pruneChanges } from '@/lib/api-changes';
import { undoChange } from '@/lib/api-undo';
import { ApiFailure } from '@/lib/api-spec';
import { apiWritesEnabled } from '@/lib/api-writes-enabled';
import { loggable } from '@/lib/log-safe';

// The record of changes made with API tokens (lib/api-changes.ts), for the
// list under the API tokens card (components/ApiChanges.tsx): every token's
// changes, the person's own record, behind the session gate like every other
// route. A token reads only its own, through /api/v1/changes.
//
//   GET     ?cursor=  a page of changes, newest first: { changes, next,
//           unreadable, unrecognised, writes }. The window past 30 days is
//           pruned first.
//   POST    { action: 'undo', id }          undoes one change, any token's
//           (lib/api-undo.ts), when what it changed is still as it left it.
//   POST    { action: 'forget', id }        forgets one change's copies of
//           what it changed, at once; the line stays.
//   POST    { action: 'forget-token', token_id }  the same for every change
//           one token made.
//   DELETE  { id }  removes a change whose stored bytes are damaged, once the
//           person confirms (only those: one unrecognised is intact data).
//
// An undo made here is recorded as the app's, counts against no token's
// limits, and works whether or not this copy lets tokens write, so a change
// made before writing was turned off can still be taken back.

const MAX_BODY_CHARS = 2 * 1024;
const PAGE = 25;

function failure(err: unknown, what: string): NextResponse {
  const unavailable = containerUnavailable(err);
  if (unavailable) return unavailable;
  if (err instanceof ApiFailure) return NextResponse.json({ error: err.message }, { status: err.status });
  if (err instanceof StoredDataUnreadableError) {
    console.error('Stored API changes unreadable:', describeUnreadable(err));
    return NextResponse.json({ error: err.message, unreadable: true }, { status: 409 });
  }
  if (err instanceof StoreRefusedError) return NextResponse.json({ error: err.message }, { status: err.status });
  console.error(`API changes: ${what} failed`, loggable(err));
  return NextResponse.json({ error: `Could not ${what}.` }, { status: 500 });
}

const CURSOR = /^[A-Za-z0-9_-]{1,200}$/;

export async function GET(req: Request) {
  try {
    const ctx = await dataCtx();
    const now = Date.now();
    await pruneChanges(ctx, now);
    const raw = new URL(req.url).searchParams.get('cursor');
    let after: { at: string; id: string } | null = null;
    if (raw !== null) {
      if (!CURSOR.test(raw)) return NextResponse.json({ error: 'Invalid cursor' }, { status: 400 });
      try {
        const [at, id] = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as unknown[];
        if (typeof at !== 'string' || typeof id !== 'string') throw new Error('not a cursor');
        after = { at, id };
      } catch {
        return NextResponse.json({ error: 'Invalid cursor' }, { status: 400 });
      }
    }
    const page = await listChanges(ctx, { limit: PAGE, after, now, report: true });
    return NextResponse.json(
      {
        changes: page.changes.map(([id, c]) => ({ id, ...c })),
        next: page.next ? Buffer.from(JSON.stringify([page.next.at, page.next.id])).toString('base64url') : null,
        unreadable: page.unreadable,
        unrecognised: page.unrecognised,
        writes: apiWritesEnabled(),
      },
      { headers: { 'Cache-Control': 'no-store' } }
    );
  } catch (err) {
    return failure(err, 'read the changes made with your tokens');
  }
}

async function bodyOf(req: Request): Promise<Record<string, unknown> | null> {
  const text = await req.text();
  if (text.length > MAX_BODY_CHARS) return null;
  try {
    const parsed = JSON.parse(text);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export async function POST(req: Request) {
  try {
    const ctx = await dataCtx();
    const body = await bodyOf(req);
    if (!body) return NextResponse.json({ error: 'Invalid request' }, { status: 400 });
    if (body.action === 'undo' || body.action === 'forget') {
      if (!isChangeId(body.id)) return NextResponse.json({ error: 'Invalid change id' }, { status: 400 });
      if (body.action === 'forget') {
        if (!(await forgetChange(ctx, body.id))) return NextResponse.json({ error: 'No such change: it may be past 30 days.' }, { status: 404 });
        return NextResponse.json({ forgotten: 1 });
      }
      const { change, undo } = await undoChange(ctx, body.id, null);
      return NextResponse.json({ change: { id: body.id, ...change }, undo });
    }
    if (body.action === 'forget-token') {
      if (typeof body.token_id !== 'string' || !/^[0-9a-f]{16}$/.test(body.token_id)) return NextResponse.json({ error: 'Invalid token' }, { status: 400 });
      return NextResponse.json({ forgotten: await forgetTokenChanges(ctx, body.token_id) });
    }
    return NextResponse.json({ error: 'Invalid request' }, { status: 400 });
  } catch (err) {
    return failure(err, 'change that');
  }
}

export async function DELETE(req: Request) {
  try {
    const ctx = await dataCtx();
    const body = await bodyOf(req);
    if (!body || !isChangeId(body.id)) return NextResponse.json({ error: 'Invalid change id' }, { status: 400 });
    // Only a change whose bytes are damaged, read now: one that reads, or is
    // intact in a form this release doesn't know, is never removed here.
    try {
      await changeStore.get(ctx, body.id);
      return NextResponse.json({ error: 'That change reads fine: forget it instead.' }, { status: 409 });
    } catch (err) {
      if (!(err instanceof UnreadableEntriesError) || !err.unreadable.includes(body.id)) throw err;
    }
    await changeStore.remove(ctx, body.id);
    return NextResponse.json({ removed: true });
  } catch (err) {
    return failure(err, 'remove that');
  }
}
