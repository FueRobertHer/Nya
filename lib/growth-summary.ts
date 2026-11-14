// lib/growth-summary.ts
//
// Accounts > Investments' numbers (components/InvestmentGrowth.tsx), for the
// accounts chosen there: what they did over a range, together and each, for
// each currency on its own, never converted. Pure: the view loads, this
// counts, and the view says it.
//
// FOUR FIGURES, as a brokerage gives them: Beginning balance, Deposits &
// withdrawals (one net figure, below zero when more came out), Investment
// returns and Ending balance, which add up. Each account is counted by its
// own chart's rule (lib/growth.ts rangeSplit): from the first recorded day
// of the range that its activity covers, to the last, so one whose record
// starts later is counted from then, its beginning balance its balance on
// that day. Money moved between the chosen accounts is a deposit to one and
// a withdrawal from the other, so it cancels out in the net; money moved from
// or to an account not chosen counts.
//
// ALL IS ALL TIME once every counted account has deposits and withdrawals
// Nya can carry (usableTotals) and a recorded day on its line, or OPENS: its
// line on All starts on the $0.00 a brokerage's months begin at, when it
// opened (lib/investment-months.ts withPastMonths), so the line is its
// deposits less withdrawals since then with no totals typed (unless they
// can't be read, which might say otherwise). The beginning balance is $0.00,
// when each account opened, the net is its line there (its deposits less
// withdrawals since it opened, carried from the totals or added up from the
// months), and the returns are its balance less that. Measured on the last
// recorded day its line reaches, as every range is, never the live balance,
// so the figure is the gap on the chart. Short of that, All counts from the
// first recorded day, as every other range does from its start. The rows
// follow the group's basis, so they add up to its figures.
//
// THE RATE OF RETURN is money-weighted over the range (lib/returns-rate.ts),
// each account a leg from its own first day. For all time only an account
// that opens with no totals carried has one, the months saying when each
// month's money went in, and the group only when every account does: typed
// totals don't say when the money before Nya's records went in, and can
// differ from the months' own sum.
//
// THE TOTAL RETURN stands in for all time's rate short of that (lib/returns-
// rate.ts totalReturn): the returns on every deposit since each account
// opened, the group's and each row's, so the rows give the same kind of
// figure as the group, never a rate beside it. An account's deposits are its
// line's money in on its last day: the totals carried, or from months each
// month's net when it is above zero (they give one net a month, so a month
// with money both in and out counts only what was left) and Nya's activity
// after. They add up across the accounts, so money moved between two of them
// counts as deposited in the one it went to.
//
// THE CHART (the hero's): the counted accounts' balances added up by day,
// from the first day every one of them has a balance, to the last day one is
// counted, and the grey line under them. Before an account is counted its
// balance is in both lines (estimated where its history is), so it adds no
// returns; from then its own grey line counts; after its last counted day it
// holds there, so the lines end on the Ending balance and the returns. Over
// a range the grey line is what they would be worth without returns; for
// all time it is their deposits less withdrawals since each opened, from the
// first day every one is counted.
//
// What it can't count is kept apart, never folded into a figure: an account
// whose activity is loading, couldn't be loaded or is still being fetched by
// another request; one with no investment activity at all; and one with
// nothing to count in the range chosen.

import { LATE_START_DAYS, availableRanges, initialRange, rangeLabel, rangeStart, type RangeKey } from './chart-range';
import { contributionBaseline, rangeSplit, usableTotals, type BalancePoint, type BaselinePoint, type Flow, type Move, type RangeSplit } from './growth';
import type { MoneyInOut } from './money-in-out';
import type { InvestmentMonths } from './investment-months';
import { returnsRate, totalReturn, type Rate, type RateLeg, type TotalReturn } from './returns-rate';

/** The note the activity carries while another request is making the
 *  account's first download (lib/investment-activity.ts): nothing is saved
 *  yet, so it isn't "no activity". */
export const ACTIVITY_STILL_LOADING = 'Investment activity is still loading';

