// The stress test's bridge (lib/fire/bridge.ts): the flat engine at the drawdown's
// tax share and health cost ends where the drawdown ends on a steady market, with
// income of every kind, one-offs and years with money to spare.

import { describe, expect, test } from 'bun:test';
import { bridgedEngine } from '@/lib/fire/bridge';
import type { BucketsToday } from '@/lib/fire/buckets-today';
import { taxShares } from '@/lib/fire/drawdown';
import type { PlanItem } from '@/lib/fire/items';
import { makeMarket, type Market } from '@/lib/fire/market';
import { steadyRun } from '@/lib/fire/path';
import { DEFAULT_PLAN, type EnginePlan, type Measured } from '@/lib/fire/plan';
import { detailWork, type DetailedInput, type PlanDetail } from '@/lib/fire/plan-detail';
import { planFigures, type PlanFigures } from '@/lib/fire/plan-figures';
import { planOf, type FirePlanV2 } from '@/lib/fire/plan-v2';
import { checkPlan, historicalCycles, MAX_YEARS, type SimPlan } from '@/lib/fire/simulate';
import { lawFor } from '@/lib/fire/tax/law';
import { ON } from './plan-gen';
import { NO_STRATEGY } from '@/lib/fire/tax/rules';

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
  strategy: NO_STRATEGY,
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
    ['a lower cost over all of living spending', [item({ kind: 'loan-end', from: when(60), yearly: 90_000 })]],
    ['a lower cost over living spending and a one-off', [item({ kind: 'loan-end', from: when(60), yearly: 90_000 }), item({ id: 'o', kind: 'one-off', from: when(65), once: 5_000 })]],
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
      expect(engineOf(f).sim.bridged).toEqual({ h: detailOf(f).start.h });
    });
  }
});

describe('a rule that can’t run out', () => {
  const other = { health: { ...input.health, coverage: { kind: 'other' as const, yearly: 4_000 } } };

  test('VPW’s last year gives up living spending for health over `h`, and lasts, as the drawdown says', () => {
    const f = figures(plan({ rule: 'vpw' }), other);
    const d = detailOf(f).start;
    const last = d.years[d.years.length - 1];
    expect(last.health).toBeGreaterThan(d.h);
    expect(d.runsOutAt).toBeNull();
    const { sim } = engineOf(f);
    expect(steadyRun(sim, 0.05).failedYear).toBeNull();
    expect(historicalCycles(sim, still(sim.years + 2)).successRate).toBe(1);
  });

  test('percent of what is there does too', () => {
    const f = figures(plan({ rule: 'percent' }), other);
    expect(detailOf(f).start.runsOutAt).toBeNull();
    expect(steadyRun(engineOf(f).sim, 0.05).failedYear).toBeNull();
  });

  test('a cost living spending can’t cover still comes up short, in both', () => {
    const f = figures(plan({ rule: 'vpw', items: [item({ kind: 'one-off', from: when(80), once: 90_000_000 })] }), other);
    const d = detailOf(f).start;
    expect(d.runsOutAt).toBe(80);
    expect(steadyRun(engineOf(f).sim, 0.05).failedYear).toBe(30);
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
    ] as const)('%s from %d, $%d at %d: health runs it out later, in both', (rule, age, cost, at, out) => {
      const f = emptied(rule, age, cost, at);
      expect(detailOf(f).start.runsOutAt).toBe(out);
      expect(age + (steadyRun(engineOf(f).sim, 0.03).failedYear as number)).toBe(out);
    });
  });

  test('spending under health coverage holds at it, in both', () => {
    const f = figures(plan({ rule: 'percent', age: 50, targetAge: 50, spending: 20_000, savings: 0, assets: 500_000, realReturn: 0.03 }), {
      buckets: buckets(0, 0, 500_000, 500_000),
      savingsSplit: null,
      health: { ...input.health, coverage: { kind: 'other', yearly: 60_000 } },
    });
    const d = detailOf(f).start;
    expect(d.notes).toContain('held-at-zero');
    expect(d.runsOutAt).not.toBeNull();
    expect(50 + (steadyRun(engineOf(f).sim, 0.03).failedYear as number)).toBe(d.runsOutAt as number);
  });

  test('a rule that can run out isn’t let off', () => {
    const f = figures(plan({ spending: 200_000 }), other);
    expect(detailOf(f).start.runsOutAt).not.toBeNull();
    expect(steadyRun(engineOf(f).sim, 0.05).failedYear).not.toBeNull();
  });
});

