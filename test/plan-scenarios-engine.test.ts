import { describe, expect, test } from 'bun:test';
import { makeMarket } from '@/lib/fire/market';
import { checkPlan, historicalCycles, monteCarlo, simulate, successGrid, type SimPlan } from '@/lib/fire/simulate';
import { usMarket } from '@/lib/fire/us-market';

// The two additions the scenarios make to the engine (lib/fire/simulate.ts):
// income that ends (OtherIncome.toYear) and a lower cost (lowerSpending).
// Both are absent from every plan the Plan itself builds, so those run
// exactly as before: the golden tests and test/fire-engine.test.ts are
// unchanged, and the first tests here hold that bit for bit.

const us = usMarket();

/** A market where nothing earns anything and prices stand still: every
 *  balance can be worked out by hand. */
function flat(years: number) {
  const z = new Array(12 * (years + 1)).fill(0);
  return makeMarket('1900-01', z, z, z);
}

function plan(over: Partial<SimPlan> = {}): SimPlan {
  return {
    startBalance: 1_000_000,
    years: 40,
    allocation: { stocks: 0.75, bonds: 0.25, cash: 0 },
    rebalance: 'annual',
    fee: 0.001,
    taxRate: 0.1,
    rule: { kind: 'constant', rate: 0.04 },
    income: [{ amount: 18_000, fromYear: 7, inflationAdjusted: true }],
    oneOffs: [{ amount: 30_000, year: 3 }],
    cashRealReturn: 0,
    ...over,
  };
}

const flatPlan = (over: Partial<SimPlan> = {}) =>
  plan({ allocation: { stocks: 1, bonds: 0, cash: 0 }, fee: 0, taxRate: 0, income: [], oneOffs: [], ...over });

describe('income that ends', () => {
  test('one that ends at or after the plan’s end is the same plan, bit for bit, by either method', () => {
    for (const toYear of [40, 41, 60]) {
      const ending = plan({ income: [{ amount: 18_000, fromYear: 7, inflationAdjusted: true, toYear }] });
      expect(historicalCycles(ending, us)).toEqual(historicalCycles(plan(), us));
      expect(monteCarlo(ending, us)).toEqual(monteCarlo(plan(), us));
    }
  });

  test('stops in the year it says: part-time work for five years on a flat market', () => {
    const m = flat(40);
    // 1,000,000 at 40,000 a year runs out in plan year 25.
    expect(historicalCycles(flatPlan(), m).worst[0].failedYear).toBe(25);
    // 20,000 a year for the first five years: 900,000 left after them, then
    // 22 more years of 40,000 leave 20,000, short of year 27's.
    const partTime = flatPlan({ income: [{ amount: 20_000, fromYear: 0, toYear: 5, inflationAdjusted: true }] });
    expect(historicalCycles(partTime, m).worst[0].failedYear).toBe(27);
    // A fixed one is valued from its own start, and still stops.
    const fixed = flatPlan({ income: [{ amount: 20_000, fromYear: 0, toYear: 5, inflationAdjusted: false }] });
    expect(historicalCycles(fixed, m).worst[0].failedYear).toBe(27);
  });

  test('is refused unless it ends, a whole year, after it starts', () => {
    for (const toYear of [7, 3, 7.5, Number.NaN]) {
      expect(() => checkPlan(plan({ income: [{ amount: 1, fromYear: 7, inflationAdjusted: true, toYear }] }))).toThrow('other income must end after it starts');
    }
  });
});

