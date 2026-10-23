import { serveAttachment } from '@/lib/attachment-serve';

// GET /api/attachments/<id>/file: the whole file, opened on the server for the
// signed-in person alone, every part read and opened before a header goes out
// (lib/attachment-serve.ts). A photo is shown inline; a PDF is only ever
// saved; `?download=1` saves a photo too.

// A 10 MiB file over a slow connection (1 Mbit/s) takes about 80 s.
export const maxDuration = 120;

type Params = { params: Promise<{ id: string }> };

export async function GET(req: Request, { params }: Params) {
  return serveAttachment(req, (await params).id, 'file');
}
