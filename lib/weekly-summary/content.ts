// lib/weekly-summary/content.ts
//
// What a weekly summary says, as facts, from what the app's own readers
// answer (lib/weekly-summary/gather.ts reads them): each section worked out by
// the functions the app shows the same things with, so the email never says
// something the app contradicts. Pure; the words are lib/weekly-summary/
// compose.ts's, which decides what may leave Nya, names included.
//
//   SPENDING, compared with a usual week. Money out, as every total counts it
//     (lib/spending.ts countsInTotals: one currency, the one most of the
//     year's transactions are in, or with a home currency that one, what is
//     in another converted at its own day's rate as the app counts it
//     (lib/fx/totals.ts), without transfers, cash or loan payments or
//     what was excluded), over the week's seven days, set against the middle
//     (the median) of the USUAL_WEEKS weeks before it, each the same seven
//     weekdays: a week with one big purchase doesn't make every other week look
//     small. In words only (LEVELS), never a figure or a percentage: a
//     percentage reveals no amount on its own, but beside any one the reader
//     knows it reveals the rest, and words say enough. Only weeks Nya holds
//     transactions for count as usual ones: not one before a connection's
//     stored history begins. Not compared at all while the week's transactions
//     aren't all in (a connection that stopped, or wasn't brought up to date
//     since the week ended), while older ones are still arriving, or with
//     fewer than MIN_USUAL_WEEKS weeks to go by: it says which instead.
//   BUDGETS this month, as the Budgets tab meters them (lib/rollover.ts
//     availableMeters: with what rolled over), each category's and each
//     group's with a budget of its own, as Home's alerts pick them
//     (components/Insights.tsx). Over once what is spent reaches what is
//     available (or nothing is available and something is spent); close from
//     CLOSE_SHARE of it, the Budgets tab's amber, only while the month runs.
//   BILLS due in the next seven days: the bills detected as the app detects
//     them (lib/recurring.ts), on the dates they are expected (as the forecast
//     and Home's reminders read them), never one the person said isn't
//     recurring; and the expenses they planned (lib/planned.ts).
//   GOALS that reached their target since the person was last told (the
//     ids the last summary sent named, lib/weekly-summary/store.ts), and
//     those behind their target date, every week while they are: by the
//     projection the Goals card shows (lib/goal-projection.ts), archived ones
//     left out. A goal that stays at its target is told of once, not weekly.
//   CONNECTIONS that need the person, from what the daily job last found
//     (lib/connection-notices.ts): a sign-in to redo, one to make again, a bank
//     reporting no open accounts, an end Plaid warned of, and an outage once it
//     has gone OUTAGE_NOTICE_DAYS. Never a problem on Nya's side.
//   MONTHS whose transactions may be incomplete, as the Budgets and Activity
//     tabs say it (lib/rollover.ts monthGapsOf).
//   UNCATEGORIZED: the week's transactions from SimpleFIN with no category,
//     the one count the app keeps of rows waiting for one (lib/spending.ts).
// A section whose store couldn't be read is UNREAD: left out, and the email
// says some of the data couldn't be read rather than guessing.

import { countsInTotals, leftOutByCurrency, uncategorizedFrom, uncategorizedFromConnector, type Countable } from '../spending';
import { addDays, dismissedSeries, upcomingBills, type RecurringSeries } from '../recurring';
import { plannedDates, type PlannedItem } from '../planned';
import { availableMeters, monthGapsOf, type CoverageFacts, type MonthBudgets, type MonthGap } from '../rollover';
import type { CategoryIndex } from '../categories';
import type { ConnectionNotice, LastSync } from '../connection-records';
import { warningLapsed, type ConnectionWarning, type HealthState } from '../connection-state';
import { OUTAGE_NOTICE_DAYS, elapsedDays } from '../connection-notices';
import type { ProjectionStatus } from '../goal-projection';
import { dayIn } from '../report/period';
import type { Weekday } from './settings';

