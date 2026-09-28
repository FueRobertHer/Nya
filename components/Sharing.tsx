'use client';

// Accounts tab: read-only sharing between connected people (#45,
// lib/sharing.ts). Two parts:
//   - under Manage accounts, Sharing: an invite link to connect with someone,
//     and for each connection what I call them and what they see of mine,
//     per account (not shared, that it exists, balance, or balance and recent
//     transactions), plus remove and block;
//   - "Shared by ...", always on the tab when a connection shares something:
//     their accounts, read-only.
// Only with Clerk on; with the shared password there's nobody to connect
// with, and both parts render nothing.

import { useCallback, useEffect, useState } from 'react';
import { formatMoney } from '@/lib/format';

type Level = 'exists' | 'balance' | 'transactions';
export type Choice = Level | 'none';
export type Connection = { id: string; label: string; introduced_as: string | null; since: string; sharing: Record<string, Level> };
export type SharingPayload = {
  enabled: boolean;
  connections?: Connection[];
  blocked?: { id: string; label: string }[];
  accounts?: { id: string; label: string }[];
};
export type SharedPayload = {
  shared: {
    connection: string;
    label: string;
    accounts: {
      id: string;
      label: string;
      level: Level;
      balance: number | null;
      as_of: string | null;
      debt: boolean;
      transactions?: { date: string; name: string; amount: number; pending: boolean }[];
    }[];
  }[];
};
export type Invite = { url: string; expires_at: string } | null;

const LEVEL_LABEL: Record<Choice, string> = {
  none: 'Not shared',
  exists: 'That it exists',
  balance: 'Balance',
  transactions: 'Balance and transactions',
};

async function send(method: string, path: string, body: unknown): Promise<{ ok: boolean; body: any }> {
  const res = await fetch(path, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).catch(() => null);
  return { ok: !!res?.ok, body: await res?.json().catch(() => null) };
}

export function SharingSettings({ refreshKey }: { refreshKey?: unknown }) {
  const [data, setData] = useState<SharingPayload | null>(null);
  const [selected, setSelected] = useState('');
  const [draft, setDraft] = useState<Record<string, Choice>>({});
  const [labelDraft, setLabelDraft] = useState('');
  const [invite, setInvite] = useState<Invite>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const load = useCallback(async () => {
    const res = await fetch('/api/connections').catch(() => null);
    if (!res?.ok) return setError('Could not load sharing.');
    const body: SharingPayload = await res.json();
    setData(body);
    setSelected((s) => (body.connections?.some((c) => c.id === s) ? s : body.connections?.[0]?.id ?? ''));
  }, []);
  useEffect(() => {
    load();
  }, [load, refreshKey]);

  // The saved choices for this connection, as a starting draft: set when the
  // connection changes or after a save, never by a background reload, so
  // choices not yet saved survive a refresh of the dashboard.
  const [draftFor, setDraftFor] = useState<string | null>(null);
  useEffect(() => {
    const c = data?.connections?.find((c) => c.id === selected);
    if (!c || draftFor === selected) return;
    setDraft(Object.fromEntries((data?.accounts ?? []).map((a) => [a.id, c.sharing[a.id] ?? 'none'])));
    setLabelDraft(c.label);
    setDraftFor(selected);
  }, [data, selected, draftFor]);

  const act = useCallback(
    async (method: string, path: string, body: unknown, done: string, resetDraft = true) => {
      setBusy(true);
      setError('');
      setNotice('');
      const res = await send(method, path, body);
      setBusy(false);
      if (!res.ok) {
        setError(res.body?.error ?? 'Something went wrong.');
        return null;
      }
      setNotice(done);
      if (resetDraft) setDraftFor(null); // start again from what was saved
      await load();
      return res.body;
    },
    [load]
  );

  return (
    <SharingSettingsView
      data={data}
      selected={selected}
      draft={draft}
      labelDraft={labelDraft}
      invite={invite}
      busy={busy}
      error={error}
      notice={notice}
      onSelect={setSelected}
      onChoose={(id, c) => setDraft((d) => ({ ...d, [id]: c }))}
      onLabel={setLabelDraft}
      onInvite={async (fromName, theirLabel) => {
        const body = await act('POST', '/api/connections/invite', { from_name: fromName, their_label: theirLabel }, '', false);
        if (body) setInvite(body);
      }}
      onSave={() => act('PUT', '/api/connections', { id: selected, label: labelDraft, accounts: draft }, 'Saved.')}
      onRemove={(id, block) => {
        const what = block ? 'Block them? Everything shared both ways ends, and they can’t connect with you again.' : 'Remove them? Everything shared both ways ends.';
        if (block !== null && !window.confirm(what)) return;
        act('DELETE', '/api/connections', { id, block: block === true }, block ? 'Blocked.' : block === null ? 'Unblocked.' : 'Removed.');
      }}
    />
  );
}

