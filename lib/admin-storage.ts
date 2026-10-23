// lib/admin-storage.ts
//
// The admin's view of storage across every account on the deployment (the
// plan's "admin view of Items and blob size per container", so a costly
// account shows up): for each container, by its opaque id, its Plaid Items
// and their state, its connections to SimpleFIN or Lunch Flow, each Item's
// stored transaction blobs against the size ceiling (MAX_TXN_BLOB_CHARS,
// lib/blob.ts), what it stores in all, and its last daily snapshot.
//
// WHO: the admin alone, decided as lib/admin-items.ts decides (adminCtx);
// the route answers anyone else with the same 404 as a route that does not
// exist (app/api/admin/storage).
//
// NOTHING OF ANYONE'S DATA IS READ. Each container is measured through the
// storage seam (lib/repo.ts measureContainer) without even the heads of its
// values: sizes and counts only. Beside that, three plain-text records are
// read: the Items' records (each bank's name, Plaid's ids, whether Plaid
// included transactions; the access token in each is never decrypted), the
// last check of each Item (lib/item-usage.ts) and the snapshot's runs
// (lib/snapshot-job.ts). Nothing is decrypted, nothing is written, and no
// person's name or email address is shown: an account is its random id, and
// "You" for the admin's own.
//
// CHEAP, a page at a time: containers in id order after a cursor (`after`),
// at most MAX_PAGE a request, measured a few at once. Each measure walks the
// keyspace (SCAN with MATCH), which is what the page costs.
//
// LENIENT, for display only: nothing writes, deletes or records anything on
// it. A part of a container that can't be read is null, said as such, never
// zero; one container failing costs the others nothing.

import { listContainers, type Ctx, type ContainerId, type ContainerStatus } from './containers';
import { measureContainer, type ContainerMeasure } from './repo';
import { getItems, type StoredItem } from './storage';
import { readUsage, type Usage } from './item-usage';
import { readRuns, type RunRecord } from './snapshot-job';
import { maxBlobChars } from './blob';

/** Containers per request, at most, and by default. */
export const MAX_PAGE = 50;
export const DEFAULT_PAGE = 20;
/** Containers measured at once. */
const AT_ONCE = 4;

/** One Plaid Item of a container, as stored. */
export type AdminItem = {
  item_id: string;
  institution_name: string;
  /** Whether Plaid billed Transactions on it when it was linked; null when
   *  the lookup failed, and absent from Items linked before it was kept. */
  transactions_billed: boolean | null;
  /** Its stored blobs' sizes (0 for none). */
  txns_chars: number;
  invtxns_chars: number;
  /** A transaction save was refused for its size (its marker is there; it
   *  clears on the Item's next sync that fits). */
  blocked: boolean;
  /** Its last transaction save failed. */
  unsaved: boolean;
  /** The last check of it (lib/item-usage.ts), or null when there is none. */
  usage: { flagged: 'refused' | 'hidden' | null; refused_since: string | null; hidden_since: string | null; checked_at: string | null } | null;
};

export type AdminContainer = {
  container: string;
  /** The admin's own. */
  you: boolean;
  status: ContainerStatus;
  created_at: string;
  /** Null where the container couldn't be walked. */
  storage: {
    keys: number;
    total_chars: number;
    /** The largest single value anywhere in it: the one nearest the ceiling. */
    largest_chars: number;
    /** Keys found that couldn't be measured: their sizes are not in the
     *  total, which is then a floor. */
    unmeasured: number;
  } | null;
  /** Null where the Items' records couldn't be read. */
  items: AdminItem[] | null;
  /** Blobs whose Item is no longer linked: they cost the same. */
  orphaned: { item_id: string; txns_chars: number; invtxns_chars: number }[] | null;
  /** Counted from the measure: connections, those still holding the access
   *  they were given (one without needs connecting again), and the accounts
   *  they keep up to date. */
  connectors: { connections: number; with_credential: number; accounts: number } | null;
  /** The newest recorded run of the daily snapshot; null for none, and
   *  `unreadable` true when the runs couldn't be read. */
  snapshot: ({ date: string } & RunRecord) | null;
  snapshot_unreadable: boolean;
};

export type AdminStorage = {
  as_of: string;
  ceiling_chars: number;
  /** Every container on the deployment, and those after this page. */
  total: number;
  next: string | null;
  containers: AdminContainer[];
};

const failed = Symbol('failed');
const lenient = <T>(what: string, run: () => Promise<T>): Promise<T | typeof failed> =>
  run().catch((err) => {
    console.error(`Admin storage: one account's ${what} could not be read.`, err instanceof Error ? err.name : typeof err);
    return failed;
  });

/** Sizes by Item from the measure's key names: "txns:<item>", "invtxns:<item>"
 *  and the markers beside them. */
