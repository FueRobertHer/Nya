// lib/share-views.ts
//
// What the other person on a connection is shown of someone's net worth,
// spending, holdings, budgets and goals (#45 step 3, the kinds of
// lib/share-kinds.ts): each a small projection of the owner's data, built on
// the server each time it is read, from the owner's Ctx, which only
// lib/sharing.ts builds (projectShare passes it here). Nothing here builds a
// Ctx, writes anything, or calls Plaid: every read is of what is stored, and
// read-only.
//
// THE OWNER'S OWN NUMBERS. Each kind is read by the functions the owner's own
// screens and the read-only API read by (which the API documents as the
// app's own rules), never by arithmetic of its own, so a share never says
// what the owner's app contradicts:
//   - net worth: lib/api-read.ts readNetWorthAndHistory, each account's newest
//     measured balance added up as the Accounts tab adds them (in the currency
//     most accounts are in, the others named and left out), and the history
//     the owner's chart draws, hidden accounts subtracted and ended ones from
//     their end day, one point a week (at "total", readNetWorth: the same
//     total without drawing the chart); readAccounts for the accounts in it
//     whose balances the share of accounts shows, and only those.
//   - spending: the Activity tab's own assembly (lib/activity.ts
//     assembleBankRows and finishActivity, never syncing) and its totals
//     (lib/totals.ts summarize, by the spending rule of lib/spending.ts): one
//     currency, what was left out for another named by its currency alone,
//     transfers and what the owner excluded left out, money out only, by
//     category and its group.
//   - holdings: the allocation the Plan tab draws (lib/allocation/allocation.ts
//     allocate), over the investment accounts' newest measured balances and
//     the positions last recorded (readAccounts, readHoldings), with the
//     owner's own buckets and splits (lib/allocation-settings.ts).
//   - budgets: the Budgets tab's read of a month (lib/budget-month.ts
//     readBudgetMonth) and the read-only API's answer from it
//     (lib/api-read.ts budgetsAnswer): spent against what is available, with
//     what rolled over, this month and last, both from one read of the
//     transactions (readBudgetMonths), the income pool left unread as it is
//     never shown.
//   - goals: lib/api-goals.ts readGoals, each goal as the Goals card tells it
//     (lib/goal-view.ts).
//
// ONLY WHAT IT NAMES. Each projection is built up from nothing, field by
// field, never a payload filtered on the way out: no transaction, its id,
// merchant, note, tags, split parts or group (spending and budgets are
// totals by the owner's own categories and groups, never a transaction), no
// account id anywhere, no account name in a net worth without its accounts or
// in holdings, no monthly rate or amount short behind a goal's projection,
// and at the percentage levels no amount at all.
//
// THE OWNER'S MONTH. "This month" is the owner's own: the month it is in the
// time zone they keep for their weekly summary (lib/weekly-summary/
// settings.ts), as their own screens count months on their device; by the
// UTC day, as the read-only API counts them, when they keep none.
//
// HIDDEN AND ENDED ACCOUNTS as the owner's own screens treat them: a hidden
// account is in none of it, nor a goal on one (left out while it is hidden,
// as a hidden account's own share is paused); an ended one counts from its
// end day in nothing, as everywhere in the app, and a goal on one says so.
//
// WHAT CAN'T BE READ. A kind whose owner's data can't be read says so
// (Unreadable), never a short figure as if whole: a store the seam can't use
// (budgets, goals, allocation settings, an account's end, holdings history),
// a bank's stored transactions or a manual account's book that can't be
// read, rows imported from files into a linked account that can't be, an
// account net worth or holdings would count that couldn't be read or hasn't
// been loaded. Each kind on its own: one that can't be read leaves the others
// shown. What only isn't all in yet (a bank still bringing in its older
// history, one not synced yet, a bank account or card whose transactions
// don't come in) is shown, and says it may be incomplete, as the owner's own
// Budgets tab says it; so is spending that counts transactions whose
// exclusion couldn't be read, and spending or budgets that file some rows
// otherwise because how the owner files them couldn't be read (their
// categories, their merchants' defaults, their approvals in the review
// queue), as the owner's Activity tab counts and says them. Storage out of
// reach says nothing of the data, and throws (lib/sharing.ts then shows
// nothing of the share, as for its accounts).
//
// THE OWNER'S HOME CURRENCY (decision 5). Once the owner has chosen one, a
// net worth, spending or holdings share is in it, converted as their own
// screens convert (net worth's base, lib/fx/totals.ts totalsIn, the
// allocation's inputsIn), and a budgets share counts spending in other
// currencies converted into the budgets' own, as their Budgets tab does. Each
// says only that it is converted, at the ECB's daily rates and, where one was
// used, the owner's own rates (SharedConversion): never a rate's value, nor
// which currency an own rate is for. What has no rate is named by its
// currency alone, as before.

