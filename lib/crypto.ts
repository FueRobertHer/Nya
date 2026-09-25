// lib/crypto.ts
//
// Encrypts everything Nya stores (Plaid access tokens, balances, history,
// transactions) before it is written to Redis, so a leak of the database or
// of a backup alone doesn't expose it.
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
//   belongs. They cannot forge a value or a data key.
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
//   - Backups (lib/export.ts) carry the wrapped keys like any other value.
//
// DATA KEY IDS COMMIT TO THEIR KEY. An id is "k<n>-<8 hex>", where the hex is
// derived from the key itself. Two different keys can therefore never share an
// id, even if a key is deleted and "k<n>" is handed out again, and a loaded key
// is checked against its id. Without that, a process holding an old key in
// memory under a reused id would write values no other process could read.
//
// k0 is the exception: PLAID_ENCRYPTION_KEY, the original single key, used
// directly. Everything written before this existed is under it, so it stays
// readable until every value has been re-encrypted under a data key and that
// has been proven by an export/restore.
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
// WRITES go to the ACTIVE data key ("crypto:active") in v2. The first write
// that has the current master and finds no active key creates k1 (see
// createActiveKey). With no master, or if the active key cannot be had for any
// reason, writes fall back to v1 under k0, which every deployment can read: a
// missing or broken master can make writes use the old key, never make them
// fail.
//
// Once anything has written v2 in production, this reader must never be
// reverted to before it, or those values become unreadable.

import { redis, kEnv } from './storage';

const LEGACY_KEY_ENV = 'PLAID_ENCRYPTION_KEY';
const MASTER_KEY_ENV = 'MASTER_KEY';
const LEGACY_KEY_ID = 'k0';
/** "k0", or "k<n>-<8 hex>" with no leading zero in n. */
const KEY_ID = /^(k0|k[1-9][0-9]{0,5}-[0-9a-f]{8})$/;
const FLAGS = /^(-|[a-z]{1,8})$/;
const KNOWN_FLAGS = new Set(['c']);

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

// ---------------------------------------------------------------------------
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

// ---------------------------------------------------------------------------
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

// ---------------------------------------------------------------------------
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

// ---------------------------------------------------------------------------
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
  return p;
}

/**
 * Data keys, opened on first use and kept for the life of the process.
 *
 * Per key and per master: a data key that cannot be opened affects only the
 * values encrypted with it. Concurrent first uses share one load. Failures are
 * not cached, so a Redis blip is retried on the next read. Because ids commit
 * to their key, a cached key can never be confused with a different one.
 */
const _dataKeys = new Map<string, Promise<CryptoKey>>();
async function dataKey(keyId: string): Promise<CryptoKey> {
  const master = await masterKey();
  finishRotationSoon(master.fingerprint);
  const cacheKey = `${master.fingerprint}:${keyId}`;
  const cached = _dataKeys.get(cacheKey);
  if (cached) return cached;

  const load = (async () => {
    const stored = await redis().hget(keysHashKey(), keyId);
    if (stored === null || stored === undefined) throw new UnknownKeyError(keyId);
    return importAes(await unwrapDataKey(master, keyId, parseStoredDataKey(keyId, stored)));
  })();
  _dataKeys.set(cacheKey, load);
  load.catch(() => {
    if (_dataKeys.get(cacheKey) === load) _dataKeys.delete(cacheKey);
  });
  return load;
}

