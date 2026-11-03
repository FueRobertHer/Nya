import { describe, expect, test } from 'bun:test';
import { DEFAULT_PLAN, projectFrom, type FirePlan, type Measured } from '@/lib/fire/plan';
import { planFigures, type PlanFigures } from '@/lib/fire/plan-figures';
import { planPath, steadyRun, type PlanPath } from '@/lib/fire/path';
import { makeMarket } from '@/lib/fire/market';
import { historicalCycles, type SimPlan } from '@/lib/fire/simulate';
import { hasWalk, savingsIn, walkBalanceAt, walkPath, type LifeEvent, type WalkChanges } from '@/lib/fire/events';
import { projectBalance, projectionShort } from '@/lib/fire/fi';
import { seededRandom } from '@/lib/fire/random';

// One plan's path (lib/fire/path.ts): invested assets year by year from
// today, from the same functions as the FI figures. Hand-worked cases, then
// properties over generated plans, with and without life events. Pure: no
// clock is read; every case gives its own ages.

const plan = (over: Partial<FirePlan> = {}): FirePlan => ({ ...DEFAULT_PLAN, ...over });
const figures = (p: FirePlan, m: Measured, events: LifeEvent[] = []): PlanFigures => {
  const f = planFigures(p, m, events);
  if ('refused' in f) throw new Error('refused');
  return f;
};
const path = (f: PlanFigures, years?: number): PlanPath => {
  const p = planPath(f, years);
  if (!p) throw new Error('no path');
  return p;
};
const balances = (p: PlanPath) => p.points.map((x) => x.balance);
const costIn = (w: WalkChanges, year: number) => w.costs.reduce((s, c) => (c.year === year ? s + c.amount : s), 0);
const inAt = (w: WalkChanges, year: number) => w.moneyIn.reduce((s, m) => (m.year === year ? s + m.amount : s), 0);
const none: Measured = { spending: null, savings: null, assets: null };
const home = (cost: number, atAge = 42): LifeEvent => ({ id: 'h', kind: 'house', label: 'Home', atAge, cost, yearly: 0, years: null });

