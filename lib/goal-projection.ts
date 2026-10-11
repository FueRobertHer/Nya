// lib/goal-projection.ts
//
// When a goal will be reached, worked out from what actually went into its
// account (#42). Derived on every read, never stored. Pure, safe to import
// from client code: the Goals card runs it with the balances it shows, the
// read-only API with the balances Nya last measured, both on the same monthly
// figures (lib/goal-flows.ts gathers them from stored data).
//
// WHAT COUNTS AS A CONTRIBUTION, per calendar month (a transaction's month is
// the one its date is in; "this month" is the viewer's own):
//   - From TRANSACTIONS, when Nya has the account's rows: the net money in,
//     transfers included (a transfer into savings is the contribution, unlike
//     in spending, where transfers are left out). Deposits and transfers in,
//     less what went out. Pending rows are left out until they post, and
//     interest and dividends (a bank's "interest earned" or "dividends", or a
//     row entered as interest) are counted apart, as growth: they grow the
//     balance, but nobody put them in.
//   - From BALANCES, for an account whose rows Nya doesn't have (an
//     investment account, a manual account with no transactions entered, a
//     connection that brings in balances only): the change in the last
//     balance Nya recorded in each month's last week, from measured balances
//     only, never an estimate. Interest and market moves can't be told apart
//     from contributions there, so the figure is labelled as a change in
//     balance, not as contributions.
//   - A month Nya has no figure for is unknown (null), never zero: the months
//     before an account's data begins, or a month whose end has no recorded
//     balance.
//
// THE RATE is the average of the last three complete months it knows (fewer
// when fewer are known), else the goal's monthly target, labelled as such. A
// month that may be missing transactions (an institution that couldn't be
// loaded, is still importing older ones, or stopped syncing before the month
// ended; or the month the data begins in) makes the rate uncertain, and says
// why. Zero or less is "no recent contributions", never an infinite date.
// When several goals share an account, its money in can't be told apart
// between them: each is projected at its own monthly target, or not at all.
//
// THE PROJECTION counts whole monthly contributions from next month on: what
// is left over the rate, rounded up, so a goal $50 short at $250 a month is
// reached next month, not in a fifth of one. With a target date, what each
// month until then needs, and how far the rate is from that.

import { minorDigits } from './manual-txn-input';

export type FlowSource = 'transactions' | 'balances';

/** Why a month's figure may be short. */
export type MonthGap =
  /** The institution's transactions couldn't be loaded this time. */
  | { kind: 'missing'; institution: string }
  /** Its older transactions are still arriving. */
  | { kind: 'importing'; institution: string }
  /** Its connection stopped syncing before the month ended: `since`, when it
   *  last synced (an ISO time), or null when it never did. */
  | { kind: 'stopped'; institution: string; since: string | null }
  /** Nya's transactions for the account begin part way through this month. */
  | { kind: 'begins'; on: string };

/** One month's money in, in the account's currency. */
export type MonthFlow = {
  /** YYYY-MM. */
  month: string;
  /** Net money in (see the header), or the change in balance; null when it
   *  isn't known. */
  amount: number | null;
  /** Interest and dividends that came in, left out of `amount`
   *  (transactions only). */
  growth?: number;
  gaps?: MonthGap[];
};

/** An account's last complete months, oldest first, and where they come from. */
export type AccountFlow = { source: FlowSource; months: MonthFlow[] };

/** The fewest rows a figure is read from: what a stored or manual row holds. */
export type FlowRow = {
  date: string;
  amount: number;
  pending?: boolean;
  account_id?: string;
  subcategory?: string | null;
  category?: string | null;
};

/** How many complete months the rate averages. */
export const RATE_MONTHS = 3;
/** The last days of a month whose recorded balance ends it. */
export const MONTH_END_DAYS = 7;
/** Past this many months, a projection says "not within 50 years". */
export const MAX_PROJECTED_MONTHS = 600;

/** To the currency's minor unit, half away from zero, never -0. */
const round = (amount: number, currency: string | null) => {
  const scale = 10 ** minorDigits(currency || 'USD');
  return (Math.sign(amount) * Math.round(Math.abs(amount) * scale)) / scale || 0;
};

/** YYYY-MM `n` months after `month` (before, for a negative `n`). */
export function addMonths(month: string, n: number): string {
  const y = Number(month.slice(0, 4));
  const m = Number(month.slice(5, 7)) - 1 + n;
  const year = y + Math.floor(m / 12);
  return `${year}-${String((((m % 12) + 12) % 12) + 1).padStart(2, '0')}`;
}

/** Months from `a` to `b` (YYYY-MM): 0 for the same month, negative when b
 *  is earlier. */
export function monthDiff(a: string, b: string): number {
  return (Number(b.slice(0, 4)) - Number(a.slice(0, 4))) * 12 + Number(b.slice(5, 7)) - Number(a.slice(5, 7));
}

