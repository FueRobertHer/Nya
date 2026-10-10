// lib/repo.ts
//
// The storage seam (Postgres migration plan, Phase 1): how new stores reach
// storage. A store is declared once, by name, and gets a few named operations;
// nothing here reads or writes an arbitrary key. Today they run on Redis, and
// this is the only code new stores reach Redis through
// (test/storage-boundary.test.ts keeps it that way). A Postgres or SQLite
// implementation can later sit behind the same declarations without the code
// that uses a store changing, and the existing stores move behind the seam one
// at a time. See docs/architecture.md, "Storage seam".
//
// TWO SHAPES, which cover the stores the backlog adds:
//
//   defineValueStore  one encrypted JSON value per container, replaced whole on
//                     every save (the shape of goals and budgets). In Redis,
//                     one string key; in a table, one row per container.
//   defineMapStore    one encrypted JSON value per id (the shape of manual
//                     accounts). In Redis, one hash with a field per id; in a
//                     table, a row per id.
//
// And one for the service's own bookkeeping:
//
//   defineCounterStore  a count per container in a fixed window that starts
//                       with its first count and ends on its own (a rate
//                       limit, such as downloads of my data). Not the
//                       person's data, so never encrypted or exported. In
//                       Redis, one integer key with an expiry, counted in
//                       Lua; in a table, a row with the count and the end of
//                       its window.
//
// CONTAINERS ONLY, by design. Every store keeps its data inside a container (kc
// in lib/storage.ts), so deleting the account deletes it with the rest
// (lib/account-deletion.ts sweeps the container's prefix). There is no
// environment-wide store: a lookup that has to work before a container is
// known carries the container's opaque id itself (an API token will), so its
// record lives inside the container too.
//
// WHO WINS. Writes to different ids of a map store never touch each other.
// Writes to the same id, like saves of a value store, are last-write-wins: a
// get() followed by a set() loses a change saved in between. Where anything else
// can change the same entry at the same time (a webhook, a rule, a second
// device), change it with MapStore.update(), a compare-and-set that retries; for
// a change that must land on several entries together or not at all (moving
// something from one entry to another), MapStore.updateMany(). A value store
// is for data one person edits at a time.
//
// DECLARING ONE, in a module under lib/:
//
//   export const rulesStore = defineMapStore<Rule>('rules', {
//     what: 'rules', // plural: "Your saved rules could not be read"
//     isValid: isRule, // checked on every read and before every write
//     exportable: true, // will it be in the person's own data download?
//   });
//
// then import that module in lib/stores.ts, the catalogue that everything
// walking every store reads: the key inventory in lib/reencrypt.ts, and the
// person's data download (lib/user-export.ts), where each store declared
// exportable is a section of its own. The name is the key family, so a
// declared store is in the key inventory by construction.
//
// READS ARE STRICT unless the method's name says otherwise. A read answers with
// what is stored, or says exactly why it cannot:
//   - never saved: null, or an empty map;
//   - UNREADABLE: the stored bytes are damaged (not ciphertext, or ciphertext
//     that fails to authenticate under a data key). Nothing readable is lost
//     by removing it;
//   - UNRECOGNISED: as far as this code can tell it is intact, but it does not
//     understand it: not JSON, a shape isValid rejects even after upgrade, or a
//     format a later version may write (another version tag or flag, or a value
//     bound to a context). A bug to fix, or a release to roll forward to, never
//     data to delete;
//   - this deployment cannot read it (no master key or the wrong one, a key
//     missing from the key store, a failed decrypt under k0, decompression
//     failing, storage unreachable): that error, as it is. It says nothing
//     about the data. k0 (PLAID_ENCRYPTION_KEY) does not commit to its key, so
//     a replaced key fails every value written before it exactly as damage
//     would, even beside values written after it that read fine.
// Strict reads throw StoredDataUnreadableError for the middle two: for a map
// store UnreadableEntriesError, which names the ids of each, for a value store
// UnreadableValueError. A failure is never "empty": a caller that writes,
// deletes or records history on the answer must not mistake one for the other
// (the bug lib/stored-json.ts exists for).
//   ONLY UNREADABLE ENTRIES MAY EVER BE OFFERED FOR REMOVAL, and only once the
// person confirms. MapStore.getAllReport names both kinds instead of throwing,
// so a route can show what it read, offer to remove the unreadable ids, and
// report the unrecognised ones as a problem to fix; ValueStore.getReport says
// the same of a value store's one value. A store kept outside the seam whose
// reader reports what it can't use the same way tells the kinds apart with
// openStored, so every report draws the line where the seam does.
// MapStore.replaceUnreadable
// is that removal with a value put in its place, in one step: it writes only
// over an entry whose bytes are damaged and still the bytes it read, so it can
// never replace one that reads, or one that is unrecognised.
//   MapStore.getAllLenient is the one lenient read: it leaves out what it cannot
// use (a deployment problem still throws). It is only for conveniences that
// nothing writes, deletes or records on; say so where it is called.
//
// WRITES NEVER BUILD ON A FAILED READ. A value store refuses to replace a value
// it cannot read. A map store writes the entries it is given and nothing else,
// and there is deliberately no "replace the whole map": computed from a lenient
// read, it would delete what could not be read. update() reads its entry
// strictly before computing anything. Every value is checked with isValid as it
// will read back (after a JSON round trip) and written exactly as checked, so a
// store never holds what its own reads reject. A write too large for one
// request (the ceiling in lib/blob.ts) is refused whole, never trimmed.
//
// IN A ROUTE: ContainerError -> containerUnavailable() (503), as everywhere;
// StoredDataUnreadableError -> 409 with { error: err.message, unreadable: true }
// (and, from UnreadableEntriesError, its unreadable and unrecognised ids);
// StoreRefusedError (UpdateConflictError, StoredValueTooLargeError) -> err.status
// (409, 413) with { error: err.message }; anything else -> a generic 500.
//
// EVOLVING A STORE'S SHAPE. Every value ever stored must keep reading: values
// are rewritten only when saved, and a restored backup brings old ones back. So
// isValid must accept every shape a deployed version wrote, after the store's
// optional upgrade: a new field is optional, or upgrade fills it in. upgrade
// runs on each stored value, current ones too, before isValid. It returns the
// current shape, leaves what it does not recognise unchanged for isValid to
// reject, and never throws (a throw is a bug, raised as it is, not blamed on
// the data). Writes always store the current shape.
//
// IDS ARE PLAINTEXT. A map store's ids are Redis field names, stored and backed
// up unencrypted. Use random ids (crypto.randomUUID()), a provider's own ids, or
// a hash of a random secret such as an API token. Never content (a name, a
// merchant, a date, an amount), and never a plain hash of content: anyone with a
// copy of the database can reverse it by hashing guesses. An id that must be
// derived from content needs a keyed HMAC whose key is not in the database. Ids
// are limited to letters, digits and "_.:-".
//
// NOT BOUND TO A CONTEXT. lib/crypto.ts can bind a value to a context (the "c"
// flag), so a value copied to another field fails to decrypt. Seam values are
// not bound, because the re-encryption pass (lib/reencrypt.ts) cannot move a
// bound value: every seam value would stay under its old data key and the pass
// could never report complete, which retiring a leaked key depends on. Binding
// would stop a seam value being moved onto another id or store, though not an
// unbound value being swapped in until decrypt() refuses those. If that is
// wanted, it is one change here: bind to the store name and id (never the
// environment prefix, so a restore into another namespace still reads, and
// never the container, so a container's data can still be copied byte for
// byte), and teach the pass the same context; classify() already maps a key to
// its declaration.
//
// AN OPERATION THE SEAM LACKS is added here as a named method with its own
// contract test (and its Lua, if it must be atomic), never as raw key access.

