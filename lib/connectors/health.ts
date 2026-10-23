// lib/connectors/health.ts
//
// The health of accounts a connector feeds (lib/connectors/), in the shape the
// connection health view, the Home notes and Activity's month notes already
// read (lib/connection-state.ts ConnectionHealth, cause 'connector'), and its
// words. Pure, client-safe: the server builds it (lib/connectors/institutions.ts)
// and the browser words it (components/ConnectionHealth.tsx).
//
// WHOSE SIDE. A broken link at SimpleFIN looks like a Nya problem from the
// outside, so every state says whose side it is on:
//   - SimpleFIN's (side 'connector'): it reported a problem with a bank, didn't
//     answer, answered with something Nya can't read, or has only an old
//     balance from the bank. Its own words are shown as it sent them;
//   - the person's ('you'): SimpleFIN no longer accepts Nya's access (removed
//     or reset at SimpleFIN, or the subscription ended), or wants payment, or
//     a card or a loan reports a positive balance only they can say how to
//     read (lib/connectors/institutions.ts SIGNS);
//   - Nya's ('nya'): it can't read what it keeps, its daily update didn't run,
//     or SimpleFIN refused how Nya asked. Never the person's to fix;
//   - not known ('unknown'): the server's address isn't one Nya connects to.
// And what to do: fix it at SimpleFIN and refresh, connect again with a new
// Setup Token (the accounts and their history stay), choose accounts, or wait.
// The same holds for Lunch Flow, in its words: connecting again takes an API
// key from it (CONNECTOR_WORDS), and since it gives no time with a balance,
// a link of its that broke is told by the status of its accounts (a problem
// it reports), never by an old balance. A request about one of its accounts
// that brought nothing this time is `down` (lib/connectors/institutions.ts):
// nothing to do, since Nya asks again, never "fix it at Lunch Flow".

import type { ConnectionHealth, HealthAction, HealthState, Side } from '../connection-state';
import { CONNECTOR_WORDS, isConnectorKind, type ConnectorDetail, type ConnectorIssue, type ConnectorKind } from './types';

/** What connecting again takes, in words: "a new Setup Token". */
const again = (kind: ConnectorKind) => (isConnectorKind(kind) ? CONNECTOR_WORDS[kind].again : 'a new Setup Token');

/** Each issue's state and action (what a failed request's own side doesn't
 *  settle, its side). */
const ISSUES: Readonly<Record<ConnectorIssue, { state: HealthState; action: HealthAction; side: Side }>> = {
  ok: { state: 'healthy', action: 'none', side: 'none' },
  waiting: { state: 'outage', action: 'wait', side: 'connector' },
  reported: { state: 'needs_reauth', action: 'reconnect', side: 'connector' },
  missing: { state: 'partial', action: 'resolve', side: 'connector' },
  sign: { state: 'partial', action: 'resolve', side: 'you' },
  old_balance: { state: 'needs_reauth', action: 'reconnect', side: 'connector' },
  stale: { state: 'outage', action: 'wait', side: 'nya' },
  unreadable: { state: 'outage', action: 'wait', side: 'nya' },
  gone: { state: 'relink', action: 'remove', side: 'nya' },
  refused: { state: 'relink', action: 'relink', side: 'you' },
  payment: { state: 'needs_reauth', action: 'reconnect', side: 'you' },
  limited: { state: 'outage', action: 'wait', side: 'nya' },
  rejected: { state: 'outage', action: 'wait', side: 'nya' },
  down: { state: 'outage', action: 'wait', side: 'connector' },
  answer: { state: 'outage', action: 'wait', side: 'connector' },
  blocked: { state: 'outage', action: 'wait', side: 'unknown' },
  credentials: { state: 'relink', action: 'relink', side: 'nya' },
};

export const CONNECTOR_ISSUES = Object.keys(ISSUES) as ConnectorIssue[];

/** A connector's accounts' health, as the views read it. `side`, when given,
 *  is a failed request's own (lib/connectors/simplefin.ts says per status). */
export function connectorHealth(detail: ConnectorDetail, lastOkAt: string | null, side?: Side): ConnectionHealth {
  const known = Object.hasOwn(ISSUES, detail.issue) ? ISSUES[detail.issue] : ISSUES.down;
  return { state: known.state, cause: 'connector', side: side ?? known.side, action: known.action, last_ok_at: lastOkAt, detail };
}

const quoted = (messages: string[]) => messages.map((m) => `“${m}”`).join(' ');

/** "Sep 20" for an ISO time, by its UTC day; the text as it is otherwise. */
export function shortDay(iso: string | undefined): string {
  const at = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(at) ? new Date(at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }) : (iso ?? '');
}
const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);

/** "A", "A and B", "A, B and C". */
function names(list: string[]): string {
  if (list.length <= 1) return list.join('');
  return `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}`;
}

