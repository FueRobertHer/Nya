// lib/store-failure.ts
//
// The answer a route gives for an error reading or writing a store on the
// storage seam (lib/repo.ts), the same everywhere (docs/architecture.md,
// "Storage seam"):
//   - no usable container: 503 with the reason (containerUnavailable);
//   - StoredDataUnreadableError: 409, flagged `unreadable` so the client
//     never takes it for "nothing saved", with the ids of each kind from an
//     UnreadableEntriesError (only `unreadable_ids` may ever be offered for
//     removal). The log gets why, never the ids;
//   - StoreRefusedError: its own status (409 when an entry kept changing, 413
//     when a write would be too large) and message: nothing was written;
//   - anything else: 500 with `fallback`, logged without what the request held.

import { NextResponse } from 'next/server';
import { containerUnavailable } from './data-ctx';
import { StoredDataUnreadableError, StoreRefusedError, UnreadableEntriesError, describeUnreadable } from './repo';
import { loggable } from './log-safe';

export function storeFailure(err: unknown, fallback: string): NextResponse {
  const unavailable = containerUnavailable(err);
  if (unavailable) return unavailable;
  if (err instanceof StoredDataUnreadableError) {
    console.error(`Stored ${err.what} unreadable:`, describeUnreadable(err));
    const ids = err instanceof UnreadableEntriesError ? { unreadable_ids: err.unreadable, unrecognised_ids: err.unrecognised } : {};
    return NextResponse.json({ error: err.message, unreadable: true, ...ids }, { status: 409 });
  }
  if (err instanceof StoreRefusedError) return NextResponse.json({ error: err.message }, { status: err.status });
  console.error(loggable(err));
  return NextResponse.json({ error: fallback }, { status: 500 });
}
