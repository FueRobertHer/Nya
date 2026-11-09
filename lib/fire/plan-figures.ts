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
//   - with D9 (`fiAt`, from lib/fire/earliest.ts), FI is given, and the date is
//     that age: the earliest stop that lasts;
//   - what the plan STARTS WITH, and what the walk says it would have then:
//     a plan run from its FI number at an age it wouldn't have reached it is
//     said to start with money it wouldn't have (startsWith.more);
//   - in the detailed tax model (`detailed`, made by lib/fire/plan-detail.ts, so
//     this file loads none of it for a plan in the flat one), the tax on what a
//     year before the stop has to sell goes in the walk, `detail` holds the years
//     after the stop, and `shares` the tax and health in the FI number.
//
// THE FI NUMBER'S TAX AND HEALTH come from a drawdown of its own, from the FI number
// at the stop, whatever the plan starts from: the shares of a plan that doesn't last
// would overstate what it needs, and saving more would lower its target. Each round
// works the number out from the last round's pair, and draws from it, until the pair
// repeats. It iterates on the published pair (tax to a tenth of a percent, health to
// the dollar), so the number on the page reproduces the pair on the page. It takes a
// handful of rounds; one that goes round and round takes the higher of its last two.
// Candidates in a search each settle their own.
//
// Arithmetic only: no engine run, no market history.

import { projectBalance, projectionShort } from './fi';
import { compileItems, conditionalFlows, type CompiledItems, type Count, type ItemAges, type ItemNote } from './compile';
import { hasWalk, lastChange, savingsIn, walkBalanceAt, walkToFi, type CompiledEvents, type Shortfall, type WalkChanges } from './events';
import { MONEY_KINDS } from './items';
import { enginePlan, fiView, formulasTake, planYears, projectFrom, startAge, unmeasuredOf, type EnginePlan, type FiView, type Measured, type Missing, type PlanCore, type StartChoice, type WorkedOut } from './plan';
import { planOf, type FirePlanV2 } from './plan-v2';
import type { Drawdown } from './drawdown';
import type { DetailRun, DetailWork, PlanDetail } from './plan-detail';
import type { SavedItems, SavedPlan } from './saved-plan';
import { planPath } from './path';
import { resolveAt, resolveItems, type PerRun, type Resolution, type SteadyWorld } from './steady';

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

/** The tax and health in a detailed plan's FI number, and the run they came from. */
export type FiShares = {
  /** Tax's share of what the years cost, to a tenth of a percent. */
  t: number;
  /** The level yearly health cost, to the dollar. */
  h: number;
  /** The spending the number rests on, with lasting changes in effect at the stop,
   *  and what measured spending holds of coverage, which comes off it. */
  spending: number;
  paid: number;
  /** False where the rounds went round and round; `gap`, how far apart the last two numbers were. */
  settled: boolean;
  gap: number;
  /** The drawdown from the FI number, at this pair. */
  drawn: Drawdown;
  /** It had to take today's shares. */
  noMix: boolean;
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
   *  of the other kinds (`events`), tax on what a year had to sell (`tax`). */
  walkFrom: { items: boolean; events: boolean; tax: boolean };
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
  /** The years after the stop in the detailed tax model, or why they couldn't be
   *  worked out, when the flat model carries the plan. Null in the flat model. */
  detail: PlanDetail | { failed: string } | null;
  /** The tax and health in the FI number. Null in the flat model, and where they
   *  can't be worked out, when the flat model's number carries the plan. */
  shares: FiShares | null;
};

/** Lasting changes take spending in retirement below zero: not worked out. */
export type FiguresRefused = { refused: 'below-zero'; spending: number; lasting: number };

export type FiguresOptions = {
  /** What counts where, by the release flags (lib/fire/compile.ts Count). */
  count: Count;
  /** For a plan in the detailed tax model. */
  detailed?: DetailWork | null;
  /** The search's answer, from the job (lib/fire/search-job.ts), so nothing is
   *  searched for twice. */
  resolved?: Resolution;
  /** FI at this age, and under the stop at FI the stop too, in place of the
   *  search (D9's earliest stop that lasts, lib/fire/earliest.ts); null: none lasts. */
  fiAt?: number | null;
};

type Built = {
  view: FiView;
  core: FiView;
  engine: EnginePlan | { missing: Missing };
  compiled: CompiledItems;
  /** What the FI number leaves out: changes after the age it reads its lasting changes at. */
  later: CompiledItems['later'];
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
    ...(w.taxes ? { taxes: w.taxes.filter((x) => x.year <= last) } : {}),
  };
}

