// lib/fire/plan.worker.ts
//
// The simulator in a Web Worker, so a Monte Carlo of 5,000 runs or the
// twenty-odd cells of the grid never freeze the page. Started by
// components/plan-runner.ts with new Worker(new URL(...)), which Next's
// bundler turns into a chunk of its own, carrying the engine and the market
// history. Each message is one job (lib/fire/jobs.ts); each answer carries
// the job's id.

import { runPlanJob, type PlanMessage, type PlanReply } from './jobs';
import { usMarket } from './us-market';

// The page's TypeScript setup knows the DOM, not a worker's scope: the two
// members used here are typed by hand.
const scope = self as unknown as {
  onmessage: ((e: MessageEvent<PlanMessage>) => void) | null;
  postMessage(reply: PlanReply): void;
};

scope.onmessage = (e) => {
  scope.postMessage({ id: e.data.id, result: runPlanJob(e.data.job, usMarket()) });
};
