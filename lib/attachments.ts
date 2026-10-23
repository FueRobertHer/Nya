// lib/attachments.ts
//
// Receipts and documents attached to transactions (#47): a photo of a receipt,
// an invoice or a warranty as a PDF. The stores are lib/attachment-stores.ts,
// the sealing lib/attachment-crypto.ts, the file store lib/attachment-objects.ts,
// the nightly sweep lib/attachment-sweep.ts; the design and its review are in
// docs/architecture.md, "Receipts and documents".
//
// TURNED ON in two steps (docs/operations.md): with a file store connected
// (the Blob token), files already attached can be viewed, moved, renamed,
// deleted and downloaded, the sweep runs and an account's deletion deletes
// them; ADDING one also needs ATTACHMENTS_QUOTA_MB, the most each account may
// keep, so whoever pays for the storage chooses to.
//
// UPLOADS, IN PARTS. The page shrinks and re-encodes a photo first
// (components/attachment-capture.ts), then:
//   1. startUpload: every check, the limits reserved in one compare-and-set
//      (attachment-usage, so uploads at the same moment never pass a limit
//      together), the transaction's index entry written at once (holding at
//      most PER_TRANSACTION, checked in its own compare-and-set), then the
//      record, `uploading`, with its file key wrapped and what each part's
//      SHA-256 must be;
//   2. receivePart, once per part and for the thumbnail: exactly the size and
//      the digest declared (a body cut short by a proxy is refused, never
//      stored short), what its first bytes must be, sealed and put, then
//      recorded; the last one makes it `ready`.
// An upload not finished within UPLOAD_MS is refused further parts; a new start
// releases the person's own expired ones first, and the sweep the rest.
//
// WHERE A FILE IS (Place, lib/attachment-stores.ts): on a transaction by its
// id while the transaction lives, and carried by its content key exactly when
// ids die, at a disconnect, as categories and notes are (lib/overrides.ts,
// lib/txn-annotations.ts). The moves:
//   - a pending row that posts: to the posted row naming it (settleAfterSync);
//   - a posted row the bank removes: to the one row of the same account with
//     its content in the same sync (a re-post under a new id), else not on a
//     transaction (settleAfterSync);
//   - a disconnect: waiting on the earlier account by content
//     (retireAttachments), placed again once the person links it to the
//     re-added one and its history is in, on the one posted row with that
//     content (placeWaiting, from the link and from each sync after);
//   - a forget, a deleted or undone row, an emptied account: not on a
//     transaction, kept and listed (forgetEarlierAttachments,
//     releaseAttachments, releaseAllAttachments).
// A FILE IS NEVER DELETED AS A SIDE EFFECT: only deleteAttachment (the
// person's own) and an account's deletion (lib/account-deletion.ts) delete
// one. Every placement step that fails marks the container for the sweep's
// check (markForCheck), which finds what was missed.
//
// THE RECORD DECIDES, THE INDEX FOLLOWS: each change writes the record first,
// then the index, each in a compare-and-set. A reader that shows a file reads
// its record; only the paperclip and the filter read the index alone.

import type { Ctx } from './containers';
import { hasOwnKey, NoOwnKeyError, DecryptFailedError } from './crypto';
import { findTransactions, type FoundTxn } from './txn-lookup';
import { contentKey, type StoredTxn } from './transactions';
import { getLinks, resolveId, type Link } from './link-core';
import { loggable } from './log-safe';
import {
  attachmentRequests,
  attachmentStore,
  placeStore,
  sweepStateStore,
  usageStore,
  earlierField,
  EARLIER_PREFIX,
  NAME_MAX,
  type Attachment,
  type AttachmentKind,
  type AsPlaced,
  type LooseReason,
  type Place,
  type Usage,
} from './attachment-stores';
import {
  AttachmentDamagedError,
  MAX_FILE_BYTES,
  MAX_THUMB_BYTES,
  PART_BYTES,
  jpegProblem,
  newFileKey,
  openPart,
  partSizes,
  pdfProblem,
  sealPart,
  sha256Hex,
  storedBytes,
  unwrapFileKey,
  wrapFileKey,
  type PartName,
} from './attachment-crypto';
import { attachmentObjects, containerFolder, objectPath, objectPaths, parseObjectPath, withLimit, type AttachmentObjects } from './attachment-objects';
import { attachmentsMode } from './attachments-mode';

// ---- Limits ----

/** The most files one account keeps. */
export const MAX_FILES = 4000;
/** The most files on one transaction. */
export const PER_TRANSACTION = 10;
/** Uploads one account may have in progress at once. */
export const MAX_UPLOADS = 3;
/** How long an upload may take, from its start. */
export const UPLOAD_MS = 60 * 60 * 1000;
/** Starts, parts and views an hour (attachment-requests). */
export const STARTS_PER_HOUR = 60;
export const PARTS_PER_HOUR = 400;
export const VIEWS_PER_HOUR = 1000;
/** How long one call to the file store may take. */
export const STORE_CALL_MS = 20_000;

export { quotaBytes, attachmentsMode } from './attachments-mode';
/** A request refused, with what to say and the status to say it with. */
export class AttachmentRefused extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly retryAfterSeconds?: number
  ) {
    super(message);
    this.name = 'AttachmentRefused';
  }
}

export const OFF_MESSAGE = 'Adding receipts and documents is off on this copy of Nya.';
export const NOT_CONNECTED_MESSAGE = 'Receipts and documents can’t be reached on this copy of Nya just now: no file store is connected.';
export const NO_OWN_KEY_MESSAGE =
  'Receipts and documents need your account’s own data key, which this copy of Nya hasn’t made for it yet. Ask whoever runs it.';

/** A size in words: KB under a megabyte, MB with a decimal under ten, GB
 *  from a thousand and twenty-four. */
export function sizeWords(bytes: number): string {
  const n = bytes / (1024 * 1024);
  if (n >= 1024) return `${(n / 1024).toFixed(1).replace(/\.0$/, '')} GB`;
  if (n >= 10) return `${Math.round(n)} MB`;
  if (n >= 1) return `${n.toFixed(1).replace(/\.0$/, '')} MB`;
  return `${Math.max(1, Math.ceil(bytes / 1024))} KB`;
}
const mb = sizeWords;

