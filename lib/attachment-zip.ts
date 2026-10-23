// lib/attachment-zip.ts
//
// The person's receipts and documents as a download of their own (#47): ZIP
// files of about VOLUME_BYTES each, the files decrypted, in folders by year,
// each volume with a manifest; and the list of them the JSON download carries
// (`attachments`, lib/user-export.ts), which names each file as the ZIP does.
// The route is app/api/attachments/download; docs/data-export.md has the
// format.
//
// VOLUMES OF ABOUT 50 MB, AND AT MOST 400 FILES, in the order the files were
// added: a volume goes out in the route's 300 seconds over about 1.4 Mbit/s,
// and the page holds about twice it at its peak, which a phone's tab keeps.
//
// ONE PLAN FOR THE SET (review blocking 1): the card makes the download
// ready once (makePlan), and is given the plan, each volume's ids, signed
// (planToken); every volume after is served from it (servePlan), never from
// a plan worked out again, so a file deleted, added or moved between two
// volumes can't shift the others' cut: a volume holds exactly its planned
// files, less those deleted or no longer whole, which its manifest names,
// and the last volume's manifest names every such file of the set. A file
// added after is in no volume; the route counts it (X-Nya-Added) and the
// card offers a new set. The set counts as one download (setToken, bound to
// the person, the account, the plan and how many volumes there are, for an
// hour from the last volume).
//
// A WHOLE FILE OR NONE, as every download (docs/data-export.md): its size is
// known before the first byte. The account's folder is listed once before
// anything is sent, and a file whose objects are missing or the wrong size is
// left out and named (left_out, and the route's notes). Each file is read and
// opened whole before its entry is written, so its CRC-32 and size are in its
// header (no data descriptor: every unzip reads that); one that fails to open
// as the volume streams is written as zeros of its size, so the length still
// holds, marked damaged in the manifest, which goes last, its fields of fixed
// width so its size is known too, and the record is marked damaged (a later
// read that opens it whole clears the mark).
//
// THE NAMES are built from the transaction's day and merchant as placed and
// the file's id, cleaned of anything a file system would read as a path or
// refuse (separators, "..", control characters, trailing dots and spaces,
// Windows' reserved names), and stored as UTF-8 (the flag set).

import { createHash, createHmac } from 'node:crypto';
import type { Ctx } from './containers';
import { crc32 } from './zip';
import { attachmentStore, isAttachmentId, type Attachment } from './attachment-stores';
import { openPart, partSizes, sealedSize, unwrapFileKey, AttachmentDamagedError, type PartName } from './attachment-crypto';
import { containerFolder, objectPath, withLimit, type AttachmentObjects } from './attachment-objects';
import { clearDamaged, markDamaged } from './attachments';

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

// ---- The plan: made ready once, then served as it is ----

/** The most files in one volume: each is read and opened in turn, so a
 *  volume of many small files still goes out in the route's 300 seconds. */
export const VOLUME_FILES = 400;
/** How long a plan made ready can be downloaded from. */
export const PLAN_MS = 6 * 60 * 60 * 1000;
/** The longest plan token taken: MAX_FILES ids, and room. */
export const MAX_PLAN_CHARS = 400_000;

export type PlannedFile = { id: string; record: Attachment; name: string };
/** A file left out, and why: its objects aren't all in the store
 *  (`missing`), it was deleted after the download was made ready
 *  (`deleted`), or its record can't be read now (`unreadable`). `volume`:
 *  the volume it was planned for, in the last volume's list of the set's. */
export type LeftOut = { id: string; why: 'missing' | 'deleted' | 'unreadable'; volume?: number };

/** A download made ready: which files, by id, go in which volume, for one
 *  account, until a time. */
export type Plan = { container: string; until: number; volumes: string[][] };

/** The volume limits, which a test may set smaller (setVolumeLimitsForTests). */
let limits = { bytes: VOLUME_BYTES, files: VOLUME_FILES };
export function setVolumeLimitsForTests(next: { bytes: number; files: number } | null): void {
  limits = next ?? { bytes: VOLUME_BYTES, files: VOLUME_FILES };
}

