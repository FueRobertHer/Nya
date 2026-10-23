import { describe, expect, test } from 'bun:test';
import { realReturn } from '@/lib/fire/derive';
import { baristaFiNumber, coastFiNumber, fiNumber, projectBalance, yearsToTarget } from '@/lib/fire/fi';
import { makeMarket, monthLabel, type Market } from '@/lib/fire/market';
import { usMarket } from '@/lib/fire/us-market';
import { seededRandom } from '@/lib/fire/random';
import {
  canRunOut,
  constantReal,
  floorAndCeiling,
  guytonKlinger,
  percentOfPortfolio,
  plannedWithdrawal,
  variablePercentage,
  vpwExpectedReturn,
  vpwShare,
  withRate,
  type RuleSpec,
  type YearState,
} from '@/lib/fire/rules';
import {
  checkPlan,
  historicalCycles,
  historicalStarts,
  monteCarlo,
  quantile,
  simulate,
  successGrid,
  type SimPlan,
  type SimResult,
} from '@/lib/fire/simulate';

/** A market where every month returns the same, `years` long. */
function flatMarket(years: number, monthly: { stocks?: number; bonds?: number; inflation?: number } = {}): Market {
  const n = years * 12;
  return makeMarket('2000-01', new Array(n).fill(monthly.stocks ?? 0), new Array(n).fill(monthly.bonds ?? 0), new Array(n).fill(monthly.inflation ?? 0));
}

function plan(over: Partial<SimPlan> = {}): SimPlan {
  return {
    startBalance: 1_000_000,
    years: 30,
    allocation: { stocks: 0.75, bonds: 0.25, cash: 0 },
    rebalance: 'annual',
    fee: 0,
    taxRate: 0,
    rule: { kind: 'constant', rate: 0.04 },
    income: [],
    oneOffs: [],
    cashRealReturn: 0,
    ...over,
  };
}

const state = (over: Partial<YearState> = {}): YearState => ({
  year: 1,
  years: 30,
  balance: 1_000_000,
  startBalance: 1_000_000,
  previous: 40_000,
  initial: 40_000,
  lastNominalReturn: 0.05,
  lastInflation: 0.03,
  ...over,
});

