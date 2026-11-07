// The stress test with each year's tax (lib/fire/taxed-paths.ts): on a steady market a
// path ends where the drawdown ends, fails in the year the drawdown runs out, and on a
// market that moves each year is what the year says it is on that path's own return,
// inflation and prices. The plan-level cases of what a drawdown hands the engine live
// here too, as they did beside the bridge this replaced.

import { describe, expect, test } from 'bun:test';
import type { BucketsToday } from '@/lib/fire/buckets-today';
import { taxShares } from '@/lib/fire/drawdown';
import type { PlanItem } from '@/lib/fire/items';
import { runPlanJob } from '@/lib/fire/jobs';
import { makeMarket, type Market } from '@/lib/fire/market';
import { steadyRun } from '@/lib/fire/path';
import { DEFAULT_PLAN, type EnginePlan, type Measured } from '@/lib/fire/plan';
import { detailWork, type DetailedInput, type PlanDetail } from '@/lib/fire/plan-detail';
import { planFigures, type PlanFigures } from '@/lib/fire/plan-figures';
import { planOf, type FirePlanV2 } from '@/lib/fire/plan-v2';
import { checkPlan, firedAcross, historicalCycles, monteCarlo, simulate, successGrid, TAXED_GRID_RUNS, TAXED_GRID_STEP, type PathSource, type SimPlan } from '@/lib/fire/simulate';
import { taxedPaths } from '@/lib/fire/taxed-paths';
import { lawFor } from '@/lib/fire/tax/law';
import { NO_STRATEGY, type Strategy } from '@/lib/fire/tax/rules';
import { newPersonYear, newYearResult, runYear, shortcuts, type YearInput } from '@/lib/fire/tax/year';
import { usMarket } from '@/lib/fire/us-market';
import { ON } from './plan-gen';

const WITH_TAX = { taxed: taxedPaths };

const account = (bucket: string, value: number, basis: number | null = null, owner = 'you') => ({ owner, value, basis, account_id: `${owner}-${bucket}`, bucket });
const group = (bucket: string, ...accounts: ReturnType<typeof account>[]) => ({ bucket, accounts, total: accounts.reduce((s, a) => s + a.value, 0) });
const buckets = (taxable: number, deferred: number, roth: number, reachable: number) =>
  ({
    groups: [group('taxable', account('taxable', taxable, taxable / 2)), group('tax-deferred', account('tax-deferred', deferred)), group('roth', account('roth', roth))],
    roth: [{ owner: 'you', amount: reachable }],
    total: taxable + deferred + roth,
  }) as unknown as Pick<BucketsToday, 'groups' | 'roth' | 'total'>;

const input: DetailedInput = {
  calendarYear: 2026,
  filing: 'single',
  dependents: [],
  rmdAges: { you: 75, partner: 75 },
  buckets: buckets(400_000, 700_000, 200_000, 80_000),
  savingsSplit: [{ bucket: 'taxable', share: 1 }],
  share457: { you: 0, partner: 0 },
  inflation: 0.03,
  taxableYield: 0,
  health: { coverage: { kind: 'other', yearly: 9_000 }, medicareExtra: 0, meetsRule: [], countMedicaid: false, acaLaw: '2026', growth: 0.021, incomeGrowth: 0.011 },
  state: null,
  stateRate: 0,
  paidToday: 0,
  strategy: NO_STRATEGY,
  law: lawFor(2026).law,
  lawYear: { year: 2026, behind: false },
};

const plan = (over: Partial<FirePlanV2> = {}): FirePlanV2 => ({ ...planOf({ ...DEFAULT_PLAN, age: 45, targetAge: 50, spending: 70_000, savings: 40_000, assets: 1_300_000, realReturn: 0.05, withdrawalRate: 0.04, fee: 0 }), start: 'at-stop', ...over });
const M: Measured = { spending: null, savings: null, assets: null };
const when = (age: number) => ({ anchor: { at: 'age' as const, age }, offset: 0 });
const atBalance = (amount: number) => ({ anchor: { at: 'balance' as const, amount }, offset: 0 });
const item = (over: Partial<PlanItem> & Pick<PlanItem, 'kind'>): PlanItem => ({ id: 'x', label: 'x', from: when(60), until: null, once: null, yearly: null, replaces: null, every: null, times: null, inflationAdjusted: true, owner: null, beforeTax: false, ...over });

function figures(p: FirePlanV2, over: Partial<DetailedInput> = {}): PlanFigures {
  const f = planFigures(p, M, { count: ON, detailed: detailWork({ ...input, ...over }) });
  if ('refused' in f) throw new Error('refused');
  return f;
}
const detailOf = (f: PlanFigures): PlanDetail => {
  if (f.detail === null || 'failed' in f.detail) throw new Error(`no detail: ${JSON.stringify(f.detail)}`);
  return f.detail;
};
const engineOf = (f: PlanFigures): EnginePlan => {
  if (!('sim' in f.engine)) throw new Error('no engine');
  return f.engine;
};
const total = (b: { taxable: number; deferred: number; roth: number; hsa: number }) => b.taxable + b.deferred + b.roth + b.hsa;

/** A market where stocks and bonds both earn `real` and prices rise `inflation` a year. */
const steady = (years: number, real = 0.05, inflation = 0.03): Market => {
  const n = years * 12;
  const r = (1 + real) ** (1 / 12) - 1;
  return makeMarket('2000-01', new Array(n).fill(r), new Array(n).fill(r), new Array(n).fill((1 + inflation) ** (1 / 12) - 1));
};

/** The balances the drawdown has, at the start of each year and at its end. */
const drawdownBalances = (d: PlanDetail) => [...d.start.years.map((y) => total(y.start)), total(d.start.years[d.start.years.length - 1].end)];

/** A single path's balances and the year it failed in, on a steady market. */
function onePath(sim: SimPlan, real: number, inflation = 0.03) {
  const market = steady(sim.years, real, inflation);
  const source: PathSource = { count: 1, monthAt: (p, y) => p + 12 * y, label: () => null };
  const run = taxedPaths(sim, market, source, true);
  const failedYear = run.failedYear[0];
  return { balances: Array.from(run.balances as Float64Array), failedYear: failedYear < 0 ? null : failedYear, spending: Array.from(run.spending as Float64Array) };
}

/** The largest gap between the path and the drawdown, over the years the path ran. */
function gap(f: PlanFigures, real = 0.05): number {
  const d = detailOf(f);
  const want = drawdownBalances(d);
  const { balances, failedYear } = onePath(engineOf(f).sim, real);
  const to = failedYear === null ? want.length : failedYear + 1;
  let worst = 0;
  for (let i = 0; i < to; i++) worst = Math.max(worst, Math.abs(balances[i] - want[i]));
  return worst;
}

