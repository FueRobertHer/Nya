// components/attachment-client.ts
//
// The page's side of receipts and documents (#47): the calls to
// app/api/attachments, an upload part by part (a file the page made ready
// with components/attachment-capture.ts: a start, each part, the thumbnail,
// and a cancel if any is refused, so nothing is left half sent), and saving a
// file. Nothing here keeps a file: what is opened is shown from the app's own
// address, never stored in the browser by Nya.

import { digest, partDigests, type Prepared } from './attachment-capture';

export type FilePlace =
  | { on: 'transaction'; transaction_id: string; carried?: true; check?: true }
  | { on: 'earlier'; account_id: string; pending: boolean; alike: number }
  | { on: 'none'; why: 'removed' | 'gone' | 'forgotten' | 'emptied'; since: string };

/** A file as the server describes it (lib/attachments.ts AttachmentView). */
export type FileView = {
  id: string;
  kind: 'image' | 'pdf';
  bytes: number;
  thumb: boolean;
  name: string | null;
  created_at: string;
  place: FilePlace;
  as_placed: { date: string; amount: number; currency: string | null; name: string } | null;
  damaged?: true;
};

export type Mode = { connected: boolean; uploads: boolean; quota_bytes: number | null };

export type Usage = { bytes: number; files: number; quota_bytes: number | null; max_files: number };

export type ListAnswer = {
  mode: Mode;
  usage: Usage & { zip_at: string | null };
  limits: { per_transaction: number; file_bytes: number; thumb_bytes: number; part_bytes: number };
  files: FileView[];
  unreadable: string[];
  unrecognised: string[];
  deleting: number;
};

export const fileUrl = (id: string) => `/api/attachments/${id}/file`;
export const thumbUrl = (id: string) => `/api/attachments/${id}/thumb`;

/** What the server said went wrong, or a plain sentence. */
async function errorOf(res: Response, fallback: string): Promise<string> {
  const data = await res.json().catch(() => null);
  return typeof data?.error === 'string' ? data.error : fallback;
}

const UNREACHABLE = 'Nya could not be reached. Check your connection and try again.';

/** Every file, and what this copy allows and how much is used. */
export async function listFiles(): Promise<ListAnswer | { error: string }> {
  try {
    const res = await fetch('/api/attachments', { cache: 'no-store' });
    if (!res.ok) return { error: await errorOf(res, 'Your receipts and documents couldn’t be read.') };
    return (await res.json()) as ListAnswer;
  } catch {
    return { error: UNREACHABLE };
  }
}

/** The files on these transactions (a row's `attached_on`). */
export async function filesOn(ids: readonly string[]): Promise<{ mode: Mode; files: FileView[]; usage: Usage | null } | { error: string }> {
  try {
    const res = await fetch(`/api/attachments?ids=${ids.map(encodeURIComponent).join(',')}`, { cache: 'no-store' });
    if (!res.ok) return { error: await errorOf(res, 'The receipts on this transaction couldn’t be read.') };
    return (await res.json()) as { mode: Mode; files: FileView[]; usage: Usage | null };
  } catch {
    return { error: UNREACHABLE };
  }
}

export type Progress = { sent: number; total: number };

/** Sends a file made ready onto a transaction, part by part: its id, or what
 *  went wrong (the upload then cancelled). */
export async function uploadFile(transaction_id: string, file: Prepared, onProgress?: (p: Progress) => void): Promise<{ id: string } | { error: string }> {
  const partBytes = 2 * 1024 * 1024;
  let id: string | null = null;
  const total = file.bytes.length + (file.thumb?.length ?? 0);
  let sent = 0;
  try {
    const start = await fetch('/api/attachments', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        transaction_id,
        kind: file.kind,
        bytes: file.bytes.length,
        part_sha256: await partDigests(file.bytes, partBytes),
        ...(file.thumb ? { thumb: { bytes: file.thumb.length, sha256: await digest(file.thumb) } } : {}),
        ...(file.name ? { name: file.name } : {}),
      }),
    });
    if (!start.ok) return { error: await errorOf(start, 'The file couldn’t be attached.') };
    const started = (await start.json()) as { id: string; part_bytes: number };
    id = started.id;
    const put = async (part: string, bytes: Uint8Array) => {
      const res = await fetch(`/api/attachments/${id}/parts/${part}`, { method: 'PUT', headers: { 'Content-Type': 'application/octet-stream' }, body: bytes as BodyInit });
      if (!res.ok) throw new Error(await errorOf(res, 'Part of the file didn’t arrive. Try again.'));
      sent += bytes.length;
      onProgress?.({ sent, total });
    };
    for (let i = 0; i * started.part_bytes < file.bytes.length; i++) await put(String(i), file.bytes.subarray(i * started.part_bytes, (i + 1) * started.part_bytes));
    if (file.thumb) await put('t', file.thumb);
    return { id };
  } catch (err) {
    // Nothing is left half sent: the upload is cancelled, its parts deleted.
    if (id) await fetch(`/api/attachments/${id}`, { method: 'DELETE' }).catch(() => {});
    return { error: err instanceof Error && err.message !== 'Failed to fetch' && err.message !== 'Load failed' ? err.message : UNREACHABLE };
  }
}

