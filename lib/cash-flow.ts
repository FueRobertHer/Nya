// lib/cash-flow.ts
//
// Where money came from and where it went over a period (#41): the flows the
// Activity tab's cash flow chart draws (components/CashFlowSankey.tsx, laid
// out by lib/sankey.ts), and what /api/v1/cash-flow and the MCP server's
// get_cash_flow answer (lib/api-cash-flow.ts). Pure, safe in the browser.
//
// ONE SOURCE OF TRUTH. The flows are the totals' own, by their rules
// (lib/spending.ts countsInTotals, lib/totals.ts): the rows the Activity tab
// totals (lib/activity.ts finishActivity), in one currency, with what the
// person excluded and what a rule of theirs hides left out, and transfers,
// cash withdrawals and loan payments neither money in nor money out. So the
// money in on the chart is the Activity tab's money in for the same months
// (summarize's money_in), and its spending by category is the Budgets tab's
// and the API's (spendingByCategory, by the category each row is filed under,
// lib/categories.ts filedId), to the cent. What is left out is counted, and
// said, as the totals say it (cashFlowNotes).
//
// MONEY IN, BY WHO PAID IT. Each counted inflow (a negative amount, Plaid's
// sign) goes to its payer: the name on the row (the merchant's, or the
// person's own name for it, as the list shows it), the same whatever its
// capitals. Plaid's transaction_code has no payroll value (it is one of
// adjustment, atm, bank charge, bill payment, cash, cashback, cheque, direct
// debit, interest, purchase, standing order and transfer), so pay is known by
// who paid it, and one employer is one source however its deposits are filed.
// The chart draws the largest payers and folds the rest into "Other income"
// (flowGraph). Nothing names a source the rows don't: each is a name on them,
// the fold, or the money that came from savings or debt (below).
//
// A REFUND is money in, as every total counts it (lib/totals.ts), never less
// spending in its category: a shop that refunded something is among the
// payers, marked a refund when every row of it is filed under a spending
// category the row names. Not the uncategorized one, where a deposit that
// says nothing of itself is filed (a paycheck from SimpleFIN, which brings no
// categories, say), so a payer is never called a refund on a guess.
//
// MONEY OUT, BY CATEGORY GROUP AND CATEGORY: each counted outflow under the
// category it is filed under (filedId, as the Budgets tab files it), in that
// category's group. Which rows count is the groups' kinds' to say
// (lib/spending.ts isTransfer reads a row's category_kind): a transfer group's
// rows are never money out. A row filed under a category the set doesn't know
// counts under the uncategorized one, never left out.
//
// MORE OUT THAN IN. What was spent beyond what came in came from savings or
// debt (money already in the accounts, or a card's balance growing): a node of
// its own beside the payers, never a link running back. What was left over is
// a node beside the groups.
//
// SPLIT TRANSACTIONS (#39) aren't on this branch. Once a transaction can be
// split, each part a row of its own in its own category, every part flows here
// as the totals count it; `tally` is the one place that counts a node's
// transactions, where the parts of one transaction would count once.

import { countsInTotals, uncategorizedFromConnector, uncategorizedNote, type LeftOut } from './spending';
import { summarize, tidy, type TotalsRow } from './totals';
import { categoryById, displayName, filedId, groupOf, uncategorizedOf, type CategoryIndex, type CategoryKind } from './categories';
import { addMonths, monthName, monthsFrom, monthsText } from './rollover';
import { joinNames, monthGaps, type Incomplete, type Stopped } from './month-coverage';
import { refusedNames, unallowedNames, withoutNote, NO_CONNECTIONS_WITHOUT, type NoTransactionsView } from './no-transactions';
import type { LabelSide, SankeyLinkInput } from './sankey';

/** What the flows read of a transaction: what the totals read, and its id
 *  and name. */
export type FlowRow = TotalsRow & {
  transaction_id: string;
  name: string;
  /** A rule hides it (lib/rules.ts): left out as an exclusion is, and
   *  counted apart, as the Activity tab says them. */
  excluded_by_rule?: true;
  /** Where it came from: SimpleFIN's rows come without categories. */
  source?: string | null;
};

/** One payer's counted money in. `key` is its name as compared. */
export type Payer = { key: string; name: string; amount: number; transactions: number; refund: boolean; ids: string[] };
export type FlowCategory = { id: string; name: string; amount: number; transactions: number; ids: string[] };
export type FlowGroup = { id: string; name: string; kind: CategoryKind; amount: number; transactions: number; ids: string[]; categories: FlowCategory[] };

