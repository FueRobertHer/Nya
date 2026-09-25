// lib/blob-sizes.ts
//
// How much the stored transaction and investment blobs take (#58): the
// transaction store (lib/transactions.ts, "txns:<item_id>") and the investment
// store (lib/invstore.ts, "invtxns:<item_id>"), in stored characters, which are
// bytes here (base64 travels as ASCII; lib/blob.ts).
//
// Measured when asked, not recorded as blobs are written: a size recorded on
// write drifts from the blob it describes (a disconnect racing a sync, two
// syncs at once, a failed record, the re-encryption pass rewriting a blob) and
// misses every blob no write has touched since, including the one most worth
// knowing about, a blob blocked at the ceiling. Measuring reads the truth: one
// keyspace walk and one STRLEN per blob, which stays small at a few blobs per
// linked institution.
//
// Every blob is reported, including ones whose Item is no longer linked
// (orphaned: a sync that finished after a disconnect can leave one), since
// they cost the same. An Item blocked at the ceiling also carries the size its
// last write was refused at (the marker in lib/transactions.ts).
//
// This is the number a storage quota would read, and what tells you whether one
// import is about to cost an Upstash tier upgrade. Nothing enforces a quota
// yet: when one comes, the refusal path it needs (tell the user, change
// nothing) is the one the size ceiling already takes.
//
// Until the data moves into containers (PRs 10 to 13) every blob belongs to
// this deployment's container (lib/sessions.ts); the walk then follows kc().

import { redis, k, getItems } from './storage';
import { deploymentContainer } from './sessions';

export type BlobKind = 'txns' | 'invtxns';
export type ItemSizes = {
  item_id: string;
  /** Not among the linked Items: left behind, and still stored. */
  orphaned: boolean;
  txns?: number;
  invtxns?: number;
  /** The size the last transaction write was refused at, when blocked. */
  blocked_at?: number;
};
export type StorageUsage = { total_chars: number; items: ItemSizes[] };

const PAGE = 200;

/** Where each kind of blob lives, spelled out so the key-name check in
 *  test/reencrypt.test.ts can see them. */
const blobPrefixes = (): [BlobKind, string][] => [
  ['txns', k('txns:')],
  ['invtxns', k('invtxns:')],
];

/** Every key matching the pattern, once each (SCAN may repeat a key). */
async function keysMatching(pattern: string): Promise<string[]> {
  const found = new Set<string>();
  let cursor: string | number = 0;
  do {
    const [next, page] = (await redis().scan(cursor, { match: pattern, count: PAGE })) as [string | number, string[]];
    for (const key of page) found.add(key);
    cursor = next;
  } while (String(cursor) !== '0');
  return [...found];
}

function blockedChars(value: unknown): number | undefined {
  let v: any = value;
  if (typeof value === 'string') {
    try {
      v = JSON.parse(value);
    } catch {
      return undefined;
    }
  }
  return v && Number.isSafeInteger(v.chars) && v.chars >= 0 ? v.chars : undefined;
}

/** The stored size of every blob, by Item, largest first, and their total. */
export async function readStorageUsage(): Promise<StorageUsage> {
  const linked = new Set((await getItems()).map((i) => i.item_id));
  const byItem = new Map<string, ItemSizes>();
  const entry = (item_id: string) => {
    let e = byItem.get(item_id);
    if (!e) byItem.set(item_id, (e = { item_id, orphaned: !linked.has(item_id) }));
    return e;
  };

  let total = 0;
  for (const [kind, prefix] of blobPrefixes()) {
    const keys = await keysMatching(`${prefix}*`);
    const sizes = await Promise.all(keys.map((key) => redis().strlen(key)));
    keys.forEach((key, i) => {
      entry(key.slice(prefix.length))[kind] = sizes[i];
      total += sizes[i];
    });
  }

  const blockedPrefix = k('txns-blocked:');
  const blocked = await keysMatching(`${blockedPrefix}*`);
  const markers = await Promise.all(blocked.map((key) => redis().get(key)));
  blocked.forEach((key, i) => {
    const chars = blockedChars(markers[i]);
    if (chars !== undefined) entry(key.slice(blockedPrefix.length)).blocked_at = chars;
  });

  const sum = (e: ItemSizes) => (e.txns ?? 0) + (e.invtxns ?? 0);
  const items = [...byItem.values()].sort((a, b) => sum(b) - sum(a) || (a.item_id < b.item_id ? -1 : 1));
  return { total_chars: total, items };
}

/** "container <id>", for a ceiling error: which container's data would not
 *  fit. Never throws: a log line must not fail for want of it. */
export async function containerLabel(): Promise<string> {
  try {
    const dep = await deploymentContainer();
    if (dep.kind === 'container') return `container ${dep.container}`;
    return dep.kind === 'none' ? 'no container' : `an unresolved container (${dep.reason})`;
  } catch (err) {
    return `an unresolved container (${err instanceof Error ? err.name : 'error'})`;
  }
}
