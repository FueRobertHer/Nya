// The stress test's bridge (lib/fire/bridge.ts): the flat engine at the drawdown's
// tax share and health cost ends where the drawdown ends on a steady market, with
// income of every kind, one-offs and years with money to spare.

import { describe, expect, test } from 'bun:test';
import { bridgedEngine } from '@/lib/fire/bridge';
import type { BucketsToday } from '@/lib/fire/buckets-today';
import type { PlanItem } from '@/lib/fire/items';
import { makeMarket, type Market } from '@/lib/fire/market';
import { steadyRun } from '@/lib/fire/path';
import { DEFAULT_PLAN, type EnginePlan, type Measured } from '@/lib/fire/plan';
import { detailWork, type DetailedInput, type PlanDetail } from '@/lib/fire/plan-detail';
import { planFigures, type PlanFigures } from '@/lib/fire/plan-figures';
import { planOf, type FirePlanV2 } from '@/lib/fire/plan-v2';
import { historicalCycles, MAX_YEARS, type SimPlan } from '@/lib/fire/simulate';
import { lawFor } from '@/lib/fire/tax/law';
import { ON } from './plan-gen';

const account = (bucket: string, value: number, basis: number | null = null) => ({ owner: 'you', value, basis, account_id: bucket, bucket });
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
  law: lawFor(2026).law,
  lawYear: { year: 2026, behind: false },
};

const plan = (over: Partial<FirePlanV2> = {}): FirePlanV2 => ({ ...planOf({ ...DEFAULT_PLAN, age: 45, targetAge: 50, spending: 70_000, savings: 40_000, assets: 1_300_000, realReturn: 0.05, withdrawalRate: 0.04 }), start: 'at-stop', ...over });
const M: Measured = { spending: null, savings: null, assets: null };
const when = (age: number) => ({ anchor: { at: 'age' as const, age }, offset: 0 });
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
const endOf = (d: PlanDetail) => total(d.start.years[d.start.years.length - 1].end);

/** A market where nothing moves, `years` long. */
const still = (years: number): Market => {
  const n = years * 12;
  return makeMarket('2000-01', new Array(n).fill(0), new Array(n).fill(0), new Array(n).fill(0));
};

describe('on a steady market it ends where the drawdown ends', () => {
  const cases: [string, PlanItem[]][] = [
    ['nothing but spending and health', []],
    ['income given before tax', [item({ kind: 'social-security', from: when(67), yearly: 30_000, beforeTax: true }), item({ id: 'p', kind: 'pension', from: when(60), yearly: 15_000, beforeTax: true })]],
    ['income given after tax', [item({ kind: 'other-income', from: when(55), yearly: 20_000, beforeTax: false })]],
    ['income that doesn’t keep up with prices', [item({ kind: 'pension', from: when(60), yearly: 24_000, beforeTax: true, inflationAdjusted: false })]],
    ['a one-off', [item({ kind: 'one-off', from: when(58), once: 120_000 })]],
    ['a windfall', [item({ kind: 'windfall', from: when(60), once: 200_000 })]],
    ['a windfall far over the year’s need', [item({ kind: 'windfall', from: when(55), once: 900_000 })]],
    ['income over the year’s need, for years', [item({ kind: 'other-income', from: when(52), until: when(58), yearly: 180_000, beforeTax: false })]],
    ['a lower cost', [item({ kind: 'loan-end', from: when(60), yearly: 12_000 })]],
    ['part-time work', [item({ kind: 'part-time', from: when(50), until: when(55), yearly: 30_000, beforeTax: true })]],
    ['all of them', [item({ id: 'a', kind: 'social-security', from: when(67), yearly: 30_000, beforeTax: true }), item({ id: 'b', kind: 'other-income', from: when(55), until: when(60), yearly: 20_000 }), item({ id: 'c', kind: 'one-off', from: when(58), once: 120_000 }), item({ id: 'd', kind: 'windfall', from: when(70), once: 200_000 }), item({ id: 'e', kind: 'loan-end', from: when(62), yearly: 12_000 })]],
  ];
  for (const [what, items] of cases) {
    test(what, () => {
      const f = figures(plan({ items }));
      const d = detailOf(f);
      expect(d.start.runsOutAt).toBeNull();
      const run = steadyRun(engineOf(f).sim, 0.05);
      expect(run.failedYear).toBeNull();
      expect(Math.abs(run.balances[run.balances.length - 1] - endOf(d))).toBeLessThan(1);
      // And the tax share and health cost say so.
      expect(d.start.t).toBeGreaterThan(0);
      expect(engineOf(f).sim.taxRate).toBe(d.start.t);
      expect(engineOf(f).sim.bridged).toBe(true);
    });
  }
});

