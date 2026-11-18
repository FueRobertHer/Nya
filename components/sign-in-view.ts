// components/sign-in-view.ts
//
// Where a demo sign-in is on the sign-in page (components/SignInFlow.tsx),
// apart from React, so it can be tested alone.

/** How long a demo sign-in may take before the sign-in page shows again, so
 *  a ticket that didn't work (Clerk says so in its form) never leaves only a
 *  placeholder on screen. Loading Clerk and signing in takes a second or two. */
export const DEMO_WAIT_MS = 12_000;

/** How long Clerk's form may take to load before the page says it hasn't,
 *  and what may be in its way. */
export const FORM_WAIT_MS = 15_000;

/** What the demo card says when the page came back after DEMO_WAIT_MS with
 *  nothing else said, as the password login does after its own wait. */
export const DEMO_LATE = 'Nya didn’t open. Try again, or reload the page.';

/** A demo sign-in: on its way or not, which press it is, so each press
 *  waits DEMO_WAIT_MS of its own, and whether the page is back because that
 *  wait ran out (late), which the demo card says. */
export type DemoState = { pending: boolean; attempt: number; late: boolean };

export type DemoEvent =
  | { type: 'press' }
  // DEMO_WAIT_MS passed since that press (or since the page came with a ticket).
  | { type: 'waited'; attempt: number }
  // The sign-in failed, and the demo card says why.
  | { type: 'failed' }
  // The page came back from the browser's cache.
  | { type: 'back' };

/** The first state: on its way when the page came with a demo ticket. Taken
 *  once, from the first render: Clerk takes the ticket out of the address and
 *  refreshes the page as it signs in, and that render, without the ticket,
 *  must not show the sign-in page again. */
export function demoStart(ticket: boolean): DemoState {
  return { pending: ticket, attempt: 0, late: false };
}

export function demoStep(s: DemoState, e: DemoEvent): DemoState {
  switch (e.type) {
    case 'press':
      return { pending: true, attempt: s.attempt + 1, late: false };
    case 'waited':
      // A wait from an earlier press, or one that outlived its sign-in, ends nothing.
      return e.attempt === s.attempt && s.pending ? { ...s, pending: false, late: true } : s;
    case 'failed':
    case 'back':
      // The demo card says why it failed; back from the cache, nothing went wrong.
      return { ...s, pending: false, late: false };
  }
}