// ---------------------------------------------------------------------------
// Master rotation
//
// Three states, recorded in "crypto:rotation":
//   none      no rotation in progress.
//   prepared  every data key also has a lock for the new master, proven to
//             open. Written only after a COMPLETE, verified prepare, so a
//             prepare that fails partway leaves no record, and nothing is ever
//             removed on the strength of a partial one.
//   finished  after the new master has been running for ROTATION_GRACE_MS, its
//             deployment removes the old locks and the record. The grace
//             period is the rollback window: until then, rolling back to the
//             old deployment still works.
//
// Changing only the master does NOT protect against someone who already holds
// a copy of the database (or a backup) together with the old master: they can
// open the data keys in that copy, and the data keys do not change. Responding
// to that needs new data keys and re-encryption, which come with the
// re-encryption pass.

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
function rotationLockKey(): string {
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

async function readAllKeys(): Promise<Map<string, StoredDataKey>> {
  const all = ((await redis().hgetall(keysHashKey())) ?? {}) as Record<string, unknown>;
  const out = new Map<string, StoredDataKey>();
  for (const [id, value] of Object.entries(all)) {
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
 * master: give every data key a lock for the new master as well, and record
 * the rotation only once all of them are done and proven to open.
 *
 * Every data key must open with the current master first. Each key is left
 * with exactly two locks, current and new; a lock for any other master is
 * dropped, which is how a new request replaces an unfinished rotation (say,
 * to a key that was mistyped or not saved). Interrupted, it leaves every key
 * still openable by the current master and no record, so nothing is ever
 * finished from it; running it again completes it.
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
    for (const [id, stored] of keys) {
      const lock = await next.wrap(id, raw.get(id)!);
      // Checked before it is saved, so a bad lock is never stored.
      await unwrapDataKey(next, id, { ...stored, wrapped: { [next.fingerprint]: lock } });
      await writeKey(id, {
        ...stored,
        wrapped: { [current.fingerprint]: stored.wrapped[current.fingerprint], [next.fingerprint]: lock },
        next: next.fingerprint,
      });
    }

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

/**
 * Step 3 of a master rotation, run by the deployment that has the NEW master:
 * remove the other locks from every data key, then the record.
 *
 * All or nothing: only when the record names this deployment's master, the
 * grace period is over (or `force`), and EVERY key is marked for this master
 * and proven to open with it. Otherwise nothing is removed. Keeps every other
 * field of each key.
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
    for (const [id, stored] of keys) {
      if (stored.next !== current.fingerprint || !stored.wrapped[current.fingerprint]) {
        throw new RotationError(`${id} was not prepared for this master, so no locks were removed. Run the rotation again.`);
      }
      await unwrapDataKey(current, id, stored);
    }
    for (const [id, stored] of keys) {
      const { next: _done, ...rest } = stored;
      await writeKey(id, { ...rest, wrapped: { [current.fingerprint]: stored.wrapped[current.fingerprint] } });
    }
    // Before the record goes, so no moment exists with neither a pending
    // rotation nor this master recorded, in which an old deployment could
    // create a key only it can open.
    await writeCurrentMaster(current.fingerprint);
    await redis().del(rotationKey());
    return { state: 'finished', finished: keys.size };
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

function keyFor(keyId: string): Promise<CryptoKey> {
  return keyId === LEGACY_KEY_ID ? legacyKey() : dataKey(keyId);
}

// ---------------------------------------------------------------------------
// Formats

export type CiphertextFormat = { version: 1 | 2; keyId: string; flags: string };

type Parsed = CiphertextFormat & { body: string; header: string };

function parse(payload: string): Parsed {
  if (!payload.includes('.')) return { version: 1, keyId: LEGACY_KEY_ID, flags: '-', body: payload, header: '' };

  const parts = payload.split('.');
  // Named only when it looks like a version tag; anything else is not quoted.
  if (parts[0] !== 'v2') {
    throw new MalformedCiphertextError(
      /^v[0-9]{1,3}$/.test(parts[0]) ? `Unsupported encryption format "${parts[0]}".` : 'Unrecognised encrypted value.'
    );
  }
  if (parts.length !== 4) throw new MalformedCiphertextError('Encrypted value does not have four parts.');
  const [, keyId, flags, body] = parts;
  if (!KEY_ID.test(keyId)) throw new MalformedCiphertextError('Encrypted value has an invalid key id.');
  if (!FLAGS.test(flags)) throw new MalformedCiphertextError('Encrypted value has invalid flags.');
  if (flags !== '-') {
    for (const f of flags) {
      if (!KNOWN_FLAGS.has(f)) throw new MalformedCiphertextError(`Encrypted value uses unknown flag "${f}".`);
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

// ---------------------------------------------------------------------------
// The active data key: the one new writes use

/** How long a process trusts the active key id it last read, and the data key
 *  it opened for it. A change of active key is picked up within this, so
 *  anything that switches keys and then relies on the old one no longer being
 *  written (a re-encryption pass) must wait longer than this first. */
const ACTIVE_CACHE_MS = 60 * 1000;
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

async function writeCurrentMaster(fingerprint: string): Promise<void> {
  await redis().set(currentMasterKeyName(), JSON.stringify({ fingerprint }));
}

let _active: { fingerprint: string; id: string; at: number } | null = null;
let _activeLoad: { fingerprint: string; run: Promise<string | null> } | null = null;
let _fallback: { since: number; loggedAt: number; reason: string } | null = null;

/** Forget the cached active key id. For tests, and for code that has just
 *  changed it. */
export function forgetActiveKey(): void {
  _active = null;
  _activeLoad = null;
  _fallback = null;
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

      const all = ((await redis().hgetall(keysHashKey())) ?? {}) as Record<string, unknown>;
      const numbers = Object.keys(all)
        .filter((id) => KEY_ID.test(id) && id !== LEGACY_KEY_ID)
        .map((id) => Number(id.slice(1, id.indexOf('-'))));
      const raw = crypto.getRandomValues(new Uint8Array(32));
      const id = await dataKeyId(Math.max(0, ...numbers) + 1, raw);
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
    await dataKey(id);
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
 * The active data key for the re-encryption pass (lib/reencrypt.ts), created
 * if there is none yet. Unlike encrypt(), never falls back to k0: a pass that
 * moved values to k0 would be undoing itself.
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
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
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

// ---------------------------------------------------------------------------
// Public API

/**
 * Encrypts a plaintext string: v2 under the active data key when there is a
 * master, otherwise v1 under k0. Never fails because of the data key: if it
 * cannot be had (Redis, a master that cannot open it), falls back to k0,
 * which every deployment can read, and logs that (again every hour while it
 * lasts). Only getting the key falls back; a failure to encrypt is thrown.
 */
export async function encrypt(plaintext: string): Promise<string> {
  const now = Date.now();
  let v2: { id: string; key: CryptoKey } | null = null;
  let failed: unknown = null;
  try {
    const id = await activeKeyId(now);
    if (id) v2 = { id, key: await keyFor(id) };
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
 * key; this form is for writing under a specific key (tests, and later the
 * re-encryption pass and context-bound callers).
 */
export async function encryptV2(plaintext: string, keyId: string, context?: string): Promise<string> {
  if (!KEY_ID.test(keyId)) throw new Error(`Invalid key id "${keyId}".`);
  checkContext(context);
  return sealV2(plaintext, keyId, await keyFor(keyId), context);
}

/**
 * Decrypts a value in either format. A value bound to a context needs the
 * same context; one that is not bound ignores it, so callers can start
 * passing a context before every value carries one. (Once every value is
 * bound, a strict mode should refuse unbound values when a context is given;
 * until then a writer to the database could swap in an unbound value.)
 *
 * Throws UnknownKeyError, MasterKeyError, MalformedCiphertextError or
 * DecryptFailedError when it cannot.
 */
export async function decrypt(payload: string, context?: string): Promise<string> {
  const p = parse(payload);
  checkContext(context);
  const key = await keyFor(p.keyId);
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