import type { Ctx } from './containers';
import { readAccounts, readHoldings, readNetWorth, readNetWorthAndHistory, budgetsAnswer, type ApiAccount, type ApiAccounts } from './api-read';
import { readGoals, type ApiGoal } from './api-goals';
import { assembleBankRows, finishActivity, type BankSource } from './activity';
import { readBudgetMonths } from './budget-month';
import { summarize, tidy, type SummaryCategory } from './totals';
import { leftOutByCurrency, type LeftOut } from './spending';
import { coveredOutOfDays, noTransactionsView, spendingUnknown, type NoTransactionsView } from './no-transactions';
import { withImportedFiles } from './history-import/without-files';
import { categoryById, displayName, groupOf, indexTaxonomy, type CategoryIndex } from './categories';
import { allocate, inputsIn, isMoney, shareLabel, shares, type AllocHolding, type AllocInstitution } from './allocation/allocation';
import { readFlowFx } from './fx/read';
import { conversionIn, totalsIn } from './fx/totals';
import { CLASS_NAMES, SLOTS, ASSET_CLASSES, type Slot } from './allocation/classes';
import { BUCKET_NAMES, BUCKET_SLOTS } from './allocation/buckets';
import { allocationSettingsStore } from './allocation-settings';
import { isInvestmentType } from './balance';
import { dominantCurrency } from './format';
import { lastEndDay } from './lifecycle';
import { directoryTypes } from './links';
import { getKeptAccounts } from './kept-accounts';
import { rememberedAccountsReport } from './last-known';
import { readGoalRecords, wireGoal } from './goal-plans';
import { weeklySettingStore } from './weekly-summary/store';
import { dayIn } from './report/period';
import { StoredDataUnreadableError } from './repo';
import { StateUnreadableError } from './transactions';
import {
  pctOf,
  sharedKinds,
  SPENDING_MONTHS,
  VIEW_KINDS,
  viewsReadOf,
  type BudgetGroup,
  type BudgetLine,
  type BudgetsMonth,
  type BudgetsShare,
  type BudgetsView,
  type GoalLine,
  type GoalsShare,
  type GoalsView,
  type HoldingsLine,
  type HoldingsShare,
  type HoldingsView,
  type NetWorthShare,
  type NetWorthView,
  type ShareViews,
  type SharedViews,
  type SpendingGroup,
  type SpendingLine,
  type SpendingMonth,
  type SpendingShare,
  type SpendingView,
  type Unreadable,
  type ViewKind,
  type ViewsRead,
} from './share-kinds';
import type { FactGoal } from './share-inference';

const UNREADABLE: Unreadable = { unreadable: true };

/** Whether an error says the owner's stored data can't be used (damaged, or
 *  in a form this release doesn't know), as opposed to storage, or another
 *  service, being out of reach for a moment: lib/sharing.ts's rule. */
export function dataUnreadable(err: unknown): boolean {
  return err instanceof StoredDataUnreadableError || (err instanceof StateUnreadableError && err.kind === 'decode');
}

/** Whether an account counts in net worth now, as the read-only API counts
 *  it: not once it has ended. */
const countsNow = (a: ApiAccount) => a.lifecycle === null || a.lifecycle.date > lastEndDay();

/** An account as its own share labels it (lib/sharing.ts shareableAccounts):
 *  the institution, its name, and the last digits its bank gives. */
const labelOf = (a: ApiAccount) => `${a.institution} ${a.name}${a.mask ? ` ••${a.mask}` : ''}`;

/** A percentage in words (lib/share-kinds.ts): the Plan tab's rule, from the
 *  amount, which is known here at every level. */
const labelFor = (amount: number, pct: number | null, whole: number): string | null => (pct === null ? null : shareLabel(amount, pct, whole));

/** What more than one kind reads of the owner's, read once for all of them
 *  in a projection (projectViews): the accounts, as the read-only API lists
 *  them. */
type Reads = { accounts: () => Promise<ApiAccounts> };

/** The owner's own day, YYYY-MM-DD (see THE OWNER'S MONTH). LENIENT, for
 *  this display only, which nothing writes or records on: a setting that
 *  can't be read, or a zone this runtime doesn't know, leaves the UTC day. */
