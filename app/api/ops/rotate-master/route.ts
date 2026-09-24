import { NextResponse } from 'next/server';
import { opsGuard, notPost } from '@/lib/ops';
import {
  MasterKeyError,
  RotationError,
  finishMasterRotation,
  prepareMasterRotation,
  rotationStatus,
} from '@/lib/crypto';

// Rotate the master key (see lib/crypto.ts, "Master rotation"). Three bodies:
//
//   {"new_master_key": "<base64>"}   step 1: prepare every data key for it
//   {} or empty                      report where a rotation stands
//   {"finish_now": true}             remove the old locks now, skipping the
//                                    24-hour rollback window (only works on
//                                    the deployment running the new master)
//
// Anything else is refused, so a misspelled field can never be mistaken for a
// request to do something else.
//
// Locked like every /api/ops route (lib/ops.ts). The new key arrives in the
// body, never the URL, and is never logged or returned: only its fingerprint
// is, so the key saved in a password manager can be checked against it.

// Opening and re-locking every data key is quick, but allow for many.
export const maxDuration = 60;

const MAX_BODY_CHARS = 1024;

function bad(message: string, status = 400) {
  return NextResponse.json({ error: message }, { status });
}

export async function POST(req: Request) {
  const refused = await opsGuard(req);
  if (refused) return refused;

  const text = await req.text();
  if (text.length > MAX_BODY_CHARS) return bad('Body too large', 413);
  let body: unknown = {};
  if (text.trim()) {
    try {
      body = JSON.parse(text);
    } catch {
      return bad('Body must be valid JSON');
    }
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return bad('Body must be a JSON object');
  }
  const fields = Object.keys(body);
  const b = body as Record<string, unknown>;

  try {
    if (fields.length === 0) {
      return NextResponse.json(await rotationStatus());
    }
    if (fields.length === 1 && fields[0] === 'new_master_key') {
      if (typeof b.new_master_key !== 'string') return bad('new_master_key must be a string');
      const { prepared, fingerprint } = await prepareMasterRotation(b.new_master_key);
      return NextResponse.json({
        prepared,
        new_master_fingerprint: fingerprint,
        next_step:
          'Check new_master_fingerprint matches the key you saved, then set MASTER_KEY to it in Vercel and redeploy. The old locks are removed 24 hours after the new deployment starts.',
      });
    }
    if (fields.length === 1 && fields[0] === 'finish_now' && b.finish_now === true) {
      return NextResponse.json(await finishMasterRotation({ force: true }));
    }
    return bad('Send {"new_master_key": "..."}, {"finish_now": true}, or an empty body.');
  } catch (err) {
    // Refusals carry a message written for you; they name key ids and
    // fingerprints, never key material.
    if (err instanceof RotationError || err instanceof MasterKeyError) return bad(err.message, 409);
    // Anything else (a database error, say) can quote stored values in its
    // message, so neither the response nor the log repeats it.
    console.error('Master rotation failed:', err instanceof Error ? err.name : typeof err);
    return bad('Rotation failed. Nothing was finished; check the logs and try again.', 500);
  }
}

export const { GET, HEAD, OPTIONS, PUT, PATCH, DELETE } = notPost;
