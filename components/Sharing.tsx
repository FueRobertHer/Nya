'use client';

// Accounts tab: read-only sharing between the people in the app (#45,
// lib/sharing.ts). Two parts:
//   - under Manage accounts, what I share with each person, per account:
//     not shared, balance, or balance and recent transactions;
//   - "Shared with you", always on the tab when someone shares something:
//     their accounts, read-only, marked as theirs.
// Only with Clerk on; with the shared password there's nobody to share with,
// and both parts render nothing.

import { useCallback, useEffect, useState } from 'react';
import { formatMoney } from '@/lib/format';

type Level = 'balance' | 'transactions';
type Choice = Level | 'none';
export type SharingPayload = {
  enabled: boolean;
  people?: { id: string; name: string }[];
  accounts?: { id: string; label: string }[];
  sharing?: Record<string, Record<string, Level>>;
};
export type SharedPayload = {
  shared: {
    from: string;
    name: string;
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

const LEVEL_LABEL: Record<Choice, string> = { none: 'Not shared', balance: 'Balance', transactions: 'Balance and transactions' };

export function SharingSettings({ refreshKey }: { refreshKey?: unknown }) {
  const [data, setData] = useState<SharingPayload | null>(null);
  const [person, setPerson] = useState('');
  const [draft, setDraft] = useState<Record<string, Choice>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const load = useCallback(async () => {
    const res = await fetch('/api/sharing').catch(() => null);
    if (!res?.ok) return setError('Could not load sharing.');
    const body: SharingPayload = await res.json();
    setData(body);
    setPerson((p) => p || body.people?.[0]?.id || '');
  }, []);
  useEffect(() => {
    load();
  }, [load, refreshKey]);

  // The saved choices for this person, as a starting draft: set when the
  // person changes or after a save, never by a background reload, so choices
  // not yet saved survive a refresh of the dashboard.
  const [draftFor, setDraftFor] = useState<string | null>(null);
  useEffect(() => {
    if (!data || !person || draftFor === person) return;
    const current = data.sharing?.[person] ?? {};
    setDraft(Object.fromEntries((data.accounts ?? []).map((a) => [a.id, current[a.id] ?? 'none'])));
    setDraftFor(person);
  }, [data, person, draftFor]);

  const save = useCallback(async () => {
    setBusy(true);
    setError('');
    setNotice('');
    const res = await fetch('/api/sharing', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ to: person, accounts: draft }),
    }).catch(() => null);
    setBusy(false);
    if (!res?.ok) {
      const body = await res?.json().catch(() => null);
      return setError(body?.error ?? 'Could not save.');
    }
    setNotice('Saved.');
    setDraftFor(null); // start again from what was saved
    load();
  }, [person, draft, load]);

  return (
    <SharingSettingsView
      data={data}
      person={person}
      draft={draft}
      busy={busy}
      error={error}
      notice={notice}
      onPerson={setPerson}
      onChoose={(id, c) => setDraft((d) => ({ ...d, [id]: c }))}
      onSave={save}
    />
  );
}

export function SharingSettingsView({
  data,
  person,
  draft,
  busy,
  error,
  notice,
  onPerson,
  onChoose,
  onSave,
}: {
  data: SharingPayload | null;
  person: string;
  draft: Record<string, Choice>;
  busy: boolean;
  error: string;
  notice: string;
  onPerson: (id: string) => void;
  onChoose: (id: string, c: Choice) => void;
  onSave: () => void;
}) {
  if (!data) return error ? <div className="card error">{error}</div> : null;
  if (!data.enabled) return null;
  const people = data.people ?? [];
  const accounts = data.accounts ?? [];
  return (
    <div className="card">
      <h3>Sharing</h3>
      {people.length === 0 ? (
        <p className="sub">Nobody else uses the app yet. Once someone signs in, you can share accounts with them here.</p>
      ) : (
        <>
          <p className="sub">
            Read-only: they can see, never change. Nothing is shared until you choose it. Hiding an account pauses its
            sharing until you unhide it.
          </p>
          {people.length > 1 && (
            <select value={person} onChange={(e) => onPerson(e.target.value)} aria-label="Person">
              {people.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          )}
          {people.length === 1 && <p>With {people[0].name}:</p>}
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
          {accounts.length > 0 && (
            <button onClick={onSave} disabled={busy || !person}>
              {busy ? 'Saving…' : 'Save'}
            </button>
          )}
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

export function SharedWithMeView({ data }: { data: SharedPayload | null }) {
  const [open, setOpen] = useState<string | null>(null);
  if (!data || data.shared.length === 0) return null;
  return (
    <>
      {data.shared.map((s) => (
        <div key={s.from} className="card">
          <h3>Shared by {s.name}</h3>
          <p className="sub">Read-only.</p>
          {s.accounts.map((a) => (
            <div key={a.id}>
              <div className="share-row">
                <span>
                  {a.label}
                  {a.as_of && <span className="sub"> · as of {a.as_of}</span>}
                </span>
                <span>{a.balance === null ? 'No balance yet' : `${formatMoney(a.balance)}${a.debt ? ' owed' : ''}`}</span>
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
