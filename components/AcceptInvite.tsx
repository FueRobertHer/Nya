'use client';

// Accepting an invite link (app/connect/[token]): name the person, connect.
// Connecting shares nothing by itself; each side then chooses what to share.

import { useState } from 'react';

export function AcceptInvite({ token, fromName }: { token: string; fromName: string }) {
  const [label, setLabel] = useState(fromName);
  const [myName, setMyName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);

  const accept = async () => {
    setBusy(true);
    setError('');
    const res = await fetch('/api/connections/accept', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token, label, my_name: myName }),
    }).catch(() => null);
    setBusy(false);
    if (res?.ok) return setDone(true);
    const body = await res?.json().catch(() => null);
    setError(body?.error ?? 'Could not connect. Try again.');
  };

  if (done) return <p>Connected. Choose what you share with them under Manage accounts, Sharing.</p>;
  return (
    <>
      <p>
        {fromName ? `${fromName} invited you to connect.` : 'Someone invited you to connect.'} Connecting shares nothing by
        itself: each of you chooses which accounts the other can see, read-only.
      </p>
      <label className="peer-row">
        <span>What you call them</span>
        <input value={label} onChange={(e) => setLabel(e.target.value)} maxLength={40} />
      </label>
      <label className="peer-row">
        <span>Your name, as they’ll see it</span>
        <input value={myName} onChange={(e) => setMyName(e.target.value)} maxLength={40} placeholder="So they know it’s you" />
      </label>
      <button onClick={accept} disabled={busy}>
        {busy ? 'Connecting…' : 'Connect'}
      </button>
      {error && <div className="error">{error}</div>}
    </>
  );
}
