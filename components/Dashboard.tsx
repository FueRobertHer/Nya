'use client';

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { usePlaidLink, type PlaidLinkOnSuccessMetadata } from 'react-plaid-link';
import NetWorthChart, { type HistoryPoint } from './NetWorthChart';
import AccountSparkline from './AccountSparkline';
import AccountLinks from './AccountLinks';
import { historyPausedSince } from '@/lib/history-status';
import InvestmentActivity from './InvestmentActivity';
import MonthBreakdown, { type Txn } from './MonthBreakdown';
import Insights, { type IdleCashAccount } from './Insights';
import BudgetsTab, { type Budgets } from './BudgetsTab';
import { createWholeListStore, initialListState, type ListState } from '@/lib/whole-list-store';
import { type Goal } from './GoalsCard';
import { formatMoney, dominantCurrency } from '@/lib/format';
// Same dependency-free-shared-module trick as lib/format: the sign rule lives
// outside lib/hidden.ts so the client can import it without pulling in Redis.
import { isInvestmentType, isOwedType, signedContribution } from '@/lib/balance';
// Same reason: lib/cash.ts imports nothing, so the cash rule can be shared
// between the server payload and this component.
import { institutionCash, isCashHolding, cashSharePct } from '@/lib/cash';

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
  // Plaid security fields, read by lib/cash.ts to tell an invested position
  // from money parked in cash. All optional, because a payload cached in
  // localStorage before this shipped carries none of them. What that payload
  // DOES carry is `name`, and lib/cash.ts's last rule reads names -- so an
  // offline first paint off an old cache still marks a fund called "...Money
  // Market..." as cash, just without the confirmation Plaid's own flag gives.
  // Graceful degradation rather than a blank: the amount and the share come
  // from `value`, which was always there.
  ticker?: string | null;
  security_type?: string | null;
  is_cash_equivalent?: boolean | null;
};

type Institution = {
  institution_name: string;
  item_id: string;
  accounts: Account[];
  holdings: Holding[];
  error: string | null;
  needs_reauth: boolean;
  // 'on' | 'off' | 'loading' | 'unavailable' (lib/networth.ts). Optional and
  // compared explicitly against 'off' so a stale cached payload, which has no
  // such field, never offers the Enable button.
  liabilities?: string;
  // YYYY-MM-DD when the shown balances were last observed, set only when the
  // live fetch failed and they were recovered (recovery is all-or-nothing per
  // institution, so this covers every account in it). Optional: a payload
  // cached before this shipped has none, which reads as "not stale" and shows
  // the plain error, matching the old behaviour.
  //
  // The reverse direction is NOT disclosed: a rolled-back deploy reading a new
  // localStorage payload renders recovered balances with no staleness marker at
  // all, under the plain red error. The numbers are still real, just undated.
  stale_as_of?: string;
  // Set instead of stale_as_of when last-known balances exist but are past the
  // age limit. The card stays at $0.00, and says why rather than looking like
  // an institution that never had recoverable balances at all.
  stale_too_old?: string;
  // How many of this institution's known accounts could not be recovered, set
  // alongside stale_as_of. Nonzero means the subtotal is short, so the card
  // says so rather than presenting an incomplete figure as merely dated.
  stale_missing?: number;
  // How many accounts this institution previously reported were absent from an
  // otherwise SUCCESSFUL fetch (lib/vanished.ts). Unlike the stale fields there
  // is no error alongside it: the balances shown are fresh and correct, they are
  // just not all of them, so the total is short by whatever the missing ones
  // held. History is paused while this is set, which is why it has to be said
  // out loud -- otherwise the hero total simply drops and disagrees with the
  // last charted point for three days with nothing to explain it.
  unconfirmed_missing?: number;
  manual?: boolean; // synthetic grouping of manually-tracked accounts
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

// The modal's working copy. `balance` is a STRING here, matching how
// BudgetsTab and GoalsCard hold numeric inputs: an <input type="number">
// reports '' for a partially-typed value like "-", and Number('') is 0, so
// storing a number would erase the minus sign as you type it and make the
// field impossible to clear. It's parsed once on submit instead.
// `account_id` is null while adding; the server mints it on create.
type ManualDraft = Omit<ManualAccount, 'account_id' | 'balance'> & {
  account_id: string | null;
  balance: string;
};

const MANUAL_TYPE_LABELS: { value: string; label: string }[] = [
  { value: 'depository', label: 'Cash (checking, savings)' },
  { value: 'investment', label: 'Investment (brokerage, 401k, HSA)' },
  { value: 'credit', label: 'Credit card' },
  { value: 'loan', label: 'Loan (mortgage, auto, student)' },
  { value: 'other', label: 'Other (property, crypto)' },
];

type Tab = 'home' | 'accounts' | 'activity' | 'budgets';

// Last-known dashboard snapshot, kept on-device so the app paints instantly
// on open (and still shows something useful offline) while fresh data loads
// in the background. Cleared on logout.
const LOCAL_CACHE_KEY = 'nya:dashboard';

// Currency-aware money, so a EUR/GBP account isn't rendered with a "$".
// Delegates to the shared formatter (which falls back to $ for a null or
// unrecognized code); "--" for a missing value.
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
 * The rest of a liability's terms, shown only when the row is expanded — the
 * collapsed row already carries rate, minimum and due date.
 *
 * Follows TxnDetail in MonthBreakdown: build the rows by pushing only fields
 * that are actually present, and render nothing at all rather than a list of
 * dashes when none are.
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
 * Whether to offer "Enable payment details" for an institution.
 *
 * Only 'off' — the product was never initialized on this Item, and update mode
 * can add it. 'loading' means Plaid is already fetching (offering the button
 * there would loop: the reload right after a successful enable arrives before
 * the data does), and 'unavailable' means enabling would change nothing. A
 * stale cached payload has no field at all, which also falls through to false.
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
};

