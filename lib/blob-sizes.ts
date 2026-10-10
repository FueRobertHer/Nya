// lib/blob-sizes.ts
//
// How much a container stores where it can grow large (#58), in stored
// characters, which are bytes here (base64 travels as ASCII; lib/blob.ts):
//   - the transaction and investment blobs, per Item: the transaction store
//     (lib/transactions.ts, "txns:<item_id>") and the investment store
//     (lib/invstore.ts, "invtxns:<item_id>");
//   - every store on the storage seam that holds something (lib/stores.ts),
//     by the seam's own measure (StoreSize in lib/repo.ts): the books of
//     transactions on manual accounts, the records of file imports, holdings
//     history, what was said about transactions, and the rest. Each with its
//     largest value, the one nearest the ceiling: a write is held to it one
//     request at a time, so one manual account's book, one month of holdings,
//     or one import's records, never the store whole.
// NOT the older stores kept as hashes (balance history, manual accounts,
// categories, renames, links, the account directory) nor the caches: neither
// total here is the container's whole size.
//
// Measured when asked, not recorded as blobs are written: a recorded size drifts
// from the blob it describes (a disconnect racing a sync, a failed record, the
// re-encryption pass rewriting a blob) and misses every blob no write has touched
// since, including the one most worth knowing about, a blob blocked at the
// ceiling. Measuring reads the truth with one keyspace walk and one STRLEN per
// blob, which stays small at a few blobs per linked institution.
//
// Every blob is reported, including ones whose Item is no longer linked
// (orphaned: a sync that finished after a disconnect can leave one), since they
// cost the same. An Item blocked at the ceiling also carries the size its last
// write was refused at (the marker in lib/transactions.ts).
//
// A storage quota would read these numbers, and the older stores' too, which
// this does not measure yet. Nothing enforces a quota; when one comes, the
// refusal path it needs (tell the user, change nothing) is the one the size
// ceiling already takes. Measured for one container: the walk covers only its
// keys (kc()), and each store measures its own key in it.

import { redis, kc, getItems } from './storage';
import type { Ctx } from './containers';
import { maxBlobChars } from './blob';
import { declaredStores } from './stores';
import type { MapStore, Store, ValueStore } from './repo';

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
/** One store on the seam, as measured (MapStore.size, ValueStore.size). */
export type StoreUsage = {
  /** Its name: the key family it is stored under. */
  store: string;
  /** What it holds, as declared. */
  what: string;
  /** Entries stored, readable or not: 1 for a value store. */
  entries: number;
  /** Characters stored, ids and values together. */
  chars: number;
  /** Its largest value, the one nearest the ceiling: its id (null for a
   *  value store's one value) and characters. */
  largest_id: string | null;
  largest_chars: number;
};
/** `total_chars` is the Items' blobs' total, `stores_chars` the seam
 *  stores': neither is the container's whole size (see the header). */
export type StorageUsage = { total_chars: number; items: ItemSizes[]; stores_chars: number; stores: StoreUsage[] };

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
  const stores = await readStoreSizes(ctx);
  return { total_chars: total, items, stores_chars: stores.reduce((n, s) => n + s.chars, 0), stores };
}

const measurable = (s: Store): s is ValueStore<unknown> | MapStore<unknown> => s.kind === 'value' || s.kind === 'map';

/** Every store on the seam that holds something, largest first, one request
 *  each. Counter stores are left out: a count is the service's bookkeeping,
 *  a few characters that never grow. */
async function readStoreSizes(ctx: Ctx): Promise<StoreUsage[]> {
  const measured = await Promise.all(declaredStores().filter(measurable).map(async (s) => ({ s, size: await s.size(ctx) })));
  return measured
    .flatMap(({ s, size }): StoreUsage[] =>
      size.largest
        ? [{ store: s.name, what: s.what, entries: size.entries, chars: size.chars, largest_id: size.largest.id, largest_chars: size.largest.chars }]
        : []
    )
    .sort((a, b) => b.chars - a.chars || (a.store < b.store ? -1 : 1));
}