describe('a lower cost', () => {
  test('absent or empty, the plan is the same plan, bit for bit', () => {
    expect(historicalCycles(plan({ lowerSpending: [] }), us)).toEqual(historicalCycles(plan(), us));
    expect(monteCarlo(plan({ lowerSpending: [] }), us)).toEqual(monteCarlo(plan(), us));
    // And nothing the Plan builds carries the field, so its JSON (the key the
    // tab caches answers by) is unchanged.
    expect(JSON.stringify(plan())).not.toContain('lowerSpending');
  });

  test('takes off the year’s spending: a mortgage paid off', () => {
    const m = flat(40);
    // 10,000 lower from year 10: 400,000 in ten years, then 30,000 a year
    // leaves 600,000 for 20 years exactly, so year 30 runs out.
    const lower = flatPlan({ lowerSpending: [{ amount: 10_000, fromYear: 10 }] });
    expect(historicalCycles(lower, m).worst[0].failedYear).toBe(30);
    // For ten years only, from year 10: 400,000, 300,000, then 300,000 at
    // 40,000 lasts 7 more years, short of year 27's.
    const span = flatPlan({ lowerSpending: [{ amount: 10_000, fromYear: 10, toYear: 20 }] });
    expect(historicalCycles(span, m).worst[0].failedYear).toBe(27);
  });

  test('never becomes money: larger than the year’s spending, nothing is withdrawn and nothing invested', () => {
    const m = flat(10);
    // Percent of portfolio spends 4% of the balance; a cost lower by more than
    // that leaves nothing to withdraw, so the balance stands still, and never
    // ends above where it started.
    const percent = flatPlan({ years: 10, rule: { kind: 'percent', rate: 0.04 } });
    const r = historicalCycles({ ...percent, lowerSpending: [{ amount: 50_000, fromYear: 0, toYear: 10 }] }, m);
    expect(r.ending.p50).toBe(1_000_000);
    expect(r.balance.p50.every((b) => b === 1_000_000)).toBe(true);
    expect(historicalCycles(percent, m).ending.p50).toBeLessThan(1_000_000);
  });

  test('no value appears from nowhere: on a flat market with no income, no year ends above the one before', () => {
    const m = flat(30);
    let seed = 7;
    const next = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
    const rules: SimPlan['rule'][] = [
      { kind: 'constant', rate: 0.04 },
      { kind: 'percent', rate: 0.05 },
      { kind: 'guardrails', rate: 0.045 },
      { kind: 'floor-ceiling', rate: 0.04, floor: 0.9, ceiling: 1.25 },
      { kind: 'vpw', expectedReturn: 0.03 },
    ];
    for (let i = 0; i < 60; i++) {
      const from = Math.floor(next() * 25);
      const p = flatPlan({
        years: 30,
        rule: rules[i % rules.length],
        taxRate: Math.round(next() * 30) / 100,
        oneOffs: [{ amount: Math.round(next() * 50_000), year: Math.floor(next() * 30) }],
        lowerSpending: [{ amount: Math.round(next() * 120_000), fromYear: from, toYear: next() < 0.5 ? undefined : from + 1 + Math.floor(next() * 5) }],
      });
      const bands = historicalCycles(p, m).balance.p50;
      for (let y = 1; y < bands.length; y++) expect(bands[y]).toBeLessThanOrEqual(bands[y - 1] + 1e-6);
      expect(bands[bands.length - 1]).toBeLessThanOrEqual(p.startBalance);
    }
  });

  test('a one-off and a lower cost of the same amount in the same year cancel', () => {
    const both = plan({ oneOffs: [{ amount: 30_000, year: 3 }, { amount: 12_000, year: 9 }], lowerSpending: [{ amount: 12_000, fromYear: 9, toYear: 10 }] });
    const a = historicalCycles(both, us);
    const b = historicalCycles(plan(), us);
    expect(a.successRate).toBe(b.successRate);
    expect(a.ending.p50).toBeCloseTo(b.ending.p50, 3);
    expect(a.ending.p10).toBeCloseTo(b.ending.p10, 3);
  });

  test('is refused without an amount and a plan year, or ending before it starts', () => {
    expect(() => checkPlan(plan({ lowerSpending: [{ amount: -1, fromYear: 0 }] }))).toThrow('a lower cost needs an amount and a plan year');
    expect(() => checkPlan(plan({ lowerSpending: [{ amount: 1, fromYear: -1 }] }))).toThrow('a lower cost needs an amount and a plan year');
    expect(() => checkPlan(plan({ lowerSpending: [{ amount: 1, fromYear: 4, toYear: 4 }] }))).toThrow('a lower cost must end after it starts');
  });
});

describe('the grid reaches past the plan’s end', () => {
  test('a 50-year cell of a 40-year plan is a 50-year simulation of the same plan, ended income and lower costs included', () => {
    const p = plan({
      income: [{ amount: 15_000, fromYear: 30, toYear: 45, inflationAdjusted: true }],
      oneOffs: Array.from({ length: 60 }, (_, year) => ({ amount: 5_000, year })),
      lowerSpending: [{ amount: 8_000, fromYear: 35 }],
    });
    for (const method of ['historical', 'monte-carlo'] as const) {
      const [cell] = successGrid(method, p, us, [0.04], [50]);
      expect(cell.successRate).toBe(simulate(method, { ...p, years: 50 }, us).successRate);
    }
  });
});
