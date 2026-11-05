// lib/fire/path.ts
//
// One plan's path: invested assets year by year from today, the balances the
// FI figures already rest on, for the chart on Your path (rollout 8b) to
// draw. From the same functions as the figures, so the point at the target
// age is the view's atTargetAge exactly:
//   - with items that change the walk (lib/fire/events.ts), the walk's own
//     balances (walkPath, which walkBalanceAt reads);
//   - otherwise projectBalance at each whole year (lib/fire/fi.ts), the
//     closed form fiView projects the target age's balance with, stopping
//     where a year would end below zero (projectionShort), as the walk does.
// Nothing from nowhere: no point the figures couldn't also give, no money in
// but a windfall's, and none where the walk can't go on (a cost larger than
// the balance, or a year taking out more than there is). A point is the
// balance at the start of its year, before that year's money in and costs.
//
// After the stop (the tax plan's P, D13), the same steady return on to the
// plan's end, where Will it last? ends: the plan's own rule drawing its
// spending, with its items in the years they cover, at the ages the figures
// resolved them to (steadyRun, below). It starts where the walk ends, at the
// stop age's balance (today's once the stop has come). Not the simulation:
// no fee, no cash and no mix, one return a year on the whole balance. In the
// detailed tax model those years are the drawdown's (lib/fire/plan-detail.ts),
// from the same balance to the same end.
//
// Arithmetic only, and nothing that touches storage: the Plan tab runs this
// in the browser.

import { projectBalance, projectionShort } from './fi';
import { compileItems } from './compile';
import type { Drawdown } from './drawdown';
import { costIn, hasWalk, walkPath, type Shortfall } from './events';
import { INCOME_KINDS, MONEY_KINDS } from './items';
import { enginePlan, planYears, projectFrom, startAge, type FiView, type PlanCore } from './plan';
import type { PlanFigures } from './plan-figures';
import { plannedWithdrawal, type YearState } from './rules';
import { DEFAULT_INFLATION } from './saved-plan';
import { checkPlan, type SimPlan } from './simulate';

/** `inHand`, only in a year with money in (a windfall): the balance once it
 *  has come in and that year's costs are paid, which the chart steps up to
 *  at that age, so a windfall that reaches the FI number reaches it on the
 *  line. Left out where that year's costs are more than there is. */
export type PathPoint = { age: number; balance: number; inHand?: number };

export type PlanPath = {
  /** From today's age, one a year, to the end asked for (the target age by
   *  default), or through the start of the year the walk can't go on. */
  points: PathPoint[];
  /** The age the plan stops working at (the view's stopAge). */
  stopAge: number;
  /** The view's: the FI number, and the age it is reached at (null when it
   *  never is, or isn't worked out). */
  fiNumber: number | null;
  fiAge: number | null;
  /** Where this path can't go on, within its own years. Not the figures'
   *  `short`, which is the FI date's: the walk to the FI number, which keeps
   *  going until it gets there and is only looked for with an FI number. */
  short: Shortfall | null;
  /** The points are the walk's, with the plan's items. Not the figures'
   *  `walked`, which says the FI date is (that needs an FI number;
   *  these points don't). */
  fromWalk: boolean;
  /** The years after the stop, to the plan's end: only for the path to the
   *  stop (no length asked for), and null where there is nothing to draw. */
  after: PathAfter | null;
};

/** What the path counts after the stop that the FI number leaves out: plan
 *  income from the age it counts from, and one-off costs at their age. */
export type LeftOutItem = { label: string; age: number; kind: 'income' | 'expense' };

export type PathAfter = {
  /** From the age it starts drawing (the stop, or today once the stop has
   *  come), one a year, to `endAge`, or through the start of the year it
   *  can't pay. The first has the walk's last balance; a windfall that year
   *  is in that point's `inHand` on the walk, and in this path's first year. */
  points: PathPoint[];
  /** The plan's end: where Will it last? ends (startAge plus planYears). */
  endAge: number;
  /** The age of the year it can't pay, or null when it lasts. */
  runsOutAt: number | null;
  /** Within its own years only: nothing it never reaches. `events` says items
   *  beyond income and one-offs count here in a way the FI number doesn't. */
  leftOut: { items: LeftOutItem[]; events: boolean };
  /** Items beyond income and one-offs count in these years. */
  withEvents: boolean;
};

/** Which part of the path Your path's chart shows: to the stop, or to the
 *  plan's end. Here so the dashboard can keep it without the Plan's
 *  components (test/plan-landing-source.test.ts). */
export type PathRange = 'stop' | 'whole';

const EPS = 1e-9;

