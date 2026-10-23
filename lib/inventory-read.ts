// lib/inventory-read.ts
//
// Your data (app/your-data, /api/data-inventory): what Nya keeps about one
// person, kind by kind (the registry in lib/inventory.ts), measured now:
// how many entries of each, their size, whether they are encrypted and under
// which key, whether the download has them, how long they are kept and who
// else can see them.
//
// NUMBERS ONLY. Nothing is decrypted, and no value is read: the container is
// measured through the storage seam (lib/repo.ts measureContainer), which
// hands back sizes, counts and, for each value, only which key it says it is
// encrypted under. The few kinds kept outside the container are counted from
// plain-text records (the account's record, the sign-in it belongs to, the
// sharing connections, the data key's entry), never decrypted either.
//
// LENIENT, for display only: nothing writes, deletes or records anything on
// what this answers. Each part that can't be read is named as such (status
// "unreadable", its count and size null), never shown as holding nothing; a
// container that can't be walked at all is every kind in it unreadable, with
// `measured` false. A key nothing names is counted as such (`unknown`), never
// left out.
//
// For one person's own container only: the Ctx is theirs (the route resolves
// it with dataCtx), and what is read outside it is their own part (their
// sign-in's owners entry, their connections, their container's key entry).

import { getContainer, type Ctx } from './containers';
import { measureContainer, type KeyMeasure } from './repo';
import { readContainerEntry } from './crypto';
import { declaredStore, declaredStores } from './stores';
import { EXACT, PREFIXES } from './key-families';
import { SECTIONS, STORED_KEYS } from './user-export';
import { myConnections } from './sharing';
import { ownedContainer } from './owners';
import { sendsEmail } from './notice-recipients';
import { clerkEnabled } from './auth-mode';
import { apiWritesEnabled } from './api-writes-enabled';
import { isExcluded, isRefetched } from './export';
import { backupRetention, databaseBackupDays } from './backup';
import { masterKeyConfigured } from './crypto';
import { keyDeletionText } from './deletion-receipt';
import { containerEntry, families, GROUPS, keptRows, kindOf, outsideEntries, SEERS, type Entry, type Group, type Outside, type Seer } from './inventory';

/** How a kind's values are kept. For an encrypted kind, how many of its
 *  values say they are under the account's own key, under a key this copy
 *  of Nya shares (the original single key or a shared data key), under a key
 *  whose id can't be read (`unclear`), or don't look encrypted at all
 *  (`not_ciphertext`: they can't be read), or weren't looked at, for their
 *  size (`unchecked`: lib/repo.ts HEADS_STEP_BYTES). Claims read from each value's
 *  first bytes, never decrypted. `token`: the Plaid Items' records, whose
 *  access token alone is encrypted; `wrapped`: the data key's record, whose
 *  key is locked by the master key. */
export type Encryption =
  | { kind: 'plain' }
  | { kind: 'token' }
  | { kind: 'wrapped' }
  | { kind: 'encrypted'; own: number; shared: number; unclear: number; not_ciphertext: number; unchecked: number };

export type InventoryRow = {
  /** The key family or store name. */
  id: string;
  group: Group;
  name: string;
  about: string | null;
  /** In the person's own container, or kept for the whole environment. */
  where: 'yours' | 'environment';
  /** "read": counted (0 is nothing stored); "unreadable": couldn't be read
   *  just now; "not-counted": not counted here (see the row's words). */
  status: 'read' | 'unreadable' | 'not-counted';
  count: number | null;
  unit: readonly [string, string];
  /** Bytes stored, or null where unreadable or not measured (a kind kept
   *  beside everyone else's, outside the container). */
  chars: number | null;
  encryption: Encryption;
  download: { included: boolean; text: string };
  /** Whether the nightly backups copy it, by the backup's own lists
   *  (lib/export.ts EXCLUDED_PREFIXES and REFETCHED_PREFIXES), where this
   *  copy of Nya takes backups (Inventory.backups). */
  backed_up: boolean;
  /** The privacy page's retention rows it is kept by. */
  kept: string[];
  /** For a count kept for a window: how long. */
  kept_detail: string | null;
  seen: string[];
  plain: string | null;
};

