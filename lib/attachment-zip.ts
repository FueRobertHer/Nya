// lib/attachment-zip.ts
//
// The person's receipts and documents as a download of their own (#47): ZIP
// files of about VOLUME_BYTES each, the files decrypted, in folders by year,
// each volume with a manifest; and the list of them the JSON download carries
// (`attachments`, lib/user-export.ts), which names each file as the ZIP does.
// The route is app/api/attachments/download; docs/data-export.md has the
// format.
//
// VOLUMES OF ABOUT 50 MB, oldest files first: a volume goes out in the route's
// 300 seconds over about 1.4 Mbit/s, and the page holds about twice it at its
// peak, which a phone's tab keeps. A set of volumes counts as one download
// (setToken, bound to the person, the account, the listing and how many
// volumes there are, for an hour).
//
// A WHOLE FILE OR NONE, as every download (docs/data-export.md): its size is
// known before the first byte. The account's folder is listed once before
// anything is sent, and a file whose objects are missing or the wrong size is
// left out of the plan and named (left_out, and the route's notes). Each file
// is read and opened whole before its entry is written, so its CRC-32 and
// size are in its header (no data descriptor: every unzip reads that); one
// that fails to open as the volume streams is written as zeros of its size,
// so the length still holds, marked damaged in the manifest, which goes last,
// its fields of fixed width so its size is known too, and the record is
// marked damaged, so the next listing leaves it out.
//
// THE NAMES are built from the transaction's day and merchant as placed and
// the file's id, cleaned of anything a file system would read as a path or
// refuse (separators, "..", control characters, trailing dots and spaces,
// Windows' reserved names), and stored as UTF-8 (the flag set).

import { createHash, createHmac } from 'node:crypto';
import type { Ctx } from './containers';
import { crc32 } from './zip';
import { attachmentStore, type Attachment } from './attachment-stores';
import { openPart, partSizes, sealedSize, unwrapFileKey, AttachmentDamagedError, type PartName } from './attachment-crypto';
import { containerFolder, objectPath, parseObjectPath, withLimit, type AttachmentObjects } from './attachment-objects';
import { markDamaged } from './attachments';

export const VOLUME_BYTES = 50 * 1024 * 1024;
export const ZIP_FORMAT = 'nya-attachments';
export const ZIP_VERSION = 1;
export const MANIFEST_NAME = 'nya-attachments.json';
/** How long a set token holds, from the first volume. */
export const SET_MS = 60 * 60 * 1000;

const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

/** One part of a name, safe on any file system: no separators, no "..", no
 *  control characters, no trailing dots or spaces, not a reserved name, at
 *  most `max` characters. Empty becomes `fallback`. */
