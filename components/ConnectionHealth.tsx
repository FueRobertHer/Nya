'use client';

// The connection health view (#51): every linked institution in one place,
// with its state, when it last synced (as a date), whose side a problem is on,
// which accounts it affects, how much of net worth is shown from last known
// balances rather than measured, and the one thing to do about it. Its own
// card on the Accounts tab, collapsed while every connection works, open when
// one doesn't, and opened by the link in a notice email (?view=connections).
//
// Also the "Reconnect soon" note an institution's card carries while Plaid
// says its connection will end on a date (ReconnectSoonNote).
//
// And the questions about an institution's accounts (#50,
// lib/lifecycle-questions.ts): an account missing from its answer, held at
// its last known balance until the person says whether it closed, one at
// zero for weeks, and one that ended but that its bank still returns moving
// (`ended_reported`). The dashboard draws them (`questions`), the same as on
// the institution's own card, a hidden account's too (its absence holds every
// total all the same); a connection with one needs attention.
//
// The accounts SimpleFIN feeds are rows here too, with SimpleFIN's own words
// and its own actions (lib/connectors/health.ts): fix it at SimpleFIN and
// refresh, connect again with a new Setup Token, or choose accounts.
//
// Everything here reads the `health` the server attached to each institution
// (lib/connection-state.ts); a payload from before it existed has none, and
// the view says nothing about such an institution rather than guess.

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { ConnectionHealth as Health, HealthState } from '@/lib/connection-state';
import { formatMoney, dominantCurrency, hideAmountsIn } from '@/lib/format';
import { signedContribution } from '@/lib/balance';
import { instantDay } from '@/lib/local-date';
import { joinNames } from '@/lib/month-coverage';
import { connectorBadge, connectorHealthText, connectorSideText, connectorSite } from '@/lib/connectors/health';
import type { ConnectorAsk } from './Connectors';
import { Masked } from './HideAmounts';

/** What the view needs of an institution, as /api/net-worth sends it. */
export type HealthInstitution = {
  institution_name: string;
  item_id: string;
  manual?: boolean;
  /** Accounts a connector the person brought feeds (SimpleFIN): `manual`
   *  too, but with a connection whose health this view shows. */
  connector?: string;
  connection_id?: string;
  error: string | null;
  accounts: {
    account_id?: string;
    name: string;
    mask: string | null;
    type: string;
    balance: number | null;
    currency: string | null;
    hidden?: boolean;
    stale?: boolean;
    /** Held at its last known balance while a question about it is open
     *  (lib/lifecycle-questions.ts). */
    held?: { as_of: string | null; too_old?: string };
    question?: { kind: 'missing' | 'zero' | 'reported'; still_open?: true; again?: true };
  }[];
  /** Accounts that ended that its bank still returns, moved since: asked
   *  about, and counted in nothing (lib/lifecycle-questions.ts). */
  ended_reported?: { question?: { kind: string } }[];
  health?: Health;
  stale_as_of?: string;
  stale_as_of_at?: string;
  stale_too_old?: string;
  stale_too_old_at?: string;
  unconfirmed_missing?: number;
  unshown_accounts?: { account_id?: string; name: string; mask: string | null }[];
};

const BADGES: Record<HealthState, string> = {
  healthy: 'Working',
  reconnect_soon: 'Reconnect soon',
  needs_reauth: 'Needs reconnecting',
  outage: 'Not updating',
  relink: 'Needs connecting again',
  closed: 'No open accounts',
  partial: 'Missing accounts',
};

/** How loudly each state is drawn: red where only the person can fix it now,
 *  amber where it is coming or clears on its own. */
const TONES: Record<HealthState, 'up' | 'warn' | 'down'> = {
  healthy: 'up',
  reconnect_soon: 'warn',
  needs_reauth: 'down',
  outage: 'warn',
  relink: 'down',
  closed: 'down',
  partial: 'warn',
};

/** Worst first, so what needs the person tops the list. */
const ORDER: HealthState[] = ['needs_reauth', 'relink', 'closed', 'reconnect_soon', 'outage', 'partial', 'healthy'];

/** Whether the end Plaid warned of has already come (on a connection that
 *  still answered, or in a payload made before it). */
