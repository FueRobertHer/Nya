// lib/growth.ts
//
// Splits an investment account's balance change into money in, money out and
// growth, for the second line on its chart, the figures on its sheet, and
// Accounts > Investments, which adds up each account's range (rangeSplit).
//
// The line is the balance on a starting day plus every flow across the account
// boundary since (lib/investments.ts externalFlow: contributions, rollovers and
// transfers in; withdrawals out). What the balance has above it is growth:
// market movement and dividends, less fees.
//
// It starts at the first REAL point inside the flows window, never earlier. The
// backfilled region of an investment account's history is the current balance
// walked backward through those same flows with no market movement modelled
// (lib/backfill.ts), so growth measured across it would be a fiction the walk
// put there. Measured points only exist from the first snapshot on.
//
// MONEY IN AND OUT. With the totals the person gave for a day
// (lib/money-in-out.ts), the line is instead their net money in on each day:
// the totals, less what Nya saw move between that day and the totals' day,
// plus what moved after (moneyInOutOn). The gap above it is then growth since
// the account started, not since the line's first day. Each day's flows are
// already one net per day (lib/investments.ts dailyFlows), so a fund exchange
// booked as a transfer out and a transfer in on one day nets away: a day's
// net is money in when above zero, money out when below.
//
// MOVES. Money that leaves and comes back is neither: an exchange whose two
// legs land on different days, a sweep, a transfer between two of the
// person's investment accounts. Out and in of the same amount within
// MOVE_DAYS of each other is a move. In one account its legs are taken out of
// the flows where the activity is built (withoutMoves, lib/investment-
// activity.ts), so the line, its readout and the sheet's figures never see
// them. Between accounts each one's figures rightly show its leg, and Accounts
// > Investments' net has the two cancel out (lib/growth-summary.ts).
//
// Imports nothing but a pure date helper: the chart is a client component.

import { latestAsOf } from './money-in-out';

/** A balance on a day. `entered`: a month's ending balance from a file the
 *  person imported (lib/investment-months.ts), real, on the 1st of the next
 *  month: it holds every flow dated before that day. */
export type BalancePoint = { date: string; value: number; estimated?: boolean; entered?: boolean };
export type Flow = { date: string; amount: number };
/** A point on the line: its value, and the money in and out it holds, each
 *  zero or more. Without totals they count from the line's first day; with
 *  them, from the account's start, so only their changes between two points
 *  say what moved between them. */
export type BaselinePoint = { date: string; value: number; in: number; out: number };
/** What the person said was put in and taken out by the end of `as_of`. */
export type Totals = { in: number; out: number; as_of: string };

const cents = (n: number) => Math.round(n * 100) / 100;

/**
 * Whether the totals can be carried through the activity Nya has for the
 * account: their day must be one it has activity for (from `flowsFrom`), or
 * Nya can't take off what moved between the two, and not ahead of the
 * person's today. Checked on every read, since the activity's start can move
 * (an institution that keeps less history, a re-link to a new id).
 */
export function usableTotals(totals: Totals | null | undefined, flowsFrom: string | null | undefined, now: number = Date.now()): boolean {
  return !!totals && !!flowsFrom && totals.as_of >= flowsFrom && totals.as_of <= latestAsOf(now);
}

/**
 * The money in and out by the start of `day` (flows dated before it, as the
 * balance shows them, see contributionBaseline), carried from the totals:
 * what moved after their day is added, what moved from `day` to their day is
 * taken off. `flows` are the account's daily nets, every one inside the
 * activity the totals were checked against (usableTotals).
 */
export function moneyInOutOn(totals: Totals, flows: readonly Flow[], day: string): { in: number; out: number } {
  let inn = totals.in;
  let out = totals.out;
  for (const f of flows) {
    // Counted by the totals' day: f <= as_of. Counted by `day`: f < day.
    const byTotals = f.date <= totals.as_of;
    const byDay = f.date < day;
    if (byTotals === byDay) continue;
    const sign = byDay ? 1 : -1;
    if (f.amount > 0) inn += sign * f.amount;
    else out += sign * -f.amount;
  }
  return { in: cents(inn), out: cents(out) };
}

/**
 * The money in and out that moved after the totals' day and before `day`:
 * what the sheet says came "since" them.
 */
export function movedSince(totals: Totals, flows: readonly Flow[], day: string): { in: number; out: number } {
  let inn = 0;
  let out = 0;
  for (const f of flows) {
    if (f.date <= totals.as_of || f.date >= day) continue;
    if (f.amount > 0) inn += f.amount;
    else out -= f.amount;
  }
  return { in: cents(inn), out: cents(out) };
}

