import { describe, expect, test, mock, beforeEach, afterEach } from 'bun:test';
import { FakeRedis, storageMock } from './fake-redis';

process.env.PLAID_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');

const fake = new FakeRedis({ deserialize: true });
mock.module('@/lib/storage', () => storageMock(fake));

const { registryKey, ContainerError } = await import('@/lib/containers');
const { kc } = await import('@/lib/storage');
const { runSnapshots, readRegistry, readRuns, readRun, reasonOf, nothingSucceeded, REGISTRY_RETRY_MS, LOCK_SECONDS } = await import('@/lib/snapshot-job');
const { forgetEpochs } = await import('@/lib/sessions');
const runsRoute = await import('@/app/api/snapshot-runs/route');
const { withRateLimitRetry, isRateLimited } = await import('@/lib/rate-limit-retry');

type Id = Parameters<typeof readRuns>[0]['container'];
const DATE = '2026-09-25';
const ids = Array.from({ length: 5 }, () => crypto.randomUUID() as Id);
const [A, B, C] = ids;

async function register(entries: [Id, string][]) {
  for (const [id, status] of entries) {
    await fake.hset(registryKey(), { [id]: JSON.stringify({ status, primary: id === A, created_at: `2026-01-0${ids.indexOf(id) + 1}` }) });
  }
  return readRegistry();
}

const saved = { ...process.env };
const errors = console.error;
beforeEach(() => {
  fake.reset();
  forgetEpochs();
  delete process.env.CONTAINER_ID;
  console.error = () => {};
});
afterEach(() => {
  process.env = { ...saved };
  console.error = errors;
});

describe('once the data is in containers', () => {
  test('one container failing costs the others nothing, and each outcome is kept', async () => {
    const registry = await register([[A, 'active'], [B, 'active'], [C, 'active']]);
    const report = await runSnapshots(registry, {
      scheduledFor: DATE,
      scopedData: true,
      work: async (ctx) => {
        if (ctx.container === A) throw new Error('Plaid is down');
        return ctx.container === B ? { status: 'recorded' } : { status: 'unclean', reason: 'Not every account could be read.' };
      },
    });
    expect(report.failed).toBe(1);
    expect(report.results.map((r) => [r.container, r.status])).toEqual([
      [A, 'failed'],
      [B, 'recorded'],
      [C, 'unclean'],
    ]);
    expect((report.results[0] as any).reason).toBe('Error: Plaid is down');
    expect((await readRun({ container: A }, DATE))?.status).toBe('failed');
    expect((await readRun({ container: B }, DATE))?.status).toBe('recorded');
    expect((await readRun({ container: C }, DATE))?.reason).toBe('Not every account could be read.');
  });

  test('a container recorded for the date is not run again; the others are', async () => {
    const registry = await register([[A, 'active'], [B, 'active']]);
    const ran: string[] = [];
    const work = async (ctx: { container: Id }) => {
      ran.push(ctx.container);
      return ctx.container === A ? ({ status: 'recorded' } as const) : ({ status: 'failed', reason: 'x' } as const);
    };
    await runSnapshots(registry, { scheduledFor: DATE, scopedData: true, work });
    const again = await runSnapshots(registry, { scheduledFor: DATE, scopedData: true, work });
    expect(again.results.map((r) => r.status)).toEqual(['already', 'failed']);
    expect(ran).toEqual([A, B, B]);
    expect((await readRun({ container: B }, DATE))?.attempts).toBe(2);
    // Another date is its own run.
    await runSnapshots(registry, { scheduledFor: '2026-09-26', scopedData: true, work });
    expect(ran).toEqual([A, B, B, A, B]);
  });

  test('containers that are not active are filtered out before anything is read or written', async () => {
    const registry = await register([[A, 'restoring'], [B, 'archived'], [C, 'active']]);
    const ran: string[] = [];
    const report = await runSnapshots(registry, {
      scheduledFor: DATE,
      scopedData: true,
      work: async (ctx) => (ran.push(ctx.container), { status: 'recorded' }),
    });
    expect(ran).toEqual([C]);
    expect(report.results.slice(0, 2)).toEqual([
      { container: A, status: 'skipped', reason: 'The container is restoring.' },
      { container: B, status: 'skipped', reason: 'The container is archived.' },
    ]);
    expect(await readRuns({ container: A })).toEqual([]);
    expect(await readRuns({ container: B })).toEqual([]);
  });

  test('at most `concurrency` run at once, and every container still runs', async () => {
    const registry = await register(ids.map((id) => [id, 'active'] as [Id, string]));
    let now = 0;
    let max = 0;
    const done: string[] = [];
    await runSnapshots(registry, {
      scheduledFor: DATE,
      scopedData: true,
      concurrency: 2,
      work: async (ctx) => {
        now++;
        max = Math.max(max, now);
        await new Promise((r) => setTimeout(r, 5));
        now--;
        done.push(ctx.container);
        return { status: 'recorded' };
      },
    });
    expect(max).toBe(2);
    expect(done.sort()).toEqual([...ids].sort());
  });

  test('containers not started within the budget are deferred, with nothing written', async () => {
    const registry = await register([[A, 'active'], [B, 'active'], [C, 'active']]);
    let t = 0;
    const report = await runSnapshots(registry, {
      scheduledFor: DATE,
      scopedData: true,
      concurrency: 1,
      budgetMs: 10,
      clock: () => t,
      work: async () => ((t += 20), { status: 'recorded' }),
    });
    expect(report.results.map((r) => r.status)).toEqual(['recorded', 'deferred', 'deferred']);
    // Recorded as deferred, so the day shows why it has no snapshot.
    expect(await readRun({ container: B }, DATE)).toMatchObject({ status: 'deferred', attempts: 0 });
    // The catch-up run does them.
    const later = await runSnapshots(registry, { scheduledFor: DATE, scopedData: true, work: async () => ({ status: 'recorded' }) });
    expect(later.results.map((r) => r.status)).toEqual(['already', 'recorded', 'recorded']);
  });

  test('an outcome that cannot be recorded still reports the run', async () => {
    const registry = await register([[A, 'active']]);
    fake.failNext('hset', 2); // the "running" mark and the outcome
    const report = await runSnapshots(registry, { scheduledFor: DATE, scopedData: true, work: async () => ({ status: 'recorded' }) });
    expect(report.results[0].status).toBe('recorded');
    expect(await readRun({ container: A }, DATE)).toBeNull();
  });

  test('a failed read of the outcome fails that container alone', async () => {
    const registry = await register([[A, 'active'], [B, 'active']]);
    fake.failNext('hget');
    const report = await runSnapshots(registry, {
      scheduledFor: DATE,
      scopedData: true,
      concurrency: 1,
      work: async () => ({ status: 'recorded' }),
    });
    expect(report.results.map((r) => r.status)).toEqual(['failed', 'recorded']);
  });
});

