// lib/fire/savings-split.ts
//
// Where a year's savings go, by bucket and person: each bucket grows at the
// plan's return with its share of them (lib/fire/tax/mix.ts). Measured from the
// last year's contributions per account; savings matched to no investment
// account go to taxable, and a child's account left out of the plan matches
// nothing (D7). With nothing measured, savings follow today's balances. An
// account in no bucket counts as tax-deferred (D8).
//
// The shares sum to 1. Pure.

import type { TaxBucket } from '@/lib/allocation/buckets';
import type { BucketGroup, BucketsToday } from './buckets-today';
import type { Owner } from './tax-facts';

export type SplitShare = { bucket: TaxBucket; owner: Owner; share: number };

export type SavingsSplit = {
  shares: SplitShare[];
  /** What the shares rest on: the last year's contributions, today's balances,
   *  or nothing to go by, when everything is taxable. */
  from: 'contributions' | 'balances' | 'none';
};

const taxBucket = (g: BucketGroup): TaxBucket => (g.bucket === 'unclassified' ? 'tax-deferred' : g.bucket);

/** The amounts by bucket and person, as shares of `whole`. */
function sharesOf(amounts: Map<string, SplitShare>, whole: number): SplitShare[] {
  return [...amounts.values()].map((s) => ({ ...s, share: s.share / whole }));
}

function adder() {
  const amounts = new Map<string, SplitShare>();
  return {
    amounts,
    add(bucket: TaxBucket, owner: Owner, amount: number) {
      const key = `${owner}:${bucket}`;
      const held = amounts.get(key);
      if (held) held.share += amount;
      else amounts.set(key, { bucket, owner, share: amount });
    },
  };
}

export function savingsSplit(today: Pick<BucketsToday, 'groups'>, savings: number | null): SavingsSplit {
  const measured = adder();
  let matched = 0;
  for (const g of today.groups) {
    for (const a of g.accounts) {
      if (a.contributions !== null && a.contributions > 0) {
        measured.add(taxBucket(g), a.owner, a.contributions);
        matched += a.contributions;
      }
    }
  }
  if (matched > 0) {
    const whole = savings !== null && savings > matched ? savings : matched;
    if (whole > matched) measured.add('taxable', 'you', whole - matched);
    return { shares: sharesOf(measured.amounts, whole), from: 'contributions' };
  }

  const held = adder();
  let total = 0;
  for (const g of today.groups) {
    for (const a of g.accounts) {
      if (a.value > 0) {
        held.add(taxBucket(g), a.owner, a.value);
        total += a.value;
      }
    }
  }
  if (total > 0) return { shares: sharesOf(held.amounts, total), from: 'balances' };
  return { shares: [{ bucket: 'taxable', owner: 'you', share: 1 }], from: 'none' };
}

/** A year's savings with each bucket's share as you chose them (null: measured). A
 *  bucket's share goes between its people as the measured split has them, else to
 *  you. Chosen shares of nothing are left out. */
export function chosenSplit(today: Pick<BucketsToday, 'groups'>, savings: number | null, chosen: readonly { bucket: TaxBucket; share: number }[] | null): SplitShare[] {
  const measured = savingsSplit(today, savings).shares;
  if (chosen === null) return measured;
  return chosen.flatMap(({ bucket, share }) => {
    if (!(share > 0)) return [];
    const inBucket = measured.filter((s) => s.bucket === bucket);
    const whole = inBucket.reduce((sum, s) => sum + s.share, 0);
    return whole > 0 ? inBucket.map((s) => ({ bucket, owner: s.owner, share: (share * s.share) / whole })) : [{ bucket, owner: 'you' as const, share }];
  });
}

/** The split by bucket alone, largest first, for the sheet's lines. */
export function byBucket(split: SavingsSplit): { bucket: TaxBucket; share: number }[] {
  const out = new Map<TaxBucket, number>();
  for (const s of split.shares) out.set(s.bucket, (out.get(s.bucket) ?? 0) + s.share);
  return [...out].map(([bucket, share]) => ({ bucket, share })).sort((a, b) => b.share - a.share);
}
