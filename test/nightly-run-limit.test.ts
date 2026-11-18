import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { FakeRedis, storageMock, testKey } from './fake-redis';

// The one run lock of the nightly jobs (lib/backup.ts takeRunLock, and
// lib/nightly-run-limit.ts for a cron's run): taken by
// every run, from a cron or from Run now, and let go when the run ends, so
// Run now waits only while a run is actually going. Over test/fake-redis.ts.

const fake = new FakeRedis();
mock.module('@/lib/storage', () => storageMock(fake));

const { takeRunLock, runningNow, RUN_LOCK_MS } = await import('@/lib/backup');
const { runAsCron, runWords, CRON_WAIT_MS } = await import('@/lib/nightly-run-limit');
const LOCK = testKey('backups:job-running');

beforeEach(() => fake.reset());

/** Takes the lock, or fails the test. */
async function take(job: 'backup' | 'files', by: 'cron' | 'hand') {
  const taken = await takeRunLock(job, by);
  if (!('lock' in taken)) throw new Error('expected the lock');
  return taken.lock;
}

const quiet = async <T>(run: () => Promise<T>): Promise<T> => {
  const error = console.error;
  console.error = () => {};
  try {
    return await run();
  } finally {
    console.error = error;
  }
};

describe('the nightly jobs’ run lock', () => {
  test('one run at a time, of either job, whoever started it; free again once it ends', async () => {
    expect(await runningNow()).toBeNull();
    const lock = await take('backup', 'cron');
    expect(await runningNow()).toEqual({ job: 'backup', by: 'cron', started: lock.holder.started });
    expect(await takeRunLock('files', 'hand')).toEqual({ busy: { job: 'backup', by: 'cron', started: lock.holder.started } });
    expect(await takeRunLock('backup', 'hand')).toEqual({ busy: lock.holder });
    await lock.release();
    expect(await runningNow()).toBeNull();
    expect('lock' in (await takeRunLock('files', 'hand'))).toBe(true);
  });

  test('expires past the routes’ limit of 300 s, for a run Vercel ended before it could let go', async () => {
    expect(RUN_LOCK_MS).toBeGreaterThan(300_000);
    await take('backup', 'hand');
    expect(await fake.ttl(LOCK)).toBe(RUN_LOCK_MS / 1000);
  });

  test('a run lets go only of its own lock', async () => {
    const first = await take('backup', 'hand');
    // Its lock expired (Vercel ended it), and a cron took the next.
    await fake.del(LOCK);
    const second = await take('files', 'cron');
    await first.release();
    expect(await runningNow()).toEqual(second.holder);
  });

  test('a lock that can’t be read still holds, naming no run', async () => {
    await fake.set(LOCK, 'not json');
    expect(await runningNow()).toBeNull();
    expect(await takeRunLock('backup', 'hand')).toEqual({ busy: null });
    expect(runWords(null)).toBe('another nightly job');
  });

  test('says which run is going', () => {
    expect(runWords({ job: 'backup', by: 'cron', started: '2026-06-15T16:00:00.000Z' })).toBe('the nightly backup (started by its cron)');
    expect(runWords({ job: 'files', by: 'hand', started: '2026-06-15T16:00:00.000Z' })).toBe('the clean-up of receipts and documents (started from the Nightly jobs page)');
  });
});

describe('a cron’s run', () => {
  test('waits half a minute at most, so its run still fits in the routes’ limit', () => {
    expect(CRON_WAIT_MS).toBe(30_000);
  });

  test('runs under the lock, and lets it go however the run ends', async () => {
    let during: unknown = null;
    const ok = await runAsCron('backup', async () => ((during = await runningNow()), { status: 200, body: {} }), async () => {});
    expect(ok.status).toBe(200);
    expect(during).toMatchObject({ job: 'backup', by: 'cron' });
    expect(await runningNow()).toBeNull();
    const failed = await runAsCron('files', async () => ({ status: 500, body: { error: 'listing' } }), async () => {});
    expect(failed).toEqual({ status: 500, body: { error: 'listing' } });
    expect(await runningNow()).toBeNull();
    await expect(runAsCron('backup', async () => Promise.reject(new Error('boom')), async () => {})).rejects.toThrow('boom');
    expect(await runningNow()).toBeNull();
  });

  test('waits for a run already going, then runs, told how long it waited', async () => {
    const hand = await take('backup', 'hand');
    setTimeout(() => void hand.release(), 300);
    let waited = -1;
    const res = await runAsCron('backup', async (ms) => ((waited = ms), { status: 200, body: {} }), async () => {}, 5_000);
    expect(res.status).toBe(200);
    expect(waited).toBeGreaterThanOrEqual(250);
    expect(await runningNow()).toBeNull();
  });

  test('a run still going after the wait: the cron fails, records why, runs nothing, and leaves the other run’s lock alone', async () => {
    const hand = await take('files', 'hand');
    const recorded: string[] = [];
    let ran = false;
    const res = await quiet(() =>
      runAsCron('backup', async () => ((ran = true), { status: 200, body: {} }), async (reason) => void recorded.push(reason), 1_000)
    );
    const reason = 'Not run: the clean-up of receipts and documents (started from the Nightly jobs page) was still going after 1s. Run it again from the Nightly jobs page.';
    expect(res).toEqual({ status: 500, body: { error: reason } });
    expect(recorded).toEqual([reason]);
    expect(ran).toBe(false);
    expect(await runningNow()).toEqual(hand.holder);
  });
});