/**
 * One run of a simulation plan on a steady market: `realReturn` a year on
 * the whole balance, prices rising DEFAULT_INFLATION a year (for income that
 * doesn't keep up with it, and the nominal return guardrails read). Each
 * year as the engine's (lib/fire/simulate.ts runPaths): the rule's
 * withdrawal, income and one-offs, lower costs, the need grossed up for tax,
 * run out in the year it can't be paid; then the rest grows. Balances are at
 * the start of each year: `years + 1` when it lasts, through the start of
 * the year it ran out in when it doesn't. Throws as checkPlan does.
 */
export function steadyRun(sim: SimPlan, realReturn: number): { balances: number[]; failedYear: number | null } {
  checkPlan(sim);
  const years = sim.years;
  const tax = sim.taxRate;
  const inflation = DEFAULT_INFLATION;
  const oneOffs = new Array<number>(years).fill(0);
  for (const o of sim.oneOffs) if (o.year < years) oneOffs[o.year] += o.amount;
  const lower = new Array<number>(years).fill(0);
  for (const l of sim.lowerSpending ?? []) {
    for (let y = l.fromYear; y < Math.min(years, l.toYear ?? years); y++) lower[y] += l.amount;
  }
  const state: YearState = { year: 0, years, balance: 0, startBalance: sim.startBalance, previous: 0, initial: 0, lastNominalReturn: 0, lastInflation: 0 };
  const balances: number[] = [];
  let bal = sim.startBalance;
  for (let y = 0; y < years; y++) {
    balances.push(bal);
    state.year = y;
    state.balance = bal;
    const raw = plannedWithdrawal(sim.rule, state);
    const planned = Number.isFinite(raw) && raw > 0 ? raw : 0;
    if (y === 0) state.initial = planned;
    state.previous = planned;
    let income = 0;
    for (const s of sim.income) {
      if (y < s.fromYear || (s.toYear !== undefined && y >= s.toYear)) continue;
      income += s.inflationAdjusted ? s.amount : s.amount / (1 + inflation) ** (y - Math.max(0, s.fromYear));
    }
    const cost = planned * (1 - tax) + oneOffs[y];
    const need = (lower[y] > 0 ? Math.max(0, cost - lower[y]) : cost) - income;
    if (need > 0) {
      const gross = need / (1 - tax);
      if (gross > bal * (1 + EPS) + EPS) return { balances, failedYear: y };
      bal = Math.max(0, bal - gross);
    } else if (need < 0) {
      bal -= sim.bridged ? need / (1 - tax) : need;
    }
    state.lastNominalReturn = bal > 0 ? (1 + realReturn) * (1 + inflation) - 1 : 0;
    state.lastInflation = inflation;
    bal *= 1 + realReturn;
  }
  balances.push(bal);
  return { balances, failedYear: null };
}

/** The path from today, `years` whole years long (to the target age by
 *  default); null when there is nothing to project from (projectFrom).
 *  Throws on a length that isn't a whole number of years, 0 or more. */
export function planPath(f: PlanFigures, years?: number): PlanPath | null {
  if (years !== undefined && !(Number.isInteger(years) && years >= 0)) throw new RangeError(`A path is a whole number of years, 0 or more: ${years}`);
  const from = projectFrom(f.plan, f.view);
  if (from === null) return null;
  const age = f.plan.age as number;
  const n = years ?? from.years;
  const g = f.plan.realReturn;
  const walk = hasWalk(f.walk) ? f.walk : null;
  let balances: number[];
  let short: Shortfall | null = null;
  if (walk !== null) {
    ({ balances, short } = walkPath(from.assets, from.savings, g, walk, n));
  } else {
    short = projectionShort(from.assets, from.savings, g, n);
    balances = [];
    for (let k = 0; k <= (short ? short.year : n); k++) balances.push(projectBalance(from.assets, from.savings, g, k));
  }
  const sum = (xs: readonly { year: number; amount: number }[], k: number) => xs.reduce((s, x) => (x.year === k ? s + x.amount : s), 0);
  const point = (balance: number, k: number): PathPoint => {
    const moneyIn = walk ? sum(walk.moneyIn, k) : 0;
    if (!walk || moneyIn <= 0) return { age: age + k, balance };
    // In the walk's own order: money in, then the year's costs.
    const cost = costIn(walk, k);
    const inHand = balance + moneyIn;
    return cost > 0 && cost > inHand + 1e-9 ? { age: age + k, balance } : { age: age + k, balance, inHand: inHand - cost };
  };
  const points = balances.map(point);
  return {
    points,
    stopAge: f.view.stopAge as number,
    fiNumber: f.view.fiNumber,
    fiAge: f.view.fiAge,
    short,
    fromWalk: walk !== null,
    after: years === undefined && short === null ? afterStop(f, points[points.length - 1]) : null,
  };
}