import { createHash } from 'node:crypto';
import { redis, kc } from './storage';
import { isEnvWide, type Ctx } from './containers';
import { encrypt, formatOf, DecryptFailedError, MalformedCiphertextError, UnsupportedFormatError } from './crypto';
import { StoredDataUnreadableError } from './stored-json';
import { decryptJsonText, encodeJsonText, maxBlobChars, blobWarnChars } from './blob';
import { listedKind } from './key-families';
import { isExcluded } from './export';

export { StoredDataUnreadableError, describeUnreadable } from './stored-json';

/** Entries of a map store that cannot be used, by their own doing (see READS
 *  above). `unreadable`: their bytes are damaged, so a route may offer to remove
 *  them once the person confirms. `unrecognised`: they decrypt intact but this
 *  code does not understand them; never offered for removal. Both in id order,
 *  never in the message, which reaches logs. */
export class UnreadableEntriesError extends StoredDataUnreadableError {
  constructor(
    what: string,
    readonly unreadable: string[],
    readonly unrecognised: string[],
    cause?: unknown
  ) {
    super(what, cause);
    this.name = 'UnreadableEntriesError';
  }
}

/** A value store's value that cannot be used, by its own doing. `unrecognised`
 *  is true when it decrypts intact but this code does not understand it, so it
 *  must never be offered for removal; false when its bytes are damaged. */
export class UnreadableValueError extends StoredDataUnreadableError {
  constructor(
    what: string,
    readonly unrecognised: boolean,
    cause?: unknown
  ) {
    super(what, cause);
    this.name = 'UnreadableValueError';
  }
}

/** A write the seam refused, with nothing written. `status` is what a route
 *  answers with, with the message as the error. */
export class StoreRefusedError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message);
    this.name = 'StoreRefusedError';
  }
}

/** update() gave up: the entry kept changing under it. 409: try again. */
export class UpdateConflictError extends StoreRefusedError {
  constructor(readonly what: string) {
    super(`Your saved ${what} kept changing while this change was being saved, so it was not made. Try again.`, 409);
    this.name = 'UpdateConflictError';
  }
}

/** A write whose request would not fit the ceiling in lib/blob.ts. 413:
 *  nothing was written, and nothing was trimmed to fit. */
export class StoredValueTooLargeError extends StoreRefusedError {
  constructor(
    readonly what: string,
    readonly chars: number,
    readonly limit: number
  ) {
    super(`Your ${what} are too large to save (${chars} characters stored, over the limit of ${limit}), so nothing was changed.`, 413);
    this.name = 'StoredValueTooLargeError';
  }
}

export type StoreOptions<T> = {
  /** What the person calls the contents, plural, for messages: "Your saved
   *  {what} could not be read, so they were left untouched." */
  what: string;
  /** The current shape. A stored value that fails it (after upgrade) is
   *  unrecognised; a value that would fail it is refused before it is written. */
  isValid: (v: unknown) => v is T;
  /** Whether the contents will belong in the person's own data download: true
   *  for what they entered or what describes their money, false for secrets
   *  (token hashes, connector credentials) and the service's own bookkeeping. */
  exportable: boolean;
  /** Turns a value an earlier version stored into the current shape, before
   *  isValid sees it. See "Evolving a store's shape" above. */
  upgrade?: (stored: unknown) => unknown;
  /** Stores each value gzip-compressed (lib/blob.ts), for values that can grow
   *  large. Reads take either form, so it can be switched on or off later. */
  compress?: boolean;
};

