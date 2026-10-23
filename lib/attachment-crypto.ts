// lib/attachment-crypto.ts
//
// How a receipt or document attached to a transaction (#47, lib/attachments.ts)
// is sealed before it goes to the file store (lib/attachment-objects.ts), and
// what is checked of its bytes before that. Pure but for the Web Crypto calls
// and the wrapping of a file's key, which lib/crypto.ts does.
//
// A KEY PER FILE. Each file gets 32 random bytes of its own, made by the server
// when the upload starts. Each part of the file (PART_BYTES each but the last,
// so a part fits Vercel's 4.5 MB request body, sent one request at a time),
// and its thumbnail, is stored as
//
//   0x01 | nonce (12 random bytes) | AES-256-GCM ciphertext, its tag included
//
// with additional data naming the format, the container, the attachment, the
// part and how many parts there are ("nya-attachment.1.<container>.<id>.
// <part>.<parts>", the thumbnail's part "t"). So a part can't be swapped
// between files or accounts, put in another place in its file, or left out
// unnoticed (every part names the count). Nonces are random: a key seals at
// most six objects, and a retried part is sealed afresh.
//
// THE FILE'S KEY is wrapped under the container's own data key, bound to the
// context "attachment:<container>:<id>" (lib/crypto.ts encryptOwn, opened only
// with decryptOwn), and kept only in the attachment's record in the database,
// which the seam encrypts again. The file store never holds a key, so it, or a
// copy of it, holds nothing readable on its own; and destroying the
// container's key (an account deletion) ends every copy of every file key.
//
// WHAT IS CHECKED OF THE BYTES (lib/attachments.ts, as each part arrives): a
// photo is a JPEG (its first bytes) that carries no location, which no
// browser's canvas writes, so a page that skipped re-encoding, or a request
// made by hand, can't store one (jpegProblem); a PDF says it is one in its
// first kilobyte, as readers allow (pdfProblem). Nothing else is ever stored.

import { decryptOwn, encryptOwn } from './crypto';
import type { Ctx } from './containers';

/** The format of a sealed part: its first byte. */
export const PART_FORMAT = 1;
/** A part's size, but the last: under Vercel's 4.5 MB request body, and
 *  Next's proxy buffer of 10 MB, which cuts a longer body short without an
 *  error (node_modules/next/dist/docs, proxyClientMaxBodySize). */
export const PART_BYTES = 2 * 1024 * 1024;
/** The largest file, as stored (before sealing). */
export const MAX_FILE_BYTES = 10 * 1024 * 1024;
/** How many parts a file can have. */
export const MAX_PARTS = Math.ceil(MAX_FILE_BYTES / PART_BYTES);
/** The largest thumbnail. */
export const MAX_THUMB_BYTES = 256 * 1024;
/** What sealing adds to a part: the format byte, the nonce and the tag. */
export const SEAL_OVERHEAD = 1 + 12 + 16;

/** A part of a file (0 to parts - 1), or its thumbnail. */
export type PartName = number | 't';

/** A part that doesn't open: damaged, altered, or another file's. Nothing is
 *  said about its bytes. */
export class AttachmentDamagedError extends Error {
  constructor(message = 'A part of this file can’t be opened: it is damaged.') {
    super(message);
    this.name = 'AttachmentDamagedError';
  }
}

/** The size of each part of a file of `bytes` bytes. */
export function partSizes(bytes: number): number[] {
  if (!Number.isInteger(bytes) || bytes < 1) return [];
  const out: number[] = [];
  for (let left = bytes; left > 0; left -= PART_BYTES) out.push(Math.min(PART_BYTES, left));
  return out;
}

/** How many bytes a part of `bytes` takes once sealed. */
export const sealedSize = (bytes: number): number => bytes + SEAL_OVERHEAD;

/** What a file with this many bytes and this thumbnail takes in the store. */
export function storedBytes(bytes: number, thumbBytes: number | null): number {
  return partSizes(bytes).reduce((n, b) => n + sealedSize(b), 0) + (thumbBytes === null ? 0 : sealedSize(thumbBytes));
}

/** A new file key: 32 random bytes. */
export function newFileKey(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(32));
}

const contextOf = (ctx: Ctx, id: string) => `attachment:${ctx.container}:${id}`;

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

function fromBase64(text: string): Uint8Array {
  const binary = atob(text);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

/** The file key, wrapped under the container's own key for this attachment
 *  (lib/crypto.ts encryptOwn: NoOwnKeyError without one). */
export function wrapFileKey(ctx: Ctx, id: string, key: Uint8Array): Promise<string> {
  return encryptOwn(ctx, toBase64(key), contextOf(ctx, id));
}

/** The file key back, only from a value wrapped for this attachment in this
 *  container under its own key (decryptOwn). */
export async function unwrapFileKey(ctx: Ctx, id: string, wrapped: string): Promise<Uint8Array> {
  const key = fromBase64(await decryptOwn(ctx, wrapped, contextOf(ctx, id)));
  if (key.length !== 32) throw new AttachmentDamagedError('This file’s key is damaged.');
  return key;
}

function additionalData(container: string, id: string, part: PartName, parts: number): Uint8Array {
  return new TextEncoder().encode(`nya-attachment.${PART_FORMAT}.${container}.${id}.${part}.${parts}`);
}

async function importKey(key: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', key as BufferSource, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

/** A part sealed with the file's key, ready for the store. */
export async function sealPart(key: Uint8Array, container: string, id: string, part: PartName, parts: number, bytes: Uint8Array): Promise<Uint8Array> {
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const sealed = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce, additionalData: additionalData(container, id, part, parts) as BufferSource }, await importKey(key), bytes as BufferSource)
  );
  const out = new Uint8Array(1 + nonce.length + sealed.length);
  out[0] = PART_FORMAT;
  out.set(nonce, 1);
  out.set(sealed, 1 + nonce.length);
  return out;
}

