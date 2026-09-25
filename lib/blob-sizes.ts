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
// Measured for one container: the walk covers only its keys (kc()).

import { redis, kc, getItems } from './storage';
import type { Ctx } from './containers';
import { deploymentContainer } from './sessions';
import { maxBlobChars } from './blob';

export type BlobKind = 'txns' | 'invtxns';
export type ItemSizes = {
  item_id: string;
  /** Not among the linked Items: left behind, and still stored. */
  orphaned: boolean;
  txns?: number;
  invtxns?: number;
  /** The size the last transaction write was refused at, when it was. */
  blocked_at?: number;
  /** Whether that size is still over the ceiling. False after the ceiling
   *  was raised: the marker clears on the Item's next sync. */
  blocked?: boolean;
};
export type StorageUsage = { total_chars: number; items: ItemSizes[] };

const PAGE = 200;

/** Where each kind of blob lives, spelled out so the key-name check in
 *  test/reencrypt.test.ts can see them. */
const blobPrefixes = (ctx: Ctx): [BlobKind, string][] => [
  ['txns', kc(ctx, 'txns:')],
  ['invtxns', kc(ctx, 'invtxns:')],
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
export async function readStorageUsage(ctx: Ctx): Promise<StorageUsage> {
  const byItem = new Map<string, ItemSizes>();
  const entry = (item_id: string) => {
    let e = byItem.get(item_id);
    if (!e) byItem.set(item_id, (e = { item_id, orphaned: false }));
    return e;
  };

  let total = 0;
  for (const [kind, prefix] of blobPrefixes(ctx)) {
    const keys = await keysMatching(`${prefix}*`);
    const sizes = await Promise.all(keys.map((key) => redis().strlen(key)));
    keys.forEach((key, i) => {
      // Deleted between the walk and the measure: a real blob is never empty.
      if (sizes[i] <= 0) return;
      entry(key.slice(prefix.length))[kind] = sizes[i];
      total += sizes[i];
    });
  }

  const blockedPrefix = kc(ctx, 'txns-blocked:');
  const blocked = await keysMatching(`${blockedPrefix}*`);
  const markers = await Promise.all(blocked.map((key) => redis().get(key)));
  blocked.forEach((key, i) => {
    const chars = blockedChars(markers[i]);
    if (chars === undefined) return;
    const e = entry(key.slice(blockedPrefix.length));
    e.blocked_at = chars;
    e.blocked = chars > maxBlobChars();
  });

  // Read after the walk, not before: an Item linked while it ran would
  // otherwise be called orphaned. A disconnect during it is reported as one.
  const linked = new Set((await getItems(ctx)).map((i) => i.item_id));
  for (const e of byItem.values()) e.orphaned = !linked.has(e.item_id);

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
