// A year before the stop that can't pay for itself: what it sells, the tax on
// that sale in the walk, and the mix that follows (lib/fire/tax/mix.ts taxedMix,
// lib/fire/events.ts).

import { describe, expect, test } from 'bun:test';
import { costIn, hasWalk, lastChange, walkBalanceAt, walkPath, walkToFi, type WalkChanges } from '@/lib/fire/events';
import { lawFor } from '@/lib/fire/tax/law';
import { projectMix, taxedMix, type MixSlot, type TaxedWalk } from '@/lib/fire/tax/mix';
import { newPersonYear, newYearResult, runYear, type YearInput } from '@/lib/fire/tax/year';

const law = lawFor(2026).law;
const taxed: TaxedWalk = { today: { age: 40, partnerAge: null, calendarYear: 2026 }, filing: 'single', rmdAges: { you: 75, partner: 75 }, share457: { you: 0, partner: 0 }, state: null, stateRate: 0, law };
const NO_WALK: WalkChanges = { moneyIn: [], costs: [], spans: [] };
const slot = (bucket: MixSlot['bucket'], value: number, more: Partial<MixSlot> = {}): MixSlot => ({ owner: 'you', bucket, value, basis: 0, reachable: 0, ...more });
const MIX = [slot('taxable', 300_000, { basis: 150_000 }), slot('tax-deferred', 500_000), slot('roth', 100_000, { reachable: 40_000 })];
const args = (over: Partial<Parameters<typeof taxedMix>[1]> = {}) => ({ savings: 50_000, split: [{ bucket: 'taxable' as const, owner: 'you' as const, share: 1 }], realReturn: 0.05, inflation: 0.03, walk: NO_WALK, years: 10, ...over });
const assets = (slots: readonly MixSlot[]) => slots.reduce((s, x) => s + x.value, 0);

