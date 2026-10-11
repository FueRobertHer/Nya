// lib/budget-month.ts
//
// One month of budgets as the Budgets tab, the read-only API and MCP, and the
// data download show it (#37), read once and one way, so they agree: each
// budget's amount that month, what rolls into it, what was spent against it,
// the income pool when income carryover is on, and which months may be
// incomplete. The math is lib/rollover.ts; this gathers what it reads.
//
// FROM THE STORED HISTORY. Spending is read from the stored transactions, as
// the Activity tab assembles them (lib/activity.ts: the person's categories,
// names and exclusions, manual and imported rows, SimpleFIN's, hidden
// accounts left out), back to the first month any carry or pool counts
// (lib/rollover.ts neededFrom), however long before the year the dashboard
// loads, never calling Plaid. Each month's spending by category and money in
// and out go through lib/totals.ts, so through countsInTotals (lib/spending.ts):
// one currency (the one most of the last year's transactions are in, as the
// Budgets tab and the API take it), what was excluded left out, transfers,
// cash and loan payments never spending or income, and what is in other
// currencies counted apart and named, never added.
//
// HONEST GAPS. A month whose transactions may be incomplete is named, with
// why (lib/rollover.ts MonthGap): an institution whose rows aren't all here
// (missing, or older ones still importing), a connection that stopped
// syncing before the month ended, a linked institution whose stored history
// begins after the month began, a bank account or card whose transactions
// don't come in, what the read couldn't read (a manual account's rows, the
// person's own categories or carried exclusions, how each connection is
// doing), and rows whose exclusion couldn't be read. Every carry and pool
// counting such a month says it may be off. The first month with any
// transactions is where carries and pools begin (the clamp), and is named.
//
// TWO READERS. The app's (`app`) migrates budgets and notes the budget set in
// the record (lib/budget-months-store.ts noteMonths), so a change made
// elsewhere is pinned to the month it was first seen. The read-only API and
// the download write nothing: they note it in memory, as of `today`.

import type { Ctx } from './containers';
import { assembleBankRows, finishActivity, type BankSource, type PlaidPayload } from './activity';
import { readHealthForDisplay } from './connection-health';
import { noticesStore } from './connection-records';
import { connectorBanksReport, type ConnectorBanksReport } from './connectors/institutions';
import { manualTxnStore } from './manual-txns';
import { loadBudgets, budgetsForReading } from './budget-store';
import { budgetMonthsStore, incomeCarryoverStore, noteMonths } from './budget-months-store';
import { filedId, indexTaxonomy, type CategoryIndex, type Taxonomy } from './categories';
import type { Budgets } from './budget-set';
import { LOOKBACK_DAYS, type Txn } from './transactions';
import { spendingByCategory, summarize } from './totals';
import { totalsCurrency } from './spending';
import { stoppedConnections } from './month-coverage';
import { noTransactionsView, quietItemIds, type NoTransactionsView } from './no-transactions';
import {
  budgetsInMonth,
  incomePool,
  monthGapsOf,
  monthOf,
  monthsFrom,
  neededFrom,
  noteBudgets,
  startMonths,
  type BudgetMonths,
  type CoverageFacts,
  type IncomeCarryover,
  type IncomePool,
  type MonthBudgets,
  type MonthGap,
} from './rollover';

/** The first day of the window the dashboard loads (the last LOOKBACK_DAYS,
 *  by UTC day, as lib/transactions.ts cuts it): the rows the budgets'
 *  currency is decided over. */
export const windowStart = (now: number = Date.now()): string => new Date(now - LOOKBACK_DAYS * 86_400_000).toISOString().slice(0, 10);

/** The stored rows from `since` on, assembled as the Activity tab's are, and
 *  what says whether they are all there. Never calls Plaid; writes nothing. */