const endPassed = (h: Health, now: number) => !!h.ends_at && Date.parse(h.ends_at) <= now;

export function badgeOf(h: Health, now: number = Date.now()): string {
  if (h.cause === 'unsupported') return "Can't be repaired";
  if (h.state === 'reconnect_soon' && endPassed(h, now)) return 'Reconnect now';
  return BADGES[h.state] ?? BADGES.outage;
}

const localDay = (iso: string) => instantDay(iso) ?? iso.slice(0, 10);
/** "Sep 12" from a YYYY-MM-DD, read at local midnight, as the cards read dates. */
const calendarDay = (date: string) => new Date(`${date}T00:00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
/** A stored snapshot's day, in the viewer's own time when its instant is known
 *  and belongs to that UTC day (as fmtStaleDay in components/Dashboard.tsx). */
const snapshotDay = (date: string, at?: string) => (at && at.slice(0, 10) === date ? localDay(at) : calendarDay(date));

/** The day a connection ends, as the badge and the note say it. */
export function endsText(h: Health, now: number = Date.now()): string {
  if (!h.ends_at) return 'Plaid says this connection will end soon';
  const day = localDay(h.ends_at);
  if (endPassed(h, now)) return `Plaid said this connection would end ${h.ends_estimated ? 'around' : 'on'} ${day}`;
  return `Plaid says this connection ends ${h.ends_estimated ? 'around' : 'on'} ${day}`;
}

/** What to do about an end Plaid warned of: before it, or now that it has come. */
export function reconnectText(h: Health, now: number = Date.now()): string {
  return endPassed(h, now) ? 'Reconnect now to keep it syncing' : 'Reconnect before then to keep it syncing';
}

/** What is wrong and what to do, in a sentence or two. */
export function healthText(name: string, h: Health, inst: Pick<HealthInstitution, 'unconfirmed_missing'> & Partial<Pick<HealthInstitution, 'accounts'>>, now: number = Date.now()): string | null {
  const again = `connect ${name} again: link its new accounts to the old ones and their history carries over`;
  switch (h.cause) {
    case 'ok':
      return null;
    case 'consent_ending':
    case 'disconnect_pending':
      return `${endsText(h, now)}. ${reconnectText(h, now)}: it takes a minute.`;
    case 'login':
      return `${name} needs you to sign in again. Reconnect: it takes a minute.`;
    case 'access':
      return `${name} isn't sharing everything Nya needs. Reconnect and allow access to your accounts.`;
    case 'locked':
      return `${name} has locked this sign-in. Unlock it with ${name}, then reconnect.`;
    case 'bank_action':
      return `${name} needs something done on its own website first, such as a new password or terms to accept. Then reconnect.`;
    case 'institution_down':
      return `${name} isn't answering. Nothing to do: it usually recovers on its own.`;
    case 'provider':
      return `Plaid, which Nya reaches ${name} through, is having trouble. Nothing to do: it usually recovers on its own.`;
    case 'unreachable':
      return `Nya couldn't get an answer. Nothing to do: it usually recovers on its own.`;
    // On Nya's side: nothing for the person to do, and never removal, which
    // would lose the connection's stored transactions for nothing.
    case 'credentials':
      return `Nya can't read the sign-in it keeps for ${name}. Nothing for you to do: whoever runs Nya restores its encryption keys, and the connection then works as before.`;
    case 'token':
      return `Plaid doesn't accept the access Nya keeps for ${name}, which usually means Nya's own Plaid settings changed. Nothing for you to do: whoever runs Nya puts them back, and the connection then works as before.`;
    case 'setup':
      return `Plaid refused Nya's own settings, so it can't reach ${name} just now. Nothing for you to do: whoever runs Nya puts them right, and the connection then works as before.`;
    case 'revoked':
      return `Access to ${name} was withdrawn, so this connection can't be repaired. Remove it, then ${again}.`;
    case 'gone':
      return `Plaid no longer has this connection, so it can't be repaired. Remove it, then ${again}.`;
    case 'unsupported':
      return `Plaid can no longer reach ${name}, so reconnecting won't help. Remove the connection; its history is kept, and its accounts can be tracked by hand.`;
    case 'no_accounts':
      return `${name} reports no open accounts. If you closed them, remove the connection: their history is kept.`;
    case 'vanished': {
      const n = inst.unconfirmed_missing ?? 0;
      const one = n === 1;
      // Every one held is one the person said is still open: they have
      // answered, so say what that holds, and for how long.
      const held = (inst.accounts ?? []).filter((a) => a.held);
      if (held.length > 0 && held.every((a) => a.question?.still_open)) {
        return `You said ${one ? 'the account' : `the ${n} accounts`} ${name} stopped reporting ${one ? 'is' : 'are'} still open. Until ${one ? 'it comes' : 'they come'} back, ${one ? 'it is' : 'they are'} counted at ${one ? 'its' : 'their'} last known balance and no total is saved, for two weeks from your answer at most; then Nya asks again. Reconnecting may bring ${one ? 'it' : 'them'} back.`;
      }
      return `${n} account${one ? '' : 's'} ${name} used to report ${one ? "isn't" : "aren't"} in its latest answer. Until you say whether ${one ? 'it' : 'they'} closed, ${one ? 'it is' : 'they are'} counted at ${one ? 'its' : 'their'} last known balance and no total is saved. If nobody answers, Nya assumes ${one ? 'it' : 'them'} closed after three days, and you can say otherwise. Removed ${one ? 'it' : 'them'} on purpose? Check with Add or remove accounts.`;
    }
    default:
      return `${name} couldn't be updated${h.code ? ` (Plaid: ${h.code})` : ''}. This usually clears on its own.`;
  }
}

