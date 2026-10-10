// lib/age/age.ts
//
// The age file format, version 1 (https://age-encryption.org/v1), for a
// download of my data protected with a passphrase (lib/protected-download.ts),
// and for opening one in the browser (app/open-download). Pure, safe to import
// from client code: HKDF and HMAC are Web Crypto's, ChaCha20-Poly1305 and
// scrypt are this folder's, and the slow key derivation is passed in, so the
// server can use node:crypto's own.
//
// WHY AGE. It is an existing, documented standard for exactly this: a file
// encrypted with a passphrase, opened by a free tool on every platform (the
// `age` command, or its other implementations), with no part of Nya needed.
// It is built only from standard primitives: scrypt, HKDF-SHA256,
// HMAC-SHA256 and ChaCha20-Poly1305. test/age.test.ts holds this code to the
// age project's own test vectors, and to the age command where it is
// installed.
//
// THE LAYOUT. A text header, then the payload:
//
//   age-encryption.org/v1
//   -> scrypt <salt, 16 bytes in base64> <work factor, log2 N>
//   <the file key, sealed: 32 bytes in base64>
//   --- <the header's MAC: 32 bytes in base64>
//   <16-byte nonce><the payload's chunks>
//
// Base64 is the standard alphabet without padding. The file key is 16 random
// bytes. The passphrase opens it: scrypt(passphrase, salt =
// "age-encryption.org/v1/scrypt" + the salt, N = 2^work factor, r = 8, p = 1)
// is a 32-byte key that seals it with ChaCha20-Poly1305 under a nonce of
// zeros. The MAC is HMAC-SHA256 of the header up to and including "---",
// keyed with HKDF-SHA256(the file key, no salt, "header"), so a header that
// was changed is caught.
//
// STREAMED, AND WHOLE OR NOT AT ALL. The payload is cut in chunks of 64 KiB,
// each sealed with ChaCha20-Poly1305 under the payload key (HKDF-SHA256 of
// the file key, salted with the nonce, "payload") and a nonce that is the
// chunk's number (11 bytes, big-endian) and a last byte, 1 on the last chunk
// and 0 on every other (age's STREAM). So chunks can be written as the file
// is made and read as it arrives, and a file that was cut short (no chunk
// marked last), had chunks swapped or reordered (a chunk opened under another
// number), or had anything added after its end, fails to open, as does any
// chunk changed. Only the last chunk is shorter than 64 KiB, and it is empty
// only when the whole payload is.

import { open, seal } from './chacha20poly1305';

export const INTRO = 'age-encryption.org/v1';
/** The bytes of plaintext in every chunk but the last. */
export const CHUNK_SIZE = 64 * 1024;
export const TAG_SIZE = 16;
export const NONCE_SIZE = 16;
export const FILE_KEY_SIZE = 16;
const SALT_SIZE = 16;
const SCRYPT_LABEL = 'age-encryption.org/v1/scrypt';
/** The work factor Nya writes: age's own default for a passphrase, about a
 *  second of a computer's time and 256 MB of memory for each guess. */
export const WORK_FACTOR = 18;
/** The largest work factor age's own tool opens (its test vectors refuse 23). */
export const MAX_WORK_FACTOR = 22;
/** How long a header may be. A passphrase file's is about 150 bytes. */
const MAX_HEADER = 64 * 1024;

/** The slow key derivation: scrypt(password, salt, N, r, p, dkLen). */
export type ScryptFn = (password: Uint8Array, salt: Uint8Array, N: number, r: number, p: number, dkLen: number) => Promise<Uint8Array>;

/**
 * Why a file didn't open, in the words of age's test vectors where they have
 * them:
 *   - `not-age`: it isn't an age file at all;
 *   - `unsupported`: an age file in a form this code doesn't open (another
 *     version, the text "armor", a work factor past the caller's limit);
 *   - `header`: its header is damaged ("header failure");
 *   - `passphrase`: the passphrase doesn't open it, or it was locked to a key
 *     rather than a passphrase ("no match");
 *   - `mac`: its header was changed after it was made ("HMAC failure");
 *   - `payload`: its contents are damaged, cut short, reordered, or have
 *     something after their end ("payload failure").
 */
