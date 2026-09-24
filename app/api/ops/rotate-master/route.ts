import { NextResponse } from 'next/server';
import { opsGuard, notPost } from '@/lib/ops';
import { RotationError, finishMasterRotation, prepareMasterRotation } from '@/lib/crypto';

// Rotate the master key (see lib/crypto.ts). The whole procedure:
//
//   1. POST the new master here while the app still runs with the current one:
//        curl -X POST https://<host>/api/ops/rotate-master \
//          -H "Authorization: Bearer $OPS_SECRET" \
//          -H 'Content-Type: application/json' \
//          -d '{"new_master_key":"<base64 from openssl rand -base64 32>"}'
//      Every data key gets a lock for the new master too, checked before it
//      is saved. Your data itself is not touched.
//   2. Set MASTER_KEY to the new master in Vercel and redeploy.
//   3. Nothing: the new deployment removes the old locks by itself. POSTing
//      here with an empty body after the redeploy does it immediately and
//      reports what is left.
//
// Save the new master in your password manager BEFORE step 1.
//
// Locked like every /api/ops route (lib/ops.ts). The new key arrives in the
// body, never the URL, and is never logged or returned.

const MAX_BODY_CHARS = 1024;

export async function POST(req: Request) {
  const refused = await opsGuard(req);
  if (refused) return refused;

  const text = await req.text();
  if (text.length > MAX_BODY_CHARS) return NextResponse.json({ error: 'Body too large' }, { status: 413 });
  let body: { new_master_key?: unknown } = {};
  if (text.trim()) {
    try {
      body = JSON.parse(text);
    } catch {
      return NextResponse.json({ error: 'Body must be valid JSON' }, { status: 400 });
    }
  }

  try {
    if (body.new_master_key === undefined) {
      const { finished, pending } = await finishMasterRotation();
      return NextResponse.json({ finished, pending });
    }
    if (typeof body.new_master_key !== 'string') {
      return NextResponse.json({ error: 'new_master_key must be a string' }, { status: 400 });
    }
    const { prepared, fingerprint } = await prepareMasterRotation(body.new_master_key);
    return NextResponse.json({
      prepared,
      new_master_fingerprint: fingerprint,
      next_step: 'Set MASTER_KEY to the new key in Vercel and redeploy. The new deployment removes the old locks by itself.',
    });
  } catch (err) {
    if (err instanceof RotationError) return NextResponse.json({ error: err.message }, { status: 409 });
    // Never echo the request: it holds the new key.
    console.error('Master rotation failed', err instanceof Error ? err.message : err);
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Rotation failed' }, { status: 500 });
  }
}

export const { GET, HEAD, OPTIONS, PUT, PATCH, DELETE } = notPost;
