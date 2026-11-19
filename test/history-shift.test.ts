// The stress test's history moved by the accounts' own growth (version 2's
// `historyMoved`, lib/fire/account-growth.ts historyShift): every year of history
// moves by the accounts' gap from the plan's rate, in points added to the year's
// growth (lib/fire/simulate.ts runPaths, lib/fire/taxed-paths.ts). Off, with no
// account at its own rate, at the plan's rate or with invested assets typed, the
// run plan carries nothing and every run is history as it ran.

import { describe, expect, test } from 'bun:test';
import type { BucketsToday } from '@/lib/fire/buckets-today';
import { runPlanJob, type PlanJob } from '@/lib/fire/jobs';
import { makeMarket, type Market } from '@/lib/fire/market';
import { DEFAULT_PLAN, type AccountRate, type EnginePlan, type Measured } from '@/lib/fire/plan';
import { detailWork, type DetailedInput, type PlanDetail } from '@/lib/fire/plan-detail';
import { planFigures, type PlanFigures } from '@/lib/fire/plan-figures';
import { planOf, type FirePlanV2 } from '@/lib/fire/plan-v2';
import { checkPlan, historicalCycles, MAX_HISTORY_SHIFT, monteCarlo, type PathSource, type SimPlan } from '@/lib/fire/simulate';
import { taxedPaths, type SimTax } from '@/lib/fire/taxed-paths';
import { lawFor } from '@/lib/fire/tax/law';
import { NO_STRATEGY } from '@/lib/fire/tax/rules';
import { usMarket } from '@/lib/fire/us-market';
import { lastingKey } from '@/components/plan-search';
import { ON } from './plan-gen';

const US = usMarket();

const FLAT: SimPlan = {
  startBalance: 1000,
  years: 1,
  allocation: { stocks: 0.6, bonds: 0.4, cash: 0 },
  rebalance: 'annual',
  fee: 0,
  taxRate: 0,
  rule: { kind: 'constant', rate: 0 },
  income: [],
  oneOffs: [],
  cashRealReturn: 0,
};

/** A market whose every year earns `stocks` and `bonds` after inflation, with prices rising `inflation`. */
function steady(years: number, stocks: number, bonds = stocks, inflation = 0): Market {
  const n = years * 12;
  const monthly = (r: number) => new Array(n).fill((1 + r) ** (1 / 12) - 1);
  return makeMarket('2000-01', monthly(stocks), monthly(bonds), monthly(inflation));
}

/** The one historical start of a market exactly as long as the plan. */
function onlyStart(plan: SimPlan, market: Market) {
  const r = historicalCycles(plan, market);
  expect(r.paths).toBe(1);
  return r;
}

/** Each year's balance and spending agree, to within a millionth of the balance. */
function same(a: ReturnType<typeof onlyStart>, b: ReturnType<typeof onlyStart>) {
  const within = 1e-6 * Math.max(1, ...b.balance.p50);
  for (let y = 0; y < b.balance.p50.length; y++) expect(Math.abs(a.balance.p50[y] - b.balance.p50[y])).toBeLessThan(within);
  for (let y = 0; y < (b.spending?.p50.length ?? 0); y++) expect(Math.abs((a.spending as NonNullable<typeof a.spending>).p50[y] - (b.spending as NonNullable<typeof b.spending>).p50[y])).toBeLessThan(within);
  expect(a.successRate).toBe(b.successRate);
}