/** A sealed part opened, or AttachmentDamagedError: never bytes that don't
 *  authenticate, whatever is wrong with them. */
export async function openPart(key: Uint8Array, container: string, id: string, part: PartName, parts: number, stored: Uint8Array): Promise<Uint8Array> {
  if (stored.length < SEAL_OVERHEAD || stored[0] !== PART_FORMAT) throw new AttachmentDamagedError();
  try {
    return new Uint8Array(
      await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: stored.subarray(1, 13) as BufferSource, additionalData: additionalData(container, id, part, parts) as BufferSource },
        await importKey(key),
        stored.subarray(13) as BufferSource
      )
    );
  } catch {
    throw new AttachmentDamagedError();
  }
}

/** The SHA-256 of some bytes, as lowercase hex. */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as BufferSource));
  return [...digest].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// ---- What is checked of the bytes ----

const ascii = (bytes: Uint8Array, at: number, text: string) => [...text].every((ch, i) => bytes[at + i] === ch.charCodeAt(0));

/** Whether an Exif block (the bytes after "Exif\0\0") names a GPS directory
 *  in its first one (tag 0x8825), which is where a photo's location is.
 *  Unreadable structure counts as one: refused rather than guessed. */
function exifHasLocation(tiff: Uint8Array): boolean {
  if (tiff.length < 8) return true;
  const little = tiff[0] === 0x49 && tiff[1] === 0x49;
  const big = tiff[0] === 0x4d && tiff[1] === 0x4d;
  if (!little && !big) return true;
  const u16 = (at: number) => (little ? tiff[at] | (tiff[at + 1] << 8) : (tiff[at] << 8) | tiff[at + 1]);
  const u32 = (at: number) => (little ? (tiff[at] | (tiff[at + 1] << 8) | (tiff[at + 2] << 16)) + tiff[at + 3] * 0x1000000 : tiff[at] * 0x1000000 + ((tiff[at + 1] << 16) | (tiff[at + 2] << 8) | tiff[at + 3]));
  if (u16(2) !== 42) return true;
  const ifd = u32(4);
  if (ifd + 2 > tiff.length) return true;
  const count = u16(ifd);
  if (ifd + 2 + count * 12 > tiff.length) return true;
  for (let i = 0; i < count; i++) if (u16(ifd + 2 + i * 12) === 0x8825) return true;
  return false;
}

/**
 * What is wrong with the start of a JPEG for storing, or null: it must start
 * as a JPEG does, and its header (every segment up to the first scan, which
 * part 0 of a file always holds whole) must carry no location: no Exif block
 * with a GPS directory, no XMP block, no Photoshop (APP13) block. A canvas
 * writes none of them, so what the browser re-encoded always passes.
 */
export function jpegProblem(bytes: Uint8Array): string | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[2] !== 0xff) return 'This isn’t a JPEG photo.';
  let at = 2;
  while (at + 4 <= bytes.length) {
    if (bytes[at] !== 0xff) return 'This photo can’t be read.';
    const marker = bytes[at + 1];
    // Fill bytes, and markers that stand alone.
    if (marker === 0xff) {
      at += 1;
      continue;
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      at += 2;
      continue;
    }
    if (marker === 0xda) return null; // the first scan: the header is over
    if (marker === 0xd9) return 'This photo can’t be read.';
    const length = (bytes[at + 2] << 8) | bytes[at + 3];
    if (length < 2 || at + 2 + length > bytes.length) return 'This photo can’t be read.';
    const data = bytes.subarray(at + 4, at + 2 + length);
    if (marker === 0xe1) {
      if (ascii(data, 0, 'Exif\0\0') && exifHasLocation(data.subarray(6))) return LOCATION;
      if (ascii(data, 0, 'http://ns.adobe.com/xap/1.0/')) return LOCATION;
    }
    if (marker === 0xed) return LOCATION;
    at += 2 + length;
  }
  return 'This photo can’t be read.';
}

const LOCATION = 'This photo still carries what the camera saved with it, such as where it was taken. Choose it again in the app, which leaves that out.';

/** What is wrong with the start of a PDF, or null: "%PDF-" must be in its
 *  first kilobyte, which is where readers look for it. */
export function pdfProblem(bytes: Uint8Array): string | null {
  const end = Math.min(bytes.length, 1024) - 5;
  for (let at = 0; at <= end; at++) if (ascii(bytes, at, '%PDF-')) return null;
  return 'This isn’t a PDF.';
}
