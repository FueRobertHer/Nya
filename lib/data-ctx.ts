// lib/data-ctx.ts
//
// The container a request's data lives in (#53): this deployment's, by the
// same rule sessions are checked by (lib/sessions.ts, deploymentContainer).
// The proxy has already refused any session naming another container, so this
// is also the container of the session making the request.
//
// Resolve it once per request, at the route, and pass it down: every function
// that reads or writes stored data takes the Ctx, so a key cannot be built for
// a container nobody resolved, and resolving costs one registry read per
// request at most (deploymentContainer reuses it for a few seconds).
//
// Never a guess: with no usable container (none yet, misconfigured, being
// restored, several) the request is refused with the reason, rather than
// reading or writing anywhere else.

import { NextResponse } from 'next/server';
import { ContainerError, type Ctx } from './containers';
import { deploymentContainer } from './sessions';

export async function dataCtx(now: number = Date.now()): Promise<Ctx> {
  const dep = await deploymentContainer(now);
  if (dep.kind === 'container') return { container: dep.container };
  throw new ContainerError(dep.kind === 'none' ? 'No container exists yet.' : dep.reason);
}

/** The response for a request refused for want of a container, or null if
 *  `err` is something else. 503: the data is there, just not reachable. */
export function containerUnavailable(err: unknown): NextResponse | null {
  if (!(err instanceof ContainerError)) return null;
  console.error(`Request refused: ${err.message}`);
  return NextResponse.json({ error: err.message }, { status: 503 });
}