type Declared = {
  /** The key family: each container's data is at "<env>:c:<container>:<name>". */
  readonly name: string;
  readonly what: string;
  readonly exportable: boolean;
};

export type ValueStore<T> = Declared & {
  readonly kind: 'value';
  /** Strict. The value, or null if none was ever saved. */
  get(ctx: Ctx): Promise<T | null>;
  /** Strict about deployment problems, but says why the value cannot be used
   *  instead of throwing, as MapStore.getAllReport does for entries: the value,
   *  or null, with `unreadable` (its bytes are damaged, so it may be offered
   *  for removal once the person confirms) or `unrecognised` (intact, never
   *  offered) when that is why. Both false and null: never saved. */
  getReport(ctx: Ctx): Promise<{ value: T | null; unreadable: boolean; unrecognised: boolean }>;
  /** Replaces the value, unless the one there now cannot be read: then refuses,
   *  leaving it exactly as it is. Last write wins (see the header). */
  set(ctx: Ctx, value: T): Promise<void>;
  /** Deletes the value, readable or not. */
  remove(ctx: Ctx): Promise<void>;
};

export type MapStore<T> = Declared & {
  readonly kind: 'map';
  /** Strict. One entry, or null if there is none. */
  get(ctx: Ctx, id: string): Promise<T | null>;
  /** Strict. The entries there are for these ids, in the order asked; an id
   *  with no entry is left out. */
  getMany(ctx: Ctx, ids: Iterable<string>): Promise<Map<string, T>>;
  /** Strict. Every entry, in id order: empty if none was ever saved. */
  getAll(ctx: Ctx): Promise<Map<string, T>>;
  /** Strict about deployment problems, but names the entries it cannot use
   *  instead of throwing: the readable entries in id order, the unreadable ids
   *  (which may be offered for removal) and the unrecognised ones (which may
   *  not). For a route that shows what it read and helps repair the rest. */
  getAllReport(ctx: Ctx): Promise<{ entries: Map<string, T>; unreadable: string[]; unrecognised: string[] }>;
  /** LENIENT. Every entry it can use, in id order. Only for conveniences that
   *  nothing writes, deletes or records on. A deployment problem still throws. */
  getAllLenient(ctx: Ctx): Promise<Map<string, T>>;
  /** Writes one entry, replacing any under the same id, without reading it. */
  set(ctx: Ctx, id: string, value: T): Promise<void>;
  /** Writes several entries in one step (one HSET): every one, or none if any
   *  is invalid or the whole is too large. A repeated id keeps its last value. */
  setMany(ctx: Ctx, entries: Iterable<readonly [string, T]>): Promise<void>;
  /** Changes one entry safely when other writers may change it too: reads it
   *  (strictly), computes the new value with `fn` (null deletes it), and writes
   *  only if the entry is still what was read, else waits a moment and runs `fn`
   *  again on what is there now, a few times before UpdateConflictError. `fn`
   *  may therefore run more than once: it should only compute. Returns what was
   *  written. */
  update(ctx: Ctx, id: string, fn: (current: T | null) => T | null | Promise<T | null>): Promise<T | null>;
  /** Changes several entries together, as one step: reads them (strictly),
   *  computes with `fn` what to write to some of them (null deletes one;
   *  an id left out of its answer is left as it is), and writes all of it
   *  only if none of the entries read has changed meanwhile, else waits a
   *  moment and runs `fn` again, a few times before UpdateConflictError. No
   *  reader ever sees some of the writes without the others, and a failure
   *  writes none of them. For a handful of entries (at most MANY_AT_ONCE).
   *  Returns what was written. */
  updateMany(
    ctx: Ctx,
    ids: Iterable<string>,
    fn: (current: Map<string, T | null>) => Map<string, T | null> | Promise<Map<string, T | null>>
  ): Promise<Map<string, T | null>>;
  /** The repair of an entry whose bytes are damaged, once the person has
   *  confirmed removing it (see READS): writes `value` in its place, in one
   *  step, only if it is unreadable and still holds the bytes read. Answers
   *  false, writing nothing, when it reads fine, is unrecognised, is gone or
   *  changed since it was read. A deployment problem is thrown, as by every
   *  read, and a value it would refuse to write is refused before anything is
   *  read. */
  replaceUnreadable(ctx: Ctx, id: string, value: T): Promise<boolean>;
  /** Deletes entries, readable or not. Ids with no entry are ignored. */
  remove(ctx: Ctx, ...ids: string[]): Promise<void>;
  /** How many entries there are, readable or not (for count limits). */
  count(ctx: Ctx): Promise<number>;
  /** Whether there is an entry under the id, readable or not. */
  has(ctx: Ctx, id: string): Promise<boolean>;
};

/** A counter store's window as it stands. */
export type CounterWindow = {
  /** Counted so far in this window: 0 when none is running. */
  count: number;
  /** Seconds until this window ends: 0 when none is running, else at least 1. */
  secondsLeft: number;
};

export type CounterStore = Declared & {
  readonly kind: 'counter';
  /** How long a window lasts, from its first count. */
  readonly windowSeconds: number;
  /** Strict: the window as it stands. Counts nothing. Throws if the count
   *  cannot be read, so a limit built on it fails closed. */
  read(ctx: Ctx): Promise<CounterWindow>;
  /** Counts one, atomically, starting a window if none is running, and answers
   *  the window with this one counted. Two callers racing never get the same
   *  count, so the count is what decides. Throws if it cannot count. */
  take(ctx: Ctx): Promise<CounterWindow>;
};

export type Store = ValueStore<unknown> | MapStore<unknown> | CounterStore;