/** The month's last day, YYYY-MM-DD. */
export function lastDay(month: string): string {
  const d = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0));
  return d.toISOString().slice(0, 10);
}

const dayMs = (day: string) => Date.parse(`${day}T00:00:00Z`);
const daysBetween = (a: string, b: string) => Math.round((dayMs(b) - dayMs(a)) / 86_400_000);

/** The `n` complete months before `month`, oldest first. */
export function trailingMonths(month: string, n: number = RATE_MONTHS): string[] {
  return Array.from({ length: n }, (_, i) => addMonths(month, i - n));
}

/** Interest and dividends: money the balance earned, not money put in. By
 *  Plaid's detailed category (shown as a subcategory), or by the words of a
 *  row's category (one entered or imported by hand). */
const GROWTH_WORDS = new Set(['interest earned', 'interest', 'interest income', 'dividends', 'dividend', 'interest and dividends']);
export function isGrowth(row: Pick<FlowRow, 'subcategory' | 'category'>): boolean {
  const sub = row.subcategory?.trim().toLowerCase();
  const cat = row.category?.trim().toLowerCase();
  return (!!sub && GROWTH_WORDS.has(sub)) || (!!cat && GROWTH_WORDS.has(cat));
}

/**
 * Each month's net money in from an account's rows (see the header): the
 * rows of any of `ids` (the account's current id and earlier ones), posted,
 * by Plaid's sign (a positive amount left the account), interest and
 * dividends apart. `start` is the first day Nya's rows for the account cover:
 * a month before it is unknown, and the month it falls in, after its first
 * day, says the rows begin part way through.
 */
export function flowsFromRows(
  rows: readonly FlowRow[],
  ids: ReadonlySet<string>,
  months: readonly string[],
  opts: { start: string | null; currency: string | null }
): MonthFlow[] {
  const inflow = new Map<string, number>();
  const growth = new Map<string, number>();
  for (const r of rows) {
    if (r.pending || !r.account_id || !ids.has(r.account_id)) continue;
    const month = r.date.slice(0, 7);
    const into = isGrowth(r) ? growth : inflow;
    into.set(month, (into.get(month) ?? 0) - r.amount);
  }
  const startMonth = opts.start ? opts.start.slice(0, 7) : null;
  return months.map((month) => {
    if (startMonth !== null && month < startMonth) return { month, amount: null };
    const flow: MonthFlow = { month, amount: round(inflow.get(month) ?? 0, opts.currency) };
    const g = growth.get(month);
    if (g !== undefined && g !== 0) flow.growth = round(g, opts.currency);
    if (startMonth === month && opts.start!.slice(8) !== '01') flow.gaps = [{ kind: 'begins', on: opts.start! }];
    return flow;
  });
}

/**
 * Each month's change in an account's recorded balance: the last balance
 * recorded in the month's last MONTH_END_DAYS days, less the same for the
 * month before; unknown when either has none. `points` are measured
 * balances only (never an estimate), in any order.
 */
export function flowsFromBalances(points: readonly { date: string; value: number }[], months: readonly string[], currency: string | null): MonthFlow[] {
  const sorted = [...points].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const endOf = (month: string): number | null => {
    const last = lastDay(month);
    let found: number | null = null;
    for (const p of sorted) {
      if (p.date > last) break;
      if (daysBetween(p.date, last) < MONTH_END_DAYS) found = p.value;
    }
    return found;
  };
  return months.map((month) => {
    const end = endOf(month);
    const before = endOf(addMonths(month, -1));
    return { month, amount: end === null || before === null ? null : round(end - before, currency) };
  });
}

/** The rate an account's months give. */
export type Measured = {
  /** The average of the known months. */
  average: number;
  /** How many months it averages (at most RATE_MONTHS). */
  months: number;
  source: FlowSource;
  /** A month it averages may be missing some money in (see MonthGap). */
  uncertain: boolean;
  gaps: MonthGap[];
  /** Interest and dividends over those months, apart (transactions only). */
  growth: number;
};

/** The average of an account's known months, or null when none is known. */
export function measuredRate(flow: AccountFlow | null | undefined, currency: string | null): Measured | null {
  if (!flow) return null;
  const known = flow.months.filter((m) => m.amount !== null);
  if (known.length === 0) return null;
  const gaps = known.flatMap((m) => m.gaps ?? []);
  return {
    average: round(known.reduce((s, m) => s + m.amount!, 0) / known.length, currency),
    months: known.length,
    source: flow.source,
    uncertain: gaps.length > 0,
    gaps,
    growth: round(known.reduce((s, m) => s + (m.growth ?? 0), 0), currency),
  };
}