export type CashFlow = {
  /** The one currency every amount is in (totalsCurrency over the rows the
   *  caller shows); null when no row says one. */
  currency: string | null;
  money_in: number;
  money_out: number;
  net: number;
  /** money_in less money_out when more came in, else 0. */
  left_over: number;
  /** money_out less money_in when more went out, else 0. */
  from_savings_or_debt: number;
  /** Money in by payer, most first: they add up to money_in. */
  payers: Payer[];
  /** Money out by group, most first, each with its categories, most first:
   *  they add up to money_out. */
  groups: FlowGroup[];
  /** Transactions in the period, and of them: counted; left out as
   *  transfers, cash withdrawals or loan payments; excluded (by the person or
   *  a rule's hide); of those, hidden by a rule; counted although whether the
   *  person excluded them couldn't be read. As summarize counts them. */
  transactions: number;
  counted: number;
  transfers: number;
  excluded: number;
  hidden_by_rule: number;
  exclusion_unknown: number;
  left_out: LeftOut;
  left_out_text: string | null;
};

/** Counts a node's transactions: one a row on this branch, where a row is a
 *  transaction (see SPLIT TRANSACTIONS above). */
type Tally = { add: (t: FlowRow) => void; readonly n: number };
function tally(): Tally {
  let n = 0;
  return {
    add: () => {
      n++;
    },
    get n() {
      return n;
    },
  };
}

/** A payer's name as compared: the same in any capitals and spacing. */
export const payerKey = (name: string): string => name.normalize('NFC').replace(/\s+/g, ' ').trim().toLowerCase();

const byAmount = <T extends { amount: number; name: string }>(a: T, b: T) => b.amount - a.amount || a.name.localeCompare(b.name);

/**
 * The period's flows: the rows whose date `inRange` takes, in `currency`, by
 * the totals' rules (see the header). Money in, out and the counts are
 * summarize's own; the payers and groups add up to them.
 */
export function cashFlow(rows: readonly FlowRow[], inRange: (date: string) => boolean, currency: string | null, ix: CategoryIndex): CashFlow {
  const totals = summarize(rows, inRange, currency);
  type PayerSum = { name: string; amount: number; tally: Tally; refund: boolean; ids: string[] };
  type CategorySum = { name: string; amount: number; tally: Tally; ids: string[] };
  type GroupSum = { name: string; kind: CategoryKind; amount: number; tally: Tally; ids: string[]; categories: Map<string, CategorySum> };
  const payers = new Map<string, PayerSum>();
  const groups = new Map<string, GroupSum>();
  const hidden = tally();
  const uncategorized = uncategorizedOf(ix);
  for (const t of rows) {
    if (!inRange(t.date)) continue;
    if (t.excluded === true && t.excluded_by_rule) hidden.add(t);
    if (t.amount === 0 || !countsInTotals(t, currency)) continue;
    const category = categoryById(ix, filedId(ix, t)) ?? uncategorized;
    const group = groupOf(ix, category);
    if (t.amount < 0) {
      const key = payerKey(t.name);
      const p: PayerSum = payers.get(key) ?? { name: t.name.trim(), amount: 0, tally: tally(), refund: true, ids: [] };
      p.amount += -t.amount;
      p.tally.add(t);
      p.ids.push(t.transaction_id);
      // Money back on spending: filed under a spending category the row names.
      if (group.kind !== 'expense' || category.id === uncategorized.id) p.refund = false;
      payers.set(key, p);
    } else {
      const g: GroupSum = groups.get(group.id) ?? { name: group.name, kind: group.kind, amount: 0, tally: tally(), ids: [], categories: new Map() };
      g.amount += t.amount;
      g.tally.add(t);
      g.ids.push(t.transaction_id);
      const c: CategorySum = g.categories.get(category.id) ?? { name: category.name, amount: 0, tally: tally(), ids: [] };
      c.amount += t.amount;
      c.tally.add(t);
      c.ids.push(t.transaction_id);
      g.categories.set(category.id, c);
      groups.set(group.id, g);
    }
  }
  return {
    currency,
    money_in: totals.money_in,
    money_out: totals.money_out,
    net: totals.net,
    left_over: totals.net > 0 ? totals.net : 0,
    from_savings_or_debt: totals.net < 0 ? tidy(-totals.net) : 0,
    payers: [...payers]
      .map(([key, p]) => ({ key, name: p.name, amount: tidy(p.amount), transactions: p.tally.n, refund: p.refund, ids: p.ids }))
      .sort((a, b) => byAmount(a, b) || (a.key < b.key ? -1 : 1)),
    groups: [...groups]
      .map(([id, g]) => ({
        id,
        name: g.name,
        kind: g.kind,
        amount: tidy(g.amount),
        transactions: g.tally.n,
        ids: g.ids,
        categories: [...g.categories].map(([cid, c]) => ({ id: cid, name: c.name, amount: tidy(c.amount), transactions: c.tally.n, ids: c.ids })).sort(byAmount),
      }))
      .sort(byAmount),
    transactions: totals.transactions,
    counted: totals.counted,
    transfers: totals.transfers,
    excluded: totals.excluded,
    hidden_by_rule: hidden.n,
    exclusion_unknown: totals.exclusion_unknown,
    left_out: totals.left_out,
    left_out_text: totals.left_out_text,
  };
}

