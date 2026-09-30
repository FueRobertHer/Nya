// lib/backup.ts
//
// The nightly off-site copy: the same archive as /api/ops/export
// (lib/export.ts), written to object storage by a cron, read back and checked,
// and old copies pruned. Without it the only copy outside the database is
// whatever export was last downloaded by hand.
//
// The archive stays ciphertext (lib/export.ts rule 1): a stolen backup is
// useless without MASTER_KEY and PLAID_ENCRYPTION_KEY, which are not in it.
// It is still financial data, so the store is private: a blob is read only
// with the store's token, never by URL.
//
// One archive per environment per run, holding every container (a restore
// replaces the environment; see lib/restore.ts). Named by the time it was
// taken, so names sort by age and never collide.
//
// Each run records its outcome (backups:status, environment-wide), and the
// dashboard says so when the last run failed or none has succeeded for two
// days (backupProblem): Vercel doesn't send an alert for a failed cron, and a
// stalled snapshot once went unnoticed for three weeks.
//
// Nothing is pruned unless this run's copy was read back intact, and the
// newest MIN_KEPT copies are always kept, whatever their age: a clock or
// retention mistake can never leave the store empty.
//
// Every step has a time limit (STEP_LIMITS_MS). Neither Vercel Blob nor Upstash
// times out a request on its own, and Vercel ends the function at maxDuration
// without running anything after, so one call that never answered used to
// leave a copy uploaded, nothing pruned, no outcome recorded, and only "Task
// timed out" in the log. A step over its limit is now an ordinary failure that
// names the step.

import { get as httpGet } from 'node:http';
import { get as httpsGet } from 'node:https';
import { verifyArchive } from './restore';
import { exportLines, type ExportClient } from './export';
import { envPrefix, kEnv, redis } from './storage';

/** What a backup needs from object storage. Vercel Blob in production
 *  (vercelBlobStore); tests pass one kept in memory. Each call is given a
 *  signal that aborts when its step runs out of time. */
export type BackupStore = {
  put(pathname: string, body: string, signal?: AbortSignal): Promise<void>;
  /** The blob's text, or null if it isn't there. */
  get(pathname: string, signal?: AbortSignal): Promise<string | null>;
  list(prefix: string, signal?: AbortSignal): Promise<{ pathname: string; uploadedAt: Date }[]>;
  del(pathnames: string[], signal?: AbortSignal): Promise<void>;
};

export const DEFAULT_KEEP_DAYS = 30;
export const MIN_KEPT = 7;

/**
 * How long each step may take, in milliseconds. The longest path (export,
 * upload, read-back, list, prune) adds up to 255s, 45s under the route's
 * maxDuration of 300s (a failure is recorded in 15s of that), so a failure is
 * still recorded before Vercel ends the function. The read-back has the most
 * because a stalled body is tried three other ways before it gives up. `discard` takes the place of list and prune when the read-back is
 * wrong. A 1 MB archive takes seconds; these are for a call that never answers.
 */
export const STEP_LIMITS_MS = {
  export: 90_000,
  upload: 45_000,
  'read-back': 60_000,
  list: 30_000,
  prune: 30_000,
  discard: 30_000,
} as const;

export type BackupStep = keyof typeof STEP_LIMITS_MS;

export type BackupOptions = {
  /** Told how long each step took as it finishes, so the log shows where the
   *  time went even when a later step fails. */
  onStep?: (step: BackupStep, ms: number) => void;
  /** Tests shorten these. */
  limits?: Partial<Record<BackupStep, number>>;
};

/**
 * Runs one step against its time limit. Over the limit, the step's signal is
 * aborted (cancelling the request where the client honours it) and the step
 * fails at once, whether or not the call ever settles. "Took longer" covers
 * both a call that never answered and one the SDK kept retrying: Vercel Blob
 * retries 5xx and network errors up to 10 times with a doubling backoff.
 */
async function step<T>(name: BackupStep, opts: BackupOptions, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const limit = opts.limits?.[name] ?? STEP_LIMITS_MS[name];
  const started = Date.now();
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      // Aborted with no reason on purpose: Vercel Blob stops only on the
      // default AbortError, and retries any other error (a reason passed here
      // is what the fetch rejects with), carrying on for many minutes.
      controller.abort();
      reject(new Error(`The backup's ${name} step took longer than ${limit / 1000}s`));
    }, limit);
  });
  let result: T;
  try {
    result = await Promise.race([run(controller.signal), timeout]);
  } finally {
    clearTimeout(timer);
  }
  try {
    opts.onStep?.(name, Date.now() - started);
  } catch {
    // Only reporting: a step that finished must not fail because of it.
  }
  return result;
}