describe('the FI number and its variants', () => {
  test('spending divided by the withdrawal rate, grossed up for tax on withdrawals', () => {
    expect(fiNumber(40_000, 0.04)).toBeCloseTo(1_000_000, 6);
    // A 20% tax leaves 80 cents of each dollar withdrawn: 50,000 a year to spend 40,000.
    expect(fiNumber(40_000, 0.04, 0.2)).toBeCloseTo(1_250_000, 6);
    expect(fiNumber(-5, 0.04)).toBe(0);
    expect(() => fiNumber(40_000, 0)).toThrow(RangeError);
    expect(() => fiNumber(40_000, 0.04, 1)).toThrow(RangeError);
    expect(() => fiNumber(40_000, NaN)).toThrow(RangeError);
  });

  test('Barista FI: part-time income covers part of the spending', () => {
    expect(baristaFiNumber(40_000, 15_000, 0.04)).toBeCloseTo(625_000, 6);
    // Income above the spending leaves nothing for the portfolio to cover.
    expect(baristaFiNumber(40_000, 50_000, 0.04)).toBe(0);
    expect(baristaFiNumber(40_000, -10, 0.04)).toBeCloseTo(1_000_000, 6);
  });

  test('a projected balance compounds the assets and the end-of-year savings', () => {
    // 100,000 x 1.05^10 + 10,000 x (1.05^10 - 1) / 0.05.
    expect(projectBalance(100_000, 10_000, 0.05, 10)).toBeCloseTo(100_000 * 1.05 ** 10 + 10_000 * ((1.05 ** 10 - 1) / 0.05), 6);
    expect(projectBalance(100_000, 10_000, 0, 10)).toBe(200_000);
    expect(projectBalance(100_000, 0, -0.1, 1)).toBeCloseTo(90_000, 6);
  });

  test('Coast FI discounts the FI number back to today at the real return', () => {
    expect(coastFiNumber(1_000_000, 0.05, 20)).toBeCloseTo(1_000_000 / 1.05 ** 20, 6);
    // Already at the target age: nothing left to grow.
    expect(coastFiNumber(1_000_000, 0.05, 0)).toBe(1_000_000);
    expect(coastFiNumber(1_000_000, 0.05, -3)).toBe(1_000_000);
  });

  // The closed form must agree with saving and growing year by year: the first
  // whole year the balance reaches the target is the closed form rounded up.
  function bruteForceYears(assets: number, savings: number, g: number, target: number): number {
    let b = assets;
    for (let n = 0; n <= 500; n++) {
      if (b >= target - 1e-6) return n;
      b = b * (1 + g) + savings;
    }
    return Infinity;
  }

  test('years to FI agrees with a year-by-year projection in every case', () => {
    const cases: [number, number, number, number][] = [
      [100_000, 30_000, 0.05, 1_000_000], // the usual case
      [0, 20_000, 0.07, 500_000], // starting from nothing
      [250_000, 0, 0.05, 1_000_000], // no savings, growth alone
      [100_000, 30_000, 0, 1_000_000], // no growth
      [100_000, -2_000, 0.05, 1_000_000], // spending down, but growth outpaces it
      [100_000, 30_000, -0.02, 1_000_000], // a negative return that savings still beat
      [100_000, 10_000, -0.02, 1_000_000], // a negative return that holds it below
      [100_000, -10_000, 0.05, 1_000_000], // withdrawals bigger than the growth
      [0, 0, 0.05, 1_000_000], // nothing at all
      [100_000, 0, 0, 1_000_000],
      [100_000, 0, -0.05, 1_000_000],
    ];
    for (const [a, c, g, t] of cases) {
      const closed = yearsToTarget(a, c, g, t);
      const brute = bruteForceYears(a, c, g, t);
      if (brute === Infinity) expect(closed).toBe(Infinity);
      else expect(Math.ceil(closed - 1e-9)).toBe(brute);
    }
  });

  test('years to FI is zero once there, and exact at whole years', () => {
    expect(yearsToTarget(1_000_000, 0, 0.05, 1_000_000)).toBe(0);
    expect(yearsToTarget(2_000_000, -50_000, -0.05, 1_000_000)).toBe(0);
    const t = projectBalance(100_000, 25_000, 0.05, 12);
    expect(yearsToTarget(100_000, 25_000, 0.05, t)).toBeCloseTo(12, 9);
  });
});