export type Inventory = {
  as_of: string;
  /** The account's own data key: whether it has one, since when, and since
   *  when all its data has been under it. Null when it couldn't be read. */
  key: { own: boolean; since: string | null; moved: string | null } | null;
  /** False when the container couldn't be walked: every kind in it is then
   *  unreadable. */
  measured: boolean;
  /** Whether this copy of Nya takes nightly backups: "kept", "none" (no
   *  backup store is set up), or "invalid" (set up, but none is taken while
   *  their retention setting is not valid), as lib/backup.ts says. */
  backups: 'kept' | 'none' | 'invalid';
  groups: { id: Group; title: string; rows: InventoryRow[] }[];
  /** Keys in the container that no kind names (a later version's, say):
   *  how many, and their size, null when some of them couldn't be measured.
   *  Null when there are none (or, with `measured` false, when that isn't
   *  known). */
  unknown: { keys: number; chars: number | null } | null;
  /** What this copy of Nya keeps that is about nobody by name. */
  elsewhere: InventoryRow[];
};

/** The family or store a key inside the container belongs to, or null. */
function familyOf(key: string): string | null {
  if (Object.hasOwn(EXACT, key)) return key;
  for (const [prefix] of PREFIXES) if (key.startsWith(prefix)) return prefix;
  return declaredStore(key) ? key : null;
}

type Tally = { count: number; chars: number; heads: Record<string, number>; unmeasured: boolean };

/** The sections of the download that carry a store under another name. */
const coveredBy = (): Map<string, string> => new Map(SECTIONS.flatMap((s) => (s.covers ?? []).map((c) => [c, s.key] as const)));

/** What the download does with a kind, from its own lists (see lib/inventory.ts). */
function downloadOf(name: string, e: Entry, covered: Map<string, string>): InventoryRow['download'] {
  if (e.download) return { included: e.download.startsWith('In your download'), text: e.download };
  const store = declaredStore(name);
  if (store) {
    const counter = store.kind === 'counter' || store.kind === 'counter-map';
    if (store.exportable && !counter) return { included: true, text: `In your download, under ${covered.get(name) ?? name}.` };
    return {
      included: false,
      text: counter ? 'Not in your download: a count the app keeps, not your data.' : 'Not in your download: the app’s own bookkeeping, not your data.',
    };
  }
  const where = STORED_KEYS.find(([k]) => k === name)?.[1];
  if (where === undefined) return { included: false, text: 'Not in your download.' };
  if (where.startsWith('left out: ')) return { included: false, text: `Not in your download: ${where.slice('left out: '.length)}.` };
  return { included: true, text: `In your download, under ${where}.` };
}

/** A window's length in words: "an hour", "a day", "10 minutes". */
export function windowWords(seconds: number): string {
  const unit = (n: number, one: string, article: string) => (n === 1 ? `${article} ${one}` : `${n} ${one}s`);
  if (seconds % 86_400 === 0) return unit(seconds / 86_400, 'day', 'a');
  if (seconds % 3_600 === 0) return unit(seconds / 3_600, 'hour', 'an');
  if (seconds % 60 === 0) return unit(seconds / 60, 'minute', 'a');
  return unit(seconds, 'second', 'a');
}

/** How long a counter store's count lasts, or null for any other kind. */
function counterWindow(name: string): string | null {
  const store = declaredStore(name);
  if (!store || (store.kind !== 'counter' && store.kind !== 'counter-map')) return null;
  return `Each count lasts ${windowWords(store.windowSeconds)} from the first.`;
}

/** The words for who else can see a kind, as this copy of Nya is set up:
 *  nobody to share with under the shared password, and no email service
 *  where none is set up. */
function seenBy(seen: readonly Seer[] | undefined): string[] {
  const mail = sendsEmail();
  const people = clerkEnabled();
  return (seen ?? []).filter((s) => (s !== 'email' || mail) && (s !== 'shared' || people)).map((s) => SEERS[s]);
}

