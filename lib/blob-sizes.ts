// lib/blob-sizes.ts
//
// How much each Item's stored blobs take (#58): the transaction store
// (lib/transactions.ts) and the investment store (lib/invstore.ts), in stored
// characters, which are bytes here (base64 travels as ASCII; lib/blob.ts).
// Recorded on every write that lands, removed when the Item is disconnected.
//
// This is the number a storage quota would read, and what tells you whether one
// import is about to cost an Upstash tier upgrade. Nothing enforces a quota
// yet: when one comes, the refusal path it needs (tell the user, change
// nothing) is the one the size ceiling already takes.
//
// Kept beside the blobs it describes, under the same (still unscoped) keys, so
// it moves with them when the data moves into containers (PRs 10 to 13). Until
// then every Item belongs to this deployment's container (lib/sessions.ts),
// which is the container the totals are reported for.
//
// Best effort: a failed record never fails the write it describes. A size can
// lag the blob by one write, never by more.

import { redis, k } from './storage';
import { deploymentContainer } from './sessions';

export type BlobKind = 'txns' | 'invtxns';
export type BlobSize = { chars: number; at: string };
export type ItemSizes = { item_id: string } & Partial<Record<BlobKind, BlobSize>>;
export type StorageUsage = { total_chars: number; items: ItemSizes[] };

const KINDS: readonly BlobKind[] = ['txns', 'invtxns'];

function sizesKey(): string {
  return k('blob-sizes');
}

const field = (kind: BlobKind, item_id: string) => `${kind}:${item_id}`;

/** Records the size of a blob just written. Never throws. */
export async function recordBlobSize(kind: BlobKind, item_id: string, chars: number, now: number = Date.now()): Promise<void> {
  try {
    const size: BlobSize = { chars, at: new Date(now).toISOString() };
    await redis().hset(sizesKey(), { [field(kind, item_id)]: JSON.stringify(size) });
  } catch (err) {
    console.warn(`blob-sizes: could not record the ${kind} size for ${item_id}`, err instanceof Error ? err.name : err);
  }
}

/** Forgets a blob's size, when the blob itself is deleted. Never throws. */
export async function forgetBlobSize(kind: BlobKind, item_id: string): Promise<void> {
  try {
    await redis().hdel(sizesKey(), field(kind, item_id));
  } catch (err) {
    console.warn(`blob-sizes: could not forget the ${kind} size for ${item_id}`, err instanceof Error ? err.name : err);
  }
}

function parseSize(value: unknown): BlobSize | null {
  let v: any = value;
  if (typeof value === 'string') {
    try {
      v = JSON.parse(value);
    } catch {
      return null;
    }
  }
  if (!v || typeof v !== 'object' || !Number.isSafeInteger(v.chars) || v.chars < 0 || typeof v.at !== 'string') return null;
  return { chars: v.chars, at: v.at };
}

/** Every recorded size, by Item, largest first, and their total. An entry
 *  that cannot be read is left out rather than failing the rest. */
export async function readStorageUsage(): Promise<StorageUsage> {
  const all = ((await redis().hgetall(sizesKey())) ?? {}) as Record<string, unknown>;
  const byItem = new Map<string, ItemSizes>();
  let total = 0;
  for (const [f, value] of Object.entries(all)) {
    const sep = f.indexOf(':');
    const kind = f.slice(0, sep) as BlobKind;
    const item_id = f.slice(sep + 1);
    const size = parseSize(value);
    if (sep < 0 || !KINDS.includes(kind) || !item_id || !size) continue;
    const entry = byItem.get(item_id) ?? { item_id };
    entry[kind] = size;
    byItem.set(item_id, entry);
    total += size.chars;
  }
  const sum = (e: ItemSizes) => KINDS.reduce((n, kind) => n + (e[kind]?.chars ?? 0), 0);
  const items = [...byItem.values()].sort((a, b) => sum(b) - sum(a) || (a.item_id < b.item_id ? -1 : 1));
  return { total_chars: total, items };
}

/** "container <id>", for a ceiling error: which container's data would not
 *  fit. Never throws: a log line must not fail for want of it. */
export async function containerLabel(): Promise<string> {
  try {
    const dep = await deploymentContainer();
    if (dep.kind === 'container') return `container ${dep.container}`;
    return dep.kind === 'none' ? 'no container' : 'an unresolved container';
  } catch {
    return 'an unresolved container';
  }
}