export function SharingSettingsView({
  data,
  selected,
  draft,
  labelDraft,
  invite,
  busy,
  error,
  notice,
  onSelect,
  onChoose,
  onLabel,
  onInvite,
  onSave,
  onRemove,
}: {
  data: SharingPayload | null;
  selected: string;
  draft: Record<string, Choice>;
  labelDraft: string;
  invite: Invite;
  busy: boolean;
  error: string;
  notice: string;
  onSelect: (id: string) => void;
  onChoose: (id: string, c: Choice) => void;
  onLabel: (label: string) => void;
  onInvite: (fromName: string, theirLabel: string) => void;
  onSave: () => void;
  /** block: true blocks, false removes, null lifts a block (no confirmation). */
  onRemove: (id: string, block: boolean | null) => void;
}) {
  const [fromName, setFromName] = useState('');
  const [theirLabel, setTheirLabel] = useState('');
  if (!data) return error ? <div className="card error">{error}</div> : null;
  if (!data.enabled) return null;
  const connections = data.connections ?? [];
  const accounts = data.accounts ?? [];
  const current = connections.find((c) => c.id === selected);
  // What they can see now: a share on an account I've since hidden is paused.
  const seen = current ? accounts.filter((a) => current.sharing[a.id]).length : 0;
  return (
    <div className="card">
      <h3>Sharing</h3>
      <p className="sub">
        Connect with someone by sending them an invite link. They see only the accounts you choose, read-only, and
        nobody else in the app can find you.
      </p>

      <div className="share-invite">
        <input value={fromName} onChange={(e) => setFromName(e.target.value)} placeholder="Your name, as they’ll see it" aria-label="Your name, as they’ll see it" maxLength={40} />
        <input value={theirLabel} onChange={(e) => setTheirLabel(e.target.value)} placeholder="What you call them" aria-label="What you call them" maxLength={40} />
        <button onClick={() => onInvite(fromName, theirLabel)} disabled={busy}>
          Make an invite link
        </button>
      </div>
      {invite && (
        <div className="share-invite">
          <input readOnly value={invite.url} aria-label="Invite link" onFocus={(e) => e.target.select()} />
          <button className="secondary" onClick={() => navigator.clipboard?.writeText(invite.url)}>
            Copy
          </button>
          <p className="sub">Send it to them yourself. It works once, until {new Date(invite.expires_at).toLocaleString()}.</p>
        </div>
      )}

      {connections.length === 0 ? (
        <p className="sub">No connections yet.</p>
      ) : (
        <>
          {connections.length > 1 && (
            <select value={selected} onChange={(e) => onSelect(e.target.value)} aria-label="Connection">
              {connections.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.label}
                </option>
              ))}
            </select>
          )}
          {current && (
            <>
              <label className="share-row">
                <span>What you call them</span>
                <input value={labelDraft} onChange={(e) => onLabel(e.target.value)} maxLength={40} />
              </label>
              <p className="sub">
                {current.introduced_as ? `They introduced themselves as “${current.introduced_as}”. ` : 'They didn’t give a name. '}
                Connected {current.since}. Not who you meant to invite? Remove them.
              </p>
              <p>
                {seen === 0
                  ? `${current.label} can’t see any of your accounts.`
                  : `${current.label} can see ${seen === 1 ? '1 of your accounts' : `${seen} of your accounts`}, as set below.`}
              </p>
              {accounts.length === 0 && <p className="sub">You have no accounts to share yet.</p>}
              {accounts.map((a) => (
                <div key={a.id} className="share-row">
                  <span>{a.label}</span>
                  <select value={draft[a.id] ?? 'none'} onChange={(e) => onChoose(a.id, e.target.value as Choice)} aria-label={`Share ${a.label}`}>
                    {(Object.keys(LEVEL_LABEL) as Choice[]).map((c) => (
                      <option key={c} value={c}>
                        {LEVEL_LABEL[c]}
                      </option>
                    ))}
                  </select>
                </div>
              ))}
              <button onClick={onSave} disabled={busy}>
                {busy ? 'Saving…' : 'Save'}
              </button>{' '}
              <button className="secondary" onClick={() => onRemove(current.id, false)} disabled={busy}>
                Remove
              </button>{' '}
              <button className="secondary" onClick={() => onRemove(current.id, true)} disabled={busy}>
                Block
              </button>
            </>
          )}
        </>
      )}

      {(data.blocked ?? []).length > 0 && (
        <>
          <p className="sub">Blocked</p>
          {data.blocked!.map((b) => (
            <div key={b.id} className="share-row">
              <span>{b.label}</span>
              <button className="secondary" onClick={() => onRemove(b.id, null)} disabled={busy}>
                Unblock
              </button>
            </div>
          ))}
        </>
      )}
      {error && <div className="error">{error}</div>}
      {notice && <div className="sub">{notice}</div>}
    </div>
  );
}

