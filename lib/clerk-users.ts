// lib/clerk-users.ts
//
// Changes to Clerk users themselves. Kept apart from the routes so tests mock
// this module rather than Clerk's, whose mocked shape differs between files.

/** Deletes the Clerk user: their sign-in, email and name, and their sessions. */
export async function deleteClerkUser(userId: string): Promise<void> {
  const { clerkClient } = await import('@clerk/nextjs/server');
  await (await clerkClient()).users.deleteUser(userId);
}