/** How a kind's values are kept, from its kind and what its values claim. */
function encryptionOf(name: string, heads: Record<string, number>, ownKey: string | null): Encryption {
  const kind = kindOf(name);
  if (kind === 'plain' || kind === null) return { kind: 'plain' };
  if (kind === 'items') return { kind: 'token' };
  let own = 0;
  let shared = 0;
  for (const [claim, n] of Object.entries(heads)) {
    if (claim === '-' || claim === '?' || claim === '+') continue;
    if (ownKey !== null && claim === ownKey) own += n;
    else shared += n;
  }
  return { kind: 'encrypted', own, shared, unclear: heads['?'] ?? 0, not_ciphertext: heads['-'] ?? 0, unchecked: heads['+'] ?? 0 };
}

/** Whether the privacy page shows a retention row on this copy of Nya: it
 *  shows the record a deleted account leaves only where accounts have keys
 *  of their own to destroy (app/privacy/page.tsx, keyDeletionText), so an
 *  entry never cites a row the page doesn't have. */
function rowShown(row: string): boolean {
  // Only where tokens can make changes does the page say how long they are
  // kept (lib/api-writes-enabled.ts).
  if (row === 'Changes made with API tokens') return apiWritesEnabled();
  if (row !== 'A record that a deleted account existed') return true;
  return keyDeletionText({ envelope: masterKeyConfigured(), backups: backupRetention(), databaseDays: databaseBackupDays() }).key.length > 0;
}

const rowOf = (
  id: string,
  e: Entry,
  where: InventoryRow['where'],
  read: Pick<InventoryRow, 'status' | 'count' | 'chars' | 'encryption'>,
  download: InventoryRow['download']
): InventoryRow => ({
  id,
  group: e.group,
  name: e.name,
  about: e.about ?? null,
  where,
  ...read,
  unit: e.unit,
  download,
  backed_up: !isExcluded(id) && !isRefetched(id),
  kept: keptRows(e).filter(rowShown),
  kept_detail: counterWindow(id),
  seen: seenBy(e.seen),
  plain: e.plain ?? null,
});

/** What reading a kind outside the container came to: a count, nothing to
 *  count here, or a failure (named, never zero). */
type OutsideRead = { status: 'read'; count: number } | { status: 'not-counted' } | { status: 'unreadable' };

/** A part of the list that couldn't be read (see the header). */
const FAILED = Symbol('failed');
const quiet = <T>(what: string, run: () => Promise<T>): Promise<T | typeof FAILED> =>
  run().catch((err) => {
    console.error(`Your data: ${what} could not be read.`, err instanceof Error ? err.name : typeof err);
    return FAILED;
  });

/**
 * Everything Nya keeps about the person whose container this is, counted and
 * measured now (see the header). `userId` is their Clerk account, or null with
 * the shared password (no people, so no sharing). `now` stamps the answer.
 */
