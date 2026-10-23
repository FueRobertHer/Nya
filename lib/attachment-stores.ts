// lib/attachment-stores.ts
//
// The stores behind receipts and documents attached to transactions (#47):
// declared here, on the storage seam (lib/repo.ts), with their closed shapes;
// what is done with them is lib/attachments.ts, the nightly sweep
// lib/attachment-sweep.ts. The files themselves are never here: their sealed
// parts are in the file store (lib/attachment-objects.ts), and only these
// records can open them (lib/attachment-crypto.ts).
//
//   attachments          one record per file, under a random id: what it is,
//                        its wrapped key, where it is placed and what its
//                        transaction said then. The authority for everything
//                        about a file. Not exportable: the download has a
//                        section of its own that never holds a key
//                        (lib/user-export.ts).
//   attachment-places    the index: a transaction's id, or "earlier:<account>"
//                        for files waiting on a disconnected bank's account,
//                        to the attachment ids placed there. Derived from the
//                        records, so the paperclip is one HKEYS and the sync
//                        reads only the rows it changed. The record decides
//                        and the index follows; a reader that shows a file
//                        checks its record.
//   attachment-usage     what is reserved: bytes and files, the uploads in
//                        progress, when the files were last downloaded. Every
//                        limit is checked and reserved in one compare-and-set
//                        on it, so uploads at the same moment can't pass a
//                        limit together; the nightly sweep reconciles it.
//   attachment-sweep     the nightly sweep's state for the container: objects
//                        seen with no record naming them and since when, the
//                        marker a failed placement step leaves, when the
//                        placements were last checked.
//   attachment-requests  starts, parts and views counted an hour at a time.
//
// READS ARE STRICT (the seam's rule); each caller says where it is lenient.

import { defineCounterMapStore, defineMapStore, defineValueStore } from './repo';

export const ATTACHMENT_VERSION = 1;

/** What a file is stored as. */
export type AttachmentKind = 'image' | 'pdf';
export const CONTENT_TYPES: Readonly<Record<AttachmentKind, string>> = { image: 'image/jpeg', pdf: 'application/pdf' };
export const isAttachmentKind = (v: unknown): v is AttachmentKind => v === 'image' || v === 'pdf';

/** Why a file is no longer on a transaction. */
export type LooseReason =
  | 'removed' // the bank removed its transaction
  | 'gone' // its transaction was deleted, its import undone, or its account let go
  | 'forgotten' // the earlier account it waited on was forgotten
  | 'emptied'; // the account was emptied, or a restore undone
export const LOOSE_REASONS: readonly LooseReason[] = ['removed', 'gone', 'forgotten', 'emptied'];

/** What its transaction said when the file was last placed: for the list,
 *  for a file no longer on one, and for the names in the ZIP. As placed,
 *  never kept up to date with the transaction. */
export type AsPlaced = { date: string; amount: number; currency: string | null; name: string };

/** Where a file is. */
export type Place =
  /** On a transaction, by its id. `content`: its posted bank row's content
   *  key (lib/transactions.ts contentKey), when known, what carries it
   *  across a re-link. `carried`: placed by a re-link, by content. `check`:
   *  two rows have that content now, so the person should check which. */
  | { on: 'transaction'; transaction_id: string; account_id: string | null; content: string | null; carried?: true; check?: true }
  /** Its bank row went with a disconnect: waiting for the person to link
   *  that account to the re-added one. `alike`: how many of the account's
   *  rows had its content then (pending ones like it too); `pending`: its row
   *  was still pending. */
  | { on: 'earlier'; account_id: string; content: string; alike: number; pending: boolean }
  /** Not on a transaction, kept and listed. `was`: where it was. */
  | { on: 'none'; why: LooseReason; since: string; was?: { transaction_id: string | null; account_id: string | null; content: string | null } };

