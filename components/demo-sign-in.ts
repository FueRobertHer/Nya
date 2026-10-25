// components/demo-sign-in.ts
//
// A demo button's sign-in, in place (components/DemoSignIn.tsx): the ticket
// from app/api/demo/sign-in, signed in with through Clerk, which then moves
// to Home. No page loads again, so Clerk doesn't start over. Apart from React
// and Clerk's provider, so it can be tested alone.

import { DEMO_UNAVAILABLE } from '@/lib/demo';

/** What this needs of Clerk (useClerk): its client's sign-in, and setActive. */
export type TicketClerk = {
  client?: {
    signIn: { create(params: { strategy: 'ticket'; ticket: string }): Promise<{ status: string | null; createdSessionId: string | null }> };
  } | null;
  setActive(params: { session: string; redirectUrl: string }): Promise<unknown>;
};

export type DemoResult = { ok: true } | { ok: false; error: string };

/** Signs in as the demo account `user` (its Clerk id). Done once Clerk has
 *  moved to Home; otherwise what to tell the person: the route's own words
 *  (too many sign-ins from this address), or that it couldn't just now. */
export async function demoSignIn(user: string, clerk: TicketClerk, post: typeof fetch = fetch): Promise<DemoResult> {
  let ticket: unknown;
  try {
    const body = new FormData();
    body.set('user', user);
    const res = await post('/api/demo/sign-in', { method: 'POST', body, headers: { Accept: 'application/json' } });
    const data = await res.json().catch(() => null);
    if (!res.ok) return { ok: false, error: typeof data?.error === 'string' ? data.error : DEMO_UNAVAILABLE };
    ticket = data?.ticket;
  } catch {
    return { ok: false, error: DEMO_UNAVAILABLE };
  }
  if (typeof ticket !== 'string' || !clerk.client) return { ok: false, error: DEMO_UNAVAILABLE };
  try {
    const attempt = await clerk.client.signIn.create({ strategy: 'ticket', ticket });
    if (attempt.status !== 'complete' || !attempt.createdSessionId) return { ok: false, error: DEMO_UNAVAILABLE };
    // Moves to Home before the session is set, and resolves once it has.
    await clerk.setActive({ session: attempt.createdSessionId, redirectUrl: '/' });
    return { ok: true };
  } catch {
    return { ok: false, error: DEMO_UNAVAILABLE };
  }
}