describe('while the data is still unscoped', () => {
  test('only the deployment container runs; another active one is skipped', async () => {
    const registry = await register([[A, 'active'], [B, 'active']]);
    process.env.CONTAINER_ID = B;
    const ran: string[] = [];
    const report = await runSnapshots(registry, { scheduledFor: DATE, work: async (ctx) => (ran.push(ctx.container), { status: 'recorded' }) });
    expect(ran).toEqual([B]);
    expect(report.results[0]).toEqual({ container: A, status: 'skipped', reason: 'Its data is not in containers yet.' });
    expect(await readRuns({ container: A })).toEqual([]);
  });

  test('with CONTAINER_ID unset, the single active container runs', async () => {
    const registry = await register([[A, 'active'], [B, 'archived']]);
    const ran: string[] = [];
    await runSnapshots(registry, { scheduledFor: DATE, work: async (ctx) => (ran.push(ctx.container), { status: 'recorded' }) });
    expect(ran).toEqual([A]);
  });

  test('when the deployment container cannot be worked out, nothing runs and every container fails with why', async () => {
    const registry = await register([[A, 'active'], [B, 'active']]);
    const ran: string[] = [];
    const report = await runSnapshots(registry, { scheduledFor: DATE, work: async (ctx) => (ran.push(ctx.container), { status: 'recorded' }) });
    expect(ran).toEqual([]);
    expect(report.failed).toBe(2);
    expect((report.results[0] as any).reason).toBe('More than one container is active.');
    expect((await readRun({ container: B }, DATE))?.status).toBe('failed');

    process.env.CONTAINER_ID = C; // not in the registry
    const named = await runSnapshots(registry, { scheduledFor: DATE, work: async (ctx) => (ran.push(ctx.container), { status: 'recorded' }) });
    expect(ran).toEqual([]);
    expect((named.results[0] as any).reason).toContain('not in the registry');
  });

  test('a container being restored stops the unscoped run for every container', async () => {
    const registry = await register([[A, 'restoring'], [B, 'active']]);
    const ran: string[] = [];
    const report = await runSnapshots(registry, { scheduledFor: DATE, work: async (ctx) => (ran.push(ctx.container), { status: 'recorded' }) });
    expect(ran).toEqual([]);
    expect(report.results[1]).toMatchObject({ container: B, status: 'failed', reason: 'A container is being restored.' });
    // A lock it never took (another invocation's) is not released.
    await fake.set(kc({ container: B }, 'snapshot:lock'), 'other', { nx: true, ex: LOCK_SECONDS });
    await runSnapshots(registry, { scheduledFor: DATE, work: async () => ({ status: 'recorded' }) });
    expect(await fake.get<string>(kc({ container: B }, 'snapshot:lock'))).toBe('other');
  });

  test('the default snapshot refuses to run once the data is said to be in containers', async () => {
    const registry = await register([[A, 'active'], [B, 'active']]);
    const report = await runSnapshots(registry, { scheduledFor: DATE, scopedData: true });
    expect(report.results.map((r) => r.status)).toEqual(['failed', 'failed']);
    expect((report.results[0] as any).reason).toBe('The snapshot does not read data from containers yet.');
  });

  test('no containers: nothing to do', async () => {
    const report = await runSnapshots(await readRegistry(), { scheduledFor: DATE, work: async () => ({ status: 'recorded' }) });
    expect(report).toEqual({ scheduled_for: DATE, results: [], failed: 0 });
  });
});

