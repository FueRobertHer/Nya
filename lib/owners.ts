// lib/owners.ts
//
// Which container a signed-in Clerk account owns (#44), when Clerk is on
// (lib/auth-mode.ts). One environment-wide hash: Clerk user id -> container id.
//
// Kept simple for one owner: the first allowed account to sign in claims the
// data that is already here (this deployment's container), once, and only
// while nobody owns anything yet. The claim is one Lua step, so two first
// sign-ins can't both take it. Anyone else signed in has no container and
// reaches no data; giving new accounts their own containers comes later.
//
// Password mode never reads this: it keeps the deployment's container.

import { redis, kEnv } from './storage';
import { ContainerError, getContainer, isContainerId, type ContainerId } from './containers';
import { deploymentContainer } from './sessions';

export const ownersKey = () => kEnv('owners');

/** Maps the user to the container only if nobody owns anything yet. The first
 *  line names the script for the test double. */
export const CLAIM_FIRST = `-- nya:owner-claim-first
if redis.call('HLEN', KEYS[1]) ~= 0 then return 0 end
redis.call('HSET', KEYS[1], ARGV[1], ARGV[2])
return 1`;

async function owned(userId: string): Promise<ContainerId | null> {
  const id = await redis().hget<string>(ownersKey(), userId);
  if (id === null || id === undefined) return null;
  if (typeof id !== 'string' || !isContainerId(id)) throw new ContainerError('This account maps to something that is not a container.');
  return id;
}

/** The container this signed-in account owns, claiming the existing data on
 *  the very first sign-in. Throws ContainerError when there is none to reach. */
export async function ownerContainer(userId: string, now: number = Date.now()): Promise<ContainerId> {
  let id = await owned(userId);
  if (!id) {
    const dep = await deploymentContainer(now);
    if (dep.kind !== 'container') throw new ContainerError(dep.kind === 'none' ? 'No container exists yet.' : dep.reason);
    const claimed = await redis().eval(CLAIM_FIRST, [ownersKey()], [userId, dep.container]);
    // Lost a race with this same account in another tab, or someone else
    // already owns the data: either way, read what is there now.
    id = claimed === 1 ? dep.container : await owned(userId);
    if (!id) throw new ContainerError('This account has no data here yet.');
  }
  const record = await getContainer(id);
  if (!record) throw new ContainerError('This account’s container is not in the registry.');
  if (record.status !== 'active') throw new ContainerError(`This account’s container is ${record.status}.`);
  return id;
}
