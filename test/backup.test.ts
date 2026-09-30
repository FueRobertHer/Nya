import { describe, expect, test, mock, beforeEach, afterEach } from 'bun:test';
import { FakeRedis, storageMock, testKey } from './fake-redis';

const fake = new FakeRedis();
mock.module('@/lib/storage', () => storageMock(fake));

// Vercel Blob, kept in memory, recording how it was called.
type Stored = { body: string; uploadedAt: Date; options: any };
const blobs = new Map<string, Stored>();
let clock = new Date('2026-06-15T16:00:00.000Z');
let corruptReads = false;
/** The one blob whose reads deliver headers and then no body. */
let stallPath: string | null = null;
let blobUrl = 'https://store.blob.vercel-storage.com/x';
/** The headers the last read was sent with. */
let readHeaders: Record<string, string> | undefined;
/** The abortSignal each call was last given. */
const signals: Record<string, AbortSignal | undefined> = {};
mock.module('@vercel/blob', () => ({
  put: async (pathname: string, body: string, options: any) => {
    signals.put = options.abortSignal;
    if (blobs.has(pathname) && !options.allowOverwrite) throw new Error('exists');
    blobs.set(pathname, { body, uploadedAt: clock, options });
    return { pathname, url: `https://blob/${pathname}` };
  },
  get: async (pathname: string, options: any) => {
    signals.get = options.abortSignal;
    readHeaders = options.headers;
    const b = blobs.get(pathname);
    if (!b || options.access !== 'private') return null;
    const text = corruptReads ? b.body.slice(0, -2) + '\n' : b.body;
    // A stalled read: the response arrives and its body never sends a byte.
    const stream = pathname === stallPath ? new ReadableStream<Uint8Array>() : new Response(text).body;
    return { statusCode: 200, stream, headers: new Headers(), blob: { url: blobUrl } };
  },
  list: async ({ prefix, cursor, abortSignal }: { prefix: string; cursor?: string; abortSignal?: AbortSignal }) => {
    signals.list = abortSignal;
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
  del: async (pathnames: string[], options?: { abortSignal?: AbortSignal }) => {
    signals.del = options?.abortSignal;
    for (const p of pathnames) blobs.delete(p);
  },
}));

const { runBackup, vercelBlobStore, backupFolder, MIN_KEPT, backupProblem, recordOutcome, readBody, nodeText } = await import('@/lib/backup');
const { verifyArchive } = await import('@/lib/restore');
const { GET } = await import('@/app/api/backup/route');

const DAY = 86_400_000;
const saved = { ...process.env };
beforeEach(async () => {
  fake.reset();
  blobs.clear();
  corruptReads = false;
  stallPath = null;
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

  test('reads the copy back uncompressed', async () => {
    await runBackup(fake as any, await store(), clock);
    expect(readHeaders).toEqual({ 'accept-encoding': 'identity' });
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

// Neither Vercel Blob nor Upstash times a request out, and Vercel ends the
// function at maxDuration without running anything after. A read-back that
// never answered left the copy uploaded, nothing pruned, and no outcome.
describe('a step that never answers', () => {
  const never = () => new Promise<never>(() => {});

  /** The real store, with one method replaced by one that hangs, recording
   *  the signal it was given. */
  async function hanging(method: 'put' | 'get' | 'list' | 'del') {
    const real = await store();
    const seen: { signal?: AbortSignal } = {};
    const s = {
      ...real,
      [method]: (...args: any[]) => {
        seen.signal = args.at(-1);
        return never();
      },
    };
    return { s, seen };
  }

  const limits = { export: 1000, upload: 20, 'read-back': 20, list: 20, prune: 20, discard: 20 };

  test('fails the run with the step it was on, and cancels the request', async () => {
    const { s, seen } = await hanging('get');
    await expect(runBackup(fake as any, s, clock, { limits })).rejects.toThrow("backup's read-back step took longer than 0.02s");
    expect(seen.signal?.aborted).toBe(true);
    // The default reason: Vercel Blob stops only on an AbortError, and retries
    // anything else (for many minutes) after the step has already failed.
    expect((seen.signal?.reason as Error).name).toBe('AbortError');
  });

  test('a step that finished is never failed by its report', async () => {
    const onStep = () => {
      throw new Error('logging broke');
    };
    const result = await runBackup(fake as any, await store(), clock, { onStep });
    expect(blobs.has(result.pathname)).toBe(true);
  });

  test('recording the outcome gives up rather than running into maxDuration', async () => {
    const [get, error] = [fake.get, console.error];
    const errors: string[] = [];
    fake.get = () => new Promise<never>(() => {});
    console.error = (...args: unknown[]) => errors.push(args.join(' '));
    try {
      await recordOutcome({ ok: true }, clock, 20);
      expect(errors).toEqual(['Backup outcome not recorded took longer than 0.02s']);
    } finally {
      fake.get = get;
      console.error = error;
    }
  });

  test('a read-back that runs out of time leaves the copy and prunes nothing', async () => {
    process.env.BACKUP_KEEP_DAYS = '1';
    const start = clock.getTime();
    for (let d = 0; d < 10; d++) await runBackup(fake as any, await store(), new Date(start + d * DAY));
    const { s } = await hanging('get');
    await expect(runBackup(fake as any, s, new Date(start + 40 * DAY), { limits })).rejects.toThrow('read-back');
    // The newest few from before plus the unverified copy: had it been
    // trusted, the oldest of those would have been pruned.
    expect(blobs.size).toBe(MIN_KEPT + 1);
  });

  for (const [method, name] of [
    ['put', 'upload'],
    ['list', 'list'],
  ] as const) {
    test(`a ${name} that hangs fails as the ${name} step`, async () => {
      const { s } = await hanging(method);
      await expect(runBackup(fake as any, s, clock, { limits })).rejects.toThrow(`backup's ${name} step`);
    });
  }

  test('a prune that hangs fails as the prune step', async () => {
    process.env.BACKUP_KEEP_DAYS = '1';
    const start = clock.getTime();
    for (let d = 0; d < MIN_KEPT; d++) await runBackup(fake as any, await store(), new Date(start + d * DAY));
    const { s } = await hanging('del');
    await expect(runBackup(fake as any, s, new Date(start + 40 * DAY), { limits })).rejects.toThrow("backup's prune step");
  });

  test('a discard that hangs still reports the bad read-back', async () => {
    corruptReads = true;
    const { s } = await hanging('del');
    await expect(runBackup(fake as any, s, clock, { limits })).rejects.toThrow('did not read back');
  });

  test('each finished step reports how long it took', async () => {
    const steps: string[] = [];
    await runBackup(fake as any, await store(), clock, { onStep: (step, ms) => (expect(ms).toBeGreaterThanOrEqual(0), steps.push(step)) });
    expect(steps).toEqual(['export', 'upload', 'read-back', 'list']); // nothing old enough to prune
  });

  test('the Vercel Blob store hands each call its signal', async () => {
    const s = await store();
    const signal = new AbortController().signal;
    await s.put('backups/test/x.ndjson', 'body', signal);
    await s.get('backups/test/x.ndjson', signal);
    await s.list('backups/test/', signal);
    await s.del(['backups/test/x.ndjson'], signal);
    expect(signals).toEqual({ put: signal, get: signal, list: signal, del: signal });
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

  test('writes a backup and says what it wrote, step by step', async () => {
    const log = console.log;
    const lines: string[] = [];
    console.log = (...args: unknown[]) => lines.push(args.join(' '));
    try {
      const res = await cron();
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.keys).toBe(2);
      expect(blobs.has(body.pathname)).toBe(true);
      for (const step of ['export', 'upload', 'read-back', 'list']) {
        expect(lines.some((l) => new RegExp(`^Backup ${step} took \\d+\\.\\ds$`).test(l))).toBe(true);
      }
      // The read-back says whether the response or its body was slow.
      expect(lines.some((l) => l.startsWith('Backup read-back response after'))).toBe(true);
      expect(lines.some((l) => l.startsWith('Backup read-back response headers'))).toBe(true);
      expect(lines.some((l) => l.startsWith('Backup read-back body at'))).toBe(true);
      expect(lines.some((l) => l.startsWith('Backup read-back body after'))).toBe(true);
      expect(lines.at(-1)).toStartWith('Backup written');
    } finally {
      console.log = log;
    }
  });

  test('a failure is a 500 with the reason', async () => {
    corruptReads = true;
    const [log, errors] = [console.log, console.error];
    console.log = console.error = () => {};
    try {
      const res = await cron();
      expect(res.status).toBe(500);
      expect((await res.json()).error).toContain('did not read back');
    } finally {
      console.log = log;
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

describe('saying when backups have stopped', () => {
  const quiet = async <T>(fn: () => Promise<T>) => {
    const [log, error] = [console.log, console.error];
    console.log = console.error = () => {};
    try {
      return await fn();
    } finally {
      [console.log, console.error] = [log, error];
    }
  };
  const at = (iso: string) => new Date(iso);

  test('nothing to say before any backup has run, or after one just did', async () => {
    expect(await backupProblem()).toBeNull();
    expect((await quiet(() => cron())).status).toBe(200);
    expect(await backupProblem()).toBeNull();
  });

  test('a failed night is reported with its reason and the last good copy, until one succeeds', async () => {
    await recordOutcome({ ok: true }, at('2026-06-14T16:00:00Z'));
    corruptReads = true;
    await quiet(() => cron());
    const problem = await backupProblem();
    expect(problem!.last_ok).toBe('2026-06-14T16:00:00.000Z');
    expect(problem!.reason).toContain('did not read back');
    corruptReads = false;
    await quiet(() => cron());
    expect(await backupProblem()).toBeNull();
  });

  test('no store connected is reported too', async () => {
    delete process.env.BLOB_READ_WRITE_TOKEN;
    await quiet(() => cron());
    expect((await backupProblem())!.reason).toContain('No blob store');
  });

  test('no success for more than two days is reported, even with no failure recorded', async () => {
    await recordOutcome({ ok: true }, at('2026-06-10T16:00:00Z'));
    expect(await backupProblem(at('2026-06-12T15:00:00Z'))).toBeNull();
    expect(await backupProblem(at('2026-06-12T17:00:00Z'))).toEqual({ last_ok: '2026-06-10T16:00:00.000Z', reason: null });
  });

  test('a status that can’t be read is no notice, and a failed record never fails the backup', async () => {
    fake.failNext('get');
    expect(await backupProblem()).toBeNull();
    fake.failNext('set');
    expect((await quiet(() => cron())).status).toBe(200);
  });

  test('the status is kept out of the backup itself', async () => {
    await recordOutcome({ ok: true }, at('2026-06-14T16:00:00Z'));
    const { pathname } = await runBackup(fake as any, await store(), clock);
    expect(verifyArchive(blobs.get(pathname)!.body).records.map((r) => r.key)).not.toContain('backups:status');
  });
});

describe('reading a backup back', () => {
  const enc = new TextEncoder();
  const streamOf = (chunks: Uint8Array[], then: 'end' | 'hang') =>
    new ReadableStream<Uint8Array>({
      start(c) {
        for (const chunk of chunks) c.enqueue(chunk);
        if (then === 'end') c.close();
      },
    });

  test('a body is read to the end, with progress after each chunk', async () => {
    const seen: [number, number][] = [];
    const text = await readBody(streamOf([enc.encode('ab'), enc.encode('cde')], 'end'), 1000, (b, n) => seen.push([b, n]));
    expect(text).toBe('abcde');
    expect(seen).toEqual([[2, 1], [5, 2]]);
  });

  test('a character split across two chunks still reads as one', async () => {
    const bytes = enc.encode('a€b'); // € is three bytes
    expect(await readBody(streamOf([bytes.slice(0, 2), bytes.slice(2)], 'end'), 1000)).toBe('a€b');
  });

  test('a body that sends nothing is given up on', async () => {
    const started = Date.now();
    expect(await readBody(streamOf([], 'hang'), 30)).toBeNull();
    expect(Date.now() - started).toBeLessThan(1000);
  });

  test('a body that stops part-way is given up on', async () => {
    expect(await readBody(streamOf([enc.encode('ab')], 'hang'), 30)).toBeNull();
  });

  test('node’s client reads a URL, sends the headers, and refuses a failure', async () => {
    const server = Bun.serve({
      port: 0,
      fetch: (req) => (new URL(req.url).pathname === '/ok' ? new Response(`hello ${req.headers.get('x-test')}`) : new Response('no', { status: 404 })),
    });
    try {
      const base = `http://localhost:${server.port}`;
      expect(await nodeText(`${base}/ok`, { 'x-test': 'yes' }, AbortSignal.timeout(2000))).toBe('hello yes');
      await expect(nodeText(`${base}/missing`, {}, AbortSignal.timeout(2000))).rejects.toThrow('status 404');
    } finally {
      await server.stop(true);
    }
  });

  test('a read-back that gets no data fails with a reason, and sends the token nowhere but Vercel Blob', async () => {
    stallPath = `${backupFolder()}nya-${clock.toISOString().replace(/[:.]/g, '-')}.ndjson`;
    blobUrl = 'https://example.com/x';
    const log = console.log;
    const lines: string[] = [];
    console.log = (...args: unknown[]) => lines.push(args.join(' '));
    try {
      const s = (await vercelBlobStore(30))!;
      await expect(runBackup(fake as any, s, clock)).rejects.toThrow('is not a Vercel Blob URL');
      expect(lines.some((l) => l.startsWith('Backup read-back body stalled'))).toBe(true);
      expect(lines.some((l) => l.includes('no older copy to compare with'))).toBe(true);
    } finally {
      console.log = log;
      blobUrl = 'https://store.blob.vercel-storage.com/x';
    }
  });

  test('when the new copy stalls, an older one is read to tell whether any read does', async () => {
    const s = (await vercelBlobStore(30))!;
    const older = await runBackup(fake as any, s, new Date(clock.getTime() - DAY));
    stallPath = `${backupFolder()}nya-${clock.toISOString().replace(/[:.]/g, '-')}.ndjson`;
    const log = console.log;
    const lines: string[] = [];
    console.log = (...args: unknown[]) => lines.push(args.join(' '));
    try {
      await expect(runBackup(fake as any, s, clock)).rejects.toThrow('got no data');
      const probe = lines.find((l) => l.includes('the older copy'))!;
      expect(probe).toContain(older.pathname);
      expect(probe).toContain('read fine');
    } finally {
      console.log = log;
    }
  });
});