function blobsOf(measure: ContainerMeasure) {
  const by = new Map<string, { txns: number; invtxns: number; blocked: boolean; unsaved: boolean }>();
  const of = (id: string) => {
    let b = by.get(id);
    if (!b) by.set(id, (b = { txns: 0, invtxns: 0, blocked: false, unsaved: false }));
    return b;
  };
  for (const k of measure.keys) {
    if (k.key.startsWith('txns:')) of(k.key.slice('txns:'.length)).txns += k.chars;
    else if (k.key.startsWith('invtxns:')) of(k.key.slice('invtxns:'.length)).invtxns += k.chars;
    else if (k.key.startsWith('txns-blocked:')) of(k.key.slice('txns-blocked:'.length)).blocked = true;
    else if (k.key.startsWith('txns-unsaved:')) of(k.key.slice('txns-unsaved:'.length)).unsaved = true;
  }
  return by;
}

const usageOf = (u: Usage | undefined): AdminItem['usage'] =>
  u ? { flagged: u.flagged, refused_since: u.error_since, hidden_since: u.hidden_since, checked_at: u.checked_at } : null;

/** One container, measured and read (see the header). */
async function containerRow(c: { id: ContainerId; status: ContainerStatus; created_at: string }, admin: Ctx): Promise<AdminContainer> {
  const ctx: Ctx = { container: c.id };
  const [measure, items, usage, runs] = await Promise.all([
    lenient('storage', () => measureContainer(ctx)),
    lenient('Items', () => getItems(ctx)),
    lenient('Item checks', () => readUsage(ctx)),
    lenient('snapshot runs', () => readRuns(ctx, 1)),
  ]);
  const count = (store: string) => (measure === failed ? 0 : measure.keys.find((k) => k.key === store)?.entries ?? 0);
  const blobs = measure === failed ? null : blobsOf(measure);
  const linked = items === failed ? null : new Set(items.map((i) => i.item_id));
  return {
    container: c.id,
    you: c.id === admin.container,
    status: c.status,
    created_at: c.created_at,
    storage:
      measure === failed
        ? null
        : {
            keys: measure.keys.length + measure.unmeasured.length,
            total_chars: measure.keys.reduce((n, k) => n + k.chars, 0),
            largest_chars: measure.keys.reduce((n, k) => Math.max(n, k.largest), 0),
            unmeasured: measure.unmeasured.length,
          },
    items:
      items === failed
        ? null
        : items
            .map((i: StoredItem): AdminItem => {
              const b = blobs?.get(i.item_id);
              return {
                item_id: i.item_id,
                institution_name: i.institution_name,
                transactions_billed: i.transactions_billed ?? null,
                txns_chars: b?.txns ?? 0,
                invtxns_chars: b?.invtxns ?? 0,
                blocked: b?.blocked ?? false,
                unsaved: b?.unsaved ?? false,
                usage: usage === failed ? null : usageOf(usage.get(i.item_id)),
              };
            })
            .sort((a, b) => b.txns_chars + b.invtxns_chars - (a.txns_chars + a.invtxns_chars) || (a.item_id < b.item_id ? -1 : 1)),
    orphaned:
      blobs === null || linked === null
        ? null
        : [...blobs]
            .filter(([id, b]) => !linked.has(id) && b.txns + b.invtxns > 0)
            .map(([item_id, b]) => ({ item_id, txns_chars: b.txns, invtxns_chars: b.invtxns }))
            .sort((a, b) => (a.item_id < b.item_id ? -1 : 1)),
    connectors:
      measure === failed
        ? null
        : { connections: count('connector-connections'), with_credential: count('connector-secrets'), accounts: count('connector-accounts') },
    snapshot: runs === failed ? null : (runs[0] ?? null),
    snapshot_unreadable: runs === failed,
  };
}

/**
 * A page of the admin's view: the containers after `after` (by id), at most
 * `limit`, each measured now (see the header). The registry itself failing
 * throws: there is nothing to show without it.
 */
export async function readAdminStorage(admin: Ctx, opts: { after?: string | null; limit?: number; now?: number } = {}): Promise<AdminStorage> {
  const limit = Math.min(Math.max(1, opts.limit ?? DEFAULT_PAGE), MAX_PAGE);
  const registry = (await listContainers()).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const rest = opts.after ? registry.filter((c) => c.id > opts.after!) : registry;
  const page = rest.slice(0, limit);
  const containers: AdminContainer[] = [];
  for (let i = 0; i < page.length; i += AT_ONCE) {
    containers.push(...(await Promise.all(page.slice(i, i + AT_ONCE).map((c) => containerRow(c, admin)))));
  }
  return {
    as_of: new Date(opts.now ?? Date.now()).toISOString(),
    ceiling_chars: maxBlobChars(),
    total: registry.length,
    next: rest.length > page.length ? page[page.length - 1].id : null,
    containers,
  };
}