/** Whose side the problem is on: the support question to answer first. */
export function sideText(name: string, h: Health): string | null {
  switch (h.side) {
    case 'you':
      return `On your side: your sign-in at ${name}`;
    case 'bank':
      return `On ${name}'s side`;
    case 'plaid':
      return "On Plaid's side";
    case 'nya':
      return "On Nya's side";
    case 'unknown':
      return 'Whose side: not known';
    default:
      return null;
  }
}

const label = (a: { name: string; mask: string | null }) => (a.mask ? `${a.name} ••${a.mask}` : a.name);

type Row = HealthInstitution['accounts'][number];

/** ", together $3,800 of net worth", unless several currencies would be added. */
function together(rows: Row[], money: (n: number, currency: string | null) => string): string {
  const currencies = new Set(rows.map((a) => a.currency).filter(Boolean));
  if (currencies.size > 1) return '';
  const sum = rows.reduce((n, a) => n + signedContribution(a.type, a.balance ?? 0), 0);
  return `, together ${money(sum, dominantCurrency(rows.map((a) => ({ iso_currency_code: a.currency }))))} of net worth`;
}

/**
 * Which accounts a problem affects, and how much of net worth is shown from
 * last known balances rather than measured now, labeled as such. Hidden
 * accounts are left out, as they are of every total.
 */
export function affectedText(inst: HealthInstitution, money: (n: number, currency: string | null) => string = formatMoney): string[] {
  const h = inst.health;
  if (!h) return [];
  const lines: string[] = [];
  if (h.state === 'partial') {
    // Held at their last known balances (lib/lifecycle-questions.ts), or not
    // counted when none is recent enough; a payload from before holds says
    // only how many.
    const held = inst.accounts.filter((a) => a.held && !a.hidden);
    const counted = held.filter((a) => a.balance != null);
    const uncounted = held.filter((a) => a.balance == null);
    if (counted.length > 0) {
      const days = new Set(counted.map((a) => a.held?.as_of));
      const first = counted[0].held?.as_of;
      const day = days.size === 1 && first ? ` from ${calendarDay(first)}` : '';
      lines.push(`Shown at last known balances${day}, not measured now: ${joinNames(counted.map(label))}${together(counted, money)}.`);
    }
    if (uncounted.length > 0) lines.push(`Not counted in net worth: ${joinNames(uncounted.map(label))}.`);
    if (held.length === 0) {
      const n = inst.unconfirmed_missing ?? 0;
      lines.push(`${n} account${n === 1 ? '' : 's'} not in the total.`);
    }
    return lines;
  }
  if (!inst.error) return lines;
  const recovered = inst.accounts.filter((a) => a.stale && !a.hidden && a.balance != null);
  if (recovered.length > 0) {
    const day = inst.stale_as_of ? ` from ${snapshotDay(inst.stale_as_of, inst.stale_as_of_at)}` : '';
    lines.push(`Shown at last known balances${day}, not measured now: ${joinNames(recovered.map(label))}${together(recovered, money)}.`);
  }
  const unshown = inst.unshown_accounts ?? [];
  if (unshown.length > 0) {
    lines.push(`Not counted in net worth: ${joinNames(unshown.map(label))}.`);
  } else if (recovered.length === 0) {
    lines.push('Not counted in net worth.');
  }
  if (inst.stale_too_old) {
    lines.push(`Its last known balances are from ${snapshotDay(inst.stale_too_old, inst.stale_too_old_at)}, too old to count.`);
  }
  return lines;
}

