import { NextResponse } from 'next/server';
import { clerkEnabled } from '@/lib/auth-mode';
import { deleteAccount, deletionCheck, DeletionRefused } from '@/lib/account-deletion';
import { plaidClient } from '@/lib/plaid';

// The signed-in account itself (lib/account-deletion.ts). Only with Clerk on:
// the shared password has no accounts to delete. Reads the Clerk user
// directly rather than through dataCtx, which refuses an archived container,
// so a deletion that stopped part way can be run again.

async function signedIn(): Promise<string | null> {
  const { auth } = await import('@clerk/nextjs/server');
  return (await auth()).userId ?? null;
}

export async function GET() {
  if (!clerkEnabled()) return NextResponse.json({ enabled: false });
  const userId = await signedIn();
  if (!userId) return NextResponse.json({ error: 'Not signed in.' }, { status: 401 });
  const check = await deletionCheck(userId);
  return NextResponse.json({ enabled: true, can_delete: check.allowed, ...(check.allowed ? {} : { reason: check.reason }) });
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
    return NextResponse.json({ deleted: true, ...result });
  } catch (err) {
    if (err instanceof DeletionRefused) return NextResponse.json({ error: err.message }, { status: 409 });
    console.error('Account deletion failed', err instanceof Error ? err.name : err);
    return NextResponse.json({ error: 'The deletion stopped part way. Run it again to finish.' }, { status: 500 });
  }
}
