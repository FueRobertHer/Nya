// components/sign-in-view.ts
//
// What the sign-in page shows while it hands over to the app
// (components/SignInFlow.tsx), apart from Clerk, so it can be tested alone.

/** How long a demo sign-in may take before the sign-in page shows again, so
 *  a ticket that didn't work (Clerk says so in its form) never leaves only a
 *  placeholder on screen. Loading Clerk and signing in takes a second or two. */
export const DEMO_WAIT_MS = 12_000;

export type SignInView = 'page' | 'signing-in' | 'loading';

/** What the sign-in page shows: the app loading once signed in when Home is
 *  next ("loading"); the same while a demo sign-in is on its way, until it
 *  has waited too long ("signing-in"); else itself. Once signed in for
 *  anywhere but Home (an invite link), Clerk's own form says so. */
export function signInView(s: { signedIn: boolean; home: boolean; demo: boolean; waited: boolean }): SignInView {
  if (s.signedIn) return s.home ? 'loading' : 'page';
  return s.demo && !s.waited ? 'signing-in' : 'page';
}

/** Whether Clerk goes Home after signing in: with no redirect_url (its
 *  default is "/"), or one whose path is "/", a notice email's
 *  /?view=connections included (proxy.ts returnPath). */
export function goesHome(redirect: string | string[] | undefined): boolean {
  if (redirect === undefined) return true;
  if (typeof redirect !== 'string') return false;
  try {
    return new URL(redirect, 'https://nya.invalid').pathname === '/';
  } catch {
    return false;
  }
}
