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

type Payload = { txns: InvestmentTxn[]; ytd_contributions: number; note: string | null };

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
    fetch(
      `/api/investment-activity?id=${encodeURIComponent(accountId)}&item_id=${encodeURIComponent(itemId)}`
    )
      .then((res) => {
        if (!res.ok) throw new Error();
        return res.json();
      })
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
  if (data.note) return <p className="empty-note">{data.note}.</p>;
  if (data.txns.length === 0) {
    return <p className="empty-note">No investment activity in the last year.</p>;
  }

  return (
    <div className="inv-activity">
      {data.ytd_contributions > 0 && (
        <div className="type-tag">
          {formatMoney(data.ytd_contributions, data.txns[0]?.currency)} contributed this year
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
