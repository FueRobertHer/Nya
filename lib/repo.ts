// lib/repo.ts
//
// The storage seam (Postgres migration plan, Phase 1): how new stores reach
// storage. A store is declared once, by name, and gets a few named operations;
// nothing here reads or writes an arbitrary key. Today they run on Redis, and
// this file and lib/stored-json.ts are the only seam code that touches it
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
//   defineMapStore    one encrypted JSON value per id, each written on its own,
//                     so two writers editing different entries never clobber
//                     each other (the shape of manual accounts). In Redis, one
//                     hash with a field per id; in a table, a row per id.
//
// Either keeps its data inside the container (kc in lib/storage.ts),
// encrypted (lib/crypto.ts).
//
// DECLARING ONE, in a module under lib/:
//
//   export const rulesStore = defineMapStore<Rule>('rules', {
//     what: 'rules', // plural: "Your saved rules could not be read"
//     isValid: isRule, // checked on every read and before every write
//     exportable: true, // part of the person's own data download?
//   });
//
// then import that module in lib/stores.ts, the catalogue that everything
// walking every store reads (the key inventory in lib/reencrypt.ts, a
// person's data download). The name is the key family, so a declared store is
// in the key inventory by construction, with no list to update.
//
// READS ARE STRICT unless the method's name says otherwise:
//   - never saved                     -> null, or an empty map
//   - saved but unreadable (a failed
//     decrypt, damaged JSON, or a value
//     its isValid rejects)            -> StoredDataUnreadableError
//   - storage unreachable             -> that error
// A failure is never "empty": a caller that writes, deletes or records history
// on the answer must not mistake one for the other (the bug lib/stored-json.ts
// exists for). The one lenient read is MapStore.getAllLenient, which leaves out
// entries it cannot read (a failure to reach storage still throws). It is only
// for conveniences that nothing writes, deletes or records on; say so where it
// is called.
//
// WRITES NEVER BUILD ON A FAILED READ. A value store refuses to replace a value
// it cannot read. A map store writes the entries it is given and nothing else,
// and there is deliberately no "replace the whole map": computed from a lenient
// read, it would delete what could not be read. An update that starts from a
// stored entry reads it with get(), which throws if it is unreadable. Every
// value is checked with isValid as it will read back (after a JSON round trip)
// before it is written, so a store never holds what its own reads reject.
//
// IDS ARE PLAINTEXT. A map store's ids are Redis field names, stored and backed
// up unencrypted. Use opaque ids: random (crypto.randomUUID()), a hash, or a
// provider's own id, never content such as a name, merchant, date or amount.
// They are limited to letters, digits and "_.:-", which keeps most content out
// by accident.
//
// NOT BOUND TO A CONTEXT. lib/crypto.ts can bind a value to a context (the "c"
// flag), so a value copied to another field fails to decrypt. Seam values are
// not bound, for two reasons. The re-encryption pass (lib/reencrypt.ts) cannot
// move a bound value, since only its owner knows the context, so every seam
// value would stay under its old data key and the pass would never report
// complete, which retiring a leaked key depends on. And binding would stop no
// swap yet: encrypt() falls back to k0's v1 format, which cannot carry a
// context, and decrypt() accepts an unbound value wherever a context is given.
// If that changes, binding is one change here: bind to the store name and id
// (never the environment prefix, so a restore into another namespace still
// reads, and never the container, so a container's data can still be copied
// byte for byte), and teach the re-encryption pass to derive the same context
// from a key and field.
//
// AN OPERATION THE SEAM LACKS is added here as a named method with its own
// contract test (and its Lua, if it must be atomic), never as raw key access.

import { redis, kc } from './storage';
import { isEnvWide, type Ctx } from './containers';
import { encrypt } from './crypto';
import { StoredDataUnreadableError, parseEncryptedJson, readEncryptedJson, writeEncryptedJson } from './stored-json';

export { StoredDataUnreadableError, describeUnreadable } from './stored-json';

export type StoreOptions<T> = {
  /** What the person calls the contents, plural, for messages: "Your saved
   *  {what} could not be read, so they were left untouched." */
  what: string;
  /** The shape every stored value has. A stored value that fails it is
   *  unreadable; a value that would fail it is refused before it is written. */
  isValid: (v: unknown) => v is T;
  /** Whether the contents belong in the person's own data download: true for
   *  what they entered or what describes their money, false for secrets (token
   *  hashes, connector credentials) and the service's own bookkeeping. */
  exportable: boolean;
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
  /** Replaces the value, unless the one there now cannot be read: then refuses
   *  (StoredDataUnreadableError) and leaves it exactly as it is. */
  set(ctx: Ctx, value: T): Promise<void>;
  /** Deletes the value, readable or not. */
  remove(ctx: Ctx): Promise<void>;
};

