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
//
// THE RECEIPT. What is stored is counted between steps 1 and 2, the way the
// download of my data would read it (lib/user-export.ts), and the steps count
// what they do, for the receipt the person is shown at the end
// (lib/deletion-receipt.ts). Counting reads and never writes, and never stops
// a deletion: a count that can't be read is null.

import { redis, containerPrefix, getItems } from './storage';
import { getContainer, isContainerId, registryKey, type ContainerId, type ContainerRecord, type Ctx } from './containers';
import { ownersKey } from './owners';
import { dropConnectionsOf } from './sharing';
import { isDemoUser } from './demo';
import { decrypt } from './crypto';
import { collectUserData, buildUserExport } from './user-export';
import type { DeletionCounts } from './deletion-receipt';

export class DeletionRefused extends Error {}

/** The sign-in could not be deleted (step 6), after everything else was.
 *  `counts` says what was, so the receipt a retry ends with can include it. */
export class SignInNotDeleted extends Error {
  constructor(
    readonly counts: DeletionCounts,
    cause: unknown
  ) {
    super('The sign-in could not be deleted', { cause });
    this.name = 'SignInNotDeleted';
  }
}

export type DeletionResult = {
  disconnected: number;
  deletedKeys: number;
  counts: DeletionCounts;
  /** Whether the account still had a container to delete. */
  found_data: boolean;
  /** An earlier attempt had already started on it: the counts are what was left. */
  resumed: boolean;
};

type StoredCounts = Pick<DeletionCounts, 'accounts' | 'transactions' | 'investment_transactions' | 'history_days'>;

/** What a container holds, counted as the download of my data reads it.
 *  Never throws: what can't be read is null, and is deleted all the same. */
async function countStored(ctx: Ctx): Promise<StoredCounts> {
  try {
    const doc = buildUserExport(await collectUserData({ ctx, userId: null }), new Date());
    const days = new Set([
      ...doc.net_worth_history.points.map((p) => p.date),
      ...doc.account_history.flatMap((s) => s.points.map((p) => p.date)),
    ]);
    return {
      accounts: doc.accounts.length + doc.manual_accounts.length,
      transactions: doc.transactions.length,
      investment_transactions: doc.investment_transactions.length,
      history_days: days.size,
    };
  } catch (err) {
    console.error('Account deletion: what was stored could not be counted', err instanceof Error ? err.name : typeof err);
    return { accounts: null, transactions: null, investment_transactions: null, history_days: null };
  }
}

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
): Promise<DeletionResult> {
  const check = await deletionCheck(userId);
  if (!check.allowed) throw new DeletionRefused(check.reason);

  const raw = await redis().hget<string>(ownersKey(), userId);
  const container = typeof raw === 'string' && isContainerId(raw) ? (raw as ContainerId) : null;
  let disconnected = 0;
  let notDisconnected = 0;
  let deletedKeys = 0;
  let stored: StoredCounts = { accounts: 0, transactions: 0, investment_transactions: 0, history_days: 0 };
  let resumed = false;

  if (container) {
    const ctx: Ctx = { container };
    const rec = await getContainer(container);
    // 1. Nothing reaches it from here on.
    if (rec && rec.status !== 'archived') {
      const archived: ContainerRecord = { ...rec, status: 'archived' };
      await redis().hset(registryKey(), { [container]: JSON.stringify(archived) });
    } else {
      // Archived already, or out of the registry: an earlier attempt got this far.
      resumed = true;
    }
    // What it holds, for the receipt, before any of it goes.
    stored = await countStored(ctx);
    // 2. Its banks.
    for (const item of await getItems(ctx)) {
      try {
        await opts.removeItem(await decrypt(item.encrypted_access_token));
        disconnected++;
      } catch (err) {
        notDisconnected++;
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
  const connectionsEnded = await dropConnectionsOf(userId);

  // 6. The sign-in.
  let signInError: unknown = null;
  let signInDeleted = false;
  try {
    if (opts.deleteUser) {
      await opts.deleteUser(userId);
      signInDeleted = true;
    }
  } catch (err) {
    signInError = err;
  }
  // 7. Late writes.
  if (container) deletedKeys += await sweep({ container });
  const counts: DeletionCounts = {
    banks_disconnected: disconnected,
    banks_not_disconnected: notDisconnected,
    ...stored,
    connections_ended: connectionsEnded,
    sign_in_deleted: signInDeleted,
  };
  if (signInError) throw new SignInNotDeleted(counts, signInError);
  return { disconnected, deletedKeys, counts, found_data: container !== null, resumed };
}
