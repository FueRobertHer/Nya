import { describe, expect, test } from 'bun:test';
import { DEFAULT_PLAN, enginePlan, fiView, repairPlan, type FirePlan, type Measured, type PlanExpense, type PlanIncome } from '@/lib/fire/plan';
import { planFigures, type PlanFigures } from '@/lib/fire/plan-figures';
import { compileEvents, lastChange, walkToFi, type LifeEvent } from '@/lib/fire/events';
import {
  NO_CHANGES,
  applyScenario,
  currencyFor,
  hasAmounts,
  isPlanScenario,
  nameTaken,
  otherCurrency,
  parseScenarioDraft,
  recordSave,
  removeAdded,
  resolveScenario,
  restoreItem,
  scenarioChanges,
  unsetChange,
  type PlanScenario,
  type ScenarioChanges,
  type ScenarioDraft,
} from '@/lib/fire/scenarios';
import { makeMarket } from '@/lib/fire/market';
import { historicalCycles, simulate, successGrid, MAX_YEARS } from '@/lib/fire/simulate';
import { usMarket } from '@/lib/fire/us-market';
import { projectBalance, yearsToTarget } from '@/lib/fire/fi';

// Plan scenarios (lib/fire/scenarios.ts), their life events
// (lib/fire/events.ts) and one plan's figures (lib/fire/plan-figures.ts).
// Pure: no clock is read anywhere here; every case gives its own ages.

const us = usMarket();
const plan = (over: Partial<FirePlan> = {}): FirePlan => ({ ...DEFAULT_PLAN, ...over });
const income = (over: Partial<PlanIncome> = {}): PlanIncome => ({ id: 'ss', label: 'Social Security', amount: 24_000, fromAge: 67, inflationAdjusted: true, ...over });
const expense = (over: Partial<PlanExpense> = {}): PlanExpense => ({ id: 'roof', label: 'Roof', amount: 25_000, atAge: 70, ...over });
const changes = (over: Partial<ScenarioChanges> = {}): ScenarioChanges => ({ ...NO_CHANGES, ...over });
const figures = (p: FirePlan, m: Measured, events: LifeEvent[] = []): PlanFigures => {
  const f = planFigures(p, m, events);
  if ('refused' in f) throw new Error('refused');
  return f;
};
const sim = (f: PlanFigures) => {
  if (!('sim' in f.engine)) throw new Error('missing');
  return f.engine.sim;
};

const measured: Measured = { spending: 40_000, savings: 50_000, assets: 500_000 };
const thePlan = plan({ age: 40, targetAge: 55, income: [income()], expenses: [expense()] });

describe('the base Plan', () => {
  const starts: FirePlan['start'][] = ['fi-number', 'assets', 'custom'];
  const rules: FirePlan['rule'][] = ['constant', 'percent', 'guardrails', 'vpw', 'floor-ceiling'];

  test('a scenario with no changes resolves to the Plan, deep-equal, for every rule and start', () => {
    for (const start of starts) {
      for (const rule of rules) {
        const p = { ...thePlan, start, rule, startBalance: start === 'custom' ? 900_000 : null };
        const r = resolveScenario(p, NO_CHANGES);
        if (!r.ok) throw new Error(r.error);
        expect(r.plan).toEqual(p);
        expect(r.orphans).toEqual({ income: [], expenses: [] });
        expect(r.moot).toEqual({ income: [], expenses: [] });
      }
    }
  });

  test('its figures are fiView and enginePlan exactly, and its engine plan the same JSON (the same job)', () => {
    for (const start of starts) {
      const p = { ...thePlan, start, startBalance: start === 'custom' ? 900_000 : null };
      const view = fiView(p, measured);
      const f = figures(p, measured);
      expect(f.view).toEqual(view);
      expect(f.engine).toEqual(enginePlan(p, view));
      const r = resolveScenario(p, NO_CHANGES);
      if (!r.ok) throw new Error(r.error);
      expect(JSON.stringify(sim(figures(r.plan, measured)))).toBe(JSON.stringify(sim(f)));
    }
  });

  test('and the same SimResult, by either method', () => {
    const r = resolveScenario(thePlan, NO_CHANGES);
    if (!r.ok) throw new Error(r.error);
    for (const method of ['historical', 'monte-carlo'] as const) {
      expect(simulate(method, sim(figures(r.plan, measured)), us)).toEqual(simulate(method, sim(figures(thePlan, measured)), us));
    }
  });

  test('a repaired Plan is the base the same way', () => {
    const stored = { ...thePlan, withdrawalRate: 0.4 }; // past today's range
    const { plan: repaired, fixed } = repairPlan(stored);
    expect(fixed.length).toBe(1);
    const r = resolveScenario(repaired, NO_CHANGES);
    if (!r.ok) throw new Error(r.error);
    expect(r.plan).toEqual(repaired);
  });
});