/** "Last synced Oct 6", or that it was never recorded. */
export function lastSyncedText(h: Health): string {
  return h.last_ok_at ? `Last synced ${localDay(h.last_ok_at)}` : 'Last synced: not recorded yet';
}

export default function ConnectionHealth({
  institutions,
  unavailable = false,
  connecting,
  focus = false,
  onFocused,
  onReconnect,
  onRemove,
  onManageAccounts,
  questions,
  onConnector,
}: {
  institutions: HealthInstitution[];
  /** The server could not read Plaid's warnings or the sync times. */
  unavailable?: boolean;
  connecting: boolean;
  /** Opened from a notice email's link: show it, and scroll to it. */
  focus?: boolean;
  /** Called once it has been shown for `focus`, so coming back to the tab
   *  later doesn't scroll to it again. */
  onFocused?: () => void;
  onReconnect: (item_id: string) => void;
  onRemove: (item_id: string) => void;
  onManageAccounts: (item_id: string) => void;
  /** The questions about an institution's accounts, drawn as on its card. */
  questions?: (inst: HealthInstitution) => ReactNode;
  /** What a SimpleFIN row's button asks (components/Connectors.tsx). */
  onConnector?: (ask: ConnectorAsk) => void;
}) {
  const rows = useMemo(
    () =>
      institutions
        .filter((i): i is HealthInstitution & { health: Health } => (!i.manual || !!i.connector) && !!i.health)
        .sort((a, b) => ORDER.indexOf(a.health.state) - ORDER.indexOf(b.health.state) || a.institution_name.localeCompare(b.institution_name)),
    [institutions]
  );
  const troubled = rows.filter(needsAttention).length;
  const [open, setOpen] = useState(troubled > 0 || focus);
  const ref = useRef<HTMLDivElement>(null);
  // Open when something goes wrong, or the email's link asks; the person's own
  // toggle otherwise stands.
  useEffect(() => {
    if (troubled > 0 || focus) setOpen(true);
  }, [troubled, focus]);
  // Once there is a card to show (the institutions may still be loading).
  const shown = rows.length > 0;
  useEffect(() => {
    if (!focus || !shown || !ref.current) return;
    ref.current.scrollIntoView({ block: 'start' });
    onFocused?.();
  }, [focus, shown, onFocused]);

  if (!shown) return null;
  return (
    <ConnectionHealthView
      ref={ref}
      rows={rows}
      open={open}
      onToggle={() => setOpen((o) => !o)}
      unavailable={unavailable}
      connecting={connecting}
      onReconnect={onReconnect}
      onRemove={onRemove}
      onManageAccounts={onManageAccounts}
      questions={questions}
      onConnector={onConnector}
    />
  );
}

/** A connection that isn't working, or has a question about an account,
 *  a hidden one's included: its absence holds every total all the same. */
export const needsAttention = (r: HealthInstitution & { health: Health }) =>
  r.health.state !== 'healthy' || r.accounts.some((a) => !!a.question) || (r.ended_reported ?? []).some((a) => !!a.question);

