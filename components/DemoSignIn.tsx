'use client';

// The demo accounts' card on the sign-in page (lib/demo.ts). Each button is a
// form that posts to app/api/demo/sign-in. With Clerk loaded, a press instead
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

export default function DemoSignIn({ demos, unavailable }: { demos: DemoUser[]; unavailable: boolean }) {
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
      <h2>Try the demo</h2>
      <p className="panel-note">
        Sign in as a demo account, with pretend banks from Plaid&apos;s sandbox. Everyone who tries it shares these
        accounts, so anything you add is visible to others.
      </p>
      <div className="action-row">
        {demos.map((u) => (
          <form key={u.id} method="post" action="/api/demo/sign-in" onSubmit={onSubmit}>
            <input type="hidden" name="user" value={u.id} />
            <button type="submit">{u.label}</button>
          </form>
        ))}
      </div>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
