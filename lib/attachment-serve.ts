// lib/attachment-serve.ts
//
// Sending one receipt or document, or its thumbnail, to the signed-in person
// (app/api/attachments/<id>/file and /thumb). Opened on the server: the page
// never holds a file's key, and no address of the file store ever leaves it.
// Every part is read and opened before a header is sent (lib/attachments.ts
// readFile), so a part that is missing (410) or damaged (409) is answered as
// such, never as a response cut short; then the bytes go out as a stream, so a
// 10 MiB file isn't held to Vercel's 4.5 MB figure for a response that isn't.
// Each view is counted (VIEWS_PER_HOUR). The headers are lib/attachment-http.ts
// fileHeaders: never cached, never sniffed, never read by another site.

import { NextResponse } from 'next/server';
import { dataCtx } from './data-ctx';
import { countRequest, readFile } from './attachments';
import { attachmentFailure, fileHeaders, NO_STORE } from './attachment-http';
import { isAttachmentId } from './attachment-stores';

export async function serveAttachment(req: Request, id: string, which: 'file' | 'thumb'): Promise<Response> {
  if (!isAttachmentId(id)) return NextResponse.json({ error: 'There is no such receipt or document.' }, { status: 404, headers: NO_STORE });
  const url = new URL(req.url);
  if ([...url.searchParams.keys()].some((k) => k !== 'download') || (url.searchParams.has('download') && url.searchParams.get('download') !== '1')) {
    return NextResponse.json({ error: 'Unknown parameter.' }, { status: 400, headers: NO_STORE });
  }
  try {
    const ctx = await dataCtx();
    await countRequest(ctx, 'read');
    const { record, bytes } = await readFile(ctx, id, which);
    let sent = false;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent) controller.close();
        else {
          // In pieces, so a large file goes out as it is taken.
          for (let at = 0; at < bytes.length; at += 256 * 1024) controller.enqueue(bytes.subarray(at, at + 256 * 1024));
          sent = true;
          controller.close();
        }
      },
    });
    return new Response(stream, { headers: fileHeaders(record.kind, bytes.length, record.name, { thumb: which === 'thumb', download: url.searchParams.get('download') === '1' }) });
  } catch (err) {
    return attachmentFailure(err, 'That receipt or document could not be opened.');
  }
}
