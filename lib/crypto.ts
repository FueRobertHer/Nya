// lib/crypto.ts
//
// Encrypts the values that hold financial data (Plaid access tokens, balances,
// history, transactions and the rest; classify() in lib/reencrypt.ts lists
// every store) before they are written to Redis, so a leak of the database or
// of a backup alone doesn't expose them. Key and field names, and the few
// stores that hold no amounts, stay plain text: dates, ids, bank names,
// renamed merchants' original names, sharing's names and levels
// (docs/architecture.md).
//
// Uses the Web Crypto API (available in Bun, Node 19+, and Vercel's Edge
// runtime).
//
// WHAT THIS PROTECTS AGAINST, AND WHAT IT DOES NOT.
//
//   Protects: someone who obtains the database (an Upstash leak) or a backup
//   file, without the master key.
//   Does not protect: someone with the Vercel environment, which holds both
//   the master key and the database credentials. Moving the master key into a
//   managed key service (see MasterKey below) is what would separate them.
//   Partly protects: someone who can WRITE to the database can delete or
//   replay values, and can swap one valid ciphertext for another unless the
//   value is bound to a context (the "c" flag below) that names where it
//   belongs. They cannot forge a value or a data key. Nor does the check that
//   a value is under its own container's key (below) stop them: which key
//   belongs to which container is plain text in the key store and the map, as
//   which account owns which container is in lib/owners.ts. What that check
//   stops is code that reads one container's data while acting for another.
//
// ENVELOPE ENCRYPTION, SO KEYS CAN ROTATE WITHOUT NEW ENV VARS.
//
// Data is encrypted with DATA KEYS. The app generates those itself and
// stores them in Redis ("crypto:keys"), each encrypted
// ("wrapped") by the MASTER KEY, the one secret in the environment
// (MASTER_KEY) and the one thing to keep a copy of. So:
//
//   - Rotating the master key re-locks only the data keys, never the data,
//     and never needs a second master in the environment:
//       1. POST the new master to /api/ops/rotate-master. The running app,
//          which has the current master, adds a lock for the new one to every
//          data key, checks each, and records the rotation only when all are
//          done.
//       2. Set MASTER_KEY to the new master in Vercel and redeploy.
//       3. Nothing: 24 hours later (the rollback window) the new deployment
//          removes the old locks by itself. See "Master rotation" below.
//     Your data is never re-encrypted, so a rotation cannot damage it.
//   - Backups keep the wrapped keys apart from the data, in key archives
//     (lib/key-archive.ts), so a deletion can take a key out of every copy.
//
// DATA KEY IDS COMMIT TO THEIR KEY. An id is "k<n>-<8 hex>", where the hex is
// derived from the key itself. Two different keys can therefore never share an
// id, even if a key is deleted and "k<n>" is handed out again, and a loaded key
// is checked against its id. Without that, a process holding an old key in
// memory under a reused id would write values no other process could read.
// The number comes from a counter of its own ("crypto:key-seq"), so two keys
// may share a number (the release before numbers its first key by reading the
// store); their ids still differ.
//
// k0 is the exception: PLAID_ENCRYPTION_KEY, the original single key, used
// directly. Everything written before this existed is under it, so it stays
// readable until every value has been re-encrypted under a data key and that
// has been proven by an export/restore.
//
// A DATA KEY PER CONTAINER (docs/architecture.md, "Per-container data keys").
// Each container's values are encrypted under a data key made for it alone: an
// ordinary entry of the key store with one more field, "container", naming
// it. The map ("crypto:container-keys") says which key a container writes
// with. A key is made at a container's birth, in the step that registers it,
// or for an older container by the migration pass (lib/reencrypt.ts); never on
// a write, so a missing map entry never reads as a new container. Deleting a
// container destroys its key (destroyContainerKeys), leaving a tombstone
// ("crypto:destroyed") and a marker in the map, so a write that comes too late
// fails rather than land under a shared key.
//
//   encrypt(ctx) and decrypt(ctx) take the container the value is stored in,
//   the Ctx that built its key, never the viewer's.
//   A value under a key whose record names another container is refused
//   (KeyNotForContainerError); a container whose own key can't be used
//   (ContainerKeyError, a ContainerError: 503) never falls back to another.
//   Values under k0 or an environment data key name no container, and read in
//   any container until the pass moves them.
//
// TWO FORMATS.
//
//   v1: <base64(iv + ciphertext)>
//       The original. Always k0, and records nothing about it.
//
//   v2: v2.<keyid>.<flags>.<base64(iv + ciphertext)>
//       Names its key. The header "v2.<keyid>.<flags>" is bound in as AES-GCM
//       additional data, so it cannot be edited without decryption failing.
//       <flags> is "-" for none, or letters from a fixed set, each at most once
//       and in alphabetical order, so every set of flags has one spelling:
//         c  the value is also bound to a caller-supplied context (for example
//            the container and record it belongs to), which must be passed
//            again to decrypt it. A context must never include the environment
//            prefix, or a restored copy under another prefix could not be read.
//       Unknown flags are refused, never ignored, so a later flag can mean
//       something without older code misreading it.
//
// The two can never be confused: "." is not in the base64 alphabet, so a v1
// value never contains one, and anything that does is versioned.
//
// WRITES. A container with a key of its own writes v2 under it, and never
// under anything else: if its key can't be had, or its map entry can't be
// read, the write fails. That withdraws, for those containers, the promise
// this header used to make, that a missing or broken master could make writes
// use the old key but never make them fail: a storage failure reading the map
// entry or the key on its first use in a process now fails that write. Every
// other container writes to the environment's ACTIVE data key
// ("crypto:active") in v2, as before. The first such write that has the
// current master and finds no active key creates one (see createActiveKey).
// With no master, or if the active key cannot be had for any reason, those
// writes fall back to v1 under k0, which every deployment can read.
//
// Once anything has written v2 in production, this reader must never be
// reverted to before it, or those values become unreadable.

import { redis, kEnv } from './storage';
import { ContainerError, isContainerId, registryKey, type ContainerId, type Ctx } from './containers';

const LEGACY_KEY_ENV = 'PLAID_ENCRYPTION_KEY';
const MASTER_KEY_ENV = 'MASTER_KEY';
const LEGACY_KEY_ID = 'k0';
/** "k0", or "k<n>-<8 hex>" with no leading zero in n. */
const KEY_ID = /^(k0|k[1-9][0-9]{0,5}-[0-9a-f]{8})$/;
/** The highest n the id format allows: past it, the release before could not
 *  read the id, so no key is made. */
export const MAX_KEY_NUMBER = 999_999;
const FLAGS = /^(-|[a-z]{1,8})$/;
const KNOWN_FLAGS = new Set(['c']);
/** Fields read per HSCAN of the key store, and keys written per HSET. A key's
 *  record is about 300 characters, so a page of writes is about 30 KB. */
export const SCAN_PAGE = 200;
export const WRITE_PAGE = 100;

/** A stored value names a key this deployment does not have. Never answered
 *  by trying another key: that would hide a missing key until it mattered. */
export class UnknownKeyError extends Error {
  constructor(readonly keyId: string) {
    super(`Encrypted with key "${keyId}", which does not exist here.`);
    this.name = 'UnknownKeyError';
  }
}

/** A stored value is not in any format this code can read. Messages never
 *  quote the value: a mis-stored plaintext would otherwise land in logs. */
export class MalformedCiphertextError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MalformedCiphertextError';
  }
}

/** A value in a format this code does not know, though a later version might
 *  write it: another version tag, or a flag added after this code. Still a
 *  MalformedCiphertextError to every caller that does not tell them apart; the
 *  storage seam (lib/repo.ts) does, so a rollback never treats such a value as
 *  damaged. */
export class UnsupportedFormatError extends MalformedCiphertextError {
  constructor(message: string) {
    super(message);
    this.name = 'UnsupportedFormatError';
  }
}

/** The key is right but authentication failed: the value, its header, or its
 *  context does not match what was encrypted. */
export class DecryptFailedError extends Error {
  constructor(
    readonly keyId: string,
    reason = 'the value is damaged, was altered, or needs a different context'
  ) {
    super(`Decryption with key "${keyId}" failed: ${reason}.`);
    this.name = 'DecryptFailedError';
  }
}

/** A data key exists but cannot be opened with this deployment's master key,
 *  or is not the key its id says it is. */
export class MasterKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MasterKeyError';
  }
}

/**
 * A container's own data key can't be used: it is missing from the key store,
 * this master can't open it, its record names another container, the
 * container's map entry can't be read, or says the key was destroyed with the
 * account. A ContainerError, so every route answers it as the container being
 * unavailable (503) through containerUnavailable(), never as damaged data,
 * never as empty, and never with anything written. The message names the
 * container and the key for the log; the person is shown a plain sentence.
 */
export class ContainerKeyError extends ContainerError {
  constructor(
    readonly container: string,
    readonly keyId: string | null,
    readonly reason: string
  ) {
    super(`The data key of container ${container}${keyId ? ` (${keyId})` : ''} can't be used: ${reason.replace(/\.$/, '')}.`);
    this.name = 'ContainerKeyError';
  }
}

/**
 * A value is under the key of another container than the one it is read in.
 * Nothing has been decrypted, so nothing says it is damaged: to the seam it is
 * unrecognised, never offered for removal. Its usual cause is a bug that read
 * one container's key while acting for another, so it is logged as one.
 */
export class KeyNotForContainerError extends Error {
  constructor(
    readonly keyId: string,
    readonly container: string,
    readonly owner: string
  ) {
    super(`Encrypted with key "${keyId}", which belongs to container ${owner}, not ${container}.`);
    this.name = 'KeyNotForContainerError';
  }
}

