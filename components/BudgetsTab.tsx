'use client';

// Budgets tab -- the Mint core loop: monthly budgets per category or per
// category group, rolled up to your groups (components/BudgetsCard.tsx), with
// progress meters (fill carries severity: accent -> warning -> over),
// then savings goals, and what is coming (components/UpcomingPanel.tsx): the
// cash forecast with its what-if, the list or calendar of what is due, the
// bills and income detected and the items planned. Spending is the current
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
// irregular" is on, above the month's spending (components/IncomePool.tsx). A
// month picker shows a past month as it was: its budgets then, its spending,
// and what rolled into it, read only and saying so. The month is shared with
// the Activity tab (components/view-month-state.ts). Until the month has
// loaded, or when it can't be, this month shows as it always has, with a
// note. This month's answer carries the budget suggestions from history a
// budget's sheet offers (lib/budget-suggestions.ts).
//
// THE MONTH, TOP TO BOTTOM (rollout phase 6a2): one notice for what may leave
// the month short (components/budget-notes.ts, design-system.md "Status and
// honesty" rule 3), the starter sets' offer, the income pool, the Spent card
// (the total, a "May be incomplete" badge when the month itself may be
// short, the meter, the notes that explain the figures, and why anything
// couldn't be loaded), the budgets as rows that open their sheets
// (components/BudgetsCard.tsx), + Add budget, and "My income is irregular"
// as a row that opens its setting. This month with no budget at all is one
// card instead of Spent and its rows (components/EmptyState.tsx, drawn by
// BudgetsCard, which owns Add budget's sheet): what budgets are for, what
// the Spent card would have said of the month, and Add budget as the one
// primary (the screen review after step 5). Once the budgets have been ready, a
// reload (after a save the server refused) keeps all of it drawn from what
// the page holds, read only, so a sheet open on a budget stays open on what
// was typed and says why.
//
// While your categories are still the ones Nya made, the starter sets are
// offered here once, above the budgets (components/TemplateOffer.tsx).
//
// UPCOMING (rollout phase 6a3): one notice for what the bills, income,
// planned items and payments may be missing (components/upcoming-notes.tsx),
// the forecast, the list or the calendar, Recurring and Planned. As the
// budgets are on Month, once the planned items have been ready a reload
// (after a save the server refused: lib/whole-list-store.ts) keeps them
// drawn from what the page holds, which is then what is saved, so the
// forecast keeps them and its warning, the list its planned rows, and a
// sheet open on them stays open on what was typed and says why. Changes
// wait for them to be ready again. The first load says it is loading.
//
// THREE SEGMENTS (docs/design/information-architecture.md#budgets), each with
// one time range, under a pinned bar (components/BudgetsBar.tsx): Month (the
// month's budgets), Upcoming (the forecast, the list or calendar, recurring
// and planned) and Goals (savings goals, and the debt payoff plan when there
// is a card or loan to plan). All three stay mounted, the others hidden, so
// nothing typed in one is lost by looking at another.

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { ListStatus } from '@/lib/whole-list-store';
import { type Txn } from './MonthBreakdown';
import { historyCount, leftOutByCurrency, leftOutText } from '@/lib/spending';
import { conversionIn, convertedText, leftOutWhy, totalsIn } from '@/lib/fx/totals';
import type { FxTable } from '@/lib/fx/rates';
import { splitChangedText } from './SplitChangedNote';
import { placeBudgets, type Budgets } from '@/lib/budget-set';
import { filedId, indexTaxonomy, type Taxonomy } from '@/lib/categories';
import BudgetsCard, { budgetTotals, NoBudgets, type RolloverChange, type Target } from './BudgetsCard';
import { changeRollover, useBudgetMonth, NOT_LOADED as NOT_LOADED_TEXT, type BudgetMonthState } from './budget-month-state';
import { IncomePoolHeader, IncomeSetting } from './IncomePool';
import { BudgetsMonthSkeleton, RowsSkeleton, UpcomingSkeleton } from './LoadingSkeletons';
import TotalCaveats, { Notice, type Caveat } from './TotalCaveats';
import { monthNotice, pastMonthNotes, thisMonthNotes } from './budget-notes';
import { gapText, monthName as nameOfMonth, monthsText, type IncomeCarryover, type MonthGap } from '@/lib/rollover';
import { dismissedSeries, type RecurringSeries } from '@/lib/recurring';
import { localDate, localMonth, instantDay } from '@/lib/local-date';
import { cashPosition, type ForecastInstitution } from '@/lib/forecast';
import { EMPTY_PLANNED, type Planned } from '@/lib/planned';
import { formatMoney } from '@/lib/format';
import { spendingByCategory } from '@/lib/totals';
import type { Incomplete, Stopped } from '@/lib/month-coverage';
import { noSpending as noSpendingOf, withoutNote, NO_CONNECTIONS_WITHOUT, type NoTransactionsView } from '@/lib/no-transactions';
import GoalsCard, { type Goal, type GoalAccount } from './GoalsCard';
import type { GoalPlansDamage } from './GoalPlansRepair';
import UpcomingPanel from './UpcomingPanel';
import { Masked } from './HideAmounts';
import TemplateOffer from './TemplateOffer';
import BudgetsBar, { BUDGETS_MONTH_TITLE, budgetsPanelId, budgetsTabId, type BudgetsMonth, type BudgetsSegment } from './BudgetsBar';
import { chevron, RIGHT } from './ActivityBar';
import { budgetsRange, budgetsShown, writeMonth, type ViewMonth } from './view-month-state';

