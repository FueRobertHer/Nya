// lib/ops.ts
//
// The lock on the operations routes (/api/ops/*), which can read the whole
// database or change its keys. Shared so every such route is locked the same
// way:
//
// - OFF UNLESS OPS_ENABLED=1. Set it for the length of an operation, then
//   remove it. While off, the route answers 404, as if it did not exist, so a
//   leaked OPS_SECRET is useless on its own.
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

export function notFound(): Response {
  return NextResponse.json({ error: 'Not found' }, { status: 404 });
}

/** A response to send instead of running the operation, or null to proceed. */
export async function opsGuard(req: Request): Promise<Response | null> {
  if (process.env.OPS_ENABLED !== '1') return notFound();

  const secret = process.env.OPS_SECRET;
  const header = req.headers.get('authorization') ?? '';
  const presented = header.startsWith('Bearer ') ? header.slice(7) : '';
  // `!secret` matters: without it an enabled route with no secret set would be
  // open rather than closed.
  if (!secret || !presented || !(await secretsMatch(presented, secret))) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
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