const FILL_10: Strategy = { order: 'standard', conversions: { kind: 'bracket', top: 0.1 }, convertUntil: null };
const ACA_12: Strategy = { order: 'standard', conversions: { kind: 'aca-then-bracket', top: 0.12 }, convertUntil: null };
const ROTH_FIRST: Strategy = { order: 'roth-before-deferred', conversions: { kind: 'none' }, convertUntil: null };
const ACA_COVER = { health: { ...input.health, coverage: { kind: 'aca' as const, adult: 11_000, quotedAge: 50, child: null } } };

const COUPLE_TODAY = {
  groups: [group('taxable', account('taxable', 300_000, 150_000), account('taxable', 100_000, 90_000, 'partner')), group('tax-deferred', account('tax-deferred', 500_000), account('tax-deferred', 200_000, null, 'partner')), group('roth', account('roth', 150_000), account('roth', 50_000, null, 'partner'))],
  roth: [
    { owner: 'you', amount: 80_000 },
    { owner: 'partner', amount: 20_000 },
  ],
  total: 1_300_000,
} as unknown as Pick<BucketsToday, 'groups' | 'roth' | 'total'>;

describe('on a steady market a path ends where the drawdown ends', () => {
  const kinds: [string, PlanItem[]][] = [
    ['nothing but spending and health', []],
    ['income given before tax', [item({ kind: 'social-security', from: when(67), yearly: 30_000, beforeTax: true }), item({ id: 'p', kind: 'pension', from: when(60), yearly: 15_000, beforeTax: true })]],
    ['income given after tax', [item({ kind: 'other-income', from: when(55), yearly: 20_000, beforeTax: false })]],
    ['income that doesn’t keep up with prices', [item({ kind: 'pension', from: when(60), yearly: 24_000, beforeTax: true, inflationAdjusted: false })]],
    ['a one-off', [item({ kind: 'one-off', from: when(58), once: 120_000 })]],
    ['a windfall', [item({ kind: 'windfall', from: when(60), once: 200_000 })]],
    ['a windfall far over the year’s need', [item({ kind: 'windfall', from: when(55), once: 900_000 })]],
    ['income over the year’s need, for years', [item({ kind: 'other-income', from: when(52), until: when(58), yearly: 180_000, beforeTax: false })]],
    ['a lower cost', [item({ kind: 'loan-end', from: when(60), yearly: 12_000 })]],
    ['a lower cost over all of living spending', [item({ kind: 'loan-end', from: when(60), yearly: 90_000 })]],
    ['a lower cost over living spending and a one-off', [item({ kind: 'loan-end', from: when(60), yearly: 90_000 }), item({ id: 'o', kind: 'one-off', from: when(65), once: 5_000 })]],
    ['part-time work', [item({ kind: 'part-time', from: when(50), until: when(55), yearly: 30_000, beforeTax: true })]],
    ['all of them', [item({ id: 'a', kind: 'social-security', from: when(67), yearly: 30_000, beforeTax: true }), item({ id: 'b', kind: 'other-income', from: when(55), until: when(60), yearly: 20_000 }), item({ id: 'c', kind: 'one-off', from: when(58), once: 120_000 }), item({ id: 'd', kind: 'windfall', from: when(70), once: 200_000 }), item({ id: 'e', kind: 'loan-end', from: when(62), yearly: 12_000 })]],
  ];
  for (const [what, items] of kinds) {
    test(`${what}, to within a cent`, () => {
      const f = figures(plan({ items }));
      expect(detailOf(f).start.runsOutAt).toBeNull();
      expect(gap(f)).toBeLessThan(0.01);
    });
  }

  const coupleItems = [item({ id: 'y', kind: 'social-security', from: when(67), yearly: 30_000, beforeTax: true, owner: 'you' }), item({ id: 'z', kind: 'pension', from: when(60), yearly: 12_000, beforeTax: true, owner: 'partner', inflationAdjusted: false }), item({ id: 'w', kind: 'part-time', from: when(50), until: when(53), yearly: 25_000, beforeTax: true, owner: 'partner' })];

  // What moves a constant rule's money from one solution of the fill to another is only
  // the fill's own window of a dollar, a year, compounded.
  const strategies: [string, Strategy, number][] = [
    ['no rule', NO_STRATEGY, 0.01],
    ['Roth before tax-deferred', ROTH_FIRST, 0.01],
    ['filling the 10% bracket', FILL_10, 100],
    ['the ACA limit, then the 12% bracket', ACA_12, 100],
  ];
  for (const [what, strategy, within] of strategies) {
    test(`single, joint and on the ACA: ${what}`, () => {
      expect(gap(figures(plan(), { strategy }))).toBeLessThan(within);
      expect(gap(figures(plan({ items: coupleItems, partnerAge: 44 }), { filing: 'joint', buckets: COUPLE_TODAY, strategy }))).toBeLessThan(within);
      expect(gap(figures(plan({ items: coupleItems, partnerAge: 44 }), { ...ACA_COVER, filing: 'joint', buckets: COUPLE_TODAY, strategy, taxableYield: 0.02, state: 'CA', stateRate: 0.06 }))).toBeLessThan(within);
    });
  }

  // These rules' `t` and `h` settle to $1 (drawdown.ts), and the drawdown's last run
  // used the pair before the one it returns, so a path sits a little apart: a share of
  // a dollar a year, carried along.
  for (const rule of ['percent', 'guardrails', 'vpw', 'floor-ceiling'] as const) {
    test(`${rule}, to within about $100`, () => {
      expect(gap(figures(plan({ rule })))).toBeLessThan(100);
      expect(gap(figures(plan({ rule }), { strategy: ACA_12, ...ACA_COVER }))).toBeLessThan(100);
      expect(gap(figures(plan({ rule, items: kinds[12][1] })))).toBeLessThan(100);
    });
  }
});

