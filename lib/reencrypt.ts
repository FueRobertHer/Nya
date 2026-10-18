// lib/reencrypt.ts
//
// The migration pass: gives every container a data key of its own and moves
// each container's values to it (docs/architecture.md, "Per-container data
// keys"; docs/operations.md says when to run it).
//
// Until it has run, a container made before per-container keys keeps every
// value under the environment's keys: k0 (PLAID_ENCRYPTION_KEY) and the
// environment's data keys, which every container can read. Moving them is what
// makes deleting the container make its copies unreadable, and what would let
// those keys be retired one day.
//
// HOW IT STAYS SAFE WHILE THE APP IS RUNNING:
//
//   - EXPLICIT LIST, NOT GUESSWORK. Every key is classified by the lists in
//     lib/key-families.ts: a string or hash of ciphertext, the Plaid items (whose
//     access token is one field of a JSON value), or known plaintext. A store
//     declared through the storage seam (lib/repo.ts) is classified by its
//     declaration, found through the catalogue in lib/stores.ts. An unlisted key
//     is reported and left alone, so a store added later can't be missed
//     silently (a test checks every key name in lib/ is listed).
//   - A CONTAINER AT A TIME, FROM A CURSOR. Containers are walked in id order,
//     each call starting after the last one the call before finished
//     (`after`), so it reaches every container however many there are. Only
//     active ones: one being restored is about to be replaced, and one archived
//     is being deleted.
//   - KEYS ONLY WHERE NOTHING SAYS OTHERWISE. A container with no key gets one
//     (lib/crypto.ts claimContainerKey: one Lua step, which answers a key made
//     meanwhile and refuses during a master rotation) only when every value it
//     holds is under k0 or an environment key. A value under a container key
//     the store doesn't hold means its key was lost, not that it is new: that
//     container is reported as damaged and left alone. A container whose map
//     entry is missing while its key's record names it gets the entry back.
//   - COMPARE-AND-SET, GUARDED BY THE MAP. Each value is written back by a small
//     Lua script only if it still hashes to what was read, and only while the
//     container's map entry still names the key and the key is still stored. A
//     save landing mid-pass wins; the pass reports it as changed meanwhile. A
//     container whose entry changes mid-walk (deleted meanwhile) ends its walk,
//     and the pass goes on to the next.
//   - CHECKED AFTER WRITING. Each value written is read back and decrypted
//     under its container, with the key loaded fresh from the store.
//   - SAME PLAINTEXT, SAME READERS. Only the encryption changes; every reader
//     already handles both formats and every key.
//   - MOVED, ONLY FROM A CLEAN WALK. A container is recorded as moved (`moved`
//     in its map entry, the time its walk began) only when one call walked the
//     whole of it, its key was made at least ACTIVE_CACHE_MS before (instances
//     pick a new key up within it), and the walk found nothing to move and
//     nothing unreadable, unclassified or changed meanwhile. A run skips moved
//     containers; the nightly backup's count clears `moved` where a value under
//     a shared key turns up again (lib/key-archive.ts).
//   - NEVER OUTSIDE CONTAINERS. The pre-container copies at the environment's
//     root are counted (on a call starting from the beginning) and never
//     written: they are due to be deleted.
//   - A CHECK WRITES NOTHING. Not even a key.
//
// Values are never decrypted into the report: it carries container ids, key
// names, field names, counts and error types only.

import { createHash } from 'node:crypto';
import { rawRedis, envPrefix } from './storage';
import { splitScoped, isEnvWide, listContainers, type ContainerId, type Ctx } from './containers';
import { declaredStore, declaredPublicStore } from './stores';
import type { Store } from './repo';
import { listedKind, type Kind } from './key-families';
import {
  ACTIVE_CACHE_MS,
  claimContainerKey,
  containerKeysBlocked,
  containerKeysKey,
  decrypt,
  encryptV2,
  forgetContainerKey,
  formatOf,
  keysHashKey,
  legacyKeyProblem,
  masterKeyConfigured,
  prepareContainerKey,
  readContainerEntries,
  readKeyRecords,
  reloadKey,
  updateContainerEntry,
  ContainerKeyError,
  DecryptFailedError,
  KeyNotForContainerError,
  MalformedCiphertextError,
  MasterKeyError,
  UnknownKeyError,
  type ContainerKeyEntry,
  type StoredDataKey,
} from './crypto';