describe('withdrawal rules', () => {
  test('constant real: the first year’s amount, every year, whatever the balance', () => {
    expect(constantReal(0.04, state({ year: 0, previous: 0, initial: 0 }))).toBeCloseTo(40_000, 9);
    expect(constantReal(0.04, state({ year: 7, balance: 10_000, initial: 40_000 }))).toBe(40_000);
  });

  test('percent of portfolio: a share of this year’s balance', () => {
    expect(percentOfPortfolio(0.04, state({ balance: 500_000 }))).toBeCloseTo(20_000, 9);
  });

  describe('guardrails', () => {
    test('the first year takes the rate', () => {
      expect(guytonKlinger(0.05, state({ year: 0, balance: 800_000, previous: 0, initial: 0 }))).toBeCloseTo(40_000, 9);
    });

    test('a normal year keeps last year’s withdrawal in real terms', () => {
      expect(guytonKlinger(0.04, state({ previous: 40_000, balance: 1_000_000 }))).toBe(40_000);
    });

    test('after a losing year, with the rate above where it started, the raise for inflation is skipped', () => {
      // 40,000 of 900,000 is 4.4%, above 4%: frozen in nominal terms, so its
      // real value falls by last year's 3% inflation.
      const w = guytonKlinger(0.04, state({ previous: 40_000, balance: 900_000, lastNominalReturn: -0.1, lastInflation: 0.03 }));
      expect(w).toBeCloseTo(40_000 / 1.03, 9);
      // Deflation does not turn the skipped raise into a real increase.
      expect(guytonKlinger(0.04, state({ previous: 40_000, balance: 900_000, lastNominalReturn: -0.1, lastInflation: -0.02 }))).toBe(40_000);
    });

    test('after a losing year with the rate still at or below where it started, the raise happens', () => {
      expect(guytonKlinger(0.04, state({ previous: 40_000, balance: 1_100_000, lastNominalReturn: -0.05 }))).toBe(40_000);
    });

    test('capital preservation: 20% above the starting rate cuts 10%, except in the last 15 years', () => {
      // 40,000 of 800,000 is 5%, more than 4% x 1.2 = 4.8%.
      expect(guytonKlinger(0.04, state({ previous: 40_000, balance: 800_000 }))).toBeCloseTo(36_000, 9);
      expect(guytonKlinger(0.04, state({ year: 15, years: 30, previous: 40_000, balance: 800_000 }))).toBe(40_000);
      expect(guytonKlinger(0.04, state({ year: 14, years: 30, previous: 40_000, balance: 800_000 }))).toBeCloseTo(36_000, 9);
    });

    test('prosperity: 20% below the starting rate raises 10%', () => {
      // 40,000 of 1,300,000 is 3.08%, under 4% x 0.8 = 3.2%.
      expect(guytonKlinger(0.04, state({ previous: 40_000, balance: 1_300_000 }))).toBeCloseTo(44_000, 9);
    });
  });

  describe('VPW', () => {
    test('spends everything in the last year, and 1/n a year at a zero expected return', () => {
      expect(vpwShare(0.05, 1)).toBe(1);
      expect(vpwShare(0.05, 0)).toBe(1);
      expect(vpwShare(0, 4)).toBe(0.25);
    });

    test('pays the same real amount every year, ending at zero, when the expected return arrives', () => {
      const g = 0.04;
      let balance = 1_000_000;
      const paid: number[] = [];
      for (let y = 0; y < 30; y++) {
        const w = variablePercentage(g, state({ year: y, years: 30, balance }));
        paid.push(w);
        balance = (balance - w) * (1 + g);
      }
      for (const w of paid) expect(w).toBeCloseTo(paid[0], 6);
      expect(balance).toBeCloseTo(0, 6);
    });

    test('expects a return from the allocation', () => {
      expect(vpwExpectedReturn({ stocks: 0.6, bonds: 0.4, cash: 0 })).toBeCloseTo(0.6 * 0.05 + 0.4 * 0.02, 12);
    });
  });

  test('floor and ceiling: a percent of the portfolio, kept between two multiples of the first year', () => {
    expect(floorAndCeiling(0.04, 0.9, 1.25, state({ year: 0, balance: 1_000_000 }))).toBeCloseTo(40_000, 9);
    expect(floorAndCeiling(0.04, 0.9, 1.25, state({ balance: 500_000, initial: 40_000 }))).toBeCloseTo(36_000, 9);
    expect(floorAndCeiling(0.04, 0.9, 1.25, state({ balance: 2_000_000, initial: 40_000 }))).toBeCloseTo(50_000, 9);
    expect(floorAndCeiling(0.04, 0.9, 1.25, state({ balance: 1_100_000, initial: 40_000 }))).toBeCloseTo(44_000, 9);
  });

  test('dispatch, rate swaps and which rules can run out', () => {
    const s = state({ balance: 500_000 });
    expect(plannedWithdrawal({ kind: 'percent', rate: 0.04 }, s)).toBeCloseTo(20_000, 9);
    expect(plannedWithdrawal({ kind: 'constant', rate: 0.04 }, s)).toBe(40_000);
    expect(withRate({ kind: 'constant', rate: 0.04 }, 0.03)).toEqual({ kind: 'constant', rate: 0.03 });
    expect(withRate({ kind: 'vpw', expectedReturn: 0.04 }, 0.03)).toBeNull();
    expect(canRunOut('constant')).toBe(true);
    expect(canRunOut('guardrails')).toBe(true);
    expect(canRunOut('floor-ceiling')).toBe(true);
    expect(canRunOut('percent')).toBe(false);
    expect(canRunOut('vpw')).toBe(false);
  });
});

/** Every path of a result on a flat market is the same, so any band will do. */
const balances = (r: SimResult) => r.balance.p50;

