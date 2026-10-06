import { NextResponse } from 'next/server';
import { clerkEnabled } from '@/lib/auth-mode';
import { deleteAccount, deletionCheck, DeletionRefused, SignInNotDeleted } from '@/lib/account-deletion';
import { backupProblem, backupRetention } from '@/lib/backup';
import { buildDeletionReceipt } from '@/lib/deletion-receipt';
import { plaidClient } from '@/lib/plaid';

// The signed-in account itself (lib/account-deletion.ts). Only with Clerk on:
// the shared password has no accounts to delete. Reads the Clerk user
// directly rather than through dataCtx, which refuses an archived container,
// so a deletion that stopped part way can be run again.
//
// A finished deletion answers with its receipt (lib/deletion-receipt.ts): what
// was deleted, when the last backup holding it expires, and what stays. One
// that stopped after deleting the data but not the sign-in answers with what
// it did delete (deleted_so_far), so the receipt the retry ends with counts it.

// Counting what is stored reads all of it once, and each bank is a call to
// Plaid: more than the default allows for a large account.
export const maxDuration = 60;

async function signedIn(): Promise<string | null> {
  const { auth } = await import('@clerk/nextjs/server');
  return (await auth()).userId ?? null;
}

/** The longest a backup can keep a copy, for the warning before deleting:
 *  null when this server keeps none, or it can't be worked out. */
function backupDays(): number | null {
  const r = backupRetention();
  return r?.kept ? r.max_days : null;
}

export async function GET() {
  if (!clerkEnabled()) return NextResponse.json({ enabled: false });
  const userId = await signedIn();
  if (!userId) return NextResponse.json({ error: 'Not signed in.' }, { status: 401 });
  const check = await deletionCheck(userId);
  return NextResponse.json({
    enabled: true,
    can_delete: check.allowed,
    ...(check.allowed ? { backup_days: backupDays() } : { reason: check.reason }),
  });
}

/** { confirm: "DELETE" }: deletes this account and all its data. */
export async function DELETE(req: Request) {
  if (!clerkEnabled()) return NextResponse.json({ error: 'There are no accounts to delete with the shared password.' }, { status: 400 });
  const userId = await signedIn();
  if (!userId) return NextResponse.json({ error: 'Not signed in.' }, { status: 401 });
  const body = await req.json().catch(() => null);
  if (body?.confirm !== 'DELETE') return NextResponse.json({ error: 'Type DELETE to confirm.' }, { status: 400 });
  try {
    const result = await deleteAccount(userId, {
      removeItem: async (access_token) => {
        await plaidClient.itemRemove({ access_token });
      },
      deleteUser: async (id) => (await import('@/lib/clerk-users')).deleteClerkUser(id),
    });
    const now = new Date();
    const receipt = buildDeletionReceipt({
      counts: result.counts,
      found_data: result.found_data,
      resumed: result.resumed,
      deleted_at: now,
      retention: backupRetention(),
      stopped: (await backupProblem(now)) !== null,
    });
    return NextResponse.json({ deleted: true, disconnected: result.disconnected, deletedKeys: result.deletedKeys, receipt });
  } catch (err) {
    if (err instanceof DeletionRefused) return NextResponse.json({ error: err.message }, { status: 409 });
    const cause = err instanceof SignInNotDeleted && err.cause instanceof Error ? `: ${err.cause.name}` : '';
    console.error('Account deletion failed', err instanceof Error ? `${err.name}${cause}` : err);
    return NextResponse.json(
      {
        error: 'The deletion stopped part way. Run it again to finish.',
        ...(err instanceof SignInNotDeleted ? { deleted_so_far: err.counts } : {}),
      },
      { status: 500 }
    );
  }
}
