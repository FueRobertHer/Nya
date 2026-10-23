import { NextResponse } from 'next/server';
import { dataCtx } from '@/lib/data-ctx';
import type { Ctx } from '@/lib/containers';
import { attachmentsOn, listAttachments, readUsage, startUpload, MAX_FILES, PER_TRANSACTION, type StartInput } from '@/lib/attachments';
import { attachmentFailure, isDemo, personMode, DEMO_REFUSAL, NO_STORE } from '@/lib/attachment-http';
import { isAttachmentKind, NAME_MAX } from '@/lib/attachment-stores';
import { MAX_FILE_BYTES, MAX_PARTS, MAX_THUMB_BYTES, PART_BYTES } from '@/lib/attachment-crypto';
import { isTransactionId } from '@/lib/txn-annotations';
import { isSplitOrGroupId } from '@/lib/split-rows';

// Receipts and documents attached to transactions (#47, lib/attachments.ts),
// for the signed-in person alone: behind the session gate (proxy.ts), in the
// container dataCtx() resolves, which is always the person's own, so another
// account's ids are simply not found. Never through the API or a share.
//
// GET                 what this copy allows (`mode`), what is used of the
//                     quota, and every file, newest first, with what can't
//                     be read named (409 flagged unreadable when the records
//                     can't be listed at all, never "none").
// GET ?ids=a,b        the files on these transactions (a row's own and the
//                     rows it stands for, as /api/transactions says in
//                     `attached_on`), at most PER_TRANSACTION each, with
//                     what is used of the quota (null when unreadable).
// POST { transaction_id, kind: "image" | "pdf", bytes, part_sha256: [..],
//        thumb?: { bytes, sha256 }, name? }
//                     starts an upload (lib/attachments.ts startUpload):
//                     the parts then go to /api/attachments/<id>/parts/<n>.
//                     Refused for a demo account (shared by everyone), where
//                     adding is off, and for an account without its own data
//                     key.
// Every field is checked here: its type, its length, its range.

const MAX_BODY_CHARS = 8 * 1024;
const SHA = /^[0-9a-f]{64}$/;
const MAX_IDS = 12;

export async function GET(req: Request) {
  let ctx: Ctx;
  try {
    ctx = await dataCtx();
  } catch (err) {
    return attachmentFailure(err, 'Your receipts and documents could not be read.');
  }
  const url = new URL(req.url);
  const keys = [...url.searchParams.keys()];
  if (keys.some((k) => k !== 'ids')) return NextResponse.json({ error: 'Unknown parameter.' }, { status: 400, headers: NO_STORE });
  const mode = await personMode();
  try {
    if (url.searchParams.has('ids')) {
      const ids = (url.searchParams.get('ids') ?? '').split(',').filter(Boolean);
      if (ids.length === 0 || ids.length > MAX_IDS || ids.some((id) => !isTransactionId(id) || isSplitOrGroupId(id))) {
        return NextResponse.json({ error: 'Send the ids of up to 12 transactions.' }, { status: 400, headers: NO_STORE });
      }
      // With what is used of the quota, for the transaction's sheet to say
      // when it is nearly full; null when that can't be read.
      const [files, usage] = await Promise.all([attachmentsOn(ctx, ids), readUsage(ctx).catch(() => null)]);
      return NextResponse.json(
        { mode, files, usage: usage ? { bytes: usage.bytes, files: usage.files, quota_bytes: mode.quota_bytes, max_files: MAX_FILES } : null },
        { headers: NO_STORE }
      );
    }
    const [list, usage] = await Promise.all([listAttachments(ctx), readUsage(ctx)]);
    return NextResponse.json(
      {
        mode,
        usage: { bytes: usage.bytes, files: usage.files, quota_bytes: mode.quota_bytes, max_files: MAX_FILES, zip_at: usage.zip_at ?? null },
        limits: { per_transaction: PER_TRANSACTION, file_bytes: MAX_FILE_BYTES, thumb_bytes: MAX_THUMB_BYTES, part_bytes: PART_BYTES },
        ...list,
      },
      { headers: NO_STORE }
    );
  } catch (err) {
    return attachmentFailure(err, 'Your receipts and documents could not be read.');
  }
}

