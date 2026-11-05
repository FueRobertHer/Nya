// lib/fire/tax/mix.ts
//
// The mix at the start age: what each person holds in each bucket when the
// simulated retirement starts, from today's buckets (lib/fire/buckets-today.ts)
// and the walk to the start. One loop a year, in the walk's order
// (lib/fire/events.ts walkPath), so its total is the walk's balance, within a
// cent:
//   - money in at the year's start goes to taxable at full basis;
//   - a cost at the year's start comes from every bucket, by its share;
//   - everything grows at the plan's return, which is after inflation;
//   - the year's savings go by the split (lib/fire/savings-split.ts), and a year
//     whose saving is below zero takes it from every bucket, by its share.
//
// Cost basis and the Roth money that can be reached are in money of their day,
// so in today's dollars they shrink with inflation; new money comes in at full
// basis. Every start keeps its total and takes its proportions from this
// (the detailed model, T3); here it is only shown.
//
// Pure.

import type { TaxBucket } from '@/lib/allocation/buckets';
import { costIn, moneyInAt, savingsIn, type WalkChanges } from '../events';
import type { BucketsToday } from '../buckets-today';
import type { SplitShare } from '../savings-split';
import type { Owner } from '../tax-facts';

export type MixSlot = {
  owner: Owner;
  bucket: TaxBucket;
  value: number;
  /** Taxable only: what was paid for it, in today's dollars. */
  basis: number;
  /** Roth only: what can be taken out early, in today's dollars. */
  reachable: number;
};

const empty = (owner: Owner, bucket: TaxBucket): MixSlot => ({ owner, bucket, value: 0, basis: 0, reachable: 0 });

/** Today's buckets as slots, scaled to `assets`, the plan's figure, which may be
 *  the person's own. A basis not known counts as all gain, as a position with
 *  none does. With no accounts to go by, it is all taxable. */
export function mixToday(today: Pick<BucketsToday, 'groups' | 'roth' | 'total'>, assets: number): MixSlot[] {
  if (today.total <= 0) return assets > 0 ? [{ ...empty('you', 'taxable'), value: assets }] : [];
  const scale = assets / today.total;
  const slots = new Map<string, MixSlot>();
  for (const g of today.groups) {
    const bucket: TaxBucket = g.bucket === 'unclassified' ? 'tax-deferred' : g.bucket;
    for (const a of g.accounts) {
      const key = `${a.owner}:${bucket}`;
      const slot = slots.get(key) ?? empty(a.owner, bucket);
      slot.value += a.value * scale;
      if (bucket === 'taxable') slot.basis += (a.basis ?? 0) * scale;
      slots.set(key, slot);
    }
  }
  for (const r of today.roth) {
    const slot = slots.get(`${r.owner}:roth`);
    if (slot && r.amount !== null) slot.reachable = Math.min(r.amount, slot.value);
  }
  return [...slots.values()];
}

export type ProjectedMix = { slots: MixSlot[]; total: number };

const totalOf = (slots: Iterable<MixSlot>) => {
  let sum = 0;
  for (const s of slots) sum += s.value;
  return sum;
};

/** The mix `years` from now, or null where the walk can't get there (a cost it
 *  can't pay, or a saving below zero that would take it below zero). */
export function projectMix(today: readonly MixSlot[], args: { savings: number; split: readonly SplitShare[]; realReturn: number; inflation: number; walk: WalkChanges; years: number }): ProjectedMix | null {
  const { savings, split, realReturn, inflation, walk, years } = args;
  const slots = new Map<string, MixSlot>(today.map((s) => [`${s.owner}:${s.bucket}`, { ...s }]));
  const slotFor = (owner: Owner, bucket: TaxBucket) => {
    const key = `${owner}:${bucket}`;
    let slot = slots.get(key);
    if (!slot) {
      slot = empty(owner, bucket);
      slots.set(key, slot);
    }
    return slot;
  };
  /** Every bucket down by the same share. */
  const takeShare = (amount: number) => {
    const total = totalOf(slots.values());
    const keep = total > 0 ? 1 - amount / total : 0;
    for (const s of slots.values()) {
      s.value *= keep;
      s.basis *= keep;
      s.reachable *= keep;
    }
  };

  for (let k = 0; k < years; k++) {
    const moneyIn = moneyInAt(walk, k);
    if (moneyIn > 0) {
      const taxable = slotFor('you', 'taxable');
      taxable.value += moneyIn;
      taxable.basis += moneyIn;
    }
    const cost = costIn(walk, k);
    if (cost > 0) {
      if (cost > totalOf(slots.values()) + 1e-9) return null;
      takeShare(cost);
    }
    for (const s of slots.values()) {
      s.value *= 1 + realReturn;
      s.basis /= 1 + inflation;
      s.reachable = Math.min(s.reachable / (1 + inflation), s.value);
    }
    const saved = savingsIn(walk, savings, k);
    if (saved >= 0) {
      for (const share of split) {
        const slot = slotFor(share.owner, share.bucket);
        const amount = saved * share.share;
        slot.value += amount;
        if (share.bucket === 'taxable') slot.basis += amount;
        if (share.bucket === 'roth') slot.reachable += amount;
      }
    } else {
      if (totalOf(slots.values()) + saved < 0) return null;
      takeShare(-saved);
    }
  }
  return { slots: [...slots.values()], total: totalOf(slots.values()) };
}

/** Each bucket's share of the mix, largest first, without those that round to
 *  nothing. */
export function mixShares(mix: ProjectedMix): { bucket: TaxBucket; pct: number }[] {
  if (mix.total <= 0) return [];
  const by = new Map<TaxBucket, number>();
  for (const s of mix.slots) by.set(s.bucket, (by.get(s.bucket) ?? 0) + s.value);
  return [...by]
    .map(([bucket, value]) => ({ bucket, pct: Math.round((value / mix.total) * 100) }))
    .filter((s) => s.pct > 0)
    .sort((a, b) => b.pct - a.pct);
}
