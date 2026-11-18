'use client';

// Disconnecting a connection to an institution, from its ⋯, Settings >
// Connections, or the offer once every account of it has ended (#50): what
// goes and what stays, the name typed to confirm, then the write. It makes
// the write itself, so a failure is said beside its buttons, where the person
// is (docs/design/guidelines.md#after-save), not on the Accounts screen
// behind the sheet. Once done, the connection's card leaves the screen
// behind, so the sheet closes with nothing more.

import { useId, useState } from 'react';
import { Sheet } from './Sheet';
import { Notice } from './TotalCaveats';
import DisconnectSplitsNote from './DisconnectSplitsNote';
import { PLAID_PORTAL } from '@/lib/deletion-receipt';

/** The connection asked about. */
export type DisconnectTarget = { item_id: string; institution_name: string };

export type DisconnectSheetProps = {
  open: boolean;
  /** The connection, kept while the sheet slides out. */
  target: DisconnectTarget | null;
  /** Every account of it ended (#50): asked as the offer to remove it. */
  ended: boolean;
  onClose: () => void;
  /** It is gone: the screen behind reads again, and the sheet closes. */
  onDisconnected: (item_id: string) => void;
};

/** What a failed disconnect says, in the sheet, whose title names the connection. */
export const DISCONNECT_FAILED = 'Could not disconnect. Please try again.';

export default function DisconnectSheet({ open, target, ended, onClose, onDisconnected }: DisconnectSheetProps) {
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const errorId = useId();
  // Opened on a connection: nothing typed and no error from an earlier one.
  const asking = open ? (target?.item_id ?? null) : null;
  const [askedFor, setAskedFor] = useState(asking);
  if (asking !== askedFor) {
    setAskedFor(asking);
    if (asking !== null) {
      setTyped('');
      setError(null);
    }
  }

  const name = target?.institution_name ?? '';
  const matches = typed.trim().toLowerCase() === name.trim().toLowerCase();

  async function disconnect() {
    if (!target) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/disconnect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ item_id: target.item_id }),
      });
      if (!res.ok) {
        // A store that can't be reached says why (lib/data-ctx.ts); the rest are Nya's.
        const data = res.status === 503 ? await res.json().catch(() => null) : null;
        setError(typeof data?.error === 'string' ? data.error : DISCONNECT_FAILED);
        return;
      }
      onDisconnected(target.item_id);
    } catch {
      setError(DISCONNECT_FAILED);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Sheet
      open={open}
      title={target ? `Disconnect ${target.institution_name}?` : 'Disconnect'}
      onClose={() => !busy && onClose()}
      footer={
        target && (
          <>
            {error && (
              <div className="sheet-footer-note" id={errorId}>
                <Notice level="critical" role="alert">
                  {error}
                </Notice>
              </div>
            )}
            <button type="button" className="btn secondary" onClick={onClose} disabled={busy}>
              Cancel
            </button>
            <button type="button" className="btn danger" disabled={busy || !matches} onClick={() => void disconnect()} aria-describedby={error ? errorId : undefined}>
              {busy ? 'Disconnecting…' : 'Disconnect'}
            </button>
          </>
        )
      }
    >
      {target && (
        <div className="stack">
          {/* Every account of it ended (#50): the connection still syncs
              nothing of use, and Plaid bills it until it is removed. */}
          {ended && (
            <p className="helper">
              Every account at {name} has ended, but the connection is still open, and Plaid charges for it until it is removed. Their history, and when each ended, are kept.
            </p>
          )}
          <p className="helper">
            This removes {name} and its accounts from Nya, and ends the connection at Plaid. What you told your plan about those accounts for tax goes too. You can reconnect it later. Type{' '}
            <strong>{name}</strong> below to confirm.
          </p>
          {/* What adding it back doesn't bring back (#39). */}
          <DisconnectSplitsNote itemId={target.item_id} />
          {/* Disconnecting is about the connection; closing is about an
              account (#50). Only the person knows which happened. */}
          {!ended && (
            <p className="helper">
              Disconnecting doesn&apos;t say an account closed. If one did, mark it instead (open the account, then Mark as closed…): it then stops counting from that day, and the chart marks it.
            </p>
          )}
          {/* What Plaid itself keeps is beyond a disconnect's reach (the
              deletion receipt says the same, lib/deletion-receipt.ts): say
              where people can see and delete it. */}
          <p className="helper">
            Plaid keeps its own records of what it collected, under its own privacy policy. See and delete them at the{' '}
            <a href={PLAID_PORTAL} target="_blank" rel="noreferrer">
              Plaid Portal
            </a>
            .
          </p>
          <label className="field">
            Institution name
            <input value={typed} onChange={(e) => setTyped(e.target.value)} placeholder={name} disabled={busy} autoCapitalize="off" autoCorrect="off" />
          </label>
        </div>
      )}
    </Sheet>
  );
}
