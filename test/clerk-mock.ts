// One mock of Clerk for every test file, with one shared "who is signed in".
// Bun's module mocks are process-wide: with a mock per file, each keeping its
// own signed-in user, whichever file's loaded first answered for the rest,
// so results depended on file order. Import this instead of mocking Clerk.
//
// `reverified` answers Clerk's has({ reverification }) check, a sign-in
// recent enough for a sensitive action (app/api/my-data). True unless a test
// says otherwise. reverificationError is Clerk's own, so the hint a route
// sends is exactly the one the client's useReverification hook looks for.

import { mock } from 'bun:test';
import { reverificationError } from '@clerk/backend/internal';

const g = globalThis as { __nyaClerk?: { signedIn: string | null; reverified: boolean } };
export const clerk = (g.__nyaClerk ??= { signedIn: null, reverified: true });

const auth = async () => ({
  userId: clerk.signedIn,
  has: (params: { reverification?: unknown }) => !!clerk.signedIn && (params?.reverification === undefined || clerk.reverified),
});
mock.module('@clerk/nextjs/server', () => ({
  auth,
  clerkMiddleware: (handler: any) => (req: any, event: any) => handler(auth, req, event),
  reverificationError,
}));