/** The request's JSON object, or why not. */
async function bodyOf(req: Request): Promise<Record<string, unknown> | NextResponse> {
  const text = await req.text();
  if (text.length > MAX_BODY_CHARS) return NextResponse.json({ error: 'Request too large' }, { status: 413, headers: NO_STORE });
  try {
    const parsed = JSON.parse(text);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('not an object');
    return parsed;
  } catch {
    return NextResponse.json({ error: 'Invalid request' }, { status: 400, headers: NO_STORE });
  }
}

/** A start, checked field by field, or what is wrong with it. */
function startOf(body: Record<string, unknown>): StartInput | string {
  const allowed = ['transaction_id', 'kind', 'bytes', 'part_sha256', 'thumb', 'name'];
  if (Object.keys(body).some((k) => !allowed.includes(k))) return 'Unknown field.';
  const { transaction_id, kind, bytes, part_sha256, thumb, name } = body;
  if (!isTransactionId(transaction_id) || isSplitOrGroupId(transaction_id)) return 'Invalid transaction id.';
  if (!isAttachmentKind(kind)) return 'kind must be "image" or "pdf".';
  if (!Number.isInteger(bytes) || (bytes as number) < 1) return 'bytes must be a whole number above 0.';
  if ((bytes as number) > MAX_FILE_BYTES) return `A file can be at most ${MAX_FILE_BYTES / (1024 * 1024)} MB.`;
  if (!Array.isArray(part_sha256) || part_sha256.length < 1 || part_sha256.length > MAX_PARTS || !part_sha256.every((s) => typeof s === 'string' && SHA.test(s))) {
    return 'part_sha256 must list each part’s SHA-256, in hex.';
  }
  let t: StartInput['thumb'] = null;
  if (thumb !== undefined && thumb !== null) {
    if (typeof thumb !== 'object' || Array.isArray(thumb)) return 'thumb must be { bytes, sha256 }.';
    const th = thumb as Record<string, unknown>;
    if (Object.keys(th).some((k) => k !== 'bytes' && k !== 'sha256')) return 'thumb must be { bytes, sha256 }.';
    if (!Number.isInteger(th.bytes) || (th.bytes as number) < 1 || (th.bytes as number) > MAX_THUMB_BYTES) return 'The thumbnail is too large.';
    if (typeof th.sha256 !== 'string' || !SHA.test(th.sha256)) return 'thumb.sha256 must be a SHA-256, in hex.';
    t = { bytes: th.bytes as number, sha256: th.sha256 };
  }
  if (name !== undefined && name !== null && (typeof name !== 'string' || name.length > NAME_MAX * 4)) return 'name must be text.';
  return { transaction_id, kind, bytes: bytes as number, part_sha256: part_sha256 as string[], thumb: t, name: typeof name === 'string' ? name : null };
}

export async function POST(req: Request) {
  let ctx: Ctx;
  try {
    ctx = await dataCtx();
  } catch (err) {
    return attachmentFailure(err, 'The upload could not be started.');
  }
  if (await isDemo()) return NextResponse.json({ error: DEMO_REFUSAL }, { status: 403, headers: NO_STORE });
  const body = await bodyOf(req);
  if (body instanceof NextResponse) return body;
  const input = startOf(body);
  if (typeof input === 'string') return NextResponse.json({ error: input }, { status: 400, headers: NO_STORE });
  try {
    return NextResponse.json(await startUpload(ctx, input), { headers: NO_STORE });
  } catch (err) {
    return attachmentFailure(err, 'The upload could not be started.');
  }
}