describe('the flat stress test', () => {
  test('one year by hand: the gap is added to the market’s year, not taken as a ratio', () => {
    // A 3% year with the plan at 5% and the accounts at 7%: 1.03 + 0.02. As a
    // ratio, 1.03 * 1.07 / 1.05, it would be 1049.62.
    expect(onlyStart({ ...FLAT, historyShift: 0.02 }, steady(1, 0.03)).ending.p50).toBeCloseTo(1050, 9);
    // The fee comes off after, as on history as it ran.
    expect(onlyStart({ ...FLAT, fee: 0.001, historyShift: 0.02 }, steady(1, 0.03)).ending.p50).toBeCloseTo(1050 * 0.999, 9);
    expect(onlyStart({ ...FLAT, historyShift: -0.02 }, steady(1, 0.03)).ending.p50).toBeCloseTo(1010, 9);
  });

  test('a gap of nothing is history as it ran, to the bit, by either method and every way of rebalancing', () => {
    const plan: SimPlan = { ...FLAT, startBalance: 1_000_000, years: 30, allocation: { stocks: 0.7, bonds: 0.2, cash: 0.1 }, fee: 0.0005, rule: { kind: 'guardrails', rate: 0.045 } };
    for (const rebalance of ['annual', 'monthly', 'none'] as const) {
      const p = { ...plan, rebalance };
      expect(historicalCycles({ ...p, historyShift: 0 }, US)).toEqual(historicalCycles(p, US));
      expect(monteCarlo({ ...p, historyShift: 0 }, US, { runs: 300 })).toEqual(monteCarlo(p, US, { runs: 300 }));
    }
  });

  test('moved by a gap, history runs as a market each year that much higher would, cash included', () => {
    // Stocks and bonds apart, so a mix left to drift moves; the guardrails read
    // last year's return, which the lower gap takes below nothing.
    const plan: SimPlan = { ...FLAT, startBalance: 1_000_000, years: 12, allocation: { stocks: 0.6, bonds: 0.3, cash: 0.1 }, cashRealReturn: 0.005 };
    for (const gap of [0.013, -0.07]) {
      for (const rebalance of ['annual', 'none'] as const) {
        for (const rule of [{ kind: 'constant', rate: 0.04 }, { kind: 'guardrails', rate: 0.05 }] as const) {
          const p = { ...plan, rebalance, rule };
          const moved = onlyStart({ ...p, historyShift: gap }, steady(12, 0.06, 0.01, 0.02));
          const higher = onlyStart({ ...p, cashRealReturn: p.cashRealReturn + gap }, steady(12, 1.06 + gap - 1, 1.01 + gap - 1, 0.02));
          same(moved, higher);
        }
      }
    }
    // Rebalanced each month the mix's year compounds, so a market with stocks and bonds alike.
    const p = { ...plan, allocation: { stocks: 0.6, bonds: 0.4, cash: 0 }, rebalance: 'monthly' as const, rule: { kind: 'guardrails' as const, rate: 0.05 } };
    same(onlyStart({ ...p, historyShift: -0.07 }, steady(12, 0.04, 0.04, 0.02)), onlyStart(p, steady(12, 1.04 - 0.07 - 1, 1.04 - 0.07 - 1, 0.02)));
  });

  test('the guardrails skip a raise after a year the gap takes below nothing', () => {
    // 2% after inflation and 3% inflation is about 5% a year; 6 points lower, about -1%.
    const plan: SimPlan = { ...FLAT, years: 2, rule: { kind: 'guardrails', rate: 0.04 } };
    const market = steady(2, 0.02, 0.02, 0.03);
    const asRan = onlyStart(plan, market).spending!.p50;
    const moved = onlyStart({ ...plan, historyShift: -0.06 }, market).spending!.p50;
    expect(asRan[1]).toBeCloseTo(asRan[0], 9);
    expect(moved[1]).toBeCloseTo(moved[0] / 1.03, 9);
  });

  test('a year never loses more than all of it', () => {
    for (const rebalance of ['annual', 'none'] as const) {
      const r = onlyStart({ ...FLAT, years: 3, rebalance, allocation: { stocks: 0.5, bonds: 0.3, cash: 0.2 }, historyShift: -1.5 }, steady(3, 0.03));
      expect(r.ending.p50).toBe(0);
      expect(Math.min(...r.balance.p10, ...r.balance.p50)).toBe(0);
    }
    expect(onlyStart({ ...FLAT, years: 3, rule: { kind: 'constant', rate: 0.04 }, historyShift: -1.5 }, steady(3, 0.03)).successRate).toBe(0);
  });

  test('a gap must be a number, within two whole years’ growth', () => {
    for (const historyShift of [Number.NaN, Infinity, MAX_HISTORY_SHIFT + 0.01, -MAX_HISTORY_SHIFT - 0.01]) {
      expect(() => checkPlan({ ...FLAT, historyShift })).toThrow('history can be moved by at most 200 points a year');
    }
    for (const historyShift of [MAX_HISTORY_SHIFT, -MAX_HISTORY_SHIFT, 0]) expect(() => checkPlan({ ...FLAT, historyShift })).not.toThrow();
    // With tax worked out every bucket says its own.
    for (const gaps of [{ taxable: 0, deferred: 0, deferred457: Number.NaN, roth: 0, hsa: 0 }, { taxable: 0, deferred: 0, roth: 0, hsa: 0 }]) {
      expect(() => checkPlan({ ...FLAT, tax: { historyShift: gaps } as unknown as SimTax })).toThrow('history can be moved by at most 200 points a year');
    }
  });

  test('on US history, a point a year moves the answer, by either method', () => {
    const plan: SimPlan = { ...FLAT, startBalance: 1_000_000, years: 40, allocation: { stocks: 0.8, bonds: 0.2, cash: 0 }, fee: 0.0005, rule: { kind: 'constant', rate: 0.045 } };
    const by = (historyShift: number) => ({ historical: historicalCycles({ ...plan, historyShift }, US).successRate, monteCarlo: monteCarlo({ ...plan, historyShift }, US, { runs: 1000 }).successRate });
    const lower = by(-0.01);
    const none = by(0);
    const higher = by(0.01);
    for (const method of ['historical', 'monteCarlo'] as const) {
      expect(lower[method]).toBeLessThan(none[method]);
      expect(higher[method]).toBeGreaterThan(none[method]);
    }
    // Measured on main: 82% of historical starts as history ran, 95% a point higher.
    expect(none.historical).toBeCloseTo(0.82, 1);
    expect(higher.historical).toBeGreaterThan(none.historical + 0.08);
  });
});

