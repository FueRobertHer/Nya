'use client';

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { usePlaidLink, type PlaidLinkOnSuccessMetadata } from 'react-plaid-link';
import NetWorthChart, { type HistoryPoint } from './NetWorthChart';
import AccountSparkline from './AccountSparkline';
import MonthBreakdown, { type Txn } from './MonthBreakdown';
import Insights from './Insights';
import BudgetsTab, { type Budgets } from './BudgetsTab';
import { type Goal } from './GoalsCard';

type Account = {
  account_id: string;
  name: string;
  type: string;
  subtype: string | null;
  balance: number | null;
};

type Holding = {
  name: string;
  quantity: number | null;
  value: number | null;
  cost_basis: number | null;
};

type Institution = {
  institution_name: string;
  item_id: string;
  accounts: Account[];
  holdings: Holding[];
  error: string | null;
  needs_reauth: boolean;
};

type Tab = 'home' | 'accounts' | 'activity' | 'budgets';

// Last-known dashboard snapshot, kept on-device so the app paints instantly
// on open (and still shows something useful offline) while fresh data loads
// in the background. Cleared on logout.
const LOCAL_CACHE_KEY = 'nya:dashboard';

function fmt(n: number | null | undefined): string {
  if (n == null) return '--';
  return (n < 0 ? '-$' : '$') + Math.abs(n).toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function signedBalance(a: Account): number {
  const b = a.balance ?? 0;
  return a.type === 'credit' || a.type === 'loan' ? -b : b;
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
  const [budgets, setBudgets] = useState<Budgets>({});
  const [goals, setGoals] = useState<Goal[]>([]);
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
      setAsOf(data.as_of ?? null);
      setConnected(data.institutions.length > 0);

      // First open with a near-empty chart: backfill estimated history from
      // transactions in the background (what the big trackers do on link).
      const hist: HistoryPoint[] = data.history ?? [];
      const thin = hist.filter((h) => !h.estimated).length <= 1 && !hist.some((h) => h.estimated);
      if (thin && data.institutions.length > 0 && !backfillTried.current) {
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
    fetch('/api/budgets')
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (data?.budgets) setBudgets(data.budgets);
      })
      .catch(() => {
        // Budgets are additive; a failed load just shows none.
      });
    fetch('/api/goals')
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (data?.goals) setGoals(data.goals);
      })
      .catch(() => {
        // Same: goals just show empty.
      });
  }, [loadTransactions]);

  const saveBudgets = useCallback(async (next: Budgets) => {
    setBudgets(next); // optimistic; the PUT below confirms
    try {
      const res = await fetch('/api/budgets', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ budgets: next }),
      });
      if (!res.ok) setError('Could not save budgets.');
    } catch {
      setError('Could not save budgets.');
    }
  }, []);

  const saveGoals = useCallback(async (next: Goal[]) => {
    setGoals(next); // optimistic
    try {
      const res = await fetch('/api/goals', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ goals: next }),
      });
      if (!res.ok) setError('Could not save goals.');
    } catch {
      setError('Could not save goals.');
    }
  }, []);

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

  const disconnect = useCallback(
    async (item_id: string, institutionName: string) => {
      if (!window.confirm(`Disconnect ${institutionName}? You can reconnect it later.`)) return;
      await fetch('/api/disconnect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ item_id }),
      });
      loadNetWorth(true);
      if (txns !== null) loadTransactions(true);
    },
    [loadNetWorth, loadTransactions, txns]
  );

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

  const refreshAll = useCallback(() => {
    loadNetWorth(true);
    if (txns !== null) loadTransactions(true);
  }, [loadNetWorth, loadTransactions, txns]);

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

  const subtitle = loading
    ? 'Loading your accounts…'
    : connected
      ? `${institutions.length} institution${institutions.length === 1 ? '' : 's'} connected`
      : 'Connect your bank, credit card, and brokerage accounts';

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
            {error && <div className="error">{error}</div>}
          </div>
        ) : (
          <>
            {tab === 'home' && (
              <>
                <div className="card">
                  <div className="total-label">Net Worth</div>
                  <div className={`total-value${netWorth < 0 ? ' negative' : ''}`}>
                    {fmt(netWorth)}
                  </div>
                  {heroDelta && (
                    <div className={`hero-delta${heroDelta.value >= 0 ? ' up' : ' down'}`}>
                      {heroDelta.value >= 0 ? '▲' : '▼'} {fmt(Math.abs(heroDelta.value))} (
                      {heroDelta.pct.toFixed(1)}%) · past {heroDelta.days} days
                    </div>
                  )}
                  {asOf && (
                    <div className="as-of">
                      Updated {fmtAsOf(asOf)}
                      {refreshing ? ' · refreshing…' : ''}
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
                </div>

                <Insights
                  txns={txns}
                  budgets={budgets}
                  accounts={institutions.flatMap((i) =>
                    i.accounts.map((a) => ({ name: a.name, type: a.type, balance: a.balance }))
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
                  {error && <div className="error">{error}</div>}
                </div>

                {institutions.map((inst) => {
                  const instTotal = inst.accounts.reduce((sum, a) => sum + signedBalance(a), 0);
                  return (
                    <div className="card" key={inst.item_id}>
                      <div className="inst-header">
                        <div className="inst-name">{inst.institution_name}</div>
                        <div className="inst-total">{fmt(instTotal)}</div>
                      </div>

                      {inst.accounts.length > 0 && (
                        <table>
                          <tbody>
                            {inst.accounts.map((a) => (
                              <Fragment key={a.account_id}>
                                <tr
                                  className="acct-row"
                                  onClick={() => toggleAccount(a.account_id)}
                                  aria-expanded={expandedAccounts.has(a.account_id)}
                                >
                                  <td>
                                    {a.name}
                                    <div className="type-tag">{a.subtype || a.type}</div>
                                  </td>
                                  <td className="num">{fmt(signedBalance(a))}</td>
                                </tr>
                                {expandedAccounts.has(a.account_id) && (
                                  <tr>
                                    <td colSpan={2} className="acct-chart-cell">
                                      <AccountSparkline accountId={a.account_id} />
                                    </td>
                                  </tr>
                                )}
                              </Fragment>
                            ))}
                          </tbody>
                        </table>
                      )}

                      {inst.holdings.length > 0 && (
                        <>
                          <h2>Holdings</h2>
                          <table>
                            <thead>
                              <tr>
                                <th>Security</th>
                                <th className="num">Qty</th>
                                <th className="num">Value</th>
                              </tr>
                            </thead>
                            <tbody>
                              {inst.holdings.map((h, i) => (
                                <tr key={i}>
                                  <td>{h.name}</td>
                                  <td className="num">{h.quantity?.toFixed(3) ?? '--'}</td>
                                  <td className="num">
                                    {fmt(h.value)}
                                    {h.value != null && h.cost_basis != null && (
                                      <div
                                        className={`gain${h.value - h.cost_basis >= 0 ? ' inflow' : ' loss'}`}
                                      >
                                        {fmtGain(h.value, h.cost_basis)}
                                      </div>
                                    )}
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </>
                      )}

                      {inst.error && <div className="error">{inst.error}</div>}

                      <div className="card-actions">
                        {inst.needs_reauth && (
                          <button onClick={() => startReconnect(inst.item_id)} disabled={connecting}>
                            Reconnect
                          </button>
                        )}
                        <button
                          className="secondary"
                          onClick={() => disconnect(inst.item_id, inst.institution_name)}
                        >
                          Disconnect
                        </button>
                      </div>
                    </div>
                  );
                })}
              </>
            )}

            {tab === 'activity' && (
              <MonthBreakdown
                txns={txns}
                notes={txnNotes}
                loading={txnsLoading}
                onRecategorize={recategorize}
              />
            )}

            {tab === 'budgets' && (
              <BudgetsTab
                txns={txns}
                budgets={budgets}
                onSave={saveBudgets}
                goals={goals}
                onSaveGoals={saveGoals}
                accounts={institutions.flatMap((i) =>
                  i.accounts.map((a) => ({
                    account_id: a.account_id,
                    name: a.name,
                    institution: i.institution_name,
                    balance: a.balance,
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
    </>
  );
}
