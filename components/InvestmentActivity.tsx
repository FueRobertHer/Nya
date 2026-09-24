'use client';

// Recent activity for one investment account, shown under the balance chart
// when an investment row is expanded (Accounts tab). Fetches its own data on
// mount like AccountSparkline -- but unlike that one this endpoint makes live
// Plaid calls, so it's cached server-side for 15 minutes to survive an
// expand/collapse loop.

import { useEffect, useState } from 'react';
import { formatMoney } from '@/lib/format';

type InvestmentTxn = {
  investment_transaction_id: string;
  date: string;
  name: string;
  type: string;
  subtype: string;
  quantity: number;
  amount: number;
  currency: string | null;
  security: string | null;
};

export type InvestmentActivityPayload = {
  txns: InvestmentTxn[];
  ytd_contributions: number;
  ytd_rollovers: number;
  /** Money crossing the account boundary per day, for the chart's added-vs-
   *  growth line. Null when unavailable or withheld (see the route). */
  flows?: { date: string; amount: number }[] | null;
  flows_from?: string | null;
  /** Last date the flows are known complete for; the line stops there. */
  flows_to?: string | null;
  note: string | null;
};
type Payload = InvestmentActivityPayload;

// One request per account for both readers. The expanded row mounts this list
// and the balance chart together, and both want this payload: fetched
// separately they would miss the server cache together and cost two live
// Plaid calls. Reused for a minute, which covers that and an expand/collapse;
// the server's own 15-minute cache covers the rest. A failure is dropped at
// once so the next mount retries.
const REUSE_MS = 60_000;
const inflight = new Map<string, { at: number; promise: Promise<Payload> }>();

export function loadInvestmentActivity(accountId: string, itemId: string): Promise<Payload> {
  const key = `${itemId}:${accountId}`;
  const hit = inflight.get(key);
  if (hit && Date.now() - hit.at < REUSE_MS) return hit.promise;
  const promise = fetch(
    `/api/investment-activity?id=${encodeURIComponent(accountId)}&item_id=${encodeURIComponent(itemId)}`
  ).then((res) => {
    if (!res.ok) throw new Error(`investment-activity ${res.status}`);
    return res.json() as Promise<Payload>;
  });
  inflight.set(key, { at: Date.now(), promise });
  promise.catch(() => {
    if (inflight.get(key)?.promise === promise) inflight.delete(key);
  });
  return promise;
}

function fmtDay(iso: string): string {
  // Parsed at local midnight, not UTC, so a date never renders as the day
  // before for anyone west of Greenwich.
  const d = new Date(`${iso}T00:00:00`);
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/**
 * Plaid reports a positive amount when cash is debited. Flipped here so money
 * arriving in the account reads positive, matching how the Activity tab renders
 * cash transactions.
 *
 * Note this is cash movement, not change in total value: a buy shows as a large
 * negative even though the account is worth the same afterwards, because the
 * cash became securities. The caption below the table says so.
 */
function fmtAmount(t: InvestmentTxn): string {
  const flipped = -t.amount;
  try {
    return new Intl.NumberFormat(undefined, {
      style: 'currency',
      currency: t.currency || 'USD',
      signDisplay: 'always',
    }).format(flipped);
  } catch {
    return formatMoney(flipped, t.currency);
  }
}

export default function InvestmentActivity({
  accountId,
  itemId,
}: {
  accountId: string;
  itemId: string;
}) {
  const [data, setData] = useState<Payload | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    loadInvestmentActivity(accountId, itemId)
      .then((d) => {
        if (!cancelled) setData(d);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [accountId, itemId]);

  if (failed) return <div className="error">Could not load investment activity.</div>;
  if (data === null) {
    return <div className="spinner" role="status" aria-label="Loading investment activity" />;
  }
  // With stored history, a note (institution down, storage problem) no longer
  // means there is nothing to show: say it, then show what is stored.
  if (data.txns.length === 0) {
    return <p className="empty-note">{data.note ? `${data.note}.` : 'No investment activity yet.'}</p>;
  }

  return (
    <div className="inv-activity">
      {data.note && <p className="empty-note">{data.note}; showing saved activity.</p>}
      {data.ytd_contributions > 0 && (
        <div className="type-tag">
          {formatMoney(data.ytd_contributions, data.txns[0]?.currency)} contributed this year
        </div>
      )}
      {/* Kept on its own line rather than added to the figure above: a rollover
          is existing retirement money arriving, not money saved this year. */}
      {data.ytd_rollovers > 0 && (
        <div className="type-tag">
          {formatMoney(data.ytd_rollovers, data.txns[0]?.currency)} rolled over this year
        </div>
      )}
      <table className="txn-table">
        <tbody>
          {data.txns.map((t) => {
            const inflow = -t.amount > 0;
            return (
              <tr key={t.investment_transaction_id}>
                <td>
                  <div className="txn-text">
                    {t.name}
                    <div className="type-tag">
                      {fmtDay(t.date)} · {t.subtype}
                      {t.security ? ` · ${t.security}` : ''}
                    </div>
                  </div>
                </td>
                <td className={`num${inflow ? ' inflow' : ''}`}>{fmtAmount(t)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <p className="chart-note">
        Amounts are cash moving in and out of the account, not change in its value — a buy spends
        cash to hold securities worth the same.
      </p>
    </div>
  );
}