describe('every reader of history takes it from the run plan', () => {
  const plan: SimPlan = { ...FLAT, startBalance: 1_000_000, years: 40, allocation: { stocks: 0.8, bonds: 0.2, cash: 0 }, fee: 0.0005, rule: { kind: 'constant', rate: 0.045 } };
  const run = (job: PlanJob) => {
    const r = runPlanJob(job, US);
    if (!r.ok) throw new Error(r.error);
    return r;
  };

  test('the stress test, the grid and where an item that waits on a balance falls', () => {
    const moved = { ...plan, historyShift: 0.01 };
    const rate = (p: SimPlan) => (run({ kind: 'simulate', method: 'historical', plan: p }) as { result: { successRate: number } }).result.successRate;
    expect(rate(moved)).toBeGreaterThan(rate(plan));
    const cell = (p: SimPlan) => (run({ kind: 'grid-cell', method: 'monte-carlo', plan: p, rate: 0.05, years: 40 }) as { cell: { successRate: number } }).cell.successRate;
    expect(cell(moved)).toBeGreaterThan(cell(plan));
    const waits = { triggers: [2_000_000], items: [] };
    // More runs reach the balance a point higher (the year half of them do can come later, among more).
    const fired = (p: SimPlan) => (run({ kind: 'fired', method: 'historical', plan: { ...p, conditional: waits }, trigger: 0, offset: 0 }) as { fired: { fired: number } }).fired.fired;
    expect(fired(moved)).toBeGreaterThan(fired(plan));
  });

  test('the earliest stop that lasts, from the stored plan', () => {
    const stored: FirePlanV2 = { ...planOf({ ...DEFAULT_PLAN, age: 41, targetAge: 50, spending: 64_000, savings: 50_000, assets: null, realReturn: 0.05, withdrawalRate: 0.04, fee: 0.001, stocksPct: 75, bondsPct: 25 }), start: 'at-stop', lastsIn: 0.9, accounts: [{ account_id: 'brk', growth: 0.07, yield: null }] };
    const measured: Measured = { spending: null, savings: null, assets: 595_000, accounts: [{ id: 'brk', value: 140_000 }, { id: 'k', value: 455_000 }] };
    const age = (p: FirePlanV2) => {
      const r = run({ kind: 'earliest', method: 'historical', plan: p, measured, count: ON, detailed: null }) as { answer: { age: number | null } };
      return r.answer.age;
    };
    const asRan = age(stored);
    const moved = age({ ...stored, historyMoved: true });
    expect(asRan).not.toBeNull();
    expect(moved).toBeLessThan(asRan as number);
    // Its job is another, so an answer for one is never the other's.
    const job = (p: FirePlanV2) => lastingKey({ kind: 'earliest', method: 'historical', plan: p, measured, count: ON, detailed: null });
    expect(job({ ...stored, historyMoved: true })).not.toBe(job(stored));
  });
});

