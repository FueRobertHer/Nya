import { NextResponse } from 'next/server';
import { dataCtx } from '@/lib/data-ctx';
import { receivePart } from '@/lib/attachments';
import { attachmentFailure, isDemo, readBodyAtMost, DEMO_REFUSAL, NO_STORE } from '@/lib/attachment-http';
import { isAttachmentId } from '@/lib/attachment-stores';
import { MAX_PARTS, MAX_THUMB_BYTES, PART_BYTES } from '@/lib/attachment-crypto';

// PUT /api/attachments/<id>/parts/<n> (0 to parts - 1) or /parts/t (the
// thumbnail): one part of an upload started at /api/attachments, its raw
// bytes as the body (application/octet-stream, never base64). At most
// PART_BYTES, under Vercel's 4.5 MB request body and the proxy's buffer
// (which would cut a longer one short without a word): a body longer than its
// part is refused before it is read whole, and one shorter, or not the bytes
// whose SHA-256 the start declared, is refused, never stored short
// (lib/attachments.ts receivePart). Answers whether the file is ready now.

// A part over a slow phone connection: 2 MiB at 1 Mbit/s is about 16 s.
export const maxDuration = 60;

type Params = { params: Promise<{ id: string; part: string }> };

export async function PUT(req: Request, { params }: Params) {
  const { id, part } = await params;
  if (!isAttachmentId(id)) return NextResponse.json({ error: 'There is no upload of that file in progress.' }, { status: 404, headers: NO_STORE });
  const name = part === 't' ? 't' : /^(0|[1-9][0-9]?)$/.test(part) && Number(part) < MAX_PARTS ? Number(part) : null;
  if (name === null) return NextResponse.json({ error: 'There is no such part of this file.' }, { status: 400, headers: NO_STORE });
  let ctx;
  try {
    ctx = await dataCtx();
  } catch (err) {
    return attachmentFailure(err, 'That part could not be stored.');
  }
  if (await isDemo()) return NextResponse.json({ error: DEMO_REFUSAL }, { status: 403, headers: NO_STORE });
  const body = await readBodyAtMost(req, name === 't' ? MAX_THUMB_BYTES : PART_BYTES);
  if (body === null) return NextResponse.json({ error: 'This part is too large.' }, { status: 413, headers: NO_STORE });
  try {
    return NextResponse.json(await receivePart(ctx, id, name, body), { headers: NO_STORE });
  } catch (err) {
    return attachmentFailure(err, 'That part could not be stored.');
  }
}
