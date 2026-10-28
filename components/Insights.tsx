'use client';

// Small computed observations for the Home tab -- the "is this normal?"
// glance the big trackers lead with. Everything derives from data already
// loaded (history + transactions), no extra API calls. Spending is what counts
// in totals (lib/spending.ts), as on the Activity and Budgets tabs: in one
// currency, with what is in others named under the list, and so is a month
// that may be missing a connection's transactions, in their words
// (lib/month-coverage.ts).

import { useMemo, type ReactNode } from 'react';
import { type Txn } from './MonthBreakdown';
import { countsInTotals, currencyOf, leftOutByCurrency, leftOutText } from '@/lib/spending';
import { leftOutWhy, totalsIn, type TotalsIn } from '@/lib/fx/totals';
import type { FxTable } from '@/lib/fx/rates';
import { dismissedSeries, upcomingBills, type RecurringSeries } from '@/lib/recurring';
import { instantDay, localDate, localMonth } from '@/lib/local-date';
import { formatMoney } from '@/lib/format';
import { useAmountsHidden } from './hide-amounts';
import { Masked } from './HideAmounts';
import { SpendingNotes } from './NeedsAttention';
import { isCashOnHand } from '@/lib/balance';
import { RECONNECT_ALERT_DAYS } from '@/lib/connection-state';
import { missingMonthNotes, NO_CONNECTIONS_WITHOUT, type NoTransactionsView } from '@/lib/no-transactions';
import { monthGapNotes, type Incomplete, type Stopped } from '@/lib/month-coverage';
import { spendingByCategory } from '@/lib/totals';
import { budgetMeters, placeBudgets, EMPTY_BUDGETS, type Budgets } from '@/lib/budget-set';
import { withCarry, type Carries } from '@/lib/rollover';
import { filedId, indexTaxonomy, type Taxonomy } from '@/lib/categories';
import { bankRows } from '@/lib/split-rows';
import type { Severity } from '@/lib/accounts-status';
import { distinctAccountNames } from '@/lib/account-names';

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

const NO_SERIES: RecurringSeries[] = [];
const NO_DISMISSED: string[] = [];
const NO_GAPS: Incomplete[] = [];
const NO_STOPPED: Stopped[] = [];

/** The Home alerts for connections ending within RECONNECT_ALERT_DAYS, soonest
 *  first, every one (Home's Needs attention gives each its row): calendar
 *  days on the viewer's own calendar, as the due-date alerts below count
 *  them. */
/** An alert as one sentence (`text`), and as a row says it: `title`, then
 *  `sub` under it when the sentence goes on after a colon. Built apart, so a
 *  name holding a colon is never split. */
export type AlertLine = { text: string; title: string; sub?: string };

/** "Title: what follows" as one sentence and as its parts. */
const line = (title: string, sub?: string): AlertLine => (sub ? { text: `${title}: ${sub}`, title, sub } : { text: title, title });

export function reconnectAlerts(soon: ReconnectSoon[], now: Date = new Date()): ({ key: string; days: number } & AlertLine)[] {
  const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const out: ({ key: string; days: number } & AlertLine)[] = [];
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
    out.push({ key: `reconnect-${s.item_id}`, ...line(`Reconnect ${s.institution_name}`, said), days });
  }
  return out.sort((a, b) => a.days - b.days);
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

/** An account a payment is about, with what opens its sheet, and its
 *  institution and mask, which tell it from another of the same name. */
export type PaymentAccount = InsightAccount & { item_id: string; account_id: string; institution?: string; mask?: string | null };

const LOW_BALANCE_THRESHOLD = 100;
const MAX_INSIGHTS = 6;

// Each says what it is in words: no color of its own (rollout.md "Decided in
// 4c"), since amber is for what needs the person and red for a short number.
type Insight = { key: string; text: string };

