// lib/accounts-status.ts
//
// One color for each connection's problems on the Accounts tab (rollout phase
// 3b), from two questions, so the card's notices, its badge, Settings >
// Connections and the status pill always agree:
//
//   1. Is it broken in a way only the person can fix? Sign in again,
//      reconnect, connect again, pay or fix it at SimpleFIN or Lunch Flow,
//      say which way a card goes, or remove a connection that can't be
//      repaired. The card shows the button that does it.
//   2. Is the total missing an account's money? Nothing could be fetched or
//      recovered, accounts couldn't be shown, balances are too old to count,
//      or an account is held with no balance. The card says what isn't
//      counted.
//
// Either makes it critical (red). Anything else that is off is a caution
// (amber): balances recovered during an outage or a problem on Nya's side, a
// connection that ends soon, accounts held at their last known balance, an
// open question about an account, something Nya keeps that couldn't be read,
// and a new connection waiting for its first answer (its accounts were never
// in the total, and the card says it is waiting). The words never change
// with the color. Pure, client-safe.

import type { ConnectionHealth } from './connection-state';

export type Severity = 'critical' | 'caution';

/** What the two questions read of an institution, as /api/net-worth sends it. */
export type StatusInstitution = {
  item_id: string;
  manual?: boolean;
  connector?: string;
  connection_id?: string;
  error: string | null;
  needs_reauth?: boolean;
  stale_as_of?: string;
  stale_missing?: number;
  stale_too_old?: string;
  unconfirmed_missing?: number;
  accounts: { balance: number | null; hidden?: boolean; held?: unknown; question?: unknown }[];
  ended_reported?: { question?: unknown }[];
  health?: ConnectionHealth;
};

/** A connector's issues only the person can act on: fix it at the service,
 *  pay it, connect again, say which way a card goes, or disconnect. */
const CONNECTOR_NEEDS_YOU = new Set(['reported', 'old_balance', 'payment', 'refused', 'credentials', 'gone', 'sign']);

/** Question 1: broken in a way only the person can fix. */
export function needsYou(inst: StatusInstitution): boolean {
  const h = inst.health;
  if (h?.cause === 'connector') return CONNECTOR_NEEDS_YOU.has(h.detail?.issue ?? '');
  if (h) return h.state === 'needs_reauth' || h.state === 'relink' || h.state === 'closed';
  // A payload from before health was sent: a failing connection that a
  // reconnect fixes (needs_reauth alone is also set while one ends soon).
  return !!inst.needs_reauth && !!inst.error;
}

/** Question 2: the total is missing an account's money. */
export function missingMoney(inst: StatusInstitution): boolean {
  // A new connection waiting for its first answer: never in the total yet.
  if (inst.health?.cause === 'connector' && inst.health.detail?.issue === 'waiting') return false;
  if (inst.error && (!inst.stale_as_of || !!inst.stale_missing || !!inst.stale_too_old)) return true;
  return inst.accounts.some((a) => !a.hidden && !!a.held && a.balance == null);
}

/** Anything off that isn't critical. `extra` is what the connection's own
 *  record says beyond its health (a SimpleFIN note, a carried account's
 *  warning). */
function offAtAll(inst: StatusInstitution, extra: boolean): boolean {
  const h = inst.health;
  return (
    extra ||
    !!inst.error ||
    !!inst.unconfirmed_missing ||
    (!!h && h.state !== 'healthy') ||
    !!h?.unread ||
    inst.accounts.some((a) => !!a.question) ||
    (inst.ended_reported ?? []).some((a) => !!a.question)
  );
}

/** The one color for an institution's card, or null when nothing is off. */
export function severityOf(inst: StatusInstitution, extra = false): Severity | null {
  if (needsYou(inst) || missingMoney(inst)) return 'critical';
  return offAtAll(inst, extra) ? 'caution' : null;
}

/** The worse of two. */
export function worse(a: Severity | null, b: Severity | null): Severity | null {
  return a === 'critical' || b === 'critical' ? 'critical' : (a ?? b);
}

/** Which of these to go to first: the worst, then the first on screen. */
export function firstToFix<T extends { severity: Severity | null }>(entries: readonly T[]): T | null {
  return entries.find((e) => e.severity === 'critical') ?? entries.find((e) => e.severity === 'caution') ?? null;
}
