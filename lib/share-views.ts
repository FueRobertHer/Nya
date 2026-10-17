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
//     their end day, one point a week; readAccounts for the accounts behind it.
//   - spending: the Activity tab's own assembly (lib/activity.ts
//     assembleBankRows and finishActivity, never syncing) and its totals
//     (lib/totals.ts summarize, by the spending rule of lib/spending.ts): one
//     currency, what was left out for another named, transfers and what the
//     owner excluded left out, money out only, by category and its group.
//   - holdings: the allocation the Plan tab draws (lib/allocation/allocation.ts
//     allocate), over the investment accounts' newest measured balances and
//     the positions last recorded (readAccounts, readHoldings), with the
//     owner's own buckets and splits (lib/allocation-settings.ts).
//   - budgets: the Budgets tab's read of a month (lib/budget-month.ts
//     readBudgetMonth) and the read-only API's answer from it
//     (lib/api-read.ts budgetsAnswer): spent against what is available, with
//     what rolled over, this month and last.
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
// HIDDEN AND ENDED ACCOUNTS as the owner's own screens treat them: a hidden
// account is in none of it, nor a goal on one (left out while it is hidden,
// as a hidden account's own share is paused); an ended one counts from its
// end day in nothing, as everywhere in the app, and a goal on one says so.
//
// WHAT CAN'T BE READ. A kind whose owner's data can't be read says so
// (Unreadable), never a short figure as if whole: a store the seam can't use
// (budgets, goals, allocation settings, an account's end, holdings history),
// a bank's stored transactions or a manual account's book that can't be
// read, an account net worth or holdings would count that couldn't be read or
// hasn't been loaded. Each kind on its own: one that can't be read leaves the
// others shown. What only isn't all in yet (a bank still bringing in its
// older history, one not synced yet) is shown, and says it may be
// incomplete, as the owner's own Budgets tab says it. Storage out of reach
// says nothing of the data, and throws (lib/sharing.ts then shows nothing of
// the share, as for its accounts).