describe('by hand', () => {
  test('with no events, the closed form at each whole year: $100,000, saving $20,000 a year at 5%', () => {
    const p = path(figures(plan({ age: 35, targetAge: 40, assets: 100_000, savings: 20_000 }), none));
    expect(p.points.map((x) => x.age)).toEqual([35, 36, 37, 38, 39, 40]);
    const want = [100_000, 125_000, 151_250, 178_812.5, 207_753.125, 238_140.78125];
    balances(p).forEach((b, k) => expect(b).toBeCloseTo(want[k], 6));
    expect(p.fromWalk).toBe(false);
    expect(p.short).toBeNull();
    expect(p.stopAge).toBe(40);
  });

  test('a home bought from investments at 42: the balance falls by its cost at the start of that year, then grows again', () => {
    const f = figures(plan({ age: 40, targetAge: 45, assets: 500_000, savings: 50_000 }), none, [home(300_000)]);
    const p = path(f);
    const want = [500_000, 575_000, 653_750, 421_437.5, 492_509.375, 567_134.84375];
    balances(p).forEach((b, k) => expect(b).toBeCloseTo(want[k], 6));
    expect(p.fromWalk).toBe(true);
    expect(balances(p)[5]).toBe(f.view.atTargetAge as number);
  });

  test('a cost it can’t pay: the path stops at the start of that year, with where and why, and there is no balance at the stop age', () => {
    const f = figures(plan({ age: 40, targetAge: 45, assets: 500_000, savings: 50_000 }), none, [home(900_000)]);
    const p = path(f);
    expect(balances(p)).toEqual([500_000, 575_000, 653_750]);
    expect(p.short).toEqual({ year: 2, have: 653_750, need: 900_000, kind: 'cost' });
    expect(f.view.atTargetAge).toBeNull();
  });

  test('a windfall pays a home bought in its own year: in first, then the cost, and the path goes on (8d)', () => {
    const gift: LifeEvent = { id: 'w', kind: 'windfall', label: 'Gift', atAge: 42, amount: 300_000 };
    const f = figures(plan({ age: 40, targetAge: 45, assets: 500_000, savings: 50_000 }), none, [home(900_000), gift]);
    const p = path(f);
    expect(p.short).toBeNull();
    // 653,750 at 42, before the windfall and the home; 53,750 left after both.
    const want = [500_000, 575_000, 653_750, 106_437.5, 161_759.375, 219_847.34375];
    balances(p).forEach((b, k) => expect(b).toBeCloseTo(want[k], 6));
    expect(balances(p)[5]).toBe(f.view.atTargetAge as number);
    // Less than the home takes, with the windfall: it stops, and says what there was.
    const less = path(figures(plan({ age: 40, targetAge: 45, assets: 500_000, savings: 50_000 }), none, [home(900_000), { ...gift, amount: 100_000 }]));
    expect(less.short).toEqual({ year: 2, have: 753_750, need: 900_000, kind: 'cost' });
  });

  test('a windfall that reaches the FI number on the day it comes: FI that year, and the point says what is in hand then (8d, with 8b’s chart)', () => {
    const gift: LifeEvent = { id: 'w', kind: 'windfall', label: 'Gift', atAge: 42, amount: 400_000 };
    const f = figures(plan({ age: 40, targetAge: 45, spending: 40_000, assets: 500_000, savings: 50_000 }), none, [gift]);
    expect(f.view.fiNumber).toBe(1_000_000);
    expect(f.view.yearsToFi).toBe(2);
    expect(f.view.fiAge).toBe(42);
    const p = path(f);
    // The point is the balance before the windfall, as before a cost; what
    // is in hand once it is in is at the FI number or over it.
    expect(p.points[2]).toEqual({ age: 42, balance: 653_750, inHand: 1_053_750 });
    expect(p.points.filter((q) => q.inHand !== undefined).length).toBe(1);
    expect(balances(p)[5]).toBe(f.view.atTargetAge as number);
    // With a home the same year, in hand is after it; with one it can't pay, none.
    const both = path(figures(plan({ age: 40, targetAge: 45, assets: 500_000, savings: 50_000 }), none, [gift, home(1_000_000)]));
    expect(both.points[2].inHand).toBeCloseTo(53_750, 6);
    const short = path(figures(plan({ age: 40, targetAge: 45, assets: 500_000, savings: 50_000 }), none, [gift, home(2_000_000)]));
    expect(short.points[2]).toEqual({ age: 42, balance: 653_750 });
    expect(short.short?.kind).toBe('cost');
  });

  test('savings below zero in the walk: it stops the year that would take it below zero, never a negative balance', () => {
    // Spending $30,000 more a year for good from today, saving nothing: the
    // walk saves -$30,000 a year at no growth.
    const more: LifeEvent = { id: 's', kind: 'spending', label: 'More', fromAge: 40, yearly: 30_000, years: null };
    const f = figures(plan({ age: 40, targetAge: 50, realReturn: 0, spending: 40_000, assets: 100_000, savings: 0 }), none, [more]);
    const p = path(f);
    expect(balances(p)).toEqual([100_000, 70_000, 40_000, 10_000]);
    expect(p.short).toEqual({ year: 3, have: 10_000, need: 30_000, kind: 'savings' });
    // Here the FI date's walk stops at the same place.
    expect(f.short).toEqual(p.short);
  });

  test('with no events, savings below zero: the projection stops the year that would take it below zero, as the walk does, and there is no balance at the stop age (rollout 8b)', () => {
    const f = figures(plan({ age: 40, targetAge: 55, assets: 100_000, savings: -10_000 }), none);
    const p = path(f);
    // $100,000 at 5%, taking $10,000 a year: $5,000 more than it earns,
    // growing; below zero in the 15th year.
    expect(p.points).toHaveLength(15);
    expect(p.short).toEqual({ year: 14, have: projectBalance(100_000, -10_000, 0.05, 14), need: 10_000, kind: 'savings' });
    expect(projectBalance(100_000, -10_000, 0.05, 15)).toBeLessThan(0);
    expect(f.view.atTargetAge).toBeNull();
  });

  test('a plan started from its FI number at a stop age the projection never gets to says so, never a balance below zero (review of 8b)', () => {
    const f = figures(plan({ age: 40, targetAge: 55, spending: 40_000, assets: 100_000, savings: -10_000 }), none);
    expect(f.startsWith?.projected).toBeNull();
    expect(f.startsWith?.short).toEqual({ year: 14, have: projectBalance(100_000, -10_000, 0.05, 14), need: 10_000, kind: 'savings' });
    expect(f.startsWith?.more).toBe(true);
  });

  test('invested assets below zero: nothing grows from there, even with savings that would climb out', () => {
    const f = figures(plan({ age: 40, targetAge: 70 }), { spending: null, savings: 6_000, assets: -100_000 });
    const p = path(f);
    expect(p.points).toEqual([{ age: 40, balance: -100_000 }]);
    expect(p.short).toEqual({ year: 0, have: -100_000, need: -6_000, kind: 'savings' });
    expect(f.view.atTargetAge).toBeNull();
  });

  test('already at FI with savings below zero for good: the FI date is today, and the path still runs out before the stop age', () => {
    const more: LifeEvent = { id: 's', kind: 'spending', label: 'More', fromAge: 40, yearly: 30_000, years: null };
    const f = figures(plan({ age: 40, targetAge: 60, realReturn: 0, spending: 20_000, savings: -50_000, assets: 1_300_000 }), none, [more]);
    expect(f.view.yearsToFi).toBe(0);
    expect(f.short).toBeNull();
    const p = path(f);
    expect(p.short).toEqual({ year: 16, have: 20_000, need: 80_000, kind: 'savings' });
    expect(f.view.atTargetAge).toBeNull();
  });

  test('a stop age before today’s: one point, today’s assets, which is atTargetAge', () => {
    const f = figures(plan({ age: 50, targetAge: 45, assets: 300_000, savings: 10_000 }), none);
    const p = path(f);
    expect(p.points).toEqual([{ age: 50, balance: 300_000 }]);
    expect(f.view.atTargetAge).toBe(300_000);
  });

  test('a length that isn’t a whole number of years, 0 or more, is refused', () => {
    const f = figures(plan({ age: 40, targetAge: 45, assets: 500_000, savings: 50_000 }), none, [home(300_000)]);
    for (const years of [2.5, -1, Infinity, NaN]) expect(() => planPath(f, years)).toThrow(RangeError);
    expect(path(f, 0).points).toEqual([{ age: 40, balance: 500_000 }]);
  });

  test('a longer path when asked for, the same years first', () => {
    const f = figures(plan({ age: 40, targetAge: 45, assets: 500_000, savings: 50_000 }), none, [home(300_000)]);
    const long = path(f, 20);
    expect(long.points).toHaveLength(21);
    expect(long.points.slice(0, 6)).toEqual(path(f).points);
    expect(long.points[20].age).toBe(60);
  });

  test('nothing to project from: no ages, rates the formulas don’t take, neither figure, or one not measured', () => {
    const p = plan({ age: 40, targetAge: 55, assets: 100_000, savings: 10_000 });
    expect(planPath(figures({ ...p, age: null }, none))).toBeNull();
    expect(planPath(figures({ ...p, targetAge: null }, none))).toBeNull();
    expect(planPath(figures({ ...p, realReturn: 2 }, none))).toBeNull();
    expect(planPath(figures({ ...p, assets: null, savings: null }, none))).toBeNull();
    expect(planPath(figures({ ...p, savings: null }, { ...none, unmeasured: ['savings'] }))).toBeNull();
  });
});