export type AgeFailure = 'not-age' | 'unsupported' | 'header' | 'passphrase' | 'mac' | 'payload';

export class AgeError extends Error {
  constructor(
    readonly kind: AgeFailure,
    message: string
  ) {
    super(message);
    this.name = 'AgeError';
  }
}

const fail = (kind: AgeFailure, message: string): never => {
  throw new AgeError(kind, message);
};

const utf8 = (s: string) => new TextEncoder().encode(s);

// ---- Base64, as age writes it: the standard alphabet, no padding ----

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const VALUES = new Int16Array(128).fill(-1);
for (let i = 0; i < ALPHABET.length; i++) VALUES[ALPHABET.charCodeAt(i)] = i;

export function base64(bytes: Uint8Array): string {
  let out = '';
  let i = 0;
  for (; i + 3 <= bytes.length; i += 3) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    out += ALPHABET[n >>> 18] + ALPHABET[(n >>> 12) & 63] + ALPHABET[(n >>> 6) & 63] + ALPHABET[n & 63];
  }
  const rest = bytes.length - i;
  if (rest === 1) {
    const n = bytes[i] << 16;
    out += ALPHABET[n >>> 18] + ALPHABET[(n >>> 12) & 63];
  } else if (rest === 2) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8);
    out += ALPHABET[n >>> 18] + ALPHABET[(n >>> 12) & 63] + ALPHABET[(n >>> 6) & 63];
  }
  return out;
}

/** The bytes of unpadded base64, or null when it isn't that: a character
 *  outside the alphabet (padding among them), a length no bytes have, or a
 *  non-canonical last character (bits set past the last byte). */
export function unbase64(text: string): Uint8Array<ArrayBuffer> | null {
  if (text.length % 4 === 1) return null;
  const out = new Uint8Array(Math.floor((text.length * 3) / 4));
  let o = 0;
  let acc = 0;
  let bits = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    const v = c < 128 ? VALUES[c] : -1;
    if (v < 0) return null;
    acc = (acc << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[o++] = (acc >>> bits) & 0xff;
    }
  }
  // Canonical: whatever bits are left over are zero.
  if ((acc & ((1 << bits) - 1)) !== 0) return null;
  return out;
}

// ---- HKDF and HMAC, from Web Crypto ----

async function hkdf(ikm: Uint8Array, salt: Uint8Array, info: string): Promise<Uint8Array<ArrayBuffer>> {
  const key = await crypto.subtle.importKey('raw', new Uint8Array(ikm), 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(salt), info: utf8(info) }, key, 256));
}

