// lib/backup.ts
//
// The nightly off-site copy: the same archive as /api/ops/export
// (lib/export.ts), written to object storage by a cron, read back and checked,
// and old copies pruned. Without it the only copy outside the database is
// whatever export was last downloaded by hand.
//
// The archive keeps every value as stored (lib/export.ts rule 1): what is
// encrypted stays ciphertext, unreadable without MASTER_KEY and
// PLAID_ENCRYPTION_KEY, which are not in it. Not everything is encrypted:
// dates, account and transaction ids, bank names and the merchant names a
// person renamed are plain text in the database, so in the archive too
// (docs/operations.md). It is financial data either way, so the store is
// private: a blob is read only with the store's token, never by its bare URL.
//
// One archive per environment per run, holding every container (a restore
// replaces the environment; see lib/restore.ts). Named by the time it was
// taken, so names sort by age and never collide, and `.f2` for format 2, so an
// archive the release before writes (format 1, with the key store inside) is
// told apart by its name.
//
// THE KEYS GO APART (docs/operations.md, "Per-container data keys"). A data
// archive of format 2 leaves the key store out; each run then writes a key
// archive (lib/key-archive.ts), checks it, and keeps seven generations. A run
// that can't write and check its key archive fails, its data archive kept.
// The same run notes, in each container's map entry, the time of an archive
// that holds one of its values under k0 or an environment key (`shared_in`),
// read from the headers alone, and clears its `moved`; and the time of any
// format-1 archive the release before took after the container's key was made
// (a rollback), since that archive holds the key itself.
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
import { envPrefix, kEnv, redis, rawRedis } from './storage';
import { rewriteAfterDeletion, writeKeyArchive, type KeyArchiveResult, type KeysLock, type KeysPending } from './key-archive';
import { containersUnderSharedKeys, keyIdsByContainer, namedKeyIds } from './archive-scan';
import { MasterKeyError, readContainerEntries, readKeyRecords, updateContainerEntry, ContainerKeyError } from './crypto';

/** What a backup needs from object storage. Vercel Blob in production
 *  (vercelBlobStore); tests pass one kept in memory. Each call is given a
 *  signal that aborts when its step runs out of time. */
export type BackupStore = {
  /** `cacheMaxAgeSeconds`: how long a cache may serve it, for a file that
   *  must stop being served soon after it is deleted (a key archive). */
  put(pathname: string, body: string, signal?: AbortSignal, opts?: { cacheMaxAgeSeconds?: number }): Promise<void>;
  /** The blob's text, or null if it isn't there. */
  get(pathname: string, signal?: AbortSignal): Promise<string | null>;
  list(prefix: string, signal?: AbortSignal): Promise<{ pathname: string; uploadedAt: Date }[]>;
  del(pathnames: string[], signal?: AbortSignal): Promise<void>;
};

export const DEFAULT_KEEP_DAYS = 30;
export const MIN_KEPT = 7;

/**
 * How long each step may take, in milliseconds. The longest path (export,
 * upload, read-back, the key archive, the count, list, prune) adds up to
 * 240s, a minute under the route's maxDuration of 300s, so a failure is still
 * recorded before Vercel ends the function. `discard` takes the place of the
 * rest when the read-back is wrong. A 1 MB archive takes seconds; these are
 * for a call that never answers.
 */
