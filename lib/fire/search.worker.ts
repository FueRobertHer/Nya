// lib/fire/search.worker.ts
//
// A detailed plan's search in a Web Worker, so its drawdowns never freeze the page, and
// Tune to a goal's settings in a second thread of the same script.
// Started by components/plan-search.ts with new Worker(new URL(...)), which Next's
// bundler turns into a chunk of its own, apart from the simulator's: this one has
// no market history in it (test/plan-search.test.ts). Each message is one job
// (lib/fire/search-job.ts, lib/fire/tune-job.ts); each answer carries the job's id.

import { runSearchJob, type SearchJob, type SearchResult } from './search-job';
import { runTuneJob, type TuneJob, type TuneResult } from './tune-job';

// The page's TypeScript setup knows the DOM, not a worker's scope: the two members
// used here are typed by hand.
const scope = self as unknown as {
  onmessage: ((e: MessageEvent<{ id: number; job: SearchJob | TuneJob }>) => void) | null;
  postMessage(reply: { id: number; result: SearchResult | TuneResult }): void;
};

scope.onmessage = (e) => {
  const { id, job } = e.data;
  scope.postMessage({ id, result: 'tune' in job ? runTuneJob(job) : runSearchJob(job) });
};
