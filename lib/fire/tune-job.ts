// lib/fire/tune-job.ts
//
// Tune to a goal's settings as a message (lib/fire/tune.ts): a couple of hundred
// drawdowns, up to a couple of thousand for a fixed amount, so they run in a Web Worker
// (lib/fire/search.worker.ts), or on the page where a worker can't start
// (components/plan-search.ts). Plain data both ways, as a search's are.

import { planFigures } from './plan-figures';
import { detailWork } from './plan-detail';
import type { SearchJob } from './search-job';
import type { Resolution } from './steady';
import { tuneRuns, type TuneRun } from './tune';

/** `resolved`: the plan's answer where it is the earliest stop that lasts (D9), so
 *  every run holds that stop, as Tune holds the plan's stop. */
export type TuneJob = SearchJob & { tune: true; resolved?: Resolution };

export type TuneResult = { ok: true; runs: TuneRun[] } | { ok: false; error: string; unavailable?: true };

export function runTuneJob({ plan, measured, count, detailed, resolved }: TuneJob): TuneResult {
  try {
    const f = planFigures(plan, measured, { count, detailed: detailWork(detailed), ...(resolved ? { resolved } : {}) });
    if ('refused' in f) return { ok: false, error: 'This plan’s figures can’t be worked out.' };
    return { ok: true, runs: tuneRuns(f, detailed) };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