/** BACKUP_KEEP_DAYS, validated: a typo must not prune everything. */
export function keepDays(): number {
  const raw = process.env.BACKUP_KEEP_DAYS;
  if (!raw) return DEFAULT_KEEP_DAYS;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) throw new Error(`BACKUP_KEEP_DAYS must be a whole number of days, 1 or more (got ${JSON.stringify(raw)})`);
  return n;
}

/** Where this environment's backups live in the store. */
export function backupFolder(): string {
  return `backups/${envPrefix().replace(/:$/, '')}/`;
}

export type BackupResult = { pathname: string; bytes: number; keys: number; pruned: string[] };

export async function runBackup(
  client: ExportClient,
  store: BackupStore,
  now: Date = new Date(),
  opts: BackupOptions = {}
): Promise<BackupResult> {
  const days = keepDays(); // before anything is written: a bad setting fails loudly first
  const { body, records } = await step('export', opts, async () => {
    const parts: string[] = [];
    for await (const line of exportLines(client, now)) parts.push(line);
    const body = parts.join('');
    // Checked before upload too: an archive restore would refuse is not a backup.
    return { body, records: verifyArchive(body).records };
  });

  const pathname = `${backupFolder()}nya-${now.toISOString().replace(/[:.]/g, '-')}.ndjson`;
  await step('upload', opts, (signal) => store.put(pathname, body, signal));

  // Read back: what counts is what the store will hand over on the bad day. A
  // read-back that runs out of time leaves the copy in place, unverified: it is
  // most likely fine, and nothing is pruned on the strength of it.
  const stored = await step('read-back', opts, (signal) => store.get(pathname, signal));
  if (stored !== body) {
    await step('discard', opts, (signal) => store.del([pathname], signal)).catch(() => {});
    throw new Error(`The backup ${pathname} did not read back as written`);
  }

  const cutoff = now.getTime() - days * 86_400_000;
  const existing = await step('list', opts, (signal) => store.list(backupFolder(), signal));
  existing.sort((a, b) => (a.pathname < b.pathname ? 1 : -1)); // newest first
  const pruned = existing
    .slice(MIN_KEPT)
    .filter((b) => b.pathname !== pathname && b.uploadedAt.getTime() < cutoff)
    .map((b) => b.pathname);
  if (pruned.length > 0) await step('prune', opts, (signal) => store.del(pruned, signal));

  return { pathname, bytes: Buffer.byteLength(body), keys: records.length, pruned };
}

/** How long the read-back's body may go without a chunk before other ways of
 *  reading it are tried. Three of them at this long fit in the read-back step. */
export const BODY_STALL_MS = 10_000;

/**
 * Reads a response body to the end, or gives up (null) when no chunk arrives
 * for `stallMs`. The body of the SDK's read once never delivered a byte in the
 * deployed function, though the response had arrived and the same read took
 * 0.3s on a laptop: the caller then reads the same URL another way.
 * `onProgress` hears the total after each chunk.
 */
export async function readBody(
  stream: ReadableStream<Uint8Array>,
  stallMs: number,
  onProgress: (bytes: number, chunks: number) => void = () => {}
): Promise<string | null> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  for (;;) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const stalled = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), stallMs);
    });
    const next = await Promise.race([reader.read(), stalled]).finally(() => clearTimeout(timer));
    if (next === null) {
      reader.cancel().catch(() => {});
      return null;
    }
    if (next.done) break;
    chunks.push(next.value);
    bytes += next.value.length;
    onProgress(bytes, chunks.length);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

/** GETs a URL with node's own http(s) client, which involves neither fetch
 *  nor undici. */
export function nodeText(url: string, headers: Record<string, string>, signal: AbortSignal): Promise<string> {
  const get = url.startsWith('https:') ? httpsGet : httpGet;
  return new Promise((resolve, reject) => {
    const req = get(url, { headers, signal }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`status ${res.statusCode}`));
        return;
      }
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => resolve(new TextDecoder().decode(Buffer.concat(chunks))));
      res.on('error', reject);
    });
    req.on('error', reject);
  });
}

/** GETs a URL with fetch as it was before Next patched it (Next keeps it as
 *  _nextOriginalFetch), or plain fetch when there is no such thing. */