/** The parts of an account's activity payload (app/api/investment-activity)
 *  this reads. */
export type GrowthActivity = {
  flows?: Flow[] | null;
  moves?: Move[] | null;
  flows_from?: string | null;
  flows_to?: string | null;
  /** The first day of Nya's own activity, which typed totals are checked
   *  against, when months imported from a file reach `flows_from` further
   *  back (lib/investment-months.ts withPastMonths); else `flows_from`. */
  totals_from?: string | null;
  note: string | null;
  txns?: readonly unknown[];
  money_in_out?: MoneyInOut | null;
  money_in_out_unreadable?: boolean;
  /** The months imported for the account, which the views join to its
   *  history before it is summed (lib/investment-months.ts). Not read here. */
  investment_months?: InvestmentMonths | null;
};

export type ActivityState = { state: 'loading' } | { state: 'failed' } | { state: 'ready'; data: GrowthActivity };

export type GrowthAccount = {
  account_id: string;
  item_id: string;
  currency: string | null;
  activity: ActivityState;
  /** Its balance history; null while the history loads. */
  points: BalancePoint[] | null;
};

/**
 * What an account's activity lets the view do with it:
 *   - loading: on its way;
 *   - failed: it couldn't be loaded, so a figure without it is short;
 *   - busy: another request is making its first download;
 *   - none: it has no investment activity at all;
 *   - counted: in the figures, whenever the range has a line for it.
 */
export type RowStatus = 'loading' | 'failed' | 'busy' | 'none' | 'counted';

/** Why an account's split starts or ends where it does: its own recorded
 *  days, the activity Nya has for it, or a brokerage's months: from their
 *  first month (`months`), from when it opened (`opened`, at $0.00), or
 *  from a month's end inside them, since they give one balance a month
 *  (`month-end`). */
export type Edge = { day: string; cause: 'recorded' | 'activity' | 'months' | 'opened' | 'month-end' };

export type TotalsState = 'set' | 'unset' | 'outdated' | 'unreadable';

/** Beginning balance, Deposits & withdrawals, Investment returns and Ending
 *  balance: begin + dw + returns = end. */
export type Figures = { begin: number; dw: number; returns: number; end: number };

/** What a group's figures count: the range from its start, or all time from
 *  the totals (see the header). */
export type Basis = 'range' | 'all';

export type GrowthRow<A extends GrowthAccount = GrowthAccount> = {
  account: A;
  status: RowStatus;
  /** The range's money in, out and growth; null when it isn't counted or the
   *  range has no line for it. */
  split: RangeSplit | null;
  /** Said only when it counts from well after the range starts (more than
   *  LATE_START_DAYS), or, on All, after the others in its currency. */
  from: Edge | null;
  /** Said only when it stops more than a day before the latest day. */
  to: Edge | null;
  /** Its totals, for an account that is counted. */
  totals: TotalsState | null;
  /** Its figures on the group's basis; null when it has none. */
  figures: Figures | null;
  /** Its rate of return over the range (for all time only when it, and every
   *  other account in its group, opens with no totals carried, see the
   *  header). */
  rate: Rate | null;
  /** Its total return for all time, when its group has one (see the
   *  header); null with nothing deposited. */
  total: TotalReturn | null;
};

/** The hero's chart: the balances added up by day, and the grey line, which
 *  may start later (all time) but has a point on each of its days. */
export type GrowthChart = { points: BalancePoint[]; baseline: BaselinePoint[] };

