import { NextResponse } from 'next/server';
import { opsGuard, notPost } from '@/lib/ops';
import { MasterKeyError } from '@/lib/crypto';
import { reencrypt } from '@/lib/reencrypt';

// Move every stored value to the active data key (see lib/reencrypt.ts). Two
// bodies:
//
//   {} or empty       check only: count what is still under another key, and
//                     anything unreadable or unlisted. Writes nothing.
//   {"run": true}     move values, until done or the time limit. Call it
//                     again until it answers "complete": true.
//
// Anything else is refused. Locked like every /api/ops route (lib/ops.ts).
// The response carries key names, field names, counts and error types, never
// values.

export const maxDuration = 60;
/** Leaves room under maxDuration to finish the value in hand and answer. */
const BUDGET_MS = 40 * 1000;
const MAX_BODY_CHARS = 256;

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
  if (!body || typeof body !== 'object' || Array.isArray(body)) return bad('Body must be a JSON object');
  const fields = Object.keys(body);
  const run = fields.length === 1 && fields[0] === 'run' && (body as Record<string, unknown>).run === true;
  if (fields.length !== 0 && !run) return bad('Send {"run": true}, or an empty body to check.');

  try {
    return NextResponse.json(await reencrypt({ dryRun: !run, budgetMs: BUDGET_MS }));
  } catch (err) {
    // Written for you: names key ids and fingerprints, never key material.
    if (err instanceof MasterKeyError) return bad(err.message, 409);
    // Anything else (a database error) can quote stored values, so neither the
    // response nor the log repeats its message.
    console.error('Re-encryption failed:', err instanceof Error ? err.name : typeof err);
    return bad('Re-encryption stopped. Whatever was moved stays moved; check the logs and call it again.', 500);
  }
}

export const { GET, HEAD, OPTIONS, PUT, PATCH, DELETE } = notPost;
