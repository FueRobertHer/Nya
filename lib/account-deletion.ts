// lib/account-deletion.ts
//
// Deleting an account and everything it owns (#44): the person's own choice,
// from the app. In order, each step safe to repeat, so a deletion that stops
// part way is finished by running it again:
//
//   1. its container is marked archived: from then on nothing reaches it (its
//      own requests, the snapshot cron, anyone it shared with);
//   2. what it holds is counted, and what its map entry says of its data key
//      is read, for the receipt (below);
//   3. each of its banks is disconnected at Plaid (a failure there is logged
//      and the rest goes on, as with /api/disconnect; the connection is then
//      left at Plaid, which ends it only once its token stops being used);
//   4. every key in the container is deleted;
//   5. the container leaves the registry;
//   6. its data key is destroyed (lib/crypto.ts destroyContainerKeys): every
//      key whose record names it goes, with a tombstone for each, its map
//      entry becomes a marker, and none is left. After 3, which decrypts each
//      bank's token with it, and before 7, which is how a deletion that
//      stopped part way finds its container again;
//   7. the account's owners entry becomes a marker (lib/owners.ts
//      DELETION_MARKER), which owned() refuses, so a request from another tab
//      can't get the account a new container meanwhile;
//   8. every connection it is in is removed, and with it all sharing both
//      ways (after 5, so nothing can reach the account meanwhile);
//   9. the Clerk user is deleted, and then the owners marker; if the first
//      fails the deletion reports it, and running it again retries just this;
//  10. the container is swept once more, for anything a request already in
//      flight wrote after step 4;
//  11. every kept key archive is rewritten without the destroyed key
//      (lib/key-archive.ts), or, if that can't be done in its time, left for
//      the next nightly backup, which the receipt says; and the backup folder
//      is listed for any archive an older version of Nya took after the key
//      was made (a rollback's, which holds the key itself), so the receipt
//      says so even when the nightly run hasn't noted it yet.
//
// The primary container (the first, the owner's) is never deleted from here:
// background jobs without a signed-in account use it, and with it gone they
// would have no rule left to pick one.
//
// Nightly backups (lib/backup.ts) still hold the data until they age out:
// what is under the destroyed key unreadably once step 11 is done (unless a
// rollback's archive holds the key), and what is under a key shared by
// everyone on this copy (k0 or an environment key) readably, which the
// receipt dates from the map entry read at step 2. The nightly run sweeps a
// destroyed container's prefix once more the night after
// (sweepDestroyedContainers), for a write that came later still.
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
import { ownersKey, ownersOf, DELETION_MARKER } from './owners';
import { dropConnectionsOf } from './sharing';
import { isDemoUser } from './demo';
import { decrypt, destroyContainerKeys, readContainerEntries, readContainerEntry, readTombstones, updateContainerEntry, ContainerKeyError, type ContainerKeyEntry } from './crypto';
import { listFormat1Archives, newestHoldingKey, rewriteKeyArchivesAfterDeletion, type BackupStore } from './backup';
import { collectUserData, countAccounts, missingIds } from './user-export';
import type { DeletionCounts, ReceiptKeys } from './deletion-receipt';

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
  /** What the receipt says of its data key; null with no container. */
  keys: ReceiptKeys | null;
};

/**
 * What a container's map entry, read before its key is destroyed, says for
 * the receipt: whether its data was under a key of its own, and the latest
 * time a copy can have held it under a key shared by everyone on this copy.
 *   - no key of its own: everything was, up to the deletion;
 *   - one made by the migration pass: up to when the pass found nothing left
 *     to move (`moved`), or the deletion if it never did, or later if a
 *     nightly archive found a value under a shared key since (`shared_in`);
 *   - one it was born with (`moved` its `since`): only what a nightly archive
 *     found, if any.
 * And, from `format1` (when each format-1 archive in the backup folder was
 * taken, oldest first; null when it couldn't be listed), the newest taken
 * after its key was made (`key_in`), which holds the key itself. One the
 * nightly run hasn't noted in the entry yet (a rollback since its last run)
 * counts as it would have: `moved` no longer stands, since the release
 * before may have written values under a shared key meanwhile; and so does
 * a folder that couldn't be listed.
 * `entry` undefined: it couldn't be read (an earlier attempt destroyed it):
 * whether there was a key is told by the tombstones, and the dates are the
 * deletion's and the newest format-1 archive's, as if nothing said otherwise.
 */
