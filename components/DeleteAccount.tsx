'use client';

// Deleting my account and all its data (lib/account-deletion.ts), on the
// "Data & privacy" page of Clerk's account window (components/ClerkAccount.tsx).
// Only with Clerk on. Asks for DELETE typed out;
// the primary account is told why it can't be deleted here.

import { useEffect, useState } from 'react';
import { useClerk } from '@clerk/nextjs';

type Status = { enabled: boolean; can_delete?: boolean; reason?: string } | 'failed';

export default function DeleteAccount({ beforeSignOut }: { beforeSignOut: () => void }) {
  const { signOut } = useClerk();
  const [status, setStatus] = useState<Status | null>(null);
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    fetch('/api/account')
      .then((res) => (res.ok ? res.json() : 'failed'))
      .then(setStatus)
      .catch(() => setStatus('failed'));
  }, []);

  const onDelete = async () => {
    setBusy(true);
    setError('');
    const res = await fetch('/api/account', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirm: typed }),
    }).catch(() => null);
    setBusy(false);
    if (!res?.ok) {
      const body = await res?.json().catch(() => null);
      return setError(body?.error ?? 'Could not delete the account.');
    }
    beforeSignOut();
    await signOut({ redirectUrl: '/sign-in' }).catch(() => {
      window.location.href = '/sign-in';
    });
  };

  return <DeleteAccountView status={status} typed={typed} busy={busy} error={error} onType={setTyped} onDelete={onDelete} />;
}

export function DeleteAccountView({
  status,
  typed,
  busy,
  error,
  onType,
  onDelete,
}: {
  status: Status | null;
  typed: string;
  busy: boolean;
  error: string;
  onType: (s: string) => void;
  onDelete: () => void;
}) {
  // This is the whole of its page in Clerk's account window: never blank.
  if (status === null) return <div className="spinner" role="status" aria-label="Loading" />;
  if (status === 'failed') return <p className="error">Could not check this account. Close this window and try again.</p>;
  if (!status.enabled) return null;
  return (
    <div className="privacy-panel">
      <h3>Delete my account</h3>
      {status.can_delete === false ? (
        <p className="sub">{status.reason}</p>
      ) : (
        <>
          <p className="sub">
            Disconnects your banks, deletes everything stored for you (balances, history, transactions, categories,
            budgets, goals) and stops all sharing, then deletes your sign-in. This can’t be undone. Nightly backups
            keep a copy for up to 30 days.
          </p>
          <input
            className="text-input"
            value={typed}
            onChange={(e) => onType(e.target.value)}
            placeholder="Type DELETE"
            aria-label="Type DELETE to confirm"
          />
          <button className="danger-outline" onClick={onDelete} disabled={busy || typed !== 'DELETE'}>
            {busy ? 'Deleting…' : 'Delete my account'}
          </button>
          {error && <div className="error">{error}</div>}
        </>
      )}
    </div>
  );
}