// ---- The chart's nodes and links ----

export type FlowNodeKind = 'payer' | 'other-income' | 'deficit' | 'total' | 'group' | 'left-over' | 'category' | 'other-categories';

/** A node of the chart, for lib/sankey.ts: what it is, what it is called, its
 *  amount, and the rows behind it (what tapping it shows; null for the left
 *  over and the deficit, which are no transactions). A fold says what it
 *  holds. */
export type FlowNode = {
  id: string;
  column: number;
  side: LabelSide;
  kind: FlowNodeKind;
  label: string;
  value: number;
  transactions: number;
  ids: readonly string[] | null;
  members?: { name: string; amount: number }[];
};

export type FlowGraph = { nodes: FlowNode[]; links: SankeyLinkInput[]; total: number };

/** The least share of the period's flow a payer or a category is drawn with
 *  on its own: smaller ones fold, so none is an unreadable hairline. */
export const MIN_SHARE = 0.03;
/** The most payers drawn on their own. */
export const MAX_PAYERS = 6;

/** What a payer is called on the chart: its name, or that it has none. */
export const payerLabel = (p: Pick<Payer, 'name'>): string => p.name || 'No name';

/** Of `items` (most first), those drawn on their own and those folded
 *  together: what `keep` refuses folds, but never one alone, which would hide
 *  its name and draw nothing fewer. */
function fold<T>(items: readonly T[], keep: (t: T, i: number) => boolean): { shown: T[]; folded: T[] } {
  const shown = items.filter(keep);
  const folded = items.filter((t, i) => !keep(t, i));
  return folded.length === 1 ? { shown: [...items], folded: [] } : { shown, folded };
}

/**
 * The chart's nodes and links, in four columns: payers (and the deficit, at
 * the foot), everything counted, the groups (and the left over, at the foot),
 * and each group's categories. Every amount is the flow's own. A payer drawn
 * on its own takes at least `minShare` of the larger of money in and out, and
 * is among the `maxPayers` largest; the rest fold into Other income. A
 * group's categories under `minShare` fold into Other, in its group; a group
 * under it, or whose categories would all fold, ends at its group.
 */
