import { describe, expect, test } from 'bun:test';
import { runDrawdown, type DrawdownInput } from '@/lib/fire/drawdown';
import type { PlanItem } from '@/lib/fire/items';
import { DEFAULT_PLAN } from '@/lib/fire/plan';
import { detailWork, type DetailedInput } from '@/lib/fire/plan-detail';
import { planFigures } from '@/lib/fire/plan-figures';
import { planOf, type FirePlanV2 } from '@/lib/fire/plan-v2';
import { seededRandom } from '@/lib/fire/random';
import { historicalCycles, monteCarlo, type SimPlan } from '@/lib/fire/simulate';
import { taxedPaths, type SimTax } from '@/lib/fire/taxed-paths';
import { LAW_2026 } from '@/lib/fire/tax/law/2026';
import { NO_STRATEGY, type Strategy } from '@/lib/fire/tax/rules';
import { newPersonYear, newYearResult, runYear, type YearInput, type YearResult } from '@/lib/fire/tax/year';
import { tuneRuns } from '@/lib/fire/tune';
import { usMarket } from '@/lib/fire/us-market';
import { ON } from './plan-gen';

// What the year costs: the year in a 5,000 by 40 loop, as a Monte Carlo job
// with taxes runs it, timed against the flat Monte Carlo job of the same size on
// the same machine, so a slow runner slows both. This test only measures. The
// bound guards against the year's work growing (a solver that walks every cell,
// say), not against a slow machine: a ratio of 60, about three times the 19
// measured. And the jobs themselves, by the same rule, which the tax plan's
// Overview sets against a phone's budget. Set TAX_TIMING=1 to print the figures,
// which docs/architecture.md records.
//
// The workload: a couple, 50 and 48 in Nevada, from 50 to 89. On the ACA to
// 65 (benchmark $11,000 at 50, health costs 2.1 points over prices), then
// Medicare with IRMAA from the year two before; Social Security from 67;
// RMDs from 75. Each of the 5,000 runs has its own seeded returns and
// spending, so the years land in the cells, near the cliff and on the lines.
// The runs' returns are drawn before the timed region; each year's balances
// are the year before's close, as the drawdown will chain them.

/** How far process.cpuUsage() moves at a time, in milliseconds (about 16 on
 *  Windows, microseconds on Linux), as import-parsers.test.ts measures it. */
const CPU_STEP_MS = (() => {
  const used = () => {
    const { user, system } = process.cpuUsage();
    return user + system;
  };
  const moves: number[] = [];
  for (let last = used(); moves.length < 3; ) {
    const now = used();
    if (now !== last) {
      moves.push(now - last);
      last = now;
    }
  }
  return moves.sort((a, b) => a - b)[1] / 1000;
})();

/** How long `work` takes, in milliseconds: the smaller of processor and wall
 *  time, the processor time counted a step more than it reads (a short job
 *  can read a step short on Windows), the best of three after a full
 *  collection, as import-parsers.test.ts times its reads. */
function readMs(work: () => unknown): number {
  let best = Infinity;
  for (let run = 0; run < 3; run++) {
    Bun.gc(true);
    const cpu = process.cpuUsage();
    const wall = performance.now();
    work();
    const wallMs = performance.now() - wall;
    const { user, system } = process.cpuUsage(cpu);
    best = Math.min(best, wallMs, (user + system) / 1000 + CPU_STEP_MS);
  }
  return best;
}

const RUNS = 5_000;
const YEARS = 40;
const ACA_YEARS = 15; // 50 to 64

const rand = seededRandom(5_000);
const returns = new Float64Array(RUNS * YEARS);
const spending = new Float64Array(RUNS);
for (let i = 0; i < returns.length; i++) returns[i] = -0.15 + 0.35 * rand();
for (let r = 0; r < RUNS; r++) spending[r] = 50_000 + 30_000 * rand();

function start(inp: YearInput, run: number): void {
  inp.people[0] = { ...newPersonYear(50), rmdAge: 75, taxable: 400_000, basis: 220_000, deferred: 800_000, roth: 200_000, rothReachable: 100_000, hsa: 40_000 };
  inp.people[1] = { ...newPersonYear(48), rmdAge: 75, deferred: 300_000 };
  inp.spending = spending[run];
  inp.irmaaMagi = null;
}

const input: YearInput = {
  calendarYear: 2026, yearsFromToday: 0, priceLevel: 1, irmaaPriceRatio: 1.03 ** 2, filing: 'joint',
  people: [newPersonYear(50), newPersonYear(48)], dependents: 0, state: 'NV', stateRate: 0, spending: 64_000,
  oneOffs: 0, windfall: 0, afterTaxIncome: 0, taxableYield: 0.02, qualifiedShare: 0.9, taxExempt: 0, carryover: 0,
  irmaaMagi: null, coverage: { kind: 'aca', adult: 11_000, quotedAge: 50, child: null }, medicareExtra: 2_000,
  countMedicaid: false, acaLaw: '2026', healthGrowth: 0.021, incomeGrowth: 0.011, ceiling: null, growth: 0.05,
  inflation: 0.03,
};

