import { NextResponse } from 'next/server';
import {
  getManualAccounts,
  getManualAccount,
  saveManualAccount,
  removeManualAccount,
  normalizeInstitutionName,
  isManualId,
  isOwedType,
  newManualId,
  MANUAL_TYPES,
  MAX_BALANCE,
  type ManualAccount,
  type ManualType,
} from '@/lib/manual';
import { clearCaches } from '@/lib/cache';
import { clearBackfillDone } from '@/lib/history';
import { pruneHidden } from '@/lib/hidden';

// CRUD for manually-tracked accounts, deliberately ONE ACCOUNT PER REQUEST.
//
// The obvious shape here is the /api/goals one: the client PUTs the whole list
// and the server replaces it. That is unsafe for these records. The client's
// list is derived from the last /api/net-worth payload, which can be stale (a
// tab left open, a second device, the localStorage snapshot painted before the
// network load resolves) or *empty* (a manual-accounts read failure renders as
// an institution with an error and no accounts). A whole-list write from any of
// those states would delete every account the client didn't know about, and
// each deletion orphans that account's balance history permanently, since
// re-adding mints a new random id.
//
// Per-account operations remove the entire class: a request can only affect the
// account it names. It also means a scheduled push to /api/ingest/balance can't
// be reverted by an unrelated edit made in a stale tab.

const MAX_ACCOUNTS = 50;

type DraftInput = {
  name?: unknown;
  institution_name?: unknown;
  type?: unknown;
  subtype?: unknown;
  balance?: unknown;
};

type Validated = Omit<ManualAccount, 'account_id' | 'updated_at'>;

/** Shared field validation for create and update. Returns an error string, or
 *  the cleaned fields. */
function validate(body: DraftInput): { error: string } | { value: Validated } {
  const name = String(body?.name ?? '').trim().slice(0, 60);
  const institution_name = normalizeInstitutionName(String(body?.institution_name ?? '')).slice(0, 60);
  const type = String(body?.type ?? '') as ManualType;
  const subtype = body?.subtype == null ? null : String(body.subtype).trim().slice(0, 40) || null;
  const balance = Number(body?.balance);

  if (!name || !institution_name) return { error: 'Name and institution are required' };
  if (!MANUAL_TYPES.includes(type)) return { error: 'Invalid account type' };
  // Unlike a savings goal, a balance of 0 is meaningful and a negative one is
  // legitimate (an overdrawn checking account), so only reject values that
  // aren't real numbers.
  if (!Number.isFinite(balance) || Math.abs(balance) > MAX_BALANCE) {
    return { error: 'Invalid balance' };
  }
  // Credit and loan balances are amounts OWED, which computeNetWorth()
  // subtracts. Accepting a negative here would double-negate into positive net
  // worth, so a "-500" card balance is a user error, not a credit.
  if (isOwedType(type) && balance < 0) {
    return { error: 'Credit and loan balances are the amount owed, so they cannot be negative' };
  }
  return { value: { name, institution_name, type, subtype, balance } };
}

/** Cached payloads still hold the old balances. The backfill flag is cleared
 *  only when the numbers actually moved: the estimated history layer was
 *  reconstructed without this account, so it would sit short by its balance
 *  and put a visible step at the estimated/real seam. A rename doesn't change
 *  any total, and recomputing forces a full Plaid transaction re-pull. */
async function invalidate(balanceChanged: boolean): Promise<void> {
  await clearCaches();
  if (balanceChanged) await clearBackfillDone();
}

export async function GET() {
  try {
    return NextResponse.json({ accounts: await getManualAccounts() });
  } catch (err) {
    console.error(err);
    return NextResponse.json({ error: 'Failed to load manual accounts' }, { status: 500 });
  }
}

/** Creates one account. The id is minted server-side so a client can't choose
 *  one that collides with an existing account's history. */
export async function POST(req: Request) {
  try {
    const body = await req.json();
    const result = validate(body);
    if ('error' in result) return NextResponse.json({ error: result.error }, { status: 400 });

    // Throws (and 500s) rather than treating an unreadable hash as empty.
    const existing = await getManualAccounts();
    if (existing.length >= MAX_ACCOUNTS) {
      return NextResponse.json(
        { error: `At most ${MAX_ACCOUNTS} manual accounts` },
        { status: 400 }
      );
    }

    const account: ManualAccount = {
      ...result.value,
      account_id: newManualId(),
      updated_at: new Date().toISOString(),
    };
    await saveManualAccount(account);
    await invalidate(true);
    return NextResponse.json({ account });
  } catch (err) {
    console.error(err);
    return NextResponse.json({ error: 'Failed to add manual account' }, { status: 500 });
  }
}

/** Updates one existing account in place. Only the named account is written. */
export async function PATCH(req: Request) {
  try {
    const body = await req.json();
    const account_id = String(body?.account_id ?? '').slice(0, 80);
    if (!account_id || !isManualId(account_id)) {
      return NextResponse.json({ error: 'Invalid account id' }, { status: 400 });
    }
    const result = validate(body);
    if ('error' in result) return NextResponse.json({ error: result.error }, { status: 400 });

    const existing = await getManualAccount(account_id);
    if (!existing) {
      return NextResponse.json({ error: 'That account no longer exists' }, { status: 404 });
    }

    const balanceChanged = existing.balance !== result.value.balance;
    const account: ManualAccount = {
      ...result.value,
      account_id,
      // Only stamp updated_at when the balance actually moved, so the "Updated
      // ..." line reflects the last real balance change rather than a rename.
      updated_at: balanceChanged ? new Date().toISOString() : existing.updated_at,
    };
    await saveManualAccount(account);
    await invalidate(balanceChanged);
    return NextResponse.json({ account });
  } catch (err) {
    console.error(err);
    return NextResponse.json({ error: 'Failed to update manual account' }, { status: 500 });
  }
}

/** Removes one account. Its balance history is intentionally left in place:
 *  history is keyed by date, not by account, and rewriting past dates is
 *  something this app never does. The orphaned series is unreachable once the
 *  account is gone. */
export async function DELETE(req: Request) {
  try {
    const body = await req.json();
    const account_id = String(body?.account_id ?? '').slice(0, 80);
    if (!account_id || !isManualId(account_id)) {
      return NextResponse.json({ error: 'Invalid account id' }, { status: 400 });
    }
    await removeManualAccount(account_id);
    // The account is gone, so a hidden entry naming it would linger forever.
    await pruneHidden([account_id]);
    await invalidate(true);
    return NextResponse.json({ success: true });
  } catch (err) {
    console.error(err);
    return NextResponse.json({ error: 'Failed to remove manual account' }, { status: 500 });
  }
}