describe('the simulator: no value appears from nowhere', () => {
  test('with zero returns and inflation, the balance is the start plus deposits minus withdrawals', () => {
    for (const rebalance of ['annual', 'monthly', 'none'] as const) {
      const r = historicalCycles(
        plan({
          rebalance,
          income: [{ amount: 50_000, fromYear: 10, inflationAdjusted: true }],
          oneOffs: [{ amount: 100_000, year: 5 }],
        }),
        flatMarket(40)
      );
      // Years 0-9 withdraw 40,000 each, year 5 another 100,000, and from year
      // 10 the income is 10,000 more than the spending, which is invested.
      expect(r.ending.p50).toBeCloseTo(1_000_000 - 40_000 * 10 - 100_000 + 10_000 * 20, 6);
      expect(balances(r)[1]).toBeCloseTo(960_000, 6);
      expect(balances(r)[6]).toBeCloseTo(1_000_000 - 40_000 * 6 - 100_000, 6);
      expect(r.successRate).toBe(1);
    }
  });

  test('tax grosses up every withdrawal, and only withdrawals', () => {
    const r = historicalCycles(
      plan({
        taxRate: 0.25,
        income: [{ amount: 50_000, fromYear: 10, inflationAdjusted: true }],
        oneOffs: [{ amount: 100_000, year: 5 }],
      }),
      flatMarket(40)
    );
    // 4% is 40,000 withdrawn, 30,000 to spend after tax. Year 5 needs
    // 130,000 after tax, 173,333 before. From year 10 the income covers the
    // 30,000 and 20,000 more is invested, untaxed.
    expect(r.firstYearSpending).toBeCloseTo(30_000, 6);
    expect(r.ending.p50).toBeCloseTo(1_000_000 - 40_000 * 9 - 130_000 / 0.75 + 20_000 * 20, 6);
  });

  test('the fee compounds to its annual rate', () => {
    const r = historicalCycles(plan({ fee: 0.01, rule: { kind: 'constant', rate: 0 }, years: 10 }), flatMarket(20));
    expect(r.ending.p50).toBeCloseTo(1_000_000 * 0.99 ** 10, 6);
  });

  test('cash earns its real return', () => {
    const r = historicalCycles(
      plan({ allocation: { stocks: 0, bonds: 0, cash: 1 }, cashRealReturn: 0.01, rule: { kind: 'constant', rate: 0 }, years: 10 }),
      flatMarket(20)
    );
    expect(r.ending.p50).toBeCloseTo(1_000_000 * 1.01 ** 10, 6);
  });
});

describe('the simulator: inflation is applied exactly once', () => {
  // Every nominal return equals inflation, so every real return is exactly
  // zero (the same realReturn the generator uses). A plan that adjusted its
  // withdrawals for inflation as well would drift away from these figures.
  const monthlyInflation = 0.01;
  const inflated = (years: number) =>
    flatMarket(years, {
      stocks: realReturn(monthlyInflation, monthlyInflation),
      bonds: realReturn(monthlyInflation, monthlyInflation),
      inflation: monthlyInflation,
    });
  const yearFactor = (1 + monthlyInflation) ** 12;

  test('a constant real withdrawal takes the same real amount every year', () => {
    const r = historicalCycles(plan({ startBalance: 100_000, years: 5, rule: { kind: 'constant', rate: 0.1 } }), inflated(5));
    expect(balances(r)).toEqual([100_000, 90_000, 80_000, 70_000, 60_000, 50_000].map((v) => expect.closeTo(v, 6)) as unknown as number[]);
  });

  test('income that keeps up with inflation keeps its value, and a fixed pension loses it after it starts', () => {
    const run = (inflationAdjusted: boolean) =>
      historicalCycles(
        plan({
          startBalance: 100_000,
          years: 5,
          rule: { kind: 'constant', rate: 0.1 },
          income: [{ amount: 6_000, fromYear: 2, inflationAdjusted }],
        }),
        inflated(5)
      ).ending.p50;
    // Years 0 and 1 take 10,000; from year 2 the income pays 6,000 of it.
    expect(run(true)).toBeCloseTo(100_000 - 20_000 - 3 * 4_000, 6);
    // The fixed pension is worth 6,000 in year 2, then 6,000 / 1.01^12, then
    // 6,000 / 1.01^24 in today's dollars: the portfolio makes up the difference.
    expect(run(false)).toBeCloseTo(100_000 - 20_000 - 4_000 - (10_000 - 6_000 / yearFactor) - (10_000 - 6_000 / yearFactor ** 2), 6);
  });
});