/** A drawdown's balances, as a steady run says them: at the start of each year,
 *  through the start of the year it couldn't pay, or to the end of its last. */
function drawnBalances(d: Drawdown): { balances: number[]; failedYear: number | null } {
  const total = (b: Drawdown['years'][number]['start']) => b.taxable + b.deferred + b.roth + b.hsa;
  const first = d.years.findIndex((y) => y.short);
  if (first >= 0) return { balances: d.years.slice(0, first + 1).map((y) => total(y.start)), failedYear: first };
  return { balances: [...d.years.map((y) => total(y.start)), total(d.years[d.years.length - 1].end)], failedYear: null };
}

/** The years after the stop, from `from` (the walk's last point: the stop
 *  age's balance, or today's once the stop has come). The plan's own rule
 *  draws its spending, with lasting changes in effect then, as a start from
 *  that balance (enginePlan's 'custom' start, so the first year withdraws
 *  the spending, grossed up for tax); the items' parts count from that age,
 *  each at the age the figures resolved it to. Null where there is nothing
 *  to draw, or the engine wouldn't run it. */
function afterStop(f: PlanFigures, from: PathPoint): PathAfter | null {
  const plan = f.plan;
  const d = from.age;
  const stop = f.view.stopAge;
  const first = startAge(plan, stop);
  const spendingNow = f.view.spending.value;
  if (first === null || spendingNow === null || !(from.balance > 0)) return null;
  const endAge = first + planYears(plan, stop);
  const years = endAge - d;
  if (years < 1) return null;
  // Only the simulation's parts are read here, so the walk's switch is off.
  const at = { age: plan.age, startAge: d, stop: d, years, taxRate: plan.taxRate };
  const ages = f.resolution.ages;
  const all = compileItems(plan.items, ages, at, { planInWalk: false });
  const lasting = all.lasting.reduce((s, x) => s + x.amount, 0);
  const spending = spendingNow + lasting;
  if (spending < 0) return null;
  const run: PlanCore = { ...plan, start: 'custom', startBalance: from.balance, targetAge: d, stopAtFi: false, horizon: years, spending };
  const view: FiView = { ...f.view, stopAge: d, spending: { ...f.view.spending, value: spending } };
  const built = enginePlan(run, view);
  if (!('sim' in built)) return null;
  const { oneOffs, income, lowerSpending } = all.sim;
  const sim = {
    ...built.sim,
    oneOffs: [...built.sim.oneOffs, ...oneOffs],
    income: [...built.sim.income, ...income],
    ...(lowerSpending.length > 0 ? { lowerSpending } : {}),
  };
  // What the FI number leaves out beyond income and one-offs (listed below):
  // the other items' parts in these years.
  const life = compileItems(plan.items, ages.map((x, i) => (MONEY_KINDS.includes(plan.items[i].kind) ? null : x)), at, { planInWalk: false }).sim;
  const counted = life.oneOffs.some((o) => o.year < years) || life.income.some((s) => s.fromYear < years) || life.lowerSpending.some((l) => l.fromYear < years);
  const whole = f.detail !== null && 'whole' in f.detail ? f.detail.whole : null;
  let steady: ReturnType<typeof steadyRun>;
  try {
    steady = whole ? drawnBalances(whole) : steadyRun(sim, plan.realReturn);
  } catch (e) {
    // The figures are worked out in the Plan's render: a plan the engine
    // refuses leaves the years after the stop out, never the tab.
    if (e instanceof RangeError) return null;
    throw e;
  }
  const items: LeftOutItem[] = [];
  for (const [i, x] of plan.items.entries()) {
    const placed = ages[i];
    if (placed === null) continue;
    if (x.kind === 'one-off') {
      if (placed.start >= d && placed.start < endAge) items.push({ label: x.label, age: placed.start, kind: 'expense' });
    } else if (MONEY_KINDS.includes(x.kind) && INCOME_KINDS.includes(x.kind) && (placed.end === null || placed.end > d)) {
      const age = Math.max(placed.start, d);
      if (age < endAge) items.push({ label: x.label, age, kind: 'income' });
    }
  }
  items.sort((a, b) => a.age - b.age);
  return {
    points: steady.balances.map((balance, k) => ({ age: d + k, balance })),
    endAge,
    runsOutAt: steady.failedYear === null ? null : d + steady.failedYear,
    leftOut: { items, events: counted || lasting !== (f.retirement?.lasting ?? 0) },
    withEvents: counted || lasting !== 0,
  };
}
