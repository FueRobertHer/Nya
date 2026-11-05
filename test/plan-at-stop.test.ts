import { describe, expect, test } from 'bun:test';
import { conditionalFlows } from '@/lib/fire/compile';
import { ITEM_LIMITS, type PlanItem } from '@/lib/fire/items';
import { steadyRun } from '@/lib/fire/path';
import { enginePlan, fiView, parsePlan, type EnginePlan, type Measured } from '@/lib/fire/plan';
import { planFigures, type PlanFigures } from '@/lib/fire/plan-figures';
import { unmeasuredNeed } from '@/lib/fire/progress';
import { DEFAULT_PLAN_V2, parsePlanV2, type FirePlanV2 } from '@/lib/fire/plan-v2';
import { makeMarket, type Market } from '@/lib/fire/market';
import { checkPlan, historicalCycles, MAX_CONDITIONAL, type SimPlan } from '@/lib/fire/simulate';
import { startsWithText } from '@/components/plan-scenario-text';
import { everyRunText } from '@/components/plan-items';

// D11's start, as its reader runs it (the tax plan's timeline, "With D11's
// start"): Will it last? from what your own steady path has at the stop, a balance
// milestone not fired by then checked per run on that run's balance. The oracle is
// the steady path: on a market that never changes, every run is the steady one, so
// each must fire where the steady path placed it, as steadyRun is held to
// historicalCycles. Nothing else moves for the other starts.

const FLAT = { planInWalk: false };
const M: Measured = { spending: 40_000, savings: 30_000, assets: 500_000 };

const plan = (over: Partial<FirePlanV2> = {}): FirePlanV2 => ({ ...DEFAULT_PLAN_V2, age: 40, targetAge: 50, realReturn: 0.05, withdrawalRate: 0.04, taxRate: 0.1, fee: 0, stocksPct: 100, bondsPct: 0, horizon: 30, start: 'at-stop', rule: 'constant', ...over });
const figures = (p: FirePlanV2, m: Measured = M) => {
  const f = planFigures(p, m, { count: FLAT });
  if ('refused' in f) throw new Error('refused');
  return f as PlanFigures;
};
const sim = (f: PlanFigures): SimPlan => (f.engine as EnginePlan).sim;

/** An item that starts when the balance reaches `amount`. */
const onBalance = (id: string, over: Partial<PlanItem>, amount: number, offset = 0): PlanItem => ({
  id,
  label: id,
  kind: 'spending',
  from: { anchor: { at: 'balance', amount }, offset },
  until: null,
  once: null,
  yearly: null,
  every: null,
  times: null,
  owner: 'you',
  inflationAdjusted: true,
  beforeTax: false,
  replaces: null,
  ...over,
});
const atAge = (x: PlanItem, age: number): PlanItem => ({ ...x, from: { anchor: { at: 'age', age }, offset: 0 } });

/** A market of a year's real return per year, for exactly its own years: one
 *  start, so every percentile is that run. */
function yearly(rates: readonly number[], inflation = 0.03): Market {
  const months = rates.flatMap((r) => new Array<number>(12).fill((1 + r) ** (1 / 12) - 1));
  return makeMarket('1900-01', months, months, new Array(months.length).fill((1 + inflation) ** (1 / 12) - 1));
}

/** The one run's balances on a steady market, to set against the steady path. */
const balancesOf = (s: SimPlan, real: number) => historicalCycles(s, yearly(new Array(s.years).fill(real))).balance.p50;