/**
 * Whether a failed decrypt says only that this deployment can't use the
 * value's key, never that the value is damaged: a failed decrypt under k0,
 * which a replaced PLAID_ENCRYPTION_KEY looks exactly like (k0 commits to no
 * key), or a data key the key store lacks. What a reader that names what it
 * can't use calls `unavailable` (lib/manual.ts ManualAccountsReport), and
 * never offers for removal nor passes over for an older value.
 */
export function sealedAway(err: unknown): boolean {
  return (err instanceof DecryptFailedError && err.keyId === LEGACY_KEY_ID) || err instanceof UnknownKeyError;
}

// Raw key handling

export function decodeKeyMaterial(material: string, name: string): Uint8Array {
  let raw: Uint8Array;
  try {
    raw = Uint8Array.from(atob(material.trim()), (c) => c.charCodeAt(0));
  } catch {
    throw new Error(`${name} is not valid base64. Generate with: openssl rand -base64 32`);
  }
  if (raw.length !== 32) {
    throw new Error(`${name} must decode to exactly 32 bytes (AES-256). Generate with: openssl rand -base64 32`);
  }
  return raw;
}

/**
 * Whether this deployment has a usable master key, read from the environment
 * alone (MASTER_KEY set, and 32 bytes of base64): no database read, so the
 * public security page (app/security) can say which scheme this copy uses.
 * True does not mean every value is under a data key yet: values from before
 * the master was set stay under k0 until the re-encryption pass moves them,
 * and a write that can't use a data key falls back to k0 (and logs it).
 */
export function masterKeyConfigured(): boolean {
  const material = process.env[MASTER_KEY_ENV];
  if (!material) return false;
  try {
    decodeKeyMaterial(material, MASTER_KEY_ENV);
    return true;
  } catch {
    return false;
  }
}

/** Non-extractable: once imported, the key's bytes cannot be read back out of
 *  the process through the Web Crypto API. */
function importAes(raw: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', raw as BufferSource, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  bytes.forEach((b) => (binary += String.fromCharCode(b)));
  return btoa(binary);
}

function fromBase64(s: string): Uint8Array {
  let binary: string;
  try {
    binary = atob(s);
  } catch {
    throw new MalformedCiphertextError('Encrypted value is not valid base64.');
  }
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

const utf8 = (s: string) => new TextEncoder().encode(s);

async function sha256Hex(label: string, bytes: Uint8Array, chars: number): Promise<string> {
  const l = utf8(label);
  const input = new Uint8Array(l.length + bytes.length);
  input.set(l, 0);
  input.set(bytes, l.length);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', input));
  return [...digest].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, chars);
}

/** AES-GCM seal: base64(iv + ciphertext + tag). */
async function seal(key: CryptoKey, plaintext: Uint8Array, aad?: Uint8Array): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12)); // 96-bit IV, standard for GCM
  const params: AesGcmParams = aad
    ? { name: 'AES-GCM', iv, additionalData: aad as BufferSource }
    : { name: 'AES-GCM', iv };
  const ciphertext = await crypto.subtle.encrypt(params, key, plaintext as BufferSource);
  const combined = new Uint8Array(iv.length + ciphertext.byteLength);
  combined.set(iv, 0);
  combined.set(new Uint8Array(ciphertext), iv.length);
  return toBase64(combined);
}

async function open(key: CryptoKey, keyId: string, body: string, aad?: Uint8Array): Promise<Uint8Array> {
  const combined = fromBase64(body);
  // A 12-byte IV plus GCM's 16-byte tag is the smallest possible value.
  if (combined.length < 28) throw new MalformedCiphertextError('Encrypted value is too short.');
  const params: AesGcmParams = aad
    ? { name: 'AES-GCM', iv: combined.slice(0, 12), additionalData: aad as BufferSource }
    : { name: 'AES-GCM', iv: combined.slice(0, 12) };
  try {
    return new Uint8Array(await crypto.subtle.decrypt(params, key, combined.slice(12)));
  } catch {
    throw new DecryptFailedError(keyId);
  }
}

// k0: the legacy key, straight from the environment

// Imported once per process: reads decrypt hundreds of values per request. A
// failed import isn't cached, so a missing env var stays a per-call error
// rather than a poisoned singleton.
let _legacyKey: Promise<CryptoKey> | null = null;
function legacyKey(): Promise<CryptoKey> {
  if (!_legacyKey) {
    _legacyKey = (async () => {
      const material = process.env[LEGACY_KEY_ENV];
      if (!material) throw new Error(`${LEGACY_KEY_ENV} is not set. Generate one with: openssl rand -base64 32`);
      return importAes(decodeKeyMaterial(material, LEGACY_KEY_ENV));
    })().catch((err) => {
      _legacyKey = null;
      throw err;
    });
  }
  return _legacyKey;
}

// The master key

/**
 * Whatever wraps and unwraps data keys. Today a key from the environment; the
 * interface is kept this narrow so a managed key service (AWS KMS or similar,
 * where the master never leaves the service and every use is logged) can
 * replace it without touching anything else.
 */
export type MasterKey = {
  fingerprint: string;
  wrap(keyId: string, raw: Uint8Array): Promise<string>;
  unwrap(keyId: string, wrapped: string): Promise<Uint8Array>;
};

/** A short public name for a master key: 16 hex characters of SHA-256 over a
 *  label and the key. Stored as the key of each wrapping, so it is part of the
 *  stored layout and must never change. Reveals nothing usable. */
export function masterFingerprint(raw: Uint8Array): Promise<string> {
  return sha256Hex('nya master key fingerprint:', raw, 16);
}

/** Additional data for a wrapped key, so a wrapping cannot be moved to a
 *  different id and opened there. */
const wrapAad = (keyId: string) => utf8(`nya data key ${keyId}`);

export async function importMasterKey(material: string, name = MASTER_KEY_ENV): Promise<MasterKey> {
  const raw = decodeKeyMaterial(material, name);
  const key = await importAes(raw);
  const fingerprint = await masterFingerprint(raw);
  return {
    fingerprint,
    wrap: (keyId, dataKey) => seal(key, dataKey, wrapAad(keyId)),
    unwrap: (keyId, wrapped) => open(key, keyId, wrapped, wrapAad(keyId)),
  };
}

// Cached against the env string so a changed value (tests, or a future hot
// reload) is picked up rather than served stale. A failure is never kept.
let _master: { source: string; key: Promise<MasterKey> } | null = null;
function masterKey(): Promise<MasterKey> {
  const source = process.env[MASTER_KEY_ENV] ?? '';
  if (_master && _master.source === source) return _master.key;
  const key = source
    ? importMasterKey(source)
    : Promise.reject(new MasterKeyError(`${MASTER_KEY_ENV} is not set, so data keys cannot be opened.`));
  const entry = { source, key };
  key.catch(() => {
    if (_master === entry) _master = null;
  });
  _master = entry;
  return key;
}

/** The master this deployment runs with, for code that must check a key
 *  archive's locks against it (lib/key-archive.ts). */
export function currentMaster(): Promise<MasterKey> {
  return masterKey();
}

// Data keys

/** How a data key is stored in the crypto:keys hash. */
export type StoredDataKey = {
  created_at: string;
  /** master fingerprint -> wrapped key */
  wrapped: Record<string, string>;
  /** During a master rotation: the fingerprint of the master being rotated
   *  to. Once a deployment running that master sees it, the other locks are
   *  removed and this is cleared. */
  next?: string;
  /** The container the key was made for, if it is a container's key. Absent
   *  on the environment's own data keys. The release before keeps it as a
   *  field it doesn't know. */
  container?: string;
};

export function keysHashKey(): string {
  return kEnv('crypto:keys');
}

/** The 8 hex characters an id carries to commit to its key. Part of the
 *  stored layout: it must never change. */
export function keyCommitment(raw: Uint8Array): Promise<string> {
  return sha256Hex('nya data key id:', raw, 8);
}

/** The full id for data key number n with these bytes. */
export async function dataKeyId(n: number, raw: Uint8Array): Promise<string> {
  return `k${n}-${await keyCommitment(raw)}`;
}

/** Unwrap a stored data key with a master key, check it is the key its id
 *  names, and return its raw bytes. */
export async function unwrapDataKey(master: MasterKey, keyId: string, stored: StoredDataKey): Promise<Uint8Array> {
  const wrapped = stored.wrapped?.[master.fingerprint];
  if (!wrapped) {
    throw new MasterKeyError(
      `Data key ${keyId} is not wrapped for master key ${master.fingerprint} (it has: ${Object.keys(stored.wrapped ?? {}).join(', ') || 'none'}).`
    );
  }
  let raw: Uint8Array;
  try {
    raw = await master.unwrap(keyId, wrapped);
  } catch {
    throw new MasterKeyError(`Data key ${keyId} could not be unwrapped with master key ${master.fingerprint}.`);
  }
  if (raw.length !== 32) throw new MasterKeyError(`Data key ${keyId} is not 32 bytes.`);
  if (!keyId.endsWith(`-${await keyCommitment(raw)}`)) {
    throw new MasterKeyError(`Data key ${keyId} is not the key its id names.`);
  }
  return raw;
}

/** Parse a stored data key. Takes a string (the raw client, the fake) or an
 *  already-parsed object (Upstash's default client parses JSON on read). */