/** What the budget alerts read: as the Budgets tab meters this month. */
export type BudgetAlertInput = {
  txns: Txn[] | null;
  /** What the figures convert with, once a home currency is chosen
   *  (app/api/transactions `fx`); null without one. */
  fx?: FxTable | null;
  /** By category and group id (lib/budget-set.ts), against your categories
   *  (components/categories-state.ts): no alert until both have loaded. */
  budgets?: Budgets;
  taxonomy?: Taxonomy | null;
  /** What rolled into this month's budgets (lib/rollover.ts), once the
   *  Budgets tab's month has loaded: an alert weighs what is available, as
   *  that tab's meters do. Null meanwhile: each budget's amount alone. */
  budgetCarries?: Carries | null;
};

/**
 * This month's budgets that are over or close, worst first, at most two (the
 * Budgets tab shows every one; `more` counts the rest): each category's, and
 * the limit of each group with a budget of its own (lib/budget-set.ts), by
 * name as the category or group is named. A group without one only adds up
 * its categories' budgets, which alert on their own: alerting on the sum too
 * would say the same overspending twice, and could push out the alert for a
 * budget the person set. Home's Needs attention lists them.
 */
export function budgetAlerts({ txns, fx = null, budgets = EMPTY_BUDGETS, taxonomy = null, budgetCarries = null }: BudgetAlertInput, now: Date = new Date()): { alerts: ({ key: string } & AlertLine)[]; more: number } {
  const alerts: ({ key: string } & AlertLine)[] = [];
  if (!txns || !taxonomy) return { alerts, more: 0 };
  const thisMonthKey = localMonth(now);
  // Budgets carry no currency of their own: they are in the one most of the
  // transactions are in, as the Budgets tab reads them, with spending in
  // others converted into it at each day's rate once a home currency is
  // chosen (lib/fx/totals.ts).
  const budgeted = totalsIn(txns, fx, { into: 'most' });
  const displayCurrency = budgeted.currency;
  const ix = indexTaxonomy(taxonomy);
  const spendByCat = spendingByCategory(budgeted.rows, (date) => date.slice(0, 7) === thisMonthKey, displayCurrency, (t) => filedId(ix, t));
  const meters = budgetMeters(ix, withCarry(placeBudgets(budgets, ix), budgetCarries), new Map(Object.entries(spendByCat)));
  const candidates = [
    ...meters.groups.filter((m) => m.limit !== null && m.own !== null).map((m) => ({ key: `group-${m.group.id}`, name: m.group.name, budget: m.limit!, spent: m.spent })),
    ...meters.groups.flatMap((m) => m.categories.filter((c) => c.budget !== null).map((c) => ({ key: `category-${c.category.id}`, name: c.category.name, budget: c.budget!, spent: c.spent }))),
  ];
  // With rollover, what is available can be nothing or less (an overspent
  // carry): over at once, first among the over.
  const ratio = ({ spent, budget }: { spent: number; budget: number }) => (budget > 0 ? spent / budget : Infinity);
  const flagged = candidates
    .filter(({ spent, budget }) => (budget > 0 ? spent / budget >= 0.9 : budget < 0 || spent > 0))
    .sort((a, b) => (ratio(a) === ratio(b) ? 0 : ratio(b) > ratio(a) ? 1 : -1));
  for (const { key, name, budget, spent } of flagged.slice(0, 2)) {
    const over = `Over your ${name} budget`;
    alerts.push({
      key: `budget-${key}`,
      ...(budget <= 0
        ? // Nothing available: said as what was carried over, never "of" a limit of zero or less.
          budget < 0
          ? line(over, `overspending carried over left it ${formatMoney(-budget, displayCurrency)} over before this month${spent > 0 ? `, and ${formatMoney(spent, displayCurrency)} is spent` : ''}`)
          : line(over, `overspending carried over left nothing of it this month, and ${formatMoney(spent, displayCurrency)} is spent`)
        : spent >= budget
          ? line(over, `${formatMoney(spent, displayCurrency)} of ${formatMoney(budget, displayCurrency)}`)
          : line(`Approaching your ${name} budget (${Math.round((spent / budget) * 100)}%)`)),
    });
  }
  return { alerts, more: Math.max(0, flagged.length - 2) };
}

/**
 * Card and loan payments overdue (red) or coming due within a week (amber),
 * from Plaid's liabilities data rather than inferred from transactions:
 * overdue first, then soonest first. Every one: each is its own thing to do,
 * with its own account sheet. Home's Needs attention lists them, each named
 * so no two read the same (lib/account-names.ts).
 */
