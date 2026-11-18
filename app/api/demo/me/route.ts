import { NextResponse } from 'next/server';
import { clerkEnabled } from '@/lib/auth-mode';
import { isDemoUser } from '@/lib/demo';

// Whether the signed-in account is one of the shared demo accounts
// (lib/demo.ts, DEMO_USER_IDS), for the account menu (components/ClerkAccount.tsx):
// a demo account is never shown Clerk's account window, whose Security page
// lists every visitor's device and address. Asked of the server, which alone
// reads DEMO_USER_IDS, so nothing in the browser decides it.
//
//   GET  { user, demo }: the account it answers for, so a page whose viewer
//        changed in place (components/demo-sign-in.ts) can tell an answer
//        for the one before; 401 signed out, 404 without Clerk.
//
// Nothing is stored or read but the session, so it answers in one step.

const NO_STORE = { 'Cache-Control': 'no-store' };

export async function GET() {
  if (!clerkEnabled()) return NextResponse.json({ error: 'There are no accounts with the shared password.' }, { status: 404, headers: NO_STORE });
  const { auth } = await import('@clerk/nextjs/server');
  const userId = (await auth()).userId ?? null;
  if (!userId) return NextResponse.json({ error: 'Not signed in.' }, { status: 401, headers: NO_STORE });
  return NextResponse.json({ user: userId, demo: isDemoUser(userId) }, { headers: NO_STORE });
}
