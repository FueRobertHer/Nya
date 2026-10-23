import { serveAttachment } from '@/lib/attachment-serve';

// GET /api/attachments/<id>/thumb: a photo's thumbnail, as the file is served
// (lib/attachment-serve.ts).

export const maxDuration = 30;

type Params = { params: Promise<{ id: string }> };

export async function GET(req: Request, { params }: Params) {
  return serveAttachment(req, (await params).id, 'thumb');
}