describe('a year that can’t pay for itself', () => {
  test('a home in a saving year sells only what the year can’t cover, and pays the tax on that', () => {
    const walk: WalkChanges = { moneyIn: [], costs: [{ year: 0, amount: 350_000 }], spans: [] };
    const slots = [slot('taxable', 500_000, { basis: 250_000 }), slot('tax-deferred', 500_000), slot('roth', 100_000, { reachable: 40_000 })];
    const { mix, taxes } = taxedMix(slots, args({ walk, years: 1 }), taxed);
    expect(taxes.length).toBe(1);
    // The same sale on its own: $300,000 of spending from the same accounts.
    const people = [newPersonYear(40), newPersonYear()] as [ReturnType<typeof newPersonYear>, ReturnType<typeof newPersonYear>];
    Object.assign(people[0], { taxable: 500_000, basis: 250_000, deferred: 500_000, roth: 100_000, rothReachable: 40_000 });
    const year: YearInput = {
      calendarYear: 2026, yearsFromToday: 0, priceLevel: 1, irmaaPriceRatio: 1, filing: 'single', people, dependents: 0, state: null, stateRate: 0, spending: 300_000, oneOffs: 0, windfall: 0,
      afterTaxIncome: 0, taxableYield: 0, qualifiedShare: 0, taxExempt: 0, carryover: 0, irmaaMagi: null, coverage: null, medicareExtra: 0, countMedicaid: false, acaLaw: '2026', healthGrowth: 0, incomeGrowth: 0, ceiling: null, growth: 0, inflation: 0, skipHealth: true,
    };
    const out = runYear(year, law, newYearResult());
    expect(taxes[0]).toEqual({ year: 0, amount: out.federal.total.v });
    expect(out.federal.total.v).toBeGreaterThan(0);
    expect(out.people[0].drawn.taxable).toBeCloseTo(300_000 + out.federal.total.v, 6);
    // Nothing of the walk's balance is lost: it stays the walk's, within a cent.
    const at = walkBalanceAt(1_100_000, 50_000, 0.05, { ...walk, taxes }, 1);
    if (!('balance' in at)) throw new Error('the walk stopped short');
    expect(Math.abs(mix!.total - at.balance)).toBeLessThan(0.01);
    // It came from taxable first, not by share.
    const of = (b: string) => mix!.slots.find((s) => s.bucket === b)!;
    expect(of('tax-deferred').value / of('roth').value).toBeCloseTo(5, 9);
    expect(of('tax-deferred').value).toBeGreaterThan(500_000 * 1.04);
    expect(of('taxable').value).toBeLessThan(200_000 * 1.05);
  });

  test('a cost the year’s saving covers stays by share, untaxed', () => {
    const walk: WalkChanges = { moneyIn: [], costs: [{ year: 2, amount: 40_000 }], spans: [] };
    const flat = projectMix(MIX, args({ walk }))!;
    const { mix, taxes } = taxedMix(MIX, args({ walk }), taxed);
    expect(taxes).toEqual([]);
    expect(mix).toEqual(flat);
  });

  test('money in counts toward what the year covers', () => {
    const covered: WalkChanges = { moneyIn: [{ year: 0, amount: 310_000 }], costs: [{ year: 0, amount: 350_000 }], spans: [] };
    expect(taxedMix(MIX, args({ walk: covered, years: 1 }), taxed).taxes).toEqual([]);
    const notCovered: WalkChanges = { ...covered, moneyIn: [{ year: 0, amount: 100_000 }] };
    expect(taxedMix(MIX, args({ walk: notCovered, years: 1 }), taxed).taxes.length).toBe(1);
  });

  test('no year below zero: the same as the untaxed mix, to the cent and the slot', () => {
    expect(taxedMix(MIX, args(), taxed)).toEqual({ mix: projectMix(MIX, args()), taxes: [] });
  });

  const walks: [string, WalkChanges, number][] = [
    ['a saving below zero, for good', { moneyIn: [], costs: [], spans: [{ from: 1, to: null, delta: -90_000 }] }, 30_000],
    ['a saving below zero, then not', { moneyIn: [], costs: [], spans: [{ from: 2, to: 5, delta: -120_000 }] }, 30_000],
    ['a home bigger than the saving', { moneyIn: [], costs: [{ year: 3, amount: 200_000 }], spans: [] }, 30_000],
    ['a home and money in the same year', { moneyIn: [{ year: 3, amount: 60_000 }], costs: [{ year: 3, amount: 200_000 }], spans: [] }, 30_000],
    ['a saving below zero from the first year', NO_WALK, -25_000],
  ];
  const ways: [string, TaxedWalk][] = [
    ['single', taxed],
    ['no filing said', { ...taxed, filing: null }],
    ['joint', { ...taxed, filing: 'joint', today: { ...taxed.today, partnerAge: 38 } }],
    ['with a state’s rate', { ...taxed, state: 'CA', stateRate: 0.06 }],
  ];
  for (const [what, walk, savings] of walks) {
    for (const [how, at] of ways) {
      test(`its total is the taxed walk’s, within a cent: ${what}, ${how}`, () => {
        for (const [years, realReturn] of [[1, 0.05], [10, 0.05], [10, 0.02], [10, -0.01], [7, 0]] as const) {
          const partner = at.filing === 'joint' ? [{ ...slot('tax-deferred', 200_000), owner: 'partner' as const }] : [];
          const slots = [...MIX, ...partner];
          const { mix, taxes } = taxedMix(slots, args({ walk, savings, years, realReturn }), at);
          // A small sale can sit under the 0% gains band; a state's rate takes it.
          if (years > 3 && at.stateRate > 0) expect(taxes.length).toBeGreaterThan(0);
          const reached = walkBalanceAt(assets(slots), savings, realReturn, { ...walk, taxes }, years);
          if (!('balance' in reached)) throw new Error('the walk stopped short');
          expect(Math.abs(mix!.total - reached.balance)).toBeLessThan(0.01);
          for (const s of mix!.slots) {
            expect(s.value).toBeGreaterThanOrEqual(0);
            expect(s.basis).toBeLessThanOrEqual(s.value + 1e-6);
            expect(s.reachable).toBeLessThanOrEqual(s.value + 1e-6);
          }
        }
      });
    }
  }

  test('where the walk can’t get there there’s no mix, the taxes up to then are kept, and the walk stops in the same year', () => {
    const walk: WalkChanges = { moneyIn: [], costs: [{ year: 1, amount: 400_000 }, { year: 3, amount: 900_000 }], spans: [] };
    const { mix, taxes } = taxedMix(MIX, args({ walk, savings: 0 }), taxed);
    expect(mix).toBeNull();
    expect(taxes.map((x) => x.year)).toEqual([1, 3]);
    const p = walkPath(assets(MIX), 0, 0.05, { ...walk, taxes }, 10);
    expect(p.short?.year).toBe(3);
    expect(p.short?.kind).toBe('cost');
    expect(p.short?.need).toBe(900_000 + taxes[1].amount);
  });

  test('a partner on your return keeps their share of each bucket as it falls', () => {
    const slots = [slot('taxable', 100_000, { basis: 100_000 }), { ...slot('taxable', 300_000, { basis: 300_000 }), owner: 'partner' as const }];
    const walk: WalkChanges = { moneyIn: [], costs: [{ year: 0, amount: 200_000 }], spans: [] };
    const { mix } = taxedMix(slots, args({ walk, savings: 0, years: 1, realReturn: 0 }), { ...taxed, today: { ...taxed.today, partnerAge: 38 } });
    expect(mix!.slots.find((s) => s.owner === 'you')!.value).toBeCloseTo(50_000, 6);
    expect(mix!.slots.find((s) => s.owner === 'partner')!.value).toBeCloseTo(150_000, 6);
  });

  test('health coverage is no part of it, Medicare from 65 included', () => {
    const at: TaxedWalk = { ...taxed, today: { ...taxed.today, age: 66 } };
    const slots = [slot('taxable', 500_000, { basis: 500_000 }), slot('hsa', 50_000)];
    const walk: WalkChanges = { moneyIn: [], costs: [{ year: 0, amount: 100_000 }], spans: [] };
    const { mix, taxes } = taxedMix(slots, args({ walk, savings: 0, years: 1, realReturn: 0, inflation: 0 }), at);
    // All basis, so no gain and no tax, and the HSA isn't touched for premiums.
    expect(taxes).toEqual([]);
    expect(mix!.slots.find((s) => s.bucket === 'taxable')!.value).toBeCloseTo(400_000, 6);
    expect(mix!.slots.find((s) => s.bucket === 'hsa')!.value).toBeCloseTo(50_000, 6);
  });

  test('what an owner sells past the RMD age and doesn’t need goes to taxable', () => {
    const at: TaxedWalk = { ...taxed, today: { ...taxed.today, age: 80 } };
    const slots = [slot('tax-deferred', 1_000_000)];
    const walk: WalkChanges = { moneyIn: [], costs: [{ year: 0, amount: 1_000 }], spans: [] };
    const { mix } = taxedMix(slots, args({ walk, savings: 0, years: 1, realReturn: 0, inflation: 0 }), at);
    expect(mix!.slots.find((s) => s.bucket === 'taxable')!.value).toBeGreaterThan(0);
    expect(Math.abs(mix!.total - 999_000) - (1_000_000 - mix!.total - 1_000)).toBeLessThan(0.01);
  });

  test('nothing to sell, with a walk still above zero, stays the walk’s', () => {
    const walk: WalkChanges = { moneyIn: [], costs: [], spans: [{ from: 0, to: 1, delta: -30_000 }] };
    const { mix } = taxedMix([slot('taxable', 29_000, { basis: 29_000 })], args({ walk, savings: 0, years: 1, realReturn: 0.05, inflation: 0 }), taxed);
    expect(mix!.total).toBeCloseTo(29_000 * 1.05 - 30_000, 6);
  });
});

