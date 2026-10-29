'use client';

// "Shared by ...", what others share with me (#45, lib/sharing.ts), on the
// Accounts tab and on the first screen whenever a connection shares
// something: their accounts, read-only, and until when. They are fetched
// only once that part of the page is on screen, since each fetch is counted
// as a showing in the sharer's record (lib/access-log.ts). A fetch turned
// away (the limit on reads) or failing keeps what is shown, and says why it
// couldn't be refreshed. With nothing on screen it says nothing, unless
// nothing has loaded yet and the last good read on this device had something
// shared (rememberShares).
//
// Its own module, apart from Settings > Sharing (components/Sharing.tsx),
// which draws the same card as "What they see" (SharedCard): Home draws this
// part, and Settings' part is loaded when it opens
// (components/SettingsCardsLoader.tsx).
//
// Class names avoid "share": ad blockers' social-share filters hide such
// elements (Fanboy's list has ##.share-row).

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { formatDay, formatMoney } from '@/lib/format';
import { shownName } from '@/lib/merchant-name';
import { SHARED_TXN_DAYS, type Level } from '@/lib/share-rules';
import type { SharedViews } from '@/lib/share-kinds';
import { CollapsibleHeader } from './Collapsible';
import { SharedWithMeSkeleton } from './LoadingSkeletons';
import { Masked } from './HideAmounts';
import { cacheKeyFor } from './device-cache';
import { SharedViewsList } from './SharedViews';
import { shortDate, endLabel, ended } from './SharingDates';

export type SharedAccount = {
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

/** A person's initial, for their avatar. */
export const initial = (label: string) => (label.trim()[0] ?? '?').toUpperCase();

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

/** "Closed Mar 12": an account that ended, as the one it is shared
 *  with reads it. Untracked is said as theirs to say: they stopped following
 *  it, which is not the same as closing it. */
export function endedText(e: NonNullable<SharedAccount['ended']>): string {
  const day = formatDay(e.on, { sentence: true });
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
export function SharedCard({ name, view, note }: { name: string; view: SharedView; note: ReactNode }) {
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
              {shortDate(t.date, undefined, true)} {shownName(t)}
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
