// lib/fire/bucket-growth.ts
//
// With accounts at their own rates (version 2's `accounts`), what each tax
// bucket grows at and what the taxable accounts pay out, for the detailed model
// (lib/fire/plan-detail.ts). The plan as a whole runs at its blend
// (lib/fire/account-growth.ts planGrowth); these say how that growth is shared
// between the buckets.
//
// A bucket's rate is worked out as the blend is, over the accounts in it: the
// plan's rate plus each one's difference from it, weighted by what it holds (a
// balance of zero or below weighs nothing), held within the rates it blends. A
// bucket with no account in it isn't said, and grows at the blend. Money in no
// bucket and a counted child's account grow as tax-deferred, as the mix counts
// them (lib/fire/tax/mix.ts): before the stop a 457(b) is in tax-deferred, from
// the stop on its own (lib/fire/tax/year.ts reads them apart), and a child's
// account is shared between the two as the year shares it (each person's
// `share457`).
//
// The taxable yield is worked out the same way, over the taxable accounts: an
// account's own yield, else the one typed in Assumptions, else what it paid over
// the last year, else what they paid together. With no taxable account at a
// yield of its own, it is that figure itself, to the bit.
//
// Nothing here applies with no account at its own rate: then the plan's figures
// are what they were before accounts had rates.
//
// Pure.

import type { TaxBucket } from '@/lib/allocation/buckets';
import type { Owner } from './tax-facts';
import type { BucketAccount, BucketsToday } from './buckets-today';
import type { AccountRate } from './plan';
import { MAX_RATE } from './tax-choices';
import type { YearGrowth } from './tax/year';

/** Each bucket's growth after inflation, where its accounts give one. */
export type BucketGrowth = {
  /** Before the stop, by the mix's buckets: tax-deferred holds a 457(b) and money
   *  in no bucket. */
  mix: Partial<Record<TaxBucket, number>>;
  /** From the stop on, by what a year holds: deferred holds a counted child's
   *  account too, as the year counts it. */
  year: Partial<YearGrowth>;
};

type Sum = { total: number; lift: number; low: number; high: number };

/** The blend over what was summed, held within the rates in it. */
const blendOf = (base: number, s: Sum) => Math.min(s.high, Math.max(s.low, base + s.lift / s.total));

function add(sums: Map<string, Sum>, key: string, w: number, r: number, base: number): void {
  const s = sums.get(key) ?? { total: 0, lift: 0, low: Infinity, high: -Infinity };
  s.total += w;
  s.lift += w * (r - base);
  s.low = Math.min(s.low, r);
  s.high = Math.max(s.high, r);
  sums.set(key, s);
}

/** By id, so the order accounts arrive in never moves a last digit. */
const byId = (accounts: readonly BucketAccount[]) => [...accounts].sort((a, b) => (a.account_id < b.account_id ? -1 : a.account_id > b.account_id ? 1 : 0));

const accountsOf = (groups: BucketsToday['groups']) =>
  byId(groups.flatMap((g) => g.accounts.map((a) => ({ ...a, bucket: g.bucket }))));

/** What each bucket grows at with the plan's accounts' own rates; null when no
 *  account above zero has one. `realReturn` is the plan's own rate, which an
 *  account without one grows at. `share457`: each person's share of
 *  tax-deferred money in a 457(b), which the year also takes of a counted
 *  child's account (lib/fire/tax/mix.ts peopleOf). */
export function bucketGrowth(plan: { realReturn: number; accounts?: readonly AccountRate[] }, groups: BucketsToday['groups'], share457: Readonly<Record<Owner, number>> = { you: 0, partner: 0 }): BucketGrowth | null {
  const own = new Map<string, number>();
  for (const x of plan.accounts ?? []) if (x.growth !== null) own.set(x.account_id, x.growth);
  if (own.size === 0) return null;
  const base = plan.realReturn;
  const mix = new Map<string, Sum>();
  const year = new Map<string, Sum>();
  let any = false;
  for (const a of accountsOf(groups)) {
    const w = Math.max(0, a.value);
    if (!(w > 0)) continue;
    const r = own.get(a.account_id) ?? base;
    any ||= own.has(a.account_id);
    const deferred = a.bucket === 'tax-deferred' || a.bucket === 'unclassified';
    add(mix, deferred ? 'tax-deferred' : a.bucket, w, r, base);
    if (a.bucket === 'education') {
      const s = Math.min(1, Math.max(0, share457[a.owner] ?? 0));
      if (s < 1) add(year, 'deferred', w * (1 - s), r, base);
      if (s > 0) add(year, 'deferred457', w * s, r, base);
    } else add(year, a.bucket === 'taxable' || a.bucket === 'roth' || a.bucket === 'hsa' ? a.bucket : deferred && a.subtype === '457b' ? 'deferred457' : 'deferred', w, r, base);
  }
  if (!any) return null;
  return {
    mix: Object.fromEntries([...mix].map(([k, s]) => [k, blendOf(base, s)])),
    year: Object.fromEntries([...year].map(([k, s]) => [k, blendOf(base, s)])),
  };
}

/** What a taxable account paid over the last year, as a share of it, where that
 *  can be read as a yield (components/plan-detailed.ts measuredYield reads the same). */
export function paidOf(a: Pick<BucketAccount, 'income' | 'value'>): number | null {
  return a.income !== null && a.value > 0 && a.income >= 0 && a.income / a.value <= MAX_RATE ? a.income / a.value : null;
}

/** The taxable accounts' yield, with their own: `base` (what the plan pays out
 *  without them) where no taxable account above zero has its own. `typed`: the
 *  one typed in Assumptions, which an account without its own takes; null, each
 *  takes what it paid, else `base`. */
export function planYield(plan: { accounts?: readonly AccountRate[] }, groups: BucketsToday['groups'], base: number, typed: number | null): number {
  const own = new Map<string, number>();
  for (const x of plan.accounts ?? []) if (x.yield !== null) own.set(x.account_id, x.yield);
  if (own.size === 0) return base;
  const sum: Sum = { total: 0, lift: 0, low: Infinity, high: -Infinity };
  let any = false;
  for (const a of byId(groups.filter((g) => g.bucket === 'taxable').flatMap((g) => g.accounts))) {
    const w = Math.max(0, a.value);
    if (!(w > 0)) continue;
    any ||= own.has(a.account_id);
    const r = own.get(a.account_id) ?? typed ?? paidOf(a) ?? base;
    sum.total += w;
    sum.lift += w * (r - base);
    sum.low = Math.min(sum.low, r);
    sum.high = Math.max(sum.high, r);
  }
  return any ? blendOf(base, sum) : base;
}
