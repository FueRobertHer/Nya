'use client';

// The invite link's page (app/connect/[token]): what it says about the link,
// and accepting it: name the person, connect. Connecting shares nothing by
// itself; each side then chooses what to share. Once Connect is answered
// with a connection, or with a refusal that a retry can't change, the form
// gives way to the answer and focus goes to it; a failure keeps the form, to
// try again.

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { settingsHref, tabHref } from '@/lib/dashboard-tab';
import { Notice } from './TotalCaveats';

/** Settings > Sharing, over Accounts, at whose bottom what they share shows. */
const SHARING_HREF = settingsHref('sharing', tabHref('accounts', '/'));

const DONE = 'Connected. Nothing is shared yet: what they share with you will show at the bottom of Accounts, and you choose what you share with them in Settings, Sharing.';

/** What the page says instead of the form: a link that can't be used, or
 *  couldn't be checked (caution), or my own (information). Drawn here, a
 *  client module, as the page is a server one and a notice's icon isn't. */
export function InviteNote({ level, children }: { level: 'caution' | 'info'; children: ReactNode }) {
  return <Notice level={level}>{children}</Notice>;
}

type Answer = { level: 'done' | 'caution' | 'info'; text: string; sharing: boolean };

export function AcceptInvite({ token, fromName }: { token: string; fromName: string }) {
  const [label, setLabel] = useState(fromName);
  const [myName, setMyName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [answer, setAnswer] = useState<Answer | null>(null);
  const answerLine = useRef<HTMLDivElement>(null);
  // Connect is gone with the form, so focus goes to what replaced it.
  useEffect(() => {
    if (answer) answerLine.current?.focus();
  }, [answer]);

  const accept = async () => {
    setBusy(true);
    setError('');
    const res = await fetch('/api/connections/accept', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token, label, my_name: myName }),
    }).catch(() => null);
    const body = res?.ok ? null : await res?.json().catch(() => null);
    setBusy(false);
    if (res?.ok) return setAnswer({ level: 'done', text: DONE, sharing: true });
    // A refusal (409) is final: the link can't be used, or we already are.
    if (res?.status === 409 && typeof body?.error === 'string') {
      return setAnswer(body.connected ? { level: 'info', text: body.error, sharing: true } : { level: 'caution', text: body.error, sharing: false });
    }
    setError(typeof body?.error === 'string' ? body.error : 'Could not connect. Try again.');
  };

  if (answer)
    return (
      <>
        <Notice level={answer.level} role="status" ref={answerLine} tabIndex={-1}>
          {answer.text}
        </Notice>
        {answer.sharing && (
          <a className="btn btn-block" href={SHARING_HREF}>
            Choose what you share
          </a>
        )}
      </>
    );
  return (
    <>
      <p>
        {fromName ? `${fromName} invited you to connect.` : 'Someone invited you to connect.'} Connecting shares nothing by
        itself: each of you then chooses what to share with the other, read-only.
      </p>
      <label className="field">
        What you call them
        <input value={label} onChange={(e) => setLabel(e.target.value)} maxLength={40} />
      </label>
      <label className="field">
        Your name, as they’ll see it
        <input value={myName} onChange={(e) => setMyName(e.target.value)} maxLength={40} placeholder="So they know it’s you" />
      </label>
      <div className="stack tight">
        <button className="btn btn-block" onClick={accept} disabled={busy}>
          {busy ? 'Connecting…' : 'Connect'}
        </button>
        {error && (
          <Notice level="critical" role="alert">
            {error}
          </Notice>
        )}
      </div>
    </>
  );
}
