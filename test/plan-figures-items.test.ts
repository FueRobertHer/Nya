import { describe, expect, test } from 'bun:test';
import { planPath } from '@/lib/fire/path';
import type { PlanFigures } from '@/lib/fire/plan-figures';
import { expensesOf, incomeOf } from '@/lib/fire/items';
import { DEFAULT_PLAN, type FirePlan } from '@/lib/fire/plan';
import { planOf } from '@/lib/fire/plan-v2';
import * as oldFigures from './fixtures/before-d15/fire/plan-figures';
import * as oldPath from './fixtures/before-d15/fire/path';
import * as oldSaved from './fixtures/before-d15/fire/saved-plan';
import { plannedAt } from '@/lib/fire/saved-plan';
import { resolveSaved } from '@/lib/fire/plan-figures';
import { figuresOf, genEvents, genMeasured, genPlan, ON, rand } from './plan-gen';

// The Plan's arithmetic on version 2 (lib/fire/plan-figures.ts, path.ts),
// held to the files from before D15 (test/fixtures/before-d15, the release
// before E1's own) for every version 1 plan and scenario: with D15's switch
// off nothing moves. Then what the switch moves.

const cases = Array.from({ length: 400 }, (_, i) => {
  const g = rand(7000 + i);
  const p = genPlan(g, i % 3 === 0);
  const m = genMeasured(g);
  const events = g.chance(0.6) ? genEvents(g) : [];
  return { p, m, events };
});

describe('with the switch off, the release before’s figures exactly', () => {
  test('the view, the engine plan, the walk and what it starts with', () => {
    let compared = 0;
    for (const { p, m, events } of cases) {
      const was = oldFigures.planFigures(p, m, events);
      const now = figuresOf(p, m, events);
      if ('refused' in was || 'refused' in now) {
        expect(now).toEqual(was as never);
        continue;
      }
      compared++;
      const { stopAge, workedOut, ...view } = now.view;
      expect(view).toEqual(was.view);
      expect(stopAge).toBe(p.targetAge);
      expect(workedOut).toBe(was.view.fiNumber);
      if ('missing' in was.engine) expect(now.engine).toEqual(was.engine);
      else {
        const { left: _left, beyond: _beyond, ...engine } = was.engine;
        expect(now.engine).toEqual(engine);
      }
      expect([now.retirement, now.short, now.walked, now.walkedSavings, now.startsWith]).toEqual([was.retirement, was.short, was.walked, was.walkedSavings, was.startsWith]);
      if (was.events === null) expect(now.events).toBeNull();
      else {
        // Null now where none of them counts, which every reader takes as none.
        const e = now.events ?? { walk: { moneyIn: [], costs: [], spans: [] }, lasting: [], later: [] };
        // Then, the life events' notes were the events' own; now, an item's.
        const notes = now.itemNotes.filter((n) => n.at >= planOf(p).items.length).map(({ id, part }) => ({ id, part }));
        expect([e.walk, e.lasting, e.later, notes]).toEqual([was.events.walk, was.events.lasting, was.events.later, was.events.notes]);
      }
      expect(now.walkFrom.items).toBe(false);
    }
    expect(compared).toBeGreaterThan(300);
  });

  test('the path, to the stop and after it, whole', () => {
    let drawn = 0;
    for (const { p, m, events } of cases) {
      const was = oldFigures.planFigures(p, m, events);
      const now = figuresOf(p, m, events);
      if ('refused' in was || 'refused' in now) continue;
      const before = oldPath.planPath(was);
      expect(planPath(now)).toEqual(before);
      if (before?.after) drawn++;
      if (before && p.age !== null) expect(planPath(now, 7)).toEqual(oldPath.planPath(was, 7));
    }
    expect(drawn).toBeGreaterThan(100);
  });

  test('Will it last?’s incomes and one-offs, and the card’s notes, are the ones it placed', () => {
    for (const { p, m, events } of cases) {
      const was = oldFigures.planFigures(p, m, events);
      const now = figuresOf(p, m, events);
      if ('refused' in was || 'refused' in now || 'missing' in was.engine) continue;
      const { left, beyond } = was.engine;
      // The version 1 lists' own notes, which come before the life events'.
      const own = planOf(p).items.length;
      const ids = (...parts: string[]) => new Set(now.itemNotes.filter((n) => n.at < own && parts.includes(n.part)).map((n) => n.id));
      const unplaced = ids('no-age', 'before-start', 'after-end');
      expect(incomeOf(now.plan).filter((x) => !unplaced.has(x.id))).toEqual(p.income.filter((x) => !left.income.includes(x)));
      expect(expensesOf(now.plan).filter((x) => !unplaced.has(x.id))).toEqual(p.expenses.filter((x) => !left.expenses.includes(x) && !beyond.includes(x)));
      expect([...ids('no-age', 'before-start')].sort()).toEqual([...left.income, ...left.expenses].map((x) => x.id).sort());
      expect([...ids('after-end')]).toEqual(beyond.map((x) => x.id));
    }
  });

  test('Progress’s line: a saved copy of each plan, placed and evaluated, is where the release before had it', () => {
    const days = ['2024-03-01', '2024-09-15', '2025-03-01', '2027-06-30', '2031-01-01'];
    for (const [i, { p, m }] of cases.entries()) {
      const saved = { version: 1 as const, plan: p, savings: m.savings ?? 0, currency: 'USD', inflation: 0.03, day: '2024-03-01', savedAt: '2024-03-01T12:00:00.000Z', rev: `r${i}` };
      const start = { day: '2024-03-01', total: m.assets ?? 0 };
      const items = resolveSaved(saved, start, m.spending, { planInWalk: false });
      for (const d of days) expect(plannedAt(saved, start, d, items)).toBe(oldSaved.plannedAt(saved, start, d));
    }
  });
});