describe('the run plans', () => {
  const rate = (account_id: string, growth: number | null): AccountRate => ({ account_id, growth, yield: null });
  const account = (account_id: string, value: number, basis: number | null = null) => ({ owner: 'you', value, basis, account_id, bucket: account_id, income: null, subtype: 'x' });
  const grp = (bucket: string, ...accounts: ReturnType<typeof account>[]) => ({ bucket, accounts, total: accounts.reduce((s, a) => s + a.value, 0) });
  const BUCKETS = {
    groups: [grp('taxable', account('taxable', 300_000, 150_000)), grp('tax-deferred', account('tax-deferred', 500_000)), grp('roth', account('roth', 200_000))],
    roth: [{ owner: 'you', amount: 80_000 }],
    total: 1_000_000,
  } as unknown as Pick<BucketsToday, 'groups' | 'roth' | 'total'>;
  const input: DetailedInput = {
    calendarYear: 2026,
    filing: 'single',
    dependents: [],
    rmdAges: { you: 75, partner: 75 },
    buckets: BUCKETS,
    savingsSplit: [{ bucket: 'taxable', share: 1 }],
    share457: { you: 0, partner: 0 },
    inflation: 0.03,
    taxableYield: 0,
    health: { coverage: { kind: 'other', yearly: 6_000 }, medicareExtra: 0, meetsRule: [], countMedicaid: false, acaLaw: '2026', growth: 0.021, incomeGrowth: 0.011 },
    state: null,
    stateRate: 0,
    paidToday: 0,
    strategy: NO_STRATEGY,
    law: lawFor(2026).law,
    lawYear: { year: 2026, behind: false },
  };
  const work = detailWork(input);
  const M: Measured = { spending: null, savings: null, assets: 1_000_000, accounts: [{ id: 'taxable', value: 300_000 }, { id: 'tax-deferred', value: 500_000 }, { id: 'roth', value: 200_000 }] };
  const plan = (over: Partial<FirePlanV2> = {}): FirePlanV2 => ({ ...planOf({ ...DEFAULT_PLAN, age: 45, targetAge: 55, spending: 60_000, savings: 40_000, assets: null, realReturn: 0.05, withdrawalRate: 0.04, fee: 0 }), start: 'at-stop', ...over });
  const figures = (p: FirePlanV2, detailed = true): PlanFigures => {
    const f = planFigures(p, M, { count: ON, ...(detailed ? { detailed: work } : {}) });
    if ('refused' in f) throw new Error('refused');
    return f;
  };
  const engineOf = (f: PlanFigures): EnginePlan => {
    if (!('sim' in f.engine)) throw new Error('no engine');
    return f.engine;
  };
  const detailOf = (f: PlanFigures): PlanDetail => {
    if (f.detail === null || 'failed' in f.detail) throw new Error(`no detail: ${JSON.stringify(f.detail)}`);
    return f.detail;
  };
  const total = (b: { taxable: number; deferred: number; roth: number; hsa: number }) => b.taxable + b.deferred + b.roth + b.hsa;
  /** A run plan as history as it ran would have it. */
  const asRan = ({ historyShift: _flat, tax, ...sim }: SimPlan): SimPlan => {
    if (!tax) return sim;
    const { historyShift: _buckets, ...rest } = tax;
    return { ...sim, tax: rest };
  };
  /** One path's balances and spending on a market a plan's length long. */
  function onePath(sim: SimPlan, market: Market) {
    const source: PathSource = { count: 1, monthAt: (p, y) => p + 12 * y, label: () => null };
    const r = taxedPaths(sim, market, source, true);
    return { balances: Array.from(r.balances as Float64Array), spending: Array.from(r.spending as Float64Array), failedYear: r.failedYear[0] };
  }
  const OWN = [rate('taxable', 0.08), rate('roth', 0.06)];

  test('flat: the blend’s gap, only with history moved and an account at a rate of its own', () => {
    const on = engineOf(figures(plan({ accounts: OWN, historyMoved: true }), false));
    const f = figures(plan({ accounts: OWN, historyMoved: true }), false);
    expect(on.sim.historyShift).toBe(f.view.growth - 0.05);
    expect(on.sim.historyShift).toBeGreaterThan(0);
    for (const p of [plan({ accounts: OWN }), plan({ historyMoved: true }), plan({ accounts: [rate('taxable', 0.05)], historyMoved: true }), plan({ accounts: OWN, historyMoved: true, assets: 1_000_000 })]) {
      expect(Object.hasOwn(engineOf(figures(p, false)).sim, 'historyShift')).toBe(false);
    }
  });

  test('worked out: each bucket’s own gap, a bucket not said at the blend’s; nothing when nothing moves', () => {
    const f = figures(plan({ accounts: OWN, historyMoved: true }));
    const { sim } = engineOf(f);
    const blend = f.view.growth - 0.05;
    expect(sim.historyShift).toBe(blend);
    const gaps = sim.tax?.historyShift as NonNullable<SimTax['historyShift']>;
    expect(gaps.taxable).toBeCloseTo(0.03, 12);
    expect(gaps.roth).toBeCloseTo(0.01, 12);
    expect(gaps.deferred).toBe(0);
    expect(gaps.deferred457).toBe(blend);
    expect(gaps.hsa).toBe(blend);
    for (const p of [plan({ accounts: OWN }), plan({ accounts: [rate('taxable', 0.05)], historyMoved: true }), plan({ accounts: OWN, historyMoved: true, assets: 1_000_000 })]) {
      const { sim: s } = engineOf(figures(p));
      expect(Object.hasOwn(s, 'historyShift')).toBe(false);
      expect(Object.hasOwn(s.tax as SimTax, 'historyShift')).toBe(false);
    }
    // Off, the run plan is the one history as it ran has: every key the same.
    expect(engineOf(figures(plan({ accounts: OWN }))).sim).toEqual(asRan(sim));
  });

  test('on a steady market at the plan’s rate, a moved path ends where the steady years end, year by year', () => {
    const f = figures(plan({ accounts: OWN, historyMoved: true }));
    const d = detailOf(f);
    const want = [...d.start.years.map((y) => total(y.start)), total(d.start.years[d.start.years.length - 1].end)];
    const market = steady(engineOf(f).sim.years, 0.05, 0.05, 0.03);
    const moved = onePath(engineOf(f).sim, market);
    expect(moved.failedYear).toBe(-1);
    const off = (path: number[]) => Math.max(...want.map((w, i) => Math.abs(path[i] - w)));
    expect(off(moved.balances)).toBeLessThan(0.01);
    // History as it ran grows every bucket at the market's 5%, so it parts from them.
    expect(off(onePath(asRan(engineOf(f).sim), market).balances)).toBeGreaterThan(10_000);
  });

  test('moved by a gap, a path runs as a market each year that much higher would, for any rule and mix', () => {
    // Every account at 7% against the plan's 5%: every bucket 2 points higher.
    const all = [rate('taxable', 0.07), rate('tax-deferred', 0.07), rate('roth', 0.07)];
    for (const over of [{}, { rule: 'guardrails' as const }, { rebalance: 'none' as const, stocksPct: 60, bondsPct: 30 }]) {
      const { sim } = engineOf(figures(plan({ accounts: all, historyMoved: true, ...over })));
      expect(sim.tax?.historyShift).toEqual({ taxable: 0.07 - 0.05, deferred: 0.07 - 0.05, deferred457: 0.07 - 0.05, roth: 0.07 - 0.05, hsa: 0.07 - 0.05 });
      const gap = sim.historyShift as number;
      const moved = onePath(sim, steady(sim.years, 0.06, 0.01, 0.03));
      const higher = onePath({ ...asRan(sim), cashRealReturn: sim.cashRealReturn + gap }, steady(sim.years, 1.06 + gap - 1, 1.01 + gap - 1, 0.03));
      expect(moved.failedYear).toBe(higher.failedYear);
      for (let i = 0; i < higher.balances.length; i++) expect(Math.abs(moved.balances[i] - higher.balances[i])).toBeLessThan(0.01);
      for (let i = 0; i < higher.spending.length; i++) expect(Math.abs(moved.spending[i] - higher.spending[i])).toBeLessThan(0.01);
    }
  });

  test('with tax worked out, the guardrails skip a raise after a year the gap takes below nothing', () => {
    // Every account at -1% against the plan's 5%: 6 points lower, so 2% and 3%
    // inflation, about 5% a year as history ran, is about -1% moved.
    const all = [rate('taxable', -0.01), rate('tax-deferred', -0.01), rate('roth', -0.01)];
    const { sim } = engineOf(figures(plan({ accounts: all, historyMoved: true, rule: 'guardrails' })));
    const market = steady(sim.years, 0.02, 0.02, 0.03);
    const moved = onePath(sim, market).spending;
    const ran = onePath(asRan(sim), market).spending;
    expect(ran[1]).toBeCloseTo(ran[0], 4);
    expect(moved[1]).toBeCloseTo(moved[0] / 1.03, 4);
  });

  test('with tax worked out, a bucket never loses more than all of it, a taxable one paying dividends too', () => {
    const { sim } = engineOf(figures(plan({ accounts: OWN, historyMoved: true })));
    const gaps = { taxable: -1.5, deferred: -1.5, deferred457: -1.5, roth: -1.5, hsa: -1.5 };
    for (const taxableYield of [0, 0.02]) {
      const tax = { ...(sim.tax as SimTax), taxableYield };
      const { historyShift: _gaps, ...together } = tax;
      for (const t of [{ ...tax, historyShift: gaps }, together]) {
        const r = onePath({ ...sim, historyShift: -1.5, tax: t }, steady(sim.years, 0.05));
        expect(r.failedYear).toBeGreaterThanOrEqual(0);
        expect(Math.min(...r.balances)).toBe(0);
      }
    }
  });

  test('with a mix left to drift, a bucket’s gap holds each asset at nothing or more, as the blend’s does', () => {
    // Stocks lose 60% a year and history moves 50 points lower: stocks hold at
    // nothing while bonds keep 52%, every bucket alike, so saying each bucket's
    // gap runs as the blend's alone does.
    const { sim } = engineOf(figures(plan({ accounts: OWN, historyMoved: true, rebalance: 'none', stocksPct: 60, bondsPct: 30 })));
    const tax = sim.tax as SimTax;
    const { historyShift: _gaps, ...together } = tax;
    const gaps = { taxable: -0.5, deferred: -0.5, deferred457: -0.5, roth: -0.5, hsa: -0.5 };
    const market = steady(sim.years, -0.6, 0.02);
    const apart = onePath({ ...sim, historyShift: -0.5, tax: { ...tax, historyShift: gaps } }, market);
    const alike = onePath({ ...sim, historyShift: -0.5, tax: together }, market);
    expect(alike.balances[1]).toBeGreaterThan(0);
    for (let i = 0; i < alike.balances.length; i++) expect(apart.balances[i]).toBeCloseTo(alike.balances[i], 6);
  });
});