describe('fails in the year the drawdown runs out', () => {
  const other = { health: { ...input.health, coverage: { kind: 'other' as const, yearly: 4_000 } } };
  const short = (spending: number, assets: number) => figures(plan({ age: 50, targetAge: 50, spending, savings: 0, assets }), { buckets: buckets(assets * 0.2, assets * 0.7, assets * 0.1, assets * 0.05), savingsSplit: null });

  test('a constant rule, across plans, with income that goes on after the money is gone', () => {
    const ss = (yearly: number) => item({ kind: 'social-security', from: when(67), yearly, beforeTax: true });
    let out = 0;
    for (const age of [45, 50, 55])
      for (const assets of [800_000, 1_100_000, 1_500_000])
        for (const spending of [70_000, 85_000, 110_000])
          for (const yearly of [0, 30_000, 40_000])
            for (const realReturn of [0.03, 0.05]) {
              const g = figures(plan({ age, targetAge: age, spending, savings: 0, assets, realReturn, items: yearly ? [ss(yearly)] : [] }), { buckets: buckets(assets * 0.2, assets * 0.7, assets * 0.1, assets * 0.05), savingsSplit: null });
              const at = detailOf(g).start.runsOutAt;
              const failed = onePath(engineOf(g).sim, realReturn).failedYear;
              expect(failed === null ? null : age + failed).toBe(at);
              if (at !== null) out++;
            }
    expect(out).toBeGreaterThan(40);
  });

  test('VPW’s last year gives up living spending for health over `h`, and lasts', () => {
    const f = figures(plan({ rule: 'vpw' }), other);
    const d = detailOf(f).start;
    const last = d.years[d.years.length - 1];
    expect(last.health).toBeGreaterThan(d.h);
    expect(d.runsOutAt).toBeNull();
    const path = onePath(engineOf(f).sim, 0.05);
    expect(path.failedYear).toBeNull();
    // What it gave up shows in the year's spending.
    const y = d.years.length - 1;
    expect(Math.abs(path.spending[y] - (last.living + d.h))).toBeLessThan(5);
    expect(historicalCycles(engineOf(f).sim, steady(engineOf(f).sim.years + 1), WITH_TAX).successRate).toBe(1);
  });

  test('percent of what is there does too', () => {
    const f = figures(plan({ rule: 'percent' }), other);
    expect(detailOf(f).start.runsOutAt).toBeNull();
    expect(onePath(engineOf(f).sim, 0.05).failedYear).toBeNull();
  });

  test('a cost living spending can’t cover still comes up short', () => {
    const f = figures(plan({ rule: 'vpw', items: [item({ kind: 'one-off', from: when(80), once: 90_000_000 })] }), other);
    expect(detailOf(f).start.runsOutAt).toBe(80);
    expect(onePath(engineOf(f).sim, 0.05).failedYear).toBe(30);
  });

  describe('once a cost has taken all there is', () => {
    const emptied = (rule: 'percent' | 'vpw', age: number, cost: number, at: number) => {
      const assets = 1_000_000;
      const p = plan({ rule, age, targetAge: age, spending: 40_000, savings: 0, assets, realReturn: 0.03, items: [item({ kind: 'one-off', from: when(at), once: cost })] });
      return figures(p, { buckets: buckets(0, 0, assets, assets), savingsSplit: null, health: { ...input.health, coverage: { kind: 'other', yearly: 30_000 } } });
    };
    test.each([
      ['percent', 60, 740_770, 68, 69],
      ['percent', 66, 935_000, 68, 69],
      ['vpw', 60, 518_937, 75, 88],
    ] as const)('%s from %d, $%d at %d: health runs it out later, as the drawdown says', (rule, age, cost, at, out) => {
      const f = emptied(rule, age, cost, at);
      expect(detailOf(f).start.runsOutAt).toBe(out);
      expect(age + (onePath(engineOf(f).sim, 0.03).failedYear as number)).toBe(out);
    });
  });

  test('spending under health coverage holds at it: a year still owes its coverage', () => {
    const f = figures(plan({ rule: 'percent', age: 50, targetAge: 50, spending: 20_000, savings: 0, assets: 500_000, realReturn: 0.03 }), {
      buckets: buckets(0, 0, 500_000, 500_000),
      savingsSplit: null,
      health: { ...input.health, coverage: { kind: 'other', yearly: 60_000 } },
    });
    const d = detailOf(f).start;
    expect(d.notes).toContain('held-at-zero');
    expect(d.runsOutAt).not.toBeNull();
    const path = onePath(engineOf(f).sim, 0.03);
    expect(50 + (path.failedYear as number)).toBe(d.runsOutAt as number);
    for (let y = 0; y < (path.failedYear as number); y++) expect(path.spending[y]).toBeGreaterThanOrEqual(d.h - 1e-6);
  });

  test('a rule that can run out isn’t let off', () => {
    const f = figures(plan({ spending: 200_000 }), other);
    expect(detailOf(f).start.runsOutAt).not.toBeNull();
    expect(onePath(engineOf(f).sim, 0.05).failedYear).not.toBeNull();
  });

  test('a plan that runs out: its balance is 0 from then on, and it counts as failed', () => {
    const f = short(120_000, 1_100_000);
    const d = detailOf(f).start;
    expect(d.runsOutAt).toBe(57);
    const { sim } = engineOf(f);
    const r = historicalCycles(sim, steady(sim.years), WITH_TAX);
    expect(r.successRate).toBe(0);
    expect(r.worst[0].failedYear).toBe(7);
    expect(r.ending.p50).toBe(0);
    expect(r.balance.p50[8]).toBe(0);
  });
});

