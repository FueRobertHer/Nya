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

import type { SearchJob, SearchResult } from '@/lib/fire/search-job';
import { createPlanRunner, type WorkerLike } from './plan-runner';

const MAX_KEPT = 16;

export type PlanSearch = {
  /** The job's answer, or null while it is worked out. Safe in a render: a job is
   *  asked for once, whoever and however often asks. */
  answer(slot: string, job: SearchJob): SearchResult | null;
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

export function createPlanSearch(opts: { startWorker: () => WorkerLike<SearchResult> | null; runHere: (job: SearchJob) => Promise<SearchResult> }): PlanSearch {
  const runner = createPlanRunner<SearchJob, SearchResult>(opts);
  type Kept = { controller: AbortController; result: SearchResult | null };
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
      const key = searchKey(job);
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