async function ownerToday(theirs: Ctx, now: number): Promise<string> {
  const setting = await weeklySettingStore.get(theirs).catch(() => null);
  return (setting ? dayIn(now, setting.time_zone) : null) ?? new Date(now).toISOString().slice(0, 10);
}

// ---- Net worth ----

async function netWorthView(theirs: Ctx, s: NetWorthShare, reads: Reads, balancesShown: PromiseLike<ReadonlySet<string>> | ReadonlySet<string>): Promise<NetWorthView | Unreadable> {
  const read =
    s.detail === 'history'
      ? readNetWorthAndHistory(theirs, { includeEstimated: true, interval: 'week' }, { base: true })
      : readNetWorth(theirs, { base: true }).then((now) => ({ now, history: null }));
  const [{ now, history }, listed] = await Promise.all([read, s.accounts ? reads.accounts() : Promise.resolve(null)]);
  // An account that couldn't be read, or hasn't been loaded, would leave the
  // total short: none is shown rather than a short one.
  if (now.missing_accounts.length > 0 || (listed !== null && listed.missing_accounts.length > 0)) return UNREADABLE;
  const [main, ...others] = now.totals;
  // In the owner's home currency once they chose one, as their own net worth
  // is: unless nothing can be converted into it (it has no rate itself).
  const base = now.base && now.base_currency && !now.base.left_out.some((l) => l.why === 'base_has_no_rate') ? now.base : null;
  const view: NetWorthView = base
    ? {
        detail: s.detail,
        currency: now.base_currency!,
        total: now.totals.length > 0 ? base.net_worth : null,
        as_of: now.balances_to,
        from: now.balances_from,
        other_currencies: base.left_out.map((l) => ({ currency: l.currency, accounts: l.accounts })),
        without_balance: now.accounts_without_balance,
        converted: { own_rates: base.own_rates.length > 0 },
      }
    : {
        detail: s.detail,
        currency: main?.currency ?? null,
        total: main ? main.net_worth : null,
        as_of: now.balances_to,
        from: now.balances_from,
        other_currencies: others.map((t) => ({ currency: t.currency ?? '', accounts: t.accounts })),
        without_balance: now.accounts_without_balance,
      };
  if (history) {
    // Converted, each point at its own day's rate; a point that can't be is
    // not drawn, as the owner's chart leaves it out.
    view.history = base
      ? history.points.flatMap((p) => (p.to_base === null ? [] : [{ date: p.date, value: p.to_base, ...(p.estimated ? { estimated: true as const } : {}) }]))
      : history.points.map((p) => ({ date: p.date, value: p.value, ...(p.estimated ? { estimated: true as const } : {}) }));
    if (!base && history.mixed_currencies) view.history_mixed = true;
  }
  if (listed) {
    // The accounts counted now whose balances the share of accounts shows
    // (`balancesShown`), each with its newest measured balance: never one it
    // doesn't, so a net worth with its accounts shows no balance the account
    // rows above it don't. Those without one count in no total, and are said
    // by without_balance.
    const shown = await balancesShown;
    view.accounts = listed.accounts
      .filter((a) => countsNow(a) && a.balance !== null && shown.has(a.id))
      .map((a) => ({ label: labelOf(a), balance: a.balance!, currency: a.currency, debt: a.is_debt, as_of: a.as_of }));
  }
  return view;
}

// ---- Transactions, for spending and budgets ----

/**
 * Whether the stored transactions a total would be built on couldn't all be
 * read (see WHAT CAN'T BE READ): a manual account's book, or a bank's stored
 * transactions (`missing` though it was synced), or, when `unread` is known
 * (the notes saying transactions couldn't all be read or aren't all in), one
 * more of those than the banks not all in account for: rows imported from
 * files into a linked account that can't be shown.
 */
function transactionsDamaged(sources: readonly BankSource[], manualUnread: readonly string[] | 'all', unread?: number): boolean {
  if (manualUnread === 'all' || manualUnread.length > 0) return true;
  if (sources.some((s) => s.coverage === 'missing' && !s.never_synced)) return true;
  // Each bank whose rows aren't all in has one note; any note past those is
  // something else that couldn't be read.
  return unread !== undefined && unread > sources.filter((s) => s.coverage !== 'complete').length;
}

/** Whether some of how the owner files rows couldn't be read
 *  (lib/share-kinds.ts FilingUnread): the categories they chose, their
 *  merchants' defaults, or approvals of the rows read, as the read layer
 *  reports each. */