/**
 * The line for every point from its start on, or null when there's nothing
 * honest to draw: no flows (unavailable, or withheld because rows were
 * missing), or no real point inside their window.
 *
 * A flow counts from the day AFTER its date. The daily snapshot is taken at
 * 13:00 UTC, before US markets open, and investment balances usually update
 * overnight, so the snapshot on a flow's own date almost never includes it.
 * Counting it that same day would show "+$60,000 added, -$60,000 growth" for a
 * day and then snap back. The same rule means a flow dated on the start day is
 * counted, not assumed to be in the starting balance: an account opened by a
 * rollover would otherwise report the whole rollover as growth.
 *
 * The one place that rule can't be checked is BEFORE the start: a flow dated a
 * day or two earlier may or may not be in the starting balance yet, depending
 * on when the institution updated it. Guessing wrong books it as growth for the
 * life of the chart, not just for a day. So the start is the first real point
 * with no flow in the SETTLE_DAYS before it, where the starting balance is
 * unambiguous, and only falls back to the first real point when every candidate
 * has one (an account contributing every few days).
 *
 * Nor does it start between the two legs of a move (`moves`, from
 * withoutMoves): a move's legs are out of the flows, and a balance that
 * really dipped between them (money sent out and back) would read the
 * return as growth from such a start.
 *
 * With `totals` that can be carried (usableTotals) the value is the net money
 * in on each day instead (moneyInOutOn), from the same start: growth measured
 * across the estimated stretch would still be the walk's fiction.
 */
const SETTLE_DAYS = 3;

export function contributionBaseline(
  points: readonly BalancePoint[],
  flows: readonly Flow[] | null | undefined,
  flowsFrom: string | null | undefined,
  /** Last date the flows are known complete for. Past it a contribution may
   *  simply not be known yet, and would read as growth, so the line stops. */
  flowsTo?: string | null,
  totals?: Totals | null,
  /** The moves taken out of `flows` (withoutMoves). */
  moves?: readonly Move[] | null
): BaselinePoint[] | null {
  if (!flows || !flowsFrom) return null;
  if (flowsTo) points = points.filter((p) => p.date <= flowsTo);
  const sorted = [...flows].sort((a, b) => (a.date < b.date ? -1 : 1));
  const candidates = points.filter((p) => !p.estimated && p.date >= flowsFrom);
  if (candidates.length === 0) return null;
  const settled = (p: BalancePoint) => {
    const from = shiftDays(p.date, -SETTLE_DAYS);
    // A leg counts from the day after its date: from `date` on, one leg is
    // in the balance and the other isn't.
    if ((moves ?? []).some((m) => m.from < p.date && p.date <= m.to)) return false;
    // A month's ending balance holds every flow dated before its day, so
    // nothing just before it is in doubt (the snapshot's ambiguity).
    return !!p.entered || !sorted.some((f) => f.date >= from && f.date < p.date);
  };
  const start = candidates.find(settled) ?? candidates[0];
  const carried = usableTotals(totals, flowsFrom) ? totals : null;

  const out: BaselinePoint[] = [];
  // Money in and out since the start, or the totals carried to the start.
  const first = carried ? moneyInOutOn(carried, sorted, start.date) : { in: 0, out: 0 };
  let inn = first.in;
  let outs = first.out;
  let next = 0;
  while (next < sorted.length && sorted[next].date < start.date) next++;
  for (const p of points) {
    if (p.date < start.date) continue;
    while (next < sorted.length && sorted[next].date < p.date) {
      const a = sorted[next++].amount;
      if (a > 0) inn += a;
      else outs -= a;
    }
    const i = cents(inn);
    const o = cents(outs);
    out.push({ date: p.date, value: carried ? cents(i - o) : cents(start.value + i - o), in: i, out: o });
  }
  return out;
}

/** What moved over a range of an account's chart: money in, money out and
 *  growth from `from` to `to`, both real days on its grey line. */
export type RangeSplit = { from: string; to: string; in: number; out: number; growth: number };

/**
 * The account chart's readout for a range with nothing scrubbed
 * (components/NetWorthChart.tsx splitBetween, from the grey line's first day
 * to the last real day it reaches), for Accounts > Investments to add up across
 * accounts. `shown` is the range's points (lib/chart-range.ts sliceRange,
 * which ends on the account's own last point); the rest are
 * contributionBaseline's. Null where the chart has no split for the range:
 * no line in it.
 *
 * The line can start after the range does (its first real day inside the
 * activity, see contributionBaseline) and end before it (the last day the
 * activity is known to, or the last real day), so `from` and `to` say what
 * was counted.
 */
export function rangeSplit(
  shown: readonly BalancePoint[],
  flows: readonly Flow[] | null | undefined,
  flowsFrom: string | null | undefined,
  flowsTo?: string | null,
  totals?: Totals | null,
  moves?: readonly Move[] | null
): RangeSplit | null {
  const line = contributionBaseline(shown, flows, flowsFrom, flowsTo, totals, moves);
  if (!line || line.length === 0) return null;
  const real = new Map(shown.filter((p) => !p.estimated).map((p) => [p.date, p.value] as const));
  const start = line[0];
  const end = [...line].reverse().find((b) => real.has(b.date));
  // The line starts on a real day, so an end is always found; kept honest.
  if (!end || !real.has(start.date)) return null;
  return {
    from: start.date,
    to: end.date,
    in: cents(end.in - start.in),
    out: cents(end.out - start.out),
    growth: cents(real.get(end.date)! - real.get(start.date)! - (end.value - start.value)),
  };
}