export function paymentAlerts(accounts: PaymentAccount[], now: Date = new Date()): ({ key: string; severity: Severity; item_id: string; account_id: string } & AlertLine)[] {
  const overdue: ({ key: string; severity: Severity; item_id: string; account_id: string } & AlertLine)[] = [];
  const dueSoon: { days: number; alert: (typeof overdue)[number] }[] = [];
  // Local midnight today, so "days until" counts calendar days rather than
  // 24-hour blocks from now. Comparing against `now` drifted by one over the
  // day: after local noon a payment due today rounded to -1 and was dropped.
  const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const named = distinctAccountNames(accounts.filter((a) => a.liability).map((a) => ({ id: a.account_id, name: a.name, institution: a.institution ?? '', mask: a.mask })));
  for (const a of accounts) {
    const l = a.liability;
    if (!l) continue;
    const name = named.get(a.account_id) ?? a.name;
    const ids = { item_id: a.item_id, account_id: a.account_id };
    if (l.is_overdue) {
      overdue.push({
        key: `overdue-${a.account_id}`,
        text: `${name} is overdue${l.minimum_payment != null ? ` (${formatMoney(l.minimum_payment, a.currency)} minimum)` : ''}`,
        title: `${name} is overdue`,
        ...(l.minimum_payment != null ? { sub: `Minimum ${formatMoney(l.minimum_payment, a.currency)}` } : {}),
        severity: 'critical',
        ...ids,
      });
      continue;
    }
    if (!l.next_due_date) continue;
    const days = Math.round((new Date(`${l.next_due_date}T00:00:00`).getTime() - midnight) / 86_400_000);
    // `days >= 0` matters: the dashboard hydrates from a localStorage
    // snapshot with no TTL, so a stale payload can carry a due date that has
    // since passed, and "due in -4 days" would render on first paint.
    if (days < 0 || days > 7) continue;
    const when = days === 0 ? 'today' : days === 1 ? 'tomorrow' : `in ${days} days`;
    dueSoon.push({
      days,
      alert: {
        key: `due-${a.account_id}`,
        text: `${name}: ${l.minimum_payment != null ? `${formatMoney(l.minimum_payment, a.currency)} ` : ''}due ${when}`,
        title: `${name} due ${when}`,
        ...(l.minimum_payment != null ? { sub: `Minimum ${formatMoney(l.minimum_payment, a.currency)}` } : {}),
        severity: 'caution',
        ...ids,
      },
    });
  }
  // Soonest first within each group. Sorting the merged list would let a
  // far-off due date outrank an account that's already overdue.
  dueSoon.sort((x, y) => x.days - y.days);
  return [...overdue, ...dueSoon.map((d) => d.alert)];
}

/** What reading this month's spending needs said beside it (lib/month-coverage.ts). */
export type SpendingNoteInput = {
  txns: Txn[] | null;
  fx?: FxTable | null;
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
};

/**
 * What a figure read from this month's spending (a budget alert, the pace,
 * the biggest purchase) is said beside: spending in another currency than
 * the figures', this month and last, left out of them; and what the month may
 * be missing, in the words Activity and Budgets use.
 */
export function spendingNotes(
  { txns, fx = null, withoutTransactions = NO_CONNECTIONS_WITHOUT, incomplete = NO_GAPS, stopped = NO_STOPPED }: SpendingNoteInput,
  now: Date = new Date(),
  counted: TotalsIn<Txn> = totalsIn(txns ?? [], fx)
): { leftOut: string | null; missing: string[] } {
  const thisMonth = localMonth(now);
  let leftOut: string | null = null;
  if (txns && txns.length > 0) {
    const figures = counted.currency;
    const lastMonthDate = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const lastMonth = `${lastMonthDate.getFullYear()}-${String(lastMonthDate.getMonth() + 1).padStart(2, '0')}`;
    leftOut = leftOutWhy(
      leftOutText(
        leftOutByCurrency(
          counted.rows.filter((t) => (t.date.slice(0, 7) === thisMonth || t.date.slice(0, 7) === lastMonth) && t.amount > 0),
          figures
        ),
        figures,
        { where: 'these figures' }
      ),
      counted.conversion
    );
  }
  return {
    leftOut,
    missing: [...monthGapNotes(thisMonth, incomplete, stopped, (at) => instantDay(at) ?? at.slice(0, 10)), ...missingMonthNotes(withoutTransactions, thisMonth)],
  };
}

