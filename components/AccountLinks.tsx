'use client';

// Accounts tab, under Manage accounts: linking an account's history across a
// reconnect (lib/links.ts).
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
type Unclaimed = {
  old: string;
  old_label: string | null;
  first: string;
  last: string;
  last_balance: number | null;
  candidates: { id: string; label: string }[];
};
type Linked = { old: string; to: string; linked_at: string; old_label: string; to_label: string; conflict: boolean };
export type AccountLinksPayload = {
  suggestions: Suggestion[];
  unclaimed: Unclaimed[];
  links: Linked[];
  /** Saved links that can't be read. While one exists and an account is
   *  hidden, the dashboard can't load, so each gets a Remove button. */
  broken?: string[];
};
type Payload = AccountLinksPayload;

function fmtDay(iso: string | null): string {
  if (!iso) return 'unknown';
  return new Date(`${iso}T00:00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

export default function AccountLinks({
  onChanged,
  refreshKey,
}: {
  onChanged: () => void;
  /** Changes whenever the page's data reloads (its as-of time), so a re-added
   *  institution's suggestion appears without reopening the tab. */
  refreshKey?: string | null;
}) {
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
  }, [load, refreshKey]);

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
      // A pick may no longer be offered (Not this one removes it), so the
      // dropdown starts again from what the reload offers.
      if (body.old) {
        setPicked((p) => {
          const next = { ...p };
          delete next[body.old];
          return next;
        });
      }
      await load();
      // Dismissing changes no figures; linking and unlinking do.
      if (body.action !== 'dismiss' && body.action !== 'dismiss_all') onChanged();
    } catch {
      setError('Could not reach the server. Try again.');
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
  const broken = data?.broken ?? [];
  if (
    !data ||
    (data.suggestions.length === 0 && data.unclaimed.length === 0 && data.links.length === 0 && broken.length === 0)
  ) {
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
        // Only a pick that is still offered: anything else would act on an
        // account the dropdown isn't showing.
        const to = u.candidates.some((c) => c.id === picked[u.old]) ? picked[u.old] : u.candidates[0]?.id ?? '';
        return (
          <div key={u.old} className="account-link-row">
            <p>
              {u.old_label ? <strong>{u.old_label}</strong> : 'Balance history'} from {fmtDay(u.first)} to{' '}
              {fmtDay(u.last)}
              {u.last_balance != null ? ` (last balance ${formatMoney(u.last_balance)})` : ''} isn&apos;t
              attached to any current account. It may be one you reconnected.
            </p>
            <p className="chart-note">
              Only attach it to the same account: its balances join that account&apos;s chart and
              are counted as the same kind of account. Preview first to check they line up.
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
              <button className="link-btn danger-link" disabled={busy} onClick={() => onAct('POST', { action: 'dismiss_all', old: u.old })}>
                None of these
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

      {broken.length > 0 && (
        <div className="account-link-row">
          <p className="type-tag">Unreadable</p>
          <p className="chart-note">
            {broken.length === 1 ? 'A saved link' : 'Some saved links'} can&apos;t be read. Remove{' '}
            {broken.length === 1 ? 'it' : 'them'} and link again if needed.
          </p>
          {broken.map((old) => (
            <div key={old} className="account-link-linked">
              <span>Link from an earlier account</span>
              <button className="link-btn danger-link" disabled={busy} onClick={() => onAct('DELETE', { old })}>
                Remove
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
