// lib/account-deletion.ts
//
// Deleting an account and everything it owns (#44): the person's own choice,
// from the app. In order, each step safe to repeat, so a deletion that stops
// part way is finished by running it again:
//
//   1. its container is marked archived: from then on nothing reaches it (its
//      own requests, the snapshot cron, anyone it shared with);
//   2. every sharing grant to or from the account is dropped;
//   3. each of its banks is disconnected at Plaid (a failure there is logged
//      and the rest goes on: Plaid ends a connection nobody uses anyway);
//   4. every key in the container is deleted;
//   5. the container leaves the registry and the account leaves the owners map;
//   6. the Clerk user is deleted (best effort; the data is already gone).
//
// The primary container (the first, the owner's) is never deleted from here:
// background jobs without a signed-in account use it, and with it gone they
// would have no rule left to pick one.
//
// Nightly backups (lib/backup.ts) still hold the data until they age out.

import { redis, containerPrefix, getItems } from './storage';
import { getContainer, isContainerId, registryKey, type ContainerId, type ContainerRecord, type Ctx } from './containers';
import { ownersKey } from './owners';
import { dropGrantsOf } from './sharing';
import { decrypt } from './crypto';

export class DeletionRefused extends Error {}

const PAGE = 500;

async function keysIn(ctx: Ctx): Promise<string[]> {
  const found = new Set<string>();
  let cursor: string | number = 0;
  do {
    const [next, page] = (await redis().scan(cursor, { match: `${containerPrefix(ctx)}*`, count: PAGE })) as [string | number, string[]];
    for (const key of page) found.add(key);
    cursor = next;
  } while (String(cursor) !== '0');
  return [...found];
}

/** What deleting this account would remove, or why it can't be deleted. */
export async function deletionCheck(userId: string): Promise<{ allowed: true } | { allowed: false; reason: string }> {
  const id = await redis().hget<string>(ownersKey(), userId);
  if (typeof id === 'string' && isContainerId(id)) {
    const rec = await getContainer(id as ContainerId);
    if (rec?.primary) return { allowed: false, reason: 'This is the primary account. Its data can’t be deleted from the app.' };
  }
  return { allowed: true };
}

export async function deleteAccount(
  userId: string,
  opts: { removeItem: (accessToken: string) => Promise<void>; deleteUser?: (userId: string) => Promise<void> }
): Promise<{ disconnected: number; deletedKeys: number }> {
  const check = await deletionCheck(userId);
  if (!check.allowed) throw new DeletionRefused(check.reason);

  const raw = await redis().hget<string>(ownersKey(), userId);
  const container = typeof raw === 'string' && isContainerId(raw) ? (raw as ContainerId) : null;
  let disconnected = 0;
  let deletedKeys = 0;

  if (container) {
    const ctx: Ctx = { container };
    const rec = await getContainer(container);
    // 1. Nothing reaches it from here on.
    if (rec && rec.status !== 'archived') {
      const archived: ContainerRecord = { ...rec, status: 'archived' };
      await redis().hset(registryKey(), { [container]: JSON.stringify(archived) });
    }
    // 2. Sharing, both ways.
    await dropGrantsOf(userId);
    // 3. Its banks.
    for (const item of await getItems(ctx)) {
      try {
        await opts.removeItem(await decrypt(item.encrypted_access_token));
        disconnected++;
      } catch (err) {
        console.error('Account deletion: a bank could not be disconnected at Plaid', err instanceof Error ? err.name : err);
      }
    }
    // 4. Everything it stored.
    const keys = await keysIn(ctx);
    for (let i = 0; i < keys.length; i += PAGE) {
      const batch = keys.slice(i, i + PAGE);
      if (batch.length > 0) deletedKeys += Number(await redis().del(...batch));
    }
    // 5. The container itself.
    await redis().hdel(registryKey(), container);
  } else {
    await dropGrantsOf(userId);
  }
  await redis().hdel(ownersKey(), userId);

  // 6. The sign-in. Best effort: everything it could reach is gone already.
  if (opts.deleteUser) {
    try {
      await opts.deleteUser(userId);
    } catch (err) {
      console.error('Account deletion: the Clerk user could not be deleted', err instanceof Error ? err.name : err);
    }
  }
  return { disconnected, deletedKeys };
}
