// lib/growth-summary.ts
//
// Accounts > Summary's numbers (components/InvestmentGrowth.tsx): each linked
// investment account's money in, money out and growth over a range, by its own
// chart's rule (lib/growth.ts rangeSplit), added up for each currency on its
// own, never converted; and Since you started for a currency once every
// account in it has totals Nya can carry (sinceStarted). Money one account
// sent another is a move, not money in or out across them: it is taken off
// the totals (movedBetween), not off the rows, which keep their own sheet's
// figures. Pure: the card loads, this counts, and the card says it.
//
// What it can't count is kept apart, never folded into a figure: an account
// whose activity is loading, couldn't be loaded or is still being fetched by
// another request; one with no investment activity at all; and one with
// nothing to count in the range chosen.

import { LATE_START_DAYS, availableRanges, initialRange, rangeLabel, rangeStart, type RangeKey } from './chart-range';
import { movedBetween, rangeSplit, sinceStarted, usableTotals, type BalancePoint, type Flow, type Move, type RangeSplit } from './growth';
import type { MoneyInOut } from './money-in-out';

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
  note: string | null;
  txns?: readonly unknown[];
  money_in_out?: MoneyInOut | null;
  money_in_out_unreadable?: boolean;
};

export type ActivityState = { state: 'loading' } | { state: 'failed' } | { state: 'ready'; data: GrowthActivity };

export type GrowthAccount = {
  account_id: string;
  item_id: string;
  currency: string | null;
  /** The live balance. */
  balance: number | null;
  activity: ActivityState;
  /** Its balance history; null while the history loads. */
  points: BalancePoint[] | null;
};

/**
 * What an account's activity lets the card do with it:
 *   - loading: on its way;
 *   - failed: it couldn't be loaded, so a figure without it is short;
 *   - busy: another request is making its first download;
 *   - none: it has no investment activity at all;
 *   - counted: in the figures, whenever the range has a line for it.
 */
export type RowStatus = 'loading' | 'failed' | 'busy' | 'none' | 'counted';

/** Why an account's split starts or ends where it does: its own recorded
 *  days, or the activity Nya has for it. */
export type Edge = { day: string; cause: 'recorded' | 'activity' };

export type TotalsState = 'set' | 'unset' | 'outdated' | 'unreadable';

export type Since = { in: number; out: number; net: number; growth: number | null; to: string | null };

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
  /** Its Since you started figures, when its totals can be carried. */
  since: Since | null;
  /** The last day its activity is known to. */
  flowsTo: string | null;
};

export type Figures = { in: number; out: number; net: number; growth: number };

export type CurrencyGroup<A extends GrowthAccount = GrowthAccount> = {
  /** The currency added up, US dollars for an account that names none. */
  currency: string;
  rows: GrowthRow<A>[];
  /** Some of it is still on its way: no figures yet. */
  loading: boolean;
  /** The range's figures across the counted accounts, or null while loading
   *  or with nothing to count. */
  figures: Figures | null;
  /** What moved between these accounts in the range: taken off the figures'
   *  money in and money out alike, so their net is the rows'. */
  moved: number;
  /** Accounts the figures are short of. */
  failed: GrowthRow<A>[];
  busy: GrowthRow<A>[];
  /** Counted accounts with nothing to count in this range. */
  uncounted: GrowthRow<A>[];
  /** Since you started across the counted accounts, once every one has
   *  totals that can be carried and a balance to measure. */
  since: Figures | null;
  /** What moved between these accounts after each one's totals' day: taken
   *  off Since you started as `moved` is off the range's figures. */
  sinceMoved: number;
  /** Counted accounts whose totals aren't set, or are set for a day before
   *  the activity Nya now has. */
  missing: GrowthRow<A>[];
  /** Counted accounts whose totals couldn't be read. */
  unreadable: GrowthRow<A>[];
  /** Counted accounts whose totals are set but which have no balance to
   *  measure growth so far by just now: no live balance, or, for one whose
   *  activity stops early, no recorded day at its end. */
  unmeasured: GrowthRow<A>[];
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
  return usableTotals(a.money_in_out, a.flows_from) ? 'set' : 'outdated';
}

/** The rows added up, less what moved between them, off money in and money
 *  out alike. */
const sum = (rows: readonly { in: number; out: number; growth: number }[], moved = 0): Figures => {
  const inn = cents(rows.reduce((t, r) => t + r.in, 0) - moved);
  const out = cents(rows.reduce((t, r) => t + r.out, 0) - moved);
  return { in: inn, out, net: cents(inn - out), growth: cents(rows.reduce((t, r) => t + r.growth, 0)) };
};

/** The flows dated from `from` up to, not including, `to`: those a stretch
 *  between two points counts (a flow counts from the day after its date). */
const between = (flows: readonly Flow[], from: string, to: string) => flows.filter((f) => f.date >= from && f.date < to);

