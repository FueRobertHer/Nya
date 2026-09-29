// lib/account-deletion.ts
//
// Deleting an account and everything it owns (#44): the person's own choice,
// from the app. In order, each step safe to repeat, so a deletion that stops
// part way is finished by running it again:
//
//   1. its container is marked archived: from then on nothing reaches it (its
//      own requests, the snapshot cron, anyone it shared with);
//   2. each of its banks is disconnected at Plaid (a failure there is logged
//      and the rest goes on, as with /api/disconnect; the connection is then
//      left at Plaid, which ends it only once its token stops being used);
//   3. every key in the container is deleted;
//   4. the container leaves the registry and the account leaves the owners map;
//   5. every connection it is in is removed, and with it all sharing both
//      ways (after 4, so nothing can reach the account meanwhile);
//   6. the Clerk user is deleted; if that fails the deletion reports it, and
//      running it again retries just this;
//   7. the container is swept once more, for anything a request already in
//      flight wrote after step 3.
//
// The primary container (the first, the owner's) is never deleted from here:
// background jobs without a signed-in account use it, and with it gone they
// would have no rule left to pick one.
//
// Nightly backups (lib/backup.ts) still hold the data until they age out.

import { redis, containerPrefix, getItems } from './storage';
import { getContainer, isContainerId, registryKey, type ContainerId, type ContainerRecord, type Ctx } from './containers';
import { ownersKey } from './owners';
import { dropConnectionsOf } from './sharing';
import { isDemoUser } from './demo';
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

async function sweep(ctx: Ctx): Promise<number> {
  const keys = await keysIn(ctx);
  let deleted = 0;
  for (let i = 0; i < keys.length; i += PAGE) deleted += Number(await redis().del(...keys.slice(i, i + PAGE)));
  return deleted;
}

/** What deleting this account would remove, or why it can't be deleted. */
export async function deletionCheck(userId: string): Promise<{ allowed: true } | { allowed: false; reason: string }> {
  if (isDemoUser(userId)) return { allowed: false, reason: 'This is a demo account, shared by everyone who tries the app. It can’t be deleted.' };
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
    // 2. Its banks.
    for (const item of await getItems(ctx)) {
      try {
        await opts.removeItem(await decrypt(item.encrypted_access_token));
        disconnected++;
      } catch (err) {
        console.error('Account deletion: a bank could not be disconnected at Plaid', err instanceof Error ? err.name : err);
      }
    }
    // 3. Everything it stored.
    deletedKeys += await sweep(ctx);
    // 4. The container itself.
    await redis().hdel(registryKey(), container);
  }
  await redis().hdel(ownersKey(), userId);
  // 5. Sharing, both ways.
  await dropConnectionsOf(userId);

  // 6. The sign-in.
  let signInError: unknown = null;
  try {
    await opts.deleteUser?.(userId);
  } catch (err) {
    signInError = err;
  }
  // 7. Late writes.
  if (container) deletedKeys += await sweep({ container });
  if (signInError) throw signInError;
  return { disconnected, deletedKeys };
}
