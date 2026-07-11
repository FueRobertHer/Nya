'use client';

import { useCallback, useEffect, useState } from 'react';
import { usePlaidLink, type PlaidLinkOnSuccessMetadata } from 'react-plaid-link';

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
};

type Institution = {
  institution_name: string;
  item_id: string;
  accounts: Account[];
  holdings: Holding[];
  error: string | null;
  needs_reauth: boolean;
};

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

export default function Dashboard() {
  const [linkToken, setLinkToken] = useState<string | null>(null);
  const [linkMode, setLinkMode] = useState<'new' | 'update'>('new');
  const [connected, setConnected] = useState(false);
  const [institutions, setInstitutions] = useState<Institution[]>([]);
  const [netWorth, setNetWorth] = useState(0);
  const [error, setError] = useState('');
  const [connecting, setConnecting] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  const loadNetWorth = useCallback(async () => {
    setRefreshing(true);
    const res = await fetch('/api/net-worth');
    setRefreshing(false);
    if (!res.ok) {
      setError('Failed to load accounts.');
      return;
    }
    const data = await res.json();
    setInstitutions(data.institutions);
    setNetWorth(data.netWorth);
    setConnected(data.institutions.length > 0);
  }, []);

  useEffect(() => {
    loadNetWorth();
  }, [loadNetWorth]);

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
      loadNetWorth();
    },
    [loadNetWorth]
  );

  const logout = useCallback(async () => {
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
        loadNetWorth();
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
      loadNetWorth();
    },
    [linkMode, institutions, loadNetWorth]
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

  return (
    <main className="wrap">
      <div className="top-row">
        <div>
          <h1>Nya</h1>
          <p className="sub">
            {connected
              ? `${institutions.length} institution${institutions.length === 1 ? '' : 's'} connected`
              : 'Connect your bank, credit card, and brokerage accounts'}
          </p>
        </div>
        <button className="secondary logout-btn" onClick={logout}>
          Log out
        </button>
      </div>

      <div className="card">
        <button onClick={startConnect} disabled={connecting}>
          {connecting ? 'Starting…' : 'Connect an Account'}
        </button>
        {error && <div className="error">{error}</div>}
      </div>

      {connected && (
        <>
          <div className="card">
            <div className="total-label">Net Worth</div>
            <div className={`total-value${netWorth < 0 ? ' negative' : ''}`}>{fmt(netWorth)}</div>
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
                        <tr key={a.account_id}>
                          <td>
                            {a.name}
                            <div className="type-tag">{a.subtype || a.type}</div>
                          </td>
                          <td className="num">{fmt(signedBalance(a))}</td>
                        </tr>
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
                            <td className="num">{fmt(h.value)}</td>
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

          <button className="secondary" onClick={loadNetWorth} disabled={refreshing}>
            {refreshing ? 'Refreshing…' : 'Refresh'}
          </button>
        </>
      )}
    </main>
  );
}