/**
 * Reads fields exactly: each as "v" followed by its stored text, or "" where
 * there is none. Upstash's client JSON-parses what it reads, so its own HMGET
 * answers a field holding the text "null" as if it were absent; prefixed this
 * way nothing parses, and get(), has() and count() agree. The first line names
 * the script for the test double.
 */
export const READ_ENTRIES = `-- nya:repo-read-entries
local values = redis.call('HMGET', KEYS[1], unpack(ARGV))
for i = 1, #ARGV do
  if values[i] then values[i] = 'v' .. values[i] else values[i] = '' end
end
return values`;

/**
 * Writes one field (or deletes it, given "") only if it still holds what was
 * read: compared by SHA-1, as CAS_HASH in lib/reencrypt.ts does, so a large
 * value is not sent back with its replacement. "" stands for "had none": the
 * seam never stores "", and update() stops at an unusable entry before it gets
 * here. Every write encrypts with a fresh IV, so any rewrite in between differs.
 * update() hashes what it read on the client, which is the stored bytes: it
 * only writes over a value that decoded, and ciphertext is ASCII.
 * replaceUnreadable writes over damaged bytes, which need not be text at all,
 * so it compares against Redis's own hash of them (READ_ENTRY_HASHED).
 */
export const UPDATE_ENTRY = `-- nya:repo-update-entry
local cur = redis.call('HGET', KEYS[1], ARGV[1])
if (cur and redis.sha1hex(cur) or '') ~= ARGV[2] then return 0 end
if ARGV[3] == '' then redis.call('HDEL', KEYS[1], ARGV[1]) else redis.call('HSET', KEYS[1], ARGV[1], ARGV[3]) end
return 1`;

/**
 * Writes several fields of one hash, or deletes them, only if every one still
 * holds what was read, each compared by SHA-1 as UPDATE_ENTRY compares one:
 * all of the writes, or none. ARGV is a triple per field: its name, the SHA-1
 * of what was read ("" for none), and what to write: "" deletes it, and "="
 * leaves it as it is (it was read, so it is compared, but not written). The
 * seam stores neither "" nor "=". One key, so one script on one node.
 */
export const UPDATE_ENTRIES = `-- nya:repo-update-entries
for i = 1, #ARGV, 3 do
  local cur = redis.call('HGET', KEYS[1], ARGV[i])
  if (cur and redis.sha1hex(cur) or '') ~= ARGV[i + 1] then return 0 end
end
for i = 1, #ARGV, 3 do
  local new = ARGV[i + 2]
  if new == '' then redis.call('HDEL', KEYS[1], ARGV[i])
  elseif new ~= '=' then redis.call('HSET', KEYS[1], ARGV[i], new) end
end
return 1`;

/** The most entries one updateMany changes together. */
export const MANY_AT_ONCE = 16;

/**
 * Reads one field as READ_ENTRIES does, with Redis's own SHA-1 of the bytes it
 * holds, for replaceUnreadable's compare-and-set. The client decodes what it
 * reads as UTF-8 and replaces any byte sequence that isn't (Upstash's does,
 * through a TextDecoder that never fails), so for damaged bytes its own SHA-1
 * of what it read differs from the one UPDATE_ENTRY compares; this one is the
 * same by construction. The hash is prefixed "v" too, so nothing parses it.
 */
export const READ_ENTRY_HASHED = `-- nya:repo-read-entry-hashed
local v = redis.call('HGET', KEYS[1], ARGV[1])
if not v then return {'', ''} end
return {'v' .. v, 'v' .. redis.sha1hex(v)}`;

/** The error a counter store's take answers for a stored count that is not
 *  one, so it can be told from storage failing. */
const NOT_A_COUNT = 'ERR nya: the stored count is not a count';

/**
 * A counter store's window, read: its count (prefixed "v", so the client parses
 * nothing and the text is checked as stored) and its seconds left, or "" and 0
 * when no window is running. A count with no expiry (written by hand, or
 * restored from a copy taken in its last second, which records none) is given
 * a whole window here, so a limit can never stay shut for good; this is the one
 * write a read makes, and it only ever ends a window.
 */
export const COUNTER_READ = `-- nya:repo-counter-read
local n = redis.call('GET', KEYS[1])
if not n then return {'', 0} end
local ttl = redis.call('TTL', KEYS[1])
if ttl == -1 then
  redis.call('EXPIRE', KEYS[1], ARGV[1])
  ttl = tonumber(ARGV[1])
end
return {'v' .. n, ttl}`;

/**
 * Counts one in a counter store, in one step: refuses, writing nothing, if what
 * is there is not a count as INCR writes one (digits, no sign or leading zero),
 * then INCR, then a window of ARGV[1] seconds if the count has no expiry, which
 * a first count never has. A TTL of 0 is under a second left: that window is
 * still running, and is not given a fresh one. Answers the count and its
 * seconds left.
 */
export const COUNTER_TAKE = `-- nya:repo-counter-take
local cur = redis.call('GET', KEYS[1])
if cur and cur ~= '0' and not string.match(cur, '^[1-9]%d*$') then
  return redis.error_reply('${NOT_A_COUNT}')
end
local n = redis.call('INCR', KEYS[1])
local ttl = redis.call('TTL', KEYS[1])
if ttl < 0 then
  redis.call('EXPIRE', KEYS[1], ARGV[1])
  ttl = tonumber(ARGV[1])
end
return {n, ttl}`;

/** Fields read per READ_ENTRIES call, well inside Lua's limit for unpack. */
const READ_BATCH = 1000;
/** Tries before update() gives up on an entry that keeps changing. */
const UPDATE_ATTEMPTS = 5;
/** Characters of SHA-1 hex an update sends beside its new value. */
const SHA1_HEX = 40;

