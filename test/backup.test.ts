import { describe, expect, test, mock, beforeEach, afterEach } from 'bun:test';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { FakeRedis, storageMock, testKey } from './fake-redis';

const fake = new FakeRedis();
mock.module('@/lib/storage', () => storageMock(fake));

// Vercel Blob, kept in memory, recording how it was called.
type Stored = { body: string; uploadedAt: Date; options: any };
const blobs = new Map<string, Stored>();
let clock = new Date('2026-06-15T16:00:00.000Z');
let corruptReads = false;
/** Reads of a blob's URL never answer, as a stalled connection doesn't. */
let hangReads = false;
/** The host the SDK says a blob lives on. */
let blobHost = 'store.blob.vercel-storage.com';
/** Whether the SDK's own body stream was let go. */
let sdkStreamCancelled = false;
/** The URLs read with node's client, and the headers each was sent. */
const urlReads: { url: string; headers: Record<string, string> }[] = [];
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
    if (!blobs.has(pathname) || options.access !== 'private') return null;
    // As in the deployed function: the response arrives, and its body never
    // sends a byte.
    const stream = new ReadableStream<Uint8Array>({
      cancel() {
        sdkStreamCancelled = true;
      },
    });
    return { statusCode: 200, stream, headers: new Headers(), blob: { url: `https://${blobHost}/${pathname}` } };
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

// node's https client, serving the blobs kept above.
mock.module('node:https', () => ({
  get: (url: string, options: any, cb: (res: any) => void) => {
    urlReads.push({ url, headers: options.headers });
    const req = new EventEmitter();
    if (hangReads) {
      options.signal?.addEventListener('abort', () => req.emit('error', new Error('aborted')));
      return req;
    }
    const b = blobs.get(decodeURIComponent(new URL(url).pathname.slice(1)));
    const res: any = Readable.from(b ? [Buffer.from(corruptReads ? b.body.slice(0, -2) + '\n' : b.body)] : []);
    res.statusCode = b ? 200 : 404;
    res.headers = {};
    queueMicrotask(() => cb(res));
    return req;
  },
}));

const { runBackup, vercelBlobStore, backupFolder, MIN_KEPT, backupProblem, recordOutcome, nodeText, backupRetention } = await import('@/lib/backup');
const { verifyArchive } = await import('@/lib/restore');
const { GET } = await import('@/app/api/backup/route');