export function flowGraph(flow: CashFlow, opts: { minShare?: number; maxPayers?: number } = {}): FlowGraph {
  const minShare = opts.minShare ?? MIN_SHARE;
  const maxPayers = opts.maxPayers ?? MAX_PAYERS;
  const total = Math.max(flow.money_in, flow.money_out);
  if (!(total > 0)) return { nodes: [], links: [], total: 0 };
  const big = (amount: number) => amount >= minShare * total;
  const nodes: FlowNode[] = [];
  const links: SankeyLinkInput[] = [];
  const members = (items: { name: string; amount: number }[]) => items.map((m) => ({ name: m.name, amount: m.amount }));
  const sum = (items: { amount: number }[]) => tidy(items.reduce((a, m) => a + m.amount, 0));

  const payers = fold(flow.payers, (p, i) => i < maxPayers && big(p.amount));
  for (const p of payers.shown) {
    nodes.push({ id: `payer:${p.key}`, column: 0, side: 'right', kind: 'payer', label: payerLabel(p), value: p.amount, transactions: p.transactions, ids: p.ids });
    links.push({ source: `payer:${p.key}`, target: 'total', value: p.amount });
  }
  if (payers.folded.length > 0) {
    const value = sum(payers.folded);
    nodes.push({
      id: 'other-income',
      column: 0,
      side: 'right',
      kind: 'other-income',
      label: 'Other income',
      value,
      transactions: payers.folded.reduce((a, p) => a + p.transactions, 0),
      ids: payers.folded.flatMap((p) => p.ids),
      members: members(payers.folded.map((p) => ({ name: payerLabel(p), amount: p.amount }))),
    });
    links.push({ source: 'other-income', target: 'total', value });
  }
  if (flow.from_savings_or_debt > 0) {
    nodes.push({ id: 'deficit', column: 0, side: 'right', kind: 'deficit', label: 'From savings or debt', value: flow.from_savings_or_debt, transactions: 0, ids: null });
    links.push({ source: 'deficit', target: 'total', value: flow.from_savings_or_debt });
  }

  nodes.push({
    id: 'total',
    column: 1,
    side: 'none',
    kind: 'total',
    label: 'Everything counted',
    value: total,
    transactions: flow.counted,
    ids: [...flow.payers.flatMap((p) => p.ids), ...flow.groups.flatMap((g) => g.ids)],
  });

  for (const g of flow.groups) {
    nodes.push({ id: `group:${g.id}`, column: 2, side: 'left', kind: 'group', label: g.name, value: g.amount, transactions: g.transactions, ids: g.ids });
    links.push({ source: 'total', target: `group:${g.id}`, value: g.amount });
  }
  if (flow.left_over > 0) {
    nodes.push({ id: 'left-over', column: 2, side: 'left', kind: 'left-over', label: 'Left over', value: flow.left_over, transactions: 0, ids: null });
    links.push({ source: 'total', target: 'left-over', value: flow.left_over });
  }

  for (const g of flow.groups) {
    if (!big(g.amount)) continue;
    const cats = fold(g.categories, (c) => big(c.amount));
    if (cats.shown.length === 0) continue;
    for (const c of cats.shown) {
      nodes.push({ id: `category:${c.id}`, column: 3, side: 'left', kind: 'category', label: displayName(c.name), value: c.amount, transactions: c.transactions, ids: c.ids });
      links.push({ source: `group:${g.id}`, target: `category:${c.id}`, value: c.amount });
    }
    if (cats.folded.length > 0) {
      const value = sum(cats.folded);
      nodes.push({
        id: `other:${g.id}`,
        column: 3,
        side: 'left',
        kind: 'other-categories',
        label: 'Other',
        value,
        transactions: cats.folded.reduce((a, c) => a + c.transactions, 0),
        ids: cats.folded.flatMap((c) => c.ids),
        members: members(cats.folded.map((c) => ({ name: displayName(c.name), amount: c.amount }))),
      });
      links.push({ source: `group:${g.id}`, target: `other:${g.id}`, value });
    }
  }
  return { nodes, links, total };
}

/**
 * The rows behind a node of the chart, or of the table beside it, by its id:
 * one drawn (flowGraph's), or a payer, group or category the chart folds or
 * leaves to its group (`payer:`, `group:` and `category:` ids). Null for one
 * that isn't there, or isn't transactions (the left over, the deficit).
 */
export function rowIdsOf(flow: CashFlow, graph: FlowGraph, id: string): readonly string[] | null {
  const drawn = graph.nodes.find((n) => n.id === id);
  if (drawn) return drawn.ids;
  const [kind, rest] = [id.slice(0, id.indexOf(':')), id.slice(id.indexOf(':') + 1)];
  if (kind === 'payer') return flow.payers.find((p) => p.key === rest)?.ids ?? null;
  if (kind === 'group') return flow.groups.find((g) => g.id === rest)?.ids ?? null;
  if (kind === 'category') return flow.groups.flatMap((g) => g.categories).find((c) => c.id === rest)?.ids ?? null;
  return null;
}

// ---- Periods ----

export type PeriodKey = 'this-month' | 'last-month' | 'last-3-months' | 'year-to-date' | 'last-12-months';

/** The periods the chart offers, in their order. */
export const PERIODS: readonly { key: PeriodKey; label: string }[] = [
  { key: 'this-month', label: 'This month' },
  { key: 'last-month', label: 'Last month' },
  { key: 'last-3-months', label: 'Last 3 months' },
  { key: 'year-to-date', label: 'Year to date' },
  { key: 'last-12-months', label: 'Last 12 months' },
];

export const isPeriodKey = (v: unknown): v is PeriodKey => PERIODS.some((p) => p.key === v);

