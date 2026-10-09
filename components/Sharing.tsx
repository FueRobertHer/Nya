'use client';

// Read-only sharing between connected people (#45, lib/sharing.ts). Two parts:
//   - the Sharing drawer (components/Sheet.tsx), opened from the Accounts tab
//     or the account menu: an invite link to connect with someone, the people
//     I'm connected with, and for each what I call them, what they see of
//     mine, per account (not shared, that it exists, balance, or balance and
//     recent transactions) and until when, a preview of exactly what they see,
//     when they looked (the access log), plus remove and block;
//   - "Shared by ...", on the Accounts tab whenever a connection shares
//     something: their accounts, read-only, and until when.
// Only with Clerk on; with the shared password there's nobody to connect
// with, and both parts render nothing. End dates and the access log's days
// are in components/SharingDates.tsx.
//
// Class names avoid "share": ad blockers' social-share filters hide such
// elements (Fanboy's list has ##.share-row).

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { formatMoney } from '@/lib/format';
import { ACCESS_LOG_DAYS, type Level } from '@/lib/share-rules';
import { Sheet } from './Sheet';
import {
  shortDate,
  endFor,
  endAfterDays,
  endLabel,
  ended,
  EndPicker,
  WhenTheyLooked,
  RENEW_DAYS,
  type EndChoice,
  type LoggedHour,
} from './SharingDates';

export { shortDate } from './SharingDates';

export type Choice = Level | 'none';
export type Connection = {
  id: string;
  label: string;
  introduced_as: string | null;
  since: string;
  sharing: Record<string, Level>;
  /** When what I share with them ends (an ISO time, which may have passed),
   *  or null for no end. */
  expires_at: string | null;
  /** When they looked, by the hour, oldest first; null when the record can't
   *  be used, and views_problem says why. */
  views: LoggedHour[] | null;
  views_problem?: 'unreadable' | 'unrecognised' | 'unavailable';
};
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

type SharedAccount = {
  id: string;
  label: string;
  level: Level;
  balance: number | null;
  as_of: string | null;
  debt: boolean;
  transactions?: { date: string; name: string; amount: number; pending: boolean }[];
};
/** What someone is shown of one person's share (lib/sharing.ts ShareView). */
export type SharedView = { accounts: SharedAccount[]; expires_at: string | null };
export type SharedPayload = { shared: (SharedView & { connection: string; label: string })[] };
/** "What they see" (lib/sharing.ts previewShare): `view` null when they see nothing. */
export type SharePreview = { connection: string; view: SharedView | null; unreadable?: true };
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

/** The end choice a connection's settings open with: as saved, if it has one. */
const savedChoice = (c: Connection): EndChoice => (c.expires_at ? 'keep' : 'none');