describe('runs in progress', () => {
  test('are marked running before the work, so a killed run is visible', async () => {
    const registry = await register([[A, 'active']]);
    let during: unknown = null;
    await runSnapshots(registry, {
      scheduledFor: DATE,
      scopedData: true,
      work: async (ctx) => ((during = await readRun(ctx, DATE)), { status: 'recorded' }),
    });
    expect(during).toMatchObject({ status: 'running', attempts: 1 });
    expect(await readRun({ container: A }, DATE)).toMatchObject({ status: 'recorded', attempts: 1 });
  });

  test('a container another invocation is running is left to it, and its lock is released after', async () => {
    const registry = await register([[A, 'active'], [B, 'active']]);
    const lock = kc({ container: A }, 'snapshot:lock');
    await fake.set(lock, DATE, { nx: true, ex: LOCK_SECONDS });
    const ran: string[] = [];
    const work = async (ctx: { container: Id }) => (ran.push(ctx.container), { status: 'recorded' } as const);
    const report = await runSnapshots(registry, { scheduledFor: DATE, scopedData: true, work });
    expect(report.results.map((r) => r.status)).toEqual(['running', 'recorded']);
    expect(ran).toEqual([B]);
    expect(await fake.get<string>(lock)).toBe(DATE); // not ours to release
    expect(await fake.get(kc({ container: B }, 'snapshot:lock'))).toBeNull();
    expect(await fake.ttl(lock)).toBe(LOCK_SECONDS);
  });

  test('a container whose restore began after the registry was read is not run', async () => {
    const registry = await register([[A, 'active']]);
    await fake.hset(registryKey(), { [A]: JSON.stringify({ status: 'restoring', primary: true, created_at: 'x' }) });
    const ran: string[] = [];
    const report = await runSnapshots(registry, { scheduledFor: DATE, scopedData: true, work: async (ctx) => (ran.push(ctx.container), { status: 'recorded' }) });
    expect(ran).toEqual([]);
    expect(report.results[0]).toMatchObject({ status: 'failed', reason: 'The container is restoring.' });
    expect(await fake.get(kc({ container: A }, 'snapshot:lock'))).toBeNull();
  });

  test('the start budget counts from when the request began', async () => {
    const registry = await register([[A, 'active']]);
    const report = await runSnapshots(registry, {
      scheduledFor: DATE,
      scopedData: true,
      startedAt: 0,
      clock: () => 11,
      budgetMs: 10,
      work: async () => ({ status: 'recorded' }),
    });
    expect(report.results[0].status).toBe('deferred');
  });
});

describe('a run where nothing succeeded', () => {
  const r = (status: string) => ({ container: A, status }) as any;
  test('is every container that ran failing', () => {
    expect(nothingSucceeded({ scheduled_for: DATE, failed: 1, results: [r('failed'), r('skipped'), r('deferred')] })).toBe(true);
    expect(nothingSucceeded({ scheduled_for: DATE, failed: 1, results: [r('failed'), r('recorded')] })).toBe(false);
    expect(nothingSucceeded({ scheduled_for: DATE, failed: 1, results: [r('failed'), r('already')] })).toBe(false);
    expect(nothingSucceeded({ scheduled_for: DATE, failed: 1, results: [r('failed'), r('unclean')] })).toBe(false);
    expect(nothingSucceeded({ scheduled_for: DATE, failed: 1, results: [r('failed'), r('running')] })).toBe(false);
    expect(nothingSucceeded({ scheduled_for: DATE, failed: 0, results: [r('skipped')] })).toBe(false);
  });
});