const sha1 = (s: string) => createHash('sha1').update(s, 'utf8').digest('hex');
/** A short, random pause before another try, longer each time, so writers that
 *  just collided do not collide again in step. */
const pause = (attempt: number) => new Promise((resolve) => setTimeout(resolve, 5 + Math.random() * 20 * attempt));

// The registry of declared stores, by name. Read through lib/stores.ts, which
// loads every declaring module first.
const declared = new Map<string, Store>();

/** Lowercase words joined by "-" or ":", like the listed key families. No glob
 *  characters, so a key pattern built from a name matches only it. */
const NAME = /^[a-z][a-z0-9]*(?:[-:][a-z0-9]+)*$/;

/** Why a well-formed name still cannot be a store's, or null. Each would put
 *  the store's key where something else is meant to be. */
function nameTaken(name: string): string | null {
  // Containers never nest, and an environment-wide store never belongs in one:
  // lib/reencrypt.ts reports either as a key built wrongly.
  if (name.startsWith('c:')) return 'a container';
  if (isEnvWide(name)) return 'an environment-wide store';
  // A store moving behind the seam takes its entry off the list in the same
  // change; anything else under a listed name would be read as that family.
  if (listedKind(name) !== null) return 'a key family stored the old way (lib/key-families.ts)';
  if (isExcluded(name)) return 'a key that backups leave out (lib/export.ts), so its data would never be backed up';
  return null;
}

function declare<S extends Store>(store: S): S {
  const { name } = store;
  if (!NAME.test(name) || name.length > 64) {
    throw new Error(`"${name}" cannot name a store: use lowercase words joined by "-" or ":", at most 64 long.`);
  }
  const taken = nameTaken(name);
  if (taken) throw new Error(`"${name}" cannot name a store: it is ${taken}.`);
  // The same name declared again with the same kind is its module being
  // evaluated again (a development reload), so the new declaration replaces the
  // old; test/repo.test.ts checks no two declarations in the code share a name.
  // A different kind would read the other's key as the wrong type.
  const earlier = declared.get(name);
  if (earlier && earlier.kind !== store.kind) {
    throw new Error(`The store "${name}" is already declared, as a ${earlier.kind} store.`);
  }
  declared.set(name, store);
  return store;
}

/** Ids are field names, plaintext in the database (see the header). "__proto__"
 *  is refused because the Upstash client builds HGETALL's answer as a plain
 *  object, where that field would silently vanish. The id is never quoted in
 *  the message: if it is content, it does not belong in a log either. */
const ID = /^[A-Za-z0-9_.:-]{1,200}$/;

function checkId(what: string, id: unknown): string {
  if (typeof id !== 'string' || !ID.test(id) || id === '__proto__') {
    throw new TypeError(`Invalid id for ${what}: use an opaque id of letters, digits and "_.:-", at most 200 long.`);
  }
  return id;
}

/** The one key the seam builds: a declared store's, in a container. */
function storeKey(ctx: Ctx, name: string): string {
  return kc(ctx, name);
}

type Codec<T> = Pick<StoreOptions<T>, 'what' | 'isValid' | 'upgrade' | 'compress'>;

/** Why a stored value cannot be used by its own doing (see READS above). */
type Flaw = { ok: false; flaw: 'unreadable' | 'unrecognised'; cause: unknown };
/** A stored value read back, or why it cannot be used. */
type Decoded<T> = { ok: true; value: T } | Flaw;
/** A stored value's text, decrypted (and decompressed), or why it cannot be had. */
export type Opened = { ok: true; text: string } | Flaw;

const flawed = (flaw: 'unreadable' | 'unrecognised', cause: unknown): Flaw => ({ ok: false, flaw, cause });

/**
 * A stored value's text, compressed or not. Throws only what says nothing
 * about the value: a deployment that cannot read it (MasterKeyError for no
 * master key or one that does not open the data key, UnknownKeyError for a
 * key the key store lacks, a failed decrypt under k0, decompression failing,
 * storage unreachable). Damaged bytes are not ciphertext, or ciphertext that
 * fails to authenticate under a data key, whose id commits to its key. Under
 * k0 the same failure could as well be a replaced PLAID_ENCRYPTION_KEY, and no
 * other value can settle which (values written under a new k0 decrypt beside
 * old ones that cannot), so it is always thrown.
 */
async function openText(stored: unknown): Promise<Opened> {
  // The client JSON-parses what it can on the way out, so anything but
  // non-empty text was never written by the seam, nor by a store before it.
  if (typeof stored !== 'string' || stored === '') return flawed('unreadable', new Error('stored value is not encrypted text'));
  // What a later version may write (a version tag or flag this code does not
  // know, or a value bound to a context, which this code never passes) is
  // intact as far as this code can tell, so a rollback never offers it for
  // removal.
  try {
    if (formatOf(stored).flags.includes('c')) return flawed('unrecognised', new Error('stored value is bound to a context'));
  } catch (err) {
    if (err instanceof UnsupportedFormatError) return flawed('unrecognised', err);
    if (err instanceof MalformedCiphertextError) return flawed('unreadable', err);
    throw err;
  }
  try {
    return { ok: true, text: await decryptJsonText(stored) }; // compressed or not
  } catch (err) {
    if (err instanceof MalformedCiphertextError) return flawed('unreadable', err); // not base64, or too short
    if (err instanceof DecryptFailedError && err.keyId !== 'k0') return flawed('unreadable', err);
    throw err;
  }
}

