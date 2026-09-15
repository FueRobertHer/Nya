'use client';

import { useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';

// Convenience shortcut for preview deployments, so poking at a branch doesn't
// mean typing the password on every cold load.
//
// Set NEXT_PUBLIC_PREVIEW_PASSWORD in Vercel under Settings -> Environment
// Variables with ONLY the Preview box ticked. Production leaves it unset, so
// the button below never renders there.
//
// NEXT_PUBLIC_ values are inlined into the browser bundle at build time, which
// means anyone who can load the preview can read this out of the JavaScript.
// It must therefore be a throwaway password that is not production's, and the
// preview it unlocks should point at its own database -- see "Preview
// deployments" in the README.
const PREVIEW_PASSWORD = process.env.NEXT_PUBLIC_PREVIEW_PASSWORD;

export default function LoginPage() {
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const router = useRouter();

  async function login(candidate: string) {
    setError('');
    setLoading(true);
    const res = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: candidate }),
    });
    setLoading(false);
    if (res.ok) {
      router.push('/');
      router.refresh();
    } else {
      const data = await res.json().catch(() => null);
      setError(data?.error ?? 'Incorrect password');
    }
  }

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    void login(password);
  }

  // Fills the field so what was submitted is visible, then logs in with it.
  function handlePreviewLogin() {
    if (!PREVIEW_PASSWORD) return;
    setPassword(PREVIEW_PASSWORD);
    void login(PREVIEW_PASSWORD);
  }

  return (
    <main className="wrap">
      <h1>Nya</h1>
      <p className="sub">Enter your password to continue</p>
      <form className="card" onSubmit={handleSubmit}>
        <input
          className="text-input"
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="Password"
          autoFocus
        />
        <button type="submit" disabled={loading || password.length === 0}>
          {loading ? 'Checking…' : 'Log In'}
        </button>
        {PREVIEW_PASSWORD && (
          <button
            type="button"
            className="secondary"
            onClick={handlePreviewLogin}
            disabled={loading}
          >
            Fill preview password
          </button>
        )}
        {error && <div className="error">{error}</div>}
      </form>
    </main>
  );
}
