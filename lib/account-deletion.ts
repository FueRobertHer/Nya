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
// THE RECEIPT. The steps count what they do, and what is stored is counted
// between steps 1 and 2, the way the download of my data reads it
// (lib/user-export.ts), for the receipt the person is shown at the end
// (lib/deletion-receipt.ts). Counting must never stand between the person and
// their banks being disconnected:
//   - it reads and never writes;
//   - it gets COUNT_LIMIT_MS, and then the deletion goes on without it (a
//     stalled read is not an error, and Upstash's client sets no timeout);
//   - it is skipped on a retry, which finds the container archived already:
//     the first attempt counted then, or ran out of time doing it, and part of
//     the store may be gone, so a count now would be wrong;
//   - a count it couldn't make is null, which the receipt shows as
//     unavailable, never as zero.
// A failure after counting carries the counts (DeletionIncomplete), so the
// receipt a retry ends with can still say what the first attempt found.

import { redis, containerPrefix, getItems } from './storage';
import { getContainer, isContainerId, registryKey, type ContainerId, type ContainerRecord, type Ctx } from './containers';
import { ownersKey } from './owners';
import { dropConnectionsOf } from './sharing';
import { isDemoUser } from './demo';
import { decrypt } from './crypto';
import { collectUserData, countAccounts, missingIds } from './user-export';
import type { DeletionCounts } from './deletion-receipt';

export class DeletionRefused extends Error {}

/** The deletion stopped after counting. `counts` says what it had done, so
 *  the receipt a retry ends with can include it. */
export class DeletionIncomplete extends Error {
  constructor(
    readonly counts: DeletionCounts,
    cause: unknown,
    message = 'The deletion stopped part way'
  ) {
    super(message, { cause });
    this.name = 'DeletionIncomplete';
  }
}

/** The sign-in could not be deleted (step 6), after everything else was. */
export class SignInNotDeleted extends DeletionIncomplete {
  constructor(counts: DeletionCounts, cause: unknown) {
    super(counts, cause, 'The sign-in could not be deleted');
    this.name = 'SignInNotDeleted';
  }
}

export type DeletionResult = {
  disconnected: number;
  deletedKeys: number;
  counts: DeletionCounts;
  /** Whether the account still had a container to delete. */
  found_data: boolean;
  /** An earlier attempt had already begun: what was stored wasn't counted again. */
  resumed: boolean;
};

type StoredCounts = Pick<DeletionCounts, 'accounts' | 'earlier_accounts' | 'transactions' | 'investment_transactions' | 'history_days'>;

/** How long counting what is stored may take before the deletion goes on
 *  without it. */
export const COUNT_LIMIT_MS = 10_000;

/** Counts that couldn't be made: shown as unavailable. */
const UNCOUNTED: StoredCounts = { accounts: null, earlier_accounts: null, transactions: null, investment_transactions: null, history_days: null };
/** No container: nothing stored. */
const NOTHING_STORED: StoredCounts = { accounts: 0, earlier_accounts: 0, transactions: 0, investment_transactions: 0, history_days: 0 };

/**
 * What a container holds, counted as the download of my data reads it, or
 * UNCOUNTED when that can't be done within `limitMs`. Never throws. Past the
 * limit the reading carries on unwatched (it only reads) and is ignored.
 */
async function countStored(ctx: Ctx, limitMs: number): Promise<StoredCounts> {
  let late = false;
  const counting = (async (): Promise<StoredCounts> => {
    try {
      const data = await collectUserData({ ctx, userId: null });
      // A day that couldn't be read is still stored, and deleted with the rest.
      const days = new Set([
        ...data.history.totals.map((p) => p.date),
        ...[...data.history.accounts.values()].flatMap((s) => s.map((p) => p.date)),
        ...missingIds(data.problems, 'net_worth_history'),
        ...missingIds(data.problems, 'account_history'),
      ]);
      const { accounts, earlier } = countAccounts(data);
      return {
        accounts,
        earlier_accounts: earlier,
        transactions: data.stores.reduce((n, s) => n + Object.keys(s.txns).length, 0),
        investment_transactions: data.investments.reduce((n, i) => n + Object.keys(i.state.txns).length, 0),
        history_days: days.size,
      };
    } catch (err) {
      if (!late) console.error('Account deletion: what was stored could not be counted', err instanceof Error ? err.name : typeof err);
      return UNCOUNTED;
    }
  })();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const limit = new Promise<StoredCounts>((resolve) => {
    timer = setTimeout(() => {
      late = true;
      console.error(`Account deletion: counting what was stored took longer than ${limitMs / 1000}s, so the receipt goes without it`);
      resolve(UNCOUNTED);
    }, limitMs);
  });
  try {
    return await Promise.race([counting, limit]);
  } finally {
    clearTimeout(timer);
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
  opts: {
    /** Removes a connection at Plaid. A connection Plaid no longer has should
     *  resolve: it is disconnected, which is what this step is for. */
    removeItem: (accessToken: string) => Promise<void>;
    deleteUser?: (userId: string) => Promise<void>;
    /** Tests shorten it. */
    countLimitMs?: number;
  }
): Promise<DeletionResult> {
  const check = await deletionCheck(userId);
  if (!check.allowed) throw new DeletionRefused(check.reason);

  const raw = await redis().hget<string>(ownersKey(), userId);
  const container = typeof raw === 'string' && isContainerId(raw) ? (raw as ContainerId) : null;
  let disconnected = 0;
  let notDisconnected = 0;
  let deletedKeys = 0;
  let connectionsEnded = 0;
  let signInDeleted = false;
  let stored = NOTHING_STORED;
  let resumed = false;
  const counts = (): DeletionCounts => ({
    banks_disconnected: disconnected,
    banks_not_disconnected: notDisconnected,
    ...stored,
    connections_ended: connectionsEnded,
    sign_in_deleted: signInDeleted,
  });

  if (container) {
    const rec = await getContainer(container);
    // 1. Nothing reaches it from here on.
    if (rec && rec.status !== 'archived') {
      const archived: ContainerRecord = { ...rec, status: 'archived' };
      await redis().hset(registryKey(), { [container]: JSON.stringify(archived) });
    } else {
      // Archived already, or out of the registry: an earlier attempt got this far.
      resumed = true;
    }
    // What it holds, for the receipt, before any of it goes; never again on a
    // retry (see the header).
    stored = resumed ? UNCOUNTED : await countStored({ container }, opts.countLimitMs ?? COUNT_LIMIT_MS);
  }
  try {
    if (container) {
      const ctx: Ctx = { container };
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
    connectionsEnded = await dropConnectionsOf(userId);
  } catch (err) {
    throw new DeletionIncomplete(counts(), err);
  }

  // 6. The sign-in.
  let signInError: unknown = null;
  try {
    if (opts.deleteUser) {
      await opts.deleteUser(userId);
      signInDeleted = true;
    }
  } catch (err) {
    signInError = err;
  }
  // 7. Late writes.
  try {
    if (container) deletedKeys += await sweep({ container });
  } catch (err) {
    throw new DeletionIncomplete(counts(), err);
  }
  if (signInError) throw new SignInNotDeleted(counts(), signInError);
  return { disconnected, deletedKeys, counts: counts(), found_data: container !== null, resumed };
}
