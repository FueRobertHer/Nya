'use client';

// The demo accounts' card on the sign-in page (lib/demo.ts). Each button is a
// tonal two-line button (the name, then what the account is set up to hold)
// in a form that posts to app/api/demo/sign-in. With Clerk loaded, a press instead
// asks that route for the ticket and signs in with it in place
// (components/demo-sign-in.ts), so no page loads again; the app loading shows
// from the press (components/SignInFlow.tsx) until Clerk has moved to Home.
// Before Clerk has loaded, or without script, the form posts as forms do and
// the page comes back with the ticket, which Clerk's form signs in with.

import { useState, type FormEvent } from 'react';
import { useClerk } from '@clerk/nextjs';
import { DEMO_UNAVAILABLE, type DemoUser } from '@/lib/demo';
import { useDemoHold } from './SignInFlow';
import { demoSignIn } from './demo-sign-in';

/** A demo account, with the few words its button says it holds
 *  (lib/demo-seed/scenarios.ts demoHolds, read by the page on the server). */
export type DemoChoice = DemoUser & { holds: string };

export default function DemoSignIn({ demos, unavailable }: { demos: DemoChoice[]; unavailable: boolean }) {
  const clerk = useClerk();
  const hold = useDemoHold();
  const [error, setError] = useState<string | null>(unavailable ? DEMO_UNAVAILABLE : null);

  const onSubmit = (e: FormEvent<HTMLFormElement>) => {
    setError(null);
    hold.start();
    if (!clerk.loaded || !clerk.client) return;
    e.preventDefault();
    const user = String(new FormData(e.currentTarget).get('user') ?? '');
    void demoSignIn(user, clerk).then((result) => {
      if (result.ok) return;
      hold.stop();
      setError(result.error);
    });
  };

  return (
    <div className="card demo-panel">
      <div className="card-header">
        <h2>Try the demo</h2>
      </div>
      <div className="stack">
        <p className="helper">
          Sign in as a demo account, with pretend banks from Plaid&apos;s sandbox. Everyone who tries it shares these
          accounts, so anything you add is visible to others.
        </p>
        <div className="stack tight">
          {demos.map((u) => (
            <form key={u.id} method="post" action="/api/demo/sign-in" onSubmit={onSubmit}>
              <input type="hidden" name="user" value={u.id} />
              {/* Tonal, so Clerk's Continue stays the one filled button. The
                  name, then what the account is set up to hold; a hidden
                  comma keeps the two from running together when spoken. */}
              <button type="submit" className="btn secondary btn-block demo-account">
                <span className="list-row-text">
                  <span className="list-row-title">{u.label}</span>
                  {u.holds && (
                    <span className="list-row-sub">
                      <span className="visually-hidden">, </span>
                      {u.holds}
                    </span>
                  )}
                </span>
              </button>
            </form>
          ))}
        </div>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
      </div>
    </div>
  );
}