describe('the balance at the stop age counts life events with no FI number (review: a home with no spending)', () => {
  const p = plan({ age: 40, targetAge: 55, assets: 500_000, savings: 50_000 });
  test('no spending, so no FI number: the home still comes off the balance at 55', () => {
    const plain = figures(p, none);
    const f = figures(p, none, [home(300_000)]);
    expect(f.view.fiNumber).toBeNull();
    expect(f.walked).toBe(false);
    expect(plain.view.atTargetAge).toBeCloseTo(2_118_392, 0);
    // The same, less the $300,000 it would have grown from 42 to 55.
    expect(f.view.atTargetAge).toBeCloseTo((plain.view.atTargetAge as number) - 300_000 * 1.05 ** 13, 6);
    expect(f.view.atTargetAge).toBe(path(f).points[15].balance);
  });
  test('and one it can’t pay leaves no balance at 55, with the path saying where', () => {
    const f = figures(p, none, [home(900_000)]);
    expect(f.view.atTargetAge).toBeNull();
    expect(f.short).toBeNull();
    expect(path(f).short).toEqual({ year: 2, have: 653_750, need: 900_000, kind: 'cost' });
  });
});

// Generated plans: ages (some missing), rates within the ranges a plan
// takes (LIMITS), figures typed, measured, missing or not measured, savings
// below zero, and up to four life events of every kind (8d's car, raise,
// windfall and loan paid off among them), costs larger than the balance
// included. A stop age before today's and rates the formulas don't take are
// the hand-worked cases above.
function generate(seed: number) {
  const r = seededRandom(seed);
  const int = (lo: number, hi: number) => lo + Math.floor(r() * (hi - lo + 1));
  const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)];
  const maybe = <T,>(p: number, v: () => T): T | null => (r() < p ? v() : null);
  const age = maybe(0.9, () => int(20, 60));
  const targetAge = maybe(0.9, () => (age ?? 40) + int(0, 30));
  const realReturn = pick([-0.05, 0, 0.03, 0.05, 0.07, 0.15, int(-500, 1500) / 10_000]);
  const p = plan({
    age,
    targetAge,
    realReturn,
    withdrawalRate: int(20, 60) / 1000,
    taxRate: pick([0, 0.1, 0.25]),
    spending: maybe(0.4, () => int(10, 120) * 1000),
    savings: maybe(0.4, () => int(-40, 100) * 1000),
    assets: maybe(0.4, () => int(0, 2000) * 1000),
  });
  const off = (['spending', 'savings', 'assets'] as const).filter(() => r() < 0.1);
  const m: Measured = {
    spending: maybe(0.7, () => int(10, 120) * 1000),
    savings: maybe(0.7, () => int(-20, 80) * 1000),
    assets: maybe(0.7, () => (r() < 0.05 ? -int(1, 50) * 1000 : int(0, 1500) * 1000)),
    unmeasured: off,
  };
  const at = () => (age ?? 40) + int(-3, 30);
  const events: LifeEvent[] = [];
  const n = pick([0, 0, 1, 2, 3, 4]);
  for (let i = 0; i < n; i++) {
    const id = `e${i}`;
    const kind = pick(['house', 'child', 'sabbatical', 'part-time', 'spending', 'car', 'raise', 'windfall', 'loan-end'] as const);
    if (kind === 'house') events.push({ id, kind, label: 'Home', atAge: at(), cost: int(0, 900) * 1000, yearly: int(-20, 30) * 1000, years: maybe(0.5, () => int(1, 30)) });
    if (kind === 'child') events.push({ id, kind, label: 'Child', fromAge: at(), yearly: int(5, 30) * 1000, years: int(1, 25) });
    if (kind === 'sabbatical') events.push({ id, kind, label: 'Break', fromAge: at(), years: int(1, 3), savingsLost: int(10, 80) * 1000 });
    if (kind === 'part-time') {
      const fromAge = at();
      events.push({ id, kind, label: 'Part-time', fromAge, toAge: fromAge + int(1, 10), yearly: int(10, 40) * 1000 });
    }
    if (kind === 'spending') events.push({ id, kind, label: 'Spending', fromAge: at(), yearly: int(-30, 40) * 1000, years: maybe(0.5, () => int(1, 20)) });
    if (kind === 'car' || kind === 'raise' || kind === 'windfall' || kind === 'loan-end') events.push(extra(kind, id));
  }
  /** One event of a kind 8d added, with figures of its own. Loans paid off
   *  are kept small against spending, so few plans are refused for spending
   *  below zero in retirement. */
  function extra(kind: 'car' | 'raise' | 'windfall' | 'loan-end', id: string): LifeEvent {
    switch (kind) {
      case 'car': {
        const atAge = at();
        const every = maybe(0.5, () => int(2, 10));
        return { id, kind, label: 'Car', atAge, cost: int(5, 900) * 1000, every, times: every === null ? 1 : Math.min(int(2, 6), 1 + Math.floor((110 - atAge) / every)) };
      }
      case 'raise':
        return { id, kind, label: 'Raise', fromAge: at(), yearly: int(1, 30) * 1000 };
      case 'windfall':
        return { id, kind, label: 'Gift', atAge: at(), amount: int(10, 900) * 1000 };
      case 'loan-end':
        return { id, kind, label: 'Loan', atAge: at(), yearly: int(1, 10) * 1000 };
    }
  }
  return { p, m, events, extra };
}

