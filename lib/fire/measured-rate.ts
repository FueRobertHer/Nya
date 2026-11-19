// lib/fire/measured-rate.ts
//
// An account's own rate of return, said on its level in the Plan's Invested
// assets (components/PlanBuckets.tsx) beside its Growth after inflation: a
// guide, which only its Use button puts in. Pure: the level loads, this counts.
//
// Counted as Accounts > Investments counts it (lib/growth-summary.ts
// summarizeGrowth), on its balance history joined to a brokerage's months
// (lib/investment-months.ts withPastMonths), so the two never disagree:
// money-weighted, over the longest of 5Y, 3Y and 1Y the account offers.
//   - Past a year the rate is a year's (returnsRate gives it a year).
//   - 1Y's is a year's return only when the account is counted from the
//     range's start to its end (within LATE_START_DAYS): one whose record or
//     activity starts later in that year has a part year's return, never said
//     as a year's.
//   - All time is never used: short of months for every day, its figure is a
//     total return, which is not a year's.
// `since` is the day the rate counts from (an account whose activity starts
// after the range does is counted from then), and `to` its last day.

import { summarizeGrowth, type GrowthActivity, type GrowthAccount } from '@/lib/growth-summary';
import { withPastMonths } from '@/lib/investment-months';
import type { BalancePoint } from '@/lib/growth';
import type { RangeKey } from '@/lib/chart-range';

export type MeasuredRate =
  /** A year's rate, as a fraction (0.091 for 9.1%), from `since` to `to`. */
  | { kind: 'rate'; rate: number; since: string; to: string }
  /** Too little to give a year's rate: under a year counted, or no activity. */
  | { kind: 'none' }
  /** Its activity couldn't be read, so nothing can be said either way. */
  | { kind: 'failed' }
  /** Another request is making its first download. */
  | { kind: 'busy' };

/** Longest first. */
const RANGES: readonly RangeKey[] = ['5Y', '3Y', '1Y'];

/**
 * `points` is the account's whole balance history, oldest first;
 * `activity` its investment activity payload (app/api/investment-activity).
 * `currency` is checked against a brokerage's months (null: US dollars).
 */
export function measuredRate(points: readonly BalancePoint[], activity: GrowthActivity, currency: string | null): MeasuredRate {
  const past = withPastMonths(points, activity, activity.investment_months, currency);
  const account: GrowthAccount = {
    account_id: 'account',
    item_id: 'item',
    currency,
    activity: { state: 'ready', data: { ...activity, flows: past.flows, flows_from: past.flows_from, totals_from: past.totals_from } },
    points: past.points,
  };
  const offered = summarizeGrowth([account], null, null, false);
  const status = offered.groups[0]?.rows[0]?.status;
  if (status === 'failed') return { kind: 'failed' };
  if (status === 'busy') return { kind: 'busy' };
  for (const key of RANGES) {
    // summarizeGrowth opens on another range when the one picked isn't offered.
    if (!offered.ranges.includes(key)) continue;
    const row = summarizeGrowth([account], key, null, false).groups[0]?.rows[0];
    if (!row?.split || !row.rate) continue;
    const yearly = row.rate.annual || (key === '1Y' && row.from === null && row.to === null);
    if (!yearly || !Number.isFinite(row.rate.value)) continue;
    return { kind: 'rate', rate: row.rate.value, since: row.split.from, to: row.split.to };
  }
  return { kind: 'none' };
}

/** A rate after inflation, as the plan's own rates are: (1 + r) / (1 + i) - 1. */
export function afterInflation(rate: number, inflation: number): number {
  return (1 + rate) / (1 + inflation) - 1;
}