function filingUnread(ownCategoriesRead: boolean, defaultsUnread: boolean, approvalsUnknown: number): boolean {
  return !ownCategoriesRead || defaultsUnread || approvalsUnknown > 0;
}

function addMonths(month: string, n: number): string {
  const [y, m] = month.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + n, 1));
  return d.toISOString().slice(0, 7);
}

/** What another currency left out, by its currency alone, never how many:
 *  "What went out in EUR isn’t in these totals, which are in USD." In the
 *  currencies' own order, so neither says which had more. Null when nothing
 *  was. */
function leftOutWords(leftOut: LeftOut, currency: string | null, what: string, where: string, converted = false): string | null {
  if (leftOut.length === 0) return null;
  const names = leftOut.map((l) => l.currency).sort();
  const list = names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
  // Converted: what is left out has no rate to convert it at.
  return `${what} in ${list} isn’t in ${where}${currency ? `, which are in ${currency}` : ''}${converted ? ': there is no rate for it' : ''}.`;
}

/** A category's and its group's names, as the owner's own screens show them. */
function describer(ix: CategoryIndex): (bucket: string) => { category: string; category_id: string | null; group_id: string | null; group: string | null } {
  return (bucket) => {
    const c = categoryById(ix, bucket);
    if (!c) return { category: displayName(bucket), category_id: null, group_id: null, group: null };
    const g = groupOf(ix, c);
    return { category: displayName(c.name), category_id: c.id, group_id: g.id, group: displayName(g.name) };
  };
}

/** Lines most first, then by name. */
const byAmount = <T extends { name: string; amount: number }>(a: T, b: T) => b.amount - a.amount || a.name.localeCompare(b.name);

/** One month's spending by group, and by category within each, as built:
 *  amounts first, cut to percentages or not afterwards. */
function spendingMonth(categories: readonly SummaryCategory[], total: number, s: SpendingShare): SpendingGroup[] {
  const groups = new Map<string, { name: string; amount: number; categories: { name: string; amount: number }[] }>();
  for (const c of categories) {
    // A category no group holds (a row filed before categories had them) is
    // said as what it is, never put in a group it isn't in.
    const key = c.group_id ?? `none:${c.category}`;
    const g = groups.get(key) ?? { name: c.group ?? c.category, amount: 0, categories: [] };
    g.amount += c.spent;
    g.categories.push({ name: c.category, amount: c.spent });
    groups.set(key, g);
  }
  const line = (name: string, amount: number): SpendingLine => {
    const pct = pctOf(amount, total);
    return { name, pct, label: labelFor(amount, pct, total), ...(s.detail === 'amounts' ? { amount: tidy(amount) } : {}) };
  };
  return [...groups.values()].sort(byAmount).map((g) => ({
    ...line(g.name, g.amount),
    ...(s.by === 'category' ? { categories: g.categories.sort(byAmount).map((c) => line(c.name, c.amount)) } : {}),
  }));
}

async function spendingView(theirs: Ctx, s: SpendingShare, today: string): Promise<SpendingView | Unreadable> {
  const bank = await assembleBankRows(theirs, { sync: false, readOnly: true });
  const finished = await finishActivity(theirs, bank.payload, bank.hidden);
  if (transactionsDamaged(bank.sources, finished.manual_unread, finished.unread_notes.length)) return UNREADABLE;
  // As the Activity tab counts them: in the one currency most rows are in,
  // or, once the owner chose a home currency, converted into it.
  const counting = totalsIn(finished.transactions, await readFlowFx(theirs, finished.transactions));
  const rows = counting.rows;
  const currency = counting.currency;
  const describe = describer(indexTaxonomy(finished.taxonomy));
  const thisMonth = today.slice(0, 7);
  // No month before the first with any transaction: before it, nothing is
  // known, which is not the same as nothing spent.
  const first = rows.reduce<string | null>((m, t) => (m === null || t.date.slice(0, 7) < m ? t.date.slice(0, 7) : m), null);
  const months: SpendingMonth[] = [];
  for (let i = 0; i < SPENDING_MONTHS; i++) {
    const month = addMonths(thisMonth, -i);
    if (first === null || month < first) break;
    const inMonth = (d: string) => d.slice(0, 7) === month;
    const sum = summarize(rows, inMonth, currency, describe);
    // What another currency left out of money out, as the budgets count it:
    // never money in, which this never shows, nor how many.
    const leftOut = leftOutByCurrency(rows.filter((t) => t.amount > 0 && inMonth(t.date)), currency);
    months.push({
      month,
      so_far: month === thisMonth,
      ...(s.detail === 'amounts' ? { total: sum.money_out } : {}),
      groups: spendingMonth(sum.categories, sum.money_out, s),
      left_out: leftOutWords(leftOut, currency, 'What went out', 'these totals', !!counting.conversion),
      // Counted although whether they were excluded couldn't be read, as the
      // Activity tab counts them; said, never how many.
      ...(sum.exclusion_unknown > 0 ? { exclusions_unknown: true as const } : {}),
    });
  }
  const incomplete = finished.incomplete.length > 0 || bank.sources.some((x) => x.coverage !== 'complete') || (await spendingShort(theirs, noTransactionsView(bank.payload), months, today));
  return {
    detail: s.detail,
    by: s.by,
    currency,
    ...(counting.conversion ? { converted: { own_rates: counting.conversion.own.length > 0 } } : {}),
    months,
    ...(incomplete ? { may_be_incomplete: true as const } : {}),
    ...(bank.own_read.exclusions ? {} : { exclusions_unread: true as const }),
    ...(filingUnread(bank.own_read.categories, finished.defaults_unread, finished.review.unknown) ? { filing_unread: true as const } : {}),
  };
}