export type MonthActivity = {
  rows: Txn[];
  notes: string[];
  taxonomy: Taxonomy;
  hidden: Set<string>;
  bank: { sources: BankSource[]; payload: PlaidPayload; own_read: { categories: boolean; names: boolean; exclusions: boolean } };
  incomplete: { institution_name: string; coverage: 'missing' | 'importing' }[];
  manual_unread: string[] | 'all';
  /** Each bank a SimpleFIN connection reaches (lib/connectors/institutions.ts). */
  fed: ConnectorBanksReport;
  view: NoTransactionsView;
  /** The first month with any stored transaction, hidden accounts' aside
   *  (unless asked for), or null with none. */
  earliest: string | null;
  facts: CoverageFacts;
};

/** The earliest day of the rows entered, imported or brought from SimpleFIN
 *  on accounts not left out. LENIENT, for this computation only, which
 *  nothing writes, deletes or records on: a book that can't be read is left
 *  out here, and the assembly's notes say it couldn't be read. */
async function firstManualDay(ctx: Ctx, leftOut: ReadonlySet<string>): Promise<string | null> {
  const books = await manualTxnStore.getAllLenient(ctx);
  let first: string | null = null;
  for (const [account, book] of books) {
    if (leftOut.has(account)) continue;
    for (const r of book.rows) if (first === null || r.date < first) first = r.date;
  }
  return first;
}

/**
 * The stored rows from `since` on (lib/activity.ts, never syncing), with what
 * says whether each month is complete (see HONEST GAPS). `grow` is the app's
 * read: rows older than the year the dashboard loads may carry a category the
 * stored set doesn't have yet, which it is grown by, as the Activity tab
 * grows it; without it nothing is written.
 */
export async function readMonthActivity(ctx: Ctx, opts: { since: string; includeHidden?: boolean; grow?: boolean }): Promise<MonthActivity> {
  const bank = await assembleBankRows(ctx, { sync: false, readOnly: true, includeHidden: opts.includeHidden, withAccountIds: true, since: opts.since });
  const leftOut = opts.includeHidden ? new Set<string>() : bank.hidden;
  const [finished, fed, health, notices, manualFirst] = await Promise.all([
    finishActivity(ctx, bank.payload, leftOut, { since: opts.since, grow: !!opts.grow }),
    // LENIENT, for this display only, as the read-only API reads them: what
    // can't be read is said by the assembly's own notes.
    connectorBanksReport(ctx),
    // LENIENT, for this display only: how each connection is doing, as the
    // read-only API reads it (lib/api-read.ts connectionFacts). What can't be
    // read makes every month uncertain, never complete.
    readHealthForDisplay(ctx),
    noticesStore.getAllReport(ctx).catch(() => null),
    firstManualDay(ctx, leftOut),
  ]);
  const rows = finished.transactions;
  const view = noTransactionsView(bank.payload);

  // Connections whose transactions stopped arriving: each linked one in a
  // broken state (its notice's), with when it last synced, and each bank a
  // SimpleFIN connection reaches whose card says so; never one that holds no
  // bank account or card (lib/month-coverage.ts stoppedConnections).
  const linked = bank.sources.map((s) => {
    const state = notices?.entries.get(s.item_id)?.state;
    const last = health?.syncs.get(s.item_id)?.at ?? null;
    return { item_id: s.item_id, institution_name: s.institution_name, ...(state ? { health: { state, last_ok_at: last } } : {}) };
  });
  const cards = fed.cards.filter((c) => !c.accounts.every((a: { account_id: string }) => leftOut.has(a.account_id)));
  const stopped = stoppedConnections([...linked, ...cards], quietItemIds(view));

  const unread: string[] = [];
  if (finished.manual_unread === 'all') unread.push('Transactions on your manual accounts');
  else if (finished.manual_unread.length > 0) unread.push(`Transactions on ${finished.manual_unread.length} manual account${finished.manual_unread.length === 1 ? '' : 's'}`);
  if (!bank.own_read.categories) unread.push('The categories you chose for some transactions');
  if (!bank.own_read.exclusions) unread.push('The exclusions you carried across a reconnect');
  if (health === null || notices === null || health.unread.size > 0 || notices.unreadable.length + notices.unrecognised.length > 0) unread.push('How each bank connection is doing');

  const exclusionUnknown = new Map<string, number>();
  for (const t of rows) if (t.excluded === null) exclusionUnknown.set(monthOf(t.date), (exclusionUnknown.get(monthOf(t.date)) ?? 0) + 1);

  const firstDays = bank.sources.flatMap((s) => (s.first_date && !s.no_transactions ? [s.first_date] : []));
  const earliestDay = [...firstDays, ...(manualFirst ? [manualFirst] : [])].sort()[0] ?? null;

  return {
    rows,
    notes: finished.notes,
    taxonomy: finished.taxonomy,
    hidden: bank.hidden,
    bank: { sources: bank.sources, payload: bank.payload, own_read: bank.own_read },
    incomplete: finished.incomplete,
    manual_unread: finished.manual_unread,
    fed,
    view,
    earliest: earliestDay ? monthOf(earliestDay) : null,
    facts: {
      incomplete: finished.incomplete,
      stopped,
      first: bank.sources.flatMap((s) => (s.first_date && !s.no_transactions && s.coverage !== 'missing' ? [{ institution: s.institution_name, day: s.first_date }] : [])),
      without: bank.sources.flatMap((s) => (s.no_transactions === 'refused' || s.no_transactions === 'no_consent' ? [{ institution: s.institution_name, reason: s.no_transactions }] : [])),
      unread,
      exclusionUnknown,
    },
  };
}

