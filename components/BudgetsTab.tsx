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
//
// BY MONTH, WITH ROLLOVER (#37). The month's budgets as the server works them
// out (components/budget-month-state.ts, app/api/budgets/month): what rolls
// into each budget and what is available, read from the stored history back
// to the first month a carry counts, beyond the year this page loads, with
// which months may be incomplete; and the income pool, when "My income is
// irregular" is on, above the meters (components/IncomePool.tsx). A month
// picker shows a past month as it was: its budgets then, its spending, and
// what rolled into it. Until the month has loaded, or when it can't be, this
// month shows as it always has, with a note. This month's answer carries the
// budget suggestions from history the editor offers (lib/budget-suggestions.ts).
//
// While your categories are still the ones Nya made, the starter sets are
// offered here once, above the budgets (components/TemplateOffer.tsx).

import { useMemo, useState } from 'react';
import type { ListStatus } from '@/lib/whole-list-store';
import { type Txn } from './MonthBreakdown';
import { leftOutByCurrency, leftOutText, totalsCurrency } from '@/lib/spending';
import SplitChangedNote from './SplitChangedNote';
import type { Budgets } from '@/lib/budget-set';
import { filedId, indexTaxonomy, type Taxonomy } from '@/lib/categories';
import BudgetsCard, { budgetTotals, type RolloverChange, type Target } from './BudgetsCard';
import { changeRollover, useBudgetMonth, NOT_LOADED as NOT_LOADED_TEXT, type BudgetMonthState } from './budget-month-state';
import { IncomePoolHeader, IncomeSetting } from './IncomePool';
import { addMonths, gapText, monthName as nameOfMonth, monthsFrom, monthsText, MAX_MONTHS_BACK, type MonthGap } from '@/lib/rollover';
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
import { Masked } from './HideAmounts';
import TemplateOffer from './TemplateOffer';

// Stable empty defaults, as in Insights.
const NO_GAPS: Incomplete[] = [];
const NO_STOPPED: Stopped[] = [];
const NO_SERIES: RecurringSeries[] = [];
const NO_INSTITUTIONS: ForecastInstitution[] = [];
const NO_ITEMS: PlannedItem[] = [];
const NO_DISMISSED: string[] = [];
const NOT_LOADED: BudgetMonthState = { status: 'idle', view: null, error: null, reload: () => {} };

/** A reason a month may be incomplete, in words: an instant as the local
 *  day it fell on, a calendar day as it is. */
const reasonText = (g: MonthGap) => {
  const text = gapText(g, (at) => (at.length > 10 ? (instantDay(at) ?? at.slice(0, 10)) : (instantDay(`${at}T12:00:00Z`, 'UTC') ?? at)));
  return `${text[0].toUpperCase()}${text.slice(1)}`;
};

/** Reasons months may be incomplete, each with the months it touches:
 *  "Chase hasn’t synced since Mar 5 (March and April)". */
function gapReasons(gaps: { month: string; gaps: MonthGap[] }[], months: ReadonlySet<string>, today: string): string[] {
  const by = new Map<string, string[]>();
  for (const g of gaps) {
    if (!months.has(g.month)) continue;
    for (const x of g.gaps) by.set(reasonText(x), [...(by.get(reasonText(x)) ?? []), g.month]);
  }
  return [...by].map(([text, ms]) => `${text} (${monthsText(ms, today)})`);
}

export type { Budgets };

/** A month gone by that isn't shown yet: loading, or why it couldn't be
 *  loaded, with a way to try again (choosing it again loads nothing new). */