/** Whether a bank account or card's spending doesn't come in for the months
 *  shown (lib/no-transactions.ts spendingUnknown): not one whose connection's
 *  files cover them, from the first through today, for every one of its bank
 *  accounts and cards, as the owner's Activity tab counts them
 *  (lib/history-import/without-files.ts, lenient: what can't be read covers
 *  nothing). */
async function spendingShort(theirs: Ctx, view: NoTransactionsView, months: readonly SpendingMonth[], today: string): Promise<boolean> {
  if (!spendingUnknown(view)) return false;
  const oldest = months.length > 0 ? months[months.length - 1].month : today.slice(0, 7);
  return spendingUnknown(coveredOutOfDays({ ...view, without: await withImportedFiles(theirs, view.without) }, `${oldest}-01`, today));
}

// ---- Budgets ----

/** A budget's line: spent against what is available. Nothing available (an
 *  overspent carry as deep as the budget) has no percentage; any spending
 *  then is over. */
function budgetLine(name: string, spent: number, limit: number, s: BudgetsShare): BudgetLine {
  const pct = pctOf(spent, limit);
  return {
    name,
    pct,
    label: labelFor(spent, pct, limit),
    over: limit > 0 ? spent > limit : spent > 0,
    ...(s.detail === 'amounts' ? { spent, limit } : {}),
  };
}

async function budgetsView(theirs: Ctx, s: BudgetsShare, today: string): Promise<BudgetsView | Unreadable> {
  const thisMonth = today.slice(0, 7);
  // Both months from one read of the transactions, as the Budgets tab reads
  // a month, the income pool left unread: it is never shown, and its setting
  // changes no budget's carry.
  const reads = await readBudgetMonths(theirs, { months: [thisMonth, addMonths(thisMonth, -1)], today: thisMonth, pool: false });
  const { activity } = reads[0];
  // The notes too, as spending's: rows imported from files that can't be
  // read leave a month short.
  if (transactionsDamaged(activity.bank.sources, activity.manual_unread, activity.unread_notes.length)) return UNREADABLE;
  const months: BudgetsMonth[] = reads.map((read) => {
    const answer = budgetsAnswer(read, { month: read.month });
    // A group by its id, or by its name (no two groups share one) where the
    // answer gives none: one the owner's app hasn't stored yet.
    const groupKey = (id: string | null, name: string | null) => id ?? `name:${name ?? ''}`;
    const categoriesOf = new Map<string, BudgetLine[]>();
    for (const b of answer.budgets) {
      const key = groupKey(b.group_id, b.group);
      categoriesOf.set(key, [...(categoriesOf.get(key) ?? []), budgetLine(displayName(b.category), b.spent, b.available, s)]);
    }
    const groups: BudgetGroup[] = answer.groups.map((g) => ({
      ...budgetLine(displayName(g.name), g.spent, g.available, s),
      ...(s.by === 'category' ? { categories: categoriesOf.get(groupKey(g.id, g.name)) ?? [] } : {}),
    }));
    const carriesUncertain = [...answer.budgets, ...answer.groups].some((b) => (b.rollover?.uncertain_months.length ?? 0) > 0);
    return {
      month: read.month,
      total: budgetLine('All budgets', answer.total.spent, answer.total.available, s),
      groups,
      left_out: leftOutWords(answer.left_out, read.currency, 'What was spent', 'these budgets', !!read.conversion),
      may_be_incomplete:
        answer.incomplete_months.some((m) => m.month === read.month) || (read.earliest !== null && read.month < read.earliest) || carriesUncertain,
    };
  });
  const filing = filingUnread(activity.bank.own_read.categories, activity.review_unread.defaults, activity.review_unread.approvals);
  // Spending in other currencies counted converted into the budgets' own, in
  // the months shown.
  const conv = reads.map((r) => conversionIn(r.monthRows, r.conversion)).filter((c) => c !== null && c.from.length > 0);
  return {
    detail: s.detail,
    by: s.by,
    currency: reads[0].currency,
    ...(conv.length > 0 ? { converted: { own_rates: conv.some((c) => c!.own.length > 0) } } : {}),
    months,
    ...(filing ? { filing_unread: true as const } : {}),
  };
}

