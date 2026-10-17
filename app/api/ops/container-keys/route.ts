import { NextResponse } from 'next/server';
import { opsGuard, notPost } from '@/lib/ops';
import { isContainerId } from '@/lib/containers';
import { vercelBlobStore } from '@/lib/backup';
import { containerKeyStatus, destroyKeysOf } from '@/lib/container-key-ops';

// The data keys per container (lib/container-key-ops.ts; docs/operations.md,
// "Per-container data keys"). Bodies:
//
//   {} or empty       the status: containers with a key and how many are
//                     moved, those without one or not yet moved, keys whose
//                     container is gone from the registry, map entries naming
//                     a key the store lacks, keys the newest key archive
//                     carries forward, the tombstones, and how far the key
//                     numbers are from their cap. Writes nothing.
//   {"destroy_keys_of": ["<container id>", ...]}
//                     destroys the keys of the containers named, each only if
//                     the registry no longer lists it, as a deletion does, and
//                     rewrites the key archives without them. For keys an
//                     account deleted while rolled back left behind.
//
// Anything else is refused. Locked like every /api/ops route (lib/ops.ts).
// Answers name containers, key ids and counts, never a key.

const MAX_BODY_CHARS = 4096;
const MAX_IDS = 50;

function bad(message: string, status = 400) {
  return NextResponse.json({ error: message }, { status });
}

export async function POST(req: Request) {
  const refused = await opsGuard(req);
  if (refused) return refused;

  const text = await req.text();
  if (text.length > MAX_BODY_CHARS) return bad('Body too large', 413);
  let asked: unknown = {};
  if (text.trim()) {
    try {
      asked = JSON.parse(text);
    } catch {
      return bad('Body must be valid JSON');
    }
  }
  if (!asked || typeof asked !== 'object' || Array.isArray(asked)) return bad('Body must be a JSON object');
  const b = asked as Record<string, unknown>;
  const fields = Object.keys(b);
  const destroy = fields.length === 1 && fields[0] === 'destroy_keys_of';
  if (fields.length !== 0 && !destroy) return bad('Send {"destroy_keys_of": ["<container id>"]}, or an empty body for the status.');
  if (destroy) {
    const ids = b.destroy_keys_of;
    if (!Array.isArray(ids) || ids.length === 0 || ids.length > MAX_IDS || !ids.every((id) => isContainerId(id))) {
      return bad(`"destroy_keys_of" must be a list of 1 to ${MAX_IDS} container ids.`);
    }
  }

  try {
    const store = await vercelBlobStore();
    if (destroy) return NextResponse.json(await destroyKeysOf([...new Set(b.destroy_keys_of as string[])], store));
    return NextResponse.json(await containerKeyStatus(store));
  } catch (err) {
    // Never the key store's contents: only what kind of failure it was.
    console.error('Container key operation failed:', err instanceof Error ? err.name : typeof err);
    return bad('Container key operation failed; check the logs and try again.', 500);
  }
}

export const { GET, HEAD, OPTIONS, PUT, PATCH, DELETE } = notPost;
