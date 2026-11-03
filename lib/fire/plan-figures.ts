// lib/fire/plan-figures.ts
//
// One plan's figures, the Plan's or a scenario's, from the same functions:
// the FI view (lib/fire/plan.ts fiView), the engine plan (enginePlan), and
// the plan's items with an open scenario's life events (lib/fire/items.ts),
// placed on the steady path (lib/fire/steady.ts) and counted where each kind
// counts (lib/fire/compile.ts): the FI walk and their parts of the
// simulation. Home and Your path both read this, so they say one answer.
//
// What items change, and how:
//   - lasting changes in effect when the simulation starts are retirement
//     spending: the FI number, Coast and Barista FI, and the spending the rule
//     withdraws are all worked out from the spending plus them, and the start
//     balance with it (a start from the FI number); every other change is in
//     the simulation only, and `later` names what the FI number leaves out;
//   - the FI date (years to FI, the age then) comes from the walk whenever
//     an item counts in it, and the balance at the stop whenever an item
//     changes the walk, with an FI number or without one. A plan's one-offs
//     and income count in it only with D15's switch (`count.planInWalk`);
//   - under "stop when I reach FI", or with an item on FI, the stop or FI is
//     searched for (lib/fire/steady.ts), and the date is the age found;
//   - what the plan STARTS WITH, and what the walk says it would have then:
//     a plan run from its FI number at an age it wouldn't have reached it is
//     said to start with money it wouldn't have (startsWith.more).
//
// Arithmetic only: no engine run, no market history.

import { projectBalance, projectionShort } from './fi';
import { compileItems, type CompiledItems, type Count, type ItemAges, type ItemNote } from './compile';
import { hasWalk, lastChange, savingsIn, walkBalanceAt, walkToFi, type CompiledEvents, type Shortfall, type WalkChanges } from './events';
import { MONEY_KINDS, type PlanItem } from './items';
import { enginePlan, fiView, formulasTake, planYears, projectFrom, startAge, unmeasuredOf, type EnginePlan, type FiView, type Measured, type Missing, type PlanCore, type StartChoice } from './plan';
import { planOf, type FirePlanV2 } from './plan-v2';
import type { SavedItems, SavedPlan } from './saved-plan';
import { planPath } from './path';
import { resolveItems, type Resolution, type SteadyWorld } from './steady';

export type StartsWith = {
  balance: number;
  from: StartChoice;
  /** The age the simulation starts at, when known. */
  atAge: number | null;
  /** What the walk projects at that age, for a start from the FI number or a
   *  typed balance (a start from today's assets is what is there); null when
   *  it can't be said (no age, or nothing to project from). */
  projected: number | null;
  /** The walk couldn't get there (a cost it can't pay). */
  short: Shortfall | null;
  /** It starts with more than the walk says it would have then. */
  more: boolean;
};

export type PlanFigures = {
  /** The plan as run (the Plan, or a scenario resolved). */
  plan: FirePlanV2;
  /** For display: the inputs as typed or measured; the FI number and what
   *  follows from it from retirement spending; years to FI and the age then
   *  from the walk when it counts (or the search), and the balance at the
   *  stop from it whenever an item changes it (null where it can't get
   *  there). Its stopAge is the resolved stop. */
  view: FiView;
  engine: EnginePlan | { missing: Missing };
  /** What the items add: the walk, lasting and later changes, and their
   *  parts of the simulation, null when none counts anywhere but the
   *  simulation's income and one-offs. Its notes are an open scenario's. */
  events: CompiledEvents | null;
  /** Every item run, the plan's first, then an open scenario's. */
  items: readonly PlanItem[];
  /** How many of `items` are the plan's. */
  planItems: number;
  /** The plan's items' notes, by position. */
  itemNotes: ItemNote[];
  /** What moved the walk: one-offs and income (a plan's, or a scenario's
   *  added ones), life events (a scenario's, or a plan's of those kinds). */
  walkFrom: { items: boolean; events: boolean };
  /** Per item, by position: whether it put anything in the walk. */
  inWalk: boolean[];
  /** Where each item is on the steady path, the stop, and the search. */
  resolution: Resolution;
  /** Spending in retirement with lasting changes, when there are any. */
  retirement: { spending: number; lasting: number } | null;
  /** The walk stopped: a cost it couldn't pay. Then there is no FI date. */
  short: Shortfall | null;
  /** Whether the FI date came from the walk. */
  walked: boolean;
  /** What the walk saves a year after the last change (lasting changes
   *  included), for the words when it never gets there; null unwalked. */
  walkedSavings: number | null;
  startsWith: StartsWith | null;
};

/** Lasting changes take spending in retirement below zero: not worked out. */
export type FiguresRefused = { refused: 'below-zero'; spending: number; lasting: number };

export type FiguresOptions = {
  /** An open scenario's life events, as items (lib/fire/items.ts eventItems). */
  events?: readonly PlanItem[];
  /** What counts where, by the release flags (lib/fire/compile.ts Count). */
  count: Count;
};

