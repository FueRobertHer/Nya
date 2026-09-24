// lib/growth.ts
//
// Splits an investment account's balance change into money added and growth,
// for the second line on its chart.
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
// Imports nothing: the chart is a client component.

export type BalancePoint = { date: string; value: number; estimated?: boolean };
export type Flow = { date: string; amount: number };

/**
 * The balance at the start plus net money added since, for every point from the
 * start on. Null when there's nothing honest to draw: no flows (unavailable, or
 * withheld because rows were missing), or no real point inside their window.
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
 */
const SETTLE_DAYS = 3;

export function contributionBaseline(
  points: BalancePoint[],
  flows: Flow[] | null | undefined,
  flowsFrom: string | null | undefined,
  /** Last date the flows are known complete for. Past it a contribution may
   *  simply not be known yet, and would read as growth, so the line stops. */
  flowsTo?: string | null
): { date: string; value: number }[] | null {
  if (!flows || !flowsFrom) return null;
  if (flowsTo) points = points.filter((p) => p.date <= flowsTo);
  const sorted = [...flows].sort((a, b) => (a.date < b.date ? -1 : 1));
  const candidates = points.filter((p) => !p.estimated && p.date >= flowsFrom);
  if (candidates.length === 0) return null;
  const settled = (date: string) => {
    const from = shiftDays(date, -SETTLE_DAYS);
    return !sorted.some((f) => f.date >= from && f.date < date);
  };
  const start = candidates.find((p) => settled(p.date)) ?? candidates[0];

  const out: { date: string; value: number }[] = [];
  let added = 0;
  let next = 0;
  while (next < sorted.length && sorted[next].date < start.date) next++;
  for (const p of points) {
    if (p.date < start.date) continue;
    while (next < sorted.length && sorted[next].date < p.date) added += sorted[next++].amount;
    out.push({ date: p.date, value: Math.round((start.value + added) * 100) / 100 });
  }
  return out;
}

/** A YYYY-MM-DD date moved by whole UTC days. */
function shiftDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}
