import { describe, expect, test } from 'bun:test';
import { DEFAULT_PLAN, fiView, type FirePlan, type FiView, type Measured, type PlanExpense, type PlanIncome } from '@/lib/fire/plan';
import * as old from './fixtures/before-d15/fire/plan';
import type { PlanFigures } from '@/lib/fire/plan-figures';
import { lastChange, walkToFi, type LifeEvent } from '@/lib/fire/events';
import { makeMarket } from '@/lib/fire/market';
import { historicalCycles, simulate, successGrid, MAX_YEARS } from '@/lib/fire/simulate';
import { usMarket } from '@/lib/fire/us-market';
import { projectBalance, yearsToTarget } from '@/lib/fire/fi';
import { compileEvents, figuresOf } from './plan-gen';

/** The release before's engine plan, which placed the plan's income and
 *  one-offs itself (now planFigures adds them as items), without the lists
 *  it couldn't place (now the items' notes). */
function enginePlan(p: FirePlan, view: FiView) {
  const e = old.enginePlan(p, view);
  if ('missing' in e) return e;
  const { left: _left, beyond: _beyond, ...rest } = e;
  return rest;
}

// Life events (lib/fire/events.ts), compiled as items (lib/fire/compile.ts),
// and one plan's figures (lib/fire/plan-figures.ts).
// Pure: no clock is read anywhere here; every case gives its own ages.

const us = usMarket();
const plan = (over: Partial<FirePlan> = {}): FirePlan => ({ ...DEFAULT_PLAN, ...over });
const income = (over: Partial<PlanIncome> = {}): PlanIncome => ({ id: 'ss', label: 'Social Security', amount: 24_000, fromAge: 67, inflationAdjusted: true, ...over });
const expense = (over: Partial<PlanExpense> = {}): PlanExpense => ({ id: 'roof', label: 'Roof', amount: 25_000, atAge: 70, ...over });
const figures = (p: FirePlan, m: Measured, events: LifeEvent[] = []): PlanFigures => {
  const f = figuresOf(p, m, events);
  if ('refused' in f) throw new Error('refused');
  return f;
};
const sim = (f: PlanFigures) => {
  if (!('sim' in f.engine)) throw new Error('missing');
  return f.engine.sim;
};

const measured: Measured = { spending: 40_000, savings: 50_000, assets: 500_000 };
const thePlan = plan({ age: 40, targetAge: 55, income: [income()], expenses: [expense()] });

describe('a plan with nothing run beside it', () => {
  test('its figures are fiView and enginePlan exactly, for every start', () => {
    for (const start of ['fi-number', 'assets', 'custom'] as const) {
      const p = { ...thePlan, start, startBalance: start === 'custom' ? 900_000 : null };
      const view = fiView(p, measured);
      const f = figures(p, measured);
      expect(f.view).toEqual(view);
      expect(f.engine).toEqual(enginePlan(p, view));
    }
  });
});

describe('one setting changed', () => {
  const cases: [string, Partial<FirePlan>][] = [
    ['targetAge', { targetAge: 50 }],
    ['spending', { spending: 48_000 }],
    ['savings', { savings: 20_000 }],
    ['assets', { assets: 650_000 }],
    ['withdrawalRate', { withdrawalRate: 0.035 }],
    ['realReturn', { realReturn: 0.04 }],
    ['taxRate', { taxRate: 0.12 }],
    ['rule', { rule: 'guardrails' }],
    ['floor', { floor: 0.8 }],
    ['ceiling', { ceiling: 1.5 }],
    ['start', { start: 'assets' }],
    ['horizon', { horizon: 35 }],
    ['mix', { stocksPct: 60, bondsPct: 30 }],
    ['rebalance', { rebalance: 'none' }],
    ['fee', { fee: 0.002 }],
  ];

  test('its figures are fiView and enginePlan exactly', () => {
    for (const [, over] of cases) {
      const direct = { ...thePlan, ...over };
      expect(figures(direct, measured).view).toEqual(fiView(direct, measured));
      expect(figures(direct, measured).engine).toEqual(enginePlan(direct, fiView(direct, measured)));
    }
  });

  test('moves the result as the engine alone would, with the same seed', () => {
    for (const [, over] of cases.filter(([f]) => ['targetAge', 'withdrawalRate', 'mix', 'rule'].includes(f))) {
      const direct = { ...thePlan, ...over };
      const alone = enginePlan(direct, fiView(direct, measured));
      if (!('sim' in alone)) throw new Error('missing');
      for (const method of ['historical', 'monte-carlo'] as const) {
        const got = simulate(method, sim(figures(direct, measured)), us);
        expect(got).toEqual(simulate(method, alone.sim, us));
        if (method === 'monte-carlo') expect(got.seed).toBe(1);
      }
    }
  });
});

