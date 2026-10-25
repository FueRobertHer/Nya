'use client';

// The sign-in page's frame (app/sign-in), and its hand-over to the app while
// a demo sign-in is on its way: from a demo button's press, and on the page
// it comes back to with Clerk's ticket, the app loading shows in the page's
// place (components/LoadingSkeletons.tsx AppLoading). Clerk's form stays
// mounted underneath, hidden: it signs in with the ticket and moves to Home,
// whose page streams the same view while it reads the session (app/page.tsx),
// and then the dashboard draws it again while it loads. Any other sign-in
// shows Clerk's form until Clerk moves to Home: Clerk sets the session only
// once it has moved, so there is nothing here to hand over on.

import { useEffect, useReducer, useState, type FormEvent, type ReactNode } from 'react';
import { AppLoading, SignInSkeleton } from './LoadingSkeletons';
import { DEMO_WAIT_MS, FORM_WAIT_MS, demoStart, demoStep } from './sign-in-view';

export function SignInFlow({ demoTicket, children }: { demoTicket: boolean; children: ReactNode }) {
  const [demo, dispatch] = useReducer(demoStep, demoTicket, demoStart);

  useEffect(() => {
    if (!demo.pending) return;
    const attempt = demo.attempt;
    const timer = setTimeout(() => dispatch({ type: 'waited', attempt }), DEMO_WAIT_MS);
    return () => clearTimeout(timer);
  }, [demo.pending, demo.attempt]);

  // Back to this page from the browser's cache (the demo's post answered
  // with an error page, say): the page again, not the placeholder.
  useEffect(() => {
    const shown = (e: PageTransitionEvent) => {
      if (e.persisted) dispatch({ type: 'back' });
    };
    window.addEventListener('pageshow', shown);
    return () => window.removeEventListener('pageshow', shown);
  }, []);

  // A demo button's form (data-demo-sign-in, app/sign-in) posts as forms
  // do, to app/api/demo/sign-in, which answers with this page and a ticket:
  // the app loading shows from the press, while the browser waits. Clerk's
  // own form submits through here too (its events bubble), and is left alone.
  const onSubmit = (e: FormEvent) => {
    if (e.target instanceof Element && e.target.closest('[data-demo-sign-in]')) dispatch({ type: 'press' });
  };

  return (
    <>
      <main className="auth-wrap" hidden={demo.pending} onSubmit={onSubmit}>
        {children}
      </main>
      {demo.pending && <AppLoading account="clerk" />}
    </>
  );
}

const FORM_LATE = 'The sign-in form hasn’t loaded. Check your connection, or anything that blocks scripts on this page, then reload it.';

/** Clerk's form's place while its script loads (the sign-in page's <SignIn
 *  fallback>). Should it not come, the page says so after FORM_WAIT_MS, and
 *  what may be in its way, rather than a placeholder that never ends. A
 *  screen reader hears it from the placeholder's status, so the notice
 *  itself is hidden from one. */
export function SignInPlaceholder() {
  const [late, setLate] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setLate(true), FORM_WAIT_MS);
    return () => clearTimeout(timer);
  }, []);
  return (
    <>
      <SignInSkeleton status={late ? FORM_LATE : 'Loading the sign-in form'} />
      {late && (
        <div className="notice caution auth-notice" aria-hidden="true">
          {ALERT}
          <div>{FORM_LATE}</div>
        </div>
      )}
    </>
  );
}

// As components/ConnectionStatus.tsx's ALERT, which brings too much with it
// for this page.
const ALERT = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M12 9v4M12 17h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" />
  </svg>
);
