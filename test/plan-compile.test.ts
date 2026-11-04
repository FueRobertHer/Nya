import { describe, expect, test } from 'bun:test';
import { compileItems, type CompileAt } from '@/lib/fire/compile';
import { savingsIn } from '@/lib/fire/events';
import { itemFromExpense, itemFromIncome, type PlanItem } from '@/lib/fire/items';
import * as oldEvents from './fixtures/before-d15/fire/events';
import * as oldPlan from './fixtures/before-d15/fire/plan';
import { compileEvents, fixedAges, genEvents, genMeasured, genPlan, itemFromEvent, rand } from './plan-gen';

// Where each item counts (lib/fire/compile.ts), held to the arithmetic from
// before D15 for what it had (test/fixtures/before-d15, the release before
// E1's own files), and what D15 adds behind its switch.

const off = { planInWalk: false };
const on = { planInWalk: true };

describe('the same arithmetic as the release before', () => {
  test('life events, as items, compile exactly as compileEvents did', () => {
    for (let seed = 1; seed <= 400; seed++) {
      const g = rand(seed);
      const events = genEvents(g);
      const at = { age: g.chance(0.9) ? g.int(25, 70) : null, startAge: g.chance(0.9) ? g.int(30, 75) : null, years: g.int(10, 60) };
      expect(compileEvents(events, at)).toEqual(oldEvents.compileEvents(events, at));
    }
  });

  test('a version 1 plan’s income and one-offs, with the switch off, are enginePlan’s parts, in its order', () => {
    for (let seed = 1; seed <= 300; seed++) {
      const g = rand(seed);
      const p = genPlan(g, true);
      const view = oldPlan.fiView(p, genMeasured(g));
      const engine = oldPlan.enginePlan(p, view);
      if (!('sim' in engine)) continue;
      const items = [...p.income.map(itemFromIncome), ...p.expenses.map(itemFromExpense)];
      const at: CompileAt = { age: p.age, startAge: engine.startAge, stop: p.targetAge, years: engine.sim.years, taxRate: p.taxRate };
      const c = compileItems(items, fixedAges(items), at, off);
      expect(c.sim.income).toEqual(engine.sim.income);
      expect(c.sim.oneOffs).toEqual(engine.sim.oneOffs);
      expect(c.walk).toEqual({ moneyIn: [], costs: [], spans: [] });
      const ids = (part: string) => c.notes.filter((n) => n.part === part).map((n) => n.id);
      expect([...ids('no-age'), ...ids('before-start')].sort()).toEqual([...engine.left.income, ...engine.left.expenses].map((x) => x.id).sort());
      expect(ids('after-end')).toEqual(engine.beyond.map((x) => x.id));
    }
  });

  test('life events still move the walk with the switch off', () => {
    const items = [itemFromEvent({ id: 'w', kind: 'windfall', label: 'Gift', atAge: 45, amount: 100_000 })];
    const c = compileItems(items, fixedAges(items), { age: 40, startAge: 55, stop: 55, years: 40, taxRate: 0 }, off);
    expect(c.walk.moneyIn).toEqual([{ year: 5, amount: 100_000 }]);
    expect(c.inWalk).toEqual([true]);
  });
});

