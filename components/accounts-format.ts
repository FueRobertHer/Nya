// The account helpers the Accounts tab, its cards and the account sheet
// share: the shapes the net worth payload sends, and how their money, days
// and terms are written.

import type { LinkKind } from '@/lib/item-products';
import { connectorBalanceDay } from '@/lib/connectors/types';
import type { ConnectionHealth as Health } from '@/lib/connection-state';
import type { AccountQuestion } from './AccountLifecycle';
import { formatMoney, hiddenFigure } from '@/lib/format';
import { instantDay } from '@/lib/local-date';
import { isOwedType, signedContribution } from '@/lib/balance';

export type Account = {
  account_id: string;
  name: string;
  official_name: string | null;
  mask: string | null;
  type: string;
  subtype: string | null;
  balance: number | null;
  limit: number | null;
  currency: string | null;
  updated_at?: string; // manual accounts only: when the balance was last typed/pushed
  hidden?: boolean; // excluded from every total and from the Activity tab
  liability?: AccountLiability; // credit/loan only, and only where Plaid serves it
  // Recovered from a past snapshot rather than fetched. Server-side this is
  // what keeps the balance out of accountBalanceMap; the client only needs to
  // know the field exists so it survives the localStorage round trip.
  stale?: boolean;
  // Investment accounts only: this load's holdings call failed for it, so its
  // positions are unknown (lib/networth.ts markUnanswered).
  holdings_unanswered?: boolean;
  // Missing from its bank's answer, held at its last known balance until the
  // person says whether it closed, and the question about it, which a zero
  // for weeks raises too (#50, lib/lifecycle-questions.ts).
  held?: { as_of: string | null; too_old?: string };
  question?: AccountQuestion;
};

// Payment terms for a credit card or loan (see lib/liabilities.ts). Optional
// everywhere: a payload cached in localStorage before this shipped has none.
export type AccountLiability = {
  kind: 'credit' | 'student' | 'mortgage';
  apr: number | null;
  apr_label: string | null;
  minimum_payment: number | null;
  next_due_date: string | null;
  last_statement_balance: number | null;
  last_payment_amount: number | null;
  last_payment_date: string | null;
  is_overdue: boolean | null;
  maturity_date?: string | null;
  escrow_balance?: number | null;
  expected_payoff_date?: string | null;
  outstanding_interest?: number | null;
};

export type Holding = {
  account_id?: string; // absent on payloads cached before hiding existed
  name: string;
  quantity: number | null;
  value: number | null;
  cost_basis: number | null;
  // Plaid security fields, read by lib/cash.ts to tell an invested position from
  // money parked in cash. Optional: a payload cached in localStorage before these
  // shipped has none, but it does carry `name`, which lib/cash.ts's last rule
  // reads, so an offline first paint still marks a "...Money Market..." fund as
  // cash (without Plaid's confirmation). The amount and share come from `value`.
  ticker?: string | null;
  security_type?: string | null;
  is_cash_equivalent?: boolean | null;
  // What `value` is in, for the Plan's allocation. Absent on payloads cached
  // before it was sent: the account's currency is used then.
  currency?: string | null;
};

export type Institution = {
  institution_name: string;
  item_id: string;
  // Plaid's institution id, for recognizing a second connection to the same
  // institution (lib/existing-items.ts). Absent on older cached payloads.
  institution_id?: string | null;
  // Which way it was linked (lib/item-products.ts linkedAs), for the sheet
  // that stops a second connection to it (components/ConnectRedirect.tsx).
  linked_as?: LinkKind;
  // Plaid found accounts at this Item the user hasn't added (lib/new-accounts.ts).
  new_accounts_available?: boolean;
  accounts: Account[];
  holdings: Holding[];
  error: string | null;
  needs_reauth: boolean;
  // 'on' | 'off' | 'loading' | 'unavailable' (lib/networth.ts). Optional and
  // compared explicitly against 'off' so a stale cached payload, which has no
  // such field, never offers the Enable button.
  liabilities?: string;
  // YYYY-MM-DD when the shown balances were last observed, set only when the live
  // fetch failed and they were recovered (all-or-nothing per institution, so it
  // covers every account in it). Optional: a payload cached before this shipped
  // has none, which reads as "not stale" and shows the plain error.
  //
  // The reverse is NOT disclosed: a rolled-back deploy reading a new localStorage
  // payload renders recovered balances with no staleness marker, under the plain
  // red error. The numbers are still real, just undated.
  stale_as_of?: string;
  // The instant behind stale_as_of (an ISO time), when the server knew it. The
  // date is a UTC day; this is what names the viewer's own day (fmtStaleDay).
  stale_as_of_at?: string;
  stale_too_old_at?: string;
  // Set instead of stale_as_of when last-known balances exist but are past the
  // age limit. The card stays at $0.00, and says why rather than looking like
  // an institution that never had recoverable balances at all.
  stale_too_old?: string;
  // How many of this institution's known accounts could not be recovered, set
  // alongside stale_as_of. Nonzero means the subtotal is short, so the card
  // says so rather than presenting an incomplete figure as merely dated.
  stale_missing?: number;
  // How many accounts this institution previously reported were absent from an
  // otherwise SUCCESSFUL fetch (lib/vanished.ts). There is no error alongside it:
  // the balances shown are fresh, just not all of them, so the total is short by
  // whatever the missing ones held. History is paused while this is set, so it
  // has to be said out loud, or the hero total drops and disagrees with the last
  // charted point for three days with nothing to explain it.
  unconfirmed_missing?: number;
  manual?: boolean; // synthetic grouping of manually-tracked accounts
  // Set on the accounts SimpleFIN feeds (lib/connectors/), `manual` too: they
  // are not Plaid's, and their balances aren't typed (components/Connectors.tsx).
  connector?: string;
  connection_id?: string;
  // The connection's health: state, when it last synced, whose side a problem
  // is on and what to do (lib/connection-state.ts). Optional: a payload
  // cached before it existed has none, and nothing is said then.
  health?: Health;
  // The accounts a broken card can't show, by name, for the health view, with
  // their kind and currency (absent on a payload from before they were sent).
  unshown_accounts?: { account_id: string; name: string; mask: string | null; type?: string; currency?: string | null }[];
  // Accounts that ended that its bank still returns, moved since: a copy of
  // each row with its question, counted in nothing (#50,
  // lib/lifecycle-questions.ts askAboutReportedEnds).
  ended_reported?: Account[];
};