describe('the engine it hands over', () => {
  test('the rule covers spending and health at `t`', () => {
    const f = figures(plan());
    const d = detailOf(f);
    const e = engineOf(f);
    const expected = (70_000 + d.start.h) / (1 - d.start.t) / e.sim.startBalance;
    expect(e.rate).toBeCloseTo(expected, 12);
    expect(e.rateFrom).toBe('spending');
    expect(e.sim.rule).toEqual({ kind: 'constant', rate: e.rate });
    // Its first year spends spending and the average health cost, by construction.
    expect(e.rate * e.sim.startBalance * (1 - e.sim.taxRate)).toBeCloseTo(70_000 + d.start.h, 6);
  });

  test('a FI-number start runs at its flat FI number, with the rate it needs', () => {
    const f = figures(plan({ start: 'fi-number' }));
    const e = engineOf(f);
    expect(e.sim.startBalance).toBe(f.view.fiNumber as number);
    expect(e.rate).not.toBe(0.04);
    expect(e.rate).toBeCloseTo(detailOf(f).start.rate, 12);
  });

  test('each year’s health differs from `h` by a one-off or a lower cost, through the longest plan', () => {
    const f = figures(plan());
    const d = detailOf(f);
    const { oneOffs, lowerSpending } = engineOf(f).sim;
    const flowAt = (y: number) => oneOffs.filter((o) => o.year === y).reduce((s, o) => s + o.amount, 0) - (lowerSpending ?? []).filter((l) => l.fromYear <= y && (l.toYear ?? Infinity) > y).reduce((s, l) => s + l.amount, 0);
    d.start.years.forEach((row, y) => expect(flowAt(y)).toBeCloseTo(row.health - d.start.h, 2));
    // Past the table, the last year's difference holds.
    const last = d.start.years[d.start.years.length - 1].health - d.start.h;
    expect(d.start.years.length).toBeLessThan(MAX_YEARS);
    for (let y = d.start.years.length; y < MAX_YEARS; y++) expect(flowAt(y)).toBeCloseTo(last, 2);
  });

  test('a health cost that never changes gives no flow over a cent', () => {
    const f = figures(plan({ horizon: 10 }), { health: { ...input.health, growth: 0 } });
    const { oneOffs, lowerSpending } = engineOf(f).sim;
    expect(oneOffs).toEqual([]);
    expect(lowerSpending).toEqual([]);
    expect(detailOf(f).start.h).toBeCloseTo(9_000, 6);
  });

  test('income goes in at its gross times `1 - t`, row for row', () => {
    const f = figures(plan({ items: [item({ kind: 'pension', from: when(60), yearly: 15_000, beforeTax: true, inflationAdjusted: false }), item({ id: 'y', kind: 'other-income', from: when(55), until: when(60), yearly: 20_000 })] }));
    const t = detailOf(f).start.t;
    const income = [...engineOf(f).sim.income].sort((a, b) => a.fromYear - b.fromYear);
    expect(income[0]).toEqual({ amount: 20_000 * (1 - t), fromYear: 5, toYear: 10, inflationAdjusted: true });
    expect(income[1]).toEqual({ amount: 15_000 * (1 - t), fromYear: 10, inflationAdjusted: false });
  });

  test('a start of nothing runs the flat plan', () => {
    const f = figures(plan());
    const e = engineOf(f);
    const none: EnginePlan = { ...e, sim: { ...e.sim, startBalance: 0 } };
    expect(bridgedEngine(plan(), none, detailOf(f).start, { incomeBy: [] }, undefined)).toBe(none);
  });

  test('a run that starts before today has no health flows for those years', () => {
    const f = figures(plan({ age: 55, targetAge: 50, start: 'custom', startBalance: 1_500_000, horizon: 30 }));
    const d = detailOf(f);
    expect(d.startAge).toBe(55);
    const { oneOffs, lowerSpending } = engineOf(f).sim;
    for (const y of [0, 1, 2, 3, 4]) {
      expect(oneOffs.some((o) => o.year === y)).toBe(false);
      expect((lowerSpending ?? []).some((l) => l.fromYear === y)).toBe(false);
    }
    expect(oneOffs.some((o) => o.year === 5) || (lowerSpending ?? []).some((l) => l.fromYear === 5)).toBe(true);
  });

  test('what waits on a run’s own balance compiles at `t`, money in included', () => {
    const waits = item({ kind: 'windfall', from: { anchor: { at: 'balance', amount: 50_000_000 }, offset: 0 }, once: 100_000 });
    const earns = item({ id: 'y', kind: 'other-income', from: { anchor: { at: 'balance', amount: 50_000_000 }, offset: 0 }, yearly: 20_000 });
    const f = figures(plan({ items: [waits, earns] }));
    const keep = 1 - detailOf(f).start.t;
    const c = engineOf(f).sim.conditional!;
    expect(c.items.map((x) => x.moneyIn)).toEqual([100_000 * keep, 0]);
    expect(c.items[1].income).toEqual({ amount: 20_000 * keep, inflationAdjusted: true });
  });

  test('without the bridge a conditional flow keeps what it had', () => {
    const waits = item({ kind: 'windfall', from: { anchor: { at: 'balance', amount: 50_000_000 }, offset: 0 }, once: 100_000 });
    const f = planFigures(plan({ items: [waits], taxRate: 0.1 }), M, { count: ON });
    if ('refused' in f || !('sim' in f.engine)) throw new Error('no engine');
    expect(f.engine.sim.conditional!.items[0].moneyIn).toBe(100_000);
    expect(f.engine.sim.bridged).toBeUndefined();
  });
});

