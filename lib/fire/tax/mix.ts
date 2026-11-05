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
// basis. Every start keeps its total and takes its proportions from this.
//
// In the detailed model (taxedMix), a year that can't pay for itself, its money
// in and saving less than its costs, sells what it is short by, in the order the
// years after you stop sell in (lib/fire/tax/year.ts), and pays the tax on that
// sale, no income and no health coverage counted, since a year still working has
// them from its work. The tax goes in the walk (WalkChanges.taxes), so it lowers
// the balance from then on. The sale is at the year's start and a saving arrives
// at its end, so the slots are scaled to the walk's balance, and the total still
// holds. A year that pays for itself goes as above: a cost its saving covers is
// by share, untaxed.
//
// Pure.

import type { TaxBucket } from '@/lib/allocation/buckets';
import { costIn, moneyInAt, savingsIn, shortBy, type WalkChanges } from '../events';
import type { BucketsToday } from '../buckets-today';
import type { SplitShare } from '../savings-split';
import type { Owner } from '../tax-facts';
import type { Filing, StateCode, TaxLaw } from './law/types';
import { checkYearInput, newPersonYear, newYearResult, runYear, type DrawOrder, type PersonYear, type YearInput, type YearResult } from './year';

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
 *  none does. With no accounts to go by, it is all taxable. An overdrawn account
 *  can take a bucket, or what was paid for it, below zero, which a year can't read:
 *  that slot is left out and the others come to `assets`, and a basis stops at 0. */
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
  const all = [...slots.values()];
  const held = all.filter((s) => s.value >= 0);
  const k = held.length < all.length ? assets / totalOf(held) : 1;
  for (const s of held) {
    s.value *= k;
    s.basis = Math.max(0, s.basis) * k;
    s.reachable *= k;
  }
  return held;
}

export type ProjectedMix = { slots: MixSlot[]; total: number };

/** The slots as the year's filers: on a joint return each their own, otherwise
 *  all on your return (the year reads its second person only on a joint one).
 *  A counted education account stands in as tax-deferred, as an account in no
 *  bucket does: the most taxed, the least reachable. */
export function peopleOf(slots: Iterable<MixSlot>, share457: Record<Owner, number>, joint: boolean): [PersonYear, PersonYear] {
  const people: [PersonYear, PersonYear] = [newPersonYear(), newPersonYear()];
  for (const s of slots) {
    const p = people[joint && s.owner === 'partner' ? 1 : 0];
    switch (s.bucket) {
      case 'taxable':
        p.taxable += s.value;
        p.basis += Math.min(s.basis, s.value);
        break;
      case 'roth':
        p.roth += s.value;
        p.rothReachable += Math.min(s.reachable, s.value);
        break;
      case 'hsa':
        p.hsa += s.value;
        break;
      case 'education':
      case 'tax-deferred': {
        const in457 = s.value * Math.min(1, Math.max(0, share457[s.owner] ?? 0));
        p.deferred += s.value - in457;
        p.deferred457 += in457;
        break;
      }
    }
  }
  return people;
}

const totalOf = (slots: Iterable<MixSlot>) => {
  let sum = 0;
  for (const s of slots) sum += s.value;
  return sum;
};

type MixArgs = { savings: number; split: readonly SplitShare[]; realReturn: number; inflation: number; walk: WalkChanges; years: number };

/** What working a year's tax out takes, beyond the walk. */
export type TaxedWalk = {
  today: { age: number; partnerAge: number | null; calendarYear: number };
  /** Null: not said, and counted as single. */
  filing: Filing | null;
  rmdAges: Record<Owner, number>;
  share457: Record<Owner, number>;
  state: StateCode | null;
  stateRate: number;
  law: TaxLaw;
  /** The plan's order; a year before the stop converts nothing. */
  order?: DrawOrder;
};

/** The mix `years` from now, or null where the walk can't get there (a cost it
 *  can't pay, or a saving below zero that would take it below zero). */
export function projectMix(today: readonly MixSlot[], args: MixArgs): ProjectedMix | null {
  return walkMix(today, args, null).mix;
}

/** The same with a year that can't pay for itself taxed, and those taxes, to put
 *  in the walk. Where the walk can't get there, even with them, there is no mix,
 *  and the taxes are those up to and including the year it stops in. `walk` is
 *  one with no taxes yet. Throws as checkYearInput does. */
export function taxedMix(today: readonly MixSlot[], args: MixArgs, taxed: TaxedWalk): { mix: ProjectedMix | null; taxes: { year: number; amount: number }[] } {
  return walkMix(today, args, taxed);
}

/** Scales `field` across a group to `to`: all of it to the first when it held none. */
function rescale(group: MixSlot[], field: 'value' | 'basis' | 'reachable', to: number): void {
  const from = group.reduce((sum, s) => sum + s[field], 0);
  if (from > 0) for (const s of group) s[field] *= to / from;
  else if (group.length > 0) group[0][field] = to;
}