/** A period: whole calendar months, oldest first, and their first and last
 *  days. */
export type Period = { key: PeriodKey; months: string[]; from: string; to: string };

/** A month's last day. setUTCFullYear, not Date.UTC, which reads a year
 *  under 100 as 19xx. */
export function lastDayOf(month: string): string {
  const d = new Date(0);
  d.setUTCFullYear(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0);
  return d.toISOString().slice(0, 10);
}

/**
 * The months a period covers, from `today` (YYYY-MM-DD on the person's own
 * calendar: lib/local-date.ts localDate, never UTC's). Whole months, as the
 * Activity tab totals them, so each is that tab's month to the cent: this
 * month (to its last day, as the tab counts a row dated later in it); last
 * month; the last 3 and 12 months, this one and those before it; and the
 * year to date, from January to this month.
 */
export function periodOf(key: PeriodKey, today: string): Period {
  const month = today.slice(0, 7);
  const first =
    key === 'this-month'
      ? month
      : key === 'last-month'
        ? addMonths(month, -1)
        : key === 'last-3-months'
          ? addMonths(month, -2)
          : key === 'year-to-date'
            ? `${month.slice(0, 4)}-01`
            : addMonths(month, -11);
  const last = key === 'last-month' ? addMonths(month, -1) : month;
  return { key, months: monthsFrom(first, last), from: `${first}-01`, to: lastDayOf(last) };
}

/** Whether a row's date is in the period. */
export const inPeriod = (p: Pick<Period, 'from' | 'to'>) => (date: string) => date >= p.from && date <= p.to;

/** The months it covers, in words: "October", "August to October", "November
 *  2025 to October 2026", with a year whenever it isn't this one. */
export function periodCaption(p: Pick<Period, 'months'>, today: string): string {
  const first = p.months[0];
  const last = p.months[p.months.length - 1];
  if (first === last) return monthName(first, today);
  const sameYear = first.slice(0, 4) === last.slice(0, 4);
  return sameYear ? `${monthName(first, last)} to ${monthName(last, today)}` : `${monthName(first)} to ${monthName(last)}`;
}

/** The days of transactions the Activity tab holds: the last 365, by UTC
 *  day, as lib/transactions.ts LOOKBACK_DAYS reads them (a test holds the
 *  two equal; that module is the server's, never the browser's). */
export const WINDOW_DAYS = 365;

/** The first day of that window at `now`. */
export const windowStart = (now: number = Date.now()): string => new Date(now - WINDOW_DAYS * 86_400_000).toISOString().slice(0, 10);

/** "Mar 2, 2027": a calendar day in words, as it is (never moved by a time
 *  zone). */
