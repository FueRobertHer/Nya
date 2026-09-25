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
// A session is also only good for THIS deployment's container: the one
// CONTAINER_ID names, or with it unset, the single active container. A token
// naming any other container (after a restore replaced the registry, or
// CONTAINER_ID changed) is refused, as is every session while the
// deployment's container cannot be worked out (misconfigured, restoring,
// more than one). Tokens from before sessions named a container are checked
// against this deployment's container too, so "sign out everywhere" ends
// them. Only in an environment with no container at all, and no CONTAINER_ID,
// is an old token accepted unchecked: nothing could have revoked it.
//
// Checked on every gated request (proxy.ts). Each instance reuses what it read
// for CHECK_REUSE_MS, and the proxy and the route handlers keep separate
// copies, so a revocation takes effect everywhere within a few seconds. If
// the database cannot be reached the check lets the request through: every
// route that follows needs the database anyway, so failing closed would only
// turn an outage into a logout. A stored epoch that is not a count is not an
// outage but damage, and fails closed.

import { redis, kc } from './storage';
import { CONTAINER_ENV, ContainerError, isContainerId, listContainers, type ContainerId, type Ctx } from './containers';
import type { Session } from './auth';

export const CHECK_REUSE_MS = 5 * 1000;

function epochKey(ctx: Ctx): string {
  return kc(ctx, 'sessions:epoch');
}

/** The stored epoch is not a count: damage, never "no revocations". */
export class EpochDamagedError extends Error {
  constructor() {
    super('The stored session epoch is not a count; delete it to reset sessions.');
    this.name = 'EpochDamagedError';
  }
}

/** Which container sessions in this deployment belong to. */
export type Deployment =
  | { kind: 'container'; container: ContainerId }
  | { kind: 'none' } // no container anywhere and no CONTAINER_ID: a fresh setup
  | { kind: 'unusable'; reason: string }; // misconfigured, restoring, several

const _epochs = new Map<string, { epoch: number; at: number }>();
let _deployment: { env: string; value: Deployment; at: number } | null = null;
let _failedAt: number | null = null;
let _loggedFailure = false;

/** For tests. */
export function forgetEpochs(): void {
  _epochs.clear();
  _deployment = null;
  _failedAt = null;
  _loggedFailure = false;
}

const recent = (at: number, now: number) => now - at >= 0 && now - at < CHECK_REUSE_MS;

async function readEpoch(container: ContainerId): Promise<number> {
  const value = await redis().get(epochKey({ container }));
  const epoch = value === null || value === undefined ? 0 : Number(value);
  if (!Number.isSafeInteger(epoch) || epoch < 0) throw new EpochDamagedError();
  return epoch;
}

/** The container's current session epoch; 0 if it was never bumped. With
 *  `fresh`, always read (for issuing a session, which must not start life on
 *  an epoch another instance has already moved past). */
export async function currentEpoch(
  container: ContainerId,
  now: number = Date.now(),
  opts: { fresh?: boolean } = {}
): Promise<number> {
  const seen = _epochs.get(container);
  if (!opts.fresh && seen && recent(seen.at, now)) return seen.epoch;
  const epoch = await readEpoch(container);
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

/** Which container this deployment's sessions belong to (see the header). */
export async function deploymentContainer(now: number = Date.now()): Promise<Deployment> {
  const env = process.env[CONTAINER_ENV] ?? '';
  if (_deployment && _deployment.env === env && recent(_deployment.at, now)) return _deployment.value;

  const all = await listContainers();
  const active = all.filter((c) => c.status === 'active');
  let value: Deployment;
  if (env) {
    const named = all.find((c) => c.id === env);
    if (!isContainerId(env)) value = { kind: 'unusable', reason: `${CONTAINER_ENV} is not a container id.` };
    else if (!named) value = { kind: 'unusable', reason: `${CONTAINER_ENV} names a container that is not in the registry.` };
    else if (named.status !== 'active') value = { kind: 'unusable', reason: `${CONTAINER_ENV} names a container that is ${named.status}.` };
    else value = { kind: 'container', container: named.id };
  } else if (active.length === 1) {
    value = { kind: 'container', container: active[0].id };
  } else if (all.length === 0) {
    value = { kind: 'none' };
  } else {
    value = { kind: 'unusable', reason: active.length === 0 ? 'No container is active.' : 'More than one container is active.' };
  }
  _deployment = { env, value, at: now };
  return value;
}

/**
 * The container a session belongs to in this deployment, or null if it has
 * none here: a token naming another container, or no usable container.
 */
export async function sessionContainer(session: Session, now: number = Date.now()): Promise<ContainerId | null> {
  const dep = await deploymentContainer(now);
  if (dep.kind !== 'container') return null;
  if (session.container && session.container !== dep.container) return null;
  return dep.container;
}

/** Whether a verified session is still good in this deployment. */
export async function sessionCurrent(session: Session, now: number = Date.now()): Promise<boolean> {
  // After a failure, the next few seconds are let through without asking
  // again, so an outage does not make every request wait on retries.
  if (_failedAt !== null && recent(_failedAt, now)) return true;
  try {
    const dep = await deploymentContainer(now);
    let ok: boolean;
    if (dep.kind === 'none') ok = session.legacy;
    else if (dep.kind === 'unusable') ok = false;
    else if (session.container && session.container !== dep.container) ok = false;
    else ok = session.epoch >= (await currentEpoch(dep.container, now));
    _failedAt = null;
    _loggedFailure = false;
    return ok;
  } catch (err) {
    if (err instanceof EpochDamagedError) {
      console.error(err.message);
      return false;
    }
    _failedAt = now;
    if (!_loggedFailure) {
      _loggedFailure = true;
      console.error('Session check unavailable; allowing requests until it recovers.', err instanceof Error ? err.name : err);
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
    throw new ContainerError(
      'No container exists yet, so no one can log in. Create one: with OPS_ENABLED=1 and OPS_SECRET set, POST {"create":true} to /api/ops/containers (see "Containers" in the README).'
    );
  }
  if (active.length > 1) throw new ContainerError('More than one container exists; choosing one at login is not supported yet.');
  const id = active[0].id;
  const configured = process.env[CONTAINER_ENV];
  if (configured && configured !== id) throw new ContainerError(`${CONTAINER_ENV} does not name the active container.`);
  return id;
}
