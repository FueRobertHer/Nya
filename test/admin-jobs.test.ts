import { beforeEach, describe, expect, test } from 'bun:test';
import { NextResponse } from 'next/server';
import { mockForFile } from './scoped-mock';

// The route the admin's card runs a nightly job again with
// (app/api/admin/jobs): admin-only, never while the job's own cron may be
// running, and answering with what the dashboard now says of both jobs. The
// runs themselves are the crons' (test/backup.test.ts, and the sweep's own
// tests); here they are stood in for.

let admin = true;
let holdUntil: Date | null = null;
const ran: string[] = [];
let answer = { status: 200, body: {} as Record<string, unknown> };
const problems = { backup: null as unknown, files: null as unknown };

await mockForFile('@/lib/admin-items', () => ({
  adminCtx: async () => (admin ? { container: 'c1' } : null),
  notAdmin: () => NextResponse.json({ error: 'Not found' }, { status: 404 }),
}));
await mockForFile('@/lib/backup', () => ({
  runNightlyBackup: async () => (ran.push('backup'), answer),
  cronHoldUntil: async () => holdUntil,
  backupNotice: async () => problems.backup,
  attachmentSweepProblem: async () => problems.files,
}));
await mockForFile('@/lib/attachment-sweep', () => ({
  runNightlySweep: async () => (ran.push('files'), answer),
}));

const { POST } = await import('@/app/api/admin/jobs/route');
const post = (body: unknown) => POST(new Request('http://x/api/admin/jobs', { method: 'POST', body: JSON.stringify(body) }));

beforeEach(() => {
  admin = true;
  holdUntil = null;
  ran.length = 0;
  answer = { status: 200, body: {} };
  problems.backup = null;
  problems.files = null;
});

describe('running a nightly job again', () => {
  test('anyone but the admin gets a 404, and nothing runs', async () => {
    admin = false;
    expect((await post({ job: 'backup' })).status).toBe(404);
    expect(ran).toEqual([]);
  });

  test('only the two jobs', async () => {
    expect((await post({ job: 'snapshot' })).status).toBe(400);
    expect((await post({})).status).toBe(400);
    expect(ran).toEqual([]);
  });

  test('runs the job asked for, and answers what the dashboard now says of both', async () => {
    problems.files = { last_ok: null, reason: 'listing', held: false };
    const res = await post({ job: 'backup' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ backup_problem: null, attachments_problem: { last_ok: null, reason: 'listing', held: false } });
    expect((await post({ job: 'files' })).status).toBe(200);
    expect(ran).toEqual(['backup', 'files']);
  });

  test('a run that fails answers 500 with its reason, and the record it left', async () => {
    answer = { status: 500, body: { error: 'The backup’s keys step took longer than 40s' } };
    problems.backup = { last_ok: null, reason: 'The backup’s keys step took longer than 40s' };
    const res = await post({ job: 'backup' });
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'The backup’s keys step took longer than 40s', backup_problem: problems.backup, attachments_problem: null });
  });

  test('while its cron may be running: 409, saying when to try, and nothing runs', async () => {
    holdUntil = new Date(Date.now() + 12 * 60_000 - 1000);
    const res = await post({ job: 'files' });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'Its nightly run may still be going. Try again in 12 minutes.' });
    expect(ran).toEqual([]);
  });
});
