// lib/zip.ts
//
// Reading a zip file, bounded, with no dependency: Node's own inflate. Server
// only. Shared by the migration importers' app exports (lib/import/apps/zip.ts,
// which words their messages for a person) and the ECB's history file
// (lib/fx/ecb-fetch.ts, which words them for an operator); this module only
// says what is wrong, never to whom.
//
// ONLY WHAT IS NEEDED, AND BOUNDED. The central directory is read from the end
// of the file (a zip's own index), so a zip streamed with its sizes after each
// entry (flag bit 3, zero sizes in the local header) reads as well as any.
// Each entry's data is found through its local header and inflated only when
// asked for, stored or deflated (methods 0 and 8), never past the caller's
// bound (inflate is told it, so a small file that would inflate to gigabytes
// stops there), and only when what comes out is the size and the CRC-32 the
// index says. An encrypted entry, a split archive, ZIP64 and more entries
// than the caller allows are refused.

import { inflateRawSync } from 'node:zlib';

export type ZipEntry = {
  /** As the index writes it, decoded as UTF-8; the caller cleans it. */
  name: string;
  method: number;
  flags: number;
  compressed: number;
  size: number;
  crc: number;
  offset: number;
};

/** What is wrong with a zip or an entry. */
export type ZipProblem =
  | { problem: 'damaged' }
  | { problem: 'unsupported' } // split over several files, or ZIP64
  | { problem: 'too-many'; count: number }
  | { problem: 'encrypted' }
  | { problem: 'too-large' }
  | { problem: 'method' }; // compressed some way other than deflate

export type ZipLimits = { maxEntries: number; maxEntryBytes: number };

const EOCD = 0x06054b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;

/** Whether the bytes are a zip (its first local header's signature). */
export function isZip(bytes: Uint8Array): boolean {
  return bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;
}

/** The entries a zip holds, from its central directory, or what is wrong. */
export function listZip(bytes: Uint8Array, limits: ZipLimits): ZipEntry[] | ZipProblem {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const damaged: ZipProblem = { problem: 'damaged' };
  // The end record: 22 bytes, after at most a 64 KB comment.
  let end = -1;
  for (let at = bytes.length - 22; at >= 0 && at >= bytes.length - 22 - 0xffff; at--) {
    if (view.getUint32(at, true) === EOCD) {
      end = at;
      break;
    }
  }
  if (end < 0) return damaged;
  const disk = view.getUint16(end + 4, true);
  const count = view.getUint16(end + 10, true);
  const size = view.getUint32(end + 12, true);
  const start = view.getUint32(end + 16, true);
  if (disk !== 0 || count === 0xffff || start === 0xffffffff) return { problem: 'unsupported' };
  if (count > limits.maxEntries) return { problem: 'too-many', count };
  if (start + size > end) return damaged;
  const entries: ZipEntry[] = [];
  let at = start;
  for (let i = 0; i < count; i++) {
    if (at + 46 > bytes.length || view.getUint32(at, true) !== CENTRAL) return damaged;
    const flags = view.getUint16(at + 8, true);
    const method = view.getUint16(at + 10, true);
    const crc = view.getUint32(at + 16, true);
    const compressed = view.getUint32(at + 20, true);
    const uncompressed = view.getUint32(at + 24, true);
    const nameLength = view.getUint16(at + 28, true);
    const extra = view.getUint16(at + 30, true);
    const comment = view.getUint16(at + 32, true);
    const offset = view.getUint32(at + 42, true);
    if (at + 46 + nameLength > bytes.length) return damaged;
    const name = new TextDecoder('utf-8').decode(bytes.subarray(at + 46, at + 46 + nameLength));
    entries.push({ name, method, flags, compressed, size: uncompressed, crc, offset });
    at += 46 + nameLength + extra + comment;
  }
  return entries;
}

/** An entry's bytes, inflated and checked against its size and CRC-32, or
 *  what is wrong. */
export function readEntry(bytes: Uint8Array, entry: ZipEntry, limits: ZipLimits): Uint8Array | ZipProblem {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const damaged: ZipProblem = { problem: 'damaged' };
  if (entry.flags & 1) return { problem: 'encrypted' };
  if (entry.size > limits.maxEntryBytes) return { problem: 'too-large' };
  if (entry.offset + 30 > bytes.length || view.getUint32(entry.offset, true) !== LOCAL) return damaged;
  const dataAt = entry.offset + 30 + view.getUint16(entry.offset + 26, true) + view.getUint16(entry.offset + 28, true);
  if (dataAt + entry.compressed > bytes.length) return damaged;
  const data = bytes.subarray(dataAt, dataAt + entry.compressed);
  let out: Uint8Array;
  if (entry.method === 0) out = data;
  else if (entry.method === 8) {
    try {
      out = inflateRawSync(data, { maxOutputLength: limits.maxEntryBytes });
    } catch {
      return damaged;
    }
  } else return { problem: 'method' };
  if (out.length !== entry.size || crc32(out) !== entry.crc) return damaged;
  return out;
}

/** An entry's name without the folders it is in. */
export const baseName = (name: string): string => name.split('/').pop() ?? name;

// CRC-32 (IEEE 802.3, the zip format's), by table: written here rather than
// taken from node:zlib, whose crc32 not every runtime this deploys on has.
let TABLE: Uint32Array | null = null;
function table(): Uint32Array {
  if (TABLE) return TABLE;
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return (TABLE = t);
}

/** The CRC-32 of the bytes, as a zip's index records it. */
export function crc32(bytes: Uint8Array): number {
  const t = table();
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = t[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