type Built = {
  view: FiView;
  core: FiView;
  engine: EnginePlan | { missing: Missing };
  compiled: CompiledItems;
  walk: WalkChanges;
  retirement: PlanFigures['retirement'];
  short: Shortfall | null;
  walked: boolean;
  walkedSavings: number | null;
};

/** The walk's changes through year `last` only: later ones dropped, a
 *  span running on from there as it was. */
function upTo(w: WalkChanges, last: number): WalkChanges {
  return {
    moneyIn: w.moneyIn.filter((x) => x.year <= last),
    costs: w.costs.filter((x) => x.year <= last),
    spans: w.spans.filter((s) => s.from <= last).map((s) => (s.to !== null && s.to > last ? { ...s, to: null } : s)),
  };
}

/** The figures with the items at `ages` and the stop at `stop`; `opts`, for
 *  a search's candidate, leaves items out of the walk and stops counting its
 *  changes after an age. */
function build(plan: FirePlanV2, measured: Measured, items: readonly PlanItem[], ages: readonly ItemAges[], stop: number | null, count: Count, opts?: { through: number | null; skip: ReadonlySet<number> }): Built | FiguresRefused {
  const display = fiView(plan, measured, stop);
  const placed = opts && opts.skip.size > 0 ? ages.map((x, i) => (opts.skip.has(i) ? null : x)) : ages;
  const compiled = compileItems(items, placed, { age: plan.age, startAge: startAge(plan, stop), stop, years: planYears(plan, stop), taxRate: plan.taxRate }, count);
  const walk = opts && opts.through !== null && plan.age !== null ? upTo(compiled.walk, opts.through - plan.age) : compiled.walk;
  const lasting = compiled.lasting.reduce((s, x) => s + x.amount, 0);
  let core = display;
  let retirement: PlanFigures['retirement'] = null;
  let runPlan: PlanCore = plan;
  if (lasting !== 0 && display.spending.value !== null) {
    const spending = display.spending.value + lasting;
    if (spending < 0) return { refused: 'below-zero', spending: display.spending.value, lasting };
    retirement = { spending, lasting };
    runPlan = { ...plan, spending };
    core = fiView(runPlan, measured, stop);
  }
  // Built from retirement spending; the items' parts of the simulation added.
  const built = enginePlan(runPlan, core);
  let engine: Built['engine'] = built;
  if ('sim' in built) {
    const { oneOffs, income, lowerSpending } = compiled.sim;
    engine = {
      ...built,
      sim: {
        ...built.sim,
        oneOffs: [...built.sim.oneOffs, ...oneOffs],
        income: [...built.sim.income, ...income],
        ...(lowerSpending.length > 0 ? { lowerSpending } : {}),
      },
    };
  }
  let view: FiView = { ...core, spending: display.spending };
  let short: Shortfall | null = null;
  let walkedSavings: number | null = null;
  // Never from a figure that isn't measured (lib/fire/plan.ts Measured).
  const walked = hasWalk(walk) && core.fiNumber !== null && (core.assets.value !== null || core.savings.value !== null) && unmeasuredOf(core).length === 0 && formulasTake(plan);
  if (walked) {
    const a = core.assets.value ?? 0;
    const c = core.savings.value ?? 0;
    const w = walkToFi(a, c, plan.realReturn, core.fiNumber as number, walk);
    walkedSavings = savingsIn(walk, c, lastChange(walk) + 1);
    if ('short' in w) {
      short = w.short;
      view = { ...view, yearsToFi: null, fiAge: null };
    } else {
      view = { ...view, yearsToFi: w.years, fiAge: Number.isFinite(w.years) && plan.age !== null ? plan.age + w.years : null };
    }
  }
  // The balance at the stop is the walk's whenever it changes, with an FI
  // number or without one (the path, lib/fire/path.ts, is the same walk).
  const from = projectFrom(plan, core);
  if (from !== null && hasWalk(walk)) {
    const at = walkBalanceAt(from.assets, from.savings, plan.realReturn, walk, from.years);
    view = { ...view, atTargetAge: 'balance' in at ? at.balance : null };
  }
  return { view, core, engine, compiled, walk, retirement, short, walked, walkedSavings };
}

function assemble(plan: FirePlanV2, items: readonly PlanItem[], n: number, b: Built, resolution: Resolution): PlanFigures {
  const { compiled } = b;
  const notes = compiled.notes.filter((x) => x.at >= n).map(({ id, part }) => ({ id, part }));
  const counts = hasWalk(compiled.walk) || compiled.lasting.length > 0 || compiled.later.length > 0;
  const events: CompiledEvents | null = items.length > n || counts ? { walk: compiled.walk, lasting: compiled.lasting, later: compiled.later, sim: compiled.sim, notes } : null;
  const money = (i: number) => MONEY_KINDS.includes(items[i].kind);
  return {
    plan,
    view: b.view,
    engine: b.engine,
    events,
    items,
    planItems: n,
    itemNotes: compiled.notes.filter((x) => x.at < n),
    walkFrom: { items: compiled.inWalk.some((x, i) => x && money(i)), events: compiled.inWalk.some((x, i) => x && !money(i)) },
    inWalk: compiled.inWalk,
    resolution,
    retirement: b.retirement,
    short: b.short,
    walked: b.walked,
    walkedSavings: b.walkedSavings,
    startsWith: startsWith(plan, b.core, b.engine, b.walk),
  };
}