export type CurrencyGroup<A extends GrowthAccount = GrowthAccount> = {
  /** The currency added up, US dollars for an account that names none. */
  currency: string;
  rows: GrowthRow<A>[];
  /** Some of it is still on its way: no figures yet. */
  loading: boolean;
  basis: Basis;
  /** Across the counted accounts, or null while loading or with nothing to
   *  count. */
  figures: Figures | null;
  rate: Rate | null;
  /** For all time without a rate, the total return (see the header); null
   *  with nothing deposited. */
  total: TotalReturn | null;
  /** The days the figures count, from the earliest account's first to the
   *  latest one's last. */
  span: { from: string; to: string } | null;
  /** The first day any of its accounts has recorded. */
  firstRecorded: string | null;
  /** Its chart, or null with fewer than two days to draw. */
  chart: GrowthChart | null;
  /** Accounts the figures are short of. */
  failed: GrowthRow<A>[];
  busy: GrowthRow<A>[];
  /** Counted accounts with nothing to count in this range. */
  uncounted: GrowthRow<A>[];
  /** Counted accounts with a line whose totals aren't set, or are set for a
   *  day before the activity Nya now has: All isn't all time without them. */
  missing: GrowthRow<A>[];
  /** Counted accounts with a line whose totals couldn't be read. */
  unreadable: GrowthRow<A>[];
};

export type GrowthSummary<A extends GrowthAccount = GrowthAccount> = {
  ranges: RangeKey[];
  range: RangeKey;
  /** What the range covers, in words ("Year to date", "Since Jul 12"); empty
   *  with no history at all. */
  label: string;
  groups: CurrencyGroup<A>[];
};

const DAY_MS = 86_400_000;
const parse = (d: string) => Date.parse(`${d}T00:00:00Z`);
const daysBetween = (a: string, b: string) => Math.round((parse(b) - parse(a)) / DAY_MS);
const shiftDays = (d: string, n: number) => new Date(parse(d) + n * DAY_MS).toISOString().slice(0, 10);
const cents = (n: number) => Math.round(n * 100) / 100;

function statusOf(activity: ActivityState): RowStatus {
  if (activity.state !== 'ready') return activity.state;
  const a = activity.data;
  if (a.flows && a.flows_from) return 'counted';
  if (a.note?.includes(ACTIVITY_STILL_LOADING)) return 'busy';
  // A fetch that failed with nothing saved, or rows Nya can't vouch for yet:
  // either way the figures are short of it.
  if (a.note || (a.txns?.length ?? 0) > 0) return 'failed';
  return 'none';
}

function totalsOf(a: GrowthActivity): TotalsState {
  if (a.money_in_out_unreadable) return 'unreadable';
  if (!a.money_in_out) return 'unset';
  return usableTotals(a.money_in_out, a.totals_from ?? a.flows_from) ? 'set' : 'outdated';
}

/** Why a split starts on `from`: a brokerage's month (its first, from
 *  $0.00: when it opened; a later one: a month's end), a day Nya recorded
 *  before it in `shown` (its activity starts later), or its first recorded
 *  day. `points` is the account's whole history. */
function startCause(shown: readonly BalancePoint[], points: readonly BalancePoint[], from: string): Edge['cause'] {
  const at = shown.find((p) => p.date === from);
  if (at?.entered) {
    if (points.some((p) => p.entered && p.date < from)) return 'month-end';
    return at.value === 0 ? 'opened' : 'months';
  }
  return shown.some((p) => !p.estimated && p.date < from) ? 'activity' : 'recorded';
}

const add = (rows: readonly Figures[]): Figures => {
  const total = (k: keyof Figures) => cents(rows.reduce((t, f) => t + f[k], 0));
  return { begin: total('begin'), dw: total('dw'), returns: total('returns'), end: total('end') };
};

/** A counted account's line over the range: on each recorded day from its
 *  first to its last, its balance and its grey line there (carried from the
 *  totals when it has them, so then its deposits less withdrawals since it
 *  opened), with the money in and out the line holds. */
type Track = { date: string; balance: number; line: number; in: number; out: number; entered?: boolean }[];

/**
 * The view's figures for `accounts` (those chosen, in the order the tab
 * lists them) over the range picked, or the one it opens on.
 * `historyLoading`: the balance histories are still on their way (each
 * account's `points` is null then).
 */