export type Upload = {
  /** The SHA-256 of each part, as the page declared them at the start. */
  part_sha256: string[];
  thumb_sha256: string | null;
  /** The parts stored so far. */
  received: number[];
  thumb_received: boolean;
  expires_at: string;
};

export type Attachment = {
  version: typeof ATTACHMENT_VERSION;
  status: 'uploading' | 'ready' | 'deleting';
  kind: AttachmentKind;
  /** The file's size as stored (before sealing). */
  bytes: number;
  parts: number;
  /** The thumbnail's size, or null for none (a PDF has none). */
  thumb_bytes: number | null;
  /** What its objects take in the file store, sealed, thumbnail included:
   *  what the quota counts. */
  stored_bytes: number;
  /** The file's key, wrapped under the container's own key
   *  (lib/attachment-crypto.ts); null from the moment it is being deleted. */
  file_key: string | null;
  /** The name the device gave the file, at most NAME_MAX characters. Never
   *  in a path, a log or an email; only in the header of the response that
   *  sends the file. */
  name: string | null;
  place: Place;
  as_placed: AsPlaced | null;
  created_at: string;
  ready_at?: string;
  /** A part failed to open: the viewer says so, and the ZIP leaves it out. */
  damaged?: true;
  /** Only while uploading. */
  upload?: Upload;
};

export const NAME_MAX = 120;
const ISO = (v: unknown) => typeof v === 'string' && v.length <= 40 && !Number.isNaN(Date.parse(v));
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const SHA = /^[0-9a-f]{64}$/;
const TXN_ID = /^[A-Za-z0-9_.:-]{1,200}$/;
const ACCOUNT_ID = /^[A-Za-z0-9_.:-]{1,200}$/;
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const onlyKeys = (v: Record<string, unknown>, keys: readonly string[]) => Object.keys(v).every((k) => keys.includes(k));
const count = (v: unknown, max: number) => Number.isInteger(v) && (v as number) >= 0 && (v as number) <= max;
const nullOr = <T>(v: unknown, ok: (x: unknown) => x is T) => v === null || ok(v);
const isText = (max: number) => (v: unknown): v is string => typeof v === 'string' && v.length <= max;
const isContent = isText(2000);

function isWas(v: unknown): boolean {
  return (
    isRecord(v) &&
    onlyKeys(v, ['transaction_id', 'account_id', 'content']) &&
    (v.transaction_id === null || (typeof v.transaction_id === 'string' && TXN_ID.test(v.transaction_id))) &&
    (v.account_id === null || (typeof v.account_id === 'string' && ACCOUNT_ID.test(v.account_id))) &&
    nullOr(v.content, isContent)
  );
}

export function isPlace(v: unknown): v is Place {
  if (!isRecord(v)) return false;
  if (v.on === 'transaction') {
    return (
      onlyKeys(v, ['on', 'transaction_id', 'account_id', 'content', 'carried', 'check']) &&
      typeof v.transaction_id === 'string' &&
      TXN_ID.test(v.transaction_id) &&
      (v.account_id === null || (typeof v.account_id === 'string' && ACCOUNT_ID.test(v.account_id))) &&
      nullOr(v.content, isContent) &&
      (v.carried === undefined || v.carried === true) &&
      (v.check === undefined || v.check === true)
    );
  }
  if (v.on === 'earlier') {
    return (
      onlyKeys(v, ['on', 'account_id', 'content', 'alike', 'pending']) &&
      typeof v.account_id === 'string' &&
      ACCOUNT_ID.test(v.account_id) &&
      isContent(v.content) &&
      count(v.alike, 100_000) &&
      typeof v.pending === 'boolean'
    );
  }
  if (v.on === 'none') {
    return (
      onlyKeys(v, ['on', 'why', 'since', 'was']) &&
      LOOSE_REASONS.includes(v.why as LooseReason) &&
      ISO(v.since) &&
      (v.was === undefined || isWas(v.was))
    );
  }
  return false;
}

