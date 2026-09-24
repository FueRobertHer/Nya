import { opsGuard, notPost } from '@/lib/ops';
import { rawRedis } from '@/lib/storage';
import { exportLines } from '@/lib/export';

// Download a complete copy of this environment's data (see lib/export.ts for
// the format and why the values stay encrypted).
//
// It can read the whole database, so it is locked like every /api/ops route
// (lib/ops.ts): off unless OPS_ENABLED=1, POST only, OPS_SECRET compared in
// constant time. The prefix is never taken from the request: it comes from the
// deployment's own environment. Preview and production share one database,
// separated only by that prefix, and preview runs code merged in unattended.
//
// Example:
//   curl -X POST https://<host>/api/ops/export \
//     -H "Authorization: Bearer $OPS_SECRET" -o nya-export.ndjson

// The walk is sequential and one transaction blob can be 8 MiB; the default
// limit is too tight for a database that has been accumulating for years.
export const maxDuration = 300;

export async function POST(req: Request) {
  const refused = await opsGuard(req);
  if (refused) return refused;

  const lines = exportLines(rawRedis());
  const encoder = new TextEncoder();
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');

  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { value, done } = await lines.next();
        if (done) controller.close();
        else controller.enqueue(encoder.encode(value));
      } catch (err) {
        // Headers are already sent, so the status cannot change now. Erroring
        // the stream cuts the download short before the footer, which is what
        // marks the archive as incomplete. Never log the value being read.
        console.error('Export failed mid-stream', err instanceof Error ? err.message : err);
        controller.error(err);
      }
    },
    async cancel() {
      await lines.return(undefined);
    },
  });

  return new Response(body, {
    headers: {
      'Content-Type': 'application/x-ndjson',
      'Content-Disposition': `attachment; filename="nya-export-${stamp}.ndjson"`,
      // Financial data: never let an intermediary keep a copy.
      'Cache-Control': 'no-store',
    },
  });
}

export const { GET, HEAD, OPTIONS, PUT, PATCH, DELETE } = notPost;