/** Counts one request of a kind against its hourly limit, or refuses it. */
export async function countRequest(ctx: Ctx, kind: 'start' | 'part' | 'read', now: number = Date.now()): Promise<void> {
  const limit = kind === 'start' ? STARTS_PER_HOUR : kind === 'part' ? PARTS_PER_HOUR : VIEWS_PER_HOUR;
  const w = await attachmentRequests.take(ctx, kind, now);
  if (w.count > limit) {
    const what = kind === 'read' ? `${VIEWS_PER_HOUR} receipts and documents an hour can be opened` : `${limit} ${kind === 'start' ? 'files' : 'parts of files'} an hour can be sent`;
    throw new AttachmentRefused(429, `At most ${what}. Try again in ${Math.max(1, Math.ceil(w.secondsLeft / 60))} minutes.`, w.secondsLeft);
  }
}

/** The file store, or the refusal for its absence. */
function objects(): AttachmentObjects {
  const store = attachmentObjects();
  if (!store) throw new AttachmentRefused(503, NOT_CONNECTED_MESSAGE);
  return store;
}

// ---- The index ----

/** The index field of a place, or null for a file on no transaction. Too long
 *  a field (an account id far past any provider's) is null too: such a file
 *  is only in the records, which the sweep reads. */
export function fieldOf(place: Place): string | null {
  const field = place.on === 'transaction' ? place.transaction_id : place.on === 'earlier' ? earlierField(place.account_id) : null;
  return field !== null && field.length <= 200 ? field : null;
}

/** Puts `id` in the entry at `field`, refusing past `limit`. */
async function indexAdd(ctx: Ctx, field: string, id: string, limit?: number): Promise<void> {
  await placeStore.update(ctx, field, (cur) => {
    const ids = cur?.ids ?? [];
    if (ids.includes(id)) return cur;
    if (limit !== undefined && ids.length >= limit) {
      throw new AttachmentRefused(409, `A transaction can have at most ${PER_TRANSACTION} receipts and documents. Delete one first.`);
    }
    return { ids: [...ids, id] };
  });
}

/** Takes `id` out of the entry at `field`; an entry left empty goes. */
async function indexRemove(ctx: Ctx, field: string, id: string): Promise<void> {
  await placeStore.update(ctx, field, (cur) => {
    if (!cur || !cur.ids.includes(id)) return cur;
    const ids = cur.ids.filter((x) => x !== id);
    return ids.length > 0 ? { ids } : null;
  });
}

/** Moves `id` from one entry to another (either null for none). */
async function indexMove(ctx: Ctx, from: string | null, to: string | null, id: string): Promise<void> {
  if (from === to) return;
  if (to !== null) await indexAdd(ctx, to, id);
  if (from !== null) await indexRemove(ctx, from, id);
}

/** The transaction ids that have something placed on them (field names
 *  alone, nothing decrypted): for the paperclip and the filter, which say a
 *  transaction has a file without reading its record. */
export async function attachedIds(ctx: Ctx): Promise<Set<string>> {
  return new Set((await placeStore.ids(ctx)).filter((f) => !f.startsWith(EARLIER_PREFIX)));
}

/** Leaves the marker that makes the sweep check this container's placements:
 *  where a placement step failed. Never throws: the sweep's weekly check
 *  finds what this misses. */
export async function markForCheck(ctx: Ctx, now: number = Date.now()): Promise<void> {
  try {
    await sweepStateStore.update(ctx, (cur) => (cur?.check ? cur : { ...(cur ?? { version: 1, unnamed: {} }), check: { since: new Date(now).toISOString() } }));
  } catch (err) {
    console.warn('attachments: could not mark the account for a check of its receipts', loggable(err));
  }
}

// ---- Usage ----

const emptyUsage = (): Usage => ({ version: 1, bytes: 0, files: 0, uploads: {} });

/** What the records say is reserved: every record but none, a record that
 *  can't be read as a full file (never as nothing). `seen`, when given, gets
 *  the id of every record read, readable or not. */
export async function usageFromRecords(ctx: Ctx, base: Usage | null = null, seen?: Set<string>): Promise<Usage> {
  const { entries, unreadable, unrecognised } = await attachmentStore.getAllReport(ctx);
  if (seen) for (const id of [...entries.keys(), ...unreadable, ...unrecognised]) seen.add(id);
  const out: Usage = { version: 1, bytes: 0, files: 0, uploads: {}, ...(base?.zip_at ? { zip_at: base.zip_at } : {}) };
  for (const [id, a] of entries) {
    out.bytes += a.stored_bytes;
    out.files += 1;
    if (a.status === 'uploading' && a.upload) out.uploads[id] = { bytes: a.stored_bytes, expires_at: a.upload.expires_at };
  }
  const unknown = unreadable.length + unrecognised.length;
  out.bytes += unknown * storedBytes(MAX_FILE_BYTES, MAX_THUMB_BYTES);
  out.files += unknown;
  return out;
}

/** Reserves room for one upload, or refuses it: in one compare-and-set, so
 *  uploads started at the same moment can't pass a limit together. */
async function reserve(ctx: Ctx, id: string, bytes: number, quota: number, now: number): Promise<void> {
  await usageStore.update(ctx, async (cur) => {
    const u = cur ?? (await usageFromRecords(ctx));
    const inProgress = Object.values(u.uploads).filter((x) => Date.parse(x.expires_at) > now).length;
    if (u.bytes + bytes > quota) {
      throw new AttachmentRefused(413, `Your receipts and documents use ${mb(u.bytes)} of the ${mb(quota)} this account can keep. Delete some under Manage, Receipts and documents.`);
    }
    if (u.files >= MAX_FILES) throw new AttachmentRefused(413, `This account keeps at most ${MAX_FILES.toLocaleString('en-US')} receipts and documents. Delete some first.`);
    if (inProgress >= MAX_UPLOADS) throw new AttachmentRefused(429, `At most ${MAX_UPLOADS} files can be sent at once. Wait for one to finish.`);
    return { ...u, bytes: u.bytes + bytes, files: u.files + 1, uploads: { ...u.uploads, [id]: { bytes, expires_at: new Date(now + UPLOAD_MS).toISOString() } } };
  });
}

/** Gives back what a file reserved (`file`: it is gone, so its bytes and its
 *  count too), or only its upload's place in progress once it is ready.
 *  Called only by the one call that removed the file's record (review 4: a
 *  second delete of the same file, or a race with the sweep, gives nothing
 *  back twice); `held` gives back only what the uploads in progress still
 *  hold for it, for an upload whose record was never written. */