/** A section whose store couldn't be read. */
export type Unread = { unread: true };
export const UNREAD: Unread = { unread: true };
export const isUnread = (v: unknown): v is Unread => typeof v === 'object' && v !== null && (v as Unread).unread === true;

/** Weeks before this one that a usual week is found from. */
export const USUAL_WEEKS = 8;
/** The fewest of them, with transactions to go by, to compare with at all. */
export const MIN_USUAL_WEEKS = 4;
/** The share of a budget from which it is close: the Budgets tab's amber
 *  (components/BudgetsTab.tsx meterState). */
export const CLOSE_SHARE = 0.85;
/** How many days of bills: the send day and the six after it. */
export const BILL_DAYS = 7;

/** This week's spending against a usual week's, in words (see SPENDING). */
export type Level = 'much_higher' | 'higher' | 'same' | 'lower' | 'much_lower';

/** The bounds between the levels, as shares of a usual week: from 1.5 much
 *  higher, from 1.15 higher, above 0.85 about the same, above 0.5 lower. */
export const LEVELS = { muchHigher: 1.5, higher: 1.15, sameAbove: 0.85, lowerAbove: 0.5 } as const;

export type SpendingFact =
  /** Compared: the level, and the currencies whose transactions this week
   *  aren't in it: in another currency (nothing is converted), or, with a
   *  home currency (`no_rate`), with no rate to convert them at. */
  | { kind: 'compared'; level: Level; left_out: string[]; no_rate?: true }
  /** Not one transaction is dated in the week. */
  | { kind: 'no_transactions' }
  /** Too early to say: too few weeks with transactions to go by, or older
   *  transactions still arriving. */
  | { kind: 'too_early'; why: 'history' | 'importing' }
  /** The week's transactions aren't all in: each connection behind, with the
   *  day (on the person's calendar) it last brought them in, or null. */
  | { kind: 'behind'; sources: { name: string; since: string | null }[] }
  /** No connection brings in bank or card transactions, and none were
   *  entered by hand (lib/no-transactions.ts noSpending). */
  | { kind: 'none_come_in' };

export type BudgetFact = {
  /** The month (YYYY-MM) the week ended in. */
  month: string;
  /** Whether that month is still running, so "close" means something. */
  running: boolean;
  /** Names, as the person named them, the most over first. */
  over: string[];
  close: string[];
};

export type BillFact = {
  name: string;
  /** The day it is expected (YYYY-MM-DD, a calendar day as the bank's). */
  day: string;
  /** Due before today and not in yet: expected today. Its own due day is `day`. */
  late: boolean;
  /** One the person planned (lib/planned.ts), not one detected. */
  planned: boolean;
};

export type GoalFact = {
  /** Names of the goals at their target that the person hasn't been told of. */
  reached: string[];
  behind: string[];
  /** Ids of every goal at its target now: what a summary that goes records
   *  as told (job.ts recordSent). */
  complete: string[];
};

/** The states a connection is told of in a summary. */
export type ConnectionState = Extract<HealthState, 'reconnect_soon' | 'needs_reauth' | 'relink' | 'closed' | 'outage'>;

export type ConnectionFact = {
  name: string;
  state: ConnectionState;
  /** For reconnect soon: when Plaid said it ends (an ISO time), or null. */
  ends_at: string | null;
};

export type MonthFact = { month: string; gaps: MonthGap[] };

/** Everything a summary says, before it is put into words (compose.ts). */
export type WeeklyFacts = {
  /** The day it comes on (its week's send day) and the week it covers. */
  send_day: string;
  first: string;
  last: string;
  /** The person's day when it was worked out, and their time zone. */
  today: string;
  time_zone: string;
  weekday: Weekday;
  spending: SpendingFact | Unread;
  /** Null when no budget is over or close. */
  budgets: BudgetFact | null | Unread;
  bills: BillFact[] | Unread;
  goals: GoalFact | Unread;
  connections: ConnectionFact[] | Unread;
  months: MonthFact[] | Unread;
  /** Transactions this week from SimpleFIN or Lunch Flow with no category. */
  uncategorized: number | Unread;
  /** The services they came through, as the words name them ("SimpleFIN",
   *  "Lunch Flow", or both), so nobody is told of one they don't use; both
   *  when absent (facts gathered before it was kept). */
  uncategorized_from?: string;
};

