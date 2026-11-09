// A detailed plan's search as a job (lib/fire/search-job.ts), in its worker's own
// bundle (lib/fire/search.worker.ts) and asked for by the page's one store
// (components/plan-search.ts): the answer planFigures would find by itself, plain
// data both ways; one run per job, whoever asks; stale jobs dropped from the queue;
// and what each bundle loads.

import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { createPlanSearch, planSearch, planTune, searchKey } from '@/components/plan-search';
import type { WorkerLike } from '@/components/plan-runner';
import type { BucketsToday } from '@/lib/fire/buckets-today';
import type { PlanItem } from '@/lib/fire/items';
import { DEFAULT_PLAN, type Measured } from '@/lib/fire/plan';
import { detailWork, type DetailedInput } from '@/lib/fire/plan-detail';
import { planFigures } from '@/lib/fire/plan-figures';
import { planOf, type FirePlanV2 } from '@/lib/fire/plan-v2';
import { runSearchJob, type SearchJob, type SearchResult } from '@/lib/fire/search-job';
import { lawFor } from '@/lib/fire/tax/law';
import { ON } from './plan-gen';
import { NO_STRATEGY } from '@/lib/fire/tax/rules';
import { runTuneJob, type TuneJob, type TuneResult } from '@/lib/fire/tune-job';

const account = (bucket: string, value: number, basis: number | null = null) => ({ owner: 'you', value, basis, account_id: bucket, bucket, contributions: null });
const group = (bucket: string, ...accounts: ReturnType<typeof account>[]) => ({ bucket, accounts, total: accounts.reduce((s, a) => s + a.value, 0) });
const BUCKETS = {
  groups: [group('taxable', account('taxable', 300_000, 150_000)), group('tax-deferred', account('tax-deferred', 500_000)), group('roth', account('roth', 200_000))],
  roth: [{ owner: 'you', amount: 80_000 }],
  total: 1_000_000,
} as unknown as Pick<BucketsToday, 'groups' | 'roth' | 'total'>;

const detailed: DetailedInput = {
  calendarYear: 2026,
  filing: 'single',
  dependents: [],
  rmdAges: { you: 75, partner: 75 },
  buckets: BUCKETS,
  savingsSplit: null,
  share457: { you: 0, partner: 0 },
  inflation: 0.03,
  taxableYield: 0,
  health: { coverage: { kind: 'other', yearly: 6_000 }, medicareExtra: 0, meetsRule: [], countMedicaid: false, acaLaw: '2026', growth: 0.021, incomeGrowth: 0.011 },
  state: 'CO',
  stateRate: 0.044,
  paidToday: 0,
  strategy: NO_STRATEGY,
  law: lawFor(2026).law,
  lawYear: { year: 2026, behind: false },
};
const at = (amount: number) => ({ anchor: { at: 'balance', amount } as const, offset: 0 });
const milestone: PlanItem = { id: 'm', label: 'Part-time at two million', kind: 'part-time', from: at(2_000_000), until: null, once: null, yearly: 20_000, replaces: null, every: null, times: null, inflationAdjusted: true, owner: 'you', beforeTax: true };
const plan = (over: Partial<FirePlanV2> = {}): FirePlanV2 => ({ ...planOf({ ...DEFAULT_PLAN, age: 45, targetAge: 55, spending: 60_000, savings: 40_000, assets: 1_000_000, realReturn: 0.05, withdrawalRate: 0.04 }), ...over });
const M: Measured = { spending: null, savings: null, assets: null };
const jobFor = (p: FirePlanV2): SearchJob => ({ plan: p, measured: M, count: ON, detailed });
const SEARCHING = plan({ stopAtFi: true, items: [milestone] });