async function originalFetchText(url: string, headers: Record<string, string>, signal: AbortSignal): Promise<string> {
  const patched = globalThis.fetch as typeof fetch & { _nextOriginalFetch?: typeof fetch };
  const res = await (patched._nextOriginalFetch ?? fetch)(url, { headers, signal });
  if (!res.ok) throw new Error(`status ${res.status}`);
  return res.text();
}

/** Vercel Blob, private, with the token Vercel sets when a store is connected
 *  to the project (BLOB_READ_WRITE_TOKEN). Null when there isn't one. */
export async function vercelBlobStore(stallMs: number = BODY_STALL_MS): Promise<BackupStore | null> {
  if (!process.env.BLOB_READ_WRITE_TOKEN) return null;
  const blob = await import('@vercel/blob');
  return {
    async put(pathname, body, signal) {
      await blob.put(pathname, body, {
        abortSignal: signal,
        access: 'private',
        contentType: 'application/x-ndjson',
        addRandomSuffix: false,
        allowOverwrite: false,
        // Large bodies go up in parts, each retried on its own.
        multipart: body.length > 8 * 1024 * 1024,
      });
    },
    async get(pathname, signal) {
      // The signal reaches the fetch, so it cancels reading the body too.
      // Logged as it goes so a read-back that stalls shows how far it got: the
      // body of a read-back once never finished in the deployed function while
      // the same read took 0.3s locally. Progress lines go out as data arrives,
      // because nothing runs after the step's time limit ends the function.
      const started = Date.now();
      const seconds = () => ((Date.now() - started) / 1000).toFixed(1);
      // Uncompressed, so what is compared is exactly what the store holds. This
      // was tried for a body that never delivered a byte in the deployed
      // function; it made no difference (the body stalled uncompressed too),
      // and at about 1 MB the extra transfer costs nothing, so it stayed.
      const res = await blob.get(pathname, {
        access: 'private',
        useCache: false,
        abortSignal: signal,
        headers: { 'accept-encoding': 'identity' },
      });
      console.log(`Backup read-back response after ${seconds()}s`, res ? `status ${res.statusCode}` : 'not found');
      if (!res || res.statusCode !== 200) return null;
      console.log(
        'Backup read-back response headers',
        JSON.stringify({
          node: process.version,
          nextPatchedFetch: Boolean((globalThis.fetch as { __nextPatched?: boolean }).__nextPatched),
          contentEncoding: res.headers.get('content-encoding'),
          transferEncoding: res.headers.get('transfer-encoding'),
          contentLength: res.headers.get('content-length'),
        })
      );
      let nextMark = 0;
      const text = await readBody(res.stream, stallMs, (bytes, chunks) => {
        if (bytes < nextMark) return;
        console.log(`Backup read-back body at ${seconds()}s`, `${bytes} bytes in ${chunks} chunks`);
        nextMark = bytes + 131_072;
      });
      if (text !== null) {
        console.log(`Backup read-back body after ${seconds()}s`, `${text.length} chars`);
        return text;
      }

      // No data for stallMs. Try other ways of reading the same URL, all of
      // them, so the log shows which work: fetch as it was before Next patched
      // it, and node's own client. The first that returns the archive is used.
      console.log(`Backup read-back body stalled after ${seconds()}s: no data for ${stallMs / 1000}s, trying other readers`);
      const within = () => (signal ? AbortSignal.any([signal, AbortSignal.timeout(stallMs)]) : AbortSignal.timeout(stallMs));
      const url = res.blob.url;
      const headers = { authorization: `Bearer ${process.env.BLOB_READ_WRITE_TOKEN}`, 'accept-encoding': 'identity' };
      // The token goes to Vercel Blob and nowhere else.
      const isBlobUrl = new URL(url).hostname.endsWith('.blob.vercel-storage.com');
      const readers: [string, (signal: AbortSignal) => Promise<string>][] = isBlobUrl
        ? [
            [(globalThis.fetch as { _nextOriginalFetch?: unknown })._nextOriginalFetch ? 'original fetch' : 'fetch', (s) => originalFetchText(url, headers, s)],
            ['node https', (s) => nodeText(url, headers, s)],
          ]
        : [];
      if (!isBlobUrl) console.log(`Backup read-back: ${url} is not a Vercel Blob URL, so no other reader is tried`);
      let found: string | null = null;
      for (const [name, read] of readers) {
        try {
          const got = await read(within());
          console.log(`Backup read-back via ${name} worked at ${seconds()}s`, `${got.length} chars`);
          found ??= got;
        } catch (err) {
          console.log(`Backup read-back via ${name} failed at ${seconds()}s`, err instanceof Error ? err.message : String(err));
        }
      }

      // Is it this copy that can't be read, or any read? An older copy, from an
      // earlier run and long settled, is read the way the SDK read this one.
      try {
        const older = (await blob.list({ prefix: backupFolder(), abortSignal: within() })).blobs
          .map((b) => b.pathname)
          .filter((p) => p !== pathname)
          .sort()
          .at(-1);
        if (!older) {
          console.log('Backup read-back: no older copy to compare with');
        } else {
          const other = await blob.get(older, { access: 'private', useCache: false, abortSignal: within(), headers: { 'accept-encoding': 'identity' } });
          const otherText = other && other.statusCode === 200 ? await readBody(other.stream, stallMs) : null;
          console.log(
            `Backup read-back: the older copy ${older} ${otherText === null ? 'also stalled or was not there' : `read fine, ${otherText.length} chars`} at ${seconds()}s`
          );
        }
      } catch (err) {
        console.log(`Backup read-back: reading an older copy failed at ${seconds()}s`, err instanceof Error ? err.message : String(err));
      }

      if (found !== null) return found;
      throw new Error(
        isBlobUrl
          ? "The backup's read-back got no data from the store (tried the SDK, fetch and node's https)"
          : `The backup's read-back got no data, and ${url} is not a Vercel Blob URL`
      );
    },
    async list(prefix, signal) {
      const out: { pathname: string; uploadedAt: Date }[] = [];
      let cursor: string | undefined;
      do {
        const page = await blob.list({ prefix, cursor, abortSignal: signal });
        for (const b of page.blobs) out.push({ pathname: b.pathname, uploadedAt: new Date(b.uploadedAt) });
        cursor = page.hasMore ? page.cursor : undefined;
      } while (cursor);
      return out;
    },
    async del(pathnames, signal) {
      if (pathnames.length > 0) await blob.del(pathnames, { abortSignal: signal });
    },
  };
}

