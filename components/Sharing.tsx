'use client';

// Read-only sharing between connected people (#45, lib/sharing.ts). Two parts:
//   - the Sharing drawer (components/Sheet.tsx), opened from the Accounts tab
//     or the account menu: an invite link to connect with someone, the people
//     I'm connected with, and for each what I call them and what they see of
//     mine, per account (not shared, that it exists, balance, or balance and
//     recent transactions), plus remove and block;
//   - "Shared by ...", on the Accounts tab whenever a connection shares
//     something: their accounts, read-only.
// Only with Clerk on; with the shared password there's nobody to connect
// with, and both parts render nothing.
//
// Class names avoid "share": ad blockers' social-share filters hide such
// elements (Fanboy's list has ##.share-row).

import { useCallback, useEffect, useState } from 'react';
import { formatMoney } from '@/lib/format';
import { Sheet } from './Sheet';

type Level = 'exists' | 'balance' | 'transactions';
export type Choice = Level | 'none';
export type Connection = { id: string; label: string; introduced_as: string | null; since: string; sharing: Record<string, Level> };
export type SharingPayload = {
  enabled: boolean;
  connections?: Connection[];
  blocked?: { id: string; label: string }[];
  accounts?: { id: string; label: string; institution?: string; name?: string }[];
};

type ShareableAccount = NonNullable<SharingPayload['accounts']>[number];

/** Accounts by institution, in the order given (the server sorts them). */
function byInstitution(accounts: ShareableAccount[]): [string, ShareableAccount[]][] {
  const groups = new Map<string, ShareableAccount[]>();
  for (const a of accounts) {
    const key = a.institution ?? 'Accounts';
    groups.set(key, [...(groups.get(key) ?? []), a]);
  }
  return [...groups.entries()];
}
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

const initial = (label: string) => (label.trim()[0] ?? '?').toUpperCase();

/** "Sep 28", with the year only when it isn't this one. Takes a YYYY-MM-DD
 *  (a calendar day, shown as it is) or a full ISO time (an instant, shown as the
 *  day it was in the viewer's own time zone, not its UTC day). */
export function shortDate(iso: string, now: Date = new Date()): string {
  const isInstant = /^\d{4}-\d{2}-\d{2}T\d{2}:/.test(iso);
  const d = isInstant ? new Date(iso) : new Date(`${iso.slice(0, 10)}T12:00:00`);
  if (Number.isNaN(d.getTime())) return iso;
  const sameYear = d.getFullYear() === now.getFullYear();
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', ...(sameYear ? {} : { year: 'numeric' }) });
}

function Chevron() {
  return (
    <svg className="chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="m9 18 6-6-6-6" />
    </svg>
  );
}

/** A phone's own share menu (Messages and the like). Only on touch screens:
 *  desktop browsers have one too, but there copying is what people expect. */
function touchShare(): boolean {
  return typeof navigator !== 'undefined' && typeof navigator.share === 'function' && typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
}

/** Hands the link on: the share menu on a phone, else the clipboard, else
 *  selects it for copying by hand. True when it went somewhere. */
async function sendLink(url: string, field: HTMLInputElement | null): Promise<boolean> {
  try {
    if (touchShare()) {
      await navigator.share({ url, title: 'Connect with me on Nya' });
      return true;
    }
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(url);
      return true;
    }
  } catch {
    // Dismissed, or the clipboard refused.
  }
  field?.focus();
  field?.select();
  return false;
}