import type { Ctx } from './containers';
import { readAccounts, readHoldings, readNetWorthAndHistory, budgetsAnswer, type ApiAccount } from './api-read';
import { readGoals, type ApiGoal } from './api-goals';
import { assembleBankRows, finishActivity, type BankSource } from './activity';
import { readBudgetMonth } from './budget-month';
import { summarize, tidy, type SummaryCategory } from './totals';
import { totalsCurrency } from './spending';
import { categoryById, displayName, groupOf, indexTaxonomy, type CategoryIndex } from './categories';
import { allocate, shares, type AllocHolding, type AllocInstitution } from './allocation/allocation';
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
import { StoredDataUnreadableError } from './repo';
import { StateUnreadableError } from './transactions';
import {
  pctOf,
  sharedKinds,
  SPENDING_MONTHS,
  VIEW_KINDS,
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

// ---- Net worth ----

async function netWorthView(theirs: Ctx, s: NetWorthShare): Promise<NetWorthView | Unreadable> {
  const [{ now, history }, listed] = await Promise.all([
    readNetWorthAndHistory(theirs, { includeEstimated: true, interval: 'week' }),
    s.accounts ? readAccounts(theirs) : Promise.resolve(null),
  ]);
  // An account that couldn't be read, or hasn't been loaded, would leave the
  // total short: none is shown rather than a short one.
  if (now.missing_accounts.length > 0 || (listed !== null && listed.missing_accounts.length > 0)) return UNREADABLE;
  const [main, ...others] = now.totals;
  const view: NetWorthView = {
    detail: s.detail,
    currency: main?.currency ?? null,
    total: main ? main.net_worth : null,
    as_of: now.balances_to,
    from: now.balances_from,
    other_currencies: others.map((t) => ({ currency: t.currency ?? '', accounts: t.accounts })),
    without_balance: now.accounts_without_balance,
  };
  if (s.detail === 'history') {
    view.history = history.points.map((p) => ({ date: p.date, value: p.value, ...(p.estimated ? { estimated: true as const } : {}) }));
    if (history.mixed_currencies) view.history_mixed = true;
  }
  if (listed) {
    // The accounts counted now, each with its newest measured balance: those
    // without one count in no total, and are said by without_balance.
    view.accounts = listed.accounts
      .filter((a) => countsNow(a) && a.balance !== null)
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

/** YYYY-MM, by the UTC day, as transactions' dates are kept. */
const monthOf = (ms: number) => new Date(ms).toISOString().slice(0, 7);
function addMonths(month: string, n: number): string {
  const [y, m] = month.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + n, 1));
  return d.toISOString().slice(0, 7);
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
  const line = (name: string, amount: number): SpendingLine => ({ name, pct: pctOf(amount, total), ...(s.detail === 'amounts' ? { amount: tidy(amount) } : {}) });
  return [...groups.values()].sort(byAmount).map((g) => ({
    ...line(g.name, g.amount),
    ...(s.by === 'category' ? { categories: g.categories.sort(byAmount).map((c) => line(c.name, c.amount)) } : {}),
  }));
}

async function spendingView(theirs: Ctx, s: SpendingShare, now: number): Promise<SpendingView | Unreadable> {
  const bank = await assembleBankRows(theirs, { sync: false, readOnly: true });
  const finished = await finishActivity(theirs, bank.payload, bank.hidden);
  if (transactionsDamaged(bank.sources, finished.manual_unread, finished.unread_notes.length)) return UNREADABLE;
  const rows = finished.transactions;
  // The currency the Activity tab's totals are in: the one most rows are in.
  const currency = totalsCurrency(rows);
  const describe = describer(indexTaxonomy(finished.taxonomy));
  const thisMonth = monthOf(now);
  // No month before the first with any transaction: before it, nothing is
  // known, which is not the same as nothing spent.
  const first = rows.reduce<string | null>((m, t) => (m === null || t.date.slice(0, 7) < m ? t.date.slice(0, 7) : m), null);
  const months: SpendingMonth[] = [];
  for (let i = 0; i < SPENDING_MONTHS; i++) {
    const month = addMonths(thisMonth, -i);
    if (first === null || month < first) break;
    const sum = summarize(rows, (d) => d.slice(0, 7) === month, currency, describe);
    months.push({
      month,
      so_far: month === thisMonth,
      ...(s.detail === 'amounts' ? { total: sum.money_out } : {}),
      groups: spendingMonth(sum.categories, sum.money_out, s),
      left_out: sum.left_out_text,
    });
  }
  return {
    detail: s.detail,
    by: s.by,
    currency,
    months,
    ...(finished.incomplete.length > 0 || bank.sources.some((x) => x.coverage !== 'complete') ? { may_be_incomplete: true as const } : {}),
  };
}

// ---- Budgets ----

/** A budget's line: spent against what is available. Nothing available (an
 *  overspent carry as deep as the budget) has no percentage; any spending
 *  then is over. */
function budgetLine(name: string, spent: number, limit: number, s: BudgetsShare): BudgetLine {
  return {
    name,
    pct: pctOf(spent, limit),
    over: limit > 0 ? spent > limit : spent > 0,
    ...(s.detail === 'amounts' ? { spent, limit } : {}),
  };
}

async function budgetsView(theirs: Ctx, s: BudgetsShare, now: number): Promise<BudgetsView | Unreadable> {
  // Months as the read-only API takes them: by the UTC day.
  const today = monthOf(now);
  const reads = await Promise.all([today, addMonths(today, -1)].map((month) => readBudgetMonth(theirs, { month, today })));
  if (reads.some((r) => transactionsDamaged(r.activity.bank.sources, r.activity.manual_unread))) return UNREADABLE;
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
      left_out: answer.left_out_text,
      may_be_incomplete:
        answer.incomplete_months.some((m) => m.month === read.month) || (read.earliest !== null && read.month < read.earliest) || carriesUncertain,
    };
  });
  return { detail: s.detail, by: s.by, currency: reads[0].currency, months };
}

// ---- Holdings ----

