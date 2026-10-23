import { NextResponse } from 'next/server';
import { opsGuard, notPost } from '@/lib/ops';
import { getContainer, isContainerId, type Ctx } from '@/lib/containers';
import { checkContainerKey } from '@/lib/crypto';
import { findSignFlips, repairSignFlip, SignRepairRefused } from '@/lib/sign-repair';
import { ForgetRefused } from '@/lib/links';

// Accounts whose past balances are read the other way on some days: a manual
// account changed between money held and money owed under a release before
// the app refused it, or one SimpleFIN or Lunch Flow keeps up to date whose
// kind was changed under a release before the change re-signed its history
// (lib/sign-repair.ts; docs/operations.md, "Repairing balance signs").
// Bodies:
//
//   {"container": "<id>"}
//         the dry run: every such account in the container, with the days
//         its totals say were counted the other way (how many, by layer, the
//         first and the last), or the days that can't be told and why, and
//         a repair already under way. Writes nothing.
//   {"container": "<id>", "account_id": "<id>", "repair": true}
//         repairs that one account, or finishes its repair if one is under
//         way: refused (409), with nothing written, when a day can't be told.
//
// Anything else is refused. Locked like every /api/ops route (lib/ops.ts).
// Answers name ids, days and counts, never an amount or a name.

// A repair negates each day in one step under the links lock, which is
// sized to this (lib/links.ts LINKS_LOCK_REQUEST_SECONDS).
export const maxDuration = 120;

const MAX_BODY_CHARS = 1024;
const ACCOUNT_ID = /^[A-Za-z0-9_.:-]{1,200}$/;

function bad(message: string, status = 400) {
  return NextResponse.json({ error: message }, { status });
}

export async function POST(req: Request) {
  const refused = await opsGuard(req);
  if (refused) return refused;

  const text = await req.text();
  if (text.length > MAX_BODY_CHARS) return bad('Body too large', 413);
  let asked: unknown;
  try {
    asked = JSON.parse(text || 'null');
  } catch {
    return bad('Body must be valid JSON');
  }
  if (!asked || typeof asked !== 'object' || Array.isArray(asked)) return bad('Body must be a JSON object');
  const b = asked as Record<string, unknown>;
  const fields = Object.keys(b).sort().join(',');
  const dry = fields === 'container';
  const repair = fields === 'account_id,container,repair' && b.repair === true && typeof b.account_id === 'string' && ACCOUNT_ID.test(b.account_id);
  if (!dry && !repair) return bad('Send {"container": "<id>"} for the dry run, or {"container": "<id>", "account_id": "<id>", "repair": true}.');
  if (!isContainerId(b.container)) return bad('"container" must be a container id.');

  const container = b.container;
  try {
    const record = await getContainer(container);
    if (!record) return bad('No container has that id.', 404);
    if (record.status !== 'active') return bad(`The container is ${record.status}: try again once it is active.`, 409);
    const ctx: Ctx = { container };
    // Its key opened first, so a key that can't be used fails here, before
    // anything is read.
    await checkContainerKey(ctx);
    if (dry) return NextResponse.json({ container, accounts: await findSignFlips(ctx) });
    const done = await repairSignFlip(ctx, b.account_id as string);
    return NextResponse.json({ container, account_id: b.account_id, negated: done.negated });
  } catch (err) {
    if (err instanceof SignRepairRefused) return NextResponse.json({ error: err.message, days: err.days }, { status: 409 });
    if (err instanceof ForgetRefused) return NextResponse.json({ error: err.message }, { status: 409 });
    console.error('Sign repair failed:', err instanceof Error ? err.name : typeof err);
    return bad('The repair failed; check the logs and try again: what was done is kept, and the rest is finished by trying again.', 500);
  }
}

export const { GET, HEAD, OPTIONS, PUT, PATCH, DELETE } = notPost;