// How a key's values are stored, and the frozen lists of key families stored
// the old way: lib/key-families.ts.
export type { Kind } from './key-families';

/** How each shape of store the seam declares keeps its values. */
const SEAM_KINDS: Record<Store['kind'], Kind> = { value: 'string', map: 'hash', counter: 'plain', 'counter-map': 'plain' };

/** How a key (without the environment prefix) is stored, or null if it is
 *  neither on the lists nor a declared store's. */
export function classify(key: string): Kind | null {
  // A key inside a container is stored like the same key outside one, except
  // that environment-wide stores never belong in one, and containers never
  // nest: either means a key was built wrongly, so it is reported.
  const scoped = splitScoped(key);
  // Outside every container: a key family on the lists, or a public store
  // declared through the seam (plain JSON, public data: lib/repo.ts).
  if (!scoped.container) return listedKind(key) ?? (declaredPublicStore(key) ? 'plain' : null);
  if (scoped.key.startsWith('c:') || isEnvWide(scoped.key)) return null;
  // Then a store declared through the seam: a value store is one string of
  // ciphertext, a map store a hash of it, a counter store a plain integer, a
  // counter map store a hash of plain counts.
  // Only inside a container, where the seam keeps everything; the same name
  // outside one was built wrongly, so it is reported. The seam refuses a name
  // the lists claim, so this changes nothing on them.
  const store = declaredStore(scoped.key);
  return listedKind(scoped.key) ?? (store === null ? null : SEAM_KINDS[store.kind]);
}

// The compare-and-set scripts. The value read is compared by SHA-1, so an
// 8 MiB transaction blob is not sent twice. The first line names the script
// for the test double. A key's expiry is kept.
//
// KEYS[2] and KEYS[3] are the map of container keys and crypto:keys: the write
// happens only while the container's map entry still names the key it was
// encrypted with, and that key is still stored.
//
// Answers: 1 written; 0 the value changed; -1 the value is gone; -2 the
// container's entry no longer names the key, or the key is no longer stored.
export const CAS_STRING = `-- nya:cas-string-container
local entry = redis.call('HGET', KEYS[2], ARGV[4])
if not entry or not string.find(entry, '"key":"' .. ARGV[3] .. '"', 1, true) or redis.call('HEXISTS', KEYS[3], ARGV[3]) == 0 then return -2 end
local cur = redis.call('GET', KEYS[1])
if not cur then return -1 end
if redis.sha1hex(cur) ~= ARGV[1] then return 0 end
local ttl = redis.call('PTTL', KEYS[1])
redis.call('SET', KEYS[1], ARGV[2])
if ttl > 0 then redis.call('PEXPIRE', KEYS[1], ttl) end
return 1`;

export const CAS_HASH = `-- nya:cas-hash-container
local entry = redis.call('HGET', KEYS[2], ARGV[5])
if not entry or not string.find(entry, '"key":"' .. ARGV[4] .. '"', 1, true) or redis.call('HEXISTS', KEYS[3], ARGV[4]) == 0 then return -2 end
local cur = redis.call('HGET', KEYS[1], ARGV[1])
if not cur then return -1 end
if redis.sha1hex(cur) ~= ARGV[2] then return 0 end
redis.call('HSET', KEYS[1], ARGV[1], ARGV[3])
return 1`;

/** Checked before anything is written or counted: the scripts depend on
 *  redis.sha1hex. */
export const PROBE = `-- nya:probe
return redis.sha1hex('nya')`;
const PROBE_ANSWER = sha1('nya');