describe('one change', () => {
  const cases: [keyof ScenarioChanges['set'], unknown, Partial<FirePlan>][] = [
    ['targetAge', 50, { targetAge: 50 }],
    ['spending', 48_000, { spending: 48_000 }],
    ['savings', 20_000, { savings: 20_000 }],
    ['assets', 650_000, { assets: 650_000 }],
    ['withdrawalRate', 0.035, { withdrawalRate: 0.035 }],
    ['realReturn', 0.04, { realReturn: 0.04 }],
    ['taxRate', 0.12, { taxRate: 0.12 }],
    ['rule', 'guardrails', { rule: 'guardrails' }],
    ['floor', 0.8, { floor: 0.8 }],
    ['ceiling', 1.5, { ceiling: 1.5 }],
    ['start', 'assets', { start: 'assets' }],
    ['horizon', 35, { horizon: 35 }],
    ['mix', { stocksPct: 60, bondsPct: 30 }, { stocksPct: 60, bondsPct: 30 }],
    ['rebalance', 'none', { rebalance: 'none' }],
    ['fee', 0.002, { fee: 0.002 }],
  ];

  test('each setting alone gives exactly the Plan with that value, by the same functions', () => {
    for (const [field, value, over] of cases) {
      const s = changes({ set: { [field]: value } });
      const r = resolveScenario(thePlan, s);
      if (!r.ok) throw new Error(`${field}: ${r.error}`);
      expect(r.plan).toEqual({ ...thePlan, ...over });
      const direct = { ...thePlan, ...over };
      expect(figures(r.plan, measured).view).toEqual(fiView(direct, measured));
      expect(figures(r.plan, measured).engine).toEqual(enginePlan(direct, fiView(direct, measured)));
    }
  });

  test('moves the result as the engine alone would, with the same seed', () => {
    for (const [field, value, over] of cases.filter(([f]) => ['targetAge', 'withdrawalRate', 'mix', 'rule'].includes(f))) {
      const r = resolveScenario(thePlan, changes({ set: { [field]: value } }));
      if (!r.ok) throw new Error(r.error);
      const direct = { ...thePlan, ...over };
      const alone = enginePlan(direct, fiView(direct, measured));
      if (!('sim' in alone)) throw new Error('missing');
      for (const method of ['historical', 'monte-carlo'] as const) {
        const got = simulate(method, sim(figures(r.plan, measured)), us);
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
    const w = walkToFi(500_000, 50_000, 0.05, 1_000_000, { costs: [{ year: 7, amount: 400_000 }], spans: [] });
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
    const still = walkToFi(200_000, -10_000, 0.05, 1_000_000, { costs: [], spans: [] });
    expect(still).toEqual({ years: Infinity });
  });

  test('its tail uses the savings after the last change, lasting changes included', () => {
    const w = { costs: [], spans: [{ from: 3, to: null, delta: -10_000 }] };
    expect(lastChange(w)).toBe(2);
    const r = walkToFi(100_000, 50_000, 0.05, 2_000_000, w);
    let bal = 100_000;
    for (let k = 0; k < 3; k++) bal = bal * 1.05 + 50_000;
    expect('years' in r && r.years).toBeCloseTo(3 + yearsToTarget(bal, 40_000, 0.05, 2_000_000), 9);
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
    const r = planFigures(plan({ age: 40, targetAge: 55 }), measured, [{ id: 'x', kind: 'spending', label: 'Less', fromAge: 41, yearly: -45_000, years: null }]);
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
    expect(c.walk).toEqual({ costs: [{ year: 8, amount: 100_000 }], spans: [{ from: 8, to: 13, delta: -6_000 }] });
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
    expect(c.walk).toEqual({ costs: [], spans: [] });
  });

  test('a change in spending: a lower cost as lowerSpending, never income', () => {
    const c = compileEvents([{ id: 'x', kind: 'spending', label: 'Mortgage paid', fromAge: 60, yearly: -18_000, years: null }], at);
    expect(c.sim.lowerSpending).toEqual([{ amount: 18_000, fromYear: 10 }]);
    expect(c.sim.income).toEqual([]);
    expect(c.later).toEqual([{ id: 'x', amount: -18_000, fromAge: 60 }]);
  });

  test('without an age: no today to walk from, or nothing to place by', () => {
    const e: LifeEvent = { id: 'c', kind: 'child', label: 'Child', fromAge: 45, yearly: 15_000, years: 18 };
    const noToday = compileEvents([e], { age: null, startAge: 50, years: 45 });
    expect(noToday.walk).toEqual({ costs: [], spans: [] });
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

describe('when the Plan changes later', () => {
  test('a Plan item it leaves out that is gone: nothing to leave out, said', () => {
    const s = changes({ income: { leaveOut: ['gone'], add: [] } });
    const r = resolveScenario(thePlan, s);
    if (!r.ok) throw new Error(r.error);
    expect(r.moot.income).toEqual(['gone']);
    expect(r.plan.income).toEqual(thePlan.income);
  });

  test('a replacement whose Plan item is gone is left out, never read as an addition', () => {
    const at62 = income({ id: 'ss', amount: 18_000, fromAge: 62, label: 'Social Security at 62' });
    const s = changes({ income: { leaveOut: ['ss'], add: [at62] } });
    const r = resolveScenario({ ...thePlan, income: [] }, s);
    if (!r.ok) throw new Error(r.error);
    expect(r.plan.income).toEqual([]);
    expect(r.orphans.income).toEqual([at62]);
    // While the Plan has it, it takes its place.
    const there = resolveScenario(thePlan, s);
    expect(there.ok && there.plan.income).toEqual([at62]);
  });

  test('a rule it breaks now: not run, with the reason', () => {
    const r = resolveScenario({ ...thePlan, age: 52 }, changes({ set: { targetAge: 50 } }));
    expect(r).toEqual({ ok: false, error: 'targetAge must not be before age', field: 'targetAge' });
    const full = { ...thePlan, income: [1, 2, 3, 4, 5].map((n) => income({ id: `i${n}` })) };
    const six = resolveScenario(full, changes({ income: { leaveOut: [], add: [income({ id: 'new' })] } }));
    expect(six.ok).toBe(false);
  });
});

describe('recording a form’s save', () => {
  const s0 = changes({ set: { targetAge: 50 } });
  const shown = () => applyScenario(thePlan, s0).plan;
  const roundTrip = (s: ScenarioChanges, next: FirePlan) => {
    const r = recordSave(thePlan, s, next);
    if ('error' in r) throw new Error(r.error);
    expect(applyScenario(thePlan, r.ok).plan).toEqual(next);
    return r.ok;
  };

  test('resolving what it records gives back exactly the plan the form saved', () => {
    roundTrip(s0, { ...shown(), withdrawalRate: 0.035 });
    roundTrip(s0, { ...shown(), spending: null, savings: 45_000 });
    roundTrip(s0, { ...shown(), income: [income({ amount: 20_000 })] });
    roundTrip(s0, { ...shown(), income: [] });
    roundTrip(s0, { ...shown(), expenses: [expense(), expense({ id: 'car', label: 'Car', amount: 30_000, atAge: 60 })] });
    roundTrip(s0, { ...shown(), targetAge: 52 });
  });

  test('either share changing records the mix with both; a typed balance records the balance with the start', () => {
    const mix = roundTrip(s0, { ...shown(), stocksPct: 60 });
    expect(mix.set.mix).toEqual({ stocksPct: 60, bondsPct: 25 });
    // The Plan's typed balance, kept as the form shows it: still recorded.
    const base = { ...thePlan, startBalance: 900_000 };
    const r = recordSave(base, s0, { ...applyScenario(base, s0).plan, start: 'custom' });
    expect('ok' in r && r.ok.set).toEqual({ targetAge: 50, start: 'custom', startBalance: 900_000 });
  });

  test('workplace plans written back in another order are the same setting', () => {
    const funded = { ...thePlan, planFunding: [{ account_id: 'a', paidFrom: 'bank' as const }, { account_id: 'b', paidFrom: 'payroll' as const }] };
    const next = { ...applyScenario(funded, s0).plan, savings: 40_000, planFunding: [{ account_id: 'b', paidFrom: 'payroll' as const }, { account_id: 'a', paidFrom: 'bank' as const }] };
    const r = recordSave(funded, s0, next);
    expect('ok' in r && r.ok.set).toEqual({ targetAge: 50, savings: 40_000 });
  });

  test('a value the form only wrote back, rounded to its grid, is not a change', () => {
    const offGrid = { ...thePlan, fee: 0.00123456 };
    const next = { ...applyScenario(offGrid, s0).plan, fee: 0.001235 }; // what the form's text gives back
    const r = recordSave(offGrid, s0, next);
    expect('ok' in r && r.ok.set).toEqual({ targetAge: 50 });
  });

  test('a change to what a scenario can’t hold is refused, in words, never dropped', () => {
    expect(recordSave(thePlan, s0, { ...shown(), age: 41 })).toEqual({ error: 'Your age is the same in every plan: change it with your plan open.' });
    expect('error' in recordSave(thePlan, s0, { ...shown(), method: 'monte-carlo' })).toBe(true);
    expect('error' in recordSave(thePlan, s0, { ...shown(), includeCash: true })).toBe(true);
    expect('error' in recordSave(thePlan, s0, { ...shown(), partTimeIncome: 10_000 })).toBe(true);
    expect('error' in recordSave(thePlan, s0, { ...shown(), planFunding: [{ account_id: 'a', paidFrom: 'bank' }] })).toBe(true);
    expect('error' in recordSave(thePlan, s0, { ...shown(), targetAge: null })).toBe(true);
  });

  test('keeps a replacement whose Plan item is gone, and drops a leave-out of one that is gone', () => {
    const orphan = income({ id: 'old', label: 'Pension', amount: 9_000 });
    const s = changes({ income: { leaveOut: ['old', 'gone'], add: [orphan] } });
    const r = recordSave(thePlan, s, { ...applyScenario(thePlan, s).plan, targetAge: 58 });
    expect('ok' in r && r.ok.income).toEqual({ leaveOut: ['old'], add: [orphan] });
  });

  test('removing a replaced item keeps the Plan’s out; Use your plan’s brings it back', () => {
    const at62 = income({ amount: 18_000, fromAge: 62 });
    const s = changes({ income: { leaveOut: ['ss'], add: [at62] } });
    const removed = roundTrip(s, { ...applyScenario(thePlan, s).plan, income: [] });
    expect(removed.income).toEqual({ leaveOut: ['ss'], add: [] });
    const back = restoreItem(thePlan, removed, 'income', 'ss');
    expect('ok' in back && applyScenario(thePlan, back.ok).plan.income).toEqual(thePlan.income);
  });
});

describe('Use your plan’s, and removing', () => {
  test('unsets one setting', () => {
    expect(unsetChange(changes({ set: { targetAge: 50, fee: 0.002 } }), 'fee').set).toEqual({ targetAge: 50 });
  });

  test('refuses, in words, to take a list past its limit', () => {
    const full = { ...thePlan, income: [1, 2, 3, 4, 5].map((n) => income({ id: `i${n}` })) };
    const s = changes({ income: { leaveOut: ['i1'], add: [income({ id: 'new' })] } });
    const r = restoreItem(full, s, 'income', 'i1');
    expect('error' in r && r.error).toContain('6 incomes');
  });

  test('removes an addition, and an orphan with its leave-out', () => {
    const s = changes({ income: { leaveOut: ['old'], add: [income({ id: 'old' }), income({ id: 'rent', label: 'Rent' })] } });
    expect(removeAdded(thePlan, s, 'income', 'old').income).toEqual({ leaveOut: [], add: [income({ id: 'rent', label: 'Rent' })] });
    expect(removeAdded(thePlan, s, 'income', 'rent').income.add.map((x) => x.id)).toEqual(['old']);
  });

  test('lists every change, in order', () => {
    const at62 = income({ amount: 18_000, fromAge: 62 });
    const s = changes({ set: { fee: 0.002, targetAge: 50 }, income: { leaveOut: ['ss', 'gone'], add: [at62] }, expenses: { leaveOut: ['roof'], add: [expense({ id: 'car' })] } });
    expect(scenarioChanges(thePlan, s).map((c) => c.kind + ('field' in c ? `:${c.field}` : ''))).toEqual(['set:targetAge', 'set:fee', 'moot', 'replaced', 'left-out', 'added']);
  });
});

describe('the stored shape', () => {
  const draft: ScenarioDraft = {
    name: 'Retire at 50',
    currency: 'USD',
    set: { targetAge: 50, spending: null, mix: { stocksPct: 80, bondsPct: 20 }, start: 'custom', startBalance: 800_000 },
    income: { leaveOut: ['ss'], add: [income({ amount: 18_000, fromAge: 62 })] },
    expenses: { leaveOut: [], add: [expense({ id: 'car' })] },
    events: [
      { id: 'h', kind: 'house', label: 'Home', atAge: 44, cost: 100_000, yearly: 6_000, years: null },
      { id: 'c', kind: 'child', label: 'Child', fromAge: 42, yearly: 15_000, years: 18 },
      { id: 's', kind: 'sabbatical', label: 'Off', fromAge: 45, years: 1, savingsLost: 80_000 },
      { id: 'p', kind: 'part-time', label: 'Part time', fromAge: 50, toAge: 60, yearly: 20_000 },
      { id: 'x', kind: 'spending', label: 'Less', fromAge: 65, yearly: -8_000, years: 10 },
    ],
  };
  const stored = (d: ScenarioDraft): PlanScenario => ({ version: 1, ...d, createdAt: '2026-10-20T10:00:00.000Z', savedAt: '2026-10-21T10:00:00.000Z', rev: 'r1' });

  test('a save takes what it should, and the stored shape reads back', () => {
    const r = parseScenarioDraft(draft);
    if (!('ok' in r)) throw new Error(r.error);
    expect(r.ok).toEqual(draft);
    expect(isPlanScenario(stored(r.ok))).toBe(true);
    expect(isPlanScenario(stored({ ...draft, set: {}, income: { leaveOut: [], add: [] }, expenses: { leaveOut: [], add: [] }, events: [], currency: null }))).toBe(true);
  });

  test('refuses an unknown field anywhere, and an unknown choice', () => {
    const s = stored(draft);
    expect(isPlanScenario({ ...s, extra: 1 })).toBe(false);
    expect(isPlanScenario({ ...s, set: { ...s.set, method: 'historical' } })).toBe(false);
    expect(isPlanScenario({ ...s, set: { ...s.set, rule: 'bengen-2' } })).toBe(false);
    expect(isPlanScenario({ ...s, set: { ...s.set, mix: { stocksPct: 80, bondsPct: 20, gold: 0 } } })).toBe(false);
    expect(isPlanScenario({ ...s, income: { ...s.income, note: '' } })).toBe(false);
    expect(isPlanScenario({ ...s, events: [{ ...s.events[0], extra: 1 }] })).toBe(false);
    expect(isPlanScenario({ ...s, events: [{ ...s.events[0], kind: 'windfall' }] })).toBe(false);
    expect(isPlanScenario({ ...s, version: 2 })).toBe(false);
  });

  test('a range narrowed after a save still reads, though a save refuses it', () => {
    const wide = stored({ ...draft, set: { withdrawalRate: 0.5 } });
    expect(isPlanScenario(wide)).toBe(true);
    expect('error' in parseScenarioDraft({ ...draft, set: { withdrawalRate: 0.5 } })).toBe(true);
  });

  const refused: [string, unknown][] = [
    ['no name', { ...draft, name: '  ' }],
    ['a long name', { ...draft, name: 'x'.repeat(41) }],
    ['a name on two lines', { ...draft, name: 'a\nb' }],
    ['amounts with no currency', { ...draft, currency: null }],
    ['an unknown currency', { ...draft, currency: 'XQZ' }],
    ['a setting it can’t change', { ...draft, set: { age: 50 } }],
    ['a retirement age of null', { ...draft, set: { targetAge: null } }],
    ['a typed balance with no balance', { ...draft, set: { start: 'custom' } }],
    ['a mix over 100', { ...draft, set: { mix: { stocksPct: 80, bondsPct: 30 } } }],
    ['six added incomes', { ...draft, income: { leaveOut: [], add: [1, 2, 3, 4, 5, 6].map((n) => income({ id: `i${n}` })) } }],
    ['twenty-one leave-outs', { ...draft, income: { leaveOut: Array.from({ length: 21 }, (_, i) => `x${i}`), add: [] } }],
    ['eleven events', { ...draft, events: Array.from({ length: 11 }, (_, i) => ({ ...draft.events[1], id: `c${i}` })) }],
    ['an event id twice', { ...draft, events: [draft.events[1], draft.events[1]] }],
    ['a child costing nothing', { ...draft, events: [{ ...draft.events[1], yearly: 0 }] }],
    ['part-time work ending before it starts', { ...draft, events: [{ ...draft.events[3], toAge: 50 }] }],
    ['a home with no cost and no change', { ...draft, events: [{ ...draft.events[0], cost: 0, yearly: 0 }] }],
    ['an extra field', { ...draft, note: 'x' }],
    ['a missing field', { name: 'x', currency: null, set: {}, income: { leaveOut: [], add: [] }, expenses: { leaveOut: [], add: [] } }],
  ];
  for (const [name, raw] of refused) {
    test(`refuses ${name}`, () => {
      expect('error' in parseScenarioDraft(raw)).toBe(true);
    });
  }
});

describe('names and currency', () => {
  test('two scenarios can’t share a name, in any case', () => {
    const list = [{ id: 'a', name: 'Retire at 50' }];
    expect(nameTaken(list, ' retire AT 50 ')).toBe(true);
    expect(nameTaken(list, 'Retire at 50', 'a')).toBe(false);
    expect(nameTaken(list, 'Retire at 52')).toBe(false);
  });

  test('the first amount records the Plan’s currency then; later saves keep the one typed in', () => {
    const none = { ...changes({ set: { targetAge: 50 } }), currency: 'USD' };
    const withAmount = changes({ set: { targetAge: 50, spending: 45_000 } });
    expect(hasAmounts(none)).toBe(false);
    expect(currencyFor(none, withAmount, 'EUR')).toBe('EUR');
    expect(currencyFor({ ...withAmount, currency: 'USD' }, withAmount, 'EUR')).toBe('USD');
    expect(currencyFor(null, withAmount, 'EUR')).toBe('EUR');
  });

  test('amounts typed in another currency than the Plan’s now are named; null on either side is the Plan’s', () => {
    const s = { ...changes({ set: { spending: 45_000 } }), currency: 'USD' };
    expect(otherCurrency(s, 'EUR')).toBe('USD');
    expect(otherCurrency(s, 'USD')).toBeNull();
    expect(otherCurrency(s, null)).toBeNull();
    expect(otherCurrency({ ...changes({ set: { targetAge: 50 } }), currency: 'USD' }, 'EUR')).toBeNull();
  });
});

describe('saving drops what can’t apply', () => {
  test('leave-outs of Plan items that are gone, unless a replacement still names one', async () => {
    const { pruneMoot } = await import('@/lib/fire/scenarios');
    const orphan = income({ id: 'old' });
    const s = changes({ income: { leaveOut: ['ss', 'gone', 'old'], add: [orphan] }, expenses: { leaveOut: ['roof', 'x'], add: [] } });
    const p = pruneMoot(thePlan, s);
    expect(p.income).toEqual({ leaveOut: ['ss', 'old'], add: [orphan] });
    expect(p.expenses).toEqual({ leaveOut: ['roof'], add: [] });
  });
});
