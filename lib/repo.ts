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
// device), change it with MapStore.update(), a compare-and-set that retries. A
// value store is for data one person edits at a time.
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
// person's data download once there is one. The name is the key family, so a
// declared store is in the key inventory by construction.
//
// READS ARE STRICT unless the method's name says otherwise:
//   - never saved                      -> null, or an empty map
//   - its own content damaged (not
//     ciphertext, damaged JSON, a value
//     its isValid rejects)             -> StoredDataUnreadableError; for a map
//                                         store UnreadableEntriesError, which
//                                         names the ids
//   - this deployment cannot read it
//     (no master key, a key missing
//     from the key store, storage
//     unreachable)                     -> that error, as it is
// A failure is never "empty": a caller that writes, deletes or records history
// on the answer must not mistake one for the other (the bug lib/stored-json.ts
// exists for). Nor is a deployment problem ever blamed on the data: only
// damaged entries are reported as unreadable, offered for removal, or left out.
//   MapStore.getAllReport names the damaged ids instead of throwing, so a route
// can show what it read and offer to remove the rest. Remove them only once the
// person confirms.
//   MapStore.getAllLenient is the one lenient read: it leaves damaged entries
// out (anything else still throws). It is only for conveniences that nothing
// writes, deletes or records on; say so where it is called.
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

import { redis, kc } from './storage';
import { isEnvWide, type Ctx } from './containers';
import { encrypt, DecryptFailedError, MalformedCiphertextError } from './crypto';
import { StoredDataUnreadableError } from './stored-json';
import { decodeJsonBlob, encodeJsonText, maxBlobChars, blobWarnChars } from './blob';
import { listedKind } from './key-families';
import { isExcluded } from './export';

export { StoredDataUnreadableError, describeUnreadable } from './stored-json';

/** Entries of a map store whose own content is damaged. `ids` names them, in id
 *  order, so a route can offer to remove them; never in the message, which
 *  reaches logs. */
export class UnreadableEntriesError extends StoredDataUnreadableError {
  constructor(
    what: string,
    readonly ids: string[],
    cause?: unknown
  ) {
    super(what, cause);
    this.name = 'UnreadableEntriesError';
  }
}

/** update() gave up: the entry kept changing under it. Nothing it computed was
 *  written. */
export class UpdateConflictError extends Error {
  constructor(readonly what: string) {
    super(`Your saved ${what} kept changing while this change was being saved, so it was not made. Try again.`);
    this.name = 'UpdateConflictError';
  }
}

/** A write refused because what it stores would not fit in one request
 *  (lib/blob.ts). Nothing was written, and nothing was trimmed to fit. */
export class StoredValueTooLargeError extends Error {
  constructor(
    readonly what: string,
    readonly chars: number,
    readonly limit: number
  ) {
    super(`Your ${what} are too large to save (${chars} characters stored, over the limit of ${limit}), so nothing was changed.`);
    this.name = 'StoredValueTooLargeError';
  }
}

export type StoreOptions<T> = {
  /** What the person calls the contents, plural, for messages: "Your saved
   *  {what} could not be read, so they were left untouched." */
  what: string;
  /** The current shape. A stored value that fails it (after upgrade) is
   *  damaged; a value that would fail it is refused before it is written. */
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
  /** Strict about everything but damaged entries, which it names instead of
   *  throwing: the readable entries in id order, and the damaged ids. For a
   *  route that shows what it read and offers to remove the rest. */
  getAllReport(ctx: Ctx): Promise<{ entries: Map<string, T>; unreadable: string[] }>;
  /** LENIENT. Every entry but the damaged ones, in id order. Only for
   *  conveniences that nothing writes, deletes or records on. A deployment
   *  problem still throws. */
  getAllLenient(ctx: Ctx): Promise<Map<string, T>>;
  /** Writes one entry, replacing any under the same id, without reading it. */
  set(ctx: Ctx, id: string, value: T): Promise<void>;
  /** Writes several entries in one step (one HSET): every one, or none if any
   *  is invalid or the whole is too large. A repeated id keeps its last value. */
  setMany(ctx: Ctx, entries: Iterable<readonly [string, T]>): Promise<void>;
  /** Changes one entry safely when other writers may change it too: reads it
   *  (strictly), computes the new value with `fn` (null deletes it), and writes
   *  only if the entry is still what was read, else runs `fn` again on what is
   *  there now, a few times before UpdateConflictError. `fn` may therefore run
   *  more than once: it should only compute. Returns what was written. */
  update(ctx: Ctx, id: string, fn: (current: T | null) => T | null | Promise<T | null>): Promise<T | null>;
  /** Deletes entries, readable or not. Ids with no entry are ignored. */
  remove(ctx: Ctx, ...ids: string[]): Promise<void>;
  /** How many entries there are, readable or not (for count limits). */
  count(ctx: Ctx): Promise<number>;
  /** Whether there is an entry under the id, readable or not. */
  has(ctx: Ctx, id: string): Promise<boolean>;
};

