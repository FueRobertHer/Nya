'use client';

// The button that turns a weekly summary off, on the public page its link
// opens (app/unsubscribe), signed out. The link's token is read from the
// page's address here, in the browser, and posted to the route that checks it
// (app/api/weekly-summary/unsubscribe), as a mail app's own one-click
// unsubscribe posts it. Nothing happens until the button is pressed: mail apps
// and the security scanners in front of them open links on their own. Once it
// is off, the token is taken out of the address, so it isn't left in the
// browser's history.

import { useEffect, useState } from 'react';

export type UnsubscribePhase = { kind: 'idle' } | { kind: 'busy' } | { kind: 'done'; message: string } | { kind: 'error'; message: string };

/** Posts the link's token, and says what came of it. */
export async function postUnsubscribe(token: string, fetcher: typeof fetch = fetch): Promise<UnsubscribePhase> {
  try {
    const res = await fetcher(`/api/weekly-summary/unsubscribe?t=${encodeURIComponent(token)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'List-Unsubscribe=One-Click',
    });
    const data = (await res.json().catch(() => null)) as { message?: unknown; error?: unknown } | null;
    if (res.ok) return { kind: 'done', message: typeof data?.message === 'string' ? data.message : 'Your weekly summary is off.' };
    return { kind: 'error', message: typeof data?.error === 'string' ? data.error : 'Something went wrong. Try the link again later.' };
  } catch {
    return { kind: 'error', message: 'Nya could not be reached. Check your connection and try again.' };
  }
}

export default function UnsubscribeForm() {
  // Undefined until the address has been read, after the first render.
  const [token, setToken] = useState<string | null | undefined>(undefined);
  const [phase, setPhase] = useState<UnsubscribePhase>({ kind: 'idle' });
  useEffect(() => {
    setToken(new URLSearchParams(window.location.search).get('t'));
  }, []);

  const turnOff = async () => {
    if (!token) return;
    setPhase({ kind: 'busy' });
    const next = await postUnsubscribe(token);
    setPhase(next);
    if (next.kind === 'done') window.history.replaceState(null, '', window.location.pathname);
  };

  return <UnsubscribeView token={token} phase={phase} onTurnOff={turnOff} />;
}

/** What the page shows, for the address it was opened with. What came of
 *  the button is said in one live region, there from the first render, so a
 *  screen reader announces it when its words change (one that appears
 *  already holding them often isn't). */
export function UnsubscribeView({ token, phase, onTurnOff }: { token: string | null | undefined; phase: UnsubscribePhase; onTurnOff: () => void }) {
  const said = phase.kind === 'done' || phase.kind === 'error' ? phase.message : '';
  return (
    <section className="card info-section unsubscribe-card">
      {phase.kind === 'done' ? null : token === undefined ? (
        <p className="panel-note">Loading…</p>
      ) : token === null || token === '' ? (
        <p className="panel-note">
          This page needs the link from a weekly summary email. To turn the summary off without one, sign in to Nya and turn it off under Manage on
          the Accounts tab.
        </p>
      ) : (
        <>
          <p>Turn off the weekly summary that comes with this link?</p>
          <button onClick={onTurnOff} disabled={phase.kind === 'busy'}>
            {phase.kind === 'busy' ? 'Turning it off…' : 'Turn off the weekly summary'}
          </button>
        </>
      )}
      <p role="status" className={said ? (phase.kind === 'error' ? 'error' : 'status-note') : undefined}>
        {said}
      </p>
    </section>
  );
}