async function release(ctx: Ctx, id: string, bytes: number, file: boolean, opts: { held?: boolean } = {}): Promise<void> {
  await usageStore.update(ctx, (cur) => {
    if (!cur) return cur;
    if (opts.held && !cur.uploads[id]) return cur;
    const uploads = { ...cur.uploads };
    delete uploads[id];
    if (!file) return { ...cur, uploads };
    return { ...cur, bytes: Math.max(0, cur.bytes - bytes), files: Math.max(0, cur.files - 1), uploads };
  });
}

/** Removes a record in the state `status`, answering whether this call
 *  removed it (not one that found it gone already, nor in another state). */
async function removeRecord(ctx: Ctx, id: string, status: Attachment['status']): Promise<boolean> {
  let removed = false;
  await attachmentStore.update(ctx, id, (cur) => {
    removed = false;
    if (!cur || cur.status !== status) return cur;
    removed = true;
    return null;
  });
  return removed;
}

/** What the card shows: what is used, of how much. */
export async function readUsage(ctx: Ctx): Promise<Usage> {
  return (await usageStore.get(ctx)) ?? (await usageFromRecords(ctx));
}

// ---- Starting an upload ----

export type StartInput = {
  transaction_id: string;
  kind: AttachmentKind;
  bytes: number;
  part_sha256: string[];
  thumb: { bytes: number; sha256: string } | null;
  name: string | null;
};

/** What its transaction says, for a file placed on it. */
const asPlacedOf = (t: FoundTxn): AsPlaced => ({ date: t.date, amount: t.amount, currency: t.currency, name: t.name.slice(0, 500) });
const placeOn = (t: FoundTxn): Place => ({ on: 'transaction', transaction_id: t.transaction_id, account_id: t.account_id, content: t.content ?? null });

/** A string with no lone surrogate (each becomes U+FFFD), as
 *  String.prototype.toWellFormed does. */
export function wellFormed(s: string): string {
  return s.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '\uFFFD');
}

/** A file's name as kept: trimmed, without control characters or path
 *  separators, at most NAME_MAX characters, cut between characters, never
 *  inside one (review 5: half an emoji made the file impossible to send);
 *  empty is none. NAME_MAX counts UTF-16 units, as the record's check does,
 *  so a name of emoji keeps fewer of them. */
