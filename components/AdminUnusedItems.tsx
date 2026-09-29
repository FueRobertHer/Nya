'use client';

// Manage, on the Accounts tab, for the admin only: connections across every
// account that cost money and do nothing (lib/admin-items.ts). The server decides
// who the admin is (app/page.tsx) and only mounts this for them, so nobody else
// makes a request for it; the route refuses them as well (a 404).
//
// Listing and checking remove nothing. "Review and disconnect" opens a sheet
// where the institution's name has to be typed, and the server checks again
// that the connection is still unused before it acts.

import { useCallback, useEffect, useState } from 'react';
import { Sheet } from './Sheet';

type Row = {
  container: string;
  owner: string;
  item_id: string;
  institution_name: string;
  kind: 'refused' | 'hidden';
  since: string;
};
type Payload = { flag_after_days: number; items: Row[] };

function fmtDay(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

export default function AdminUnusedItems({ onRemoved }: { onRemoved?: () => void }) {
  const [data, setData] = useState<Payload | null>(null);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState('');
  const [target, setTarget] = useState<Row | null>(null);
  const [shown, setShown] = useState<Row | null>(null); // keeps the sheet's text while it slides out
  const [typed, setTyped] = useState('');
  const [removing, setRemoving] = useState(false);
  const [sheetError, setSheetError] = useState('');

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/admin/unused');
      if (!res.ok) throw new Error();
      setData(await res.json());
    } catch {
      // Not the admin, or optional feature failed: show nothing.
      setData(null);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const checkNow = async () => {
    setChecking(true);
    setError('');
    try {
      const res = await fetch('/api/admin/unused', { method: 'POST' });
      if (!res.ok) throw new Error();
      setData(await res.json());
    } catch {
      setError('Could not check connections right now.');
    } finally {
      setChecking(false);
    }
  };

  const open = (row: Row) => {
    setTyped('');
    setSheetError('');
    setShown(row);
    setTarget(row);
  };

  const remove = async () => {
    if (!target) return;
    setRemoving(true);
    setSheetError('');
    try {
      const res = await fetch('/api/admin/unused', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ container: target.container, item_id: target.item_id }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setSheetError(typeof body.error === 'string' ? body.error : 'Could not disconnect it.');
        // The recheck may have cleared the flag: don't leave a stale row.
        if (res.status === 409) load();
        return;
      }
      setData(body);
      setTarget(null);
      onRemoved?.();
    } catch {
      setSheetError('Could not disconnect it.');
    } finally {
      setRemoving(false);
    }
  };

  if (!data) return null;
  const name = shown?.institution_name ?? '';

  return (
    <>
      <div className="card account-links">
        <div className="inst-header">
          <div className="inst-name">Unused connections (admin)</div>
        </div>

        {data.items.length === 0 ? (
          <div className="account-link-row">
            <p className="chart-note">
              Nothing to review. A connection shows up here, from any account, once Plaid has been unable to read
              it, or every account in it has been hidden, for {data.flag_after_days} days. Each connection costs a
              little every month whether or not it is used. Nothing is removed without your confirmation.
            </p>
          </div>
        ) : (
          data.items.map((f) => (
            <div key={`${f.container}:${f.item_id}`} className="account-link-row">
              <p>
                <strong>{f.institution_name}</strong> ({f.owner}){' '}
                {f.kind === 'refused'
                  ? `has not been readable since ${fmtDay(f.since)}. Its owner can reconnect it; until then it is billed but shows nothing.`
                  : `has had every account hidden since ${fmtDay(f.since)}.`}
              </p>
              <div className="manual-row-actions">
                <button className="link-btn danger-link" onClick={() => open(f)}>
                  Review and disconnect
                </button>
              </div>
            </div>
          ))
        )}

        <div className="account-link-row">
          <div className="manual-row-actions">
            <button className="link-btn" disabled={checking} onClick={checkNow}>
              {checking ? 'Checking…' : 'Check all accounts now'}
            </button>
          </div>
          {error && <div className="error">{error}</div>}
        </div>
      </div>

      <Sheet open={!!target} title={shown ? `Disconnect ${name}?` : 'Disconnect'} onClose={() => !removing && setTarget(null)}>
        {shown && (
          <>
            <p className="panel-note" style={{ marginTop: 0 }}>
              This removes {name} ({shown.owner}) and its accounts from Nya, for that person too. They can
              reconnect it later. Its stored transactions are deleted; net-worth history is kept. It is checked
              again first, and nothing is removed if it turns out to be in use. Type <strong>{name}</strong> to
              confirm.
            </p>
            <label className="field" style={{ marginTop: 12 }}>
              Institution name
              <input
                value={typed}
                onChange={(e) => setTyped(e.target.value)}
                placeholder={name}
                disabled={removing}
                autoCapitalize="off"
                autoCorrect="off"
              />
            </label>
            {sheetError && <div className="error">{sheetError}</div>}
            <div className="button-pair" style={{ marginTop: 16 }}>
              <button className="secondary" onClick={() => setTarget(null)} disabled={removing}>
                Cancel
              </button>
              <button
                className="danger"
                disabled={removing || typed.trim().toLowerCase() !== name.trim().toLowerCase()}
                onClick={remove}
              >
                {removing ? 'Checking and disconnecting…' : 'Disconnect'}
              </button>
            </div>
          </>
        )}
      </Sheet>
    </>
  );
}