export function keyFactsOf(entry: ContainerKeyEntry | null | undefined, hadTombstone: boolean, now: Date, format1: string[] | null): Omit<ReceiptKeys, 'key_backups'> {
  const at = now.toISOString();
  if (entry === undefined || (entry !== null && 'destroyed' in entry)) {
    return { own_key: hadTombstone ? true : null, shared_from: at, key_in: format1 === null ? 'unchecked' : (format1.at(-1) ?? null) };
  }
  if (entry === null) return { own_key: false, shared_from: at, key_in: null };
  const keyIn = format1 === null ? 'unchecked' : (newestHoldingKey(format1, entry.since) ?? null);
  const unnoted = keyIn === 'unchecked' || (keyIn !== null && (entry.key_in === undefined || Date.parse(keyIn) > Date.parse(entry.key_in)));
  const moved = unnoted ? undefined : entry.moved;
  const born = moved !== undefined && moved === entry.since;
  const fromPass = born ? null : (moved ?? at);
  const latest = [fromPass, entry.shared_in ?? null].filter((t): t is string => t !== null).sort().at(-1) ?? null;
  return { own_key: true, shared_from: latest, key_in: keyIn };
}

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

/** Every key in a container, by its name inside it (without the
 *  environment's prefix and the container's), for a restore's scan of
 *  whether an account is empty (lib/user-restore/empty.ts). A SCAN of the
 *  whole keyspace, page by page: call it only where it is counted. */
export async function containerKeys(ctx: Ctx): Promise<string[]> {
  const prefix = containerPrefix(ctx);
  return (await keysIn(ctx)).filter((k) => k.startsWith(prefix)).map((k) => k.slice(prefix.length));
}

/** Deletes every key in a container but those `keep` names (by its name
 *  inside the container), as the sweep above does, for a restore's undo and
 *  its emptying of an account (lib/user-restore/undo.ts). Returns how many
 *  it deleted. */
export async function sweepContainerExcept(ctx: Ctx, keep: (key: string) => boolean): Promise<number> {
  const prefix = containerPrefix(ctx);
  const keys = (await keysIn(ctx)).filter((k) => k.startsWith(prefix) && !keep(k.slice(prefix.length)));
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
    // A container the owners mapping gives to another account too (edited by
    // hand, docs/authentication.md): deleting it would take that account's
    // data, and its key, with this one's.
    if ((await ownersOf(id as ContainerId)).some((other) => other !== userId)) {
      return { allowed: false, reason: 'This account’s data belongs to another sign-in too, so it can’t be deleted from the app. Ask whoever runs this copy of Nya.' };
    }
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
    /** Where the key archives are kept (lib/backup.ts vercelBlobStore), or
     *  null where none are: step 11. */
    keyArchives?: BackupStore | null;
  }
): Promise<DeletionResult> {
  const check = await deletionCheck(userId);
  if (!check.allowed) throw new DeletionRefused(check.reason);

  const raw = await redis().hget<string>(ownersKey(), userId);
  // The marker step 7 leaves: everything up to it is done.
  const marked = typeof raw === 'string' && raw.startsWith(DELETION_MARKER) && isContainerId(raw.slice(DELETION_MARKER.length));
  const container = typeof raw === 'string' && isContainerId(raw) ? (raw as ContainerId) : marked ? (raw.slice(DELETION_MARKER.length) as ContainerId) : null;
  let disconnected = 0;
  let notDisconnected = 0;
  let deletedKeys = 0;
  let connectionsEnded = 0;
  let signInDeleted = false;
  let stored = NOTHING_STORED;
  let resumed = false;
  let entryRead: KeyEntryRead | null = null;
  const counts = (): DeletionCounts => ({
    banks_disconnected: disconnected,
    banks_not_disconnected: notDisconnected,
    ...stored,
    connections_ended: connectionsEnded,
    sign_in_deleted: signInDeleted,
  });

  if (container && !marked) {
    const rec = await getContainer(container);
    // 1. Nothing reaches it from here on.
    if (rec && rec.status !== 'archived') {
      const archived: ContainerRecord = { ...rec, status: 'archived' };
      await redis().hset(registryKey(), { [container]: JSON.stringify(archived) });
    } else {
      // Archived already, or out of the registry: an earlier attempt got this far.
      resumed = true;
    }
    // 2. What it holds, for the receipt, before any of it goes; never again
    // on a retry (see the header). And what its map entry says of its key.
    stored = resumed ? UNCOUNTED : await countStored({ container }, opts.countLimitMs ?? COUNT_LIMIT_MS);
    entryRead = await readKeyEntry(container);
  }
  try {
    if (container && !marked) {
      const ctx: Ctx = { container };
      // 3. Its banks.
      for (const item of await getItems(ctx)) {
        try {
          await opts.removeItem(await decrypt(ctx, item.encrypted_access_token));
          disconnected++;
        } catch (err) {
          notDisconnected++;
          console.error('Account deletion: a bank could not be disconnected at Plaid', err instanceof Error ? err.name : err);
        }
      }
      // 4. Everything it stored.
      deletedKeys += await sweep(ctx);
      // 5. The container itself.
      await redis().hdel(registryKey(), container);
      // 6. Its data key: only now, once nothing needs it.
      await destroyContainerKeys(ctx);
      // 7. The account can't be given a container while the rest runs.
      await redis().hset(ownersKey(), { [userId]: `${DELETION_MARKER}${container}` });
    } else if (!container) {
      await redis().hdel(ownersKey(), userId);
    }
    // 8. Sharing, both ways.
    connectionsEnded = await dropConnectionsOf(userId);
  } catch (err) {
    throw new DeletionIncomplete(counts(), err);
  }

  // 9. The sign-in, then the marker.
  let signInError: unknown = null;
  try {
    if (opts.deleteUser) {
      await opts.deleteUser(userId);
      signInDeleted = true;
    }
    if (container && (signInDeleted || !opts.deleteUser)) await redis().hdel(ownersKey(), userId);
  } catch (err) {
    signInError = err;
  }
  // 10. Late writes.
  try {
    if (container) deletedKeys += await sweep({ container });
  } catch (err) {
    throw new DeletionIncomplete(counts(), err);
  }
  // 11. The key archives, last, and any archive an older version took that
  // holds the key. Never fails the deletion: the key is gone from the
  // database, and the nightly run rewrites them if this can't.
  let keys: ReceiptKeys | null = null;
  if (container) {
    const store = opts.keyArchives ?? null;
    const keyBackups = await rewriteKeyArchivesAfterDeletion(store, container);
    // No store, no backups: nothing an older version took is kept either.
    const format1 = store ? await listFormat1Archives(store) : [];
    const read = entryRead ?? (await readKeyEntry(container));
    keys = { ...keyFactsOf(read.entry, read.hadTombstone, new Date(), format1), key_backups: keyBackups };
  }
  if (signInError) throw new SignInNotDeleted(counts(), signInError);
  return { disconnected, deletedKeys, counts: counts(), found_data: container !== null && !marked, resumed, keys };
}

