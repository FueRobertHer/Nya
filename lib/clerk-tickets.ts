// lib/clerk-tickets.ts
//
// One-minute, single-use sign-in tickets (the demo buttons, lib/demo.ts):
// Clerk's sign-in page signs in whoever brings one. Its own module so tests
// mock this rather than Clerk.

export async function signInTicket(userId: string): Promise<string> {
  const { clerkClient } = await import('@clerk/nextjs/server');
  const { token } = await (await clerkClient()).signInTokens.createSignInToken({ userId, expiresInSeconds: 60 });
  return token;
}
