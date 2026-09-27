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
// Nothing is pruned unless this run's copy was read back intact, and the
// newest MIN_KEPT copies are always kept, whatever their age: a clock or
// retention mistake can never leave the store empty.

import { verifyArchive } from './restore';
import { exportLines, type ExportClient } from './export';
import { envPrefix } from './storage';

/** What a backup needs from object storage. Vercel Blob in production
 *  (vercelBlobStore); tests pass one kept in memory. */
export type BackupStore = {
  put(pathname: string, body: string): Promise<void>;
  /** The blob's text, or null if it isn't there. */
  get(pathname: string): Promise<string | null>;
  list(prefix: string): Promise<{ pathname: string; uploadedAt: Date }[]>;
  del(pathnames: string[]): Promise<void>;
};

export const DEFAULT_KEEP_DAYS = 30;
export const MIN_KEPT = 7;

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

export async function runBackup(client: ExportClient, store: BackupStore, now: Date = new Date()): Promise<BackupResult> {
  const days = keepDays(); // before anything is written: a bad setting fails loudly first
  const parts: string[] = [];
  for await (const line of exportLines(client, now)) parts.push(line);
  const body = parts.join('');
  // Checked before upload too: an archive restore would refuse is not a backup.
  const { records } = verifyArchive(body);

  const pathname = `${backupFolder()}nya-${now.toISOString().replace(/[:.]/g, '-')}.ndjson`;
  await store.put(pathname, body);

  // Read back: what counts is what the store will hand over on the bad day.
  const stored = await store.get(pathname);
  if (stored !== body) {
    await store.del([pathname]).catch(() => {});
    throw new Error(`The backup ${pathname} did not read back as written`);
  }

  const cutoff = now.getTime() - days * 86_400_000;
  const existing = (await store.list(backupFolder())).sort((a, b) => (a.pathname < b.pathname ? 1 : -1)); // newest first
  const pruned = existing
    .slice(MIN_KEPT)
    .filter((b) => b.pathname !== pathname && b.uploadedAt.getTime() < cutoff)
    .map((b) => b.pathname);
  if (pruned.length > 0) await store.del(pruned);

  return { pathname, bytes: Buffer.byteLength(body), keys: records.length, pruned };
}

/** Vercel Blob, private, with the token Vercel sets when a store is connected
 *  to the project (BLOB_READ_WRITE_TOKEN). Null when there isn't one. */
export async function vercelBlobStore(): Promise<BackupStore | null> {
  if (!process.env.BLOB_READ_WRITE_TOKEN) return null;
  const blob = await import('@vercel/blob');
  return {
    async put(pathname, body) {
      await blob.put(pathname, body, {
        access: 'private',
        contentType: 'application/x-ndjson',
        addRandomSuffix: false,
        allowOverwrite: false,
        // Large bodies go up in parts, each retried on its own.
        multipart: body.length > 8 * 1024 * 1024,
      });
    },
    async get(pathname) {
      const res = await blob.get(pathname, { access: 'private', useCache: false });
      if (!res || res.statusCode !== 200) return null;
      return new Response(res.stream).text();
    },
    async list(prefix) {
      const out: { pathname: string; uploadedAt: Date }[] = [];
      let cursor: string | undefined;
      do {
        const page = await blob.list({ prefix, cursor });
        for (const b of page.blobs) out.push({ pathname: b.pathname, uploadedAt: new Date(b.uploadedAt) });
        cursor = page.hasMore ? page.cursor : undefined;
      } while (cursor);
      return out;
    },
    async del(pathnames) {
      if (pathnames.length > 0) await blob.del(pathnames);
    },
  };
}
