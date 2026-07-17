'use client';

// Activity tab: month-by-month breakdown of the last ~12 months of
// transactions. A scrollable "Net by month" column row selects the month —
// each column's height is that month's net magnitude and its color the sign
// (green positive, red negative). Below it, a two-line chart traces cumulative
// income vs spend across the days of the selected month. Then a summary shows
// money in / money out / net (transfers and loan payments excluded, so
// credit-card payments don't double-count as both spending and income); top
// spending categories draw as single-hue horizontal bars (magnitude lives in
// length, not color); and finally the searchable transaction list.

import { useEffect, useMemo, useRef, useState } from 'react';
import MonthFlowChart from './MonthFlowChart';

export type Txn = {
  transaction_id: string;
  date: string;
  name: string;
  amount: number;
  pending: boolean;
  account_name: string;
  institution_name: string;
  category: string | null;
};

function fmtUsd(n: number): string {
  return (n < 0 ? '-$' : '$') + Math.abs(n).toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

// Compact, signed currency for the net-bar value labels: +$1.2K / -$340.
function fmtCompactSigned(n: number): string {
  const sign = n < 0 ? '-' : '+';
  const abs = Math.abs(n);
  return abs >= 1000 ? `${sign}$${(abs / 1000).toFixed(1)}K` : `${sign}$${Math.round(abs)}`;
}

// Plaid's convention: positive amounts are money leaving the account.
function fmtTxnAmount(amount: number): string {
  const abs = Math.abs(amount).toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return amount > 0 ? `-$${abs}` : `+$${abs}`;
}

function fmtTxnDate(iso: string): string {
  return new Date(`${iso}T00:00:00`).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
  });
}

function monthLabel(ym: string): string {
  const d = new Date(`${ym}-01T00:00:00`);
  const now = new Date();
  const sameYear = d.getFullYear() === now.getFullYear();
  return d.toLocaleDateString(undefined, sameYear ? { month: 'short' } : { month: 'short', year: '2-digit' });
}

// Money moving between your own accounts isn't income or spending.
export function isTransfer(t: Txn): boolean {
  return !!t.category && (t.category.startsWith('transfer') || t.category === 'loan payments');
}

// Base category options for recategorization, merged with whatever
// categories appear in the data.
const BASE_CATEGORIES = [
  'food and drink',
  'general merchandise',
  'transportation',
  'travel',
  'rent and utilities',
  'entertainment',
  'personal care',
  'medical',
  'general services',
  'income',
  'transfer in',
  'transfer out',
  'loan payments',
  'other',
];