// ---- Holdings ----

async function holdingsView(theirs: Ctx, s: HoldingsShare, reads: Reads): Promise<HoldingsView | Unreadable> {
  const [listed, held, settings] = await Promise.all([reads.accounts(), readHoldings(theirs), allocationSettingsStore.get(theirs)]);
  // An account that couldn't be read could be an investment one: no
  // allocation is shown rather than one short of it.
  if (listed.missing_accounts.length > 0 || !held.complete) return UNREADABLE;
  const counted = listed.accounts.filter((a) => isInvestmentType(a.type) && countsNow(a));
  // As the dashboard has them (lib/fire/inputs.ts AssetInstitution): by
  // institution, a linked one's apart from those kept by hand or by SimpleFIN,
  // which list no positions. Nothing failed: these are what was stored.
  const institutions = new Map<string, AllocInstitution>();
  for (const a of counted) {
    const linked = a.source === 'plaid';
    const key = `${linked ? 'linked' : 'kept'}:${a.institution}`;
    const inst = institutions.get(key) ?? { name: a.institution, item_id: linked ? key : null, error: false, staleAsOf: null, missing: 0, accounts: [] };
    inst.accounts.push({ account_id: a.id, name: a.name, type: a.type, subtype: a.subtype, balance: a.balance, currency: a.currency });
    institutions.set(key, inst);
  }
  const countedIds = new Set(counted.map((a) => a.id));
  const holdings: AllocHolding[] = held.accounts
    .filter((h) => countedIds.has(h.account_id))
    .flatMap((h) =>
      h.positions.map((p) => ({ account_id: h.account_id, name: p.name, ticker: p.ticker, security_type: p.type, is_cash_equivalent: p.cash_equivalent, value: p.value, currency: p.currency }))
    );
  // In the owner's home currency once they chose one, at the newest rates,
  // as the Plan's allocation converts (inputsIn); else the main one.
  const fx = await readFlowFx(theirs, [], Date.now(), { accounts: true });
  const currency = fx?.home ?? dominantCurrency(counted.map((a) => ({ iso_currency_code: a.currency })));
  const converting = fx ? inputsIn([...institutions.values()], holdings, { home: fx.home!, latest: fx.latest, own: [...fx.own] }, currency) : null;
  const alloc = allocate({ institutions: converting?.institutions ?? [...institutions.values()], holdings: converting?.holdings ?? holdings, settings, currency });
  const amounts = s.detail === 'amounts';
  const lines = <K extends string>(totals: Record<K, number>, order: readonly K[], names: Record<K, string>): HoldingsLine[] =>
    shares(totals, order).map((x) => ({ slot: x.slot, name: names[x.slot], pct: x.pct, label: x.label, ...(amounts ? { amount: tidy(x.amount) } : {}) }));
  const notes: string[] = [];
  if (counted.length === 0) notes.push('No investment accounts to show.');
  if ((alloc.classes.unclassified ?? 0) !== 0) notes.push('Unclassified is money Nya can’t place in a class: a fund it doesn’t know, or money no position explains.');
  for (const o of alloc.otherCurrencies)
    notes.push(fx ? `What is held in ${o.currency} isn’t counted here: there is no rate for it.` : `What is held in ${o.currency} isn’t counted here: their totals don’t convert currencies.`);
  if (alloc.unpriced > 0) notes.push(`${alloc.unpriced === 1 ? 'A position' : `${alloc.unpriced} positions`} with no value ${alloc.unpriced === 1 ? 'isn’t' : 'aren’t'} counted.`);
  // As net worth says an account with no balance yet: never counted as nothing.
  if (alloc.noBalance > 0) {
    const one = alloc.noBalance === 1;
    notes.push(`${one ? '1 investment account has' : `${alloc.noBalance} investment accounts have`} no balance yet and no position, so ${one ? 'it isn’t' : 'they aren’t'} counted.`);
  }
  // The days the figures are from, newest and oldest: the positions last
  // recorded, and the balances. Positions from long before a balance are
  // said by their day.
  const days = [...held.accounts.filter((h) => countedIds.has(h.account_id)).map((h) => h.as_of), ...counted.map((a) => a.as_of)].filter((d): d is string => !!d).sort();
  return {
    detail: s.detail,
    currency,
    ...(converting?.converted ? { converted: { own_rates: converting.converted.own.length > 0 } } : {}),
    as_of: days[days.length - 1] ?? null,
    from: days[0] ?? null,
    ...(amounts ? { total: tidy(alloc.total) } : {}),
    classes: lines(alloc.classes as Record<Slot, number>, SLOTS, CLASS_NAMES),
    buckets: lines(alloc.buckets, BUCKET_SLOTS, BUCKET_NAMES),
    ...(s.positions
      ? {
          positions: alloc.securities
            .filter((r) => isMoney(r.amount))
            .map((r) => {
              const split = r.classified.split;
              const classes = split ? ASSET_CLASSES.filter((c) => (split[c] ?? 0) > 0) : [];
              const pct = pctOf(r.amount, alloc.total);
              return {
                ticker: r.ticker,
                name: r.name,
                class: classes.length === 1 ? CLASS_NAMES[classes[0]] : classes.length > 1 ? 'Mixed' : CLASS_NAMES.unclassified,
                pct,
                label: labelFor(r.amount, pct, alloc.total),
                ...(amounts ? { amount: tidy(r.amount) } : {}),
              };
            }),
        }
      : {}),
    notes,
  };
}

