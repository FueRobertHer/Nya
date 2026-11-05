// lib/fire/plan-detail.ts
//
// One plan's figures in the detailed tax model: what lib/fire/plan-figures.ts
// asks of it, made once per page (or per plan) from what the page knows
// (components/plan-detailed.ts). It stands apart so that planFigures, which Home
// loads for every plan, loads none of the tax year or the law for a flat one.
//
// THREE DRAWDOWNS:
//   - `start`, from the plan's own start with the mix projected at the start age,
//     scaled to its balance (Year by year, its tax and health, the stress test);
//   - `whole`, from the balance projected at the stop (Whole path's years after
//     the stop, and the milestones that fire on them);
//   - `fiRun`, from the FI number itself, at the stop, whose tax and health go in
//     that number (lib/fire/plan-figures.ts), so the number doesn't move with the
//     plan's start.
// The first two are the same run when they start in the same place, as "at your
// stop age" does.
//
// A start with no mix still runs, as the flat model does: a walk that can't get
// there, or nothing to project from, takes today's shares, or all taxable with no
// accounts to go by, and says so.
//
// Arithmetic only, and nothing that touches storage: the Plan tab runs this in the
// browser.

import type { TaxBucket } from '@/lib/allocation/buckets';
import type { BucketsToday } from './buckets-today';
import { bridgedEngine } from './bridge';
import { compileItems, conditionalFlows, type CompileAt, type CompiledItems } from './compile';
import { runDrawdown, type Drawdown, type DrawdownHealth } from './drawdown';
import type { WalkChanges } from './events';
import { planPath } from './path';
import { planYears, projectFrom, ruleSpec } from './plan';
import type { PlanFigures } from './plan-figures';
import type { FirePlanV2 } from './plan-v2';
import type { Strategy } from './tax/rules';
import { chosenSplit } from './savings-split';
import type { Owner } from './tax-facts';
import type { Filing, StateCode, TaxLaw } from './tax/law/types';
import { mixToday, taxedMix, type MixSlot, type TaxedWalk } from './tax/mix';

/** What the page knows that the plan doesn't say. Plain data, as a search's job
 *  carries it to a worker (lib/fire/search-job.ts). */
export type DetailedInput = {
  calendarYear: number;
  /** Null: not said, and counted as single. */
  filing: Filing | null;
  dependents: readonly { untilAge: number }[];
  rmdAges: Record<Owner, number>;
  buckets: Pick<BucketsToday, 'groups' | 'roth' | 'total'>;
  /** Each bucket's share of a year's savings as chosen; null: measured. */
  savingsSplit: readonly { bucket: TaxBucket; share: number }[] | null;
  share457: Record<Owner, number>;
  inflation: number;
  taxableYield: number;
  health: DrawdownHealth;
  state: StateCode | null;
  /** 0 in a state with no income tax. */
  stateRate: number;
  /** What measured spending already holds of coverage, a year: the years add
   *  coverage themselves. Off measured spending only. */
  paidToday: number;
  /** The plan's order and Roth conversions. */
  strategy: Strategy;
  law: TaxLaw;
  /** The year of the law in use, and whether it is older than this year. */
  lawYear: { year: number; behind: boolean };
};

/** `no-mix`: the start's mix couldn't be projected, so it took today's shares. */
export type DetailNote = 'no-mix';

export type PlanDetail = {
  start: Drawdown;
  /** Your age in `start`'s first year. */
  startAge: number;
  /** Null where there is nothing to draw after the stop. */
  whole: Drawdown | null;
  /** All the tax the walk paid before the stop. */
  walkTax: number;
  law: DetailedInput['lawYear'];
  notes: DetailNote[];
};

/** A drawdown, what it spent, and whether it had to take today's shares. */
export type DetailRun = { drawn: Drawdown; noMix: boolean; spending: number; paid: number };