describe('where it starts', () => {
  test('what the walk has at the stop, your spending the first year, and no line against itself', () => {
    const f = figures(plan());
    const e = f.engine as EnginePlan;
    expect(e.sim.startBalance).toBe(f.view.atTargetAge as number);
    expect(e.startAge).toBe(50);
    expect(e.rateFrom).toBe('spending');
    expect(e.rate).toBeCloseTo(40_000 / 0.9 / e.sim.startBalance, 10);
    expect(f.startsWith).toEqual({ balance: e.sim.startBalance, from: 'at-stop', atAge: 50, projected: null, short: null, more: false });
    expect(startsWithText(f.startsWith!, (n) => `$${Math.round(n)}`)).toBe(`$${Math.round(e.sim.startBalance)}, what you’d have at 50.`);
  });

  test('with items changing the walk, the walk’s balance, the same one the path draws from', () => {
    const f = figures(plan({ items: [atAge(onBalance('car', { kind: 'car', once: 40_000 }, 0), 45)] }));
    const plain = figures(plan());
    expect(f.view.atTargetAge).toBeLessThan(plain.view.atTargetAge as number);
    expect(sim(f).startBalance).toBe(f.view.atTargetAge as number);
  });

  test('what it needs, said apart from the other starts', () => {
    for (const over of [{ age: null }, { targetAge: null }] as Partial<FirePlanV2>[]) {
      expect(figures(plan(over)).engine).toEqual({ missing: 'stop-balance' });
    }
    expect(figures(plan(), { spending: 40_000, savings: null, assets: null }).engine).toEqual({ missing: 'stop-balance' });
    // A walk that can't pay what it meets never gets to the stop.
    const broke = figures(plan({ items: [atAge(onBalance('big', { kind: 'car', once: 9_000_000 }, 0), 45)] }));
    expect(broke.engine).toEqual({ missing: 'stop-balance' });
    const noSpending = figures(plan(), { spending: null, savings: 30_000, assets: 500_000 });
    expect(noSpending.engine).toEqual({ missing: 'spending' });
    const view = fiView({ ...plan(), start: 'at-stop' }, M);
    expect(enginePlan(plan(), { ...view, atTargetAge: 0 })).toEqual({ missing: 'stop-balance' });
    // And the other starts' words stay theirs: your own FI number of nothing has
    // always asked for a balance.
    expect(enginePlan({ ...plan(), start: 'fi-number', fiNumber: 0 }, { ...view, fiNumber: 0 })).toEqual({ missing: 'balance' });
    expect(enginePlan({ ...plan(), start: 'assets' }, { ...view, assets: { ...view.assets, value: 0 } })).toEqual({ missing: 'assets' });
    // Unmeasured assets are why, and it says so.
    expect(unmeasuredNeed('stop-balance', { ...view, assets: { ...view.assets, source: 'unmeasured' } })).toBe('your invested assets, which aren’t measured');
    expect(unmeasuredNeed('stop-balance', view)).toBeNull();
  });

  test('readers keep it, and the flat ones refuse nothing about it', () => {
    const stored = plan();
    const read = parsePlanV2(stored);
    expect('plan' in read && read.plan.start).toBe('at-stop');
    const { version: _v, items: _i, partnerAge: _p, stopAtFi: _s, fiNumber: _f, ...rest } = stored;
    const v1 = parsePlan({ ...rest, version: 1, income: [], expenses: [] });
    expect('plan' in v1 && v1.plan.start).toBe('at-stop');
    expect(DEFAULT_PLAN_V2.start).toBe('fi-number');
  });
});