describe('the FI walk', () => {
  const p = plan({ age: 40, targetAge: 60 });

  test('with no events is yearsToTarget, the Plan’s own figure', () => {
    expect(figures(p, measured).view.yearsToFi).toBe(yearsToTarget(500_000, 50_000, 0.05, 1_000_000));
    expect(figures(p, measured).view.yearsToFi).toBeCloseTo(5.896, 3);
  });

  test('the hand-worked cases', () => {
    const child = figures(p, measured, [{ id: 'c', kind: 'child', label: 'A child', fromAge: 42, yearly: 15_000, years: 18 }]);
    expect(child.view.yearsToFi).toBeCloseTo(6.668, 3);
    expect(child.view.fiAge).toBeCloseTo(46.668, 3);
    const home = figures(p, measured, [{ id: 'h', kind: 'house', label: 'Our home', atAge: 44, cost: 100_000, yearly: 6_000, years: 30 }]);
    expect(home.view.yearsToFi).toBeCloseTo(7.264, 3);
    const sabbatical = figures(p, measured, [{ id: 's', kind: 'sabbatical', label: 'A year off', fromAge: 45, years: 1, savingsLost: 80_000 }]);
    expect(sabbatical.view.yearsToFi).toBeCloseTo(6.729, 3);
  });

  test('counts an event in every year it covers, past the retirement age too (review: a child across the target age)', () => {
    // Age 40, 300,000, saving 30,000, FI number 1,000,000, retiring at 50, a
    // child from 45 for 18 years at 15,000. Stopping the child's costs at 50
    // would give 12.985 years; they go on, and FI is 13.741 years away.
    const m: Measured = { spending: 40_000, savings: 30_000, assets: 300_000 };
    const f = figures(plan({ age: 40, targetAge: 50 }), m, [{ id: 'c', kind: 'child', label: 'A child', fromAge: 45, yearly: 15_000, years: 18 }]);
    expect(f.view.yearsToFi).toBeCloseTo(13.741, 3);
    expect(f.walked).toBe(true);
    // A start from today's assets walks the same way.
    const fromToday = figures(plan({ age: 40, targetAge: 50, start: 'assets' }), m, [{ id: 'c', kind: 'child', label: 'A child', fromAge: 45, yearly: 15_000, years: 18 }]);
    expect(fromToday.view.yearsToFi).toBeCloseTo(13.741, 3);
  });

  test('a cost after it first gets there that takes it back below moves the date to when it gets there again', () => {
    // Reached at 5.9 years; a home at 47 paying 400,000 from investments.
    const w = walkToFi(500_000, 50_000, 0.05, 1_000_000, { moneyIn: [], costs: [{ year: 7, amount: 400_000 }], spans: [] });
    if (!('years' in w)) throw new Error('short');
    expect(w.years).toBeGreaterThan(8);
    // Exactly: the balance after year 7's cost, then the closed form.
    let bal = 500_000;
    for (let k = 0; k < 7; k++) bal = bal * 1.05 + 50_000;
    bal -= 400_000;
    expect(w.years).toBeCloseTo(7 + yearsToTarget(bal, 50_000, 0.05, 1_000_000), 9);
  });

  test('a cost it can’t pay stops the FI date, never a negative balance or money from nowhere', () => {
    const f = figures(p, measured, [{ id: 'h', kind: 'house', label: 'Our home', atAge: 42, cost: 800_000, yearly: 0, years: null }]);
    expect(f.view.yearsToFi).toBeNull();
    expect(f.short).toEqual({ year: 2, have: 653_750, need: 800_000, kind: 'cost' });
    expect(f.startsWith?.more).toBe(true);
    // Savings below zero that would take the balance below zero, the same.
    const broke = figures(plan({ age: 40, targetAge: 60 }), { ...measured, assets: 50_000 }, [{ id: 's', kind: 'sabbatical', label: 'Off', fromAge: 40, years: 1, savingsLost: 120_000 }]);
    expect(broke.view.yearsToFi).toBeNull();
    expect(broke.short).toEqual({ year: 0, have: 50_000, need: 70_000, kind: 'savings' });
  });

  test('savings below zero for good, after the last change: where the balance would go below zero, never “never”', () => {
    // Age 40, 100,000, saving 30,000, and a home from 40 costing 40,000 a year
    // more for good: 10,000 a year below zero, from a balance earning 5,000.
    const f = figures(plan({ age: 40, targetAge: 55 }), { spending: 40_000, savings: 30_000, assets: 100_000 }, [
      { id: 'h', kind: 'house', label: 'Home', atAge: 40, cost: 0, yearly: 40_000, years: null },
    ]);
    expect(f.view.yearsToFi).toBeNull();
    expect(f.walkedSavings).toBe(-10_000);
    let bal = 100_000;
    for (let k = 0; k < 14; k++) bal = bal * 1.05 - 10_000;
    expect(f.short).toEqual({ year: 14, have: bal, need: 10_000, kind: 'savings' });
    expect(bal * 1.05 - 10_000).toBeLessThan(0);
    // Saving below zero exactly what it earns: it holds still, and is never there.
    const still = walkToFi(200_000, -10_000, 0.05, 1_000_000, { moneyIn: [], costs: [], spans: [] });
    expect(still).toEqual({ years: Infinity });
  });

  test('its tail uses the savings after the last change, lasting changes included', () => {
    const w = { moneyIn: [], costs: [], spans: [{ from: 3, to: null, delta: -10_000 }] };
    expect(lastChange(w)).toBe(2);
    const r = walkToFi(100_000, 50_000, 0.05, 2_000_000, w);
    let bal = 100_000;
    for (let k = 0; k < 3; k++) bal = bal * 1.05 + 50_000;
    expect('years' in r && r.years).toBeCloseTo(3 + yearsToTarget(bal, 40_000, 0.05, 2_000_000), 9);
  });

  test('a windfall: in at the start of its year, then the closed form from there', () => {
    // 500,000, saving 50,000 at 5%: 653,750 at 42, and 300,000 in then.
    const f = figures(p, measured, [{ id: 'w', kind: 'windfall', label: 'Gift', atAge: 42, amount: 300_000 }]);
    expect(f.walked).toBe(true);
    expect(f.view.yearsToFi).toBeCloseTo(2 + yearsToTarget(953_750, 50_000, 0.05, 1_000_000), 9);
    expect(f.view.yearsToFi).toBeLessThan(3);
    // Enough to reach the FI number on the day it comes: FI at 42 exactly.
    const big = figures(p, measured, [{ id: 'w', kind: 'windfall', label: 'Gift', atAge: 42, amount: 400_000 }]);
    expect(big.view.yearsToFi).toBe(2);
    // The balance at the stop age is the closed form, plus the windfall grown from 42 to 60.
    expect(f.view.atTargetAge).toBeCloseTo(projectBalance(500_000, 50_000, 0.05, 20) + 300_000 * 1.05 ** 18, 6);
  });

  test('a windfall pays a cost in its own year: it arrives first', () => {
    const home = { id: 'h', kind: 'house', label: 'Home', atAge: 42, cost: 900_000, yearly: 0, years: null } as const;
    expect(figures(p, measured, [home]).short).toEqual({ year: 2, have: 653_750, need: 900_000, kind: 'cost' });
    const f = figures(p, measured, [home, { id: 'w', kind: 'windfall', label: 'Gift', atAge: 42, amount: 300_000 }]);
    expect(f.short).toBeNull();
    // 953,750 in hand, 900,000 out: 53,750 left, then the closed form.
    const w = walkToFi(500_000, 50_000, 0.05, 1_000_000, { moneyIn: [{ year: 2, amount: 300_000 }], costs: [{ year: 2, amount: 900_000 }], spans: [] });
    expect('years' in w && w.years).toBeCloseTo(2 + yearsToTarget(53_750, 50_000, 0.05, 1_000_000), 9);
    expect(f.view.yearsToFi).toBe((w as { years: number }).years);
    // Not enough: the shortfall says what there was, the windfall included.
    const less = figures(p, measured, [home, { id: 'w', kind: 'windfall', label: 'Gift', atAge: 42, amount: 100_000 }]);
    expect(less.short).toEqual({ year: 2, have: 753_750, need: 900_000, kind: 'cost' });
  });

  test('a raise: more saved from its age, for good, and the FI number as it was', () => {
    const f = figures(p, measured, [{ id: 'r', kind: 'raise', label: 'Raise', fromAge: 42, yearly: 10_000 }]);
    expect(f.view.fiNumber).toBe(1_000_000);
    expect(f.retirement).toBeNull();
    expect(f.walkedSavings).toBe(60_000);
    let bal = 500_000;
    for (let k = 0; k < 2; k++) bal = bal * 1.05 + 50_000;
    expect(f.view.yearsToFi).toBeCloseTo(2 + yearsToTarget(bal, 60_000, 0.05, 1_000_000), 9);
    expect(f.view.yearsToFi).toBeLessThan(figures(p, measured).view.yearsToFi as number);
  });

  test('cars every few years: each comes off the balance at its age', () => {
    const f = figures(p, measured, [{ id: 'v', kind: 'car', label: 'Cars', atAge: 41, cost: 40_000, every: 3, times: 2 }]);
    let bal = 500_000;
    for (let k = 0; k < 20; k++) {
      if (k === 1 || k === 4) bal -= 40_000;
      bal = bal * 1.05 + 50_000;
    }
    expect(f.view.atTargetAge).toBeCloseTo(bal, 6);
    expect(f.view.yearsToFi).toBeGreaterThan(figures(p, measured).view.yearsToFi as number);
  });

  test('a loan paid off before the stop age lowers the FI number and raises savings from then', () => {
    const f = figures(plan({ age: 40, targetAge: 55 }), measured, [{ id: 'l', kind: 'loan-end', label: 'Car loan', atAge: 45, yearly: 6_000 }]);
    expect(f.retirement).toEqual({ spending: 34_000, lasting: -6_000 });
    expect(f.view.fiNumber).toBe(850_000);
    expect(f.walkedSavings).toBe(56_000);
  });
});