describe('what a steady market can’t see', () => {
  test('N identical starts all match, so nothing carries from one path to the next', () => {
    const f = figures(plan({ items: [item({ kind: 'social-security', from: when(67), yearly: 30_000, beforeTax: true }), item({ id: 'p', kind: 'pension', from: when(60), yearly: 24_000, beforeTax: true, inflationAdjusted: false })] }), { ...ACA_COVER, strategy: ACA_12, taxableYield: 0.02 });
    const { sim } = engineOf(f);
    const market = steady(sim.years + 2);
    const source: PathSource = { count: 6, monthAt: (p, y) => p * 3 + 12 * y, label: () => null };
    const run = taxedPaths({ ...sim, rule: { kind: 'guardrails', rate: engineOf(f).rate } }, market, source, true);
    const balances = run.balances as Float64Array;
    const width = sim.years + 1;
    for (let p = 1; p < source.count; p++) {
      for (let y = 0; y < width; y++) expect(Math.abs(balances[p * width + y] - balances[y])).toBeLessThan(1e-4);
    }
  });

  test('a path worked by hand: mix drift, fee, a fixed pension on its own inflation, IRMAA’s prices and MAGI', () => {
    // Four years, one start. Stocks and bonds apart, left to drift, a fee of 1%.
    const stockYears = [0.2, -0.3, 0.1, 0.05];
    const bondYears = [0, 0.05, 0.1, -0.02];
    const inflationYears = [0.1, 0, 0.05, 0.02];
    const monthly = (years: number[]) => years.flatMap((r) => new Array(12).fill((1 + r) ** (1 / 12) - 1));
    const market = makeMarket('2000-01', monthly(stockYears), monthly(bondYears), monthly(inflationYears));
    const law = lawFor(2026).law;
    const today = { age: 68, partnerAge: null, calendarYear: 2026 };
    const fee = 0.01;
    const sim: SimPlan = {
      startBalance: 3_000_000,
      years: 4,
      allocation: { stocks: 0.5, bonds: 0.5, cash: 0 },
      rebalance: 'none',
      fee,
      taxRate: 0.1,
      rule: { kind: 'constant', rate: 0.05 },
      income: [],
      oneOffs: [],
      cashRealReturn: 0,
      tax: {
        startAge: 70,
        today,
        filing: 'single',
        dependents: [],
        rmdAges: { you: 75, partner: 75 },
        slots: [
          { owner: 'you', bucket: 'tax-deferred', value: 2_000_000, basis: 0, reachable: 0 },
          { owner: 'you', bucket: 'taxable', value: 1_000_000, basis: 800_000, reachable: 0 },
        ],
        share457: { you: 0, partner: 0 },
        inflation: 0.03,
        taxableYield: 0.02,
        income: [{ amount: 0, fromYear: 0, inflationAdjusted: false, kind: 'pension', owner: 'you', beforeTax: true, gross: 130_000 }],
        health: { coverage: { kind: 'other', yearly: 5_000 }, medicareExtra: 0, meetsRule: [], countMedicaid: false, acaLaw: '2026', growth: 0.021, incomeGrowth: 0.011 },
        state: null,
        stateRate: 0,
        law,
        strategy: NO_STRATEGY,
        t: 0.1,
        h: 6_000,
      },
    };
    const source: PathSource = { count: 1, monthAt: (_, y) => 12 * y, label: () => null };
    const run = taxedPaths(sim, market, source, true);

    // The same four years, chained here, with what each year should see written out.
    const person = newPersonYear(70);
    person.taxable = 1_000_000;
    person.basis = 800_000;
    person.deferred = 2_000_000;
    const out = newYearResult();
    let bal = 3_000_000;
    const expected = [bal];
    const prices = [1, 1.1, 1.1, 1.155];
    const magis: number[] = [];
    let stocks = 0.5;
    let bonds = 0.5;
    let carryover = 0;
    for (let y = 0; y < 4; y++) {
      const factor = stocks * (1 + stockYears[y]) + bonds * (1 + bondYears[y]);
      person.age = 70 + y;
      person.pension = (130_000 * prices[0]) / prices[y];
      const year: YearInput = {
        calendarYear: 2028 + y,
        yearsFromToday: 2 + y,
        priceLevel: 1.03 ** 2 * prices[y],
        irmaaPriceRatio: y >= 2 ? prices[y] / prices[y - 2] : 1.03 ** 2,
        filing: 'single',
        people: [person, newPersonYear()],
        dependents: 0,
        state: null,
        stateRate: 0,
        spending: 0.05 * 3_000_000 * 0.9 - 6_000,
        oneOffs: 0,
        windfall: 0,
        afterTaxIncome: 0,
        taxableYield: 0.02,
        qualifiedShare: 0.75,
        taxExempt: 0,
        carryover,
        irmaaMagi: y >= 2 ? magis[y - 2] : null,
        coverage: { kind: 'other', yearly: 5_000 },
        medicareExtra: 0,
        countMedicaid: false,
        acaLaw: '2026',
        healthGrowth: 0.021,
        incomeGrowth: 0.011,
        ceiling: null,
        order: 'standard',
        growth: factor * (1 - fee) - 1,
        inflation: inflationYears[y],
      };
      runYear(year, law, out);
      expect(out.short).toBe(false);
      const e = out.people[0].end;
      person.taxable = e.taxable;
      person.basis = e.basis;
      person.deferred = e.deferred;
      person.deferred457 = e.deferred457;
      person.roth = e.roth;
      person.rothReachable = e.rothReachable;
      person.hsa = e.hsa;
      person.window = [...e.window];
      carryover = out.carryoverOut;
      magis.push(out.federal.magiIrmaa.v);
      bal = e.taxable + e.deferred + e.deferred457 + e.roth + e.hsa;
      expected.push(bal);
      stocks = (stocks * (1 + stockYears[y])) / factor;
      bonds = (bonds * (1 + bondYears[y])) / factor;
    }
    const balances = Array.from(run.balances as Float64Array);
    expected.forEach((v, i) => expect(balances[i]).toBeCloseTo(v, 6));
    // IRMAA and the fixed pension really are in play here.
    expect(out.health.people[0].irmaa).toBeGreaterThan(0);
    expect(run.firstYearSpending).toBeCloseTo(0.05 * 3_000_000 * 0.9, 6);
  });

  test('with no tax and no health, on a market that moves, a path is the flat engine’s to a cent, at every rule and rebalancing', () => {
    // All Roth, no coverage, no yield, from 60 (all of it reachable, whatever a market's
    // inflation does to what is) to before 65 (Medicare, charged whatever the coverage).
    const none: Partial<DetailedInput> = { buckets: buckets(0, 0, 1_300_000, 1_300_000), health: { ...input.health, coverage: null }, savingsSplit: null };
    const market = usMarket();
    for (const rule of ['constant', 'percent', 'guardrails', 'vpw', 'floor-ceiling'] as const) {
      for (const rebalance of ['annual', 'monthly', 'none'] as const) {
        const p = plan({ rule, rebalance, fee: 0.002, stocksPct: 60, bondsPct: 30, age: 60, targetAge: 60, horizon: 5, savings: 0, start: 'custom', startBalance: 1_300_000 });
        const f = figures(p, none);
        const d = detailOf(f);
        expect(d.start.t).toBe(0);
        expect(d.start.h).toBe(0);
        const { sim } = engineOf(f);
        expect(sim.tax).toBeDefined();
        const { tax: _tax, ...flat } = sim;
        const a = historicalCycles(sim, market, WITH_TAX);
        const b = historicalCycles(flat, market);
        expect(a.paths).toBe(b.paths);
        expect(a.successRate).toBe(b.successRate);
        for (const key of ['p10', 'p50', 'p90'] as const) a.balance[key].forEach((v, i) => expect(Math.abs(v - b.balance[key][i])).toBeLessThan(0.01));
        for (const key of ['p10', 'p50', 'p90'] as const) a.spending?.[key].forEach((v, i) => expect(Math.abs(v - (b.spending as NonNullable<typeof b.spending>)[key][i])).toBeLessThan(0.01));
      }
    }
  });

  test('a surplus is invested, drifting with the mix, and a balance of nothing resets the mix', () => {
    // Income over spending with the balance at nothing: every dollar comes in at the target.
    const market = makeMarket('2000-01', new Array(36).fill(0.01), new Array(36).fill(0), new Array(36).fill(0));
    const base = figures(plan({ rebalance: 'none', stocksPct: 50, bondsPct: 50, age: 60, targetAge: 60, horizon: 3, savings: 0, start: 'custom', startBalance: 100_000, spending: 1_000, items: [item({ kind: 'other-income', from: when(60), yearly: 60_000 })] }), { buckets: buckets(0, 0, 100_000, 100_000), health: { ...input.health, coverage: null }, savingsSplit: null });
    const { sim } = engineOf(base);
    const taxed = historicalCycles(sim, market, WITH_TAX);
    const { tax: _tax, ...flat } = sim;
    const flatPlan: SimPlan = { ...flat, income: [{ amount: 60_000, fromYear: 0, inflationAdjusted: true }] };
    const ours = taxed.balance.p50;
    const theirs = historicalCycles(flatPlan, market).balance.p50;
    // A surplus goes into taxable, whose growth comes less its yield: no yield here.
    ours.forEach((v, i) => expect(v).toBeCloseTo(theirs[i], 2));
  });
});

