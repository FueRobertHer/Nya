// One mock of Clerk for every test file, with one shared "who is signed in".
// Bun's module mocks are process-wide: with a mock per file, each keeping its
// own signed-in user, whichever file's loaded first answered for the rest,
// so results depended on file order. Import this instead of mocking Clerk.

import { mock } from 'bun:test';

const g = globalThis as { __nyaClerk?: { signedIn: string | null } };
export const clerk = (g.__nyaClerk ??= { signedIn: null });

const auth = async () => ({ userId: clerk.signedIn });
mock.module('@clerk/nextjs/server', () => ({
  auth,
  clerkMiddleware: (handler: any) => (req: any, event: any) => handler(auth, req, event),
}));
