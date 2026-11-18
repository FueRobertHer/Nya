'use client';

import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { CoverageNote, TrustLinks } from '@/components/TrustLinks';
import { AppLoading } from '@/components/LoadingSkeletons';
import { CONNECTIONS_PATH } from '@/lib/connection-state';
import { TAGLINE } from '@/lib/tagline';
import { Why } from '@/components/Why';
import { Notice } from '@/components/TotalCaveats';
import FieldError from '@/components/FieldError';

/** How long the app loading may stand in for this page before the form comes
 *  back: a session the browser wouldn't keep sends Home back here, where
 *  this page would otherwise go on loading. */
const OPEN_WAIT_MS = 12_000;

// A page exports nothing but itself, so its words live here and its tests
// (test/login-view.test.tsx) say them again.
// A password the server didn't take (app/api/login, 401), said under the
// field: what is wrong and what to do.
const WRONG_PASSWORD = 'That password isn’t right. Check it and try again.';
// The server couldn't be reached at all (offline, say).
const UNREACHABLE = 'Nya couldn’t be reached. Check your connection and try again.';
// Accepted, but the app never opened in its place.
const DIDNT_OPEN = 'Nya didn’t open. Try again, or reload the page.';

const ERROR_ID = 'password-error';

/** Where to go once signed in: Home, or the connection that needs attention when the
 *  proxy says that is where the person was going (a notice email's link). Only
 *  that one flag is read, never a path, so this can't send anyone elsewhere.
 *  Read from the address when the form is sent, so the page needs no
 *  Suspense boundary for useSearchParams. */
function afterLogin(): string {
  return new URLSearchParams(window.location.search).get('view') === 'connections' ? CONNECTIONS_PATH : '/';
}

// The shared password's sign-in (lib/auth-mode.ts), when the deployment has
// no Clerk. A wrong password is the field's error, under it; anything else
// that stops a sign-in (too many tries, the server, no connection, the app
// not opening) is a notice under the button.
export default function LoginPage() {
  const [password, setPassword] = useState('');
  const [wrong, setWrong] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  // Accepted: the app loading takes the page's place until the dashboard,
  // which draws the same while it loads, is in (components/LoadingSkeletons.tsx).
  const [accepted, setAccepted] = useState(false);
  const router = useRouter();
  // Back to the field after a try that didn't sign in: the button it was
  // sent with is held while it is checked, and focus leaves a held button.
  const field = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!accepted) return;
    const timer = setTimeout(() => {
      setAccepted(false);
      setError(DIDNT_OPEN);
    }, OPEN_WAIT_MS);
    return () => clearTimeout(timer);
  }, [accepted]);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setWrong(false);
    setError('');
    setLoading(true);
    let res: Response;
    try {
      res = await fetch('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }),
      });
    } catch {
      setLoading(false);
      setError(UNREACHABLE);
      field.current?.focus();
      return;
    }
    setLoading(false);
    if (res.ok) {
      setAccepted(true);
      router.push(afterLogin());
      router.refresh();
    } else {
      if (res.status === 401) setWrong(true);
      else {
        const data = await res.json().catch(() => null);
        setError(typeof data?.error === 'string' ? data.error : 'Nya couldn’t sign you in just now. Try again.');
      }
      field.current?.focus();
    }
  }

  if (accepted) return <AppLoading account="password" />;

  return (
    <main className="wrap">
      <h1>Nya</h1>
      {/* What Nya is, as the sign-in page says it, then what to do. */}
      <p className="sub">
        {TAGLINE} Enter your password to continue.
      </p>
      <form className="card" onSubmit={handleSubmit}>
        <div className="stack">
          <label className="field">
            Password
            <input
              ref={field}
              type="password"
              name="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => {
                setPassword(e.target.value);
                setWrong(false);
              }}
              aria-invalid={wrong || undefined}
              aria-describedby={wrong ? ERROR_ID : undefined}
              autoFocus
            />
          </label>
          {/* An alert, so it is heard when it comes: after Enter, focus is
              already on the field, and moving it there again says nothing.
              A stack, so the error keeps the stack's spacing under the
              field rather than adding its own. */}
          {wrong && (
            <div role="alert" className="stack">
              <FieldError id={ERROR_ID}>{WRONG_PASSWORD}</FieldError>
            </div>
          )}
          <button type="submit" className="btn btn-block" disabled={loading || password.length === 0}>
            {loading ? 'Checking…' : 'Sign in'}
          </button>
          {error && (
            <Notice level="critical" role="alert">
              {error}
            </Notice>
          )}
        </div>
      </form>
      <Why label="Which banks work?">
        <CoverageNote />
      </Why>
      <TrustLinks />
    </main>
  );
}