export async function readInventory(ctx: Ctx, opts: { userId: string | null; now?: number }): Promise<Inventory> {
  const clerk = clerkEnabled() && opts.userId !== null;
  const [measure, entry, record, owned, connections] = await Promise.all([
    quiet('the container', () => measureContainer(ctx, { heads: true })),
    quiet('the data key', () => readContainerEntry(ctx.container)),
    quiet('the account record', () => getContainer(ctx.container)),
    clerk ? quiet('the sign-in', () => ownedContainer(opts.userId!)) : Promise.resolve(null),
    clerk ? quiet('the sharing connections', () => myConnections(opts.userId!)) : Promise.resolve(null),
  ]);

  const key = entry === FAILED ? null : entry !== null && 'key' in entry ? { own: true, since: entry.since, moved: entry.moved ?? null } : { own: false, since: null, moved: null };
  const ownKey = entry !== FAILED && entry !== null && 'key' in entry ? entry.key : null;

  // Every key measured, by the kind it belongs to.
  const tallies = new Map<string, Tally>();
  const unknown = { keys: 0, chars: 0 };
  let unknownUnmeasured = false;
  const tally = (family: string) => {
    let t = tallies.get(family);
    if (!t) tallies.set(family, (t = { count: 0, chars: 0, heads: {}, unmeasured: false }));
    return t;
  };
  const kindIn = (key: string): string | null => {
    const family = familyOf(key);
    // A family kept for the whole environment, found inside a container, was
    // built wrongly: counted as a key nothing names here.
    return family !== null && containerEntry(family) !== null ? family : null;
  };
  if (measure !== FAILED) {
    for (const m of measure.keys as KeyMeasure[]) {
      const family = kindIn(m.key);
      if (family === null || m.type === 'other') {
        unknown.keys += 1;
        unknown.chars += m.chars;
        continue;
      }
      const t = tally(family);
      t.count += m.entries;
      t.chars += m.chars;
      for (const [claim, n] of Object.entries(m.heads ?? {})) t.heads[claim] = (t.heads[claim] ?? 0) + n;
    }
    for (const name of measure.unmeasured) {
      const family = kindIn(name);
      if (family === null) {
        unknown.keys += 1;
        unknownUnmeasured = true;
      } else tally(family).unmeasured = true;
    }
  }

  const covered = coveredBy();
  const rows: InventoryRow[] = [];
  const inContainer = [...families().filter((f) => containerEntry(f) !== null), ...declaredStores().map((s) => s.name)];
  for (const name of inContainer) {
    const e = containerEntry(name)!;
    const t = tallies.get(name);
    const unreadable = measure === FAILED || t?.unmeasured === true;
    rows.push(
      rowOf(
        name,
        e,
        'yours',
        unreadable
          ? { status: 'unreadable', count: null, chars: null, encryption: encryptionOf(name, {}, ownKey) }
          : { status: 'read', count: t?.count ?? 0, chars: t?.chars ?? 0, encryption: encryptionOf(name, t?.heads ?? {}, ownKey) },
        downloadOf(name, e, covered)
      )
    );
  }

  // The kinds kept outside the container: the person's own part of each,
  // where it can be counted cheaply.
  const outsideRead = (name: string, o: Outside): OutsideRead | null => {
    if (o.clerk && !clerk) return null; // no people with the shared password
    switch (name) {
      case 'containers':
        return record === FAILED ? { status: 'unreadable' } : { status: 'read', count: record ? 1 : 0 };
      case 'owners':
        return owned === FAILED ? { status: 'unreadable' } : { status: 'read', count: owned === ctx.container ? 1 : 0 };
      case 'connections':
        return connections === FAILED || connections === null ? { status: 'unreadable' } : { status: 'read', count: connections.connections.length + connections.blocked.length };
      case 'crypto:':
        return key === null ? { status: 'unreadable' } : { status: 'read', count: key.own ? 1 : 0 };
      default:
        return { status: 'not-counted' };
    }
  };
  const elsewhere: InventoryRow[] = [];
  for (const [name, o] of outsideEntries()) {
    const read = o.about_you ? outsideRead(name, o) : { status: 'not-counted' as const };
    if (read === null) continue;
    const row = rowOf(
      name,
      o,
      'environment',
      {
        status: read.status,
        count: read.status === 'read' ? read.count : null,
        chars: null,
        encryption: { kind: o.wrapped ? 'wrapped' : 'plain' },
      },
      { included: (o.download ?? '').startsWith('In your download'), text: o.download ?? 'Not in your download.' }
    );
    (o.about_you ? rows : elsewhere).push(row);
  }

  const backups = backupRetention();
  return {
    as_of: new Date(opts.now ?? Date.now()).toISOString(),
    key,
    measured: measure !== FAILED,
    backups: backups === null ? 'invalid' : backups.kept ? 'kept' : 'none',
    groups: GROUPS.map(([id, title]) => ({ id, title, rows: rows.filter((r) => r.group === id) })).filter((g) => g.rows.length > 0),
    unknown: unknown.keys > 0 ? { keys: unknown.keys, chars: unknownUnmeasured ? null : unknown.chars } : null,
    elsewhere,
  };
}
