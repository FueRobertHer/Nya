import { describe, expect, test, mock, beforeEach, afterEach } from 'bun:test';
import { FakeRedis, storageMock, testKey } from './fake-redis';

const fake = new FakeRedis();
mock.module('@/lib/storage', () => storageMock(fake));

// Vercel Blob, kept in memory, recording how it was called.
type Stored = { body: string; uploadedAt: Date; options: any };
const blobs = new Map<string, Stored>();
let clock = new Date('2026-06-15T16:00:00.000Z');
let corruptReads = false;
mock.module('@vercel/blob', () => ({
  put: async (pathname: string, body: string, options: any) => {
    if (blobs.has(pathname) && !options.allowOverwrite) throw new Error('exists');
    blobs.set(pathname, { body, uploadedAt: clock, options });
    return { pathname, url: `https://blob/${pathname}` };
  },
  get: async (pathname: string, options: any) => {
    const b = blobs.get(pathname);
    if (!b || options.access !== 'private') return null;
    const text = corruptReads ? b.body.slice(0, -2) + '\n' : b.body;
    return { statusCode: 200, stream: new Response(text).body, headers: new Headers(), blob: {} };
  },
  list: async ({ prefix, cursor }: { prefix: string; cursor?: string }) => {
    // Two per page, so paging is exercised.
    const all = [...blobs.entries()].filter(([p]) => p.startsWith(prefix)).sort(([a], [b]) => (a < b ? -1 : 1));
    const start = cursor ? Number(cursor) : 0;
    const page = all.slice(start, start + 2);
    return {
      blobs: page.map(([pathname, b]) => ({ pathname, uploadedAt: b.uploadedAt })),
      hasMore: start + 2 < all.length,
      cursor: String(start + 2),
    };
  },
  del: async (pathnames: string[]) => {
    for (const p of pathnames) blobs.delete(p);
  },
}));

const { runBackup, vercelBlobStore, backupFolder, MIN_KEPT } = await import('@/lib/backup');
const { verifyArchive } = await import('@/lib/restore');
const { GET } = await import('@/app/api/backup/route');

const DAY = 86_400_000;
const saved = { ...process.env };
beforeEach(async () => {
  fake.reset();
  blobs.clear();
  corruptReads = false;
  clock = new Date('2026-06-15T16:00:00.000Z');
  process.env.BLOB_READ_WRITE_TOKEN = 'token';
  process.env.CRON_SECRET = 'cron';
  delete process.env.BACKUP_KEEP_DAYS;
  await fake.set(testKey('budgets'), 'ciphertext');
  await fake.hset(testKey('history:net-worth'), { '2026-06-14': 'a', '2026-06-15': 'b' });
});
afterEach(() => {
  process.env = { ...saved };
});

const store = async () => (await vercelBlobStore())!;
const cron = (auth = 'Bearer cron') => GET(new Request('http://x/api/backup', { headers: { authorization: auth } }));

