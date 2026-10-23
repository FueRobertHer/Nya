// lib/data-ctx.ts
//
// The container a request's data lives in (#53). With Clerk on
// (lib/auth-mode.ts), the one the signed-in account owns (lib/owners.ts);
// with the shared password, this deployment's, by the same rule sessions are
// checked by (lib/sessions.ts, deploymentContainer), and the proxy has already
// refused any session naming another container.
//
// dataCtx() is for routes behind the proxy: with Clerk on it asks Clerk who is
// signed in, which only works where the proxy ran. A route that authenticates
// itself (a cron, the balance ingest) uses deploymentCtx().
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
import { clerkEnabled } from './auth-mode';
import { ownerContainer } from './owners';
import { checkContainerKey, ContainerKeyError } from './crypto';

// Every Ctx handed out here has had its container's data key opened (when it
// has one), so a key that can't be used is refused before any reader runs,
// and a reader that swallows errors never takes it for "empty"
// (docs/architecture.md, "Per-container data keys"). Kept with the
// container's map entry for a minute: no round trip in the hot path.

// With Clerk on (lib/auth-mode.ts), the container is the signed-in account's
// (lib/owners.ts); the proxy has already checked the account is allowed.
export async function dataCtx(now: number = Date.now()): Promise<Ctx> {
  if (!clerkEnabled()) return deploymentCtx(now);
  const { auth } = await import('@clerk/nextjs/server');
  const { userId } = await auth();
  if (!userId) throw new ContainerError('Not signed in.');
  return checked({ container: await ownerContainer(userId, now) });
}

/** The signed-in Clerk account and its container, for routes that act as a
 *  person (sharing). Null in password mode, which has no people. */
export async function signedInCtx(now: number = Date.now()): Promise<{ userId: string; ctx: Ctx } | null> {
  if (!clerkEnabled()) return null;
  const { auth } = await import('@clerk/nextjs/server');
  const { userId } = await auth();
  if (!userId) throw new ContainerError('Not signed in.');
  return { userId, ctx: await checked({ container: await ownerContainer(userId, now) }) };
}

/** This deployment's container, whoever asks. For routes that authenticate
 *  themselves rather than through a session (the balance ingest). */
export async function deploymentCtx(now: number = Date.now()): Promise<Ctx> {
  const dep = await deploymentContainer(now);
  if (dep.kind === 'container') return checked({ container: dep.container });
  throw new ContainerError(dep.kind === 'none' ? 'No container exists yet.' : dep.reason);
}

async function checked(ctx: Ctx): Promise<Ctx> {
  await checkContainerKey(ctx);
  return ctx;
}

/** What the person is told when their container's data key can't be used.
 *  The key and the reason go to the log only. */
export const KEY_UNAVAILABLE_MESSAGE = 'Your data can’t be read on this server just now. Try again later.';

/** The response for a request refused for want of a container, or null if
 *  `err` is something else. 503: the data is there, just not reachable. */
export function containerUnavailable(err: unknown): NextResponse | null {
  if (!(err instanceof ContainerError)) return null;
  console.error(`Request refused: ${err.message}`);
  const shown = err instanceof ContainerKeyError ? KEY_UNAVAILABLE_MESSAGE : err.message;
  return NextResponse.json({ error: shown }, { status: 503 });
}
