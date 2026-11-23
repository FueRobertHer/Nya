// Runs the Plan tab's simulations (lib/fire/jobs.ts) in a Web Worker
// (lib/fire/plan.worker.ts), so the page stays responsive while 5,000 Monte
// Carlo runs or the grid's cells are worked out, and a detailed plan's search
// (lib/fire/search-job.ts) in a worker of its own.
//
// ONE JOB AT A TIME, queued here on the page. A job goes to the worker only
// once the one before it is answered, so a job whose caller has moved on (the
// plan changed again before it ran) is dropped from the queue and never run:
// the tab cancels the jobs of a plan it no longer shows, and the answer for the
// current plan never waits behind a stale batch. Only the one job already
// running finishes; its answer is ignored.
//
// Where a worker can't be had (none in this browser, or its script failed to
// load: offline before it was ever fetched, say), the same queue runs on the
// page instead, one job per task, so the tab still works, just less smoothly.
// A job the worker was running when it failed runs on the page too: none is
// lost, and none is answered twice. If the page can't run them either (the
// engine's code failed to load as well), the answer says the job was
// unavailable, so the tab can say so and offer to try again rather than wait
// for an answer that will never come.
//
// No React here, so the switching can be tested on its own.

import type { PlanJob, PlanJobResult } from '@/lib/fire/jobs';

/** A job's answer when no run answered it. */
export type JobFailure = { ok: false; error: string; unavailable?: true };

/** The part of a Worker this uses. */
export type WorkerLike<R = PlanJobResult> = {
  postMessage(message: unknown): void;
  terminate(): void;
  onmessage: ((e: MessageEvent<{ id: number; result: R }>) => void) | null;
  onerror: ((e: Event) => void) | null;
};

export type PlanRunner<J = PlanJob, R = PlanJobResult> = {
  /** Runs a job after the ones before it. Aborting `signal` while it waits
   *  drops it, answered "cancelled"; once it runs, it finishes. */
  run(job: J, signal?: AbortSignal): Promise<R | JobFailure>;
  /** Stops the worker; jobs running or waiting are answered with an error. */
  dispose(): void;
};

const STOPPED: JobFailure = { ok: false, error: 'stopped' };
const CANCELLED: JobFailure = { ok: false, error: 'cancelled' };

export function createPlanRunner<J = PlanJob, R = PlanJobResult>(opts: {
  /** Starts the worker, or returns null (or throws) where there is none. */
  startWorker: () => WorkerLike<R> | null;
  /** Runs a job on the page. */
  runHere: (job: J) => Promise<R>;
  /** Maximum number of parallel workers to spawn lazily (defaults to 1). */
  concurrency?: number;
}): PlanRunner<J, R> {
  type Answer = R | JobFailure;
  type Entry = { job: J; resolve: (r: Answer) => void; forget: () => void };
  type Slot = { worker: WorkerLike<R>; running: { entry: Entry; id: number } | null };
  let maxWorkers = Math.max(1, Math.floor(opts.concurrency ?? 1));
  const slots: Slot[] = [];
  let broken = false;
  let disposed = false;
  let nextId = 1;
  const queue: Entry[] = [];
  /** The job running on the page when workers are unavailable or failed. */
  let pageRunning: Entry | null = null;

  const settle = (entry: Entry, result: Answer) => {
    entry.forget();
    entry.resolve(result);
  };

  /** Spawns one worker slot if below the pool cap, or returns null. */
  function spawnSlot(): Slot | null {
    if (broken || slots.length >= maxWorkers) return null;
    let w: WorkerLike<R> | null = null;
    try {
      w = opts.startWorker();
    } catch {
      w = null;
    }
    if (!w) {
      if (slots.length === 0) broken = true;
      else maxWorkers = slots.length;
      return null;
    }
    const slot: Slot = { worker: w, running: null };
    w.onmessage = (e) => {
      // An answer for anything but this slot's running job is late: ignored.
      if (!slot.running || e.data?.id !== slot.running.id) return;
      const { entry } = slot.running;
      slot.running = null;
      settle(entry, e.data.result);
      next();
    };
    w.onerror = () => fail();
    slots.push(slot);
    return slot;
  }

  /** Starts the next queued job(s) on idle workers, or one on the page. */
  function next() {
    if (disposed || queue.length === 0) return;
    if (!broken) {
      while (queue.length > 0 && !broken && !disposed) {
        const slot = slots.find((s) => s.running === null) ?? spawnSlot();
        if (!slot) break;
        const entry = queue.shift()!;
        const id = nextId++;
        slot.running = { entry, id };
        try {
          slot.worker.postMessage({ id, job: entry.job });
        } catch {
          fail(); // the worker died between messages
          return;
        }
      }
      if (!broken) return;
    }
    // On the page, one job per task, so the page can paint between jobs.
    if (pageRunning || disposed) return;
    const entry = queue.shift();
    if (!entry) return;
    pageRunning = entry;
    setTimeout(() => {
      if (disposed) return; // dispose() has answered it
      opts
        .runHere(entry.job)
        .catch((err): Answer => ({ ok: false, error: err instanceof Error ? err.message : String(err), unavailable: true }))
        .then((result) => {
          if (disposed) return;
          pageRunning = null;
          settle(entry, result);
          next();
        });
    }, 0);
  }

  /** A worker failed: none are used again, and every in-flight worker job
   *  runs on the page, in order, ahead of the rest. */
  function fail() {
    if (broken) return;
    broken = true;
    const inFlight: { entry: Entry; id: number }[] = [];
    for (const slot of slots.splice(0)) {
      if (slot.running) inFlight.push(slot.running);
      slot.running = null;
      try {
        slot.worker.terminate();
      } catch {
        // Already gone.
      }
    }
    inFlight.sort((a, b) => a.id - b.id);
    if (inFlight.length > 0) queue.unshift(...inFlight.map((x) => x.entry));
    next();
  }

  return {
    run(job, signal) {
      return new Promise<Answer>((resolve) => {
        if (disposed) return resolve(STOPPED);
        if (signal?.aborted) return resolve(CANCELLED);
        const entry: Entry = { job, resolve, forget: () => {} };
        if (signal) {
          // Dropped only while it waits: a running job finishes.
          const onAbort = () => {
            const at = queue.indexOf(entry);
            if (at >= 0) {
              queue.splice(at, 1);
              settle(entry, CANCELLED);
            }
          };
          signal.addEventListener('abort', onAbort);
          entry.forget = () => signal.removeEventListener('abort', onAbort);
        }
        queue.push(entry);
        next();
      });
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const slot of slots.splice(0)) {
        try {
          slot.worker.terminate();
        } catch {
          // Already gone.
        }
        if (slot.running) settle(slot.running.entry, STOPPED);
        slot.running = null;
      }
      if (pageRunning) settle(pageRunning, STOPPED);
      pageRunning = null;
      for (const entry of queue.splice(0)) settle(entry, STOPPED);
    },
  };
}