describe('runSearchJob', () => {
  test('its answer is the one planFigures finds, and working the rest from it searches no more', () => {
    const result = runSearchJob(jobFor(SEARCHING));
    if (!result.ok || 'refused' in result.answer) throw new Error(JSON.stringify(result));
    const direct = planFigures(SEARCHING, M, { count: ON, detailed: detailWork(detailed) });
    if ('refused' in direct) throw new Error('refused');
    expect(result.answer).toEqual(direct.resolution);
    expect(result.answer.searched).toBe('stop');
    const from = planFigures(SEARCHING, M, { count: ON, detailed: detailWork(detailed), resolved: result.answer });
    expect(from).toEqual(direct);
  });

  test('a job and its answer are plain data: a worker’s message is the same', () => {
    const job = jobFor(SEARCHING);
    expect(structuredClone(job)).toEqual(job);
    const direct = runSearchJob(job);
    expect(runSearchJob(structuredClone(job))).toEqual(direct);
    expect(structuredClone(direct)).toEqual(direct);
  });

  test('lasting changes under zero: the refusal is its answer', () => {
    const spending: PlanItem = { ...milestone, id: 's', kind: 'spending', from: { anchor: { at: 'age', age: 45 }, offset: 0 }, yearly: -80_000 };
    const result = runSearchJob(jobFor(plan({ items: [spending] })));
    expect(result).toMatchObject({ ok: true, answer: { refused: 'below-zero' } });
  });

  test('what throws is an error, never the job’s end', () => {
    expect(runSearchJob({ ...jobFor(SEARCHING), plan: null as unknown as SearchJob['plan'] })).toMatchObject({ ok: false });
  });
});

/** A worker holding every job until told. */
class Held implements WorkerLike<SearchResult> {
  onmessage: WorkerLike<SearchResult>['onmessage'] = null;
  onerror: WorkerLike<SearchResult>['onerror'] = null;
  posted: { id: number; job: SearchJob }[] = [];
  postMessage(m: unknown) {
    this.posted.push(m as { id: number; job: SearchJob });
  }
  /** Answers the job running now. */
  respond() {
    const m = this.posted[this.posted.length - 1];
    this.onmessage?.({ data: { id: m.id, result: runSearchJob(m.job) } } as MessageEvent);
  }
  terminate() {}
}

const settled = () => new Promise((r) => setTimeout(r, 0));
const small = (targetAge: number) => jobFor(plan({ targetAge }));

