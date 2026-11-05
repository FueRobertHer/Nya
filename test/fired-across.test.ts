import { describe, expect, test } from 'bun:test';
import { acrossText } from '@/components/plan-items';
import { runPlanJob } from '@/lib/fire/jobs';
import { makeMarket } from '@/lib/fire/market';
import { firedAcross, type SimPlan } from '@/lib/fire/simulate';

// Across history (the tax plan's T3): where an item that waits on a run's own balance
// falls across the plan's runs, and how the item sheet says it.

/** Stocks up by `monthly` each month from the start, for `years` years. */
const rising = (years: number, monthly: (m: number) => number) => {
  const n = years * 12;
  return makeMarket('2000-01', Array.from({ length: n }, (_, m) => monthly(m)), new Array(n).fill(0), new Array(n).fill(0));
};

const PLAN = (years: number, triggers: number[]): SimPlan => ({
  startBalance: 100_000,
  years,
  allocation: { stocks: 1, bonds: 0, cash: 0 },
  rebalance: 'annual',
  fee: 0,
  taxRate: 0,
  rule: { kind: 'constant', rate: 0 },
  income: [],
  oneOffs: [],
  conditional: { triggers, items: [] },
  cashRealReturn: 0,
});

describe('firedAcross', () => {
  test('finds the year each run first starts at the trigger', () => {
    // 1% a month: each start month rides the same steady rise.
    const market = rising(40, () => 0.01);
    const r = firedAcross('historical', PLAN(10, [200_000]), market, 0, 0);
    // 100,000 at 12.68% a year passes 200,000 after six years.
    expect(r.fired).toBe(r.runs);
    expect(r.byHalf).toBe(6);
  });

  test('its offset moves the year, and one past the plan’s end doesn’t count', () => {
    const market = rising(40, () => 0.01);
    expect(firedAcross('historical', PLAN(10, [200_000]), market, 0, 2).byHalf).toBe(8);
    const late = firedAcross('historical', PLAN(10, [200_000]), market, 0, 4);
    expect(late.fired).toBe(0);
    expect(late.byHalf).toBeNull();
  });

  test('a run that never gets there isn’t counted, and half is of those that do', () => {
    // Rising for the first half of the history, flat after: later starts never get there.
    const market = rising(40, (m) => (m < 240 ? 0.01 : 0));
    const r = firedAcross('historical', PLAN(10, [150_000]), market, 0, 0);
    expect(r.fired).toBeGreaterThan(0);
    expect(r.fired).toBeLessThan(r.runs);
    expect(r.byHalf).toBe(4);
  });

  test('a trigger the plan doesn’t have is refused, and the job says so', () => {
    const market = rising(20, () => 0.01);
    expect(() => firedAcross('historical', PLAN(10, [200_000]), market, 1, 0)).toThrow('no such trigger');
    expect(runPlanJob({ kind: 'fired', method: 'historical', plan: PLAN(10, [200_000]), trigger: 1, offset: 0 }, market)).toMatchObject({ ok: false });
  });

  test('the job answers with it', () => {
    const market = rising(40, () => 0.01);
    expect(runPlanJob({ kind: 'fired', method: 'historical', plan: PLAN(10, [200_000]), trigger: 0, offset: 0 }, market)).toMatchObject({ ok: true, kind: 'fired', fired: { byHalf: 6 } });
  });
});

describe('its words', () => {
  test('the board’s line, every run and none', () => {
    expect(acrossText({ fired: { runs: 100, fired: 74, byHalf: 12 }, startAge: 50 })).toBe('It starts in 74% of runs, by 62 in half of those; in 26% of runs it never does');
    expect(acrossText({ fired: { runs: 100, fired: 100, byHalf: 12 }, startAge: 50 })).toBe('It starts in every run, by 62 in half of them');
    expect(acrossText({ fired: { runs: 100, fired: 0, byHalf: null }, startAge: 50 })).toBe('It never starts, in any run');
  });

  test('some and not all stay so, whatever the rounding says', () => {
    expect(acrossText({ fired: { runs: 1000, fired: 999, byHalf: 5 }, startAge: 50 })).toContain('99% of runs');
    expect(acrossText({ fired: { runs: 1000, fired: 999, byHalf: 5 }, startAge: 50 })).toContain('in 1% of runs it never does');
    expect(acrossText({ fired: { runs: 1000, fired: 1, byHalf: 5 }, startAge: 50 })).toContain('1% of runs');
  });
});
