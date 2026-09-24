// lib/crypto.ts
//
// Encrypts everything Nya stores (Plaid access tokens, balances, history,
// transactions) before it is written to Redis, so a leak of the database or
// a backup alone doesn't expose it.
//
// Uses the Web Crypto API (available in Bun, Node 19+, and Vercel's Edge
// runtime).
//
// ENVELOPE ENCRYPTION, SO KEYS CAN ROTATE WITHOUT NEW ENV VARS.
//
// Data is encrypted with DATA KEYS (k1, k2, ...). The app generates those
// itself and stores them in Redis (the "crypto:keys" hash), each one encrypted
// ("wrapped") with the MASTER KEY, which is the one secret in the environment
// (MASTER_KEY) and the one thing to keep a copy of. So:
//
//   - Rotating a data key is a command (scripts/keys.ts), with no Vercel
//     change: make a new key, start writing with it, re-encrypt.
//   - Rotating the master key only re-wraps the few data keys, never the data,
//     and runs locally with both masters in the shell. Each data key is stored
//     wrapped under every master it has been given, keyed by that master's
//     fingerprint, so a deployment still on the old master keeps working until
//     it is redeployed with the new one. There is never a second master in the
//     environment.
//   - Backups (lib/export.ts) carry the wrapped keys like any other Redis
//     value, so a backup plus the master key is complete on its own.
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
//       <flags> is "-" for none, or letters from a fixed set:
//         c  the value is also bound to a caller-supplied context (for example
//            the container it belongs to, once there are several), which must
//            be passed again to decrypt it.
//       Unknown flags are refused, never ignored, so a later flag can mean
//       something without older code misreading it.
//
// The two can never be confused: "." is not in the base64 alphabet, so a v1
// value never contains one, and anything that does is versioned.
//
// This file currently only READS v2; encrypt() still writes v1 with k0, so
// this change is fully revertible. Once anything has written v2 in
// production, this reader must never be reverted, or those values become
// unreadable.

import { redis, k } from './storage';

const LEGACY_KEY_ENV = 'PLAID_ENCRYPTION_KEY';
const MASTER_KEY_ENV = 'MASTER_KEY';
const LEGACY_KEY_ID = 'k0';
/** k0, k1, k2 ... with no leading zeros, so no two ids look alike. */
const KEY_ID = /^k(0|[1-9][0-9]{0,5})$/;
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

/** A stored value is not in any format this code can read. */
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

/** A data key exists but cannot be opened with this deployment's master key. */
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
// The master key and the data keys it wraps

/** How a data key is stored in the crypto:keys hash. */
export type StoredDataKey = {
  created_at: string;
  /** master fingerprint -> base64(iv + wrapped key) */
  wrapped: Record<string, string>;
};

export function keysHashKey(): string {
  return k('crypto:keys');
}

/** A short public name for a master key: the first 16 hex characters of
 *  SHA-256 over a label and the key. Identifies which master wrapped a data
 *  key without revealing anything usable about it. */
