// lib/admin-storage.ts
//
// The admin's view of storage across every account on the deployment (the
// plan's "admin view of Items and blob size per container", so a costly
// account shows up): for each container, by its opaque id, its Plaid Items
// and their state, its connections to SimpleFIN or Lunch Flow, each Item's
// stored transaction blobs against the size ceiling (MAX_TXN_BLOB_CHARS,
// lib/blob.ts), what it stores in all, and its last daily snapshot.
//
// WHO: the admin alone, decided as lib/admin-items.ts decides (adminCtx).
// Anyone else is refused before anything is read. The page is linked at
// /admin/storage and lives at /admin-view/storage: proxy.ts sends the admin
// there, and anyone else's request reaches no route, so they get the 404 any
// missing path gets, header for header (lib/admin-gate.ts). The route answers
// them with the JSON 404 the admin's other route gives (app/api/admin/storage).
//
// WHAT IT READS, AND SHOWS. Nothing is decrypted. The containers are measured
// through the storage seam (lib/repo.ts measureContainers), without even the
// heads of their values: sizes and counts. Beside them, three plain-text
// records, which the view shows: the Items' records (each bank's name,
// Plaid's id for the connection, whether Plaid billed Transactions when it
// was linked; the access token in each is never opened), the daily check's
// record of each Item (lib/item-usage.ts: since when Plaid refused it, or
// every account was hidden) and the snapshot's newest run (lib/snapshot-job.ts:
// its outcome, and the reason it failed, which can name a Plaid error code).
// No person's name or email address.
//
// CHEAP, a page at a time: containers in id order after a cursor (`after`),
// at most MAX_PAGE a request, with one walk of the keyspace for the whole
// page (SCAN with MATCH, then a Lua step per hundred of each container's
// keys), so the walk costs the same for one container or fifty.
//
// LENIENT, for display only: nothing writes, deletes or records anything on
// it. A part that can't be read is null, or flagged unreadable, said as such,
// never zero or "nothing"; one container's records failing costs the others
// nothing.

import { listContainers, type Ctx, type ContainerId, type ContainerStatus } from './containers';
import { measureContainers, type ContainerMeasure } from './repo';
import { getItems, type StoredItem } from './storage';
import { readUsage, type Usage } from './item-usage';
import { readNewestRun, type RunRecord } from './snapshot-job';
import { maxBlobChars } from './blob';

/** Containers per request, at most, and by default. */
export const MAX_PAGE = 50;
export const DEFAULT_PAGE = 20;
/** Containers whose records are read at once. */
const AT_ONCE = 4;

/** One Plaid Item of a container, as stored. Its sizes and markers are null
 *  when they couldn't be measured (the container's walk failed, or the step
 *  that held one of its keys): not known, never 0 or none. */
export type AdminItem = {
  item_id: string;
  institution_name: string;
  /** Whether Plaid billed Transactions on it when it was linked; null when
   *  the lookup failed, and for Items linked before it was kept. */
  transactions_billed: boolean | null;
  /** Its stored blobs' sizes (0 for none). */
  txns_chars: number | null;
  invtxns_chars: number | null;
  /** A transaction save was refused for its size (its marker is there; it
   *  clears on the Item's next sync that fits). */
  blocked: boolean | null;
  /** Its last transaction save failed. */
  unsaved: boolean | null;
  /** The last check of it (lib/item-usage.ts), or null when there is none,
   *  or when it couldn't be read (`usage_unreadable`). */
  usage: { flagged: 'refused' | 'hidden' | null; refused_since: string | null; hidden_since: string | null; checked_at: string | null } | null;
  usage_unreadable: boolean;
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
  /** Blobs whose Item is no longer linked: they cost the same. Null where
   *  the container couldn't be measured (or a blob of it wasn't) or its
   *  Items read. */
  orphaned: { item_id: string; txns_chars: number; invtxns_chars: number }[] | null;
  /** Counted from the measure: connections, those still holding the access
   *  they were given (one without needs connecting again), and the accounts
   *  they keep up to date. Null where the container, or one of those stores,
   *  couldn't be measured. */
  connectors: { connections: number; with_credential: number; accounts: number } | null;
  /** The newest recorded run of the daily snapshot; null for none, or when
   *  it couldn't be read (`snapshot_unreadable`: the runs couldn't be read,
   *  or the newest one is damaged, so no older one is shown as the last). */
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
    console.error(`Admin storage: ${what} could not be read.`, err instanceof Error ? err.name : typeof err);
    return failed;
  });

/** The kinds of key an Item's blobs and markers are kept under. */
const ITEM_KEYS = ['txns:', 'invtxns:', 'txns-blocked:', 'txns-unsaved:'] as const;
/** The connector stores the counts are read off. */
const CONNECTOR_STORES = ['connector-connections', 'connector-secrets', 'connector-accounts'];