// ---- Spending ----

/** A source of transactions, as the summary weighs how complete the week is. */
export type SpendingSource = {
  name: string;
  /** It brings transactions in (not an investment-only connection, say). */
  brings: boolean;
  /** When it last brought them in (an ISO time), or null if never known. */
  synced_at: string | null;
  /** Its older transactions are all in. */
  complete: boolean;
};

export type SpendingInput = {
  /** The Activity tab's rows (lib/activity.ts), hidden accounts' and those of
   *  accounts that ended left out as the app leaves them out. */
  rows: readonly (Countable & { date: string; amount: number })[];
  /** The currency totals over them are in (lib/spending.ts totalsCurrency),
   *  or the home currency they were converted into (lib/fx/totals.ts). */
  currency: string | null;
  /** They were converted into a home currency: what is left out has no rate. */
  converted?: boolean;
  send_day: string;
  first: string;
  last: string;
  time_zone: string;
  sources: readonly SpendingSource[];
  /** What says whether a month may be incomplete (lib/rollover.ts): the
   *  connections that stopped, and where each one's stored history begins. */
  facts: Pick<CoverageFacts, 'stopped' | 'first' | 'incomplete'>;
  /** No connection brings in spending, and no row came from anywhere else. */
  none_come_in: boolean;
};