describe('the oracle: on a market that never changes, each run is the steady path', () => {
  const REAL = 0.05;
  /** The plan with its milestone item placed at the age the steady path fired it. */
  const asFixed = (p: FirePlanV2, f: PlanFigures): FirePlanV2 => ({ ...p, start: 'custom', startBalance: sim(f).startBalance, items: p.items.map((x, i) => {
    const a = f.resolution.ages[i];
    if (!a) throw new Error('never placed');
    return { ...x, from: { anchor: { at: 'age', age: a.start }, offset: 0 }, until: a.end === null ? null : { anchor: { at: 'age', age: a.end }, offset: 0 } };
  }) });

  const cases: [string, Partial<PlanItem>, number, number][] = [
    ['a cost for good', { kind: 'spending', yearly: 12_000 }, 1_250_000, 0],
    ['a lower cost', { kind: 'spending', yearly: -8_000 }, 1_250_000, 0],
    ['a one-off, three years on', { kind: 'one-off', once: 60_000 }, 1_250_000, 3],
    ['a repeating car', { kind: 'car', once: 25_000, every: 5, times: 3 }, 1_250_000, 0],
    ['money in', { kind: 'windfall', once: 90_000 }, 1_250_000, 0],
    ['a home', { kind: 'home', once: 80_000, yearly: 9_000 }, 1_250_000, 0],
    ['income that keeps up', { kind: 'pension', yearly: 15_000, inflationAdjusted: true }, 1_250_000, 0],
    ['income that doesn’t', { kind: 'pension', yearly: 15_000, inflationAdjusted: false }, 1_250_000, 2],
    ['income before tax', { kind: 'pension', yearly: 15_000, beforeTax: true }, 1_250_000, 0],
    ['a loan paid off', { kind: 'loan-end', yearly: 6_000 }, 1_250_000, 0],
    ['for some years', { kind: 'spending', yearly: 10_000, until: { years: 4 } }, 1_250_000, 0],
    ['part-time work', { kind: 'part-time', yearly: 20_000, until: { years: 6 }, inflationAdjusted: false }, 1_250_000, 0],
  ];
  for (const [name, over, amount, offset] of cases) {
    test(name, () => {
      const p = plan({ items: [onBalance('m', over, amount, offset)] });
      const f = figures(p);
      // The milestone comes after the stop on the steady path, so it goes per run.
      expect(f.resolution.perRun?.edges[0]).toBeTruthy();
      const start = f.resolution.ages[0]?.start as number;
      expect(start).toBeGreaterThan(50);
      const s = sim(f);
      expect(s.conditional?.items.length).toBe(1);
      expect(s.oneOffs.length + s.income.length).toBe(0);
      const fixed = sim(figures(asFixed(p, f)));
      const steady = steadyRun(fixed, REAL);
      const run = balancesOf(s, REAL);
      for (let y = 0; y < steady.balances.length; y++) expect(run[y]).toBeCloseTo(steady.balances[y], 5);
    });
  }

  test('an item that follows a milestone, by years, and two on one amount', () => {
    const a = onBalance('a', { kind: 'spending', yearly: 5_000, until: { years: 3 } }, 1_250_000);
    const b: PlanItem = { ...onBalance('b', { kind: 'one-off', once: 30_000 }, 0), from: { anchor: { at: 'item', id: 'a', edge: 'end' }, offset: 2 } };
    const c = onBalance('c', { kind: 'spending', yearly: 2_000 }, 1_250_000);
    const p = plan({ items: [a, b, c] });
    const f = figures(p);
    expect(f.resolution.perRun?.triggers).toEqual([1_250_000, 1_250_000]);
    expect(f.resolution.perRun?.edges[1]?.start).toEqual({ trigger: 0, offset: 5 });
    const steady = steadyRun(sim(figures(asFixed(p, f))), REAL);
    const run = balancesOf(sim(f), REAL);
    for (let y = 0; y < steady.balances.length; y++) expect(run[y]).toBeCloseTo(steady.balances[y], 5);
  });

  test('never reached on the steady path, it still waits in each run, and costs nothing there', () => {
    const p = plan({ items: [onBalance('m', { kind: 'spending', yearly: 12_000 }, 99_000_000)] });
    const f = figures(p);
    expect(f.resolution.ages).toEqual([null]);
    expect(f.resolution.perRun?.triggers).toEqual([99_000_000]);
    const without = sim(figures(plan()));
    const steady = steadyRun(without, REAL);
    const run = balancesOf(sim(f), REAL);
    for (let y = 0; y < steady.balances.length; y++) expect(run[y]).toBeCloseTo(steady.balances[y], 5);
  });
});