/** The badge. */
export function connectorBadge(h: ConnectionHealth): string {
  switch (h.detail?.issue) {
    case 'ok':
      return 'Working';
    case 'reported':
      return `Needs attention at ${h.detail.label}`;
    case 'payment':
      return `Payment due at ${h.detail.label}`;
    case 'refused':
    case 'credentials':
      return 'Needs connecting again';
    case 'missing':
      return 'Missing accounts';
    case 'sign':
      return 'Needs your answer';
    case 'old_balance':
      return `Not updating at ${h.detail.label}`;
    case 'waiting':
      return `Waiting for ${h.detail.label}`;
    case 'gone':
      return 'Disconnected';
    default:
      return 'Not updating';
  }
}

/**
 * What is wrong and what to do, in a sentence or two, with the connector's
 * own words where it gave some. `name` is the institution the accounts are
 * at. Null when nothing is wrong.
 */
export function connectorHealthText(name: string, h: ConnectionHealth): string | null {
  const d = h.detail;
  if (!d) return null;
  const by = d.label;
  const until = `Until then its balances are shown as last known, and no day's total is saved.`;
  switch (d.issue) {
    case 'ok':
      return null;
    case 'waiting':
      return `Waiting for ${by}'s answer about ${name}: Nya asks at its next daily update, or when you Refresh. ${until}`;
    case 'sign': {
      const n = d.accounts.length;
      // Some banks give Lunch Flow a card's credit left to spend in its place
      // (lib/connectors/lunchflow.ts), which neither answer reads rightly.
      const neither = d.connector === 'lunchflow' ? ' If neither is right (some banks report the credit left to spend instead), stop tracking it with Choose accounts.' : '';
      return `${by} reports ${names(d.messages)} as money held. For a card or a loan that is unusual: some servers report what you owe that way. Say which it is, once: until you do, ${plural(n, 'it isn’t', 'they aren’t')} counted, and no day's total is saved.${neither}`;
    }
    case 'old_balance':
      return `The latest balance ${by} has from ${name} is from ${shortDay(d.messages[0])}: its link to ${name} has stopped updating. Fix it in ${by} (often by signing in to ${name} there again), then refresh here. ${until}`;
    case 'reported':
      return `${by} reports: ${quoted(d.messages)}. This is between ${by} and ${name}: fix it in ${by} (often by signing in to ${name} there again), then refresh here. ${until}`;
    case 'missing': {
      const n = d.accounts.length;
      // One that closed holds nothing once it is said (lib/connectors/institutions.ts).
      const it = plural(n, 'it', 'them');
      return `${names(d.accounts)} ${plural(n, "isn't", "aren't")} in ${by}'s latest answer. If you removed ${it} at ${by}, stop tracking ${it} here with Choose accounts. If ${plural(n, 'it', 'they')} closed, say so with Close… on ${plural(n, 'it', 'each')}, from the Accounts tab. ${until}`;
    }
    case 'stale':
      return `Nya hasn't had an answer from ${by} in over a day: its daily update didn't run. Nothing for you to do; Refresh asks now.`;
    case 'unreadable':
      return `What Nya keeps about your ${by} accounts couldn't be read, so they aren't counted. Nothing for you to do: whoever runs Nya needs to look at it.`;
    case 'gone':
      return `This account's ${by} connection is gone. Disconnect it to keep its history as a manual account, or remove it.`;
    case 'refused':
      return `${by} no longer accepts Nya's access: it was removed or reset at ${by}, or the subscription ended. Connect again with ${again(d.connector)}: your accounts and their history stay. ${quoted(d.messages)}`;
    case 'payment':
      return `${by} says your subscription needs paying. Renew it at ${by}; Nya picks up again at its next update. ${until}`;
    case 'limited':
      return `${by} says Nya asked too often. Nothing for you to do: Nya asks again at its next update.`;
    case 'rejected':
      return `${by} refused how Nya asked: ${quoted(d.messages)} Nothing for you to do: whoever runs Nya needs to look at it.`;
    case 'down':
      return `${quoted(d.messages)} Nothing to do: this usually clears on its own, and Nya asks again at its next update.`;
    case 'answer':
      return `${by}'s answer couldn't be read. Nothing to do yet: Nya asks again at its next update.`;
    case 'blocked':
      return `${quoted(d.messages)} If you didn't expect this, connect again with ${again(d.connector)}.`;
    case 'credentials':
      return `Nya can't use the access ${by} gave it. Connect again with ${again(d.connector)}: your accounts and their history stay.`;
    default:
      return `${name} couldn't be updated through ${by}.`;
  }
}

/** Whose side the problem is on. */
export function connectorSideText(name: string, h: ConnectionHealth): string | null {
  const by = h.detail?.label ?? 'the connector';
  switch (h.side) {
    case 'connector':
      return `On ${by}'s side`;
    case 'you':
      return `On your side: your ${by} account`;
    case 'bank':
      return `On ${name}'s side`;
    case 'nya':
      return "On Nya's side";
    case 'unknown':
      return 'Whose side: not known';
    default:
      return null;
  }
}

/** The connector's own site, where the person fixes what it reports. */
export function connectorSite(d: ConnectorDetail): string | null {
  return d.host ? `https://${d.host}/` : null;
}