/**
 * The card's figures for `accounts` (in the order the tab lists them) over
 * the range picked, or the one it opens on. `historyLoading`: the balance
 * histories are still on their way (each account's `points` is null then).
 */
export function summarizeGrowth<A extends GrowthAccount>(
  accounts: readonly A[],
  picked: RangeKey | null,
  main: string | null,
  historyLoading: boolean,
  now: number = Date.now()
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
  const today = new Date(now).toISOString().slice(0, 10);
  // Each counted account's flows inside what its figures count, for the
  // moves between accounts: the range's split, and since its totals' day.
  const rangeFlows = new Map<GrowthRow<A>, Flow[]>();
  const sinceFlows = new Map<GrowthRow<A>, Flow[]>();
  const last = days.length ? days[days.length - 1].date : null;
  const ranges = availableRanges(days, 'investment');
  const range = picked && ranges.includes(picked) ? picked : last ? initialRange(ranges, 'investment', last) : 'ALL';
  const start = last ? rangeStart(range, last) : null;
  const firstShown = days.find((d) => start === null || d.date >= start)?.date ?? null;
  const label = last && firstShown ? rangeLabel(range, firstShown, last) : '';

  const rows: GrowthRow<A>[] = accounts.map((account) => {
    const status = statusOf(account.activity);
    const row: GrowthRow<A> = { account, status, split: null, from: null, to: null, totals: null, since: null, flowsTo: null };
    if (status !== 'counted' || account.activity.state !== 'ready') return row;
    const a = account.activity.data;
    const totals = a.money_in_out ?? null;
    row.flowsTo = a.flows_to ?? null;
    row.totals = totalsOf(a);
    if (row.totals === 'set' && totals) {
      const s = sinceStarted(totals, a.flows!, a.flows_to, account.balance, account.points, now);
      row.since = { in: s.in, out: s.out, net: s.net, growth: s.growth, to: s.to };
      // What it adds to the totals: after their day, before the measuring one.
      sinceFlows.set(
        row,
        a.flows!.filter((f) => f.date > totals.as_of && f.date < (s.to ?? today))
      );
    }
    if (!account.points) return row;
    // Its range ends on its own last day, as on its sheet, unless that day is
    // before the card's range starts: then it has nothing in this range. It
    // starts where the card's does: one whose history stopped early would
    // count from before it on its own sheet, which goes back from its own
    // last day. For every other account the two are the same days.
    const own = account.points[account.points.length - 1]?.date;
    if (!own || (start !== null && own < start)) return row;
    const shown = start === null ? account.points : account.points.filter((p) => p.date >= start);
    row.split = rangeSplit(shown, a.flows, a.flows_from, a.flows_to, totals, a.moves);
    if (!row.split) return row;
    const split = row.split;
    rangeFlows.set(row, between(a.flows!, split.from, split.to));
    if (start !== null && daysBetween(start, split.from) > LATE_START_DAYS) {
      row.from = { day: split.from, cause: shown.some((p) => !p.estimated && p.date < split.from) ? 'activity' : 'recorded' };
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
        const shown = r.account.points ?? [];
        const from = r.split.from;
        r.from = { day: from, cause: shown.some((p) => !p.estimated && p.date < from) ? 'activity' : 'recorded' };
      }
    }
    const loading = historyLoading || list.some((r) => r.status === 'loading');
    const counted = list.filter((r) => r.status === 'counted');
    const split = counted.flatMap((r) => (r.split ? [r.split] : []));
    const failed = list.filter((r) => r.status === 'failed');
    const busy = list.filter((r) => r.status === 'busy');
    const ready =
      !loading &&
      failed.length === 0 &&
      busy.length === 0 &&
      counted.length > 0 &&
      counted.every((r) => r.totals === 'set' && r.since && r.since.growth !== null);
    const figures = !loading && split.length > 0;
    const moved = figures ? movedBetween(counted.map((r) => rangeFlows.get(r) ?? [])) : 0;
    const sinceMoved = ready ? movedBetween(counted.map((r) => sinceFlows.get(r) ?? [])) : 0;
    return {
      currency,
      rows: list,
      loading,
      figures: figures ? sum(split, moved) : null,
      moved,
      failed,
      busy,
      uncounted: loading ? [] : counted.filter((r) => !r.split),
      since: ready ? sum(counted.map((r) => ({ in: r.since!.in, out: r.since!.out, growth: r.since!.growth! })), sinceMoved) : null,
      sinceMoved,
      missing: counted.filter((r) => r.totals === 'unset' || r.totals === 'outdated'),
      unreadable: counted.filter((r) => r.totals === 'unreadable'),
      unmeasured: counted.filter((r) => r.totals === 'set' && r.since?.growth === null),
    };
  });

  return { ranges, range, label, groups };
}