// One manually-tracked account as the API returns it (see lib/manual.ts).
export type ManualAccount = {
  account_id: string;
  name: string;
  institution_name: string;
  type: string;
  subtype: string | null;
  balance: number;
  /** The currency its balance is in; US dollars when it names none. */
  currency?: string;
};

export function fmt(n: number | null | undefined, currency?: string | null): string {
  if (n == null) return '--';
  return formatMoney(n, currency);
}

export function signedBalance(a: Account): number {
  return signedContribution(a.type, a.balance ?? 0);
}

// "+$12.34 · 5.2%" gain/loss for a holding vs its cost basis.
export function fmtGain(value: number, cost: number): string {
  const gain = value - cost;
  const sign = gain >= 0 ? '+' : '-';
  const pct = cost !== 0 ? ` · ${((Math.abs(gain) / Math.abs(cost)) * 100).toFixed(1)}%` : '';
  return `${sign}$${hiddenFigure(
    Math.abs(gain).toLocaleString(undefined, {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })
  )}${pct}`;
}

// "Mar 4" from a YYYY-MM-DD. Parsed at local midnight, not UTC, so a due date
// never renders as the day before for anyone west of Greenwich.
export function fmtDay(iso: string): string {
  return new Date(`${iso}T00:00:00`).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
  });
}

// The local day of an instant (an ISO time), not its UTC day.
export function fmtInstantDay(iso: string): string {
  return instantDay(iso) ?? fmtDay(iso.slice(0, 10));
}

// The day a stored snapshot was taken, in the viewer's own time. The snapshot's
// date is a UTC day, which for anyone west of Greenwich can be the day after the
// one they were in; when the server knows the instant it was taken, that instant
// is shown as the local day instead. Otherwise the date is all there is.
export function fmtStaleDay(date: string, at?: string): string {
  // The instant must belong to that date's UTC day; a mismatch (a restore keeps
  // this environment's own record of instants) means it isn't this snapshot's.
  const local = at && at.slice(0, 10) === date ? instantDay(at) : null;
  return local ?? fmtDay(date);
}

// The one-line summary under a credit or loan row: rate, minimum, due date.
// Built by pushing only the parts Plaid actually reported, so a card that
// reports a due date but no APR still gets a useful line instead of "-- APR".
export function liabilitySummary(a: Account): string | null {
  const l = a.liability;
  if (!l) return null;
  const parts: string[] = [];
  if (l.apr != null) parts.push(`${l.apr.toFixed(2)}% APR`);
  if (l.minimum_payment != null) parts.push(`min ${fmt(l.minimum_payment, a.currency)}`);
  if (l.next_due_date) parts.push(`due ${fmtDay(l.next_due_date)}`);
  return parts.length > 0 ? parts.join(' · ') : null;
}

/**
 * Whether to offer "Enable payment details" for an institution. Only 'off': the
 * product was never initialized on this Item and update mode can add it.
 * 'loading' means Plaid is already fetching (offering the button would loop, since
 * the reload after a successful enable arrives before the data), and
 * 'unavailable' means enabling would change nothing. A stale cached payload has
 * no field at all, which also yields false.
 */
export function canEnableLiabilities(inst: Institution): boolean {
  return inst.liabilities === 'off' && inst.accounts.some((a) => isOwedType(a.type));
}

export function fmtAsOf(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

/** What kind of account it is: its bank's own name for it when that differs,
 *  its type, and the currency chosen for a typed balance when it isn't the
 *  one shown. */
export function accountKind(a: Account, inst: Institution, shownCurrency: string | null): string {
  const official = a.official_name && a.official_name !== a.name ? `${a.official_name} · ` : '';
  const currency = inst.manual && !inst.connector && a.currency && a.currency !== shownCurrency ? ` · in ${a.currency}` : '';
  return `${official}${a.subtype || a.type}${currency}`;
}

/** When a balance that isn't fetched now was set: typed by hand, or as a
 *  SimpleFIN or Lunch Flow sync gave it. SimpleFIN's is the day the bank gave
 *  it; Lunch Flow gives no day, so its is the day Nya received it. Null for a
 *  Plaid balance, which is implicitly now. */
export function balanceDay(a: Account, inst: Institution): string | null {
  if (!inst.manual || !a.updated_at) return null;
  return inst.connector ? connectorBalanceDay(inst.connector, fmtInstantDay(a.updated_at)) : `Updated ${fmtAsOf(a.updated_at)}`;
}

/** An account missing from its bank's answer, held until the question about
 *  it is answered (#50): its balance is the last known one, or not counted. */
export function heldLine(a: Account): string | null {
  if (!a.held) return null;
  return a.held.as_of ? `Last known balance, from ${fmtDay(a.held.as_of)}` : 'No recent balance, so not counted';
}
