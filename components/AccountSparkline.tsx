'use client';

// Tap-to-expand balance history for a single account (Accounts tab). Fetches
// its own data on mount -- the endpoint reads straight from Redis (no Plaid
// calls), so it's fast enough to load per tap.

import { useEffect, useState } from 'react';
import NetWorthChart, { type HistoryPoint } from './NetWorthChart';

export default function AccountSparkline({ accountId }: { accountId: string }) {
  const [points, setPoints] = useState<HistoryPoint[] | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/account-history?id=${encodeURIComponent(accountId)}`)
      .then((res) => {
        if (!res.ok) throw new Error();
        return res.json();
      })
      .then((data) => {
        if (!cancelled) setPoints(data.points ?? []);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [accountId]);

  if (failed) return <div className="error">Could not load account history.</div>;
  if (points === null) {
    return <div className="spinner" role="status" aria-label="Loading account history" />;
  }
  if (points.length < 2) {
    return (
      <p className="empty-note">
        Not enough history for this account yet — it builds as snapshots accumulate.
      </p>
    );
  }
  return <NetWorthChart points={points} label="Balance" />;
}
