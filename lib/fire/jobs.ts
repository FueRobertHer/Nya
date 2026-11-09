// lib/fire/jobs.ts
//
// The simulator's work as messages, so the Plan tab can run it in a Web
// Worker (lib/fire/plan.worker.ts) and keep the page responsive, or on the
// page where a worker can't start (components/plan-runner.ts). Pure: a job
// gives the same answer wherever it runs, and the engine is not changed to
// suit either.
//
// The grid is asked for one cell at a time, so that even on the page each
// task stays short (a 60-year Monte Carlo cell is about 5,000 runs of up to
// 60 years).
//
// A job brings the tax year with it: this file loads in the worker and on demand on
// the page, never in Home's chunk (lib/fire/plan-figures.ts).
//
// D9's earliest stop that lasts (lib/fire/earliest.ts) is a job here too, since it
// runs Will it last? at each stop it tries: it brings the plan and what a detailed
// plan's drawdown runs on, with the law, as a detailed plan's search does.

import type { Count } from './compile';
import { earliestStop, type EarliestAnswer } from './earliest';
import type { Market } from './market';
import type { Measured } from './plan';
import { detailWork, type DetailedInput } from './plan-detail';
import type { FiguresRefused } from './plan-figures';
import type { FirePlanV2 } from './plan-v2';
import { firedAcross, simulate, successGrid, type FiredResult, type GridCell, type Method, type SimPlan, type SimResult } from './simulate';
import { taxedPaths } from './taxed-paths';

export type PlanJob =
  | { kind: 'simulate'; method: Method; plan: SimPlan }
  /** One grid cell: the plan at `rate` (null for a rule without one) for `years`. */
  | { kind: 'grid-cell'; method: Method; plan: SimPlan; rate: number | null; years: number }
  /** Where an item that waits on a run's own balance falls across the runs. */
  | { kind: 'fired'; method: Method; plan: SimPlan; trigger: number; offset: number }
  /** D9: the earliest stop that lasts for a plan with `lastsIn`; `detailed`, null in
   *  the flat model. */
  | EarliestJob;

export type EarliestJob = { kind: 'earliest'; method: Method; plan: FirePlanV2; measured: Measured; count: Count; detailed: DetailedInput | null };

export type PlanJobResult =
  | { ok: true; kind: 'simulate'; result: SimResult }
  | { ok: true; kind: 'grid-cell'; cell: GridCell }
  | { ok: true; kind: 'fired'; fired: FiredResult }
  | { ok: true; kind: 'earliest'; answer: EarliestAnswer | FiguresRefused }
  /** The engine refused the plan; or, with `unavailable`, the job couldn't be
   *  run at all (its code failed to load: offline, say), which says nothing
   *  about the plan. */
  | { ok: false; error: string; unavailable?: true };

/** A job and the id its answer is matched to. */
export type PlanMessage = { id: number; job: PlanJob };
export type PlanReply = { id: number; result: PlanJobResult };

const WITH_TAX = { taxed: taxedPaths };

export function runPlanJob(job: PlanJob, market: Market): PlanJobResult {
  try {
    if (job.kind === 'simulate') return { ok: true, kind: 'simulate', result: simulate(job.method, job.plan, market, WITH_TAX) };
    if (job.kind === 'fired') return { ok: true, kind: 'fired', fired: firedAcross(job.method, job.plan, market, job.trigger, job.offset, WITH_TAX) };
    if (job.kind === 'earliest') {
      const answer = earliestStop({ plan: job.plan, measured: job.measured, count: job.count, detailed: job.detailed ? detailWork(job.detailed) : null, method: job.method }, market, WITH_TAX);
      return 'error' in answer ? { ok: false, error: answer.error } : { ok: true, kind: 'earliest', answer };
    }
    // successGrid gives a rule without a rate one cell per length whatever
    // rates it is given, so a null rate asks for that cell.
    const [cell] = successGrid(job.method, job.plan, market, job.rate === null ? [] : [job.rate], [job.years], WITH_TAX);
    if (!cell) return { ok: false, error: 'no cell for that rate' };
    return { ok: true, kind: 'grid-cell', cell };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