export default function MonthBreakdown({
  txns,
  notes,
  loading,
  onRecategorize,
}: {
  txns: Txn[] | null;
  notes: string[];
  loading: boolean;
  onRecategorize: (transaction_id: string, category: string) => void;
}) {
  const [month, setMonth] = useState<string | null>(null); // YYYY-MM; null = latest
  const [query, setQuery] = useState('');
  const [recatId, setRecatId] = useState<string | null>(null); // txn being recategorized

  const categoryOptions = useMemo(() => {
    const set = new Set(BASE_CATEGORIES);
    (txns ?? []).forEach((t) => {
      if (t.category) set.add(t.category);
    });
    return [...set].sort();
  }, [txns]);

  const months = useMemo(() => {
    const set = new Set<string>();
    (txns ?? []).forEach((t) => set.add(t.date.slice(0, 7)));
    return [...set].sort().reverse().slice(0, 12);
  }, [txns]);

  const selected = month ?? months[0] ?? null;

  const monthTxns = useMemo(
    () => (txns ?? []).filter((t) => t.date.slice(0, 7) === selected),
    [txns, selected]
  );

  const { moneyIn, moneyOut, categories } = useMemo(() => {
    let inflow = 0;
    let outflow = 0;
    const byCategory: Record<string, number> = {};
    for (const t of monthTxns) {
      if (isTransfer(t)) continue;
      if (t.amount < 0) {
        inflow += -t.amount;
      } else {
        outflow += t.amount;
        const cat = t.category ?? 'other';
        byCategory[cat] = (byCategory[cat] ?? 0) + t.amount;
      }
    }
    const categories = Object.entries(byCategory)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5);
    return { moneyIn: inflow, moneyOut: outflow, categories };
  }, [monthTxns]);

  // Spending per month (oldest → newest) for the trend columns. Bar height
  // tracks spending (out); bar color tracks that month's net (in − out) so a
  // month you overspent reads red and a month you saved reads green.
  const trend = useMemo(
    () =>
      [...months].reverse().map((m) => {
        let inflow = 0;
        let outflow = 0;
        for (const t of txns ?? []) {
          if (t.date.slice(0, 7) !== m || isTransfer(t)) continue;
          if (t.amount < 0) inflow += -t.amount;
          else outflow += t.amount;
        }
        return { month: m, out: outflow, net: inflow - outflow };
      }),
    [txns, months]
  );

  // Keep the newest month in view when the row overflows (older months scroll
  // off to the left).
  const trendRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = trendRef.current;
    if (el) el.scrollLeft = el.scrollWidth;
  }, [trend.length]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return monthTxns;
    return monthTxns.filter(
      (t) =>
        t.name.toLowerCase().includes(q) ||
        (t.category ?? '').includes(q) ||
        t.account_name.toLowerCase().includes(q) ||
        t.institution_name.toLowerCase().includes(q)
    );
  }, [monthTxns, query]);

  if (loading) {
    return (
      <div className="card">
        <div className="spinner" role="status" aria-label="Loading transactions" />
      </div>
    );
  }

  if (!txns || (txns.length === 0 && notes.length === 0)) {
    return (
      <div className="card">
        <p className="empty-note">No transactions in the last 12 months.</p>
      </div>
    );
  }

  const net = moneyIn - moneyOut;
  const maxCat = categories.length > 0 ? categories[0][1] : 1;

  return (
    <>
      {trend.length > 1 && (
        <div className="card">
          <div className="inst-header">
            <div className="inst-name">Net by month</div>
            <div className="inst-total">tap a month to select</div>
          </div>
          <div className="trend-row" ref={trendRef}>
            {(() => {
              const max = Math.max(...trend.map((t) => Math.abs(t.net)), 1);
              return trend.map(({ month: m, net }) => (
                <button
                  key={m}
                  className={`trend-col${m === selected ? ' active' : ''}`}
                  onClick={() => setMonth(m)}
                  aria-pressed={m === selected}
                  aria-label={`${monthLabel(m)}: net ${fmtUsd(net)}`}
                >
                  <span className="trend-val">{fmtCompactSigned(net)}</span>
                  <span
                    className={`trend-bar${net >= 0 ? ' up' : ' down'}`}
                    style={{ height: `${Math.max((Math.abs(net) / max) * 72, 2)}px` }}
                  />
                  <span className="trend-label">{monthLabel(m)}</span>
                </button>
              ));
            })()}
          </div>
        </div>
      )}

      {selected && monthTxns.length > 0 && (
        <div className="card">
          <div className="inst-header">
            <div className="inst-name">Income vs spend</div>
            <div className="inst-total">{monthLabel(selected)}</div>
          </div>
          <MonthFlowChart txns={monthTxns} month={selected} />
        </div>
      )}

      <div className="card">
        <div className="summary-row">
          <div>
            <div className="total-label">In</div>
            <div className="summary-value inflow">{fmtUsd(moneyIn)}</div>
          </div>
          <div>
            <div className="total-label">Out</div>
            <div className="summary-value">{fmtUsd(moneyOut)}</div>
          </div>
          <div>
            <div className="total-label">Net</div>
            <div className={`summary-value${net < 0 ? ' negative' : net > 0 ? ' inflow' : ''}`}>
              {fmtUsd(net)}
            </div>
          </div>
        </div>
        <div className="chart-note">Transfers and loan payments excluded.</div>
      </div>

      {categories.length > 0 && (
        <div className="card">
          <div className="inst-header">
            <div className="inst-name">Top spending</div>
          </div>
          <div className="cat-list">
            {categories.map(([cat, sum]) => (
              <div className="cat-row" key={cat}>
                <span className="cat-name">{cat}</span>
                <div className="cat-track">
                  <div className="cat-bar" style={{ width: `${(sum / maxCat) * 100}%` }} />
                </div>
                <span className="cat-val">{fmtUsd(sum)}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="card">
        <div className="inst-header">
          <div className="inst-name">Transactions</div>
          <div className="inst-total">
            {visible.length}
            {query ? ` of ${monthTxns.length}` : ''}
          </div>
        </div>

        <input
          className="text-input search-input"
          type="search"
          placeholder="Search transactions"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />

        {visible.length === 0 ? (
          <p className="empty-note">
            {query ? 'No transactions match your search.' : 'No transactions this month.'}
          </p>
        ) : (
          <table>
            <tbody>
              {visible.map((t) => (
                <tr
                  key={t.transaction_id}
                  className="acct-row"
                  onClick={() => setRecatId(recatId === t.transaction_id ? null : t.transaction_id)}
                >
                  <td className="txn-date">{fmtTxnDate(t.date)}</td>
                  <td>
                    {t.name}
                    {t.pending && <span className="pending-tag"> · pending</span>}
                    <div className="type-tag">
                      {t.institution_name} · {t.account_name}
                      {t.category ? ` · ${t.category}` : ''}
                    </div>
                    {recatId === t.transaction_id && (
                      <select
                        className="text-input recat-select"
                        value={t.category ?? 'other'}
                        onClick={(e) => e.stopPropagation()}
                        onChange={(e) => {
                          onRecategorize(t.transaction_id, e.target.value);
                          setRecatId(null);
                        }}
                        aria-label={`Category for ${t.name}`}
                      >
                        {categoryOptions.map((c) => (
                          <option key={c} value={c}>
                            {c}
                          </option>
                        ))}
                      </select>
                    )}
                  </td>
                  <td className={`num${t.amount < 0 ? ' inflow' : ''}`}>{fmtTxnAmount(t.amount)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        {notes.map((n) => (
          <div className="error" key={n}>
            {n}
          </div>
        ))}
      </div>
    </>
  );
}
