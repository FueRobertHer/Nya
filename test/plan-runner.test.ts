import { describe, expect, test } from 'bun:test';
import { createPlanRunner, type WorkerLike } from '@/components/plan-runner';
import { runPlanJob, type PlanJob, type PlanJobResult, type PlanMessage } from '@/lib/fire/jobs';
import { historicalCycles, type SimPlan } from '@/lib/fire/simulate';
import { usMarket } from '@/lib/fire/us-market';

const plan: SimPlan = {
  startBalance: 1_000_000,
  years: 30,
  allocation: { stocks: 0.75, bonds: 0.25, cash: 0 },
  rebalance: 'annual',
  fee: 0,
  taxRate: 0,
  rule: { kind: 'constant', rate: 0.04 },
  income: [],
  oneOffs: [],
  cashRealReturn: 0,
};
const job: PlanJob = { kind: 'simulate', method: 'historical', plan };
const here = async (j: PlanJob) => runPlanJob(j, usMarket());

/** A worker that answers on the next tick, or fails when told to. */
class FakeWorker implements WorkerLike {
  onmessage: WorkerLike['onmessage'] = null;
  onerror: WorkerLike['onerror'] = null;
  posted: PlanMessage[] = [];
  terminated = false;
  answer = true;
  postMessage(message: unknown) {
    const m = message as PlanMessage;
    this.posted.push(m);
    if (this.answer) setTimeout(() => this.onmessage?.({ data: { id: m.id, result: runPlanJob(m.job, usMarket()) } } as MessageEvent), 0);
  }
  terminate() {
    this.terminated = true;
  }
  fail() {
    this.onerror?.(new Event('error'));
  }
}

describe('the jobs', () => {
  test('a simulation job gives what the engine gives', () => {
    const r = runPlanJob(job, usMarket());
    expect(r.ok && r.kind === 'simulate' && r.result.successRate).toBe(historicalCycles(plan, usMarket()).successRate);
  });

  test('a grid cell job gives one cell, and a rule without a rate one cell per length', () => {
    const cell = runPlanJob({ kind: 'grid-cell', method: 'historical', plan, rate: 0.05, years: 20 }, usMarket());
    expect(cell.ok && cell.kind === 'grid-cell' && [cell.cell.rate, cell.cell.years]).toEqual([0.05, 20]);
    const vpw = runPlanJob({ kind: 'grid-cell', method: 'historical', plan: { ...plan, rule: { kind: 'vpw', expectedReturn: 0.04 } }, rate: null, years: 30 }, usMarket());
    expect(vpw.ok && vpw.kind === 'grid-cell' && vpw.cell.rate).toBeNull();
  });

  test('a plan the engine refuses is an answer, not a crash', () => {
    expect(runPlanJob({ ...job, plan: { ...plan, years: 0 } }, usMarket())).toEqual({ ok: false, error: 'a plan runs 1 to 60 years' });
  });
});

describe('the runner', () => {
  test('sends jobs to the worker and matches each answer to its job', async () => {
    const worker = new FakeWorker();
    const runner = createPlanRunner({ startWorker: () => worker, runHere: async () => ({ ok: false, error: 'not here' }) });
    const [a, b] = await Promise.all([runner.run(job), runner.run({ ...job, plan: { ...plan, years: 20 } })]);
    expect(worker.posted.map((m) => m.id)).toEqual([1, 2]);
    expect(a.ok && a.kind === 'simulate' && a.result.years).toBe(30);
    expect(b.ok && b.kind === 'simulate' && b.result.years).toBe(20);
  });

  test('without a worker, runs the jobs on the page, one per task', async () => {
    const ran: PlanJob[] = [];
    const runner = createPlanRunner({
      startWorker: () => null,
      runHere: async (j) => {
        ran.push(j);
        return here(j);
      },
    });
    const r = await runner.run(job);
    expect(r.ok).toBe(true);
    expect(ran).toEqual([job]);
    // A worker that can't even be built counts the same.
    const throwing = createPlanRunner({
      startWorker: () => {
        throw new Error('no workers here');
      },
      runHere: here,
    });
    expect((await throwing.run(job)).ok).toBe(true);
  });

  test('a worker that fails hands its waiting jobs to the page, and every later one', async () => {
    const worker = new FakeWorker();
    worker.answer = false; // stuck: never answers
    let onPage = 0;
    const runner = createPlanRunner({
      startWorker: () => worker,
      runHere: async (j) => {
        onPage++;
        return here(j);
      },
    });
    const waiting = runner.run(job);
    worker.fail();
    const r: PlanJobResult = await waiting;
    expect(r.ok).toBe(true);
    expect(worker.terminated).toBe(true);
    expect((await runner.run(job)).ok).toBe(true);
    expect(onPage).toBe(2);
    expect(worker.posted).toHaveLength(1);
  });

  test('a job the page cannot run either is answered as unavailable, not left waiting', async () => {
    const worker = new FakeWorker();
    worker.answer = false;
    const runner = createPlanRunner({
      startWorker: () => worker,
      runHere: async () => {
        throw new Error('Failed to load chunk');
      },
    });
    const waiting = runner.run(job);
    worker.fail();
    expect(await waiting).toEqual({ ok: false, error: 'Failed to load chunk', unavailable: true });
    // A plan the engine refuses is not "unavailable": it would fail anywhere.
    expect(runPlanJob({ ...job, plan: { ...plan, years: 0 } }, usMarket())).not.toHaveProperty('unavailable');
  });

  test('stopping answers waiting jobs, and refuses new ones', async () => {
    const worker = new FakeWorker();
    worker.answer = false;
    const runner = createPlanRunner({ startWorker: () => worker, runHere: here });
    const waiting = runner.run(job);
    runner.dispose();
    expect(await waiting).toEqual({ ok: false, error: 'stopped' });
    expect(await runner.run(job)).toEqual({ ok: false, error: 'stopped' });
    expect(worker.terminated).toBe(true);
  });
});