describe('lasting changes are retirement spending (review: a change in spending for good)', () => {
  test('+X for good from today is the same plan as spending S + X and saving X less: the same FI number, FI date and SimResult', () => {
    const X = 10_000;
    const p = plan({ age: 40, targetAge: 55, horizon: 40 });
    const asEvent = figures(p, measured, [{ id: 'x', kind: 'spending', label: 'More', fromAge: 40, yearly: X, years: null }]);
    const typed = figures({ ...p, spending: 40_000 + X, savings: 50_000 - X }, measured);
    expect(asEvent.view.fiNumber).toBe(typed.view.fiNumber);
    expect(asEvent.view.fiNumber).toBe(1_250_000);
    expect(asEvent.view.yearsToFi).toBe(typed.view.yearsToFi);
    expect(asEvent.retirement).toEqual({ spending: 50_000, lasting: X });
    expect(simulate('historical', sim(asEvent), us)).toEqual(simulate('historical', sim(typed), us));
    // Its display keeps today's spending, as measured.
    expect(asEvent.view.spending).toEqual({ value: 40_000, source: 'measured' });
  });

  test('from a later age before retirement: in the FI number, and the walk saves less from then', () => {
    const f = figures(plan({ age: 40, targetAge: 55 }), measured, [{ id: 'x', kind: 'spending', label: 'More', fromAge: 42, yearly: 10_000, years: null }]);
    expect(f.view.fiNumber).toBe(1_250_000);
    expect(f.events?.later).toEqual([]);
    // Two years at 50,000, then 40,000 a year towards 1,250,000.
    let bal = 500_000;
    for (let k = 0; k < 2; k++) bal = bal * 1.05 + 50_000;
    expect(f.view.yearsToFi).toBe(2 + yearsToTarget(bal, 40_000, 0.05, 1_250_000));
    expect(f.view.yearsToFi).toBeCloseTo(9.0443, 4);
  });

  test('a start from today’s assets withdraws the higher spending, at the rate it implies', () => {
    const f = figures(plan({ age: 40, targetAge: 55, start: 'assets' }), measured, [{ id: 'x', kind: 'spending', label: 'More', fromAge: 40, yearly: 10_000, years: null }]);
    expect('rate' in f.engine && f.engine.rate).toBeCloseTo(50_000 / 500_000, 12);
  });

  test('one that starts after retirement stays in the simulation, to the longest plan, and is named', () => {
    const f = figures(plan({ age: 40, targetAge: 55 }), measured, [{ id: 'x', kind: 'spending', label: 'Care', fromAge: 80, yearly: 12_000, years: null }]);
    expect(f.view.fiNumber).toBe(1_000_000);
    expect(f.events?.later).toEqual([{ id: 'x', amount: 12_000, fromAge: 80 }]);
    const years = sim(f).oneOffs.filter((o) => o.amount === 12_000).map((o) => o.year);
    expect(years[0]).toBe(25);
    expect(years[years.length - 1]).toBe(MAX_YEARS - 1);
  });

  test('taking retirement spending below zero is refused, never run', () => {
    const r = figuresOf(plan({ age: 40, targetAge: 55 }), measured, [{ id: 'x', kind: 'spending', label: 'Less', fromAge: 41, yearly: -45_000, years: null }]);
    expect(r).toEqual({ refused: 'below-zero', spending: 40_000, lasting: -45_000 });
  });
});