describe('the simulator: running out', () => {
  test('a plan that pays every year to the end succeeds, even at zero', () => {
    const r = historicalCycles(plan({ startBalance: 100, years: 10, rule: { kind: 'constant', rate: 0.1 } }), flatMarket(10));
    expect(r.successRate).toBe(1);
    expect(r.ending.p50).toBeCloseTo(0, 9);
  });

  test('a plan that cannot pay a year in full has run out that year, and holds nothing after', () => {
    const r = historicalCycles(plan({ startBalance: 100, years: 11, rule: { kind: 'constant', rate: 0.1 } }), flatMarket(11));
    expect(r.successRate).toBe(0);
    expect(r.worst[0].failedYear).toBe(10);
    expect(r.worst[0].endBalance).toBe(0);
    expect(r.spending).toBeNull();
    expect(r.lowestSpending).toBeNull();
    expect(balances(r)[11]).toBe(0);
  });

  test('a one-off bigger than the balance empties even a percent-of-portfolio plan', () => {
    const r = historicalCycles(
      plan({ rule: { kind: 'percent', rate: 0.04 }, years: 10, oneOffs: [{ amount: 2_000_000, year: 3 }] }),
      flatMarket(10)
    );
    expect(r.successRate).toBe(0);
    expect(r.worst[0].failedYear).toBe(3);
  });

  test('VPW ends at zero, by design, and that is a success', () => {
    const r = historicalCycles(plan({ rule: { kind: 'vpw', expectedReturn: 0.03 } }), usMarket());
    expect(r.successRate).toBe(1);
    expect(r.ending.p90).toBeCloseTo(0, 6);
  });
});

describe('the simulator: rebalancing', () => {
  // Stocks double in the first month of each year; bonds stay flat.
  const doubling = makeMarket(
    '2000-01',
    Array.from({ length: 24 }, (_, i) => (i % 12 === 0 ? 1 : 0)),
    new Array(24).fill(0),
    new Array(24).fill(0)
  );
  const run = (rebalance: SimPlan['rebalance']) =>
    historicalCycles(
      plan({ startBalance: 100, years: 2, allocation: { stocks: 0.5, bonds: 0.5, cash: 0 }, rebalance, rule: { kind: 'constant', rate: 0 } }),
      doubling
    ).ending.p50;

  test('never rebalanced, the stocks keep their gains: 50 -> 100 -> 200, plus 50 of bonds', () => {
    expect(run('none')).toBeCloseTo(250, 9);
  });

  test('rebalanced yearly or monthly, half is sold back into bonds each time: 150, then 75 x 2 + 75', () => {
    expect(run('annual')).toBeCloseTo(225, 9);
    expect(run('monthly')).toBeCloseTo(225, 9);
  });
});