export function parseStoredDataKey(keyId: string, value: unknown): StoredDataKey {
  let parsed: unknown = value;
  if (typeof value === 'string') {
    try {
      parsed = JSON.parse(value);
    } catch {
      throw new MasterKeyError(`Data key ${keyId} is stored in an unreadable form.`);
    }
  }
  const p = parsed as StoredDataKey;
  if (!p || typeof p !== 'object' || !p.wrapped || typeof p.wrapped !== 'object' || Array.isArray(p.wrapped)) {
    throw new MasterKeyError(`Data key ${keyId} is stored in an unreadable form.`);
  }
  if (p.container !== undefined && !isContainerId(p.container)) {
    throw new MasterKeyError(`Data key ${keyId} names something that is not a container.`);
  }
  return p;
}

/** A data key, opened, with the container its record names (null for the
 *  environment's own keys and k0). */
type OpenedKey = { key: CryptoKey; container: string | null };

/**
 * Data keys, opened on first use and kept for the life of the process.
 *
 * Per key and per master: a data key that cannot be opened affects only the
 * values encrypted with it. Concurrent first uses share one load. Failures are
 * not cached, so a Redis blip is retried on the next read. Because ids commit
 * to their key, a cached key can never be confused with a different one.
 */
const _dataKeys = new Map<string, Promise<OpenedKey>>();
/** Every master a key has been opened with in this process (one, or two
 *  across a rotation), so a key is forgotten without scanning the cache. */
const _openedWith = new Set<string>();
async function dataKey(keyId: string): Promise<OpenedKey> {
  const master = await masterKey();
  finishRotationSoon(master.fingerprint);
  _openedWith.add(master.fingerprint);
  const cacheKey = `${master.fingerprint}:${keyId}`;
  const cached = _dataKeys.get(cacheKey);
  if (cached) return cached;

  const load = (async () => {
    const value = await redis().hget(keysHashKey(), keyId);
    if (value === null || value === undefined) throw new UnknownKeyError(keyId);
    const stored = parseStoredDataKey(keyId, value);
    const key = await importAes(await unwrapDataKey(master, keyId, stored));
    return { key, container: stored.container ?? null };
  })();
  _dataKeys.set(cacheKey, load);
  load.catch(() => {
    if (_dataKeys.get(cacheKey) === load) _dataKeys.delete(cacheKey);
  });
  return load;
}

/** Forget an opened key, so its next use reads it from the store again. A
 *  lookup per master it can have been opened with, never a scan of the cache:
 *  it runs on every map entry's refresh, so once per container a minute. */
function forgetDataKey(keyId: string): void {
  for (const fingerprint of _openedWith) _dataKeys.delete(`${fingerprint}:${keyId}`);
}

/** Forgets an opened key, so its next use reads it from the store again: for
 *  the migration pass, which checks what it writes against the key as stored
 *  now, not as an earlier read left it in memory. */
export function reloadKey(keyId: string): void {
  forgetDataKey(keyId);
}

/**
 * Every field of the key store, a page at a time (HSCAN), as stored: the key
 * store has a key per container, so it is never read in one request. A field
 * the scan repeats is kept once.
 */
export async function scanKeyStore(): Promise<Map<string, unknown>> {
  const out = new Map<string, unknown>();
  let cursor: string | number = 0;
  do {
    const [next, flat] = (await redis().hscan(keysHashKey(), cursor, { count: SCAN_PAGE })) as [string | number, unknown[]];
    for (let i = 0; i + 1 < flat.length; i += 2) out.set(String(flat[i]), flat[i + 1]);
    cursor = next;
  } while (String(cursor) !== '0');
  return out;
}

/** Writes key records a page per request. */
async function writeKeys(entries: [string, StoredDataKey][]): Promise<void> {
  for (let i = 0; i < entries.length; i += WRITE_PAGE) {
    const page = entries.slice(i, i + WRITE_PAGE);
    await redis().hset(keysHashKey(), Object.fromEntries(page.map(([id, stored]) => [id, JSON.stringify(stored)])));
  }
}

// Key numbers

/**
 * The next key number, from a counter of its own: one INCR, started the first
 * time past the highest number the key store holds. Never a field of
 * crypto:keys, where the release before refuses anything that isn't a key
 * (and with it every master rotation). Answers -1 when the counter doesn't
 * exist and no starting point was given.
 */
export const KEY_SEQ = `-- nya:key-seq
if redis.call('EXISTS', KEYS[1]) == 0 then
  if ARGV[1] == '' then return -1 end
  redis.call('SET', KEYS[1], ARGV[1], 'NX')
end
return redis.call('INCR', KEYS[1])`;

export function keySeqKey(): string {
  return kEnv('crypto:key-seq');
}

/** The highest key number in the store, read a page at a time. Never spread
 *  into Math.max: at a key per container that throws in Node past about
 *  150,000 numbers. */
async function highestKeyNumber(): Promise<number> {
  let max = 0;
  for (const id of (await scanKeyStore()).keys()) {
    if (!KEY_ID.test(id) || id === LEGACY_KEY_ID) continue;
    const n = Number(id.slice(1, id.indexOf('-')));
    if (n > max) max = n;
  }
  return max;
}

/** The key counter as stored (the last number handed out), or null when
 *  there is none yet or it isn't a number. For the status. */
export async function readKeyCounter(): Promise<number | null> {
  const v = await redis().get<unknown>(keySeqKey());
  if (typeof v === 'number' && Number.isSafeInteger(v)) return v;
  if (typeof v === 'string' && /^(0|[1-9][0-9]*)$/.test(v)) return Number(v);
  return null;
}

/** The next number for a new data key. Two keys may share one; their ids
 *  still differ, since an id commits to its key. */
export async function nextKeyNumber(): Promise<number> {
  let n = Number(await redis().eval(KEY_SEQ, [keySeqKey()], ['']));
  if (n === -1) n = Number(await redis().eval(KEY_SEQ, [keySeqKey()], [String(await highestKeyNumber())]));
  if (!Number.isSafeInteger(n) || n < 1) throw new MasterKeyError('The key counter holds something that is not a number.');
  return n;
}

// Master rotation
//
// Three states, recorded in "crypto:rotation":
//   none      no rotation in progress.
//   prepared  every data key also has a lock for the new master, proven to
//             open. Written only after a COMPLETE, verified prepare, so a
//             failed one leaves no record and nothing is removed on the
//             strength of a partial one.
//   finished  after the new master has run for ROTATION_GRACE_MS, its
//             deployment removes the old locks and the record. Until then,
//             rolling back to the old deployment still works.
//
// With a key per container, these loops are as long as the number of
// accounts, so both read the store a page at a time and write a page of keys
// per request, and finishing can be repeated: a key already finished passes,
// and the record goes only once every key is finished. An interrupted finish
// (a Redis error part way, or the automatic finish frozen when the request it
// ran beside ended) is completed by the next attempt.
//
// Changing only the master does NOT protect against someone who already holds
// a copy of the database (or a backup) together with the old master: the data
// keys in that copy do not change. Responding to that needs new data keys and
// re-encryption (see lib/reencrypt.ts).

/** How long the old master's locks are kept after the new master is running. */
export const ROTATION_GRACE_MS = 24 * 60 * 60 * 1000;
/** A rotation step holds a lock for at most this long. */
const ROTATION_LOCK_MS = 60 * 1000;
/** How often a process may try to finish a rotation on its own. */
const AUTO_FINISH_EVERY_MS = 10 * 60 * 1000;

/** A rotation cannot proceed. Nothing was changed when this is thrown. */
export class RotationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RotationError';
  }
}

export type RotationRecord = { from: string; next: string; prepared_at: string };

export function rotationKey(): string {
  return kEnv('crypto:rotation');
}
export function rotationLockKey(): string {
  return kEnv('crypto:rotation-lock');
}

async function readRotation(): Promise<RotationRecord | null> {
  const value = await redis().get(rotationKey());
  if (value === null || value === undefined) return null;
  const r = (typeof value === 'string' ? JSON.parse(value) : value) as RotationRecord;
  if (!r || typeof r.next !== 'string' || typeof r.from !== 'string' || typeof r.prepared_at !== 'string') {
    throw new RotationError('The rotation record is unreadable. Start the rotation again.');
  }
  return r;
}

/** True while a rotation is prepared but not finished. New data keys must not
 *  be created then: they would only get the old master's lock. */
export async function rotationPending(): Promise<boolean> {
  return (await readRotation()) !== null;
}

/** Every data key, parsed; refuses an entry that isn't one. Read a page at a
 *  time. */
async function readAllKeys(): Promise<Map<string, StoredDataKey>> {
  const out = new Map<string, StoredDataKey>();
  for (const [id, value] of await scanKeyStore()) {
    if (!KEY_ID.test(id) || id === LEGACY_KEY_ID) throw new RotationError(`Unexpected entry "${id}" in the key store.`);
    out.set(id, parseStoredDataKey(id, value));
  }
  return out;
}

async function writeKey(id: string, stored: StoredDataKey): Promise<void> {
  await redis().hset(keysHashKey(), { [id]: JSON.stringify(stored) });
}

/** Run one rotation step (or the creation of the first data key) at a time
 *  across every instance. */
async function withRotationLock<T>(fn: () => Promise<T>, onBusy?: () => Promise<T>): Promise<T> {
  const token = crypto.randomUUID();
  const got = await redis().set(rotationLockKey(), token, { nx: true, px: ROTATION_LOCK_MS });
  if (!got) {
    if (onBusy) return onBusy();
    throw new RotationError('Another rotation step is running. Try again in a minute.');
  }
  try {
    return await fn();
  } finally {
    try {
      if ((await redis().get(rotationLockKey())) === token) await redis().del(rotationLockKey());
    } catch {
      // It expires on its own.
    }
  }
}

