'use client';

// Small computed observations for the Home tab -- the "is this normal?"
// glance the big trackers lead with. Everything derives from data already
// loaded (history + transactions), no extra API calls. Spending is what counts
// in totals (lib/spending.ts), as on the Activity and Budgets tabs: in one
// currency, with what is in others named under the list, and so is a month
// that may be missing a connection's transactions, in their words
// (lib/month-coverage.ts).

import { useMemo } from 'react';
import { type Txn } from './MonthBreakdown';
import { countsInTotals, leftOutByCurrency, leftOutText, totalsCurrency } from '@/lib/spending';
import { detectRecurring, upcomingBills } from '@/lib/recurring';
import { instantDay, localMonth } from '@/lib/local-date';
import { formatMoney } from '@/lib/format';
import { isCashOnHand } from '@/lib/balance';
import { RECONNECT_ALERT_DAYS } from '@/lib/connection-state';
import { missingMonthNotes, NO_CONNECTIONS_WITHOUT, type NoTransactionsView } from '@/lib/no-transactions';
import { monthGapNotes, type Incomplete, type Stopped } from '@/lib/month-coverage';

/**
 * A connection Plaid says will end on a date (lib/connection-state.ts,
 * "reconnect soon"). Its card says so from the day Plaid warns; Home raises it
 * too once the date is RECONNECT_ALERT_DAYS away.
 */
export type ReconnectSoon = {
  item_id: string;
  institution_name: string;
  /** When it ends (an ISO time). */
  ends_at: string;
  /** True when that is an estimate rather than Plaid's own figure. */
  ends_estimated?: boolean;
};

const NO_RECONNECTS: ReconnectSoon[] = [];
const NO_GAPS: Incomplete[] = [];
const NO_STOPPED: Stopped[] = [];

/** The Home alerts for connections ending within RECONNECT_ALERT_DAYS, soonest
 *  first, at most two: calendar days on the viewer's own calendar, as the
 *  due-date alerts below count them. */
export function reconnectAlerts(soon: ReconnectSoon[], now: Date = new Date()): { key: string; text: string; days: number }[] {
  const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const out: { key: string; text: string; days: number }[] = [];
  for (const s of soon) {
    const end = new Date(s.ends_at);
    if (Number.isNaN(end.getTime())) continue;
    const days = Math.round((new Date(end.getFullYear(), end.getMonth(), end.getDate()).getTime() - midnight) / 86_400_000);
    if (days > RECONNECT_ALERT_DAYS) continue;
    // An estimate (Plaid gave no time) is said as one.
    const day = end.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    const when = days === 0 ? 'today' : days === 1 ? 'tomorrow' : `in ${s.ends_estimated ? 'about ' : ''}${days} days`;
    const said =
      days < 0
        ? s.ends_estimated
          ? `Plaid expected its connection to end around ${day}`
          : `Plaid said its connection would end on ${day}`
        : s.ends_estimated
          ? `Plaid expects its connection to end ${when}`
          : `Plaid says its connection ends ${when}`;
    out.push({ key: `reconnect-${s.item_id}`, text: `Reconnect ${s.institution_name}: ${said}`, days });
  }
  return out.sort((a, b) => a.days - b.days).slice(0, 2);
}

/**
 * An investment account with more cash sitting in it than looks deliberate,
 * already filtered to the flagged ones by lib/cash.ts. Optional so a caller with
 * no holdings to classify can leave it out; the Dashboard always passes it.
 */
export type IdleCashAccount = {
  /** React key. Account NAMES collide across institutions; ids don't. */
  account_id: string;
  name: string;
  /** Last 4, where the institution reports it. Two accounts at one broker can
   *  share a name, and the Accounts tab tells them apart the same way. */
  mask: string | null;
  institution_name: string;
  cash: number;
  /**
   * Fraction of the account's priced holdings sitting in cash, 0..1, or null
   * where the denominator was degenerate and the percentage would be a claim
   * rather than a measurement.
   */
  share: number | null;
  currency: string | null;
};

// A stable empty default, rather than `= []` in the destructuring: a fresh
// array literal per render is a new identity, which would re-run the memo below
// on every render for any caller that omits the prop.
const NO_IDLE_CASH: IdleCashAccount[] = [];