const byAdded = (x: { id: string; record: Attachment }, y: { id: string; record: Attachment }) =>
  x.record.created_at < y.record.created_at ? -1 : x.record.created_at > y.record.created_at ? 1 : x.id < y.id ? -1 : 1;

/** Which files the account's folder holds whole (every part, and the
 *  thumbnail, at the size it was sealed at), from one listing. */
async function wholeIn(ctx: Ctx, store: AttachmentObjects): Promise<(id: string, a: Attachment) => boolean> {
  const listed = await withLimit('a listing', 30_000, (signal) => store.list(containerFolder(ctx), signal));
  const sizes = new Map(listed.map((o) => [o.pathname, o.size]));
  return (id, a) => {
    const want: [PartName, number][] = partSizes(a.bytes).map((b, i) => [i, b]);
    if (a.thumb_bytes !== null) want.push(['t', a.thumb_bytes]);
    return want.every(([p, b]) => sizes.get(objectPath(ctx, id, p)) === sealedSize(b));
  };
}

/**
 * The download made ready (review blocking 1): every ready file whose
 * objects are all there (one once marked damaged too: each is opened again
 * as its volume is written), in the order they were added, which nothing
 * changes, packed into volumes of about VOLUME_BYTES and at most
 * VOLUME_FILES. A file whose objects aren't all there is left out and named.
 * From then on the plan is what is served (planToken, servePlan), whatever
 * changes meanwhile: a file moved stays in its volume, one deleted is named
 * as such, one added is in no volume and is counted, so the card can offer a
 * new set. A set of volumes never misses a file without a word.
 */
export async function makePlan(
  ctx: Ctx,
  store: AttachmentObjects,
  now: number = Date.now()
): Promise<{ volumes: PlannedFile[][]; left_out: LeftOut[]; unreadable: number; plan: Plan }> {
  const report = await attachmentStore.getAllReport(ctx);
  const whole = await wholeIn(ctx, store);
  const files: PlannedFile[] = [];
  const left_out: LeftOut[] = [];
  for (const [id, a] of report.entries) {
    if (a.status !== 'ready') continue;
    if (!whole(id, a)) left_out.push({ id, why: 'missing' });
    else files.push({ id, record: a, name: entryName(id, a) });
  }
  files.sort(byAdded);
  const volumes: PlannedFile[][] = [];
  let current: PlannedFile[] = [];
  let bytes = 0;
  for (const f of files) {
    if (current.length > 0 && (bytes + f.record.bytes > limits.bytes || current.length >= limits.files)) {
      volumes.push(current);
      current = [];
      bytes = 0;
    }
    current.push(f);
    bytes += f.record.bytes;
  }
  if (current.length > 0) volumes.push(current);
  left_out.sort((x, y) => (x.id < y.id ? -1 : 1));
  return {
    volumes,
    left_out,
    unreadable: report.unreadable.length + report.unrecognised.length,
    plan: { container: ctx.container, until: now + PLAN_MS, volumes: volumes.map((v) => v.map((f) => f.id)) },
  };
}

/** One volume of a plan, as the files are now. */
export type ServedVolume = {
  /** Its files still ready and whole, in the plan's order. */
  files: PlannedFile[];
  /** Its own planned files that aren't. */
  left_out: LeftOut[];
  /** For the last volume: every file of the set that isn't ready and whole
   *  now, with the volume it was planned for (one deleted after its volume
   *  was saved is in that volume). Null for another volume. */
  set_left_out: LeftOut[] | null;
  /** Ready files the plan doesn't hold: added after it was made ready. */
  added: number;
};

/** Serves volume `volume` (from 1) of a plan: exactly its planned files,
 *  less those deleted or no longer whole, which are named (servePlan never
 *  takes a file from another volume, nor one added since). */
