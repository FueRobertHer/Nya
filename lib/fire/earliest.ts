// lib/fire/earliest.ts
//
// D9: the earliest stop that lasts. For a plan with `lastsIn` (lib/fire/plan-v2.ts),
// its answer is the earliest whole age at which stopping lasts in at least that share
// of Will it last?'s starts, by the plan's own method, in place of the age the walk
// reaches the FI number (decision 25).
//
// A stop at k is the plan with FI at k, the stop at k (so what is timed on either
// starts there) and Will it last? starting from what the steady path has then (D11's
// start): the only start that changes with the stop. It lasts when its share of
// starts that last reaches `lastsIn`. Each candidate settles its own tax and health
// in the FI number, as a search's candidates do.
//
// The search assumes a later stop never lasts less. It halves the ages from today's
// to PLAN_TO_AGE on the grid's sample (lib/fire/simulate.ts successGrid: every sixth
// start or TAXED_GRID_RUNS runs in the detailed model, every start in the flat one),
// then runs the age found in full, a year later at a time while it falls short, and
// the year before in full where its sample comes within SAMPLE_MARGIN of the share,
// a year earlier at a time while one lasts. So the age said is one whose full run
// lasts, and the year before's full run doesn't, or wasn't close. A stop with
// nothing to draw (the walk runs out before it, or has nothing there) doesn't last.
//
// Runs in the simulator's worker (lib/fire/jobs.ts), which holds the market history.

import type { Count } from './compile';
import type { Market } from './market';
import { PLAN_TO_AGE, type Measured, type Missing } from './plan';
import type { DetailWork } from './plan-detail';
import { planFigures, type FiguresRefused } from './plan-figures';
import type { FirePlanV2 } from './plan-v2';
import { simulate, successGrid, type Method, type MonteCarloOptions, type SimPlan } from './simulate';
import type { Resolution } from './steady';

/** How far under the share a year's sample can be and still be run in full: the
 *  sample came within 1.5 points of the full run at every stop of the prototype
 *  household (couple 41 and 40, detailed, 2026 law). */
export const SAMPLE_MARGIN = 0.03;

export type EarliestAnswer = {
  /** The earliest whole age a stop lasts at; null: none by PLAN_TO_AGE. */
  age: number | null;
  /** The plan's own resolution with FI there, for planFigures (`resolved`). */
  resolution: Resolution;
  /** The full run's share of starts that last at `age`; null with none. */
  share: number | null;
  /** The age the run from `age` (or, with none, from PLAN_TO_AGE) lasts to. */
  to: number | null;
};

export type EarliestInput = { plan: FirePlanV2; measured: Measured; count: Count; detailed: DetailWork | null; method: Method };

type Candidate = { sim: SimPlan; rate: number | null } | { missing: Missing };

/** The earliest stop that lasts, or the plan's figures refused, or why it can't be
 *  worked out (a stop the engine can't run). */
export function earliestStop({ plan, measured, count, detailed, method }: EarliestInput, market: Market, opts: MonteCarloOptions = {}): EarliestAnswer | FiguresRefused | { error: string } {
  const share = plan.lastsIn;
  if (share === undefined) return { error: 'the plan has no share to last in' };
  if (plan.age === null) return { error: 'the plan has no age' };
  const lo = Math.ceil(plan.age);
  const hi = Math.max(PLAN_TO_AGE, lo);
  const stopping = { ...plan, stopAtFi: true, start: 'at-stop' as const };

  const candidates = new Map<number, Candidate | FiguresRefused>();
  const candidate = (k: number) => {
    let c = candidates.get(k);
    if (c === undefined) {
      const f = planFigures(stopping, measured, { count, detailed, fiAt: k });
      c = 'refused' in f ? f : 'sim' in f.engine ? { sim: f.engine.sim, rate: plan.rule === 'vpw' ? null : f.engine.rate } : { missing: f.engine.missing };
      candidates.set(k, c);
    }
    return c;
  };
  class Stop extends Error {
    constructor(readonly answer: FiguresRefused | { error: string }) {
      super('stop');
    }
  }
  /** The run from a stop at k; null when there is nothing to draw then, a stop
   *  that can't last. */
  const run = (k: number) => {
    const c = candidate(k);
    if ('refused' in c) throw new Stop(c);
    if ('missing' in c) {
      if (c.missing === 'stop-balance') return null;
      throw new Stop({ error: `a stop at ${k} can't be simulated without ${c.missing}` });
    }
    return c;
  };
  const sampled = new Map<number, number>();
  const sample = (k: number) => {
    let s = sampled.get(k);
    if (s === undefined) {
      const r = run(k);
      if (r === null) s = 0;
      else {
        const [cell] = successGrid(method, r.sim, market, r.rate === null ? [] : [r.rate], [r.sim.years], opts);
        if (!cell) throw new Stop({ error: 'no cell for that rate' });
        s = cell.successRate;
      }
      sampled.set(k, s);
    }
    return s;
  };
  const fulls = new Map<number, number>();
  const full = (k: number) => {
    let s = fulls.get(k);
    if (s === undefined) {
      const r = run(k);
      s = r === null ? 0 : simulate(method, r.sim, market, opts).successRate;
      fulls.set(k, s);
    }
    return s;
  };
  const endOf = (k: number) => {
    const c = candidate(k);
    return 'sim' in c ? k + c.sim.years : null;
  };

  let found: number | null;
  try {
    found = null;
    if (sample(hi) >= share || (sample(hi) >= share - SAMPLE_MARGIN && full(hi) >= share)) {
      let a = lo;
      let b = hi;
      while (a < b) {
        const m = Math.floor((a + b) / 2);
        if (sample(m) >= share) b = m;
        else a = m + 1;
      }
      let k = a;
      while (full(k) < share && k < hi) k++;
      if (full(k) >= share) {
        while (k > lo && sample(k - 1) >= share - SAMPLE_MARGIN && full(k - 1) >= share) k--;
        found = k;
      }
    }
  } catch (err) {
    if (err instanceof Stop) return err.answer;
    throw err;
  }
  const own = planFigures(plan, measured, { count, detailed, fiAt: found });
  if ('refused' in own) return own;
  return { age: found, resolution: own.resolution, share: found === null ? null : full(found), to: endOf(found ?? hi) };
}
