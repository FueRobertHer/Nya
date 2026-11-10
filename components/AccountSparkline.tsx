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
//
// With `moneyInOut` it also draws the account's money in and out above the
// chart (components/MoneyInOutFigures.tsx), from the same payload and this
// history, and carries the grey line from the totals the person set
// (lib/growth.ts usableTotals). A save or a clear reloads the payload
// (onMoneyInOutSaved), so both change at once.

import { useCallback, useEffect, useState } from 'react';
import NetWorthChart, { type HistoryPoint } from './NetWorthChart';
import { loadInvestmentActivity, onMoneyInOutSaved, type InvestmentActivityPayload } from './InvestmentActivity';
import MoneyInOutFigures, { MoneyInOutSkeleton, type MoneyInOutTarget } from './MoneyInOutFigures';
import { contributionBaseline, usableTotals } from '@/lib/growth';
import { Notice } from './TotalCaveats';

export default function AccountSparkline({
  accountId,
  itemId,
  currency,
  previewWith,
  investment = false,
  owed = false,
  moneyInOut,
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
  /** Its money in and out above the chart, for an investment account's sheet:
   *  its live balance, how the form names it, and opening the form. */
  moneyInOut?: { balance: number | null | undefined; label: string; onEdit: (target: MoneyInOutTarget) => void };
}) {
  const [points, setPoints] = useState<HistoryPoint[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [activity, setActivity] = useState<InvestmentActivityPayload | null>(null);
  const [activityFailed, setActivityFailed] = useState(false);
  // Bumped when this account's money in and out are saved: loads it again.
  const [saves, setSaves] = useState(0);
  useEffect(() => {
    if (!itemId) return;
    const mine = `${itemId}:${accountId}`;
    return onMoneyInOutSaved((key) => {
      if (key === mine) setSaves((n) => n + 1);
    });
  }, [accountId, itemId]);

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
        if (cancelled) return;
        setActivity(d);
        setActivityFailed(false);
      })
      .catch(() => {
        // The balance chart stands on its own; InvestmentActivity reports the failure.
        if (!cancelled) setActivityFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [accountId, itemId, saves]);

  // The totals, when the grey line can be carried from them.
  const totals = activity?.money_in_out ?? null;
  const carried = usableTotals(totals, activity?.flows_from) ? totals : null;
  // Given the selected range's points, so money in, out and growth count from
  // the start of the range.
  const baselineFor = useCallback(
    (shown: HistoryPoint[]) =>
      activity ? contributionBaseline(shown, activity.flows, activity.flows_from, activity.flows_to, carried, activity.moves) : null,
    [activity, carried]
  );

  // Above the chart, whatever the chart's own state: it reads the history
  // only for where the line starts and a measuring day.
  let figures = null;
  if (moneyInOut && itemId && !previewWith) {
    // Nothing once the activity has failed to load: InvestmentActivity says so.
    if (!activity) figures = activityFailed ? null : <MoneyInOutSkeleton />;
    else if (activity.flows && activity.flows_from) {
      figures = (
        <MoneyInOutFigures
          target={{
            account_id: accountId,
            item_id: itemId,
            label: moneyInOut.label,
            currency: currency ?? null,
            totals,
            flows: activity.flows,
            flows_from: activity.flows_from,
          }}
          unreadable={!!activity.money_in_out_unreadable}
          flowsTo={activity.flows_to}
          balance={moneyInOut.balance}
          points={points}
          onEdit={moneyInOut.onEdit}
        />
      );
    }
  }

  if (failed)
    return (
      <>
        {figures}
        <Notice level="critical" role="alert">
          Could not load account history.
        </Notice>
      </>
    );
  if (points === null) {
    // Roughly the chart's own height, so the chart replacing it moves nothing.
    return (
      <>
        {figures}
        <div className="chart-loading">
          <div className="chart-loading-box">
            <div className="spinner" role="status" aria-label="Loading account history" />
          </div>
        </div>
      </>
    );
  }
  if (points.length < 2) {
    return (
      <>
        {figures}
        <p className="empty-note">
          Not enough history for this account yet: it builds as snapshots accumulate.
        </p>
      </>
    );
  }
  return (
    <>
      {figures}
      <NetWorthChart
        points={points}
        label="Balance"
        baselineFor={activity ? baselineFor : null}
        baselineFrom={carried?.as_of ?? null}
        currency={currency}
        rangeSet={investment ? 'investment' : 'balance'}
        // A preview is for checking the joined history, all of it.
        initialRange={previewWith ? 'ALL' : undefined}
        owed={owed}
        // An investment account keeps the line's row from the start and whatever
        // its transactions turn out to say (they may fail, or have no split for the
        // range): a row that came and went would shift the page, and one blank line
        // is cheaper than that.
        reserveSplit={!!itemId}
      />
    </>
  );
}
