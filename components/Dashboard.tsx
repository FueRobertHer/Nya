'use client';

import ClerkAccount from './ClerkAccount';
import { watchSignOut } from './sign-out-watch';
import { LOCAL_CACHE_KEY, cacheKeyFor } from './device-cache';
import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { usePlaidLink, type PlaidLinkOnSuccessMetadata, type PlaidLinkOnEventMetadata } from 'react-plaid-link';
import { existingItemsAt } from '@/lib/existing-items';
import NetWorthChart, { type HistoryPoint } from './NetWorthChart';
import AccountSparkline from './AccountSparkline';
import AccountLinks from './AccountLinks';
import AdminUnusedItems from './AdminUnusedItems';
import DownloadMyData from './DownloadMyData';
import { instantDay } from '@/lib/local-date';
import { PLAID_PORTAL } from '@/lib/deletion-receipt';
import { SharingDrawer, SharedWithMe } from './Sharing';
import { Sheet } from './Sheet';
import DebtPayoff from './DebtPayoff';
import { CoverageNote, TrustLinks } from './TrustLinks';
import ConnectButtons from './ConnectButtons';
import { RedirectChoices } from './ConnectRedirect';
import type { LinkKind } from '@/lib/item-products';
import { noTransactionsView, quietItemIds, unallowedItemIds, NO_CONNECTIONS_WITHOUT, type NoTransactionsView } from '@/lib/no-transactions';
import { historyPausedSince } from '@/lib/history-status';
import InvestmentActivity from './InvestmentActivity';
import HoldingsRecorded from './HoldingsRecorded';
import MonthBreakdown, { type Txn } from './MonthBreakdown';
import ManualTxnSheet from './ManualTxnSheet';
import { useTransactionEdits } from './transaction-edits';
import Insights, { type IdleCashAccount } from './Insights';
import ConnectionHealth, { ReconnectSoonNote } from './ConnectionHealth';
import { totalNotes } from './total-notes';
import { stoppedConnections, type Incomplete } from '@/lib/month-coverage';
import type { ConnectionHealth as Health } from '@/lib/connection-state';
import BudgetsTab, { type Budgets } from './BudgetsTab';
import type { RecurringRow } from '@/lib/recurring';
import { EMPTY_PLANNED, isPlanned, type Planned } from '@/lib/planned';
import { createWholeListStore, initialListState, type ListState } from '@/lib/whole-list-store';
import { type Goal } from './GoalsCard';
import { formatMoney, dominantCurrency } from '@/lib/format';
// Same dependency-free-shared-module trick as lib/format: the sign rule lives
// outside lib/hidden.ts so the client can import it without pulling in Redis.
import { CASH_SUBTYPE, isCashOnHand, isInvestmentType, isOwedType, signedContribution } from '@/lib/balance';
// Same reason: lib/cash.ts imports nothing, so the cash rule can be shared
// between the server payload and this component.
import { institutionCash, isCashHolding, cashSharePct } from '@/lib/cash';
// The Plan tab carries the projection engine, so its code is loaded only when
// the tab is opened, and a failure to load or run it stays on that tab.
import PlanTabLoader from './PlanTabLoader';

type Account = {
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
};

// Payment terms for a credit card or loan (see lib/liabilities.ts). Optional
// everywhere: a payload cached in localStorage before this shipped has none.
type AccountLiability = {
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

type Holding = {
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
};

type Institution = {
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
  // The connection's health: state, when it last synced, whose side a problem
  // is on and what to do (lib/connection-state.ts). Optional: a payload
  // cached before it existed has none, and nothing is said then.
  health?: Health;
  // The accounts a broken card can't show, by name, for the health view.
  unshown_accounts?: { account_id: string; name: string; mask: string | null }[];
};

// One manually-tracked account as the API returns it (see lib/manual.ts).
type ManualAccount = {
  account_id: string;
  name: string;
  institution_name: string;
  type: string;
  subtype: string | null;
  balance: number;
};

// The form's working copy. `balance` is a STRING, as in BudgetsTab and GoalsCard:
// an <input type="number"> reports '' for a partly typed value like "-", and
// Number('') is 0, so a number would erase the minus sign as you type it. It's
// parsed once on submit. `account_id` is null while adding; the server mints it.
type ManualDraft = Omit<ManualAccount, 'account_id' | 'balance'> & {
  account_id: string | null;
  balance: string;
};

// "cash" is a choice, not a type: saved as depository with the subtype
// CASH_SUBTYPE (lib/balance.ts), which the Plan reads to count cash
// withdrawals and the cash spending entered on the account once.
const MANUAL_TYPE_LABELS: { value: string; label: string }[] = [
  { value: 'depository', label: 'Checking or savings' },
  { value: 'cash', label: 'Cash on hand (a wallet)' },
  { value: 'investment', label: 'Investment (brokerage, 401k, HSA)' },
  { value: 'credit', label: 'Credit card' },
  { value: 'loan', label: 'Loan (mortgage, auto, student)' },
  { value: 'other', label: 'Other (property, crypto)' },
];

type Tab = 'home' | 'accounts' | 'activity' | 'budgets' | 'plan';

// Last-known dashboard snapshot, kept on-device so the app paints instantly on
// open (and shows something useful offline) while fresh data loads. Cleared on
// logout; keyed per account (device-cache.ts).
/** Set once this page has been sent to the login page because its session
 *  ended: nothing may save the snapshot again after it was cleared. */
let signedOut = false;

// Currency-aware money, so a EUR/GBP account isn't rendered with a "$".
// Delegates to the shared formatter (falls back to $ for a null or unrecognized
// code); "--" for a missing value.
/** The value, or the last one that wasn't null: what a closing drawer keeps
 *  showing while it slides out. */
function useLast<T>(value: T | null): T | null {
  const last = useRef<T | null>(value);
  if (value !== null) last.current = value;
  return last.current;
}

/** A 20px line icon for the account actions. */
function ActionIcon({ d }: { d: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={d} />
    </svg>
  );
}

function fmt(n: number | null | undefined, currency?: string | null): string {
  if (n == null) return '--';
  return formatMoney(n, currency);
}

function signedBalance(a: Account): number {
  return signedContribution(a.type, a.balance ?? 0);
}

// "+$12.34 · 5.2%" gain/loss for a holding vs its cost basis.
function fmtGain(value: number, cost: number): string {
  const gain = value - cost;
  const sign = gain >= 0 ? '+' : '-';
  const pct = cost !== 0 ? ` · ${((Math.abs(gain) / Math.abs(cost)) * 100).toFixed(1)}%` : '';
  return `${sign}$${Math.abs(gain).toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}${pct}`;
}

// "Mar 4" from a YYYY-MM-DD. Parsed at local midnight, not UTC, so a due date
// never renders as the day before for anyone west of Greenwich.
function fmtDay(iso: string): string {
  return new Date(`${iso}T00:00:00`).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
  });
}

// The local day of an instant (an ISO time), not its UTC day.
function fmtInstantDay(iso: string): string {
  return instantDay(iso) ?? fmtDay(iso.slice(0, 10));
}

// The day a stored snapshot was taken, in the viewer's own time. The snapshot's
// date is a UTC day, which for anyone west of Greenwich can be the day after the
// one they were in; when the server knows the instant it was taken, that instant
// is shown as the local day instead. Otherwise the date is all there is.
function fmtStaleDay(date: string, at?: string): string {
  // The instant must belong to that date's UTC day; a mismatch (a restore keeps
  // this environment's own record of instants) means it isn't this snapshot's.
  const local = at && at.slice(0, 10) === date ? instantDay(at) : null;
  return local ?? fmtDay(date);
}

// The one-line summary under a credit or loan row: rate, minimum, due date.
// Built by pushing only the parts Plaid actually reported, so a card that
// reports a due date but no APR still gets a useful line instead of "-- APR".
function liabilitySummary(a: Account): string | null {
  const l = a.liability;
  if (!l) return null;
  const parts: string[] = [];
  if (l.apr != null) parts.push(`${l.apr.toFixed(2)}% APR`);
  if (l.minimum_payment != null) parts.push(`min ${fmt(l.minimum_payment, a.currency)}`);
  if (l.next_due_date) parts.push(`due ${fmtDay(l.next_due_date)}`);
  return parts.length > 0 ? parts.join(' · ') : null;
}

/**
 * The rest of a liability's terms, shown only when the row is expanded (the
 * collapsed row already carries rate, minimum and due date).
 *
 * Follows TxnDetail in MonthBreakdown: push only fields that are present, and
 * render nothing rather than a list of dashes when none are.
 */