/** The median of some numbers (the two middle ones averaged). */
export function median(xs: readonly number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** This week's money out against a usual week's, in words (LEVELS). */
export function levelOf(week: number, usual: number): Level {
  if (usual <= 0) return week <= 0 ? 'same' : 'higher';
  const r = week / usual;
  if (r >= LEVELS.muchHigher) return 'much_higher';
  if (r >= LEVELS.higher) return 'higher';
  if (r > LEVELS.sameAbove) return 'same';
  if (r > LEVELS.lowerAbove) return 'lower';
  return 'much_lower';
}

/** Money out that counts (as every total counts it, lib/totals.ts summarize)
 *  over [from, to]: each split part and group net as the rows hold them, and
 *  never a transaction of a group counted outside them (group_outside). */
export function moneyOut(rows: SpendingInput['rows'], from: string, to: string, currency: string | null): number {
  let total = 0;
  for (const t of rows) if (t.date >= from && t.date <= to && t.amount > 0 && countsInTotals(t, currency)) total += t.amount;
  return total;
}

/** The week's spending against a usual week's (see SPENDING in the header). */
export function spendingFact(input: SpendingInput): SpendingFact {
  if (input.none_come_in) return { kind: 'none_come_in' };
  const { first, last, send_day, time_zone } = input;
  // Connections whose transactions stopped before the week was over (a
  // broken one, by when it last synced), unless every account it holds had
  // ended by the week's first day; and those that work but weren't brought
  // up to date since the week ended. Each with the day it last brought them.
  const localDay = (iso: string | null) => (iso ? dayIn(iso, time_zone) : null);
  const behind = new Map<string, string | null>();
  for (const s of input.facts.stopped) {
    if (s.until && s.until <= first) continue;
    const since = localDay(s.last_ok_at);
    if (since === null || since <= last) behind.set(s.institution_name, since);
  }
  for (const i of input.facts.incomplete) if (i.coverage === 'missing' && !behind.has(i.institution_name)) behind.set(i.institution_name, null);
  for (const s of input.sources) {
    if (!s.brings || behind.has(s.name)) continue;
    const since = localDay(s.synced_at);
    if (since === null || since < send_day) behind.set(s.name, since);
  }
  if (behind.size > 0) return { kind: 'behind', sources: [...behind].map(([name, since]) => ({ name, since })).sort((a, b) => (a.name < b.name ? -1 : 1)) };

  const inWeek = input.rows.filter((t) => t.date >= first && t.date <= last);
  if (inWeek.length === 0) return { kind: 'no_transactions' };
  if (input.sources.some((s) => s.brings && !s.complete) || input.facts.incomplete.some((i) => i.coverage === 'importing')) return { kind: 'too_early', why: 'importing' };

  // A usual week only counts where every connection's stored history had
  // begun, and where any transaction at all is held.
  const begun = [...input.facts.first.map((f) => f.day), ...(input.rows.length > 0 ? [input.rows.reduce((d, t) => (t.date < d ? t.date : d), input.rows[0].date)] : [])].sort();
  const from = begun[begun.length - 1] ?? first;
  const weeks: number[] = [];
  for (let k = 1; k <= USUAL_WEEKS; k++) {
    const start = addDays(first, -7 * k);
    if (start < from) break;
    weeks.push(moneyOut(input.rows, start, addDays(last, -7 * k), input.currency));
  }
  if (weeks.length < MIN_USUAL_WEEKS) return { kind: 'too_early', why: 'history' };
  const left_out = leftOutByCurrency(inWeek, input.currency).map((l) => l.currency);
  return {
    kind: 'compared',
    level: levelOf(moneyOut(input.rows, first, last, input.currency), median(weeks)),
    left_out,
    ...(input.converted && left_out.length > 0 ? { no_rate: true as const } : {}),
  };
}

// ---- Budgets ----

/**
 * The budgets over and close in a month, as the Budgets tab meters them with
 * what rolled over (see BUDGETS in the header). Null when none is either.
 */
export function budgetFact(input: { ix: CategoryIndex; view: MonthBudgets; spent: Readonly<Record<string, number>>; month: string; running: boolean }): BudgetFact | null {
  const meters = availableMeters(input.ix, input.view.budgets, input.view.carries, new Map(Object.entries(input.spent)));
  const candidates = [
    ...meters.groups.filter((m) => m.limit !== null && m.own !== null).map((m) => ({ name: m.group.name, limit: m.limit!, spent: m.spent })),
    ...meters.groups.flatMap((m) => m.categories.filter((c) => c.budget !== null).map((c) => ({ name: c.category.name, limit: c.budget!, spent: c.spent }))),
  ];
  // The Budgets tab's own rule: over once the limit is used up, or with
  // nothing left at all once something is spent or the month began over.
  const isOver = (c: { limit: number; spent: number }) => (c.limit > 0 ? c.spent >= c.limit : c.spent > 0 || c.limit < 0);
  const share = (c: { limit: number; spent: number }) => (c.limit > 0 ? c.spent / c.limit : Infinity);
  const byShare = (a: { name: string; limit: number; spent: number }, b: typeof a) => share(b) - share(a) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  const over = candidates.filter(isOver).sort(byShare);
  const close = input.running ? candidates.filter((c) => !isOver(c) && c.limit > 0 && c.spent / c.limit >= CLOSE_SHARE).sort(byShare) : [];
  if (over.length === 0 && close.length === 0) return null;
  return { month: input.month, running: input.running, over: over.map((c) => c.name), close: close.map((c) => c.name) };
}

// ---- Bills ----

/**
 * The bills due from `today` through the BILL_DAYS that start with it: each
 * detected bill at its first expected date, once by name (the same bill on two
 * accounts is one bill, as Home lists them), never one the person dismissed;
 * and each expense they planned, at its first day in them. Soonest first.
 */
export function billsFact(input: { series: readonly RecurringSeries[]; dismissed: readonly string[]; planned: readonly PlannedItem[]; today: string }): BillFact[] {
  const until = addDays(input.today, BILL_DAYS - 1);
  const gone = new Set(dismissedSeries(input.series, input.dismissed).keys());
  const seen = new Set<string>();
  const out: BillFact[] = [];
  for (const b of upcomingBills(input.series, BILL_DAYS - 1, input.today, gone)) {
    if (seen.has(b.series.name)) continue;
    seen.add(b.series.name);
    out.push({ name: b.series.name, day: b.late ? b.due : b.date, late: b.late, planned: false });
  }
  for (const item of input.planned) {
    if (item.kind !== 'expense') continue;
    const day = plannedDates(item, input.today, until, 1)[0];
    if (day) out.push({ name: item.name, day, late: false, planned: true });
  }
  return out.sort((a, b) => (a.late !== b.late ? (a.late ? -1 : 1) : a.day < b.day ? -1 : a.day > b.day ? 1 : a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

// ---- Goals ----

/** A goal as the summary weighs it: as the Goals card and the API read it
 *  (lib/api-goals.ts). */
export type GoalInput = { id: string; name: string; archived: boolean; state: string; status: ProjectionStatus | null };

/** The goals that reached their target since `told` (the ids the last
 *  summary that went recorded; null before any, when every goal at its target
 *  is news), and those behind their target date (see GOALS). */
export function goalsFact(goals: readonly GoalInput[], told: readonly string[] | null = null): GoalFact {
  const counted = goals.filter((g) => !g.archived && g.state === 'tracked');
  const complete = counted.filter((g) => g.status === 'complete');
  const known = new Set(told ?? []);
  return {
    reached: complete.filter((g) => !known.has(g.id)).map((g) => g.name),
    behind: counted.filter((g) => g.status === 'behind').map((g) => g.name),
    complete: complete.map((g) => g.id),
  };
}

// ---- Connections ----

/** States that need the person to do something, as the notices count them. */
const NEEDS_YOU: ReadonlySet<HealthState> = new Set<HealthState>(['reconnect_soon', 'needs_reauth', 'relink', 'closed']);

/**
 * The connections that need the person, from what the daily job last found
 * about each (its episode in lib/connection-records.ts) and Plaid's warnings
 * (see CONNECTIONS in the header), by name.
 */
export function connectionsFact(input: {
  items: readonly { item_id: string; institution_name: string }[];
  notices: ReadonlyMap<string, ConnectionNotice>;
  warnings: ReadonlyMap<string, ConnectionWarning>;
  syncs: ReadonlyMap<string, LastSync>;
  now: number;
}): ConnectionFact[] {
  const out: ConnectionFact[] = [];
  for (const item of input.items) {
    const notice = input.notices.get(item.item_id) ?? null;
    const last = input.syncs.get(item.item_id)?.at ?? null;
    const warning = input.warnings.get(item.item_id) ?? null;
    const ends = warning && !warningLapsed(warning, last, null) ? warning.ends_at : null;
    if (notice) {
      // Never about a problem on Nya's side: nothing for the person to do.
      if (notice.side === 'nya') continue;
      if (NEEDS_YOU.has(notice.state)) out.push({ name: item.institution_name, state: notice.state as ConnectionState, ends_at: notice.state === 'reconnect_soon' ? ends : null });
      else if (notice.state === 'outage' && elapsedDays(last ?? notice.since, input.now) >= OUTAGE_NOTICE_DAYS) out.push({ name: item.institution_name, state: 'outage', ends_at: null });
    } else if (ends) {
      out.push({ name: item.institution_name, state: 'reconnect_soon', ends_at: ends });
    }
  }
  return out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

// ---- Months ----

/** The months, oldest first, whose transactions may be incomplete, with why. */
export function monthsFact(months: readonly string[], facts: CoverageFacts): MonthFact[] {
  return [...new Set(months)]
    .sort()
    .map((month) => ({ month, gaps: monthGapsOf(month, facts) }))
    .filter((m) => m.gaps.length > 0);
}

// ---- Uncategorized ----

/** The week's transactions from SimpleFIN or Lunch Flow with no category, that count. */
export function uncategorizedFact(rows: readonly (Countable & { date: string; source?: string | null })[], first: string, last: string): number {
  return uncategorizedFromConnector(rows.filter((t) => t.date >= first && t.date <= last));
}

/** The services the week's uncategorized transactions came through, named
 *  as the words name them (lib/spending.ts uncategorizedFrom). */
export function uncategorizedSourcesFact(rows: readonly (Countable & { date: string; source?: string | null })[], first: string, last: string): string {
  return uncategorizedFrom(rows.filter((t) => t.date >= first && t.date <= last));
}
