'use client';

import { useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { CoverageNote, TrustLinks } from '@/components/TrustLinks';
import { CONNECTIONS_PATH } from '@/lib/connection-state';

/** Where to go once signed in: Home, or the Connection health card when the
 *  proxy says that is where the person was going (a notice email's link). Only
 *  that one flag is read, never a path, so this can't send anyone elsewhere.
 *  Read from the address when the form is sent, so the page needs no
 *  Suspense boundary for useSearchParams. */
function afterLogin(): string {
  return new URLSearchParams(window.location.search).get('view') === 'connections' ? CONNECTIONS_PATH : '/';
}

export default function LoginPage() {
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const router = useRouter();

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError('');
    setLoading(true);
    const res = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password }),
    });
    setLoading(false);
    if (res.ok) {
      router.push(afterLogin());
      router.refresh();
    } else {
      const data = await res.json().catch(() => null);
      setError(data?.error ?? 'Incorrect password');
    }
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
        {error && <div className="error">{error}</div>}
      </form>
      <CoverageNote />
      <TrustLinks />
    </main>
  );
}