describe('a year with money to spare', () => {
  const sim = (over: Partial<SimPlan> = {}): SimPlan => ({ startBalance: 1_000_000, years: 1, allocation: { stocks: 1, bonds: 0, cash: 0 }, rebalance: 'annual', fee: 0, taxRate: 0.1, rule: { kind: 'constant', rate: 0.06 }, income: [{ amount: 180_000, fromYear: 0, inflationAdjusted: true }], oneOffs: [], cashRealReturn: 0, ...over });

  test('at 10%, $200,000 of money in against $54,000 of spending invests $140,000, in a steady run', () => {
    expect(steadyRun(sim({ bridged: true }), 0).balances[1]).toBeCloseTo(1_140_000, 6);
    expect(steadyRun(sim(), 0).balances[1]).toBeCloseTo(1_126_000, 6);
  });

  for (const rebalance of ['annual', 'none'] as const) {
    test(`and in the engine, rebalanced ${rebalance}`, () => {
      const on = historicalCycles(sim({ bridged: true, rebalance }), still(2));
      const off = historicalCycles(sim({ rebalance }), still(2));
      expect(on.balance.p50[1]).toBeCloseTo(1_140_000, 6);
      expect(off.balance.p50[1]).toBeCloseTo(1_126_000, 6);
    });
  }

  test('with `t` at zero the switch changes nothing, in the engine and in a steady run', () => {
    expect(steadyRun(sim({ bridged: true, taxRate: 0 }), 0)).toEqual(steadyRun(sim({ taxRate: 0 }), 0));
    expect(historicalCycles(sim({ bridged: true, taxRate: 0 }), still(2)).balance.p50).toEqual(historicalCycles(sim({ taxRate: 0 }), still(2)).balance.p50);
  });
});

describe('with no tax and no health, the flat simulation', () => {
  // All Roth money, all of it reachable, no coverage, and the years end before 65.
  const none: Partial<DetailedInput> = { buckets: buckets(0, 0, 1_300_000, 1_300_000), health: { ...input.health, coverage: null } };
  const p = plan({ targetAge: 50, horizon: 10, savings: 0, start: 'custom', startBalance: 1_300_000 });

  test('`t` and `h` are zero', () => {
    const d = detailOf(figures(p, none));
    expect(d.start.t).toBe(0);
    expect(d.start.h).toBe(0);
  });

  test('its balances are the flat engine’s, within a cent, in every cycle', () => {
    const flat = planFigures(p, M, { count: ON });
    if ('refused' in flat || !('sim' in flat.engine)) throw new Error('no engine');
    const market = still(12);
    const a = historicalCycles(engineOf(figures(p, none)).sim, market);
    const b = historicalCycles(flat.engine.sim, market);
    expect(a.successRate).toBe(b.successRate);
    a.balance.p50.forEach((v, i) => expect(Math.abs(v - b.balance.p50[i])).toBeLessThan(0.01));
  });
});
