import { afterEach, beforeEach, describe, expect, mock, setSystemTime, test } from 'bun:test';
import { FakeRedis, storageMock, testKey } from './fake-redis';

// The nightly jobs' run log (lib/backup.ts startRun, logNotRun, recentRuns),
// shown on the Nightly jobs page because Vercel keeps a run's own log about an
// hour: each run written when it starts and when it ends, the last
// RUN_LOG_CAP kept, never failing a run. Over test/fake-redis.ts.

const fake = new FakeRedis();
mock.module('@/lib/storage', () => storageMock(fake));

const { startRun, logNotRun, recentRuns, logReason, takeRunLock, RUN_LOG_CAP, RUN_LOCK_MS, RUN_LOG_LIMIT_MS } = await import('@/lib/backup');
const { runAsCron } = await import('@/lib/nightly-run-limit');
const LOG = testKey('backups:runs');

beforeEach(() => fake.reset());
afterEach(() => setSystemTime());

const quiet = async <T>(run: () => Promise<T>): Promise<T> => {
  const error = console.error;
  console.error = () => {};
  try {
    return await run();
  } finally {
    console.error = error;
  }
};

/** Lets the writes sent without waiting land. */
const settle = () => new Promise((r) => setTimeout(r, 10));

describe('the run log', () => {
  test('a run is there from its start, says where it has got to, and ends saying how it went', async () => {
    const log = await startRun('backup', 'cron', new Date('2026-11-18T16:00:05Z'));
    log.phase('upload');
    await settle();
    let [run] = (await recentRuns(new Date('2026-11-18T16:01:00Z')))!;
    expect(run).toMatchObject({ id: log.id, job: 'backup', by: 'cron', started: '2026-11-18T16:00:05.000Z', ended: null, outcome: 'running', silent: false });
    expect(run.at?.phase).toBe('upload');

    log.step('export', 2100);
    log.step('upload', 812.4);
    log.attempt('read-back', 'The backup’s read-back step took longer than 45s');
    log.step('read-back', 400);
    log.resend();
    log.resend();
    await log.end('worked', null);
    [run] = (await recentRuns())!;
    expect(run).toMatchObject({
      outcome: 'worked',
      reason: null,
      at: null,
      attempts: [{ step: 'read-back', reason: 'The backup’s read-back step took longer than 45s' }],
      steps: [
        ['export', 2100],
        ['upload', 812],
        ['read-back', 400],
      ],
      resends: 2,
    });
    expect(run.ended).not.toBeNull();
    // Its "where it got to" goes with its end.
    expect(Object.keys((await fake.hgetall<Record<string, string>>(LOG)) ?? {})).toEqual([log.id]);
  });

  test('ends once: a second end changes nothing', async () => {
    const log = await startRun('files', 'hand');
    await log.end('failed', 'first');
    await log.end('worked', null);
    expect((await recentRuns())![0]).toMatchObject({ outcome: 'failed', reason: 'first' });
    expect(log.ended).toBe(true);
  });

  test('a run that never ended, once the run lock would have let it go, says so, with where it got to', async () => {
    const log = await startRun('backup', 'cron', new Date('2026-11-18T16:00:00Z'));
    log.phase('keys');
    await settle();
    const before = (await recentRuns(new Date(Date.parse('2026-11-18T16:00:00Z') + RUN_LOCK_MS - 1000)))![0];
    expect(before.silent).toBe(false);
    const after = (await recentRuns(new Date(Date.parse('2026-11-18T16:00:00Z') + RUN_LOCK_MS + 1000)))![0];
    expect(after).toMatchObject({ outcome: 'running', silent: true, at: { phase: 'keys' } });
  });

  test('a cron that didn’t run is there too, with why', async () => {
    await logNotRun('files', 'Not run: the nightly backup (started by its cron) was still going after 30s.');
    expect((await recentRuns())![0]).toMatchObject({ job: 'files', by: 'cron', outcome: 'not-run', reason: 'Not run: the nightly backup (started by its cron) was still going after 30s.' });
  });

  test(`keeps the newest ${RUN_LOG_CAP}, of both jobs, newest first`, async () => {
    const start = Date.parse('2026-10-01T16:00:00Z');
    const ids: string[] = [];
    for (let i = 0; i < RUN_LOG_CAP + 5; i++) {
      const log = await startRun(i % 2 ? 'files' : 'backup', 'cron', new Date(start + i * 3_600_000));
      if (i < 3) log.phase('export');
      await log.end('worked', null);
      ids.push(log.id);
    }
    // One more start trims to the cap again.
    const last = await startRun('backup', 'hand', new Date(start + 100 * 3_600_000));
    ids.push(last.id);
    await settle();
    const runs = (await recentRuns())!;
    expect(runs.map((r) => r.id)).toEqual(ids.slice(-RUN_LOG_CAP).reverse());
    // Nothing of the runs dropped is left behind.
    expect(Object.keys((await fake.hgetall<Record<string, string>>(LOG)) ?? {}).length).toBe(RUN_LOG_CAP);
  });

  test('an entry that can’t be read is left out; a log that can’t be read is null, not empty', async () => {
    await fake.hset(LOG, { 'x.1': 'not json', 'y.1': JSON.stringify({ job: 'other' }) });
    await (await startRun('backup', 'cron')).end('worked', null);
    expect((await recentRuns())!.map((r) => r.outcome)).toEqual(['worked']);
    fake.failNext('hgetall');
    expect(await quiet(() => recentRuns())).toBeNull();
  });

  test('a write that fails never fails the run', async () => {
    fake.failNext('hsetnx');
    const log = await quiet(() => startRun('backup', 'cron'));
    fake.failNext('hset');
    await quiet(() => log.end('worked', null));
    fake.failNext('hset');
    await quiet(() => logNotRun('backup', 'Not run'));
  });

  test(
    'a write that stalls is given up after a few seconds, so the run still ends in time',
    async () => {
      const hset = fake.hset.bind(fake);
      const log = await startRun('backup', 'cron');
      fake.hset = () => new Promise(() => {});
      try {
        const began = Date.now();
        await quiet(() => log.end('worked', null));
        expect(Date.now() - began).toBeLessThan(RUN_LOG_LIMIT_MS + 1000);
      } finally {
        fake.hset = hset;
      }
    },
    RUN_LOG_LIMIT_MS + 5000
  );

  test('a reason keeps no account id and none of the command Upstash names', () => {
    expect(logReason('The map entry of container 0f8fad5b-d9cb-469f-a165-70867728950e kept changing')).toBe('The map entry of container [id] kept changing');
    expect(logReason('UpstashError: ERR wrong type, command was: ["hset","k","secret"]')).toBe('UpstashError: ERR wrong type');
    expect(logReason('x'.repeat(300))).toHaveLength(200);
  });
});

