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
// Before that, once the copy reads back, the same run notes in each
// container's map entry the time of an archive that holds one of its values
// under k0 or an environment key (`shared_in`), read from the headers alone,
// and clears its `moved`; and, from the folder's listing, the time of the
// newest format-1 archive the release before took after the container's key
// was made (`key_in`: a rollback's, which holds the key itself), clearing
// `moved` too.
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
// names the step. Within a step, a listing, a delete or a read that stalls is
// sent again on a new request (lib/blob-attempts.ts), so one quiet connection
// no longer uses up the whole step.

import { get as httpGet } from 'node:http';
import { get as httpsGet } from 'node:https';
import { verifyArchive } from './restore';
import { exportLines, type ExportClient } from './export';
import { envPrefix, kEnv, redis, rawRedis } from './storage';
import { rewriteAfterDeletion, writeKeyArchive, type KeyArchiveResult, type KeysLock, type KeysPending } from './key-archive';
import { containersUnderSharedKeys, keyIdsByContainer, namedKeyIds } from './archive-scan';
import { MasterKeyError, masterKeyConfigured, readContainerEntries, readKeyRecords, updateContainerEntry, ContainerKeyError } from './crypto';
import { retryStalled } from './blob-attempts';

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
 * upload, read-back, the count, list, the key archive, prune) adds up to
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
  /** How long to wait for the key archives' lock (lib/key-archive.ts). */
  keysLockWaitMs?: number;
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
    const e = await updateContainerEntry(c, (cur) =>
      cur && 'key' in cur && (cur.moved !== undefined || cur.shared_in !== at) ? { key: cur.key, since: cur.since, shared_in: at, ...(cur.key_in !== undefined ? { key_in: cur.key_in } : {}) } : null
    );
    if (e && 'key' in e && e.shared_in === at) noted.push(c);
  }
  return noted;
}

/** When each format-1 archive in a listing of the backup folder was taken
 *  (the release before's, holding the whole key store), oldest first. */
export function format1Archives(listed: { pathname: string }[]): string[] {
  return listed
    .map((b) => dataArchiveName(b.pathname))
    .filter((n): n is { taken: string; format1: boolean } => n !== null && n.format1)
    .map((n) => n.taken)
    .sort();
}

/** The newest of these format-1 archive times taken after a key was made
 *  (`since`), or undefined: the archive that holds that key itself. */
export function newestHoldingKey(format1: string[], since: string): string | undefined {
  return format1.filter((t) => Date.parse(t) > Date.parse(since)).at(-1);
}

/**
 * Notes a rollback, seen in the store's own listing: a format-1 archive (the
 * release before's, holding the whole key store) taken after a container's
 * key was made holds that key. Its time goes in `key_in` (if later than what
 * is there) and `moved` is cleared, since the release before may have written
 * the container's values under a shared key meanwhile.
 */
async function noteRollbacks(listed: { pathname: string }[]): Promise<string[]> {
  const format1 = format1Archives(listed);
  if (format1.length === 0) return [];
  const noted: string[] = [];
  for (const [container, entry] of await readContainerEntries()) {
    if (entry instanceof ContainerKeyError || !('key' in entry)) continue;
    const newest = newestHoldingKey(format1, entry.since);
    if (!newest || (entry.key_in !== undefined && Date.parse(entry.key_in) >= Date.parse(newest))) continue;
    const e = await updateContainerEntry(container, (cur) =>
      cur && 'key' in cur && (cur.key_in === undefined || Date.parse(cur.key_in) < Date.parse(newest))
        ? { key: cur.key, since: cur.since, ...(cur.shared_in !== undefined ? { shared_in: cur.shared_in } : {}), key_in: newest }
        : null
    );
    if (e && 'key' in e && e.key_in === newest) noted.push(container);
  }
  return noted;
}

/**
 * When each format-1 archive in the backup folder was taken (format1Archives),
 * for a deletion's receipt, which must not wait for the nightly run to have
 * noted a rollback: one listing, within `limitMs`. Null when it can't be
 * listed in that time. Never throws.
 */