async function holdingsView(theirs: Ctx, s: HoldingsShare): Promise<HoldingsView | Unreadable> {
  const [listed, held, settings] = await Promise.all([readAccounts(theirs), readHoldings(theirs), allocationSettingsStore.get(theirs)]);
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
  const currency = dominantCurrency(counted.map((a) => ({ iso_currency_code: a.currency })));
  const alloc = allocate({ institutions: [...institutions.values()], holdings, settings, currency });
  const amounts = s.detail === 'amounts';
  const lines = <K extends string>(totals: Record<K, number>, order: readonly K[], names: Record<K, string>): HoldingsLine[] =>
    shares(totals, order).map((x) => ({ slot: x.slot, name: names[x.slot], pct: x.pct, ...(amounts ? { amount: tidy(x.amount) } : {}) }));
  const notes: string[] = [];
  if (counted.length === 0) notes.push('No investment accounts to show.');
  if ((alloc.classes.unclassified ?? 0) !== 0) notes.push('Unclassified is money Nya can’t place in a class: a fund it doesn’t know, or money no position explains.');
  for (const o of alloc.otherCurrencies) notes.push(`What is held in ${o.currency} isn’t counted here: nothing is converted.`);
  if (alloc.unpriced > 0) notes.push(`${alloc.unpriced === 1 ? 'A position' : `${alloc.unpriced} positions`} with no value ${alloc.unpriced === 1 ? 'isn’t' : 'aren’t'} counted.`);
  // The days the figures are from: the positions last recorded, and the balances.
  const days = [...held.accounts.filter((h) => countedIds.has(h.account_id)).map((h) => h.as_of), ...counted.map((a) => a.as_of)].filter((d): d is string => !!d).sort();
  return {
    detail: s.detail,
    currency,
    as_of: days[days.length - 1] ?? null,
    ...(amounts ? { total: tidy(alloc.total) } : {}),
    classes: lines(alloc.classes as Record<Slot, number>, SLOTS, CLASS_NAMES),
    buckets: lines(alloc.buckets, BUCKET_SLOTS, BUCKET_NAMES),
    ...(s.positions
      ? {
          positions: alloc.securities
            .filter((r) => Math.abs(r.amount) >= 0.005)
            .map((r) => {
              const split = r.classified.split;
              const classes = split ? ASSET_CLASSES.filter((c) => (split[c] ?? 0) > 0) : [];
              return {
                ticker: r.ticker,
                name: r.name,
                class: classes.length === 1 ? CLASS_NAMES[classes[0]] : classes.length > 1 ? 'Mixed' : CLASS_NAMES.unclassified,
                pct: pctOf(r.amount, alloc.total),
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
  return {
    name: g.name,
    state: g.state as GoalLine['state'],
    pct: tracked ? pctOf(g.saved!, g.target) : null,
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

/** The goals as shared, and what the preview's warnings go by of each
 *  (never sent to the one they are shared with); null when none of those
 *  chosen is shown, so the share says nothing of goals, as one whose
 *  accounts are all hidden says nothing of accounts. */
async function goalsView(theirs: Ctx, s: GoalsShare): Promise<{ view: GoalsView; facts: FactGoal[] } | null> {
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
  };
}

// ---- All of them ----

/** What a share's kinds show (SharedViews), in the order kinds are listed,
 *  and, for the preview's warnings only, the goals behind them. */
export type ProjectedViews = { views: SharedViews; goalFacts: FactGoal[] };

/**
 * Each kind `views` shares, projected from the owner's data (see the
 * header), all at once. Undefined when it shares none, or none shows
 * anything (goals whose every one chosen is archived, gone or on a hidden
 * account). A kind whose data can't be read is Unreadable, and the rest are
 * shown; anything else (storage out of reach) throws.
 */
export async function projectViews(theirs: Ctx, views: ShareViews, now: number): Promise<ProjectedViews | undefined> {
  const kinds = sharedKinds(views);
  if (kinds.length === 0) return undefined;
  const out: SharedViews = {};
  let goalFacts: FactGoal[] = [];
  const read = async (kind: ViewKind): Promise<void> => {
    try {
      switch (kind) {
        case 'net_worth':
          out.net_worth = await netWorthView(theirs, views.net_worth!);
          break;
        case 'spending':
          out.spending = await spendingView(theirs, views.spending!, now);
          break;
        case 'holdings':
          out.holdings = await holdingsView(theirs, views.holdings!);
          break;
        case 'budgets':
          out.budgets = await budgetsView(theirs, views.budgets!, now);
          break;
        case 'goals': {
          const goals = await goalsView(theirs, views.goals!);
          if (goals) {
            out.goals = goals.view;
            goalFacts = goals.facts;
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
  return Object.keys(ordered).length > 0 ? { views: ordered, goalFacts } : undefined;
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
 *  on: a remembered record that can't be read leaves its accounts to the
 *  directory. */
export async function investmentAccountIds(ctx: Ctx, ids: readonly string[]): Promise<Set<string>> {
  const [types, kept, remembered] = await Promise.all([directoryTypes(ctx, [...ids]), getKeptAccounts(ctx), rememberedAccountsReport(ctx)]);
  const typeOf = new Map<string, string>();
  for (const accounts of Object.values(remembered.byItem)) for (const a of accounts) typeOf.set(a.account_id, a.type);
  for (const k of kept) typeOf.set(k.account_id, k.type);
  return new Set(ids.filter((id) => isInvestmentType(typeOf.get(id) ?? types[id] ?? '')));
}
