// lib/demo.ts
//
// One-click demo accounts, on Vercel Preview only: two (or more) Clerk users
// of the development instance that anyone can try the app as, on Plaid's
// sandbox. They are named in DEMO_USER_IDS, comma-separated, each an id with
// an optional label: "user_abc:Alex, user_def:Sam".
//
// Nothing here works anywhere but Preview (VERCEL_ENV=preview) or a local
// `next dev`: set on Production by mistake, the variable does nothing, so a
// demo button can never sign anyone into production.
//
// Demo accounts are allowed in without being on CLERK_ALLOWED_USER_IDS
// (lib/auth-mode.ts), and behave like any account (linking sandbox banks,
// connecting, sharing), except that they can't be deleted: the next visitor
// would find the demo gone.

export type DemoUser = { id: string; label: string };

/** Whether this deployment may offer demo accounts at all. */
export function demoEnvironment(): boolean {
  return process.env.VERCEL_ENV === 'preview' || (process.env.NODE_ENV === 'development' && !process.env.VERCEL_ENV);
}

export function demoUsers(): DemoUser[] {
  if (!demoEnvironment()) return [];
  if (!process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY || !process.env.CLERK_SECRET_KEY) return [];
  const out: DemoUser[] = [];
  for (const [i, raw] of (process.env.DEMO_USER_IDS ?? '').split(',').entries()) {
    const [id, ...rest] = raw.trim().split(':');
    if (!id || !id.startsWith('user_')) continue;
    out.push({ id, label: rest.join(':').trim().slice(0, 24) || `Demo ${i + 1}` });
  }
  return out;
}

export function isDemoUser(userId: string): boolean {
  return demoUsers().some((u) => u.id === userId);
}