export async function listFormat1Archives(store: BackupStore, limitMs = 5_000): Promise<string[] | null> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new Error(`took longer than ${limitMs / 1000}s`));
      }, limitMs);
    });
    return format1Archives(await Promise.race([store.list(backupFolder(), controller.signal), timeout]));
  } catch (err) {
    console.error('Backups: the folder could not be listed for a deletion receipt, so it says what it couldn\'t check.', err instanceof Error ? err.message : typeof err);
    return null;
  } finally {
    clearTimeout(timer);
  }
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

  // The count, while the copy is known good: it is kept whatever follows.
  const shared = await step('count', opts, () => noteSharedKeys(records, now));

  // The folder's listing: what is kept, for the key archive and the prune,
  // and any archive the release before took (a rollback), noted from it.
  const { existing, rollbacks } = await step('list', opts, async (signal) => {
    const existing = await store.list(backupFolder(), signal);
    return { existing, rollbacks: await noteRollbacks(existing) };
  });
  const kept = [now.toISOString(), ...existing.map((b) => dataArchiveName(b.pathname)?.taken).filter((t): t is string => t !== undefined)];

  // The key archive, checked against what tonight's values name and what the
  // data archives kept may need. A run that can't write and check it fails
  // here: its data archive is kept, and nothing is pruned.
  const named = namedKeyIds(keyIdsByContainer(records));
  const maxDays = Math.max(days + 1, MIN_KEPT);
  const keyArchive = await step('keys', opts, (signal) =>
    writeKeyArchive(client, store, keysLock, { takenAt: now, named, kept, maxDays, signal, ...(opts.keysLockWaitMs !== undefined ? { lockWaitMs: opts.keysLockWaitMs } : {}) })
  );

  const cutoff = now.getTime() - days * 86_400_000;
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
      // The lookup and the read together, sent again if they stall
      // (lib/blob-attempts.ts).
      return retryStalled('a read', signal, async (s) => {
        const res = await blob.get(pathname, { access: 'private', useCache: false, abortSignal: s });
        if (!res || res.statusCode !== 200) return null;
        res.stream.cancel().catch(() => {});
        const url = new URL(res.blob.url);
        // The token goes to Vercel Blob and nowhere else.
        if (!url.hostname.endsWith('.blob.vercel-storage.com')) throw new Error(`The backup's read-back was pointed at ${url.hostname}, which is not Vercel Blob`);
        // As the SDK's own read does, so what comes back is from the store, not a cache.
        url.searchParams.set('cache', '0');
        return readUrl(url.toString(), { authorization: `Bearer ${token}` }, s);
      });
    },
    async list(prefix, signal) {
      const out: { pathname: string; uploadedAt: Date }[] = [];
      let cursor: string | undefined;
      do {
        const page = await retryStalled('a listing', signal, (s) => blob.list({ prefix, cursor, abortSignal: s }));
        for (const b of page.blobs) out.push({ pathname: b.pathname, uploadedAt: new Date(b.uploadedAt) });
        cursor = page.hasMore ? page.cursor : undefined;
      } while (cursor);
      return out;
    },
    async del(pathnames, signal) {
      if (pathnames.length > 0) await retryStalled('a delete', signal, (s) => blob.del(pathnames, { abortSignal: s }));
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

/** The marker as stored, exactly, or null; and what it says, unless it can't
 *  be read. */
async function readMarker(): Promise<{ raw: string; pending: KeysPending | null } | null> {
  const raw = await rawRedis().get(KEYS_PENDING());
  if (raw === null || raw === undefined) return null;
  const text = String(raw);
  let p: { since?: unknown; containers?: unknown } | null;
  try {
    p = JSON.parse(text);
  } catch {
    p = null;
  }
  const readable = !!p && typeof p === 'object' && isIsoTime(p.since) && Array.isArray(p.containers) && p.containers.every((c) => typeof c === 'string');
  return { raw: text, pending: readable ? { since: p!.since as string, containers: p!.containers as string[] } : null };
}

async function readPending(): Promise<KeysPending | null> {
  const m = await readMarker();
  if (m === null) return null;
  // One that can't be read still says a rewrite is owed.
  return m.pending ?? { since: new Date(0).toISOString(), containers: [], unreadable: true };
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
      const since = cur && !cur.unreadable ? cur.since : now.toISOString();
      const next: KeysPending = { since, containers: [...new Set([...(cur?.containers ?? []), container])].sort() };
      await redis().set(KEYS_PENDING(), JSON.stringify(next));
      if ((await readPending())?.containers.includes(container)) return;
    }
  },
  async clearPendingIf(seen) {
    // Deleted only if it still says what was read (one that couldn't be read,
    // if it still can't: the run that read it rewrote everything all the
    // same), and only while it is the same text, so a marker a deletion
    // writes meanwhile stays.
    const m = await readMarker();
    if (m === null) return;
    const same = m.pending === null ? seen.unreadable === true : !seen.unreadable && m.pending.since === seen.since && JSON.stringify(m.pending.containers) === JSON.stringify(seen.containers);
    if (same) await redis().eval(DELETE_IF_HOLDS, [KEYS_PENDING()], [m.raw]);
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

/** The backups' record's key, for the operator restore, which deletes it
 *  first (lib/restore.ts restoreArchive; see backupRecordExists). */
export const backupStatusKey = STATUS;

type Status = { last_ok: string | null; last_failed: string | null; reason: string | null; attachments?: unknown };

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
      // The receipts sweep's own record rides along unchanged (below).
      const kept = prev?.attachments !== undefined ? { attachments: prev.attachments } : {};
      const next: Status = outcome.ok
        ? { last_ok: now.toISOString(), last_failed: null, reason: null, ...kept }
        : { last_ok: prev?.last_ok ?? null, last_failed: now.toISOString(), reason: outcome.reason.slice(0, 200), ...kept };
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

/** What the dashboard says of backups. `none`: they are kept here, and no
 *  run has been recorded at all (a new deployment's first day, the night
 *  after an operator restore, or a run that never gets as far as recording
 *  itself): said, so it can't be silent for good (review nit 22). */
export type BackupProblem = { last_ok: string | null; reason: string | null; none?: true };

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
  return problemOf(status, now);
}