describe('the page’s searches', () => {
  const make = () => {
    const worker = new Held();
    const search = createPlanSearch({ startWorker: () => worker, runHere: async () => ({ ok: false, error: 'not here' }) });
    return { worker, search };
  };

  test('asked again it runs once, for anyone who asks, and says so when it’s done', async () => {
    const { worker, search } = make();
    let told = 0;
    search.subscribe(() => told++);
    expect(search.answer('plan', small(55))).toBeNull();
    expect(search.answer('plan', small(55))).toBeNull();
    expect(search.answer('home', small(55))).toBeNull();
    expect(worker.posted).toHaveLength(1);
    const before = search.version();
    worker.respond();
    await settled();
    expect(told).toBe(1);
    expect(search.version()).toBe(before + 1);
    expect(search.answer('plan', small(55))).toMatchObject({ ok: true });
    expect(search.answer('another', small(55))).toMatchObject({ ok: true });
    expect(worker.posted).toHaveLength(1);
  });

  test('a job nobody asks for any more leaves the queue and never runs', async () => {
    const { worker, search } = make();
    search.answer('running', small(50));
    search.answer('preview', small(51));
    search.answer('preview', small(52));
    search.answer('preview', small(53));
    worker.respond();
    await settled();
    expect(worker.posted.map((m) => m.job.plan.targetAge)).toEqual([50, 53]);
  });

  test('one still asked for stays, whoever else moves on', async () => {
    const { worker, search } = make();
    search.answer('running', small(50));
    search.answer('home', small(51));
    search.answer('plan', small(51));
    search.answer('home', small(52));
    worker.respond();
    await settled();
    expect(worker.posted.map((m) => m.job.plan.targetAge)).toEqual([50, 51]);
    search.drop('plan');
    worker.respond();
    await settled();
    expect(worker.posted.map((m) => m.job.plan.targetAge)).toEqual([50, 51, 52]);
  });

  test('the running job’s answer, once nobody asks, is ignored', async () => {
    const { worker, search } = make();
    search.answer('plan', small(50));
    search.drop('plan');
    let told = 0;
    search.subscribe(() => told++);
    worker.respond();
    await settled();
    expect(told).toBe(0);
    search.answer('plan', small(50));
    expect(worker.posted).toHaveLength(2);
  });

  test('the last 16 answers are kept, those nobody asks for going first', async () => {
    const { worker, search } = make();
    for (let i = 0; i < 18; i++) {
      search.answer('one', small(50 + i));
      worker.respond();
      await settled();
    }
    const asked = worker.posted.length;
    expect(search.answer('one', small(67))).toMatchObject({ ok: true });
    expect(search.answer('one', small(52))).toMatchObject({ ok: true });
    expect(worker.posted).toHaveLength(asked);
    expect(search.answer('one', small(50))).toBeNull();
    expect(worker.posted).toHaveLength(asked + 1);
  });

  test('where nothing can run it: it says so, and Try again asks again', async () => {
    let attempts = 0;
    const search = createPlanSearch({
      startWorker: () => null,
      runHere: async () => {
        attempts++;
        if (attempts === 1) throw new Error('the chunk failed to load');
        return { ok: true, answer: { ages: [], why: [], stop: 55, fi: null, searched: 'none' } };
      },
    });
    expect(search.answer('plan', small(55))).toBeNull();
    await settled();
    await settled();
    expect(search.answer('plan', small(55))).toMatchObject({ ok: false, unavailable: true });
    search.retry();
    expect(search.answer('plan', small(55))).toBeNull();
    await settled();
    await settled();
    expect(search.answer('plan', small(55))).toMatchObject({ ok: true });
    expect(attempts).toBe(2);
  });

  test('the key names the law by its year', () => {
    const job = small(55);
    expect(searchKey(job)).toBe(searchKey({ ...job, detailed: { ...detailed, law: structuredClone(detailed.law) } }));
    expect(searchKey(job)).not.toContain('"brackets"');
    expect(searchKey(job)).not.toBe(searchKey({ ...job, detailed: { ...detailed, lawYear: { year: 2027, behind: false } } }));
    expect(searchKey(job)).not.toBe(searchKey({ ...job, measured: { ...M, spending: 50_000 } }));
  });
});

describe('Tune to a goal’s searches', () => {
  const tuneJob = (targetAge: number): TuneJob => ({ tune: true, plan: plan({ targetAge }), measured: M, count: ON, detailed });

  /** A worker holding every job until told, as lib/fire/search.worker.ts answers it. */
  class HeldTune implements WorkerLike<TuneResult> {
    onmessage: WorkerLike<TuneResult>['onmessage'] = null;
    onerror: WorkerLike<TuneResult>['onerror'] = null;
    posted: { id: number; job: TuneJob }[] = [];
    postMessage(m: unknown) {
      this.posted.push(m as { id: number; job: TuneJob });
    }
    respond() {
      const m = this.posted[this.posted.length - 1];
      this.onmessage?.({ data: { id: m.id, result: runTuneJob(m.job) } } as MessageEvent);
    }
    terminate() {}
  }

  test('one run per job, whoever asks, and its answer is the job’s', async () => {
    const worker = new HeldTune();
    const search = createPlanSearch<TuneJob, TuneResult>({ startWorker: () => worker, runHere: async () => ({ ok: false, error: 'not here' }) });
    expect(search.answer('tune', tuneJob(55))).toBeNull();
    expect(search.answer('tune', tuneJob(55))).toBeNull();
    await settled();
    expect(worker.posted.length).toBe(1);
    worker.respond();
    await settled();
    const answer = search.answer('tune', tuneJob(55));
    expect(answer).toEqual(runTuneJob(tuneJob(55)));
    expect(worker.posted.length).toBe(1);
  });

  test('a job nobody asks for any more is dropped from the queue', async () => {
    const worker = new HeldTune();
    const search = createPlanSearch<TuneJob, TuneResult>({ startWorker: () => worker, runHere: async () => ({ ok: false, error: 'not here' }) });
    search.answer('tune', tuneJob(55));
    search.answer('tune', tuneJob(56));
    search.answer('tune', tuneJob(57));
    await settled();
    worker.respond();
    await settled();
    expect(worker.posted.map((m) => m.job.plan.targetAge)).toEqual([55, 57]);
  });

  test('its thread is its own: a tune never waits behind a plan’s search', () => {
    expect(planTune()).toBe(planTune());
    expect(planTune() as unknown).not.toBe(planSearch());
  });

  test('the worker’s script tells the two jobs apart', () => {
    const source = readFileSync(join(import.meta.dir, '..', 'lib/fire/search.worker.ts'), 'utf8');
    expect(source).toContain("'tune' in job");
    expect(source).toContain('runTuneJob');
    expect(source).toContain('runSearchJob');
  });
});