/** A month of budgets, worked out (see the header). */
export type BudgetMonthRead = {
  month: string;
  today: string;
  /** The currency every figure is in (see FROM THE STORED HISTORY). */
  currency: string | null;
  /** The categories the budgets are placed against. */
  taxonomy: Taxonomy;
  ix: CategoryIndex;
  /** The budget set now, and the record noted against it. */
  budgetsNow: Budgets;
  months: BudgetMonths | null;
  income: IncomeCarryover | null;
  /** The month's budgets and carries (lib/rollover.ts budgetsInMonth). */
  view: MonthBudgets;
  /** The month's spending by category id. */
  spent: Record<string, number>;
  pool: IncomePool | null;
  /** The first month with any transactions, or null with none. */
  earliest: string | null;
  /** The months read whose transactions may be incomplete, oldest first. */
  gaps: { month: string; gaps: MonthGap[] }[];
  /** The month's own rows. */
  monthRows: Txn[];
  activity: MonthActivity;
};

/**
 * The month's budgets (see the header). `today` is this month, as the page
 * has it (lib/rollover.ts thisMonth), or the UTC month for the API. `app`
 * reads as the app does, writing what lib/budget-months-store.ts writes on a
 * read; without it nothing is written. `pool: false` leaves the income pool
 * out, unread. Strict: budgets, their record or the income setting that
 * can't be read throw (StoredDataUnreadableError), and so does storage out
 * of reach.
 */
