// lib/crypto.ts
//
// Encrypts everything Nya stores (Plaid access tokens, balances, history,
// transactions) before it is written to Redis, so a leak of the database or
// its credentials alone doesn't expose it -- the encryption key is required
// too.
//
// Uses the Web Crypto API (available in Bun, Node 19+, and Vercel's Edge
// runtime) so this file works unmodified across all of them.
//
// TWO FORMATS, SO THE KEY CAN BE ROTATED.
//
//   v1: <base64(iv + ciphertext)>
//       The original format. Always encrypted with PLAID_ENCRYPTION_KEY, and
//       carries no record of that, which is why the key could never change:
//       every stored value would become unreadable at once.
//
//   v2: v2.<keyid>.<base64(iv + ciphertext)>
//       Names the key that encrypted it, so several keys can be in use at once
//       and values can be moved from an old key to a new one gradually. The
//       "v2.<keyid>" header is bound in as AES-GCM additional data, so it
//       cannot be edited without decryption failing.
//
// The two can never be confused: "." is not in the base64 alphabet, so a v1
// value never contains one, and anything that does is a versioned value.
//
// KEYS.
//
//   k0  = PLAID_ENCRYPTION_KEY, permanently. Every v1 value was written with
//         it, so it must stay available until every value has been rewritten
//         under a newer key AND that has been proven by an export/restore.
//   k1+ = ENCRYPTION_KEYS, as "k1:<base64>,k2:<base64>" (neither ":" nor ","
//         is in base64). Generate each with `openssl rand -base64 32`.
//
// ROTATION IS ALWAYS TWO DEPLOYS. Add a key to ENCRYPTION_KEYS and deploy, so
// every running instance can READ it; only then start WRITING with it. A key
// that is written before every instance can read it leaves values some
// instances cannot decrypt.
//
// This file currently only READS v2; encrypt() still writes v1 with k0. That
// makes this change fully revertible: nothing in v2 exists until a later
// change starts writing it. Once that later change has run in production,
// this reader must never be reverted, or every v2 value becomes unreadable.

const KEY_ENV_VAR = 'PLAID_ENCRYPTION_KEY';
const KEYRING_ENV_VAR = 'ENCRYPTION_KEYS';
const LEGACY_KEY_ID = 'k0';
const KEY_ID = /^k[0-9]{1,6}$/;

/** A stored value names a key this deployment does not have. Distinct so a
 *  caller can tell "add the key back" from "the data is damaged". Never
 *  answered by trying another key: that would hide a missing key until the
 *  day it mattered. */
