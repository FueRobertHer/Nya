// lib/fire/account-growth.ts
//
// The growth after inflation a plan runs at until its stop, from its accounts'
// own rates (version 2's `accounts`, lib/fire/plan-v2.ts): each counted
// account grows at its own rate, or the plan's `realReturn` where it has none,
// and the plan runs at their mean weighted by what each adds to invested assets
// (Measured.accounts, the accounts the measured figure sums). A balance below
// zero weighs nothing.
//
// Worked out as the plan's rate plus each account's difference from it,
// weighted, so with no account's own rate in play the answer is `realReturn`
// itself, to the bit (a plain weighted mean of equal rates can be off in its
// last place), and every figure stays as it was before accounts had rates.
//
// The plan's rate stands, untouched, when invested assets are typed (no
// accounts make them up), when they aren't measured, when no counted account
// has a rate of its own (an account since closed or hidden is kept and
// ignored), and when nothing counted is above zero.
//
// Imports no data and no storage.

import type { Measured, PlanCore } from './plan';

/** The rate a plan runs at until its stop (see the top of this file), and how
 *  many counted accounts grow at their own rate in it (0 where the plan's rate
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
  for (const a of counted) {
    const w = Math.max(0, a.value);
    total += w;
    const r = rates.get(a.id);
    if (r === undefined) continue;
    own++;
    lift += w * (r - plan.realReturn);
  }
  return own > 0 && total > 0 ? { growth: plan.realReturn + lift / total, own } : base;
}
