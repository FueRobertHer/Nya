'use client';

// Read-only sharing between connected people (#45, lib/sharing.ts). Two parts:
//   - the Sharing drawer (components/Sheet.tsx), opened from the Accounts tab
//     or the account menu: an invite link to connect with someone, the people
//     I'm connected with, and for each what I call them, what they see of
//     mine, per account (not shared, that it exists, balance, or balance and
//     recent transactions) and until when, a preview of exactly what they see,
//     both records of showings (when what I share was shown to them, and when
//     what they share was shown to me), plus remove and block. The list and
//     those controls load without any record: each connection's records are
//     asked for on their own when it is opened, as days in this device's time
//     zone, a few at a time, so no record can stand between anyone and Remove
//     or Block;
//   - "Shared by ...", on the Accounts tab whenever a connection shares
//     something: their accounts, read-only, and until when. They are fetched
//     only once that part of the page is on screen, since each fetch is
//     counted as a showing in the sharer's record (lib/access-log.ts).
// Only with Clerk on; with the shared password there's nobody to connect
// with, and both parts render nothing. End dates and the records' days are in
// components/SharingDates.tsx.
//
// Class names avoid "share": ad blockers' social-share filters hide such
// elements (Fanboy's list has ##.share-row).

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { formatMoney } from '@/lib/format';
import { ACCESS_LOG_DAYS, SHARED_TXN_DAYS, type Level, type RecordSummary } from '@/lib/share-rules';
import { Sheet } from './Sheet';
import {
  shortDate,
  endFor,
  endAfterDays,
  endLabel,
  ended,
  EndPicker,
  ShowingsRecord,
  deviceTimeZone,
  RENEW_DAYS,
  type EndChoice,
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
};
export type SharingPayload = {
  enabled: boolean;
  connections?: Connection[];
  blocked?: { id: string; label: string }[];
  accounts?: { id: string; label: string; institution?: string; name?: string }[];
};
/** Both records of showings on one connection (lib/sharing.ts
 *  connectionRecords), asked for when it is opened. */
export type ConnectionRecords = {
  connection: string;
  /** My record's id, to clear it by when it can't be read; null before the
   *  first record, or when the connection's record id can't be read. */
  record_id: string | null;
  /** When the connection's records began, or null before the first. */
  record_since: string | null;
  /** When what I share was shown to them: my record. */
  shown_to_them: RecordSummary;
  /** When what they share was shown to me: their record, the same one they see. */
  shown_to_me: RecordSummary;
};
/** My records that can't be read and that none of my connections is matched
 *  to, by id, clearable once I confirm; `maybe_connected` when one of my
 *  connections has a record id that can't be read, so one may be its. */