function isAsPlaced(v: unknown): v is AsPlaced {
  return (
    isRecord(v) &&
    onlyKeys(v, ['date', 'amount', 'currency', 'name']) &&
    typeof v.date === 'string' &&
    DAY.test(v.date) &&
    typeof v.amount === 'number' &&
    Number.isFinite(v.amount) &&
    (v.currency === null || (typeof v.currency === 'string' && v.currency.length <= 12)) &&
    typeof v.name === 'string' &&
    v.name.length <= 500
  );
}

function isUpload(v: unknown, parts: number, thumb: boolean): v is Upload {
  return (
    isRecord(v) &&
    onlyKeys(v, ['part_sha256', 'thumb_sha256', 'received', 'thumb_received', 'expires_at']) &&
    Array.isArray(v.part_sha256) &&
    v.part_sha256.length === parts &&
    v.part_sha256.every((s) => typeof s === 'string' && SHA.test(s)) &&
    (thumb ? typeof v.thumb_sha256 === 'string' && SHA.test(v.thumb_sha256) : v.thumb_sha256 === null) &&
    Array.isArray(v.received) &&
    v.received.length <= parts &&
    v.received.every((n) => Number.isInteger(n) && n >= 0 && n < parts) &&
    new Set(v.received).size === v.received.length &&
    typeof v.thumb_received === 'boolean' &&
    ISO(v.expires_at)
  );
}

/** The current shape, closed: a field this release doesn't know makes the
 *  record unrecognised, never half used. */
export function isAttachment(v: unknown): v is Attachment {
  if (!isRecord(v)) return false;
  const keys = ['version', 'status', 'kind', 'bytes', 'parts', 'thumb_bytes', 'stored_bytes', 'file_key', 'name', 'place', 'as_placed', 'created_at', 'ready_at', 'damaged', 'upload'];
  if (!onlyKeys(v, keys) || v.version !== ATTACHMENT_VERSION) return false;
  if (v.status !== 'uploading' && v.status !== 'ready' && v.status !== 'deleting') return false;
  if (!isAttachmentKind(v.kind)) return false;
  if (!Number.isInteger(v.bytes) || (v.bytes as number) < 1 || (v.bytes as number) > 64 * 1024 * 1024) return false;
  if (!Number.isInteger(v.parts) || (v.parts as number) < 1 || (v.parts as number) > 32) return false;
  if (!(v.thumb_bytes === null || (Number.isInteger(v.thumb_bytes) && (v.thumb_bytes as number) >= 1 && (v.thumb_bytes as number) <= 4 * 1024 * 1024))) return false;
  if (!Number.isInteger(v.stored_bytes) || (v.stored_bytes as number) < 1) return false;
  if (!(v.file_key === null || (typeof v.file_key === 'string' && v.file_key.length <= 400))) return false;
  if (v.status !== 'deleting' && v.file_key === null) return false;
  if (!(v.name === null || (typeof v.name === 'string' && v.name.length <= NAME_MAX))) return false;
  if (!isPlace(v.place) || !(v.as_placed === null || isAsPlaced(v.as_placed))) return false;
  if (!ISO(v.created_at) || !(v.ready_at === undefined || ISO(v.ready_at))) return false;
  if (!(v.damaged === undefined || v.damaged === true)) return false;
  // An upload's state is there while it is uploading, never once it is
  // ready; a file deleted part way through its upload may still carry it.
  if (v.status === 'uploading' && v.upload === undefined) return false;
  if (v.status === 'ready' && v.upload !== undefined) return false;
  if (v.upload !== undefined && !isUpload(v.upload, v.parts as number, v.thumb_bytes !== null)) return false;
  return true;
}

export const attachmentStore = defineMapStore<Attachment>('attachments', {
  what: 'receipts and documents',
  isValid: isAttachment,
  // Each record holds its file's key: the download lists the files in a
  // section of its own, without it (lib/user-export.ts), and the files come
  // decrypted in the ZIP.
  exportable: false,
});