function sha1(s: string): string {
  return createHash('sha1').update(s, 'utf8').digest('hex');
}

/** The part of the raw Upstash client this uses. Values come back exactly as
 *  stored, never JSON-parsed, so the comparison is byte for byte. */
export type ReencryptClient = {
  scan(cursor: string | number, opts: { match: string; count: number }): Promise<[string | number, string[]]>;
  hscan(key: string, cursor: string | number, opts: { count: number }): Promise<[string | number, unknown[]]>;
  type(key: string): Promise<string>;
  get(key: string): Promise<unknown>;
  hget(key: string, field: string): Promise<unknown>;
  getrange(key: string, start: number, end: number): Promise<unknown>;
  eval(script: string, keys: string[], args: string[]): Promise<unknown>;
};

export type ReencryptReport = {
  dry_run: boolean;
  /** The container this call started after (null: from the beginning). */
  after: string | null;
  /** The last container this call finished: send it as `after` next time.
   *  Null when it finished none (then send `after` again). */
  next_after: string | null;
  /** Reached the last container before the time limit. */
  walked_all: boolean;
  /** Values moved to their container's key by this call. */
  moved: number;
  /** In a check: values still under another key than their container's, by
   *  key id (k0 is the legacy key). A run moves them instead. */
  to_move: Record<string, number>;
  /** Values outside any container (the pre-container copies), by key id:
   *  counted on a call from the beginning, never written. */
  outside_containers: Record<string, number>;
  /** Containers this call gave a key, mapped again from their key's record,
   *  or recorded as moved. */
  keys_made: string[];
  maps_restored: string[];
  marked_moved: string[];
  /** Containers left alone because something says their key was lost, or
   *  their entry can't be read. */
  damaged: { container: string; reason: string }[];
  /** Containers not walked: not active, destroyed, deleted mid-walk, or a key
   *  that can't be made just now. */
  skipped: { container: string; reason: string }[];
  /** Containers walked by this call that are not moved yet. */
  not_moved: string[];
  /** Values the app saved while they were being moved, so were left for next
   *  time. */
  changed_meanwhile: number;
  /** Values deleted while being moved. Nothing to do. */
  deleted_meanwhile: number;
  /** Values left alone because they cannot be moved: not decryptable, a key
   *  of the wrong type, bound to a context, under another container's key, an
   *  item that is not JSON, and so on. Listed up to a limit, with the reason. */
  unreadable: { key: string; field?: string; reason: string }[];
  unreadable_count: number;
  /** Keys not on the list in this file. Nothing was done with them. */
  unclassified: string[];
  /** Every active container has a key and is moved: from a call that walked
   *  to the last container, with nothing damaged, skipped for a key that
   *  couldn't be made, unreadable or unclassified. */
  complete: boolean;
};

const PAGE = 100;
const PARALLEL = 16;
const MAX_LISTED = 50;
/** Enough of a string value to see its header without reading the rest. */
const PEEK = 64;

/** Why a value could not be read, in words that never quote the value. */
function reasonFor(err: unknown): string {
  if (
    err instanceof UnknownKeyError ||
    err instanceof MasterKeyError ||
    err instanceof DecryptFailedError ||
    err instanceof MalformedCiphertextError ||
    err instanceof KeyNotForContainerError ||
    err instanceof ContainerKeyError
  ) {
    return `${err.name}: ${err.message}`;
  }
  return err instanceof Error ? err.name : 'Error';
}

class Unreadable extends Error {
  constructor(reason: string) {
    super(reason);
  }
}

/** Why a container was given no key, as the report says it. */
const NO_KEY_BECAUSE = {
  unregistered: 'it left the registry',
  rotation: 'a master rotation is pending',
  master: "this deployment's master is not the current one",
  taken: 'the key id was taken',
} as const;

/** The container's walk ended early: its map entry no longer names the key
 *  (deleted meanwhile). */
class WalkEnded extends Error {}