describe('the simulator: properties on the real history', () => {
  const us = usMarket();

  test('a higher withdrawal rate never raises the success rate', () => {
    for (const method of ['historical', 'monte-carlo'] as const) {
      for (const years of [30, 50]) {
        let last = 1;
        for (let rate = 0.02; rate <= 0.0701; rate += 0.0025) {
          const r = simulate(method, plan({ years, rule: { kind: 'constant', rate } }), us, { runs: 1000 });
          expect(r.successRate).toBeLessThanOrEqual(last);
          last = r.successRate;
        }
      }
    }
  });

  test('Monte Carlo: a longer plan never succeeds more often than a shorter one (the same runs, extended)', () => {
    let last = 1;
    for (const years of [10, 20, 30, 40, 50, 60]) {
      const r = monteCarlo(plan({ years, rule: { kind: 'constant', rate: 0.045 } }), us, { runs: 1000 });
      expect(r.successRate).toBeLessThanOrEqual(last);
      last = r.successRate;
    }
  });

  test('the same seed gives the same Monte Carlo result, and another seed another', () => {
    const p = plan({ rule: { kind: 'guardrails', rate: 0.05 } });
    const a = monteCarlo(p, us, { runs: 2000, seed: 7 });
    const b = monteCarlo(p, us, { runs: 2000, seed: 7 });
    expect(a).toEqual(b);
    const c = monteCarlo(p, us, { runs: 2000, seed: 8 });
    expect(c.balance.p50).not.toEqual(a.balance.p50);
    expect(a.seed).toBe(7);
    expect(a.runs).toBe(2000);
    expect(a.blockMonths).toBe(60);
  });

  test('no NaN, no negative balance, and ordered percentiles, across random plans', () => {
    const random = seededRandom(2024);
    const pick = <T>(xs: readonly T[]) => xs[Math.floor(random() * xs.length)];
    const rules: (() => RuleSpec)[] = [
      () => ({ kind: 'constant', rate: random() * 0.08 }),
      () => ({ kind: 'percent', rate: random() * 0.08 }),
      () => ({ kind: 'guardrails', rate: 0.02 + random() * 0.06 }),
      () => ({ kind: 'vpw', expectedReturn: random() * 0.06 - 0.01 }),
      () => ({ kind: 'floor-ceiling', rate: random() * 0.08, floor: 0.5 + random() * 0.5, ceiling: 1 + random() }),
    ];
    for (let i = 0; i < 40; i++) {
      // Whole tenths, so no share comes out a hair below zero.
      const stocks = Math.floor(random() * 11);
      const bonds = Math.floor(random() * (11 - stocks));
      const p = plan({
        startBalance: Math.round(random() * 3_000_000),
        years: 5 + Math.floor(random() * 56),
        allocation: { stocks: stocks / 10, bonds: bonds / 10, cash: (10 - stocks - bonds) / 10 },
        rebalance: pick(['annual', 'monthly', 'none'] as const),
        fee: random() * 0.02,
        taxRate: random() * 0.4,
        rule: pick(rules)(),
        income: random() < 0.5 ? [{ amount: random() * 60_000, fromYear: Math.floor(random() * 30), inflationAdjusted: random() < 0.5 }] : [],
        oneOffs: random() < 0.5 ? [{ amount: random() * 300_000, year: Math.floor(random() * 30) }] : [],
        cashRealReturn: random() * 0.02 - 0.01,
      });
      const r = simulate(pick(['historical', 'monte-carlo'] as const), p, us, { runs: 300, seed: i });
      expect(r.successRate).toBeGreaterThanOrEqual(0);
      expect(r.successRate).toBeLessThanOrEqual(1);
      expect(r.balance.p50).toHaveLength(p.years + 1);
      const series = [r.balance, ...(r.spending ? [r.spending] : [])];
      for (const b of series) {
        for (let y = 0; y < b.p50.length; y++) {
          const q = [b.p10[y], b.p25[y], b.p50[y], b.p75[y], b.p90[y]];
          for (const v of q) {
            expect(Number.isFinite(v)).toBe(true);
            expect(v).toBeGreaterThanOrEqual(0);
          }
          for (let k = 1; k < q.length; k++) expect(q[k]).toBeGreaterThanOrEqual(q[k - 1]);
        }
      }
      for (const w of r.worst) {
        expect(Number.isFinite(w.endBalance) && w.endBalance >= 0).toBe(true);
        expect(Number.isFinite(w.lowestSpending) && w.lowestSpending >= 0).toBe(true);
      }
      expect(Number.isFinite(r.firstYearSpending)).toBe(true);
    }
  });

  test('historical cycles start in every month that leaves the whole plan inside the data', () => {
    const r = historicalCycles(plan(), us);
    expect(r.paths).toBe(us.months - 360 + 1);
    expect(r.paths).toBe(historicalStarts(us, 30));
    expect(r.firstStart).toBe('1871-01');
    expect(r.lastStart).toBe('1993-06');
    expect(historicalStarts(us, 60)).toBe(1110);
  });

  test('the worst starts are listed once per calendar year, worst first', () => {
    const r = historicalCycles(plan({ rule: { kind: 'constant', rate: 0.045 } }), us);
    const years = r.worst.map((w) => w.start!.slice(0, 4));
    expect(new Set(years).size).toBe(years.length);
    const failedAt = r.worst.map((w) => (w.failedYear === null ? Infinity : w.failedYear));
    for (let i = 1; i < failedAt.length; i++) expect(failedAt[i]).toBeGreaterThanOrEqual(failedAt[i - 1]);
  });

  test('a flexible rule never runs out, and reports how far spending fell instead', () => {
    const r = historicalCycles(plan({ rule: { kind: 'percent', rate: 0.05 } }), us);
    expect(r.successRate).toBe(1);
    expect(r.lowestSpending!.amount).toBeLessThan(r.firstYearSpending);
    expect(r.lowestSpending!.start).toMatch(/^\d{4}-\d{2}$/);
  });
});