/** The Sharing drawer. Loads each time it opens. */
export function SharingDrawer({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [data, setData] = useState<SharingPayload | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [draft, setDraft] = useState<Record<string, Choice>>({});
  const [labelDraft, setLabelDraft] = useState('');
  const [endChoice, setEndChoice] = useState<EndChoice>('none');
  const [endDay, setEndDay] = useState('');
  const [invite, setInvite] = useState<Invite>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  // "What they see": a level below the connection.
  const [previewing, setPreviewing] = useState(false);
  const [preview, setPreview] = useState<SharePreview | null>(null);
  const [previewError, setPreviewError] = useState('');
  const asked = useRef<string | null>(null);

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
    setPreviewing(false);
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
      setEndChoice(savedChoice(c));
      setEndDay('');
      setPreviewing(false);
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

  // Always what is saved, never the draft: it is what they see.
  const openPreview = useCallback(async (id: string) => {
    asked.current = id;
    setPreviewing(true);
    setPreview(null);
    setPreviewError('');
    const res = await fetch(`/api/connections/preview?id=${encodeURIComponent(id)}`).catch(() => null);
    const body = await res?.json().catch(() => null);
    if (asked.current !== id) return; // another was asked for since
    if (!res?.ok || !body) return setPreviewError(body?.error ?? 'Could not show what they see.');
    setPreview(body);
  }, []);

  const current = data?.connections?.find((c) => c.id === selected) ?? null;
  const accounts = data?.accounts ?? [];
  // Unsaved changes to what they see: the preview shows what is saved.
  const unsaved =
    !!current &&
    (accounts.some((a) => (draft[a.id] ?? 'none') !== (current.sharing[a.id] ?? 'none')) ||
      (endFor(endChoice, endDay) !== undefined && !(endChoice === 'none' && current.expires_at === null)));
  const title = current ? (previewing ? `What ${current.label} sees` : current.label) : 'Sharing';
  return (
    <Sheet
      open={open}
      title={title}
      onClose={onClose}
      onBack={current ? () => (previewing ? setPreviewing(false) : setSelected(null)) : undefined}
    >
      {current && previewing ? (
        <PreviewView who={current.label} expiresAt={current.expires_at} preview={preview} error={previewError} unsaved={unsaved} />
      ) : (
        <SharingPanelView
          data={data}
          current={current}
          draft={draft}
          labelDraft={labelDraft}
          endChoice={endChoice}
          endDay={endDay}
          invite={invite}
          busy={busy}
          error={error}
          notice={notice}
          onOpen={openConnection}
          onChoose={(id, c) => setDraft((d) => ({ ...d, [id]: c }))}
          onLabel={setLabelDraft}
          onEndChoice={setEndChoice}
          onEndDay={setEndDay}
          onInvite={async (fromName, theirLabel) => {
            const body = await act('POST', '/api/connections/invite', { from_name: fromName, their_label: theirLabel }, '');
            if (body) setInvite(body);
          }}
          onSave={async () => {
            if (!current) return;
            const expires_at = endFor(endChoice, endDay);
            const saved = await act('PUT', '/api/connections', { id: current.id, label: labelDraft, accounts: draft, ...(expires_at !== undefined ? { expires_at } : {}) }, 'Saved.');
            // What is saved now: a choice like "7 days" isn't sent again with the next save.
            if (saved && expires_at !== undefined) setEndChoice(expires_at === null ? 'none' : 'keep');
          }}
          onRenew={async () => {
            if (!current) return;
            const expires_at = endAfterDays(RENEW_DAYS);
            const renewed = await act('PUT', '/api/connections', { id: current.id, expires_at }, `Renewed until ${endLabel(expires_at)}.`);
            if (renewed) setEndChoice('keep');
          }}
          onPreview={() => {
            if (current) openPreview(current.id);
          }}
          onClearViews={async () => {
            if (!current || !window.confirm('Clear the record of when they looked? It can’t be read, so nothing readable is lost.')) return;
            await act('DELETE', '/api/connections/access-log', { id: current.id }, 'Cleared. Their next look starts a new record.');
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
      )}
    </Sheet>
  );
}

export function SharingPanelView({
  data,
  current,
  draft,
  labelDraft,
  endChoice,
  endDay,
  invite,
  busy,
  error,
  notice,
  onOpen,
  onChoose,
  onLabel,
  onEndChoice,
  onEndDay,
  onInvite,
  onSave,
  onRenew,
  onPreview,
  onClearViews,
  onRemove,
}: {
  data: SharingPayload | null;
  /** The connection being looked at, or null for the list. */
  current: Connection | null;
  draft: Record<string, Choice>;
  labelDraft: string;
  endChoice: EndChoice;
  endDay: string;
  invite: Invite;
  busy: boolean;
  error: string;
  notice: string;
  onOpen: (id: string) => void;
  onChoose: (id: string, c: Choice) => void;
  onLabel: (label: string) => void;
  onEndChoice: (c: EndChoice) => void;
  onEndDay: (day: string) => void;
  onInvite: (fromName: string, theirLabel: string) => void;
  onSave: () => void;
  /** Gives an ended share another RENEW_DAYS, as it was. */
  onRenew: () => void;
  onPreview: () => void;
  /** Clears an unreadable record of when they looked (after confirming). */
  onClearViews: () => void;
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
    const over = seen > 0 && ended(current.expires_at);
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
          {over ? (
            <>
              <p className="stale-note" style={{ margin: '0 0 6px' }}>
                Ended {endLabel(current.expires_at!)}: {current.label} sees none of your accounts now. Your choices below are kept.
              </p>
              <button className="secondary" onClick={onRenew} disabled={busy} style={{ marginBottom: 6 }}>
                Renew until {endLabel(endAfterDays(RENEW_DAYS))}
              </button>
            </>
          ) : (
            <p className="panel-note" style={{ margin: '0 0 6px' }}>
              {seen === 0
                ? `${current.label} can’t see any of your accounts.`
                : `${current.label} can see ${seen === 1 ? '1 of your accounts' : `${seen} of your accounts`}, read-only${current.expires_at ? `, until ${endLabel(current.expires_at)}` : ''}.`}
            </p>
          )}
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
          <EndPicker saved={current.expires_at} choice={endChoice} day={endDay} onChoice={onEndChoice} onDay={onEndDay} />
          <button onClick={onSave} disabled={busy || (endChoice === 'date' && endFor('date', endDay) === undefined)} style={{ marginTop: 4 }}>
            {busy ? 'Saving…' : 'Save'}
          </button>
          <button className="secondary" onClick={onPreview} style={{ marginTop: 8 }}>
            See what {current.label} sees
          </button>
          {status}
        </section>
        <section className="panel-section">
          <p className="section-label">When they looked</p>
          <WhenTheyLooked
            who={current.label}
            since={current.since}
            views={current.views ?? null}
            problem={current.views_problem ?? (current.views === undefined ? 'unavailable' : undefined)}
            busy={busy}
            onClear={onClearViews}
          />
          <p className="panel-note">Kept for {ACCESS_LOG_DAYS} days. Only you see this, and their card tells them you can.</p>
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
              const what =
                seen === 0
                  ? 'Sees none of your accounts'
                  : ended(c.expires_at)
                    ? `Ended ${endLabel(c.expires_at!)}`
                    : `Sees ${seen} of your accounts${c.expires_at ? ` until ${endLabel(c.expires_at)}` : ''}`;
              return (
                <button key={c.id} className="peer-item" onClick={() => onOpen(c.id)}>
                  <span className="avatar">{initial(c.label)}</span>
                  <span className="peer-item-text">
                    <span className="peer-item-name">{c.label}</span>
                    <span className="peer-item-meta">
                      {what} · since {shortDate(c.since)}
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

/** "What they see": the card they get on their Accounts tab, from the same
 *  projection, as it is saved now. Only their name for me is left out: it is
 *  theirs, so the card says "you". */
export function PreviewView({
  who,
  expiresAt,
  preview,
  error,
  unsaved,
}: {
  /** What I call them. */
  who: string;
  /** When what I share with them ends, as saved: to say why they see nothing. */
  expiresAt: string | null;
  preview: SharePreview | null;
  error: string;
  /** The settings have changes not saved yet, which this doesn't show. */
  unsaved: boolean;
}) {
  if (!preview) return error ? <div className="error">{error}</div> : <div className="spinner" role="status" aria-label="Loading" />;
  const nothing = preview.unreadable
    ? `Some of what you share can’t be read right now, so ${who} sees nothing of yours.`
    : ended(expiresAt)
      ? `Your share ended ${endLabel(expiresAt!)}, so ${who} sees nothing of yours.`
      : `${who} sees nothing of yours.`;
  return (
    <>
      <p className="panel-note" style={{ marginTop: 4 }}>
        Exactly what {who} sees of yours right now, read-only, on their Accounts tab, with the dates they see. The card there carries their name
        for you.
      </p>
      {unsaved && <p className="stale-note">You have changes you haven’t saved. This shows what is saved.</p>}
      {preview.view ? (
        <SharedCard
          name="you"
          view={preview.view}
          note={<p className="panel-note">{preview.view.expires_at ? `Shared until ${endLabel(preview.view.expires_at)}. ` : ''}You can see when they look.</p>}
        />
      ) : (
        <p className="empty-note">{nothing}</p>
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

function shownBalance(a: SharedAccount): string {
  if (a.level === 'exists') return 'Balance not shared';
  if (a.balance === null) return 'No balance yet';
  return `${formatMoney(a.balance)}${a.debt ? ' owed' : ''}`;
}

/** One person's shared accounts, read-only, as the one they're shared with
 *  sees them (and the sharer, in "What they see"). */
function SharedCard({ name, view, note }: { name: string; view: SharedView; note: ReactNode }) {
  const [open, setOpen] = useState<string | null>(null);
  return (
    <div className="card">
      <div className="incoming-head">
        <span className="avatar small">{initial(name)}</span>
        <h3>Shared by {name}</h3>
        <span className="pill">Read-only</span>
      </div>
      {view.accounts.map((a) => (
        <div key={a.id} className="incoming-account">
          <div className="peer-row">
            <span>
              <span className="incoming-account-name">{a.label}</span>
              {a.as_of && <span className="incoming-account-date"> · {shortDate(a.as_of)}</span>}
            </span>
            <span className="incoming-account-value">{shownBalance(a)}</span>
          </div>
          {a.transactions && (
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
      {note}
    </div>
  );
}

export function SharedWithMeView({ data }: { data: SharedPayload | null }) {
  if (!data || data.shared.length === 0) return null;
  return (
    <>
      {data.shared.map((s) => (
        <SharedCard
          key={s.connection}
          name={s.label}
          view={s}
          note={<p className="panel-note">{s.expires_at ? `Shared until ${endLabel(s.expires_at)}. ` : ''}{s.label} can see when you look.</p>}
        />
      ))}
    </>
  );
}