describe('what waits on a run’s own balance', () => {
  const waiting = [item({ kind: 'windfall', from: atBalance(50_000_000), once: 100_000 }), item({ id: 'o', kind: 'one-off', from: atBalance(50_000_000), once: 40_000 })];
  const runsOn = (sim: SimPlan, real: number) => historicalCycles(sim, steady(sim.years, real), WITH_TAX);
  /** The same plan with every trigger at `amount`. */
  const triggeredAt = (sim: SimPlan, amount: number): SimPlan => {
    const flows = sim.conditional as NonNullable<SimPlan['conditional']>;
    return { ...sim, conditional: { ...flows, triggers: flows.triggers.map(() => amount) } };
  };

  test('it isn’t in the fixed parts, so it counts once', () => {
    const f = figures(plan({ items: waiting }));
    const { sim } = engineOf(f);
    expect(sim.conditional).toBeDefined();
    expect(sim.conditional?.items.map((x) => x.moneyIn)).toEqual([100_000, 0]);
    expect(sim.conditional?.items[1].once).toEqual([{ amount: 40_000, after: 0 }]);
    expect(sim.tax?.income).toEqual([]);
    expect(sim.oneOffs).toEqual([]);
  });

  test('income waiting stays before tax, and says what it is', () => {
    const earns = item({ id: 'y', kind: 'pension', from: atBalance(50_000_000), yearly: 20_000, owner: 'partner', beforeTax: true });
    const f = figures(plan({ items: [earns], partnerAge: 44 }), { filing: 'joint', buckets: COUPLE_TODAY });
    expect(engineOf(f).sim.conditional?.items[0].income).toEqual({ amount: 20_000, inflationAdjusted: true, kind: 'pension', owner: 'partner', beforeTax: true });
  });

  test('on a market that never gets there neither comes; on one that does each comes once', () => {
    const f = figures(plan({ items: waiting }));
    const { sim } = engineOf(f);
    const fixedOnly: SimPlan = { ...sim, conditional: undefined };
    // Never: trigger far above anything this market reaches.
    const a = runsOn(triggeredAt(sim, 1e12), 0.05).balance.p50;
    const b = runsOn(fixedOnly, 0.05).balance.p50;
    a.forEach((v, i) => expect(v).toBeCloseTo(b[i], 6));
    // At once: the same two as fixed items in the first year.
    const fixed: SimPlan = {
      ...fixedOnly,
      oneOffs: [{ amount: 40_000, year: 0 }],
      tax: { ...(sim.tax as NonNullable<SimPlan['tax']>), income: [{ amount: 0, fromYear: 0, toYear: 1, inflationAdjusted: true, kind: 'windfall', owner: null, beforeTax: false, gross: 100_000 }] },
    };
    const c = runsOn(triggeredAt(sim, 0), 0.05).balance.p50;
    const e = runsOn(fixed, 0.05).balance.p50;
    c.forEach((v, i) => expect(v).toBeCloseTo(e[i], 6));
    expect(c[c.length - 1]).not.toBeCloseTo(b[b.length - 1], 0);
  });

  test('`watch` reads the year it fired, and the year fired comes through firedAcross', () => {
    const f = figures(plan({ items: waiting }));
    const { sim } = engineOf(f);
    const trigger = 2_000_000;
    const moved = triggeredAt(sim, trigger);
    const market = steady(sim.years);
    const fired = firedAcross('historical', moved, market, 0, 0, WITH_TAX);
    expect(fired.runs).toBe(1);
    const balances = historicalCycles(moved, market, WITH_TAX).balance.p50;
    const first = balances.findIndex((b) => b >= trigger);
    if (first >= 0 && first < sim.years) {
      expect(fired.fired).toBe(1);
      expect(fired.byHalf).toBe(first);
    } else {
      expect(fired.fired).toBe(0);
    }
  });
});

describe('a stop already passed', () => {
  // You are 55 and stopped at 50: a tax year can't run before today.
  const passed = (items: PlanItem[] = []) => plan({ age: 55, targetAge: 50, start: 'custom', startBalance: 1_500_000, horizon: 30, items });

  test('the engine starts today and ends at the plan’s own end', () => {
    const f = figures(passed());
    const e = engineOf(f);
    expect(e.startAge).toBe(55);
    expect(e.sim.tax?.startAge).toBe(55);
    expect(e.sim.years).toBe(25);
    expect(detailOf(f).start.years[0].age).toBe(55);
    expect(detailOf(f).start.years.length).toBe(25);
    expect(gap(f)).toBeLessThan(0.01);
  });

  test('an item lands at its own age', () => {
    const f = figures(passed([item({ kind: 'one-off', from: when(60), once: 50_000 }), item({ id: 's', kind: 'social-security', from: when(67), yearly: 20_000, beforeTax: true })]));
    const { sim } = engineOf(f);
    expect(sim.oneOffs).toEqual([{ amount: 50_000, year: 5 }]);
    expect(sim.tax?.income[0].fromYear).toBe(12);
  });

  test('so does a waiting edge, from what you’d have at a stop already passed', () => {
    const waits = item({ id: 'w', kind: 'spending', from: when(60), until: atBalance(50_000_000), yearly: 5_000 });
    const f = figures(plan({ age: 55, targetAge: 50, start: 'at-stop', items: [waits] }), { savingsSplit: null });
    const e = engineOf(f);
    expect(e.startAge).toBe(55);
    expect(e.sim.conditional?.items[0].start).toEqual({ year: 5 });
    expect(e.sim.oneOffs).toEqual([]);
  });

  test('Compare’s rows end at the age the plan’s own row does', () => {
    const p = passed();
    const f = figures(p);
    const own = detailOf(f).start;
    const again = detailWork({ ...input, strategy: ACA_12 }).startRun(f);
    expect(again?.years[again.years.length - 1].age).toBe(own.years[own.years.length - 1].age);
    expect(again?.years.length).toBe(own.years.length);
  });

  test('a run from a stop still ahead ends where it always did', () => {
    const f = figures(plan());
    const e = engineOf(f);
    expect(e.startAge).toBe(50);
    const d = detailOf(f).start;
    expect(d.years[d.years.length - 1].age).toBe(50 + e.sim.years - 1);
    const again = detailWork(input).startRun(f);
    expect(again?.years.length).toBe(d.years.length);
  });
});

