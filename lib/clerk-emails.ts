// lib/clerk-emails.ts
//
// A Clerk user's email addresses and whether each is verified, for allowlist
// entries that are emails (lib/auth-mode.ts, which counts only verified ones).
// Its own module so tests mock this rather than Clerk.

export async function emailAddresses(userId: string): Promise<{ address: string; verified: boolean }[]> {
  const { clerkClient } = await import('@clerk/nextjs/server');
  const user = await (await clerkClient()).users.getUser(userId);
  return user.emailAddresses.map((e) => ({ address: e.emailAddress, verified: e.verification?.status === 'verified' }));
}