export type InsightAccount = {
  name: string;
  type: string;
  /** Plaid's, or a manual account's: `cash` marks cash on hand (lib/balance.ts). */
  subtype?: string | null;
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

// 'warn' is the amber the Accounts tab uses for idle cash: worth doing
// something about, but nothing has gone wrong, which is what separates it from
// the red 'down' of an overdue payment.
type Insight = { key: string; text: string; tone: 'up' | 'down' | 'neutral' | 'warn' };

export default function Insights({
  txns,
  budgets,
  accounts,
  idleCash = NO_IDLE_CASH,
  reconnectSoon = NO_RECONNECTS,
  withoutTransactions = NO_CONNECTIONS_WITHOUT,
  incomplete = NO_GAPS,
  stopped = NO_STOPPED,
}: {
  txns: Txn[] | null;
  budgets: Record<string, number>;
  accounts: InsightAccount[];
  idleCash?: IdleCashAccount[];
  reconnectSoon?: ReconnectSoon[];
  /** Connections that bring in no transactions (lib/no-transactions.ts): a
   *  bank account or card whose transactions don't come in leaves the budget
   *  alerts and the pace short, as on the Activity and Budgets tabs. */
  withoutTransactions?: NoTransactionsView;
  /** What may leave this month's spending short, as Activity and Budgets say
   *  it (lib/month-coverage.ts): an institution whose transactions didn't
   *  load or are still importing, and connections that stopped syncing. A
   *  pace or a budget alert that looks finished but isn't misleads. */
  incomplete?: Incomplete[];
  stopped?: Stopped[];
}) {
  const { insights, leftOut, missing } = useMemo(() => {
    const out: Insight[] = [];
    const now = new Date();
    const thisMonthKey = localMonth(now);
    // One currency for summed and budget figures (budgets carry none of their
    // own): only spending in it counts in them. Per-item amounts below use
    // their own currency where known.
    const displayCurrency = totalsCurrency(txns ?? []);

    // --- alerts first: they're the actionable ones ---

    // A connection about to end, first of all: missed, it stops syncing and
    // every number from that bank goes stale.
    for (const a of reconnectAlerts(reconnectSoon, now)) out.push({ key: a.key, text: a.text, tone: 'warn' });

    // Over / approaching budget (worst offenders first, max 2).
    if (txns) {
      const spendByCat: Record<string, number> = {};
      for (const t of txns) {
        if (t.date.slice(0, 7) !== thisMonthKey || t.amount <= 0 || !countsInTotals(t, displayCurrency)) continue;
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

    // Low balance on any checking/savings account. Keyed by position as well as
    // name: two accounts can share a name (a manual account tracking the same
    // institution as a linked one), and a duplicate React key would drop an alert.
    // Not cash on hand (lib/balance.ts): a wallet running low is no risk of an
    // overdraft.
    for (const [i, a] of accounts.entries()) {
      if (a.type === 'depository' && !isCashOnHand(a) && a.balance != null && a.balance < LOW_BALANCE_THRESHOLD) {
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
    // 24-hour blocks from now. Comparing against `now` drifted by one over the
    // day: after local noon a payment due today rounded to -1 and was dropped.
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

    // Uninvested cash in a brokerage: a contribution never placed, or a settlement
    // fund quietly filling up. Largest first, max 2: five brokerages don't need
    // five lines, and the Accounts tab carries the per-account detail.
    for (const a of idleCash.slice(0, 2)) {
      const where = `${a.institution_name} ${a.name}${a.mask ? ` ••${a.mask}` : ''}`;
      const howMuch =
        a.share == null
          ? ''
          : ` · ${(a.share * 100).toFixed(a.share >= 0.1 ? 0 : 1)}% of its holdings`;
      out.push({
        // Keyed by account_id, not name: brokerages call accounts "Individual" and
        // "Roth IRA", so names collide, and a duplicate React key would drop a
        // line (as in the low-balance block above).
        key: `idle-cash-${a.account_id}`,
        text: `${where}: ${formatMoney(a.cash, a.currency)} uninvested${howMuch}`,
        tone: 'warn',
      });
    }

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

    // Spending in another currency than these figures', this month and last
    // (what the budgets and the pace read): named under the list.
    let leftOut: string | null = null;
    if (txns && txns.length > 0) {
      const thisMonth = localMonth(now);
      const lastMonthDate = new Date(now.getFullYear(), now.getMonth() - 1, 1);
      const lastMonth = `${lastMonthDate.getFullYear()}-${String(lastMonthDate.getMonth() + 1).padStart(2, '0')}`;
      leftOut = leftOutText(
        leftOutByCurrency(
          txns.filter((t) => (t.date.slice(0, 7) === thisMonth || t.date.slice(0, 7) === lastMonth) && t.amount > 0),
          displayCurrency
        ),
        displayCurrency,
        { where: 'these figures' }
      );

      const spend = (month: string) =>
        txns
          .filter((t) => t.date.slice(0, 7) === month && t.amount > 0 && countsInTotals(t, displayCurrency))
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
        (t) => t.date.slice(0, 7) === thisMonth && t.amount > 0 && countsInTotals(t, displayCurrency)
      );
      if (purchases.length > 0) {
        const biggest = purchases.reduce((a, b) => (b.amount > a.amount ? b : a));
        out.push({
          key: 'biggest',
          text: `Biggest purchase this month: ${biggest.name}, ${formatMoney(biggest.amount, displayCurrency)}`,
          tone: 'neutral',
        });
      }
    }

    const shown = out.slice(0, MAX_INSIGHTS);
    // Said only beside a figure it is missing from.
    const fromSpending = shown.some((i) => i.key.startsWith('budget-') || i.key === 'pace' || i.key === 'biggest');
    return {
      insights: shown,
      leftOut: fromSpending ? leftOut : null,
      missing: fromSpending
        ? [...monthGapNotes(thisMonthKey, incomplete, stopped, (at) => instantDay(at) ?? at.slice(0, 10)), ...missingMonthNotes(withoutTransactions)]
        : [],
    };
  }, [txns, budgets, accounts, idleCash, reconnectSoon, withoutTransactions, incomplete, stopped]);

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
      {leftOut && <div className="chart-note">{leftOut}</div>}
      {missing.map((n) => (
        <div className="stale-note" key={n}>
          {n}
        </div>
      ))}
    </div>
  );
}