// Stable empty defaults, as in Insights.
const NO_GAPS: Incomplete[] = [];
const NO_STOPPED: Stopped[] = [];
const NO_SERIES: RecurringSeries[] = [];
const NO_INSTITUTIONS: ForecastInstitution[] = [];
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
      <Notice level="caution">{state.error && state.error !== NOT_LOADED_TEXT ? state.error : `${name} couldn’t be loaded.`}</Notice>
      <div className="btn-row">
        <button type="button" className="btn secondary" onClick={state.reload}>
          Try again
        </button>
      </div>
    </>
  );
}

/** Amber from 85% of what is available, and past it, as each budget's meter
 *  (components/BudgetsCard.tsx); the figures beside it say which. */
function meterState(ratio: number): '' | ' warn' {
  return ratio >= 0.85 ? ' warn' : '';
}

export default function BudgetsTab({
  txns,
  fx = null,
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
  goalsDamage,
  onGoalsRepaired,
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
  segment: segmentShown,
  onSegment,
  viewMonth,
  onViewMonth,
  onPayoff,
}: {
  txns: Txn[] | null;
  /** What spending in other currencies converts with, once a home currency
   *  is chosen (app/api/transactions `fx`); null without one. */
  fx?: FxTable | null;
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
  /** When goals can't load for plans that can't be read, how many (the
   *  repair the card offers: components/GoalPlansRepair.tsx). */
  goalsDamage?: GoalPlansDamage;
  /** Loads the goals again once damaged plans are removed. */
  onGoalsRepaired?: () => void;
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
  /** The segment shown, kept by the dashboard so the tab comes back on it;
   *  left out, the tab keeps its own. */
  segment?: BudgetsSegment;
  onSegment?: (s: BudgetsSegment) => void;
  /** The month shared with Activity (components/view-month-state.ts), and
   *  its writer; without them the tab keeps its own. */
  viewMonth?: ViewMonth;
  onViewMonth?: (m: ViewMonth) => void;
  /** Opens the debt payoff plan (components/DebtPayoff.tsx), when there is a
   *  card or loan on screen to plan; left out, Goals doesn't offer it. */
  onPayoff?: () => void;
}) {
  const [ownSegment, setOwnSegment] = useState<BudgetsSegment>('month');
  const segment = segmentShown ?? ownSegment;
  const chooseSegment = onSegment ?? setOwnSegment;
  // A segment chosen while the bar is pinned opens at its top, just under
  // the bar, not where the last one was scrolled to.
  const barRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const switched = useRef(false);
  useEffect(() => {
    if (!switched.current) return;
    switched.current = false;
    const el = panelRef.current;
    const bar = barRef.current;
    if (el && bar && el.getBoundingClientRect().top < bar.getBoundingClientRect().bottom) el.scrollIntoView({ block: 'start' });
  }, [segment]);
  const switchSegment = (s: BudgetsSegment) => {
    if (s === segment) return;
    switched.current = true;
    chooseSegment(s);
  };

  const thisMonth = localMonth();
  // The month shown: this month, or one picked to look back on, here or on
  // Activity (the month is shared when the dashboard passes it).
  const [ownMonth, setOwnMonth] = useState<ViewMonth>(null);
  const wantMonth = onViewMonth ? (viewMonth ?? null) : ownMonth;
  const writeViewMonth = onViewMonth ?? setOwnMonth;
  const shownMonth = budgetsShown(wantMonth, thisMonth);
  const past = shownMonth !== thisMonth;
  const pastMonth = useBudgetMonth(past && budgetsStatus === 'ready' ? shownMonth : null, [budgets, txns, taxonomy]);
  const month = past ? pastMonth : budgetMonth;
  // The view of the month shown, once loaded (kept while it loads again).
  const view = month.view && month.view.month === shownMonth ? month.view : null;
  // Once the budgets have been ready, a reload (after a save the server
  // refused: lib/whole-list-store.ts) keeps the month drawn from the budgets
  // the page holds, read only, so a budget's sheet open on them stays open,
  // with what was typed, and says why. The first load says it is loading.
  const [wasReady, setWasReady] = useState(budgetsStatus === 'ready');
  if (budgetsStatus !== 'loading' && wasReady !== (budgetsStatus === 'ready')) setWasReady(budgetsStatus === 'ready');
  const drawn = budgetsStatus === 'ready' || (budgetsStatus === 'loading' && wasReady);
  // This month's income setting as its view last had it, so the setting's
  // row, and its sheet open on a change, stay when the month can't be read
  // again (offline, the change fails and so does the reload after it): the
  // sheet says why, and nothing is offered until the month is back.
  const thisView = budgetMonth.view?.month === thisMonth ? budgetMonth.view : null;
  const [heldIncome, setHeldIncome] = useState<{ income: IncomeCarryover | null; earliest: string | null } | null>(null);
  if (thisView && (heldIncome?.income !== thisView.income || heldIncome?.earliest !== thisView.earliest)) {
    setHeldIncome({ income: thisView.income, earliest: thisView.earliest });
  }
  const monthName = past
    ? nameOfMonth(shownMonth, thisMonth)
    : new Date().toLocaleDateString(undefined, { month: 'long' });

  // Budgets are plain numbers with no currency; they count, and are shown in,
  // the currency most transactions are in (lib/spending.ts), as the server
  // reads them (lib/budget-month.ts). With a home currency chosen, they stay
  // in it, never relabelled, and spending in other currencies counts against
  // them converted into it at each day's rate (lib/fx/totals.ts).
  const budgeted = useMemo(() => totalsIn(txns ?? [], fx, { into: 'most' }), [txns, fx]);
  const displayCurrency = budgeted.currency;
  const monthCounted = useMemo(() => budgeted.rows.filter((t) => t.date.slice(0, 7) === thisMonth), [budgeted, thisMonth]);

  // Current-month spending per category id (lib/totals.ts, which the API's
  // budgets share).
  const spendByCat = useMemo(() => {
    const ix = taxonomy ? indexTaxonomy(taxonomy) : null;
    return spendingByCategory(monthCounted, () => true, displayCurrency, ix ? (t) => filedId(ix, t) : undefined);
  }, [monthCounted, displayCurrency, taxonomy]);

  // This month's spending in other currencies with no rate, named rather
  // than added, and what was converted.
  const leftOut = useMemo(
    () =>
      leftOutWhy(
        leftOutText(
          leftOutByCurrency(
            monthCounted.filter((t) => t.amount > 0),
            displayCurrency
          ),
          displayCurrency,
          { where: 'these budgets' }
        ),
        conversionIn(monthCounted, budgeted.conversion)
      ),
    [monthCounted, displayCurrency, budgeted]
  );
  const converted = useMemo(() => convertedText(conversionIn(monthCounted, budgeted.conversion), { budgets: true }), [monthCounted, budgeted]);

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
  // A past month's own gaps, said in the month's notice as this month's are.
  const shownGaps = useMemo(() => (view && past ? (view.gaps.find((g) => g.month === shownMonth)?.gaps ?? []) : []), [view, past, shownMonth]);
  // Months to look back on: back to the first with transactions, ten years
  // at most, or to the month shown when Activity brought an earlier one, or
  // one before the first is known.
  const earliest = budgetMonth.view?.earliest ?? null;
  const pickable = useMemo(() => budgetsRange(shownMonth, thisMonth, earliest), [shownMonth, thisMonth, earliest]);
  // Carries or amounts from before budgets were kept by month are assumed.
  const assumedNote =
    view &&
    (view.assumed.categories.length > 0 ||
      view.assumed.groups.length > 0 ||
      [...Object.values(view.carries.categories), ...Object.values(view.carries.groups)].some((c) => c.from < view.recorded_since))
      ? `Nya began keeping budgets by month in ${nameOfMonth(view.recorded_since, thisMonth)}, so before then each budget counts its amount in ${nameOfMonth(view.recorded_since, thisMonth)}.`
      : null;

  // A change to rollover or income carryover, from the sheet that asked: it
  // says the refusal itself, and closes once there is none. The month is
  // worked out again either way; should that fail, the card says so.
  async function onRollover(t: Target, change: RolloverChange): Promise<string | null> {
    const body =
      'reset' in change
        ? { action: 'reset', kind: t.kind, id: t.id }
        : change.on
          ? { action: 'rollover', kind: t.kind, id: t.id, on: true, from: change.from }
          : { action: 'rollover', kind: t.kind, id: t.id, on: false };
    const error = await changeRollover(body);
    budgetMonth.reload();
    return error;
  }
  async function onIncome(change: { enabled: true; start: string } | { enabled: false }): Promise<string | null> {
    const error = await changeRollover({ action: 'income', ...change });
    budgetMonth.reload();
    return error;
  }

  // Bills and income detected (lib/recurring.ts), for the recurring list, the
  // forecast, the list and the calendar alike.
  const series = detected ?? NO_SERIES;
  // Until the planned items load, no item counts and nothing is dismissed: the
  // segment's notice says so. Once they have been ready, a reload (after a
  // save the server refused) keeps them drawn, as the budgets are: the store
  // has put back what is saved, which is what it reads again. A dismissal
  // follows its series as amounts move (lib/recurring.ts dismissedSeries):
  // the series' ids, and what each was saved as, to restore it.
  const [plannedWasReady, setPlannedWasReady] = useState(plannedStatus === 'ready');
  if (plannedStatus !== 'loading' && plannedWasReady !== (plannedStatus === 'ready')) setPlannedWasReady(plannedStatus === 'ready');
  const plannedDrawn = plannedStatus === 'ready' || (plannedStatus === 'loading' && plannedWasReady);
  const dismissedIds = plannedDrawn ? planned.dismissed : NO_DISMISSED;
  const gone = useMemo(() => dismissedSeries(series, dismissedIds), [series, dismissedIds]);
  const dismissed = useMemo(() => new Set(gone.keys()), [gone]);
  // A planned item starts in the forecast's currency: the cash accounts'.
  const plannedCurrency = useMemo(() => cashPosition(institutions).currency ?? displayCurrency, [institutions, displayCurrency]);
  const today = localDate();

  // The month shown, the months to step through and choose from once the
  // budgets are there to show, and the way back to this month.
  const shownBar: BudgetsMonth = {
    value: shownMonth,
    months: pickable,
    label: (m) => nameOfMonth(m),
    optionLabel: (m) => (m === thisMonth ? `${nameOfMonth(m, thisMonth)} (this month)` : nameOfMonth(m, thisMonth)),
    onMonth: (m) => writeViewMonth(writeMonth(m, thisMonth)),
    disabled: budgetsStatus !== 'ready' || loading,
    back: past ? { label: 'This month', onBack: () => writeViewMonth(null) } : null,
  };

  // The bar is drawn before anything has loaded, so the month's heading is
  // there for Home's budget alerts to land on.
  const bar = <BudgetsBar ref={barRef} segment={segment} onSegment={switchSegment} month={shownBar} />;
  const panel = (s: BudgetsSegment, body: ReactNode) => (
    <div className="budgets-panel" id={budgetsPanelId(s)} role="tabpanel" aria-labelledby={budgetsTabId(s)} hidden={s !== segment} ref={s === segment ? panelRef : undefined}>
      {body}
    </div>
  );
  // Goals needs no transactions, so it never waits for them.
  const goalsPanel = panel(
    'goals',
    <>
      <GoalsCard
        goals={goals}
        status={goalsStatus}
        error={goalsError}
        saveError={goalsSaveError}
        damage={goalsDamage}
        onRepaired={onGoalsRepaired}
        accounts={accounts}
        onSave={onSaveGoals}
      />
      {onPayoff && (
        <section className="card debt-payoff" aria-labelledby="debt-payoff-title">
          <div className="card-header">
            <h3 id="debt-payoff-title">Debt payoff</h3>
          </div>
          <ul className="list-rows">
            <li>
              <button className="list-row" onClick={onPayoff}>
                <span className="list-row-text">
                  <span className="list-row-title">Payoff plan</span>
                </span>
                {chevron(RIGHT)}
              </button>
            </li>
          </ul>
        </section>
      )}
    </>
  );

  // Each segment as it will be, its figures still to come
  // (components/LoadingSkeletons.tsx), rather than a spinner it grows from.
  if (loading) {
    return (
      <>
        {bar}
        {panel('month', <BudgetsMonthSkeleton />)}
        {panel('upcoming', <UpcomingSkeleton />)}
        {goalsPanel}
      </>
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
  const noSpending = txns ? noSpendingOf(withoutTransactions, historyCount(txns)) : null;
  const namedWithout = withoutNote(withoutTransactions, txns ? historyCount(txns) : 0);

  // The currency the figures are in: this page's for this month, the
  // server's for a past one (the same rule, over the same year).
  const shownCurrency = past ? (view?.currency ?? displayCurrency) : displayCurrency;
  const shownLeftOut = past ? (view?.left_out_text ?? null) : leftOut;
  const shownConverted = past ? (view?.converted_text ?? null) : converted;

  // What may leave the month itself short, for its total: this month's as
  // Activity says it, a past one's as the server read it. With no spending
  // to count at all, nothing can be missing from it.
  const ownNotes =
    hasTotal && !noSpending
      ? past
        ? pastMonthNotes(monthName, shownGaps, reasonText)
        : thisMonthNotes(thisMonth, incomplete, stopped, withoutTransactions, (at) => instantDay(at) ?? at.slice(0, 10))
      : [];
  // The month's one notice, at the top of the segment: those, and why a
  // carry or the pool may be off.
  const notice = monthNotice(ownNotes, carryNotes);
  // The Spent card's notes: what explains its figures, where nothing is
  // wrong, each in full or gathered (components/TotalCaveats.tsx). Built in
  // a list, one at a time.
  const spentNotes: Caveat[] = [];
  if (shownConverted) spentNotes.push({ key: 'converted', severity: 'info', summary: 'spending converted', body: shownConverted });
  if (shownLeftOut) spentNotes.push({ key: 'left-out', severity: 'info', summary: 'other currencies left out', body: shownLeftOut });
  if (view?.counted_left_out_text) spentNotes.push({ key: 'counted-left-out', severity: 'info', summary: 'other currencies left out of rollover', body: view.counted_left_out_text });
  // A split whose amount changed since counts as split until edited (#39).
  const splitChanged = hasTotal && txns ? splitChangedText(txns, shownMonth) : null;
  if (splitChanged) spentNotes.push({ key: 'split-changed', severity: 'info', summary: 'split amounts changed', body: splitChanged });
  if (hasTotal && namedWithout) spentNotes.push({ key: 'without', severity: 'info', summary: 'connections without transactions', body: namedWithout });
  if (assumedNote) spentNotes.push({ key: 'assumed', severity: 'info', summary: 'earlier amounts assumed', body: assumedNote });

  // The starter sets' offer declined, its row gone: focus to the month's
  // heading, where the panel starts, rather than to nothing.
  const focusMonth = () => document.getElementById(BUDGETS_MONTH_TITLE)?.focus({ preventScroll: true });

  // This month with no budget at all: one card, the empty state, in place of
  // Spent (BudgetsCard draws it, holding Add budget's sheet). What the Spent
  // card would have said goes in it, in the same order and words. A past
  // month keeps Spent with its line: it is read only, with no first step.
  // A budget on a category or group since deleted (an orphan) is a budget
  // all the same, a row of its own: never under "No budgets yet".
  const orphaned = !!taxonomy && !!shownBudgets && placeBudgets(shownBudgets, indexTaxonomy(taxonomy)).orphans.length > 0;
  const empty = drawn && !!taxonomy && !!shownBudgets && !!shownSpent && !hasTotal && !past && !orphaned;
  const emptyNotes = empty ? (
    <>
      {budgetsSaveError && <Notice level="caution">{budgetsSaveError}</Notice>}
      {month.status === 'error' && month.error && <Notice level="caution">{month.error}</Notice>}
      {noSpending && (
        <p className="empty-note">
          {noSpending.lead}, so there&apos;s no spending to count against budgets. To track them, {noSpending.remedy}.
        </p>
      )}
      <TotalCaveats items={spentNotes} />
    </>
  ) : undefined;

  return (
    <>
      {bar}
      {panel(
        'month',
        <div className="stack loose">
          {/* A past month's rows open nothing: why, and where to go instead,
              once there are rows (Activity can bring one while they load). */}
          {past && drawn && <p className="helper">{monthName} is shown as it was. To change a budget, go to this month.</p>}
          <TotalCaveats items={notice} />
          {onCategories && <TemplateOffer taxonomy={taxonomy} onTaxonomy={onCategories} onKept={focusMonth} />}
          {drawn && view?.pool && <IncomePoolHeader pool={view.pool} currency={shownCurrency} month={shownMonth} today={thisMonth} />}
          {/* Conditional in its own slot, so BudgetsCard below keeps its
              place and is never drawn anew while a sheet closes. */}
          {!empty && (
            <section className="card stack" aria-labelledby="budgets-spent-title">
              <div className="card-header">
                <h3 id="budgets-spent-title">Spent</h3>
                {hasTotal && drawn && !noSpending && (
                  <span className="meta money">
                    <Masked>
                      {totalBudget > 0
                        ? `${formatMoney(totalSpent, shownCurrency)} of ${formatMoney(totalBudget, shownCurrency)}`
                        : `${formatMoney(totalSpent, shownCurrency)} spent, nothing left`}
                    </Masked>
                  </span>
                )}
              </div>
              {/* The month itself may be short: said in full in the notice above. */}
              {drawn && ownNotes.length > 0 && (
                <div>
                  <span className="badge warn">May be incomplete</span>
                </div>
              )}
              {drawn && hasTotal && !noSpending && (
                <div className={`meter-track${meterState(totalRatio)}`}>
                  <div className={`meter-fill${meterState(totalRatio)}`} style={{ width: `${Math.min(totalRatio * 100, 100)}%` }} />
                </div>
              )}
              {budgetsStatus === 'error' ? (
                <Notice level="caution">{budgetsError}</Notice>
              ) : !drawn ? (
                // The meter's place, and the budgets' rows under the card
                // (below), as they will be.
                <>
                  <span className="skeleton block budgets-skeleton-meter" aria-hidden="true" />
                  <p className="visually-hidden" role="status">
                    Loading budgets
                  </p>
                </>
              ) : (
                <>
                  {budgetsSaveError && <Notice level="caution">{budgetsSaveError}</Notice>}
                  {!past && month.status === 'error' && month.error && <Notice level="caution">{month.error}</Notice>}
                  {noSpending && (
                    <p className="empty-note">
                      {noSpending.lead}, so there&apos;s no spending to count against budgets. To track them, {noSpending.remedy}.
                    </p>
                  )}
                  {!taxonomy ? (
                    categoriesError ? (
                      <Notice level="caution">{`${categoriesError} Budgets are shown once they are.`}</Notice>
                    ) : (
                      <p className="empty-note">Loading your categories…</p>
                    )
                  ) : (
                    past && !view && <PastMonthPending state={month} name={monthName} />
                  )}
                  {taxonomy && shownBudgets && shownSpent && !hasTotal && past && <NoBudgets month={shownMonth} />}
                </>
              )}
              {/* What the figure counts, after what went wrong with it. */}
              <TotalCaveats items={spentNotes} />
            </section>
          )}
          {!drawn && budgetsStatus !== 'error' && <RowsSkeleton count={4} className="card list-rows budget-rows" />}
          {drawn && taxonomy && shownBudgets && shownSpent && (
            <BudgetsCard
              key={shownMonth}
              taxonomy={taxonomy}
              budgets={shownBudgets}
              spent={shownSpent}
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
              saveError={budgetsSaveError}
              monthError={!past && month.status === 'error' ? month.error : null}
              empty={emptyNotes}
            />
          )}
          {drawn && !past && heldIncome && (
            <IncomeSetting
              setting={heldIncome.income}
              today={thisMonth}
              earliest={heldIncome.earliest}
              disabled={budgetsStatus !== 'ready' || !thisView}
              monthError={thisView ? null : (budgetMonth.error ?? NOT_LOADED_TEXT)}
              onChange={onIncome}
            />
          )}
        </div>
      )}

      {panel(
        'upcoming',
        <UpcomingPanel
          institutions={institutions}
          series={series}
          planned={planned}
          plannedStatus={plannedStatus}
          plannedDrawn={plannedDrawn}
          plannedError={plannedError}
          plannedSaveError={plannedSaveError}
          onSavePlanned={onSavePlanned}
          dismissed={dismissed}
          onDismiss={
            onSavePlanned &&
            ((s, dismiss) => {
              const saved = gone.get(s.id);
              const rest = planned.dismissed.filter((d) => d !== saved && d !== s.id);
              return onSavePlanned({ ...planned, dismissed: dismiss ? [...rest, s.id] : rest });
            })
          }
          txns={txns}
          failed={txnsFailed}
          balancesAsOf={balancesAsOf}
          balancesSaved={balancesSaved}
          incomplete={incomplete}
          stopped={stopped}
          withoutTransactions={withoutTransactions}
          fx={fx}
          today={today}
          currency={displayCurrency}
          plannedCurrency={plannedCurrency}
          noSpending={noSpending}
        />
      )}

      {goalsPanel}
    </>
  );
}