describe('generated plans', () => {
  const CASES = 600;
  const cases = Array.from({ length: CASES }, (_, i) => generate(1000 + i))
    .map((c) => ({ ...c, f: planFigures(c.p, c.m, c.events) }))
    .filter((c): c is typeof c & { f: PlanFigures } => !('refused' in c.f));

  test('enough of each kind of case to mean something', () => {
    const paths = cases.map((c) => planPath(c.f));
    expect(cases.length).toBeGreaterThan(500);
    expect(paths.filter((p) => p === null).length).toBeGreaterThan(50);
    expect(paths.filter((p) => p?.fromWalk).length).toBeGreaterThan(100);
    expect(paths.filter((p) => p !== null && !p.fromWalk).length).toBeGreaterThan(50);
    expect(paths.filter((p) => p?.short).length).toBeGreaterThan(10);
    expect(cases.filter((c) => c.f.walked && c.f.view.yearsToFi !== null && Number.isFinite(c.f.view.yearsToFi) && c.f.view.yearsToFi > 0).length).toBeGreaterThan(50);
  });

  test('there is a path exactly when there is something to project from, starting at today’s age with today’s assets, a year a point', () => {
    for (const { f } of cases) {
      const from = projectFrom(f.plan, f.view);
      const p = planPath(f);
      expect(p === null).toBe(from === null);
      if (!p || !from) continue;
      expect([p.points[0].age, p.points[0].balance]).toEqual([f.plan.age as number, from.assets]);
      p.points.forEach((x, k) => expect(x.age).toBe((f.plan.age as number) + k));
      expect(p.stopAge).toBe(f.plan.targetAge as number);
      expect(p.fiNumber).toBe(f.view.fiNumber);
      expect(p.fiAge).toBe(f.view.fiAge);
      expect(p.fromWalk).toBe(f.events !== null && hasWalk(f.events.walk));
    }
  });

  test('it meets view.atTargetAge: the point at the stop age is the figure, to the bit, and it gets there exactly when there is one', () => {
    for (const { f } of cases) {
      const from = projectFrom(f.plan, f.view);
      const p = planPath(f);
      if (!p || !from) {
        expect(f.view.atTargetAge).toBeNull();
        continue;
      }
      if (p.short) {
        expect(p.points).toHaveLength(p.short.year + 1);
        expect(f.view.atTargetAge).toBeNull();
      } else {
        expect(p.points).toHaveLength(from.years + 1);
        expect(p.points[from.years].balance).toBe(f.view.atTargetAge as number);
      }
    }
  });

  // Money in (8d's windfall) changes this property, and only by its own
  // amount: a year's money in arrives at its start, before its costs, so a
  // year is the one before plus its money in, less its cost, grown, plus its
  // savings, and what a shortfall says there was includes it.
  test('no value from nowhere: each year of the walk is the year before, plus its money in, less its cost, grown, plus its savings; never below zero, never a cost paid from more than is there', () => {
    for (const { f } of cases) {
      const p = planPath(f, 60);
      if (!p?.fromWalk) continue;
      const w = (f.events as NonNullable<PlanFigures['events']>).walk;
      const from = projectFrom(f.plan, f.view)!;
      const g = f.plan.realReturn;
      const b = balances(p);
      for (let k = 0; k < b.length; k++) {
        // Today's assets are what they are; nothing after them is below zero.
        if (k > 0) expect(b[k]).toBeGreaterThanOrEqual(0);
        if (k + 1 < b.length) {
          if (costIn(w, k) > 0) expect(costIn(w, k)).toBeLessThanOrEqual(b[k] + inAt(w, k) + 1e-9);
          expect(b[k + 1]).toBe((b[k] + inAt(w, k) - costIn(w, k)) * (1 + g) + savingsIn(w, from.savings, k));
        }
      }
      const at = walkBalanceAt(from.assets, from.savings, g, w, 60);
      if ('short' in at) {
        expect(p.short).toEqual(at.short);
        const s = at.short;
        if (s.kind === 'cost') expect(s.have).toBe(b[s.year] + inAt(w, s.year));
        else expect(s.have).toBe(b[s.year] + inAt(w, s.year) - costIn(w, s.year));
      } else {
        expect(p.short).toBeNull();
        expect(b[60]).toBe(at.balance);
      }
    }
  });

  test('a point says what is in hand exactly in a year with money in whose costs are paid: the balance, plus the money in, less the costs, in the walk’s order', () => {
    let checked = 0;
    for (const { f } of cases) {
      const p = planPath(f, 60);
      if (!p) continue;
      const w = p.fromWalk ? (f.events as NonNullable<PlanFigures['events']>).walk : null;
      p.points.forEach((q, k) => {
        const paid = w !== null && !(costIn(w, k) > 0 && costIn(w, k) > q.balance + inAt(w, k) + 1e-9);
        if (w !== null && inAt(w, k) > 0 && paid) {
          checked++;
          expect(q.inHand).toBe(q.balance + inAt(w, k) - costIn(w, k));
        } else expect(q.inHand).toBeUndefined();
      });
    }
    expect(checked).toBeGreaterThan(30);
  });

  test('the only money in is the windfalls’, each once, at its own age from today', () => {
    let checked = 0;
    for (const { f, events } of cases) {
      if (!f.events || f.plan.age === null) continue;
      const age = f.plan.age;
      const windfalls = events.flatMap((e) => (e.kind === 'windfall' && e.atAge >= age ? [{ year: e.atAge - age, amount: e.amount }] : []));
      expect(f.events.walk.moneyIn).toEqual(windfalls);
      checked += windfalls.length;
    }
    expect(checked).toBeGreaterThan(30);
  });

  test('every point is walkBalanceAt’s for its year with life events, and the closed form’s, a step apart, without', () => {
    for (const { f } of cases) {
      const p = planPath(f, 40);
      if (!p) continue;
      const from = projectFrom(f.plan, f.view)!;
      const g = f.plan.realReturn;
      p.points.forEach(({ balance }, k) => {
        if (p.fromWalk) {
          const at = walkBalanceAt(from.assets, from.savings, g, (f.events as NonNullable<PlanFigures['events']>).walk, k);
          expect(at).toEqual({ balance });
        } else {
          expect(balance).toBe(projectBalance(from.assets, from.savings, g, k));
          if (k > 0) expect(balance).toBeGreaterThanOrEqual(0);
          if (k > 0) {
            const step = p.points[k - 1].balance * (1 + g) + from.savings;
            expect(Math.abs(step - balance)).toBeLessThanOrEqual(1e-9 * Math.max(1, Math.abs(balance)));
          }
        }
      });
    }
  });

  test('where the FI date’s walk stops within the path, the path stops there too', () => {
    let checked = 0;
    for (const { f } of cases) {
      if (!f.short) continue;
      const p = planPath(f, f.short.year + 1);
      if (!p) continue;
      checked++;
      expect(p.short).toEqual(f.short);
    }
    expect(checked).toBeGreaterThan(20);
  });

  // Money in changes this property where it is reached on the day money
  // comes in: the FI date is then that whole year, and the path's point for
  // it is the balance at the start of the year before its money in (as
  // before its cost), so it is that point plus the money in, less the cost,
  // that is at the FI number. 8b's chart draws the point; the marker is the
  // FI age.
  test('it meets the FI date: at the FI number by the year it is reached in, and below it in the year before', () => {
    let checked = 0;
    let onTheDay = 0;
    for (const { f } of cases) {
      const y = f.view.yearsToFi;
      const fi = f.view.fiNumber;
      if (y === null || !Number.isFinite(y) || y <= 0 || fi === null || y > 80) continue;
      const p = planPath(f, Math.ceil(y));
      if (!p) continue;
      checked++;
      const b = balances(p);
      const w = p.fromWalk ? (f.events as NonNullable<PlanFigures['events']>).walk : null;
      const inHand = (k: number) => b[k] + (w ? inAt(w, k) - costIn(w, k) : 0);
      expect(p.short).toBeNull();
      if (Number.isInteger(y)) {
        expect(inHand(y)).toBeGreaterThanOrEqual(fi * (1 - 1e-9));
        if (b[y] < fi * (1 - 1e-9)) {
          // Reached the day money comes in: the point's in hand says so, for
          // the chart to step up to the FI number at the FI age.
          onTheDay++;
          expect(p.points[y].inHand).toBe(inHand(y));
        }
      } else {
        expect(b[Math.ceil(y)]).toBeGreaterThanOrEqual(fi * (1 - 1e-9));
        expect(inHand(Math.floor(y))).toBeLessThan(fi * (1 + 1e-9));
      }
    }
    expect(checked).toBeGreaterThan(100);
    expect(onTheDay).toBeGreaterThan(0);
  });

  // 8d's kinds each move the FI date one way only, against the same plan
  // with one more of them: money in, a raise and a loan paid off never make
  // it later or add a shortfall; a car never makes it sooner or takes one
  // away. Compared only where the plan already walks, so the walk's own
  // shortfalls (which the closed form doesn't look for) are on both sides.
  test('each new kind moves the FI date one way only', () => {
    const later = (a: number | null, b: number | null) => (a ?? Infinity) > (b ?? Infinity) * (1 + 1e-9) + 1e-9;
    let compared = 0;
    for (let i = 0; i < 400; i++) {
      const c = generate(5000 + i);
      const base = planFigures(c.p, c.m, c.events);
      if ('refused' in base || !base.walked) continue;
      for (const kind of ['car', 'raise', 'windfall', 'loan-end'] as const) {
        const more = planFigures(c.p, c.m, [...c.events, c.extra(kind, 'x')]);
        if ('refused' in more) continue;
        expect(more.walked).toBe(true);
        compared++;
        const [y0, y1] = [base.short ? null : base.view.yearsToFi, more.short ? null : more.view.yearsToFi];
        if (kind === 'car') {
          if (base.short) expect(more.short).not.toBeNull();
          expect(later(y0, y1)).toBe(false);
        } else {
          if (!base.short) expect(more.short).toBeNull();
          expect(later(y1, y0)).toBe(false);
        }
      }
    }
    expect(compared).toBeGreaterThan(200);
  });
});

