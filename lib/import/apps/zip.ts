// lib/import/apps/zip.ts
//
// Reading the zip some apps export (YNAB's Export Budget Data: its register
// and plan as CSV files; ZeroSum's budget export: transactions.csv and
// budget.csv; Actual Budget's full export: its SQLite database), with no
// dependency: Node's own inflate. Server only.
//
// ONLY WHAT AN EXPORT NEEDS, AND BOUNDED. The central directory is read from
// the end of the file (a zip's own index), each entry's data found through its
// local header, and an entry's data inflated only when asked for, stored or
// deflated (methods 0 and 8), never past MAX_ENTRY_BYTES (inflate is told the
// bound, so a small file that would inflate to gigabytes stops there), and
// only when what comes out is the size the index says. An encrypted entry, a
// split archive, ZIP64 and more than MAX_ENTRIES entries are refused: no
// app's export is any of those.

import { inflateRawSync } from 'node:zlib';
import { cleanText } from '../normalize';

/** The most entries an export may hold, and the largest one read. */
export const MAX_ENTRIES = 64;
export const MAX_ENTRY_BYTES = 6 * 1024 * 1024;
/** The longest entry name kept: a file's name, as an app writes one, is far
 *  shorter. Its name is shown, and kept with the import. */
const MAX_NAME = 200;

export type ZipEntry = { name: string; method: number; flags: number; compressed: number; size: number; offset: number };

const EOCD = 0x06054b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;

/** Whether the bytes are a zip (its first local header's signature). */
export function isZip(bytes: Uint8Array): boolean {
  return bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;
}

/** The entries a zip holds, from its central directory, or why it can't be
 *  read. */
export function listZip(bytes: Uint8Array): ZipEntry[] | { error: string } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const bad = { error: 'This zip file can’t be read: it may be damaged. Export it again, or unzip it and choose the CSV file inside.' };
  // The end record: 22 bytes, after at most a 64 KB comment.
  let end = -1;
  for (let at = bytes.length - 22; at >= 0 && at >= bytes.length - 22 - 0xffff; at--) {
    if (view.getUint32(at, true) === EOCD) {
      end = at;
      break;
    }
  }
  if (end < 0) return bad;
  const disk = view.getUint16(end + 4, true);
  const count = view.getUint16(end + 10, true);
  const size = view.getUint32(end + 12, true);
  const start = view.getUint32(end + 16, true);
  if (disk !== 0 || count === 0xffff || start === 0xffffffff) return { error: 'This zip file is in a form Nya doesn’t read (split over several files, or ZIP64). Unzip it and choose the CSV file inside.' };
  if (count > MAX_ENTRIES) return { error: `This zip file holds ${count} files, more than an app’s export does. Unzip it and choose the CSV file inside.` };
  if (start + size > end) return bad;
  const entries: ZipEntry[] = [];
  let at = start;
  for (let i = 0; i < count; i++) {
    if (at + 46 > bytes.length || view.getUint32(at, true) !== CENTRAL) return bad;
    const flags = view.getUint16(at + 8, true);
    const method = view.getUint16(at + 10, true);
    const compressed = view.getUint32(at + 20, true);
    const uncompressed = view.getUint32(at + 24, true);
    const nameLength = view.getUint16(at + 28, true);
    const extra = view.getUint16(at + 30, true);
    const comment = view.getUint16(at + 32, true);
    const offset = view.getUint32(at + 42, true);
    if (at + 46 + nameLength > bytes.length) return bad;
    // Shown and kept as text is: no control characters or marks that turn
    // what follows round, and only so long.
    const full = cleanText(new TextDecoder('utf-8').decode(bytes.subarray(at + 46, at + 46 + nameLength)));
    const name = full.length <= MAX_NAME ? full : full.slice(0, /[\uD800-\uDBFF]/.test(full[MAX_NAME - 1]) ? MAX_NAME - 1 : MAX_NAME);
    entries.push({ name, method, flags, compressed, size: uncompressed, offset });
    at += 46 + nameLength + extra + comment;
  }
  return entries;
}

/** An entry's bytes, inflated, or why not (see the header). */
export function readEntry(bytes: Uint8Array, entry: ZipEntry): Uint8Array | { error: string } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const bad = { error: `The file ${entry.name} in this zip can’t be read: it may be damaged. Unzip it and choose the CSV file inside.` };
  if (entry.flags & 1) return { error: 'This zip file is encrypted. Export it again without a password, or unzip it and choose the CSV file inside.' };
  if (entry.size > MAX_ENTRY_BYTES) return { error: `${entry.name} is larger than ${MAX_ENTRY_BYTES / (1024 * 1024)} MB unzipped, more than one import takes. Export a shorter period and import it in parts.` };
  if (entry.offset + 30 > bytes.length || view.getUint32(entry.offset, true) !== LOCAL) return bad;
  const dataAt = entry.offset + 30 + view.getUint16(entry.offset + 26, true) + view.getUint16(entry.offset + 28, true);
  if (dataAt + entry.compressed > bytes.length) return bad;
  const data = bytes.subarray(dataAt, dataAt + entry.compressed);
  let out: Uint8Array;
  if (entry.method === 0) out = data;
  else if (entry.method === 8) {
    try {
      out = inflateRawSync(data, { maxOutputLength: MAX_ENTRY_BYTES });
    } catch {
      return bad;
    }
  } else return { error: `${entry.name} in this zip is compressed in a way Nya doesn’t read. Unzip it and choose the CSV file inside.` };
  if (out.length !== entry.size) return bad;
  return out;
}

/** An entry's name without the folders it is in. */
export const baseName = (name: string): string => name.split('/').pop() ?? name;
