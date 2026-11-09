// components/plan-search.ts
//
// One per page: the searches of detailed plans (lib/fire/search-job.ts), shared by
// Home and the Plan, so a tab change costs nothing. A render asks for a job's answer
// by name of who is asking (`slot`: your plan, a copy, a sheet's preview) and gets it,
// or null while it is worked out, and subscribes for when it arrives. The answers are
// kept per job, the last 16. A job nobody is asking for any more is dropped from the
// queue, so a preview typed through ten drafts runs the first and the last, never all.
//
// No React here, so it can be tested on its own.
//
// D9's earliest stop that lasts (lib/fire/earliest.ts) has its own one (planLasting),
// on the simulator's worker, since it runs Will it last? at each stop it tries: one
// per page too, so Home and the Plan ask once, and nothing the Plan tab's own runner
// does (Try again, leaving the tab) stops it.

import type { EarliestJob, PlanJob, PlanJobResult } from '@/lib/fire/jobs';
import type { SearchJob, SearchResult } from '@/lib/fire/search-job';
import type { TuneJob, TuneResult } from '@/lib/fire/tune-job';
import { createPlanRunner, type JobFailure, type WorkerLike } from './plan-runner';

const MAX_KEPT = 16;

export type PlanSearch<J = SearchJob, R extends { ok: boolean } = SearchResult> = {
  /** The job's answer, or null while it is worked out. Safe in a render: a job is
   *  asked for once, whoever and however often asks. */
  answer(slot: string, job: J): R | JobFailure | null;
  /** `slot` no longer asks for anything. */
  drop(slot: string): void;
  /** Asks again for what failed, on the next render. */
  retry(): void;
  subscribe(listener: () => void): () => void;
  /** Moves on each answer, for useSyncExternalStore. */
  version(): number;
};

/** What makes one job another: the law by its year, since the tables are large and
 *  a year holds one set of them. */
export const searchKey = ({ plan, measured, count, detailed }: SearchJob): string => JSON.stringify([plan, measured, count, { ...detailed, law: undefined }]);

/** What makes one earliest stop job another: its method too. */
export const lastingKey = ({ method, plan, measured, count, detailed }: EarliestJob): string => JSON.stringify([method, plan, measured, count, detailed && { ...detailed, law: undefined }]);

export function createPlanSearch<J = SearchJob, R extends { ok: boolean } = SearchResult>(opts: {
  startWorker: () => WorkerLike<R> | null;
  runHere: (job: J) => Promise<R>;
  /** What makes one job another; searchKey by default. */
  key?: (job: J) => string;
}): PlanSearch<J, R> {
  const runner = createPlanRunner<J, R>(opts);
  const keyOf = opts.key ?? ((job: J) => searchKey(job as SearchJob));
  type Kept = { controller: AbortController; result: R | JobFailure | null };
  const kept = new Map<string, Kept>();
  const slots = new Map<string, string>();
  const listeners = new Set<() => void>();
  let version = 0;

  const held = (key: string) => [...slots.values()].includes(key);
  const changed = () => {
    version++;
    for (const listener of [...listeners]) listener();
  };

  /** A job still waiting that nobody asks for any more goes. */
  function letGo(key: string) {
    const entry = kept.get(key);
    if (!entry || entry.result !== null || held(key)) return;
    kept.delete(key);
    entry.controller.abort();
  }

  /** The oldest answers nobody is asking for go first. */
  function trim() {
    for (const [key, entry] of kept) {
      if (kept.size <= MAX_KEPT) return;
      if (held(key)) continue;
      kept.delete(key);
      if (entry.result === null) entry.controller.abort();
    }
  }

  return {
    answer(slot, job) {
      const key = keyOf(job);
      const was = slots.get(slot);
      if (was !== key) {
        slots.set(slot, key);
        if (was !== undefined) letGo(was);
      }
      const hit = kept.get(key);
      if (hit) {
        kept.delete(key);
        kept.set(key, hit);
        return hit.result;
      }
      const entry: Kept = { controller: new AbortController(), result: null };
      kept.set(key, entry);
      trim();
      void runner.run(job, entry.controller.signal).then((result) => {
        if (kept.get(key) !== entry) return;
        entry.result = result;
        changed();
      });
      return null;
    },
    drop(slot) {
      const was = slots.get(slot);
      if (!slots.delete(slot) || was === undefined) return;
      letGo(was);
    },
    retry() {
      for (const [key, entry] of kept) if (entry.result?.ok === false) kept.delete(key);
      changed();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    version: () => version,
  };
}

let shared: PlanSearch | null = null;

/** The page's one. */
export function planSearch(): PlanSearch {
  return (shared ??= createPlanSearch({
    startWorker: () => (typeof Worker === 'undefined' ? null : (new Worker(new URL('../lib/fire/search.worker.ts', import.meta.url)) as unknown as WorkerLike<SearchResult>)),
    runHere: async (job) => {
      const { runSearchJob } = await import('@/lib/fire/search-job');
      return runSearchJob(job);
    },
  }));
}

let sharedLasting: PlanSearch<EarliestJob, PlanJobResult> | null = null;

/** The page's one for D9's earliest stop that lasts: a worker of the simulator's
 *  script (the market history in it), started only by the first plan that asks. */
export function planLasting(): PlanSearch<EarliestJob, PlanJobResult> {
  return (sharedLasting ??= createPlanSearch<EarliestJob, PlanJobResult>({
    startWorker: () => (typeof Worker === 'undefined' ? null : (new Worker(new URL('../lib/fire/plan.worker.ts', import.meta.url)) as unknown as WorkerLike<PlanJobResult>)),
    runHere: async (job: PlanJob) => {
      const [{ runPlanJob }, { usMarket }] = await Promise.all([import('@/lib/fire/jobs'), import('@/lib/fire/us-market')]);
      return runPlanJob(job, usMarket());
    },
    key: lastingKey,
  }));
}

let sharedTune: PlanSearch<TuneJob, TuneResult> | null = null;

/** The page's one for Tune to a goal: a second thread of the same script, started only
 *  by the first Tune, so a tune never waits behind a search or holds one up. */
export function planTune(): PlanSearch<TuneJob, TuneResult> {
  return (sharedTune ??= createPlanSearch<TuneJob, TuneResult>({
    startWorker: () => (typeof Worker === 'undefined' ? null : (new Worker(new URL('../lib/fire/search.worker.ts', import.meta.url)) as unknown as WorkerLike<TuneResult>)),
    runHere: async (job) => {
      const { runTuneJob } = await import('@/lib/fire/tune-job');
      return runTuneJob(job);
    },
    key: (job) => JSON.stringify([searchKey(job), job.resolved ?? null]),
  }));
}
