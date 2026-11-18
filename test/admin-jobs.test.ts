import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { NextResponse } from 'next/server';
import { mockForFile } from './scoped-mock';
import { FakeRedis, storageMock, TEST_CTX } from './fake-redis';

// The route behind the admin's Nightly jobs page (app/api/admin/jobs):
// admin-only, never running a job while another run is going, and answering
// with both jobs as they stand (lib/backup.ts nightlyJobs). The
// runs themselves are the crons' (test/backup.test.ts, and the sweep's own
// tests); here they are stood in for. The run lock is the real one
// (lib/nightly-run-limit.ts), over test/fake-redis.ts.

const fake = new FakeRedis();
mock.module('@/lib/storage', () => storageMock(fake));

let admin = true;
const ran: string[] = [];
/** The run going while each stood-in run ran. */
const during: unknown[] = [];
let answer: () => Promise<{ status: number; body: Record<string, unknown> }> = async () => ({ status: 200, body: {} });
/** What lib/backup.ts nightlyJobs reads, stood in for. */
let jobs: { job: string; again_at?: string | null }[] = [{ job: 'backup' }, { job: 'files' }];

await mockForFile('@/lib/admin-items', () => ({
  adminCtx: async () => (admin ? TEST_CTX : null),
  notAdmin: () => NextResponse.json({ error: 'Not found' }, { status: 404 }),
}));
// The real run lock, kept in the stand-in for the rest of lib/backup.ts.
const { runningNow, takeRunLock } = await import('@/lib/backup');
const stoodIn = (job: string) => async () => {
  ran.push(job);
  during.push(await runningNow());
  return answer();
};
await mockForFile('@/lib/backup', () => ({
  runningNow,
  takeRunLock,
  runNightlyBackup: stoodIn('backup'),
  nightlyJobs: async () => jobs,
}));
await mockForFile('@/lib/attachment-sweep', () => ({
  runNightlySweep: stoodIn('files'),
}));

const { GET, POST } = await import('@/app/api/admin/jobs/route');
const post = (body: unknown, type = 'application/json') =>
  POST(new Request('http://x/api/admin/jobs', { method: 'POST', headers: { 'content-type': type }, body: JSON.stringify(body) }));
const saved = { ...process.env };

beforeEach(() => {
  fake.reset();
  process.env = { ...saved };
  admin = true;
  ran.length = 0;
  during.length = 0;
  answer = async () => ({ status: 200, body: {} });
  jobs = [{ job: 'backup' }, { job: 'files' }];
});

describe('the nightly jobs route', () => {
  test('anyone but the admin gets a 404, reading or running, and nothing runs', async () => {
    admin = false;
    expect((await GET()).status).toBe(404);
    expect((await post({ job: 'backup' })).status).toBe(404);
    expect(ran).toEqual([]);
  });

  test('only the two jobs', async () => {
    expect((await post({ job: 'snapshot' })).status).toBe(400);
    expect((await post({})).status).toBe(400);
    expect(ran).toEqual([]);
  });

  test('the admin reads both jobs', async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ jobs });
    expect(ran).toEqual([]);
  });

  test('runs the job asked for, and answers both jobs as they now stand', async () => {
    const res = await post({ job: 'backup' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ jobs });
    expect(ran).toEqual(['backup']);
  });

  test('runs under the run lock its cron takes too, and lets it go once the run ends', async () => {
    expect((await post({ job: 'backup' })).status).toBe(200);
    expect(during).toEqual([expect.objectContaining({ job: 'backup', by: 'hand' })]);
    expect(await runningNow()).toBeNull();
  });

  test('while another run is going, of either job, from a cron or here: 409, naming it, and nothing runs', async () => {
    const cron = await takeRunLock('backup', 'cron');
    if (!('lock' in cron)) throw new Error('expected the lock');
    const res = await post({ job: 'files' });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'The nightly backup (started by its cron) is running now. Try again once it finishes.', jobs });
    expect(ran).toEqual([]);
    // The cron's lock is left alone, and once it ends, a run can start.
    expect(await runningNow()).toEqual(cron.lock.holder);
    await cron.lock.release();
    expect((await post({ job: 'files' })).status).toBe(200);
    expect(ran).toEqual(['files']);
  });

  test('a run that failed can be run again at once', async () => {
    const errors = console.error;
    console.error = () => {};
    try {
      answer = async () => ({ status: 500, body: { error: 'The backup’s upload step took longer than 35s' } });
      expect((await post({ job: 'backup' })).status).toBe(500);
      expect((await post({ job: 'backup' })).status).toBe(500);
      // And when one throws, its lock still goes.
      answer = () => Promise.reject(new Error('down'));
      expect((await post({ job: 'backup' })).status).toBe(500);
      expect(await runningNow()).toBeNull();
      answer = async () => ({ status: 200, body: {} });
      expect((await post({ job: 'backup' })).status).toBe(200);
    } finally {
      console.error = errors;
    }
    expect(ran).toEqual(['backup', 'backup', 'backup', 'backup']);
  });

  test('a job that worked a few minutes ago waits: 409, saying when, and nothing runs; the other job doesn’t', async () => {
    jobs = [{ job: 'backup', again_at: new Date(Date.now() + 4 * 60_000 - 1000).toISOString() }, { job: 'files', again_at: null }];
    const res = await post({ job: 'backup' });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'It worked a few minutes ago. Try again in 4 minutes.', jobs });
    expect(ran).toEqual([]);
    expect(await runningNow()).toBeNull();
    expect((await post({ job: 'files' })).status).toBe(200);
    expect(ran).toEqual(['files']);
  });

  test('JSON only, so a form on another site can’t send it', async () => {
    expect((await post({ job: 'backup' }, 'text/plain')).status).toBe(415);
    expect((await post({ job: 'backup' }, 'application/x-www-form-urlencoded')).status).toBe(415);
    expect(ran).toEqual([]);
  });

  test('a run that fails answers 500 with its reason, and the record it left', async () => {
    answer = async () => ({ status: 500, body: { error: 'The backup’s keys step took longer than 40s' } });
    const res = await post({ job: 'backup' });
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'The backup’s keys step took longer than 40s', jobs });
  });
});