describe('retiring before the FI date (review: a plan that starts with money it wouldn’t have)', () => {
  const m: Measured = { spending: 40_000, savings: 30_000, assets: 300_000 };
  test('with life events, what the walk projects then', () => {
    // A child from 42 at 15,000: two years at 30,000, three at 15,000, to 45.
    const sw = figures(plan({ age: 40, targetAge: 45 }), m, [{ id: 'c', kind: 'child', label: 'A child', fromAge: 42, yearly: 15_000, years: 18 }]).startsWith;
    let bal = 300_000;
    for (let k = 0; k < 5; k++) bal = bal * 1.05 + (k < 2 ? 30_000 : 15_000);
    expect(sw?.projected).toBe(bal);
    expect(sw?.projected).toBeCloseTo(501_365.91, 2);
    expect(sw?.more).toBe(true);
    // Retiring at 60 instead, it would have more than its FI number then.
    const late = figures(plan({ age: 40, targetAge: 60 }), m, [{ id: 'c', kind: 'child', label: 'A child', fromAge: 42, yearly: 15_000, years: 18 }]).startsWith;
    expect(late?.more).toBe(false);
  });

  test('says what the walk projects at the retirement age, and that it starts with more', () => {
    const at45 = figures(plan({ age: 40, targetAge: 45 }), m).startsWith;
    expect(at45?.balance).toBe(1_000_000);
    expect(at45?.projected).toBeCloseTo(548_653.41, 1);
    expect(at45?.projected).toBe(projectBalance(300_000, 30_000, 0.05, 5));
    expect(at45?.more).toBe(true);
    const at55 = figures(plan({ age: 40, targetAge: 55 }), m).startsWith;
    expect(at55?.projected).toBeCloseTo(1_271_035, 0);
    expect(at55?.more).toBe(false);
    // A start from today's assets is what is there.
    expect(figures(plan({ age: 40, targetAge: 45, start: 'assets' }), m).startsWith).toEqual({ balance: 300_000, from: 'assets', atAge: 40, projected: null, short: null, more: false });
  });
});