export function cleanSegment(raw: string, max = 60, fallback = 'file'): string {
  let s = raw
    .normalize('NFC')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/[\\/:*?"<>|]/g, ' ')
    .replace(/\.{2,}/g, '.')
    .replace(/\s+/g, ' ')
    .trim();
  s = Array.from(s).slice(0, max).join('').replace(/[. ]+$/g, '').replace(/^[. ]+/g, '');
  if (!s) return fallback;
  if (RESERVED.test(s.split('.')[0])) s = `_${s}`;
  return s;
}

/** The day a file is listed under: its transaction's, else the day it was
 *  added. */
const dayOf = (a: Attachment) => a.as_placed?.date ?? a.created_at.slice(0, 10);

/** The name a file has inside the ZIP (and in the JSON download). */
export function entryName(id: string, a: Attachment): string {
  const day = dayOf(a);
  const merchant = cleanSegment(a.as_placed?.name ?? (a.kind === 'pdf' ? 'Document' : 'Receipt'), 60, 'Receipt');
  return `${day.slice(0, 4)}/${day} ${merchant} ${id.slice(0, 8)}.${a.kind === 'pdf' ? 'pdf' : 'jpg'}`;
}

/** What the JSON download says of one file: never its key, its upload or
 *  where it is stored. */
export function exportedAttachment(id: string, a: Attachment) {
  return {
    id,
    on: a.place.on === 'transaction' ? { transaction_id: a.place.transaction_id } : a.place.on === 'earlier' ? { earlier_account_id: a.place.account_id } : null,
    type: a.kind === 'pdf' ? 'application/pdf' : 'image/jpeg',
    bytes: a.bytes,
    name: a.name,
    added_at: a.created_at,
    file: entryName(id, a),
    transaction_as_added: a.as_placed,
    ...(a.damaged ? { damaged: true } : {}),
  };
}

/** The JSON download's `attachments`: every ready file, oldest first. */
export function exportedAttachments(entries: ReadonlyMap<string, Attachment>) {
  return [...entries]
    .filter(([, a]) => a.status === 'ready')
    .sort(([ia, a], [ib, b]) => (dayOf(a) < dayOf(b) ? -1 : dayOf(a) > dayOf(b) ? 1 : ia < ib ? -1 : 1))
    .map(([id, a]) => exportedAttachment(id, a));
}

// ---- The plan ----

export type PlannedFile = { id: string; record: Attachment; name: string };
export type LeftOut = { id: string; why: 'missing' | 'damaged' };
export type VolumePlan = { volumes: PlannedFile[][]; left_out: LeftOut[]; unreadable: number; digest: string };

/**
 * Which files go in which volume, from the records and one listing of the
 * account's folder: every ready file whose objects are all there at the size
 * they were sealed at, oldest first, packed into volumes of about
 * VOLUME_BYTES. A damaged file, and one whose objects aren't all there, is
 * left out and named. `digest` says which listing this is, for the set token.
 */
export async function planVolumes(ctx: Ctx, store: AttachmentObjects): Promise<VolumePlan> {
  const report = await attachmentStore.getAllReport(ctx);
  const listed = await withLimit('a listing', 30_000, (signal) => store.list(containerFolder(ctx), signal));
  const sizes = new Map(listed.map((o) => [o.pathname, o.size]));
  const files: PlannedFile[] = [];
  const left_out: LeftOut[] = [];
  for (const [id, a] of report.entries) {
    if (a.status !== 'ready') continue;
    if (a.damaged) {
      left_out.push({ id, why: 'damaged' });
      continue;
    }
    const want: [PartName, number][] = partSizes(a.bytes).map((b, i) => [i, b]);
    if (a.thumb_bytes !== null) want.push(['t', a.thumb_bytes]);
    const whole = want.every(([p, b]) => sizes.get(objectPath(ctx, id, p)) === sealedSize(b));
    if (!whole) left_out.push({ id, why: 'missing' });
    else files.push({ id, record: a, name: entryName(id, a) });
  }
  files.sort((x, y) => (dayOf(x.record) < dayOf(y.record) ? -1 : dayOf(x.record) > dayOf(y.record) ? 1 : x.id < y.id ? -1 : 1));
  const volumes: PlannedFile[][] = [];
  let current: PlannedFile[] = [];
  let bytes = 0;
  for (const f of files) {
    if (current.length > 0 && (bytes + f.record.bytes > VOLUME_BYTES || current.length >= 2000)) {
      volumes.push(current);
      current = [];
      bytes = 0;
    }
    current.push(f);
    bytes += f.record.bytes;
  }
  if (current.length > 0) volumes.push(current);
  left_out.sort((x, y) => (x.id < y.id ? -1 : 1));
  const digest = createHash('sha256')
    .update(JSON.stringify([volumes.map((v) => v.map((f) => [f.id, f.record.bytes])), left_out, listed.filter((o) => parseObjectPath(ctx, o.pathname)).length]))
    .digest('hex');
  return { volumes, left_out, unreadable: report.unreadable.length + report.unrecognised.length, digest };
}

// ---- The set token (D7) ----

let keyed: { from: string; key: Buffer } | null = null;
function setKey(): Buffer {
  const from = process.env.PLAID_ENCRYPTION_KEY ?? '';
  if (keyed?.from !== from) keyed = { from, key: createHash('sha256').update(`nya-attachments-set-key:${from}`, 'utf8').digest() };
  return keyed.key;
}

type SetFacts = { container: string; user: string | null; digest: string; volumes: number };

/** A token for the rest of a set: bound to who asked, the account, the
 *  listing and the number of volumes, for SET_MS. */
export function setToken(f: SetFacts, now: number = Date.now()): string {
  const until = now + SET_MS;
  const mac = createHmac('sha256', setKey()).update(JSON.stringify([f.container, f.user, f.digest, f.volumes, until])).digest('base64url');
  return `${until}.${mac}`;
}

/** Whether a token is one setToken gave for exactly these facts, still in
 *  time. */
export function setTokenHolds(token: unknown, f: SetFacts, now: number = Date.now()): boolean {
  if (typeof token !== 'string' || token.length > 200) return false;
  const [untilText, mac] = token.split('.');
  const until = Number(untilText);
  if (!Number.isInteger(until) || until <= now || until > now + SET_MS || !mac) return false;
  const want = createHmac('sha256', setKey()).update(JSON.stringify([f.container, f.user, f.digest, f.volumes, until])).digest('base64url');
  return want.length === mac.length && createHash('sha256').update(want).digest().equals(createHash('sha256').update(mac).digest());
}

// ---- Writing a volume ----

const utf8 = (s: string) => new TextEncoder().encode(s);

/** DOS time and date (UTC) for an instant. */
function dosTime(iso: string): { time: number; date: number } {
  const d = new Date(iso);
  const year = Math.max(1980, Math.min(2107, d.getUTCFullYear()));
  return {
    time: (d.getUTCHours() << 11) | (d.getUTCMinutes() << 5) | Math.floor(d.getUTCSeconds() / 2),
    date: ((year - 1980) << 9) | ((d.getUTCMonth() + 1) << 5) | d.getUTCDate(),
  };
}

/** The UTF-8 name flag. */
const FLAGS = 0x0800;

function localHeader(name: Uint8Array, crc: number, size: number, when: { time: number; date: number }): Uint8Array {
  const h = new Uint8Array(30 + name.length);
  const v = new DataView(h.buffer);
  v.setUint32(0, 0x04034b50, true);
  v.setUint16(4, 20, true);
  v.setUint16(6, FLAGS, true);
  v.setUint16(8, 0, true); // stored: a JPEG or a PDF doesn't shrink
  v.setUint16(10, when.time, true);
  v.setUint16(12, when.date, true);
  v.setUint32(14, crc, true);
  v.setUint32(18, size, true);
  v.setUint32(22, size, true);
  v.setUint16(26, name.length, true);
  v.setUint16(28, 0, true);
  h.set(name, 30);
  return h;
}

function centralHeader(name: Uint8Array, crc: number, size: number, when: { time: number; date: number }, offset: number): Uint8Array {
  const h = new Uint8Array(46 + name.length);
  const v = new DataView(h.buffer);
  v.setUint32(0, 0x02014b50, true);
  v.setUint16(4, 20, true);
  v.setUint16(6, 20, true);
  v.setUint16(8, FLAGS, true);
  v.setUint16(10, 0, true);
  v.setUint16(12, when.time, true);
  v.setUint16(14, when.date, true);
  v.setUint32(16, crc, true);
  v.setUint32(20, size, true);
  v.setUint32(24, size, true);
  v.setUint16(28, name.length, true);
  // extra, comment, disk, internal and external attributes: none
  v.setUint32(42, offset, true);
  h.set(name, 46);
  return h;
}

function endRecord(count: number, size: number, offset: number): Uint8Array {
  const h = new Uint8Array(22);
  const v = new DataView(h.buffer);
  v.setUint32(0, 0x06054b50, true);
  v.setUint16(8, count, true);
  v.setUint16(10, count, true);
  v.setUint32(12, size, true);
  v.setUint32(16, offset, true);
  return h;
}

export type VolumeMeta = { exported_at: string; volume: number; volumes: number; left_out: LeftOut[] };

const PLACEHOLDER_SHA = '0'.repeat(64);

/** One file's line of the manifest, of fixed width: its digest and whether
 *  it is damaged are filled in once it is written, at the same length. */
function manifestEntry(f: PlannedFile, sha = PLACEHOLDER_SHA, damaged = false): string {
  const line = JSON.stringify({ ...exportedAttachment(f.id, f.record), file: f.name, sha256: sha, damaged: false });
  return damaged ? line.replace('"damaged":false', '"damaged":true ') : line;
}

function manifestText(meta: VolumeMeta, files: PlannedFile[], lines: string[]): string {
  const head = JSON.stringify({ format: ZIP_FORMAT, version: ZIP_VERSION, exported_at: meta.exported_at, volume: meta.volume, volumes: meta.volumes, left_out: meta.left_out });
  return `${head.slice(0, -1)},"files":[\n${lines.join(',\n')}\n]}\n`;
}

/** The size of a volume, in bytes, before it is written. */
export function volumeSize(files: PlannedFile[], meta: VolumeMeta): number {
  let n = 0;
  for (const f of files) n += 30 + utf8(f.name).length + f.record.bytes + 46 + utf8(f.name).length;
  const manifest = utf8(manifestText(meta, files, files.map((f) => manifestEntry(f)))).length;
  const name = utf8(MANIFEST_NAME).length;
  return n + 30 + name + manifest + 46 + name + 22;
}

/** Reads and opens one file whole, or null when a part is missing or
 *  doesn't open. */
async function openWhole(ctx: Ctx, store: AttachmentObjects, f: PlannedFile): Promise<Uint8Array | null> {
  try {
    const key = await unwrapFileKey(ctx, f.id, f.record.file_key!);
    const out = new Uint8Array(f.record.bytes);
    let at = 0;
    for (let i = 0; i < f.record.parts; i++) {
      const stored = await withLimit('a read', 20_000, (signal) => store.get(objectPath(ctx, f.id, i), signal));
      if (stored === null) return null;
      const part = await openPart(key, ctx.container, f.id, i, f.record.parts, stored);
      if (at + part.length > out.length) return null;
      out.set(part, at);
      at += part.length;
    }
    return at === out.length ? out : null;
  } catch (err) {
    if (err instanceof AttachmentDamagedError) return null;
    // Anything that says nothing about the file (the store unreachable, a key
    // this deployment can't use) stops the volume: never a file of zeros
    // standing for one that is fine.
    if (err instanceof Error && err.name === 'DecryptFailedError') return null;
    throw err;
  }
}

/**
 * The volume's bytes, a file at a time, exactly volumeSize(files, meta) of
 * them: each file read and opened whole before its entry is written (one
 * that doesn't open is zeros of its size, marked damaged), the manifest
 * last, then the index.
 */
export async function* volumeChunks(ctx: Ctx, store: AttachmentObjects, files: PlannedFile[], meta: VolumeMeta): AsyncGenerator<Uint8Array> {
  const central: Uint8Array[] = [];
  const lines: string[] = [];
  let offset = 0;
  const entry = function* (name: Uint8Array, bytes: Uint8Array, when: { time: number; date: number }): Generator<Uint8Array> {
    const crc = crc32(bytes);
    central.push(centralHeader(name, crc, bytes.length, when, offset));
    const header = localHeader(name, crc, bytes.length, when);
    offset += header.length + bytes.length;
    yield header;
    for (let at = 0; at < bytes.length; at += 256 * 1024) yield bytes.subarray(at, at + 256 * 1024);
  };
  for (const f of files) {
    const opened = await openWhole(ctx, store, f);
    const bytes = opened ?? new Uint8Array(f.record.bytes);
    if (!opened) await markDamaged(ctx, f.id);
    const sha = createHash('sha256').update(bytes).digest('hex');
    lines.push(manifestEntry(f, sha, !opened));
    yield* entry(utf8(f.name), bytes, dosTime(f.record.ready_at ?? f.record.created_at));
  }
  yield* entry(utf8(MANIFEST_NAME), utf8(manifestText(meta, files, lines)), dosTime(meta.exported_at));
  const start = offset;
  let size = 0;
  for (const c of central) {
    size += c.length;
    yield c;
  }
  yield endRecord(central.length, size, start);
}

/** The volume's file name. */
export const volumeName = (day: string, volume: number, volumes: number) => `nya-attachments-${day}-${volume}-of-${volumes}.zip`;