describe('the grid', () => {
  const us = usMarket();

  test('a cell is the plan at that rate and length, and the plan’s own cell matches its result', () => {
    const p = plan();
    const cells = successGrid('historical', p, us, [0.03, 0.04, 0.05], [20, 30]);
    expect(cells.map((c) => [c.rate, c.years])).toEqual([[0.03, 20], [0.04, 20], [0.05, 20], [0.03, 30], [0.04, 30], [0.05, 30]]);
    const own = cells.find((c) => c.rate === 0.04 && c.years === 30)!;
    expect(own.successRate).toBe(historicalCycles(p, us).successRate);
    const mc = successGrid('monte-carlo', p, us, [0.04], [30], { runs: 1500 });
    expect(mc[0].successRate).toBe(monteCarlo(p, us, { runs: 1500 }).successRate);
  });

  test('VPW has no rate to vary: one cell per length, whatever rates are asked for', () => {
    const cells = successGrid('historical', plan({ rule: { kind: 'vpw', expectedReturn: 0.04 } }), us, [0.03, 0.04], [20, 30]);
    expect(cells.map((c) => [c.rate, c.years])).toEqual([[null, 20], [null, 30]]);
    expect(cells[1].successRate).toBe(1);
    expect(cells[1].lowestSpendingShare!).toBeGreaterThan(0);
  });

  // A 60-year plan can only start up to 1963, a 50-year one up to 1973: each
  // column says where its starts end.
  test('historical cells say which starts they cover; Monte Carlo cells have no dates', () => {
    const cells = successGrid('historical', plan(), us, [0.04], [30, 50, 60]);
    expect(cells.map((c) => [c.firstStart, c.lastStart, c.paths])).toEqual([
      ['1871-01', '1993-06', 1470],
      ['1871-01', '1973-06', 1230],
      ['1871-01', '1963-06', 1110],
    ]);
    const [mc] = successGrid('monte-carlo', plan(), us, [0.04], [30], { runs: 100 });
    expect([mc.firstStart, mc.lastStart]).toEqual([null, null]);
  });

  test('a flexible rule’s cells say how far spending fell', () => {
    const [cell] = successGrid('historical', plan({ rule: { kind: 'percent', rate: 0.05 } }), us, [0.05], [30]);
    expect(cell.successRate).toBe(1);
    expect(cell.lowestSpendingShare!).toBeGreaterThan(0);
    expect(cell.lowestSpendingShare!).toBeLessThan(1);
  });
});