/**
 * Opens a value that a store kept outside the seam holds (balance history,
 * manual accounts), for a reader that reports what it cannot use as
 * getAllReport does instead of throwing: its text, or why it cannot be had,
 * by exactly the rules every read here follows (see READS above), so a
 * deployment problem is thrown as it is and never reported as damage. Text it
 * has is the reader's to understand: text it does not (not JSON, not the
 * shape it keeps) is unrecognised, as here. Reads nothing from storage.
 */
export function openStored(stored: unknown): Promise<Opened> {
  return openText(stored);
}

/** Reads a stored value back, as openText does, then parses and checks it.
 *  Also throws an upgrade that throws (a bug, never the data's doing). */
async function decode<T>(c: Codec<T>, stored: unknown): Promise<Decoded<T>> {
  const opened = await openText(stored);
  if (!opened.ok) return opened;
  let parsed: unknown;
  try {
    parsed = JSON.parse(opened.text);
  } catch (err) {
    return flawed('unrecognised', err);
  }
  const value = c.upgrade ? c.upgrade(parsed) : parsed;
  if (!c.isValid(value)) return flawed('unrecognised', new Error('stored value has a shape this code does not recognise'));
  return { ok: true, value };
}

/** The JSON a value is stored as, refused (a bug in the caller, not damaged
 *  data) unless it reads back valid: in the current shape, and after upgrade. */
function serialize<T>(c: Codec<T>, value: T): string {
  const json = JSON.stringify(value);
  const valid = json !== undefined && c.isValid(JSON.parse(json)) && (!c.upgrade || c.isValid(c.upgrade(JSON.parse(json))));
  if (!valid) throw new TypeError(`Refusing to save ${c.what}: the value does not have the shape they are stored in.`);
  return json;
}

/** Exactly the checked JSON, encrypted, and compressed first if asked. */
function encode<T>(c: Codec<T>, json: string): Promise<string> {
  return c.compress ? encodeJsonText(json) : encrypt(json);
}

/** Refuses a write whose request would cross the ceiling in lib/blob.ts, loudly
 *  and whole, as lib/transactions.ts does: nothing is trimmed to fit. */
function checkSize(name: string, what: string, ctx: Ctx, chars: number): void {
  const limit = maxBlobChars();
  if (chars > limit) {
    console.error(
      `repo: refusing to save ${name} in container ${ctx.container}: ${chars} chars, over the ${limit} ceiling. Nothing was written or dropped.`
    );
    throw new StoredValueTooLargeError(what, chars, limit);
  }
  if (chars > blobWarnChars()) {
    console.warn(`repo: ${name} in container ${ctx.container} is ${chars} chars, past ${Math.round((chars / limit) * 100)}% of the ceiling`);
  }
}

/** Declares a store holding one encrypted JSON value per container. */
export function defineValueStore<T>(name: string, opts: StoreOptions<T>): ValueStore<T> {
  const codec: Codec<T> = { what: opts.what, isValid: opts.isValid, upgrade: opts.upgrade, compress: opts.compress };
  const { what } = codec;
  const key = (ctx: Ctx) => storeKey(ctx, name);

  /** The value decoded, or null when none was ever saved. */
  const readDecoded = async (ctx: Ctx): Promise<Decoded<T> | null> => {
    // Uncaught: a failure to reach storage is never "never saved".
    const stored = await redis().get<unknown>(key(ctx));
    // Text that reads as nothing (empty, or the JSON literal null, which the
    // client parses) is never saved, as in lib/stored-json.ts. The seam writes
    // neither, and replacing one loses nothing.
    if (stored === null || stored === undefined || stored === '') return null;
    return decode(codec, stored);
  };

  const read = async (ctx: Ctx): Promise<T | null> => {
    const d = await readDecoded(ctx);
    if (d === null) return null;
    if (d.ok) return d.value;
    throw new UnreadableValueError(what, d.flaw === 'unrecognised', d.cause);
  };

  return declare<ValueStore<T>>({
    kind: 'value',
    name,
    what,
    exportable: opts.exportable,
    get: read,
    async getReport(ctx) {
      const d = await readDecoded(ctx);
      if (d === null) return { value: null, unreadable: false, unrecognised: false };
      if (d.ok) return { value: d.value, unreadable: false, unrecognised: false };
      return { value: null, unreadable: d.flaw === 'unreadable', unrecognised: d.flaw === 'unrecognised' };
    },
    async set(ctx, value) {
      const json = serialize(codec, value);
      await read(ctx); // throws, so nothing is written, if what is there cannot be read
      const encoded = await encode(codec, json);
      checkSize(name, what, ctx, encoded.length);
      await redis().set(key(ctx), encoded);
    },
    async remove(ctx) {
      await redis().del(key(ctx));
    },
  });
}