export type DamagedRecords = { damaged: string[]; maybe_connected: boolean };

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
  /** At the transactions level, the last SHARED_TXN_DAYS days of them, each in
   *  its own currency (null: the main one); or, instead, that a manual
   *  account's can't be read. */
  transactions?: { date: string; name: string; amount: number; pending: boolean; currency: string | null }[];
  transactions_unreadable?: true;
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
  // Which preview request is the latest: an older answer that comes back
  // after a newer one (go back, save, look again) is dropped.
  const asked = useRef(0);
  // The open connection's records, asked for on their own when it opens, and
  // the damaged records no connection is matched to, asked for apart: neither
  // can stop the list and its controls loading. The latest records request
  // wins, as with the preview.
  const [records, setRecords] = useState<{ id: string; data: ConnectionRecords | null; failed: boolean } | null>(null);
  const askedRecords = useRef(0);
  const [damaged, setDamaged] = useState<DamagedRecords | null>(null);

  const load = useCallback(async () => {
    const res = await fetch('/api/connections').catch(() => null);
    if (!res?.ok) return setError('Could not load sharing.');
    setError('');
    const body: SharingPayload = await res.json();
    setData(body);
    setSelected((s) => (s && body.connections?.some((c) => c.id === s) ? s : null));
  }, []);
  const loadDamaged = useCallback(async () => {
    const res = await fetch('/api/connections/access-log').catch(() => null);
    const body = res?.ok ? await res.json().catch(() => null) : null;
    // Without an answer the notice is left out: the rest works as it was.
    setDamaged(body && Array.isArray(body.damaged) ? body : null);
  }, []);
  const loadRecords = useCallback(async (id: string, all = false) => {
    const mine = ++askedRecords.current;
    // "Show all" keeps what is there while the rest comes.
    setRecords((r) => (all && r?.id === id ? r : { id, data: null, failed: false }));
    const zone = encodeURIComponent(deviceTimeZone());
    const res = await fetch(`/api/connections/records?id=${encodeURIComponent(id)}&tz=${zone}${all ? '&all=1' : ''}`).catch(() => null);
    const body: ConnectionRecords | null = res?.ok ? await res.json().catch(() => null) : null;
    if (askedRecords.current !== mine) return; // another was asked for since
    setRecords((r) => (body ? { id, data: body, failed: false } : { id, data: r?.id === id ? r.data : null, failed: true }));
  }, []);
  useEffect(() => {
    if (open) {
      load();
      loadDamaged();
      return;
    }
    // Next time it opens at the top, with nothing half-done showing.
    setSelected(null);
    setPreviewing(false);
    setInvite(null);
    setNotice('');
    setError('');
    setRecords(null);
  }, [open, load, loadDamaged]);

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
      loadRecords(id);
    },
    [data, loadRecords]
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
    const mine = ++asked.current;
    setPreviewing(true);
    setPreview(null);
    setPreviewError('');
    const res = await fetch(`/api/connections/preview?id=${encodeURIComponent(id)}`).catch(() => null);
    const body = await res?.json().catch(() => null);
    if (asked.current !== mine) return; // another was asked for since
    if (!res?.ok || !body) return setPreviewError(body?.error ?? 'Could not show what they see.');
    setPreview(body);
  }, []);

  // Clears records of mine that can't be read, once I confirm.
  const clearRecords = useCallback(
    async (ids: string[], question: string) => {
      if (ids.length === 0 || !window.confirm(question)) return;
      setBusy(true);
      setError('');
      setNotice('');
      let failed = '';
      for (const id of ids) {
        const res = await send('DELETE', '/api/connections/access-log', { id });
        if (!res.ok) failed ||= res.body?.error ?? 'Something went wrong.';
      }
      setBusy(false);
      if (failed) setError(failed);
      else setNotice(ids.length === 1 ? 'Cleared.' : 'Cleared them.');
      await Promise.all([load(), loadDamaged(), ...(selected ? [loadRecords(selected)] : [])]);
    },
    [load, loadDamaged, loadRecords, selected]
  );

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
          records={records && current && records.id === current.id ? records.data : null}
          recordsFailed={!!(records && current && records.id === current.id && records.failed)}
          onShowAll={() => {
            if (current) loadRecords(current.id, true);
          }}
          damaged={damaged}
          onClearRecord={(id) => clearRecords([id], 'Clear this record? It can’t be read, so nothing readable is lost, and the next showing starts a new one.')}
          onClearDamaged={() =>
            clearRecords(
              damaged?.damaged ?? [],
              damaged?.maybe_connected
                ? 'Clear what can’t be read? Nothing readable is lost.'
                : 'Clear what can’t be read? It belongs to no one you’re connected with now, and nothing readable is lost.'
            )
          }
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
  records,
  recordsFailed,
  onShowAll,
  damaged,
  onClearRecord,
  onClearDamaged,
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
  /** The open connection's records: null while they load, or when they
   *  couldn't be (recordsFailed). */
  records: ConnectionRecords | null;
  recordsFailed: boolean;
  /** Asks for every day of the open connection's records. */
  onShowAll: () => void;
  /** My damaged records no connection is matched to, or null when that
   *  isn't known (still loading, or it couldn't be). */
  damaged: DamagedRecords | null;
  /** Clears my unreadable record on a connection, by its id (after confirming). */
  onClearRecord: (id: string) => void;
  /** Clears my unreadable records that belong to no connection now (after
   *  confirming). */
  onClearDamaged: () => void;
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
          <p className="section-label">Shown to them</p>
          <ShowingsRecord
            key={`them-${current.id}`}
            who={current.label}
            mine
            since={records?.record_since ?? null}
            summary={records?.shown_to_them ?? null}
            failed={recordsFailed}
            busy={busy}
            onClear={
              records && records.shown_to_them.days === null && records.shown_to_them.problem === 'unreadable' && records.record_id
                ? () => onClearRecord(records.record_id!)
                : undefined
            }
            onShowAll={onShowAll}
          />
          <p className="panel-note">
            Counted each time their app loads what you share, which it does when that part of their Accounts tab comes into view. Kept{' '}
            {ACCESS_LOG_DAYS} days at most, and only while you’re connected. They see this same record.
          </p>
        </section>
        <section className="panel-section">
          <p className="section-label">Shown to you</p>
          <ShowingsRecord
            key={`me-${current.id}`}
            who={current.label}
            mine={false}
            since={records?.record_since ?? null}
            summary={records?.shown_to_me ?? null}
            failed={recordsFailed}
            busy={busy}
            onShowAll={onShowAll}
          />
          <p className="panel-note">{current.label}’s record of each time what they share was shown to you: the same one they see.</p>
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
  const unmatched = damaged?.damaged ?? [];
  return (
    <>
      <section className="panel-section">
        <p className="panel-note" style={{ marginTop: 0 }}>
          They see only the accounts you choose, read-only. Nobody else in the app can find you.
        </p>
        {unmatched.length > 0 && (
          <>
            <p className="stale-note">
              {damaged?.maybe_connected
                ? unmatched.length === 1
                  ? 'A record of showings can’t be read, and Nya can’t tell whose it is: someone you’re no longer connected with, or someone whose record id can’t be read.'
                  : `${unmatched.length} records of showings can’t be read, and Nya can’t tell whose they are: people you’re no longer connected with, or someone whose record id can’t be read.`
                : unmatched.length === 1
                  ? 'A record of showings from someone you’re no longer connected with can’t be read.'
                  : `${unmatched.length} records of showings from people you’re no longer connected with can’t be read.`}
            </p>
            <button className="secondary" onClick={onClearDamaged} disabled={busy} style={{ marginTop: 10 }}>
              {unmatched.length === 1 ? 'Clear it' : 'Clear them'}
            </button>
          </>
        )}
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
        Exactly what {who} sees of yours right now, read-only, on their Accounts tab. Their card carries their name for you, and shows its
        dates in their own time zone, so one can fall a day apart from here.
      </p>
      {unsaved && <p className="stale-note">You have changes you haven’t saved. This shows what is saved.</p>}
      {preview.view ? (
        <SharedCard
          name="you"
          view={preview.view}
          note={
            <p className="panel-note">
              {preview.view.expires_at ? `Shared until ${endLabel(preview.view.expires_at)}. ` : ''}You see each time this is shown to them, and so
              do they, in Sharing.
            </p>
          }
        />
      ) : (
        <p className="empty-note">{nothing}</p>
      )}
    </>
  );
}