/**
 * Step 1 of a master rotation, run by the deployment that has the CURRENT
 * master: give every data key a lock for the new master as well, and record the
 * rotation only once all are done and proven to open.
 *
 * Each key ends with exactly two locks, current and new; a lock for any other
 * master is dropped, which is how a new request replaces an unfinished rotation.
 * If interrupted, every key is still openable by the current master and there is
 * no record, so nothing is ever finished from it; running it again completes it.
 */
export async function prepareMasterRotation(
  newMaterial: string,
  now: number = Date.now()
): Promise<{ prepared: number; fingerprint: string }> {
  return withRotationLock(async () => {
    const current = await masterKey();
    let next: MasterKey;
    try {
      next = await importMasterKey(newMaterial, 'The new master key');
    } catch (err) {
      throw new RotationError(err instanceof Error ? err.message : String(err));
    }
    if (next.fingerprint === current.fingerprint) {
      throw new RotationError('The new master key is the same as the current one.');
    }
    const recorded = await readCurrentMaster();
    if (recorded !== null && recorded !== current.fingerprint) {
      throw new RotationError(`This deployment's master (${current.fingerprint}) is not the current one (${recorded}), so nothing was changed.`);
    }

    const keys = await readAllKeys();
    // Open everything first: a key the current master cannot open stops the
    // rotation before anything is written.
    const raw = new Map<string, Uint8Array>();
    for (const [id, stored] of keys) {
      try {
        raw.set(id, await unwrapDataKey(current, id, stored));
      } catch (err) {
        throw new RotationError(`The running master cannot open ${id}, so nothing was changed. (${err instanceof Error ? err.message : err})`);
      }
    }

    // Any record from an earlier rotation is void from here on.
    await redis().del(rotationKey());
    const writes: [string, StoredDataKey][] = [];
    for (const [id, stored] of keys) {
      const lock = await next.wrap(id, raw.get(id)!);
      // Checked before it is saved, so a bad lock is never stored.
      await unwrapDataKey(next, id, { ...stored, wrapped: { [next.fingerprint]: lock } });
      writes.push([
        id,
        { ...stored, wrapped: { [current.fingerprint]: stored.wrapped[current.fingerprint], [next.fingerprint]: lock }, next: next.fingerprint },
      ]);
    }
    await writeKeys(writes);

    // Read back: both masters must open every key, so the deployment running
    // now and the one about to be deployed both work.
    const after = await readAllKeys();
    for (const [id, stored] of after) {
      await unwrapDataKey(current, id, stored);
      await unwrapDataKey(next, id, stored);
      if (stored.next !== next.fingerprint) throw new RotationError(`${id} changed during the rotation. Run it again.`);
    }
    const record: RotationRecord = { from: current.fingerprint, next: next.fingerprint, prepared_at: new Date(now).toISOString() };
    await redis().set(rotationKey(), JSON.stringify(record));
    return { prepared: after.size, fingerprint: next.fingerprint };
  });
}

export type RotationStatus =
  | { state: 'none' }
  | { state: 'prepared'; next: string; prepared_at: string; running: string }
  | { state: 'grace'; next: string; finishes_at: string }
  | { state: 'finished'; finished: number };

/**
 * Where a rotation stands, as seen by this deployment. Reads only.
 * "prepared" means the new master is not running here yet (redeploy with it);
 * "grace" means it is, and the old locks go at finishes_at.
 */
export async function rotationStatus(now: number = Date.now()): Promise<RotationStatus> {
  const rec = await readRotation();
  if (!rec) return { state: 'none' };
  const running = process.env[MASTER_KEY_ENV] ? (await masterKey()).fingerprint : 'none';
  if (rec.next !== running) return { state: 'prepared', next: rec.next, prepared_at: rec.prepared_at, running };
  return { state: 'grace', next: rec.next, finishes_at: new Date(Date.parse(rec.prepared_at) + ROTATION_GRACE_MS).toISOString() };
}

/** Whether a key holds only this master's lock and no `next`: finished. */
function finishedFor(stored: StoredDataKey, fingerprint: string): boolean {
  const locks = Object.keys(stored.wrapped);
  return stored.next === undefined && locks.length === 1 && locks[0] === fingerprint;
}

/**
 * Step 3 of a master rotation, run by the deployment that has the NEW master:
 * remove the other locks from every data key, then the record.
 *
 * Only when the record names this deployment's master and the grace period is
 * over (or `force`). Every key must be either prepared for this master or
 * already finished (an attempt before this one stopped part way), and proven
 * to open with it; otherwise nothing is removed. The keys still to finish are
 * written a page per request, read back, and the record goes only once every
 * key is finished, so repeating this after any interruption completes it.
 * Keeps every other field of each key.
 */
export async function finishMasterRotation(
  opts: { now?: number; force?: boolean } = {}
): Promise<RotationStatus> {
  const now = opts.now ?? Date.now();
  if (!process.env[MASTER_KEY_ENV]) return { state: 'none' };
  // Checked without the lock first, so the common "nothing to do" costs one read.
  const status = await rotationStatus(now);
  if (status.state !== 'grace') return status;
  if (!opts.force && now < Date.parse(status.finishes_at)) return status;

  return withRotationLock(async () => {
    const rec = await readRotation();
    const current = await masterKey();
    if (!rec || rec.next !== current.fingerprint) return rotationStatus(now);

    const keys = await readAllKeys();
    const writes: [string, StoredDataKey][] = [];
    for (const [id, stored] of keys) {
      const done = finishedFor(stored, current.fingerprint);
      if (!done && (stored.next !== current.fingerprint || !stored.wrapped[current.fingerprint])) {
        throw new RotationError(`${id} was not prepared for this master, so no more locks were removed. Run the rotation again.`);
      }
      await unwrapDataKey(current, id, stored);
      if (done) continue;
      const { next: _done, ...rest } = stored;
      writes.push([id, { ...rest, wrapped: { [current.fingerprint]: stored.wrapped[current.fingerprint] } }]);
    }
    await writeKeys(writes);
    // Read back: only once every key is finished does the record go.
    const after = await readAllKeys();
    for (const [id, stored] of after) {
      if (!finishedFor(stored, current.fingerprint)) throw new RotationError(`${id} changed while the rotation was being finished. It finishes on the next attempt.`);
    }
    // Before the record goes, so no moment exists with neither a pending
    // rotation nor this master recorded, in which an old deployment could
    // create a key only it can open.
    await writeCurrentMaster(current.fingerprint);
    await redis().del(rotationKey());
    return { state: 'finished', finished: after.size };
  });
}

// On first use of a data key, and then at most every few minutes per process
// per master, try to finish a rotation that is due. Failures are logged and
// tried again later, never thrown into the request.
const _autoFinish = new Map<string, { at: number; run: Promise<unknown> }>();
function finishRotationSoon(fingerprint: string, now: number = Date.now()): void {
  const last = _autoFinish.get(fingerprint);
  if (last && now - last.at >= 0 && now - last.at < AUTO_FINISH_EVERY_MS) return;
  const run = finishMasterRotation({ now }).catch((err) =>
    console.error('Master rotation finish failed', err instanceof Error ? err.message : err)
  );
  _autoFinish.set(fingerprint, { at: now, run });
}

/** For tests: wait for any automatic finish this process started. */
export async function autoFinishSettled(): Promise<void> {
  await Promise.all([..._autoFinish.values()].map((v) => v.run));
}

function keyFor(keyId: string): Promise<OpenedKey> {
  return keyId === LEGACY_KEY_ID ? legacyKey().then((key) => ({ key, container: null })) : dataKey(keyId);
}

// Formats

export type CiphertextFormat = { version: 1 | 2; keyId: string; flags: string };

type Parsed = CiphertextFormat & { body: string; header: string };

function parse(payload: string): Parsed {
  if (!payload.includes('.')) return { version: 1, keyId: LEGACY_KEY_ID, flags: '-', body: payload, header: '' };

  const parts = payload.split('.');
  // Named only when it looks like a version tag; anything else is not quoted.
  if (parts[0] !== 'v2') {
    if (/^v[0-9]{1,3}$/.test(parts[0])) throw new UnsupportedFormatError(`Unsupported encryption format "${parts[0]}".`);
    throw new MalformedCiphertextError('Unrecognised encrypted value.');
  }
  if (parts.length !== 4) throw new MalformedCiphertextError('Encrypted value does not have four parts.');
  const [, keyId, flags, body] = parts;
  if (!KEY_ID.test(keyId)) throw new MalformedCiphertextError('Encrypted value has an invalid key id.');
  if (!FLAGS.test(flags)) throw new MalformedCiphertextError('Encrypted value has invalid flags.');
  if (flags !== '-') {
    for (const f of flags) {
      if (!KNOWN_FLAGS.has(f)) throw new UnsupportedFormatError(`Encrypted value uses unknown flag "${f}".`);
    }
    if ([...new Set(flags)].sort().join('') !== flags) {
      throw new MalformedCiphertextError('Encrypted value has flags out of order or repeated.');
    }
  }
  return { version: 2, keyId, flags, body, header: `v2.${keyId}.${flags}` };
}

/** A context must encode to UTF-8 and back unchanged. A lone surrogate would
 *  not: TextEncoder replaces it, so two different contexts would bind alike. */
function checkContext(context: string | undefined): void {
  if (context !== undefined && new TextDecoder().decode(utf8(context)) !== context) {
    throw new Error('A context must be valid text (it contains an unpaired surrogate).');
  }
}

/** The additional data for a v2 value: its header, plus the context when the
 *  value is bound to one. The NUL separator cannot appear in a header. */
function v2Aad(header: string, context: string | undefined): Uint8Array {
  return utf8(context === undefined ? header : `${header}\0${context}`);
}

