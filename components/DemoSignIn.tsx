'use client';

// The demo accounts' card on the sign-in page (lib/demo.ts). Each is a tonal
// button with the account's name, and under it, when the page could read it
// (lib/demo-seed/loaded.ts), the scenario it was last reset to: what was
// loaded, which stays true after visitors change the data. The button is
// described by that line, so its name stays the account's alone. Each is in
// a form that posts to app/api/demo/sign-in. With Clerk loaded, a press instead
// asks that route for the ticket and signs in with it in place
// (components/demo-sign-in.ts), so no page loads again; the app loading shows
// from the press (components/SignInFlow.tsx) until Clerk has moved to Home.
// Before Clerk has loaded, or without script, the form posts as forms do and
// the page comes back with the ticket, which Clerk's form signs in with.
// When a sign-in fails, or the app hasn't opened in the page's wait
// (components/SignInFlow.tsx), the card says so under the buttons, and focus
// goes there as the page comes back: the press hid the whole page, the
// button with it.

import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useClerk } from '@clerk/nextjs';
import { DEMO_UNAVAILABLE, type DemoUser } from '@/lib/demo';
import { useDemoHold } from './SignInFlow';
import { demoSignIn } from './demo-sign-in';
import { DEMO_LATE } from './sign-in-view';
import { Notice } from './TotalCaveats';

export default function DemoSignIn({
  demos,
  loaded = {},
  unavailable,
}: {
  demos: DemoUser[];
  /** The title of the scenario each account was last reset to, by its id. */
  loaded?: Partial<Record<string, string>>;
  unavailable: boolean;
}) {
  const clerk = useClerk();
  const hold = useDemoHold();
  const [error, setError] = useState<string | null>(unavailable ? DEMO_UNAVAILABLE : null);
  const said = error ?? (hold.late ? DEMO_LATE : null);
  const notice = useRef<HTMLDivElement>(null);
  // Focus goes to what the card says only as the page comes back from the
  // app loading. What it says when the page loads, or a failure said once
  // the page is back, is read in place, and focus stays where it is.
  const hidden = useRef(hold.pending);
  useEffect(() => {
    const was = hidden.current;
    hidden.current = hold.pending;
    if (was && !hold.pending && said) notice.current?.focus();
  }, [hold.pending, said]);

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
          accounts, so anything you add is visible to others. You can switch among sample scenarios anytime in Settings,
          Your data and privacy.
        </p>
        {/* Side by side, each half the row: a button says its name, and the
            line under it what was loaded. */}
        <div className="btn-row demo-accounts">
          {demos.map((u) => {
            const scenario = loaded[u.id];
            const lineId = `demo-loaded-${u.id}`;
            return (
              <form key={u.id} method="post" action="/api/demo/sign-in" onSubmit={onSubmit} className="stack tight">
                <input type="hidden" name="user" value={u.id} />
                {/* Tonal, so Clerk's Continue stays the one filled button. */}
                <button type="submit" className="btn secondary btn-block" aria-describedby={scenario ? lineId : undefined}>
                  {u.label}
                </button>
                {scenario && (
                  <p className="helper" id={lineId}>
                    {scenario}
                  </p>
                )}
              </form>
            );
          })}
        </div>
        {said && (
          <Notice level="critical" role="alert" ref={notice} tabIndex={-1}>
            {said}
          </Notice>
        )}
      </div>
    </div>
  );
}
