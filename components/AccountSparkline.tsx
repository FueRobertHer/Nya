'use client';

// Tap-to-expand balance history for a single account (Accounts tab). Fetches
// its own data on mount -- the endpoint reads straight from Redis (no Plaid
// calls), so it's fast enough to load per tap.
//
// For a linked investment account (`itemId` set) it also draws how much of the
// balance is money added versus growth (lib/growth.ts). That needs the account's
// investment transactions, which come from a live Plaid call, so the chart
// renders first and the second line joins it when they arrive. They are the
// same payload InvestmentActivity shows below, loaded once for both.

import { useCallback, useEffect, useState } from 'react';
import NetWorthChart, { type HistoryPoint } from './NetWorthChart';
import { loadInvestmentActivity, type InvestmentActivityPayload } from './InvestmentActivity';
import { contributionBaseline } from '@/lib/growth';

export default function AccountSparkline({
  accountId,
  itemId,
  currency,
  previewWith,
  investment = false,
  owed = false,
}: {
  accountId: string;
  /** An investment account: its chart offers ranges in years (YTD, 1Y, 3Y...). */
  investment?: boolean;
  /** A credit card or loan: its change shows no percentage. */
  owed?: boolean;
  /** An earlier id to join onto this account's chart as a preview, before the
   *  user links it (lib/links.ts). Read-only. */
  previewWith?: string;
  /** The account's ISO currency, so its chart doesn't print a EUR account in $. */
  currency?: string | null;
  /** The account's Plaid Item, for an investment account; enables the split. */
  itemId?: string;
}) {
  const [points, setPoints] = useState<HistoryPoint[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [activity, setActivity] = useState<InvestmentActivityPayload | null>(null);

  useEffect(() => {
    let cancelled = false;
    const withParam = previewWith ? `&with=${encodeURIComponent(previewWith)}` : '';
    fetch(`/api/account-history?id=${encodeURIComponent(accountId)}${withParam}`)
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
  }, [accountId, previewWith]);

  useEffect(() => {
    if (!itemId) return;
    let cancelled = false;
    loadInvestmentActivity(accountId, itemId)
      .then((d) => {
        if (!cancelled) setActivity(d);
      })
      .catch(() => {
        // The balance chart stands on its own; InvestmentActivity reports the failure.
      });
    return () => {
      cancelled = true;
    };
  }, [accountId, itemId]);

  // Given the selected range's points, so money added and growth count from
  // the start of the range.
  const baselineFor = useCallback(
    (shown: HistoryPoint[]) =>
      activity ? contributionBaseline(shown, activity.flows, activity.flows_from, activity.flows_to) : null,
    [activity]
  );

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
  return (
    <NetWorthChart
      points={points}
      label="Balance"
      baselineFor={activity ? baselineFor : null}
      currency={currency}
      rangeSet={investment ? 'investment' : 'balance'}
      // A preview is for checking the joined history, all of it.
      initialRange={previewWith ? 'ALL' : undefined}
      owed={owed}
    />
  );
}
