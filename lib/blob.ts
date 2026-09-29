// lib/blob.ts
//
// Encoding and size ceiling for the per-Item stores that hold one large JSON
// document each: cash transactions (lib/transactions.ts) and investment
// transactions (lib/invstore.ts). Shared so the two can't drift apart on how a
// blob is written or how big it may be. What each store does when a read or write
// fails stays with the store.

import { encrypt, decrypt } from './crypto';

// Max size of a stored (compressed + encrypted) blob. Upstash's free-plan
// *request-size* ceiling is 10 MB, and a get/set of an Item's blob is one
// request, so that (not the 100 MB max-record size) is the real wall. A margin is
// kept below it; writers REFUSE to persist a blob that would cross it.
//
// Measured in CHARACTERS: the value is base64 (see encodeJsonBlob) travelling as
// ASCII in a JSON body, so one character is one byte on the wire. Don't "correct"
// for base64 expansion: it already happened before the measurement, and dividing
// would cut the real ceiling to 6 MB for nothing.
//
// Overridable because the ceiling is a property of the Upstash plan, which
// differs, and tests use it to reach the refusal path.
//
// Validated rather than trusted: a negative or non-numeric value would put every
// Item over the ceiling at once, blocking every sync over an env var typo.
//
// Read when used, not at module load: two stores import it, and whichever loads
// first would otherwise fix the value before anything else (tests do) set it.
const DEFAULT_MAX_BLOB_CHARS = 8 * 1024 * 1024;
let resolved: { raw: string | undefined; value: number } | null = null;
export function maxBlobChars(): number {
  const raw = process.env.MAX_TXN_BLOB_CHARS;
  if (resolved && resolved.raw === raw) return resolved.value;
  let value = DEFAULT_MAX_BLOB_CHARS;
  if (raw) {
    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      console.warn(
        `blob: ignoring MAX_TXN_BLOB_CHARS=${JSON.stringify(raw)} (must be a positive number); using ${DEFAULT_MAX_BLOB_CHARS}`
      );
    } else {
      value = parsed;
    }
  }
  resolved = { raw, value };
  return value;
}
// Log a warning well before the wall, so a blob on its way there is visible
// while there is still time to do something about it.
export const blobWarnChars = () => maxBlobChars() * 0.6;

// Blobs are gzip-compressed before encryption: financial JSON is highly
// repetitive, so it shrinks ~10x, saving Upstash storage and bandwidth and
// keeping each blob under the request-size ceiling. Uses the Web
// CompressionStream API rather than node:zlib to stay runtime-portable, like
// lib/crypto.ts. Compression runs before encryption because ciphertext is
// high-entropy and wouldn't compress.

async function gzipString(input: string): Promise<Uint8Array> {
  const stream = new Response(input).body!.pipeThrough(new CompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function gunzipToString(data: Uint8Array): Promise<string> {
  // Pass the backing ArrayBuffer (a valid BodyInit) rather than the typed array
  // itself, which trips the strict BodyInit generic.
  const buf = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
  const stream = new Response(buf).body!.pipeThrough(new DecompressionStream('gzip'));
  return new Response(stream).text();
}

// encrypt/decrypt operate on UTF-8 strings, so the binary gzip output is
// base64-wrapped going in and unwrapped coming out (same technique as crypto.ts).
function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  bytes.forEach((b) => (binary += String.fromCharCode(b)));
  return btoa(binary);
}

function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

/** JSON, gzipped, base64-wrapped and encrypted: what a store writes. */
export async function encodeJsonBlob(value: unknown): Promise<string> {
  return encrypt(bytesToBase64(await gzipString(JSON.stringify(value))));
}

/** The reverse. Throws on anything it can't decrypt or parse; the caller
 *  decides what an unreadable blob means, and it must never mean "empty". */
export async function decodeJsonBlob<T>(blob: string): Promise<T> {
  const inner = await decrypt(blob);
  // Legacy blobs (written before compression) stored the JSON string directly.
  // base64-decoding real JSON throws (it starts with '{', not a base64 char),
  // so a failed unwrap means legacy: parse the decrypted string as-is.
  let json: string;
  try {
    json = await gunzipToString(base64ToBytes(inner));
  } catch {
    json = inner;
  }
  return JSON.parse(json) as T;
}