/** What a measure that missed some keys can't say: the Items whose blob or
 *  marker is among them (their sizes and markers unknown), whether a blob of
 *  any Item is (so which are left behind is unknown), and whether a
 *  connector store is (so its counts are). */
function unmeasuredOf(measure: ContainerMeasure) {
  const items = new Set<string>();
  let blobs = false;
  for (const key of measure.unmeasured) {
    const kind = ITEM_KEYS.find((p) => key.startsWith(p));
    if (!kind) continue;
    items.add(key.slice(kind.length));
    if (kind === 'txns:' || kind === 'invtxns:') blobs = true;
  }
  return { items, blobs, connectors: measure.unmeasured.some((key) => CONNECTOR_STORES.includes(key)) };
}

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

const usageOf = (u: Usage): NonNullable<AdminItem['usage']> => ({ flagged: u.flagged, refused_since: u.error_since, hidden_since: u.hidden_since, checked_at: u.checked_at });

/** One container, from its measure (or `failed`) and its records (see the header). */
async function containerRow(
  c: { id: ContainerId; status: ContainerStatus; created_at: string },
  measure: ContainerMeasure | typeof failed,
  admin: Ctx
): Promise<AdminContainer> {
  const ctx: Ctx = { container: c.id };
  const [items, usage, newest] = await Promise.all([
    lenient("one account's Items", () => getItems(ctx)),
    lenient("one account's Item checks", () => readUsage(ctx)),
    lenient("one account's snapshot runs", () => readNewestRun(ctx)),
  ]);
  const count = (store: string) => (measure === failed ? 0 : (measure.keys.find((k) => k.key === store)?.entries ?? 0));
  const blobs = measure === failed ? null : blobsOf(measure);
  // What one failed step left unknown is null too, never 0 or none.
  const missed = measure === failed ? null : unmeasuredOf(measure);
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
              const b = blobs === null || missed!.items.has(i.item_id) ? null : (blobs.get(i.item_id) ?? { txns: 0, invtxns: 0, blocked: false, unsaved: false });
              const u = usage === failed ? 'unreadable' : usage.get(i.item_id);
              return {
                item_id: i.item_id,
                institution_name: i.institution_name,
                transactions_billed: i.transactions_billed ?? null,
                txns_chars: b?.txns ?? null,
                invtxns_chars: b?.invtxns ?? null,
                blocked: b?.blocked ?? null,
                unsaved: b?.unsaved ?? null,
                usage: u === undefined || u === 'unreadable' ? null : usageOf(u),
                usage_unreadable: u === 'unreadable',
              };
            })
            .sort((a, b) => (b.txns_chars ?? 0) + (b.invtxns_chars ?? 0) - ((a.txns_chars ?? 0) + (a.invtxns_chars ?? 0)) || (a.item_id < b.item_id ? -1 : 1)),
    orphaned:
      blobs === null || linked === null || missed!.blobs
        ? null
        : [...blobs]
            .filter(([id, b]) => !linked.has(id) && b.txns + b.invtxns > 0)
            .map(([item_id, b]) => ({ item_id, txns_chars: b.txns, invtxns_chars: b.invtxns }))
            .sort((a, b) => (a.item_id < b.item_id ? -1 : 1)),
    connectors:
      measure === failed || missed!.connectors
        ? null
        : { connections: count('connector-connections'), with_credential: count('connector-secrets'), accounts: count('connector-accounts') },
    snapshot: newest === failed || newest === null || newest.run === null ? null : { date: newest.date, ...newest.run },
    snapshot_unreadable: newest === failed || (newest !== null && newest.run === null),
  };
}

/**
 * A page of the admin's view: the containers after `after` (by id), at most
 * `limit`, measured now with one walk (see the header). The registry itself
 * failing throws: there is nothing to show without it. The walk failing
 * makes every container's measure null, said as such, and its records are
 * still read.
 */
export async function readAdminStorage(admin: Ctx, opts: { after?: string | null; limit?: number; now?: number } = {}): Promise<AdminStorage> {
  const limit = Math.min(Math.max(1, opts.limit ?? DEFAULT_PAGE), MAX_PAGE);
  const registry = (await listContainers()).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const rest = opts.after ? registry.filter((c) => c.id > opts.after!) : registry;
  const page = rest.slice(0, limit);
  const measures = await lenient('the walk of the accounts on this page', () => measureContainers(page.map((c) => ({ container: c.id }))));
  const containers: AdminContainer[] = [];
  for (let i = 0; i < page.length; i += AT_ONCE) {
    containers.push(
      ...(await Promise.all(page.slice(i, i + AT_ONCE).map((c) => containerRow(c, measures === failed ? failed : (measures.get(c.id) ?? failed), admin))))
    );
  }
  return {
    as_of: new Date(opts.now ?? Date.now()).toISOString(),
    ceiling_chars: maxBlobChars(),
    total: registry.length,
    next: rest.length > page.length ? page[page.length - 1].id : null,
    containers,
  };
}