// The active data key: the one new writes use

/** How long a process trusts the active key id it last read, and the data key
 *  it opened for it, and the same for a container's map entry. A change of
 *  either is picked up within this, so anything that switches keys and then
 *  relies on the old one no longer being written (a re-encryption pass) must
 *  wait longer than this first. */
export const ACTIVE_CACHE_MS = 60 * 1000;
/** While writes are falling back to k0, how often to log it again. */
const FALLBACK_LOG_EVERY_MS = 60 * 60 * 1000;

export function activeKeyName(): string {
  return kEnv('crypto:active');
}

/** Which master is current: set when the first data key is created and moved
 *  by finishMasterRotation. A deployment holding any other master (an old
 *  instance still warm, an old deployment's URL, an instant rollback) must
 *  never create a data key: only it could open that key. */
export function currentMasterKeyName(): string {
  return kEnv('crypto:master');
}

// Stored as JSON rather than the bare fingerprint: Upstash's default client
// parses values on read, and a hex string like "1e5..." would come back a number.
async function readCurrentMaster(): Promise<string | null> {
  const value = await redis().get(currentMasterKeyName());
  if (value === null || value === undefined) return null;
  const r = (typeof value === 'string' ? JSON.parse(value) : value) as { fingerprint?: unknown };
  if (!r || typeof r.fingerprint !== 'string') throw new MasterKeyError('The current master record is unreadable.');
  return r.fingerprint;
}

/** The current master record exactly as it is stored, so a Lua step can
 *  compare it as text. */
const masterRecord = (fingerprint: string) => JSON.stringify({ fingerprint });

async function writeCurrentMaster(fingerprint: string): Promise<void> {
  await redis().set(currentMasterKeyName(), masterRecord(fingerprint));
}

let _active: { fingerprint: string; id: string; at: number } | null = null;
let _activeLoad: { fingerprint: string; run: Promise<string | null> } | null = null;
let _fallback: { since: number; loggedAt: number; reason: string } | null = null;

/** Forget the cached active key id, and every container's map entry. For
 *  tests, and for code that has just changed them. */
export function forgetActiveKey(): void {
  _active = null;
  _activeLoad = null;
  _fallback = null;
  _entries.clear();
}

/**
 * Create the first data key and make it active, or null to keep writing k0
 * for now.
 *
 * Runs under the rotation lock, so it can never interleave with a master
 * rotation step: a key made while a rotation is being prepared would get only
 * the old master's lock, and the rotation could then never finish. If the lock
 * is busy, this write uses k0 and a later one tries again.
 *
 * Inside the lock, and only then, it checks that no key has appeared, that no
 * rotation is pending, and that this deployment's master is the current one.
 * The key is stored and proven to open before it is claimed with SET NX.
 */
async function createActiveKey(master: MasterKey, now: number): Promise<unknown> {
  return withRotationLock(
    async () => {
      const existing = await redis().get(activeKeyName());
      if (existing !== null && existing !== undefined && existing !== '') return existing;
      if (await rotationPending()) return null;
      const current = await readCurrentMaster();
      if (current !== null && current !== master.fingerprint) {
        throw new MasterKeyError(
          `This deployment's master (${master.fingerprint}) is not the current one (${current}), so it will not create a data key.`
        );
      }
      if (current === null) await writeCurrentMaster(master.fingerprint);

      const n = await nextKeyNumber();
      if (n > MAX_KEY_NUMBER) throw new MasterKeyError('Key numbers have reached the most the id format allows, so no data key can be made.');
      const raw = crypto.getRandomValues(new Uint8Array(32));
      const id = await dataKeyId(n, raw);
      const stored: StoredDataKey = { created_at: new Date(now).toISOString(), wrapped: { [master.fingerprint]: await master.wrap(id, raw) } };
      await writeKey(id, stored);
      // Proven from the store before anything relies on it.
      const back = await redis().hget(keysHashKey(), id);
      await unwrapDataKey(master, id, parseStoredDataKey(id, back));

      // Checked again right before the claim, in case the lock expired under a
      // very slow step and a rotation was prepared meanwhile. Nothing can have
      // used the key yet, so it is safe to remove.
      if (await rotationPending()) {
        await redis().hdel(keysHashKey(), id);
        return null;
      }
      if (await redis().set(activeKeyName(), id, { nx: true })) return id;
      // Something set it outside the lock (a restore, say): use that, remove ours.
      await redis().hdel(keysHashKey(), id);
      return redis().get(activeKeyName());
    },
    async () => null
  );
}

function checkActiveId(id: unknown): string {
  if (typeof id !== 'string' || !KEY_ID.test(id) || id === LEGACY_KEY_ID) {
    throw new MasterKeyError('The active data key record is not a data key id.');
  }
  return id;
}

/**
 * The data key new writes should use, or null to write v1 under k0: when
 * there is no master, while a master rotation is pending and no data key
 * exists yet, or while another instance holds the rotation lock. Throws on
 * anything unexpected; encrypt() turns that into k0.
 *
 * On every refresh (at most once a minute) the key is reloaded from the store,
 * so a key that has gone (a restore replaced the key store) or no longer opens
 * with this master stops being written within a minute. Concurrent refreshes
 * in one process share one.
 */
async function activeKeyId(now: number = Date.now()): Promise<string | null> {
  if (!process.env[MASTER_KEY_ENV]) return null;
  const master = await masterKey();
  if (_active && _active.fingerprint === master.fingerprint && now - _active.at >= 0 && now - _active.at < ACTIVE_CACHE_MS) {
    return _active.id;
  }
  if (_activeLoad && _activeLoad.fingerprint === master.fingerprint) return _activeLoad.run;

  const run = (async () => {
    let stored = await redis().get(activeKeyName());
    if (stored === null || stored === undefined || stored === '') {
      stored = await createActiveKey(master, now);
      if (stored === null) return null;
    }
    const id = checkActiveId(stored);
    _dataKeys.delete(`${master.fingerprint}:${id}`);
    const opened = await dataKey(id);
    // The environment's writes never go to a container's key.
    if (opened.container !== null) throw new MasterKeyError(`The active data key ${id} is a container's key.`);
    _active = { fingerprint: master.fingerprint, id, at: now };
    return id;
  })();
  const entry = { fingerprint: master.fingerprint, run };
  _activeLoad = entry;
  try {
    return await run;
  } finally {
    if (_activeLoad === entry) _activeLoad = null;
  }
}

export type ActiveKeyStatus = {
  /** The data key new writes use, or null while they still use k0. */
  active_key: string | null;
  /** Why new writes cannot use it, if they cannot. */
  active_key_problem?: string;
  /** When THIS instance started writing k0 because the active key was
   *  unavailable. Other instances keep their own. */
  this_instance_fallback_since?: string;
};

/** The active data key as stored and whether this deployment can use it.
 *  Never creates one. For the ops status. */
export async function activeKeyStatus(): Promise<ActiveKeyStatus> {
  const out: ActiveKeyStatus = { active_key: null };
  if (_fallback) out.this_instance_fallback_since = new Date(_fallback.since).toISOString();
  const stored = await redis().get(activeKeyName());
  if (stored === null || stored === undefined || stored === '') return out;
  let id: string;
  try {
    id = checkActiveId(stored);
  } catch (err) {
    return { ...out, active_key_problem: (err as Error).message };
  }
  out.active_key = id;
  try {
    const master = await masterKey();
    const value = await redis().hget(keysHashKey(), id);
    if (value === null || value === undefined) throw new UnknownKeyError(id);
    await unwrapDataKey(master, id, parseStoredDataKey(id, value));
  } catch (err) {
    if (!(err instanceof MasterKeyError || err instanceof UnknownKeyError)) throw err;
    out.active_key_problem = err.message;
  }
  return out;
}

/**
 * The active data key, created if there is none yet, for code that must never
 * fall back to k0.
 */
export async function activeKeyForReencryption(): Promise<string> {
  if (!process.env[MASTER_KEY_ENV]) {
    throw new MasterKeyError(`${MASTER_KEY_ENV} is not set, so there is no data key to move values to.`);
  }
  // Read fresh, not from the minute-long cache: after a restore changed the
  // active key, a pass must not keep asking for the old one.
  _active = null;
  let id: string | null;
  try {
    id = await activeKeyId();
  } catch (err) {
    if (err instanceof UnknownKeyError) {
      throw new MasterKeyError(`The active data key ${err.keyId} is not in the key store, so nothing can be moved to it. Was the key store restored without it?`);
    }
    throw err;
  }
  if (!id) {
    throw new MasterKeyError(
      'There is no active data key yet: a master rotation is pending, or another step holds its lock. Try again later.'
    );
  }
  return id;
}

/** Why k0 cannot be used, or null if it can. The message names only the
 *  environment variable. For the re-encryption pass's report. */
export async function legacyKeyProblem(): Promise<string | null> {
  try {
    await legacyKey();
    return null;
  } catch {
    // Not legacyKey()'s own message, which suggests generating a key: a new
    // k0 cannot read anything written under the old one.
    return `${LEGACY_KEY_ENV} is missing or invalid here. Restore the original: a new key cannot read existing data.`;
  }
}

function noteFallback(err: unknown, now: number): void {
  const reason = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  if (!_fallback) _fallback = { since: now, loggedAt: -Infinity, reason };
  _fallback.reason = reason;
  if (now - _fallback.loggedAt >= FALLBACK_LOG_EVERY_MS || now < _fallback.loggedAt) {
    _fallback.loggedAt = now;
    console.error(
      `Writing with the legacy key: the active data key is unavailable (since ${new Date(_fallback.since).toISOString()}).`,
      reason
    );
  }
}