const result = newYearResult();
const magis = new Float64Array(RUNS * 2); // the last two years' IRMAA MAGI, per run

/** Years `from` to `to` (exclusive) of every run, each from the year before's close. */
function years(from: number, to: number, saved: YearInput['people'][]): void {
  for (let run = 0; run < RUNS; run++) {
    if (from === 0) start(input, run);
    else {
      input.people[0] = { ...saved[run][0] };
      input.people[1] = { ...saved[run][1] };
      input.spending = spending[run];
    }
    for (let y = from; y < to; y++) {
      input.calendarYear = 2026 + y;
      input.yearsFromToday = y;
      input.priceLevel = 1.03 ** y;
      input.growth = returns[run * YEARS + y];
      input.irmaaMagi = y >= 2 ? magis[run * 2 + (y % 2)] : null;
      const p0 = input.people[0];
      const p1 = input.people[1];
      p0.age = 50 + y;
      p1.age = 48 + y;
      p0.socialSecurity = p0.age >= 67 ? 30_000 : 0;
      p1.socialSecurity = p1.age >= 67 ? 18_000 : 0;
      const r: YearResult = runYear(input, LAW_2026, result);
      magis[run * 2 + (y % 2)] = r.federal.magiIrmaa.v;
      for (let i = 0; i < 2; i++) {
        const e = r.people[i].end;
        const p = input.people[i];
        p.taxable = e.taxable;
        p.basis = e.basis;
        p.deferred = e.deferred;
        p.deferred457 = e.deferred457;
        p.roth = e.roth;
        p.rothReachable = e.rothReachable;
        for (let w = 0; w < 4; w++) p.window[w] = e.window[w];
        p.hsa = e.hsa;
      }
      input.carryover = r.carryoverOut;
    }
    if (to < YEARS) saved[run] = [{ ...input.people[0], window: [...input.people[0].window] }, { ...input.people[1], window: [...input.people[1].window] }];
  }
}

const flatPlan: SimPlan = {
  startBalance: 1_740_000, years: YEARS, allocation: { stocks: 0.75, bonds: 0.25, cash: 0 }, rebalance: 'annual',
  fee: 0, taxRate: 0, rule: { kind: 'constant', rate: 0.04 }, income: [], oneOffs: [], cashRealReturn: 0,
};