describe('walkPath', () => {
  test('is what walkBalanceAt reads: its last balance, or its short', () => {
    const w: WalkChanges = { moneyIn: [], costs: [{ year: 3, amount: 200_000 }], spans: [{ from: 1, to: 4, delta: -20_000 }] };
    for (let years = 0; years <= 10; years++) {
      const p = walkPath(150_000, 30_000, 0.04, w, years);
      const at = walkBalanceAt(150_000, 30_000, 0.04, w, years);
      expect(at).toEqual(p.short ? { short: p.short } : { balance: p.balances[years] });
    }
  });
});

describe('projectionShort', () => {
  // A year-by-year loop: the first year end below zero.
  const byYear = (a: number, c: number, g: number, years: number) => {
    for (let k = 0; k < years; k++) if (projectBalance(a, c, g, k + 1) < 0) return { year: k, have: projectBalance(a, c, g, k), need: -c, kind: 'savings' as const };
    return null;
  };
  test('is the first year end below zero, as a year-by-year loop finds it, for any start, savings, growth and span', () => {
    const r = seededRandom(42);
    let found = 0;
    for (let i = 0; i < 5000; i++) {
      const a = Math.round((r() * 2 - 0.1) * 1_000_000);
      const c = Math.round((r() * 2 - 1) * 80_000);
      const g = [-0.05, 0, 0.03, 0.05, 0.15, (r() - 0.3) * 0.2][Math.floor(r() * 6)];
      const years = Math.floor(r() * 85);
      const want = byYear(a, c, g, years);
      if (want) found++;
      expect(projectionShort(a, c, g, years)).toEqual(want);
    }
    expect(found).toBeGreaterThan(500);
  });
  test('a balance run down to exactly zero is decided by the figure shown: never a point or a balance at the stop age below zero (review of 8b)', () => {
    for (const [a, c, g, n] of [
      [100_000, -105_000, 0.05, 1],
      [41_000, -22_050, 0.05, 2],
    ]) {
      expect(projectionShort(a, c, g, n)).toEqual(byYear(a, c, g, n));
      const f = figures(plan({ age: 40, targetAge: 40 + n, assets: a, savings: c, realReturn: g }), none);
      for (const q of path(f).points.slice(1)) expect(q.balance).toBeGreaterThanOrEqual(0);
      if (f.view.atTargetAge !== null) expect(f.view.atTargetAge).toBeGreaterThanOrEqual(0);
    }
  });

  test('is cheap for any span a stored plan can hold', () => {
    expect(projectionShort(100_000, -10_000, 0.05, Infinity)).toEqual(byYear(100_000, -10_000, 0.05, 100));
    expect(projectionShort(100_000, 10_000, 0.05, Infinity)).toBeNull();
    expect(projectionShort(100_000, -10_000, 0.05, 1e9)).toEqual({ year: 14, have: projectBalance(100_000, -10_000, 0.05, 14), need: 10_000, kind: 'savings' });
    expect(projectionShort(100_000, 10_000, 0.05, 1e9)).toBeNull();
  });
});

