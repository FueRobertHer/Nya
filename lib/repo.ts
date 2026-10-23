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
// And two for the service's own bookkeeping:
//
//   defineCounterStore  a count per container in a fixed window that starts
//                       with its first count and ends on its own (a rate
//                       limit, such as downloads of my data). Not the
//                       person's data, so never encrypted or exported. In
//                       Redis, one integer key with an expiry, counted in
//                       Lua; in a table, a row with the count and the end of
//                       its window.
//   defineCounterMapStore  the same, a count per id within a container (a
//                       rate limit per API token). In Redis, one hash with a
//                       field per id holding its count and the end of its
//                       window, counted in Lua, the hash kept a window past
//                       its last count so it goes on its own; in a table, a
//                       row per id.
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
// is for data one person edits at a time; where the app also changes it on its
// own (the categories, grown from what transactions say while the person may
// be renaming one), ValueStore.update() is the same compare-and-set for it.
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
// declared store is in the key inventory by construction. A store holding a
// credential that a restore must never bring back (API tokens, a connector's
// credential) is declared `backup: false`, and lib/export.ts leaves its key out
// of every backup. And give it an entry in lib/inventory.ts, in plain words,
// so the person's list of what Nya keeps about them (Your data) names it:
// test/inventory.test.ts fails until it has one.
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
// report the unrecognised ones as a problem to fix. MapStore.replaceUnreadable
// is that removal with a value put in its place, in one step: it writes only
// over an entry whose bytes are damaged and still the bytes it read, so it can
// never replace one that reads, or one that is unrecognised.
// ValueStore.getReport says of a value store's one value what getAllReport
// says of entries. A store kept outside the seam whose reader reports what it
// can't use the same way tells the kinds apart with openStored (or
// openStoredJson), so every report draws the line where the seam does.
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
// environment prefix, so a restore into another namespace still reads), and
// teach the pass the same context; classify() already maps a key to its
// declaration.
//
// ENCRYPTED FOR ITS CONTAINER. Every value is encrypted and decrypted with the
// Ctx its method was given, the container its key is in (lib/crypto.ts, "A
// data key per container"), so a container's values are under that
// container's own key once it has one. A byte-for-byte copy of them into
// another container no longer reads there, by design: moving data between
// containers means decrypting under one and encrypting under the other. A
// value found under another container's key is unrecognised (never offered
// for removal), and a container whose own key can't be used throws
// ContainerKeyError, a ContainerError (503).
//
// AN OPERATION THE SEAM LACKS is added here as a named method with its own
// contract test (and its Lua, if it must be atomic), never as raw key access.
//
// MEASURING A WHOLE CONTAINER: measureContainer. How much each key of one
// container holds (its type, entries, characters and largest value), every
// key the container has, the older stores' and the seam's alike, for the
// person's own list of what Nya keeps about them (lib/inventory.ts); and
// measureContainers, the same for several containers with one walk, for the
// admin's view of storage across accounts (lib/admin-storage.ts). They never
// hand back a value: with `heads`, only which key each value says it is
// encrypted under, counted. They write nothing, and build no key: they walk
// the containers' own prefixes and measure what they find there.
//
// PUBLIC DATA, THE ONE EXCEPTION TO CONTAINERS ONLY: definePublicMapStore. A
// store of data that belongs to no one and is the same for everyone (the
// ECB's published exchange rates, lib/fx/ecb-store.ts), kept once for the
// whole environment rather than once per container. Its values are plain JSON,
// never encrypted (there is nothing of anyone's to protect, and encrypting
// would tie public data to the environment's keys), never in anyone's
// download, and left out of backups and kept through restores (lib/export.ts
// REFETCHED_PREFIXES): it can always be fetched again. Its name must be under a
// prefix listed as environment-wide (ENV_WIDE_PREFIXES in lib/containers.ts),
// so a container store can't take it and a copy built inside a container is
// reported, and it has a registry of its own, so nothing that walks the
// containers' stores (the download, deletion) meets it. classify() in
// lib/reencrypt.ts knows it as plain text. Never for anything about a person:
// declaring one is a reviewed change, like adding to kEnv's list.

import { createHash } from 'node:crypto';
import { redis, kc, kEnv, containerPrefix } from './storage';
import { isEnvWide, type Ctx } from './containers';
import { encrypt, formatOf, DecryptFailedError, KeyNotForContainerError, MalformedCiphertextError, UnsupportedFormatError } from './crypto';
import { StoredDataUnreadableError } from './stored-json';
import { decryptJsonText, encodeJsonText, maxBlobChars, blobWarnChars } from './blob';
import { listedKind } from './key-families';
import { isExcluded, isRefetched } from './export';

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
  /** False only for a credential a restore must never bring back (an API
   *  token, which a restore could otherwise revive after it was revoked, or a
   *  connector's credential, which it could revive after the person
   *  disconnected it): its key is left out of every backup, and lib/export.ts
   *  must list it in EXCLUDED_PREFIXES, which declare() checks both ways. A
   *  restore then deletes what is there and brings none back. Backed up by
   *  default. */
  backup?: false;
};

