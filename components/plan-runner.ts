// Runs the Plan tab's simulations (lib/fire/jobs.ts) in a Web Worker
// (lib/fire/plan.worker.ts), so the page stays responsive while 5,000 Monte
// Carlo runs or the grid's cells are worked out.
//
// Where a worker can't be had (none in this browser, or its script failed to
// load: offline before it was ever fetched, say), the same jobs run on the
// page instead, one per task, so the tab still works, just less smoothly.
// Jobs already sent to a worker that fails are run on the page too: none is
// lost, and none is answered twice.
//
// No React here, so the switching can be tested on its own.

import type { PlanJob, PlanJobResult, PlanReply } from '@/lib/fire/jobs';

/** The part of a Worker this uses. */
export type WorkerLike = {
  postMessage(message: unknown): void;
  terminate(): void;
  onmessage: ((e: MessageEvent<PlanReply>) => void) | null;
  onerror: ((e: Event) => void) | null;
};

export type PlanRunner = {
  run(job: PlanJob): Promise<PlanJobResult>;
  /** Stops the worker; jobs still waiting are answered with an error. */
  dispose(): void;
};

export function createPlanRunner(opts: {
  /** Starts the worker, or returns null (or throws) where there is none. */
  startWorker: () => WorkerLike | null;
  /** Runs a job on the page. */
  runHere: (job: PlanJob) => Promise<PlanJobResult>;
}): PlanRunner {
  let worker: WorkerLike | null = null;
  let started = false;
  let broken = false;
  let disposed = false;
  let nextId = 1;
  const waiting = new Map<number, { job: PlanJob; resolve: (r: PlanJobResult) => void }>();
  // On the page, one job per task, in order, so the page can paint between them.
  let queue: Promise<void> = Promise.resolve();

  function runOnPage(job: PlanJob, resolve: (r: PlanJobResult) => void) {
    queue = queue.then(
      () =>
        new Promise<void>((done) => {
          setTimeout(() => {
            if (disposed) {
              resolve({ ok: false, error: 'stopped' });
              done();
              return;
            }
            opts
              .runHere(job)
              .catch((err): PlanJobResult => ({ ok: false, error: err instanceof Error ? err.message : String(err) }))
              .then(resolve)
              .finally(done);
          }, 0);
        })
    );
  }

  function fail() {
    if (broken) return;
    broken = true;
    try {
      worker?.terminate();
    } catch {
      // Already gone.
    }
    worker = null;
    const stranded = [...waiting.values()];
    waiting.clear();
    for (const w of stranded) runOnPage(w.job, w.resolve);
  }

  function ensureWorker(): WorkerLike | null {
    if (!started) {
      started = true;
      try {
        worker = opts.startWorker();
      } catch {
        worker = null;
      }
      if (!worker) {
        broken = true;
      } else {
        worker.onmessage = (e) => {
          const entry = waiting.get(e.data?.id);
          if (!entry) return;
          waiting.delete(e.data.id);
          entry.resolve(e.data.result);
        };
        worker.onerror = () => fail();
      }
    }
    return broken ? null : worker;
  }

  return {
    run(job) {
      return new Promise<PlanJobResult>((resolve) => {
        if (disposed) {
          resolve({ ok: false, error: 'stopped' });
          return;
        }
        const w = ensureWorker();
        if (!w) {
          runOnPage(job, resolve);
          return;
        }
        const id = nextId++;
        waiting.set(id, { job, resolve });
        try {
          w.postMessage({ id, job });
        } catch {
          // A job that can't be sent (the worker died between messages).
          fail();
        }
      });
    },
    dispose() {
      disposed = true;
      try {
        worker?.terminate();
      } catch {
        // Already gone.
      }
      worker = null;
      for (const w of waiting.values()) w.resolve({ ok: false, error: 'stopped' });
      waiting.clear();
    },
  };
}