// A data key per container: the map

export function containerKeysKey(): string {
  return kEnv('crypto:container-keys');
}

/** The tombstones of destroyed keys, kept for good: key id -> its container
 *  and the day it was destroyed. A hash, so the release before's export can
 *  carry it. */
export function tombstonesKey(): string {
  return kEnv('crypto:destroyed');
}

/** A container's entry in the map. */
export type ContainerKeyEntry =
  | {
      /** The key the container writes with. */
      key: string;
      /** When the key was made. */
      since: string;
      /** Since when every value of the container has been under its key: its
       *  `since` for one born with it, else when the migration pass's walk
       *  that found nothing left began. Cleared when a value under a shared
       *  key is found in it again. */
      moved?: string;
      /** When the newest nightly data archive that held one of its values
       *  under k0 or an environment key was taken. */
      shared_in?: string;
      /** When the newest format-1 archive taken after its key was made (a
       *  rollback's: the release before's nightly backup, which holds the
       *  whole key store) was taken. That archive holds the key itself. */
      key_in?: string;
    }
  | {
      /** The day its key was destroyed with the account. */
      destroyed: string;
      /** The day the nightly run last swept its prefix for late writes. */
      swept?: string;
    };

const isIso = (v: unknown): v is string => typeof v === 'string' && !Number.isNaN(Date.parse(v));

/** A map entry, checked. Takes a string or an already-parsed object. Throws
 *  ContainerKeyError for one that can't be read: a write must not guess. */
export function parseContainerEntry(container: string, value: unknown): ContainerKeyEntry {
  let v: unknown = value;
  if (typeof value === 'string') {
    try {
      v = JSON.parse(value);
    } catch {
      v = null;
    }
  }
  const e = v as Record<string, unknown> | null;
  if (e && typeof e === 'object' && typeof e.key === 'string' && KEY_ID.test(e.key) && e.key !== LEGACY_KEY_ID && isIso(e.since)) {
    return {
      key: e.key,
      since: e.since,
      ...(isIso(e.moved) ? { moved: e.moved } : {}),
      ...(isIso(e.shared_in) ? { shared_in: e.shared_in } : {}),
      ...(isIso(e.key_in) ? { key_in: e.key_in } : {}),
    };
  }
  if (e && typeof e === 'object' && typeof e.destroyed === 'string') {
    return { destroyed: e.destroyed, ...(typeof e.swept === 'string' ? { swept: e.swept } : {}) };
  }
  throw new ContainerKeyError(container, null, 'its entry in the map of container keys is unreadable');
}

// Entries are kept for ACTIVE_CACHE_MS, as the active key is. Each refresh
// also drops the opened key it names, so a key that has gone from the store
// (destroyed in another process, or a restore) stops being used within it.
const _entries = new Map<string, { at: number; run: Promise<ContainerKeyEntry | null> }>();

function cachedEntry(container: string, now: number): Promise<ContainerKeyEntry | null> {
  const hit = _entries.get(container);
  if (hit && now - hit.at >= 0 && now - hit.at < ACTIVE_CACHE_MS) return hit.run;
  const run = (async () => {
    const value = await redis().hget(containerKeysKey(), container);
    if (value === null || value === undefined) return null;
    const entry = parseContainerEntry(container, value);
    if ('key' in entry) forgetDataKey(entry.key);
    return entry;
  })();
  _entries.set(container, { at: now, run });
  run.catch(() => {
    if (_entries.get(container)?.run === run) _entries.delete(container);
  });
  return run;
}

/** Forget one container's cached map entry (or every one), after changing it. */
export function forgetContainerKey(container?: string): void {
  if (container === undefined) _entries.clear();
  else _entries.delete(container);
}

/**
 * The container's own key, opened, or null when the map names none (the
 * environment's keys are used then). Throws ContainerKeyError when it has one
 * that can't be used; a storage failure is thrown as it is.
 */
async function ownKey(ctx: Ctx, now: number = Date.now()): Promise<{ id: string; key: CryptoKey } | null> {
  const entry = await cachedEntry(ctx.container, now);
  if (entry === null) return null;
  if ('destroyed' in entry) throw new ContainerKeyError(ctx.container, null, 'it was destroyed with the account');
  let opened: OpenedKey;
  try {
    opened = await dataKey(entry.key);
  } catch (err) {
    if (err instanceof UnknownKeyError || err instanceof MasterKeyError) throw new ContainerKeyError(ctx.container, entry.key, err.message);
    throw err;
  }
  if (opened.container !== ctx.container) {
    throw new ContainerKeyError(ctx.container, entry.key, opened.container ? 'its record names another container' : 'its record names no container');
  }
  return { id: entry.key, key: opened.key };
}

/**
 * Opens the container's own key, if it has one, so a key that can't be used
 * is refused where the container is resolved (lib/data-ctx.ts and the others
 * in docs/architecture.md), before any reader that swallows errors runs.
 * Kept for the minute its map entry is: no round trip in the hot path.
 */
export async function checkContainerKey(ctx: Ctx): Promise<void> {
  await ownKey(ctx);
}

/** Whether the map names this key as the container's own (failure paths
 *  only). */
async function isOwnKey(ctx: Ctx, keyId: string): Promise<boolean> {
  try {
    const entry = await cachedEntry(ctx.container, Date.now());
    return entry !== null && 'key' in entry && entry.key === keyId;
  } catch {
    return false;
  }
}

/** The key to decrypt a value of this container with, checked against it. */
async function keyToRead(ctx: Ctx, keyId: string): Promise<CryptoKey> {
  if (keyId === LEGACY_KEY_ID) return legacyKey();
  let opened: OpenedKey;
  try {
    opened = await dataKey(keyId);
  } catch (err) {
    if ((err instanceof UnknownKeyError || err instanceof MasterKeyError) && (await isOwnKey(ctx, keyId))) {
      throw new ContainerKeyError(ctx.container, keyId, err.message);
    }
    throw err;
  }
  if (opened.container !== null && opened.container !== ctx.container) {
    if (await isOwnKey(ctx, keyId)) throw new ContainerKeyError(ctx.container, keyId, 'its record names another container');
    console.error(`Possible isolation bug: a value read in container ${ctx.container} is under ${keyId}, the key of container ${opened.container}.`);
    throw new KeyNotForContainerError(keyId, ctx.container, opened.container);
  }
  return opened.key;
}

// Making and destroying a container's key

/** A container's key, made and proven, ready to be claimed in one Lua step:
 *  the strings that step writes, exactly. */
export type PreparedContainerKey = {
  container: ContainerId;
  id: string;
  /** The key's record for crypto:keys. */
  record: string;
  /** The container's map entry. */
  entry: string;
  /** The current master record as stored, for the step to compare. */
  master: string;
};

/**
 * Makes a key for a container, wraps it with this deployment's master and
 * proves it opens, without storing anything. Null when there is no master, or
 * key numbers are past what the id format allows (that container stays on the
 * shared key, and the status lists it). `born`: for a container being
 * registered with it, which is moved from the start.
 */
export async function prepareContainerKey(
  container: ContainerId,
  opts: { born: boolean; now?: number }
): Promise<PreparedContainerKey | null> {
  if (!masterKeyConfigured()) return null;
  const master = await masterKey();
  const n = await nextKeyNumber();
  if (n > MAX_KEY_NUMBER) {
    console.error(`No data key made for container ${container}: key numbers are past ${MAX_KEY_NUMBER}, the most the id format allows.`);
    return null;
  }
  const raw = crypto.getRandomValues(new Uint8Array(32));
  const id = await dataKeyId(n, raw);
  if (!KEY_ID.test(id)) return null;
  const at = new Date(opts.now ?? Date.now()).toISOString();
  const stored: StoredDataKey = { created_at: at, wrapped: { [master.fingerprint]: await master.wrap(id, raw) }, container };
  // Proven before it is stored, so a key that doesn't open is never claimed.
  await unwrapDataKey(master, id, stored);
  const entry: ContainerKeyEntry = opts.born ? { key: id, since: at, moved: at } : { key: id, since: at };
  return { container, id, record: JSON.stringify(stored), entry: JSON.stringify(entry), master: masterRecord(master.fingerprint) };
}

/**
 * Why no container's key can be claimed just now, or null: a master rotation
 * is prepared or pending, a rotation step holds its lock ('rotation'), or this
 * deployment's master is not the current one ('master'). Read once by a call
 * of the migration pass, so a long wait doesn't use up key numbers; the claim
 * checks the same again in its own step.
 */
export async function containerKeysBlocked(): Promise<'rotation' | 'master' | null> {
  const [rotation, lock] = await Promise.all([redis().get(rotationKey()), redis().get(rotationLockKey())]);
  if ((rotation !== null && rotation !== undefined) || (lock !== null && lock !== undefined)) return 'rotation';
  const recorded = await readCurrentMaster();
  if (recorded !== null && recorded !== (await masterKey()).fingerprint) return 'master';
  return null;
}

/** The keys a step claiming a container's key reads and writes, in order: the
 *  map, the key store, the rotation record and lock, the current master. */
export function containerKeyScriptKeys(): string[] {
  return [containerKeysKey(), keysHashKey(), rotationKey(), rotationLockKey(), currentMasterKeyName()];
}

/** Its arguments, in order (all "" for none): the key's id, its record, the
 *  map entry, the current master record. */
export function containerKeyScriptArgs(p: PreparedContainerKey | null): string[] {
  return p ? [p.id, p.record, p.entry, p.master] : ['', '', '', ''];
}