// ---- Goals ----

/** A goal as it is shared: progress and when it will be reached, never the
 *  rate behind it, nor what each month needs or is short by. */
function goalLine(g: ApiGoal, s: GoalsShare): GoalLine {
  const tracked = g.state === 'tracked' && g.saved !== null;
  const p = g.projection;
  const pct = tracked ? pctOf(g.saved!, g.target) : null;
  return {
    name: g.name,
    state: g.state as GoalLine['state'],
    pct,
    // Nothing saved reads 0%, a little <1%: from the amount, at every level.
    label: tracked ? labelFor(g.saved!, pct, g.target) : null,
    currency: g.currency,
    ...(s.detail === 'amounts' ? { target: g.target, ...(tracked ? { saved: g.saved! } : {}) } : {}),
    target_date: g.target_date,
    outlook:
      tracked && p
        ? {
            status: p.status,
            completion: p.completion_month,
            beyond: (p.status === 'on_track' || p.status === 'behind') && p.completion_month === null,
            date_passed: p.target_date_passed,
          }
        : null,
    as_of: tracked ? g.saved_as_of : null,
    ...(g.state === 'ended' && g.account_lifecycle ? { ended_on: g.account_lifecycle.date } : {}),
  };
}

/** The goals as shared, and, never sent to the one they are shared with,
 *  what the preview's warnings go by of each and which were shown (their ids,
 *  for the record of showings); null when none of those chosen is shown, so
 *  the share says nothing of goals, as one whose accounts are all hidden says
 *  nothing of accounts. */
async function goalsView(theirs: Ctx, s: GoalsShare): Promise<{ view: GoalsView; facts: FactGoal[]; shown: string[] } | null> {
  const read = await readGoals(theirs);
  const chosen = new Set(s.goals);
  // A goal deleted since is gone; an archived one counts nothing and is left
  // out; one on a hidden account is left out while it is hidden.
  const goals = read.goals.filter((g) => chosen.has(g.id) && !g.archived && g.state !== 'hidden');
  if (goals.length === 0) return null;
  const lines = goals.map((g) => goalLine(g, s));
  return {
    view: { detail: s.detail, goals: lines },
    facts: goals.map((g, i) => ({ name: g.name, projected: lines[i].outlook?.completion != null, account_id: g.account_id })),
    shown: goals.map((g) => g.id),
  };
}

// ---- All of them ----

/** What a share's kinds show (SharedViews), in the order kinds are listed;
 *  for the preview's warnings only, the goals behind them; and for the record
 *  of showings, what was shown of each (`read`: each kind that could be read,
 *  as its setting chose it, and the goals shown). */
export type ProjectedViews = { views: SharedViews; goalFacts: FactGoal[]; read: ViewsRead };