describe('what stays as the steady path has it', () => {
  test('fired by the stop: its year in every run, fixed, on the walk', () => {
    const f = figures(plan({ items: [onBalance('m', { kind: 'spending', yearly: 1_000 }, 600_000)] }));
    expect(f.resolution.ages[0]?.start).toBeLessThanOrEqual(50);
    expect(f.resolution.perRun).toBeUndefined();
    expect(sim(f).conditional).toBeUndefined();
  });

  test('on FI: the steady year, in the fixed flows', () => {
    const p = plan({ targetAge: 70, items: [{ ...onBalance('m', { kind: 'one-off', once: 1_000 }, 0), from: { anchor: { at: 'fi' }, offset: 25 } }] });
    const f = figures(p);
    expect(f.resolution.perRun).toBeUndefined();
    expect(sim(f).conditional).toBeUndefined();
    expect(everyRunText(f.resolution.ages[0]?.start ?? null, p)).toContain('in every run');
  });

  test('every other start: a milestone is the steady year, and the plan is what it was', () => {
    for (const start of ['fi-number', 'assets', 'custom'] as const) {
      const f = figures(plan({ start, startBalance: 1_000_000, items: [onBalance('m', { kind: 'spending', yearly: 12_000 }, 1_250_000)] }));
      expect(f.resolution.perRun).toBeUndefined();
      expect('conditional' in sim(f)).toBe(false);
    }
  });

  test('the words: a row waiting per run says so, one fixed keeps its reason', () => {
    expect(everyRunText(null, plan(), true)).toBe('Will it last? goes by each run’s own balance for this.');
    expect(everyRunText(58, plan())).toBe('Starts at 58 in every run, as on your steady path: your FI date and what comes before your stop are the steady path’s, not each run’s.');
  });
});