export const dayText = (day: string): string =>
  new Date(`${day}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });

/**
 * What to say when a period reaches before the transactions held: before the
 * Activity tab's window (`now`), whose first days aren't loaded; or before the
 * earliest transaction there is (`rows`, every row loaded, counted or not),
 * so its first months may be missing what came before it. Null when neither.
 */
export function historyNote(p: Pick<Period, 'from'>, rows: readonly { date: string }[], now: number = Date.now()): string | null {
  const start = windowStart(now);
  if (p.from < start) return `Nya holds the last ${WINDOW_DAYS} days of transactions, from ${dayText(start)} on, so this period's first days aren't in it.`;
  let earliest: string | null = null;
  for (const t of rows) if (earliest === null || t.date < earliest) earliest = t.date;
  if (earliest !== null && earliest > p.from) return `The earliest transaction here is from ${dayText(earliest)}, so this period may be missing what came before it.`;
  return null;
}

// ---- What the chart says beside it ----

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * Beside the chart (#41): what may be missing from the period (`gaps`, in the
 * stale notes' words) and what it leaves out by the totals' rules
 * (`counted`). Gaps: an institution whose transactions couldn't be loaded or
 * are still importing; a connection that stopped syncing, with the months it
 * may leave short (lib/month-coverage.ts, months as the Activity tab reads
 * them); a bank account or card whose transactions Plaid doesn't provide or
 * the person didn't allow; a period reaching before the transactions held
 * (historyNote); and SimpleFIN rows that count without a category. Counted:
 * the transfers, exclusions and rule hides left out, exclusions that
 * couldn't be read, what is in another currency, that a refund is money in,
 * and the connections that hold no bank account or card when only rows
 * entered by hand are here. `day` names an instant's local day ("Sep 12").
 */
export function cashFlowNotes(input: {
  flow: CashFlow;
  period: Period;
  /** Every row loaded, counted or not. */
  rows: readonly FlowRow[];
  incomplete?: readonly Incomplete[];
  stopped?: readonly Stopped[];
  view?: NoTransactionsView;
  today: string;
  now?: number;
  day: (iso: string) => string;
}): { gaps: string[]; counted: string[] } {
  const { flow, period, today } = input;
  const view = input.view ?? NO_CONNECTIONS_WITHOUT;
  const whole = period.months.length === 1 ? monthName(period.months[0], today) : 'this period';
  /** The months a gap touches, in words: the period's, when it is all of them. */
  const touched = (months: string[]) => (months.length === period.months.length ? whole : monthsText(months, today));
  const gaps: string[] = [];

  const byMonth = period.months.map((m) => ({ m, gaps: monthGaps(m, [...(input.incomplete ?? [])], [...(input.stopped ?? [])]) }));
  const missing = [...new Set(byMonth.flatMap((g) => g.gaps.missing))];
  if (missing.length > 0) gaps.push(`Doesn't include ${joinNames(missing)}: ${missing.length === 1 ? 'its' : 'their'} transactions couldn't be loaded, so ${whole} may be incomplete.`);
  const stopped = new Map<string, { s: Stopped; months: string[] }>();
  for (const { m, gaps: g } of byMonth) {
    for (const s of g.stopped) {
      const key = `${s.institution_name}\u0000${s.last_ok_at ?? ''}`;
      const entry = stopped.get(key) ?? { s, months: [] };
      entry.months.push(m);
      stopped.set(key, entry);
    }
  }
  for (const { s, months } of stopped.values()) {
    const since = s.last_ok_at ? `${s.institution_name} hasn't synced since ${input.day(s.last_ok_at)}` : `${s.institution_name} isn't syncing`;
    gaps.push(`${since}, so ${touched(months)} may be missing some of its transactions.`);
  }
  const importing = [...new Set(byMonth.flatMap((g) => g.gaps.importing))];
  if (importing.length > 0) gaps.push(`${joinNames(importing)} ${importing.length === 1 ? 'is' : 'are'} still importing older transactions, so ${whole} may be incomplete.`);
  const refused = refusedNames(view);
  if (refused.length > 0) gaps.push(`Doesn't include the bank or card accounts at ${joinNames(refused)}: Plaid doesn't provide their transactions, so ${whole} may be incomplete.`);
  const unallowed = unallowedNames(view);
  if (unallowed.length > 0) {
    gaps.push(
      `Doesn't include the bank or card accounts at ${joinNames(unallowed)}: you didn't allow Nya to see their transactions, so ${whole} may be incomplete. To bring them in, choose Allow transactions on the Accounts tab.`
    );
  }
  const history = historyNote(period, input.rows, input.now);
  if (history) gaps.push(history);
  const inRange = inPeriod(period);
  const uncategorized = uncategorizedNote(uncategorizedFromConnector(input.rows.filter((t) => inRange(t.date))));
  if (uncategorized) gaps.push(uncategorized);

  const counted: string[] = [];
  const byYou = flow.excluded - flow.hidden_by_rule;
  const hidden = flow.hidden_by_rule;
  const excluded = [
    ...(byYou > 0 ? [`${plural(byYou, 'transaction')} you excluded`] : []),
    ...(hidden > 0 ? [byYou > 0 ? `${hidden} a rule hides` : `${plural(hidden, 'transaction')} a rule hides`] : []),
  ];
  counted.push(
    `Transfers, cash withdrawals and loan payments are left out, as in every total${flow.transfers > 0 ? ` (${flow.transfers} here)` : ''}.` +
      (excluded.length > 0 ? ` So ${byYou + hidden === 1 ? 'is' : 'are'} ${joinNames(excluded)}.` : '')
  );
  if (flow.exclusion_unknown > 0) {
    const n = flow.exclusion_unknown;
    counted.push(`Whether you excluded ${plural(n, 'transaction')} couldn't be read, so ${n === 1 ? 'it counts' : 'they count'} here.`);
  }
  if (flow.left_out_text) counted.push(flow.left_out_text);
  if (flow.payers.some((p) => p.refund)) counted.push('A refund counts as money in, as in every total, never as less spending in its category.');
  const named = withoutNote(view, input.rows.length);
  if (named) counted.push(named);
  return { gaps, counted };
}
