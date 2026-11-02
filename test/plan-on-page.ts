// test/plan-on-page.ts
//
// The Plan view suites' simulations, run on the page rather than in a Worker
// (components/plan-runner.ts falls back to that where a browser has none).
// On the fake clock (fakeClock, test/mini-dom.ts) a worker's answer lands
// whenever its thread is done, in real time, so whether a test saw it would
// vary from run to run; on the page each job is a timer like the rest, and is
// answered in the same order every run. The engine's modules are loaded here
// first, so the first job doesn't wait on the disk either.
//
// lib/fire/plan.worker.ts is still run for real: a test that needs the
// thread puts Worker back with the function this returns, on real timers.

import { afterEach, beforeEach } from 'bun:test';

await Promise.all([import('@/lib/fire/jobs'), import('@/lib/fire/us-market')]);

/** Takes Worker away for each test of the calling file. The function returned
 *  puts it back until the test ends, and returns how many answers its workers
 *  have posted, so a test can tell the thread answered, not the page. */
export function simulateOnPage(): () => () => number {
  const real = globalThis.Worker;
  const g = globalThis as { Worker?: typeof Worker };
  beforeEach(() => void delete g.Worker);
  afterEach(() => void (g.Worker = real));
  return () => {
    let posted = 0;
    g.Worker = class extends real {
      constructor(...args: ConstructorParameters<typeof Worker>) {
        super(...args);
        this.addEventListener('message', () => posted++);
      }
    };
    return () => posted;
  };
}
