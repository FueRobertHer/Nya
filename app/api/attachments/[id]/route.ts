import { NextResponse } from 'next/server';
import { dataCtx } from '@/lib/data-ctx';
import type { Ctx } from '@/lib/containers';
import { deleteAttachment, discardUpload, moveAttachment, renameAttachment } from '@/lib/attachments';
import { attachmentFailure, NO_STORE } from '@/lib/attachment-http';
import { attachmentStore, isAttachmentId, NAME_MAX } from '@/lib/attachment-stores';
import { isTransactionId } from '@/lib/txn-annotations';
import { isSplitOrGroupId } from '@/lib/split-rows';

// One receipt or document (lib/attachments.ts), the signed-in person's own.
// These need only a connected file store, never the quota: a file already
// attached can always be moved, renamed or deleted (docs/operations.md).
//
// PATCH { transaction_id }   moves it to another transaction (at most
//                            PER_TRANSACTION on one);
// PATCH { name }             renames it (null or "" clears the name);
// DELETE                     deletes it, for good: its key leaves the
//                            database at once, then its objects and its
//                            record go. `finished: false` when the file store
//                            couldn't be reached: it can't be opened any
//                            more, and the nightly sweep finishes it. An
//                            upload in progress is cancelled the same way.

type Params = { params: Promise<{ id: string }> };

async function resolve(params: Params['params']): Promise<{ ctx: Ctx; id: string } | NextResponse> {
  const { id } = await params;
  if (!isAttachmentId(id)) return NextResponse.json({ error: 'There is no such receipt or document.' }, { status: 404, headers: NO_STORE });
  try {
    return { ctx: await dataCtx(), id };
  } catch (err) {
    return attachmentFailure(err, 'That receipt or document could not be changed.');
  }
}

export async function PATCH(req: Request, { params }: Params) {
  const r = await resolve(params);
  if (r instanceof NextResponse) return r;
  const text = await req.text();
  if (text.length > 4096) return NextResponse.json({ error: 'Request too large' }, { status: 413, headers: NO_STORE });
  let body: Record<string, unknown>;
  try {
    const parsed = JSON.parse(text);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('not an object');
    body = parsed;
  } catch {
    return NextResponse.json({ error: 'Invalid request' }, { status: 400, headers: NO_STORE });
  }
  const keys = Object.keys(body);
  try {
    if (keys.length === 1 && keys[0] === 'transaction_id') {
      const to = body.transaction_id;
      if (!isTransactionId(to) || isSplitOrGroupId(to)) return NextResponse.json({ error: 'Invalid transaction id.' }, { status: 400, headers: NO_STORE });
      return NextResponse.json({ file: await moveAttachment(r.ctx, r.id, to) }, { headers: NO_STORE });
    }
    if (keys.length === 1 && keys[0] === 'name') {
      const name = body.name;
      if (name !== null && (typeof name !== 'string' || name.length > NAME_MAX * 4)) return NextResponse.json({ error: 'name must be text.' }, { status: 400, headers: NO_STORE });
      return NextResponse.json({ file: await renameAttachment(r.ctx, r.id, name || null) }, { headers: NO_STORE });
    }
    return NextResponse.json({ error: 'Send { transaction_id } or { name }.' }, { status: 400, headers: NO_STORE });
  } catch (err) {
    return attachmentFailure(err, 'That receipt or document could not be changed.');
  }
}

export async function DELETE(_req: Request, { params }: Params) {
  const r = await resolve(params);
  if (r instanceof NextResponse) return r;
  try {
    const record = await attachmentStore.get(r.ctx, r.id);
    if (record?.status === 'uploading') {
      await discardUpload(r.ctx, r.id, Date.now(), { cancelled: true });
      return NextResponse.json({ finished: true }, { headers: NO_STORE });
    }
    return NextResponse.json(await deleteAttachment(r.ctx, r.id), { headers: NO_STORE });
  } catch (err) {
    return attachmentFailure(err, 'That receipt or document could not be deleted.');
  }
}