/** A YYYY-MM-DD date moved by whole UTC days. */
function shiftDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

/** How many days apart money out and the same money in can be and still be
 *  one move: long enough for an exchange's buy to settle after its sell, or a
 *  transfer between institutions to arrive. */
export const MOVE_DAYS = 5;

/**
 * The legs that pair into moves: each money out with money in of the same
 * amount, to the cent, no more than MOVE_DAYS from it. Nearest first, so
 * of two candidates the closer one is the other leg; then the earlier.
 * Returns each pair's two indexes, out first.
 */
function pairMoves(legs: readonly Flow[]): [number, number][] {
  const ins = new Map<number, number[]>();
  legs.forEach((l, i) => {
    if (l.amount <= 0) return;
    const key = Math.round(l.amount * 100);
    (ins.get(key) ?? ins.set(key, []).get(key)!).push(i);
  });
  const dayOf = (d: string) => Math.round(Date.parse(`${d}T00:00:00Z`) / 86_400_000);
  const candidates: { out: number; inn: number; gap: number }[] = [];
  legs.forEach((l, out) => {
    if (l.amount >= 0) return;
    for (const inn of ins.get(Math.round(-l.amount * 100)) ?? []) {
      const gap = Math.abs(dayOf(legs[inn].date) - dayOf(l.date));
      if (gap <= MOVE_DAYS) candidates.push({ out, inn, gap });
    }
  });
  const first = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
  candidates.sort((a, b) => a.gap - b.gap || first(legs[a.out].date, legs[b.out].date) || first(legs[a.inn].date, legs[b.inn].date));
  const used = new Set<number>();
  const found: [number, number][] = [];
  for (const c of candidates) {
    if (used.has(c.out) || used.has(c.inn)) continue;
    used.add(c.out);
    used.add(c.inn);
    found.push([c.out, c.inn]);
  }
  return found;
}

/** A move inside one account: the days of its two legs, the earlier first. */
export type Move = { from: string; to: string };

/**
 * One account's daily flows without the moves inside it (see the header):
 * what's left is money that came in from outside its investments, or went
 * out of them. A leg whose other half is outside the flows' window stays.
 * The moves are kept as the days they span, so the line never starts
 * between two legs (contributionBaseline).
 */
export function withoutMoves(flows: readonly Flow[]): { flows: Flow[]; moves: Move[] } {
  const found = pairMoves(flows);
  const paired = new Set(found.flat());
  const moves = found
    .map(([out, inn]): Move => {
      const [from, to] = [flows[out].date, flows[inn].date].sort();
      return { from, to };
    })
    .sort((a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : a.to < b.to ? -1 : a.to > b.to ? 1 : 0));
  return { flows: flows.filter((_, i) => !paired.has(i)), moves };
}

/**
 * An account's all-time figures from its totals: money in, money out and the
 * net by the measuring day, and all-time returns, the balance less that net;
 * its sheet says what moved since the totals (`since`). Measured today on
 * the live balance while the activity is known to yesterday or later;
 * otherwise on the last recorded balance up to the day after the activity
 * ends (`to` names that day), since money that moved after it isn't known
 * yet. `growth` is null where there is no balance to measure.
 */
export function sinceStarted(
  totals: Totals,
  flows: readonly Flow[],
  flowsTo: string | null | undefined,
  balance: number | null | undefined,
  points: readonly BalancePoint[] | null,
  now: number = Date.now()
): { in: number; out: number; net: number; growth: number | null; to: string | null; since: { in: number; out: number } } {
  const today = new Date(now).toISOString().slice(0, 10);
  let day = today;
  let measured: number | null = balance ?? null;
  if (flowsTo && flowsTo < shiftDays(today, -1)) {
    const until = shiftDays(flowsTo, 1);
    const last = [...(points ?? [])].reverse().find((p) => !p.estimated && p.date <= until);
    day = last?.date ?? until;
    measured = last?.value ?? null;
  }
  const at = moneyInOutOn(totals, flows, day);
  const net = cents(at.in - at.out);
  return {
    ...at,
    net,
    growth: measured === null ? null : cents(measured - net),
    to: day === today ? null : day,
    since: movedSince(totals, flows, day),
  };
}

/** What Nya has seen go in from the start of its activity to the end of
 *  `day`: the floor under money in for that day, unless it is a net. */
export function seenIn(flows: readonly Flow[], day: string): number {
  return cents(flows.reduce((sum, f) => (f.date <= day && f.amount > 0 ? sum + f.amount : sum), 0));
}

/** The days' nets in the SETTLE_DAYS up to and including `day`, oldest
 *  first: money a brokerage's figures for that day may not show yet. */
export function movedNear(flows: readonly Flow[], day: string): Flow[] {
  const from = shiftDays(day, -(SETTLE_DAYS - 1));
  return flows.filter((f) => f.date >= from && f.date <= day).sort((a, b) => (a.date < b.date ? -1 : 1));
}