/** The database must run the scripts; anything else it answers is an error
 *  about something else (a network or auth failure), and is thrown as is. */
async function probe(client: ReencryptClient): Promise<void> {
  let answer: unknown;
  try {
    answer = await client.eval(PROBE, [], []);
  } catch (err) {
    // Upstash appends ", command was: <the command>" to every error, and the
    // command here names sha1hex, so only the part before it is looked at.
    const message = (err instanceof Error ? err.message : String(err)).replace(/, command was: [\s\S]*$/, '');
    if (!/attempt to call field 'sha1hex'|a nil value|unknown command|NOSCRIPT/i.test(message)) throw err;
    answer = null;
  }
  if (answer !== PROBE_ANSWER) {
    throw new MasterKeyError('The database does not support the scripts this pass needs (redis.sha1hex), so nothing was changed.');
  }
}

/**
 * A value in a key listed as plaintext that looks like ciphertext: v2, or v1
 * (base64 of at least a 12-byte IV and a 16-byte tag, so 40+ characters). No
 * plaintext store holds either: they keep dates, counters, JSON, ids and lock
 * tokens, none of which is long unbroken base64.
 */
const looksEncrypted = (v: unknown) =>
  typeof v === 'string' && (/^v2\.k[0-9]/.test(v) || (v.length >= 40 && v.length % 4 === 0 && /^[A-Za-z0-9+/]+={0,2}$/.test(v)));

async function inBatches<T>(items: T[], fn: (item: T) => Promise<void>): Promise<void> {
  for (let i = 0; i < items.length; i += PARALLEL) await Promise.all(items.slice(i, i + PARALLEL).map(fn));
}

async function listKeys(client: ReencryptClient, prefix: string): Promise<string[]> {
  const keys = new Set<string>();
  let cursor: string | number = 0;
  do {
    const [next, page] = await client.scan(cursor, { match: `${prefix}*`, count: 1000 });
    for (const key of page) if (key.startsWith(prefix)) keys.add(key);
    cursor = next;
  } while (String(cursor) !== '0');
  return [...keys].sort();
}

/** One ciphertext found by a walk: the full key it is in, its hash field
 *  (none for a string), the ciphertext, how to put a replacement back where it
 *  was (an item's token is one field of its JSON), and the stored text read. */
type Found = { full: string; field: string | undefined; ciphertext: string; wrap: (next: string) => string; read: string };

/**
 * One call of the pass: gives keys to active containers that have none, and
 * moves values to their container's key, a container at a time from `after`,
 * until done or `budgetMs` runs out. With `dryRun`, reads and checks
 * everything and writes nothing at all. `afterRollback` (a run, for data
 * archives taken by hand while rolled back, which the backups can't see)
 * first clears every container's `moved` and dates its `shared_in` now.
 */
