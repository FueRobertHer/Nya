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
// Every name the app takes from Clerk's server module, clerkClient too: a
// module mock replaces only the names it gives, so with one left out, a file
// that loaded Clerk's real module first (through proxy.ts, say) would leave
// the real one in place for every file after it. Clerk's API is never
// reachable from a test, so every call to it fails, the same in any order.
mock.module('@clerk/nextjs/server', () => ({
  auth,
  clerkMiddleware: (handler: any) => (req: any, event: any) => handler(auth, req, event),
  reverificationError,
  clerkClient: async () => {
    throw new Error('Clerk’s API is not reachable from a test');
  },
}));
