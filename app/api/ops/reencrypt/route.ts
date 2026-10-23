import { NextResponse } from 'next/server';
import { opsGuard, notPost } from '@/lib/ops';
import { MasterKeyError } from '@/lib/crypto';
import { isContainerId } from '@/lib/containers';
import { reencrypt } from '@/lib/reencrypt';

// The migration pass: give each container a data key of its own and move its
// values to it (see lib/reencrypt.ts). Bodies:
//
//   {} or empty       check only: per container, whether it has a key, is
//                     moved, and what is still under another key; anything
//                     unreadable or unlisted. Writes nothing.
//   {"run": true}     make keys and move values, until done or the time
//                     limit. Call it again until it answers "complete": true.
//   "after": "<id>"   with either: start after this container, the
//                     `next_after` of the call before, so a sequence of calls
//                     reaches every container however many there are.
//   "after_rollback": true
//                     with "run": data archives were taken by hand while
//                     rolled back, which the backups can't see: every
//                     container's `moved` is cleared, and its `shared_in` dated
//                     now, first.
//
// Anything else is refused. Locked like every /api/ops route (lib/ops.ts).
// The response carries container ids, key names, field names, counts and error
// types, never values.

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
  const b = body as Record<string, unknown>;
  const fields = Object.keys(b);
  const known = new Set(['run', 'after', 'after_rollback']);
  if (fields.some((f) => !known.has(f))) return bad('Send {"run": true}, or an empty body to check, each with "after" if you have one.');
  if ('run' in b && b.run !== true) return bad('"run" can only be true.');
  if ('after' in b && !isContainerId(b.after)) return bad('"after" must be a container id: the next_after of the call before.');
  if ('after_rollback' in b && (b.after_rollback !== true || b.run !== true)) return bad('"after_rollback" can only be true, and only with "run".');
  const run = b.run === true;

  try {
    return NextResponse.json(
      await reencrypt({ dryRun: !run, budgetMs: BUDGET_MS, after: (b.after as string | undefined) ?? null, afterRollback: b.after_rollback === true })
    );
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