export function SharedWithMe({ refreshKey }: { refreshKey?: unknown }) {
  const [data, setData] = useState<SharedPayload | null>(null);
  useEffect(() => {
    fetch('/api/shared')
      .then((res) => (res.ok ? res.json() : null))
      .then((body) => setData(body))
      .catch(() => setData(null));
  }, [refreshKey]);
  return <SharedWithMeView data={data} />;
}

function shownBalance(a: SharedPayload['shared'][number]['accounts'][number]): string {
  if (a.level === 'exists') return 'Balance not shared';
  if (a.balance === null) return 'No balance yet';
  return `${formatMoney(a.balance)}${a.debt ? ' owed' : ''}`;
}

export function SharedWithMeView({ data }: { data: SharedPayload | null }) {
  const [open, setOpen] = useState<string | null>(null);
  if (!data || data.shared.length === 0) return null;
  return (
    <>
      {data.shared.map((s) => (
        <div key={s.connection} className="card">
          <h3>Shared by {s.label}</h3>
          <p className="sub">Read-only.</p>
          {s.accounts.map((a) => (
            <div key={a.id}>
              <div className="share-row">
                <span>
                  {a.label}
                  {a.as_of && <span className="sub"> · as of {a.as_of}</span>}
                </span>
                <span>{shownBalance(a)}</span>
              </div>
              {a.transactions && (
                <button className="secondary" onClick={() => setOpen(open === a.id ? null : a.id)}>
                  {open === a.id ? 'Hide transactions' : `Recent transactions (${a.transactions.length})`}
                </button>
              )}
              {open === a.id &&
                a.transactions?.map((t, i) => (
                  <div key={i} className="share-row sub">
                    <span>
                      {t.date} {t.name}
                      {t.pending ? ' (pending)' : ''}
                    </span>
                    <span>{formatMoney(-t.amount)}</span>
                  </div>
                ))}
            </div>
          ))}
        </div>
      ))}
    </>
  );
}