export const STEP_LIMITS_MS = {
  export: 75_000,
  upload: 35_000,
  'read-back': 35_000,
  keys: 40_000,
  count: 15_000,
  list: 20_000,
  prune: 20_000,
  discard: 20_000,
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

/**
 * How long the nightly backups can keep a copy of data deleted now, for the
 * receipt an account deletion shows (lib/deletion-receipt.ts).
 *
 * Every copy taken before the deletion still holds the data, the newest no
 * later than the deletion itself. A copy is pruned by the first successful run
 * at which it is older than keepDays() and not among the newest MIN_KEPT
 * (runBackup). With one run a night, a copy just short of the limit at one run
 * goes at the next, so the last copy holding the data is gone keepDays() + 1
 * days after the deletion at most, or MIN_KEPT days when that is longer (the
 * newest MIN_KEPT are kept whatever their age). That holds only while runs
 * succeed: nothing is pruned on a night that fails, so a receipt says so when
 * backups have stopped (backupProblem).
 *
 * `kept` is false when this deployment has no blob store, so it takes no
 * backups at all. Null when BACKUP_KEEP_DAYS is invalid: then no backup runs
 * (runBackup refuses before anything else), none is pruned either, and no
 * date would be true.
 */
export function backupRetention(): { kept: false } | { kept: true; keep_days: number; min_kept: number; max_days: number } | null {
  if (!process.env.BLOB_READ_WRITE_TOKEN) return { kept: false };
  let days: number;
  try {
    days = keepDays();
  } catch {
    return null;
  }
  return { kept: true, keep_days: days, min_kept: MIN_KEPT, max_days: Math.max(days + 1, MIN_KEPT) };
}

/**
 * DATABASE_BACKUP_DAYS, validated: how many days the database host's own
 * backups keep a copy (Upstash's Daily Backup keeps each for 1 or 3 days; 0,
 * the default, means it is off). Each holds the whole database, key store
 * included, so the pages and the deletion receipt add it to how long a
 * deleted account's copies stay readable. Null when it isn't a whole number
 * of days, 0 or more: then no date that depends on it is true.
 */
export function databaseBackupDays(): number | null {
  const raw = process.env.DATABASE_BACKUP_DAYS;
  if (raw === undefined || raw === '') return 0;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 && n <= 366 ? n : null;
}

/** Where this environment's backups live in the store. */
export function backupFolder(): string {
  return `backups/${envPrefix().replace(/:$/, '')}/`;
}

export type BackupResult = {
  pathname: string;
  bytes: number;
  keys: number;
  pruned: string[];
  /** The key archive this run wrote, and what it rewrote and pruned. */
  key_archive: KeyArchiveResult;
  /** Containers noted as having a value under a shared key in this archive. */
  shared_in: string[];
  /** Containers noted as held, with their key, by an archive the release
   *  before took (a rollback). */
  rollback_noted: string[];
};

/** A data archive's name: format 2's carry `.f2`. */
const DATA_ARCHIVE = /nya-(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z)(\.f2)?\.ndjson$/;

/** When a data archive was taken, from its name, as an ISO time, and whether
 *  the release before wrote it (format 1). Null for a name that isn't one. */
export function dataArchiveName(pathname: string): { taken: string; format1: boolean } | null {
  const m = DATA_ARCHIVE.exec(pathname);
  if (!m) return null;
  const [date, time] = m[1].split('T');
  const [h, mi, s, ms] = time.slice(0, -1).split('-');
  return { taken: `${date}T${h}:${mi}:${s}.${ms}Z`, format1: m[2] === undefined };
}

/**
 * Notes, in each container's map entry, that this archive holds one of its
 * values under k0 or an environment key: `shared_in` set to when it was
 * taken, `moved` cleared, so the migration pass walks it again. From the
 * values' headers alone. Answers the containers noted.
 */
async function noteSharedKeys(records: Awaited<ReturnType<typeof verifyArchive>>['records'], takenAt: Date): Promise<string[]> {
  const keyRecords = await readKeyRecords();
  const owner = (id: string): string | null | undefined => {
    const r = keyRecords.get(id);
    if (r === undefined || r instanceof MasterKeyError) return undefined;
    return r.container ?? null;
  };
  const shared = containersUnderSharedKeys(keyIdsByContainer(records), owner);
  const at = takenAt.toISOString();
  const noted: string[] = [];
  for (const c of shared) {
    const e = await updateContainerEntry(c, (cur) => (cur && 'key' in cur && (cur.moved !== undefined || cur.shared_in !== at) ? { key: cur.key, since: cur.since, shared_in: at } : null));
    if (e && 'key' in e && e.shared_in === at) noted.push(c);
  }
  return noted;
}

/**
 * Notes a rollback, seen in the store's own listing: a format-1 archive (the
 * release before's, holding the whole key store) taken after a container's
 * key was made holds that container readably. Its time goes in `shared_in`
 * (if later than what is there) and `moved` is cleared.
 */
async function noteRollbacks(listed: { pathname: string }[]): Promise<string[]> {
  const format1 = listed.map((b) => dataArchiveName(b.pathname)).filter((n): n is { taken: string; format1: boolean } => n !== null && n.format1).map((n) => n.taken).sort();
  if (format1.length === 0) return [];
  const noted: string[] = [];
  for (const [container, entry] of await readContainerEntries()) {
    if (entry instanceof ContainerKeyError || !('key' in entry)) continue;
    const newest = format1.filter((t) => t > entry.since).at(-1);
    if (!newest || (entry.shared_in !== undefined && entry.shared_in >= newest)) continue;
    const e = await updateContainerEntry(container, (cur) =>
      cur && 'key' in cur && (cur.shared_in === undefined || cur.shared_in < newest) ? { key: cur.key, since: cur.since, shared_in: newest } : null
    );
    if (e && 'key' in e && e.shared_in === newest) noted.push(container);
  }
  return noted;
}

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

  const pathname = `${backupFolder()}nya-${now.toISOString().replace(/[:.]/g, '-')}.f2.ndjson`;
  await step('upload', opts, (signal) => store.put(pathname, body, signal));

  // Read back: what counts is what the store will hand over on the bad day. A
  // read-back that runs out of time leaves the copy in place, unverified: it is
  // most likely fine, and nothing is pruned on the strength of it.
  const stored = await step('read-back', opts, (signal) => store.get(pathname, signal));
  if (stored !== body) {
    await step('discard', opts, (signal) => store.del([pathname], signal)).catch(() => {});
    throw new Error(`The backup ${pathname} did not read back as written`);
  }

  // The key archive, checked against what tonight's values name. A run that
  // can't write and check it fails here: its data archive is kept, and
  // nothing is pruned.
  const named = namedKeyIds(keyIdsByContainer(records));
  const maxDays = Math.max(days + 1, MIN_KEPT);
  const keyArchive = await step('keys', opts, (signal) => writeKeyArchive(client, store, keysLock, { takenAt: now, named, maxDays, signal }));
  const shared = await step('count', opts, () => noteSharedKeys(records, now));

  const cutoff = now.getTime() - days * 86_400_000;
  const existing = await step('list', opts, (signal) => store.list(backupFolder(), signal));
  const rollbacks = await noteRollbacks(existing);
  existing.sort((a, b) => (a.pathname < b.pathname ? 1 : -1)); // newest first
  const pruned = existing
    .slice(MIN_KEPT)
    .filter((b) => b.pathname !== pathname && b.uploadedAt.getTime() < cutoff)
    .map((b) => b.pathname);
  if (pruned.length > 0) await step('prune', opts, (signal) => store.del(pruned, signal));

  return { pathname, bytes: Buffer.byteLength(body), keys: records.length, pruned, key_archive: keyArchive, shared_in: shared, rollback_noted: rollbacks };
}

