// Seeded plans and life events for the tests that hold E1's arithmetic and
// readers to the release before's (test/fixtures/release-before): the same
// seed gives the same cases on every run.

import { seededRandom } from '@/lib/fire/random';
import { DEFAULT_PLAN, type FirePlan, type PlanExpense, type PlanIncome, type StartChoice } from '@/lib/fire/plan';
import type { LifeEvent } from '@/lib/fire/events';

export type Rand = { n: () => number; int: (min: number, max: number) => number; pick: <T>(xs: readonly T[]) => T; chance: (p: number) => boolean };

export function rand(seed: number): Rand {
  const r = seededRandom(seed);
  return {
    n: r,
    int: (min, max) => min + Math.floor(r() * (max - min + 1)),
    pick: (xs) => xs[Math.floor(r() * xs.length)],
    chance: (p) => r() < p,
  };
}

const LABELS = ['Roof', 'Social Security', 'Pension', 'Car', 'Wedding', 'Rental income', 'Boat', 'Tuition'];

/** A version 1 plan parsePlan takes, with up to 5 incomes and 10 one-offs.
 *  `edge` adds what version 1 takes and life events don't: $0 amounts. */
export function genPlan(g: Rand, edge = false): FirePlan {
  const age = g.chance(0.9) ? g.int(22, 70) : null;
  const targetAge = g.chance(0.9) ? (age === null ? g.int(30, 75) : Math.min(100, age + g.int(0, 30))) : null;
  const start = g.pick<StartChoice>(['fi-number', 'fi-number', 'assets', 'custom']);
  const amount = (max: number) => (edge && g.chance(0.15) ? 0 : g.int(1, max / 1000) * 1000);
  const income: PlanIncome[] = Array.from({ length: g.int(0, 5) }, (_, i) => ({
    id: `inc${i}`,
    label: g.pick(LABELS),
    amount: amount(60_000),
    fromAge: g.int(16, 100),
    inflationAdjusted: g.chance(0.6),
  }));
  const expenses: PlanExpense[] = Array.from({ length: g.int(0, 10) }, (_, i) => ({
    id: `exp${i}`,
    label: g.pick(LABELS),
    amount: amount(400_000),
    atAge: g.int(16, 110),
  }));
  return {
    ...DEFAULT_PLAN,
    age,
    targetAge,
    spending: g.chance(0.6) ? g.int(20, 120) * 1000 : null,
    savings: g.chance(0.4) ? g.int(-10, 80) * 1000 : null,
    assets: g.chance(0.4) ? g.int(0, 3000) * 1000 : null,
    withdrawalRate: g.pick([0.03, 0.035, 0.04, 0.045]),
    realReturn: g.pick([0.02, 0.04, 0.05, 0.06]),
    taxRate: g.pick([0, 0, 0.1, 0.2]),
    partTimeIncome: g.chance(0.2) ? g.int(5, 40) * 1000 : 0,
    rule: g.pick(['constant', 'percent', 'guardrails', 'vpw', 'floor-ceiling'] as const),
    start,
    startBalance: start === 'custom' ? g.int(100, 3000) * 1000 : g.chance(0.2) ? g.int(100, 3000) * 1000 : null,
    horizon: g.chance(0.2) ? g.int(10, 50) : null,
    income,
    expenses,
  };
}

/** Measured inputs: a figure, none, or there but not measured. */
export function genMeasured(g: Rand) {
  const off = g.chance(0.1) ? [g.pick(['spending', 'savings', 'assets'] as const)] : [];
  return {
    spending: g.chance(0.85) ? g.int(20, 150) * 1000 : null,
    savings: g.chance(0.85) ? g.int(-5, 90) * 1000 : null,
    assets: g.chance(0.85) ? g.int(0, 4000) * 1000 : null,
    ...(off.length > 0 ? { unmeasured: off } : {}),
  };
}

/** Life events parseLifeEvent takes, up to 10, with distinct ids. */
export function genEvents(g: Rand, prefix = 'ev'): LifeEvent[] {
  return Array.from({ length: g.int(0, 6) }, (_, i): LifeEvent => {
    const id = `${prefix}${i}`;
    const label = g.pick(LABELS);
    const at = g.int(20, 90);
    switch (g.int(0, 8)) {
      case 0:
        return { id, kind: 'house', label, atAge: at, cost: g.int(0, 400) * 1000, yearly: g.int(-20, 20) * 1000 || 1000, years: g.chance(0.5) ? null : g.int(1, 30) };
      case 1:
        return { id, kind: 'child', label, fromAge: at, yearly: g.int(1, 30) * 1000, years: g.int(1, 25) };
      case 2:
        return { id, kind: 'sabbatical', label, fromAge: at, years: g.int(1, 10), savingsLost: g.int(1, 60) * 1000 };
      case 3:
        return { id, kind: 'part-time', label, fromAge: at, toAge: Math.min(110, at + g.int(1, 15)), yearly: g.int(1, 50) * 1000 };
      case 4:
        return { id, kind: 'spending', label, fromAge: at, yearly: (g.chance(0.5) ? -1 : 1) * g.int(1, 30) * 1000, years: g.chance(0.5) ? null : g.int(1, 30) };
      case 5: {
        const times = g.chance(0.5) ? 1 : g.int(2, 4);
        return { id, kind: 'car', label, atAge: Math.min(at, 80), cost: g.int(5, 60) * 1000, every: times === 1 ? null : g.int(2, 8), times };
      }
      case 6:
        return { id, kind: 'raise', label, fromAge: at, yearly: g.int(1, 30) * 1000 };
      case 7:
        return { id, kind: 'windfall', label, atAge: at, amount: g.int(1, 500) * 1000 };
      default:
        return { id, kind: 'loan-end', label, atAge: at, yearly: g.int(1, 30) * 1000 };
    }
  });
}