// The steady path after the stop (the tax plan's P): steadyRun is the
// engine's year (lib/fire/simulate.ts runPaths) on one steady market, so on a
// market history that IS steady it gives what historicalCycles does for its
// one start: a month's return (1 + g)^(1/12) - 1 for stocks and bonds, and
// 3% a year of inflation, over exactly the plan's months.
describe('steadyRun', () => {
  const sim = (over: Partial<SimPlan> = {}): SimPlan => ({
    startBalance: 1_000_000,
    years: 30,
    allocation: { stocks: 1, bonds: 0, cash: 0 },
    rebalance: 'annual',
    fee: 0,
    taxRate: 0.1,
    rule: { kind: 'constant', rate: 0.04 },
    income: [],
    oneOffs: [],
    cashRealReturn: 0,
    ...over,
  });
  const steadyMarket = (g: number, years: number) => {
    const n = 12 * years;
    const month = (1 + g) ** (1 / 12) - 1;
    const prices = 1.03 ** (1 / 12) - 1;
    return makeMarket('1900-01', new Array(n).fill(month), new Array(n).fill(month), new Array(n).fill(prices));
  };
  const close = (a: number, b: number) => expect(Math.abs(a - b)).toBeLessThanOrEqual(1e-7 * Math.max(1, Math.abs(b)));
  const same = (p: SimPlan, g: number) => {
    const h = historicalCycles(p, steadyMarket(g, p.years));
    expect(h.paths).toBe(1);
    const run = steadyRun(p, g);
    const failed = h.worst[0].failedYear;
    expect(run.failedYear).toBe(failed);
    expect(run.balances).toHaveLength(failed === null ? p.years + 1 : failed + 1);
    run.balances.forEach((b, k) => close(b, h.balance.p50[k]));
    return run;
  };
  const income = [
    { amount: 20_000, fromYear: 10, inflationAdjusted: true },
    { amount: 12_000, fromYear: 5, inflationAdjusted: false },
    { amount: 30_000, fromYear: 2, toYear: 4, inflationAdjusted: true },
  ];
  const oneOffs = [{ amount: 80_000, year: 7 }, { amount: 25_000, year: 29 }, { amount: 50_000, year: 40 }];
  const lowerSpending = [{ amount: 10_000, fromYear: 3, toYear: 9 }, { amount: 5_000, fromYear: 20 }];

  // Guardrails at 4% growing 4%: the withdrawal stays well inside its 80%
  // and 120% of the rate's share, so no year sits on a threshold.
  for (const rule of [
    { kind: 'constant', rate: 0.04 },
    { kind: 'percent', rate: 0.04 },
    { kind: 'guardrails', rate: 0.04 },
    { kind: 'vpw', expectedReturn: 0.05 },
    { kind: 'floor-ceiling', rate: 0.04, floor: 0.9, ceiling: 1.25 },
  ] as const) {
    test(`the engine's year on a steady market: ${rule.kind}, with income kept up with inflation and not, one-offs and lower costs`, () => {
      same(sim({ rule }), 0.04);
      same(sim({ rule, income, oneOffs, lowerSpending }), 0.04);
      same(sim({ rule, income, oneOffs, lowerSpending, taxRate: 0 }), 0.05);
    });
  }

  test('one that runs out: the same year, and the balances up to the start of it', () => {
    const run = same(sim({ rule: { kind: 'constant', rate: 0.1 } }), 0.02);
    expect(run.failedYear).not.toBeNull();
    expect(run.failedYear!).toBeLessThan(29);
    const late = same(sim({ rule: { kind: 'constant', rate: 0.03 }, oneOffs: [{ amount: 5_000_000, year: 12 }] }), 0.04);
    expect(late.failedYear).toBe(12);
  });

  test('refuses what the engine refuses', () => {
    expect(() => steadyRun(sim({ fee: 0.6 }), 0.05)).toThrow(RangeError);
    expect(() => steadyRun(sim({ years: 0 }), 0.05)).toThrow(RangeError);
  });
});