export function cleanName(raw: string | null): string | null {
  if (raw === null) return null;
  const chars = Array.from(
    wellFormed(raw)
      .normalize('NFC')
      .replace(/[\u0000-\u001f\u007f/\\]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
  );
  let name = '';
  for (const ch of chars) {
    if (name.length + ch.length > NAME_MAX) break;
    name += ch;
  }
  name = name.trim();
  return name.length > 0 ? name : null;
}

/** Releases the person's own uploads that ran out of time (their objects,
 *  then the record), so one never holds the quota or a place in progress
 *  until the sweep. Best effort: the sweep does it too. */
async function releaseExpired(ctx: Ctx, now: number): Promise<void> {
  const usage = await usageStore.get(ctx);
  for (const [id, u] of Object.entries(usage?.uploads ?? {})) {
    if (Date.parse(u.expires_at) > now) continue;
    await discardUpload(ctx, id, now).catch((err) => console.warn('attachments: an expired upload was left for the sweep', loggable(err)));
  }
}

/** Throws away an upload that ran out of time, or was cancelled: its objects
 *  first (by their computed paths), then its record, its index entry and what
 *  it reserved. Only an upload, never a ready file. */
export async function discardUpload(ctx: Ctx, id: string, now: number, opts: { cancelled?: boolean } = {}): Promise<boolean> {
  const record = await attachmentStore.get(ctx, id);
  if (record && record.status !== 'uploading') return false;
  if (record && !opts.cancelled && Date.parse(record.upload!.expires_at) > now) return false;
  if (record) {
    const store = objects();
    await withLimit('a delete', STORE_CALL_MS, (signal) => store.del(objectPaths(ctx, id, record.parts, record.thumb_bytes !== null), signal));
    if (!(await removeRecord(ctx, id, 'uploading'))) return false;
    const field = fieldOf(record.place);
    if (field) await indexRemove(ctx, field, id);
    await release(ctx, id, record.stored_bytes, true);
    return true;
  }
  // No record: only what it reserved, if anything.
  const usage = await usageStore.get(ctx);
  const held = usage?.uploads[id];
  if (held) await release(ctx, id, held.bytes, true, { held: true });
  return Boolean(held);
}

/**
 * Starts an upload (see the header): answers the new attachment's id and
 * the size of each part. AttachmentRefused for anything the request can't
 * have; LookupUnreadableError when whether the transaction is stored can't
 * be told; NoOwnKeyError is answered as a refusal.
 */
export async function startUpload(ctx: Ctx, input: StartInput, now: number = Date.now()): Promise<{ id: string; part_bytes: number; parts: number }> {
  const mode = attachmentsMode();
  if (!mode.connected) throw new AttachmentRefused(503, NOT_CONNECTED_MESSAGE);
  if (!mode.uploads || mode.quota_bytes === null) throw new AttachmentRefused(403, OFF_MESSAGE);
  if (!(await hasOwnKey(ctx))) throw new AttachmentRefused(409, NO_OWN_KEY_MESSAGE);
  const sizes = partSizes(input.bytes);
  if (input.bytes > MAX_FILE_BYTES) throw new AttachmentRefused(413, `A file can be at most ${mb(MAX_FILE_BYTES)}.`);
  if (sizes.length === 0 || sizes.length !== input.part_sha256.length) throw new AttachmentRefused(400, 'The parts don’t match the file’s size.');
  if (input.kind === 'pdf' && input.thumb) throw new AttachmentRefused(400, 'A PDF has no thumbnail here.');
  if (input.thumb && (input.thumb.bytes < 1 || input.thumb.bytes > MAX_THUMB_BYTES)) throw new AttachmentRefused(413, 'The thumbnail is too large.');
  await countRequest(ctx, 'start', now);
  await releaseExpired(ctx, now);

  const found = (await findTransactions(ctx, [input.transaction_id])).get(input.transaction_id);
  if (!found) throw new AttachmentRefused(404, 'That transaction isn’t stored.');

  const id = crypto.randomUUID();
  const stored = storedBytes(input.bytes, input.thumb?.bytes ?? null);
  await reserve(ctx, id, stored, mode.quota_bytes, now);
  const place = placeOn(found);
  const field = fieldOf(place);
  try {
    // At once, so a sync that posts or removes the row while this uploads
    // moves the file with the rest; readers check the record anyway.
    if (field) await indexAdd(ctx, field, id, PER_TRANSACTION);
    const record: Attachment = {
      version: 1,
      status: 'uploading',
      kind: input.kind,
      bytes: input.bytes,
      parts: sizes.length,
      thumb_bytes: input.thumb?.bytes ?? null,
      stored_bytes: stored,
      file_key: await wrapFileKey(ctx, id, newFileKey()),
      name: cleanName(input.name),
      place,
      as_placed: asPlacedOf(found),
      created_at: new Date(now).toISOString(),
      upload: {
        part_sha256: input.part_sha256,
        thumb_sha256: input.thumb?.sha256 ?? null,
        received: [],
        thumb_received: false,
        expires_at: new Date(now + UPLOAD_MS).toISOString(),
      },
    };
    await attachmentStore.set(ctx, id, record);
  } catch (err) {
    if (field) await indexRemove(ctx, field, id).catch(() => {});
    await release(ctx, id, stored, true).catch(() => {});
    if (err instanceof NoOwnKeyError) throw new AttachmentRefused(409, NO_OWN_KEY_MESSAGE);
    throw err;
  }
  return { id, part_bytes: PART_BYTES, parts: sizes.length };
}

// ---- Receiving a part ----

/** What part 0 of a file, or a thumbnail, must start as. */
function bytesProblem(kind: AttachmentKind, part: PartName, bytes: Uint8Array): string | null {
  if (part === 't') return jpegProblem(bytes);
  if (part !== 0) return null;
  return kind === 'image' ? jpegProblem(bytes) : pdfProblem(bytes);
}

/**
 * Stores one part of an upload, or its thumbnail (see the header). Answers
 * whether the file is ready now. The record is read again after the put: an
 * upload cancelled or swept meanwhile has the object just put deleted.
 */
export async function receivePart(ctx: Ctx, id: string, part: PartName, body: Uint8Array, now: number = Date.now()): Promise<{ ready: boolean }> {
  const mode = attachmentsMode();
  if (!mode.connected) throw new AttachmentRefused(503, NOT_CONNECTED_MESSAGE);
  if (!mode.uploads) throw new AttachmentRefused(403, OFF_MESSAGE);
  await countRequest(ctx, 'part', now);
  const record = await attachmentStore.get(ctx, id);
  if (!record || record.status !== 'uploading' || !record.upload) throw new AttachmentRefused(404, 'There is no upload of that file in progress.');
  if (Date.parse(record.upload.expires_at) <= now) throw new AttachmentRefused(410, 'This upload took too long. Start it again.');
  const sizes = partSizes(record.bytes);
  let expected: { size: number; sha: string };
  if (part === 't') {
    if (record.thumb_bytes === null || record.upload.thumb_sha256 === null) throw new AttachmentRefused(400, 'This file has no thumbnail.');
    expected = { size: record.thumb_bytes, sha: record.upload.thumb_sha256 };
  } else {
    if (!Number.isInteger(part) || part < 0 || part >= sizes.length) throw new AttachmentRefused(400, 'There is no such part of this file.');
    expected = { size: sizes[part], sha: record.upload.part_sha256[part] };
  }
  if (body.length !== expected.size || (await sha256Hex(body)) !== expected.sha) {
    throw new AttachmentRefused(400, 'This part didn’t arrive whole. Send it again.');
  }
  const problem = bytesProblem(record.kind, part, body);
  if (problem) throw new AttachmentRefused(415, problem);

  const key = await unwrapFileKey(ctx, id, record.file_key!);
  const sealed = await sealPart(key, ctx.container, id, part, record.parts, body);
  const store = objects();
  const path = objectPath(ctx, id, part);
  await withLimit('a part', 30_000, (signal) => store.put(path, sealed, signal));

  let ready = false;
  const after = await attachmentStore.update(ctx, id, (cur) => {
    if (!cur || cur.status !== 'uploading' || !cur.upload) return cur;
    const upload = { ...cur.upload };
    if (part === 't') upload.thumb_received = true;
    else if (!upload.received.includes(part)) upload.received = [...upload.received, part].sort((a, b) => a - b);
    const whole = upload.received.length === cur.parts && (cur.thumb_bytes === null || upload.thumb_received);
    if (!whole) return { ...cur, upload };
    const next: Attachment = { ...cur, status: 'ready', ready_at: new Date(now).toISOString() };
    delete next.upload;
    return next;
  });
  if (!after || after.status === 'deleting') {
    // Cancelled or swept while this part was on its way: nothing of it stays.
    await withLimit('a delete', STORE_CALL_MS, (signal) => store.del([path], signal)).catch(() => {});
    throw new AttachmentRefused(404, 'There is no upload of that file in progress.');
  }
  if (after.status === 'ready' && record.status === 'uploading') {
    ready = true;
    await release(ctx, id, after.stored_bytes, false).catch((err) => console.warn('attachments: an upload stayed counted as in progress', loggable(err)));
  }
  return { ready };
}

// ---- Reading ----

/** The file isn't in the store any more (an older backup's record, say). */
export class AttachmentGoneError extends Error {
  constructor() {
    super('This file isn’t in storage any more.');
    this.name = 'AttachmentGoneError';
  }
}

/**
 * One ready file, or its thumbnail, opened whole before anything is sent: a
 * part that is missing (AttachmentGoneError) or doesn't open
 * (AttachmentDamagedError, and the record is marked `damaged`) is found
 * before a header goes out, never half way through a response.
 */
export async function readFile(ctx: Ctx, id: string, which: 'file' | 'thumb'): Promise<{ record: Attachment; bytes: Uint8Array }> {
  const record = await attachmentStore.get(ctx, id);
  if (!record || record.status !== 'ready') throw new AttachmentRefused(404, 'There is no such receipt or document.');
  if (which === 'thumb' && (record.thumb_bytes === null || record.thumb_damaged)) throw new AttachmentRefused(404, 'This file has no thumbnail.');
  const store = objects();
  try {
    const key = await unwrapFileKey(ctx, id, record.file_key!);
    const names: PartName[] = which === 'thumb' ? ['t'] : partSizes(record.bytes).map((_, i) => i);
    const pieces: Uint8Array[] = [];
    for (const part of names) {
      const stored = await withLimit('a read', STORE_CALL_MS, (signal) => store.get(objectPath(ctx, id, part), signal));
      if (stored === null) throw new AttachmentGoneError();
      pieces.push(await openPart(key, ctx.container, id, part, record.parts, stored));
    }
    const bytes = new Uint8Array(pieces.reduce((n, p) => n + p.length, 0));
    let at = 0;
    for (const p of pieces) {
      bytes.set(p, at);
      at += p.length;
    }
    // Opened whole: a mark from a read that failed before (a store that
    // answered badly once) is cleared.
    if (which === 'file' && record.damaged) await clearDamaged(ctx, id);
    return { record, bytes };
  } catch (err) {
    if (err instanceof AttachmentDamagedError || err instanceof DecryptFailedError) {
      // A thumbnail that doesn't open loses its thumbnail, never the file
      // (review 7): the file's own parts may be fine.
      if (which === 'thumb') await markThumbDamaged(ctx, id);
      else await markDamaged(ctx, id);
      throw err instanceof AttachmentDamagedError ? err : new AttachmentDamagedError();
    }
    throw err;
  }
}

/** Marks a file damaged: the viewer says so. The ZIP tries it again, and a
 *  read that opens it whole clears the mark. */
export async function markDamaged(ctx: Ctx, id: string): Promise<void> {
  await attachmentStore.update(ctx, id, (cur) => (cur && !cur.damaged ? { ...cur, damaged: true } : cur)).catch(() => {});
}

/** Clears the mark once the file opened whole. */
export async function clearDamaged(ctx: Ctx, id: string): Promise<void> {
  await attachmentStore
    .update(ctx, id, (cur) => {
      if (!cur || !cur.damaged) return cur;
      const next = { ...cur };
      delete next.damaged;
      return next;
    })
    .catch(() => {});
}

/** Marks a thumbnail that doesn't open: the file is shown without one. */
async function markThumbDamaged(ctx: Ctx, id: string): Promise<void> {
  await attachmentStore.update(ctx, id, (cur) => (cur && !cur.thumb_damaged ? { ...cur, thumb_damaged: true } : cur)).catch(() => {});
}

/** What the page is told of a file: never its key, its upload or a path. */
export type AttachmentView = {
  id: string;
  kind: AttachmentKind;
  bytes: number;
  thumb: boolean;
  name: string | null;
  created_at: string;
  place:
    | { on: 'transaction'; transaction_id: string; carried?: true; check?: true; posting?: true }
    | { on: 'earlier'; account_id: string; pending: boolean; alike: number }
    | { on: 'none'; why: LooseReason; since: string };
  as_placed: AsPlaced | null;
  damaged?: true;
};

export function viewOf(id: string, a: Attachment): AttachmentView {
  const place: AttachmentView['place'] =
    a.place.on === 'transaction'
      ? {
          on: 'transaction',
          transaction_id: a.place.transaction_id,
          ...(a.place.carried ? { carried: true as const } : {}),
          ...(a.place.check ? { check: true as const } : {}),
          ...(a.place.posting ? { posting: true as const } : {}),
        }
      : a.place.on === 'earlier'
        ? { on: 'earlier', account_id: a.place.account_id, pending: a.place.pending, alike: a.place.alike }
        : { on: 'none', why: a.place.why, since: a.place.since };
  return {
    id,
    kind: a.kind,
    bytes: a.bytes,
    thumb: a.thumb_bytes !== null && !a.thumb_damaged,
    name: a.name,
    created_at: a.created_at,
    place,
    as_placed: a.as_placed,
    ...(a.damaged ? { damaged: true as const } : {}),
  };
}

/** Every ready file, newest first, with what can't be read named (strict:
 *  never "none" for what can't be read), and how many are being deleted. */
export async function listAttachments(ctx: Ctx): Promise<{ files: AttachmentView[]; unreadable: string[]; unrecognised: string[]; deleting: number }> {
  const { entries, unreadable, unrecognised } = await attachmentStore.getAllReport(ctx);
  const files: AttachmentView[] = [];
  let deleting = 0;
  for (const [id, a] of entries) {
    if (a.status === 'ready') files.push(viewOf(id, a));
    else if (a.status === 'deleting') deleting++;
  }
  files.sort((x, y) => (x.created_at < y.created_at ? 1 : x.created_at > y.created_at ? -1 : x.id < y.id ? -1 : 1));
  return { files, unreadable, unrecognised, deleting };
}

/**
 * The ready files on these transactions (a row and the rows it stands for,
 * as the read layer says: `attached_on`), from their index entries, each
 * checked against its record. An entry naming a file whose record is
 * readable and placed elsewhere (a crash between the record and the index)
 * is put right here, for the one entry read.
 */
export async function attachmentsOn(ctx: Ctx, transaction_ids: readonly string[]): Promise<AttachmentView[]> {
  const entries = await placeStore.getMany(ctx, transaction_ids);
  const ids = [...new Set([...entries.values()].flatMap((e) => e.ids))];
  if (ids.length === 0) return [];
  const records = await attachmentStore.getMany(ctx, ids);
  const out: AttachmentView[] = [];
  for (const [field, entry] of entries) {
    for (const id of entry.ids) {
      const a = records.get(id);
      if (a && a.status === 'ready' && a.place.on === 'transaction' && a.place.transaction_id === field) out.push(viewOf(id, a));
      // Stale: a readable record that isn't uploading and is placed elsewhere,
      // or no record at all.
      else if (!a || (a.status !== 'uploading' && !(a.place.on === 'transaction' && a.place.transaction_id === field))) {
        await indexRemove(ctx, field, id).catch(() => {});
      }
    }
  }
  return out.sort((x, y) => (x.created_at < y.created_at ? -1 : 1));
}

// ---- The person's changes ----

/** Moves a ready file to another transaction (the person's choice). */
export async function moveAttachment(ctx: Ctx, id: string, transaction_id: string): Promise<AttachmentView> {
  const record = await attachmentStore.get(ctx, id);
  if (!record || record.status !== 'ready') throw new AttachmentRefused(404, 'There is no such receipt or document.');
  const found = (await findTransactions(ctx, [transaction_id])).get(transaction_id);
  if (!found) throw new AttachmentRefused(404, 'That transaction isn’t stored.');
  const place = placeOn(found);
  const to = fieldOf(place);
  if (to) await indexAdd(ctx, to, id, record.place.on === 'transaction' && record.place.transaction_id === transaction_id ? undefined : PER_TRANSACTION);
  let from: string | null = null;
  const after = await attachmentStore.update(ctx, id, (cur) => {
    if (!cur || cur.status !== 'ready') return cur;
    from = fieldOf(cur.place);
    return { ...cur, place, as_placed: asPlacedOf(found) };
  });
  if (!after || after.status !== 'ready') {
    if (to) await indexRemove(ctx, to, id).catch(() => {});
    throw new AttachmentRefused(404, 'There is no such receipt or document.');
  }
  if (from !== null && from !== to) await indexRemove(ctx, from, id).catch(() => markForCheck(ctx));
  return viewOf(id, after);
}

/** Renames a file (null clears the name). */
export async function renameAttachment(ctx: Ctx, id: string, name: string | null): Promise<AttachmentView> {
  const after = await attachmentStore.update(ctx, id, (cur) => (cur && cur.status === 'ready' ? { ...cur, name: cleanName(name) } : cur));
  if (!after || after.status !== 'ready') throw new AttachmentRefused(404, 'There is no such receipt or document.');
  return viewOf(id, after);
}

/**
 * Deletes a file, the person's own choice (see "What deleted means" in
 * docs/architecture.md): its key leaves the database in the first step (the
 * record is `deleting`, with no key), its index entry goes, its objects are
 * deleted, then the record and what it reserved. If the file store can't be
 * reached, it answers `finished: false`: the file can't be opened any more,
 * and the sweep deletes its objects and its record later.
 */
export async function deleteAttachment(ctx: Ctx, id: string): Promise<{ finished: boolean }> {
  const seen: { before: Attachment | null } = { before: null };
  const after = await attachmentStore.update(ctx, id, (cur) => {
    seen.before = cur;
    if (!cur || cur.status === 'deleting') return cur;
    const next: Attachment = { ...cur, status: 'deleting', file_key: null };
    return next;
  });
  if (!seen.before || !after) throw new AttachmentRefused(404, 'There is no such receipt or document.');
  const field = fieldOf(seen.before.place);
  if (field) await indexRemove(ctx, field, id).catch(() => markForCheck(ctx));
  try {
    await finishDelete(ctx, id, after);
    return { finished: true };
  } catch (err) {
    console.warn('attachments: a deleted file’s objects were left for the sweep', loggable(err));
    return { finished: false };
  }
}

/** The rest of a delete, for deleteAttachment and the sweep: the objects,
 *  then the record, then what it reserved. */
export async function finishDelete(ctx: Ctx, id: string, record: Attachment): Promise<void> {
  const store = objects();
  await withLimit('a delete', STORE_CALL_MS, (signal) => store.del(objectPaths(ctx, id, record.parts, record.thumb_bytes !== null), signal));
  if (await removeRecord(ctx, id, 'deleting')) await release(ctx, id, record.stored_bytes, true);
}

// ---- Moves the app makes (see the header) ----

/** Moves one file to a new place, the record first, then the index. `fn`
 *  answers the new place and what its transaction says, or null to leave it
 *  (it is given the record as it is now, and may run more than once). */
async function movePlace(ctx: Ctx, id: string, fn: (cur: Attachment) => { place: Place; as_placed?: AsPlaced | null } | null): Promise<boolean> {
  let from: string | null = null;
  let to: string | null = null;
  let moved = false;
  await attachmentStore.update(ctx, id, (cur) => {
    moved = false;
    if (!cur || cur.status === 'deleting') return cur;
    const next = fn(cur);
    if (!next) return cur;
    from = fieldOf(cur.place);
    to = fieldOf(next.place);
    moved = true;
    return { ...cur, place: next.place, ...(next.as_placed !== undefined ? { as_placed: next.as_placed } : {}) };
  });
  if (moved) await indexMove(ctx, from, to, id);
  return moved;
}

const was = (p: Place): { transaction_id: string | null; account_id: string | null; content: string | null } | undefined =>
  p.on === 'transaction' ? { transaction_id: p.transaction_id, account_id: p.account_id, content: p.content } : p.on === 'earlier' ? { transaction_id: null, account_id: p.account_id, content: p.content } : p.was;

/** A file not on a transaction now, remembering where it was. */
const loose = (cur: Place, why: LooseReason, now: number): Place => ({ on: 'none', why, since: new Date(now).toISOString(), ...(was(cur) ? { was: was(cur)! } : {}) });

const asPlacedOfRow = (t: StoredTxn): AsPlaced => ({
  date: t.date,
  amount: t.amount,
  currency: t.iso_currency_code ?? t.unofficial_currency_code ?? null,
  name: (t.merchant_name || t.name).slice(0, 500),
});
const placeOnRow = (t: StoredTxn, extra: { carried?: true } = {}): Place => ({
  on: 'transaction',
  transaction_id: t.transaction_id,
  account_id: t.account_id,
  content: t.pending ? null : contentKey(t.account_id, t),
  ...extra,
});

/** The ids placed on these fields, read from the index (strict). */
async function placedOn(ctx: Ctx, fields: readonly string[]): Promise<Map<string, string[]>> {
  if (fields.length === 0) return new Map();
  const out = new Map<string, string[]>();
  for (let i = 0; i < fields.length; i += 500) {
    for (const [field, entry] of await placeStore.getMany(ctx, fields.slice(i, i + 500))) out.set(field, entry.ids);
  }
  return out;
}

/** The fields of the index among these transaction ids (one HKEYS). */
async function indexedAmong(ctx: Ctx, ids: Iterable<string>): Promise<string[]> {
  const wanted = new Set(ids);
  if (wanted.size === 0) return [];
  return (await placeStore.ids(ctx)).filter((f) => wanted.has(f));
}

/** The key a content key has under the account's current id, following the
 *  links, or null when the account isn't linked to anything (as
 *  lib/txn-annotations.ts does for what carries). */
function currentContent(content: string, account_id: string, links: ReadonlyMap<string, Pick<Link, 'to'>>): string | null {
  const current = resolveId(account_id, links);
  if (current === account_id || !content.startsWith(`${account_id}|`)) return null;
  return current + content.slice(account_id.length);
}

/** What one sync of an Item changed (lib/transactions.ts): the ids it
 *  removed, the ids it added (rows its stored state didn't hold before), and
 *  every row stored now. `historyIn`: the connection's history has all
 *  arrived (no first pull or older history still coming), which placing a
 *  carried file waits for. */
export type SyncChange = { removed: ReadonlySet<string>; added: ReadonlySet<string>; rows: readonly StoredTxn[]; historyIn: boolean };

/** How long a file waits on a pending row that went with no posted row
 *  naming it, before it is not on a transaction (the sweep's check). Plaid
 *  posts most within days; a card hold can take two weeks. */
export const POSTING_WAIT_MS = 14 * 86_400_000;

/**
 * After a sync saved an Item's rows (lib/transactions.ts):
 *   - a file on a pending row moves to the posted row naming it
 *     (pending_transaction_id), in this sync or any later one: a pending row
 *     that went with no posted row naming it yet keeps its files on its id,
 *     `posting` (review 2), and the sweep's check loosens them only after
 *     POSTING_WAIT_MS;
 *   - a file on a posted row the bank removed moves to the one row with its
 *     content that this sync ADDED (a re-post under a new id), never to one
 *     stored before, which may be an identical purchase with receipts of its
 *     own (review 3); otherwise it is not on a transaction any more;
 *   - files waiting on earlier accounts linked to this Item's accounts are
 *     placed where they can be (placeWaiting).
 * Never throws: a step that fails marks the container for the sweep's check.
 */
export async function settleAfterSync(ctx: Ctx, change: SyncChange, now: number = Date.now()): Promise<void> {
  const { removed, added, rows, historyIn } = change;
  try {
    const posted = new Map<string, StoredTxn>();
    const addedByContent = new Map<string, StoredTxn[]>();
    const stored = new Set<string>();
    for (const t of rows) {
      stored.add(t.transaction_id);
      if (t.pending) continue;
      if (t.pending_transaction_id) posted.set(t.pending_transaction_id, t);
      if (!added.has(t.transaction_id)) continue;
      const k = contentKey(t.account_id, t);
      addedByContent.set(k, [...(addedByContent.get(k) ?? []), t]);
    }
    // The rows removed now, and the pending ids a posted row names that no
    // stored row has: files may wait on one of those since an earlier sync.
    const fields = await indexedAmong(ctx, [...removed, ...[...posted.keys()].filter((p) => !stored.has(p))]);
    let wait = false;
    for (const [field, ids] of await placedOn(ctx, fields)) {
      for (const id of ids) {
        await movePlace(ctx, id, (cur) => {
          if (cur.place.on !== 'transaction' || cur.place.transaction_id !== field) return null;
          const after = posted.get(field);
          if (after) return { place: placeOnRow(after), as_placed: asPlacedOfRow(after) };
          if (!removed.has(field)) return null;
          // A pending row (no content of its own) that went with nothing
          // naming it yet: its files wait on its id for the posted row.
          if (cur.place.content === null) {
            wait = true;
            return cur.place.posting ? null : { place: { ...cur.place, posting: new Date(now).toISOString() } };
          }
          const same = (addedByContent.get(cur.place.content) ?? []).filter((t) => t.transaction_id !== field);
          if (same.length === 1) return { place: placeOnRow(same[0]), as_placed: asPlacedOfRow(same[0]) };
          return { place: loose(cur.place, 'removed', now) };
        });
      }
    }
    if (wait) await markForCheck(ctx, now);
  } catch (err) {
    console.warn('attachments: the files on transactions the bank changed were left for the sweep', loggable(err));
    await markForCheck(ctx, now);
  }
  await placeWaiting(ctx, rows, historyIn, now);
}

/**
 * Places the files waiting on earlier accounts that are now linked to the
 * accounts of these rows (one connection's, as just stored): each on the one
 * posted row with its content under the current account's id, once the
 * connection's history is in (`historyIn`) and that row is after its oldest
 * stored day, and only when its content was one transaction's (`alike` 1)
 * and is one row's now. Others wait. One small read when nothing waits.
 * Never throws: a step that fails marks the container for the check.
 */
export async function placeWaiting(ctx: Ctx, rows: readonly StoredTxn[], historyIn: boolean, now: number = Date.now()): Promise<number> {
  try {
    const accounts = new Set(rows.map((t) => t.account_id));
    if (accounts.size === 0) return 0;
    const links = await getLinks(ctx);
    const olds = [...links.keys()].filter((old) => !accounts.has(old) && accounts.has(resolveId(old, links)));
    if (olds.length === 0) return 0;
    const waiting = await placedOn(ctx, olds.map(earlierField));
    if (waiting.size === 0) return 0;
    if (!historyIn) return 0;
    const oldest = rows.reduce<string | null>((d, t) => (d === null || t.date < d ? t.date : d), null);
    const byContent = new Map<string, StoredTxn[]>();
    for (const t of rows) {
      if (t.pending) continue;
      const k = contentKey(t.account_id, t);
      byContent.set(k, [...(byContent.get(k) ?? []), t]);
    }
    let placed = 0;
    for (const ids of waiting.values()) {
      for (const id of ids) {
        const moved = await movePlace(ctx, id, (cur) => {
          if (cur.place.on !== 'earlier' || cur.place.alike !== 1 || cur.place.pending) return null;
          const key = currentContent(cur.place.content, cur.place.account_id, links);
          const same = key ? (byContent.get(key) ?? []) : [];
          if (same.length !== 1 || oldest === null || !(oldest < same[0].date)) return null;
          return { place: placeOnRow(same[0], { carried: true }), as_placed: asPlacedOfRow(same[0]) };
        });
        if (moved) placed++;
      }
    }
    return placed;
  } catch (err) {
    console.warn('attachments: files waiting on an earlier account were left for the sweep', loggable(err));
    await markForCheck(ctx, now);
    return 0;
  }
}

/** Right after the person links an earlier account to `to`
 *  (lib/links.ts linkAccounts): the files waiting on it are placed on the
 *  linked account's stored rows where they can be (placeWaiting), so they
 *  show at once rather than at the next sync. Never throws. */
export async function placeAfterLink(ctx: Ctx, to: string, now: number = Date.now()): Promise<void> {
  try {
    const { getItems } = await import('./storage');
    const { readStoredItem } = await import('./transactions');
    for (const item of await getItems(ctx)) {
      const stored = await readStoredItem(ctx, item.item_id);
      if (!Object.hasOwn(stored.accounts, to) && !Object.values(stored.txns).some((t) => t.account_id === to)) continue;
      await placeWaiting(ctx, Object.values(stored.txns), !stored.history_pending, now);
      return;
    }
  } catch (err) {
    console.warn('attachments: files waiting on a linked account were left for the next sync', loggable(err));
    await markForCheck(ctx, now);
  }
}

/** Five days, in ms: how far apart a pending row and a posted one can be
 *  dated and still be taken for the same purchase when counting alike. */
const ALIKE_DAYS_MS = 5 * 86_400_000;
const cents = (n: number) => Math.round(n * 100);
const words = (t: { name: string }) => t.name.toLowerCase().replace(/\s+/g, ' ').trim();

/** How many of the account's rows look like this one (its own included): the
 *  posted rows with its content, and the pending ones with its amount and
 *  words within a few days. */
function alikeCount(t: StoredTxn, rows: readonly StoredTxn[]): number {
  const k = contentKey(t.account_id, t);
  let n = 0;
  for (const r of rows) {
    if (r.account_id !== t.account_id) continue;
    if (!r.pending && contentKey(r.account_id, r) === k) n++;
    else if (r.pending && r.transaction_id !== t.transaction_id && cents(r.amount) === cents(t.amount) && words(r) === words(t) && Math.abs(Date.parse(r.date) - Date.parse(t.date)) <= ALIKE_DAYS_MS) n++;
    else if (r.pending && r.transaction_id === t.transaction_id) n++;
  }
  return Math.max(1, n);
}

/**
 * At a disconnect (lib/disconnect-item.ts), before the Item's rows go: every
 * file on one of them waits on its earlier account by content. Throws if
 * storage fails; the caller must not let that stop the disconnect, and marks
 * the container (the sweep then places them from the content kept at
 * attach time).
 */
export async function retireAttachments(ctx: Ctx, stored: readonly StoredTxn[], now: number = Date.now()): Promise<number> {
  const byId = new Map(stored.map((t) => [t.transaction_id, t]));
  const fields = await indexedAmong(ctx, byId.keys());
  let n = 0;
  for (const [field, ids] of await placedOn(ctx, fields)) {
    const t = byId.get(field)!;
    for (const id of ids) {
      const moved = await movePlace(ctx, id, (cur) =>
        cur.place.on === 'transaction' && cur.place.transaction_id === field
          ? { place: { on: 'earlier', account_id: t.account_id, content: contentKey(t.account_id, t), alike: alikeCount(t, stored), pending: t.pending } }
          : null
      );
      if (moved) n++;
    }
  }
  return n;
}

/** When the person forgets an earlier account (lib/links.ts): the files
 *  waiting on it are not on a transaction any more, kept. Never throws. */
export async function forgetEarlierAttachments(ctx: Ctx, account_id: string, now: number = Date.now()): Promise<void> {
  try {
    const field = earlierField(account_id);
    for (const [, ids] of await placedOn(ctx, [field])) {
      for (const id of ids) await movePlace(ctx, id, (cur) => (cur.place.on === 'earlier' && cur.place.account_id === account_id ? { place: loose(cur.place, 'forgotten', now) } : null));
    }
  } catch (err) {
    console.warn('attachments: the files of a forgotten account were left for the sweep', loggable(err));
    await markForCheck(ctx, now);
  }
}

/** When transactions go that keep their own ids (a manual row deleted, a
 *  manual account deleted, an import undone, an account let go:
 *  lib/split-gone.ts): their files are not on a transaction any more, kept.
 *  Throws if storage fails, after marking the container for the check. */
export async function releaseAttachments(ctx: Ctx, transaction_ids: readonly string[], why: LooseReason = 'gone', now: number = Date.now()): Promise<void> {
  try {
    const fields = await indexedAmong(ctx, transaction_ids);
    for (const [field, ids] of await placedOn(ctx, fields)) {
      for (const id of ids) await movePlace(ctx, id, (cur) => (cur.place.on === 'transaction' && cur.place.transaction_id === field ? { place: loose(cur.place, why, now) } : null));
    }
  } catch (err) {
    await markForCheck(ctx, now);
    throw err;
  }
}

/** After an account is emptied, or a restore undone (lib/account-deletion.ts
 *  sweepContainerExcept): every file is kept, not on a transaction, and the
 *  index (which the emptying deleted) has nothing left to say. A record that
 *  can't be read is left as it is. */
export async function releaseAllAttachments(ctx: Ctx, now: number = Date.now()): Promise<number> {
  const { entries } = await attachmentStore.getAllReport(ctx);
  let n = 0;
  for (const [id, a] of entries) {
    if (a.place.on === 'none' || a.status === 'deleting') continue;
    await attachmentStore.update(ctx, id, (cur) => (cur && cur.place.on !== 'none' ? { ...cur, place: loose(cur.place, 'emptied', now) } : cur));
    n++;
  }
  // Anything the emptying didn't take (an entry written since), gone too.
  const left = await placeStore.ids(ctx);
  if (left.length > 0) await placeStore.remove(ctx, ...left);
  return n;
}

// ---- When the account goes ----

/** The time step 3b of an account's deletion may take in all (review 8):
 *  the route's 300 seconds must leave room for the records and the key. */
export const DELETE_FILES_MS = 30_000;

/**
 * Every object in the account's folder of the file store, deleted, for its
 * deletion (lib/account-deletion.ts step 3b): how many files went, and how
 * many were left (the store out of reach, or its time up: DELETE_FILES_MS
 * in all, so a slow store at an account's 4,000 files can't use the route's
 * time before the records and the key go), null when the folder couldn't
 * even be listed, undefined when no file store is connected (so none can
 * have been kept). Never throws: once the account's key is destroyed,
 * whatever is left can't be read, and the nightly sweep deletes a deleted
 * account's folder.
 */
export async function deleteContainerFiles(ctx: Ctx, opts: { budgetMs?: number } = {}): Promise<{ deleted: number; left: number } | null | undefined> {
  const deadline = Date.now() + (opts.budgetMs ?? DELETE_FILES_MS);
  /** Each call's limit: its own 15 s, within what is left of the budget. */
  const limit = () => Math.max(1, Math.min(15_000, deadline - Date.now()));
  let store: AttachmentObjects | null;
  let objects: { pathname: string }[];
  try {
    store = attachmentObjects();
    // No file store connected: none can have been kept.
    if (!store) return undefined;
    const connected = store;
    objects = await withLimit('a listing', limit(), (signal) => connected.list(containerFolder(ctx), signal));
  } catch (err) {
    console.error('Account deletion: the file store couldn’t be listed', loggable(err));
    return null;
  }
  const files = (paths: { pathname: string }[]) => new Set(paths.map((o) => parseObjectPath(ctx, o.pathname)?.id ?? o.pathname)).size;
  const total = files(objects);
  let done = 0;
  try {
    for (; done < objects.length; done += 100) {
      if (Date.now() >= deadline) throw new Error('its time was up');
      const page = objects.slice(done, done + 100).map((o) => o.pathname);
      await withLimit('a delete', limit(), (signal) => store!.del(page, signal));
    }
    return { deleted: total, left: 0 };
  } catch (err) {
    console.error('Account deletion: files were left in the file store for the nightly sweep', loggable(err));
    // A file is left when any of its objects is.
    const left = files(objects.slice(done));
    return { deleted: total - left, left };
  }
}
