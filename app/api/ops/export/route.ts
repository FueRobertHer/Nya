import { NextResponse } from 'next/server';
import { secretsMatch } from '@/lib/auth';
import { rawRedis } from '@/lib/storage';
import { exportLines } from '@/lib/export';

// Download a complete copy of this environment's data (see lib/export.ts for
// the format and why the values stay encrypted).
//
// This route can read the whole database, so it is harder to reach than the
// other self-authenticating routes:
//
// - OFF UNLESS OPS_ENABLED=1. Set it for the length of a backup, then remove
//   it. While off the route answers 404, as if it did not exist, so a leaked
//   OPS_SECRET is useless on its own.
// - POST ONLY. A GET would invite putting the secret in a URL, and URLs end up
//   in logs, browser history and proxy caches. Every other method answers 404
//   explicitly: left undefined, Next answers GET and HEAD with 405 and OPTIONS
//   with 204 plus an Allow header, all of which reveal the route exists even
//   while it is switched off.
// - CONSTANT-TIME COMPARISON, as /api/ingest/balance does, since this is
//   reachable by anyone on the internet.
// - THE PREFIX IS NEVER TAKEN FROM THE REQUEST. It comes from the deployment's
//   own environment. Preview and production share one database, separated
//   only by that prefix, and preview runs code merged in unattended.
//
// Excluded from the session gate in proxy.ts, like the other bearer routes.
//
// Example:
//   curl -X POST https://<host>/api/ops/export \
//     -H "Authorization: Bearer $OPS_SECRET" -o nya-export.ndjson

// The walk is sequential and one transaction blob can be 8 MiB; the default
// limit is too tight for a database that has been accumulating for years.
export const maxDuration = 300;

export async function POST(req: Request) {
  if (process.env.OPS_ENABLED !== '1') return notFound();

  const secret = process.env.OPS_SECRET;
  const header = req.headers.get('authorization') ?? '';
  const presented = header.startsWith('Bearer ') ? header.slice(7) : '';
  // `!secret` matters: without it an enabled route with no secret set would be
  // open rather than closed.
  if (!secret || !presented || !(await secretsMatch(presented, secret))) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

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

function notFound() {
  return NextResponse.json({ error: 'Not found' }, { status: 404 });
}

export const GET = notFound;
export const HEAD = notFound;
export const OPTIONS = notFound;
export const PUT = notFound;
export const PATCH = notFound;
export const DELETE = notFound;