describe('life events, kind by kind', () => {
  const at = { age: 40, startAge: 50, years: 45 };

  test('a home: its cost from investments in the walk and, when in retirement, as a one-off; its yearly change as savings, then in the simulation', () => {
    const c = compileEvents([{ id: 'h', kind: 'house', label: 'Home', atAge: 48, cost: 100_000, yearly: 6_000, years: 5 }], at);
    expect(c.walk).toEqual({ moneyIn: [], costs: [{ year: 8, amount: 100_000 }], spans: [{ from: 8, to: 13, delta: -6_000 }] });
    // Ages 50 to 52 of its five years are in retirement.
    expect(c.sim.oneOffs).toEqual([0, 1, 2].map((year) => ({ amount: 6_000, year })));
    const later = compileEvents([{ id: 'h', kind: 'house', label: 'Home', atAge: 60, cost: 200_000, yearly: -3_000, years: 10 }], at);
    expect(later.sim.oneOffs).toEqual([{ amount: 200_000, year: 10 }]);
    expect(later.sim.lowerSpending).toEqual([{ amount: 3_000, fromYear: 10, toYear: 20 }]);
  });

  test('a child: savings lower in each year, and a one-off in each year from retirement', () => {
    const c = compileEvents([{ id: 'c', kind: 'child', label: 'Child', fromAge: 45, yearly: 15_000, years: 18 }], at);
    expect(c.walk.spans).toEqual([{ from: 5, to: 23, delta: -15_000 }]);
    expect(c.sim.oneOffs.map((o) => o.year)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  });

  test('a sabbatical: savings lower; after retirement it changes nothing, and says so', () => {
    const before = compileEvents([{ id: 's', kind: 'sabbatical', label: 'Off', fromAge: 44, years: 2, savingsLost: 70_000 }], at);
    expect(before.walk.spans).toEqual([{ from: 4, to: 6, delta: -70_000 }]);
    expect(before.notes).toEqual([]);
    const after = compileEvents([{ id: 's', kind: 'sabbatical', label: 'Off', fromAge: 52, years: 1, savingsLost: 70_000 }], at);
    expect(after.notes).toEqual([{ id: 's', part: 'retired' }]);
    expect(after.sim).toEqual({ oneOffs: [], income: [], lowerSpending: [] });
  });

  test('part-time work: income for its years from retirement; before it, left out and said; never in the walk', () => {
    const c = compileEvents([{ id: 'p', kind: 'part-time', label: 'Part time', fromAge: 45, toAge: 56, yearly: 25_000 }], at);
    expect(c.sim.income).toEqual([{ amount: 25_000, fromYear: 0, toYear: 6, inflationAdjusted: true }]);
    expect(c.notes).toEqual([{ id: 'p', part: 'before-start' }]);
    expect(c.walk).toEqual({ moneyIn: [], costs: [], spans: [] });
  });

  test('a change in spending: a lower cost as lowerSpending, never income', () => {
    const c = compileEvents([{ id: 'x', kind: 'spending', label: 'Mortgage paid', fromAge: 60, yearly: -18_000, years: null }], at);
    expect(c.sim.lowerSpending).toEqual([{ amount: 18_000, fromYear: 10 }]);
    expect(c.sim.income).toEqual([]);
    expect(c.later).toEqual([{ id: 'x', amount: -18_000, fromAge: 60 }]);
  });

  test('a car once: its cost from investments in the walk, and a one-off when it comes after the stop age', () => {
    const before = compileEvents([{ id: 'v', kind: 'car', label: 'Car', atAge: 48, cost: 30_000, every: null, times: 1 }], at);
    expect(before.walk).toEqual({ moneyIn: [], costs: [{ year: 8, amount: 30_000 }], spans: [] });
    expect(before.sim).toEqual({ oneOffs: [], income: [], lowerSpending: [] });
    expect(before.notes).toEqual([]);
    const after = compileEvents([{ id: 'v', kind: 'car', label: 'Car', atAge: 55, cost: 30_000, every: null, times: 1 }], at);
    expect(after.sim.oneOffs).toEqual([{ amount: 30_000, year: 5 }]);
  });

  test('a car every few years: each one a cost at its own age, in the walk from today and in the simulation from the stop age', () => {
    const c = compileEvents([{ id: 'v', kind: 'car', label: 'Cars', atAge: 46, cost: 30_000, every: 8, times: 4 }], at);
    // At 46, 54, 62 and 70.
    expect(c.walk.costs).toEqual([6, 14, 22, 30].map((year) => ({ year, amount: 30_000 })));
    expect(c.sim.oneOffs).toEqual([4, 12, 20].map((year) => ({ amount: 30_000, year })));
    expect(c.lasting).toEqual([]);
    expect(c.later).toEqual([]);
    // The first before today counts from the next.
    const past = compileEvents([{ id: 'v', kind: 'car', label: 'Cars', atAge: 34, cost: 30_000, every: 8, times: 3 }], at);
    expect(past.walk.costs).toEqual([{ year: 2, amount: 30_000 }, { year: 10, amount: 30_000 }]);
    expect(past.notes).toEqual([{ id: 'v', part: 'past' }]);
    // Every one before today: already in your figures.
    const gone = compileEvents([{ id: 'v', kind: 'car', label: 'Cars', atAge: 30, cost: 30_000, every: 4, times: 2 }], at);
    expect([gone.walk.costs, gone.notes]).toEqual([[], [{ id: 'v', part: 'already' }]]);
  });

  test('a raise: more saved for good from its age, in the walk only; never retirement spending', () => {
    const c = compileEvents([{ id: 'r', kind: 'raise', label: 'Raise', fromAge: 42, yearly: 10_000 }], at);
    expect(c.walk).toEqual({ moneyIn: [], costs: [], spans: [{ from: 2, to: null, delta: 10_000 }] });
    expect(c.sim).toEqual({ oneOffs: [], income: [], lowerSpending: [] });
    expect(c.lasting).toEqual([]);
    expect(c.later).toEqual([]);
    expect(c.notes).toEqual([]);
    // After the stop age, still in the walk (it saves until FI), with nothing to note: it is never in the simulation.
    const late = compileEvents([{ id: 'r', kind: 'raise', label: 'Raise', fromAge: 52, yearly: 10_000 }], at);
    expect(late.walk.spans).toEqual([{ from: 12, to: null, delta: 10_000 }]);
    expect(late.notes).toEqual([]);
    // Before today: your savings already have it, so it is left out, never counted twice.
    const past = compileEvents([{ id: 'r', kind: 'raise', label: 'Raise', fromAge: 38, yearly: 10_000 }], at);
    expect(past.walk).toEqual({ moneyIn: [], costs: [], spans: [] });
    expect(past.notes).toEqual([{ id: 'r', part: 'already' }]);
    // Without your age, it can't be placed anywhere it counts.
    const noAge = compileEvents([{ id: 'r', kind: 'raise', label: 'Raise', fromAge: 42, yearly: 10_000 }], { ...at, age: null });
    expect(noAge.walk.spans).toEqual([]);
    expect(noAge.notes).toEqual([{ id: 'r', part: 'no-today-walk' }]);
    // The FI number is the plan's, whatever the raise.
    const p = plan({ age: 40, targetAge: 55 });
    expect(figures(p, measured, [{ id: 'r', kind: 'raise', label: 'Raise', fromAge: 42, yearly: 10_000 }]).view.fiNumber).toBe(figures(p, measured).view.fiNumber);
  });

  test('a windfall: money in, in the walk at its age and in the simulation as income for its one year from the stop age', () => {
    const before = compileEvents([{ id: 'w', kind: 'windfall', label: 'Gift', atAge: 45, amount: 200_000 }], at);
    expect(before.walk).toEqual({ moneyIn: [{ year: 5, amount: 200_000 }], costs: [], spans: [] });
    expect(before.sim).toEqual({ oneOffs: [], income: [], lowerSpending: [] });
    const after = compileEvents([{ id: 'w', kind: 'windfall', label: 'Gift', atAge: 60, amount: 200_000 }], at);
    expect(after.walk.moneyIn).toEqual([{ year: 20, amount: 200_000 }]);
    expect(after.sim.income).toEqual([{ amount: 200_000, fromYear: 10, toYear: 11, inflationAdjusted: true }]);
    expect(after.sim.oneOffs).toEqual([]);
    const past = compileEvents([{ id: 'w', kind: 'windfall', label: 'Gift', atAge: 38, amount: 200_000 }], at);
    expect(past.walk.moneyIn).toEqual([]);
    expect(past.notes).toEqual([{ id: 'w', part: 'already' }]);
    const late = compileEvents([{ id: 'w', kind: 'windfall', label: 'Gift', atAge: 100, amount: 200_000 }], at);
    expect(late.notes).toEqual([{ id: 'w', part: 'after-end' }]);
    expect(late.sim.income).toEqual([{ amount: 200_000, fromYear: 50, toYear: 51, inflationAdjusted: true }]);
    // Without your age: from the stop age the simulation places it; before
    // it, nothing can, and it says it is left out (review: not "placed").
    const noAge = { ...at, age: null };
    expect(compileEvents([{ id: 'w', kind: 'windfall', label: 'Gift', atAge: 60, amount: 200_000 }], noAge).notes).toEqual([{ id: 'w', part: 'no-today' }]);
    const early = compileEvents([{ id: 'w', kind: 'windfall', label: 'Gift', atAge: 45, amount: 200_000 }], noAge);
    expect([early.walk.moneyIn, early.sim.income, early.notes]).toEqual([[], [], [{ id: 'w', part: 'no-today-walk' }]]);
    const cars = compileEvents([{ id: 'v', kind: 'car', label: 'Cars', atAge: 44, cost: 30_000, every: 4, times: 2 }], noAge);
    expect([cars.sim.oneOffs, cars.notes]).toEqual([[], [{ id: 'v', part: 'no-today-walk' }]]);
  });

  test('a loan paid off: spending lower for good, as a change in spending of the same amount less', () => {
    for (const atAge of [48, 60]) {
      const loan = compileEvents([{ id: 'l', kind: 'loan-end', label: 'Loan', atAge, yearly: 18_000 }], at);
      const spending = compileEvents([{ id: 'l', kind: 'spending', label: 'Loan', fromAge: atAge, yearly: -18_000, years: null }], at);
      expect(loan).toEqual(spending);
    }
    const c = compileEvents([{ id: 'l', kind: 'loan-end', label: 'Loan', atAge: 48, yearly: 18_000 }], at);
    expect(c.walk.spans).toEqual([{ from: 8, to: null, delta: 18_000 }]);
    expect(c.lasting).toEqual([{ id: 'l', amount: -18_000 }]);
    const later = compileEvents([{ id: 'l', kind: 'loan-end', label: 'Loan', atAge: 60, yearly: 18_000 }], at);
    expect(later.sim.lowerSpending).toEqual([{ amount: 18_000, fromYear: 10 }]);
    expect(later.later).toEqual([{ id: 'l', amount: -18_000, fromAge: 60 }]);
    // Paid off before today: your measured spending is already without it.
    const past = compileEvents([{ id: 'l', kind: 'loan-end', label: 'Loan', atAge: 38, yearly: 18_000 }], at);
    expect([past.walk.spans, past.lasting, past.notes]).toEqual([[], [], [{ id: 'l', part: 'already' }]]);
  });

  test('without an age: no today to walk from, or nothing to place by', () => {
    const e: LifeEvent = { id: 'c', kind: 'child', label: 'Child', fromAge: 45, yearly: 15_000, years: 18 };
    const noToday = compileEvents([e], { age: null, startAge: 50, years: 45 });
    expect(noToday.walk).toEqual({ moneyIn: [], costs: [], spans: [] });
    expect(noToday.notes).toEqual([{ id: 'c', part: 'no-today' }]);
    expect(noToday.sim.oneOffs.length).toBe(13);
    expect(compileEvents([e], { age: null, startAge: null, years: 30 }).notes).toEqual([{ id: 'c', part: 'no-age' }]);
  });

  test('before today, its years count from today; after the plan ends, it is said', () => {
    const past = compileEvents([{ id: 'c', kind: 'child', label: 'Child', fromAge: 36, yearly: 15_000, years: 18 }], at);
    expect(past.walk.spans).toEqual([{ from: 0, to: 14, delta: -15_000 }]);
    expect(past.notes).toEqual([{ id: 'c', part: 'past' }]);
    const late = compileEvents([{ id: 'h', kind: 'house', label: 'Home', atAge: 100, cost: 50_000, yearly: 0, years: null }], at);
    expect(late.notes).toEqual([{ id: 'h', part: 'after-end' }]);
    expect(late.sim.oneOffs).toEqual([{ amount: 50_000, year: 50 }]);
  });

  test('a lower cost larger than the year’s spending makes no money (review: a decrease larger than the need)', () => {
    const z = new Array(12 * 31).fill(0);
    const flat = makeMarket('1900-01', z, z, z);
    const p = plan({ age: 60, targetAge: 60, start: 'custom', startBalance: 1_000_000, horizon: 10, rule: 'percent', stocksPct: 100, bondsPct: 0, fee: 0 });
    const f = figures(p, measured, [{ id: 'x', kind: 'spending', label: 'Less', fromAge: 61, yearly: -60_000, years: 9 }]);
    expect(sim(f).lowerSpending).toEqual([{ amount: 60_000, fromYear: 1, toYear: 10 }]);
    const r = historicalCycles(sim(f), flat);
    expect(r.ending.p50).toBeLessThanOrEqual(1_000_000);
    // The first year withdraws 4%; nothing after.
    expect(r.ending.p50).toBeCloseTo(960_000, 6);
  });

  test('in the simulation a windfall is money in, invested when the year doesn’t need it; a car is a one-off', () => {
    const z = new Array(12 * 31).fill(0);
    const flat = makeMarket('1900-01', z, z, z);
    // 1,000,000 from 60, 40,000 a year by the constant rule, no tax, no returns.
    const p = plan({ age: 60, targetAge: 60, start: 'custom', startBalance: 1_000_000, horizon: 10, stocksPct: 100, bondsPct: 0, fee: 0 });
    const end = (events: LifeEvent[]) => historicalCycles(sim(figures(p, measured, events)), flat).ending.p50;
    expect(end([])).toBeCloseTo(600_000, 6);
    // 100,000 in at 61: that year takes 40,000 from it and invests 60,000.
    expect(end([{ id: 'w', kind: 'windfall', label: 'Gift', atAge: 61, amount: 100_000 }])).toBeCloseTo(700_000, 6);
    // One at 60, the first year: the same.
    expect(end([{ id: 'w', kind: 'windfall', label: 'Gift', atAge: 60, amount: 100_000 }])).toBeCloseTo(700_000, 6);
    // Two cars, at 62 and 66.
    expect(end([{ id: 'v', kind: 'car', label: 'Cars', atAge: 62, cost: 25_000, every: 4, times: 2 }])).toBeCloseTo(550_000, 6);
    // A raise in retirement changes nothing.
    expect(end([{ id: 'r', kind: 'raise', label: 'Raise', fromAge: 62, yearly: 25_000 }])).toBeCloseTo(600_000, 6);
  });

  test('the grid’s longer columns count what is past the plan’s end: a 50-year cell equals a 50-year simulation', () => {
    const p = plan({ age: 40, targetAge: 55, horizon: 40 });
    const f = figures(p, measured, [
      { id: 'x', kind: 'spending', label: 'Care', fromAge: 85, yearly: 12_000, years: null },
      { id: 'y', kind: 'spending', label: 'Paid off', fromAge: 70, yearly: -5_000, years: 30 },
    ]);
    const s = sim(f);
    expect(s.years).toBe(40);
    for (const method of ['historical', 'monte-carlo'] as const) {
      const [cell] = successGrid(method, s, us, [0.04], [50]);
      expect(cell.successRate).toBe(simulate(method, { ...s, years: 50, rule: { kind: 'constant', rate: 0.04 } }, us).successRate);
    }
  });
});
