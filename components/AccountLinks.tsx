'use client';

// Accounts tab: linking an account's history across a reconnect (lib/links.ts).
//
// Shows only when there is something to decide or undo:
//   - a suggestion: an account that stopped reporting and a new one that looks
//     like the same account, with the evidence, to Link or mark Not the same;
//   - history known only from balances (older than the account directory), to
//     assign to one of the accounts that appeared after it;
//   - the links already made, each with Unlink.
// Every choice shows a chart preview first, so a wrong pairing is visible as a
// jump before it is made. Nothing links without a tap here.

import { useCallback, useEffect, useState } from 'react';
import AccountSparkline from './AccountSparkline';
import { formatMoney } from '@/lib/format';

type Suggestion = {
  old: string;
  to: string;
  old_label: string;
  to_label: string;
  evidence: {
    persistent_match: boolean;
    old_last: string | null;
    old_last_balance: number | null;
    new_first: string | null;
    new_first_balance: number | null;
  };
};
type Unclaimed = { old: string; first: string; last: string; last_balance: number; candidates: { id: string; label: string }[] };
type Linked = { old: string; to: string; linked_at: string; old_label: string; to_label: string; conflict: boolean };
export type AccountLinksPayload = { suggestions: Suggestion[]; unclaimed: Unclaimed[]; links: Linked[] };
type Payload = AccountLinksPayload;

function fmtDay(iso: string | null): string {
  if (!iso) return 'unknown';
  return new Date(`${iso}T00:00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

export default function AccountLinks({ onChanged }: { onChanged: () => void }) {
  const [data, setData] = useState<Payload | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [preview, setPreview] = useState<{ old: string; to: string } | null>(null);
  const [picked, setPicked] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/account-links');
      if (!res.ok) throw new Error();
      setData(await res.json());
    } catch {
      // Optional feature: a failed load just shows nothing.
      setData(null);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const act = async (method: 'POST' | 'DELETE', body: Record<string, string>) => {
    setBusy(true);
    setError('');
    try {
      const res = await fetch('/api/account-links', {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        setError(j.error || 'Could not update the link');
        return;
      }
      setPreview(null);
      await load();
      // Dismissing changes no figures; linking and unlinking do.
      if (body.action !== 'dismiss') onChanged();
    } finally {
      setBusy(false);
    }
  };

  return (
    <AccountLinksView
      data={data}
      busy={busy}
      error={error}
      preview={preview}
      picked={picked}
      onPreview={setPreview}
      onPick={(old, to) => {
        setPicked((p) => ({ ...p, [old]: to }));
        setPreview(null);
      }}
      onAct={act}
    />
  );
}

/** The card itself, from already-loaded data: rendered by AccountLinks, and
 *  directly by tests and previews. */
export function AccountLinksView({
  data,
  busy,
  error,
  preview,
  picked,
  onPreview,
  onPick,
  onAct,
}: {
  data: Payload | null;
  busy: boolean;
  error: string;
  preview: { old: string; to: string } | null;
  picked: Record<string, string>;
  onPreview: (p: { old: string; to: string } | null) => void;
  onPick: (old: string, to: string) => void;
  onAct: (method: 'POST' | 'DELETE', body: Record<string, string>) => void;
}) {
  if (!data || (data.suggestions.length === 0 && data.unclaimed.length === 0 && data.links.length === 0)) {
    return null;
  }

  const isPreviewing = (old: string, to: string) => preview?.old === old && preview?.to === to;
  const previewButton = (old: string, to: string) => (
    <button
      className="link-btn"
      disabled={busy}
      onClick={() => onPreview(isPreviewing(old, to) ? null : { old, to })}
    >
      {isPreviewing(old, to) ? 'Hide preview' : 'Preview'}
    </button>
  );

  return (
    <div className="card account-links">
      <div className="inst-header">
        <div className="inst-name">Reconnected accounts</div>
      </div>

      {data.suggestions.map((s) => (
        <div key={`${s.old}>${s.to}`} className="account-link-row">
          <p>
            <strong>{s.old_label}</strong> stopped reporting on {fmtDay(s.evidence.old_last)}, and{' '}
            <strong>{s.to_label}</strong> appeared on {fmtDay(s.evidence.new_first)}. Same account?
          </p>
          <p className="chart-note">
            {s.evidence.persistent_match ? 'Plaid identifies them as the same account. ' : ''}
            {s.evidence.old_last_balance != null && s.evidence.new_first_balance != null
              ? `Last balance ${formatMoney(s.evidence.old_last_balance)}, first balance ${formatMoney(s.evidence.new_first_balance)}.`
              : ''}
          </p>
          <div className="manual-row-actions">
            {previewButton(s.old, s.to)}
            <button className="link-btn" disabled={busy} onClick={() => onAct('POST', { action: 'link', old: s.old, to: s.to })}>
              Link history
            </button>
            <button className="link-btn danger-link" disabled={busy} onClick={() => onAct('POST', { action: 'dismiss', old: s.old, to: s.to })}>
              Not the same
            </button>
          </div>
          {isPreviewing(s.old, s.to) && <AccountSparkline accountId={s.to} previewWith={s.old} />}
        </div>
      ))}

      {data.unclaimed.map((u) => {
        const to = picked[u.old] ?? u.candidates[0]?.id ?? '';
        return (
          <div key={u.old} className="account-link-row">
            <p>
              Balance history from {fmtDay(u.first)} to {fmtDay(u.last)} (last balance{' '}
              {formatMoney(u.last_balance)}) isn&apos;t attached to any account. It may belong to an
              account you reconnected.
            </p>
            <label className="type-tag">
              Attach to{' '}
              <select
                value={to}
                disabled={busy}
                onChange={(e) => onPick(u.old, e.target.value)}
              >
                {u.candidates.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.label}
                  </option>
                ))}
              </select>
            </label>
            <div className="manual-row-actions">
              {previewButton(u.old, to)}
              <button className="link-btn" disabled={busy || !to} onClick={() => onAct('POST', { action: 'link', old: u.old, to })}>
                Link history
              </button>
              <button className="link-btn danger-link" disabled={busy || !to} onClick={() => onAct('POST', { action: 'dismiss', old: u.old, to })}>
                Not this one
              </button>
            </div>
            {isPreviewing(u.old, to) && <AccountSparkline accountId={to} previewWith={u.old} />}
          </div>
        );
      })}

      {data.links.length > 0 && (
        <div className="account-link-row">
          <p className="type-tag">Linked</p>
          {data.links.map((l) => (
            <div key={l.old} className="account-link-linked">
              <span>
                {l.old_label} → {l.to_label}
                {l.conflict ? ' (the earlier account is reporting again, so this link is paused)' : ''}
              </span>
              <button className="link-btn danger-link" disabled={busy} onClick={() => onAct('DELETE', { old: l.old })}>
                Unlink
              </button>
            </div>
          ))}
        </div>
      )}

      {error && <div className="error">{error}</div>}
      <p className="chart-note">
        Linking joins balance history only; nothing stored is changed, and Unlink puts it back as it was.
      </p>
    </div>
  );
}
