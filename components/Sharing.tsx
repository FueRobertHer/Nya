'use client';

// Read-only sharing between connected people (#45, lib/sharing.ts). Two parts:
//   - Settings > Sharing (SharingSettings), opened from Settings or the
//     account menu: in place, an invite link to connect with someone, the
//     people I'm connected with and the blocked; each person in a sheet of
//     their own (components/Sheet.tsx) with what I call them, what they see of
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
//     counted as a showing in the sharer's record (lib/access-log.ts). A
//     fetch turned away (the limit on reads) or failing keeps what is shown,
//     and says why it couldn't be refreshed. With nothing on screen it says
//     nothing, unless nothing has loaded yet and the last good read on this
//     device had something shared (rememberShares).
// Beside the accounts, the other kinds of share (#45 step 3): a person's sheet's
// choices for them, and what they could work out from all of it together,
// are components/ShareKinds.tsx; how a card draws them, components/SharedViews.tsx.
// Only with Clerk on; with the shared password there's nobody to connect
// with, and both parts render nothing. End dates and the records' days are in
// components/SharingDates.tsx.
//
// Class names avoid "share": ad blockers' social-share filters hide such
// elements (Fanboy's list has ##.share-row).

import { useCallback, useEffect, useRef, useState, type ReactNode, type Ref } from 'react';
import { formatMoney } from '@/lib/format';
import { shownName } from '@/lib/merchant-name';
import { ACCESS_LOG_DAYS, SHARED_TXN_DAYS, type Level, type RecordSummary } from '@/lib/share-rules';
import { Sheet } from './Sheet';
import { CollapsibleHeader } from './Collapsible';
import { RowsSkeleton, SharedWithMeSkeleton } from './LoadingSkeletons';
import { Notice } from './TotalCaveats';
import { CAUTION } from './ConnectionStatus';
import { Masked } from './HideAmounts';
import { cacheKeyFor } from './device-cache';
import { InferenceNotes, KindsEditor, sameViews, seenText, viewsToSave, type ShareableGoal } from './ShareKinds';
import { SharedViewsList } from './SharedViews';
import { sharedKinds, type ShareViews, type SharedViews } from '@/lib/share-kinds';
import type { Inference } from '@/lib/share-inference';
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
  /** The other kinds I share with them (lib/share-kinds.ts). */
  views?: ShareViews;
  /** When what I share with them ends (an ISO time, which may have passed),
   *  or null for no end. */
  expires_at: string | null;
};
export type SharingPayload = {
  enabled: boolean;
  connections?: Connection[];
  blocked?: { id: string; label: string }[];
  /** What I can share, and (`waiting`) a shared account a connector feeds
   *  that is only waiting for its balance: its share can be kept or ended,
   *  not begun or changed, until it has one (lib/sharing.ts). */
  accounts?: { id: string; label: string; institution?: string; name?: string; waiting?: true; investment?: true }[];
  /** The goals I could share, and whether they couldn't be read. */
  goals?: ShareableGoal[];
  goals_unreadable?: true;
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
  /** The currency the balance is in (null: the main one). */
  currency: string | null;
  as_of: string | null;
  debt: boolean;
  /** At the transactions level, the last SHARED_TXN_DAYS days of them, each in
   *  its own currency (null: the main one); or, instead, that a manual
   *  account's can't be read. */
  transactions?: { date: string; name: string; amount: number; pending: boolean; currency: string | null; name_from_bank?: true }[];
  transactions_unreadable?: true;
  /** It ended on `on` (lib/lifecycle.ts): no balance then, and only the
   *  transactions from before it. */
  ended?: { state: 'closed' | 'left' | 'untracked'; on: string };
};
/** What someone is shown of one person's share (lib/sharing.ts ShareView). */
export type SharedView = { accounts: SharedAccount[]; expires_at: string | null; views?: SharedViews };
export type SharedPayload = { shared: (SharedView & { connection: string; label: string })[] };
/** "What they see" (lib/sharing.ts previewShare): `view` null when they see
 *  nothing; `inferences`, what they could work out from all of it. */