/** The Sharing drawer. Loads each time it opens. */
export function SharingDrawer({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [data, setData] = useState<SharingPayload | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [draft, setDraft] = useState<Record<string, Choice>>({});
  const [labelDraft, setLabelDraft] = useState('');
  const [invite, setInvite] = useState<Invite>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const load = useCallback(async () => {
    const res = await fetch('/api/connections').catch(() => null);
    if (!res?.ok) return setError('Could not load sharing.');
    setError('');
    const body: SharingPayload = await res.json();
    setData(body);
    setSelected((s) => (s && body.connections?.some((c) => c.id === s) ? s : null));
  }, []);
  useEffect(() => {
    if (open) {
      load();
      return;
    }
    // Next time it opens at the top, with nothing half-done showing.
    setSelected(null);
    setInvite(null);
    setNotice('');
    setError('');
  }, [open, load]);

  // Opening a connection starts its draft from what is saved.
  const openConnection = useCallback(
    (id: string) => {
      const c = data?.connections?.find((c) => c.id === id);
      if (!c) return;
      setDraft(Object.fromEntries((data?.accounts ?? []).map((a) => [a.id, c.sharing[a.id] ?? 'none'])));
      setLabelDraft(c.label);
      setNotice('');
      setError('');
      setSelected(id);
    },
    [data]
  );

  const act = useCallback(
    async (method: string, path: string, body: unknown, done: string) => {
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
      await load();
      return res.body;
    },
    [load]
  );

  const current = data?.connections?.find((c) => c.id === selected) ?? null;
  return (
    <Sheet open={open} title={current ? current.label : 'Sharing'} onClose={onClose} onBack={current ? () => setSelected(null) : undefined}>
      <SharingPanelView
        data={data}
        current={current}
        draft={draft}
        labelDraft={labelDraft}
        invite={invite}
        busy={busy}
        error={error}
        notice={notice}
        onOpen={openConnection}
        onChoose={(id, c) => setDraft((d) => ({ ...d, [id]: c }))}
        onLabel={setLabelDraft}
        onInvite={async (fromName, theirLabel) => {
          const body = await act('POST', '/api/connections/invite', { from_name: fromName, their_label: theirLabel }, '');
          if (body) setInvite(body);
        }}
        onSave={() => {
          if (current) act('PUT', '/api/connections', { id: current.id, label: labelDraft, accounts: draft }, 'Saved.');
        }}
        onRemove={async (id, block) => {
          const what = block
            ? 'Block them? Everything shared both ways ends, and they can’t connect with you again.'
            : 'Remove them? Everything shared both ways ends.';
          if (block !== null && !window.confirm(what)) return;
          const done = await act('DELETE', '/api/connections', { id, block: block === true }, block ? 'Blocked.' : block === null ? 'Unblocked.' : 'Removed.');
          if (done) setSelected(null);
        }}
      />
    </Sheet>
  );
}

export function SharingPanelView({
  data,
  current,
  draft,
  labelDraft,
  invite,
  busy,
  error,
  notice,
  onOpen,
  onChoose,
  onLabel,
  onInvite,
  onSave,
  onRemove,
}: {
  data: SharingPayload | null;
  /** The connection being looked at, or null for the list. */
  current: Connection | null;
  draft: Record<string, Choice>;
  labelDraft: string;
  invite: Invite;
  busy: boolean;
  error: string;
  notice: string;
  onOpen: (id: string) => void;
  onChoose: (id: string, c: Choice) => void;
  onLabel: (label: string) => void;
  onInvite: (fromName: string, theirLabel: string) => void;
  onSave: () => void;
  /** block: true blocks, false removes, null lifts a block (no confirmation). */
  onRemove: (id: string, block: boolean | null) => void;
}) {
  const [fromName, setFromName] = useState('');
  const [theirLabel, setTheirLabel] = useState('');
  const [sent, setSent] = useState(false);
  if (!data) return error ? <div className="error">{error}</div> : <div className="spinner" role="status" aria-label="Loading" />;
  if (!data.enabled) return <p className="panel-note">Sharing needs accounts; this app signs in with a shared password.</p>;
  const accounts = data.accounts ?? [];
  const status = (
    <>
      {error && <div className="error">{error}</div>}
      {notice && <div className="status-note">{notice}</div>}
    </>
  );

  if (current) {
    // What they can see now: a share on an account I've since hidden is paused.
    const seen = accounts.filter((a) => current.sharing[a.id]).length;
    return (
      <>
        <section className="panel-section">
          <label className="field">
            What you call them
            <input value={labelDraft} onChange={(e) => onLabel(e.target.value)} maxLength={40} />
          </label>
          <p className="panel-note">
            {current.introduced_as ? `They introduced themselves as “${current.introduced_as}”. ` : 'They didn’t give a name. '}
            Connected {shortDate(current.since)}. Not who you meant to invite? Remove them.
          </p>
        </section>
        <section className="panel-section">
          <p className="section-label">What they can see</p>
          <p className="panel-note" style={{ margin: '0 0 6px' }}>
            {seen === 0
              ? `${current.label} can’t see any of your accounts.`
              : `${current.label} can see ${seen === 1 ? '1 of your accounts' : `${seen} of your accounts`}, read-only.`}
          </p>
          {accounts.length === 0 && <p className="panel-note">You have no accounts to share yet.</p>}
          {byInstitution(accounts).map(([institution, list]) => (
            <div key={institution} className="institution-group">
              <p className="institution-name">{institution}</p>
              {list.map((a) => (
                <div key={a.id} className="peer-row">
                  <span>{a.name ?? a.label}</span>
                  <select value={draft[a.id] ?? 'none'} onChange={(e) => onChoose(a.id, e.target.value as Choice)} aria-label={`What they see of ${a.label}`}>
                    {(Object.keys(LEVEL_LABEL) as Choice[]).map((c) => (
                      <option key={c} value={c}>
                        {LEVEL_LABEL[c]}
                      </option>
                    ))}
                  </select>
                </div>
              ))}
            </div>
          ))}
          <button onClick={onSave} disabled={busy} style={{ marginTop: 12 }}>
            {busy ? 'Saving…' : 'Save'}
          </button>
          {status}
        </section>
        <section className="panel-section">
          <p className="section-label">Connection</p>
          <div className="button-pair">
            <button className="danger-outline" onClick={() => onRemove(current.id, false)} disabled={busy}>
              Remove
            </button>
            <button className="danger-outline" onClick={() => onRemove(current.id, true)} disabled={busy}>
              Block
            </button>
          </div>
          <p className="panel-note">Either ends everything shared, both ways. Blocking also stops them connecting with you again.</p>
        </section>
      </>
    );
  }

  const connections = data.connections ?? [];
  const blocked = data.blocked ?? [];
  return (
    <>
      <section className="panel-section">
        <p className="panel-note" style={{ marginTop: 0 }}>
          They see only the accounts you choose, read-only. Nobody else in the app can find you.
        </p>
      </section>
      <section className="panel-section">
        <p className="section-label">Invite someone</p>
        <label className="field">
          Your name, as they’ll see it
          <input value={fromName} onChange={(e) => setFromName(e.target.value)} placeholder="Optional" maxLength={40} />
        </label>
        <label className="field">
          What you call them
          <input value={theirLabel} onChange={(e) => setTheirLabel(e.target.value)} placeholder="Optional" maxLength={40} />
        </label>
        <button onClick={() => onInvite(fromName, theirLabel)} disabled={busy}>
          Create invite link
        </button>
        {invite && (
          <>
            <div className="invite-link">
              <input readOnly value={invite.url} aria-label="Invite link" onFocus={(e) => e.target.select()} />
              <button
                className="secondary"
                onClick={async (e) => {
                  const field = e.currentTarget.previousElementSibling as HTMLInputElement | null;
                  const ok = await sendLink(invite.url, field);
                  if (!ok) return;
                  setSent(true);
                  setTimeout(() => setSent(false), 2000);
                }}
              >
                {sent ? (touchShare() ? 'Sent' : 'Copied') : touchShare() ? 'Send' : 'Copy'}
              </button>
            </div>
            <p className="panel-note">Send it to them yourself. It works once, until {new Date(invite.expires_at).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}.</p>
          </>
        )}
        {status}
      </section>
      <section className="panel-section">
        <p className="section-label">People</p>
        {connections.length === 0 ? (
          <p className="panel-note">No one yet. Create an invite link and send it to them.</p>
        ) : (
          <div className="peer-list">
            {connections.map((c) => {
              const seen = accounts.filter((a) => c.sharing[a.id]).length;
              return (
                <button key={c.id} className="peer-item" onClick={() => onOpen(c.id)}>
                  <span className="avatar">{initial(c.label)}</span>
                  <span className="peer-item-text">
                    <span className="peer-item-name">{c.label}</span>
                    <span className="peer-item-meta">
                      {seen === 0 ? 'Sees none of your accounts' : `Sees ${seen} of your accounts`} · since {shortDate(c.since)}
                    </span>
                  </span>
                  <Chevron />
                </button>
              );
            })}
          </div>
        )}
      </section>
      {blocked.length > 0 && (
        <section className="panel-section">
          <p className="section-label">Blocked</p>
          <div className="peer-list">
            {blocked.map((b) => (
              <div key={b.id} className="peer-item">
                <span className="avatar small">{initial(b.label)}</span>
                <span className="peer-item-text">
                  <span className="peer-item-name">{b.label}</span>
                </span>
                <button className="secondary peer-item-action" onClick={() => onRemove(b.id, null)} disabled={busy}>
                  Unblock
                </button>
              </div>
            ))}
          </div>
        </section>
      )}
    </>
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

// A manual account's id (lib/manual.ts MANUAL_ID_PREFIX, a module a client
// component can't import). What is shared of one's transactions is its
// bank's rows only for now, and it has none: its rows are entered by hand.
const isManualAccount = (id: string) => id.startsWith('manual_');

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
          <div className="incoming-head">
            <span className="avatar small">{initial(s.label)}</span>
            <h3>Shared by {s.label}</h3>
            <span className="pill">Read-only</span>
          </div>
          {s.accounts.map((a) => (
            <div key={a.id} className="incoming-account">
              <div className="peer-row">
                <span>
                  <span className="incoming-account-name">{a.label}</span>
                  {a.as_of && <span className="incoming-account-date"> · {shortDate(a.as_of)}</span>}
                </span>
                <span className="incoming-account-value">{shownBalance(a)}</span>
              </div>
              {a.transactions && a.transactions.length === 0 && isManualAccount(a.id) ? (
                <div className="incoming-account-date">Transactions entered by hand aren&apos;t shared yet.</div>
              ) : a.transactions && (
                <button className="link-btn" onClick={() => setOpen(open === a.id ? null : a.id)}>
                  {open === a.id ? 'Hide transactions' : `Recent transactions (${a.transactions.length})`}
                </button>
              )}
              {open === a.id &&
                a.transactions?.map((t, i) => (
                  <div key={i} className="incoming-txn">
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