async function change(id: string, method: 'PATCH' | 'DELETE', body?: unknown): Promise<{ ok: true; data: unknown } | { error: string }> {
  try {
    const res = await fetch(`/api/attachments/${id}`, { method, ...(body ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}) });
    if (!res.ok) return { error: await errorOf(res, 'That change couldn’t be made.') };
    return { ok: true, data: await res.json().catch(() => null) };
  } catch {
    return { error: UNREACHABLE };
  }
}

export const deleteFile = (id: string) => change(id, 'DELETE');
export const moveFile = (id: string, transaction_id: string) => change(id, 'PATCH', { transaction_id });
export const renameFile = (id: string, name: string | null) => change(id, 'PATCH', { name });

/** A file read from the app and handed to the browser to save (a PDF, or a
 *  photo kept as a file). */
export async function saveFile(id: string, name: string): Promise<string | null> {
  try {
    const res = await fetch(`${fileUrl(id)}?download=1`, { cache: 'no-store' });
    if (!res.ok) return errorOf(res, 'The file couldn’t be opened.');
    saveBlob(await res.blob(), name);
    return null;
  } catch {
    return UNREACHABLE;
  }
}

/** Hands bytes to the browser to save, as the data download does. */
export function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/** A file size in words: KB under a megabyte, MB to one decimal under ten,
 *  GB from 1024 MB. */
export function sizeWords(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  if (mb >= 1024) return `${Math.round((mb / 1024) * 10) / 10} GB`;
  if (mb >= 10) return `${Math.round(mb)} MB`;
  if (mb >= 1) return `${Math.round(mb * 10) / 10} MB`;
  return `${Math.max(1, Math.ceil(bytes / 1024))} KB`;
}

/** How full the quota is, from 0 to 1, or null with no quota. */
export function quotaShare(u: Pick<Usage, 'bytes' | 'files' | 'quota_bytes' | 'max_files'>): number | null {
  if (u.quota_bytes === null || u.quota_bytes <= 0) return null;
  return Math.max(u.bytes / u.quota_bytes, u.files / u.max_files);
}

/** What the sheet says once the quota is past 80% full, or null. */
export function quotaNote(u: Usage | null): string | null {
  if (!u) return null;
  const share = quotaShare(u);
  if (share === null || share < 0.8) return null;
  if (share >= 1) return `The space for receipts and documents on this copy of Nya is full (${sizeWords(u.bytes)} of ${sizeWords(u.quota_bytes!)}, ${u.files} files). Delete some to add more.`;
  return `${Math.floor(share * 100)}% of the space for receipts and documents on this copy of Nya is used (${sizeWords(u.bytes)} of ${sizeWords(u.quota_bytes!)}).`;
}

/** Why a file isn't on a transaction, in words. */
export function looseWords(p: FilePlace): string | null {
  if (p.on === 'transaction') return p.check ? 'Check which transaction this is on: two look the same now.' : null;
  if (p.on === 'earlier') {
    if (p.pending) return 'Waiting on a disconnected bank: its transaction was still pending, so attach it again by hand once it is back.';
    if (p.alike > 1) return 'Waiting on a disconnected bank: two of its transactions looked the same, so choose which once it is back.';
    return 'Waiting on a disconnected bank: it goes back on its transaction when you connect the bank again and link the account.';
  }
  const why = { removed: 'your bank removed its transaction', gone: 'its transaction was deleted', forgotten: 'you forgot the account it was on', emptied: 'the account was emptied' }[p.why];
  return `Not on a transaction: ${why}. Attach it again, or delete it.`;
}
