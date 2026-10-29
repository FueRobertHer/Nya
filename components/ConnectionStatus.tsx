'use client';

// What a connection says on its institution's card (rollout phase 3b), where
// the Connection health card and the SimpleFIN and Lunch Flow cards used to
// say it: what is wrong and what it does to the total, in one notice whose
// color comes from lib/accounts-status.ts, then when it last synced and whose
// side a problem is on, the questions about its accounts, and the buttons
// that fix it, each once. The words are the ones those cards used
// (test/connection-words.test.tsx holds them to it).
//
// What repeats the card's own line goes behind "Why?": Plaid's explanation of
// a connection that ends soon or of accounts missing from its answer, and the
// SimpleFIN or Lunch Flow card's own lines about what its last answer brought.
// A connection's lines that cover all its banks are on its first card; a
// carried account's are on the card that holds it.

import { Fragment, type ReactNode } from 'react';
import { AccountQuestions, type useAccountLifecycle } from './AccountLifecycle';
import { Masked } from './HideAmounts';
import { Why } from './Why';
import { affectedText, badgeOf, endsText, healthText, lastSyncedText, reconnectText, sideText } from './ConnectionHealth';
import { carriedLine, retryLine, type ConnectorAsk } from './Connectors';
import { connectorBadge, connectorHealthText, connectorSideText, connectorSite } from '@/lib/connectors/health';
import { formatMoney, hideAmountsIn } from '@/lib/format';
import { instantDay } from '@/lib/local-date';
import type { PageFx } from '@/lib/fx/view';
import type { ConnectionView } from '@/lib/connectors/view';
import { severityOf, type Severity } from '@/lib/accounts-status';
import { fmtStaleDay, type Account, type Institution } from './accounts-format';

/** A critical notice's icon: never color alone. */
export const ALERT = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M12 9v4M12 17h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" />
  </svg>
);

/** A caution notice's icon, the clock Needs attention's rows use: in light,
 *  red and amber are too close to tell apart by color, so the shape does. */
export const CAUTION = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M12 7v5l3 2M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0z" />
  </svg>
);

/** What a screen reader says first, for what a notice's color and icon
 *  show: its level, visually hidden (design-system.md, Status and honesty). */
export function LevelWord({ level }: { level: Severity | 'info' | 'done' }) {
  return <span className="visually-hidden">{level === 'critical' ? 'Critical: ' : level === 'caution' ? 'Caution: ' : level === 'done' ? 'Done: ' : 'Note: '}</span>;
}

/** The icon for a notice whose level is decided at run time. */
export function levelIcon(level: Severity): ReactNode {
  return level === 'critical' ? ALERT : CAUTION;
}

const names = (list: string[]) => (list.length <= 1 ? list.join('') : `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}`);
const localDay = (iso: string) => instantDay(iso) ?? iso.slice(0, 10);

/** The connection a connector's card belongs to, and whether this card is its
 *  first (where the lines about all its banks go). */
export type ConnectionPlace = { conn: ConnectionView | null; first: boolean; firstName: string | null };

/** What the connection's own record says beyond its health: a note on its
 *  last answer (on its first card), and a carried account's line (on the
 *  card that holds it). */
function extras(inst: Institution, place: ConnectionPlace | null) {
  const conn = place?.conn ?? null;
  const note = conn && place?.first ? (conn.last_fetch?.note ?? null) : null;
  const ids = new Set(inst.accounts.map((a) => a.account_id));
  const carried = (conn?.accounts ?? []).flatMap((a) => {
    const line = ids.has(a.account_id) ? carriedLine(a, conn!.label) : null;
    return line ? [{ account_id: a.account_id, name: a.name, ...line }] : [];
  });
  return { note, carried };
}

/** The one color of an institution's card, from its health and what its
 *  connection's own record says (lib/accounts-status.ts). */
export function connectionSeverity(inst: Institution, place: ConnectionPlace | null = null): Severity | null {
  const { note, carried } = extras(inst, place);
  return severityOf(inst, !!note || carried.some((c) => c.warn));
}

