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

import type { Market } from './market';
import { simulate, successGrid, type GridCell, type Method, type SimPlan, type SimResult } from './simulate';

export type PlanJob =
  | { kind: 'simulate'; method: Method; plan: SimPlan }
  /** One grid cell: the plan at `rate` (null for a rule without one) for `years`. */
  | { kind: 'grid-cell'; method: Method; plan: SimPlan; rate: number | null; years: number };

export type PlanJobResult =
  | { ok: true; kind: 'simulate'; result: SimResult }
  | { ok: true; kind: 'grid-cell'; cell: GridCell }
  | { ok: false; error: string };

/** A job and the id its answer is matched to. */
export type PlanMessage = { id: number; job: PlanJob };
export type PlanReply = { id: number; result: PlanJobResult };

export function runPlanJob(job: PlanJob, market: Market): PlanJobResult {
  try {
    if (job.kind === 'simulate') return { ok: true, kind: 'simulate', result: simulate(job.method, job.plan, market) };
    // successGrid gives a rule without a rate one cell per length whatever
    // rates it is given, so a null rate asks for that cell.
    const [cell] = successGrid(job.method, job.plan, market, job.rate === null ? [] : [job.rate], [job.years]);
    if (!cell) return { ok: false, error: 'no cell for that rate' };
    return { ok: true, kind: 'grid-cell', cell };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