/**
 * A container's data key, made for its birth, as the registering scripts take
 * it (lib/container-key-lua.ts). Best effort: with no master, or if making it
 * fails (logged), the arguments say "no key" and the container is registered
 * without one, for the migration pass to give it one later.
 */
export async function birthKey(container: ContainerId, now: number = Date.now()): Promise<{ keys: string[]; args: string[] }> {
  let prepared: PreparedContainerKey | null = null;
  try {
    prepared = await prepareContainerKey(container, { born: true, now });
  } catch (err) {
    console.error(`No data key made for the new container ${container}:`, err instanceof Error ? err.name : typeof err);
  }
  return { keys: containerKeyScriptKeys(), args: containerKeyScriptArgs(prepared) };
}

/**
 * Claims a key for a container that exists already (the migration pass), in
 * one step. Answers what happened, with the entry as it now stands ("v" and
 * its text, so the client parses nothing):
 *   have          the map has an entry for it already: that one stands;
 *   unregistered  the container is not in the registry;
 *   rotation      a master rotation is prepared or pending, or holds its lock;
 *   master        this deployment's master is not the current one;
 *   taken         the key's id is in the store already;
 *   made          the key and the map entry were written together.
 * The first line names the script for the test double.
 */
export const CONTAINER_KEY_CREATE = `-- nya:container-key-create
local have = redis.call('HGET', KEYS[1], ARGV[1])
if have then return {'have', 'v' .. have} end
if redis.call('HEXISTS', KEYS[6], ARGV[1]) == 0 then return {'unregistered', ''} end
if redis.call('EXISTS', KEYS[3]) == 1 or redis.call('EXISTS', KEYS[4]) == 1 then return {'rotation', ''} end
local master = redis.call('GET', KEYS[5])
if master and master ~= ARGV[5] then return {'master', ''} end
if redis.call('HEXISTS', KEYS[2], ARGV[2]) == 1 then return {'taken', ''} end
if not master then redis.call('SET', KEYS[5], ARGV[5]) end
redis.call('HSET', KEYS[2], ARGV[2], ARGV[3])
redis.call('HSET', KEYS[1], ARGV[1], ARGV[4])
return {'made', 'v' .. ARGV[4]}`;

export type ClaimOutcome = 'have' | 'unregistered' | 'rotation' | 'master' | 'taken' | 'made';

export async function claimContainerKey(p: PreparedContainerKey): Promise<{ outcome: ClaimOutcome; entry: ContainerKeyEntry | null }> {
  const answer = await redis().eval(CONTAINER_KEY_CREATE, [...containerKeyScriptKeys(), registryKey()], [p.container, ...containerKeyScriptArgs(p)]);
  if (!Array.isArray(answer) || answer.length !== 2 || typeof answer[0] !== 'string' || typeof answer[1] !== 'string') {
    throw new Error('crypto: unexpected answer claiming a container key');
  }
  const outcome = answer[0] as ClaimOutcome;
  forgetContainerKey(p.container);
  const text = answer[1];
  return { outcome, entry: text === '' ? null : parseContainerEntry(p.container, text.slice(1)) };
}

/**
 * Destroys a container's keys, in one step, and only for a container no
 * longer in the registry (answers -1 otherwise, changing nothing). Of the key
 * ids named: one whose record names the container is deleted, with a
 * tombstone for it; one already gone from the store is tombstoned for the
 * container unless a tombstone stands (the map entry named it, so a copy of
 * it in a key archive is the container's); one whose record or tombstone
 * names another container is left alone, whatever named it. The map entry
 * becomes a marker that the key was destroyed, so a write that comes too late
 * fails. Repeating it does nothing more. Answers the ids that are now the
 * container's tombstones, destroyed now or before.
 * KEYS: the map, the key store, the registry, the tombstones.
 * ARGV: the container, the day, then the key ids.
 */
export const CONTAINER_KEY_DESTROY = `-- nya:container-key-destroy
if redis.call('HEXISTS', KEYS[3], ARGV[1]) == 1 then return -1 end
local mark = '"container":"' .. ARGV[1] .. '"'
local stone = '{"container":"' .. ARGV[1] .. '","on":"' .. ARGV[2] .. '"}'
local out = {}
for i = 3, #ARGV do
  local id = ARGV[i]
  local rec = redis.call('HGET', KEYS[2], id)
  local tomb = redis.call('HGET', KEYS[4], id)
  if rec then
    if string.find(rec, mark, 1, true) then
      redis.call('HDEL', KEYS[2], id)
      if not tomb then redis.call('HSET', KEYS[4], id, stone) end
      out[#out + 1] = id
    end
  elseif not tomb then
    redis.call('HSET', KEYS[4], id, stone)
    out[#out + 1] = id
  elseif string.find(tomb, mark, 1, true) then
    out[#out + 1] = id
  end
end
local cur = redis.call('HGET', KEYS[1], ARGV[1])
if not cur or not string.find(cur, '"destroyed"', 1, true) then
  redis.call('HSET', KEYS[1], ARGV[1], '{"destroyed":"' .. ARGV[2] .. '"}')
end
return out`;

/** The container a stored key record names, from the record as the client
 *  hands it over, or null. */
function recordContainer(value: unknown): string | null {
  if (value && typeof value === 'object' && typeof (value as StoredDataKey).container === 'string') return (value as StoredDataKey).container!;
  if (typeof value === 'string') {
    const m = /"container":"([0-9a-f-]{36})"/.exec(value);
    if (m) return m[1];
  }
  return null;
}

/** Every key whose record names this container, from the whole store. */
async function keysOfContainer(container: string): Promise<string[]> {
  const out: string[] = [];
  for (const [id, value] of await scanKeyStore()) if (recordContainer(value) === container) out.push(id);
  return out.sort();
}

/**
 * Destroys every key of a container that has left the registry: the one its
 * map entry names, any other whose record names it (a damaged map entry must
 * not let a key survive), and those already tombstoned for it, so a retry
 * answers the same. Then checks none is left. Repeating it does nothing more.
 * Answers the key ids destroyed, now or before.
 */
export async function destroyContainerKeys(ctx: Ctx, now: number = Date.now()): Promise<{ destroyed: string[] }> {
  const ids = new Set<string>(await keysOfContainer(ctx.container));
  for (const [id, stone] of await readTombstones()) if (stone.container === ctx.container) ids.add(id);
  const raw = await redis().hget(containerKeysKey(), ctx.container);
  if (raw !== null && raw !== undefined) {
    try {
      const entry = parseContainerEntry(ctx.container, raw);
      if ('key' in entry) ids.add(entry.key);
    } catch {
      // An unreadable entry names no key; the scan above found them all.
    }
  }
  const day = new Date(now).toISOString().slice(0, 10);
  const answer = await redis().eval(
    CONTAINER_KEY_DESTROY,
    [containerKeysKey(), keysHashKey(), registryKey(), tombstonesKey()],
    [ctx.container, day, ...[...ids].sort()]
  );
  if (answer === -1 || answer === '-1') throw new ContainerError(`Container ${ctx.container} is still in the registry, so its key was not destroyed.`);
  if (!Array.isArray(answer)) throw new Error('crypto: unexpected answer destroying a container key');
  forgetContainerKey(ctx.container);
  for (const id of ids) forgetDataKey(id);
  const left = await keysOfContainer(ctx.container);
  if (left.length > 0) throw new ContainerError(`Keys of container ${ctx.container} are still in the key store after it was destroyed (${left.join(', ')}).`);
  return { destroyed: answer.map(String).sort() };
}

/** The tombstones, as stored: key id -> its container and day. */
export type Tombstone = { container: string; on: string };

export async function readTombstones(): Promise<Map<string, Tombstone>> {
  const out = new Map<string, Tombstone>();
  let cursor: string | number = 0;
  do {
    const [next, flat] = (await redis().hscan(tombstonesKey(), cursor, { count: SCAN_PAGE })) as [string | number, unknown[]];
    for (let i = 0; i + 1 < flat.length; i += 2) {
      let v: unknown = flat[i + 1];
      if (typeof v === 'string') {
        try {
          v = JSON.parse(v);
        } catch {
          v = null;
        }
      }
      const t = v as Tombstone | null;
      if (t && typeof t.container === 'string' && typeof t.on === 'string') out.set(String(flat[i]), { container: t.container, on: t.on });
    }
    cursor = next;
  } while (String(cursor) !== '0');
  return out;
}

/** A container's map entry, read fresh (never from the cache), or null. */
export async function readContainerEntry(container: string): Promise<ContainerKeyEntry | null> {
  const value = await redis().hget(containerKeysKey(), container);
  if (value === null || value === undefined) return null;
  return parseContainerEntry(container, value);
}

/** Reads a map entry exactly as stored ("v" and its text, or ""), so a change
 *  to it can be compared as text. */
export const CONTAINER_ENTRY_READ = `-- nya:container-entry-read
local v = redis.call('HGET', KEYS[1], ARGV[1])
if not v then return '' end
return 'v' .. v`;

/** Writes a map entry only if it still holds exactly the text read ("" for
 *  none). The first line names the script for the test double. */
export const CONTAINER_ENTRY_UPDATE = `-- nya:container-entry-update
local cur = redis.call('HGET', KEYS[1], ARGV[1])
if (cur or '') ~= ARGV[2] then return 0 end
redis.call('HSET', KEYS[1], ARGV[1], ARGV[3])
return 1`;

/**
 * Changes a container's map entry safely: reads it exactly, computes the new
 * one with `fn` (null leaves it as it is), and writes only if it is still what
 * was read, a few times before giving up. For the pass (moved) and the nightly
 * backup (shared_in, swept), which may change the same entry. Answers the
 * entry as written, or as it stands.
 */