/** Declares a store holding one encrypted JSON value per id, per container. */
export function defineMapStore<T>(name: string, opts: StoreOptions<T>): MapStore<T> {
  const codec: Codec<T> = { what: opts.what, isValid: opts.isValid, upgrade: opts.upgrade, compress: opts.compress };
  const { what } = codec;
  const key = (ctx: Ctx) => storeKey(ctx, name);

  /** Each field's stored text, exactly, or null where there is none. */
  const readFields = async (ctx: Ctx, ids: string[]): Promise<(string | null)[]> => {
    const out: (string | null)[] = [];
    for (let i = 0; i < ids.length; i += READ_BATCH) {
      const batch = ids.slice(i, i + READ_BATCH);
      const answer = await redis().eval(READ_ENTRIES, [key(ctx)], batch);
      if (!Array.isArray(answer) || answer.length !== batch.length || !answer.every((v) => typeof v === 'string')) {
        throw new Error(`repo: unexpected answer reading ${name}`);
      }
      for (const v of answer as string[]) out.push(v === '' ? null : v.slice(1));
    }
    return out;
  };

  /** Entries decoded, in the order given: the usable ones, and the ids of the
   *  unreadable and the unrecognised. A deployment problem is thrown: it says
   *  nothing about the entries, so none is reported or left out for it. */
  const decodeAll = async (entries: (readonly [string, unknown])[]) => {
    const results = await Promise.all(entries.map(async ([id, stored]) => ({ id, d: await decode(codec, stored) })));
    const values = new Map<string, T>();
    const unreadable: string[] = [];
    const unrecognised: string[] = [];
    let cause: unknown;
    for (const { id, d } of results) {
      if (d.ok) values.set(id, d.value);
      else {
        (d.flaw === 'unreadable' ? unreadable : unrecognised).push(id);
        cause ??= d.cause;
      }
    }
    return { values, unreadable: unreadable.sort(), unrecognised: unrecognised.sort(), cause };
  };

  const strict = (r: Awaited<ReturnType<typeof decodeAll>>) => {
    if (r.unreadable.length > 0 || r.unrecognised.length > 0) {
      throw new UnreadableEntriesError(what, r.unreadable, r.unrecognised, r.cause);
    }
    return r.values;
  };

  const readAll = async (ctx: Ctx) => {
    // Uncaught: a failure to reach storage is never an empty map.
    const stored = (await redis().hgetall<Record<string, unknown>>(key(ctx))) ?? {};
    return decodeAll(
      Object.keys(stored)
        .sort()
        .map((id) => [id, stored[id]] as const)
    );
  };

  const getMany = async (ctx: Ctx, ids: Iterable<string>): Promise<Map<string, T>> => {
    const wanted = [...new Set([...ids].map((id) => checkId(what, id)))];
    if (wanted.length === 0) return new Map();
    const stored = await readFields(ctx, wanted);
    const present = wanted.flatMap((id, i) => (stored[i] === null ? [] : [[id, stored[i]] as const]));
    return strict(await decodeAll(present));
  };

  const setMany = async (ctx: Ctx, entries: Iterable<readonly [string, T]>): Promise<void> => {
    // Everything is checked before anything is written.
    const checked = [...entries].map(([id, value]) => [checkId(what, id), serialize(codec, value)] as const);
    if (checked.length === 0) return;
    const fields = Object.fromEntries(await Promise.all(checked.map(async ([id, json]) => [id, await encode(codec, json)] as const)));
    checkSize(name, what, ctx, Object.entries(fields).reduce((n, [id, v]) => n + id.length + v.length, 0));
    await redis().hset(key(ctx), fields);
  };

  const update = async (ctx: Ctx, id: string, fn: (current: T | null) => T | null | Promise<T | null>): Promise<T | null> => {
    checkId(what, id);
    for (let attempt = 1; ; attempt++) {
      const [stored] = await readFields(ctx, [id]);
      let current: T | null = null;
      if (stored !== null) {
        const d = await decode(codec, stored);
        if (!d.ok) {
          throw new UnreadableEntriesError(what, d.flaw === 'unreadable' ? [id] : [], d.flaw === 'unrecognised' ? [id] : [], d.cause);
        }
        current = d.value;
      }
      const next = await fn(current);
      if (next === null && stored === null) return null; // nothing there, nothing to write
      let written = ''; // deletes it
      if (next !== null) {
        written = await encode(codec, serialize(codec, next));
        checkSize(name, what, ctx, id.length + SHA1_HEX + written.length);
      }
      const seen = stored === null ? '' : sha1(stored);
      if (Number(await redis().eval(UPDATE_ENTRY, [key(ctx)], [id, seen, written])) === 1) return next;
      if (attempt >= UPDATE_ATTEMPTS) throw new UpdateConflictError(what);
      await pause(attempt);
    }
  };

  const updateMany = async (
    ctx: Ctx,
    ids: Iterable<string>,
    fn: (current: Map<string, T | null>) => Map<string, T | null> | Promise<Map<string, T | null>>
  ): Promise<Map<string, T | null>> => {
    const wanted = [...new Set([...ids].map((id) => checkId(what, id)))];
    if (wanted.length > MANY_AT_ONCE) throw new TypeError(`updateMany changes at most ${MANY_AT_ONCE} ${what} at once.`);
    if (wanted.length === 0) return new Map();
    for (let attempt = 1; ; attempt++) {
      const stored = await readFields(ctx, wanted);
      const read = await decodeAll(wanted.flatMap((id, i) => (stored[i] === null ? [] : [[id, stored[i]] as const])));
      if (read.unreadable.length > 0 || read.unrecognised.length > 0) {
        throw new UnreadableEntriesError(what, read.unreadable, read.unrecognised, read.cause);
      }
      const current = new Map(wanted.map((id) => [id, read.values.get(id) ?? null] as const));
      const next = await fn(current);
      for (const id of next.keys()) {
        if (!current.has(id)) throw new TypeError(`updateMany may only write the ${what} it read.`);
      }
      // Every entry is sent, so each is compared; only those with a change are
      // written. Deleting an entry that isn't there changes nothing.
      const args: string[] = [];
      let chars = 0;
      let writes = 0;
      for (const [i, id] of wanted.entries()) {
        let written = '=';
        if (next.has(id)) {
          const value = next.get(id) ?? null;
          if (value !== null) written = await encode(codec, serialize(codec, value));
          else if (stored[i] !== null) written = '';
        }
        if (written !== '=') writes++;
        args.push(id, stored[i] === null ? '' : sha1(stored[i]!), written);
        chars += id.length + SHA1_HEX + written.length;
      }
      if (writes === 0) return next;
      checkSize(name, what, ctx, chars);
      if (Number(await redis().eval(UPDATE_ENTRIES, [key(ctx)], args)) === 1) return next;
      if (attempt >= UPDATE_ATTEMPTS) throw new UpdateConflictError(what);
      await pause(attempt);
    }
  };

  return declare<MapStore<T>>({
    kind: 'map',
    name,
    what,
    exportable: opts.exportable,
    async get(ctx, id) {
      return (await getMany(ctx, [id])).get(id) ?? null;
    },
    getMany,
    getAll: async (ctx) => strict(await readAll(ctx)),
    async getAllReport(ctx) {
      const { values, unreadable, unrecognised } = await readAll(ctx);
      return { entries: values, unreadable, unrecognised };
    },
    getAllLenient: async (ctx) => (await readAll(ctx)).values,
    set: (ctx, id, value) => setMany(ctx, [[id, value]]),
    setMany,
    update,
    updateMany,
    async remove(ctx, ...ids) {
      for (const id of ids) checkId(what, id);
      if (ids.length > 0) await redis().hdel(key(ctx), ...ids);
    },
    async count(ctx) {
      return Number(await redis().hlen(key(ctx)));
    },
    async has(ctx, id) {
      return Number(await redis().hexists(key(ctx), checkId(what, id))) === 1;
    },
    async replaceUnreadable(ctx, id, value) {
      checkId(what, id);
      const written = await encode(codec, serialize(codec, value));
      checkSize(name, what, ctx, id.length + SHA1_HEX + written.length);
      const answer = await redis().eval(READ_ENTRY_HASHED, [key(ctx)], [id]);
      if (!Array.isArray(answer) || answer.length !== 2 || !answer.every((v) => typeof v === 'string')) {
        throw new Error(`repo: unexpected answer reading ${name}`);
      }
      const [stored, hash] = answer as [string, string];
      if (stored === '') return false;
      // Thrown as it is when this deployment can't read it (a failed decrypt
      // under k0 among them): that says nothing about the bytes.
      const d = await decode(codec, stored.slice(1));
      if (d.ok || d.flaw !== 'unreadable') return false;
      // The same compare-and-set as update(), only over the bytes just read,
      // as Redis hashes them: what the client read may not be those bytes.
      return Number(await redis().eval(UPDATE_ENTRY, [key(ctx)], [id, hash.slice(1), written])) === 1;
    },
  });
}