/** What a backups record says is wrong, or null. */
function problemOf(status: Status, now: Date): BackupProblem | null {
  if (status.last_failed) return { last_ok: status.last_ok, reason: status.reason };
  // Two days: the cron runs at 16:00 UTC, so yesterday's copy being the
  // newest is normal for most of the day.
  if (status.last_ok && now.getTime() - Date.parse(status.last_ok) > 2 * 86_400_000) {
    return { last_ok: status.last_ok, reason: null };
  }
  return null;
}

/** What the dashboard says of backups: backupProblem's, and, where backups
 *  are kept, that none has been recorded at all (`none`). From the one read
 *  backupProblem makes. Never throws. */
export async function backupNotice(now: Date = new Date()): Promise<BackupProblem | null> {
  let status: Status | null;
  try {
    status = await readStatus();
  } catch {
    return null;
  }
  if (!status) return backupRetention()?.kept ? { last_ok: null, reason: null, none: true } : null;
  return problemOf(status, now);
}

// ---- The nightly sweep of receipts and documents (lib/attachment-sweep.ts) ----
//
// Its outcome, and where it got to, kept inside the backups' own record
// (backups:status, environment-wide, plain text, no ciphertext) as its
// `attachments` field: it cleans up the same private store, and Vercel sends
// no alert for a failed cron either. A field of that record rather than a key
// of its own, since no new key family is built by hand
// (test/storage-boundary.test.ts). Each writer keeps the other's part: the
// backup's recordOutcome carries it over, and the sweep writes only it. The
// two run at different times of night (vercel.json), so the read and the
// write of one never meet the other's.

export type AttachmentSweepStatus = {
  last_ok: string | null;
  last_failed: string | null;
  reason: string | null;
  /** The container after which the next run carries on, or null to start
   *  from the first. */
  cursor: string | null;
  /** When the store-wide pass last ran. */
  listed_at: string | null;
  /** The breaker held a pass back (B1): when, and in how many accounts. */
  held?: { at: string; containers: number };
};

/** The sweep's record, or null when none was ever kept (or it can't be
 *  parsed: then the sweep starts from the first account, which only redoes
 *  work). Throws when storage fails. */
