// lib/fire/search-job.ts
//
// A detailed plan's search as a message: every candidate of "stop when I reach FI",
// or of an item on FI, runs its own drawdown when the drawdown can move the answer,
// so it runs in a Web Worker (lib/fire/search.worker.ts), or on the page where a
// worker can't start (components/plan-search.ts). The answer is the resolution
// alone, from which planFigures works the rest out without searching again.
//
// Plain data both ways, and the law comes in the job, so the worker carries the tax
// year but no law tables and no market history.

import type { Measured } from './plan';
import { planFigures, type FiguresRefused } from './plan-figures';
import { detailWork, type DetailedInput } from './plan-detail';
import type { Count } from './compile';
import type { FirePlanV2 } from './plan-v2';
import type { Resolution } from './steady';

export type SearchJob = { plan: FirePlanV2; measured: Measured; count: Count; detailed: DetailedInput };

export type SearchResult =
  | { ok: true; answer: Resolution | FiguresRefused }
  /** It failed; or, with `unavailable`, it couldn't be run at all (its code failed
   *  to load: offline, say), which says nothing about the plan. */
  | { ok: false; error: string; unavailable?: true };

export function runSearchJob({ plan, measured, count, detailed }: SearchJob): SearchResult {
  try {
    const f = planFigures(plan, measured, { count, detailed: detailWork(detailed) });
    return { ok: true, answer: 'refused' in f ? f : f.resolution };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
