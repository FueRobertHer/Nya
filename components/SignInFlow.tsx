'use client';

// The sign-in page's frame (app/sign-in), and its hand-over to the app. While
// a demo button's sign-in is on its way, and once Clerk says this visit has
// signed in and Home is next, the page shows the app loading in its place
// (components/LoadingSkeletons.tsx AppLoading): the header and the Net worth
// card the dashboard then draws again while it loads, so the sign-in card
// changing size, the page going blank and the dashboard growing from a
// spinner all go. Clerk's form stays mounted underneath, hidden: Clerk
// finishes the sign-in and moves to the app from it.

import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { useAuth } from '@clerk/nextjs';
import { AppLoading } from './LoadingSkeletons';
import { DEMO_WAIT_MS, signInView } from './sign-in-view';

export function SignInFlow({ demoTicket, home, children }: { demoTicket: boolean; home: boolean; children: ReactNode }) {
  const { isLoaded, isSignedIn } = useAuth();
  // Someone already signed in who opens this page (adding an account) is
  // shown it: only a sign-in made here hands over, or a demo ticket's.
  const sawSignedOut = useRef(false);
  const [signedIn, setSignedIn] = useState(false);
  const [demoSent, setDemoSent] = useState(false);
  const [waited, setWaited] = useState(false);
  const demo = demoTicket || demoSent;

  useEffect(() => {
    if (!isLoaded) return;
    if (!isSignedIn) sawSignedOut.current = true;
    else if (sawSignedOut.current || demoTicket) setSignedIn(true);
  }, [isLoaded, isSignedIn, demoTicket]);

  useEffect(() => {
    if (!demo || signedIn) return;
    const timer = setTimeout(() => setWaited(true), DEMO_WAIT_MS);
    return () => clearTimeout(timer);
  }, [demo, signedIn]);

  // Back to this page from the browser's cache (the demo's post answered
  // with an error page, say): the page again, not the placeholder.
  useEffect(() => {
    const shown = (e: PageTransitionEvent) => {
      if (e.persisted) setDemoSent(false);
    };
    window.addEventListener('pageshow', shown);
    return () => window.removeEventListener('pageshow', shown);
  }, []);

  // A demo button's form (data-demo-sign-in, app/sign-in) posts as forms
  // do, to app/api/demo/sign-in, which answers with this page and a ticket:
  // the app loading shows from the press, while the browser waits. Clerk's
  // own form submits through here too (its events bubble), and is left alone.
  const onSubmit = (e: FormEvent) => {
    if (!(e.target instanceof Element) || !e.target.closest('[data-demo-sign-in]')) return;
    setDemoSent(true);
    setWaited(false);
  };

  const view = signInView({ signedIn, home, demo, waited });
  return (
    <>
      <main className="auth-wrap" hidden={view !== 'page'} onSubmit={onSubmit}>
        {children}
      </main>
      {view !== 'page' && <AppLoading account="clerk" />}
    </>
  );
}