export type DetailWork = {
  /** What measured spending already holds of coverage. */
  paidToday: number;
  /** The drawdown from the FI number at the stop, whose tax and health are that
   *  number's, or why it couldn't be worked out; null with nothing to draw. It needs
   *  no engine, so a plan whose own start can't run still has a number. */
  fiRun(f: PlanFigures, balance: number): DetailRun | { failed: string } | null;
  /** The drawdown from the plan's own start, as `figures` runs it: what another rule
   *  would come to from there (lib/fire/compare-conversions.ts). Null where it can't run. */
  startRun(f: PlanFigures): Drawdown | null;
  /** The walk with the tax on what its years before the stop have to sell. */
  taxWalk(plan: FirePlanV2, walk: WalkChanges, from: { assets: number; savings: number; years: number }): WalkChanges;
  /** Enough for the path alone, for a search's candidate: `start` isn't to be
   *  read, and is `whole`. */
  forPath(f: PlanFigures): PlanDetail | { failed: string } | null;
  /** What the assembled figures gain: the drawdowns, and the engine to stress. */
  figures(f: PlanFigures, fixed: CompiledItems, at: CompileAt): Pick<PlanFigures, 'detail' | 'engine'>;
};

type Plain = Omit<WalkChanges, 'taxes'>;

const withoutTaxes = ({ moneyIn, costs, spans }: WalkChanges): Plain => ({ moneyIn, costs, spans });

