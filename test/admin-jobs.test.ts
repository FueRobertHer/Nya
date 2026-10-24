import { beforeEach, describe, expect, test } from 'bun:test';
import { NextResponse } from 'next/server';
import { mockForFile } from './scoped-mock';

// The route behind the admin's Nightly jobs page (app/api/admin/jobs):
// admin-only, never running a job while its own cron may be, and answering
// with both jobs as they stand (lib/backup.ts nightlyJobs). The
// runs themselves are the crons' (test/backup.test.ts, and the sweep's own
// tests); here they are stood in for.

let admin = true;
let holdUntil: Date | null = null;
const ran: string[] = [];
let answer = { status: 200, body: {} as Record<string, unknown> };
/** What lib/backup.ts nightlyJobs reads, stood in for. */
let jobs: unknown[] = [{ job: 'backup' }, { job: 'files' }];

await mockForFile('@/lib/admin-items', () => ({
  adminCtx: async () => (admin ? { container: 'c1' } : null),
  notAdmin: () => NextResponse.json({ error: 'Not found' }, { status: 404 }),
}));
await mockForFile('@/lib/backup', () => ({
  runNightlyBackup: async () => (ran.push('backup'), answer),
  cronHoldUntil: async () => holdUntil,
  nightlyJobs: async () => jobs,
}));
await mockForFile('@/lib/attachment-sweep', () => ({
  runNightlySweep: async () => (ran.push('files'), answer),
}));

const { GET, POST } = await import('@/app/api/admin/jobs/route');
const post = (body: unknown) => POST(new Request('http://x/api/admin/jobs', { method: 'POST', body: JSON.stringify(body) }));

beforeEach(() => {
  admin = true;
  holdUntil = null;
  ran.length = 0;
  answer = { status: 200, body: {} };
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
    expect((await post({ job: 'files' })).status).toBe(200);
    expect(ran).toEqual(['backup', 'files']);
  });

  test('a run that fails answers 500 with its reason, and the record it left', async () => {
    answer = { status: 500, body: { error: 'The backup’s keys step took longer than 40s' } };
    const res = await post({ job: 'backup' });
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'The backup’s keys step took longer than 40s', jobs });
  });

  test('while its cron may be running: 409, saying when to try, and nothing runs', async () => {
    holdUntil = new Date(Date.now() + 12 * 60_000 - 1000);
    const res = await post({ job: 'files' });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'Its nightly run may still be going. Try again in 12 minutes.', jobs });
    expect(ran).toEqual([]);
  });
});