const STATUS = () => kEnv('backups:status');

type Status = { last_ok: string | null; last_failed: string | null; reason: string | null };

async function readStatus(): Promise<Status | null> {
  const raw = await redis().get<unknown>(STATUS());
  const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
  return parsed && typeof parsed === 'object' ? (parsed as Status) : null;
}

/** How long recording an outcome may take. Upstash sets no timeout, and this
 *  runs in the minute the step limits leave before maxDuration. */
export const RECORD_LIMIT_MS = 15_000;

/** Records a run's outcome. Best effort: never what fails a backup, and given
 *  up on after `limitMs` rather than left to run into maxDuration. */
export async function recordOutcome(
  outcome: { ok: true } | { ok: false; reason: string },
  now: Date = new Date(),
  limitMs: number = RECORD_LIMIT_MS
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const write = async () => {
      const prev = await readStatus();
      const next: Status = outcome.ok
        ? { last_ok: now.toISOString(), last_failed: null, reason: null }
        : { last_ok: prev?.last_ok ?? null, last_failed: now.toISOString(), reason: outcome.reason.slice(0, 200) };
      await redis().set(STATUS(), JSON.stringify(next));
    };
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`took longer than ${limitMs / 1000}s`)), limitMs);
    });
    await Promise.race([write(), timeout]);
  } catch (err) {
    console.error('Backup outcome not recorded', err instanceof Error ? err.message : err);
  } finally {
    clearTimeout(timer);
  }
}

export type BackupProblem = { last_ok: string | null; reason: string | null };

/** Something the dashboard should say about backups, or null. Null too when
 *  none has ever run (they aren't set up) and when the status can't be read:
 *  this is a notice, never a reason to fail a page. */
export async function backupProblem(now: Date = new Date()): Promise<BackupProblem | null> {
  let status: Status | null;
  try {
    status = await readStatus();
  } catch {
    return null;
  }
  if (!status) return null;
  if (status.last_failed) return { last_ok: status.last_ok, reason: status.reason };
  // Two days: the cron runs at 16:00 UTC, so yesterday's copy being the
  // newest is normal for most of the day.
  if (status.last_ok && now.getTime() - Date.parse(status.last_ok) > 2 * 86_400_000) {
    return { last_ok: status.last_ok, reason: null };
  }
  return null;
}
