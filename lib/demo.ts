// lib/demo.ts
//
// One-click demo accounts, everywhere but production: exactly two Clerk users
// of the development instance, Alex and Sam, that anyone can try the app as,
// on Plaid's sandbox. They are the only accounts with a one-click sign-in.
// DEMO_USER_IDS gives each one's id, comma-separated, labelled with its name:
// "user_abc:Alex, user_def:Sam". An entry labelled anything else, or nothing,
// is ignored, so no other account can be given a demo button.
//
// Nothing here works on Production (VERCEL_ENV=production) or a self-hosted
// `next start`: set there by mistake, the variable does nothing, so a demo
// button can never sign anyone into production. Vercel's Preview and
// Development environments and a local `next dev` offer them.
//
// Demo accounts are allowed in without being on CLERK_ALLOWED_USER_IDS
// (lib/auth-mode.ts), and behave like any account (linking sandbox banks,
// connecting, sharing), except that they can't be deleted: the next visitor
// would find the demo gone. Instead each can be reset to a scenario, from
// Settings' Demo data card or a terminal (lib/demo-seed/reset.ts).

export type DemoUser = { id: string; label: string };

/** The demo accounts, in the order the sign-in page offers them. */
export const DEMO_NAMES = ['Alex', 'Sam'] as const;

/** How many demo sign-ins one address may start per window, and the window: a
 *  courtesy to Clerk, since each is a call to it (app/api/demo/sign-in). Here
 *  rather than in the route, which may export only its handler, so the public
 *  security page's statement of how long an address is kept can be tested.
 */
export const DEMO_SIGN_INS_PER_WINDOW = 20;
export const DEMO_WINDOW_SECONDS = 10 * 60;

/** What the sign-in page says when a demo sign-in couldn't be made: Clerk
 *  didn't give a ticket, or didn't sign in with it. */
export const DEMO_UNAVAILABLE = 'The demo couldn’t sign in just now. Try again.';

/** Whether this deployment may offer demo accounts at all: any Vercel
 *  environment but Production, or a local `next dev` off Vercel. */
export function demoEnvironment(): boolean {
  const vercel = process.env.VERCEL_ENV;
  if (vercel) return vercel === 'preview' || vercel === 'development';
  return process.env.NODE_ENV === 'development';
}

export function demoUsers(): DemoUser[] {
  if (!demoEnvironment()) return [];
  if (!process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY || !process.env.CLERK_SECRET_KEY) return [];
  // The first entry for each name wins, and one id can't be both.
  const ids = new Map<string, string>();
  for (const raw of (process.env.DEMO_USER_IDS ?? '').split(',')) {
    const [id, ...rest] = raw.trim().split(':');
    const label = rest.join(':').trim().toLowerCase();
    const name = DEMO_NAMES.find((n) => n.toLowerCase() === label);
    if (!id || !id.startsWith('user_') || !name || ids.has(name) || [...ids.values()].includes(id)) continue;
    ids.set(name, id);
  }
  return DEMO_NAMES.flatMap((label) => {
    const id = ids.get(label);
    return id ? [{ id, label }] : [];
  });
}

export function isDemoUser(userId: string): boolean {
  return demoUsers().some((u) => u.id === userId);
}
