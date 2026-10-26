import { describe, expect, test } from 'bun:test';
import { DEFAULT_PLAN, projectFrom, type FirePlan, type Measured } from '@/lib/fire/plan';
import { planFigures, type PlanFigures } from '@/lib/fire/plan-figures';
import { planPath, type PlanPath } from '@/lib/fire/path';
import { hasWalk, savingsIn, walkBalanceAt, walkPath, type LifeEvent, type WalkChanges } from '@/lib/fire/events';
import { projectBalance } from '@/lib/fire/fi';
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

  test('with no events, savings below zero take the closed form below zero, as atTargetAge already says (for 8b to decide how to draw)', () => {
    const f = figures(plan({ age: 40, targetAge: 55, assets: 100_000, savings: -10_000 }), none);
    const p = path(f);
    expect(p.short).toBeNull();
    expect(balances(p)[15]).toBe(f.view.atTargetAge as number);
    expect(balances(p)[15]).toBeLessThan(0);
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
    assets: maybe(0.7, () => int(0, 1500) * 1000),
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
      expect(p.points[0]).toEqual({ age: f.plan.age as number, balance: from.assets });
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
        expect(b[k]).toBeGreaterThanOrEqual(0);
        if (k + 1 < b.length) {
          expect(costIn(w, k)).toBeLessThanOrEqual(b[k] + inAt(w, k) + 1e-9);
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
        if (b[y] < fi * (1 - 1e-9)) onTheDay++;
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