/**
 * What others share with me, fetched only once this part of the page is on
 * screen, and again after a refresh if it is (or once it next is): each fetch
 * counts as a showing in the sharer's record, so one is made only when the
 * cards can actually be seen. Scrolling past them again fetches nothing.
 */
export function SharedWithMe({ refreshKey }: { refreshKey?: unknown }) {
  const [data, setData] = useState<SharedPayload | null>(null);
  const [onScreen, setOnScreen] = useState(false);
  const spot = useRef<HTMLDivElement>(null);
  const loadedFor = useRef<{ key: unknown } | null>(null);
  useEffect(() => {
    const el = spot.current;
    if (!el) return;
    if (typeof IntersectionObserver === 'undefined') {
      setOnScreen(true);
      return;
    }
    const watch = new IntersectionObserver((entries) => setOnScreen(entries.some((e) => e.isIntersecting)));
    watch.observe(el);
    return () => watch.disconnect();
  }, []);
  useEffect(() => {
    if (!onScreen || (loadedFor.current && Object.is(loadedFor.current.key, refreshKey))) return;
    loadedFor.current = { key: refreshKey };
    fetch('/api/shared')
      .then((res) => (res.ok ? res.json() : null))
      .then((body) => setData(body))
      .catch(() => setData(null));
  }, [onScreen, refreshKey]);
  return (
    <div ref={spot} className="incoming-spot">
      <SharedWithMeView data={data} />
    </div>
  );
}

/** A shared transaction's amount, money out shown as a minus, in its own
 *  currency: nothing is converted (a row with none is in the main one). */
export function sharedTxnAmount(t: { amount: number; currency: string | null }): string {
  return formatMoney(-t.amount, t.currency);
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
          {a.transactions_unreadable ? (
            <div className="incoming-account-date">Its transactions can&apos;t be read, so they aren&apos;t shown.</div>
          ) : a.transactions && a.transactions.length === 0 ? (
            <div className="incoming-account-date">No transactions in the last {SHARED_TXN_DAYS} days.</div>
          ) : (
            a.transactions && (
              <button className="link-btn" onClick={() => setOpen(open === a.id ? null : a.id)}>
                {open === a.id ? 'Hide transactions' : `Recent transactions (${a.transactions.length})`}
              </button>
            )
          )}
          {open === a.id &&
            a.transactions?.map((t, i) => (
              <div key={i} className="incoming-txn">
                <span>
                  {t.date} {t.name}
                  {t.pending ? ' (pending)' : ''}
                </span>
                <span>{sharedTxnAmount(t)}</span>
              </div>
            ))}
        </div>
      ))}
      {note}
    </div>
  );
}

export function SharedWithMeView({ data }: { data: SharedPayload | null }) {
  const [now, setNow] = useState(() => Date.now());
  // A share that ends while it is on screen goes at its end, without waiting
  // for the next fetch: from then on the server shows nothing of it.
  const next = Math.min(Infinity, ...(data?.shared ?? []).map((s) => (s.expires_at ? Date.parse(s.expires_at) : Infinity)).filter((t) => t > now));
  useEffect(() => {
    if (!Number.isFinite(next)) return;
    const timer = setTimeout(() => setNow(Date.now()), Math.min(Math.max(next - Date.now(), 0), 2 ** 31 - 1) + 10);
    return () => clearTimeout(timer);
  }, [next]);
  const shared = (data?.shared ?? []).filter((s) => !ended(s.expires_at, now));
  if (shared.length === 0) return null;
  return (
    <>
      {shared.map((s) => (
        <SharedCard
          key={s.connection}
          name={s.label}
          view={s}
          note={
            <p className="panel-note">
              {s.expires_at ? `Shared until ${endLabel(s.expires_at)}. ` : ''}
              {s.label} sees each time this is shown to you, and so do you, in Sharing.
            </p>
          }
        />
      ))}
    </>
  );
}
