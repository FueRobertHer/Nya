// lib/fire/plan-figures.ts
//
// One plan's figures, the Plan's or a scenario's, from the same functions:
// the FI view (lib/fire/plan.ts fiView), the engine plan (enginePlan), and,
// with life events (lib/fire/events.ts), the FI walk and the events' parts
// of the simulation. With no events it is fiView and enginePlan exactly, so
// the Plan's column in compare mode is the Plan tab's own figures.
//
// What life events change, and how:
//   - lasting changes in effect when the simulation starts are retirement
//     spending: the FI number, Coast and Barista FI, and the spending the rule
//     withdraws are all worked out from the spending plus them, and the start
//     balance with it (a start from the FI number); every other change is in
//     the simulation only, and `later` names what the FI number leaves out;
//   - the FI date (years to FI, the age then) comes from the walk whenever
//     an event counts in it, and the balance at the target age whenever an
//     event changes the walk, with an FI number or without one;
//   - what the plan STARTS WITH, and what the walk says it would have then:
//     a plan run from its FI number at an age it wouldn't have reached it is
//     said to start with money it wouldn't have (startsWith.more).
//
// Arithmetic only: no engine run, no market history.

import { projectBalance } from './fi';
import { compileEvents, hasWalk, lastChange, savingsIn, walkBalanceAt, walkToFi, type CompiledEvents, type LifeEvent, type Shortfall } from './events';
import { enginePlan, fiView, formulasTake, planYears, projectFrom, startAge, unmeasuredOf, type EnginePlan, type FirePlan, type FiView, type Measured, type Missing, type StartChoice } from './plan';

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
  plan: FirePlan;
  /** For display: the inputs as typed or measured; the FI number and what
   *  follows from it from retirement spending; years to FI and the age then
   *  from the walk when it counts, and the balance at the target age from it
   *  whenever an event changes it (null where it can't get there). */
  view: FiView;
  engine: EnginePlan | { missing: Missing };
  events: CompiledEvents | null;
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

export function planFigures(plan: FirePlan, measured: Measured, events: readonly LifeEvent[] = []): PlanFigures | FiguresRefused {
  if (events.length === 0) {
    const view = fiView(plan, measured);
    const engine = enginePlan(plan, view);
    return { plan, view, engine, events: null, retirement: null, short: null, walked: false, walkedSavings: null, startsWith: startsWith(plan, view, engine, null) };
  }
  const display = fiView(plan, measured);
  const compiled = compileEvents(events, { age: plan.age, startAge: startAge(plan), years: planYears(plan) });
  const lasting = compiled.lasting.reduce((s, x) => s + x.amount, 0);
  let core = display;
  let retirement: PlanFigures['retirement'] = null;
  let runPlan = plan;
  if (lasting !== 0 && display.spending.value !== null) {
    const spending = display.spending.value + lasting;
    if (spending < 0) return { refused: 'below-zero', spending: display.spending.value, lasting };
    retirement = { spending, lasting };
    runPlan = { ...plan, spending };
    core = fiView(runPlan, measured);
  }
  // Built from retirement spending; the events' parts of the simulation added.
  const built = enginePlan(runPlan, core);
  let engine: PlanFigures['engine'] = built;
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
  const walked = hasWalk(compiled.walk) && core.fiNumber !== null && (core.assets.value !== null || core.savings.value !== null) && unmeasuredOf(core).length === 0 && formulasTake(plan);
  if (walked) {
    const a = core.assets.value ?? 0;
    const c = core.savings.value ?? 0;
    const w = walkToFi(a, c, plan.realReturn, core.fiNumber as number, compiled.walk);
    walkedSavings = savingsIn(compiled.walk, c, lastChange(compiled.walk) + 1);
    if ('short' in w) {
      short = w.short;
      view = { ...view, yearsToFi: null, fiAge: null };
    } else {
      view = { ...view, yearsToFi: w.years, fiAge: Number.isFinite(w.years) && plan.age !== null ? plan.age + w.years : null };
    }
  }
  // The balance at the target age is the walk's whenever it changes, with an
  // FI number or without one (the path, lib/fire/path.ts, is the same walk).
  const from = projectFrom(plan, core);
  if (from !== null && hasWalk(compiled.walk)) {
    const at = walkBalanceAt(from.assets, from.savings, plan.realReturn, compiled.walk, from.years);
    view = { ...view, atTargetAge: 'balance' in at ? at.balance : null };
  }
  return { plan, view, engine, events: compiled, retirement, short, walked, walkedSavings, startsWith: startsWith(plan, core, engine, compiled) };
}

function startsWith(plan: FirePlan, view: FiView, engine: EnginePlan | { missing: Missing }, compiled: CompiledEvents | null): StartsWith | null {
  if (!('sim' in engine)) return null;
  const balance = engine.sim.startBalance;
  const atAge = engine.startAge;
  const base = { balance, from: plan.start, atAge, projected: null, short: null, more: false };
  if (plan.start === 'assets' || plan.age === null || atAge === null || !formulasTake(plan)) return base;
  if ((view.assets.value === null && view.savings.value === null) || unmeasuredOf(view).length > 0) return base;
  const a = view.assets.value ?? 0;
  const c = view.savings.value ?? 0;
  const years = Math.max(0, atAge - plan.age);
  if (!compiled || !hasWalk(compiled.walk)) {
    const projected = projectBalance(a, c, plan.realReturn, years);
    return { ...base, projected, more: balance > projected + 0.5 };
  }
  const at = walkBalanceAt(a, c, plan.realReturn, compiled.walk, years);
  if ('short' in at) return { ...base, short: at.short, more: true };
  return { ...base, projected: at.balance, more: balance > at.balance + 0.5 };
}