export type SharePreview = { connection: string; view: SharedView | null; unreadable?: true; inferences?: Inference[]; inferences_unavailable?: true };
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

/** A done notice's icon. */
const CHECK = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M20 6 9 17l-5-5" />
  </svg>
);

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

/** The value, or the last one that wasn't null: what a closing sheet keeps
 *  showing while it slides out. */
function useLast<T>(value: T | null): T | null {
  const last = useRef<T | null>(value);
  if (value !== null) last.current = value;
  return last.current;
}

/** Settings > Sharing (docs/design/information-architecture.md#settings): the
 *  list in place (the invite, the people, the blocked), and each person in a
 *  sheet of their own, with "What they see" as its second level. Loads as the
 *  section opens: Settings mounts a section only while it is open. */
export function SharingSettings() {
  const [data, setData] = useState<SharingPayload | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [draft, setDraft] = useState<Record<string, Choice>>({});
  // The other kinds, as being chosen (lib/share-kinds.ts).
  const [viewsDraft, setViewsDraft] = useState<ShareViews>({});
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
  // The People card's title, where focus goes once a person is removed or
  // blocked: the row that opened their sheet is gone with them. The Blocked
  // card's, where it goes once someone is unblocked (People's, when that was
  // the last and the card is gone).
  const people = useRef<HTMLHeadingElement>(null);
  const blockedTitle = useRef<HTMLHeadingElement>(null);
  // Which of the two focus goes to, once the list that follows the change is
  // drawn: only then is it known whether the Blocked card is still there.
  const [landing, setLanding] = useState<'people' | 'blocked' | null>(null);
  useEffect(() => {
    if (!landing) return;
    (landing === 'blocked' ? (blockedTitle.current ?? people.current) : people.current)?.focus();
    setLanding(null);
  }, [landing]);

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
    load();
    loadDamaged();
  }, [load, loadDamaged]);

  // Opening a connection starts its draft from what is saved.
  const openConnection = useCallback(
    (id: string) => {
      const c = data?.connections?.find((c) => c.id === id);
      if (!c) return;
      setDraft(Object.fromEntries((data?.accounts ?? []).map((a) => [a.id, c.sharing[a.id] ?? 'none'])));
      setViewsDraft(c.views ?? {});
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

  // Removes, blocks or (block null) unblocks, after confirming the first two.
  // A person removed or blocked from their sheet takes the sheet with them,
  // and focus goes to the People card, under the line saying what was done.
  const remove = useCallback(
    async (id: string, block: boolean | null) => {
      const what = block
        ? 'Block them? Everything shared both ways ends, and they can’t connect with you again.'
        : 'Remove them? Everything shared both ways ends.';
      if (block !== null && !window.confirm(what)) return;
      const done = await act('DELETE', '/api/connections', { id, block: block === true }, block ? 'Blocked.' : block === null ? 'Unblocked.' : 'Removed.');
      if (!done) return;
      if (block !== null) setSelected(null);
      setLanding(block === null ? 'blocked' : 'people');
    },
    [act]
  );

  const current = data?.connections?.find((c) => c.id === selected) ?? null;
  // What the sheet shows while it slides out, once closed.
  const shown = useLast(current);
  const accounts = data?.accounts ?? [];
  // Unsaved changes to what they see: the preview shows what is saved.
  const unsaved =
    !!current &&
    (accounts.some((a) => (draft[a.id] ?? 'none') !== (current.sharing[a.id] ?? 'none')) ||
      !sameViews(viewsDraft, current.views) ||
      (endFor(endChoice, endDay) !== undefined && !(endChoice === 'none' && current.expires_at === null)));
  return (
    <>
      <SharingListView
        data={data}
        invite={invite}
        busy={busy}
        // What was done, or went wrong, on the list; a person's sheet says
        // its own while it is open.
        error={selected ? '' : error}
        notice={selected ? '' : notice}
        damaged={damaged}
        peopleRef={people}
        blockedRef={blockedTitle}
        onOpen={openConnection}
        onInvite={async (fromName, theirLabel) => {
          const body = await act('POST', '/api/connections/invite', { from_name: fromName, their_label: theirLabel }, '');
          if (body) setInvite(body);
        }}
        onClearDamaged={() =>
          clearRecords(
            damaged?.damaged ?? [],
            damaged?.maybe_connected
              ? 'Clear what can’t be read? Nothing readable is lost.'
              : 'Clear what can’t be read? It belongs to no one you’re connected with now, and nothing readable is lost.'
          )
        }
        onUnblock={(id) => remove(id, null)}
      />
      {data && (
        <Sheet
          open={!!current}
          title={shown ? (previewing ? `What ${shown.label} sees` : shown.label) : 'Sharing'}
          onClose={() => {
            setSelected(null);
            setNotice('');
            setError('');
          }}
          onBack={previewing ? () => setPreviewing(false) : undefined}
        >
          {shown &&
            (previewing ? (
              <PreviewView who={shown.label} expiresAt={shown.expires_at} preview={preview} error={previewError} unsaved={unsaved} />
            ) : (
              <ConnectionView
                data={data}
                current={shown}
                draft={draft}
                viewsDraft={viewsDraft}
                labelDraft={labelDraft}
                endChoice={endChoice}
                endDay={endDay}
                busy={busy}
                error={error}
                notice={notice}
                onChoose={(id, c) => setDraft((d) => ({ ...d, [id]: c }))}
                onViews={setViewsDraft}
                onLabel={setLabelDraft}
                onEndChoice={setEndChoice}
                onEndDay={setEndDay}
                onSave={async () => {
                  if (!current) return;
                  const expires_at = endFor(endChoice, endDay);
                  const saved = await act(
                    'PUT',
                    '/api/connections',
                    { id: current.id, label: labelDraft, accounts: draft, views: viewsToSave(viewsDraft), ...(expires_at !== undefined ? { expires_at } : {}) },
                    'Saved.'
                  );
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
                records={records && records.id === shown.id ? records.data : null}
                recordsFailed={!!(records && records.id === shown.id && records.failed)}
                onShowAll={() => {
                  if (current) loadRecords(current.id, true);
                }}
                onClearRecord={(id) => clearRecords([id], 'Clear this record? It can’t be read, so nothing readable is lost, and the next showing starts a new one.')}
                onRemove={remove}
              />
            ))}
        </Sheet>
      )}
    </>
  );
}

/** The list, in place on Settings > Sharing: how sharing works, the invite,
 *  the people (each a row that opens their sheet) and the blocked. What the
 *  list's actions did, or why they failed, is said once at its top, in one
 *  status region. */
export function SharingListView({
  data,
  invite,
  busy,
  error,
  notice,
  damaged,
  peopleRef,
  blockedRef,
  onOpen,
  onInvite,
  onClearDamaged,
  onUnblock,
}: {
  data: SharingPayload | null;
  invite: Invite;
  busy: boolean;
  error: string;
  notice: string;
  /** My damaged records no connection is matched to, or null when that
   *  isn't known (still loading, or it couldn't be). */
  damaged: DamagedRecords | null;
  /** The People card's title, for focus to land on. */
  peopleRef?: Ref<HTMLHeadingElement>;
  /** The Blocked card's title, for focus to land on. */
  blockedRef?: Ref<HTMLHeadingElement>;
  onOpen: (id: string) => void;
  onInvite: (fromName: string, theirLabel: string) => void;
  /** Clears my unreadable records that belong to no connection now (after
   *  confirming). */
  onClearDamaged: () => void;
  onUnblock: (id: string) => void;
}) {
  const [fromName, setFromName] = useState('');
  const [theirLabel, setTheirLabel] = useState('');
  const [sent, setSent] = useState(false);
  if (!data) {
    if (error) return <Notice level="critical">{error}</Notice>;
    return (
      <div className="stack" aria-busy="true">
        <section className="card stack" aria-hidden="true">
          <div className="card-header">
            <h2>
              <span className="skeleton rows-skeleton-title" />
            </h2>
          </div>
          <RowsSkeleton count={2} />
        </section>
        <p className="visually-hidden" role="status">
          Loading
        </p>
      </div>
    );
  }
  if (!data.enabled) return <p className="empty-note">Sharing needs accounts; this app signs in with a shared password.</p>;
  const accounts = data.accounts ?? [];
  const connections = data.connections ?? [];
  const blocked = data.blocked ?? [];
  const unmatched = damaged?.damaged ?? [];
  return (
    <div className="stack">
      <div className="stack tight">
        <p className="helper">They see only the accounts you choose, read-only. Nobody else in the app can find you.</p>
        {unmatched.length > 0 && (
          <div className="notice caution">
            {CAUTION}
            <div className="stack tight">
              <p>
                {damaged?.maybe_connected
                  ? unmatched.length === 1
                    ? 'A record of showings can’t be read, and Nya can’t tell whose it is: someone you’re no longer connected with, or someone whose record id can’t be read.'
                    : `${unmatched.length} records of showings can’t be read, and Nya can’t tell whose they are: people you’re no longer connected with, or someone whose record id can’t be read.`
                  : unmatched.length === 1
                    ? 'A record of showings from someone you’re no longer connected with can’t be read.'
                    : `${unmatched.length} records of showings from people you’re no longer connected with can’t be read.`}
              </p>
              <div className="btn-row">
                <button className="btn secondary" onClick={onClearDamaged} disabled={busy}>
                  {unmatched.length === 1 ? 'Clear it' : 'Clear them'}
                </button>
              </div>
            </div>
          </div>
        )}
        {/* One region for what the list's actions did: always on the page, so
            a line put in it is read out. */}
        <div role="status">
          {error && <Notice level="critical">{error}</Notice>}
          {notice && (
            <div className="notice done">
              {CHECK}
              <div>{notice}</div>
            </div>
          )}
        </div>
      </div>
      <section className="card stack" aria-labelledby="sharing-invite-title">
        <div className="card-header">
          <h2 id="sharing-invite-title">Invite someone</h2>
        </div>
        <label className="field">
          Your name, as they’ll see it
          <input value={fromName} onChange={(e) => setFromName(e.target.value)} placeholder="Optional" maxLength={40} />
        </label>
        <label className="field">
          What you call them
          <input value={theirLabel} onChange={(e) => setTheirLabel(e.target.value)} placeholder="Optional" maxLength={40} />
        </label>
        <div className="btn-row">
          <button className="btn" onClick={() => onInvite(fromName, theirLabel)} disabled={busy}>
            Create invite link
          </button>
        </div>
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
            <p className="helper">Send it to them yourself. It works once, until {new Date(invite.expires_at).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}.</p>
          </>
        )}
      </section>
      <section className="card stack" aria-labelledby="sharing-people-title">
        <div className="card-header">
          <h2 id="sharing-people-title" ref={peopleRef} tabIndex={-1}>
            People
          </h2>
        </div>
        {connections.length === 0 ? (
          <p className="empty-note">No one yet. Create an invite link and send it to them.</p>
        ) : (
          <ul className="list-rows">
            {connections.map((c) => {
              const seen = accounts.filter((a) => !a.waiting && c.sharing[a.id]).length;
              const sees = seenText(seen, c.views);
              const what =
                sees === null
                  ? 'Sees none of your accounts'
                  : ended(c.expires_at)
                    ? `Ended ${endLabel(c.expires_at!)}`
                    : `Sees ${sees}${c.expires_at ? ` until ${endLabel(c.expires_at)}` : ''}`;
              return (
                <li key={c.id}>
                  <button className="list-row" aria-haspopup="dialog" onClick={() => onOpen(c.id)}>
                    <span className="avatar" aria-hidden="true">
                      {initial(c.label)}
                    </span>
                    <span className="list-row-text">
                      <span className="list-row-title">{c.label}</span>
                      <span className="list-row-sub">
                        {what} · since {shortDate(c.since)}
                      </span>
                    </span>
                    <Chevron />
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </section>
      {blocked.length > 0 && (
        <section className="card stack" aria-labelledby="sharing-blocked-title">
          <div className="card-header">
            <h2 id="sharing-blocked-title" ref={blockedRef} tabIndex={-1}>
              Blocked
            </h2>
          </div>
          <ul className="list-rows">
            {blocked.map((b) => (
              <li key={b.id}>
                {/* Not a button itself: its one action is Unblock, beside it. */}
                <div className="list-row">
                  <span className="avatar small" aria-hidden="true">
                    {initial(b.label)}
                  </span>
                  <span className="list-row-text">
                    <span className="list-row-title">{b.label}</span>
                  </span>
                  <button className="btn secondary" onClick={() => onUnblock(b.id)} disabled={busy}>
                    Unblock
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

/** One person, in their sheet: what I call them, what they see of mine and
 *  until when, both records of showings, and Remove and Block. */
export function ConnectionView({
  data,
  current,
  draft,
  viewsDraft = {},
  labelDraft,
  endChoice,
  endDay,
  busy,
  error,
  notice,
  onChoose,
  onViews = () => {},
  onLabel,
  onEndChoice,
  onEndDay,
  onSave,
  onRenew,
  onPreview,
  records,
  recordsFailed,
  onShowAll,
  onClearRecord,
  onRemove,
}: {
  data: SharingPayload;
  /** The connection being looked at. */
  current: Connection;
  draft: Record<string, Choice>;
  /** The other kinds, as being chosen. */
  viewsDraft?: ShareViews;
  labelDraft: string;
  endChoice: EndChoice;
  endDay: string;
  busy: boolean;
  error: string;
  notice: string;
  onChoose: (id: string, c: Choice) => void;
  onViews?: (views: ShareViews) => void;
  onLabel: (label: string) => void;
  onEndChoice: (c: EndChoice) => void;
  onEndDay: (day: string) => void;
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
  /** Clears my unreadable record on a connection, by its id (after confirming). */
  onClearRecord: (id: string) => void;
  /** block: true blocks, false removes (each confirmed first). */
  onRemove: (id: string, block: boolean) => void;
}) {
  const accounts = data.accounts ?? [];
  const status = (
    <>
      {error && <div className="error">{error}</div>}
      {notice && <div className="status-note">{notice}</div>}
    </>
  );

  // What they can see now: a share on an account I've since hidden, or on
  // one waiting for its balance, is paused. One waiting is listed only
  // where it is shared, to keep or end.
  const seen = accounts.filter((a) => !a.waiting && current.sharing[a.id]).length;
  const listed = accounts.filter((a) => !a.waiting || current.sharing[a.id]);
  // What they can see now, in words: accounts, and the other kinds.
  const sees = seenText(seen, current.views);
  const over = sees !== null && ended(current.expires_at);
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
              Ended {endLabel(current.expires_at!)}: {current.label} sees {sharedKinds(current.views).length > 0 ? 'nothing of yours' : 'none of your accounts'} now. Your choices below are kept.
            </p>
            <button className="secondary" onClick={onRenew} disabled={busy} style={{ marginBottom: 6 }}>
              Renew until {endLabel(endAfterDays(RENEW_DAYS))}
            </button>
          </>
        ) : (
          <p className="panel-note" style={{ margin: '0 0 6px' }}>
            {sees === null
              ? `${current.label} can’t see any of your accounts.`
              : `${current.label} can see ${sees}, read-only${current.expires_at ? `, until ${endLabel(current.expires_at)}` : ''}.`}
          </p>
        )}
        {listed.length === 0 && <p className="panel-note">You have no accounts to share yet.</p>}
        {byInstitution(listed).map(([institution, list]) => (
          <div key={institution} className="institution-group">
            <p className="institution-name">{institution}</p>
            {list.map((a) => (
              <div key={a.id} className="peer-row">
                <span>
                  {a.name ?? a.label}
                  {a.waiting && (
                    <span className="type-tag" style={{ display: 'block' }}>
                      Waiting for its balance: shown to them again once it has one
                    </span>
                  )}
                </span>
                <select value={draft[a.id] ?? 'none'} onChange={(e) => onChoose(a.id, e.target.value as Choice)} aria-label={`What they see of ${a.label}`}>
                  {(a.waiting ? (['none', current.sharing[a.id]] as Choice[]) : (Object.keys(LEVEL_LABEL) as Choice[])).map((c) => (
                    <option key={c} value={c}>
                      {LEVEL_LABEL[c]}
                    </option>
                  ))}
                </select>
              </div>
            ))}
          </div>
        ))}
        <KindsEditor
          views={viewsDraft}
          onChange={onViews}
          goals={data.goals_unreadable ? null : (data.goals ?? [])}
          who={current.label}
          accounts={accounts
            .filter((a) => !a.waiting)
            .map((a) => {
              const c = draft[a.id] ?? 'none';
              return { id: a.id, label: a.label, level: c === 'none' ? null : c, investment: a.investment === true };
            })}
        />
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
        <>
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
          {/* What they could work out from all of it: every warning needs another kind shared. */}
          {preview.inferences_unavailable ? (
            <p className="stale-note">What they could work out from all of this couldn’t be worked out just now. Try again later.</p>
          ) : (
            preview.view.views && <InferenceNotes found={preview.inferences ?? []} />
          )}
        </>
      ) : (
        <p className="empty-note">{nothing}</p>
      )}
    </>
  );
}

/**
 * Why what is shared with me couldn't be read or refreshed, in words, from
 * the answer of app/api/shared: past the limit on reads (429), when to come
 * back, in the answer's own words, else by its Retry-After; otherwise what
 * the answer said, or that Nya couldn't be reached (status 0).
 */
export function sharedProblem(status: number, body: { error?: unknown } | null, retryAfter: string | null): string {
  const said = typeof body?.error === 'string' ? body.error.trim() : '';
  const sentence = (t: string) => (/[.!?]$/.test(t) ? t : `${t}.`);
  if (status === 429) {
    if (said) return sentence(said);
    const seconds = Number(retryAfter);
    const minutes = Number.isFinite(seconds) && seconds > 0 ? Math.ceil(seconds / 60) : null;
    return minutes === null ? 'Try again in a few minutes.' : `Try again in ${minutes === 1 ? 'a minute' : `${minutes} minutes`}.`;
  }
  if (said) return /try again/i.test(said) ? sentence(said) : `${sentence(said)} Try again later.`;
  return status === 0 ? 'Nya couldn’t be reached. Try again later.' : 'Try again later.';
}

type DeviceStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

/** This device's storage, or null where there is none (the server). Even
 *  reaching it can throw, where site data is blocked. */
function deviceStorage(): DeviceStorage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

/** Where this device remembers whether the last good read of what is shared
 *  with `viewer` had anything in it: beside the dashboard's snapshot for the
 *  same account (components/device-cache.ts), so signing out forgets it with
 *  the snapshot (components/ForgetDevice.tsx). */
export const sharedSeenKey = (viewer: string) => `${cacheKeyFor(viewer)}:shared`;

/** REMEMBERED ON THIS DEVICE, a viewer's own convenience and never relied
 *  on: whether the last good read had anything shared, so a read that fails
 *  before anything is on screen (offline, say) can say so to someone who
 *  has shares, and to nobody else. Quietly nothing where it can't be kept. */
export function rememberShares(viewer: string | undefined, had: boolean, storage: DeviceStorage | null = deviceStorage()): void {
  if (!viewer || !storage) return;
  try {
    if (had) storage.setItem(sharedSeenKey(viewer), '1');
    else storage.removeItem(sharedSeenKey(viewer));
  } catch {
    // Not kept: a failed read then says nothing, as before anything was.
  }
}

/** LENIENT: whether the last good read on this device had anything shared;
 *  false when it can't say. */
export function rememberedShares(viewer: string | undefined, storage: DeviceStorage | null = deviceStorage()): boolean {
  if (!viewer || !storage) return false;
  try {
    return storage.getItem(sharedSeenKey(viewer)) === '1';
  } catch {
    return false;
  }
}

/** One read of what is shared with me (app/api/shared), as the cards take
 *  it: what came, or else why nothing did (sharedProblem) and whether the
 *  last good read on this device had anything shared (rememberedShares). A
 *  good read is remembered so (rememberShares). Never throws. */
export async function readSharedWithMe(
  viewer: string | undefined,
  get: (url: string) => Promise<Response> = (url) => fetch(url),
  storage: DeviceStorage | null = deviceStorage()
): Promise<{ data: SharedPayload; problem: '' } | { data: null; problem: string; hadShares: boolean }> {
  try {
    const res = await get('/api/shared');
    const body = await res.json().catch(() => null);
    if (res.ok && body) {
      rememberShares(viewer, Array.isArray(body.shared) && body.shared.length > 0, storage);
      return { data: body, problem: '' };
    }
    return { data: null, problem: sharedProblem(res.status, body, res.headers.get('Retry-After')), hadShares: rememberedShares(viewer, storage) };
  } catch {
    return { data: null, problem: sharedProblem(0, null, null), hadShares: rememberedShares(viewer, storage) };
  }
}

/**
 * What others share with me, fetched only once this part of the page is on
 * screen, and again after a refresh if it is (or once it next is): each fetch
 * counts as a showing in the sharer's record, so one is made only when the
 * cards can actually be seen. Scrolling past them again fetches nothing.
 * `viewer`: who is signed in, whose last good read this device remembers.
 */
export function SharedWithMe({ refreshKey, viewer }: { refreshKey?: unknown; viewer?: string }) {
  const [data, setData] = useState<SharedPayload | null>(null);
  // Why the last read was turned away or failed (sharedProblem), or ''.
  const [problem, setProblem] = useState('');
  // Whether the last good read on this device had anything shared, as
  // remembered when a read fails (rememberedShares).
  const [hadShares, setHadShares] = useState(false);
  const [onScreen, setOnScreen] = useState(false);
  // Whether the last good read on this device had anything shared: until
  // this one answers, the section's place is held with its skeleton, so it
  // doesn't appear only once scrolled to. Nothing is held for someone with
  // nothing shared, who would see it come and go. Read after the first
  // render, which the server's must match.
  const [expected, setExpected] = useState(false);
  useEffect(() => setExpected(rememberedShares(viewer)), [viewer]);
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
    void readSharedWithMe(viewer).then((read) => {
      if (read.data) {
        setData(read.data);
        setProblem('');
        return;
      }
      // What is on screen stays: a read turned away (the limit on reads,
      // lib/share-limit.ts) or failing never takes it away, and why it
      // couldn't be refreshed is said, as the preview says it.
      setHadShares(read.hadShares);
      setProblem(read.problem);
    });
  }, [onScreen, refreshKey, viewer]);
  return (
    <div ref={spot} className="incoming-spot">
      {data === null && !problem && expected ? <SharedWithMeSkeleton /> : <SharedWithMeView data={data} problem={problem} hadShares={hadShares} />}
    </div>
  );
}

/** A shared transaction's amount, money out shown as a minus, in its own
 *  currency: nothing is converted (a row with none is in the main one). */
export function sharedTxnAmount(t: { amount: number; currency: string | null }): string {
  return formatMoney(-t.amount, t.currency);
}

/** "Closed Mar 12, 2026": an account that ended, as the one it is shared
 *  with reads it. Untracked is said as theirs to say: they stopped following
 *  it, which is not the same as closing it. */
export function endedText(e: NonNullable<SharedAccount['ended']>): string {
  const day = new Date(`${e.on}T00:00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  if (e.state === 'closed') return `Closed ${day}`;
  if (e.state === 'left') return `No longer theirs since ${day}`;
  return `Not followed since ${day}`;
}

function shownBalance(a: SharedAccount): string {
  if (a.ended) return endedText(a.ended);
  if (a.level === 'exists') return 'Balance not shared';
  if (a.balance === null) return 'No balance yet';
  return `${formatMoney(a.balance, a.currency)}${a.debt ? ' owed' : ''}`;
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
        <SharedAccountItem key={a.id} a={a} open={open === a.id} onToggle={() => setOpen(open === a.id ? null : a.id)} />
      ))}
      {view.views && <SharedViewsList views={view.views} whose={name === 'you' ? 'Your' : `${name}’s`} />}
      {note}
    </div>
  );
}

/** One account on a shared card: its balance, and, when `open`, its
 *  transactions, each figure in its own currency. */
export function SharedAccountItem({ a, open, onToggle }: { a: SharedAccount; open: boolean; onToggle: () => void }) {
  return (
    <div className="incoming-account">
      <div className="peer-row">
        <span>
          <span className="incoming-account-name">{a.label}</span>
          {a.as_of && <span className="incoming-account-date"> · {shortDate(a.as_of)}</span>}
        </span>
        <span className="incoming-account-value">
          <Masked>{shownBalance(a)}</Masked>
        </span>
      </div>
      {a.transactions_unreadable ? (
        <div className="incoming-account-date">Its transactions can&apos;t be read, so they aren&apos;t shown.</div>
      ) : a.transactions && a.transactions.length === 0 ? (
        <div className="incoming-account-date">No transactions in the last {SHARED_TXN_DAYS} days.</div>
      ) : (
        a.transactions && (
          <button className="link-btn" onClick={onToggle}>
            {open ? 'Hide transactions' : `Recent transactions (${a.transactions.length})`}
          </button>
        )
      )}
      {open &&
        a.transactions?.map((t, i) => (
          <div key={i} className="incoming-txn">
            <span>
              {shortDate(t.date)} {shownName(t)}
              {t.pending ? ' (pending)' : ''}
            </span>
            <span>
              <Masked>{sharedTxnAmount(t)}</Masked>
            </span>
          </div>
        ))}
    </div>
  );
}

/** `problem`: why the last read was turned away or failed (sharedProblem),
 *  said above what was last shown, which stays. With nothing on screen,
 *  nothing is said: someone nobody shares with, or one offline, is never
 *  told of shares they don't have. Only when nothing has loaded here yet
 *  (`data` null) and the last good read on this device had something shared
 *  (`hadShares`, rememberedShares) is it said alone. */
export function SharedWithMeView({ data, problem = '', hadShares = false }: { data: SharedPayload | null; problem?: string; hadShares?: boolean }) {
  const [now, setNow] = useState(() => Date.now());
  // Open to start with: what is shared is read only once it is on screen
  // (SharedWithMe), and each read counts as a showing, so it is read when
  // it can be seen, as before. Closing it only folds it away.
  const [open, setOpen] = useState(true);
  // A share that ends while it is on screen goes at its end, without waiting
  // for the next fetch: from then on the server shows nothing of it.
  const next = Math.min(Infinity, ...(data?.shared ?? []).map((s) => (s.expires_at ? Date.parse(s.expires_at) : Infinity)).filter((t) => t > now));
  useEffect(() => {
    if (!Number.isFinite(next)) return;
    const timer = setTimeout(() => setNow(Date.now()), Math.min(Math.max(next - Date.now(), 0), 2 ** 31 - 1) + 10);
    return () => clearTimeout(timer);
  }, [next]);
  const shared = (data?.shared ?? []).filter((s) => !ended(s.expires_at, now));
  if (shared.length === 0) {
    return problem && data === null && hadShares ? <p className="stale-note">{`What is shared with you couldn’t be shown just now. ${problem}`}</p> : null;
  }
  return (
    <section>
      <CollapsibleHeader title="Shared with me" open={open} onToggle={() => setOpen((v) => !v)} controls="shared-with-me" />
      {open && (
        <div id="shared-with-me">
          {problem && <p className="stale-note">{`This is what was last shown: it couldn’t be refreshed. ${problem}`}</p>}
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
        </div>
      )}
    </section>
  );
}