/** The ids placed on one transaction, or waiting on one earlier account. */
export type PlaceEntry = { ids: string[] };
const ATTACHMENT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export const isAttachmentId = (v: unknown): v is string => typeof v === 'string' && ATTACHMENT_ID.test(v);

export function isPlaceEntry(v: unknown): v is PlaceEntry {
  return isRecord(v) && onlyKeys(v, ['ids']) && Array.isArray(v.ids) && v.ids.length >= 1 && v.ids.length <= 5000 && v.ids.every(isAttachmentId) && new Set(v.ids).size === v.ids.length;
}

/** The index's field for files waiting on an earlier account. */
export const EARLIER_PREFIX = 'earlier:';
export const earlierField = (account_id: string) => `${EARLIER_PREFIX}${account_id}`;

export const placeStore = defineMapStore<PlaceEntry>('attachment-places', {
  what: 'places of receipts and documents',
  isValid: isPlaceEntry,
  exportable: false, // derived from the records
});

export type Usage = {
  version: 1;
  /** Stored bytes reserved: every file's, uploads in progress and files
   *  being deleted included. */
  bytes: number;
  files: number;
  /** Uploads in progress, by attachment id: what each reserved, and when it
   *  expires. */
  uploads: Record<string, { bytes: number; expires_at: string }>;
  /** When the files were last downloaded (the ZIP), for the card's reminder. */
  zip_at?: string;
};

export function isUsage(v: unknown): v is Usage {
  return (
    isRecord(v) &&
    onlyKeys(v, ['version', 'bytes', 'files', 'uploads', 'zip_at']) &&
    v.version === 1 &&
    Number.isInteger(v.bytes) &&
    (v.bytes as number) >= 0 &&
    Number.isInteger(v.files) &&
    (v.files as number) >= 0 &&
    isRecord(v.uploads) &&
    Object.entries(v.uploads).every(([id, u]) => isAttachmentId(id) && isRecord(u) && onlyKeys(u, ['bytes', 'expires_at']) && Number.isInteger(u.bytes) && (u.bytes as number) >= 0 && ISO(u.expires_at)) &&
    (v.zip_at === undefined || ISO(v.zip_at))
  );
}

export const usageStore = defineValueStore<Usage>('attachment-usage', {
  what: 'receipt and document storage figures',
  isValid: isUsage,
  exportable: false, // bookkeeping, worked out from the records
});

export type SweepState = {
  version: 1;
  /** Attachment ids whose objects were seen with no record naming them, and
   *  when first seen: deleted only once unnamed for the backups' window. */
  unnamed: Record<string, string>;
  /** A placement step failed: check this container's placements. */
  check?: { since: string };
  /** When its placements were last checked. */
  checked_at?: string;
};

export function isSweepState(v: unknown): v is SweepState {
  return (
    isRecord(v) &&
    onlyKeys(v, ['version', 'unnamed', 'check', 'checked_at']) &&
    v.version === 1 &&
    isRecord(v.unnamed) &&
    Object.entries(v.unnamed).every(([id, at]) => isAttachmentId(id) && ISO(at)) &&
    (v.check === undefined || (isRecord(v.check) && onlyKeys(v.check, ['since']) && ISO(v.check.since))) &&
    (v.checked_at === undefined || ISO(v.checked_at))
  );
}

export const sweepStateStore = defineValueStore<SweepState>('attachment-sweep', {
  what: 'the clean-up record of receipts and documents',
  isValid: isSweepState,
  exportable: false, // the sweep's bookkeeping
});

/** Uploads started, parts sent and files viewed, an hour at a time. */
export const attachmentRequests = defineCounterMapStore('attachment-requests', {
  what: 'receipt and document request counts',
  windowSeconds: 60 * 60,
});
