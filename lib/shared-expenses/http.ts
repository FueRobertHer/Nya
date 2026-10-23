// lib/shared-expenses/http.ts
//
// How the shared expenses routes (app/api/shared-expenses) read a request and
// answer a failure, by the seam's rule (docs/architecture.md, "Storage
// seam"): a refusal of what was asked with its own status; a store of
// transactions that couldn't be read, 409 flagged unreadable, so the page
// never takes it for "not stored"; everything else by storeFailure (no
// container 503, unreadable 409 with the ids, a refused write its status,
// else 500).

import { NextResponse } from 'next/server';
import { storeFailure } from '../store-failure';
import { LookupUnreadableError } from '../txn-lookup';
import { ExpenseError } from './edits';

const MAX_BODY_CHARS = 32 * 1024;

/** The request's JSON object, or the answer refusing it. */
export async function bodyOf(req: Request): Promise<Record<string, unknown> | NextResponse> {
  const text = await req.text();
  if (text.length > MAX_BODY_CHARS) return NextResponse.json({ error: 'Request too large' }, { status: 413 });
  try {
    const parsed = JSON.parse(text);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('not an object');
    return parsed;
  } catch {
    return NextResponse.json({ error: 'Invalid request' }, { status: 400 });
  }
}

/** Refuses a body with a key the route doesn't take. */
export function onlyKeys(body: Record<string, unknown>, keys: readonly string[]): void {
  const extra = Object.keys(body).filter((k) => !keys.includes(k));
  if (extra.length > 0) throw new ExpenseError(`Unknown field: ${extra[0].slice(0, 40)}`);
}

export function failure(err: unknown, fallback: string): NextResponse {
  if (err instanceof ExpenseError) return NextResponse.json({ error: err.message }, { status: err.status });
  if (err instanceof LookupUnreadableError) return NextResponse.json({ error: err.message, unreadable: true }, { status: err.status });
  return storeFailure(err, fallback);
}