type Declared = {
  /** The key family: each container's data is at "<env>:c:<container>:<name>". */
  readonly name: string;
  readonly what: string;
  readonly exportable: boolean;
  /** In backups (lib/export.ts), unless declared `backup: false`. */
  readonly backedUp: boolean;
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
  /** Changes the value safely when something else may change it too, as
   *  MapStore.update changes an entry: reads it (strictly), computes the new
   *  value with `fn` (null deletes it), and writes only if it is still what
   *  was read, else waits a moment and runs `fn` again on what is there now, a
   *  few times before UpdateConflictError. `fn` may run more than once: it
   *  should only compute. `fn` answering the value it was given, unchanged,
   *  writes nothing, so "nothing to do" never makes a concurrent update try
   *  again. Returns what was written, or what is there. */
  update(ctx: Ctx, fn: (current: T | null) => T | null | Promise<T | null>): Promise<T | null>;
  /** Deletes the value, readable or not. */
  remove(ctx: Ctx): Promise<void>;
  /** How much it stores (StoreSize), readable or not, without reading the
   *  value. One request. */
  size(ctx: Ctx): Promise<StoreSize>;
  /** Pure, reading nothing: `value` as this store's reads would take it (after
   *  a JSON round trip, upgraded, checked with isValid), or null when they
   *  would take it as unrecognised. For a value from outside the store (a
   *  download being brought back, lib/user-restore/) before it is written. */
  check(value: unknown): T | null;
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
  /** How much it stores (StoreSize), readable or not, without reading any
   *  value. One request (MAP_SIZE). */
  size(ctx: Ctx): Promise<StoreSize>;
  /** Pure, reading nothing: an entry's `value` as this store's reads would
   *  take it, or null (see ValueStore.check). */
  check(value: unknown): T | null;
};

/**
 * How much a value or map store holds in a container, measured, never read:
 * what storage usage reports (lib/blob-sizes.ts). Characters are bytes here:
 * every value is ASCII ciphertext (lib/blob.ts), as is every id.
 */
