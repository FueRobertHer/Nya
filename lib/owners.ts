// lib/owners.ts
//
// Which container a signed-in Clerk account owns (#44), when Clerk is on
// (lib/auth-mode.ts). One environment-wide hash: Clerk user id -> container id.
//
// The first allowed account ever to sign in claims the data already here (the
// deployment's container, the primary one). Every allowed account after that
// gets a new, empty container of its own on its first sign-in. Both happen in
// one Lua step with the mapping, so a race can't give one account two
// containers or two accounts one. The proxy has already checked the account
// is on the allowlist; nobody else ever reaches this.
//
// Password mode never reads this: it keeps the deployment's container.

import { redis, kEnv } from './storage';
import {
  ContainerError,
  asContainerId,
  getContainer,
  isContainerId,
  registryKey,
  type ContainerId,
  type ContainerRecord,
} from './containers';
import { deploymentContainer } from './sessions';

export const ownersKey = () => kEnv('owners');

/**
 * The account's container, set up on its first sign-in, in one step:
 * already mapped, that; nobody mapped yet, claim ARGV[2] (the existing data,
 * '' when there is none to claim); otherwise register ARGV[3] as a new
 * container (record ARGV[4]) and map the account to it. Returns the id, or ''
 * when there was nothing to claim. The first line names the script for the
 * test double.
 */
export const CLAIM_OR_CREATE = `-- nya:owner-claim-or-create
local have = redis.call('HGET', KEYS[1], ARGV[1])
if have then return have end
if redis.call('HLEN', KEYS[1]) == 0 then
  if ARGV[2] == '' then return '' end
  redis.call('HSET', KEYS[1], ARGV[1], ARGV[2])
  return ARGV[2]
end
if redis.call('HEXISTS', KEYS[2], ARGV[3]) == 1 then return redis.error_reply('container id already registered') end
redis.call('HSET', KEYS[2], ARGV[3], ARGV[4])
redis.call('HSET', KEYS[1], ARGV[1], ARGV[3])
return ARGV[3]`;

async function owned(userId: string): Promise<ContainerId | null> {
  const id = await redis().hget<string>(ownersKey(), userId);
  if (id === null || id === undefined) return null;
  if (typeof id !== 'string' || !isContainerId(id)) throw new ContainerError('This account maps to something that is not a container.');
  return id;
}

/** The container this signed-in account owns, set up on its first sign-in.
 *  Throws ContainerError when it can't be reached. */
export async function ownerContainer(userId: string, now: number = Date.now()): Promise<ContainerId> {
  let id = await owned(userId);
  if (!id) {
    const dep = await deploymentContainer(now);
    const fresh = asContainerId(crypto.randomUUID());
    const record: ContainerRecord = { status: 'active', primary: false, created_at: new Date(now).toISOString() };
    const got = await redis().eval(CLAIM_OR_CREATE, [ownersKey(), registryKey()], [
      userId,
      dep.kind === 'container' ? dep.container : '',
      fresh,
      JSON.stringify(record),
    ]);
    if (got === '' || got === null) throw new ContainerError(dep.kind === 'container' ? 'No container to claim.' : dep.kind === 'none' ? 'No container exists yet.' : dep.reason);
    if (typeof got !== 'string' || !isContainerId(got)) throw new ContainerError('Setting up this account’s container returned something that is not a container.');
    id = got;
  }
  const record = await getContainer(id);
  if (!record) throw new ContainerError('This account’s container is not in the registry.');
  if (record.status !== 'active') throw new ContainerError(`This account’s container is ${record.status}.`);
  return id;
}