describe('the nightly backup', () => {
  test('writes the export, privately, and it restores', async () => {
    const result = await runBackup(fake as any, await store(), clock);
    expect(result.pathname).toBe(`${backupFolder()}nya-2026-06-15T16-00-00-000Z.ndjson`);
    expect(result.keys).toBe(2);
    const stored = blobs.get(result.pathname)!;
    expect(stored.options).toMatchObject({ access: 'private', addRandomSuffix: false, allowOverwrite: false });
    expect(result.bytes).toBe(Buffer.byteLength(stored.body));
    expect(verifyArchive(stored.body).records.map((r) => r.key)).toEqual(['budgets', 'history:net-worth']);
  });

  test('a copy that doesn’t read back as written is removed and reported', async () => {
    corruptReads = true;
    await expect(runBackup(fake as any, await store(), clock)).rejects.toThrow('did not read back');
    expect(blobs.size).toBe(0);
  });

  test('keeps the days asked for, and never fewer than the newest few', async () => {
    process.env.BACKUP_KEEP_DAYS = '3';
    const s = await store();
    const start = clock.getTime();
    for (let d = 0; d < 12; d++) {
      clock = new Date(start + d * DAY);
      await runBackup(fake as any, s, clock);
    }
    // 12 nightly copies, 3 days kept: the newest MIN_KEPT stay regardless.
    expect(blobs.size).toBe(MIN_KEPT);
    const names = [...blobs.keys()].sort();
    expect(names.at(-1)).toContain('2026-06-26');
    expect(names[0]).toContain(`2026-06-${26 - MIN_KEPT + 1}`);
  });

  test('prunes by age once there are more than the newest few', async () => {
    process.env.BACKUP_KEEP_DAYS = '10';
    const s = await store();
    const start = clock.getTime();
    for (let d = 0; d < 15; d++) {
      clock = new Date(start + d * DAY);
      await runBackup(fake as any, s, clock);
    }
    expect(blobs.size).toBe(11); // today and the 10 days before it
  });

  test('a failed write prunes nothing', async () => {
    const s = await store();
    const start = clock.getTime();
    for (let d = 0; d < 10; d++) {
      clock = new Date(start + d * DAY);
      await runBackup(fake as any, s, clock);
    }
    process.env.BACKUP_KEEP_DAYS = '1';
    corruptReads = true;
    await expect(runBackup(fake as any, s, new Date(start + 40 * DAY))).rejects.toThrow();
    expect(blobs.size).toBe(10);
  });

  test('another environment’s backups are never touched', async () => {
    blobs.set('backups/other/nya-2020-01-01T00-00-00-000Z.ndjson', { body: 'x', uploadedAt: new Date('2020-01-01'), options: {} });
    process.env.BACKUP_KEEP_DAYS = '1';
    const s = await store();
    const start = clock.getTime();
    for (let d = 0; d < MIN_KEPT + 3; d++) await runBackup(fake as any, s, new Date(start + d * DAY));
    expect(blobs.has('backups/other/nya-2020-01-01T00-00-00-000Z.ndjson')).toBe(true);
  });

  test('a bad retention setting fails before anything is written', async () => {
    for (const bad of ['0', '-3', 'thirty', '1.5']) {
      process.env.BACKUP_KEEP_DAYS = bad;
      await expect(runBackup(fake as any, await store(), clock)).rejects.toThrow('BACKUP_KEEP_DAYS');
    }
    expect(blobs.size).toBe(0);
  });

  // A key the format can't carry: restore would refuse the archive, so it
  // is no backup, and nothing old is pruned for it.
  test('an archive restore would refuse is not uploaded', async () => {
    const withList = Object.assign(Object.create(fake), {
      type: async (key: string) => (key === testKey('budgets') ? 'list' : fake.type(key)),
    });
    await expect(runBackup(withList, await store(), clock)).rejects.toThrow('could not carry');
    expect(blobs.size).toBe(0);
  });

  test('an export that can’t be read is not uploaded', async () => {
    fake.failNext('get');
    await expect(runBackup(fake as any, await store(), clock)).rejects.toThrow();
    expect(blobs.size).toBe(0);
  });
});

describe('the backup cron', () => {
  test('refuses without the cron secret', async () => {
    expect((await cron('Bearer nope')).status).toBe(401);
    delete process.env.CRON_SECRET;
    expect((await cron()).status).toBe(401);
    expect(blobs.size).toBe(0);
  });

  test('is a loud 500 with no store connected', async () => {
    delete process.env.BLOB_READ_WRITE_TOKEN;
    const errors = console.error;
    console.error = () => {};
    try {
      const res = await cron();
      expect(res.status).toBe(500);
      expect((await res.json()).error).toContain('BLOB_READ_WRITE_TOKEN');
    } finally {
      console.error = errors;
    }
  });

  test('writes a backup and says what it wrote', async () => {
    const log = console.log;
    console.log = () => {};
    try {
      const res = await cron();
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.keys).toBe(2);
      expect(blobs.has(body.pathname)).toBe(true);
    } finally {
      console.log = log;
    }
  });

  test('a failure is a 500 with the reason', async () => {
    corruptReads = true;
    const errors = console.error;
    console.error = () => {};
    try {
      const res = await cron();
      expect(res.status).toBe(500);
      expect((await res.json()).error).toContain('did not read back');
    } finally {
      console.error = errors;
    }
  });

  test('runs after the snapshot and its catch-up', async () => {
    const crons = (await import('../vercel.json')).default.crons as { path: string; schedule: string }[];
    const hour = (path: string) => Number(crons.find((c) => c.path === path)!.schedule.split(' ')[1]);
    expect(hour('/api/backup')).toBeGreaterThan(hour('/api/snapshot/catchup'));
    expect(hour('/api/backup')).toBeGreaterThan(hour('/api/snapshot'));
  });
});