export async function servePlan(ctx: Ctx, store: AttachmentObjects, plan: Plan, volume: number): Promise<ServedVolume> {
  const report = await attachmentStore.getAllReport(ctx);
  const whole = await wholeIn(ctx, store);
  const unknown = new Set([...report.unreadable, ...report.unrecognised]);
  const now = (id: string): PlannedFile | LeftOut['why'] => {
    if (unknown.has(id)) return 'unreadable';
    const a = report.entries.get(id);
    if (!a || a.status !== 'ready') return 'deleted';
    if (!whole(id, a)) return 'missing';
    return { id, record: a, name: entryName(id, a) };
  };
  const files: PlannedFile[] = [];
  const left_out: LeftOut[] = [];
  for (const id of plan.volumes[volume - 1] ?? []) {
    const s = now(id);
    if (typeof s === 'string') left_out.push({ id, why: s });
    else files.push(s);
  }
  let set_left_out: LeftOut[] | null = null;
  if (volume === plan.volumes.length) {
    set_left_out = [];
    plan.volumes.forEach((ids, i) => {
      for (const id of ids) {
        const s = now(id);
        if (typeof s === 'string') set_left_out!.push({ id, why: s, volume: i + 1 });
      }
    });
  }
  const planned = new Set(plan.volumes.flat());
  let added = 0;
  for (const [id, a] of report.entries) if (a.status === 'ready' && !planned.has(id)) added++;
  return { files, left_out, set_left_out, added };
}

/** "1 file" or "3 files". */
const fileCount = (n: number) => `${n} ${n === 1 ? 'file' : 'files'}`;

/** What the card says of one volume: its planned files left out, by why;
 *  for the last, the set's; and files added since the plan. */
export function volumeNotes(served: { left_out: LeftOut[]; set_left_out: LeftOut[] | null; added: number }, plan: Plan): string[] {
  const out: string[] = [];
  const why = (list: LeftOut[], w: LeftOut['why']) => list.filter((l) => l.why === w).length;
  const own = served.left_out;
  if (why(own, 'deleted') > 0) out.push(`${fileCount(why(own, 'deleted'))} planned for this ZIP file ${why(own, 'deleted') === 1 ? 'was' : 'were'} deleted after the download was made ready.`);
  if (why(own, 'missing') > 0) out.push(`${fileCount(why(own, 'missing'))} planned for this ZIP file ${why(own, 'missing') === 1 ? 'isn’t' : 'aren’t'} whole in storage now, so ${why(own, 'missing') === 1 ? 'it is' : 'they are'} left out.`);
  if (why(own, 'unreadable') > 0) out.push(`${fileCount(why(own, 'unreadable'))} planned for this ZIP file can’t be read just now, so ${why(own, 'unreadable') === 1 ? 'it is' : 'they are'} left out.`);
  const earlier = (served.set_left_out ?? []).filter((l) => l.volume !== plan.volumes.length);
  if (earlier.length > 0) {
    out.push(
      `${fileCount(earlier.length)} planned for an earlier ZIP file of this download ${earlier.length === 1 ? 'was' : 'were'} deleted or can’t be read now. The list in this one (nya-attachments.json, set_left_out) names each, with the ZIP file it was planned for: if you saved that one before, you have it.`
    );
  }
  if (served.added > 0) out.push(`${fileCount(served.added)} ${served.added === 1 ? 'was' : 'were'} added after this download was made ready, so ${served.added === 1 ? 'it isn’t' : 'they aren’t'} in it. Get the download ready again for a new set that holds ${served.added === 1 ? 'it' : 'them'}.`);
  return out;
}

// ---- The plan token ----

/** An attachment id as 16 bytes, and back. */
const idBytes = (id: string) => Buffer.from(id.replace(/-/g, ''), 'hex');
const idText = (b: Buffer) => {
  const h = b.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
};

const macOf = (key: Buffer, body: string) => createHmac('sha256', key).update(body).digest('base64url');
const sameMac = (a: string, b: string) => a.length === b.length && createHash('sha256').update(a).digest().equals(createHash('sha256').update(b).digest());

/** The plan as the page keeps it until the set is saved: the volumes' ids,
 *  sixteen bytes each, signed with the environment's key, so a volume asked
 *  for later is the one made ready. */