export function summarizeGrowth<A extends GrowthAccount>(
  accounts: readonly A[],
  picked: RangeKey | null,
  main: string | null,
  historyLoading: boolean
): GrowthSummary<A> {
  // The ranges are offered as each account's chart offers them, over every
  // day any of them has recorded: one account with five years makes 5Y worth
  // having. Recorded, not estimated: the figures count only from a recorded
  // day (contributionBaseline), so a range reaching back into estimates
  // would be counted from where the record starts, under a name ("Year to
  // date") for days it never counted.
  const days = [...new Set(accounts.flatMap((a) => (a.points ?? []).flatMap((p) => (p.estimated ? [] : [p.date]))))]
    .sort()
    .map((date) => ({ date }));
  const last = days.length ? days[days.length - 1].date : null;
  const ranges = availableRanges(days, 'investment');
  const range = picked && ranges.includes(picked) ? picked : last ? initialRange(ranges, 'investment', last) : 'ALL';
  const start = last ? rangeStart(range, last) : null;
  const firstShown = days.find((d) => start === null || d.date >= start)?.date ?? null;
  const label = last && firstShown ? rangeLabel(range, firstShown, last) : '';

  // Each counted account's line over the range, for its figures, its rate
  // and the chart.
  const tracks = new Map<GrowthRow<A>, Track>();
  // On All, those whose line starts on a brokerage's $0.00 (see the header).
  const opening = new Set<GrowthRow<A>>();

  const rows: GrowthRow<A>[] = accounts.map((account) => {
    const status = statusOf(account.activity);
    const row: GrowthRow<A> = { account, status, split: null, from: null, to: null, totals: null, figures: null, rate: null, total: null };
    if (status !== 'counted' || account.activity.state !== 'ready') return row;
    const a = account.activity.data;
    row.totals = totalsOf(a);
    // Only totals Nya can carry: checked against its own activity, which
    // months from a file can reach before.
    const totals = row.totals === 'set' ? (a.money_in_out ?? null) : null;
    if (!account.points) return row;
    // Its range ends on its own last day, as on its sheet, unless that day is
    // before the view's range starts: then it has nothing in this range. It
    // starts where the view's does: one whose history stopped early would
    // count from before it on its own sheet, which goes back from its own
    // last day. For every other account the two are the same days.
    const own = account.points[account.points.length - 1]?.date;
    if (!own || (start !== null && own < start)) return row;
    const shown = start === null ? account.points : account.points.filter((p) => p.date >= start);
    row.split = rangeSplit(shown, a.flows, a.flows_from, a.flows_to, totals, a.moves);
    if (!row.split) return row;
    const split = row.split;
    // The same line rangeSplit reads, on its recorded days.
    const real = new Map(shown.filter((p) => !p.estimated).map((p) => [p.date, p] as const));
    const line = contributionBaseline(shown, a.flows, a.flows_from, a.flows_to, totals, a.moves) ?? [];
    tracks.set(
      row,
      line
        .filter((b) => b.date <= split.to && real.has(b.date))
        .map((b) => {
          const p = real.get(b.date)!;
          return { date: b.date, balance: p.value, line: b.value, in: b.in, out: b.out, ...(p.entered ? { entered: true } : {}) };
        })
    );
    const track = tracks.get(row)!;
    if (start === null && track[0]?.entered && track[0].balance === 0) opening.add(row);
    if (start !== null && daysBetween(start, split.from) > LATE_START_DAYS) {
      row.from = { day: split.from, cause: startCause(shown, account.points, split.from) };
    }
    if (last && split.to < shiftDays(last, -1)) {
      const lastReal = [...shown].reverse().find((p) => !p.estimated);
      row.to = { day: split.to, cause: lastReal && lastReal.date > split.to ? 'activity' : 'recorded' };
    }
    return row;
  });

  const byCurrency = new Map<string, GrowthRow<A>[]>();
  for (const r of rows) {
    const code = r.account.currency ?? 'USD';
    byCurrency.set(code, [...(byCurrency.get(code) ?? []), r]);
  }
  const home = main ?? null;
  const order = [...byCurrency.keys()].sort((x, y) => {
    if (x === home) return -1;
    if (y === home) return 1;
    return byCurrency.get(y)!.length - byCurrency.get(x)!.length || (x < y ? -1 : 1);
  });

  const groups = order.map((currency): CurrencyGroup<A> => {
    const list = byCurrency.get(currency)!;
    // On All each account counts from its own start: one well after the
    // earliest in its currency is said, as a late start is on a range.
    if (start === null) {
      const froms = list.flatMap((r) => (r.split ? [r.split.from] : []));
      const earliest = froms.length ? froms.reduce((m, d) => (d < m ? d : m)) : null;
      for (const r of list) {
        if (!r.split || !earliest || daysBetween(earliest, r.split.from) <= LATE_START_DAYS) continue;
        r.from = { day: r.split.from, cause: startCause(r.account.points ?? [], r.account.points ?? [], r.split.from) };
      }
    }
    const loading = historyLoading || list.some((r) => r.status === 'loading');
    const counted = list.filter((r) => r.status === 'counted');
    const failed = list.filter((r) => r.status === 'failed');
    const busy = list.filter((r) => r.status === 'busy');
    // All time: every account with a line has it as its deposits less
    // withdrawals since it opened (its totals carried, or it opens), with a
    // recorded day. One with no line adds nothing either way, and is said as
    // not counted.
    const lined = counted.filter((r) => r.split);
    const opens = (r: GrowthRow<A>) => opening.has(r) && r.totals !== 'unreadable';
    const whole =
      range === 'ALL' &&
      !loading &&
      failed.length === 0 &&
      busy.length === 0 &&
      lined.length > 0 &&
      lined.every((r) => (r.totals === 'set' || opens(r)) && (tracks.get(r)?.length ?? 0) > 0);
    const basis: Basis = whole ? 'all' : 'range';
    // Its rate for all time: from the months alone, with no totals carried.
    const timed = (r: GrowthRow<A>) => opens(r) && r.totals !== 'set';
    // All time has a rate only when every account is timed; short of that, a
    // total return instead, for the group and each row alike.
    const yearly = !whole || lined.every(timed);
    // Each row's deposits since it opened, for the total return.
    const deposited = new Map<GrowthRow<A>, number>();

    const legs: RateLeg[] = [];
    if (!loading) {
      for (const r of counted) {
        const t = tracks.get(r);
        if (!r.split || !t || t.length === 0) continue;
        const first = t[0];
        const end = t[t.length - 1];
        if (whole) {
          r.figures = { begin: 0, dw: end.line, returns: cents(end.balance - end.line), end: end.balance };
          if (!yearly) {
            deposited.set(r, end.in);
            r.total = totalReturn(r.figures.returns, end.in);
          }
          if (!timed(r) || !yearly) continue;
        } else r.figures = { begin: first.balance, dw: cents(r.split.in - r.split.out), returns: r.split.growth, end: end.balance };
        const split = r.split;
        const all = r.account.activity.state === 'ready' ? (r.account.activity.data.flows ?? []) : [];
        const leg: RateLeg = { from: split.from, to: split.to, begin: first.balance, end: end.balance, flows: all.filter((f) => f.date >= split.from && f.date < split.to) };
        legs.push(leg);
        r.rate = returnsRate([leg]);
      }
    }
    const shown = counted.filter((r) => r.figures);
    const froms = shown.map((r) => r.split!.from).sort();
    const tos = shown.map((r) => r.split!.to).sort();
    // Recorded by Nya: not estimated, and not a month from a file.
    const recorded = list.flatMap((r) => (r.account.points ?? []).flatMap((p) => (p.estimated || p.entered ? [] : [p.date]))).sort();
    const figures = shown.length > 0 ? add(shown.map((r) => r.figures!)) : null;
    const allIn = cents(shown.reduce((t, r) => t + (deposited.get(r) ?? 0), 0));
    return {
      currency,
      rows: list,
      loading,
      basis,
      figures,
      rate: yearly ? returnsRate(legs) : null,
      total: !yearly && figures ? totalReturn(figures.returns, allIn) : null,
      span: shown.length > 0 ? { from: froms[0], to: tos[tos.length - 1] } : null,
      firstRecorded: recorded[0] ?? null,
      chart: shown.length > 0 ? chartOf(shown, tracks, basis, start) : null,
      failed,
      busy,
      uncounted: loading ? [] : counted.filter((r) => !r.split),
      // One that opens needs none.
      missing: lined.filter((r) => (r.totals === 'unset' || r.totals === 'outdated') && !opens(r)),
      unreadable: lined.filter((r) => r.totals === 'unreadable'),
    };
  });

  return { ranges, range, label, groups };
}