export async function masterFingerprint(raw: Uint8Array): Promise<string> {
  const label = utf8('nya master key fingerprint:');
  const input = new Uint8Array(label.length + raw.length);
  input.set(label, 0);
  input.set(raw, label.length);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', input));
  return [...digest.slice(0, 8)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export type MasterKey = { key: CryptoKey; fingerprint: string };

export async function importMasterKey(material: string, name = MASTER_KEY_ENV): Promise<MasterKey> {
  const raw = decodeKeyMaterial(material, name);
  return { key: await importAes(raw), fingerprint: await masterFingerprint(raw) };
}

/** Additional data for a wrapped key, so a wrapped key cannot be moved to a
 *  different id and opened there. */
const wrapAad = (keyId: string) => utf8(`nya data key ${keyId}`);

/** Wrap raw data-key bytes under a master key. */
export async function wrapDataKey(master: MasterKey, keyId: string, raw: Uint8Array): Promise<string> {
  return seal(master.key, raw, wrapAad(keyId));
}

/** Unwrap a stored data key with a master key, returning its raw bytes. Used
 *  by the rotation commands; decryption goes through dataKey() instead. */
export async function unwrapDataKey(master: MasterKey, keyId: string, stored: StoredDataKey): Promise<Uint8Array> {
  const wrapped = stored.wrapped?.[master.fingerprint];
  if (!wrapped) {
    throw new MasterKeyError(
      `Data key ${keyId} is not wrapped for master key ${master.fingerprint} (it has: ${Object.keys(stored.wrapped ?? {}).join(', ') || 'none'}).`
    );
  }
  let raw: Uint8Array;
  try {
    raw = await open(master.key, keyId, wrapped, wrapAad(keyId));
  } catch {
    throw new MasterKeyError(`Data key ${keyId} could not be unwrapped with master key ${master.fingerprint}.`);
  }
  if (raw.length !== 32) throw new MasterKeyError(`Data key ${keyId} is not 32 bytes.`);
  return raw;
}

export function parseStoredDataKey(keyId: string, json: unknown): StoredDataKey {
  let parsed: unknown = json;
  if (typeof json === 'string') {
    try {
      parsed = JSON.parse(json);
    } catch {
      throw new MasterKeyError(`Data key ${keyId} is stored in an unreadable form.`);
    }
  }
  const p = parsed as StoredDataKey;
  if (!p || typeof p !== 'object' || !p.wrapped || typeof p.wrapped !== 'object') {
    throw new MasterKeyError(`Data key ${keyId} is stored in an unreadable form.`);
  }
  return p;
}

// The master key, cached against its env string so a changed value (tests, or
// a future hot reload) is picked up rather than served stale.
let _master: { source: string; key: Promise<MasterKey> } | null = null;
function masterKey(): Promise<MasterKey> {
  const source = process.env[MASTER_KEY_ENV] ?? '';
  if (_master && _master.source === source) return _master.key;
  const key = source
    ? importMasterKey(source)
    : Promise.reject(new MasterKeyError(`${MASTER_KEY_ENV} is not set, so data keys cannot be opened.`));
  const entry = { source, key };
  // A failure is never kept: the next call tries again.
  key.catch(() => {
    if (_master === entry) _master = null;
  });
  _master = entry;
  return key;
}

/**
 * Data keys, opened on first use and kept for the life of the process.
 *
 * Per key and per master: a data key that cannot be opened (missing, damaged,
 * or not wrapped for this master) affects only the values encrypted with it.
 * Failures are not cached, so a Redis blip is retried on the next read.
 */
const _dataKeys = new Map<string, Promise<CryptoKey>>();
function dataKey(keyId: string): Promise<CryptoKey> {
  const result = (async () => {
    const master = await masterKey();
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
  })();
  return result;
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
  if (parts[0] !== 'v2') {
    throw new MalformedCiphertextError(`Unsupported encryption format "${parts[0].slice(0, 8)}".`);
  }
  if (parts.length !== 4) throw new MalformedCiphertextError('Encrypted value does not have four parts.');
  const [, keyId, flags, body] = parts;
  if (!KEY_ID.test(keyId)) throw new MalformedCiphertextError('Encrypted value has an invalid key id.');
  if (!FLAGS.test(flags)) throw new MalformedCiphertextError('Encrypted value has invalid flags.');
  if (flags !== '-') {
    for (const f of flags) {
      if (!KNOWN_FLAGS.has(f)) throw new MalformedCiphertextError(`Encrypted value uses unknown flag "${f}".`);
    }
  }
  return { version: 2, keyId, flags, body, header: `v2.${keyId}.${flags}` };
}

/** The additional data for a v2 value: its header, plus the context when the
 *  value is bound to one. The NUL separator cannot appear in a header. */
function v2Aad(header: string, context: string | undefined): Uint8Array {
  return utf8(context === undefined ? header : `${header}\0${context}`);
}

// ---------------------------------------------------------------------------
// Public API

/** Encrypts a plaintext string in the v1 format with k0. */
export async function encrypt(plaintext: string): Promise<string> {
  return seal(await legacyKey(), utf8(plaintext));
}

/**
 * Encrypts in the v2 format with the named key, optionally bound to a
 * context. Not yet used for storage: a later change switches encrypt() to it
 * once every deployment can read v2.
 */
export async function encryptV2(plaintext: string, keyId: string, context?: string): Promise<string> {
  if (!KEY_ID.test(keyId)) throw new Error(`Invalid key id "${keyId}".`);
  const header = `v2.${keyId}.${context === undefined ? '-' : 'c'}`;
  const body = await seal(await keyFor(keyId), utf8(plaintext), v2Aad(header, context));
  return `${header}.${body}`;
}

/**
 * Decrypts a value in either format. A value bound to a context needs the
 * same context; one that is not bound ignores it, so callers can start
 * passing a context before every value carries one.
 *
 * Throws UnknownKeyError, MasterKeyError, MalformedCiphertextError or
 * DecryptFailedError when it cannot.
 */
export async function decrypt(payload: string, context?: string): Promise<string> {
  const p = parse(payload);
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