describe('the path after the stop (the tax plan’s P)', () => {
  const after = (p: FirePlan, m: Measured = none, events: LifeEvent[] = []) => path(figures(p, m, events)).after;
  // $60,000 a year, no tax: a constant rule draws exactly that.
  const base = plan({ age: 41, targetAge: 50, spending: 60_000, savings: 50_000, assets: 595_000 });

  test('from the stop age’s balance to the plan’s end, the plan’s own rule drawing its spending at the steady return', () => {
    const f = figures(base, none);
    const a = path(f).after!;
    expect(a.points[0]).toEqual({ age: 50, balance: f.view.atTargetAge as number });
    expect(a.endAge).toBe(95);
    expect(a.points).toHaveLength(46);
    expect(a.points.at(-1)!.age).toBe(95);
    expect(a.runsOutAt).toBeNull();
    const b0 = a.points[0].balance;
    close(a.points[1].balance, (b0 - 60_000) * 1.05);
    expect(a.leftOut).toEqual({ items: [], events: false });
    expect(a.withEvents).toBe(false);
  });

  test('a typed length ends it there; one that ends by the stop leaves it out', () => {
    expect(after({ ...base, horizon: 20 })!.endAge).toBe(70);
    // From today's assets, 5 years from 41 ends before the stop at 50.
    expect(after({ ...base, start: 'assets', horizon: 5 })).toBeNull();
    expect(after({ ...base, start: 'assets', horizon: 20 })!.endAge).toBe(61);
  });

  test('plan income counts from the later of its age and the stop; one-offs before the stop don’t, and neither does what starts at or after the end', () => {
    const p = {
      ...base,
      income: [
        { id: 'p', label: 'Pension', amount: 20_000, fromAge: 45, inflationAdjusted: true },
        { id: 's', label: 'Social Security', amount: 24_000, fromAge: 67, inflationAdjusted: true },
        { id: 'l', label: 'Late', amount: 9_000, fromAge: 96, inflationAdjusted: true },
      ],
      expenses: [
        { id: 'c', label: 'Car', amount: 30_000, atAge: 48 },
        { id: 'r', label: 'Roof', amount: 40_000, atAge: 60 },
        { id: 'e', label: 'At the end', amount: 10_000, atAge: 95 },
      ],
    };
    const a = after(p)!;
    const b0 = a.points[0].balance;
    // The pension pays from 50: $40,000 out in the first year, not $60,000.
    close(a.points[1].balance, (b0 - 40_000) * 1.05);
    expect(a.leftOut.items).toEqual([
      { label: 'Pension', age: 50, kind: 'income' },
      { label: 'Roof', age: 60, kind: 'expense' },
      { label: 'Social Security', age: 67, kind: 'income' },
    ]);
    // The car at 48 is in neither the walk (no events) nor the years after.
    const noCar = after({ ...p, expenses: p.expenses.filter((x) => x.id !== 'c') })!;
    expect(noCar.points).toEqual(a.points);
  });

  test('a scenario’s lasting change in effect at the stop is in its spending, from the FI number or from today’s assets', () => {
    const more: LifeEvent = { id: 'm', kind: 'spending', label: 'More', fromAge: 45, yearly: 10_000, years: null };
    const fi = figures(base, none, [more]);
    const a = path(fi).after!;
    close(a.points[1].balance, (a.points[0].balance - 70_000) * 1.05);
    expect(a.withEvents).toBe(true);
    // The FI number counts it too (it starts by the stop), so it leaves out nothing.
    expect(a.leftOut.events).toBe(false);
    const assets = path(figures({ ...base, start: 'assets' }, none, [more])).after!;
    close(assets.points[1].balance, (assets.points[0].balance - 70_000) * 1.05);
    // From today's assets the FI number starts at 41, without it.
    expect(assets.leftOut.events).toBe(true);
    // A change after the stop is in the years it covers, and the FI number leaves it out.
    const later = path(figures(base, none, [{ ...more, fromAge: 60 }])).after!;
    close(later.points[1].balance, (later.points[0].balance - 60_000) * 1.05);
    expect(later.leftOut.events).toBe(true);
  });

  // The walk's stop point says what is in hand once a windfall that year is
  // in (8d); this path starts from the balance before it and counts it in
  // its first year, as the engine counts a one-off in its year.
  test('a windfall at the stop: the walk’s balance there, and the windfall in the first year after', () => {
    const gift: LifeEvent = { id: 'w', kind: 'windfall', label: 'Gift', atAge: 50, amount: 500_000 };
    const withGift = path(figures(base, none, [gift]));
    const stop = withGift.points[withGift.points.length - 1];
    expect(stop.inHand).toBeDefined();
    const a = withGift.after!;
    expect(a.points[0]).toEqual({ age: 50, balance: stop.balance });
    const plain = path(figures(base, none)).after!;
    close(a.points[0].balance, plain.points[0].balance);
    close(a.points[1].balance - plain.points[1].balance, 500_000 * 1.05);
    expect(a.withEvents).toBe(true);
  });

  test('once the stop has come, from today’s assets, today', () => {
    const f = figures({ ...base, age: 60 }, none);
    const p = path(f);
    expect(p.points).toEqual([{ age: 60, balance: 595_000 }]);
    expect(p.after!.points[0]).toEqual({ age: 60, balance: 595_000 });
    expect(p.after!.endAge).toBe(95);
  });

  test('one that can’t pay says the age it runs out at, and ends there', () => {
    const a = after({ ...base, spending: 150_000 })!;
    expect(a.runsOutAt).not.toBeNull();
    expect(a.points.at(-1)!.age).toBe(a.runsOutAt!);
  });

  test('none where there is nothing to draw, or the engine wouldn’t run it, and none for a path of a length asked for', () => {
    expect(after({ ...base, spending: null })).toBeNull();
    expect(after({ ...base, assets: 0, savings: 0 })).toBeNull();
    expect(after({ ...base, fee: 0.6 })).toBeNull();
    expect(path(figures({ ...base, fee: 0.6 }, none)).points).toHaveLength(10);
    expect(path(figures(base, none), 60).after).toBeNull();
    // A walk that can't get to the stop has nothing to start from there.
    expect(after(base, none, [home(5_000_000, 45)])).toBeNull();
  });
});