export type ProjectionStatus =
  /** Saved at least the target. */
  | 'complete'
  /** Projected to be reached; by the target date, when there is one. */
  | 'on_track'
  /** Projected after the target date, or the date has passed. */
  | 'behind'
  /** Nothing (or less than nothing) went in over the months known. */
  | 'no_recent_contributions'
  /** No rate to project with: no history, no monthly target. */
  | 'no_rate';

export type Projection = {
  status: ProjectionStatus;
  /** What is left to save; 0 once complete. */
  remaining: number;
  /** The monthly rate projected with, and where it comes from. */
  rate: number | null;
  rateFrom: 'contributions' | 'monthly_target' | null;
  /** The month (YYYY-MM) it is projected to be reached in; null when not
   *  projected, or more than MAX_PROJECTED_MONTHS away. */
  completion: string | null;
  /** Monthly contributions still needed at the rate. */
  monthsLeft: number | null;
  /** Past MAX_PROJECTED_MONTHS at this rate. */
  beyond: boolean;
  /** With a target date: what each month until it needs (all that is left
   *  when it is this month or has passed). */
  needed: number | null;
  /** How far the rate is from `needed`: above 0 short, below 0 ahead. */
  short: number | null;
  /** The target date has passed. */
  datePassed: boolean;
};

export type ProjectionInput = {
  target: number;
  /** What the goal counts as saved now. */
  saved: number;
  monthlyTarget?: number;
  targetDate?: string;
  /** The account's measured rate, or null when there is none. */
  measured: Measured | null;
  /** Other active goals count the same account, so its money in isn't this
   *  goal's alone. */
  shared: boolean;
  /** YYYY-MM-DD: the viewer's day. */
  today: string;
  currency: string | null;
};

/** When the goal will be reached (see THE PROJECTION in the header). */
export function project(input: ProjectionInput): Projection {
  const { target, saved, monthlyTarget, targetDate, measured, shared, today, currency } = input;
  const remaining = Math.max(0, round(target - saved, currency));
  const thisMonth = today.slice(0, 7);
  const datePassed = !!targetDate && targetDate < today;
  const base: Projection = { status: 'no_rate', remaining, rate: null, rateFrom: null, completion: null, monthsLeft: null, beyond: false, needed: null, short: null, datePassed };
  if (remaining <= 0) return { ...base, status: 'complete', remaining: 0 };

  // What each month until the target date needs: the months from next month
  // through the date's own, at least one.
  const monthsToDate = targetDate ? Math.max(0, monthDiff(thisMonth, targetDate.slice(0, 7))) : null;
  const needed = monthsToDate === null ? null : roundUp(remaining / Math.max(1, datePassed ? 1 : monthsToDate), currency);

  // The rate: the account's own when it is this goal's alone; otherwise the
  // monthly target. An account nothing went into is no recent contributions,
  // whatever the target says.
  let rate: number | null = null;
  let rateFrom: Projection['rateFrom'] = null;
  if (measured && measured.average <= 0) return { ...base, status: 'no_recent_contributions', needed, rate: measured.average, rateFrom: 'contributions' };
  if (measured && !shared) {
    rate = measured.average;
    rateFrom = 'contributions';
  } else if (monthlyTarget !== undefined && monthlyTarget > 0) {
    rate = monthlyTarget;
    rateFrom = 'monthly_target';
  }
  if (rate === null) return { ...base, needed };

  const monthsLeft = Math.ceil(remaining / rate - 1e-9);
  const beyond = monthsLeft > MAX_PROJECTED_MONTHS;
  const completion = beyond ? null : addMonths(thisMonth, monthsLeft);
  let status: ProjectionStatus = 'on_track';
  let short: number | null = null;
  if (targetDate) {
    status = !datePassed && monthsLeft <= monthsToDate! ? 'on_track' : 'behind';
    short = round(needed! - rate, currency);
  }
  return { ...base, status, rate, rateFrom, completion, monthsLeft, beyond, needed, short };
}

/** Up to the currency's minor unit, so what is "needed" is never a cent shy. */
function roundUp(amount: number, currency: string | null): number {
  const scale = 10 ** minorDigits(currency || 'USD');
  return Math.ceil(amount * scale - 1e-6) / scale || 0;
}

/**
 * Where the goal should be by `today` on the way to its target date: on the
 * straight line from what it held when the date was set (`start`) to the
 * target on that date. Null without a target date, a start, or a known start
 * amount, or once the start was already at the target.
 */
export function shouldHave(
  start: { date: string; amount: number | null } | undefined,
  target: number,
  targetDate: string | undefined,
  today: string,
  currency: string | null
): number | null {
  if (!start || start.amount === null || !targetDate || start.amount >= target) return null;
  if (today <= start.date) return round(start.amount, currency);
  if (today >= targetDate || targetDate <= start.date) return target;
  const share = daysBetween(start.date, today) / daysBetween(start.date, targetDate);
  return round(start.amount + (target - start.amount) * share, currency);
}