describe('with the switch on (D15)', () => {
  const p: FirePlan = { ...DEFAULT_PLAN, age: 40, targetAge: 50, spending: 40_000, savings: 50_000, assets: 500_000 };
  const m = { spending: null, savings: null, assets: null };
  const fi = (plan: FirePlan, on: boolean) => {
    const f = figuresOf(plan, m, [], on ? ON : undefined) as PlanFigures;
    return f.view.fiAge as number;
  };

  test('a one-off before FI moves the FI date; it moves nothing with the switch off', () => {
    const roof = { ...p, expenses: [{ id: 'roof', label: 'Roof', amount: 100_000, atAge: 45 }] };
    expect(fi(roof, false)).toBe(fi(p, false));
    expect(fi(roof, true)).toBeGreaterThan(fi(p, true));
    const f = figuresOf(roof, m, [], ON) as PlanFigures;
    expect(f.walkFrom).toEqual({ items: true, events: false, tax: false });
    expect(f.events?.walk.costs).toEqual([{ year: 5, amount: 100_000 }]);
    // The FI number never moves with D15.
    expect(f.view.fiNumber).toBe((figuresOf(roof, m) as PlanFigures).view.fiNumber);
  });

  test('income adds to saving from its age, and brings FI sooner', () => {
    const rent = { ...p, income: [{ id: 'rent', label: 'Rental', amount: 20_000, fromAge: 42, inflationAdjusted: true }] };
    expect(fi(rent, true)).toBeLessThan(fi(p, true));
    expect((figuresOf(rent, m, [], ON) as PlanFigures).events?.walk.spans).toEqual([{ from: 2, to: null, delta: 20_000 }]);
  });

  test('one before today, or after FI, leaves the date where it was', () => {
    const past = { ...p, expenses: [{ id: 'old', label: 'Old', amount: 100_000, atAge: 38 }] };
    expect(fi(past, true)).toBe(fi(p, true));
    const late = { ...p, expenses: [{ id: 'late', label: 'Late', amount: 1, atAge: 90 }] };
    expect(Math.round(fi(late, true))).toBe(Math.round(fi(p, true)));
  });

  test('the path steps down where a one-off lands', () => {
    const roof = { ...p, expenses: [{ id: 'roof', label: 'Roof', amount: 100_000, atAge: 45 }] };
    const on = planPath(figuresOf(roof, m, [], ON) as PlanFigures);
    const off = planPath(figuresOf(roof, m) as PlanFigures);
    expect(on?.fromWalk).toBe(true);
    expect(off?.fromWalk).toBe(false);
    expect(on?.points[6].balance).toBeLessThan(off?.points[6].balance as number);
    expect(on?.points[5].balance).toBeCloseTo(off?.points[5].balance as number, 6);
  });
});