describe('what each loads', () => {
  const ROOT = join(import.meta.dir, '..');
  const transpiler = new Bun.Transpiler({ loader: 'ts' });
  const jsx = new Bun.Transpiler({ loader: 'tsx' });
  const resolveLocal = (from: string, spec: string) => {
    const base = spec.startsWith('@/') ? join(ROOT, spec.slice(2)) : spec.startsWith('.') ? resolve(dirname(from), spec) : null;
    if (!base) return null;
    for (const p of [base, `${base}.ts`, `${base}.tsx`, join(base, 'index.ts')]) if (existsSync(p) && statSync(p).isFile()) return p;
    return null;
  };
  /** Every module `root` loads at run time, types gone as in the bundle, an import()
   *  or a worker left out where `lazy` is false. */
  function reached(root: string): string[] {
    const seen = new Set<string>([join(ROOT, root)]);
    const queue = [...seen];
    while (queue.length) {
      const file = queue.shift()!;
      for (const { path, kind } of (file.endsWith('.tsx') ? jsx : transpiler).scanImports(readFileSync(file, 'utf8'))) {
        if (kind !== 'import-statement') continue;
        const target = resolveLocal(file, path);
        if (target && !seen.has(target)) {
          seen.add(target);
          queue.push(target);
        }
      }
    }
    return [...seen].map((f) => relative(ROOT, f).replaceAll('\\', '/')).sort();
  }

  test('the search’s worker holds no market history and no law tables', () => {
    const files = reached('lib/fire/search.worker.ts');
    expect(files).toContain('lib/fire/tax/year.ts');
    expect(files.filter((f) => /us-market|jobs\.ts|plan\.worker/.test(f))).toEqual([]);
    expect(files.filter((f) => /tax\/law\/(?!types)/.test(f))).toEqual([]);
  });

  test('planFigures, which Home loads for every plan, holds no tax year, no law and no drawdown', () => {
    const files = reached('lib/fire/plan-figures.ts');
    expect(files.filter((f) => /tax\/|drawdown|plan-detail|bridge|search/.test(f))).toEqual([]);
  });

  test('the page’s searches hold none of it until a job asks', () => {
    const files = reached('components/plan-search.ts');
    expect(files).toEqual(['components/plan-runner.ts', 'components/plan-search.ts']);
  });

  test('Home’s FI line, and D9’s flow it loads for a plan with lastsIn, hold no market history and none of the simulator’s jobs', () => {
    for (const root of ['components/FiProgressCard.tsx', 'components/plan-lasting.ts']) {
      expect([root, reached(root).filter((f) => /us-market|jobs\.ts|plan\.worker|earliest/.test(f))]).toEqual([root, []]);
    }
    expect(reached('components/FiProgressCard.tsx')).not.toContain('components/plan-lasting.ts');
  });

  test('the simulator’s worker answers D9’s earliest stop that lasts', () => {
    expect(reached('lib/fire/plan.worker.ts')).toContain('lib/fire/earliest.ts');
  });
});