const DAY = 86_400_000;
const saved = { ...process.env };
beforeEach(async () => {
  fake.reset();
  blobs.clear();
  corruptReads = false;
  hangReads = false;
  blobHost = 'store.blob.vercel-storage.com';
  sdkStreamCancelled = false;
  urlReads.length = 0;
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

  test('reads the copy back from its URL with node’s client, with the token, uncompressed', async () => {
    const { pathname } = await runBackup(fake as any, await store(), clock);
    expect(urlReads).toEqual([
      {
        url: `https://store.blob.vercel-storage.com/${pathname}?cache=0`,
        headers: { authorization: 'Bearer token', 'accept-encoding': 'identity' },
      },
    ]);
  });

  // In the deployed function the body of the SDK's own read never delivered a
  // byte (Next patches fetch there), so what is compared is not read from it.
  test('never waits on the SDK’s own body, and lets it go', async () => {
    await runBackup(fake as any, await store(), clock);
    expect(sdkStreamCancelled).toBe(true);
  });

  test('sends the token nowhere but Vercel Blob', async () => {
    blobHost = 'example.com';
    await expect(runBackup(fake as any, await store(), clock)).rejects.toThrow('example.com, which is not Vercel Blob');
    expect(urlReads).toEqual([]);
    expect(blobs.size).toBe(1); // unverified, not deleted
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

  test('a read of the URL that never answers fails as the read-back step and leaves the copy', async () => {
    hangReads = true;
    await expect(runBackup(fake as any, await store(), clock, { limits })).rejects.toThrow("backup's read-back step took longer than 0.02s");
    expect(blobs.size).toBe(1);
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

describe('reading a URL with node’s client', () => {
  /** A local server, standing in for the store. */
  async function serve(handler: (req: Request) => Response | Promise<Response>, run: (base: string) => Promise<void>) {
    const server = Bun.serve({ port: 0, fetch: handler });
    try {
      await run(`http://localhost:${server.port}`);
    } finally {
      await server.stop(true);
    }
  }

  test('reads the body, sends the headers, and asks for it uncompressed', async () => {
    await serve(
      (req) => new Response(`${req.headers.get('x-test')} ${req.headers.get('accept-encoding')}`),
      async (base) => {
        expect(await nodeText(`${base}/ok`, { 'x-test': 'yes' }, AbortSignal.timeout(2000))).toBe('yes identity');
        // Whatever the caller asks for, it is never a compressed body.
        expect(await nodeText(`${base}/ok`, { 'x-test': 'yes', 'accept-encoding': 'br' }, AbortSignal.timeout(2000))).toBe('yes identity');
      }
    );
  });

  test('a large body with multi-byte characters reads back whole', async () => {
    const text = 'a€b'.repeat(200_000);
    await serve(
      () => new Response(text),
      async (base) => expect(await nodeText(`${base}/big`, {}, AbortSignal.timeout(5000))).toBe(text)
    );
  });

  test('refuses a failure', async () => {
    await serve(
      () => new Response('no', { status: 404 }),
      async (base) => await expect(nodeText(`${base}/missing`, {}, AbortSignal.timeout(2000))).rejects.toThrow('status 404')
    );
  });

  // This client doesn't decompress, and a compressed body compared with the
  // archive would look like a bad copy, which is deleted.
  test('refuses a body that came back compressed rather than passing it off as the archive', async () => {
    await serve(
      () => new Response('not really brotli', { headers: { 'content-encoding': 'br' } }),
      async (base) => await expect(nodeText(`${base}/x`, {}, AbortSignal.timeout(2000))).rejects.toThrow('unexpected content-encoding br')
    );
  });

  test('stops when its signal aborts', async () => {
    await serve(
      () => new Promise<Response>(() => {}),
      async (base) => await expect(nodeText(`${base}/hang`, {}, AbortSignal.timeout(50))).rejects.toThrow()
    );
  });
});

// The receipt an account deletion shows promises a date by which the last
// backup holding the data is gone (lib/deletion-receipt.ts). That date must be
// what pruning really does, not a figure from the docs.
describe('how long a backup outlasts a deletion', () => {
  for (const keep of [undefined, '3', '10']) {
    test(`with BACKUP_KEEP_DAYS ${keep ?? 'unset'}, the last copy goes exactly when the receipt says`, async () => {
      if (keep) process.env.BACKUP_KEEP_DAYS = keep;
      const retention = backupRetention();
      if (!retention?.kept) throw new Error('expected backups to be kept');
      const s = await store();
      // The copy taken by the run just before the deletion, then one run a night.
      const start = clock.getTime();
      const { pathname: last } = await runBackup(fake as any, s, new Date(start));
      for (let night = 1; night <= retention.max_days; night++) {
        clock = new Date(start + night * DAY);
        await runBackup(fake as any, s, clock);
        expect(blobs.has(last)).toBe(night < retention.max_days);
      }
    });
  }

  test('no blob store, no backups; a setting that can’t be read, no date', () => {
    delete process.env.BLOB_READ_WRITE_TOKEN;
    expect(backupRetention()).toEqual({ kept: false });
    process.env.BLOB_READ_WRITE_TOKEN = 'token';
    process.env.BACKUP_KEEP_DAYS = '0';
    expect(backupRetention()).toBeNull();
    process.env.BACKUP_KEEP_DAYS = '45';
    expect(backupRetention()).toEqual({ kept: true, keep_days: 45, min_kept: MIN_KEPT, max_days: 46 });
  });
});
