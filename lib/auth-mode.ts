// lib/auth-mode.ts
//
// Which sign-in the app uses. Clerk (managed accounts, the start of #44) when
// both of its keys are set; otherwise the shared password (lib/auth.ts),
// unchanged. So a deployment without Clerk keys behaves exactly as before,
// and turning Clerk on or off is a change of environment, not of code.
//
// Only people on CLERK_ALLOWED_USER_IDS (comma-separated Clerk user ids) get
// in. Unset or empty lets nobody in: a signed-in stranger must never reach
// the data. Which data an allowed account reaches is lib/owners.ts: the
// first to sign in owns what is already here, each other its own.

export function clerkEnabled(): boolean {
  return !!process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY && !!process.env.CLERK_SECRET_KEY;
}

export function clerkUserAllowed(userId: string): boolean {
  const allowed = (process.env.CLERK_ALLOWED_USER_IDS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return allowed.includes(userId);
}
