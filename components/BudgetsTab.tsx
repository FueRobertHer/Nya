'use client';

// Budgets tab -- the Mint core loop: monthly budgets per category or per
// category group, rolled up to your groups (components/BudgetsCard.tsx), with
// progress meters (fill carries severity: accent -> warning -> over),
// then savings goals, and what is coming: the cash forecast with its what-if
// (components/ForecastCard.tsx), the calendar (components/CalendarView.tsx),
// the recurring bills and income detected (components/RecurringCard.tsx) and
// the items planned (components/PlannedCard.tsx). Spending is the current
// month's outflows that count in totals (lib/spending.ts: not transfers or
// loan payments, not excluded, and in the totals' currency, naming what is in
// others), from the already-loaded transactions: the same rule as the
// Activity tab and the Home insights, so a budget agrees with both.

import { useMemo } from 'react';
import type { ListStatus } from '@/lib/whole-list-store';
import { type Txn } from './MonthBreakdown';
import { leftOutByCurrency, leftOutText, totalsCurrency } from '@/lib/spending';
import type { Budgets } from '@/lib/budget-set';
import { filedId, indexTaxonomy, type Taxonomy } from '@/lib/categories';
import BudgetsCard, { budgetTotals } from './BudgetsCard';
import { dismissedSeries, type RecurringSeries } from '@/lib/recurring';
import { localDate, localMonth, instantDay } from '@/lib/local-date';
import { cashPosition, type ForecastInstitution } from '@/lib/forecast';
import { EMPTY_PLANNED, type Planned, type PlannedItem } from '@/lib/planned';
import { formatMoney } from '@/lib/format';
import { spendingByCategory } from '@/lib/totals';
import { monthGapNotes, type Incomplete, type Stopped } from '@/lib/month-coverage';
import { missingMonthNotes, noSpending as noSpendingOf, withoutNote, NO_CONNECTIONS_WITHOUT, type NoTransactionsView } from '@/lib/no-transactions';
import GoalsCard, { type Goal, type GoalAccount } from './GoalsCard';
import ForecastCard from './ForecastCard';
import CalendarView from './CalendarView';
import RecurringCard from './RecurringCard';
import PlannedCard from './PlannedCard';

// Stable empty defaults, as in Insights.
const NO_GAPS: Incomplete[] = [];
const NO_STOPPED: Stopped[] = [];
const NO_SERIES: RecurringSeries[] = [];
const NO_INSTITUTIONS: ForecastInstitution[] = [];
const NO_ITEMS: PlannedItem[] = [];
const NO_DISMISSED: string[] = [];

export type { Budgets };

function meterState(ratio: number): '' | ' warn' | ' over' {
  if (ratio >= 1) return ' over';
  if (ratio >= 0.85) return ' warn';
  return '';
}