/** The figures with the items at `ages` and the stop at `stop`; `opts`, for
 *  a search's candidate, leaves items out of the walk (only: what they change
 *  in retirement still sets the FI number it is tested against) and stops
 *  counting its changes after an age. `shares`, the tax and health in the FI
 *  number, also count what income before the stop keeps. */
function build(plan: FirePlanV2, measured: Measured, ages: readonly ItemAges[], stop: number | null, count: Count, opts?: { through: number | null; skip: ReadonlySet<number> }, perRun?: PerRun, detailed?: DetailWork | null, shares?: { t: number; h: number } | null): Built | FiguresRefused {
  const flat = fiView(plan, measured, stop);
  // From the plan's own view, since lasting changes below make spending look typed.
  const worked: WorkedOut | undefined = shares && detailed ? { t: shares.t, h: shares.h, paid: flat.spending.source === 'measured' ? detailed.paidToday : 0 } : undefined;
  const display = worked ? fiView(plan, measured, stop, worked) : flat;
  const at = { age: plan.age, startAge: startAge(plan, stop), stop, years: planYears(plan, stop), taxRate: worked ? worked.t : plan.taxRate };
  const compiled = compileItems(plan.items, ages, at, count);
  const changes = opts && opts.skip.size > 0 ? compileItems(plan.items, ages.map((x, i) => (opts.skip.has(i) ? null : x)), at, count).walk : compiled.walk;
  let walk = opts && opts.through !== null && plan.age !== null ? upTo(changes, opts.through - plan.age) : changes;
  const lasting = compiled.lasting.reduce((s, x) => s + x.amount, 0);
  let core = display;
  let retirement: PlanFigures['retirement'] = null;
  let runPlan: PlanCore = plan;
  if (lasting !== 0 && display.spending.value !== null) {
    const spending = display.spending.value + lasting;
    if (spending < 0) return { refused: 'below-zero', spending: display.spending.value, lasting };
    retirement = { spending, lasting };
    runPlan = { ...plan, spending };
    core = fiView(runPlan, measured, stop, worked);
  }
  // The FI number's lasting changes are those at the stop, as its own run has them;
  // a start from today reads the simulation's at today.
  const fiStart = plan.age === null ? null : Math.max(stop ?? plan.age, plan.age);
  let later = compiled.later;
  if (worked && display.spending.value !== null && fiStart !== null && fiStart !== at.startAge) {
    const fiItems = compileItems(plan.items, ages, { ...at, startAge: fiStart, stop: fiStart, years: planYears({ ...plan, start: 'fi-number' }, stop) }, count);
    later = fiItems.later;
    const atFi = fiItems.lasting.reduce((s, x) => s + x.amount, 0);
    const number = fiView(atFi === 0 ? plan : { ...plan, spending: Math.max(0, display.spending.value + atFi) }, measured, stop, worked);
    core = { ...number, spending: core.spending };
  }
  // The balance at the stop is the walk's whenever it changes, with an FI
  // number or without one (the path, lib/fire/path.ts, is the same walk).
  const from = projectFrom(plan, core);
  if (detailed && from !== null) walk = detailed.taxWalk(plan, walk, from);
  const walkAtStop = from !== null && hasWalk(walk) ? walkBalanceAt(from.assets, from.savings, plan.realReturn, walk, from.years) : null;
  const atStop = walkAtStop === null ? core.atTargetAge : 'balance' in walkAtStop ? walkAtStop.balance : null;
  // Built from retirement spending; the items' parts of the simulation added.
  const built = enginePlan(runPlan, { ...core, atTargetAge: atStop });
  let engine: Built['engine'] = built;
  // What waits on a run's own balance goes per run instead (D11).
  const fixed = perRun ? compileItems(plan.items, ages.map((x, i) => (perRun.edges[i] ? null : x)), at, count) : compiled;
  if ('sim' in built) {
    const { oneOffs, income, lowerSpending } = fixed.sim;
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
  return { view, core, engine, compiled, later, walk, retirement, short, walked, walkedSavings };
}

function assemble(plan: FirePlanV2, b: Built, resolution: Resolution, shares: FiShares | null): PlanFigures {
  const { compiled } = b;
  const counts = hasWalk(compiled.walk) || compiled.lasting.length > 0 || compiled.later.length > 0;
  const events: CompiledEvents | null = counts ? { walk: compiled.walk, lasting: compiled.lasting, later: b.later, sim: compiled.sim } : null;
  const money = (i: number) => MONEY_KINDS.includes(plan.items[i].kind);
  return {
    plan,
    view: b.view,
    engine: b.engine,
    events,
    itemNotes: compiled.notes,
    walkFrom: { items: compiled.inWalk.some((x, i) => x && money(i)), events: compiled.inWalk.some((x, i) => x && !money(i)), tax: (b.walk.taxes?.length ?? 0) > 0 },
    inWalk: compiled.inWalk,
    resolution,
    retirement: b.retirement,
    short: b.short,
    walked: b.walked,
    walkedSavings: b.walkedSavings,
    walk: b.walk,
    startsWith: startsWith(plan, b.core, b.engine, b.walk),
    detail: null,
    shares,
  };
}

/** The most rounds of the FI number's run. */
const MAX_FI_ROUNDS = 8;

/** The pair as the page says it. */
const published = (d: Pick<Drawdown, 't' | 'h'>) => ({ t: Math.round(d.t * 1000) / 1000, h: Math.round(d.h) });

/** The tax and health in the FI number at these ages and this stop (see the header). */
function settleShares(plan: FirePlanV2, measured: Measured, ages: ItemAges[], stop: number | null, count: Count, detailed: DetailWork): FiShares | null {
  type Round = { pair: { t: number; h: number }; number: number; ran: DetailRun };
  const sharesOf = ({ pair, ran }: Round, settled: boolean, gap: number): FiShares => ({ ...pair, spending: ran.spending, paid: ran.paid, settled, gap, drawn: ran.drawn, noMix: ran.noMix });
  const same = (a: Round['pair'], b: Round['pair']) => a.t === b.t && a.h === b.h;
  let pair = { t: 0, h: 0 };
  let before: Round | null = null;
  let last: Round | null = null;
  for (let n = 0; n < MAX_FI_ROUNDS; n++) {
    const b = build(plan, measured, ages, stop, count, undefined, undefined, detailed, pair);
    if ('refused' in b || b.core.workedOut === null) return null;
    const ran = detailed.fiRun(assemble(plan, b, { ages, why: [], stop, fi: null, searched: 'none' }, null), b.core.workedOut);
    if (ran === null || 'failed' in ran) return null;
    const round: Round = { pair, number: b.core.workedOut, ran };
    const next = published(ran.drawn);
    if (same(next, pair)) return sharesOf(round, true, 0);
    before = last;
    last = round;
    if (before !== null && same(next, before.pair)) break;
    pair = next;
  }
  if (last === null) return null;
  const higher = before !== null && before.number > last.number ? before : last;
  return sharesOf(higher, false, before === null ? 0 : Math.abs(before.number - last.number));
}

export function planFigures(plan: FirePlanV2, measured: Measured, { count, detailed, resolved, fiAt }: FiguresOptions): PlanFigures | FiguresRefused {
  const kept = new Map<string, FiShares | null>();
  /** Per candidate: a search asks of the same ages and stop more than once. */
  const sharesFor = (ages: ItemAges[], stop: number | null): FiShares | null => {
    if (!detailed) return null;
    const key = JSON.stringify([ages, stop]);
    let made = kept.get(key);
    if (made === undefined) {
      made = settleShares(plan, measured, ages, stop, count, detailed);
      kept.set(key, made);
    }
    return made;
  };
  const world: SteadyWorld = {
    path(ages, stop) {
      const shares = sharesFor(ages, stop);
      const b = build(plan, measured, ages, stop, count, undefined, undefined, detailed, shares);
      if ('refused' in b) return null;
      const f = assemble(plan, b, { ages, why: [], stop, fi: null, searched: 'none' }, shares);
      const p = planPath(detailed ? { ...f, detail: detailed.forPath(f) } : f);
      if (p === null) return null;
      return [...p.points.map((x) => x.balance), ...(p.after?.points.slice(1).map((x) => x.balance) ?? [])];
    },
    fiAge(ages, stop, opts) {
      const b = build(plan, measured, ages, stop, count, opts, undefined, detailed, sharesFor(ages, stop));
      return 'refused' in b ? null : b.view.fiAge;
    },
  };
  const resolution = resolved ?? (fiAt !== undefined ? resolveAt(plan, world, fiAt) : resolveItems(plan, world));
  const shares = sharesFor(resolution.ages, resolution.stop);
  const b = build(plan, measured, resolution.ages, resolution.stop, count, undefined, resolution.perRun, detailed, shares);
  if ('refused' in b) return b;
  const assembled = assemble(plan, b, resolution, shares);
  const f = detailed ? { ...assembled, ...detailed.figures(assembled) } : assembled;
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