/** The card itself, from rows already sorted: for tests, and the wrapper above. */
export function ConnectionHealthView({
  ref,
  rows,
  open,
  onToggle,
  unavailable,
  connecting,
  onReconnect,
  onRemove,
  onManageAccounts,
  questions,
  onConnector,
  now = Date.now(),
}: {
  ref?: React.Ref<HTMLDivElement>;
  rows: (HealthInstitution & { health: Health })[];
  open: boolean;
  onToggle: () => void;
  unavailable: boolean;
  connecting: boolean;
  onReconnect: (item_id: string) => void;
  onRemove: (item_id: string) => void;
  onManageAccounts: (item_id: string) => void;
  questions?: (inst: HealthInstitution) => ReactNode;
  onConnector?: (ask: ConnectorAsk) => void;
  now?: number;
}) {
  const troubled = rows.filter(needsAttention).length;
  const unread = rows.filter((r) => r.health.unread).length;
  const summary =
    troubled === 0
      ? rows.length === 1
        ? 'Working'
        : `All ${rows.length} working`
      : `${troubled} of ${rows.length} need${troubled === 1 ? 's' : ''} attention`;
  return (
    <div className="card health-card" id="connection-health" ref={ref}>
      <button className="holdings-toggle" onClick={onToggle} aria-expanded={open}>
        <span className="holdings-title">Connection health</span>
        <span className="holdings-summary">
          <span className={troubled > 0 ? 'health-attention' : undefined}>{summary}</span>
          <svg className={`chevron${open ? ' open' : ''}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="m6 9 6 6 6-6" />
          </svg>
        </span>
      </button>
      {/* Shown open or closed: a closed card that says "All working" is
          exactly where a connection about to end would go unseen. */}
      {unavailable ? (
        <p className="stale-note">
          Plaid&apos;s warnings and the last sync times couldn&apos;t be read just now, so a connection that is about to end may not say so here.
        </p>
      ) : (
        unread > 0 && (
          <p className="stale-note">
            {`Some of what Nya keeps about ${unread === 1 ? 'one connection' : `${unread} connections`} couldn't be read, so a warning that one is about to end may be missing here.`}
          </p>
        )
      )}
      {open && (
        <>
          <ul className="health-list">
            {rows.map((inst) => {
              const h = inst.health;
              const name = inst.institution_name;
              // A connector's row speaks for it, in its own words.
              const fed = h.cause === 'connector' && !!h.detail;
              const text = fed ? connectorHealthText(name, h) : healthText(name, h, inst, now);
              const side = h.state === 'healthy' ? null : fed ? connectorSideText(name, h) : sideText(name, h);
              return (
                <li key={inst.item_id} className="health-row">
                  <div className="health-head">
                    <span className="inst-name">
                      {name}
                      {fed && <span className="manual-badge">via {h.detail!.label}</span>}
                    </span>
                    <span className={`health-badge health-${TONES[h.state] ?? 'warn'}`}>{fed ? connectorBadge(h) : badgeOf(h, now)}</span>
                  </div>
                  {/* A connector's own words can name a balance (a card reported as money held). */}
                  {text && (
                    <p className="health-text">
                      <Masked>{hideAmountsIn(text)}</Masked>
                    </p>
                  )}
                  {h.unread && (
                    <p className="health-text health-affected">Some of what Nya keeps about this connection couldn&apos;t be read, so a warning from Plaid may be missing here.</p>
                  )}
                  {affectedText(inst).map((line) => (
                    <p className="health-text health-affected" key={line}>
                      <Masked>{line}</Masked>
                    </p>
                  ))}
                  {questions?.(inst)}
                  <div className="health-meta">
                    {lastSyncedText(h)}
                    {side ? ` · ${side}` : ''}
                    {h.code ? ` · Plaid code ${h.code}` : ''}
                  </div>
                  {fed ? (
                    <ConnectorAction inst={inst} onConnector={onConnector} />
                  ) : (
                    <HealthAction inst={inst} connecting={connecting} onReconnect={onReconnect} onRemove={onRemove} onManageAccounts={onManageAccounts} />
                  )}
                </li>
              );
            })}
          </ul>
        </>
      )}
    </div>
  );
}

/** What a SimpleFIN row offers: fixing it at SimpleFIN, then a Refresh;
 *  connecting again with a new Setup Token; choosing accounts; saying how to
 *  read a card's or a loan's balance; a Refresh. */