export type CounterOptions = {
  /** What it holds, plural, for messages: "Your saved {what} could not be
   *  read" (a count that is not one). */
  what: string;
  /** How long a window lasts, from its first count: a whole number of seconds. */
  windowSeconds: number;
};

/** A count as COUNTER_READ answers it: digits only, as INCR writes them. */
const COUNT = /^v(0|[1-9][0-9]*)$/;

/**
 * Declares a counter store: a count per container in a fixed window (see TWO
 * SHAPES above). The service's bookkeeping, so never exportable: it is left out
 * of the person's data download. Values are plain integers, which the
 * re-encryption pass knows (classify() in lib/reencrypt.ts).
 */
export function defineCounterStore(name: string, opts: CounterOptions): CounterStore {
  const { what, windowSeconds } = opts;
  if (!Number.isInteger(windowSeconds) || windowSeconds < 1) {
    throw new Error(`The window of "${name}" must be a whole number of seconds, 1 or more.`);
  }
  const key = (ctx: Ctx) => storeKey(ctx, name);
  /** The window from a script's answer, checked: anything else says the
   *  count cannot be used, never that nothing was counted. */
  const windowOf = (answer: unknown, counted: boolean): CounterWindow => {
    if (!Array.isArray(answer) || answer.length !== 2 || !Number.isInteger(Number(answer[1]))) {
      throw new Error(`repo: unexpected answer counting ${name}`);
    }
    const [raw, ttl] = [answer[0], Number(answer[1])];
    if (!counted && raw === '') return { count: 0, secondsLeft: 0 };
    const count = counted ? Number(raw) : typeof raw === 'string' && COUNT.test(raw) ? Number(raw.slice(1)) : NaN;
    // Damaged (not a count, or a count no INCR wrote): unreadable, and thrown,
    // so a limit built on it stays shut rather than open. The window's expiry
    // still ends it.
    if (!Number.isSafeInteger(count) || count < (counted ? 1 : 0)) throw new UnreadableValueError(what, false);
    return { count, secondsLeft: Math.max(1, ttl) };
  };
  return declare<CounterStore>({
    kind: 'counter',
    name,
    what,
    exportable: false,
    windowSeconds,
    async read(ctx) {
      return windowOf(await redis().eval(COUNTER_READ, [key(ctx)], [String(windowSeconds)]), false);
    },
    async take(ctx) {
      let answer: unknown;
      try {
        answer = await redis().eval(COUNTER_TAKE, [key(ctx)], [String(windowSeconds)]);
      } catch (err) {
        // The script's refusal of a damaged count blames it, as read does.
        if (err instanceof Error && err.message.includes(NOT_A_COUNT)) throw new UnreadableValueError(what, false, err);
        throw err;
      }
      return windowOf(answer, true);
    },
  });
}

/**
 * Every store declared so far, by name. For lib/stores.ts, which imports every
 * declaring module before it reads this, so its answer is complete. Read
 * anywhere else, it holds only the stores whose modules happen to have loaded.
 */
export function storesDeclaredSoFar(): ReadonlyMap<string, Store> {
  return declared;
}

/** For tests: forgets a store a test declared, so the test files after it see
 *  only the app's own stores. */
export function forgetDeclaredStore(name: string): void {
  declared.delete(name);
}