export default function BudgetsTab({
  txns,
  budgets,
  taxonomy = null,
  categoriesError = null,
  budgetsStatus = 'ready',
  budgetsError = null,
  budgetsSaveError = null,
  onSave,
  goals,
  goalsStatus = 'ready',
  goalsError = null,
  goalsSaveError = null,
  onSaveGoals,
  accounts,
  loading,
  incomplete = NO_GAPS,
  stopped = NO_STOPPED,
  withoutTransactions = NO_CONNECTIONS_WITHOUT,
  series: detected = null,
  txnsFailed = false,
  institutions = NO_INSTITUTIONS,
  balancesAsOf = null,
  balancesSaved = false,
  planned = EMPTY_PLANNED,
  plannedStatus = 'ready',
  plannedError = null,
  plannedSaveError = null,
  onSavePlanned,
}: {
  txns: Txn[] | null;
  budgets: Budgets;
  /** Your categories (components/categories-state.ts): what budgets are set
   *  on, and the groups they roll up to. Null until loaded. */
  taxonomy?: Taxonomy | null;
  /** Why they couldn't be loaded. */
  categoriesError?: string | null;
  /** Until 'ready', the list is unknown: shown as loading, never as "none",
   *  and not editable (lib/whole-list-store.ts). */
  budgetsStatus?: ListStatus;
  /** Why the budgets could not be loaded; shown instead of the list. */
  budgetsError?: string | null;
  /** Why the last save did not go through; shown above the list. */
  budgetsSaveError?: string | null;
  /** Resolves true once saved; forms only clear then, so nothing typed is
   *  lost to a failed save. */
  onSave: (next: Budgets) => Promise<boolean>;
  goals: Goal[];
  goalsStatus?: ListStatus;
  goalsError?: string | null;
  goalsSaveError?: string | null;
  onSaveGoals: (next: Goal[]) => Promise<boolean>;
  accounts: GoalAccount[];
  loading: boolean;
  /** What may leave this month's spending short, as Activity says it
   *  (lib/month-coverage.ts): a spent figure that looks finished but isn't
   *  makes a budget look safer than it is. */
  incomplete?: Incomplete[];
  stopped?: Stopped[];
  /** Connections that bring in no transactions (lib/no-transactions.ts). When
   *  none can bring in spending, a budget shows its limit and why there is
   *  nothing against it, never "$0 of" it; a bank account Plaid doesn't
   *  provide transactions for is named under the month. */
  withoutTransactions?: NoTransactionsView;
  /** The bills and income detected (lib/recurring.ts), once for the whole
   *  dashboard, from the year loaded and the rows before it a yearly charge
   *  needs; null until transactions load. */
  series?: RecurringSeries[] | null;
  /** Transactions couldn't be loaded: said, never shown as "nothing". */
  txnsFailed?: boolean;
  /** Every institution as the dashboard last loaded it, for the forecast's
   *  cash accounts and the calendar's payments due. */
  institutions?: ForecastInstitution[];
  /** When those balances were loaded, and whether they are the ones saved on
   *  this device from an earlier visit (components/Dashboard.tsx). */
  balancesAsOf?: string | null;
  balancesSaved?: boolean;
  /** The planned items, dismissals and warning (lib/planned.ts), loaded and
   *  saved whole like the budgets. */
  planned?: Planned;
  plannedStatus?: ListStatus;
  plannedError?: string | null;
  plannedSaveError?: string | null;
  onSavePlanned?: (next: Planned) => Promise<boolean>;
}) {
  const thisMonth = localMonth();
  const monthName = new Date().toLocaleDateString(undefined, { month: 'long' });

  // Budgets are plain numbers with no currency; they count, and are shown in,
  // the currency most transactions are in (lib/spending.ts), as the Activity
  // tab's totals are.
  const displayCurrency = useMemo(() => totalsCurrency(txns ?? []), [txns]);

  // Current-month spending per category id (lib/totals.ts, which the API's
  // budgets share).
  const spendByCat = useMemo(() => {
    const ix = taxonomy ? indexTaxonomy(taxonomy) : null;
    return spendingByCategory(txns ?? [], (date) => date.slice(0, 7) === thisMonth, displayCurrency, ix ? (t) => filedId(ix, t) : undefined);
  }, [txns, thisMonth, displayCurrency, taxonomy]);

  // This month's spending in other currencies, named rather than added.
  const leftOut = useMemo(
    () =>
      leftOutText(
        leftOutByCurrency(
          (txns ?? []).filter((t) => t.date.slice(0, 7) === thisMonth && t.amount > 0),
          displayCurrency
        ),
        displayCurrency,
        { where: 'these budgets' }
      ),
    [txns, thisMonth, displayCurrency]
  );

  // Every limit and what counts against it, each group's once (lib/budget-set.ts).
  const totals = useMemo(() => (taxonomy ? budgetTotals(taxonomy, budgets, spendByCat) : { budget: 0, spent: 0 }), [taxonomy, budgets, spendByCat]);

  // Bills and income detected (lib/recurring.ts), for the recurring list, the
  // forecast and the calendar alike.
  const series = detected ?? NO_SERIES;
  // Until the planned items load, no item counts and nothing is dismissed: the
  // forecast says so. A dismissal follows its series as amounts move
  // (lib/recurring.ts dismissedSeries): the series' ids, and what each was
  // saved as, to restore it.
  const ready = plannedStatus === 'ready';
  const items = ready ? planned.items : NO_ITEMS;
  const dismissedIds = ready ? planned.dismissed : NO_DISMISSED;
  const gone = useMemo(() => dismissedSeries(series, dismissedIds), [series, dismissedIds]);
  const dismissed = useMemo(() => new Set(gone.keys()), [gone]);
  // A planned item starts in the forecast's currency: the cash accounts'.
  const plannedCurrency = useMemo(() => cashPosition(institutions).currency ?? displayCurrency, [institutions, displayCurrency]);
  const today = localDate();

  if (loading) {
    return (
      <div className="card">
        <div className="spinner" role="status" aria-label="Loading budgets" />
      </div>
    );
  }

  const totalBudget = totals.budget;
  const totalSpent = totals.spent;
  const totalRatio = totalBudget > 0 ? totalSpent / totalBudget : 0;
  // No connection can bring in spending, and none came from anywhere else
  // (rows entered by hand count): say so, rather than "$0 of" every limit.
  // With rows entered by hand, the connections that bring in none are named
  // beside the budgets instead, as where the spending comes from.
  const noSpending = txns ? noSpendingOf(withoutTransactions, txns.length) : null;
  const missingNotes = noSpending ? [] : missingMonthNotes(withoutTransactions);
  const namedWithout = withoutNote(withoutTransactions, txns?.length ?? 0);

  return (
    <>
      <div className="card">
        <div className="inst-header">
          <div className="inst-name">{monthName} budgets</div>
          {totalBudget > 0 && budgetsStatus === 'ready' && !noSpending && (
            <div className="inst-total">
              {formatMoney(totalSpent, displayCurrency)} of{' '}
              {formatMoney(totalBudget, displayCurrency)}
            </div>
          )}
        </div>

        {budgetsStatus === 'loading' ? (
          <p className="empty-note">Loading budgets…</p>
        ) : budgetsStatus === 'error' ? (
          <p className="stale-note">{budgetsError}</p>
        ) : (
          <>
        {budgetsSaveError && <p className="stale-note">{budgetsSaveError}</p>}
        {noSpending && (
          <p className="empty-note">
            {noSpending.lead}, so there&apos;s no spending to count against budgets. To track them, {noSpending.remedy}.
          </p>
        )}
        {totalBudget > 0 && !noSpending && (
          <div className={`meter-track${meterState(totalRatio)}`}>
            <div
              className={`meter-fill${meterState(totalRatio)}`}
              style={{ width: `${Math.min(totalRatio * 100, 100)}%` }}
            />
          </div>
        )}

        {taxonomy ? (
          <BudgetsCard
            taxonomy={taxonomy}
            budgets={budgets}
            spent={spendByCat}
            currency={displayCurrency}
            editable={budgetsStatus === 'ready'}
            noSpending={!!noSpending}
            onSave={onSave}
          />
        ) : (
          <p className={categoriesError ? 'stale-note' : 'empty-note'}>
            {categoriesError ? `${categoriesError} Budgets are shown once they are.` : 'Loading your categories…'}
          </p>
        )}
          </>
        )}

        {leftOut && <div className="chart-note">{leftOut}</div>}
        {totalBudget > 0 && namedWithout && <div className="chart-note">{namedWithout}</div>}
        {/* With no spending to count at all, nothing can be missing from it. */}
        {totalBudget > 0 &&
          !noSpending &&
          [...monthGapNotes(thisMonth, incomplete, stopped, (at) => instantDay(at) ?? at.slice(0, 10)), ...missingNotes].map((n) => (
            <div className="stale-note" key={n}>
              {n}
            </div>
          ))}
      </div>

      <GoalsCard
        goals={goals}
        status={goalsStatus}
        error={goalsError}
        saveError={goalsSaveError}
        accounts={accounts}
        onSave={onSaveGoals}
      />

      <ForecastCard
        institutions={institutions}
        series={series}
        planned={planned}
        plannedStatus={plannedStatus}
        dismissed={dismissed}
        onSavePlanned={onSavePlanned}
        today={today}
        txns={txns ?? undefined}
        loading={txns === null && !txnsFailed}
        failed={txnsFailed}
        balancesAsOf={balancesAsOf}
        balancesSaved={balancesSaved}
        incomplete={incomplete}
        stopped={stopped}
        withoutTransactions={withoutTransactions}
      />

      <CalendarView
        txns={txns}
        failed={txnsFailed}
        series={series}
        planned={items}
        dismissed={dismissed}
        institutions={institutions}
        today={today}
        currency={displayCurrency}
      />

      <RecurringCard
        series={series}
        today={today}
        currency={displayCurrency}
        dismissed={dismissed}
        status={plannedStatus}
        saveError={plannedSaveError}
        onDismiss={
          onSavePlanned &&
          ((s, dismiss) => {
            const saved = gone.get(s.id);
            const rest = planned.dismissed.filter((d) => d !== saved && d !== s.id);
            return onSavePlanned({ ...planned, dismissed: dismiss ? [...rest, s.id] : rest });
          })
        }
        noSpending={noSpending}
        loading={txns === null && !txnsFailed}
        failed={txnsFailed}
      />

      <PlannedCard
        planned={planned}
        status={plannedStatus}
        error={plannedError}
        saveError={plannedSaveError}
        onSave={onSavePlanned}
        today={today}
        currency={plannedCurrency}
      />
    </>
  );
}