describe('the engine a detailed plan hands over', () => {
  test('the rule covers spending and health at `t`', () => {
    const f = figures(plan());
    const d = detailOf(f);
    const e = engineOf(f);
    const expected = (70_000 + d.start.h) / (1 - d.start.t) / e.sim.startBalance;
    expect(e.rate).toBeCloseTo(expected, 12);
    expect(e.rateFrom).toBe('spending');
    expect(e.sim.rule).toEqual({ kind: 'constant', rate: e.rate });
    expect(e.rate * e.sim.startBalance * (1 - e.sim.taxRate)).toBeCloseTo(70_000 + d.start.h, 6);
    expect(e.sim.taxRate).toBe(d.start.t);
    expect(e.sim.tax?.t).toBe(d.start.t);
    expect(e.sim.tax?.h).toBe(d.start.h);
  });

  test('a FI-number start runs at its flat FI number, with the rate it needs', () => {
    const f = figures(plan({ start: 'fi-number' }));
    const e = engineOf(f);
    expect(e.sim.startBalance).toBe(f.view.fiNumber as number);
    expect(e.rate).not.toBe(0.04);
    expect(e.rate).toBeCloseTo(detailOf(f).start.rate, 12);
    expect(gap(f)).toBeLessThan(0.01);
  });

  test('income goes in as typed, by kind, and comes out of `sim.income`', () => {
    const f = figures(plan({ items: [item({ kind: 'pension', from: when(60), yearly: 15_000, beforeTax: true, inflationAdjusted: false }), item({ id: 'y', kind: 'other-income', from: when(55), until: when(60), yearly: 20_000 })] }));
    const { sim } = engineOf(f);
    expect(sim.income).toEqual([]);
    const rows = [...(sim.tax?.income ?? [])].sort((a, b) => a.fromYear - b.fromYear);
    expect(rows.map((r) => [r.kind, r.gross, r.fromYear, r.toYear ?? null, r.beforeTax, r.inflationAdjusted])).toEqual([
      ['other-income', 20_000, 5, 10, false, true],
      ['pension', 15_000, 10, null, true, false],
    ]);
  });

  test('its slots hold the start, and a worker can take the whole of it', () => {
    const f = figures(plan({ items: [item({ kind: 'one-off', from: when(58), once: 1_000 })] }), { strategy: ACA_12 });
    const { sim } = engineOf(f);
    expect((sim.tax?.slots ?? []).reduce((s, x) => s + x.value, 0)).toBeCloseTo(sim.startBalance, 6);
    const cloned = structuredClone(sim);
    const market = steady(sim.years + 2);
    expect(historicalCycles(cloned, market, WITH_TAX).balance.p50).toEqual(historicalCycles(sim, market, WITH_TAX).balance.p50);
  });

  test('a start of nothing has no engine and no years to work out', () => {
    const f = figures(plan({ start: 'custom', startBalance: 0 }));
    expect('sim' in f.engine).toBe(false);
    expect(f.detail).toBeNull();
  });

  test('a mix that can’t be projected says so, rather than throwing on the page, and the flat model carries the plan', () => {
    const f = figures(plan({ savings: -60_000 }), { stateRate: 1 });
    expect(f.detail).toMatchObject({ failed: expect.any(String) });
    expect(engineOf(f).sim.tax).toBeUndefined();
  });

  test('an overdrawn account is no reason not to run', () => {
    const overdrawn = () => {
      const checking = { owner: 'you', value: -200, basis: -200, account_id: 'checking', bucket: 'taxable' };
      return { groups: [group('taxable', checking, account('taxable', 300_000)), group('tax-deferred', account('tax-deferred', 700_000))], roth: [], total: 999_800 } as unknown as Pick<BucketsToday, 'groups' | 'roth' | 'total'>;
    };
    for (const p of [plan({ savings: -60_000, assets: 999_800 }), plan({ savings: 0, assets: 999_800, start: 'assets' })]) {
      const f = figures(p, { buckets: overdrawn(), savingsSplit: null });
      expect(detailOf(f).start.years.length).toBeGreaterThan(0);
      const { sim } = engineOf(f);
      expect(() => historicalCycles(sim, steady(sim.years), WITH_TAX)).not.toThrow();
    }
  });

  test('a plan with no tax to pay has a share of none, never a hair under, so the stress test runs', () => {
    // Adding and taking away leave this plan's tax a hair below zero in years with none.
    const accounts = (owner: string, values: Record<string, number | [number, number]>) => Object.entries(values).map(([bucket, v]) => ({ owner, bucket, account_id: `${owner}${bucket}`, value: Array.isArray(v) ? v[0] : v, basis: Array.isArray(v) ? v[1] : null }));
    const you = accounts('you', { taxable: [679_000, 256_104.75035523996], 'tax-deferred': 764_000, roth: 261_000 });
    const partner = accounts('partner', { taxable: [82_000, 49_726.71040846035], 'tax-deferred': 1_153_000, roth: 445_000, hsa: 32_000 });
    const by = (bucket: string) => group(bucket, ...([...you, ...partner].filter((a) => a.bucket === bucket) as never[]));
    const today = { groups: ['taxable', 'tax-deferred', 'roth', 'hsa'].map(by), roth: [{ owner: 'you', amount: 162_000 }, { owner: 'partner', amount: 114_000 }], total: 3_416_000 } as unknown as Pick<BucketsToday, 'groups' | 'roth' | 'total'>;
    const once = item({ id: 'car', kind: 'one-off', from: when(53), once: 231_000 });
    const rent = item({ id: 'rent', kind: 'other-income', from: when(61), yearly: 32_000, inflationAdjusted: false, owner: 'partner', beforeTax: true });
    const p = { ...plan({ age: 38, targetAge: 61, partnerAge: 69, spending: 28_000, savings: 35_000, assets: null, withdrawalRate: 0.045, realReturn: 0.04, taxRate: 0, rule: 'vpw', startBalance: 932_000, horizon: 46, fee: 0.001, floor: 0.9, ceiling: 1.25, stocksPct: 75, bondsPct: 25, items: [rent, once] }), partTimeIncome: 10_000 };
    const f = planFigures(p as FirePlanV2, { spending: 60_000, savings: null, assets: null }, {
      count: ON,
      detailed: detailWork({ ...input, filing: 'joint', rmdAges: { you: 73, partner: 73 }, buckets: today, savingsSplit: [{ bucket: 'taxable', share: 0.5 }, { bucket: 'roth', share: 0.5 }], share457: { you: 0.3, partner: 0 }, inflation: 0.02, taxableYield: 0.01, health: { coverage: { kind: 'aca', adult: 11_000, quotedAge: 50, child: 4_000 }, medicareExtra: 2_000, meetsRule: ['you'], countMedicaid: false, acaLaw: '2026', growth: 0.021, incomeGrowth: 0.011 }, paidToday: 5_000 }),
    }) as PlanFigures;
    const d = detailOf(f).start;
    expect(d.t).toBeGreaterThanOrEqual(0);
    for (const y of d.years) expect(y.tax).toBeGreaterThanOrEqual(0);
    expect(() => checkPlan(engineOf(f).sim)).not.toThrow();
  });
});