const close = (a: number, b: number) => expect(Math.abs(a - b)).toBeLessThanOrEqual(1e-6 * Math.max(1, Math.abs(b)));

describe('the path after the stop, over generated plans', () => {
  const cases = Array.from({ length: 600 }, (_, i) => generate(1000 + i))
    .map((c) => ({ ...c, f: planFigures(c.p, c.m, c.events) }))
    .filter((c): c is typeof c & { f: PlanFigures } => !('refused' in c.f));

  test('starting where the walk ends, a year a point to the plan’s end or the year it runs out, never below zero; none for a length asked for', () => {
    let drawn = 0;
    for (const { f } of cases) {
      const p = planPath(f);
      if (!p) continue;
      expect(planPath(f, 30)?.after ?? null).toBeNull();
      const a = p.after;
      if (!a) continue;
      drawn++;
      expect(p.short).toBeNull();
      expect(a.points[0]).toEqual({ age: p.points[p.points.length - 1].age, balance: p.points[p.points.length - 1].balance });
      a.points.forEach((q, k) => {
        expect(q.age).toBe(a.points[0].age + k);
        expect(Number.isFinite(q.balance)).toBe(true);
        expect(q.balance).toBeGreaterThanOrEqual(0);
      });
      expect(a.points.at(-1)!.age).toBe(a.runsOutAt ?? a.endAge);
      for (const i of a.leftOut.items) expect(i.age).toBeLessThan(a.endAge);
    }
    expect(drawn).toBeGreaterThan(50);
  });
});