export function detailWork(input: DetailedInput): DetailWork {
  const taxedWalk = (plan: FirePlanV2): TaxedWalk => ({
    today: { age: plan.age as number, partnerAge: plan.partnerAge, calendarYear: input.calendarYear },
    filing: input.filing,
    rmdAges: input.rmdAges,
    share457: input.share457,
    state: input.state,
    stateRate: input.stateRate,
    law: input.law,
    order: input.strategy.order,
  });

  const split = (savings: number) => chosenSplit(input.buckets, savings, input.savingsSplit);

  /** Today's shares, at `balance`. */
  const shares = (balance: number) => mixToday(input.buckets, balance);

  /** What is held in your `age`th year, scaled to `balance`, and whether it had
   *  to take today's shares. */
  function slotsAt(f: PlanFigures, age: number, balance: number): { slots: MixSlot[]; noMix: boolean } {
    const plan = f.plan;
    const from = projectFrom(plan, f.view);
    if (from === null) return { slots: shares(balance), noMix: true };
    const k = age - (plan.age as number);
    const base = mixToday(input.buckets, from.assets);
    const mix = k > 0 ? taxedMix(base, { savings: from.savings, split: split(from.savings), realReturn: plan.realReturn, inflation: input.inflation, walk: withoutTaxes(f.walk), years: k }, taxedWalk(plan)).mix : { slots: base, total: base.reduce((s, x) => s + x.value, 0) };
    if (mix === null || !(mix.total > 0)) return { slots: shares(balance), noMix: true };
    const scale = balance / mix.total;
    return { slots: mix.slots.map((s) => ({ ...s, value: s.value * scale, basis: s.basis * scale, reachable: s.reachable * scale })), noMix: false };
  }

  /** A drawdown from `balance` at `age` to `endAge`, the plan's items where the
   *  figures have them. Null where there is nothing to draw, as afterStop has it
   *  (lib/fire/path.ts). */
  function run(f: PlanFigures, age: number, balance: number, endAge: number): { drawn: Drawdown | { failed: string }; noMix: boolean; spending: number; paid: number } | null {
    const plan = f.plan;
    const spendingNow = f.view.spending.value;
    const years = endAge - age;
    if (plan.age === null || spendingNow === null || !(balance > 0) || years < 1) return null;
    const at: CompileAt = { age: plan.age, startAge: age, stop: age, years, taxRate: plan.taxRate };
    // Only the simulation's parts are read here, so the walk's switch is off.
    const items = compileItems(plan.items, f.resolution.ages, at, { planInWalk: false });
    const lasting = items.lasting.reduce((s, x) => s + x.amount, 0);
    const paid = f.view.spending.source === 'measured' ? input.paidToday : 0;
    const spending = spendingNow + lasting;
    if (spending < 0) return null;
    let placed: ReturnType<typeof slotsAt>;
    try {
      placed = slotsAt(f, age, balance);
    } catch (e) {
      // As runDrawdown says it of its own years, so the flat model carries the plan.
      return { drawn: { failed: e instanceof Error ? e.message : 'The years couldn’t be worked out' }, noMix: false, spending, paid };
    }
    const { slots, noMix } = placed;
    const drawn = runDrawdown({
      startAge: age,
      years,
      today: { age: plan.age, partnerAge: plan.partnerAge, calendarYear: input.calendarYear },
      filing: input.filing,
      dependents: input.dependents,
      rmdAges: input.rmdAges,
      slots,
      share457: input.share457,
      spending: Math.max(0, spending - paid),
      rule: (rate) => ruleSpec(plan, rate),
      realReturn: plan.realReturn,
      inflation: input.inflation,
      taxableYield: input.taxableYield,
      oneOffs: items.sim.oneOffs,
      lower: items.sim.lowerSpending,
      income: items.incomeBy,
      health: input.health,
      state: input.state,
      stateRate: input.stateRate,
      law: input.law,
      strategy: input.strategy,
    });
    return { drawn, noMix, spending, paid };
  }

  /** The walk's balance at the stop: where `whole` starts. */
  function atStop(f: PlanFigures): { age: number; balance: number } | null {
    const from = projectFrom(f.plan, f.view);
    const path = from === null ? null : planPath(f, from.years);
    if (path === null || path.short !== null) return null;
    return path.points[path.points.length - 1];
  }

  const endOf = (f: PlanFigures, startAge: number) => startAge + planYears(f.plan, f.view.stopAge);

  const failedIn = (d: Drawdown | { failed: string }): d is { failed: string } => 'failed' in d;

  return {
    paidToday: input.paidToday,

    fiRun(f, balance) {
      const plan = f.plan;
      if (plan.age === null) return null;
      const s = f.view.stopAge ?? plan.age;
      // To the end the FI number's own plan runs to: from today, an `assets` start
      // would count its years from today, and the number would move with the start.
      const ran = run(f, Math.max(s, plan.age), balance, s + planYears({ ...plan, start: 'fi-number' }, f.view.stopAge));
      if (ran === null) return null;
      return failedIn(ran.drawn) ? ran.drawn : { ...ran, drawn: ran.drawn };
    },

    startRun(f) {
      const { engine, plan } = f;
      if (plan.age === null || !('sim' in engine) || engine.startAge === null) return null;
      const start = run(f, Math.max(engine.startAge, plan.age), engine.sim.startBalance, endOf(f, engine.startAge));
      return start === null || failedIn(start.drawn) ? null : start.drawn;
    },

    taxWalk(plan, walk, from) {
      if (from.years <= 0) return walk;
      try {
        const { taxes } = taxedMix(mixToday(input.buckets, from.assets), { savings: from.savings, split: split(from.savings), realReturn: plan.realReturn, inflation: input.inflation, walk, years: from.years }, taxedWalk(plan));
        return taxes.length > 0 ? { ...walk, taxes } : walk;
      } catch {
        // The drawdown fails on the same input, and says so.
        return walk;
      }
    },

    forPath(f) {
      if (f.plan.age === null || !('sim' in f.engine) || f.engine.startAge === null) return null;
      const stop = atStop(f);
      if (stop === null) return null;
      const whole = run(f, stop.age, stop.balance, endOf(f, f.engine.startAge));
      if (whole === null) return null;
      if (failedIn(whole.drawn)) return whole.drawn;
      return { start: whole.drawn, startAge: stop.age, whole: whole.drawn, walkTax: 0, law: input.lawYear, notes: [] };
    },

    figures(f, fixed, at) {
      const { engine, plan } = f;
      if (plan.age === null || !('sim' in engine) || engine.startAge === null) return { detail: null, engine };
      const first = Math.max(engine.startAge, plan.age);
      const balance = engine.sim.startBalance;
      const end = endOf(f, engine.startAge);
      const start = run(f, first, balance, end);
      if (start === null) return { detail: null, engine };
      if (failedIn(start.drawn)) return { detail: start.drawn, engine };
      const stop = atStop(f);
      const same = stop !== null && stop.age === first && Math.abs(stop.balance - balance) < 0.005;
      const whole = same ? start : stop === null ? null : run(f, stop.age, stop.balance, end);
      if (whole !== null && failedIn(whole.drawn)) return { detail: whole.drawn, engine };
      const detail: PlanDetail = {
        start: start.drawn,
        startAge: first,
        whole: whole === null ? null : (whole.drawn as Drawdown),
        walkTax: (f.walk.taxes ?? []).reduce((s, x) => s + x.amount, 0),
        law: input.lawYear,
        notes: start.noMix ? ['no-mix'] : [],
      };
      const perRun = f.resolution.perRun;
      const conditional = perRun ? conditionalFlows(plan.items, perRun, f.resolution.ages, { ...at, taxRate: start.drawn.t }, true) : undefined;
      return { detail, engine: bridgedEngine(plan, engine, start.drawn, fixed, conditional) };
    },
  };
}