export async function reencrypt(opts: {
  dryRun: boolean;
  budgetMs: number;
  after?: string | null;
  afterRollback?: boolean;
  now?: () => number;
  client?: ReencryptClient;
}): Promise<ReencryptReport> {
  const client = opts.client ?? (rawRedis() as unknown as ReencryptClient);
  const now = opts.now ?? Date.now;
  const deadline = now() + opts.budgetMs;
  const after = opts.after ?? null;

  await probe(client);
  if (!opts.dryRun && !masterKeyConfigured()) {
    throw new MasterKeyError('MASTER_KEY is not set, so no container can be given a data key.');
  }
  const legacyProblem = await legacyKeyProblem();
  // Read once: while a rotation waits, no container is given a key, and none
  // of the key numbers is used up asking.
  const blocked = opts.dryRun ? null : await containerKeysBlocked();

  const report: ReencryptReport = {
    dry_run: opts.dryRun,
    after,
    next_after: null,
    walked_all: false,
    moved: 0,
    to_move: {},
    outside_containers: {},
    keys_made: [],
    maps_restored: [],
    marked_moved: [],
    damaged: [],
    skipped: [],
    not_moved: [],
    changed_meanwhile: 0,
    deleted_meanwhile: 0,
    unreadable: [],
    unreadable_count: 0,
    unclassified: [],
    complete: false,
  };
  let keyless = 0; // containers left without a key this call: never complete
  const listed = <T>(list: T[], item: T) => {
    if (list.length < MAX_LISTED) list.push(item);
  };
  const unreadable = (key: string, field: string | undefined, reason: string) => {
    report.unreadable_count++;
    if (report.unreadable.length < MAX_LISTED) report.unreadable.push(field === undefined ? { key, reason } : { key, field, reason });
  };

  const prefix = envPrefix();
  const keys = await listKeys(client, prefix);
  const byContainer = new Map<string, string[]>();
  const outside: string[] = [];
  for (const full of keys) {
    const { container } = splitScoped(full.slice(prefix.length));
    if (container) byContainer.set(container, [...(byContainer.get(container) ?? []), full]);
    else outside.push(full);
  }

  // What each key record says: which container it is for (null for the
  // environment's keys), so a value's key can be told apart without opening it.
  const records = await readKeyRecords();
  /** null: k0 or an environment key; a container id: that container's key;
   *  undefined: not in the store (or unreadable there). */
  const keyOwner = (keyId: string): string | null | undefined => {
    if (keyId === 'k0') return null;
    const r = records.get(keyId);
    if (r === undefined || r instanceof MasterKeyError) return undefined;
    return r.container ?? null;
  };

  /**
   * Visits every ciphertext under these keys (one container's, or the
   * root's). `skip` is a header (a container's own key) whose string values
   * are passed over from a peek, without reading them whole. Plaintext keys
   * are checked, not trusted: ciphertext in one means the list is wrong.
   * Unclassified keys are reported. Answers false when it ran out of time.
   */
  const walk = async (
    fulls: string[],
    counted: { unclassified: number; unreadable: number },
    visit: (found: Found) => Promise<void>,
    skip?: string
  ): Promise<boolean> => {
    for (const full of fulls) {
      if (now() >= deadline) return false;
      const key = full.slice(prefix.length);
      const kind = classify(key);
      if (kind === null) {
        counted.unclassified++;
        if (!report.unclassified.includes(key)) listed(report.unclassified, key);
        continue;
      }
      const type = await client.type(full);
      if (type === 'none') continue; // deleted since the scan
      const flag = (field: string | undefined, reason: string) => {
        counted.unreadable++;
        unreadable(key, field, reason);
      };

      if (kind === 'plain') {
        if (type === 'string') {
          // Plaintext values are small (markers, counters), so read whole.
          if (looksEncrypted(await client.get(full))) flag(undefined, 'listed as plaintext but holds encrypted data');
        } else if (type === 'hash') {
          let cursor: string | number = 0;
          do {
            const [next, flat] = await client.hscan(full, cursor, { count: PAGE });
            for (let i = 0; i + 1 < flat.length; i += 2) {
              if (looksEncrypted(flat[i + 1])) flag(String(flat[i]), 'listed as plaintext but holds encrypted data');
            }
            cursor = next;
          } while (String(cursor) !== '0');
        }
        continue;
      }

      const expected = kind === 'string' ? 'string' : kind === 'cipher' ? type : 'hash';
      if (type !== expected || (type !== 'string' && type !== 'hash')) {
        flag(undefined, `expected a ${kind === 'cipher' ? 'string or hash' : expected}, found a ${type}`);
        continue;
      }

      if (type === 'string') {
        if (skip) {
          const peek = await client.getrange(full, 0, PEEK - 1);
          if (typeof peek === 'string' && peek.startsWith(`v2.${skip}.`)) continue;
        }
        const value = await client.get(full);
        if (value === null || value === undefined) continue;
        if (typeof value !== 'string') {
          flag(undefined, 'not stored as text');
          continue;
        }
        try {
          await visit({ full, field: undefined, ciphertext: value, wrap: (n) => n, read: value });
        } catch (err) {
          if (!(err instanceof Unreadable)) throw err;
          flag(undefined, err.message);
        }
        continue;
      }

      let cursor: string | number = 0;
      do {
        if (now() >= deadline) return false;
        const [next, flat] = await client.hscan(full, cursor, { count: PAGE });
        const fields: [string, unknown][] = [];
        for (let i = 0; i + 1 < flat.length; i += 2) fields.push([String(flat[i]), flat[i + 1]]);
        await inBatches(fields, async ([field, value]) => {
          if (typeof value !== 'string') return flag(field, 'not stored as text');
          try {
            if (kind !== 'items') return await visit({ full, field, ciphertext: value, wrap: (n) => n, read: value });
            // An item: only its access token is ciphertext.
            let item: Record<string, unknown>;
            try {
              item = JSON.parse(value);
            } catch {
              throw new Unreadable('not valid JSON');
            }
            const token = item?.encrypted_access_token;
            if (typeof token !== 'string') throw new Unreadable('has no encrypted_access_token');
            await visit({ full, field, ciphertext: token, wrap: (n) => JSON.stringify({ ...item, encrypted_access_token: n }), read: value });
          } catch (err) {
            if (!(err instanceof Unreadable)) throw err;
            flag(field, err.message);
          }
        });
        cursor = next;
      } while (String(cursor) !== '0');
    }
    return true;
  };

  /** The format a value claims, or Unreadable. */
  const formatOrUnreadable = (ciphertext: string) => {
    try {
      return formatOf(ciphertext);
    } catch (err) {
      throw new Unreadable(reasonFor(err));
    }
  };

  // The values outside any container: counted, never written. Only on a call
  // from the beginning, so a sequence of calls counts them once.
  if (after === null) {
    const counted = { unclassified: 0, unreadable: 0 };
    const whole = await walk(outside, counted, async ({ ciphertext }) => {
      const f = formatOrUnreadable(ciphertext);
      report.outside_containers[f.keyId] = (report.outside_containers[f.keyId] ?? 0) + 1;
    });
    if (!whole) return finish(report, false);
  }

  const entries = await readContainerEntries();
  const registry = (await listContainers()).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  // Keys under a container the registry doesn't list (one deleted, with
  // something written after its last sweep): never walked, but named, once.
  if (after === null) {
    const registered = new Set(registry.map((c) => c.id as string));
    for (const id of [...byContainer.keys()].sort()) {
      if (!registered.has(id)) listed(report.skipped, { container: id, reason: 'it holds keys but is not in the registry' });
    }
  }

  if (opts.afterRollback && !opts.dryRun) {
    const at = new Date(now()).toISOString();
    for (const c of registry) {
      const e = await updateContainerEntry(c.id, (cur) => (cur && 'key' in cur ? { key: cur.key, since: cur.since, shared_in: at, ...(cur.key_in !== undefined ? { key_in: cur.key_in } : {}) } : null));
      if (e) entries.set(c.id, e);
    }
  }

  for (const c of registry) {
    if (after !== null && c.id <= after) continue;
    if (now() >= deadline) return finish(report, false);
    const id = c.id;
    const ctx: Ctx = { container: id as ContainerId };
    const fulls = byContainer.get(id) ?? [];
    const done = () => {
      report.next_after = id;
    };
    if (c.status !== 'active') {
      listed(report.skipped, { container: id, reason: `the container is ${c.status}` });
      done();
      continue;
    }
    let entry: ContainerKeyEntry | null;
    const stored = entries.get(id);
    if (stored instanceof ContainerKeyError) {
      listed(report.damaged, { container: id, reason: 'its entry in the map of container keys is unreadable' });
      done();
      continue;
    }
    entry = stored ?? null;
    if (entry && 'destroyed' in entry) {
      listed(report.skipped, { container: id, reason: 'its key was destroyed' });
      done();
      continue;
    }
    if (entry && entry.moved) {
      done();
      continue;
    }

    // No map entry: does a key's record name it (the entry was lost), or does
    // a value say it had a key? Neither: it never had one, and gets one.
    if (entry === null) {
      const named = [...records].filter(([, r]) => !(r instanceof MasterKeyError) && (r as StoredDataKey).container === id) as [string, StoredDataKey][];
      if (named.length > 1) {
        listed(report.damaged, { container: id, reason: `several keys name it (${named.map(([k]) => k).join(', ')}) and its map entry is missing` });
        keyless++;
        done();
        continue;
      }
      if (named.length === 1) {
        const [keyId, record] = named[0];
        if (opts.dryRun) {
          listed(report.damaged, { container: id, reason: `its map entry is missing; ${keyId} names it, and a run restores the entry` });
          done();
          continue;
        }
        entry = await updateContainerEntry(id, (e) => (e === null ? { key: keyId, since: record.created_at } : null));
        listed(report.maps_restored, id);
      } else {
        // Every value must be under k0 or an environment key.
        const counted = { unclassified: 0, unreadable: 0 };
        const tally: Record<string, number> = {};
        let lost: string | null = null;
        const whole = await walk(fulls, counted, async ({ ciphertext }) => {
          const f = formatOrUnreadable(ciphertext);
          const owner = keyOwner(f.keyId);
          if (owner === undefined) lost ??= `a value is under ${f.keyId}, which the key store doesn't hold`;
          else if (owner !== null) lost ??= `a value is under ${f.keyId}, the key of container ${owner}`;
          else tally[f.keyId] = (tally[f.keyId] ?? 0) + 1;
        });
        if (!whole) return finish(report, false);
        if (lost) {
          listed(report.damaged, { container: id, reason: `${lost}, so it gets no key` });
          keyless++;
          done();
          continue;
        }
        if (opts.dryRun) {
          for (const [k, n] of Object.entries(tally)) report.to_move[k] = (report.to_move[k] ?? 0) + n;
          listed(report.not_moved, id);
          keyless++;
          done();
          continue;
        }
        if (blocked) {
          listed(report.skipped, { container: id, reason: `no key was made: ${NO_KEY_BECAUSE[blocked]}` });
          keyless++;
          done();
          continue;
        }
        const prepared = await prepareContainerKey(id as ContainerId, { born: false, now: now() });
        if (!prepared) {
          listed(report.skipped, { container: id, reason: 'no key could be made: key numbers are at the most the id format allows' });
          keyless++;
          done();
          continue;
        }
        const claim = await claimContainerKey(prepared);
        if (claim.outcome === 'made') listed(report.keys_made, id);
        else if (claim.outcome !== 'have') {
          listed(report.skipped, { container: id, reason: `no key was made: ${NO_KEY_BECAUSE[claim.outcome]}` });
          keyless++;
          done();
          continue;
        }
        entry = claim.entry;
      }
    }
    if (!entry || !('key' in entry)) {
      listed(report.skipped, { container: id, reason: 'it has no key' });
      keyless++;
      done();
      continue;
    }
    if (entry.moved) {
      done();
      continue;
    }

    // Move what isn't under the container's key.
    const own = entry.key;
    const since = entry.since;
    const walkStart = now();
    // The key as stored now, not as some earlier read left it in memory.
    reloadKey(own);
    forgetContainerKey(id);
    const counted = { unclassified: 0, unreadable: 0 };
    let found = 0;
    let changed = 0;
    let ended = false;
    try {
      const whole = await walk(
        fulls,
        counted,
        async ({ full, field, ciphertext, wrap, read }) => {
          const f = formatOrUnreadable(ciphertext);
          if (f.keyId === own) return;
          const owner = keyOwner(f.keyId);
          if (owner !== null && owner !== undefined) throw new Unreadable(`under ${f.keyId}, the key of container ${owner}; left as it is`);
          // Bound values need their context to be read, which only their owner
          // knows. None exist yet; when they do, their owner moves them.
          if (f.flags.includes('c')) throw new Unreadable('bound to a context; its owner must move it');
          if (f.keyId === 'k0' && legacyProblem) throw new Unreadable(legacyProblem);
          found++;
          if (opts.dryRun) {
            report.to_move[f.keyId] = (report.to_move[f.keyId] ?? 0) + 1;
            return;
          }
          let plain: string;
          try {
            plain = await decrypt(ctx, ciphertext);
          } catch (err) {
            throw new Unreadable(reasonFor(err));
          }
          const next = await encryptV2(plain, own);
          // Proven before it is written: the new value must read back as the old one.
          if ((await decrypt(ctx, next)) !== plain) throw new Error('A re-encrypted value did not read back.');
          const written = wrap(next);
          const answer =
            field === undefined
              ? await client.eval(CAS_STRING, [full, containerKeysKey(), keysHashKey()], [sha1(read), written, own, id])
              : await client.eval(CAS_HASH, [full, containerKeysKey(), keysHashKey()], [field, sha1(read), written, own, id]);
          if (answer === -2) throw new WalkEnded();
          if (answer === -1) {
            report.deleted_meanwhile++;
            return;
          }
          if (answer !== 1) {
            // Changed meanwhile, unless it reads back identical: then either it
            // changed and changed back, or the two sides hash different bytes
            // (a value that is not valid UTF-8), which would never move.
            // Reported rather than counted as a plain change, so a value stuck
            // that way is visible.
            const again = field === undefined ? await client.get(full) : await client.hget(full, field);
            if (again === read) throw new Unreadable('could not be compared (it changed and changed back, or is not valid UTF-8 text); tried again next call');
            changed++;
            report.changed_meanwhile++;
            return;
          }
          report.moved++;
          // Checked after writing: read back, and decrypted under its container.
          const back = field === undefined ? await client.get(full) : await client.hget(full, field);
          if (back !== written) {
            changed++;
            report.changed_meanwhile++;
            return;
          }
          if ((await decrypt(ctx, next)) !== plain) throw new Error(`A moved value of container ${id} did not read back after it was written.`);
        },
        own
      );
      if (!whole) return finish(report, false);
    } catch (err) {
      if (!(err instanceof WalkEnded)) throw err;
      ended = true;
    }
    if (ended) {
      listed(report.skipped, { container: id, reason: 'its key changed during the walk (deleted meanwhile?)' });
      done();
      continue;
    }

    const clean = found === 0 && changed === 0 && counted.unreadable === 0 && counted.unclassified === 0;
    const settled = walkStart >= Date.parse(since) + ACTIVE_CACHE_MS;
    if (!opts.dryRun && clean && settled) {
      const at = new Date(walkStart).toISOString();
      const marked = await updateContainerEntry(id, (e) => (e && 'key' in e && e.key === own ? { ...e, moved: at } : null));
      if (marked && 'key' in marked && marked.moved === at) listed(report.marked_moved, id);
      else listed(report.not_moved, id);
    } else {
      listed(report.not_moved, id);
    }
    done();
  }
  return finish(report, true, keyless);
}

/**
 * Seals the report. `complete` only from a call that walked to the last
 * container: every active container is moved (read again now), and nothing
 * was damaged, left without a key, unreadable or unclassified in this call.
 */
async function finish(report: ReencryptReport, walkedAll: boolean, keyless = 0): Promise<ReencryptReport> {
  report.walked_all = walkedAll;
  if (!walkedAll) return report;
  const entries = await readContainerEntries();
  const active = (await listContainers()).filter((c) => c.status === 'active');
  const allMoved = active.every((c) => {
    const e = entries.get(c.id);
    return e !== undefined && !(e instanceof ContainerKeyError) && 'key' in e && !!e.moved;
  });
  report.complete =
    allMoved &&
    keyless === 0 &&
    report.damaged.length === 0 &&
    report.unreadable_count === 0 &&
    report.unclassified.length === 0 &&
    Object.keys(report.to_move).length === 0;
  return report;
}