/**
 * The hero's chart for the counted rows (see the header): their balances
 * added up on every day any of them has one in the range, from the first day
 * all of them do to the last day one is counted, with the grey line under them. A day
 * an account has no balance of its own, inside the days it is drawn from its
 * history, takes the one before and is marked estimated, as a day with no
 * data is on any chart; after its last counted day it holds there, said in
 * words instead (the row's `to`).
 */
function chartOf<A extends GrowthAccount>(
  rows: readonly GrowthRow<A>[],
  tracks: Map<GrowthRow<A>, Track>,
  basis: Basis,
  start: string | null
): GrowthChart | null {
  const each = rows.map((r) => ({ points: r.account.points ?? [], track: tracks.get(r) ?? [], split: r.split! }));
  if (each.some((e) => e.points.length === 0 || e.track.length === 0)) return null;
  // From the range's start, or the first day every account has a balance
  // when that is later.
  const latest = each.reduce((m, e) => (e.points[0].date > m ? e.points[0].date : m), each[0].points[0].date);
  const from = start !== null && start > latest ? start : latest;
  const to = each.reduce((m, e) => (e.split.to > m ? e.split.to : m), each[0].split.to);
  const dates = [...new Set(each.flatMap((e) => e.points.map((p) => p.date)))].filter((d) => d >= from && d <= to).sort();
  if (dates.length < 2) return null;
  const atPoint = each.map(() => 0);
  const atTrack = each.map(() => -1);
  const points: BalancePoint[] = [];
  const baseline: BaselinePoint[] = [];
  for (const date of dates) {
    let value = 0;
    let base: number | null = 0;
    let inn = 0;
    let out = 0;
    let estimated = false;
    // A month's end from a file, where every account has its own balance
    // that day: drawn solid however far from the next (components/
    // NetWorthChart.tsx).
    let entered = false;
    each.forEach((e, k) => {
      const { track, split } = e;
      while (atTrack[k] + 1 < track.length && track[atTrack[k] + 1].date <= date) atTrack[k]++;
      if (date >= split.from) {
        // Counted: its own line, or where it stopped.
        const t = track[atTrack[k]];
        const first = track[0];
        if (t.date !== date && date <= split.to) estimated = true;
        if (t.date === date && t.entered) entered = true;
        value += t.balance;
        inn += t.in - first.in;
        out += t.out - first.out;
        // Over a range: its balance less the returns counted on it by then,
        // which is its first balance and the line's change since. For all
        // time: its deposits less withdrawals since it opened.
        if (base !== null) base += basis === 'all' ? t.line : first.balance + (t.line - first.line);
        return;
      }
      // Not counted yet: its balance, in both lines over a range, and no
      // grey line for all time.
      while (atPoint[k] + 1 < e.points.length && e.points[atPoint[k] + 1].date <= date) atPoint[k]++;
      const p = e.points[atPoint[k]];
      if (p.estimated || p.date !== date) estimated = true;
      if (p.date === date && p.entered) entered = true;
      value += p.value;
      if (basis === 'all') base = null;
      else if (base !== null) base += p.value;
    });
    points.push(estimated ? { date, value: cents(value), estimated: true } : entered ? { date, value: cents(value), entered: true } : { date, value: cents(value) });
    if (base !== null) baseline.push({ date, value: cents(base), in: cents(inn), out: cents(out) });
  }
  return { points, baseline };
}