export class UnknownKeyError extends Error {
  constructor(readonly keyId: string) {
    super(`Encrypted with key "${keyId}", which is not configured (${KEYRING_ENV_VAR}).`);
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

/** The key is right but authentication failed: the value was altered or
 *  truncated, or its header was edited. */
export class DecryptFailedError extends Error {
  constructor(readonly keyId: string) {
    super(`Decryption with key "${keyId}" failed: the value is damaged or was altered.`);
    this.name = 'DecryptFailedError';
  }
}

function decodeKey(material: string, name: string): Uint8Array {
  let raw: Uint8Array;
  try {
    raw = Uint8Array.from(atob(material), (c) => c.charCodeAt(0));
  } catch {
    throw new Error(`${name} is not valid base64. Generate with: openssl rand -base64 32`);
  }
  if (raw.length !== 32) {
    throw new Error(`${name} must decode to exactly 32 bytes (AES-256). Generate with: openssl rand -base64 32`);
  }
  return raw;
}

function importRaw(raw: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', raw as BufferSource, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

// k0 never changes within a process, so import it once and reuse it --
// history/account reads decrypt hundreds of values per request, and
// re-importing for each one is pure waste. A failed import isn't cached, so
// a missing env var stays a per-call error rather than a poisoned singleton.
let _legacyKey: Promise<CryptoKey> | null = null;
function legacyKey(): Promise<CryptoKey> {
  if (!_legacyKey) {
    _legacyKey = (async () => {
      const material = process.env[KEY_ENV_VAR];
      if (!material) {
        throw new Error(`${KEY_ENV_VAR} is not set. Generate one with: openssl rand -base64 32`);
      }
      return importRaw(decodeKey(material, KEY_ENV_VAR));
    })().catch((err) => {
      _legacyKey = null;
      throw err;
    });
  }
  return _legacyKey;
}

/**
 * The additional keys, parsed from ENCRYPTION_KEYS.
 *
 * Only v2 reads consult this, so a typo in ENCRYPTION_KEYS can never make a v1
 * value unreadable. Cached against the raw env string, so a changed value (a
 * test, or a future hot reload) is picked up rather than served stale.
 */
let _ring: { source: string; keys: Map<string, Promise<CryptoKey>> } | null = null;
function keyring(): Map<string, Promise<CryptoKey>> {
  const source = process.env[KEYRING_ENV_VAR] ?? '';
  if (_ring && _ring.source === source) return _ring.keys;

  const keys = new Map<string, Promise<CryptoKey>>();
  for (const entry of source.split(',').map((s) => s.trim()).filter(Boolean)) {
    const sep = entry.indexOf(':');
    const id = sep === -1 ? '' : entry.slice(0, sep);
    if (!KEY_ID.test(id)) {
      throw new Error(`${KEYRING_ENV_VAR} has an entry without a valid key id; use "k1:<base64>,k2:<base64>".`);
    }
    if (id === LEGACY_KEY_ID) {
      throw new Error(`${KEYRING_ENV_VAR} may not define ${LEGACY_KEY_ID}; that is always ${KEY_ENV_VAR}.`);
    }
    if (keys.has(id)) throw new Error(`${KEYRING_ENV_VAR} defines ${id} twice.`);
    // Decoded now so a bad key fails loudly on the first read, not later.
    keys.set(id, importRaw(decodeKey(entry.slice(sep + 1), `${KEYRING_ENV_VAR} ${id}`)));
  }
  _ring = { source, keys };
  return keys;
}

function keyFor(id: string): Promise<CryptoKey> {
  if (id === LEGACY_KEY_ID) return legacyKey();
  const key = keyring().get(id);
  if (!key) throw new UnknownKeyError(id);
  return key;
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

async function seal(key: CryptoKey, plaintext: string, aad?: Uint8Array): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12)); // 96-bit IV, standard for GCM
  const params: AesGcmParams = aad ? { name: 'AES-GCM', iv, additionalData: aad as BufferSource } : { name: 'AES-GCM', iv };
  const ciphertext = await crypto.subtle.encrypt(params, key, new TextEncoder().encode(plaintext));
  const combined = new Uint8Array(iv.length + ciphertext.byteLength);
  combined.set(iv, 0);
  combined.set(new Uint8Array(ciphertext), iv.length);
  return toBase64(combined);
}

async function open(key: CryptoKey, keyId: string, payload: string, aad?: Uint8Array): Promise<string> {
  const combined = fromBase64(payload);
  // 12-byte IV plus GCM's 16-byte tag is the smallest possible ciphertext.
  if (combined.length < 28) throw new MalformedCiphertextError('Encrypted value is too short.');
  const iv = combined.slice(0, 12);
  const params: AesGcmParams = aad ? { name: 'AES-GCM', iv, additionalData: aad as BufferSource } : { name: 'AES-GCM', iv };
  try {
    const plain = await crypto.subtle.decrypt(params, key, combined.slice(12));
    return new TextDecoder().decode(plain);
  } catch {
    throw new DecryptFailedError(keyId);
  }
}

/** Parse a stored value into the key that encrypted it and how to open it. */
function parse(payload: string): { version: 1 | 2; keyId: string; body: string; header?: string } {
  if (!payload.includes('.')) return { version: 1, keyId: LEGACY_KEY_ID, body: payload };

  const first = payload.indexOf('.');
  const second = payload.indexOf('.', first + 1);
  const version = payload.slice(0, first);
  if (version !== 'v2') {
    throw new MalformedCiphertextError(`Unsupported encryption format "${version.slice(0, 8)}".`);
  }
  if (second === -1) throw new MalformedCiphertextError('Encrypted value has no key id.');
  const keyId = payload.slice(first + 1, second);
  if (!KEY_ID.test(keyId)) throw new MalformedCiphertextError('Encrypted value has an invalid key id.');
  return { version: 2, keyId, body: payload.slice(second + 1), header: payload.slice(0, second) };
}

/** Encrypts a plaintext string in the v1 format with k0. */
export async function encrypt(plaintext: string): Promise<string> {
  return seal(await legacyKey(), plaintext);
}

/**
 * Encrypts in the v2 format with the named key. Not yet used for storage: a
 * later change switches encrypt() to it once every deployment can read v2.
 */
export async function encryptV2(plaintext: string, keyId: string): Promise<string> {
  if (!KEY_ID.test(keyId)) throw new Error(`Invalid key id "${keyId}".`);
  const header = `v2.${keyId}`;
  const body = await seal(await keyFor(keyId), plaintext, new TextEncoder().encode(header));
  return `${header}.${body}`;
}

/** Decrypts a value in either format. Throws UnknownKeyError,
 *  MalformedCiphertextError or DecryptFailedError when it cannot. */
export async function decrypt(payload: string): Promise<string> {
  const { version, keyId, body, header } = parse(payload);
  const key = await keyFor(keyId);
  return version === 1 ? open(key, keyId, body) : open(key, keyId, body, new TextEncoder().encode(header));
}

/** Which key a stored value was encrypted with, without decrypting it. Lets a
 *  re-encryption pass find what still needs moving to a newer key. */
export function keyIdOf(payload: string): string {
  return parse(payload).keyId;
}