describe('reading the registry', () => {
  test('an outage is retried once, after a pause', async () => {
    await register([[A, 'active']]);
    const slept: number[] = [];
    fake.failNext('hgetall');
    expect((await readRegistry(async (ms) => void slept.push(ms))).map((c) => c.id)).toEqual([A]);
    expect(slept).toEqual([REGISTRY_RETRY_MS]);

    fake.failNext('hgetall', 2);
    await expect(readRegistry(async () => {})).rejects.toThrow();
  });

  test('a damaged registry is not retried', async () => {
    await fake.hset(registryKey(), { [A]: 'not json' });
    const slept: number[] = [];
    await expect(readRegistry(async (ms) => void slept.push(ms))).rejects.toThrow(ContainerError);
    expect(slept).toEqual([]);
  });
});

describe('the recorded outcomes', () => {
  test('are listed newest first, skipping an unreadable entry, and served for this deployment', async () => {
    await register([[A, 'active']]);
    const key = kc({ container: A }, 'snapshot:runs');
    await fake.hset(key, {
      '2026-09-23': JSON.stringify({ status: 'recorded', at: 'a', attempts: 1 }),
      '2026-09-25': JSON.stringify({ status: 'failed', reason: 'r', at: 'c', attempts: 2 }),
      '2026-09-24': 'junk',
    });
    const want: Awaited<ReturnType<typeof readRuns>> = [
      { date: '2026-09-25', status: 'failed', reason: 'r', at: 'c', attempts: 2 },
      { date: '2026-09-23', status: 'recorded', at: 'a', attempts: 1 },
    ];
    expect(await readRuns({ container: A })).toEqual(want);
    expect(await readRuns({ container: A }, 1)).toEqual(want.slice(0, 1));

    // The container sessions and the job use: here the single active one.
    const res = await runsRoute.GET();
    expect(await res.json()).toEqual({ runs: want });

    process.env.CONTAINER_ID = B; // not in the registry
    forgetEpochs();
    const bad = await runsRoute.GET();
    expect(bad.status).toBe(503);
    expect((await bad.json()).error).toContain('not in the registry');
  });
});

describe('failure reasons', () => {
  test('carry no command arguments', () => {
    expect(reasonOf(new Error('ERR wrong type, command was: ["hget","k","secret"]'))).toBe('Error: ERR wrong type');
    expect(reasonOf(new ContainerError('No container is active.'))).toBe('No container is active.');
    expect(reasonOf({ response: { status: 500 } })).toBe('object');
    expect(reasonOf({ response: { data: { error_code: 'INSTITUTION_DOWN', error_message: 'secret detail' } } })).toBe('Plaid: INSTITUTION_DOWN');
    expect(reasonOf(new Error('x'.repeat(500))).length).toBeLessThan(200);
  });
});

describe('rate limits', () => {
  const limited = { response: { status: 429, data: { error_type: 'RATE_LIMIT_EXCEEDED' } } };

  test('are waited out, twice at most', async () => {
    const slept: number[] = [];
    let calls = 0;
    const call = async () => {
      if (++calls < 3) throw limited;
      return 'ok';
    };
    expect(await withRateLimitRetry(call, [10, 20], async (ms) => void slept.push(ms))).toBe('ok');
    expect(slept).toEqual([10, 20]);

    calls = -10;
    await expect(withRateLimitRetry(call, [10, 20], async () => {})).rejects.toBe(limited);
  });

  test('anything else is thrown at once', async () => {
    const other = { response: { status: 400, data: { error_code: 'ITEM_LOGIN_REQUIRED' } } };
    let calls = 0;
    await expect(
      withRateLimitRetry(
        async () => {
          calls++;
          throw other;
        },
        [10],
        async () => {}
      )
    ).rejects.toBe(other);
    expect(calls).toBe(1);
  });

  test('are recognized by status or by Plaid code', () => {
    expect(isRateLimited({ response: { status: 429 } })).toBe(true);
    expect(isRateLimited({ response: { status: 400, data: { error_code: 'RATE_LIMIT_EXCEEDED' } } })).toBe(true);
    expect(isRateLimited({ response: { status: 400, data: { error_type: 'RATE_LIMIT_EXCEEDED' } } })).toBe(true);
    expect(isRateLimited({ code: 'ECONNABORTED' })).toBe(false);
    expect(isRateLimited(undefined)).toBe(false);
  });
});