describe('in a run', () => {
  const BASE: SimPlan = { startBalance: 1_000_000, years: 10, allocation: { stocks: 1, bonds: 0, cash: 0 }, rebalance: 'annual', fee: 0, taxRate: 0, rule: { kind: 'constant', rate: 0 }, income: [], oneOffs: [], cashRealReturn: 0 };
  const steady = (rate: number) => yearly(new Array(10).fill(rate));
  const cost = (amount: number, trigger: number): SimPlan['conditional'] => ({ triggers: [trigger], items: [{ start: { trigger: 0, offset: 0 }, end: null, once: [{ amount, after: 0 }], moneyIn: 0, income: null, yearly: 0 }] });

  test('a rising run and a falling one fire in different years, or not at all', () => {
    const s: SimPlan = { ...BASE, conditional: cost(100_000, 1_300_000) };
    // 10% a year reaches it at the start of year 3, 20% a year of year 2.
    const up = historicalCycles(s, steady(0.1)).balance.p50;
    expect(up[3]).toBeCloseTo(1_331_000, 3);
    expect(up[4]).toBeCloseTo((1_331_000 - 100_000) * 1.1, 3);
    const fast = historicalCycles(s, steady(0.2)).balance.p50;
    expect(fast[2]).toBeCloseTo(1_440_000, 3);
    expect(fast[3]).toBeCloseTo((1_440_000 - 100_000) * 1.2, 3);
    const down = historicalCycles(s, steady(-0.05)).balance.p50;
    expect(down[10]).toBeCloseTo(1_000_000 * 0.95 ** 10, 3);
  });

  test('it fires once: what it starts can’t switch it off by lowering the balance', () => {
    const s: SimPlan = { ...BASE, conditional: { triggers: [1_100_000], items: [{ start: { trigger: 0, offset: 0 }, end: null, once: [], moneyIn: 0, income: null, yearly: 150_000 }] } };
    const r = historicalCycles(s, steady(0.1)).balance.p50;
    expect(r[1]).toBeCloseTo(1_100_000, 3);
    expect(r[2]).toBeCloseTo((1_100_000 - 150_000) * 1.1, 3);
    expect(r[3]).toBeCloseTo(((1_100_000 - 150_000) * 1.1 - 150_000) * 1.1, 3);
  });

  test('each run starts unfired: a fire in one isn’t carried into the next', () => {
    // Two starts. A jump in month 0 reaches the first's trigger at year 1, and one
    // in month 13 the second's at year 2, so a year carried over would charge it a
    // year early and more would grow away.
    const months = new Array(37).fill(0);
    months[0] = 0.4;
    months[13] = 0.4;
    const r = historicalCycles({ ...BASE, years: 3, conditional: cost(1_000, 1_300_000) }, makeMarket('1900-01', months, months, new Array(37).fill(0)));
    expect(r.paths).toBe(2);
    expect(r.ending.p50).toBeCloseTo(((1_400_000 - 1_000) * 1.4 + (1_400_000 - 1_000)) / 2, 3);
  });

  test('a fixed-value income keeps its value until it fires in that run', () => {
    const s: SimPlan = { ...BASE, years: 5, conditional: { triggers: [1_200_000], items: [{ start: { trigger: 0, offset: 0 }, end: null, once: [], moneyIn: 0, income: { amount: 11_000, inflationAdjusted: false }, yearly: 0 }] } };
    // 10% a year after inflation of 10% a year: fires at year 2, 11,000 then, and
    // the next year 10,000 of that year's prices.
    const r = historicalCycles(s, yearly(new Array(5).fill(0.1), 0.1)).balance.p50;
    const reached = 1_000_000 * 1.21;
    expect(r[3]).toBeCloseTo((reached + 11_000) * 1.1, 3);
    expect(r[4]).toBeCloseTo(((reached + 11_000) * 1.1 + 10_000) * 1.1, 3);
  });

  test('an end that waits: a fixed start runs until that run’s balance gets there', () => {
    const s: SimPlan = { ...BASE, conditional: { triggers: [1_300_000], items: [{ start: { year: 0 }, end: { trigger: 0, offset: 1 }, once: [], moneyIn: 0, income: { amount: 10_000, inflationAdjusted: true }, yearly: 0 }] } };
    const r = historicalCycles(s, steady(0.1)).balance.p50;
    let bal = 1_000_000;
    const want = [bal];
    let fired = -1;
    for (let y = 0; y < 10; y++) {
      if (fired < 0 && bal >= 1_300_000) fired = y;
      if (fired < 0 || y < fired + 1) bal += 10_000;
      bal *= 1.1;
      want.push(bal);
    }
    expect(fired).toBeGreaterThan(0);
    for (let y = 0; y <= 10; y++) expect(r[y]).toBeCloseTo(want[y], 3);
  });

  test('with nothing in it, not a byte moves', () => {
    const m = yearly(Array.from({ length: 10 }, (_, i) => (i % 2 ? 0.2 : -0.1)));
    const a = historicalCycles({ ...BASE, oneOffs: [{ amount: 10_000, year: 2 }], lowerSpending: [{ amount: 500, fromYear: 1 }] }, m);
    const b = historicalCycles({ ...BASE, oneOffs: [{ amount: 10_000, year: 2 }], lowerSpending: [{ amount: 500, fromYear: 1 }], conditional: { triggers: [], items: [] } }, m);
    expect(b.balance).toEqual(a.balance);
  });

  test('a plan full of homes with waiting ends runs', () => {
    // A home bought before the start, ending on a balance, compiles to two.
    const items: PlanItem[] = Array.from({ length: ITEM_LIMITS.items }, (_, i) => ({
      id: `h${i}`, label: `Home ${i}`, kind: 'home', from: { anchor: { at: 'age', age: 45 }, offset: 0 }, until: { anchor: { at: 'balance', amount: 5_000_000 }, offset: 0 },
      once: 1_000, yearly: 100, replaces: null, every: null, times: null, inflationAdjusted: true, owner: null, beforeTax: false,
    }));
    const flows = conditionalFlows(items, { triggers: [5_000_000], edges: items.map(() => ({ start: 45, end: { trigger: 0, offset: 0 } })) }, items.map(() => ({ start: 45, end: null })), { age: 40, startAge: 50, stop: 50, years: 45, taxRate: 0 });
    expect(flows.items.length).toBe(2 * ITEM_LIMITS.items);
    expect(() => checkPlan({ ...BASE, conditional: flows })).not.toThrow();
  });

  test('the engine checks what it is given, and the cap', () => {
    const item = { start: { trigger: 0, offset: 0 }, end: null, once: [], moneyIn: 0, income: null, yearly: 1 };
    const bad = (conditional: SimPlan['conditional']) => () => checkPlan({ ...BASE, conditional });
    expect(bad({ triggers: [1], items: [item] })).not.toThrow();
    expect(bad({ triggers: [1], items: Array.from({ length: MAX_CONDITIONAL }, () => item) })).not.toThrow();
    expect(bad({ triggers: [1], items: Array.from({ length: MAX_CONDITIONAL + 1 }, () => item) })).toThrow(RangeError);
    expect(bad({ triggers: [NaN], items: [item] })).toThrow(RangeError);
    expect(bad({ triggers: [-1], items: [item] })).toThrow(RangeError);
    expect(bad({ triggers: [1], items: [{ ...item, start: { trigger: 1, offset: 0 } }] })).toThrow(RangeError);
    expect(bad({ triggers: [1], items: [{ ...item, start: { trigger: 0, offset: -1 } }] })).toThrow(RangeError);
    expect(bad({ triggers: [1], items: [{ ...item, start: { year: 1.5 } }] })).toThrow(RangeError);
    expect(bad({ triggers: [1], items: [{ ...item, yearly: Infinity }] })).toThrow(RangeError);
    expect(bad({ triggers: [1], items: [{ ...item, moneyIn: -1 }] })).toThrow(RangeError);
    expect(bad({ triggers: [1], items: [{ ...item, income: { amount: -1, inflationAdjusted: true } }] })).toThrow(RangeError);
    expect(bad({ triggers: [1], items: [{ ...item, once: [{ amount: 1, after: -1 }] }] })).toThrow(RangeError);
  });
});

