// lib/sessions.ts
//
// Session revocation (#56): each container has a session epoch, and a session
// issued under an older epoch is no longer valid. Bumping it ("sign out
// everywhere") ends every outstanding session for the container in one write.
//
// The epoch lives inside its container, at "sessions:epoch". It is not data:
// exports leave it out and a restore never replaces it (lib/export.ts,
// lib/restore.ts). Restoring an old value would bring revoked sessions back.
//
// Checked on every gated request (proxy.ts), with each instance reusing what
// it read for a few seconds, so a revocation takes effect everywhere within
// EPOCH_REUSE_MS. If the database cannot be reached the check lets the
// request through: every route that follows needs the database anyway, so
// failing closed would only turn an outage into a logout, and the login page
// would then need the database too.

import { redis, kc } from './storage';
import { CONTAINER_ENV, ContainerError, isContainerId, listContainers, type ContainerId, type Ctx } from './containers';
import type { Session } from './auth';

export const EPOCH_REUSE_MS = 5 * 1000;

function epochKey(ctx: Ctx): string {
  return kc(ctx, 'sessions:epoch');
}

const _epochs = new Map<string, { epoch: number; at: number }>();
let _loggedFailure = false;

/** For tests. */
export function forgetEpochs(): void {
  _epochs.clear();
  _loggedFailure = false;
}

/** The container's current session epoch; 0 if it was never bumped. */
export async function currentEpoch(container: ContainerId, now: number = Date.now()): Promise<number> {
  const seen = _epochs.get(container);
  if (seen && now - seen.at >= 0 && now - seen.at < EPOCH_REUSE_MS) return seen.epoch;
  const value = await redis().get(epochKey({ container }));
  const epoch = value === null || value === undefined ? 0 : Number(value);
  if (!Number.isSafeInteger(epoch) || epoch < 0) throw new Error('The stored session epoch is not a count.');
  _epochs.set(container, { epoch, at: now });
  return epoch;
}

/** End every session for the container, including the caller's. Returns the
 *  new epoch, for the session issued next. */
export async function revokeAllSessions(container: ContainerId, now: number = Date.now()): Promise<number> {
  const epoch = Number(await redis().incr(epochKey({ container })));
  _epochs.set(container, { epoch, at: now });
  return epoch;
}

/**
 * The container a session belongs to: the one its token names, or for a token
 * from before sessions named one, this deployment's CONTAINER_ID (the only
 * container there was). Null if neither is known.
 */
export function sessionContainer(session: Session): ContainerId | null {
  if (session.container) return session.container;
  const raw = process.env[CONTAINER_ENV];
  return isContainerId(raw) ? raw : null;
}

/** Whether a verified session has not been revoked. */
export async function sessionCurrent(session: Session, now: number = Date.now()): Promise<boolean> {
  const container = sessionContainer(session);
  // Only an old token in a deployment with no container yet: nothing to check
  // it against, and nothing could have revoked it.
  if (!container) return session.legacy;
  try {
    return session.epoch >= (await currentEpoch(container, now));
  } catch (err) {
    if (!_loggedFailure) {
      _loggedFailure = true;
      console.error('Session epoch unavailable; allowing the request.', err instanceof Error ? err.name : err);
    }
    return true;
  }
}

/**
 * The container a new session is for. Exactly one active container is the
 * only case handled: none means the operator has not created it yet (never
 * created here: a login racing another would mint two), and more than one
 * needs a way to choose that does not exist yet. It must also be the one this
 * deployment's CONTAINER_ID names, or the session would reach other data.
 * Throws a ContainerError, written for the operator, otherwise.
 */
export async function loginContainer(): Promise<ContainerId> {
  const active = (await listContainers()).filter((c) => c.status === 'active');
  if (active.length === 0) {
    throw new ContainerError('No container exists yet. Create one with /api/ops/containers (see the README).');
  }
  if (active.length > 1) throw new ContainerError('More than one container exists; choosing one at login is not supported yet.');
  const id = active[0].id;
  const configured = process.env[CONTAINER_ENV];
  if (configured && configured !== id) throw new ContainerError(`${CONTAINER_ENV} does not name the active container.`);
  return id;
}