function LiabilityDetail({
  liability,
  currency,
}: {
  liability?: AccountLiability;
  currency: string | null;
}) {
  if (!liability) return null;
  const l = liability;
  const rows: { label: string; value: string }[] = [];

  if (l.apr != null && l.apr_label) rows.push({ label: l.apr_label, value: `${l.apr.toFixed(2)}%` });
  if (l.last_statement_balance != null) {
    rows.push({ label: 'Statement balance', value: fmt(l.last_statement_balance, currency) });
  }
  if (l.last_payment_amount != null) {
    rows.push({
      label: 'Last payment',
      value:
        fmt(l.last_payment_amount, currency) +
        (l.last_payment_date ? ` on ${fmtDay(l.last_payment_date)}` : ''),
    });
  }
  if (l.outstanding_interest != null) {
    rows.push({ label: 'Accrued interest', value: fmt(l.outstanding_interest, currency) });
  }
  if (l.escrow_balance != null) {
    rows.push({ label: 'Escrow', value: fmt(l.escrow_balance, currency) });
  }
  if (l.expected_payoff_date) {
    rows.push({ label: 'Expected payoff', value: fmtDay(l.expected_payoff_date) });
  }
  if (l.maturity_date) rows.push({ label: 'Matures', value: fmtDay(l.maturity_date) });

  if (rows.length === 0) return null;
  return (
    <dl className="txn-detail">
      {rows.map((r) => (
        <div className="txn-detail-row" key={r.label}>
          <dt>{r.label}</dt>
          <dd>{r.value}</dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * Whether to offer "Enable payment details" for an institution. Only 'off': the
 * product was never initialized on this Item and update mode can add it.
 * 'loading' means Plaid is already fetching (offering the button would loop, since
 * the reload after a successful enable arrives before the data), and
 * 'unavailable' means enabling would change nothing. A stale cached payload has
 * no field at all, which also yields false.
 */
function canEnableLiabilities(inst: Institution): boolean {
  return inst.liabilities === 'off' && inst.accounts.some((a) => isOwedType(a.type));
}

function fmtAsOf(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

const TAB_ICONS: Record<Tab, React.ReactNode> = {
  home: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3 10.5 12 3l9 7.5M5 9.5V21h14V9.5" />
    </svg>
  ),
  accounts: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x={2.5} y={5.5} width={19} height={13} rx={2} />
      <path d="M2.5 10h19" />
    </svg>
  ),
  activity: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M4 6h16M4 12h16M4 18h10" />
    </svg>
  ),
  budgets: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx={12} cy={12} r={9} />
      <path d="M12 12V3M12 12l6.4 6.4" />
    </svg>
  ),
  plan: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3 17l6-6 4 4 8-8M15 7h6v6" />
    </svg>
  ),
};

const TAB_LABELS: Record<Tab, string> = {
  home: 'Home',
  accounts: 'Accounts',
  activity: 'Activity',
  budgets: 'Budgets',
  plan: 'Plan',
};

export default function Dashboard({
  clerk = false,
  viewer,
  admin = false,
  brokerageLink = false,
}: {
  clerk?: boolean;
  viewer?: string;
  /** Set by the server (app/page.tsx): only the admin is sent the admin panel. */
  admin?: boolean;
  /** Set by the server (app/page.tsx): whether to offer connecting a brokerage
   *  or retirement account (PLAID_BROKERAGE_LINK, lib/item-products.ts). */
  brokerageLink?: boolean;
}) {
  const cacheKey = cacheKeyFor(viewer);
  const [tab, setTab] = useState<Tab>('home');
  const [linkToken, setLinkToken] = useState<string | null>(null);
  // 'update' re-authenticates or adds a product; 'accounts' is the account
  // picker on an existing Item. Neither creates an Item.
  const [linkMode, setLinkMode] = useState<'new' | 'update' | 'accounts'>('new');
  // Refs, not state: react-plaid-link builds its handler once per token and
  // keeps the callbacks it was given then, so state read inside them would be
  // stale. See onEvent.
  const bypassDuplicateRef = useRef(false);
  const redirectingRef = useRef(false);
  const exitLinkRef = useRef<(opts?: { force?: boolean }) => void>(() => {});
  // The Item the account picker is open on, and when it opened by the server's
  // clock (see app/api/item-accounts-updated).
  const updatingItemRef = useRef<{ item_id: string; opened_at: string } | null>(null);
  // Whether Link is on screen: a late SELECT_INSTITUTION must not redirect a
  // Link that already closed.
  const linkOpenRef = useRef(false);
  // Which way the new connection in progress was started (components/ConnectButtons.tsx).
  const connectKindRef = useRef<LinkKind>('bank');
  // Set when a new connection was stopped at an institution already connected,
  // with the way it was started, for connecting it separately after all.
  const [redirect, setRedirect] = useState<{ name: string; items: Institution[]; kind: LinkKind } | null>(null);
  const shownRedirect = useLast(redirect);
  const [connected, setConnected] = useState(false);
  const [institutions, setInstitutions] = useState<Institution[]>([]);
  const [netWorth, setNetWorth] = useState(0);
  const [history, setHistory] = useState<HistoryPoint[]>([]);
  const [asOf, setAsOf] = useState<string | null>(null);
  const [backupProblem, setBackupProblem] = useState<{ last_ok: string | null; reason: string | null } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [connecting, setConnecting] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [txns, setTxns] = useState<Txn[] | null>(null);
  const [txnNotes, setTxnNotes] = useState<string[]>([]);
  // Institutions whose transactions this load lacks, for Activity's month notes.
  const [txnIncomplete, setTxnIncomplete] = useState<Incomplete[]>([]);
  // Connections that bring in no transactions, so the spending views say why.
  const [txnWithout, setTxnWithout] = useState<NoTransactionsView>(NO_CONNECTIONS_WITHOUT);
  // The rows before the loaded year that recurring detection needs.
  const [txnHistory, setTxnHistory] = useState<RecurringRow[]>([]);
  const [txnsLoading, setTxnsLoading] = useState(false);
  // Connection health (components/ConnectionHealth.tsx): whether the server
  // could read Plaid's warnings, and whether a notice email's link opened it.
  const [healthUnavailable, setHealthUnavailable] = useState(false);
  const [healthFocus, setHealthFocus] = useState(false);
  const clearHealthFocus = useCallback(() => setHealthFocus(false), []);
  // The Item update mode is open on, so its success can be recorded
  // (app/api/item-reconnected).
  const reconnectingItemRef = useRef<string | null>(null);
  const [expandedAccounts, setExpandedAccounts] = useState<Set<string>>(new Set());
  const [expandedHoldings, setExpandedHoldings] = useState<Set<string>>(new Set());
  // Budgets and goals are each saved as one whole list, so their loading and
  // saving go through lib/whole-list-store.ts, which never lets an unloaded or
  // stale list be saved over what is stored.
  const [budgetsState, setBudgetsState] = useState<ListState<Budgets>>(initialListState({}));
  const [goalsState, setGoalsState] = useState<ListState<Goal[]>>(initialListState<Goal[]>([]));
  const budgetsStore = useMemo(
    () =>
      createWholeListStore<Budgets>({
        url: '/api/budgets',
        field: 'budgets',
        noun: 'budgets',
        empty: {},
        isValid: (v): v is Budgets => typeof v === 'object' && v !== null && !Array.isArray(v),
        onChange: setBudgetsState,
      }),
    []
  );
  const goalsStore = useMemo(
    () =>
      createWholeListStore<Goal[]>({
        url: '/api/goals',
        field: 'goals',
        noun: 'goals',
        empty: [],
        isValid: (v): v is Goal[] => Array.isArray(v),
        onChange: setGoalsState,
      }),
    []
  );
  // The forecast's planned items and dismissals (lib/planned.ts), saved whole
  // the same way.
  const [plannedState, setPlannedState] = useState<ListState<Planned>>(initialListState<Planned>(EMPTY_PLANNED));
  const plannedItemsStore = useMemo(
    () =>
      createWholeListStore<Planned>({
        url: '/api/planned-items',
        field: 'planned',
        noun: 'planned items',
        empty: EMPTY_PLANNED,
        isValid: isPlanned,
        onChange: setPlannedState,
      }),
    []
  );
  const budgets = budgetsState.value;
  const goals = goalsState.value;
  // Accounts tab: disconnect buttons stay hidden until "Manage accounts" is
  // toggled, so they can't be tapped by accident. disconnectTarget drives the
  // type-to-confirm drawer.
  const [manageMode, setManageMode] = useState(false);
  // The Sharing drawer, opened from the Accounts tab or the account menu.
  const [sharingOpen, setSharingOpen] = useState(false);
  const closeSharing = useCallback(() => setSharingOpen(false), []);
  // The debt payoff planner, opened from the Accounts tab (components/DebtPayoff.tsx).
  const [payoffOpen, setPayoffOpen] = useState(false);
  const closePayoff = useCallback(() => setPayoffOpen(false), []);
  const [disconnectTarget, setDisconnectTarget] = useState<Institution | null>(null);
  const shownDisconnectTarget = useLast(disconnectTarget);
  const [disconnectInput, setDisconnectInput] = useState('');
  const [disconnecting, setDisconnecting] = useState(false);
  // Manual accounts: `manualDraft` drives the add/edit drawer, and
  // `editingManual` flips the same form between adding and editing.
  // `manualError` is separate from the page-level `error` so a failed save can't
  // linger on the Accounts card after the drawer closes, and a background refresh
  // failure can't look like a save failure.
  const [manualDraft, setManualDraft] = useState<ManualDraft | null>(null);
  const [editingManual, setEditingManual] = useState(false);
  const [savingManual, setSavingManual] = useState(false);
  const [manualError, setManualError] = useState('');
  const [manualDeleteTarget, setManualDeleteTarget] = useState<ManualAccount | null>(null);
  // What each drawer shows: the current value, or the last one while it slides out.
  const shownManualDraft = useLast(manualDraft);
  const editingManualShown = useLast(manualDraft ? editingManual : null) ?? false;
  const shownDeleteTarget = useLast(manualDeleteTarget);
  // The Hidden card starts collapsed: it exists so hidden accounts are
  // findable, not so they take up room on the balance sheet you decluttered.
  const [hiddenExpanded, setHiddenExpanded] = useState(false);
  // The stored hidden set, straight from the server, so hidden accounts stay
  // listed (and unhideable) even when their institution fails to load.
  const [hiddenMeta, setHiddenMeta] = useState<
    { account_id: string; type: string; label?: string; disconnected?: boolean }[]
  >([]);
  const [togglingHidden, setTogglingHidden] = useState<string | null>(null);
  // Guards the one-shot estimated-history backfill per page load; the server
  // keeps its own done-flag, so this only avoids redundant requests.
  const backfillTried = useRef(false);

  // Fire-and-forget: ask the server to reconstruct estimated history from
  // transactions (no-op if it already has), then reload so the chart picks
  // up the new points.
  const requestBackfill = useCallback((reload: () => void) => {
    fetch('/api/backfill', { method: 'POST' })
      .then((res) => res.ok && res.json())
      .then((data) => {
        if (data && data.backfilled > 0) reload();
      })
      .catch(() => {
        // Estimated history is a nice-to-have; fail silently.
      });
  }, []);

  const loadNetWorth = useCallback(async (force = false) => {
    setRefreshing(true);
    try {
      const res = await fetch(`/api/net-worth${force ? '?refresh=1' : ''}`);
      if (!res.ok) {
        // The server's reason when it gives one (no usable container, say),
        // so the cause shows on screen rather than only in the logs.
        const reason = await res.json().then((b) => b?.error).catch(() => null);
        setError(reason && res.status === 503 ? `Failed to load accounts: ${reason}` : 'Failed to load accounts.');
        return;
      }
      const data = await res.json();
      setError('');
      setInstitutions(data.institutions);
      setNetWorth(data.netWorth);
      setHistory(data.history ?? []);
      setHiddenMeta(data.hidden ?? []);
      setAsOf(data.as_of ?? null);
      setBackupProblem(data.backup_problem ?? null);
      setHealthUnavailable(!!data.health_unavailable);
      setConnected(data.institutions.length > 0);

      // First open with a near-empty chart: backfill estimated history from
      // transactions in the background.
      //
      // `backfill_stale` covers a layer that exists but was built by an older
      // algorithm. That is invisible from here (the chart looks full), so the
      // server has to say so, or an improvement to the reconstruction would only
      // reach people with no history yet.
      const hist: HistoryPoint[] = data.history ?? [];
      const thin = hist.filter((h) => !h.estimated).length <= 1 && !hist.some((h) => h.estimated);
      if ((thin || data.backfill_stale) && data.institutions.length > 0 && !backfillTried.current) {
        backfillTried.current = true;
        requestBackfill(() => loadNetWorth());
      }

      try {
        // A response still in flight when the session ended must not bring
        // back the snapshot the redirect just cleared.
        if (signedOut) return;
        localStorage.setItem(
          cacheKey,
          JSON.stringify({
            institutions: data.institutions,
            netWorth: data.netWorth,
            history: data.history ?? [],
            hidden: data.hidden ?? [],
            as_of: data.as_of,
          })
        );
      } catch {
        // Storage unavailable/full -- the instant-open snapshot is best-effort.
      }
    } catch {
      // Network unreachable; keep showing whatever we have (possibly the
      // hydrated snapshot).
      setError('Could not reach the server.');
    } finally {
      setRefreshing(false);
      setLoading(false);
    }
  }, [requestBackfill]);

  const loadTransactions = useCallback(async (force = false) => {
    setTxnsLoading(true);
    try {
      const res = await fetch(`/api/transactions${force ? '?refresh=1' : ''}`);
      if (!res.ok) {
        setTxnNotes(['Could not load transactions.']);
        return;
      }
      const data = await res.json();
      setTxns(data.transactions);
      setTxnNotes(data.notes ?? []);
      setTxnIncomplete(Array.isArray(data.incomplete) ? data.incomplete : []);
      setTxnWithout(noTransactionsView(data));
      setTxnHistory(Array.isArray(data.recurring_history) ? data.recurring_history : []);
    } catch {
      setTxnNotes(['Could not load transactions.']);
    } finally {
      setTxnsLoading(false);
    }
  }, []);

  // A session ended elsewhere (signed out everywhere, or the password changed)
  // makes every API call answer 401; send the dashboard to the login page instead
  // of showing load errors. A layout effect, so it is in place before any effect
  // (this component's or a child's) makes the first requests.
  useLayoutEffect(() => {
    const original = window.fetch;
    // Bound: a browser's fetch called without window as `this` throws.
    const call = original.bind(window);
    const watched = watchSignOut(call, {
      clerk,
      onSignedOut: () => {
        // The saved snapshot goes too: a device signed out elsewhere (a
        // lost phone) must not keep painting balances, offline included.
        signedOut = true;
        try {
          localStorage.removeItem(cacheKey);
        } catch {
          // Best-effort.
        }
        window.location.href = clerk ? '/sign-in' : '/login';
      },
    });
    window.fetch = Object.assign(watched, original) as typeof window.fetch;
    return () => {
      window.fetch = original;
    };
  }, [clerk]);

  useEffect(() => {
    // Paint immediately from the last-known snapshot, then revalidate.
    try {
      // The shared password's unkeyed snapshot belongs to no one account.
      if (viewer) localStorage.removeItem(LOCAL_CACHE_KEY);
      const raw = localStorage.getItem(cacheKey);
      if (raw) {
        const snap = JSON.parse(raw);
        if (Array.isArray(snap.institutions)) {
          setInstitutions(snap.institutions);
          setNetWorth(snap.netWorth ?? 0);
          setHistory(Array.isArray(snap.history) ? snap.history : []);
          setHiddenMeta(Array.isArray(snap.hidden) ? snap.hidden : []);
          setAsOf(snap.as_of ?? null);
          setConnected(snap.institutions.length > 0);
          setLoading(false);
        }
      }
    } catch {
      // Corrupted snapshot -- ignore; the network load will replace it.
    }
    loadNetWorth();
  }, [loadNetWorth]);

  // A notice email links to /?view=connections: open the Accounts tab at the
  // connection health card, then drop the query, so a reload doesn't jump there.
  useEffect(() => {
    if (new URLSearchParams(window.location.search).get('view') !== 'connections') return;
    setTab('accounts');
    setHealthFocus(true);
    window.history.replaceState(null, '', window.location.pathname);
  }, []);

  // Everything else loads in parallel with net worth (no waterfall): transactions
  // feed Activity and insights, budgets/goals feed the Budgets tab. All are cheap
  // on the server (cached or Redis-only) and empty when nothing is connected.
  useEffect(() => {
    loadTransactions();
    budgetsStore.load();
    goalsStore.load();
    plannedItemsStore.load();
  }, [loadTransactions, budgetsStore, goalsStore, plannedItemsStore]);

  const renameVendor = useCallback(
    async (vendor_key: string, name: string) => {
      // Optimistically relabel every transaction from this vendor. An empty
      // name clears the rename; we can't reconstruct the original Plaid name
      // locally, so reload to pick the reverted names back up.
      if (name) {
        setTxns((prev) =>
          prev
            ? prev.map((t) => (t.vendor_key === vendor_key ? { ...t, name } : t))
            : prev
        );
      }
      try {
        const res = await fetch('/api/rename', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ vendor_key, name }),
        });
        // Re-sync on a clear (to recover the reverted Plaid names) or on a
        // rejected write, so the optimistic change can't linger out of sync.
        if (!name || !res.ok) loadTransactions();
      } catch {
        loadTransactions(); // network failure: reload to server truth
      }
    },
    [loadTransactions]
  );

  // Transactions entered by hand, categories and the exclude flag
  // (components/transaction-edits.ts).
  const txnEdits = useTransactionEdits({
    txns,
    setTxns,
    setTxnNotes,
    setTxnIncomplete,
    setTxnWithout,
    loadTransactions,
    loadNetWorth,
    requestBackfill,
  });

  // `kind` is which way to connect (app/api/create-link-token). `bypass` skips
  // both duplicate checks for this run: the user has said the institution they
  // already have is a different login.
  const beginConnect = useCallback(async (kind: LinkKind, bypass: boolean) => {
    setError('');
    setConnecting(true);
    bypassDuplicateRef.current = bypass;
    redirectingRef.current = false;
    connectKindRef.current = kind;
    // Whatever happens (no network, an answer that isn't JSON), the buttons
    // come back: left on "Starting…", nothing could be connected.
    try {
      const res = await fetch('/api/create-link-token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind }),
      });
      const data = await res.json().catch(() => ({}));
      if (data.link_token) {
        setLinkMode('new');
        setLinkToken(data.link_token);
      } else {
        setError('Could not start connection.');
      }
    } catch {
      setError('Could not start connection.');
    } finally {
      setConnecting(false);
    }
  }, []);
  const startConnect = useCallback((kind: LinkKind) => beginConnect(kind, false), [beginConnect]);

  // Link's account picker on an existing Item, to add (or remove) accounts at an
  // institution already connected without creating a second Item.
  const startManageAccounts = useCallback(async (item_id: string) => {
    setError('');
    setConnecting(true);
    redirectingRef.current = false;
    updatingItemRef.current = null;
    const res = await fetch('/api/create-update-link-token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ item_id, select_accounts: true }),
    });
    const data = await res.json().catch(() => ({}));
    setConnecting(false);
    if (data.link_token) {
      updatingItemRef.current = { item_id, opened_at: data.opened_at ?? '' };
      setLinkMode('accounts');
      setLinkToken(data.link_token);
    } else {
      setError(data.error || 'Could not open account selection.');
    }
  }, []);

  const startReconnect = useCallback(async (item_id: string) => {
    setError('');
    setConnecting(true);
    redirectingRef.current = false;
    const res = await fetch('/api/create-update-link-token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ item_id }),
    });
    const data = await res.json();
    setConnecting(false);
    if (data.link_token) {
      reconnectingItemRef.current = item_id;
      setLinkMode('update');
      setLinkToken(data.link_token);
    } else {
      setError('Could not start reconnection.');
    }
  }, []);

  // Asks for consent to share transactions on a connection whose transactions
  // weren't allowed (lib/no-transactions.ts, no_consent): update mode with the
  // consent request (app/api/create-update-link-token, allow_transactions).
  // Its success goes the way of a Reconnect's: the server forgets the refusal
  // (app/api/item-reconnected), and the reload asks Plaid again.
  const startAllowTransactions = useCallback(async (item_id: string) => {
    setError('');
    setConnecting(true);
    redirectingRef.current = false;
    try {
      const res = await fetch('/api/create-update-link-token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ item_id, allow_transactions: true }),
      });
      const data = await res.json().catch(() => ({}));
      if (data.link_token) {
        reconnectingItemRef.current = item_id;
        setLinkMode('update');
        setLinkToken(data.link_token);
      } else {
        setError('Could not start allowing transactions.');
      }
    } catch {
      setError('Could not start allowing transactions.');
    } finally {
      setConnecting(false);
    }
  }, []);

  // Adds the liabilities product to an Item that was linked without it. Goes
  // through Link's update mode, so it re-authenticates the SAME Item rather
  // than creating a new one -- the stored transaction history survives.
  const startEnableLiabilities = useCallback(async (item_id: string) => {
    setError('');
    setConnecting(true);
    redirectingRef.current = false;
    const res = await fetch('/api/create-update-link-token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ item_id, add_liabilities: true }),
    });
    const data = await res.json();
    setConnecting(false);
    if (data.link_token) {
      reconnectingItemRef.current = item_id;
      setLinkMode('update');
      setLinkToken(data.link_token);
    } else {
      // The route names the institution-doesn't-support-it case specifically,
      // which is the likely one here and not something a retry fixes.
      setError(data.error || 'Could not start enabling payment details.');
    }
  }, []);

  const performDisconnect = useCallback(
    async (item_id: string) => {
      setDisconnecting(true);
      setError('');
      try {
        const res = await fetch('/api/disconnect', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ item_id }),
        });
        if (!res.ok) throw new Error('failed');
        setDisconnectTarget(null);
        loadNetWorth(true);
        if (txns !== null) loadTransactions(true);
      } catch {
        setError('Could not disconnect account.');
      } finally {
        setDisconnecting(false);
      }
    },
    [loadNetWorth, loadTransactions, txns]
  );

  /**
   * One manual-account mutation. Every call names a single account, so a stale
   * page can only affect the account it acted on: it can't delete accounts it
   * doesn't know about or revert a balance a scheduled push to
   * /api/ingest/balance wrote meanwhile.
   */
  const mutateManual = useCallback(
    async (method: 'POST' | 'PATCH' | 'DELETE', body: unknown) => {
      setSavingManual(true);
      setManualError('');
      try {
        const res = await fetch('/api/manual-accounts', {
          method,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        if (!res.ok) {
          const data = await res.json().catch(() => null);
          setManualError(data?.error ?? 'Could not save. Please try again.');
          return false;
        }
        setManualDraft(null);
        setManualDeleteTarget(null);
        // A forced fetch writes the new balance into today's history point, as the
        // disconnect flow does. Then recompute estimated history, which the save
        // invalidated server-side (the automatic backfill only fires when history
        // is thin).
        await loadNetWorth(true);
        requestBackfill(() => loadNetWorth());
        // Its transactions carry its name, and go with it when it is deleted.
        loadTransactions();
        return true;
      } catch {
        setManualError('Could not reach the server.');
        return false;
      } finally {
        setSavingManual(false);
      }
    },
    [loadNetWorth, requestBackfill, loadTransactions]
  );

  const startAddManual = useCallback(() => {
    setManualError('');
    setEditingManual(false);
    // The id is minted server-side on create, so a draft doesn't carry one.
    setManualDraft({
      account_id: null,
      name: '',
      institution_name: '',
      type: 'depository',
      subtype: null,
      balance: '',
    });
  }, []);

  const startEditManual = useCallback((account: ManualAccount) => {
    setManualError('');
    setEditingManual(true);
    setManualDraft({ ...account, balance: String(account.balance) });
  }, []);

  const submitManualDraft = useCallback(() => {
    if (!manualDraft) return;
    const payload = {
      name: manualDraft.name,
      institution_name: manualDraft.institution_name,
      type: manualDraft.type,
      subtype: manualDraft.subtype,
      balance: Number(manualDraft.balance),
    };
    if (manualDraft.account_id) {
      mutateManual('PATCH', { ...payload, account_id: manualDraft.account_id });
    } else {
      mutateManual('POST', payload);
    }
  }, [manualDraft, mutateManual]);

  // What a sign-out through Clerk clears first (components/ClerkAccount.tsx).
  const clearDevice = useCallback(() => {
    signedOut = true; // no load still in flight may save the snapshot again
    try {
      localStorage.removeItem(cacheKey);
    } catch {
      // Best-effort; the snapshot only lives on this device anyway.
    }
  }, []);

  const logout = useCallback(async () => {
    signedOut = true; // no load still in flight may save the snapshot again
    try {
      localStorage.removeItem(cacheKey);
    } catch {
      // Best-effort; the snapshot only lives on this device anyway.
    }
    await fetch('/api/logout', { method: 'POST' });
    window.location.href = '/login';
  }, []);

  // Ends every session for this data, on every device, this one included
  // (lib/sessions.ts). The other devices are sent to the login page on their
  // next request.
  const signOutEverywhere = useCallback(async () => {
    if (!window.confirm('Sign out on every device, including this one?')) return;
    const res = await fetch('/api/logout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ everywhere: true }),
    }).catch(() => null);
    if (!res?.ok) {
      const message = await res?.json().then((b) => b?.error).catch(() => null);
      window.alert(message || 'Could not sign out other devices. Try again.');
      return;
    }
    signedOut = true; // as in logout
    try {
      localStorage.removeItem(cacheKey);
    } catch {
      // Best-effort.
    }
    window.location.href = '/login';
  }, []);


  const onSuccess = useCallback(
    async (public_token: string, metadata: PlaidLinkOnSuccessMetadata) => {
      linkOpenRef.current = false;
      if (linkMode === 'update') {
        // Update mode re-authenticates the existing Item -- no new Item is
        // created and the access token doesn't change, so there's nothing
        // to exchange. Clear the token, tell the server the connection was
        // repaired (its "Reconnect soon" warning and any email about a break
        // are done with), then refresh.
        setLinkToken(null);
        const repaired = reconnectingItemRef.current;
        reconnectingItemRef.current = null;
        if (repaired) {
          await fetch('/api/item-reconnected', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ item_id: repaired }),
          }).catch(() => null);
        }
        loadNetWorth(true);
        // Transactions allowed just now come in on this load.
        if (txns !== null) loadTransactions(true);
        return;
      }

      if (linkMode === 'accounts') {
        // The account picker changed which accounts the Item shares. The token
        // is unchanged; the server reconciles what it remembers about the Item
        // (app/api/item-accounts-updated) before the reload reads it.
        setLinkToken(null);
        const picker = updatingItemRef.current;
        const res = picker
          ? await fetch('/api/item-accounts-updated', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(picker),
            }).catch(() => null)
          : null;
        const summary = res?.ok ? await res.json().catch(() => null) : null;
        // Unreconciled, a removed account would pause history at the next load
        // as if it had vanished. Running the picker again finishes the job.
        if (!res?.ok) setError('Could not update the account list. Open "Add or remove accounts" again to finish.');
        loadNetWorth(true);
        if (txns !== null) loadTransactions(true);
        // Only an addition cleared the backfill flag (a removal must not rebuild
        // past estimates), so only then is there anything to recompute.
        if (summary?.added > 0) requestBackfill(() => loadNetWorth());
        return;
      }

      const institutionName = metadata.institution?.name || 'Connected Account';
      // Skipped when the user already said this is a different login.
      const isDuplicate =
        !bypassDuplicateRef.current &&
        existingItemsAt(institutions, {
          institution_id: metadata.institution?.institution_id,
          name: metadata.institution?.name,
        }).length > 0;
      if (isDuplicate) {
        const proceed = window.confirm(
          `You already have an account connected to ${institutionName}. Link another one anyway?`
        );
        if (!proceed) {
          // We never call exchange-public-token, so the unused public_token
          // simply expires -- no Plaid Item gets created.
          setLinkToken(null);
          return;
        }
      }

      await fetch('/api/exchange-public-token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ public_token, institution_name: institutionName }),
      });
      setConnected(true);
      setLinkToken(null);
      loadNetWorth(true);
      if (txns !== null) loadTransactions(true);
      // The exchange route cleared the server's backfill flag, so this
      // recomputes estimated history with the new institution included.
      requestBackfill(() => loadNetWorth());
    },
    [linkMode, institutions, loadNetWorth, loadTransactions, requestBackfill, txns]
  );

  // Stops a new connection at an institution already connected, before the user
  // enters credentials, and offers to add accounts to the existing Item instead.
  // A second Item for the same login is billed separately and would duplicate
  // every account.
  //
  // The handler keeps the callbacks from the render that made it, and the `exit`
  // that render saw belongs to the previous handler, so exit goes through a ref
  // kept current below.
  const onEvent = useCallback(
    (eventName: string, metadata: PlaidLinkOnEventMetadata) => {
      if (eventName !== 'SELECT_INSTITUTION' || linkMode !== 'new' || bypassDuplicateRef.current) return;
      if (!linkOpenRef.current) return;
      const items = existingItemsAt(institutions, {
        institution_id: metadata.institution_id,
        name: metadata.institution_name,
      });
      if (items.length === 0) return;
      redirectingRef.current = true;
      setRedirect({ name: metadata.institution_name || items[0].institution_name, items, kind: connectKindRef.current });
      exitLinkRef.current({ force: true });
    },
    [linkMode, institutions]
  );

  const { open, ready, exit } = usePlaidLink({
    token: linkToken,
    onSuccess,
    onEvent,
    onExit: (err) => {
      linkOpenRef.current = false;
      // Closed by onEvent above: not a cancellation, and the redirect sheet
      // says what happens next.
      if (redirectingRef.current) {
        redirectingRef.current = false;
      } else if (err) {
        setError('Connection cancelled or failed.');
      }
      setLinkToken(null);
    },
  });
  useLayoutEffect(() => {
    exitLinkRef.current = exit as (opts?: { force?: boolean }) => void;
  }, [exit]);

  // Open Link automatically as soon as a fresh token is ready
  useEffect(() => {
    if (linkToken && ready) {
      linkOpenRef.current = true;
      open();
    }
  }, [linkToken, ready, open]);

  const toggleAccount = useCallback((account_id: string) => {
    setExpandedAccounts((prev) => {
      const next = new Set(prev);
      if (next.has(account_id)) next.delete(account_id);
      else next.add(account_id);
      return next;
    });
  }, []);

  const toggleHoldings = useCallback((item_id: string) => {
    setExpandedHoldings((prev) => {
      const next = new Set(prev);
      if (next.has(item_id)) next.delete(item_id);
      else next.add(item_id);
      return next;
    });
  }, []);

  const refreshAll = useCallback(() => {
    loadNetWorth(true);
    if (txns !== null) loadTransactions(true);
    // Retry a list that could not be loaded. One that loaded is left alone:
    // reloading it mid-edit would only risk replacing what is on screen.
    if (budgetsStore.get().status === 'error' && !budgetsStore.get().saving) budgetsStore.load();
    if (goalsStore.get().status === 'error' && !goalsStore.get().saving) goalsStore.load();
  }, [loadNetWorth, loadTransactions, txns, budgetsStore, goalsStore]);

  // What the hero total is missing, named (components/total-notes.ts). Surfaced
  // on the hero, not just on the cards: the number someone actually reads is
  // the total. In order: institutions showing recovered balances ("real but a
  // few days old"); recovered but short some rows; accounts that answered
  // before and didn't this time, at institutions otherwise fine (history is
  // paused until that resolves); and institutions that failed and could NOT be
  // recovered, so the total is short by all of each. Those last are MORE wrong
  // than the stale ones, so every such case is said, with when it was last seen.
  const missingNotes = useMemo(
    () => totalNotes(institutions, { snapshot: fmtStaleDay, instant: fmtInstantDay }),
    [institutions]
  );

  // Connections Plaid says will end on a date, for the Home alert (Insights).
  const reconnectSoon = useMemo(
    () =>
      institutions.flatMap((i) =>
        i.health?.state === 'reconnect_soon' && i.health.ends_at
          ? [{ item_id: i.item_id, institution_name: i.institution_name, ends_at: i.health.ends_at, ends_estimated: i.health.ends_estimated }]
          : []
      ),
    [institutions]
  );
  // Connections whose transactions have stopped arriving, for Activity's months.
  // Not a connection that holds no bank account or card: it brings no
  // transactions in, so its lapse leaves no month short (lib/no-transactions.ts).
  const stoppedTxns = useMemo(() => stoppedConnections(institutions, quietItemIds(txnWithout)), [institutions, txnWithout]);
  // Connections whose transactions weren't allowed: their card offers to.
  const unallowedIds = useMemo(() => unallowedItemIds(txnWithout), [txnWithout]);

  // The last recorded day, when recording has stalled (see lib/history-status.ts).
  const pausedSince = useMemo(() => historyPausedSince(history, asOf), [history, asOf]);

  // 30-day (or available-span) net-worth delta for the hero stat tile.
  const heroDelta = useMemo(() => {
    if (history.length < 2) return null;
    const targetTs = Date.now() - 30 * 24 * 60 * 60 * 1000;
    let base = history[0]; // fall back to oldest when the series is short
    for (const p of history) {
      if (new Date(`${p.date}T00:00:00Z`).getTime() <= targetTs) base = p;
    }
    const current = history[history.length - 1];
    if (base.date === current.date || base.value === 0) return null;
    const value = current.value - base.value;
    const pct = (Math.abs(value) / Math.abs(base.value)) * 100;
    const days = Math.round(
      (new Date(`${current.date}T00:00:00Z`).getTime() -
        new Date(`${base.date}T00:00:00Z`).getTime()) /
        (24 * 60 * 60 * 1000)
    );
    return { value, pct, days };
  }, [history]);

  // Plaid returns institutions/accounts in no guaranteed order; sort by name so
  // the Accounts tab renders the same every load.
  //
  // Hidden accounts are dropped here and surface in the Hidden card. An
  // institution is only removed once it has nothing left to show: one whose
  // accounts are ALL hidden goes, but one that simply failed to load keeps its
  // (empty) account list so its error and Reconnect button still render.
  const sortedInstitutions = useMemo(
    () =>
      [...institutions]
        .sort((a, b) => a.institution_name.localeCompare(b.institution_name))
        .map((inst) => {
          const hiddenIds = new Set(
            inst.accounts.filter((a) => a.hidden).map((a) => a.account_id)
          );
          return {
            ...inst,
            accounts: [...inst.accounts]
              .filter((a) => !a.hidden)
              .sort((a, b) => a.name.localeCompare(b.name)),
            // Holdings belong to a parent account, so hiding a brokerage has to
            // take its positions with it. Holdings from a payload cached before
            // this existed have no account_id and are kept.
            holdings: inst.holdings.filter(
              (h) => !h.account_id || !hiddenIds.has(h.account_id)
            ),
          };
        })
        .filter(
          (inst) =>
            inst.accounts.length > 0 ||
            inst.holdings.length > 0 ||
            !!inst.error ||
            // Keep an entirely-hidden institution visible in manage mode, or
            // its Disconnect button would be unreachable and the only way to
            // remove it would be to unhide every account first.
            (manageMode && !inst.manual)
        ),
    [institutions, manageMode]
  );

  // Investment accounts carrying enough uninvested cash to be worth a Home-tab
  // line. Built from `institutions`, not `sortedInstitutions`, which manage mode
  // also filters: an insight shouldn't come and go with a UI toggle on another
  // tab. Hidden accounts are dropped, as from every total.
  const idleCashAccounts = useMemo(() => {
    const out: IdleCashAccount[] = [];
    for (const inst of institutions) {
      // Hidden accounts are dropped BEFORE the verdict rather than after, so
      // institutionCash sees exactly what the Accounts tab sees: same rule,
      // same exemptions, same answer on both tabs.
      const visible = inst.accounts.filter((a) => !a.hidden);
      const hiddenIds = new Set(
        inst.accounts.filter((a) => a.hidden).map((a) => a.account_id)
      );
      const { byAccount, flaggedAccounts } = institutionCash(
        visible,
        inst.holdings.filter((h) => !h.account_id || !hiddenIds.has(h.account_id))
      );
      for (const a of visible) {
        if (!flaggedAccounts.has(a.account_id)) continue;
        const cash = byAccount[a.account_id];
        out.push({
          // Carries the id, institution and mask because account names aren't
          // distinctive ("Individual", "Roth IRA"), and two would otherwise
          // produce a duplicate React key and two identical, unactionable lines.
          account_id: a.account_id,
          name: a.name,
          mask: a.mask,
          institution_name: inst.institution_name,
          cash: cash.cash,
          // Null where the denominator is degenerate (a margin debit bigger than
          // the positions), so the insight drops the phrase rather than claiming
          // "100% of its holdings" for an account also holding a short. The
          // Accounts tab badge suppresses it the same way.
          share: cash.total > 0 ? cash.share : null,
          currency: a.currency,
        });
      }
    }
    return out.sort((x, y) => y.cash - x.cash);
  }, [institutions]);

  // Hidden accounts for the Hidden card, built from the STORED set, not whatever
  // resolved this load: an erroring institution returns no accounts, and
  // deriving from the live list would make its hidden accounts vanish (still
  // hidden, still subtracted from history, with no Unhide button anywhere).
  const hiddenAccounts = useMemo(() => {
    const live = new Map(
      institutions.flatMap((i) =>
        i.accounts
          .filter((a) => a.hidden)
          .map((a) => [a.account_id, { account: a, institution_name: i.institution_name }] as const)
      )
    );
    return hiddenMeta
      .map(({ account_id, type, label, disconnected }) => {
        const resolved = live.get(account_id);
        if (resolved) return { ...resolved, resolved: true };
        // Hidden, but not in this load: its institution didn't answer, or was
        // disconnected (a hidden account stays hidden past a disconnect). Render
        // what we stored so it can still be unhidden.
        return {
          account: {
            account_id,
            name: label ?? 'Unavailable account',
            type,
            subtype: null,
            balance: null,
            currency: null,
            hidden: true,
          } as Account,
          institution_name: disconnected ? 'Disconnected' : 'Not loaded',
          resolved: false,
        };
      })
      .sort((a, b) => a.account.name.localeCompare(b.account.name));
  }, [institutions, hiddenMeta]);

  const toggleHidden = useCallback(
    async (account_id: string, hidden: boolean) => {
      setError('');
      // Guarded like the adjacent manual-account actions: each toggle triggers
      // a full refresh, so repeated taps would queue several of them.
      setTogglingHidden(account_id);
      try {
        const res = await fetch('/api/hidden-accounts', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ account_id, hidden }),
        });
        const data = await res.json().catch(() => null);
        if (!res.ok) {
          setError(data?.error ?? 'Could not update hidden accounts.');
          return;
        }
        await loadNetWorth(true);
        // Hidden accounts' transactions must leave the Activity tab too. Guarded
        // like every other refresh here, so this can't kick off a first-ever
        // Plaid sync from the Accounts tab.
        if (txns !== null) loadTransactions(true);
        // The estimated layer doesn't know this account, so it can't subtract it
        // and would sit high by its balance with a step at the estimated/real
        // seam. The server cleared the backfill flag; running the recompute is on
        // us, since the automatic one only fires when history is thin.
        if (data?.recompute) requestBackfill(() => loadNetWorth());
      } catch {
        setError('Could not update hidden accounts.');
      } finally {
        setTogglingHidden(null);
      }
    },
    [loadNetWorth, loadTransactions, requestBackfill, txns]
  );

  // One currency to label summed account figures (net worth, deltas). Accounts
  // can differ, so use the most common code and flag a genuine mix rather than
  // implying an FX-converted total. Hidden accounts are excluded: a hidden EUR
  // account must not make Home announce "Accounts use multiple currencies" with
  // no such account on screen.
  const allAccounts = useMemo(
    () => institutions.flatMap((i) => i.accounts.filter((a) => !a.hidden)),
    [institutions]
  );
  const accountCurrency = useMemo(
    () => dominantCurrency(allAccounts.map((a) => ({ iso_currency_code: a.currency }))),
    [allAccounts]
  );
  const mixedAccountCurrency = useMemo(() => {
    const seen = new Set<string>();
    for (const a of allAccounts) if (a.currency) seen.add(a.currency);
    return seen.size > 1;
  }, [allAccounts]);

  // Counts what's rendering, so hiding an institution's last account doesn't
  // leave "3 institutions connected" above two cards, and a fully hidden set
  // doesn't read "0 institutions connected" as if nothing were linked.
  const shownInstitutionCount = sortedInstitutions.length;
  const subtitle = loading
    ? 'Loading your accounts…'
    : !connected
      ? 'Connect your bank, credit card, and brokerage accounts'
      : shownInstitutionCount === 0 && hiddenAccounts.length > 0
        ? `All ${hiddenAccounts.length} account${hiddenAccounts.length === 1 ? '' : 's'} hidden`
        : `${shownInstitutionCount} institution${shownInstitutionCount === 1 ? '' : 's'} connected`;

  return (
    <>
      <main className="wrap">
        <div className="top-row">
          <div>
            <div className="brand">
              {/* eslint-disable-next-line @next/next/no-img-element -- the app icon, already a static SVG */}
              <img className="brand-logo" src="/icon.svg" alt="" width={34} height={34} />
              <h1>Nya</h1>
            </div>
            <p className="sub">{subtitle}</p>
          </div>
          <div className="top-actions">
            {connected && !loading && (
              <button
                className="secondary icon-btn"
                onClick={refreshAll}
                disabled={refreshing}
                aria-label="Refresh"
                title="Refresh"
              >
                <svg
                  className={refreshing ? 'spin' : undefined}
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth={1.8}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  <path d="M20 12a8 8 0 1 1-2.35-5.65M20 4v4h-4" />
                </svg>
              </button>
            )}
            {clerk ? (
              <ClerkAccount clearDevice={clearDevice} onOpenSharing={() => setSharingOpen(true)} />
            ) : (
              <>
                <button className="secondary logout-btn" onClick={logout}>
                  Log out
                </button>
                <button className="secondary logout-btn" onClick={signOutEverywhere} title="Sign out on every device">
                  Sign out everywhere
                </button>
              </>
            )}
          </div>
        </div>

        {loading ? (
          <div className="card">
            <div className="spinner" role="status" aria-label="Loading" />
          </div>
        ) : !connected ? (
          <>
            <div className="card">
              <ConnectButtons connecting={connecting} onConnect={startConnect} brokerage={brokerageLink} />
              <CoverageNote />
              {/* Also offered here, not just on the Accounts tab: with nothing
                  connected the tab bar is hidden, so this is the only reachable
                  entry point for someone whose bank Plaid doesn't support at all. */}
              <div className="action-row">
                <button className="secondary" onClick={startAddManual} disabled={savingManual}>
                  <ActionIcon d="M12 5v14M5 12h14" />
                  Add manual
                </button>
                {clerk && (
                  <button className="secondary" onClick={() => setSharingOpen(true)}>
                    <ActionIcon d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" />
                    Sharing
                  </button>
                )}
              </div>
              <p className="empty-note">
                Manual accounts are for institutions Plaid can&apos;t reach. You type the balance and
                update it whenever you like; it counts toward net worth and builds its own history.
              </p>
              {error && <div className="error">{error}</div>}
            </div>
            {/* Someone who only follows what others share needs no bank of their own. */}
            {clerk && <SharedWithMe refreshKey={asOf} />}
          </>
        ) : (
          <>
            {tab === 'home' && (
              <>
                <div className="card">
                  <div className="total-label">Net Worth</div>
                  <div className={`total-value${netWorth < 0 ? ' negative' : ''}`}>
                    {fmt(netWorth, accountCurrency)}
                  </div>
                  {heroDelta && (
                    <div className={`hero-delta${heroDelta.value >= 0 ? ' up' : ' down'}`}>
                      {heroDelta.value >= 0 ? '▲' : '▼'} {fmt(Math.abs(heroDelta.value), accountCurrency)} (
                      {heroDelta.pct.toFixed(1)}%) · past {heroDelta.days} days
                    </div>
                  )}
                  {mixedAccountCurrency && (
                    <div className="as-of">
                      Accounts use multiple currencies; totals aren&apos;t converted.
                    </div>
                  )}
                  {asOf && (
                    <div className="as-of">
                      Updated {fmtAsOf(asOf)}
                      {refreshing ? ' · refreshing…' : ''}
                    </div>
                  )}
                  {missingNotes.map((note) => (
                    <div className="as-of stale" key={note}>
                      {note}
                    </div>
                  ))}
                </div>

                <div className="card">
                  <div className="inst-header">
                    <div className="inst-name">Over time</div>
                  </div>
                  {history.length >= 2 ? (
                    <NetWorthChart points={history} />
                  ) : (
                    <p className="empty-note">
                      History builds as you use the app — check back tomorrow for your first
                      trend line.
                    </p>
                  )}
                  {backupProblem && (
                    <div className="stale-note">
                      {backupProblem.reason ? 'The nightly backup failed' : 'The nightly backup hasn’t run'}
                      {backupProblem.last_ok ? `; the last one saved was on ${fmtInstantDay(backupProblem.last_ok)}.` : '; none has been saved yet.'}
                      {backupProblem.reason ? ` (${backupProblem.reason})` : ''} Check the backup cron in Vercel.
                    </div>
                  )}
                  {pausedSince && (
                    <div className="stale-note">
                      No net-worth total has been saved since {fmtDay(pausedSince)}. A day
                      is only saved when every institution refreshes with all of its accounts, so
                      it picks up again once they do.
                    </div>
                  )}
                </div>

                <Insights
                  txns={txns}
                  budgets={budgets}
                  idleCash={idleCashAccounts}
                  reconnectSoon={reconnectSoon}
                  withoutTransactions={txnWithout}
                  recurringHistory={txnHistory}
                  dismissed={plannedState.status === 'ready' ? plannedState.value.dismissed : undefined}
                  accounts={institutions.flatMap((i) =>
                    i.accounts
                      .filter((a) => !a.hidden)
                      .map((a) => ({
                        name: a.name,
                        type: a.type,
                        balance: a.balance,
                        currency: a.currency,
                        liability: a.liability,
                      }))
                  )}
                />
                {error && <div className="error">{error}</div>}
              </>
            )}

            {tab === 'accounts' && (
              <>
                <div className="card">
                  <ConnectButtons connecting={connecting} onConnect={startConnect} brokerage={brokerageLink} />
                  <CoverageNote />
                  {/* Equal widths, icon over label, so Manage and Done take
                      the same space and nothing shifts when it toggles. */}
                  <div className="action-row">
                    <button className="secondary" onClick={startAddManual} disabled={savingManual}>
                      <ActionIcon d="M12 5v14M5 12h14" />
                      Add manual
                    </button>
                    {clerk && (
                      <button className="secondary" onClick={() => setSharingOpen(true)}>
                        <ActionIcon d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" />
                        Sharing
                      </button>
                    )}
                    {/* Whenever there is a card or loan on screen to plan. */}
                    {allAccounts.some((a) => isOwedType(a.type)) && (
                      <button className="secondary" onClick={() => setPayoffOpen(true)}>
                        <ActionIcon d="M22 17 13.5 8.5l-5 5L2 7M16 17h6v-6" />
                        Payoff plan
                      </button>
                    )}
                    <button className="secondary" onClick={() => setManageMode((m) => !m)} aria-pressed={manageMode}>
                      <ActionIcon d={manageMode ? 'M20 6 9 17l-5-5' : 'M12 20h9M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z'} />
                      {manageMode ? 'Done' : 'Manage'}
                    </button>
                  </div>
                  {error && <div className="error">{error}</div>}
                </div>

                {/* Every linked institution's health, last good sync and the
                    action for it, in one place. Open whenever one needs
                    attention, and from a notice email's link. */}
                <ConnectionHealth
                  institutions={institutions}
                  unavailable={healthUnavailable}
                  connecting={connecting}
                  focus={healthFocus}
                  onFocused={clearHealthFocus}
                  onReconnect={startReconnect}
                  onManageAccounts={startManageAccounts}
                  onRemove={(item_id) => {
                    const target = institutions.find((i) => i.item_id === item_id);
                    if (!target) return;
                    setDisconnectInput('');
                    setDisconnectTarget(target);
                  }}
                />

                {/* Behind Manage accounts, like the other account upkeep, so
                    it doesn't take space in the everyday view; mounting only
                    then also skips its history read until it is wanted. Within
                    it, renders only when there is a reconnected account to link
                    or a link to undo. A change reloads live, since links alter
                    hidden accounts and per-account history. */}
                {manageMode && <AccountLinks onChanged={() => loadNetWorth(true)} refreshKey={asOf} />}

                {/* The admin's list of connections, across every account, that
                    cost money and do nothing. Only ever mounted for the admin (decided
                    on the server in app/page.tsx); the route also refuses
                    anyone else. Removal is confirmed inside it. */}
                {manageMode && admin && <AdminUnusedItems onRemoved={() => loadNetWorth(true)} />}

                {sortedInstitutions.map((inst) => {
                  // One verdict for the row badge, the per-holding chip and the
                  // Holdings header, so they can't disagree about the same money.
                  // `inst` is already filtered, so a hidden brokerage takes its
                  // cash with it.
                  const instCash = institutionCash(inst.accounts, inst.holdings);
                  const instTotal = inst.accounts.reduce((sum, a) => sum + signedBalance(a), 0);
                  const instCurrency = dominantCurrency(
                    inst.accounts.map((a) => ({ iso_currency_code: a.currency }))
                  );
                  const instMixed =
                    new Set(inst.accounts.map((a) => a.currency).filter(Boolean)).size > 1;
                  return (
                    <div className="card" key={inst.item_id}>
                      <div className="inst-header">
                        <div className="inst-name">
                          {inst.institution_name}
                          {inst.manual && <span className="manual-badge">Manual</span>}
                        </div>
                        <div className="inst-header-right">
                          <div className="inst-total">{fmt(instTotal, instCurrency)}</div>
                          {/* Manual groupings aren't Plaid Items, so there's
                              nothing to disconnect; they're removed per account. */}
                          {manageMode && !inst.manual && (
                            <button
                              className="disconnect-btn"
                              onClick={() => {
                                setDisconnectInput('');
                                setDisconnectTarget(inst);
                              }}
                              aria-label={`Disconnect ${inst.institution_name}`}
                            >
                              Disconnect
                            </button>
                          )}
                        </div>
                      </div>

                      {instMixed && (
                        <div className="chart-note">
                          Mixed currencies; total isn&apos;t converted.
                        </div>
                      )}

                      {inst.accounts.length > 0 && (
                        <table>
                          <tbody>
                            {inst.accounts.map((a) => {
                              const util =
                                a.type === 'credit' && a.limit && a.limit > 0 && a.balance != null
                                  ? Math.max(a.balance, 0) / a.limit
                                  : null;
                              const liabLine = liabilitySummary(a);
                              // Undefined on an account that is cash by design:
                              // institutionCash drops those, since 100% cash in a
                              // cash management account is the account working.
                              const cash = instCash.byAccount[a.account_id];
                              return (
                                <Fragment key={a.account_id}>
                                <tr
                                  className="acct-row"
                                  onClick={() => toggleAccount(a.account_id)}
                                  aria-expanded={expandedAccounts.has(a.account_id)}
                                >
                                  <td>
                                    {a.name}
                                    {a.mask && <span className="acct-mask"> ••{a.mask}</span>}
                                    <div className="type-tag">
                                      {a.official_name && a.official_name !== a.name
                                        ? `${a.official_name} · `
                                        : ''}
                                      {a.subtype || a.type}
                                    </div>
                                    {/* A Plaid balance is implicitly "now"; a
                                        typed one has to say when it was set. */}
                                    {inst.manual && a.updated_at && (
                                      <div className="manual-updated">
                                        Updated {fmtAsOf(a.updated_at)}
                                      </div>
                                    )}
                                    {util != null && (
                                      <div className="util">
                                        <div className={`meter-track${util >= 0.9 ? ' over' : util >= 0.5 ? ' warn' : ''}`}>
                                          <div
                                            className={`meter-fill${util >= 0.9 ? ' over' : util >= 0.5 ? ' warn' : ''}`}
                                            style={{ width: `${Math.min(util * 100, 100)}%` }}
                                          />
                                        </div>
                                        <span className="util-label">
                                          {Math.round(util * 100)}% of {fmt(a.limit, a.currency)} limit
                                        </span>
                                      </div>
                                    )}
                                    {liabLine && (
                                      <div
                                        className={`type-tag${a.liability?.is_overdue ? ' over-tag' : ''}`}
                                      >
                                        {a.liability?.is_overdue ? 'Overdue · ' : ''}
                                        {liabLine}
                                      </div>
                                    )}
                                    {/* Money sitting in the settlement fund
                                        rather than invested. Always shown when
                                        there is any, because a small cash line
                                        is information; the amber treatment is
                                        reserved for an amount worth acting on
                                        (lib/cash.ts), so the colour keeps
                                        meaning something. */}
                                    {cash && cash.cash > 0 && (
                                      <div className={`cash-tag${cash.flagged ? ' idle' : ''}`}>
                                        {cash.flagged && (
                                          <span className="cash-dot" aria-hidden="true" />
                                        )}
                                        {fmt(cash.cash, a.currency)}
                                        {cash.flagged ? ' uninvested' : ' in cash'}
                                        {/* "of holdings", not "of this
                                            account": the denominator is the
                                            positions Plaid priced, which can
                                            fall short of the balance rendered
                                            in the next column. */}
                                        {/* Says whose share it is: "0.0% of
                                            holdings" alone read as "0%
                                            invested", the opposite of what it
                                            meant. And never 0.0% while there
                                            is cash to show. */}
                                        {cash.total > 0 && ` · cash is ${cashSharePct(cash.share)} of holdings`}
                                      </div>
                                    )}
                                  </td>
                                  <td className="num">
                                    {fmt(signedBalance(a), a.currency)}
                                    {(inst.manual || manageMode) && (
                                      // stopPropagation so tapping an action
                                      // doesn't also toggle the history chart.
                                      <div
                                        className="manual-row-actions"
                                        onClick={(e) => e.stopPropagation()}
                                      >
                                        {inst.manual && (
                                          <button
                                            className="link-btn"
                                            disabled={savingManual || togglingHidden !== null}
                                            onClick={() =>
                                              startEditManual({
                                                account_id: a.account_id,
                                                name: a.name,
                                                institution_name: inst.institution_name,
                                                type: a.type,
                                                subtype: a.subtype,
                                                balance: a.balance ?? 0,
                                              })
                                            }
                                          >
                                            Update
                                          </button>
                                        )}
                                        {inst.manual && (
                                          <button className="link-btn" onClick={() => txnEdits.openAdd(a.account_id)}>
                                            Add transaction
                                          </button>
                                        )}
                                        {/* Hiding works on any account, linked
                                            or manual: it only stops the account
                                            counting, it doesn't remove it. */}
                                        {manageMode && (
                                          <button
                                            className="link-btn"
                                            disabled={togglingHidden !== null}
                                            onClick={() => toggleHidden(a.account_id, true)}
                                          >
                                            {togglingHidden === a.account_id ? 'Hiding…' : 'Hide'}
                                          </button>
                                        )}
                                        {inst.manual && manageMode && (
                                          <button
                                            className="link-btn danger-link"
                                            disabled={savingManual || togglingHidden !== null}
                                            onClick={() => {
                                              setManualError('');
                                              setManualDeleteTarget({
                                                account_id: a.account_id,
                                                name: a.name,
                                                institution_name: inst.institution_name,
                                                type: a.type,
                                                subtype: a.subtype,
                                                balance: a.balance ?? 0,
                                              });
                                            }}
                                          >
                                            Delete
                                          </button>
                                        )}
                                      </div>
                                    )}
                                  </td>
                                </tr>
                                {expandedAccounts.has(a.account_id) && (
                                  <tr>
                                    <td colSpan={2} className="acct-chart-cell">
                                      <AccountSparkline
                                        accountId={a.account_id}
                                        currency={a.currency}
                                        investment={isInvestmentType(a.type)}
                                        owed={isOwedType(a.type)}
                                        itemId={
                                          isInvestmentType(a.type) && !inst.manual
                                            ? inst.item_id
                                            : undefined
                                        }
                                      />
                                      {/* Since when its positions have been
                                          kept (lib/holdings-history.ts). A
                                          manual account has none to keep. */}
                                      {isInvestmentType(a.type) && !inst.manual && (
                                        <HoldingsRecorded accountId={a.account_id} />
                                      )}
                                      <LiabilityDetail liability={a.liability} currency={a.currency} />
                                      {/* Not for manual accounts: they're typed
                                          by hand, and their synthetic
                                          `manual:<name>` item_id doesn't
                                          resolve to a Plaid Item, so the fetch
                                          would 404 into a red error box under a
                                          perfectly healthy row. */}
                                      {isInvestmentType(a.type) && !inst.manual && (
                                        <InvestmentActivity
                                          accountId={a.account_id}
                                          itemId={inst.item_id}
                                        />
                                      )}
                                    </td>
                                  </tr>
                                )}
                              </Fragment>
                              );
                            })}
                          </tbody>
                        </table>
                      )}

                      {inst.holdings.length > 0 && (
                        <>
                          <button
                            className="holdings-toggle"
                            onClick={() => toggleHoldings(inst.item_id)}
                            aria-expanded={expandedHoldings.has(inst.item_id)}
                          >
                            <span className="holdings-title">
                              Holdings
                              <span className="holdings-count">{inst.holdings.length}</span>
                            </span>
                            <span className="holdings-summary">
                              {/* Says "uninvested", not "cash", because it is
                                  scoped the way the amber is: an account that
                                  is cash by design is left out of this figure,
                                  while its positions still carry their factual
                                  Cash label in the list below. */}
                              {instCash.cash > 0 && (
                                <span className={`cash-chip${instCash.flagged ? ' idle' : ''}`}>
                                  {fmt(instCash.cash, instCurrency)}{' '}
                                  {instCash.flagged ? 'uninvested' : 'cash'}
                                </span>
                              )}
                              {fmt(
                                inst.holdings.reduce((sum, h) => sum + (h.value ?? 0), 0),
                                instCurrency
                              )}
                              <svg
                                className={`chevron${expandedHoldings.has(inst.item_id) ? ' open' : ''}`}
                                viewBox="0 0 24 24"
                                fill="none"
                                stroke="currentColor"
                                strokeWidth={2}
                                strokeLinecap="round"
                                strokeLinejoin="round"
                                aria-hidden="true"
                              >
                                <path d="m6 9 6 6 6-6" />
                              </svg>
                            </span>
                          </button>
                          {expandedHoldings.has(inst.item_id) && (
                          <table>
                            <thead>
                              <tr>
                                <th>Security</th>
                                <th className="num">Qty</th>
                                <th className="num">Value</th>
                              </tr>
                            </thead>
                            <tbody>
                              {inst.holdings.map((h, i) => {
                                const isCash = isCashHolding(h);
                                return (
                                <tr key={i}>
                                  <td>
                                    {h.name}
                                    {/* The chip says WHICH row is cash; the
                                        amber says it's worth doing something
                                        about, and only the owning account can
                                        decide that. */}
                                    {isCash && (
                                      <span
                                        className={`cash-chip${
                                          h.account_id && instCash.flaggedAccounts.has(h.account_id)
                                            ? ' idle'
                                            : ''
                                        }`}
                                      >
                                        Cash
                                      </span>
                                    )}
                                  </td>
                                  <td className="num">{h.quantity?.toFixed(3) ?? '--'}</td>
                                  <td className="num">
                                    {fmt(h.value)}
                                    {/* No gain/loss on a cash line: a money
                                        market fund holds its $1 NAV, so the
                                        figure is a permanent "+$0.00 · 0.0%"
                                        that says nothing and reads as a real
                                        measurement of a flat investment. */}
                                    {!isCash && h.value != null && h.cost_basis != null && (
                                      <div
                                        className={`gain${h.value - h.cost_basis >= 0 ? ' inflow' : ' loss'}`}
                                      >
                                        {fmtGain(h.value, h.cost_basis)}
                                      </div>
                                    )}
                                  </td>
                                </tr>
                                );
                              })}
                            </tbody>
                          </table>
                          )}
                        </>
                      )}

                      {/* Plaid's week of notice that this connection will end:
                          the badge, the date and Reconnect, while it still works. */}
                      <ReconnectSoonNote inst={inst} connecting={connecting} onReconnect={startReconnect} />

                      {/* Recovering the balances adds a date to the error; it
                          does not replace the error. The distinction matters:
                          "could not fetch balances" usually clears itself,
                          while "needs to be reconnected" never does until you
                          act, and collapsing both into a soft "couldn't
                          refresh" would let a dead connection look healthy for
                          as long as the recovered numbers stay plausible --
                          the same failure this feature exists to prevent, moved
                          from the total to the label. So reauth keeps the red
                          treatment and its own wording, and only a transient
                          failure with real numbers behind it goes amber. */}
                      {inst.error && (
                        <div
                          className={
                            // Amber is for "real numbers, just dated". A card
                            // missing rows isn't that: its subtotal is wrong,
                            // not merely old, so it keeps the red treatment.
                            inst.stale_as_of && !inst.needs_reauth && !inst.stale_missing
                              ? 'stale-note'
                              : 'error'
                          }
                        >
                          {inst.error}
                          {inst.stale_as_of && ` · balances as of ${fmtStaleDay(inst.stale_as_of, inst.stale_as_of_at)}`}
                          {/* The shortfall is disclosed, not hidden: a card
                              drawn short understates debt, which overstates
                              net worth. Why a row is missing is unknowable
                              here (see lib/last-known.ts), so say the count
                              rather than guess at a reason. */}
                          {!!inst.stale_missing &&
                            ` · ${inst.stale_missing} account${
                              inst.stale_missing === 1 ? '' : 's'
                            } couldn't be shown, so this total is incomplete`}
                          {inst.stale_too_old &&
                            ` · last known balances are from ${fmtStaleDay(inst.stale_too_old, inst.stale_too_old_at)}, too old to show`}
                        </div>
                      )}

                      {/* Its own block, NOT part of the error above, because
                          there is no error: this institution answered and the
                          balances on the card are fresh. It just answered with
                          fewer accounts than it used to have, so the subtotal
                          is short and nothing is being written to history
                          until that resolves.

                          Amber rather than red for the same reason the stale
                          case is: the numbers shown are real. What is wrong is
                          that there are not all of them. */}
                      {!!inst.unconfirmed_missing && !inst.error && (
                        <div className="stale-note">
                          {inst.unconfirmed_missing} account
                          {inst.unconfirmed_missing === 1 ? '' : 's'} this institution used to
                          report {inst.unconfirmed_missing === 1 ? "isn't" : "aren't"} in its latest
                          response · this subtotal is short by{' '}
                          {inst.unconfirmed_missing === 1 ? 'it' : 'them'}, and history is paused
                          until the {inst.unconfirmed_missing === 1 ? 'account' : 'accounts'} either
                          come back or stay gone
                        </div>
                      )}

                      {/* Tells someone who just tapped Enable why the button
                          vanished without any payment details appearing. */}
                      {inst.liabilities === 'loading' && (
                        <p className="empty-note">
                          Payment details are still importing from this institution.
                        </p>
                      )}

                      {inst.new_accounts_available && !inst.manual && (
                        <p className="empty-note">
                          {inst.institution_name} has accounts you haven&apos;t added yet.
                        </p>
                      )}

                      {unallowedIds.has(inst.item_id) && (
                        <p className="empty-note">
                          You didn&apos;t allow Nya to see transactions from the bank or card accounts here.
                        </p>
                      )}

                      {/* One container, independent actions. Enable must NOT
                          sit inside a needs_reauth gate: a healthy institution
                          is exactly the case it exists for. */}
                      {(inst.needs_reauth ||
                        canEnableLiabilities(inst) ||
                        unallowedIds.has(inst.item_id) ||
                        (!inst.manual && (manageMode || inst.new_accounts_available))) && (
                        <div className="card-actions">
                          {inst.needs_reauth && (
                            <button onClick={() => startReconnect(inst.item_id)} disabled={connecting} aria-label={`Reconnect ${inst.institution_name}`}>
                              Reconnect
                            </button>
                          )}
                          {unallowedIds.has(inst.item_id) && (
                            <button
                              className="secondary"
                              onClick={() => startAllowTransactions(inst.item_id)}
                              disabled={connecting}
                              aria-label={`Allow transactions from ${inst.institution_name}`}
                            >
                              Allow transactions
                            </button>
                          )}
                          {canEnableLiabilities(inst) && (
                            <button
                              className="secondary"
                              onClick={() => startEnableLiabilities(inst.item_id)}
                              disabled={connecting}
                            >
                              Enable payment details
                            </button>
                          )}
                          {/* Adds accounts to THIS Item rather than connecting
                              the institution again (a second, separately
                              billed Item). In manage mode, like Disconnect, or
                              whenever Plaid has found new accounts. */}
                          {!inst.manual && (manageMode || inst.new_accounts_available) && (
                            <button
                              className="secondary"
                              onClick={() => startManageAccounts(inst.item_id)}
                              disabled={connecting}
                            >
                              {inst.new_accounts_available && !manageMode ? 'Review accounts' : 'Add or remove accounts'}
                            </button>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}

                {hiddenAccounts.length > 0 && (
                  <div className="card hidden-section">
                    <button
                      className="holdings-toggle"
                      onClick={() => setHiddenExpanded((v) => !v)}
                      aria-expanded={hiddenExpanded}
                    >
                      <span className="holdings-title">
                        Hidden
                        <span className="holdings-count">{hiddenAccounts.length}</span>
                      </span>
                      <span className="holdings-summary">
                        <svg
                          className={`chevron${hiddenExpanded ? ' open' : ''}`}
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth={2}
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          aria-hidden="true"
                        >
                          <path d="m6 9 6 6 6-6" />
                        </svg>
                      </span>
                    </button>
                    {hiddenExpanded && (
                      <>
                        <p className="empty-note">
                          These accounts still sync, but are left out of net worth, transactions,
                          budgets and insights. Unhiding restores their history in full.
                        </p>
                        <table>
                          <tbody>
                            {hiddenAccounts.map(({ account, institution_name, resolved }) => (
                              <tr key={account.account_id} className="hidden-row">
                                <td>
                                  {account.name}
                                  <div className="type-tag">
                                    {institution_name} · {account.subtype || account.type}
                                  </div>
                                </td>
                                <td className="num">
                                  {/* An unresolved account has no balance to
                                      show; "--" beats a misleading $0.00. */}
                                  {resolved ? fmt(signedBalance(account), account.currency) : '--'}
                                  <div className="manual-row-actions">
                                    <button
                                      className="link-btn"
                                      disabled={togglingHidden !== null}
                                      onClick={() => toggleHidden(account.account_id, false)}
                                    >
                                      {togglingHidden === account.account_id
                                        ? 'Unhiding…'
                                        : 'Unhide'}
                                    </button>
                                  </div>
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </>
                    )}
                  </div>
                )}

                {/* Download my data, with the rest of the account upkeep
                    behind Manage accounts; after the accounts, so it doesn't
                    push them down. It asks for a fresh sign-in itself. */}
                {manageMode && <DownloadMyData clerk={clerk} />}

                {/* What others share with me, whenever there is some; last,
                    so my own accounts don't move when it arrives. What I
                    share is in the Sharing drawer. */}
                {clerk && <SharedWithMe refreshKey={asOf} />}
              </>
            )}

            {tab === 'activity' && (
              <MonthBreakdown
                txns={txns}
                notes={txnNotes}
                loading={txnsLoading}
                onRecategorize={txnEdits.recategorize}
                onRename={renameVendor}
                // Only with a manual account to add to (hidden ones aren't offered).
                onAddTransaction={
                  institutions.some((i) => i.manual && i.accounts.some((a) => !a.hidden)) ? () => txnEdits.openAdd() : undefined
                }
                onEditTransaction={txnEdits.openEdit}
                onToggleExcluded={txnEdits.toggleExcluded}
                actionError={txnEdits.error}
                incomplete={txnIncomplete}
                stopped={stoppedTxns}
                withoutTransactions={txnWithout}
              />
            )}

            {tab === 'budgets' && (
              <BudgetsTab
                txns={txns}
                budgets={budgets}
                budgetsStatus={budgetsState.status}
                budgetsError={budgetsState.error}
                budgetsSaveError={budgetsState.saveError}
                onSave={budgetsStore.save}
                goals={goals}
                goalsStatus={goalsState.status}
                goalsError={goalsState.error}
                goalsSaveError={goalsState.saveError}
                onSaveGoals={goalsStore.save}
                // Hidden accounts stay in this list: GoalsCard needs them to tell
                // "you hid this account" from "this account was disconnected". It
                // excludes them from the picker itself.
                accounts={institutions.flatMap((i) =>
                  i.accounts.map((a) => ({
                    account_id: a.account_id,
                    name: a.name,
                    institution: i.institution_name,
                    balance: a.balance,
                    currency: a.currency,
                    hidden: a.hidden,
                  }))
                )}
                loading={txnsLoading}
                incomplete={txnIncomplete}
                stopped={stoppedTxns}
                withoutTransactions={txnWithout}
                // The forecast, the calendar and the recurring list.
                recurringHistory={txnHistory}
                institutions={institutions}
                planned={plannedState.value}
                plannedStatus={plannedState.status}
                plannedError={plannedState.error}
                plannedSaveError={plannedState.saveError}
                onSavePlanned={plannedItemsStore.save}
              />
            )}

            {tab === 'plan' && (
              <PlanTabLoader
                txns={txns}
                txnsLoading={txnsLoading}
                txnNotes={txnNotes}
                txnWithout={txnWithout}
                // With what went wrong at each, so a figure that may be short
                // says so; hidden accounts too, which the tab leaves out itself.
                institutions={institutions.map((i) => ({
                  name: i.institution_name,
                  item_id: i.manual ? null : i.item_id,
                  error: !!i.error || i.needs_reauth,
                  staleAsOf: i.stale_as_of ?? null,
                  staleAsOfAt: i.stale_as_of_at ?? null,
                  missing: (i.stale_missing ?? 0) + (i.unconfirmed_missing ?? 0),
                  accounts: i.accounts.map((a) => ({
                    account_id: a.account_id,
                    name: a.name,
                    type: a.type,
                    subtype: a.subtype,
                    balance: a.balance,
                    currency: a.currency,
                    hidden: a.hidden,
                  })),
                }))}
                balancesAsOf={asOf}
                currency={accountCurrency}
              />
            )}
          </>
        )}
        {/* At the foot of every tab: how the data is protected, and who can read it. */}
        <TrustLinks />
      </main>
      {clerk && <SharingDrawer open={sharingOpen} onClose={closeSharing} />}
      {/* Mounted outside the tabs so what was typed into it lasts until a reload. */}
      <DebtPayoff open={payoffOpen} onClose={closePayoff} institutions={institutions} />

      {connected && !loading && (
        <nav className="tab-bar" aria-label="Sections">
          {(['home', 'accounts', 'activity', 'budgets', 'plan'] as const).map((t) => (
            <button
              key={t}
              className={tab === t ? 'active' : ''}
              aria-current={tab === t ? 'page' : undefined}
              onClick={() => {
                // Each tab starts at its top: the page scroll would otherwise
                // carry over from one tab to the next.
                if (t !== tab) window.scrollTo(0, 0);
                setTab(t);
              }}
            >
              {TAB_ICONS[t]}
              {TAB_LABELS[t]}
            </button>
          ))}
        </nav>
      )}

      {/* Forms and confirmations open in the same drawer as Sharing
          (components/Sheet.tsx). Each keeps its last content while it slides
          out, so it doesn't empty mid-animation. */}
      <Sheet
        open={!!manualDraft}
        title={shownManualDraft && editingManualShown ? 'Update account' : 'Add a manual account'}
        onClose={() => !savingManual && setManualDraft(null)}
      >
        {shownManualDraft && (
          <>
            <p className="panel-note" style={{ marginTop: 0 }}>
              For institutions Plaid can&apos;t reach. The balance you type counts toward net worth
              and is recorded on the timeline each time you update it.
            </p>
            <div className="sheet-form">
              <label className="field">
                Account name
                <input
                  value={shownManualDraft.name}
                  onChange={(e) => setManualDraft({ ...shownManualDraft, name: e.target.value })}
                  placeholder="e.g. Credit Union Checking"
                  maxLength={60}
                  disabled={savingManual}
                />
              </label>
              <label className="field">
                Institution
                <input
                  value={shownManualDraft.institution_name}
                  onChange={(e) => setManualDraft({ ...shownManualDraft, institution_name: e.target.value })}
                  placeholder="Groups accounts into one card"
                  maxLength={60}
                  disabled={savingManual}
                />
              </label>
              <label className="field">
                Type
                <select
                  value={isCashOnHand(shownManualDraft) ? 'cash' : shownManualDraft.type}
                  onChange={(e) => {
                    const cash = e.target.value === 'cash';
                    setManualDraft({
                      ...shownManualDraft,
                      type: cash ? 'depository' : e.target.value,
                      // Cash only when chosen; another subtype is kept as it was.
                      subtype: cash ? CASH_SUBTYPE : shownManualDraft.subtype === CASH_SUBTYPE ? null : shownManualDraft.subtype,
                    });
                  }}
                  disabled={savingManual}
                >
                  {MANUAL_TYPE_LABELS.map((t) => (
                    <option key={t.value} value={t.value}>
                      {t.label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field">
                {isOwedType(shownManualDraft.type) ? 'Amount owed' : 'Current balance'}
                <input
                  // Held as a string (see ManualDraft) so a leading "-" survives
                  // typing. Credit and loan balances are amounts owed, which
                  // subtract from net worth, so a negative would double-negate.
                  type="number"
                  inputMode="decimal"
                  step="0.01"
                  min={isOwedType(shownManualDraft.type) ? 0 : undefined}
                  value={shownManualDraft.balance}
                  onChange={(e) => setManualDraft({ ...shownManualDraft, balance: e.target.value })}
                  placeholder="0.00"
                  disabled={savingManual}
                />
              </label>
            </div>
            <p className="panel-note">
              {isOwedType(shownManualDraft.type)
                ? 'Enter what you owe as a positive number. It subtracts from net worth.'
                : 'Negative balances are allowed (e.g. an overdrawn account).'}
            </p>

            {editingManualShown && shownManualDraft.account_id && (
              <p className="panel-note manual-id">
                Account ID for scripted updates: <code>{shownManualDraft.account_id}</code>
              </p>
            )}

            {manualError && <div className="error">{manualError}</div>}

            <div className="button-pair" style={{ marginTop: 16 }}>
              <button className="secondary" onClick={() => setManualDraft(null)} disabled={savingManual}>
                Cancel
              </button>
              <button
                disabled={
                  savingManual ||
                  !shownManualDraft.name.trim() ||
                  !shownManualDraft.institution_name.trim() ||
                  shownManualDraft.balance.trim() === '' ||
                  !Number.isFinite(Number(shownManualDraft.balance)) ||
                  (isOwedType(shownManualDraft.type) && Number(shownManualDraft.balance) < 0)
                }
                onClick={submitManualDraft}
              >
                {savingManual ? 'Saving…' : editingManualShown ? 'Save' : 'Add account'}
              </button>
            </div>
          </>
        )}
      </Sheet>

      <Sheet
        open={!!manualDeleteTarget}
        title={shownDeleteTarget ? `Delete ${shownDeleteTarget.name}?` : 'Delete'}
        onClose={() => !savingManual && setManualDeleteTarget(null)}
      >
        {shownDeleteTarget && (
          <>
            <p className="panel-note" style={{ marginTop: 0 }}>
              This account&apos;s balance history, and any transactions entered on it, are{' '}
              <strong>not recoverable</strong>. Re-adding it creates a new account with an empty history.
            </p>
            {manualError && <div className="error">{manualError}</div>}
            <div className="button-pair" style={{ marginTop: 16 }}>
              <button className="secondary" onClick={() => setManualDeleteTarget(null)} disabled={savingManual}>
                Cancel
              </button>
              <button
                className="danger"
                disabled={savingManual}
                onClick={() => mutateManual('DELETE', { account_id: shownDeleteTarget.account_id })}
              >
                {savingManual ? 'Deleting…' : 'Delete'}
              </button>
            </div>
          </>
        )}
      </Sheet>

      <ManualTxnSheet
        target={txnEdits.sheet}
        institutions={institutions}
        txns={txns}
        onClose={txnEdits.closeSheet}
        onSaved={txnEdits.onSaved}
        onBalanceStale={() => loadNetWorth(true)}
      />

      <Sheet
        open={!!redirect}
        title={shownRedirect ? `${shownRedirect.name} is already connected` : 'Already connected'}
        onClose={() => setRedirect(null)}
      >
        {shownRedirect && (
          <RedirectChoices
            name={shownRedirect.name}
            items={shownRedirect.items}
            kind={shownRedirect.kind}
            connecting={connecting}
            onAdd={(item_id) => {
              setRedirect(null);
              startManageAccounts(item_id);
            }}
            onConnectAgain={() => {
              setRedirect(null);
              beginConnect(shownRedirect.kind, true);
            }}
          />
        )}
      </Sheet>

      <Sheet
        open={!!disconnectTarget}
        title={shownDisconnectTarget ? `Disconnect ${shownDisconnectTarget.institution_name}?` : 'Disconnect'}
        onClose={() => !disconnecting && setDisconnectTarget(null)}
      >
        {shownDisconnectTarget && (
          <>
            <p className="panel-note" style={{ marginTop: 0 }}>
              This removes {shownDisconnectTarget.institution_name} and its accounts from Nya, and ends the
              connection at Plaid. You can reconnect it later. Type{' '}
              <strong>{shownDisconnectTarget.institution_name}</strong> below to confirm.
            </p>
            {/* What Plaid itself keeps is beyond a disconnect's reach (the
                deletion receipt says the same, lib/deletion-receipt.ts): say
                where people can see and delete it. */}
            <p className="panel-note">
              Plaid keeps its own records of what it collected, under its own privacy policy. See and delete
              them at the{' '}
              <a href={PLAID_PORTAL} target="_blank" rel="noreferrer">
                Plaid Portal
              </a>
              .
            </p>
            <label className="field" style={{ marginTop: 12 }}>
              Institution name
              <input
                value={disconnectInput}
                onChange={(e) => setDisconnectInput(e.target.value)}
                placeholder={shownDisconnectTarget.institution_name}
                disabled={disconnecting}
                autoCapitalize="off"
                autoCorrect="off"
              />
            </label>
            <div className="button-pair" style={{ marginTop: 16 }}>
              <button className="secondary" onClick={() => setDisconnectTarget(null)} disabled={disconnecting}>
                Cancel
              </button>
              <button
                className="danger"
                disabled={
                  disconnecting ||
                  disconnectInput.trim().toLowerCase() !== shownDisconnectTarget.institution_name.trim().toLowerCase()
                }
                onClick={() => performDisconnect(shownDisconnectTarget.item_id)}
              >
                {disconnecting ? 'Disconnecting…' : 'Disconnect'}
              </button>
            </div>
          </>
        )}
      </Sheet>
    </>
  );
}