describe('a plan’s drawdown, when it runs out', () => {
  const short = (spending: number, assets: number) => figures(plan({ age: 50, targetAge: 50, spending, savings: 0, assets }), { buckets: buckets(assets * 0.2, assets * 0.7, assets * 0.1, assets * 0.05), savingsSplit: null });

  test('its tax share is of what the years paid', () => {
    for (const [spending, assets, age] of [
      [120_000, 1_100_000, 57],
      [70_000, 1_100_000, 67],
    ]) {
      const d = detailOf(short(spending, assets)).start;
      expect(d.runsOutAt).toBe(age);
      const paying = d.years.filter((y) => !y.short);
      const share = paying.reduce((s, y) => s + y.tax, 0) / paying.reduce((s, y) => s + y.tax + y.living + y.health + y.oneOffs, 0);
      expect(d.t).toBeGreaterThan(share * 0.9);
    }
  });

  test('what income pays once the money is gone doesn’t thin its tax share', () => {
    const ss = item({ kind: 'social-security', from: when(67), yearly: 36_000, beforeTax: true });
    const f = figures(plan({ age: 55, targetAge: 55, spending: 80_000, savings: 0, assets: 1_000_000, realReturn: 0.04, items: [ss] }), { buckets: buckets(200_000, 700_000, 100_000, 50_000), savingsSplit: null });
    const d = detailOf(f).start;
    expect(d.runsOutAt).toBe(67);
    expect(d.t).toBeCloseTo(taxShares(d.years.slice(0, 67 - 55 + 1), 0.04).t, 9);
    expect(d.t).toBeGreaterThan(taxShares(d.years, 0.04).t * 0.999);
  });

  test('tax and health in all are what the years paid', () => {
    const d = detailOf(short(120_000, 1_100_000)).start;
    const paidYears = d.years.filter((y) => !y.short).reduce((s, y) => s + y.tax + y.health, 0);
    expect(d.taxAndHealth).toBeGreaterThanOrEqual(paidYears);
    expect(d.taxAndHealth).toBeLessThan(d.years.reduce((s, y) => s + y.tax + y.health, 0));
    // Income pays for health after the money is gone, and that was paid.
    const f = figures(plan({ age: 50, targetAge: 50, spending: 75_000, savings: 0, assets: 1_100_000, realReturn: 0.04, items: [item({ kind: 'social-security', from: when(67), yearly: 30_000, beforeTax: true })] }), { buckets: buckets(220_000, 770_000, 110_000, 55_000), savingsSplit: null });
    const withIncome = detailOf(f).start;
    expect(withIncome.runsOutAt).not.toBeNull();
    expect(withIncome.taxAndHealth).toBeGreaterThan(withIncome.years.filter((y) => !y.short).reduce((s, y) => s + y.tax + y.health, 0) + 50_000);
  });
});

describe('how a job runs', () => {
  const market = usMarket();
  const detailed = () => engineOf(figures(plan({ items: [item({ kind: 'social-security', from: when(67), yearly: 30_000, beforeTax: true })] }), { ...ACA_COVER, strategy: ACA_12, taxableYield: 0.02 })).sim;

  test('without the tax year handed in it refuses, rather than running flat', () => {
    const sim = detailed();
    expect(() => historicalCycles(sim, market)).toThrow('tax year');
    expect(() => monteCarlo(sim, market, { runs: 2 })).toThrow('tax year');
    expect(() => successGrid('historical', sim, market, [0.04], [20])).toThrow('tax year');
  });

  test('a job through runPlanJob runs the branch, on the worker’s message', () => {
    const sim = detailed();
    const job = runPlanJob({ kind: 'simulate', method: 'historical', plan: structuredClone(sim) }, market);
    expect(job.ok).toBe(true);
    if (job.ok && job.kind === 'simulate') {
      expect(job.result.paths).toBeGreaterThan(1000);
      expect(job.result.successRate).toBeGreaterThan(0);
    }
    const cell = runPlanJob({ kind: 'grid-cell', method: 'historical', plan: sim, rate: 0.04, years: 30 }, market);
    expect(cell.ok).toBe(true);
  });

  test('a job a year can’t work out answers why, not a figure', () => {
    const sim = detailed();
    const job = runPlanJob({ kind: 'simulate', method: 'historical', plan: { ...sim, tax: { ...(sim.tax as NonNullable<SimPlan['tax']>), taxableYield: Number.NaN } } }, market);
    expect(job.ok).toBe(false);
  });

  test('a job gives the same answer whatever ran before it, in either order', () => {
    const sim = detailed();
    const other = engineOf(figures(plan(), { strategy: FILL_10 })).sim;
    const opts = { runs: 60, ...WITH_TAX };
    const first = monteCarlo(sim, market, opts);
    monteCarlo(other, market, opts);
    const again = monteCarlo(sim, market, opts);
    expect(again.balance.p50).toEqual(first.balance.p50);
    expect(again.successRate).toBe(first.successRate);
  });

  test('the shortcuts leave a job’s success rate within 0.2 points, conversions on', () => {
    const sim = detailed();
    const fill = engineOf(figures(plan({ items: [item({ kind: 'social-security', from: when(67), yearly: 30_000, beforeTax: true })] }), { ...ACA_COVER, strategy: { order: 'standard', conversions: { kind: 'bracket', top: 0.12 }, convertUntil: null }, taxableYield: 0.02 })).sim;
    const opts = { runs: 200, ...WITH_TAX };
    try {
      for (const s of [sim, fill]) {
        for (const job of [(x: SimPlan) => monteCarlo(x, market, opts), (x: SimPlan) => successGrid('historical', x, market, [0.04], [40], WITH_TAX)[0]]) {
          shortcuts.on = true;
          const on = job(s).successRate;
          shortcuts.on = false;
          const off = job(s).successRate;
          expect(Math.abs(on - off)).toBeLessThan(0.002);
        }
      }
    } finally {
      shortcuts.on = true;
    }
  }, 60_000);
});