/** The badge that names what is wrong, as Connection health named it, or
 *  null when nothing is. A connection that ends soon carries its day. */
export function statusBadge(inst: Institution, now: number = Date.now()): string | null {
  const h = inst.health;
  if (!h || h.state === 'healthy') return null;
  if (h.cause === 'connector') return h.detail ? connectorBadge(h) : null;
  if (inst.manual) return null;
  const passed = !!h.ends_at && Date.parse(h.ends_at) <= now;
  const by = h.state === 'reconnect_soon' && h.ends_at && !passed ? ` · ${h.ends_estimated ? 'about ' : ''}${localDay(h.ends_at)}` : '';
  return `${badgeOf(h, now)}${by}`;
}

/** The card's own line about a failed fetch, as it always read. */
function errorLine(inst: Institution): string | null {
  if (!inst.error) return null;
  const n = inst.stale_missing ?? 0;
  return [
    inst.error,
    inst.stale_as_of ? ` · balances as of ${fmtStaleDay(inst.stale_as_of, inst.stale_as_of_at)}` : '',
    n ? ` · ${n} account${n === 1 ? '' : 's'} couldn't be shown, so this total is incomplete` : '',
    inst.stale_too_old ? ` · last known balances are from ${fmtStaleDay(inst.stale_too_old, inst.stale_too_old_at)}, too old to show` : '',
  ].join('');
}

/** Accounts missing from an answer that otherwise came, held until said. */
function missingLine(inst: Institution, allRows: Account[]): string | null {
  const n = inst.unconfirmed_missing ?? 0;
  if (!n || inst.error) return null;
  const one = n === 1;
  const held = allRows.filter((a) => a.held);
  const stillOpen = held.length > 0 && held.every((a) => a.question?.still_open);
  return (
    `${n} account${one ? '' : 's'} this institution used to report ${one ? "isn't" : "aren't"} in its latest response · ` +
    `${one ? 'it is' : 'they are'} held at ${one ? 'its' : 'their'} last known balance` +
    (stillOpen
      ? ` until ${one ? 'it comes' : 'they come'} back, two weeks from your answer at most, and history is paused until then`
      : ` until you say whether ${one ? 'it' : 'they'} closed, and history is paused until then`)
  );
}

export type ConnectionStatusProps = {
  inst: Institution;
  /** Every row, hidden ones too, for the questions about them. */
  allRows: Account[];
  place: ConnectionPlace | null;
  fx: PageFx | null;
  connecting: boolean;
  unallowed: boolean;
  lifecycle: Pick<ReturnType<typeof useAccountLifecycle>, 'busy' | 'open' | 'stillOpen' | 'confirmEnd' | 'reopen'>;
  onReconnect: (item_id: string) => void;
  onRemove: (item_id: string) => void;
  onManageAccounts: (item_id: string) => void;
  onAllowTransactions: (item_id: string) => void;
  onConnector: (ask: ConnectorAsk) => void;
  now?: number;
};

