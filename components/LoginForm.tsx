'use client';

import { useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';

/**
 * `previewLogin` shows the one-click button used on preview deployments. It is
 * only ever a boolean: the password itself stays on the server, since props
 * passed from a Server Component travel to the browser in the RSC payload.
 */
export default function LoginForm({ previewLogin = false }: { previewLogin?: boolean }) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const router = useRouter();

  async function submit(body: Record<string, unknown>) {
    setError('');
    setLoading(true);
    const res = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
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
    void submit({ password });
  }

  return (
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
      {previewLogin && (
        <button
          type="button"
          className="secondary"
          onClick={() => void submit({ previewLogin: true })}
          disabled={loading}
        >
          Use preview account
        </button>
      )}
      {error && <div className="error">{error}</div>}
    </form>
  );
}