export async function readBudgetMonth(ctx: Ctx, opts: { month: string; today: string; includeHidden?: boolean; app?: boolean; pool?: false }): Promise<BudgetMonthRead> {
  const { month, today } = opts;
  let budgetsNow: Budgets;
  let taxonomy: Taxonomy;
  let months: BudgetMonths | null;
  let income: IncomeCarryover | null;
  let activity: MonthActivity;
  const window = windowStart();
  const sinceFor = (from: string) => (`${from}-01` < window ? `${from}-01` : window);
  if (opts.app) {
    const loaded = await loadBudgets(ctx);
    budgetsNow = loaded.budgets;
    months = await noteMonths(ctx, budgetsNow, loaded.taxonomy, today);
    income = await incomeCarryoverStore.get(ctx);
    activity = await readMonthActivity(ctx, { since: sinceFor(neededFrom(months, income, month)), includeHidden: opts.includeHidden, grow: true });
    // The set the rows were filed by: the stored one, grown by them, so it
    // holds every category the budgets are on, unless the filing fell back
    // to a set made in memory (lib/category-store.ts fileTransactions).
    const filed = new Set(activity.taxonomy.categories.map((c) => c.id));
    taxonomy = loaded.taxonomy.categories.every((c) => filed.has(c.id)) ? activity.taxonomy : loaded.taxonomy;
  } else {
    // `pool: false` (the download, which has the setting in a section of its
    // own) reads no income setting, so one that can't be read never keeps the
    // budgets' carries out.
    const [stored, setting] = await Promise.all([budgetMonthsStore.get(ctx), opts.pool === false ? null : incomeCarryoverStore.get(ctx)]);
    income = setting;
    activity = await readMonthActivity(ctx, { since: sinceFor(neededFrom(stored, setting, month)), includeHidden: opts.includeHidden });
    ({ budgets: budgetsNow, taxonomy } = await budgetsForReading(ctx, activity.taxonomy));
    // Noted in memory, as the app would note it today: nothing is written.
    months = noteBudgets(stored ?? startMonths(budgetsNow, today), budgetsNow, today, indexTaxonomy(taxonomy));
  }
  return monthFromActivity({ month, today, budgetsNow, taxonomy, months, income, activity, window });
}

/** The month worked out from what was read: no reads, no writes. */
export function monthFromActivity(input: {
  month: string;
  today: string;
  budgetsNow: Budgets;
  taxonomy: Taxonomy;
  months: BudgetMonths | null;
  income: IncomeCarryover | null;
  activity: MonthActivity;
  window: string;
}): BudgetMonthRead {
  const { month, today, activity } = input;
  const ix = indexTaxonomy(input.taxonomy);
  const rows = activity.rows;
  const currency = totalsCurrency(rows.filter((t) => t.date >= input.window));
  // The rows by month, once, so each month's totals read only its own.
  const byMonth = new Map<string, Txn[]>();
  for (const t of rows) {
    const m = monthOf(t.date);
    const list = byMonth.get(m);
    if (list) list.push(t);
    else byMonth.set(m, [t]);
  }
  const all = () => true;
  // Each row by the category it is filed under, against the categories the
  // budgets are placed by (lib/categories.ts filedId), as the Budgets tab
  // files the rows it loaded.
  const spending = (m: string) => new Map(Object.entries(spendingByCategory(byMonth.get(m) ?? [], all, currency, (t) => filedId(ix, t))));
  const flows = (m: string) => summarize(byMonth.get(m) ?? [], all, currency);

  // Which months may be incomplete, from the first counted to the month
  // shown; a month still to come counts this one, which isn't over.
  const from = neededFrom(input.months, input.income, month);
  const gaps: { month: string; gaps: MonthGap[] }[] = [];
  for (const m of monthsFrom(from < month ? from : month, month)) {
    const g: MonthGap[] = [...monthGapsOf(m, activity.facts), ...(m >= today && m < month ? [{ kind: 'running' as const }] : [])];
    if (g.length > 0) gaps.push({ month: m, gaps: g });
  }
  const uncertainMonths = new Set(gaps.map((g) => g.month));
  const carryInput = { earliest: activity.earliest, uncertain: (m: string) => uncertainMonths.has(m) };

  const view = budgetsInMonth({ ix, budgets: input.budgetsNow, months: input.months, month, today, spending, ...carryInput });
  return {
    month,
    today,
    currency,
    taxonomy: input.taxonomy,
    ix,
    budgetsNow: input.budgetsNow,
    months: input.months,
    income: input.income,
    view,
    spent: Object.fromEntries(spending(month)),
    pool: incomePool(input.income, month, flows, carryInput),
    earliest: activity.earliest,
    gaps,
    monthRows: byMonth.get(month) ?? [],
    activity,
  };
}