export function PastMonthPending({ state, name }: { state: BudgetMonthState; name: string }) {
  if (state.status !== 'error') return <p className="empty-note">Loading {name}…</p>;
  return (
    <>
      <p className="stale-note">{state.error && state.error !== NOT_LOADED_TEXT ? state.error : `${name} couldn’t be loaded.`}</p>
      <button className="secondary" style={{ marginTop: 8 }} onClick={state.reload}>
        Try again
      </button>
    </>
  );
}

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
  budgetMonth = NOT_LOADED,
  onCategories,
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
  /** This month's budgets as the server works them out, with rollover
   *  (components/budget-month-state.ts), loaded once for the dashboard. */
  budgetMonth?: BudgetMonthState;
  /** Takes the set a starter template made (components/TemplateOffer.tsx),
   *  offered here once while your categories are still the ones Nya made. */
  onCategories?: (t: unknown) => void;
}) {
  const thisMonth = localMonth();
  // The month shown: this month, or one picked to look back on.
  const [picked, setPicked] = useState<string | null>(null);
  const shownMonth = picked && picked < thisMonth ? picked : thisMonth;
  const past = shownMonth !== thisMonth;
  const pastMonth = useBudgetMonth(past && budgetsStatus === 'ready' ? shownMonth : null, [budgets, txns, taxonomy]);
  const month = past ? pastMonth : budgetMonth;
  // The view of the month shown, once loaded (kept while it loads again).
  const view = month.view && month.view.month === shownMonth ? month.view : null;
  const [rolloverError, setRolloverError] = useState<string | null>(null);
  const monthName = past
    ? nameOfMonth(shownMonth, thisMonth)
    : new Date().toLocaleDateString(undefined, { month: 'long' });

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

  // What the meters show: this month's budgets and spending as this page
  // holds them, or a past month's as the server read them; with what rolled
  // into each, once the month has loaded.
  const shownBudgets = past ? (view?.budgets ?? null) : budgets;
  const shownSpent = past ? (view?.spent ?? null) : spendByCat;
  const carries = view?.carries ?? null;

  // Every limit and what counts against it, each group's once (lib/budget-set.ts).
  const totals = useMemo(
    () => (taxonomy && shownBudgets && shownSpent ? budgetTotals(taxonomy, shownBudgets, shownSpent, carries) : { budget: 0, spent: 0, any: false }),
    [taxonomy, shownBudgets, shownSpent, carries]
  );

  // The months a carry or the pool counts that may be incomplete, and why.
  const carryNotes = useMemo(() => {
    if (!view) return [];
    const counted = new Set<string>([
      ...Object.values(view.carries.categories).flatMap((c) => c.uncertain),
      ...Object.values(view.carries.groups).flatMap((c) => c.uncertain),
      ...(view.pool?.uncertain ?? []),
    ]);
    counted.delete(shownMonth);
    return gapReasons(view.gaps, counted, thisMonth);
  }, [view, shownMonth, thisMonth]);
  // A past month's own gaps, as this month's notes are said below.
  const shownGaps = useMemo(() => (view && past ? (view.gaps.find((g) => g.month === shownMonth)?.gaps ?? []).map(reasonText) : []), [view, past, shownMonth]);
  // Months to look back on: back to the first with transactions, ten years at most.
  const earliest = budgetMonth.view?.earliest ?? null;
  const pickable = useMemo(() => {
    const floor = addMonths(thisMonth, -MAX_MONTHS_BACK);
    return earliest && earliest < thisMonth ? monthsFrom(earliest > floor ? earliest : floor, thisMonth).reverse() : [thisMonth];
  }, [earliest, thisMonth]);
  // Carries or amounts from before budgets were kept by month are assumed.
  const assumedNote =
    view &&
    (view.assumed.categories.length > 0 ||
      view.assumed.groups.length > 0 ||
      [...Object.values(view.carries.categories), ...Object.values(view.carries.groups)].some((c) => c.from < view.recorded_since))
      ? `Nya began keeping budgets by month in ${nameOfMonth(view.recorded_since, thisMonth)}, so before then each budget counts its amount in ${nameOfMonth(view.recorded_since, thisMonth)}.`
      : null;

  async function onRollover(t: Target, change: RolloverChange): Promise<boolean> {
    const body =
      'reset' in change
        ? { action: 'reset', kind: t.kind, id: t.id }
        : change.on
          ? { action: 'rollover', kind: t.kind, id: t.id, on: true, from: change.from }
          : { action: 'rollover', kind: t.kind, id: t.id, on: false };
    const error = await changeRollover(body);
    setRolloverError(error);
    budgetMonth.reload();
    return error === null;
  }
  async function onIncome(change: { enabled: true; start: string } | { enabled: false }): Promise<boolean> {
    const error = await changeRollover({ action: 'income', ...change });
    setRolloverError(error);
    budgetMonth.reload();
    return error === null;
  }

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
  // With rollover, what is available in all can be nothing or less (an
  // overspent carry): there are budgets all the same, said in words.
  const hasTotal = totals.any;
  const totalRatio = totalBudget > 0 ? totalSpent / totalBudget : totalBudget < 0 || totalSpent > 0 ? 1 : 0;
  // No connection can bring in spending, and none came from anywhere else
  // (rows entered by hand count): say so, rather than "$0 of" every limit.
  // With rows entered by hand, the connections that bring in none are named
  // beside the budgets instead, as where the spending comes from.
  const noSpending = txns ? noSpendingOf(withoutTransactions, txns.length) : null;
  const missingNotes = noSpending ? [] : missingMonthNotes(withoutTransactions, thisMonth);
  const namedWithout = withoutNote(withoutTransactions, txns?.length ?? 0);

  // The currency the figures are in: this page's for this month, the
  // server's for a past one (the same rule, over the same year).
  const shownCurrency = past ? (view?.currency ?? displayCurrency) : displayCurrency;
  const shownLeftOut = past ? (view?.left_out_text ?? null) : leftOut;

  return (
    <>
      {onCategories && <TemplateOffer taxonomy={taxonomy} onTaxonomy={onCategories} />}
      <div className="card">
        <div className="inst-header">
          <div className="inst-name">{monthName} budgets</div>
          {hasTotal && budgetsStatus === 'ready' && !noSpending && (
            <div className="inst-total">
              <Masked>
                {totalBudget > 0
                  ? `${formatMoney(totalSpent, shownCurrency)} of ${formatMoney(totalBudget, shownCurrency)}`
                  : `${formatMoney(totalSpent, shownCurrency)} spent, nothing left`}
              </Masked>
            </div>
          )}
        </div>
        {pickable.length > 1 && budgetsStatus === 'ready' && (
          <select className="text-input budget-select month-picker" value={shownMonth} onChange={(e) => setPicked(e.target.value)} aria-label="Month to show">
            {pickable.map((m) => (
              <option key={m} value={m}>
                {m === thisMonth ? `${nameOfMonth(m, thisMonth)} (this month)` : nameOfMonth(m, thisMonth)}
              </option>
            ))}
          </select>
        )}

        {budgetsStatus === 'loading' ? (
          <p className="empty-note">Loading budgets…</p>
        ) : budgetsStatus === 'error' ? (
          <p className="stale-note">{budgetsError}</p>
        ) : (
          <>
        {budgetsSaveError && <p className="stale-note">{budgetsSaveError}</p>}
        {rolloverError && <p className="stale-note">{rolloverError}</p>}
        {!past && month.status === 'error' && month.error && <p className="stale-note">{month.error}</p>}
        {noSpending && (
          <p className="empty-note">
            {noSpending.lead}, so there&apos;s no spending to count against budgets. To track them, {noSpending.remedy}.
          </p>
        )}
        {view?.pool && <IncomePoolHeader pool={view.pool} currency={shownCurrency} month={shownMonth} today={thisMonth} />}
        {hasTotal && !noSpending && (
          <div className={`meter-track${meterState(totalRatio)}`}>
            <div
              className={`meter-fill${meterState(totalRatio)}`}
              style={{ width: `${Math.min(totalRatio * 100, 100)}%` }}
            />
          </div>
        )}

        {!taxonomy ? (
          <p className={categoriesError ? 'stale-note' : 'empty-note'}>
            {categoriesError ? `${categoriesError} Budgets are shown once they are.` : 'Loading your categories…'}
          </p>
        ) : past && !view ? (
          <PastMonthPending state={month} name={monthName} />
        ) : (
          <BudgetsCard
            key={shownMonth}
            taxonomy={taxonomy}
            budgets={shownBudgets!}
            spent={shownSpent!}
            currency={shownCurrency}
            editable={budgetsStatus === 'ready' && !past}
            noSpending={!!noSpending}
            onSave={onSave}
            carries={carries}
            month={shownMonth}
            past={past}
            rollover={!past && view ? { rolling: view.rollover, starts: view.starts, ended: view.ended, earliest: view.earliest } : null}
            onRollover={!past && view ? onRollover : undefined}
            suggestions={!past ? (view?.suggestions ?? null) : null}
          />
        )}
        {!past && view && (
          <IncomeSetting setting={view.income} today={thisMonth} earliest={view.earliest} disabled={budgetsStatus !== 'ready'} onChange={onIncome} />
        )}
          </>
        )}

        {shownLeftOut && <div className="chart-note">{shownLeftOut}</div>}
        {view?.counted_left_out_text && <div className="chart-note">{view.counted_left_out_text}</div>}
        {/* A split whose amount changed since counts as split until edited (#39). */}
        {hasTotal && <SplitChangedNote txns={txns} month={shownMonth} />}
        {hasTotal && namedWithout && <div className="chart-note">{namedWithout}</div>}
        {carryNotes.length > 0 && <div className="stale-note">Rollover may be off where a month is incomplete: {carryNotes.join('; ')}.</div>}
        {assumedNote && <div className="chart-note">{assumedNote}</div>}
        {/* With no spending to count at all, nothing can be missing from it. */}
        {hasTotal &&
          !noSpending &&
          (past
            ? shownGaps.map((n) => `${monthName} may be incomplete: ${n}.`)
            : [...monthGapNotes(thisMonth, incomplete, stopped, (at) => instantDay(at) ?? at.slice(0, 10)), ...missingNotes]
          ).map((n) => (
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