describe('the flexible rules, on the real history', () => {
  const us = usMarket();
  const random = seededRandom(31);
  const pick = <T>(xs: readonly T[]) => xs[Math.floor(random() * xs.length)];
  /** One stretch of the history, so a historical run is exactly one path. */
  const window = (years: number) => {
    const start = Math.floor(random() * (us.months - years * 12 + 1));
    const end = start + years * 12;
    return makeMarket(monthLabel(us, start), us.stocks.slice(start, end), us.bonds.slice(start, end), us.inflation.slice(start, end));
  };

  test('VPW never runs out, still holds money in its last year, and ends at exactly zero', () => {
    for (let i = 0; i < 60; i++) {
      const years = 10 + Math.floor(random() * 51);
      const r = historicalCycles(
        plan({ years, rule: { kind: 'vpw', expectedReturn: random() * 0.06 }, rebalance: pick(['annual', 'monthly', 'none'] as const), fee: random() * 0.01 }),
        window(years)
      );
      expect(r.paths).toBe(1);
      expect(r.successRate).toBe(1);
      expect(r.balance.p50[years - 1]).toBeGreaterThan(0);
      expect(r.ending.p50).toBe(0);
    }
    // With a tax on withdrawals the last withdrawal is grossed up and back,
    // which can leave a rounding error, never a real amount.
    const taxed = historicalCycles(plan({ rule: { kind: 'vpw', expectedReturn: 0.03 }, taxRate: 0.25 }), us);
    expect(taxed.successRate).toBe(1);
    expect(taxed.ending.p90).toBeLessThan(1e-6);
  });

  test('percent of portfolio never runs out, and never reaches zero, at any rate, mix or method', () => {
    for (let i = 0; i < 30; i++) {
      const stocks = Math.floor(random() * 11);
      const bonds = Math.floor(random() * (11 - stocks));
      const r = simulate(
        pick(['historical', 'monte-carlo'] as const),
        plan({
          years: 10 + Math.floor(random() * 51),
          allocation: { stocks: stocks / 10, bonds: bonds / 10, cash: (10 - stocks - bonds) / 10 },
          rebalance: pick(['annual', 'monthly', 'none'] as const),
          fee: random() * 0.02,
          taxRate: random() * 0.4,
          rule: { kind: 'percent', rate: 0.01 + random() * 0.14 },
        }),
        us,
        { runs: 300, seed: i }
      );
      expect(r.successRate).toBe(1);
      expect(Math.min(...r.balance.p10)).toBeGreaterThan(0);
    }
  });

  // Guyton and Klinger drop the capital preservation rule for the last 15
  // years: there, the only way the withdrawal falls is the skipped raise.
  test('guardrails never cut in the final 15 years', () => {
    for (let i = 0; i < 2_000; i++) {
      const years = 16 + Math.floor(random() * 45);
      const s = state({
        year: years - 1 - Math.floor(random() * 15), // 15 or fewer years left
        years,
        balance: 1 + random() * 2_000_000,
        previous: random() * 200_000,
        lastNominalReturn: random() * 0.6 - 0.3,
        lastInflation: random() * 0.2 - 0.05,
      });
      const rate = 0.02 + random() * 0.06;
      const w = guytonKlinger(rate, s);
      expect(w).toBeGreaterThanOrEqual((s.previous / (1 + Math.max(0, s.lastInflation))) * (1 - 1e-12));
    }
    // The same overspending state with 16 years left is cut.
    expect(guytonKlinger(0.04, state({ year: 14, years: 30, previous: 80_000, balance: 1_000_000 }))).toBeCloseTo(72_000, 9);
  });
});

describe('the engine refuses plans it cannot run honestly', () => {
  const bad: [string, Partial<SimPlan>][] = [
    ['a negative balance', { startBalance: -1 }],
    ['a NaN balance', { startBalance: NaN }],
    ['zero years', { years: 0 }],
    ['more years than it runs', { years: 61 }],
    ['a fractional length', { years: 30.5 }],
    ['an allocation over 100%', { allocation: { stocks: 0.8, bonds: 0.3, cash: 0 } }],
    ['a negative share', { allocation: { stocks: 1.2, bonds: -0.2, cash: 0 } }],
    ['a negative fee', { fee: -0.01 }],
    ['a tax of 100%', { taxRate: 1 }],
    ['a NaN rate', { rule: { kind: 'constant', rate: NaN } }],
    ['a negative rate', { rule: { kind: 'percent', rate: -0.01 } }],
    ['a floor above the ceiling', { rule: { kind: 'floor-ceiling', rate: 0.04, floor: 1.2, ceiling: 1.1 } }],
    ['negative income', { income: [{ amount: -1, fromYear: 0, inflationAdjusted: true }] }],
    ['a one-off before the plan', { oneOffs: [{ amount: 1, year: -1 }] }],
    ['cash losing everything', { cashRealReturn: -1 }],
  ];
  for (const [name, over] of bad) {
    test(name, () => {
      expect(() => checkPlan(plan(over))).toThrow(RangeError);
    });
  }

  test('a plan longer than the history has starts for', () => {
    expect(() => historicalCycles(plan({ years: 30 }), flatMarket(20))).toThrow(/too short/);
  });

  test('Monte Carlo blocks must be whole years', () => {
    expect(() => monteCarlo(plan(), usMarket(), { blockMonths: 30 })).toThrow(RangeError);
    expect(() => monteCarlo(plan(), usMarket(), { runs: 0 })).toThrow(RangeError);
  });
});

describe('quantiles', () => {
  test('interpolate between neighbours', () => {
    expect(quantile([1, 2, 3, 4], 0.5)).toBe(2.5);
    expect(quantile([1, 2, 3, 4], 0.1)).toBeCloseTo(1.3, 12);
    expect(quantile([5], 0.9)).toBe(5);
    expect(quantile([], 0.5)).toBe(0);
  });
});