describe('the compile', () => {
  const AT = { age: 40, startAge: 50, stop: 50, years: 30, taxRate: 0.2 };
  const trigger = { trigger: 0, offset: 0 };

  test('a change begun by the start with an end that waits: lasting on the steady path, taken back where it comes', () => {
    const x = onBalance('home', { kind: 'home', once: 50_000, yearly: 7_000 }, 0);
    const held = { ...atAge(x, 50), until: { anchor: { at: 'balance' as const, amount: 2_000_000 }, offset: 0 } };
    const c = conditionalFlows([held], { triggers: [2_000_000], edges: [{ start: 50, end: trigger }] }, [{ start: 50, end: null }], AT);
    expect(c.items).toEqual([
      { start: { year: 0 }, end: null, once: [{ amount: 50_000, after: 0 }], moneyIn: 0, income: null, yearly: 0 },
      { start: trigger, end: null, once: [], moneyIn: 0, income: null, yearly: -7_000 },
    ]);
  });

  test('a change whose end the steady path reached: it runs from its start in each run, to that run’s end', () => {
    const held = { ...atAge(onBalance('s', { kind: 'spending', yearly: 7_000 }, 0), 45), until: { anchor: { at: 'balance' as const, amount: 2_000_000 }, offset: 0 } };
    const c = conditionalFlows([held], { triggers: [2_000_000], edges: [{ start: 45, end: trigger }] }, [{ start: 45, end: 60 }], AT);
    expect(c.items).toEqual([{ start: { year: -5 }, end: trigger, once: [], moneyIn: 0, income: null, yearly: 7_000 }]);
  });

  test('income given before tax, at the plan’s rate; pay never in the simulation', () => {
    const inc = onBalance('p', { kind: 'pension', yearly: 10_000, beforeTax: true, inflationAdjusted: false }, 2_000_000);
    const pay = onBalance('w', { kind: 'pay', yearly: 10_000 }, 2_000_000);
    const c = conditionalFlows([inc, pay], { triggers: [2_000_000], edges: [{ start: trigger, end: null }, { start: trigger, end: null }] }, [null, null], AT);
    expect(c.items).toEqual([{ start: trigger, end: null, once: [], moneyIn: 0, income: { amount: 8_000, inflationAdjusted: false }, yearly: 0 }]);
  });

  test('a repeat’s years, and a loan paid off that never comes back', () => {
    const car = onBalance('c', { kind: 'car', once: 20_000, every: 4, times: 3 }, 2_000_000);
    const loan = onBalance('l', { kind: 'loan-end', yearly: 6_000 }, 2_000_000);
    const c = conditionalFlows([car, loan], { triggers: [2_000_000], edges: [{ start: trigger, end: null }, { start: trigger, end: null }] }, [null, null], AT);
    expect(c.items[0].once).toEqual([
      { amount: 20_000, after: 0 },
      { amount: 20_000, after: 4 },
      { amount: 20_000, after: 8 },
    ]);
    expect(c.items[1]).toEqual({ start: trigger, end: null, once: [], moneyIn: 0, income: null, yearly: -6_000 });
  });
});