export type MapStore<T> = Declared & {
  readonly kind: 'map';
  /** Strict. One entry, or null if there is none. */
  get(ctx: Ctx, id: string): Promise<T | null>;
  /** Strict. Every entry, in id order: empty if none was ever saved, and
   *  StoredDataUnreadableError if any one cannot be read. */
  getAll(ctx: Ctx): Promise<Map<string, T>>;
  /** LENIENT. Every entry that can be read, in id order; one that cannot is
   *  left out. Only for conveniences that nothing writes, deletes or records
   *  on. A failure to reach storage still throws. */
  getAllLenient(ctx: Ctx): Promise<Map<string, T>>;
  /** Writes one entry, replacing any under the same id, without reading it. */
  set(ctx: Ctx, id: string, value: T): Promise<void>;
  /** Writes several entries in one step (one HSET): every one, or none if any
   *  is invalid. A repeated id keeps its last value. */
  setMany(ctx: Ctx, entries: Iterable<readonly [string, T]>): Promise<void>;
  /** Deletes entries, readable or not. Ids with no entry are ignored. */
  remove(ctx: Ctx, ...ids: string[]): Promise<void>;
  /** How many entries there are, readable or not (for count limits). */
  count(ctx: Ctx): Promise<number>;
  /** Whether there is an entry under the id, readable or not. */
  has(ctx: Ctx, id: string): Promise<boolean>;
};

export type Store = ValueStore<unknown> | MapStore<unknown>;

// The registry of declared stores, by name. Read through lib/stores.ts, which
// loads every declaring module first.
const declared = new Map<string, Store>();

/** Lowercase words joined by "-" or ":", like the key families listed in
 *  lib/reencrypt.ts. No glob characters, so a key pattern built from a name
 *  matches only it. */
const NAME = /^[a-z][a-z0-9]*(?:[-:][a-z0-9]+)*$/;

function declare<S extends Store>(store: S): S {
  const { name } = store;
  // A container ("c:...") never nests, and an environment-wide store never
  // belongs in one: lib/reencrypt.ts reports either as a key built wrongly.
  if (!NAME.test(name) || name.length > 64 || name.startsWith('c:') || isEnvWide(name)) {
    throw new Error(
      `"${name}" cannot name a store: use lowercase words joined by "-" or ":", and not a container or an environment-wide store.`
    );
  }
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

/** The stored form of a value, refused (a bug in the caller, not damaged data)
 *  unless it reads back valid. */
function serialize<T>(what: string, isValid: (v: unknown) => v is T, value: T): string {
  const json = JSON.stringify(value);
  if (json === undefined || !isValid(JSON.parse(json))) {
    throw new TypeError(`Refusing to save ${what}: the value does not have the shape they are stored in.`);
  }
  return json;
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

/** Declares a store holding one encrypted JSON value per container. */
export function defineValueStore<T>(name: string, opts: StoreOptions<T>): ValueStore<T> {
  const { what, isValid, exportable } = opts;
  const key = (ctx: Ctx) => storeKey(ctx, name);
  return declare<ValueStore<T>>({
    kind: 'value',
    name,
    what,
    exportable,
    get: (ctx) => readEncryptedJson(key(ctx), what, isValid),
    async set(ctx, value) {
      serialize(what, isValid, value);
      await writeEncryptedJson(key(ctx), what, value, isValid);
    },
    async remove(ctx) {
      await redis().del(key(ctx));
    },
  });
}

/** Declares a store holding one encrypted JSON value per id, per container. */
export function defineMapStore<T>(name: string, opts: StoreOptions<T>): MapStore<T> {
  const { what, isValid, exportable } = opts;
  const key = (ctx: Ctx) => storeKey(ctx, name);

  /** One stored entry's value, or StoredDataUnreadableError. The client
   *  JSON-parses what it can on the way out, so anything but non-empty text is
   *  not ciphertext. */
  const read = async (stored: unknown): Promise<T> => {
    if (typeof stored !== 'string' || stored === '') {
      throw new StoredDataUnreadableError(what, new Error('stored entry is not encrypted text'));
    }
    return parseEncryptedJson(stored, what, isValid);
  };

  const readAll = async (ctx: Ctx, lenient: boolean): Promise<Map<string, T>> => {
    // Uncaught: a failure to reach storage is never an empty map.
    const stored = (await redis().hgetall<Record<string, unknown>>(key(ctx))) ?? {};
    const entries = await Promise.all(
      Object.keys(stored)
        .sort()
        .map(async (id): Promise<[string, T] | null> => {
          try {
            return [id, await read(stored[id])];
          } catch (err) {
            // Only damaged data is left out; a deployment problem (a data key
            // that could not be loaded) is thrown even here.
            if (lenient && err instanceof StoredDataUnreadableError) return null;
            throw err;
          }
        })
    );
    return new Map(entries.filter((e) => e !== null));
  };

  const setMany = async (ctx: Ctx, entries: Iterable<readonly [string, T]>): Promise<void> => {
    // Everything is checked before anything is written.
    const checked = [...entries].map(([id, value]) => [checkId(what, id), serialize(what, isValid, value)] as const);
    if (checked.length === 0) return;
    const fields = await Promise.all(checked.map(async ([id, json]) => [id, await encrypt(json)] as const));
    await redis().hset(key(ctx), Object.fromEntries(fields));
  };

  return declare<MapStore<T>>({
    kind: 'map',
    name,
    what,
    exportable,
    async get(ctx, id) {
      const stored = await redis().hget<unknown>(key(ctx), checkId(what, id));
      return stored === null || stored === undefined ? null : read(stored);
    },
    getAll: (ctx) => readAll(ctx, false),
    getAllLenient: (ctx) => readAll(ctx, true),
    set: (ctx, id, value) => setMany(ctx, [[id, value]]),
    setMany,
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
