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
 * A flow dated ON the start day is treated as already in the starting balance.
 * Snapshots are taken during the day, so that is a guess either way; this one
 * keeps a same-day contribution from being counted twice.
 */
export function contributionBaseline(
  points: BalancePoint[],
  flows: Flow[] | null | undefined,
  flowsFrom: string | null | undefined
): { date: string; value: number }[] | null {
  if (!flows || !flowsFrom) return null;
  const start = points.find((p) => !p.estimated && p.date >= flowsFrom);
  if (!start) return null;

  const sorted = [...flows].sort((a, b) => (a.date < b.date ? -1 : 1));
  const out: { date: string; value: number }[] = [];
  let added = 0;
  let next = 0;
  while (next < sorted.length && sorted[next].date <= start.date) next++;
  for (const p of points) {
    if (p.date < start.date) continue;
    while (next < sorted.length && sorted[next].date <= p.date) added += sorted[next++].amount;
    out.push({ date: p.date, value: Math.round((start.value + added) * 100) / 100 });
  }
  return out;
}