describe('the walk with taxes', () => {
  const taxesFrom = (first: number, last: number, amount: number) => Array.from({ length: last - first + 1 }, (_, i) => ({ year: first + i, amount }));

  test('a tax counts as the year’s cost, and a walk with only that has a walk', () => {
    const w: WalkChanges = { ...NO_WALK, taxes: [{ year: 2, amount: 7 }, { year: 2, amount: 3 }] };
    expect(costIn(w, 2)).toBe(10);
    expect(costIn(w, 1)).toBe(0);
    expect(hasWalk(w)).toBe(true);
    expect(lastChange(w)).toBe(-1);
    expect(hasWalk({ ...NO_WALK, taxes: [] })).toBe(false);
    expect(walkPath(1_000, 0, 0, w, 3).balances).toEqual([1_000, 1_000, 1_000, 990]);
  });

  test('walkToFi with no taxes is walkToFi as it was', () => {
    const w: WalkChanges = { moneyIn: [], costs: [{ year: 3, amount: 100_000 }], spans: [{ from: 1, to: 4, delta: -5_000 }] };
    expect(walkToFi(200_000, 30_000, 0.05, 1_000_000, { ...w, taxes: [] })).toEqual(walkToFi(200_000, 30_000, 0.05, 1_000_000, w));
  });

  test('there through the last change stays there: a later tax doesn’t take the date back', () => {
    // At 40 with $1.6M against $1.5M, saving -$180,000 from 45: FI now, as flat
    // says, and $1 a year of tax from 45 to 59 would otherwise make it short at 66.
    const w: WalkChanges = { moneyIn: [], costs: [], spans: [{ from: 5, to: null, delta: -180_000 }] };
    expect(walkToFi(1_600_000, 0, 0.05, 1_500_000, w)).toEqual({ years: 0 });
    expect(walkToFi(1_600_000, 0, 0.05, 1_500_000, { ...w, taxes: taxesFrom(5, 19, 1) })).toEqual({ years: 0 });
  });

  test('a tax before the date moves it', () => {
    const w: WalkChanges = { ...NO_WALK, costs: [{ year: 1, amount: 50_000 }] };
    const without = walkToFi(500_000, 40_000, 0.05, 1_000_000, w) as { years: number };
    const taxed = walkToFi(500_000, 40_000, 0.05, 1_000_000, { ...w, taxes: [{ year: 1, amount: 30_000 }] }) as { years: number };
    expect(taxed.years).toBeGreaterThan(without.years);
  });

  test('past the last change it walks on through the taxes, and counts years from there', () => {
    // Saving below zero for good, from today's first year: nothing changes after
    // the first span starts, so every tax is past the last change.
    const w: WalkChanges = { ...NO_WALK };
    const plain = walkToFi(2_000_000, -20_000, 0.05, 3_000_000, w) as { years: number };
    const withTax = walkToFi(2_000_000, -20_000, 0.05, 3_000_000, { ...w, taxes: taxesFrom(0, 4, 5_000) }) as { years: number };
    expect(Number.isFinite(plain.years)).toBe(true);
    expect(withTax.years).toBeGreaterThan(plain.years);
    let bal = 2_000_000;
    for (let k = 0; k < 5; k++) bal = (bal - 5_000) * 1.05 - 20_000;
    expect(withTax.years).toBeCloseTo(5 + (walkToFi(bal, -20_000, 0.05, 3_000_000, NO_WALK) as { years: number }).years, 9);
  });

  test('a tax it can’t pay past the last change stops it there', () => {
    const r = walkToFi(1_000, -200, 0, 1_000_000, { ...NO_WALK, taxes: [{ year: 2, amount: 900 }] });
    expect(r).toEqual({ short: { year: 2, have: 600, need: 900, kind: 'cost' } });
  });

  test('a balance running down past the taxes stops where it goes below zero', () => {
    const r = walkToFi(1_000, -200, 0, 1_000_000, { ...NO_WALK, taxes: [{ year: 1, amount: 100 }] });
    expect(r).toEqual({ short: { year: 4, have: 100, need: 200, kind: 'savings' } });
  });
});