/**
 * Each kind `views` shares, projected from the owner's data (see the
 * header), all at once. `balancesShown` is the accounts whose balances the
 * share of accounts shows (lib/sharing.ts, as it is read beside these),
 * which alone a net worth with its accounts lists.
 * Undefined when it shares none, or none shows anything (goals whose every
 * one chosen is archived, gone or on a hidden account). A kind whose data
 * can't be read is Unreadable, and the rest are shown; anything else
 * (storage out of reach) throws.
 */
export async function projectViews(
  theirs: Ctx,
  views: ShareViews,
  now: number,
  opts: { balancesShown?: PromiseLike<ReadonlySet<string>> | ReadonlySet<string> } = {}
): Promise<ProjectedViews | undefined> {
  const kinds = sharedKinds(views);
  if (kinds.length === 0) return undefined;
  const out: SharedViews = {};
  let goalFacts: FactGoal[] = [];
  let goalsShown: string[] = [];
  // Read once for the kinds that both need them: the accounts, for a net
  // worth with its accounts and for holdings.
  let accounts: Promise<ApiAccounts> | null = null;
  const reads: Reads = { accounts: () => (accounts ??= readAccounts(theirs)) };
  const today = views.spending || views.budgets ? await ownerToday(theirs, now) : '';
  const read = async (kind: ViewKind): Promise<void> => {
    try {
      switch (kind) {
        case 'net_worth':
          out.net_worth = await netWorthView(theirs, views.net_worth!, reads, opts.balancesShown ?? new Set());
          break;
        case 'spending':
          out.spending = await spendingView(theirs, views.spending!, today);
          break;
        case 'holdings':
          out.holdings = await holdingsView(theirs, views.holdings!, reads);
          break;
        case 'budgets':
          out.budgets = await budgetsView(theirs, views.budgets!, today);
          break;
        case 'goals': {
          const goals = await goalsView(theirs, views.goals!);
          if (goals) {
            out.goals = goals.view;
            goalFacts = goals.facts;
            goalsShown = goals.shown;
          }
          break;
        }
      }
    } catch (err) {
      if (!dataUnreadable(err)) throw err;
      console.error(`Shared data: a ${kind} share could not be read`, err instanceof Error ? err.name : err);
      out[kind] = UNREADABLE;
    }
  };
  await Promise.all(kinds.map(read));
  const ordered: SharedViews = {};
  for (const kind of VIEW_KINDS) if (out[kind]) (ordered as Record<string, unknown>)[kind] = out[kind];
  if (Object.keys(ordered).length === 0) return undefined;
  return { views: ordered, goalFacts, read: viewsReadOf(ordered, views, goalsShown) };
}

// ---- For the owner's own settings ----

/** A goal the owner can choose to share, for the Sharing drawer: its id and
 *  name, and the account it counts (for the drawer's warnings). Archived ones
 *  aren't offered. */
export type ShareableGoal = { id: string; name: string; account_id: string | null };

/** The goals the owner could share. Strict: one that can't be read throws
 *  StoredDataUnreadableError, which the drawer says, never "no goals". */
export async function shareableGoals(ctx: Ctx): Promise<ShareableGoal[]> {
  const { records, links } = await readGoalRecords(ctx, { readOnly: true });
  return records
    .map((r) => wireGoal(r, links))
    .filter((g) => !g.plan?.archived)
    .map((g) => ({ id: g.id, name: g.name, account_id: g.account_id }));
}

/** Of these accounts, the investment ones, for the warnings about holdings
 *  shared as percentages: a kept account's own type, a linked one's as its
 *  last good load remembered it, else as the account directory has it.
 *  LENIENT, for those warnings only, which nothing writes, deletes or records
 *  on: a remembered record that can't be read, or records that can't be read
 *  at all just now (the report throws for a key that can't be had), leave
 *  their accounts to the directory. */
export async function investmentAccountIds(ctx: Ctx, ids: readonly string[]): Promise<Set<string>> {
  const [types, kept, remembered] = await Promise.all([
    directoryTypes(ctx, [...ids]),
    getKeptAccounts(ctx),
    rememberedAccountsReport(ctx).catch(() => ({ byItem: {} as Awaited<ReturnType<typeof rememberedAccountsReport>>['byItem'] })),
  ]);
  const typeOf = new Map<string, string>();
  for (const accounts of Object.values(remembered.byItem)) for (const a of accounts) typeOf.set(a.account_id, a.type);
  for (const k of kept) typeOf.set(k.account_id, k.type);
  return new Set(ids.filter((id) => isInvestmentType(typeOf.get(id) ?? types[id] ?? '')));
}