describe('the grid’s sample', () => {
  const market = usMarket();
  const sim = () => engineOf(figures(plan())).sim;

  test('a cell runs every sixth start and says so, from the first start', () => {
    const [cell] = successGrid('historical', sim(), market, [0.04], [30], WITH_TAX);
    const every = market.months - 12 * 30 + 1;
    expect(cell.paths).toBe(Math.ceil(every / TAXED_GRID_STEP));
    expect(cell.firstStart).toBe('1871-01');
    expect(TAXED_GRID_STEP).toBe(6);
  });

  test('or 250 of the Monte Carlo job’s runs, the same ones', () => {
    const s = sim();
    const [cell] = successGrid('monte-carlo', s, market, [s.rule.kind === 'constant' ? s.rule.rate : 0.04], [s.years], WITH_TAX);
    expect(cell.paths).toBe(TAXED_GRID_RUNS);
    const first = monteCarlo(s, market, { runs: TAXED_GRID_RUNS, ...WITH_TAX });
    expect(cell.successRate).toBe(first.successRate);
  });

  test('the job above the grid runs them all', () => {
    const s = sim();
    expect(simulate('historical', s, market, WITH_TAX).paths).toBe(market.months - 12 * s.years + 1);
  });

  test('a flat plan’s grid keeps every start', () => {
    const { tax: _tax, ...flat } = sim();
    const [cell] = successGrid('historical', flat, market, [0.04], [30]);
    expect(cell.paths).toBe(market.months - 12 * 30 + 1);
  });

  test('its longest column runs past the plan’s end, to an age the law still reads', () => {
    const s = sim();
    const [cell] = successGrid('historical', { ...s, tax: { ...(s.tax as NonNullable<SimPlan['tax']>), startAge: 70, today: { age: 68, partnerAge: null, calendarYear: 2026 } } }, market, [0.04], [60], WITH_TAX);
    expect(cell.successRate).toBeGreaterThanOrEqual(0);
  });
});

describe('without worked-out tax, the flat engine', () => {
  const sim = (over: Partial<SimPlan> = {}): SimPlan => ({ startBalance: 1_000_000, years: 1, allocation: { stocks: 1, bonds: 0, cash: 0 }, rebalance: 'annual', fee: 0, taxRate: 0.1, rule: { kind: 'constant', rate: 0.06 }, income: [{ amount: 180_000, fromYear: 0, inflationAdjusted: true }], oneOffs: [], cashRealReturn: 0, ...over });
  const still = (years: number): Market => {
    const n = years * 12;
    return makeMarket('2000-01', new Array(n).fill(0), new Array(n).fill(0), new Array(n).fill(0));
  };

  test('invests a year’s spare money as it is, in a steady run and on either rebalancing', () => {
    expect(steadyRun(sim(), 0).balances[1]).toBeCloseTo(1_126_000, 6);
    for (const rebalance of ['annual', 'none'] as const) expect(historicalCycles(sim({ rebalance }), still(2)).balance.p50[1]).toBeCloseTo(1_126_000, 6);
  });

  test('a waiting windfall keeps what it had, and income its share after tax', () => {
    const waits = item({ kind: 'windfall', from: atBalance(50_000_000), once: 100_000 });
    const earns = item({ id: 'y', kind: 'other-income', from: atBalance(50_000_000), yearly: 20_000, beforeTax: true });
    const f = planFigures(plan({ items: [waits, earns], taxRate: 0.1 }), M, { count: ON });
    if ('refused' in f || !('sim' in f.engine)) throw new Error('no engine');
    expect(f.engine.sim.tax).toBeUndefined();
    expect(f.engine.sim.conditional?.items[0].moneyIn).toBe(100_000);
    expect(f.engine.sim.conditional?.items[1].income).toEqual({ amount: 18_000, inflationAdjusted: true });
  });

  test('gives the numbers it gave before this branch', () => {
    const market = usMarket();
    const flat = (rule: SimPlan['rule'], over: Partial<SimPlan> = {}): SimPlan => ({ startBalance: 1_000_000, years: 30, allocation: { stocks: 0.75, bonds: 0.25, cash: 0 }, rebalance: 'annual', fee: 0.001, taxRate: 0.12, rule, income: [{ amount: 20_000, fromYear: 15, inflationAdjusted: true }], oneOffs: [{ amount: 50_000, year: 5 }], lowerSpending: [{ amount: 3_000, fromYear: 10 }], cashRealReturn: 0, ...over });
    const seen = (s: SimPlan) => {
      const h = historicalCycles(s, market);
      const m = monteCarlo(s, market, { runs: 500 });
      return [h.paths, Math.round(h.successRate * 1e6), Math.round(h.ending.p50), Math.round(h.firstYearSpending), m.paths, Math.round(m.successRate * 1e6), Math.round(m.ending.p50)];
    };
    expect(seen(flat({ kind: 'constant', rate: 0.045 }))).toEqual(PINNED.constant);
    expect(seen(flat({ kind: 'guardrails', rate: 0.05 }))).toEqual(PINNED.guardrails);
    expect(seen(flat({ kind: 'vpw', expectedReturn: 0.04 }))).toEqual(PINNED.vpw);
    expect(seen(flat({ kind: 'floor-ceiling', rate: 0.05, floor: 0.9, ceiling: 1.25 }, { rebalance: 'none' }))).toEqual(PINNED.floorCeiling);
  });
});

/** From `main` at 7caa663f, run there: the flat engine as it was, these four plans. */
const PINNED = {
  constant: [1470, 996_599, 1_981_814, 39_600, 500, 968_000, 2_422_001],
  guardrails: [1470, 1_000_000, 1_778_939, 44_000, 500, 1_000_000, 1_843_860],
  vpw: [1470, 1_000_000, 27_944, 48_933, 500, 1_000_000, 28_293],
  floorCeiling: [1470, 989_796, 1_637_468, 44_000, 500, 950_000, 1_901_564],
};