const TAB_LABELS: Record<Tab, string> = {
  home: 'Home',
  accounts: 'Accounts',
  activity: 'Activity',
  budgets: 'Budgets',
};

export default function Dashboard() {
  const [tab, setTab] = useState<Tab>('home');
  const [linkToken, setLinkToken] = useState<string | null>(null);
  const [linkMode, setLinkMode] = useState<'new' | 'update'>('new');
  const [connected, setConnected] = useState(false);
  const [institutions, setInstitutions] = useState<Institution[]>([]);
  const [netWorth, setNetWorth] = useState(0);
  const [history, setHistory] = useState<HistoryPoint[]>([]);
  const [asOf, setAsOf] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [connecting, setConnecting] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [txns, setTxns] = useState<Txn[] | null>(null);
  const [txnNotes, setTxnNotes] = useState<string[]>([]);
  const [txnsLoading, setTxnsLoading] = useState(false);
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
  const budgets = budgetsState.value;
  const goals = goalsState.value;
  // Accounts tab: disconnect buttons stay hidden until "Manage accounts" is
  // toggled, so they can't be tapped by accident. disconnectTarget drives the
  // type-to-confirm modal.
  const [manageMode, setManageMode] = useState(false);
  const [disconnectTarget, setDisconnectTarget] = useState<Institution | null>(null);
  const [disconnectInput, setDisconnectInput] = useState('');
  const [disconnecting, setDisconnecting] = useState(false);
  // Manual accounts: `manualDraft` drives the add/edit modal, and
  // `editingManual` flips the same form between adding and editing.
  // `manualError` is deliberately separate from the page-level `error` so a
  // failed save can't linger on the Accounts card after the modal closes, and
  // a background refresh failure can't appear to be a save failure.
  const [manualDraft, setManualDraft] = useState<ManualDraft | null>(null);
  const [editingManual, setEditingManual] = useState(false);
  const [savingManual, setSavingManual] = useState(false);
  const [manualError, setManualError] = useState('');
  const [manualDeleteTarget, setManualDeleteTarget] = useState<ManualAccount | null>(null);
  // The Hidden card starts collapsed: it exists so hidden accounts are
  // findable, not so they take up room on the balance sheet you decluttered.
  const [hiddenExpanded, setHiddenExpanded] = useState(false);
  // The stored hidden set, straight from the server, so hidden accounts stay
  // listed (and unhideable) even when their institution fails to load.
  const [hiddenMeta, setHiddenMeta] = useState<{ account_id: string; type: string }[]>([]);
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
        setError('Failed to load accounts.');
        return;
      }
      const data = await res.json();
      setError('');
      setInstitutions(data.institutions);
      setNetWorth(data.netWorth);
      setHistory(data.history ?? []);
      setHiddenMeta(data.hidden ?? []);
      setAsOf(data.as_of ?? null);
      setConnected(data.institutions.length > 0);

      // First open with a near-empty chart: backfill estimated history from
      // transactions in the background (what the big trackers do on link).
      //
      // `backfill_stale` covers the other case: a layer that already exists but
      // was built by an older algorithm. That one is invisible from here -- the
      // chart looks full -- so the server has to say so, or an improvement to
      // the reconstruction would only ever reach people with no history yet.
      const hist: HistoryPoint[] = data.history ?? [];
      const thin = hist.filter((h) => !h.estimated).length <= 1 && !hist.some((h) => h.estimated);
      if ((thin || data.backfill_stale) && data.institutions.length > 0 && !backfillTried.current) {
        backfillTried.current = true;
        requestBackfill(() => loadNetWorth());
      }

      try {
        localStorage.setItem(
          LOCAL_CACHE_KEY,
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
    } catch {
      setTxnNotes(['Could not load transactions.']);
    } finally {
      setTxnsLoading(false);
    }
  }, []);

  useEffect(() => {
    // Paint immediately from the last-known snapshot, then revalidate.
    try {
      const raw = localStorage.getItem(LOCAL_CACHE_KEY);
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

  // Everything else loads in parallel with net worth (no waterfall):
  // transactions feed Activity + insights, budgets/goals feed the Budgets
  // tab. All are cheap on the server (cached or Redis-only) and harmlessly
  // empty when nothing is connected yet.
  useEffect(() => {
    loadTransactions();
    budgetsStore.load();
    goalsStore.load();
  }, [loadTransactions, budgetsStore, goalsStore]);

  const recategorize = useCallback(async (transaction_id: string, category: string) => {
    // Optimistic local update; the server stores the override and clears its
    // transactions cache so future loads agree.
    setTxns((prev) =>
      prev ? prev.map((t) => (t.transaction_id === transaction_id ? { ...t, category } : t)) : prev
    );
    try {
      await fetch('/api/recategorize', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ transaction_id, category }),
      });
    } catch {
      // Next refresh reverts if the write didn't land.
    }
  }, []);

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

  const startConnect = useCallback(async () => {
    setError('');
    setConnecting(true);
    const res = await fetch('/api/create-link-token', { method: 'POST' });
    const data = await res.json();
    setConnecting(false);
    if (data.link_token) {
      setLinkMode('new');
      setLinkToken(data.link_token);
    } else {
      setError('Could not start connection.');
    }
  }, []);

  const startReconnect = useCallback(async (item_id: string) => {
    setError('');
    setConnecting(true);
    const res = await fetch('/api/create-update-link-token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ item_id }),
    });
    const data = await res.json();
    setConnecting(false);
    if (data.link_token) {
      setLinkMode('update');
      setLinkToken(data.link_token);
    } else {
      setError('Could not start reconnection.');
    }
  }, []);

  // Adds the liabilities product to an Item that was linked without it. Goes
  // through Link's update mode, so it re-authenticates the SAME Item rather
  // than creating a new one -- the stored transaction history survives.
  const startEnableLiabilities = useCallback(async (item_id: string) => {
    setError('');
    setConnecting(true);
    const res = await fetch('/api/create-update-link-token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ item_id, add_liabilities: true }),
    });
    const data = await res.json();
    setConnecting(false);
    if (data.link_token) {
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
   * page can only ever affect the account it acted on -- it can't delete
   * accounts it doesn't know about, and it can't revert a balance that a
   * scheduled push to /api/ingest/balance wrote in the meantime.
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
        // A forced fetch is what writes the new balance into today's history
        // point, same as the disconnect flow. Then recompute estimated history,
        // which the save just invalidated server-side -- the automatic backfill
        // only fires when history is thin, so it won't re-run on its own.
        await loadNetWorth(true);
        requestBackfill(() => loadNetWorth());
        return true;
      } catch {
        setManualError('Could not reach the server.');
        return false;
      } finally {
        setSavingManual(false);
      }
    },
    [loadNetWorth, requestBackfill]
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

  const logout = useCallback(async () => {
    try {
      localStorage.removeItem(LOCAL_CACHE_KEY);
    } catch {
      // Best-effort; the snapshot only lives on this device anyway.
    }
    await fetch('/api/logout', { method: 'POST' });
    window.location.href = '/login';
  }, []);

  const onSuccess = useCallback(
    async (public_token: string, metadata: PlaidLinkOnSuccessMetadata) => {
      if (linkMode === 'update') {
        // Update mode re-authenticates the existing Item -- no new Item is
        // created and the access token doesn't change, so there's nothing
        // to exchange. Just clear the token and refresh.
        setLinkToken(null);
        loadNetWorth(true);
        return;
      }

      const institutionName = metadata.institution?.name || 'Connected Account';
      const isDuplicate = institutions.some((i) => i.institution_name === institutionName);
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

  const { open, ready } = usePlaidLink({
    token: linkToken,
    onSuccess,
    onExit: (err) => {
      if (err) setError('Connection cancelled or failed.');
      setLinkToken(null);
    },
  });

  // Open Link automatically as soon as a fresh token is ready
  useEffect(() => {
    if (linkToken && ready) open();
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

  // Institutions showing recovered balances. Surfaced on the hero too, not just
  // on their own cards: the number someone actually reads is the total, and
  // "this is real but a few days old" is a caveat on the total.
  const staleInstitutions = useMemo(
    () => institutions.filter((i) => i.stale_as_of),
    [institutions]
  );

  // Institutions that failed and could NOT be recovered, so the hero is short
  // by all of them. Deliberately every such case, not just the ones with a
  // named reason (too old, nothing remembered, ids changed at reauth): these
  // are MORE wrong than the stale ones, not less, and disclosing the recovered
  // case while staying silent here would be exactly backwards.
  const uncountedInstitutions = useMemo(
    () => institutions.filter((i) => i.error && !i.stale_as_of),
    [institutions]
  );

  // Recovered, but short some rows. Called out at the hero and not just on the
  // card, because "short some rows" is a statement about the total, and the
  // total is what someone actually reads.
  const incompleteCount = useMemo(
    () => institutions.reduce((n, i) => n + (i.stale_missing ?? 0), 0),
    [institutions]
  );

  // Accounts that answered before and didn't this time, at institutions that
  // are otherwise fine. Surfaced on the hero for the same reason as the stale
  // cases: the total is what gets read, and this is a caveat on the total --
  // it is short by however much those accounts held, and the chart is frozen
  // until the absence resolves one way or the other.
  const vanishedCount = useMemo(
    () => institutions.reduce((n, i) => n + (i.unconfirmed_missing ?? 0), 0),
    [institutions]
  );

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

  // Plaid returns institutions/accounts in no guaranteed order; sort by name
  // so the Accounts tab renders the same way every load.
  //
  // Hidden accounts are dropped here and surface in the Hidden card instead. An
  // institution is only removed once it has nothing left to show: one whose
  // accounts are ALL hidden goes, but one that simply failed to load keeps its
  // (already empty) account list so its error and Reconnect button still render.
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

  // Investment accounts carrying enough uninvested cash to be worth a line on
  // the Home tab. Built from `institutions` rather than `sortedInstitutions`
  // because that list is also filtered by manage mode, and an insight has no
  // business appearing and disappearing with a UI toggle on another tab.
  // Hidden accounts are dropped here for the same reason they're dropped from
  // every total: the user has said they don't want to see them.
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
          // Carries the id, the institution and the mask because account names
          // are not distinctive: "Individual" and "Roth IRA" are what
          // brokerages call them, and two of them would otherwise produce a
          // duplicate React key and two identical, unactionable lines.
          account_id: a.account_id,
          name: a.name,
          mask: a.mask,
          institution_name: inst.institution_name,
          cash: cash.cash,
          // Null where the denominator is degenerate (a margin debit bigger
          // than the positions), so the insight drops the phrase rather than
          // claiming "100% of its holdings" of an account that is also holding
          // a short. The Accounts tab badge suppresses it the same way.
          share: cash.total > 0 ? cash.share : null,
          currency: a.currency,
        });
      }
    }
    return out.sort((x, y) => y.cash - x.cash);
  }, [institutions]);

  // Hidden accounts for the Hidden card, built from the STORED set rather than
  // from whatever resolved this load. An institution that's erroring returns no
  // accounts, and deriving from the live list alone would make its hidden
  // accounts silently disappear -- still hidden, still subtracted from history,
  // but with no Unhide button anywhere.
  const hiddenAccounts = useMemo(() => {
    const live = new Map(
      institutions.flatMap((i) =>
        i.accounts
          .filter((a) => a.hidden)
          .map((a) => [a.account_id, { account: a, institution_name: i.institution_name }] as const)
      )
    );
    return hiddenMeta
      .map(({ account_id, type }) => {
        const resolved = live.get(account_id);
        if (resolved) return { ...resolved, resolved: true };
        // Hidden, but its institution didn't answer this load. Render what we
        // stored so it can still be unhidden.
        return {
          account: {
            account_id,
            name: 'Unavailable account',
            type,
            subtype: null,
            balance: null,
            currency: null,
            hidden: true,
          } as Account,
          institution_name: 'Not loaded',
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
        // The estimated history layer doesn't know this account, so it can't
        // subtract it and would sit high by its balance with a step at the
        // estimated/real seam. The server cleared the backfill flag; actually
        // running the recompute is on us, since the automatic one only fires
        // when history is thin.
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
  // implying an FX-converted total.
  // Hidden accounts excluded: a hidden EUR account must not make the Home tab
  // announce "Accounts use multiple currencies" with no such account on screen.
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

  // Counts what's actually rendering, so hiding an institution's last account
  // doesn't leave "3 institutions connected" above two cards. When everything
  // is hidden the count would read "0 institutions connected", which sounds
  // like nothing is linked rather than like it's all tucked away.
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
            <h1>Nya</h1>
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
            <button className="secondary logout-btn" onClick={logout}>
              Log out
            </button>
          </div>
        </div>

        {loading ? (
          <div className="card">
            <div className="spinner" role="status" aria-label="Loading" />
          </div>
        ) : !connected ? (
          <div className="card">
            <button onClick={startConnect} disabled={connecting}>
              {connecting ? 'Starting…' : 'Connect an Account'}
            </button>
            {/* Also offered here, not just on the Accounts tab: with nothing
                connected the tab bar is hidden, so this is the only reachable
                entry point for someone whose bank Plaid doesn't support at all. */}
            <button
              className="secondary manage-toggle"
              onClick={startAddManual}
              disabled={savingManual}
            >
              Add a manual account
            </button>
            <p className="empty-note">
              Manual accounts are for institutions Plaid can&apos;t reach. You type the balance and
              update it whenever you like; it counts toward net worth and builds its own history.
            </p>
            {error && <div className="error">{error}</div>}
          </div>
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
                  {staleInstitutions.length > 0 && (
                    <div className="as-of stale">
                      {staleInstitutions.length === 1
                        ? `${staleInstitutions[0].institution_name} ${
                            staleInstitutions[0].needs_reauth ? 'needs reconnecting' : "couldn't refresh"
                          }; its balances are from ${fmtDay(staleInstitutions[0].stale_as_of!)}`
                        : `${staleInstitutions.length} institutions couldn't refresh; showing their last known balances`}
                    </div>
                  )}
                  {incompleteCount > 0 && (
                    <div className="as-of stale">
                      {incompleteCount} account{incompleteCount === 1 ? '' : 's'} couldn&apos;t be
                      shown, so this total is incomplete
                    </div>
                  )}
                  {vanishedCount > 0 && (
                    <div className="as-of stale">
                      {vanishedCount} account{vanishedCount === 1 ? '' : 's'} stopped reporting, so
                      this total is short by {vanishedCount === 1 ? 'it' : 'them'} · history is
                      paused until that settles
                    </div>
                  )}
                  {uncountedInstitutions.length > 0 && (
                    <div className="as-of stale">
                      {uncountedInstitutions.length === 1
                        ? `${uncountedInstitutions[0].institution_name} couldn't be reached and isn't counted in this total`
                        : `${uncountedInstitutions.length} institutions couldn't be reached and aren't counted in this total`}
                    </div>
                  )}
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
                  <button onClick={startConnect} disabled={connecting}>
                    {connecting ? 'Starting…' : 'Connect an Account'}
                  </button>
                  <button
                    className="secondary manage-toggle"
                    onClick={startAddManual}
                    disabled={savingManual}
                  >
                    Add a manual account
                  </button>
                  <button
                    className="secondary manage-toggle"
                    onClick={() => setManageMode((m) => !m)}
                    aria-pressed={manageMode}
                  >
                    {manageMode ? 'Done' : 'Manage accounts'}
                  </button>
                  {error && <div className="error">{error}</div>}
                </div>

                {/* Only renders when there is a reconnected account to link or
                    a link to undo. A change reloads live, since links alter
                    hidden accounts and per-account history. */}
                <AccountLinks onChanged={() => loadNetWorth(true)} />

                {sortedInstitutions.map((inst) => {
                  // One verdict for the row badge, the per-holding chip and
                  // the Holdings header, so they can't disagree about the same
                  // money. `inst` is already filtered here, so a hidden
                  // brokerage takes its cash with it.
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
                              // institutionCash drops those, because 100% cash
                              // in a cash management account is the account
                              // working and the warning could never be cleared.
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
                                        itemId={
                                          isInvestmentType(a.type) && !inst.manual
                                            ? inst.item_id
                                            : undefined
                                        }
                                      />
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
                          {inst.stale_as_of && ` · balances as of ${fmtDay(inst.stale_as_of)}`}
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
                            ` · last known balances are from ${fmtDay(inst.stale_too_old)}, too old to show`}
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

                      {/* One container, two independent actions. Enable must
                          NOT sit inside a needs_reauth gate: a healthy
                          institution is exactly the case it exists for. */}
                      {(inst.needs_reauth || canEnableLiabilities(inst)) && (
                        <div className="card-actions">
                          {inst.needs_reauth && (
                            <button onClick={() => startReconnect(inst.item_id)} disabled={connecting}>
                              Reconnect
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
              </>
            )}

            {tab === 'activity' && (
              <MonthBreakdown
                txns={txns}
                notes={txnNotes}
                loading={txnsLoading}
                onRecategorize={recategorize}
                onRename={renameVendor}
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
                // Hidden accounts stay in this list rather than being filtered
                // out: GoalsCard needs them to tell "you hid this account" from
                // "this account was disconnected". It excludes them from the
                // picker itself.
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
              />
            )}
          </>
        )}
      </main>

      {connected && !loading && (
        <nav className="tab-bar" aria-label="Sections">
          {(['home', 'accounts', 'activity', 'budgets'] as const).map((t) => (
            <button
              key={t}
              className={tab === t ? 'active' : ''}
              aria-current={tab === t ? 'page' : undefined}
              onClick={() => setTab(t)}
            >
              {TAB_ICONS[t]}
              {TAB_LABELS[t]}
            </button>
          ))}
        </nav>
      )}

      {manualDraft && (
        <div
          className="modal-overlay"
          role="dialog"
          aria-modal="true"
          aria-label={editingManual ? 'Update manual account' : 'Add a manual account'}
          onClick={() => !savingManual && setManualDraft(null)}
        >
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-title">
              {editingManual ? 'Update account' : 'Add a manual account'}
            </div>
            <p className="modal-body">
              For institutions Plaid can&apos;t reach. The balance you type counts toward net worth
              and is recorded on the timeline each time you update it.
            </p>

            <input
              className="text-input"
              value={manualDraft.name}
              onChange={(e) => setManualDraft({ ...manualDraft, name: e.target.value })}
              placeholder="Account name (e.g. Credit Union Checking)"
              aria-label="Account name"
              maxLength={60}
              autoFocus={!editingManual}
              disabled={savingManual}
            />
            <input
              className="text-input"
              value={manualDraft.institution_name}
              onChange={(e) =>
                setManualDraft({ ...manualDraft, institution_name: e.target.value })
              }
              placeholder="Institution (groups accounts into one card)"
              aria-label="Institution"
              maxLength={60}
              disabled={savingManual}
            />
            <select
              className="text-input budget-select"
              value={manualDraft.type}
              onChange={(e) => setManualDraft({ ...manualDraft, type: e.target.value })}
              aria-label="Account type"
              disabled={savingManual}
            >
              {MANUAL_TYPE_LABELS.map((t) => (
                <option key={t.value} value={t.value}>
                  {t.label}
                </option>
              ))}
            </select>
            <input
              className="text-input"
              // Held as a string (see ManualDraft) so a leading "-" survives
              // being typed. Credit and loan balances are amounts owed, which
              // subtract from net worth, so a negative there would
              // double-negate into a positive.
              type="number"
              step="0.01"
              min={isOwedType(manualDraft.type) ? 0 : undefined}
              value={manualDraft.balance}
              onChange={(e) => setManualDraft({ ...manualDraft, balance: e.target.value })}
              placeholder={isOwedType(manualDraft.type) ? 'Amount owed' : 'Current balance'}
              aria-label={isOwedType(manualDraft.type) ? 'Amount owed' : 'Current balance'}
              autoFocus={editingManual}
              disabled={savingManual}
            />
            <p className="empty-note">
              {isOwedType(manualDraft.type)
                ? 'Enter what you owe as a positive number. It subtracts from net worth.'
                : 'Negative balances are allowed (e.g. an overdrawn account).'}
            </p>

            {editingManual && manualDraft.account_id && (
              <p className="empty-note manual-id">
                Account ID for scripted updates: <code>{manualDraft.account_id}</code>
              </p>
            )}

            {manualError && <div className="error">{manualError}</div>}

            <div className="card-actions">
              <button
                className="secondary"
                onClick={() => setManualDraft(null)}
                disabled={savingManual}
              >
                Cancel
              </button>
              <button
                disabled={
                  savingManual ||
                  !manualDraft.name.trim() ||
                  !manualDraft.institution_name.trim() ||
                  manualDraft.balance.trim() === '' ||
                  !Number.isFinite(Number(manualDraft.balance)) ||
                  (isOwedType(manualDraft.type) && Number(manualDraft.balance) < 0)
                }
                onClick={submitManualDraft}
              >
                {savingManual ? 'Saving…' : editingManual ? 'Save' : 'Add account'}
              </button>
            </div>
          </div>
        </div>
      )}

      {manualDeleteTarget && (
        <div
          className="modal-overlay"
          role="dialog"
          aria-modal="true"
          aria-label={`Delete ${manualDeleteTarget.name}`}
          onClick={() => !savingManual && setManualDeleteTarget(null)}
        >
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-title">Delete {manualDeleteTarget.name}?</div>
            <p className="modal-body">
              This account&apos;s balance history is <strong>not recoverable</strong>. Re-adding it
              creates a new account with an empty history.
            </p>
            {manualError && <div className="error">{manualError}</div>}
            <div className="card-actions">
              <button
                className="secondary"
                onClick={() => setManualDeleteTarget(null)}
                disabled={savingManual}
              >
                Cancel
              </button>
              <button
                className="danger"
                disabled={savingManual}
                onClick={() =>
                  mutateManual('DELETE', { account_id: manualDeleteTarget.account_id })
                }
              >
                {savingManual ? 'Deleting…' : 'Delete'}
              </button>
            </div>
          </div>
        </div>
      )}

      {disconnectTarget && (
        <div
          className="modal-overlay"
          role="dialog"
          aria-modal="true"
          aria-label={`Disconnect ${disconnectTarget.institution_name}`}
          onClick={() => !disconnecting && setDisconnectTarget(null)}
        >
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-title">Disconnect {disconnectTarget.institution_name}?</div>
            <p className="modal-body">
              This removes {disconnectTarget.institution_name} and its accounts from Nya. You can
              reconnect it later. Type <strong>{disconnectTarget.institution_name}</strong> below to
              confirm.
            </p>
            <input
              className="text-input"
              value={disconnectInput}
              onChange={(e) => setDisconnectInput(e.target.value)}
              placeholder={disconnectTarget.institution_name}
              aria-label="Type the institution name to confirm"
              autoFocus
              disabled={disconnecting}
            />
            <div className="card-actions">
              <button
                className="secondary"
                onClick={() => setDisconnectTarget(null)}
                disabled={disconnecting}
              >
                Cancel
              </button>
              <button
                className="danger"
                disabled={
                  disconnecting ||
                  disconnectInput.trim().toLowerCase() !==
                    disconnectTarget.institution_name.trim().toLowerCase()
                }
                onClick={() => performDisconnect(disconnectTarget.item_id)}
              >
                {disconnecting ? 'Disconnecting…' : 'Disconnect'}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