export function planToken(p: Plan): string {
  const vols = p.volumes.map((ids) => Buffer.concat(ids.map(idBytes)).toString('base64url')).join('~');
  const body = `p1.${p.container}.${p.until}.${vols}`;
  return `${body}.${macOf(planKey(), body)}`;
}

/** A plan token this environment signed for this account, or why not:
 *  `expired` once PLAN_MS has passed, null for anything else. */
export function readPlanToken(token: unknown, container: string, now: number = Date.now()): Plan | 'expired' | null {
  if (typeof token !== 'string' || token.length > MAX_PLAN_CHARS) return null;
  const parts = token.split('.');
  if (parts.length !== 5 || parts[0] !== 'p1') return null;
  const [, owner, untilText, vols, mac] = parts;
  if (!sameMac(macOf(planKey(), parts.slice(0, 4).join('.')), mac)) return null;
  if (owner !== container) return null;
  const until = Number(untilText);
  if (!Number.isInteger(until) || until > now + PLAN_MS) return null;
  if (until <= now) return 'expired';
  const volumes: string[][] = [];
  for (const v of vols === '' ? [] : vols.split('~')) {
    const b = Buffer.from(v, 'base64url');
    if (b.length === 0 || b.length % 16 !== 0 || b.toString('base64url') !== v) return null;
    const ids: string[] = [];
    for (let at = 0; at < b.length; at += 16) ids.push(idText(b.subarray(at, at + 16)));
    if (!ids.every(isAttachmentId)) return null;
    volumes.push(ids);
  }
  return { container: owner, until, volumes };
}

/** What a set token binds a plan by. */
export const planDigest = (token: string) => createHash('sha256').update(token).digest('hex');

// ---- The set token (D7) ----

let keyed: { from: string; set: Buffer; plan: Buffer } | null = null;
/** The keys the set token and the plan token are signed with, each its own,
 *  derived from the environment's key. */
function keys(): { set: Buffer; plan: Buffer } {
  const from = process.env.PLAID_ENCRYPTION_KEY ?? '';
  if (keyed?.from !== from) {
    keyed = {
      from,
      set: createHash('sha256').update(`nya-attachments-set-key:${from}`, 'utf8').digest(),
      plan: createHash('sha256').update(`nya-attachments-plan-key:${from}`, 'utf8').digest(),
    };
  }
  return keyed;
}
const setKey = () => keys().set;
function planKey(): Buffer {
  return keys().plan;
}

type SetFacts = { container: string; user: string | null; digest: string; volumes: number };

/** A token for the rest of a set: bound to who asked, the account, the plan
 *  (planDigest) and the number of volumes, for SET_MS from the last volume
 *  served. */
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
  return sameMac(want, mac);
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

/** What a volume's manifest says beside its files: when it was made, which
 *  volume of how many, its planned files left out, for the last volume the
 *  set's (set_left_out), and how many files were added after the plan. */
export type VolumeMeta = { exported_at: string; volume: number; volumes: number; left_out: LeftOut[]; set_left_out?: LeftOut[] | null; added?: number };

const PLACEHOLDER_SHA = '0'.repeat(64);

/** One file's line of the manifest, of fixed width: its digest and whether
 *  it is damaged are filled in once it is written, at the same length. */
function manifestEntry(f: PlannedFile, sha = PLACEHOLDER_SHA, damaged = false): string {
  const line = JSON.stringify({ ...exportedAttachment(f.id, f.record), file: f.name, sha256: sha, damaged: false });
  return damaged ? line.replace('"damaged":false', '"damaged":true ') : line;
}

function manifestText(meta: VolumeMeta, files: PlannedFile[], lines: string[]): string {
  const head = JSON.stringify({
    format: ZIP_FORMAT,
    version: ZIP_VERSION,
    exported_at: meta.exported_at,
    volume: meta.volume,
    volumes: meta.volumes,
    left_out: meta.left_out,
    ...(meta.set_left_out ? { set_left_out: meta.set_left_out } : {}),
    added_since: meta.added ?? 0,
  });
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
    else if (f.record.damaged) await clearDamaged(ctx, f.id);
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