export type StoreSize = {
  /** Entries stored, readable or not: 0 or 1 for a value store. */
  entries: number;
  /** Characters stored, ids and values together. */
  chars: number;
  /** The largest value: its id (null for a value store's one value) and its
   *  characters; null when nothing is stored. Each write is held to the
   *  request ceiling on its own (lib/blob.ts), so this is the one nearest it. */
  largest: { id: string | null; chars: number } | null;
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

export type CounterMapStore = Declared & {
  readonly kind: 'counter-map';
  /** How long a window lasts, from its first count. */
  readonly windowSeconds: number;
  /** Counts one for `id`, atomically, starting a window for it if none is
   *  running, and answers its window with this one counted. Each id counts
   *  apart from the others, and two callers racing never get the same count,
   *  so the count is what decides. `now` (ms) is the clock the window is
   *  measured by: the caller's, and a test's own. Throws if it cannot count,
   *  so a limit built on it fails closed. */
  take(ctx: Ctx, id: string, now?: number): Promise<CounterWindow>;
  /** Forgets these ids' windows, counted or not. */
  remove(ctx: Ctx, ...ids: string[]): Promise<void>;
};

export type Store = ValueStore<unknown> | MapStore<unknown> | CounterStore | CounterMapStore;

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
 * Reads a value store's key exactly, as READ_ENTRIES reads a field: "v" and
 * its stored text, or "" where there is none, so the client parses nothing
 * and ValueStore.update hashes the text it read. A hash at the key is Redis's
 * WRONGTYPE.
 */
export const READ_VALUE = `-- nya:repo-read-value
local v = redis.call('GET', KEYS[1])
if not v then return '' end
return 'v' .. v`;

/**
 * Writes a value store's key (or deletes it, given "") only if it still holds
 * what was read, compared by SHA-1 as UPDATE_ENTRY compares a field, "" for
 * "had none". Every write encrypts with a fresh IV, so any save in between
 * differs.
 */
export const UPDATE_VALUE = `-- nya:repo-update-value
local cur = redis.call('GET', KEYS[1])
if (cur and redis.sha1hex(cur) or '') ~= ARGV[1] then return 0 end
if ARGV[2] == '' then redis.call('DEL', KEYS[1]) else redis.call('SET', KEYS[1], ARGV[2]) end
return 1`;

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

/**
 * How much a map store's hash holds, in one step, without reading a value:
 * its number of fields, the bytes of every field name and value together, and
 * the largest value's field (prefixed "v", so nothing parses it) and bytes,
 * the lowest field name among equals, so the answer doesn't depend on the
 * order HKEYS gives. Bytes as Redis stores them, so a damaged value counts
 * what it holds. A string at the key is Redis's WRONGTYPE.
 */
export const MAP_SIZE = `-- nya:repo-size
local fields = redis.call('HKEYS', KEYS[1])
if #fields == 0 then return {0, 0, '', 0} end
local chars, largest, most = 0, '', -1
for i = 1, #fields do
  local n = redis.call('HSTRLEN', KEYS[1], fields[i])
  chars = chars + #fields[i] + n
  if n > most or (n == most and fields[i] < largest) then
    largest = fields[i]
    most = n
  end
end
return {#fields, chars, 'v' .. largest, most}`;

/**
 * How much each key named holds (measureContainer), in one step, without
 * handing back a value: for each, {type, entries, bytes, largest, heads}. A
 * string is one entry; a hash's entries are its fields, its bytes every field
 * name and value together, and its largest its longest value. Bytes as Redis
 * stores them. A key gone since the walk is "none"; a type the app never
 * writes (a list, a set) is measured as nothing, by its type's name.
 *
 * `heads` (ARGV[1] "1") counts, for each key, the key each value claims to be
 * encrypted under, from its first 64 bytes alone (lib/crypto.ts, Formats): a
 * versioned value's key id, "?" for one in that shape whose id can't be read,
 * "k0" for an unversioned value of base64 long enough to be ciphertext under
 * the original key, and "-" for anything else (plain text, or damage), as
 * "<claim>=<count>" joined by commas, prefixed "v" so nothing parses it. A
 * string's head is read with GETRANGE, at no cost for its size; Redis has no
 * such read of a hash field, so a hash's values are read whole inside Redis
 * for theirs, and only the counts leave it. That is bounded: ARGV[2] is the
 * bytes of hash values one step may read for heads (HEADS_STEP_BYTES), and a
 * value past it is "+", not looked at, so a step never holds Redis for long
 * whatever the values' size.
 */
export const MEASURE_KEYS = `-- nya:repo-measure-keys
local heads = ARGV[1] == '1'
local budget = tonumber(ARGV[2]) or 0
local spent = 0
local function claim(head, n)
  local id = string.match(head, '^v2%.(k[%w%-]+)%.')
  if id then return id end
  if string.sub(head, 1, 3) == 'v2.' then return '?' end
  if n >= 40 and string.match(head, '^[A-Za-z0-9+/=]+$') then return 'k0' end
  return '-'
end
local function encode(t)
  local parts = {}
  for c, k in pairs(t) do parts[#parts + 1] = c .. '=' .. k end
  return 'v' .. table.concat(parts, ',')
end
local out = {}
for i = 1, #KEYS do
  local key = KEYS[i]
  local t = redis.call('TYPE', key)['ok']
  local claims = {}
  if t == 'string' then
    local n = redis.call('STRLEN', key)
    if heads then
      local c = claim(redis.call('GETRANGE', key, 0, 63), n)
      claims[c] = 1
    end
    out[i] = {'string', 1, n, n, encode(claims)}
  elseif t == 'hash' then
    local fields = redis.call('HKEYS', key)
    local chars, most = 0, 0
    for j = 1, #fields do
      local n = redis.call('HSTRLEN', key, fields[j])
      chars = chars + #fields[j] + n
      if n > most then most = n end
      if heads then
        local c = '+'
        if spent + n <= budget then
          spent = spent + n
          c = claim(string.sub(redis.call('HGET', key, fields[j]), 1, 64), n)
        end
        claims[c] = (claims[c] or 0) + 1
      end
    end
    out[i] = {'hash', #fields, chars, most, encode(claims)}
  else
    out[i] = {t, 0, 0, 0, 'v'}
  end
end
return out`;

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

/**
 * Counts one for an id in a counter map store, in one step. Each field holds
 * "<count>:<end of its window>" (whole seconds since 1970, by the clock of
 * whoever started the window). ARGV: the id, now and the window, in seconds.
 * A window that has ended, or ends further ahead than any could (a clock that
 * moved back), starts again. The hash is kept two windows past its last count,
 * so it outlives every window in it (with room for clocks a little apart) and
 * goes on its own once nothing counts. What is there and is not a count as
 * this writes one is refused, writing nothing but that expiry, should the hash
 * have none (one restored by hand), so it can't stay forever. Answers the
 * count and its seconds left.
 */
export const COUNTERS_TAKE = `-- nya:repo-counters-take
local now = tonumber(ARGV[2])
local window = tonumber(ARGV[3])
local raw = redis.call('HGET', KEYS[1], ARGV[1])
local count, ends = 0, 0
if raw then
  local c, e = string.match(raw, '^([1-9]%d*):([1-9]%d*)$')
  if not c then
    if redis.call('TTL', KEYS[1]) < 0 then redis.call('EXPIRE', KEYS[1], 2 * window) end
    return redis.error_reply('${NOT_A_COUNT}')
  end
  count, ends = tonumber(c), tonumber(e)
end
if ends <= now or ends - now > 2 * window then
  count = 0
  ends = now + window
end
count = count + 1
redis.call('HSET', KEYS[1], ARGV[1], count .. ':' .. ends)
redis.call('EXPIRE', KEYS[1], 2 * window)
return {count, ends - now}`;

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
 *  the store's key where something else is meant to be. `backedUp` false is a
 *  store declared out of backups, whose key lib/export.ts must leave out. */
function nameTaken(name: string, backedUp: boolean): string | null {
  // Containers never nest, and an environment-wide store never belongs in one:
  // lib/reencrypt.ts reports either as a key built wrongly.
  if (name.startsWith('c:')) return 'a container';
  if (isEnvWide(name)) return 'an environment-wide store';
  // A store moving behind the seam takes its entry off the list in the same
  // change; anything else under a listed name would be read as that family.
  if (listedKind(name) !== null) return 'a key family stored the old way (lib/key-families.ts)';
  if (backedUp && isExcluded(name)) return 'a key that backups leave out (lib/export.ts), so its data would never be backed up';
  if (!backedUp && !isExcluded(name)) return 'declared out of backups, but lib/export.ts would back it up: list it in EXCLUDED_PREFIXES';
  return null;
}

function declare<S extends Store>(store: S): S {
  const { name } = store;
  if (!NAME.test(name) || name.length > 64) {
    throw new Error(`"${name}" cannot name a store: use lowercase words joined by "-" or ":", at most 64 long.`);
  }
  const taken = nameTaken(name, store.backedUp);
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
export type Decoded<T> = { ok: true; value: T } | Flaw;
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
async function openText(ctx: Ctx, stored: unknown): Promise<Opened> {
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
    return { ok: true, text: await decryptJsonText(ctx, stored) }; // compressed or not
  } catch (err) {
    // Under another container's key: intact as far as anything can tell, and
    // not this container's to remove (lib/crypto.ts KeyNotForContainerError).
    if (err instanceof KeyNotForContainerError) return flawed('unrecognised', err);
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
export function openStored(ctx: Ctx, stored: unknown): Promise<Opened> {
  return openText(ctx, stored);
}

/**
 * openStored, then parsed and checked as a store's own reads check a value
 * (decode), for a value kept outside the seam whose shape is one check
 * (budgets and goals, read for the download of my data): text that is not
 * JSON, or JSON `isValid` rejects, is unrecognised. Reads nothing from
 * storage.
 */
export function openStoredJson<T>(ctx: Ctx, stored: unknown, isValid: (v: unknown) => v is T): Promise<Decoded<T>> {
  return decode(ctx, { what: 'a stored value', isValid }, stored);
}

/** Reads a stored value back, as openText does, then parses and checks it.
 *  Also throws an upgrade that throws (a bug, never the data's doing). */
async function decode<T>(ctx: Ctx, c: Codec<T>, stored: unknown): Promise<Decoded<T>> {
  const opened = await openText(ctx, stored);
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

/** A value from outside as a store's reads would take it: after a JSON round
 *  trip (so what is checked is what would be written), upgraded, and valid;
 *  null otherwise. Never throws on a value that can't be written as JSON. */
function checked<T>(c: Codec<T>, value: unknown): T | null {
  let json: string | undefined;
  try {
    json = JSON.stringify(value);
  } catch {
    return null;
  }
  if (json === undefined) return null;
  const parsed: unknown = JSON.parse(json);
  const v = c.upgrade ? c.upgrade(parsed) : parsed;
  return c.isValid(v) ? v : null;
}

/** Exactly the checked JSON, encrypted for the container, and compressed
 *  first if asked. */
function encode<T>(ctx: Ctx, c: Codec<T>, json: string): Promise<string> {
  return c.compress ? encodeJsonText(ctx, json) : encrypt(ctx, json);
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
    return decode(ctx, codec, stored);
  };

  const read = async (ctx: Ctx): Promise<T | null> => {
    const d = await readDecoded(ctx);
    if (d === null) return null;
    if (d.ok) return d.value;
    throw new UnreadableValueError(what, d.flaw === 'unrecognised', d.cause);
  };

  const update = async (ctx: Ctx, fn: (current: T | null) => T | null | Promise<T | null>): Promise<T | null> => {
    for (let attempt = 1; ; attempt++) {
      const answer = await redis().eval(READ_VALUE, [key(ctx)], []);
      if (typeof answer !== 'string') throw new Error(`repo: unexpected answer reading ${name}`);
      // Exactly the text stored, which is what the write compares against.
      const stored = answer === '' ? null : answer.slice(1);
      let current: T | null = null;
      // Text that reads as nothing, as get() reads it (the client parses "null"
      // and '""' to nothing there), is never saved: replacing it loses nothing.
      if (stored !== null && stored !== '' && stored !== 'null' && stored !== '""') {
        const d = await decode(ctx, codec, stored);
        if (!d.ok) throw new UnreadableValueError(what, d.flaw === 'unrecognised', d.cause);
        current = d.value;
      }
      const next = await fn(current);
      if (next === null && stored === null) return null; // nothing there, nothing to write
      // The value it was given, unchanged: nothing to write. Rewriting it would
      // change the stored text (a new IV), and every other update of it under
      // way would have to run again.
      if (next === current) return current;
      let written = ''; // deletes it
      if (next !== null) {
        written = await encode(ctx, codec, serialize(codec, next));
        checkSize(name, what, ctx, SHA1_HEX + written.length);
      }
      const seen = stored === null ? '' : sha1(stored);
      if (Number(await redis().eval(UPDATE_VALUE, [key(ctx)], [seen, written])) === 1) return next;
      if (attempt >= UPDATE_ATTEMPTS) throw new UpdateConflictError(what);
      await pause(attempt);
    }
  };

  return declare<ValueStore<T>>({
    kind: 'value',
    name,
    what,
    exportable: opts.exportable,
    backedUp: opts.backup !== false,
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
      const encoded = await encode(ctx, codec, json);
      checkSize(name, what, ctx, encoded.length);
      await redis().set(key(ctx), encoded);
    },
    update,
    async remove(ctx) {
      await redis().del(key(ctx));
    },
    async size(ctx) {
      // STRLEN: 0 where there is nothing, and WRONGTYPE for a hash.
      const chars = Number(await redis().strlen(key(ctx)));
      if (!Number.isSafeInteger(chars) || chars < 0) throw new Error(`repo: unexpected answer measuring ${name}`);
      return chars === 0 ? { entries: 0, chars: 0, largest: null } : { entries: 1, chars, largest: { id: null, chars } };
    },
    check: (value) => checked(codec, value),
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
  const decodeAll = async (ctx: Ctx, entries: (readonly [string, unknown])[]) => {
    const results = await Promise.all(entries.map(async ([id, stored]) => ({ id, d: await decode(ctx, codec, stored) })));
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
      ctx,
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
    return strict(await decodeAll(ctx, present));
  };

  const setMany = async (ctx: Ctx, entries: Iterable<readonly [string, T]>): Promise<void> => {
    // Everything is checked before anything is written.
    const checked = [...entries].map(([id, value]) => [checkId(what, id), serialize(codec, value)] as const);
    if (checked.length === 0) return;
    const fields = Object.fromEntries(await Promise.all(checked.map(async ([id, json]) => [id, await encode(ctx, codec, json)] as const)));
    checkSize(name, what, ctx, Object.entries(fields).reduce((n, [id, v]) => n + id.length + v.length, 0));
    await redis().hset(key(ctx), fields);
  };

  const update = async (ctx: Ctx, id: string, fn: (current: T | null) => T | null | Promise<T | null>): Promise<T | null> => {
    checkId(what, id);
    for (let attempt = 1; ; attempt++) {
      const [stored] = await readFields(ctx, [id]);
      let current: T | null = null;
      if (stored !== null) {
        const d = await decode(ctx, codec, stored);
        if (!d.ok) {
          throw new UnreadableEntriesError(what, d.flaw === 'unreadable' ? [id] : [], d.flaw === 'unrecognised' ? [id] : [], d.cause);
        }
        current = d.value;
      }
      const next = await fn(current);
      if (next === null && stored === null) return null; // nothing there, nothing to write
      let written = ''; // deletes it
      if (next !== null) {
        written = await encode(ctx, codec, serialize(codec, next));
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
      const read = await decodeAll(ctx, wanted.flatMap((id, i) => (stored[i] === null ? [] : [[id, stored[i]] as const])));
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
          if (value !== null) written = await encode(ctx, codec, serialize(codec, value));
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
    backedUp: opts.backup !== false,
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
    async size(ctx) {
      const answer = await redis().eval(MAP_SIZE, [key(ctx)], []);
      if (!Array.isArray(answer) || answer.length !== 4 || typeof answer[2] !== 'string') {
        throw new Error(`repo: unexpected answer measuring ${name}`);
      }
      const [entries, chars, most] = [Number(answer[0]), Number(answer[1]), Number(answer[3])];
      if (![entries, chars, most].every((n) => Number.isSafeInteger(n) && n >= 0)) throw new Error(`repo: unexpected answer measuring ${name}`);
      return { entries, chars, largest: entries === 0 ? null : { id: answer[2].slice(1), chars: most } };
    },
    check: (value) => checked(codec, value),
    async replaceUnreadable(ctx, id, value) {
      checkId(what, id);
      const written = await encode(ctx, codec, serialize(codec, value));
      checkSize(name, what, ctx, id.length + SHA1_HEX + written.length);
      const answer = await redis().eval(READ_ENTRY_HASHED, [key(ctx)], [id]);
      if (!Array.isArray(answer) || answer.length !== 2 || !answer.every((v) => typeof v === 'string')) {
        throw new Error(`repo: unexpected answer reading ${name}`);
      }
      const [stored, hash] = answer as [string, string];
      if (stored === '') return false;
      // Thrown as it is when this deployment can't read it (a failed decrypt
      // under k0 among them): that says nothing about the bytes.
      const d = await decode(ctx, codec, stored.slice(1));
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
  /** As for a value or map store (StoreOptions): false leaves it out of
   *  backups, with lib/export.ts listing it. */
  backup?: false;
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
    backedUp: opts.backup !== false,
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
 * Declares a counter map store: a count per id in a container, each in a fixed
 * window of its own (see TWO SHAPES above), such as requests per API token.
 * The service's bookkeeping, like a counter store: never exportable, and its
 * values are plain text ("<count>:<end>"), which the re-encryption pass knows
 * (classify() in lib/reencrypt.ts). Ids are opaque, as a map store's are.
 */
export function defineCounterMapStore(name: string, opts: CounterOptions): CounterMapStore {
  const { what, windowSeconds } = opts;
  if (!Number.isInteger(windowSeconds) || windowSeconds < 1) {
    throw new Error(`The window of "${name}" must be a whole number of seconds, 1 or more.`);
  }
  const key = (ctx: Ctx) => storeKey(ctx, name);
  return declare<CounterMapStore>({
    kind: 'counter-map',
    name,
    what,
    exportable: false,
    backedUp: opts.backup !== false,
    windowSeconds,
    async take(ctx, id, now = Date.now()) {
      checkId(what, id);
      let answer: unknown;
      try {
        answer = await redis().eval(COUNTERS_TAKE, [key(ctx)], [id, String(Math.floor(now / 1000)), String(windowSeconds)]);
      } catch (err) {
        // Damaged: thrown, never taken for no count, so a limit built on it
        // stays shut rather than open. The id is named, as a map store's are.
        if (err instanceof Error && err.message.includes(NOT_A_COUNT)) throw new UnreadableEntriesError(what, [id], [], err);
        throw err;
      }
      const [count, left] = Array.isArray(answer) && answer.length === 2 ? answer.map(Number) : [NaN, NaN];
      if (!Number.isSafeInteger(count) || count < 1 || !Number.isSafeInteger(left)) {
        throw new Error(`repo: unexpected answer counting ${name}`);
      }
      // A window's end is set by the clock of whoever started it, which may run
      // a little ahead of this one: never more than a window is left.
      return { count, secondsLeft: Math.min(windowSeconds, Math.max(1, left)) };
    },
    async remove(ctx, ...ids) {
      for (const id of ids) checkId(what, id);
      if (ids.length > 0) await redis().hdel(key(ctx), ...ids);
    },
  });
}

/** A public store's options: what it holds, for messages, and the check of
 *  each value, which may depend on its id (each field holds its own shape). */
export type PublicStoreOptions<T> = { what: string; isValid: (v: unknown, id: string) => v is T };

export type PublicMapStore<T> = {
  readonly kind: 'public-map';
  /** The key family, environment-wide: "<env>:<name>". */
  readonly name: string;
  readonly what: string;
  /** Strict. The values there are for these ids, in the order asked; an id
   *  with none is left out. One that isn't JSON, or that its check refuses,
   *  throws UnreadableEntriesError naming it (unrecognised: plain text has no
   *  damaged bytes to tell apart). */
  getMany(ids: Iterable<string>): Promise<Map<string, T>>;
  /** As getMany, but names the ids whose values can't be used instead of
   *  throwing. For readers that nothing writes on, which then do without
   *  them and say so. A storage failure still throws. */
  getManyReport(ids: Iterable<string>): Promise<{ entries: Map<string, T>; unrecognised: string[] }>;
  /** Writes these entries in one step (one HSET): every one, or none if any
   *  is invalid or the whole is over the blob ceiling (StoredValueTooLargeError). */
  setMany(entries: Iterable<readonly [string, T]>): Promise<void>;
  /** Every id stored, in id order. */
  ids(): Promise<string[]>;
};

// Public stores, by name: a registry apart from the containers' stores.
const publicDeclared = new Map<string, PublicMapStore<unknown>>();

/** A stored plain value, which the client may already have parsed (the
 *  default Upstash client parses what looks like JSON). */
function plainValue(raw: unknown): { ok: true; value: unknown } | { ok: false } {
  if (typeof raw !== 'string') return { ok: true, value: raw };
  try {
    return { ok: true, value: JSON.parse(raw) };
  } catch {
    return { ok: false };
  }
}

/**
 * Declares a public map store (see PUBLIC DATA above): one environment-wide
 * hash of plain JSON values, one per id. Its name must be under a prefix
 * listed as environment-wide and as refetched, and not a key family stored the
 * old way.
 */
export function definePublicMapStore<T>(name: string, opts: PublicStoreOptions<T>): PublicMapStore<T> {
  if (!NAME.test(name) || name.length > 64) {
    throw new Error(`"${name}" cannot name a store: use lowercase words joined by "-" or ":", at most 64 long.`);
  }
  if (!isEnvWide(name)) throw new Error(`"${name}" cannot name a public store: it is not under a prefix lib/containers.ts lists as environment-wide.`);
  if (!isRefetched(name)) throw new Error(`"${name}" cannot name a public store: lib/export.ts must list it in REFETCHED_PREFIXES, so backups leave it out.`);
  if (listedKind(name) !== null) throw new Error(`"${name}" cannot name a public store: it is a key family stored the old way (lib/key-families.ts).`);
  const { what, isValid } = opts;
  const key = () => kEnv(name);
  const read = async (ids: Iterable<string>) => {
    const asked = [...new Set([...ids].map((id) => checkId(what, id)))];
    const entries = new Map<string, T>();
    const unrecognised: string[] = [];
    if (asked.length === 0) return { entries, unrecognised };
    const got = (await redis().hmget<Record<string, unknown>>(key(), ...asked)) ?? {};
    for (const id of asked) {
      const raw = got[id];
      if (raw === null || raw === undefined) continue;
      const v = plainValue(raw);
      if (v.ok && isValid(v.value, id)) entries.set(id, v.value);
      else unrecognised.push(id);
    }
    return { entries, unrecognised: unrecognised.sort() };
  };
  const store: PublicMapStore<T> = {
    kind: 'public-map',
    name,
    what,
    async getMany(ids) {
      const { entries, unrecognised } = await read(ids);
      if (unrecognised.length > 0) throw new UnreadableEntriesError(what, [], unrecognised);
      return entries;
    },
    getManyReport: read,
    async setMany(given) {
      const fields: Record<string, string> = {};
      let chars = 0;
      for (const [id, value] of given) {
        checkId(what, id);
        const text = JSON.stringify(value);
        // Checked as it will read back, and written exactly as checked.
        if (text === undefined || !isValid(JSON.parse(text), id)) throw new TypeError(`Invalid value for ${what}: refused before it was written.`);
        fields[id] = text;
        chars += id.length + text.length;
      }
      if (Object.keys(fields).length === 0) return;
      const limit = maxBlobChars();
      if (chars > limit) throw new StoredValueTooLargeError(what, chars, limit);
      await redis().hset(key(), fields);
    },
    async ids() {
      return (await redis().hkeys(key())).sort();
    },
  };
  // The same name declared again is its module being evaluated again (a
  // development reload): the new declaration replaces the old.
  publicDeclared.set(name, store as PublicMapStore<unknown>);
  return store;
}

// ---- Measuring a whole container ----

/** One key of a container, as measured (measureContainer). Characters are
 *  bytes, as Redis stores them. */
export type KeyMeasure = {
  /** Its name inside the container (without the environment's prefix and
   *  the container's). */
  key: string;
  /** "other" for a type the app never writes (a list, a set). */
  type: 'string' | 'hash' | 'other';
  /** A string is one; a hash's fields; nothing measured for "other". */
  entries: number;
  /** Every field name and value together. */
  chars: number;
  /** The longest value's characters: the one nearest the request ceiling
   *  (lib/blob.ts), since each write is held to it on its own. */
  largest: number;
  /** With `heads`: how many of its values claim each key, by key id ("k0",
   *  the original single key, for an unversioned value), "?" for a value in
   *  the versioned shape whose key id can't be read, and "-" for one that is
   *  not ciphertext in shape at all (plain text, or damage), and "+" for a
   *  hash value not looked at, past the step's HEADS_STEP_BYTES. A claim,
   *  read from the value's first bytes: nothing is decrypted, so a value
   *  claiming a key may still fail to open under it. */
  heads?: Record<string, number>;
};

export type ContainerMeasure = {
  /** Every key found and measured, in name order. */
  keys: KeyMeasure[];
  /** Keys found whose measuring failed, in name order: never left out, nor
   *  counted as holding nothing. */
  unmeasured: string[];
};

/** Keys asked for per SCAN page, and measured per MEASURE_KEYS step. */
const MEASURE_SCAN_PAGE = 500;
const MEASURE_STEP = 100;
/** The bytes of hash values one MEASURE_KEYS step reads inside Redis for
 *  their heads: a few milliseconds of Redis's time at most. A value past it
 *  is "+", not looked at. */
export const HEADS_STEP_BYTES = 4 * 1024 * 1024;

/** Reads one MEASURE_KEYS row, or null for a key gone since the walk. */
function measured(key: string, row: unknown, heads: boolean): KeyMeasure | null {
  const bad = () => new Error('repo: unexpected answer measuring a container');
  if (!Array.isArray(row) || row.length !== 5 || typeof row[0] !== 'string' || typeof row[4] !== 'string' || !row[4].startsWith('v')) throw bad();
  if (row[0] === 'none') return null;
  const [entries, chars, largest] = [Number(row[1]), Number(row[2]), Number(row[3])];
  if (![entries, chars, largest].every((n) => Number.isSafeInteger(n) && n >= 0)) throw bad();
  const type = row[0] === 'string' || row[0] === 'hash' ? row[0] : 'other';
  const out: KeyMeasure = { key, type, entries, chars, largest };
  if (heads) {
    const counts: Record<string, number> = {};
    for (const part of row[4].slice(1).split(',')) {
      if (part === '') continue;
      const at = part.lastIndexOf('=');
      const n = Number(part.slice(at + 1));
      if (at <= 0 || !Number.isSafeInteger(n) || n <= 0) throw bad();
      counts[part.slice(0, at)] = n;
    }
    out.heads = counts;
  }
  return out;
}

/** Every key matching `prefix*`, once each (SCAN may repeat one), a page at
 *  a time. Throws when a page can't be had: what it would have found is not
 *  known. */
async function walk(prefix: string): Promise<string[]> {
  const found = new Set<string>();
  let cursor: string | number = 0;
  do {
    const [next, page] = (await redis().scan(cursor, { match: `${prefix}*`, count: MEASURE_SCAN_PAGE })) as [string | number, string[]];
    for (const key of page) if (key.startsWith(prefix) && key.length > prefix.length) found.add(key);
    cursor = next;
  } while (String(cursor) !== '0');
  return [...found].sort();
}

/** Measures one container's keys, found by a walk (full keys, under its
 *  prefix), MEASURE_STEP a step. A step that fails names its keys. */
async function measureKeys(ctx: Ctx, prefix: string, all: string[], heads: boolean): Promise<ContainerMeasure> {
  const keys: KeyMeasure[] = [];
  const unmeasured: string[] = [];
  for (let i = 0; i < all.length; i += MEASURE_STEP) {
    const step = all.slice(i, i + MEASURE_STEP);
    let answer: unknown;
    try {
      answer = await redis().eval(MEASURE_KEYS, step, [heads ? '1' : '0', String(HEADS_STEP_BYTES)]);
    } catch (err) {
      console.error(`repo: ${step.length} keys of container ${ctx.container} could not be measured:`, err instanceof Error ? err.name : typeof err);
      unmeasured.push(...step.map((key) => key.slice(prefix.length)));
      continue;
    }
    if (!Array.isArray(answer) || answer.length !== step.length) throw new Error('repo: unexpected answer measuring a container');
    step.forEach((key, j) => {
      const m = measured(key.slice(prefix.length), answer[j], heads);
      if (m) keys.push(m);
    });
  }
  return { keys, unmeasured };
}

/**
 * How much every key of one container holds, measured now: a SCAN of the
 * container's prefix (MATCH, a page at a time, each key once however often
 * SCAN gives it), then MEASURE_KEYS on what it found, MEASURE_STEP keys a
 * step. No value leaves Redis, and nothing is decrypted or written: with
 * `heads`, the key each value claims (KeyMeasure.heads), counted, at most
 * HEADS_STEP_BYTES of hash values read for them a step. Strict about the
 * walk: a SCAN that fails throws, since what it would have found is not
 * known. A step that fails names each of its keys in `unmeasured`, never
 * leaves them out, so the rest is still measured and what was not is said.
 *
 * Its cost is the walk: SCAN reads the environment's whole keyspace, of
 * which MATCH keeps this container's, so call it where it is counted (a page
 * the person opens, held to a count of its own), never in a hot path. For
 * several containers at once, measureContainers walks once.
 */
export async function measureContainer(ctx: Ctx, opts: { heads?: boolean } = {}): Promise<ContainerMeasure> {
  const prefix = containerPrefix(ctx);
  return measureKeys(ctx, prefix, await walk(prefix), opts.heads === true);
}

/**
 * measureContainer for several containers, with one walk for all of them:
 * a SCAN of every container's keys (the prefix the containers share), each
 * key kept for the container it is in, when that is one asked for, then
 * each container measured as measureContainer measures it, without heads
 * (sizes and counts only). The walk costs the same for one container or
 * fifty. In the order asked; a container asked for twice is measured once.
 * Strict about the walk, as measureContainer is.
 */
export async function measureContainers(ctxs: readonly Ctx[]): Promise<Map<Ctx['container'], ContainerMeasure>> {
  const out = new Map<Ctx['container'], ContainerMeasure>();
  if (ctxs.length === 0) return out;
  // "<env>:c:", the part every container's prefix starts with.
  const shared = containerPrefix(ctxs[0]).slice(0, -(ctxs[0].container.length + 1));
  const prefixes = new Map<string, string>();
  for (const ctx of ctxs) {
    const prefix = containerPrefix(ctx);
    if (!prefix.startsWith(shared) || prefix !== `${shared}${ctx.container}:`) throw new Error('repo: containers that do not share a prefix');
    prefixes.set(ctx.container, prefix);
  }
  const found = new Map<string, string[]>([...prefixes.keys()].map((c) => [c, []]));
  for (const key of await walk(shared)) {
    const end = key.indexOf(':', shared.length);
    if (end < 0) continue;
    const container = key.slice(shared.length, end);
    const prefix = prefixes.get(container);
    if (prefix !== undefined && key.length > prefix.length) found.get(container)!.push(key);
  }
  for (const ctx of ctxs) {
    if (out.has(ctx.container)) continue;
    out.set(ctx.container, await measureKeys(ctx, prefixes.get(ctx.container)!, found.get(ctx.container)!, false));
  }
  return out;
}

/** Every public store declared so far, by name. For lib/stores.ts only, as
 *  storesDeclaredSoFar is. */
export function publicStoresDeclaredSoFar(): ReadonlyMap<string, PublicMapStore<unknown>> {
  return publicDeclared;
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
  publicDeclared.delete(name);
}