/**
 * GETs a URL with node's own http(s) client. It sends `accept-encoding:
 * identity` itself and refuses any other encoding, because unlike fetch this
 * client doesn't decompress: a compressed body compared with the archive would
 * look like a bad copy, and a bad copy is deleted.
 */
export function nodeText(url: string, headers: Record<string, string>, signal: AbortSignal): Promise<string> {
  const get = url.startsWith('https:') ? httpsGet : httpGet;
  return new Promise((resolve, reject) => {
    const req = get(url, { headers: { ...headers, 'accept-encoding': 'identity' }, signal }, (res) => {
      const encoding = res.headers['content-encoding'];
      if (res.statusCode !== 200 || (encoding && encoding !== 'identity')) {
        res.resume();
        reject(new Error(res.statusCode !== 200 ? `status ${res.statusCode}` : `unexpected content-encoding ${encoding}`));
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

/** What reads a blob's URL back: node's own client in production, a stand-in
 *  in tests. */
export type ReadUrl = (url: string, headers: Record<string, string>, signal: AbortSignal) => Promise<string>;

/** Vercel Blob, private, with the token Vercel sets when a store is connected
 *  to the project (BLOB_READ_WRITE_TOKEN). Null when there isn't one. */
export async function vercelBlobStore(readUrl: ReadUrl = nodeText): Promise<BackupStore | null> {
  const token = process.env.BLOB_READ_WRITE_TOKEN;
  if (!token) return null;
  const blob = await import('@vercel/blob');
  return {
    async put(pathname, body, signal, opts) {
      await blob.put(pathname, body, {
        abortSignal: signal,
        access: 'private',
        contentType: 'application/x-ndjson',
        addRandomSuffix: false,
        allowOverwrite: false,
        // Large bodies go up in parts, each retried on its own.
        multipart: body.length > 8 * 1024 * 1024,
        ...(opts?.cacheMaxAgeSeconds !== undefined ? { cacheControlMaxAge: opts.cacheMaxAgeSeconds } : {}),
      });
    },
    async get(pathname, signal) {
      // The SDK finds the blob (null when it isn't there) and gives its URL, but
      // its body is not what is read. In the deployed function the body of the
      // SDK's read never delivered a byte, for any blob, while the response
      // arrived at once: the SDK reads through fetch, and Next patches fetch in
      // route handlers. The same URL read with node's own client returns the
      // whole archive in under a second (as does Next's unpatched fetch), so
      // that is what is compared.
      const res = await blob.get(pathname, { access: 'private', useCache: false, abortSignal: signal });
      if (!res || res.statusCode !== 200) return null;
      res.stream.cancel().catch(() => {});
      const url = new URL(res.blob.url);
      // The token goes to Vercel Blob and nowhere else.
      if (!url.hostname.endsWith('.blob.vercel-storage.com')) throw new Error(`The backup's read-back was pointed at ${url.hostname}, which is not Vercel Blob`);
      // As the SDK's own read does, so what comes back is from the store, not a cache.
      url.searchParams.set('cache', '0');
      return readUrl(url.toString(), { authorization: `Bearer ${token}` }, signal ?? new AbortController().signal);
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

// The key archives' lock and the marker a deletion leaves (lib/key-archive.ts
// KeysLock), beside the backups' own record.

const KEYS_LOCK = () => kEnv('backups:keys-lock');
const KEYS_PENDING = () => kEnv('backups:keys-pending');

/** How long the key archives' lock is held at most. The nightly run's key
 *  archive step and a deletion's rewrite each finish well inside it. */
export const KEYS_LOCK_MS = 120_000;

/** Deletes a key only while it holds exactly ARGV[1]: the lock's release,
 *  and the marker's clearing. The same script as the snapshot's lock
 *  (lib/snapshot-job.ts), and named the same. */
export const DELETE_IF_HOLDS = `-- nya:release-lock
if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end
return 0`;

const isIsoTime = (v: unknown): v is string => typeof v === 'string' && !Number.isNaN(Date.parse(v));

async function readPending(): Promise<KeysPending | null> {
  const raw = await redis().get<unknown>(KEYS_PENDING());
  if (raw === null || raw === undefined) return null;
  let v: unknown = raw;
  if (typeof raw === 'string') {
    try {
      v = JSON.parse(raw);
    } catch {
      v = null;
    }
  }
  const p = v as { since?: unknown; containers?: unknown } | null;
  // One that can't be read still says a rewrite is owed.
  if (!p || typeof p !== 'object' || !isIsoTime(p.since) || !Array.isArray(p.containers)) return { since: new Date(0).toISOString(), containers: [] };
  return { since: p.since, containers: p.containers.filter((c): c is string => typeof c === 'string') };
}

export const keysLock: KeysLock = {
  async take(waitMs) {
    const token = crypto.randomUUID();
    const until = Date.now() + waitMs;
    for (;;) {
      if (await redis().set(KEYS_LOCK(), token, { nx: true, px: KEYS_LOCK_MS })) return token;
      if (Date.now() >= until) return null;
      await new Promise((r) => setTimeout(r, Math.min(500, Math.max(0, until - Date.now()))));
    }
  },
  async release(token) {
    try {
      await redis().eval(DELETE_IF_HOLDS, [KEYS_LOCK()], [token]);
    } catch (err) {
      console.error('Key archives: the lock could not be released; it will expire.', err instanceof Error ? err.name : typeof err);
    }
  },
  readPending,
  async markPending(container, now) {
    for (let attempt = 0; attempt < 3; attempt++) {
      const cur = await readPending();
      const next: KeysPending = { since: cur?.since ?? now.toISOString(), containers: [...new Set([...(cur?.containers ?? []), container])].sort() };
      await redis().set(KEYS_PENDING(), JSON.stringify(next));
      if ((await readPending())?.containers.includes(container)) return;
    }
  },
  async clearPendingIf(seen) {
    await redis().eval(DELETE_IF_HOLDS, [KEYS_PENDING()], [JSON.stringify(seen)]);
  },
};

/** Whether a deletion left the key archives for the nightly run, and since
 *  when: for the status. */
export async function keysPending(): Promise<KeysPending | null> {
  return readPending();
}

/**
 * A deletion's last step (lib/account-deletion.ts): every kept key archive
 * rewritten without the keys just destroyed, or left for the next nightly
 * run (lib/key-archive.ts rewriteAfterDeletion). Never throws.
 */
export function rewriteKeyArchivesAfterDeletion(
  store: BackupStore | null,
  container: string,
  opts: { now?: Date; limitMs?: number; lockWaitMs?: number } = {}
): ReturnType<typeof rewriteAfterDeletion> {
  return rewriteAfterDeletion(store, rawRedis() as unknown as Parameters<typeof rewriteAfterDeletion>[1], keysLock, container, opts);
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
