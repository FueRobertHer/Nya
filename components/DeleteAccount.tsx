'use client';

// Deleting my account and all its data (lib/account-deletion.ts), on the
// "Data & privacy" page of Clerk's account window (components/ClerkAccount.tsx).
// Only with Clerk on. Asks for DELETE typed out;
// the primary account is told why it can't be deleted here.
//
// It ends with a receipt (lib/deletion-receipt.ts). The receipt is kept in the
// tab's sessionStorage and shown on the sign-in page the deletion signs out
// to (components/DeletionReceipt.tsx), since this window closes once Clerk
// notices the session is gone. Where that storage is off, it is shown here
// instead, with a Sign out button. An attempt that stopped after deleting the
// data keeps what it did delete, so the retry's receipt counts it.

import { useEffect, useState } from 'react';
import { useClerk } from '@clerk/nextjs';
import type { DeletionReceipt } from '@/lib/deletion-receipt';
import { DeletionReceiptView, keepPartial, keepReceipt, withEarlierAttempts } from './DeletionReceipt';

type Status = { enabled: boolean; can_delete?: boolean; reason?: string; backup_days?: number | null } | 'failed';

export default function DeleteAccount({ beforeSignOut }: { beforeSignOut: () => void }) {
  const { signOut } = useClerk();
  const [status, setStatus] = useState<Status | null>(null);
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [receipt, setReceipt] = useState<DeletionReceipt | null>(null);

  useEffect(() => {
    fetch('/api/account')
      .then((res) => (res.ok ? res.json() : 'failed'))
      .then(setStatus)
      .catch(() => setStatus('failed'));
  }, []);

  const leave = async () => {
    await signOut({ redirectUrl: '/sign-in' }).catch(() => {
      window.location.href = '/sign-in';
    });
  };

  const onDelete = async () => {
    setBusy(true);
    setError('');
    const res = await fetch('/api/account', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirm: typed }),
    }).catch(() => null);
    const body = await res?.json().catch(() => null);
    setBusy(false);
    if (!res?.ok) {
      if (body?.deleted_so_far) keepPartial(body.deleted_so_far);
      return setError(body?.error ?? 'Could not delete the account.');
    }
    beforeSignOut();
    const done = body?.receipt ? withEarlierAttempts(body.receipt as DeletionReceipt) : null;
    // Shown here only when it can't be kept for the sign-in page.
    if (done && !keepReceipt(done)) return setReceipt(done);
    await leave();
  };

  return (
    <DeleteAccountView
      status={status}
      typed={typed}
      busy={busy}
      error={error}
      onType={setTyped}
      onDelete={onDelete}
      receipt={receipt}
      onSignOut={leave}
    />
  );
}

export function DeleteAccountView({
  status,
  typed,
  busy,
  error,
  onType,
  onDelete,
  receipt = null,
  onSignOut = () => {},
}: {
  status: Status | null;
  typed: string;
  busy: boolean;
  error: string;
  onType: (s: string) => void;
  onDelete: () => void;
  receipt?: DeletionReceipt | null;
  onSignOut?: () => void;
}) {
  if (receipt) {
    return (
      <div className="privacy-panel">
        <DeletionReceiptView receipt={receipt} onDone={onSignOut} doneLabel="Sign out" />
      </div>
    );
  }
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
            budgets, goals) and stops all sharing, then deletes your sign-in. This can’t be undone.
            {typeof status.backup_days === 'number' && ` Nightly backups keep an encrypted copy for up to ${status.backup_days} days.`}{' '}
            To keep a copy, use Download my data under Manage accounts first. When it’s done you’ll get a receipt of what
            was deleted and what stays.
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