describe('the cost of the year', () => {
  test('5,000 runs by 40 years of the year cost under 60 times the flat Monte Carlo job of the same size', () => {
    const market = usMarket();
    const flat = readMs(() => monteCarlo(flatPlan, market));
    const saved: YearInput['people'][] = new Array(RUNS);
    let aca = 0;
    let medicare = 0;
    const total = readMs(() => {
      const a = performance.now();
      years(0, ACA_YEARS, saved);
      const b = performance.now();
      years(ACA_YEARS, YEARS, saved);
      const c = performance.now();
      aca = b - a;
      medicare = c - b;
    });
    if (process.env.TAX_TIMING) {
      const perYear = (total * 1000) / (RUNS * YEARS);
      console.log(JSON.stringify({
        flatJobMs: +flat.toFixed(1), taxJobMs: +total.toFixed(1), ratio: +(total / flat).toFixed(1),
        usPerYear: +perYear.toFixed(2), usPerAcaYear: +((aca * 1000) / (RUNS * ACA_YEARS)).toFixed(2),
        usPerMedicareYear: +((medicare * 1000) / (RUNS * (YEARS - ACA_YEARS))).toFixed(2),
      }));
    }
    expect(total / flat).toBeLessThan(60);
    expect(total).toBeLessThan(20_000);
  }, 120_000);

  // The jobs as the tab runs them: the household above from 50, a rate and the steady
  // years' `t` and `h` as it would have them, no conversions and the ACA rule. Against
  // the flat job of the same size: about 28 and 60 for Monte Carlo, on a fifth of the runs.
  test('a job with each year’s tax stays the same order, with and without conversions', () => {
    const market = usMarket();
    const taxOf = (strategy: Strategy): SimTax => ({
      startAge: 50,
      today: { age: 41, partnerAge: 40, calendarYear: 2026 },
      filing: 'joint',
      dependents: [],
      rmdAges: { you: 75, partner: 75 },
      slots: [
        { owner: 'you', bucket: 'taxable', value: 415_664, basis: 224_828, reachable: 0 },
        { owner: 'you', bucket: 'tax-deferred', value: 823_116, basis: 0, reachable: 0 },
        { owner: 'you', bucket: 'roth', value: 196_805, basis: 0, reachable: 98_646 },
        { owner: 'you', bucket: 'hsa', value: 38_783, basis: 0, reachable: 0 },
      ],
      share457: { you: 0, partner: 0 },
      inflation: 0.03,
      taxableYield: 0.02,
      income: [
        { amount: 28_500, fromYear: 17, inflationAdjusted: true, kind: 'social-security', owner: 'you', beforeTax: true, gross: 30_000 },
        { amount: 17_000, fromYear: 18, inflationAdjusted: true, kind: 'social-security', owner: 'partner', beforeTax: true, gross: 18_000 },
      ],
      health: { coverage: { kind: 'aca', adult: 11_000, quotedAge: 50, child: null }, medicareExtra: 0, meetsRule: [], countMedicaid: false, acaLaw: '2026', growth: 0.021, incomeGrowth: 0.011 },
      state: 'NV',
      stateRate: 0,
      law: LAW_2026,
      strategy,
      t: 0.05,
      h: 8_000,
    });
    const sim = (strategy: Strategy): SimPlan => ({
      ...flatPlan,
      startBalance: 1_474_368,
      rule: { kind: 'constant', rate: 0.052 },
      income: [],
      tax: taxOf(strategy),
    });
    const WITH_TAX = { taxed: taxedPaths };
    const SOME = { runs: 1_000 };
    const flat = readMs(() => monteCarlo(flatPlan, market, SOME));
    const none = sim(NO_STRATEGY);
    const aca = sim({ order: 'standard', conversions: { kind: 'aca-then-bracket', top: 0.12 }, convertUntil: null });
    const mcNone = readMs(() => monteCarlo(none, market, { ...SOME, ...WITH_TAX }));
    const mcAca = readMs(() => monteCarlo(aca, market, { ...SOME, ...WITH_TAX }));
    const historicalNone = readMs(() => historicalCycles(none, market, WITH_TAX));
    if (process.env.TAX_TIMING) {
      console.log(JSON.stringify({ flatMs: +flat.toFixed(1), monteCarlo1000NoneMs: +mcNone.toFixed(1), monteCarlo1000AcaMs: +mcAca.toFixed(1), historicalNoneMs: +historicalNone.toFixed(1), ratios: [+(mcNone / flat).toFixed(1), +(mcAca / flat).toFixed(1)] }));
    }
    expect(mcNone / flat).toBeLessThan(90);
    expect(mcAca / flat).toBeLessThan(180);
  }, 60_000);

  // One drawdown is what a sheet's preview, the search's candidates and each
  // plan in Compare wait on: 46 years, a Medicaid and ACA stretch, the cells
  // included. A rule that isn't constant runs it up to 8 times.
  test('46 years of the drawdown stay well under what a page can wait for', () => {
    const inp: DrawdownInput = {
      startAge: 50, years: 46, today: { age: 41, partnerAge: 40, calendarYear: 2026 }, filing: 'joint', dependents: [], rmdAges: { you: 75, partner: 75 },
      slots: [{ owner: 'you', bucket: 'taxable', value: 420_000, basis: 280_000, reachable: 0 }, { owner: 'you', bucket: 'tax-deferred', value: 900_000, basis: 0, reachable: 0 }, { owner: 'you', bucket: 'roth', value: 120_000, basis: 0, reachable: 70_000 }, { owner: 'you', bucket: 'hsa', value: 35_000, basis: 0, reachable: 0 }],
      share457: { you: 0, partner: 0 }, spending: 64_000, rule: (rate) => ({ kind: 'percent', rate }), realReturn: 0.05, inflation: 0.03, taxableYield: 0.02, oneOffs: [], lower: [],
      income: [{ amount: 0, fromYear: 17, inflationAdjusted: true, kind: 'social-security', owner: 'you', beforeTax: true, gross: 30_000 }, { amount: 0, fromYear: 18, inflationAdjusted: true, kind: 'social-security', owner: 'partner', beforeTax: true, gross: 18_000 }],
      health: { coverage: { kind: 'aca', adult: 11_000, quotedAge: 50, child: null }, medicareExtra: 0, meetsRule: [], countMedicaid: false, acaLaw: '2026', growth: 0.021, incomeGrowth: 0.011 },
      state: 'NV', stateRate: 0, law: LAW_2026,
    };
    let rounds = 0;
    const ms = readMs(() => {
      for (let i = 0; i < 50; i++) {
        const d = runDrawdown(inp);
        if ('failed' in d) throw new Error(d.failed);
        rounds = d.rounds;
      }
    });
    if (process.env.TAX_TIMING) console.log(JSON.stringify({ drawdownMs: +(ms / 50).toFixed(2), rounds }));
    expect(rounds).toBeGreaterThan(1);
    expect(ms / 50).toBeLessThan(40);

    // A rule that fills a ceiling searches around each year it converts,
    // which G's grid and the stress test's paths multiply. It must stay the same order.
    let converted = 0;
    const filling = readMs(() => {
      for (let i = 0; i < 50; i++) {
        const d = runDrawdown({ ...inp, strategy: { order: 'standard', conversions: { kind: 'aca-then-bracket', top: 0.12 }, convertUntil: null } });
        if ('failed' in d) throw new Error(d.failed);
        converted = d.years.reduce((sum, y) => sum + y.conversion, 0);
      }
    });
    if (process.env.TAX_TIMING) console.log(JSON.stringify({ fillingMs: +(filling / 50).toFixed(2), converted: Math.round(converted) }));
    expect(converted).toBeGreaterThan(0);
    expect(filling / 50).toBeLessThan(80);
  }, 60_000);

  // Tune to a goal's grid: each rule's settings, in a worker, on a constant rule (the only
  // one it's offered on). It is meant to take under 1 s on a mid-range phone, a person's own
  // fixed amount under 3 s. The bounds are a good deal over what was measured, as above.
  test('Tune’s grid stays what a person can wait for', () => {
    const social = (id: string, owner: 'you' | 'partner', age: number, yearly: number): PlanItem => ({ id, label: id, kind: 'social-security', from: { anchor: { at: 'age', age }, offset: 0 }, until: null, once: null, yearly, replaces: null, every: null, times: null, inflationAdjusted: true, owner, beforeTax: true });
    const plan: FirePlanV2 = {
      ...planOf({ ...DEFAULT_PLAN, age: 41, targetAge: 50, spending: 64_000, savings: 50_000, assets: 595_000, realReturn: 0.05, withdrawalRate: 0.04, fee: 0.001, stocksPct: 75, bondsPct: 25, rebalance: 'annual', rule: 'constant' }),
      partnerAge: 40,
      start: 'at-stop',
      items: [social('you', 'you', 67, 30_000), social('partner', 'partner', 68, 18_000)],
    };
    const account = (bucket: string, value: number, basis: number | null = null) => ({ owner: 'you', value, basis, account_id: bucket, bucket });
    const group = (bucket: string, value: number, basis: number | null = null) => ({ bucket, accounts: [account(bucket, value, basis)], total: value });
    const input: DetailedInput = {
      calendarYear: 2026, filing: 'joint', dependents: [], rmdAges: { you: 75, partner: 75 },
      buckets: { groups: [group('taxable', 140_000, 105_000), group('tax-deferred', 360_000), group('roth', 70_000), group('hsa', 25_000)], roth: [{ owner: 'you', amount: 45_000 }], total: 595_000 } as unknown as DetailedInput['buckets'],
      savingsSplit: [{ bucket: 'taxable', share: 18 / 50 }, { bucket: 'tax-deferred', share: 24 / 50 }, { bucket: 'roth', share: 8 / 50 }],
      share457: { you: 0, partner: 0 }, inflation: 0.03, taxableYield: 0.02,
      health: { coverage: { kind: 'aca', adult: 11_000, quotedAge: 50, child: null }, medicareExtra: 0, meetsRule: [], countMedicaid: false, acaLaw: '2026', growth: 0.021, incomeGrowth: 0.011 },
      state: 'NV', stateRate: 0, paidToday: 0, strategy: NO_STRATEGY, law: LAW_2026, lawYear: { year: 2026, behind: false },
    };
    const measure = (strategy: Strategy) => {
      const job = { ...input, strategy };
      const f = planFigures(plan, { spending: null, savings: null, assets: null }, { count: ON, detailed: detailWork(job) });
      if ('refused' in f) throw new Error('refused');
      let runs = 0;
      const ms = readMs(() => {
        runs = tuneRuns(f, job).length;
      });
      return { ms, runs };
    };
    const grid = measure(NO_STRATEGY);
    const fixed = measure({ order: 'standard', conversions: { kind: 'fixed', yearly: 40_000 }, convertUntil: null });
    if (process.env.TAX_TIMING) console.log(JSON.stringify({ tuneRuns: grid.runs, tuneMs: +grid.ms.toFixed(1), tuneFixedRuns: fixed.runs, tuneFixedMs: +fixed.ms.toFixed(1) }));
    expect(grid.runs).toBe(252);
    expect(fixed.runs).toBe(2_352);
    expect(grid.ms).toBeLessThan(1_500);
    expect(fixed.ms).toBeLessThan(6_000);
  }, 60_000);
});