describe('D15: the plan’s one-offs and income in the walk', () => {
  const at: CompileAt = { age: 40, startAge: 55, stop: 55, years: 40, taxRate: 0.2 };
  const roof = itemFromExpense({ id: 'roof', label: 'Roof', amount: 30_000, atAge: 45 });
  const rent = itemFromIncome({ id: 'rent', label: 'Rental income', amount: 12_000, fromAge: 48, inflationAdjusted: false });

  test('a one-off is a cost in its year, and income adds to saving every year from its age', () => {
    const c = compileItems([roof, rent], fixedAges([roof, rent]), at, on);
    expect(c.walk.costs).toEqual([{ year: 5, amount: 30_000 }]);
    expect(c.walk.spans).toEqual([{ from: 8, to: null, delta: 12_000 }]);
    expect(c.inWalk).toEqual([true, true]);
    // The simulation is as it was.
    const o = compileItems([roof, rent], fixedAges([roof, rent]), at, off);
    expect(c.sim).toEqual(o.sim);
    expect(c.notes).toEqual(o.notes);
  });

  test('one before today is in measured saving: left out, and taken out from its end', () => {
    const past = itemFromExpense({ id: 'x', label: 'Old', amount: 5_000, atAge: 35 });
    const pension: PlanItem = { ...rent, kind: 'pension', from: { anchor: { at: 'age', age: 30 }, offset: 0 }, until: { anchor: { at: 'age', age: 50 }, offset: 0 }, beforeTax: true };
    const c = compileItems([past, pension], fixedAges([past, pension]), at, on);
    expect(c.walk.costs).toEqual([]);
    // Before tax: 12,000 at 1 - 0.2.
    expect(c.walk.spans).toEqual([{ from: 10, to: null, delta: -9_600 }]);
    // It ends at 50, before the simulation starts at 55.
    expect(c.sim.income).toEqual([]);
    expect(compileItems([pension], fixedAges([pension]), { ...at, startAge: 45 }, on).sim.income).toEqual([{ amount: 9_600, fromYear: 0, toYear: 5, inflationAdjusted: false }]);
  });

  test('part-time work that says what it replaces counts in the walk before the stop', () => {
    const job: PlanItem = { ...rent, id: 'pt', kind: 'part-time', from: { anchor: { at: 'age', age: 50 }, offset: 0 }, until: { anchor: { at: 'age', age: 60 }, offset: 0 }, yearly: 30_000, replaces: 70_000, inflationAdjusted: true };
    const c = compileItems([job], fixedAges([job]), at, off);
    expect(c.walk.spans).toEqual([{ from: 10, to: 20, delta: -40_000 }]);
    expect(c.sim.income).toEqual([{ amount: 30_000, fromYear: 0, toYear: 5, inflationAdjusted: true }]);
    expect(c.notes).toEqual([{ at: 0, id: 'pt', part: 'before-start' }]);
    // Not said, it stays out of the walk, as a migrated life event does.
    expect(compileItems([{ ...job, replaces: null }], fixedAges([job]), at, off).walk.spans).toEqual([]);
    // Begun before today: from its end, what it replaced less what it paid.
    const begun = { ...job, from: { anchor: { at: 'age' as const, age: 38 }, offset: 0 } };
    expect(compileItems([begun], fixedAges([begun]), at, off).walk.spans).toEqual([{ from: 20, to: null, delta: 40_000 }]);
  });

  test('unplaced items count nowhere; notes say which by position', () => {
    const a = { ...roof, id: 'same' };
    const b = { ...roof, id: 'same', from: { anchor: { at: 'age' as const, age: 30 }, offset: 0 } };
    const c = compileItems([a, b, rent], [{ start: 45, end: null }, { start: 30, end: null }, null], { ...at, startAge: 40 }, off);
    expect(c.notes).toEqual([{ at: 1, id: 'same', part: 'before-start' }]);
    expect(c.sim.income).toEqual([]);
  });
});