export async function updateContainerEntry(
  container: string,
  fn: (entry: ContainerKeyEntry | null) => ContainerKeyEntry | null
): Promise<ContainerKeyEntry | null> {
  for (let attempt = 1; attempt <= 5; attempt++) {
    const answer = await redis().eval(CONTAINER_ENTRY_READ, [containerKeysKey()], [container]);
    if (typeof answer !== 'string') throw new Error('crypto: unexpected answer reading a container key entry');
    const text = answer === '' ? '' : answer.slice(1);
    const current = text === '' ? null : parseContainerEntry(container, text);
    const next = fn(current);
    if (next === null) return current;
    const written = JSON.stringify(next);
    if (written === text) return current;
    if (Number(await redis().eval(CONTAINER_ENTRY_UPDATE, [containerKeysKey()], [container, text, written])) === 1) {
      forgetContainerKey(container);
      return next;
    }
  }
  throw new Error(`The map entry of container ${container} kept changing, so it was not updated.`);
}

/** Every map entry, a page at a time: container id -> entry, or the error
 *  that says why one can't be read. For the pass, the status and backups. */
export async function readContainerEntries(): Promise<Map<string, ContainerKeyEntry | ContainerKeyError>> {
  const out = new Map<string, ContainerKeyEntry | ContainerKeyError>();
  let cursor: string | number = 0;
  do {
    const [next, flat] = (await redis().hscan(containerKeysKey(), cursor, { count: SCAN_PAGE })) as [string | number, unknown[]];
    for (let i = 0; i + 1 < flat.length; i += 2) {
      const container = String(flat[i]);
      try {
        out.set(container, parseContainerEntry(container, flat[i + 1]));
      } catch (err) {
        if (!(err instanceof ContainerKeyError)) throw err;
        out.set(container, err);
      }
    }
    cursor = next;
  } while (String(cursor) !== '0');
  return out;
}

/** Every key record, parsed where it can be: id -> record or the error. For
 *  the status, the pass and the key archives. Fields that are not key ids are
 *  left out. */
export async function readKeyRecords(): Promise<Map<string, StoredDataKey | MasterKeyError>> {
  const out = new Map<string, StoredDataKey | MasterKeyError>();
  for (const [id, value] of await scanKeyStore()) {
    if (!KEY_ID.test(id) || id === LEGACY_KEY_ID) continue;
    try {
      out.set(id, parseStoredDataKey(id, value));
    } catch (err) {
      if (!(err instanceof MasterKeyError)) throw err;
      out.set(id, err);
    }
  }
  return out;
}

// Public API

/**
 * Encrypts a plaintext string for the container it is stored in: v2 under the
 * container's own key when it has one, and only under it (ContainerKeyError
 * when it can't be had). Otherwise as before: v2 under the environment's
 * active data key when there is a master, else v1 under k0; getting that key
 * falls back to k0, which every deployment can read, and logs it (again every
 * hour while it lasts). A failure to encrypt is thrown.
 */
export async function encrypt(ctx: Ctx, plaintext: string): Promise<string> {
  const own = await ownKey(ctx);
  if (own) return sealV2(plaintext, own.id, own.key, undefined);
  return encryptShared(plaintext);
}

async function encryptShared(plaintext: string): Promise<string> {
  const now = Date.now();
  let v2: { id: string; key: CryptoKey } | null = null;
  let failed: unknown = null;
  try {
    const id = await activeKeyId(now);
    if (id) v2 = { id, key: (await keyFor(id)).key };
  } catch (err) {
    failed = err;
    noteFallback(err, now);
  }
  if (v2) {
    _fallback = null;
    return sealV2(plaintext, v2.id, v2.key, undefined);
  }
  let legacy: CryptoKey;
  try {
    legacy = await legacyKey();
  } catch (err) {
    if (failed === null) throw err;
    const why = (e: unknown) => (e instanceof Error ? e.message : String(e));
    throw new MasterKeyError(`Cannot encrypt: the active data key is unavailable (${why(failed)}), and so is the legacy key (${why(err)}).`);
  }
  return seal(legacy, utf8(plaintext));
}

async function sealV2(plaintext: string, keyId: string, key: CryptoKey, context: string | undefined): Promise<string> {
  const header = `v2.${keyId}.${context === undefined ? '-' : 'c'}`;
  const body = await seal(key, utf8(plaintext), v2Aad(header, context));
  return `${header}.${body}`;
}

/**
 * Encrypts in the v2 format with the named key, optionally bound to a
 * context. encrypt() uses this format for everything it writes under a data
 * key; this form is for writing under a specific key (tests, and the
 * re-encryption pass, which checks the result with decrypt() under the
 * container it is for).
 */
export async function encryptV2(plaintext: string, keyId: string, context?: string): Promise<string> {
  if (!KEY_ID.test(keyId)) throw new Error(`Invalid key id "${keyId}".`);
  checkContext(context);
  return sealV2(plaintext, keyId, (await keyFor(keyId)).key, context);
}

/**
 * Decrypts a value stored in this container, in either format. A value under
 * another container's key is refused (KeyNotForContainerError), and one under
 * the container's own key that can't be used throws ContainerKeyError. A value
 * bound to a context needs the same context; one that is not bound ignores
 * it, so callers can start passing a context before every value carries one.
 * (Once every value is bound, a strict mode should refuse unbound values when
 * a context is given; until then a writer to the database could swap in an
 * unbound value.)
 *
 * Throws UnknownKeyError, MasterKeyError, MalformedCiphertextError or
 * DecryptFailedError when it cannot.
 */
export async function decrypt(ctx: Ctx, payload: string, context?: string): Promise<string> {
  const p = parse(payload);
  checkContext(context);
  const key = await keyToRead(ctx, p.keyId);
  if (p.version === 1) return new TextDecoder().decode(await open(key, p.keyId, p.body));

  const bound = p.flags.includes('c');
  // Said specifically: the usual cause is a caller that has not been updated
  // to pass the context, which is a bug to fix, not damaged data.
  if (bound && context === undefined) {
    throw new DecryptFailedError(p.keyId, 'the value is bound to a context and none was given');
  }
  const plain = await open(key, p.keyId, p.body, v2Aad(p.header, bound ? context : undefined));
  return new TextDecoder().decode(plain);
}

/** The container has no data key of its own, so nothing can be sealed under
 *  one (encryptOwn): one made before this release, until the migration pass
 *  gives it a key, or a copy without a master key. Not a ContainerError: the
 *  container works, only what needs its own key is refused. */
export class NoOwnKeyError extends Error {
  constructor(readonly container: string) {
    super(`Container ${container} has no data key of its own.`);
    this.name = 'NoOwnKeyError';
  }
}

/**
 * Seals under the container's own key and nothing else, bound to `context`:
 * for a secret whose readability must end with that key (the key of a file
 * attached to a transaction, lib/attachment-crypto.ts). encrypt() without its
 * fallbacks: NoOwnKeyError when the container has no key of its own, and
 * ContainerKeyError when it has one that can't be used. The context names
 * what the value belongs to and never the environment prefix (see the
 * header), so a copy in another place doesn't open.
 *
 * THE INVARIANT this rests on (docs/architecture.md, "Per-container data
 * keys"): a container's own key is never replaced or retired while the
 * container lives. A value sealed here sits inside another value (a seam
 * record), where no pass that reads value headers can see it, so a re-keying
 * that moved the records and retired the old key would leave these unopenable.
 * Any future re-keying must open each one with decryptOwn and seal it again.
 */
export async function encryptOwn(ctx: Ctx, plaintext: string, context: string): Promise<string> {
  checkContext(context);
  const own = await ownKey(ctx);
  if (!own) throw new NoOwnKeyError(ctx.container);
  return sealV2(plaintext, own.id, own.key, context);
}

/**
 * Opens a value encryptOwn sealed, and only such a value: v2, bound to
 * `context`, under the key the container's map entry names as its own.
 * Stricter than decrypt(), which reads a value under k0 or an environment key
 * in any container and ignores the context of a value bound to none: a
 * secret wrapped some other way by a bug would open there, and destroying
 * the container's key would not end it. Throws DecryptFailedError for a value
 * that isn't one, NoOwnKeyError when the container has no key of its own, and
 * as decrypt() does otherwise.
 */
export async function decryptOwn(ctx: Ctx, payload: string, context: string): Promise<string> {
  checkContext(context);
  const p = parse(payload);
  if (p.version !== 2 || !p.flags.includes('c')) throw new DecryptFailedError(p.keyId, 'the value is not sealed to its own context');
  const own = await ownKey(ctx);
  if (!own) throw new NoOwnKeyError(ctx.container);
  if (own.id !== p.keyId) throw new DecryptFailedError(p.keyId, 'the value is not under this container’s own key');
  const plain = await open(own.key, p.keyId, p.body, v2Aad(p.header, context));
  return new TextDecoder().decode(plain);
}

/** Whether the container has a data key of its own that can be used now
 *  (NoOwnKeyError's opposite), for a route that refuses what needs one
 *  before it writes anything. Throws ContainerKeyError for one that can't be
 *  used, and a storage failure as it is. */
export async function hasOwnKey(ctx: Ctx): Promise<boolean> {
  return (await ownKey(ctx)) !== null;
}

/**
 * The format a stored value claims, without decrypting it: which version, key
 * and flags. For a re-encryption pass to find what still needs moving. It does
 * not validate the value: anything without a "." reads as v1 under k0.
 */
export function formatOf(payload: string): CiphertextFormat {
  const { version, keyId, flags } = parse(payload);
  return { version, keyId, flags };
}

export const isKeyId = (s: string) => KEY_ID.test(s);