function ConnectorAction({ inst, onConnector }: { inst: HealthInstitution & { health: Health }; onConnector?: (ask: ConnectorAsk) => void }) {
  const d = inst.health.detail;
  const id = d?.connection_id;
  if (!d || !id || !onConnector) return null;
  const site = connectorSite(d);
  switch (d.issue) {
    case 'refused':
    case 'credentials':
      return (
        <div className="card-actions">
          <button onClick={() => onConnector({ kind: 'token', connection_id: id })}>Connect again</button>
        </div>
      );
    case 'missing':
      return (
        <div className="card-actions">
          <button className="secondary" onClick={() => onConnector({ kind: 'accounts', connection_id: id })}>
            Choose accounts
          </button>
        </div>
      );
    case 'sign':
      return (
        <div className="card-actions">
          <button onClick={() => onConnector({ kind: 'sign', connection_id: id })}>Answer</button>
        </div>
      );
    case 'gone':
      return (
        <div className="card-actions">
          <button className="secondary" onClick={() => onConnector({ kind: 'disconnect', connection_id: id })}>
            Disconnect
          </button>
        </div>
      );
    case 'reported':
    case 'old_balance':
    case 'payment':
    case 'down':
    case 'answer':
    case 'blocked':
    case 'stale':
    case 'waiting':
      return (
        <div className="card-actions">
          {(d.issue === 'reported' || d.issue === 'old_balance' || d.issue === 'payment') && site && (
            <a className="connector-site" href={site} target="_blank" rel="noreferrer">
              Open {d.label}
            </a>
          )}
          <button className="secondary" onClick={() => onConnector({ kind: 'refresh', connection_id: id })}>
            Refresh
          </button>
        </div>
      );
    default:
      return null;
  }
}

/** The one button a state offers, if any. */
function HealthAction({
  inst,
  connecting,
  onReconnect,
  onRemove,
  onManageAccounts,
}: {
  inst: HealthInstitution & { health: Health };
  connecting: boolean;
  onReconnect: (item_id: string) => void;
  onRemove: (item_id: string) => void;
  onManageAccounts: (item_id: string) => void;
}) {
  const { action, cause } = inst.health;
  if (action === 'reconnect') {
    return (
      <div className="card-actions">
        <button onClick={() => onReconnect(inst.item_id)} disabled={connecting} aria-label={`Reconnect ${inst.institution_name}`}>
          Reconnect
        </button>
      </div>
    );
  }
  if (action === 'relink' || action === 'remove' || (action === 'resolve' && cause === 'no_accounts')) {
    return (
      <div className="card-actions">
        <button className="secondary" onClick={() => onRemove(inst.item_id)}>
          Remove {inst.institution_name}
        </button>
      </div>
    );
  }
  if (action === 'resolve') {
    return (
      <div className="card-actions">
        <button className="secondary" onClick={() => onManageAccounts(inst.item_id)} disabled={connecting}>
          Add or remove accounts
        </button>
      </div>
    );
  }
  return null;
}

/**
 * On an institution's own card while Plaid says its connection will end: the
 * badge, the date, and a Reconnect button, which goes through update mode and
 * keeps the connection and its history.
 */
export function ReconnectSoonNote({
  inst,
  connecting,
  onReconnect,
  now = Date.now(),
}: {
  inst: Pick<HealthInstitution, 'item_id' | 'institution_name' | 'health' | 'manual'>;
  connecting: boolean;
  onReconnect: (item_id: string) => void;
  now?: number;
}) {
  const h = inst.health;
  if (inst.manual || !h || h.state !== 'reconnect_soon') return null;
  // Once the day has passed the note says which it was; the badge says what to do.
  const by = h.ends_at && !endPassed(h, now) ? ` · ${h.ends_estimated ? 'about ' : ''}${localDay(h.ends_at)}` : '';
  return (
    <div className="reconnect-soon">
      <span className="health-badge health-warn">{`${badgeOf(h, now)}${by}`}</span>
      <p className="stale-note">{`${endsText(h, now)}. ${reconnectText(h, now)}.`}</p>
      <div className="card-actions">
        <button onClick={() => onReconnect(inst.item_id)} disabled={connecting} aria-label={`Reconnect ${inst.institution_name}`}>
          Reconnect
        </button>
      </div>
    </div>
  );
}