function walkMix(today: readonly MixSlot[], args: MixArgs, taxed: TaxedWalk | null): { mix: ProjectedMix | null; taxes: { year: number; amount: number }[] } {
  const { savings, split, realReturn, inflation, walk, years } = args;
  const taxes: { year: number; amount: number }[] = [];
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
  const grow = () => {
    for (const s of slots.values()) {
      s.value *= 1 + realReturn;
      s.basis /= 1 + inflation;
      s.reachable = Math.min(s.reachable / (1 + inflation), s.value);
    }
  };
  const joint = taxed !== null && taxed.filing === 'joint' && taxed.today.partnerAge !== null;
  let out: YearResult | null = null;
  let carryover = 0;
  /** Sells `draw`, and the tax on it, along the year's order: each slot moves as
   *  its filer's bucket does, so a partner on your return keeps their share. The
   *  tax, or 0. */
  const sell = (at: TaxedWalk, draw: number, k: number): number => {
    const people = peopleOf(slots.values(), at.share457, joint);
    people[0].age = at.today.age + k;
    people[0].rmdAge = at.rmdAges.you;
    if (joint) {
      people[1].age = (at.today.partnerAge as number) + k;
      people[1].rmdAge = at.rmdAges.partner;
    }
    const input: YearInput = {
      calendarYear: at.today.calendarYear + k,
      yearsFromToday: k,
      priceLevel: (1 + inflation) ** k,
      irmaaPriceRatio: 1,
      filing: joint ? 'joint' : 'single',
      people,
      dependents: 0,
      state: at.state,
      stateRate: at.stateRate,
      spending: draw,
      oneOffs: 0,
      windfall: 0,
      afterTaxIncome: 0,
      taxableYield: 0,
      qualifiedShare: 0,
      taxExempt: 0,
      carryover,
      irmaaMagi: null,
      coverage: null,
      medicareExtra: 0,
      countMedicaid: false,
      acaLaw: '2026',
      healthGrowth: 0,
      incomeGrowth: 0,
      ceiling: null,
      order: at.order,
      growth: 0,
      inflation: 0,
      skipHealth: true,
    };
    if (out === null) {
      checkYearInput(input);
      out = newYearResult();
    }
    runYear(input, at.law, out);
    carryover = out.carryoverOut;
    for (let i = 0; i < (joint ? 2 : 1); i++) {
      const e = out.people[i].end;
      const owner: Owner = i === 0 ? 'you' : 'partner';
      const group = (...buckets: TaxBucket[]) => [...slots.values()].filter((s) => (!joint || s.owner === owner) && buckets.includes(s.bucket));
      const taxable = group('taxable');
      if (taxable.length === 0 && e.taxable > 0) taxable.push(slotFor(owner, 'taxable'));
      rescale(taxable, 'value', e.taxable);
      rescale(taxable, 'basis', e.basis);
      rescale(group('tax-deferred', 'education'), 'value', e.deferred + e.deferred457);
      const roth = group('roth');
      rescale(roth, 'value', e.roth);
      rescale(roth, 'reachable', e.rothReachable);
      rescale(group('hsa'), 'value', e.hsa);
    }
    return out.federal.total.v;
  };
  const stopped = { mix: null, taxes };
  /** The walk's balance, with the taxes so far, as walkPath has it. */
  let balance = totalOf(slots.values());

  for (let k = 0; k < years; k++) {
    if (taxed !== null) {
      const short = shortBy(walk, savings, k);
      if (short > 0) {
        const incoming = moneyInAt(walk, k);
        const costs = costIn(walk, k);
        const saving = savingsIn(walk, savings, k);
        const tax = sell(taxed, short, k);
        if (tax > 0) taxes.push({ year: k, amount: tax });
        balance += incoming;
        if (costs + tax > balance + 1e-9) return stopped;
        balance = (balance - costs - tax) * (1 + realReturn) + saving;
        if (balance < 0) return stopped;
        grow();
        const now = totalOf(slots.values());
        if (now > 0) takeShare(now - balance);
        else if (balance > 0) {
          const s = slotFor('you', 'taxable');
          s.value = balance;
          s.basis = balance;
        }
        continue;
      }
    }
    const moneyIn = moneyInAt(walk, k);
    if (moneyIn > 0) {
      const taxable = slotFor('you', 'taxable');
      taxable.value += moneyIn;
      taxable.basis += moneyIn;
    }
    const cost = costIn(walk, k);
    if (cost > 0) {
      if (cost > totalOf(slots.values()) + 1e-9) return stopped;
      takeShare(cost);
    }
    grow();
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
      if (totalOf(slots.values()) + saved < 0) return stopped;
      takeShare(-saved);
    }
    balance = totalOf(slots.values());
  }
  return { mix: { slots: [...slots.values()], total: totalOf(slots.values()) }, taxes };
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