describe('a plan that runs out', () => {
  const short = (spending: number, assets: number) => figures(plan({ age: 50, targetAge: 50, spending, savings: 0, assets }), { buckets: buckets(assets * 0.2, assets * 0.7, assets * 0.1, assets * 0.05), savingsSplit: null });

  test('its tax share is of what the years paid, so the bridge runs out when the drawdown does', () => {
    for (const [spending, assets, age] of [
      [120_000, 1_100_000, 57],
      [70_000, 1_100_000, 67],
    ]) {
      const f = short(spending, assets);
      const d = detailOf(f).start;
      expect(d.runsOutAt).toBe(age);
      expect(50 + (steadyRun(engineOf(f).sim, 0.05).failedYear as number)).toBe(age);
      // Not thinned by the years that couldn't pay.
      const paying = d.years.filter((y) => !y.short);
      const share = paying.reduce((s, y) => s + y.tax, 0) / paying.reduce((s, y) => s + y.tax + y.living + y.health + y.oneOffs, 0);
      expect(d.t).toBeGreaterThan(share * 0.9);
    }
  });

  test('what income pays once the money is gone doesn’t thin its tax share', () => {
    const ss = (yearly: number) => item({ kind: 'social-security', from: when(67), yearly, beforeTax: true });
    const f = figures(plan({ age: 55, targetAge: 55, spending: 80_000, savings: 0, assets: 1_000_000, realReturn: 0.04, items: [ss(36_000)] }), { buckets: buckets(200_000, 700_000, 100_000, 50_000), savingsSplit: null });
    const d = detailOf(f).start;
    expect(d.runsOutAt).toBe(67);
    expect(55 + (steadyRun(engineOf(f).sim, 0.04).failedYear as number)).toBe(67);
    expect(d.t).toBeCloseTo(taxShares(d.years.slice(0, 67 - 55 + 1), 0.04).t, 9);
    expect(d.t).toBeGreaterThan(taxShares(d.years, 0.04).t * 0.999);
    // And across plans: the constant rule runs out when the drawdown does.
    let out = 0;
    for (const age of [45, 50, 55])
      for (const assets of [800_000, 1_100_000, 1_500_000])
        for (const spending of [70_000, 85_000, 110_000])
          for (const yearly of [0, 30_000, 40_000])
            for (const realReturn of [0.03, 0.05]) {
              const g = figures(plan({ age, targetAge: age, spending, savings: 0, assets, realReturn, items: yearly ? [ss(yearly)] : [] }), { buckets: buckets(assets * 0.2, assets * 0.7, assets * 0.1, assets * 0.05), savingsSplit: null });
              const at = detailOf(g).start.runsOutAt;
              if (at === null) continue;
              out++;
              expect(age + (steadyRun(engineOf(g).sim, realReturn).failedYear as number)).toBe(at);
            }
    expect(out).toBeGreaterThan(40);
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

describe('what can’t be worked out', () => {
  const overdrawn = () => {
    const checking = { owner: 'you', value: -200, basis: -200, account_id: 'checking', bucket: 'taxable' };
    return { groups: [group('taxable', checking, account('taxable', 300_000)), group('tax-deferred', account('tax-deferred', 700_000))], roth: [], total: 999_800 } as unknown as Pick<BucketsToday, 'groups' | 'roth' | 'total'>;
  };

  test('an overdrawn account is no reason not to', () => {
    for (const p of [plan({ savings: -60_000, assets: 999_800 }), plan({ savings: 0, assets: 999_800, start: 'assets' })]) {
      const f = figures(p, { buckets: overdrawn(), savingsSplit: null });
      expect(detailOf(f).start.years.length).toBeGreaterThan(0);
    }
  });

  test('a mix that can’t be projected says so, rather than throwing on the page', () => {
    const f = figures(plan({ savings: -60_000 }), { stateRate: 1 });
    expect(f.detail).toMatchObject({ failed: expect.any(String) });
    // And the flat model carries the plan.
    expect(engineOf(f).sim.bridged).toBeUndefined();
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
    expect(steadyRun(sim({ bridged: { h: 0 } }), 0).balances[1]).toBeCloseTo(1_140_000, 6);
    expect(steadyRun(sim(), 0).balances[1]).toBeCloseTo(1_126_000, 6);
  });

  for (const rebalance of ['annual', 'none'] as const) {
    test(`and in the engine, rebalanced ${rebalance}`, () => {
      const on = historicalCycles(sim({ bridged: { h: 0 }, rebalance }), still(2));
      const off = historicalCycles(sim({ rebalance }), still(2));
      expect(on.balance.p50[1]).toBeCloseTo(1_140_000, 6);
      expect(off.balance.p50[1]).toBeCloseTo(1_126_000, 6);
    });
  }

  test('with `t` at zero the switch changes nothing, in the engine and in a steady run', () => {
    expect(steadyRun(sim({ bridged: { h: 0 }, taxRate: 0 }), 0)).toEqual(steadyRun(sim({ taxRate: 0 }), 0));
    expect(historicalCycles(sim({ bridged: { h: 0 }, taxRate: 0 }), still(2)).balance.p50).toEqual(historicalCycles(sim({ taxRate: 0 }), still(2)).balance.p50);
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