describe('part-time work that overlaps, for one person', () => {
  const at: CompileAt = { age: 40, startAge: 46, stop: 60, years: 40, taxRate: 0 };
  const blank = itemFromExpense({ id: 'x', label: 'x', amount: 0, atAge: 50 });
  type Job = { id: string; start: number; end: number | null; pays: number; replaces: number | null; owner?: PlanItem['owner'] };
  const compile = (jobs: Job[]) => {
    const items = jobs.map((j): PlanItem => ({ ...blank, id: j.id, label: j.id, kind: 'part-time', yearly: j.pays, once: null, replaces: j.replaces, owner: j.owner ?? null }));
    return compileItems(items, jobs.map((j) => ({ start: j.start, end: j.end })), at, off);
  };
  /** Saving at an age, on $60,000 measured. */
  const saving = (jobs: Job[], age: number) => savingsIn(compile(jobs).walk, 60_000, age - 40);
  const job = (id: string, start: number, end: number | null, replaces: number | null = 100_000, pays = 50_000, owner: PlanItem['owner'] = null): Job => ({ id, start, end, pays, replaces, owner });

  test('both count: each takes off what it replaces, and both pay in the simulation', () => {
    const c = compile([job('a', 44, 50), job('b', 48, 56)]);
    expect(c.walk.spans).toEqual([{ from: 4, to: 10, delta: -50_000 }, { from: 8, to: 16, delta: -50_000 }]);
    expect(c.sim.income).toEqual([
      { amount: 50_000, fromYear: 0, toYear: 4, inflationAdjusted: true },
      { amount: 50_000, fromYear: 2, toYear: 10, inflationAdjusted: true },
    ]);
    expect(c.inWalk).toEqual([true, true]);
  });

  test('a side job replacing nothing pays on top', () => {
    const jobs = [job('a', 44, 50), job('side', 48, 56, 0, 15_000)];
    expect(saving(jobs, 47)).toBe(10_000);
    expect(saving(jobs, 48)).toBe(25_000);
    expect(saving(jobs, 50)).toBe(75_000);
  });

  describe('begun before today, in measured saving with the take-home gone once', () => {
    test('it comes back once, from the last end', () => {
      // Whichever is listed first, and either way round the ends fall.
      for (const jobs of [[job('a', 36, 46), job('b', 38, 44)], [job('b', 38, 44), job('a', 36, 46)]]) {
        expect(saving(jobs, 43)).toBe(60_000);
        expect(saving(jobs, 44)).toBe(10_000);
        expect(saving(jobs, 46)).toBe(60_000);
      }
    });

    test('ending together, it still comes back once', () => {
      const jobs = [job('a', 36, 45), job('b', 38, 45)];
      expect(saving(jobs, 44)).toBe(60_000);
      expect(saving(jobs, 45)).toBe(60_000);
    });

    test('the largest said, whichever job it was', () => {
      const jobs = [job('a', 36, 44, 100_000), job('b', 38, 46, 30_000)];
      expect(saving(jobs, 44)).toBe(10_000);
      expect(saving(jobs, 46)).toBe(60_000);
    });

    test('one job alone is as it was: what it replaced less what it paid, from its end', () => {
      expect(compile([job('a', 36, 46)]).walk.spans).toEqual([{ from: 6, to: null, delta: 50_000 }]);
    });

    test('a side job replacing nothing doesn’t hold the take-home back', () => {
      const jobs = [job('a', 36, 44), job('side', 38, 50, 0, 15_000)];
      expect(saving(jobs, 44)).toBe(110_000);
      expect(saving(jobs, 50)).toBe(95_000);
    });

    test('each person’s comes back at their own end', () => {
      const jobs = [job('a', 36, 44), job('b', 38, 46, 100_000, 50_000, 'partner')];
      expect(saving(jobs, 44)).toBe(110_000);
      expect(saving(jobs, 46)).toBe(160_000);
    });

    test('none while one runs for good', () => {
      const jobs = [job('a', 36, null), job('b', 38, 44)];
      expect(saving(jobs, 44)).toBe(10_000);
      expect(saving(jobs, 70)).toBe(10_000);
    });

    test('one over before today, or not said, doesn’t count', () => {
      expect(saving([job('over', 30, 38), job('a', 36, 44)], 44)).toBe(110_000);
      expect(saving([job('over', 30, 38), job('a', 36, 44)], 38)).toBe(60_000);
      const unsaid = compile([job('unsaid', 38, 50, null), job('a', 36, 44)]);
      expect(unsaid.walk.spans).toEqual([{ from: 4, to: null, delta: 50_000 }]);
      expect(unsaid.inWalk).toEqual([false, true]);
    });
  });
});