export type Store = ValueStore<unknown> | MapStore<unknown>;

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
 * read, "" meaning it had none: the seam never stores "", and update() stops
 * at a damaged entry before it gets here. Compared whole, as in lib/history.ts:
 * every write encrypts with a fresh IV, so any rewrite in between differs.
 */
export const UPDATE_ENTRY = `-- nya:repo-update-entry
if (redis.call('HGET', KEYS[1], ARGV[1]) or '') ~= ARGV[2] then return 0 end
if ARGV[3] == '' then redis.call('HDEL', KEYS[1], ARGV[1]) else redis.call('HSET', KEYS[1], ARGV[1], ARGV[3]) end
return 1`;

/** Fields read per READ_ENTRIES call, well inside Lua's limit for unpack. */
const READ_BATCH = 1000;
/** Tries before update() gives up on an entry that keeps changing. */
const UPDATE_ATTEMPTS = 5;

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

/**
 * Whether a failure to read a value is the value's own damage. Anything else
 * means this deployment cannot read it: MasterKeyError (no master key, or one
 * that does not open the data key), UnknownKeyError (a key the key store
 * lacks), storage unreachable. So is a failed decrypt under k0: unlike a data
 * key, PLAID_ENCRYPTION_KEY does not commit to its key, so a changed key fails
 * every k0 value exactly as damage would.
 */
function isDamage(err: unknown): boolean {
  return (
    err instanceof SyntaxError ||
    err instanceof MalformedCiphertextError ||
    (err instanceof DecryptFailedError && err.keyId !== 'k0')
  );
}

/** A stored value read back. Damage is thrown as `unreadable` makes it, any
 *  other failure as it is. */
async function decode<T>(c: Codec<T>, stored: unknown, unreadable: (cause: unknown) => Error): Promise<T> {
  // The client JSON-parses what it can on the way out, so anything but
  // non-empty text was never written by the seam.
  if (typeof stored !== 'string' || stored === '') throw unreadable(new Error('stored value is not encrypted text'));
  let parsed: unknown;
  try {
    parsed = await decodeJsonBlob(stored); // compressed or not
  } catch (err) {
    if (isDamage(err)) throw unreadable(err);
    throw err;
  }
  const value = c.upgrade ? c.upgrade(parsed) : parsed;
  if (!c.isValid(value)) throw unreadable(new Error('stored value has the wrong shape'));
  return value;
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

  const read = async (ctx: Ctx): Promise<T | null> => {
    // Uncaught: a failure to reach storage is never "never saved".
    const stored = await redis().get<unknown>(key(ctx));
    // Text that reads as nothing (empty, or the JSON literal null, which the
    // client parses) is never saved, as in lib/stored-json.ts. The seam writes
    // neither, and replacing one loses nothing.
    if (stored === null || stored === undefined || stored === '') return null;
    return decode(codec, stored, (cause) => new StoredDataUnreadableError(what, cause));
  };

  return declare<ValueStore<T>>({
    kind: 'value',
    name,
    what,
    exportable: opts.exportable,
    get: read,
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
  const damaged = (id: string) => (cause: unknown) => new UnreadableEntriesError(what, [id], cause);

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

  /** Entries decoded, in the order given: the readable ones, and the ids whose
   *  own content is damaged. A deployment problem is thrown: it says nothing
   *  about the entries, so none is reported or left out for it. */
  const decodeAll = async (entries: (readonly [string, unknown])[]) => {
    type Decoded = { id: string; ok: true; value: T } | { id: string; ok: false; damage: UnreadableEntriesError };
    const results = await Promise.all(
      entries.map(async ([id, stored]): Promise<Decoded> => {
        try {
          return { id, ok: true, value: await decode(codec, stored, damaged(id)) };
        } catch (err) {
          if (err instanceof UnreadableEntriesError) return { id, ok: false, damage: err };
          throw err;
        }
      })
    );
    const values = new Map<string, T>();
    const unreadable: string[] = [];
    let cause: unknown;
    for (const r of results) {
      if (r.ok) values.set(r.id, r.value);
      else {
        unreadable.push(r.id);
        cause ??= r.damage.cause;
      }
    }
    return { values, unreadable: unreadable.sort(), cause };
  };

  const strict = (r: Awaited<ReturnType<typeof decodeAll>>) => {
    if (r.unreadable.length > 0) throw new UnreadableEntriesError(what, r.unreadable, r.cause);
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
      const current = stored === null ? null : await decode(codec, stored, damaged(id));
      const next = await fn(current);
      if (next === null && stored === null) return null; // nothing there, nothing to write
      let written = ''; // deletes it
      if (next !== null) {
        written = await encode(codec, serialize(codec, next));
        checkSize(name, what, ctx, id.length + written.length);
      }
      if (Number(await redis().eval(UPDATE_ENTRY, [key(ctx)], [id, stored ?? '', written])) === 1) return next;
      if (attempt >= UPDATE_ATTEMPTS) throw new UpdateConflictError(what);
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
      const { values, unreadable } = await readAll(ctx);
      return { entries: values, unreadable };
    },
    getAllLenient: async (ctx) => (await readAll(ctx)).values,
    set: (ctx, id, value) => setMany(ctx, [[id, value]]),
    setMany,
    update,
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
