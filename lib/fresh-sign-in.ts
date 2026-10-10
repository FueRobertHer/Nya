// lib/fresh-sign-in.ts
//
// A fresh sign-in, on top of the session the proxy already checked, for the
// actions that hand over more than a page does: downloading everything
// (app/api/my-data) and making an API token (app/api/api-tokens), which keeps
// reading the data after every session has ended. So a stolen session cookie
// can do neither on its own.
//
//   - with Clerk (lib/auth-mode.ts), a sign-in verified within the last ten
//     minutes (Clerk's "strict" reverification: the second factor if the
//     account has one, the first otherwise). Without it the answer is Clerk's
//     reverification hint, a 403 its useReverification hook knows: it asks
//     the person to confirm it is them, then sends the request again.
//   - with the shared password, the password again, in the request, compared
//     in constant time. Wrong ones count against the login's own limit (per
//     IP, lib/rate-limit.ts), so this can't be used to guess the password
//     faster than the login allows. A wrong password is a 403, never a 401:
//     the dashboard takes any 401 to mean signed out.

import { NextResponse } from 'next/server';
import { clerkEnabled } from './auth-mode';
import { verifyPassword } from './auth';
import { passwordAttemptsExhausted, countWrongPassword, clearWrongPasswords } from './rate-limit';

/** How recent a Clerk sign-in must be (see the header). */
export const FRESH = 'strict' as const;

/** The longest password a request may carry. */
export const PASSWORD_MAX = 1024;

/** The fresh sign-in, or the response to send instead. `password` is what the
 *  request carried (null for none); `userId` is the Clerk account, null with
 *  the shared password. */
export async function freshSignIn(req: Request, password: string | null): Promise<{ userId: string | null } | NextResponse> {
  if (clerkEnabled()) {
    const { auth, reverificationError } = await import('@clerk/nextjs/server');
    const { userId, has } = await auth();
    if (!userId) return NextResponse.json({ error: 'Not signed in.' }, { status: 401 });
    if (!has({ reverification: FRESH })) return NextResponse.json(reverificationError(FRESH), { status: 403 });
    return { userId };
  }
  if (await passwordAttemptsExhausted(req)) {
    return NextResponse.json({ error: 'Too many wrong passwords. Try again in a few minutes.' }, { status: 429 });
  }
  if (!password || !(await verifyPassword(password))) {
    await countWrongPassword(req);
    return NextResponse.json({ error: 'That password isn’t right.', wrong_password: true }, { status: 403 });
  }
  await clearWrongPasswords(req);
  return { userId: null };
}
