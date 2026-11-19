// lib/fire/account-growth.ts
//
// The growth after inflation a plan runs at on its steady path, before the stop
// and after it, from its accounts' own rates (version 2's `accounts`,
// lib/fire/plan-v2.ts): each counted account grows at its own rate, or the
// plan's `realReturn` where it has none, and the plan runs at their mean
// weighted by what each adds to invested assets (Measured.accounts, the
// accounts the measured figure sums). A balance of zero or below weighs nothing.
//
// Worked out as the plan's rate plus each account's difference from it,
// weighted, so with no account's own rate in play the answer is `realReturn`
// itself, to the bit (a plain weighted mean of equal rates can be off in its
// last place), and every figure stays as it was before accounts had rates. The
// answer is held within the rates it blends, which rounding could otherwise
// take a last digit past (past the plan's range, at its bound).
//
// The plan's rate stands, untouched, when invested assets are typed (no
// accounts make them up), when they aren't measured, when no counted account
// above zero has a rate of its own (an account since closed or hidden is kept
// and ignored), and when nothing counted is above zero.
//
// The stress test can move market history by the same rates (version 2's
// `historyMoved`): every year of it by the blend's gap from the plan's rate, in
// points added to the year (an account at 7% against the plan's 5% adds 2, so a
// -30% year is -28%), and with tax worked out each bucket by its own accounts'
// gap (lib/fire/bucket-growth.ts). The gap is worked out here, once a plan, from
// what the steady path runs at: so with no account at its own rate, or at the
// plan's, nothing moves, to the bit.
//
// Imports no data and no storage.

import type { AccountRate, FiView, Measured, PlanCore } from './plan';
import type { YearGrowth } from './tax/year';

/** The rate a plan runs at (see the top of this file), and how many counted
 *  accounts above zero grow at their own rate in it (0 where the plan's rate
 *  stands). */
export function planGrowth(plan: Pick<PlanCore, 'realReturn' | 'assets' | 'accounts'>, measured: Pick<Measured, 'assets' | 'unmeasured' | 'accounts'>): { growth: number; own: number } {
  const base = { growth: plan.realReturn, own: 0 };
  if (plan.assets !== null || measured.assets === null || measured.unmeasured?.includes('assets')) return base;
  const rates = new Map<string, number>();
  for (const x of plan.accounts ?? []) if (x.growth !== null) rates.set(x.account_id, x.growth);
  if (rates.size === 0) return base;
  // By id, so the order the accounts arrive in never moves the last digit.
  const counted = [...(measured.accounts ?? [])].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  let own = 0;
  let total = 0;
  let lift = 0;
  let low = Infinity;
  let high = -Infinity;
  for (const a of counted) {
    const w = Math.max(0, a.value);
    if (!(w > 0)) continue;
    total += w;
    const r = rates.get(a.id) ?? plan.realReturn;
    low = Math.min(low, r);
    high = Math.max(high, r);
    if (!rates.has(a.id)) continue;
    own++;
    lift += w * (r - plan.realReturn);
  }
  if (own === 0) return base;
  return { growth: Math.min(high, Math.max(low, plan.realReturn + lift / total)), own };
}

type Moved = Pick<PlanCore, 'realReturn' | 'historyMoved'>;
type Grows = Pick<FiView, 'growth' | 'ownRates'>;

/** What the stress test moves every year of history by (the run plan's
 *  `historyShift`): the blend's gap from the plan's rate, with history moved and
 *  an account at its own rate; null where nothing moves. */
export function historyShift(plan: Moved, view: Grows): number | null {
  if (!plan.historyMoved || view.ownRates === 0) return null;
  const gap = view.growth - plan.realReturn;
  return gap === 0 ? null : gap;
}

/** Each bucket's gap with tax worked out (SimTax's `historyShift`), from what it
 *  grows at on the steady years (bucketGrowth's `year`): a bucket not said takes
 *  the blend's, as it grows at the blend there. Null where nothing moves. */
export function bucketShift(plan: Moved, view: Grows, year: Partial<YearGrowth> | null | undefined): YearGrowth | null {
  if (!plan.historyMoved || view.ownRates === 0) return null;
  const at = (k: keyof YearGrowth) => (year?.[k] ?? view.growth) - plan.realReturn;
  const gaps: YearGrowth = { taxable: at('taxable'), deferred: at('deferred'), deferred457: at('deferred457'), roth: at('roth'), hsa: at('hsa') };
  return Object.values(gaps).every((g) => g === 0) ? null : gaps;
}

/** An account's own growth and dividends as a sheet holds them: a null is the
 *  plan's. */
export type OwnRates = { growth: number | null; yield: number | null };

/** A plan's accounts' own rates, by id: what a sheet starts from. */
export const ratesOf = (accounts: readonly AccountRate[] | undefined): Map<string, OwnRates> => new Map((accounts ?? []).map((x) => [x.account_id, { growth: x.growth, yield: x.yield }]));

/** The plan's accounts with their own rates as a sheet holds them (`rates`, by
 *  id, from ratesOf): none with neither, by id. Past `cap`
 *  (LIMITS.accountRates), the accounts `listed` now come before those since
 *  hidden or closed. Absent when none is left, as a plan stores it. */
export function withRates(rates: ReadonlyMap<string, OwnRates>, listed: ReadonlySet<string>, cap: number): AccountRate[] | undefined {
  const kept = [...rates].map(([account_id, r]) => ({ account_id, growth: r.growth, yield: r.yield })).filter((x) => x.growth !== null || x.yield !== null);
  const first = [...kept.filter((x) => listed.has(x.account_id)), ...kept.filter((x) => !listed.has(x.account_id))].slice(0, cap);
  const list = first.sort((a, b) => (a.account_id < b.account_id ? -1 : a.account_id > b.account_id ? 1 : 0));
  return list.length > 0 ? list : undefined;
}
