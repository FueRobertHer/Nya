import { NextResponse } from 'next/server';
import { opsGuard, notPost } from '@/lib/ops';
import { rawRedis } from '@/lib/storage';
import { exportLines } from '@/lib/export';
import { keyArchiveNow } from '@/lib/key-archive';

// Download a complete copy of this environment's data (see lib/export.ts for
// the format and why the values stay encrypted). Bodies:
//
//   {} or empty       the data archive (format 2), which keeps no keys;
//   {"keys": true}    a key archive (lib/key-archive.ts): the key store as it
//                     stands, every key wrapped by the master. Take one with
//                     every data archive you keep by hand: a restore needs
//                     both. It keeps the keys of accounts deleted after it was
//                     taken for as long as you keep it, so keep it only for
//                     the restore you took it for.
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
//   curl -X POST https://<host>/api/ops/export -d '{"keys": true}' \
//     -H "Authorization: Bearer $OPS_SECRET" -o nya-keys.ndjson

// The walk scans the whole shared database and one transaction blob can be
// 8 MiB; the default limit is too tight for a database that has been
// accumulating for years.
export const maxDuration = 300;

const MAX_BODY_CHARS = 64;

export async function POST(req: Request) {
  const refused = await opsGuard(req);
  if (refused) return refused;

  const text = await req.text();
  if (text.length > MAX_BODY_CHARS) return NextResponse.json({ error: 'Body too large' }, { status: 413 });
  let asked: unknown = {};
  if (text.trim()) {
    try {
      asked = JSON.parse(text);
    } catch {
      return NextResponse.json({ error: 'Body must be valid JSON' }, { status: 400 });
    }
  }
  const b = asked as Record<string, unknown> | null;
  if (!b || typeof b !== 'object' || Array.isArray(b) || Object.keys(b).some((k) => k !== 'keys') || ('keys' in b && b.keys !== true)) {
    return NextResponse.json({ error: 'Send an empty body for the data archive, or {"keys": true} for a key archive.' }, { status: 400 });
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');

  if (b.keys === true) {
    try {
      const archive = await keyArchiveNow(rawRedis());
      return new Response(archive, {
        headers: {
          'Content-Type': 'application/x-ndjson',
          'Content-Disposition': `attachment; filename="nya-keys-${stamp}.ndjson"`,
          'Cache-Control': 'no-store',
        },
      });
    } catch (err) {
      // Never the key store's contents: only what kind of failure it was.
      console.error('Key archive export failed', err instanceof Error ? err.name : typeof err);
      return NextResponse.json({ error: 'The key archive could not be read. Check the logs and try again.' }, { status: 500 });
    }
  }

  const lines = exportLines(rawRedis());
  const encoder = new TextEncoder();

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
