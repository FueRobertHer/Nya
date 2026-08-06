'use client';

// Small computed observations for the Home tab -- the "is this normal?"
// glance the big trackers lead with. Everything derives from data already
// loaded (history + transactions), no extra API calls.

import { useMemo } from 'react';
import { type Txn } from './MonthBreakdown';
import { detectRecurring, upcomingBills } from '@/lib/recurring';
import { formatMoney, dominantCurrency } from '@/lib/format';

export type InsightAccount = {
  name: string;
  type: string;
  balance: number | null;
  currency: string | null;
  liability?: {
    minimum_payment: number | null;
    next_due_date: string | null;
    is_overdue: boolean | null;
  };
};

const LOW_BALANCE_THRESHOLD = 100;
const MAX_INSIGHTS = 6;

const TRANSFER_CODES = new Set(['transfer', 'atm', 'bank charge']);
function isTransfer(t: Txn): boolean {
  if (t.transaction_code && TRANSFER_CODES.has(t.transaction_code)) return true;
  return !!t.category && (t.category.startsWith('transfer') || t.category === 'loan payments');
}

type Insight = { key: string; text: string; tone: 'up' | 'down' | 'neutral' };

export default function Insights({
  txns,
  budgets,
  accounts,
}: {
  txns: Txn[] | null;
  budgets: Record<string, number>;
  accounts: InsightAccount[];
}) {
  const insights = useMemo<Insight[]>(() => {
    const out: Insight[] = [];
    const now = new Date();
    const thisMonthKey = now.toISOString().slice(0, 7);
    // One display currency for summed/budget figures (budgets carry no currency
    // of their own). Per-item amounts below use their own currency where known.
    const displayCurrency = dominantCurrency(txns ?? []);

    // --- alerts first: they're the actionable ones ---

    // Over / approaching budget (worst offenders first, max 2).
    if (txns) {
      const spendByCat: Record<string, number> = {};
      for (const t of txns) {
        if (t.date.slice(0, 7) !== thisMonthKey || t.amount <= 0 || isTransfer(t)) continue;
        const cat = t.category ?? 'other';
        spendByCat[cat] = (spendByCat[cat] ?? 0) + t.amount;
      }
      const flagged = Object.entries(budgets)
        .map(([cat, budget]) => ({ cat, budget, spent: spendByCat[cat] ?? 0 }))
        .filter(({ spent, budget }) => spent / budget >= 0.9)
        .sort((a, b) => b.spent / b.budget - a.spent / a.budget)
        .slice(0, 2);
      for (const { cat, budget, spent } of flagged) {
        out.push(
          spent >= budget
            ? {
                key: `budget-${cat}`,
                text: `Over your ${cat} budget — ${formatMoney(spent, displayCurrency)} of ${formatMoney(budget, displayCurrency)}`,
                tone: 'down',
              }
            : {
                key: `budget-${cat}`,
                text: `Approaching your ${cat} budget (${Math.round((spent / budget) * 100)}%)`,
                tone: 'neutral',
              }
        );
      }
    }

    // Low balance on any checking/savings account. Keyed by position as well
    // as name: two accounts can share a name (a manual account tracking the
    // same institution as a linked one, say), and a duplicate React key would
    // drop one of the alerts.
    for (const [i, a] of accounts.entries()) {
      if (a.type === 'depository' && a.balance != null && a.balance < LOW_BALANCE_THRESHOLD) {
        out.push({
          key: `low-${i}-${a.name}`,
          text: `Low balance: ${a.name} at ${formatMoney(a.balance, a.currency)}`,
          tone: 'down',
        });
      }
    }

    // Card and loan payments coming due, from Plaid's liabilities data rather
    // than inferred from transactions. Max 2, overdue first, since an overdue
    // payment is the more actionable of the two.
    const overdue: Insight[] = [];
    const dueSoon: { days: number; insight: Insight }[] = [];
    // Local midnight today, so "days until" counts calendar days rather than
    // 24-hour blocks from this instant. Comparing against `now` directly made
    // the answer drift by one over the course of the day: after local noon a
    // payment due today rounded to -1 and was dropped as already past.
    const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    for (const [i, a] of accounts.entries()) {
      const l = a.liability;
      if (!l) continue;
      if (l.is_overdue) {
        overdue.push({
          key: `overdue-${i}-${a.name}`,
          text: `${a.name} is overdue${l.minimum_payment != null ? ` — ${formatMoney(l.minimum_payment, a.currency)} minimum` : ''}`,
          tone: 'down',
        });
        continue;
      }
      if (!l.next_due_date) continue;
      const days = Math.round(
        (new Date(`${l.next_due_date}T00:00:00`).getTime() - midnight) / 86_400_000
      );
      // `days >= 0` matters: the dashboard hydrates from a localStorage
      // snapshot with no TTL, so a stale payload can carry a due date that has
      // since passed, and "due in -4 days" would render on first paint.
      if (days < 0 || days > 7) continue;
      dueSoon.push({
        days,
        insight: {
          key: `due-${i}-${a.name}`,
          text: `${a.name}: ${l.minimum_payment != null ? `${formatMoney(l.minimum_payment, a.currency)} ` : ''}due ${days === 0 ? 'today' : days === 1 ? 'tomorrow' : `in ${days} days`}`,
          tone: 'neutral',
        },
      });
    }
    // Soonest first within each group, matching the recurring-bills block
    // below. Sorting the merged list would let a far-off due date outrank an
    // account that's already overdue.
    dueSoon.sort((x, y) => x.days - y.days);
    out.push(...[...overdue, ...dueSoon.map((d) => d.insight)].slice(0, 2));

    // Recurring bills expected within a week (soonest first, max 2,
    // deduped by name -- the same bill on two linked accounts is one bill).
    if (txns) {
      const seen = new Set<string>();
      for (const b of upcomingBills(detectRecurring(txns), 7)) {
        if (seen.has(b.name)) continue;
        seen.add(b.name);
        out.push({
          key: `bill-${b.name}`,
          text: `Upcoming: ${b.name} (~${formatMoney(b.amount, b.currency ?? displayCurrency)}) around ${new Date(`${b.nextDate}T00:00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`,
          tone: 'neutral',
        });
        if (seen.size >= 2) break;
      }
    }

    if (txns && txns.length > 0) {
      const thisMonth = now.toISOString().slice(0, 7);
      const lastMonthDate = new Date(now.getFullYear(), now.getMonth() - 1, 1);
      const lastMonth = `${lastMonthDate.getFullYear()}-${String(lastMonthDate.getMonth() + 1).padStart(2, '0')}`;

      const spend = (month: string) =>
        txns
          .filter((t) => t.date.slice(0, 7) === month && t.amount > 0 && !isTransfer(t))
          .reduce((sum, t) => sum + t.amount, 0);

      // --- spending pace vs last month, prorated to the same day-of-month ---
      const thisSpend = spend(thisMonth);
      const lastSpend = spend(lastMonth);
      if (thisSpend > 0 && lastSpend > 0) {
        const daysInLastMonth = new Date(now.getFullYear(), now.getMonth(), 0).getDate();
        const prorated = lastSpend * (now.getDate() / daysInLastMonth);
        if (prorated > 0) {
          const ratio = thisSpend / prorated;
          const pct = Math.abs(ratio - 1) * 100;
          const monthName = lastMonthDate.toLocaleDateString(undefined, { month: 'long' });
          out.push(
            pct < 5
              ? {
                  key: 'pace',
                  text: `Spending is tracking about even with ${monthName}'s pace`,
                  tone: 'neutral',
                }
              : {
                  key: 'pace',
                  text: `Spending is tracking ${pct.toFixed(0)}% ${ratio > 1 ? 'above' : 'below'} ${monthName}'s pace`,
                  // more spending = down-tone, less = up-tone
                  tone: ratio > 1 ? 'down' : 'up',
                }
          );
        }
      }

      // --- biggest purchase this month ---
      const purchases = txns.filter(
        (t) => t.date.slice(0, 7) === thisMonth && t.amount > 0 && !isTransfer(t)
      );
      if (purchases.length > 0) {
        const biggest = purchases.reduce((a, b) => (b.amount > a.amount ? b : a));
        out.push({
          key: 'biggest',
          text: `Biggest purchase this month: ${biggest.name}, ${formatMoney(biggest.amount, biggest.iso_currency_code)}`,
          tone: 'neutral',
        });
      }
    }

    return out.slice(0, MAX_INSIGHTS);
  }, [txns, budgets, accounts]);

  if (insights.length === 0) return null;

  return (
    <div className="card">
      <div className="inst-header">
        <div className="inst-name">Insights</div>
      </div>
      <ul className="insight-list">
        {insights.map((i) => (
          <li key={i.key} className={`insight insight-${i.tone}`}>
            {i.text}
          </li>
        ))}
      </ul>
    </div>
  );
}
