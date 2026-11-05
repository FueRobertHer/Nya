// Seeded plans and life events for the tests that hold the Plan's arithmetic
// to that from before D15 (test/fixtures/before-d15) and its writes to the
// release before's readers (test/fixtures/release-before): the same seed
// gives the same cases on every run. The app no longer takes life events: a
// plan holds items, so the helpers here turn the release before's cases into
// items and run them as the app does.

import { seededRandom } from '@/lib/fire/random';
import { DEFAULT_PLAN, type FirePlan, type PlanExpense, type PlanIncome, type StartChoice } from '@/lib/fire/plan';
import type { CompiledEvents, EventNote, LifeEvent } from '@/lib/fire/events';
import { compileItems, type Count, type ItemAges } from '@/lib/fire/compile';
import { fixedEdges, type ItemKind, type PlanItem, type When } from '@/lib/fire/items';
import { planFigures } from '@/lib/fire/plan-figures';
import { planOf, type FirePlanV2 } from '@/lib/fire/plan-v2';
import type { Measured } from '@/lib/fire/plan';
import { wholeMoney } from '@/components/plan-text';

/** D15's switch off: every figure as the release before E1 had it. */
export const OFF: Count = { planInWalk: false };
export const ON: Count = { planInWalk: true };

const ageWhen = (age: number): When => ({ anchor: { at: 'age', age }, offset: 0 });

/** An item with only its kind's own fields set, the rest as the one shape has
 *  them for a field a kind doesn't take (lib/fire/items.ts). */
function item(id: string, label: string, kind: ItemKind, from: When, set: Partial<PlanItem>): PlanItem {
  return { id, label, kind, from, until: null, once: null, yearly: null, replaces: null, every: null, times: null, inflationAdjusted: true, owner: null, beforeTax: false, ...set };
}

/** A life event, as an item with the same figures and id, its ages
 *  as age anchors: a raise is pay up for good, a career break pay down by
 *  what it costs in saving for its years, part-time work with what it
 *  replaces not said (so it stays out of the walk, as it was). */
export function itemFromEvent(e: LifeEvent): PlanItem {
  switch (e.kind) {
    case 'house':
      return item(e.id, e.label, 'home', ageWhen(e.atAge), { until: e.years === null ? null : { years: e.years }, once: e.cost, yearly: e.yearly });
    case 'child':
      return item(e.id, e.label, 'child', ageWhen(e.fromAge), { until: { years: e.years }, yearly: e.yearly });
    case 'sabbatical':
      return item(e.id, e.label, 'pay', ageWhen(e.fromAge), { until: { years: e.years }, yearly: -e.savingsLost });
    case 'part-time':
      return item(e.id, e.label, 'part-time', ageWhen(e.fromAge), { until: ageWhen(e.toAge), yearly: e.yearly });
    case 'spending':
      return item(e.id, e.label, 'spending', ageWhen(e.fromAge), { until: e.years === null ? null : { years: e.years }, yearly: e.yearly });
    case 'car':
      return item(e.id, e.label, 'car', ageWhen(e.atAge), { once: e.cost, every: e.every, times: e.times });
    case 'raise':
      return item(e.id, e.label, 'pay', ageWhen(e.fromAge), { yearly: e.yearly });
    case 'windfall':
      return item(e.id, e.label, 'windfall', ageWhen(e.atAge), { once: e.amount });
    case 'loan-end':
      return item(e.id, e.label, 'loan-end', ageWhen(e.atAge), { yearly: e.yearly });
  }
}

/** A version 1 plan's figures, as the Plan tab works them out (in memory as
 *  version 2), with life events as items after its income and one-offs. */
export function figuresOf(p: FirePlan, m: Measured, events: readonly LifeEvent[] = [], count: Count = OFF) {
  const plan = planOf(p);
  return planFigures({ ...plan, items: [...plan.items, ...events.map(itemFromEvent)] }, m, { count });
}

/** The ages of items timed by ages alone (life events, version 1's lists):
 *  their own, an end for good null. */
export function fixedAges(items: readonly PlanItem[]): ItemAges[] {
  const edges = fixedEdges({ items: [...items], age: null, partnerAge: null, targetAge: null, stopAtFi: false });
  return items.map((_, i) => {
    const start = edges.get(`${i}:start`);
    return start === undefined ? null : { start, end: edges.get(`${i}:end`) ?? null };
  });
}

/**
 * Where each life event counts: in the FI walk from today (`age`), in the
 * simulation from its start age (`startAge`) for `years`. Either age may be
 * unknown; then that part is left out, and noted.
 */
export function compileEvents(events: readonly LifeEvent[], at: { age: number | null; startAge: number | null; years: number }): CompiledEvents & { notes: EventNote[] } {
  const items = events.map(itemFromEvent);
  const { notes, inWalk: _inWalk, ...rest } = compileItems(items, fixedAges(items), { ...at, stop: null, taxRate: 0 }, OFF);
  return { ...rest, notes: notes.map(({ id, part }) => ({ id, part })) };
}

/** What the Plan tab gives its Timeline card for a plan, in dollars and
 *  saving nothing. */
export function timelineProps(plan: FirePlanV2, m: Measured = { spending: null, savings: null, assets: null }, count: Count = ON) {
  const f = planFigures(plan, m, { count });
  const refused = 'refused' in f;
  return {
    plan,
    figures: refused ? null : f,
    refused,
    measured: m,
    count,
    copyName: null as string | null,
    version: 'v1',
    editable: true,
    paused: null as string | null,
    money: (n: number) => wholeMoney(n, 'USD'),
    planInWalk: count.planInWalk,
    savings: plan.savings ?? m.savings,
    onSave: async () => true as boolean | string,
    alsoFor: () => [],
    tryIt: null,
    onAskAge: () => {},
  };
}

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
/** A plan the frozen fixtures can read: D11's start is held by its own tests
 *  (test/plan-at-stop.test.ts), since no release before it reads it. */
export type GenPlan = FirePlan & { start: Exclude<StartChoice, 'at-stop'> };

export function genPlan(g: Rand, edge = false): GenPlan {
  const age = g.chance(0.9) ? g.int(22, 70) : null;
  const targetAge = g.chance(0.9) ? (age === null ? g.int(30, 75) : Math.min(100, age + g.int(0, 30))) : null;
  const start = g.pick<GenPlan['start']>(['fi-number', 'fi-number', 'assets', 'custom']);
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

/** Life events in their ranges, up to 6, with distinct ids. */
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
