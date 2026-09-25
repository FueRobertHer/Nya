import { describe, expect, test, mock, beforeEach, afterEach } from 'bun:test';
import { FakeRedis, storageMock } from './fake-redis';

process.env.PLAID_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');

const fake = new FakeRedis({ deserialize: true });
mock.module('@/lib/storage', () => storageMock(fake));

const { registryKey, ContainerError } = await import('@/lib/containers');
const { kc } = await import('@/lib/storage');
const { runSnapshots, readRegistry, readRuns, readRun, reasonOf, REGISTRY_RETRY_MS } = await import('@/lib/snapshot-job');
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
    expect(await readRun({ container: B }, DATE)).toBeNull();
    // The catch-up run does them.
    const later = await runSnapshots(registry, { scheduledFor: DATE, scopedData: true, work: async () => ({ status: 'recorded' }) });
    expect(later.results.map((r) => r.status)).toEqual(['already', 'recorded', 'recorded']);
  });

  test('an outcome that cannot be recorded still reports the run', async () => {
    const registry = await register([[A, 'active']]);
    fake.failNext('hset');
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

  test('no containers: nothing to do', async () => {
    const report = await runSnapshots(await readRegistry(), { scheduledFor: DATE, work: async () => ({ status: 'recorded' }) });
    expect(report).toEqual({ scheduled_for: DATE, results: [], failed: 0 });
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

    process.env.CONTAINER_ID = A;
    const res = await runsRoute.GET();
    expect(await res.json()).toEqual({ runs: want });

    delete process.env.CONTAINER_ID;
    expect((await runsRoute.GET()).status).toBe(503);
  });
});

describe('failure reasons', () => {
  test('carry no command arguments', () => {
    expect(reasonOf(new Error('ERR wrong type, command was: ["hget","k","secret"]'))).toBe('Error: ERR wrong type');
    expect(reasonOf(new ContainerError('No container is active.'))).toBe('No container is active.');
    expect(reasonOf({ response: { status: 500 } })).toBe('object');
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