/** Whether the account's data is under a key of its own, for the page that
 *  offers to delete it; null when that can't be read. Never throws: it only
 *  words the page. */
export async function ownKeyOf(userId: string): Promise<boolean | null> {
  try {
    const container = await redis().hget<string>(ownersKey(), userId);
    if (typeof container !== 'string' || !isContainerId(container)) return null;
    const entry = await readContainerEntry(container);
    return entry !== null && 'key' in entry;
  } catch {
    return null;
  }
}

type KeyEntryRead = { entry: ContainerKeyEntry | null | undefined; hadTombstone: boolean };

/** The container's map entry, and whether a tombstone names it, for the
 *  receipt (keyFactsOf). Never throws: a read that fails says nothing. */
async function readKeyEntry(container: ContainerId): Promise<KeyEntryRead> {
  let entry: ContainerKeyEntry | null | undefined;
  try {
    entry = await readContainerEntry(container);
  } catch {
    entry = undefined;
  }
  let hadTombstone = false;
  try {
    for (const t of (await readTombstones()).values()) if (t.container === container) hadTombstone = true;
  } catch {
    hadTombstone = false;
  }
  return { entry, hadTombstone };
}

/**
 * The night after a deletion, every destroyed container's prefix is swept
 * once more, for anything written there later still (a request in flight on
 * an instance that held the key, a count, a snapshot's outcome), and its map
 * entry says so (`swept`). Never one the registry lists. Answers the
 * containers swept.
 */
export async function sweepDestroyedContainers(now: Date = new Date()): Promise<string[]> {
  const today = now.toISOString().slice(0, 10);
  const swept: string[] = [];
  for (const [container, entry] of await readContainerEntries()) {
    if (entry instanceof ContainerKeyError || !('destroyed' in entry) || entry.swept !== undefined || entry.destroyed >= today) continue;
    if (!isContainerId(container) || (await getContainer(container as ContainerId))) continue;
    await sweep({ container: container as ContainerId });
    await updateContainerEntry(container, (e) => (e && 'destroyed' in e && e.swept === undefined ? { destroyed: e.destroyed, swept: today } : null));
    swept.push(container);
  }
  return swept;
}
