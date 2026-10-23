// lib/container-key-ops.ts
//
// What the operator sees of the data keys per container, and destroying a
// container's keys by hand (app/api/ops/container-keys; docs/operations.md,
// "Per-container data keys"). Reads the registry, the map, the key store and
// the newest key archive; names containers, key ids and counts, never a key.
//
// Nothing here destroys a key on its own: a registry read wrongly, or
// restored with --replace-registry, must never cost a living container its
// key. Destroying is asked for by container id, and done only for a
// container the registry no longer lists, the way a deletion does it.

import { listContainers, isContainerId, type ContainerId } from './containers';
import {
  readContainerEntries,
  readKeyRecords,
  readTombstones,
  readKeyCounter,
  destroyContainerKeys,
  MAX_KEY_NUMBER,
  MasterKeyError,
  ContainerKeyError,
} from './crypto';
import { listGenerations, verifyKeyArchive } from './key-archive';
import { keysPending, rewriteKeyArchivesAfterDeletion, type BackupStore } from './backup';

/** At most this many ids in each list of the status; the counts are whole. */
const LISTED = 200;

const capped = (ids: string[]) => ({ count: ids.length, ids: ids.slice(0, LISTED) });

export type ContainerKeyStatus = {
  /** Active containers with a key of their own, and how many are moved. */
  with_key: { count: number; moved: number };
  /** Active containers without one: the migration pass gives them one. */
  without_key: { count: number; ids: string[] };
  /** Active containers with a key, not yet moved: values may still be under
   *  a shared key. */
  not_moved: { count: number; ids: string[] };
  /** Keys whose record names a container the registry no longer lists: an
   *  account the release before deleted, say. destroy_keys_of destroys
   *  them. */
  orphaned_keys: { count: number; ids: string[]; containers: string[] };
  /** Map entries naming a key the key store doesn't hold. */
  entries_missing_key: { count: number; ids: string[] };
  /** Map entries that can't be read. */
  unreadable_entries: { count: number; ids: string[] };
  /** Keys the newest key archive carries forward (missing from the store,
   *  never tombstoned); null when no key archive could be read. */
  carried_forward: { count: number; ids: string[] } | null;
  tombstones: number;
  /** The key counter, and how far it is from the most the id format takes. */
  key_numbers: { next: number | null; max: number; left: number | null };
  /** A deletion left the key archives for the next nightly run: since when,
   *  and the containers waiting. */
  key_archives_pending: { since: string; containers: string[] } | null;
};

/** The status, from one read of each store. */
export async function containerKeyStatus(store: BackupStore | null): Promise<ContainerKeyStatus> {
  const [registry, entries, records, tombstones, seq, pending] = await Promise.all([
    listContainers(),
    readContainerEntries(),
    readKeyRecords(),
    readTombstones(),
    readKeyCounter(),
    keysPending(),
  ]);
  const active = registry.filter((c) => c.status === 'active').map((c) => c.id as string);
  const registered = new Set(registry.map((c) => c.id as string));
  const withKey: string[] = [];
  const moved: string[] = [];
  const without: string[] = [];
  const notMoved: string[] = [];
  const missingKey: string[] = [];
  const unreadable: string[] = [];
  for (const id of active) {
    const e = entries.get(id);
    if (e instanceof ContainerKeyError) {
      unreadable.push(id);
      continue;
    }
    if (!e || !('key' in e)) {
      without.push(id);
      continue;
    }
    withKey.push(id);
    if (e.moved) moved.push(id);
    else notMoved.push(id);
  }
  for (const [id, e] of entries) {
    if (e instanceof ContainerKeyError) {
      if (!active.includes(id)) unreadable.push(id);
      continue;
    }
    if ('key' in e && !records.has(e.key)) missingKey.push(id);
  }
  const orphaned: string[] = [];
  const orphanContainers = new Set<string>();
  for (const [keyId, r] of records) {
    if (r instanceof MasterKeyError || r.container === undefined) continue;
    if (!registered.has(r.container)) {
      orphaned.push(keyId);
      orphanContainers.add(r.container);
    }
  }
  let carried: ContainerKeyStatus['carried_forward'] = null;
  if (store) {
    try {
      const { generations } = await listGenerations(store);
      if (generations.length > 0) {
        const text = await store.get(generations[0].pathname);
        if (text !== null) carried = capped([...verifyKeyArchive(text).keys].filter(([, e]) => e.missing_since !== undefined).map(([id]) => id).sort());
      } else carried = capped([]);
    } catch {
      carried = null;
    }
  }
  return {
    with_key: { count: withKey.length, moved: moved.length },
    without_key: capped(without.sort()),
    not_moved: capped(notMoved.sort()),
    orphaned_keys: { ...capped(orphaned.sort()), containers: [...orphanContainers].sort().slice(0, LISTED) },
    entries_missing_key: capped(missingKey.sort()),
    unreadable_entries: capped([...new Set(unreadable)].sort()),
    carried_forward: carried,
    tombstones: tombstones.size,
    key_numbers: { next: seq === null ? null : seq + 1, max: MAX_KEY_NUMBER, left: seq === null ? null : Math.max(0, MAX_KEY_NUMBER - seq) },
    key_archives_pending: pending,
  };
}

export type DestroyOutcome = { container: string; destroyed: string[] } | { container: string; refused: string };

/**
 * Destroys the keys of each container named, each only if the registry no
 * longer lists it, then rewrites the key archives without them (or leaves
 * that to the next nightly backup). Answers what each came to.
 */
export async function destroyKeysOf(
  ids: string[],
  store: BackupStore | null
): Promise<{ results: DestroyOutcome[]; key_backups: Awaited<ReturnType<typeof rewriteKeyArchivesAfterDeletion>> | null }> {
  const registered = new Set((await listContainers()).map((c) => c.id as string));
  const results: DestroyOutcome[] = [];
  for (const id of ids) {
    if (!isContainerId(id)) {
      results.push({ container: id, refused: 'not a container id' });
      continue;
    }
    if (registered.has(id)) {
      results.push({ container: id, refused: 'the registry still lists it, so its keys were not destroyed' });
      continue;
    }
    const { destroyed } = await destroyContainerKeys({ container: id as ContainerId });
    results.push({ container: id, destroyed });
  }
  const any = results.some((r) => 'destroyed' in r && r.destroyed.length > 0);
  const key_backups = any ? await rewriteKeyArchivesAfterDeletion(store, results.find((r) => 'destroyed' in r)!.container) : null;
  return { results, key_backups };
}