describe('a cron’s run, in the run log', () => {
  test('is started under the lock and ended as the run answers, or as it threw', async () => {
    await runAsCron('backup', async (_waited, log) => {
      log.step('export', 10);
      return { status: 500, body: { error: 'The backup’s export step took longer than 60s' } };
    }, async () => {});
    // A run's id starts with its start time: a later millisecond, a later run.
    await settle();
    await quiet(() => runAsCron('files', async () => Promise.reject(new Error('down')), async () => {}).catch(() => {}));
    await settle();
    await runAsCron('backup', async (_waited, log) => {
      await log.end('worked', null);
      return { status: 200, body: {} };
    }, async () => {});
    const runs = (await recentRuns())!;
    expect(runs.map((r) => [r.job, r.by, r.outcome, r.reason])).toEqual([
      ['backup', 'cron', 'worked', null],
      ['files', 'cron', 'failed', 'down'],
      ['backup', 'cron', 'failed', 'The backup’s export step took longer than 60s'],
    ]);
    expect(runs[2].steps).toEqual([['export', 10]]);
  });

  test('one that found another run going is in the log as not run, and nothing else is', async () => {
    const taken = await takeRunLock('backup', 'hand');
    if (!('lock' in taken)) throw new Error('expected the lock');
    let ran = false;
    await quiet(() => runAsCron('files', async () => ((ran = true), { status: 200, body: {} }), async () => {}, 10));
    await taken.lock.release();
    expect(ran).toBe(false);
    const runs = (await recentRuns())!;
    expect(runs.map((r) => [r.job, r.outcome])).toEqual([['files', 'not-run']]);
    expect(runs[0].reason).toStartWith('Not run: the nightly backup (started from the Nightly jobs page) was still going');
  });
});
