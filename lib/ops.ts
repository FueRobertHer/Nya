// lib/ops.ts
//
// The lock on the operations routes (/api/ops/*), which can read the whole
// database or change its keys. Shared so every such route is locked the same
// way:
//
// - OFF UNLESS THE `ops` FEATURE SWITCH IS ON (lib/flags.ts): OPS_ENABLED=1
//   while that is set, else the stored switch. Turn it on for the length of an
//   operation, then off. While off, the route answers 404, as if it did not
//   exist, so a leaked OPS_SECRET is useless on its own. The stored switch is
//   looked at in this instance's copy first (lib/flag-read.ts), so a probe of
//   these public paths reads nothing, and read again, fresh, once the secret
//   matched: turning it off holds at once, turning it on takes up to 30
//   seconds. A new environment has no stored switch yet (no account owns a
//   container to set one), so OPS_ENABLED=1 is how one is set up.
// - POST ONLY, with the secret in a header. A GET would invite putting the
//   secret in a URL, and URLs end up in logs, browser history and caches.
//   Every other method answers 404 explicitly: left undefined, Next answers
//   GET and HEAD with 405 and OPTIONS with 204 plus an Allow header, which
//   reveals the route exists even while it is switched off.
// - CONSTANT-TIME COMPARISON (lib/auth.ts), since these are reachable by anyone
//   on the internet.
//
// Each route is also excluded from the session gate in proxy.ts, with a `$`
// anchor, like the other self-authenticating routes.

import { NextResponse } from 'next/server';
import { secretsMatch } from './auth';
import { opsOnCached, opsOnFresh } from './flag-read';

export function notFound(): Response {
  return NextResponse.json({ error: 'Not found' }, { status: 404 });
}

/** A response to send instead of running the operation, or null to proceed. */
export async function opsGuard(req: Request): Promise<Response | null> {
  if (!(await opsOnCached())) return notFound();

  const secret = process.env.OPS_SECRET;
  const header = req.headers.get('authorization') ?? '';
  const presented = header.startsWith('Bearer ') ? header.slice(7) : '';
  // `!secret` matters: without it an enabled route with no secret set would be
  // open rather than closed.
  if (!secret || !presented || !(await secretsMatch(presented, secret))) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  if (!(await opsOnFresh())) return notFound();
  return null;
}

/** Every method but POST, for a route to re-export. */
export const notPost = {
  GET: notFound,
  HEAD: notFound,
  OPTIONS: notFound,
  PUT: notFound,
  PATCH: notFound,
  DELETE: notFound,
};
