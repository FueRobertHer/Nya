// lib/fire/plan-figures.ts
//
// One plan's figures, the Plan's or a copy's, from the same functions: the FI
// view (lib/fire/plan.ts fiView), the engine plan (enginePlan), and the plan's
// items (lib/fire/items.ts), placed on the steady path (lib/fire/steady.ts) and
// counted where each kind counts (lib/fire/compile.ts): the FI walk and their
// parts of the simulation. Home and Your path both read this, so they say one
// answer.
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
import { compileItems, conditionalFlows, type CompiledItems, type Count, type ItemAges, type ItemNote } from './compile';
import { hasWalk, lastChange, savingsIn, walkBalanceAt, walkToFi, type CompiledEvents, type Shortfall, type WalkChanges } from './events';
import { MONEY_KINDS } from './items';
import { enginePlan, fiView, formulasTake, planYears, projectFrom, startAge, unmeasuredOf, type EnginePlan, type FiView, type Measured, type Missing, type PlanCore, type StartChoice } from './plan';
import { planOf, type FirePlanV2 } from './plan-v2';
import type { SavedItems, SavedPlan } from './saved-plan';
import { planPath } from './path';
import { resolveItems, type PerRun, type Resolution, type SteadyWorld } from './steady';

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
  /** The plan as run: the Plan, or a copy of it. */
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
   *  simulation's income and one-offs. */
  events: CompiledEvents | null;
  /** The plan's items' notes, by position. */
  itemNotes: ItemNote[];
  /** The walk's changes by year, which the projected mix follows
   *  (lib/fire/tax/mix.ts). */
  walk: WalkChanges;
  /** What moved the walk: the plan's one-offs and income (`items`), its items
   *  of the other kinds (`events`). */
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
 *  a search's candidate, leaves items out of the walk (only: what they change
 *  in retirement still sets the FI number it is tested against) and stops
 *  counting its changes after an age. */
function build(plan: FirePlanV2, measured: Measured, ages: readonly ItemAges[], stop: number | null, count: Count, opts?: { through: number | null; skip: ReadonlySet<number> }, perRun?: PerRun): Built | FiguresRefused {
  const display = fiView(plan, measured, stop);
  const at = { age: plan.age, startAge: startAge(plan, stop), stop, years: planYears(plan, stop), taxRate: plan.taxRate };
  const compiled = compileItems(plan.items, ages, at, count);
  const changes = opts && opts.skip.size > 0 ? compileItems(plan.items, ages.map((x, i) => (opts.skip.has(i) ? null : x)), at, count).walk : compiled.walk;
  const walk = opts && opts.through !== null && plan.age !== null ? upTo(changes, opts.through - plan.age) : changes;
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
  // The balance at the stop is the walk's whenever it changes, with an FI
  // number or without one (the path, lib/fire/path.ts, is the same walk).
  const from = projectFrom(plan, core);
  const walkAtStop = from !== null && hasWalk(walk) ? walkBalanceAt(from.assets, from.savings, plan.realReturn, walk, from.years) : null;
  const atStop = walkAtStop === null ? core.atTargetAge : 'balance' in walkAtStop ? walkAtStop.balance : null;
  // Built from retirement spending; the items' parts of the simulation added.
  const built = enginePlan(runPlan, { ...core, atTargetAge: atStop });
  let engine: Built['engine'] = built;
  if ('sim' in built) {
    // What waits on a run's own balance goes per run instead (D11).
    const fixed = perRun ? compileItems(plan.items, ages.map((x, i) => (perRun.edges[i] ? null : x)), at, count).sim : compiled.sim;
    const { oneOffs, income, lowerSpending } = fixed;
    engine = {
      ...built,
      sim: {
        ...built.sim,
        oneOffs: [...built.sim.oneOffs, ...oneOffs],
        income: [...built.sim.income, ...income],
        ...(lowerSpending.length > 0 ? { lowerSpending } : {}),
        ...(perRun ? { conditional: conditionalFlows(plan.items, perRun, ages, at) } : {}),
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
  if (walkAtStop !== null) view = { ...view, atTargetAge: atStop };
  return { view, core, engine, compiled, walk, retirement, short, walked, walkedSavings };
}

function assemble(plan: FirePlanV2, b: Built, resolution: Resolution): PlanFigures {
  const { compiled } = b;
  const counts = hasWalk(compiled.walk) || compiled.lasting.length > 0 || compiled.later.length > 0;
  const events: CompiledEvents | null = counts ? { walk: compiled.walk, lasting: compiled.lasting, later: compiled.later, sim: compiled.sim } : null;
  const money = (i: number) => MONEY_KINDS.includes(plan.items[i].kind);
  return {
    plan,
    view: b.view,
    engine: b.engine,
    events,
    itemNotes: compiled.notes,
    walkFrom: { items: compiled.inWalk.some((x, i) => x && money(i)), events: compiled.inWalk.some((x, i) => x && !money(i)) },
    inWalk: compiled.inWalk,
    resolution,
    retirement: b.retirement,
    short: b.short,
    walked: b.walked,
    walkedSavings: b.walkedSavings,
    walk: b.walk,
    startsWith: startsWith(plan, b.core, b.engine, b.walk),
  };
}

export function planFigures(plan: FirePlanV2, measured: Measured, { count }: FiguresOptions): PlanFigures | FiguresRefused {
  const world: SteadyWorld = {
    path(ages, stop) {
      const b = build(plan, measured, ages, stop, count);
      if ('refused' in b) return null;
      const p = planPath(assemble(plan, b, { ages, why: [], stop, fi: null, searched: 'none' }));
      if (p === null) return null;
      return [...p.points.map((x) => x.balance), ...(p.after?.points.slice(1).map((x) => x.balance) ?? [])];
    },
    fiAge(ages, stop, opts) {
      const b = build(plan, measured, ages, stop, count, opts);
      return 'refused' in b ? null : b.view.fiAge;
    },
  };
  const resolution = resolveItems(plan, world);
  const b = build(plan, measured, resolution.ages, resolution.stop, count, undefined, resolution.perRun);
  if ('refused' in b) return b;
  const f = assemble(plan, b, resolution);
  if (resolution.searched === 'none' || plan.age === null) return f;
  // The search's answer is the date: the age found, or none by the end. With
  // none and no date without it either (a figure not measured, or a cost the
  // walk can't pay), what that one says stands: not worked out isn't never.
  const found = resolution.fi;
  if (found === null && f.view.yearsToFi === null) return f;
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
  // From what you'd have at the stop, it is that balance: nothing to set it against.
  if (plan.start === 'assets' || plan.start === 'at-stop' || plan.age === null || atAge === null || !formulasTake(plan)) return base;
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
