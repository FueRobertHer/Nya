import { describe, expect, test } from 'bun:test';
import { seededRandom } from '@/lib/fire/random';
import { monteCarlo, type SimPlan } from '@/lib/fire/simulate';
import { LAW_2026 } from '@/lib/fire/tax/law/2026';
import { newPersonYear, newYearResult, runYear, type YearInput, type YearResult } from '@/lib/fire/tax/year';
import { usMarket } from '@/lib/fire/us-market';

// What the year costs: the year in a 5,000 by 40 loop, as a Monte Carlo job
// with taxes would run it, timed against today's flat Monte Carlo job of the
// same size on the same machine, so a slow runner slows both. A job with
// taxes is meant to take under 1 s on a mid-range phone; this test only
// measures. The bound guards against the year's work growing (a solver that
// walks every cell, say), not against a slow machine: a ratio of 200, about
// three times the 60 to 66 measured. Set TAX_TIMING=1 to print the figures,
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
  test('5,000 runs by 40 years of the year cost under 200 times the flat Monte Carlo job of the same size', () => {
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
    expect(total / flat).toBeLessThan(200);
    expect(total).toBeLessThan(20_000);
  }, 120_000);
});