/**
 * Home's This month card (rollout phase 4c): what is worth knowing and needs
 * nothing done, one plain row each (rollout phase 4b moved the budget,
 * payment and reconnect alerts into Needs attention,
 * components/NeedsAttention.tsx), with what the month may be missing after
 * the pace and the biggest purchase, and the FI line last (`fi`,
 * components/FiProgressCard.tsx, loaded after Home paints). A low balance
 * stays here: it has no fix to go to and no way to set it aside.
 */
export default function Insights({
  txns,
  fx = null,
  accounts,
  idleCash = NO_IDLE_CASH,
  withoutTransactions = NO_CONNECTIONS_WITHOUT,
  series = NO_SERIES,
  dismissed = NO_DISMISSED,
  incomplete = NO_GAPS,
  stopped = NO_STOPPED,
  fi = null,
}: {
  txns: Txn[] | null;
  /** What the figures convert with, once a home currency is chosen
   *  (app/api/transactions `fx`); null without one. */
  fx?: FxTable | null;
  accounts: InsightAccount[];
  idleCash?: IdleCashAccount[];
  withoutTransactions?: NoTransactionsView;
  /** The bills and income detected (lib/recurring.ts), once for the whole
   *  dashboard, from the year loaded and the rows before it a yearly charge
   *  needs. */
  series?: RecurringSeries[];
  /** Detected bills the person said aren't recurring, as saved
   *  (lib/planned.ts), matched to series by dismissedSeries. */
  dismissed?: string[];
  incomplete?: Incomplete[];
  stopped?: Stopped[];
  /** The FI line, an <li> once its figures are in (components/FiProgressLoader.tsx). */
  fi?: ReactNode;
}) {
  // The texts name amounts, so they are written again when hiding amounts is
  // turned on or off (components/hide-amounts.ts).
  const hidden = useAmountsHidden();
  const { insights, leftOut, missing } = useMemo(() => {
    const out: Insight[] = [];
    const now = new Date();
    // The pace and the biggest purchase are in the home currency once one is
    // chosen, every row converted at its day's rate (lib/fx/totals.ts). What
    // has no rate counts in neither, and is named. Per-item amounts use their
    // own currency where known.
    const counted = totalsIn(txns ?? [], fx);
    const figures = counted.currency;
    const displayCurrency = totalsIn(txns ?? [], fx, { into: 'most' }).currency;

    // Low balance on any checking/savings account. Keyed by position as well as
    // name: two accounts can share a name (a manual account tracking the same
    // institution as a linked one), and a duplicate React key would drop an alert.
    // Not cash on hand (lib/balance.ts): a wallet running low is no risk of an
    // overdraft.
    // One row: the first, and how many more. Several small accounts kept on
    // purpose would otherwise push the month's own figures off the card.
    const low = [...accounts.entries()].filter(([, a]) => a.type === 'depository' && !isCashOnHand(a) && a.balance != null && a.balance < LOW_BALANCE_THRESHOLD);
    if (low.length > 0) {
      const [i, a] = low[0];
      const more = low.length - 1;
      out.push({
        key: `low-${i}-${a.name}`,
        text: `Low balance: ${a.name} at ${formatMoney(a.balance!, a.currency)}${more > 0 ? `, and ${more} more account${more === 1 ? '' : 's'}` : ''}`,
      });
    }

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
      });
    }

    // Recurring bills expected within a week, on the dates their cadence
    // names (lib/recurring.ts): soonest first, max 2, deduped by name (the
    // same bill on two linked accounts is one bill), none the person said
    // isn't recurring. One due before today and not in yet says so.
    if (txns) {
      const seen = new Set<string>();
      const day = (iso: string) => new Date(`${iso}T00:00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
      const gone = new Set(dismissedSeries(series, dismissed).keys());
      for (const { series: b, due, late } of upcomingBills(series, 7, localDate(now), gone)) {
        if (seen.has(b.name)) continue;
        seen.add(b.name);
        const amount = `~${formatMoney(b.amount, b.currency ?? displayCurrency)}`;
        out.push({
          key: `bill-${b.name}`,
          text: late ? `Expected: ${b.name} (${amount}), due ${day(due)} and not in yet` : `Upcoming: ${b.name} (${amount}) around ${day(due)}`,
        });
        if (seen.size >= 2) break;
      }
    }

    if (txns && txns.length > 0) {
      const thisMonth = localMonth(now);
      const lastMonthDate = new Date(now.getFullYear(), now.getMonth() - 1, 1);
      const lastMonth = `${lastMonthDate.getFullYear()}-${String(lastMonthDate.getMonth() + 1).padStart(2, '0')}`;
      const spend = (month: string) =>
        counted.rows
          .filter((t) => t.date.slice(0, 7) === month && t.amount > 0 && countsInTotals(t, figures))
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
                }
              : {
                  key: 'pace',
                  text: `Spending is tracking ${pct.toFixed(0)}% ${ratio > 1 ? 'above' : 'below'} ${monthName}'s pace`,
                }
          );
        }
      }

      // --- biggest purchase this month ---
      // A split transaction is one purchase, whole, as the bank charged it,
      // when any of its parts counts; a group, its net (#39, lib/split-rows.ts).
      // Ranked by what each came to in the home currency, and said in its own.
      const purchases = bankRows(counted.rows, { groups: 'keep' }).filter(
        (t) =>
          t.date.slice(0, 7) === thisMonth &&
          t.amount > 0 &&
          (t.split_parts ? t.split_parts.some((p) => countsInTotals(p, figures)) : countsInTotals(t, figures))
      );
      if (purchases.length > 0) {
        const biggest = purchases.reduce((a, b) => (b.amount > a.amount ? b : a));
        const own = bankRows(txns, { groups: 'keep' }).find((t) => t.transaction_id === biggest.transaction_id) ?? biggest;
        out.push({
          key: 'biggest',
          text: `Biggest purchase this month: ${own.name}, ${formatMoney(own.amount, currencyOf(own) ?? figures)}`,
        });
      }
    }

    // The month's own figures first (the pace, the biggest purchase, the bills
    // coming), then a low balance, then idle cash, so the cap never drops the
    // figures the card is named for.
    const rank = (key: string) => (key === 'pace' ? 0 : key === 'biggest' ? 1 : key.startsWith('bill-') ? 2 : key.startsWith('low-') ? 3 : 4);
    const shown = out.sort((a, b) => rank(a.key) - rank(b.key)).slice(0, MAX_INSIGHTS);
    // Said only beside a figure it is missing from.
    const fromSpending = shown.some((i) => i.key === 'pace' || i.key === 'biggest');
    const notes = fromSpending ? spendingNotes({ txns, fx, withoutTransactions, incomplete, stopped }, now, counted) : null;
    return { insights: shown, leftOut: notes?.leftOut ?? null, missing: notes?.missing ?? [] };
    // `hidden` isn't read inside: it changes what formatMoney writes there.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [txns, fx, accounts, idleCash, withoutTransactions, series, dismissed, incomplete, stopped, hidden]);

  if (insights.length === 0 && !fi) return null;
  // What the month may be missing follows the last figure read from it.
  let last = -1;
  insights.forEach((i, n) => {
    if (i.key === 'pace' || i.key === 'biggest') last = n;
  });
  const said = last >= 0 && (leftOut !== null || missing.length > 0);
  // Hidden by CSS while it has no row: the FI line can arrive later, or not
  // at all.
  return (
    <section className="card this-month" aria-labelledby="this-month-title">
      <div className="card-header">
        <h2 id="this-month-title">This month</h2>
      </div>
      <ul className="list-rows">
        {insights.map((i, n) => (
          <li key={i.key}>
            <div className="list-row">
              <span className="list-row-text">
                <Masked>{i.text}</Masked>
              </span>
            </div>
            {said && n === last && <SpendingNotes leftOut={leftOut} missing={missing} />}
          </li>
        ))}
        {fi}
      </ul>
    </section>
  );
}