export function planFigures(plan: FirePlanV2, measured: Measured, { events = [], count }: FiguresOptions): PlanFigures | FiguresRefused {
  const items = events.length > 0 ? [...plan.items, ...events] : plan.items;
  const n = plan.items.length;
  const world: SteadyWorld = {
    path(ages, stop) {
      const b = build(plan, measured, items, ages, stop, count);
      if ('refused' in b) return null;
      const p = planPath(assemble(plan, items, n, b, { ages, why: [], stop, fi: null, searched: 'none' }));
      if (p === null) return null;
      return [...p.points.map((x) => x.balance), ...(p.after?.points.slice(1).map((x) => x.balance) ?? [])];
    },
    fiAge(ages, stop, opts) {
      const b = build(plan, measured, items, ages, stop, count, opts);
      return 'refused' in b ? null : b.view.fiAge;
    },
  };
  const resolution = resolveItems({ ...plan, items }, world);
  const b = build(plan, measured, items, resolution.ages, resolution.stop, count);
  if ('refused' in b) return b;
  const f = assemble(plan, items, n, b, resolution);
  if (resolution.searched === 'none' || plan.age === null) return f;
  // The search's answer is the date: the age found, or none by the end.
  const found = resolution.fi;
  return {
    ...f,
    view: { ...f.view, fiAge: found, yearsToFi: found === null ? Infinity : found - plan.age },
    short: found === null ? f.short : null,
  };
}

const savedKept = new Map<string, SavedItems | null>();

/**
 * A saved plan's items where its own steady path has them, for Progress
 * (lib/fire/saved-plan.ts plannedAt): its figures worked out once, from the
 * start's balance, the savings it kept and its typed spending, or `spending`
 * (today's measured) where none was typed. Null with no age or nothing in
 * the walk, so the line is a steady one, as before items. Kept per saved
 * copy, start, spending and switch, so the month points only evaluate.
 */
export function resolveSaved(saved: Pick<SavedPlan, 'plan' | 'savings' | 'day' | 'rev'>, start: { day: string; total: number }, spending: number | null, count: Count): SavedItems | null {
  const key = JSON.stringify([saved.rev, saved.day, start.day, start.total, spending, count.planInWalk]);
  const kept = savedKept.get(key);
  if (kept !== undefined) return kept;
  const plan = planOf(saved.plan);
  let out: SavedItems | null = null;
  if (plan.age !== null && plan.items.length > 0) {
    const f = planFigures({ ...plan, savings: saved.savings, assets: start.total }, { spending, savings: saved.savings, assets: start.total }, { count });
    if (!('refused' in f) && f.events !== null && hasWalk(f.events.walk)) {
      const counted = plan.items.flatMap((item, i) => (f.inWalk[i] && MONEY_KINDS.includes(item.kind) ? [{ item, ages: f.resolution.ages[i] }] : []));
      out = { from: saved.day, age: plan.age, walk: f.events.walk, counted };
    }
  }
  if (savedKept.size >= 16) savedKept.clear();
  savedKept.set(key, out);
  return out;
}

function startsWith(plan: FirePlanV2, view: FiView, engine: EnginePlan | { missing: Missing }, walk: WalkChanges): StartsWith | null {
  if (!('sim' in engine)) return null;
  const balance = engine.sim.startBalance;
  const atAge = engine.startAge;
  const base = { balance, from: plan.start, atAge, projected: null, short: null, more: false };
  if (plan.start === 'assets' || plan.age === null || atAge === null || !formulasTake(plan)) return base;
  if ((view.assets.value === null && view.savings.value === null) || unmeasuredOf(view).length > 0) return base;
  const a = view.assets.value ?? 0;
  const c = view.savings.value ?? 0;
  const years = Math.max(0, atAge - plan.age);
  if (!hasWalk(walk)) {
    // Never a projection below zero: where it would go there, it never gets
    // that far, as the walk says.
    const short = projectionShort(a, c, plan.realReturn, years);
    if (short) return { ...base, short, more: true };
    const projected = projectBalance(a, c, plan.realReturn, years);
    return { ...base, projected, more: balance > projected + 0.5 };
  }
  const at = walkBalanceAt(a, c, plan.realReturn, walk, years);
  if ('short' in at) return { ...base, short: at.short, more: true };
  return { ...base, projected: at.balance, more: balance > at.balance + 0.5 };
}