export async function readAttachmentSweep(): Promise<AttachmentSweepStatus | null> {
  let status: Status | null;
  try {
    status = await readStatus();
  } catch (err) {
    if (err instanceof SyntaxError) return null;
    throw err;
  }
  return sweepOf(status);
}

/** The sweep's record inside the backups' one, or null. */
function sweepOf(status: Status | null): AttachmentSweepStatus | null {
  const parsed = status?.attachments;
  if (!parsed || typeof parsed !== 'object') return null;
  const s = parsed as Partial<AttachmentSweepStatus>;
  const iso = (v: unknown) => (typeof v === 'string' && !Number.isNaN(Date.parse(v)) ? v : null);
  return {
    last_ok: iso(s.last_ok),
    last_failed: iso(s.last_failed),
    reason: typeof s.reason === 'string' ? s.reason.slice(0, 200) : null,
    cursor: typeof s.cursor === 'string' && s.cursor.length <= 64 ? s.cursor : null,
    listed_at: iso(s.listed_at),
    ...(s.held && typeof s.held === 'object' && iso(s.held.at) && Number.isInteger(s.held.containers) ? { held: { at: s.held.at, containers: s.held.containers } } : {}),
  };
}

/** Whether the backups' record is there at all. An operator restore
 *  (lib/restore.ts) deletes it as its first write, with everything else not
 *  preserved, and never writes it again: the next nightly backup does. So
 *  while backups are kept, its absence says a restore may be running (or
 *  ran since the last backup), and the receipts sweep writes nothing then
 *  (review nit 10). Throws when storage fails. */
export async function backupRecordExists(): Promise<boolean> {
  return (await redis().get<unknown>(STATUS())) !== null;
}

/** Records the sweep's record. Best effort, given up on after RECORD_LIMIT_MS. */
export async function recordAttachmentSweep(status: AttachmentSweepStatus): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`took longer than ${RECORD_LIMIT_MS / 1000}s`)), RECORD_LIMIT_MS);
    });
    const write = async () => {
      let prev: Status | null = null;
      try {
        prev = await readStatus();
      } catch (err) {
        if (!(err instanceof SyntaxError)) throw err;
      }
      const next: Status = { last_ok: prev?.last_ok ?? null, last_failed: prev?.last_failed ?? null, reason: prev?.reason ?? null, attachments: status };
      await redis().set(STATUS(), JSON.stringify(next));
    };
    await Promise.race([write(), timeout]);
  } catch (err) {
    console.error('Receipts sweep outcome not recorded', err instanceof Error ? err.message : err);
  } finally {
    clearTimeout(timer);
  }
}

/** `paused`: backups are kept and their record isn't there, so the sweep
 *  writes nothing (lib/attachment-sweep.ts): said, never silent. */
export type AttachmentSweepProblem = { last_ok: string | null; reason: string | null; held: boolean; paused?: true };

/** Something the dashboard should say about the sweep, or null: its last run
 *  failed, its breaker held a pass back in the last week, or none has
 *  succeeded for nine days (it walks every account at least weekly). Null
 *  when it never ran (no files kept here) or the record can't be read: a
 *  notice, never a reason to fail a page. */
export async function attachmentSweepProblem(now: Date = new Date()): Promise<AttachmentSweepProblem | null> {
  let status: Status | null;
  try {
    status = await readStatus();
  } catch {
    return null;
  }
  // Paused while the backups' record isn't there (review nit 22), where
  // files can be kept at all (a master key: lib/attachments.ts).
  if (!status) return backupRetention()?.kept && masterKeyConfigured() ? { last_ok: null, reason: null, held: false, paused: true } : null;
  const s = sweepOf(status);
  if (!s) return null;
  if (s.last_failed) return { last_ok: s.last_ok, reason: s.reason, held: false };
  if (s.held && now.getTime() - Date.parse(s.held.at) < 7 * 86_400_000) return { last_ok: s.last_ok, reason: null, held: true };
  if (s.last_ok && now.getTime() - Date.parse(s.last_ok) > 9 * 86_400_000) return { last_ok: s.last_ok, reason: null, held: false };
  return null;
}
