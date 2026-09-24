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
// Data is encrypted with DATA KEYS. The app generates those itself
// (scripts/keys.ts) and stores them in Redis ("crypto:keys"), each encrypted
// ("wrapped") by the MASTER KEY, the one secret in the environment
// (MASTER_KEY) and the one thing to keep a copy of. So:
//
//   - Rotating a data key is a command, with no Vercel change.
//   - Rotating the master key re-wraps only the data keys, never the data, and
//     runs locally. Each data key is stored wrapped under every master it has
//     been given, keyed by that master's fingerprint, so a deployment still on
//     the old master keeps working until it is redeployed. There is never a
//     second master in the environment.
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
// DEPLOYMENTS RECORD WHICH MASTER THEY RUN. Each process notes its master
// key's fingerprint and the time in "crypto:masters-seen" (at most every few
// minutes). scripts/keys.ts relies on it: it will not create a key for a master
// no deployment is running, and will not drop an old master while a deployment
// still reports it. A fingerprint reveals nothing usable about the key.
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
// This file currently only READS v2; encrypt() still writes v1 with k0, so
// this change is fully revertible. Once anything has written v2 in
// production, this reader must never be reverted, or those values become
// unreadable.

import { redis, kEnv } from './storage';

const LEGACY_KEY_ENV = 'PLAID_ENCRYPTION_KEY';
const MASTER_KEY_ENV = 'MASTER_KEY';
const LEGACY_KEY_ID = 'k0';
/** "k0", or "k<n>-<8 hex>" with no leading zero in n. */
const KEY_ID = /^(k0|k[1-9][0-9]{0,5}-[0-9a-f]{8})$/;
const FLAGS = /^(-|[a-z]{1,8})$/;
const KNOWN_FLAGS = new Set(['c']);
/** How often a process re-records the master it runs. */
const ATTEST_EVERY_MS = 5 * 60 * 1000;

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

export function mastersSeenKey(): string {
  return kEnv('crypto:masters-seen');
}

let _lastAttest: { fingerprint: string; at: number } | null = null;

/**
 * Record, at most every few minutes, that this process runs the master key it
 * has. Best effort: a failure here must never break a request, and nothing
 * but scripts/keys.ts's safety checks reads it. Does nothing without a master.
 */
export async function attestMasterKey(now: number = Date.now()): Promise<void> {
  try {
    if (!process.env[MASTER_KEY_ENV]) return;
    const { fingerprint } = await masterKey();
    // Skipped only when the last record is recent AND not in the future: a
    // clock that went backwards counts as due, rather than silencing reports.
    const since = _lastAttest ? now - _lastAttest.at : Infinity;
    if (_lastAttest && _lastAttest.fingerprint === fingerprint && since >= 0 && since < ATTEST_EVERY_MS) return;
    _lastAttest = { fingerprint, at: now };
    await redis().hset(mastersSeenKey(), { [fingerprint]: new Date(now).toISOString() });
  } catch {
    // Best effort, by design.
  }
}

// ---------------------------------------------------------------------------
// Data keys

/** How a data key is stored in the crypto:keys hash. */
export type StoredDataKey = {
  created_at: string;
  /** master fingerprint -> wrapped key */
  wrapped: Record<string, string>;
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
  void attestMasterKey();
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
  checkContext(context);
  const header = `v2.${keyId}.${context === undefined ? '-' : 'c'}`;
  const body = await seal(await keyFor(keyId), utf8(plaintext), v2Aad(header, context));
  return `${header}.${body}`;
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