export function ConnectionStatus({
  inst,
  allRows,
  place,
  fx,
  connecting,
  unallowed,
  lifecycle,
  onReconnect,
  onRemove,
  onManageAccounts,
  onAllowTransactions,
  onConnector,
  now = Date.now(),
}: ConnectionStatusProps) {
  const h = inst.health;
  const name = inst.institution_name;
  const fed = h?.cause === 'connector' && !!h.detail;
  const d = fed ? h!.detail! : null;
  const conn = place?.conn ?? null;
  const { note, carried } = extras(inst, place);
  const severity = connectionSeverity(inst, place);

  // What is wrong, in the words the cards used.
  const soon = !!h && !inst.manual && h.state === 'reconnect_soon';
  const explained = !h ? null : fed ? connectorHealthText(name, h) : healthText(name, h, inst, now);
  // Said already by the card's own line: behind "Why?".
  const explainedBehind = !fed && !!h && (soon || h.cause === 'vanished');
  const lines: ReactNode[] = [];
  const own = errorLine(inst);
  if (own) lines.push(own);
  const missing = missingLine(inst, allRows);
  if (missing) lines.push(missing);
  if (soon) lines.push(`${endsText(h!, now)}. ${reconnectText(h!, now)}.`);
  // A connector's own words can name a balance (a card reported as money held).
  if (explained && !explainedBehind) lines.push(<Masked>{hideAmountsIn(explained)}</Masked>);
  if (h?.unread) lines.push("Some of what Nya keeps about this connection couldn't be read, so a warning from Plaid may be missing here.");
  for (const line of affectedText(inst, formatMoney, fx)) lines.push(<Masked>{line}</Masked>);
  if (note) lines.push(note);

  // What the SimpleFIN or Lunch Flow card said of its last answer, on the
  // connection's first card.
  const behind: ReactNode[] = [];
  if (explained && explainedBehind) behind.push(<Masked>{hideAmountsIn(explained)}</Masked>);
  const f = conn?.last_fetch ?? null;
  const unsure = (conn?.accounts ?? []).filter((a) => a.needs_sign);
  if (conn && place?.first) {
    if (f && !f.ok && f.message) behind.push(f.message);
    for (const p of f?.problems ?? []) {
      behind.push(p.retry ? retryLine(p.message) : `${conn.label} reports: “${p.message}”${p.accounts ? ` (${p.accounts.join(', ')})` : ''}`);
    }
    if (f && f.missing.length > 0) behind.push(`Not in ${conn.label}’s latest answer: ${f.missing.join(', ')}.`);
    if (unsure.length > 0) {
      behind.push(
        <>
          {conn.label} reports <Masked>{names(unsure.map((a) => `${a.name} (+${formatMoney(a.reported ?? 0, a.currency)})`))}</Masked> as money held. Say which way{' '}
          {unsure.length === 1 ? 'it goes: until you do, it isn’t' : 'they go: until you do, they aren’t'} counted.
        </>
      );
    }
  }
  const connSaid = !!f && (!f.ok || f.problems.length > 0 || f.missing.length > 0 || !!f.note) || unsure.length > 0;

  // The buttons that fix it, each once.
  const actions = new Map<string, ReactNode>();
  const add = (key: string, node: ReactNode) => {
    if (!actions.has(key)) actions.set(key, node);
  };
  if (!fed && !inst.manual) {
    if (h?.action === 'reconnect' || (inst.needs_reauth && !!inst.error)) {
      add(
        'reconnect',
        <button className="btn" onClick={() => onReconnect(inst.item_id)} disabled={connecting} aria-label={`Reconnect ${name}`}>
          Reconnect
        </button>
      );
    }
    if (h && (h.action === 'relink' || h.action === 'remove' || (h.action === 'resolve' && h.cause === 'no_accounts'))) {
      add(
        'remove',
        <button className="btn secondary" onClick={() => onRemove(inst.item_id)}>
          Disconnect {name}
        </button>
      );
    }
    // Adds accounts to THIS Item rather than connecting the institution
    // again (a second, separately billed Item).
    if (inst.new_accounts_available) {
      add(
        'manage',
        <button className="btn secondary" onClick={() => onManageAccounts(inst.item_id)} disabled={connecting}>
          Review accounts
        </button>
      );
    } else if (h?.action === 'resolve' && h.cause !== 'no_accounts') {
      add(
        'manage',
        <button className="btn secondary" onClick={() => onManageAccounts(inst.item_id)} disabled={connecting}>
          Add or remove accounts
        </button>
      );
    }
  }
  if (unallowed) {
    add(
      'allow',
      <button className="btn secondary" onClick={() => onAllowTransactions(inst.item_id)} disabled={connecting} aria-label={`Allow transactions from ${name}`}>
        Allow transactions
      </button>
    );
  }
  if (d?.connection_id) {
    const id = d.connection_id;
    const site = connectorSite(d);
    switch (d.issue) {
      case 'refused':
      case 'credentials':
        add('token', <button className="btn" onClick={() => onConnector({ kind: 'token', connection_id: id, connector: d.connector })}>Connect again</button>);
        break;
      case 'missing':
        add('accounts', <button className="btn secondary" onClick={() => onConnector({ kind: 'accounts', connection_id: id })}>Choose accounts</button>);
        break;
      case 'sign':
        add('sign', <button className="btn" onClick={() => onConnector({ kind: 'sign', connection_id: id })}>Answer</button>);
        break;
      case 'gone':
        add('disconnect', <button className="btn secondary" onClick={() => onConnector({ kind: 'disconnect', connection_id: id })}>Disconnect</button>);
        break;
      case 'reported':
      case 'old_balance':
      case 'payment':
      case 'down':
      case 'answer':
      case 'blocked':
      case 'stale':
      case 'waiting':
        if ((d.issue === 'reported' || d.issue === 'old_balance' || d.issue === 'payment') && site) {
          add(
            'site',
            <a className="btn secondary" href={site} target="_blank" rel="noreferrer">
              Open {d.label}
            </a>
          );
        }
        add('refresh', <button className="btn secondary" onClick={() => onConnector({ kind: 'refresh', connection_id: id })}>Refresh</button>);
        break;
    }
  }

  const side = !h || h.state === 'healthy' ? null : fed ? connectorSideText(name, h) : sideText(name, h);
  return (
    <>
      {severity && (lines.length > 0 || behind.length > 0) && (
        <div className={`notice ${severity}`}>
          {levelIcon(severity)}
          <div className="stack tight">
            <LevelWord level={severity} />
            {lines.map((line, i) => (
              <p key={i}>{line}</p>
            ))}
            {behind.length > 0 && (
              <Why>
                <div className="stack tight">
                  {behind.map((line, i) => (
                    <p key={i}>{line}</p>
                  ))}
                </div>
              </Why>
            )}
          </div>
        </div>
      )}
      {conn && !place?.first && connSaid && place?.firstName && <p className="helper">{`More about ${conn.label} is on ${place.firstName}’s card.`}</p>}
      {h && (
        <p className="helper">
          {lastSyncedText(h)}
          {side ? ` · ${side}` : ''}
          {h.code ? ` · Plaid code ${h.code}` : ''}
        </p>
      )}
      {carried.map((c) => (
        <div key={c.account_id} className="stack tight">
          {c.warn ? (
            <div className="notice caution">
              {CAUTION}
              <p>
                <LevelWord level="caution" />
                {c.text}
              </p>
            </div>
          ) : (
            <p className="helper">{c.text}</p>
          )}
          <div className="btn-row">
            <button className="btn secondary" onClick={() => onConnector({ kind: 'uncarry', connection_id: conn!.connection_id, account_id: c.account_id })}>
              Undo carrying {c.name} on
            </button>
          </div>
        </div>
      ))}
      {/* The questions about its accounts (#50): missing from its answer, at
          zero for weeks, or ended and still reported. From every row, a
          hidden one's too: its absence holds every total all the same. */}
      <AccountQuestions
        accounts={[...allRows, ...(inst.ended_reported ?? [])]}
        institution={name}
        busy={lifecycle.busy}
        onOpen={lifecycle.open}
        onStillOpen={lifecycle.stillOpen}
        onConfirmEnd={lifecycle.confirmEnd}
        onReopen={lifecycle.reopen}
      />
      {/* Tells someone who just tapped Enable why it went without any
          payment details appearing. */}
      {inst.liabilities === 'loading' && <p className="helper">Payment details are still importing from this institution.</p>}
      {inst.new_accounts_available && !inst.manual && <p className="helper">{name} has accounts you haven&apos;t added yet.</p>}
      {unallowed && <p className="helper">You didn&apos;t allow Nya to see transactions from the bank or card accounts here.</p>}
      {actions.size > 0 && (
        <div className="btn-row">
          {[...actions.entries()].map(([key, node]) => (
            <Fragment key={key}>{node}</Fragment>
          ))}
        </div>
      )}
    </>
  );
}