async function hmac(key: Uint8Array, data: Uint8Array): Promise<Uint8Array<ArrayBuffer>> {
  const k = await crypto.subtle.importKey('raw', new Uint8Array(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', k, new Uint8Array(data)));
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

// ---- Writing ----

const ZERO_NONCE = new Uint8Array(12);

/** The scrypt stanza's key, from the passphrase and the stanza's salt. */
async function wrapKey(passphrase: string, salt: Uint8Array, workFactor: number, kdf: ScryptFn): Promise<Uint8Array> {
  const labelled = new Uint8Array(SCRYPT_LABEL.length + salt.length);
  labelled.set(utf8(SCRYPT_LABEL), 0);
  labelled.set(salt, SCRYPT_LABEL.length);
  return kdf(utf8(passphrase), labelled, 2 ** workFactor, 8, 1, 32);
}

/**
 * The header of a file locked with a passphrase (see the header of this
 * file), as bytes, MAC and final newline included. `salt` is 16 random bytes.
 */
export async function passphraseHeader(
  fileKey: Uint8Array,
  passphrase: string,
  opts: { salt: Uint8Array; workFactor?: number; scrypt: ScryptFn }
): Promise<Uint8Array<ArrayBuffer>> {
  const workFactor = opts.workFactor ?? WORK_FACTOR;
  if (fileKey.length !== FILE_KEY_SIZE || opts.salt.length !== SALT_SIZE) throw new Error('age: a file key and a salt are 16 bytes');
  if (!Number.isInteger(workFactor) || workFactor < 1 || workFactor > MAX_WORK_FACTOR) throw new Error('age: the work factor is out of range');
  const body = seal(await wrapKey(passphrase, opts.salt, workFactor, opts.scrypt), ZERO_NONCE, fileKey);
  // 32 bytes are 43 characters: one body line, shorter than 64 as the last must be.
  const text = `${INTRO}\n-> scrypt ${base64(opts.salt)} ${workFactor}\n${base64(body)}\n---`;
  const mac = await hmac(await hkdf(fileKey, new Uint8Array(0), 'header'), utf8(text));
  return utf8(`${text} ${base64(mac)}\n`);
}

/** The key the payload's chunks are sealed with. */
export async function payloadKey(fileKey: Uint8Array, nonce: Uint8Array): Promise<Uint8Array<ArrayBuffer>> {
  if (nonce.length !== NONCE_SIZE) throw new Error('age: the payload nonce is 16 bytes');
  return hkdf(fileKey, nonce, 'payload');
}

/** A chunk's nonce: its number, big-endian in 11 bytes, then 1 if it is the
 *  last chunk and 0 if not. */
function chunkNonce(counter: number, last: boolean): Uint8Array {
  const nonce = new Uint8Array(12);
  let n = counter;
  for (let i = 10; i >= 0 && n > 0; i--) {
    nonce[i] = n % 256;
    n = Math.floor(n / 256);
  }
  nonce[11] = last ? 1 : 0;
  return nonce;
}

/**
 * The payload's chunks (after its nonce), sealed one by one as the plaintext
 * arrives, in pieces of any size. A full chunk is held until more plaintext
 * follows it, so the last one is known when it is sealed; plaintext that ends
 * on a chunk's edge ends with that full chunk, marked last, and an empty
 * plaintext is one empty chunk.
 */
export function* sealPayload(key: Uint8Array, plaintext: Iterable<Uint8Array>): Generator<Uint8Array<ArrayBuffer>> {
  const buffer = new Uint8Array(CHUNK_SIZE);
  let fill = 0;
  let counter = 0;
  for (const piece of plaintext) {
    let at = 0;
    while (at < piece.length) {
      if (fill === CHUNK_SIZE) {
        yield seal(key, chunkNonce(counter++, false), buffer);
        fill = 0;
      }
      const n = Math.min(CHUNK_SIZE - fill, piece.length - at);
      buffer.set(piece.subarray(at, at + n), fill);
      fill += n;
      at += n;
    }
  }
  yield seal(key, chunkNonce(counter, true), buffer.subarray(0, fill));
}

/** How many bytes an encrypted file is: its header, the nonce, the plaintext
 *  and a tag for each chunk (at least one). */
export function encryptedSize(headerBytes: number, plaintextBytes: number): number {
  return headerBytes + NONCE_SIZE + plaintextBytes + TAG_SIZE * Math.max(1, Math.ceil(plaintextBytes / CHUNK_SIZE));
}

// ---- Reading ----

export type Stanza = { type: string; args: string[]; body: Uint8Array };

export type Header = {
  stanzas: Stanza[];
  /** The bytes the MAC covers: the header up to and including "---". */
  signed: Uint8Array;
  mac: Uint8Array;
  /** Where the payload (its nonce first) starts. */
  end: number;
};

/** A header line's characters: printable ASCII only (no CR, no tab). */
const isLine = (s: string) => /^[\x20-\x7e]*$/.test(s);
/** A stanza argument: one or more visible ASCII characters. */
const isArg = (s: string) => /^[\x21-\x7e]+$/.test(s);
const BASE64_LINE = /^[A-Za-z0-9+/]*$/;

/**
 * The header of an age file, parsed as the format requires: the version
 * line, one or more stanzas (each "-> " and its arguments, then a body in
 * base64 lines of 64 characters ending with a shorter one, which may be
 * empty), and the MAC line. Anything else is `header`; a file that isn't age
 * at all is `not-age`, and one in another version or in the text armor is
 * `unsupported`.
 */
export function parseHeader(file: Uint8Array): Header {
  let pos = 0;
  // Never searched past MAX_HEADER: a header is never longer.
  const head = file.subarray(0, Math.min(file.length, MAX_HEADER));
  const line = (): string => {
    const nl = head.indexOf(0x0a, pos);
    if (nl < 0) fail('header', 'The file ends inside its header.');
    let s = '';
    for (let i = pos; i < nl; i++) s += String.fromCharCode(file[i]);
    pos = nl + 1;
    if (!isLine(s)) fail('header', 'The header holds a character it can’t.');
    return s;
  };
  const start = new TextDecoder('latin1').decode(file.subarray(0, Math.min(file.length, 64)));
  if (!start.startsWith(`${INTRO}\n`)) {
    if (start.startsWith(INTRO)) fail('header', 'The header’s first line is damaged.');
    if (start.startsWith('age-encryption.org/')) fail('unsupported', 'This file is in a version of the age format that isn’t opened here.');
    if (start.startsWith('-----BEGIN AGE ENCRYPTED FILE-----')) fail('unsupported', 'This file is in age’s text form (armored), which isn’t opened here.');
    fail('not-age', 'This isn’t an age file.');
  }
  line();
  const stanzas: Stanza[] = [];
  for (;;) {
    const at = pos;
    const l = line();
    if (l.startsWith('---')) {
      // "--- " and the MAC, 32 bytes, nothing else.
      if (!l.startsWith('--- ')) fail('header', 'The header’s last line is damaged.');
      const mac = unbase64(l.slice(4));
      if (!mac || mac.length !== 32 || l.length !== 4 + 43) fail('header', 'The header’s last line is damaged.');
      if (stanzas.length === 0) fail('header', 'The header names no way to open the file.');
      return { stanzas, signed: file.slice(0, at + 3), mac: mac!, end: pos };
    }
    if (!l.startsWith('-> ')) fail('header', 'The header holds a line it can’t.');
    const args = l.slice(3).split(' ');
    if (!args.every(isArg)) fail('header', 'A line of the header is damaged.');
    let text = '';
    for (;;) {
      const b = line();
      if (b.length > 64 || !BASE64_LINE.test(b)) fail('header', 'A line of the header is damaged.');
      text += b;
      if (b.length < 64) break;
    }
    const body = unbase64(text);
    if (!body) fail('header', 'A line of the header is damaged.');
    stanzas.push({ type: args[0], args: args.slice(1), body: body! });
  }
}

/** The file key, from the header's scrypt stanza and the passphrase. */
async function unwrapWithPassphrase(header: Header, passphrase: string, kdf: ScryptFn, maxWorkFactor: number): Promise<Uint8Array> {
  const scrypts = header.stanzas.filter((s) => s.type === 'scrypt');
  if (scrypts.length === 0) {
    return fail('passphrase', 'This file wasn’t protected with a passphrase: it is locked to an age key, so open it with age and that key.');
  }
  // A passphrase file has one stanza, the scrypt one, and nothing beside it.
  if (header.stanzas.length !== 1) fail('header', 'The header is damaged: a passphrase file has nothing beside its passphrase.');
  const [stanza] = scrypts;
  if (stanza.args.length !== 2) fail('header', 'The header’s passphrase line is damaged.');
  const salt = unbase64(stanza.args[0]);
  if (!salt || salt.length !== SALT_SIZE) fail('header', 'The header’s passphrase line is damaged.');
  const factor = stanza.args[1];
  if (!/^[1-9][0-9]?$/.test(factor) || Number(factor) > MAX_WORK_FACTOR) fail('header', 'The header’s passphrase line is damaged.');
  if (stanza.body.length !== 32) fail('header', 'The header’s passphrase line is damaged.');
  const workFactor = Number(factor);
  if (workFactor > maxWorkFactor) {
    fail('unsupported', 'This file was protected with a slower setting than this page can manage. Open it with the age app instead.');
  }
  const fileKey = open(await wrapKey(passphrase, salt!, workFactor, kdf), ZERO_NONCE, stanza.body);
  if (!fileKey) return fail('passphrase', 'That passphrase doesn’t open this file.');
  return fileKey;
}

/** Throws `mac` unless the header's MAC is the file key's. */
async function checkMac(header: Header, fileKey: Uint8Array): Promise<void> {
  const mac = await hmac(await hkdf(fileKey, new Uint8Array(0), 'header'), header.signed);
  if (!sameBytes(mac, header.mac)) fail('mac', 'This file’s header was changed after it was made, so it can’t be trusted.');
}

/**
 * The payload's plaintext, a verified chunk at a time, as age's own reader
 * releases it: a chunk only once its tag checks out under its number. A full
 * chunk is tried as one more is to come, then as the last; a short one only
 * as the last. Throws `payload` at the first chunk that doesn't open, at an
 * end with no last chunk, at anything after the last chunk, and at an empty
 * last chunk after others. `from` is where the chunks start (after the
 * nonce).
 */
export function* openPayload(file: Uint8Array, from: number, key: Uint8Array): Generator<Uint8Array<ArrayBuffer>> {
  let pos = from;
  for (let counter = 0; ; counter++) {
    const left = file.length - pos;
    if (left === 0) fail('payload', 'The file is cut short: it ends before its last part.');
    const take = Math.min(left, CHUNK_SIZE + TAG_SIZE);
    const sealed = file.subarray(pos, pos + take);
    pos += take;
    let last = take < CHUNK_SIZE + TAG_SIZE;
    let plain = last ? null : open(key, chunkNonce(counter, false), sealed);
    if (!plain) {
      plain = open(key, chunkNonce(counter, true), sealed);
      last = true;
    }
    if (!plain) return fail('payload', 'The file is damaged: part of it doesn’t open.');
    if (last && plain.length === 0 && counter > 0) fail('payload', 'The file is damaged: it ends with an empty part.');
    yield plain;
    if (last) {
      if (pos !== file.length) fail('payload', 'The file is damaged: something was added after its end.');
      return;
    }
  }
}

/** The payload's nonce and key, from the file key: `header` if the nonce
 *  isn't all there (age's test vectors count it as the header's). */
async function payloadStart(file: Uint8Array, header: Header, fileKey: Uint8Array): Promise<{ from: number; key: Uint8Array }> {
  if (file.length - header.end < NONCE_SIZE) fail('header', 'The file ends before its contents start.');
  const nonce = file.subarray(header.end, header.end + NONCE_SIZE);
  return { from: header.end + NONCE_SIZE, key: await payloadKey(fileKey, nonce) };
}

export type OpenOptions = {
  /** The slow key derivation: lib/age/scrypt.ts's in a browser. */
  scrypt: ScryptFn;
  /** The largest work factor tried: a browser can't spare the memory for
   *  every one age allows. MAX_WORK_FACTOR when not given. */
  maxWorkFactor?: number;
  /** How far the payload is, 0 to 1, as chunks open. */
  onPayloadProgress?: (done: number) => void;
};

/**
 * The plaintext of a file locked with a passphrase, as its chunks, once every
 * chunk has opened: never part of one. Throws AgeError saying why it didn't
 * open. Lets the page draw between chunks.
 */
export async function decryptWithPassphrase(file: Uint8Array, passphrase: string, opts: OpenOptions): Promise<Uint8Array[]> {
  const header = parseHeader(file);
  const fileKey = await unwrapWithPassphrase(header, passphrase, opts.scrypt, opts.maxWorkFactor ?? MAX_WORK_FACTOR);
  await checkMac(header, fileKey);
  const { from, key } = await payloadStart(file, header, fileKey);
  const parts: Uint8Array[] = [];
  let at = from;
  for (const part of openPayload(file, from, key)) {
    parts.push(part);
    at += part.length + TAG_SIZE;
    // About every 4 MB, a moment for the page to draw.
    if (parts.length % 64 === 0) {
      opts.onPayloadProgress?.((at - from) / Math.max(1, file.length - from));
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
  }
  opts.onPayloadProgress?.(1);
  return parts;
}

/**
 * For tests against age's test vectors, which give the file key: the header
 * parsed and its MAC checked with that key, then the payload's chunks as they
 * open (openPayload), whatever opened before a failure included.
 */
export async function openWithFileKey(file: Uint8Array, fileKey: Uint8Array): Promise<Generator<Uint8Array<ArrayBuffer>>> {
  const header = parseHeader(file);
  await checkMac(header, fileKey);
  const { from, key } = await payloadStart(file, header, fileKey);
  return openPayload(file, from, key);
}
