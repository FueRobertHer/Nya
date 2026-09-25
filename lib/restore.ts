// lib/restore.ts
//
// Writes an archive from lib/export.ts back into Redis, under THIS process's
// key prefix. Driven by scripts/restore.ts, never by an HTTP route: a Vercel
// function accepts at most about 4.5 MB of request body, and one Item's
// transaction blob alone can be 8 MiB, so an upload route could not take a real
// archive. Running locally also means nothing on the internet can overwrite the
// database.
//
// THE ORDER IS THE SAFETY:
//
// 1. VERIFY EVERYTHING BEFORE WRITING ANYTHING. The whole file is checked
//    (format, era, footer, hash, count, every record's shape) before the first
//    write. A bad archive is refused while the target is still untouched.
//
// 2. REFUSE A POPULATED TARGET unless told to overwrite, and the caller takes a
//    fresh export of it before anything is deleted (scripts/restore.ts does).
//
// 3. REPLACE, DON'T MERGE. Overwrite deletes every key under the prefix first
//    (except login rate limits), so the result is exactly the archive: no stray
//    Item from after the backup, no hash field the archive does not have. That
//    is also what makes a re-run after a crash safe: it starts clean again.
//
// 4. READ IT ALL BACK. After writing, the target is exported again and compared
//    record for record with the archive. Only an exact match is reported as a
//    restore; anything else throws.

import { createHash } from 'node:crypto';
import { k, kEnv } from './storage';
import { splitScoped } from './containers';
import {
  byCodePoint,
  isExcluded,
  EXPORT_FORMAT_VERSION,
  SCHEMA_ERA,
  exportLines,
  type ExportClient,
  type ExportHeader,
  type ExportRecord,
} from './export';

/** A refusal: the archive or the target is not safe to restore. Distinct from
 *  an ordinary Error so the CLI can say "refused" rather than "crashed". */
export class RestoreRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RestoreRefused';
  }
}

export type VerifiedArchive = {
  header: ExportHeader;
  records: ExportRecord[];
};

/** Stay well under Upstash's per-request limit when writing a large hash. */
const HSET_CHUNK_CHARS = 512 * 1024;

/**
 * The shortest expiry a restored key is given. The archive records seconds
 * remaining at export time; a key restored with only a few left could expire
 * between being written and being read back, and fail a restore that worked.
 * A TTL only ever marks disposable data, so a short extension costs nothing.
 */
const MIN_RESTORED_TTL = 60;

/** Never deleted by an overwrite: a counter of failed logins belongs to the
 *  running environment, not to the data being restored. */
const PRESERVED_PREFIX = 'ratelimit:';

function refuse(message: string): never {
  throw new RestoreRefused(message);
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function parseLine(line: string, n: number): unknown {
  try {
    return JSON.parse(line);
  } catch {
    refuse(`Line ${n} is not valid JSON.`);
  }
}

function checkRecord(raw: unknown, n: number): ExportRecord {
  if (!isPlainObject(raw)) refuse(`Line ${n} is not a record.`);
  const { key, type, ttl, value } = raw;

  if (typeof key !== 'string' || key.length === 0) refuse(`Line ${n} has no key.`);
  if (isExcluded(key)) {
    refuse(`Line ${n} holds ${key}, which exports never include.`);
  }
  if (ttl !== null && !(Number.isInteger(ttl) && (ttl as number) > 0)) {
    refuse(`Line ${n} (${key}) has an invalid ttl.`);
  }

  if (type === 'string') {
    if (typeof value !== 'string') refuse(`Line ${n} (${key}) is a string with a non-string value.`);
    return { key, type, ttl: ttl as number | null, value };
  }
  if (type === 'hash') {
    if (!isPlainObject(value)) refuse(`Line ${n} (${key}) is a hash with no fields object.`);
    const entries = Object.entries(value);
    // Redis cannot hold an empty hash, and HSET with no fields is an error.
    if (entries.length === 0) refuse(`Line ${n} (${key}) is an empty hash.`);
    if (entries.some(([, v]) => typeof v !== 'string')) {
      refuse(`Line ${n} (${key}) has a non-string hash value.`);
    }
    return { key, type, ttl: ttl as number | null, value: value as Record<string, string> };
  }
  refuse(`Line ${n} (${key}) has unknown type ${JSON.stringify(type)}.`);
}

/**
 * Check an archive completely, or throw RestoreRefused naming the first
 * problem. Pure: touches no storage, so it is safe to run against anything.
 */
export function verifyArchive(text: string): VerifiedArchive {
  // Every line, footer included, ends in "\n". Anything after the final one is
  // either a truncated line or something appended; either way not ours.
  // Named specifically: an editor or a Windows download converting line
  // endings would otherwise surface as a baffling checksum mismatch.
  if (text.includes('\r\n')) {
    refuse('The file has Windows (CRLF) line endings, so it was converted after export. Use the original download.');
  }
  if (!text.endsWith('\n')) refuse('The file does not end with a complete line; it may be cut short.');
  const lines = text.slice(0, -1).split('\n');
  if (lines.length < 2) refuse('The file has no footer; it is incomplete.');

  const header = parseLine(lines[0], 1);
  if (!isPlainObject(header) || !('nya_export' in header)) refuse('Line 1 is not a Nya export header.');
  if (header.nya_export !== EXPORT_FORMAT_VERSION) {
    refuse(`Archive format ${JSON.stringify(header.nya_export)} is not one this code can read.`);
  }
  // An archive from another key layout would restore keys nothing reads.
  if (header.schema_era !== SCHEMA_ERA) {
    refuse(
      `Archive was taken under key layout ${JSON.stringify(header.schema_era)}; this code uses ${JSON.stringify(SCHEMA_ERA)}.`
    );
  }

  const footer = parseLine(lines[lines.length - 1], lines.length);
  if (!isPlainObject(footer) || footer.end !== true) refuse('The last line is not a footer; the file is incomplete.');

  const hash = createHash('sha256');
  hash.update(lines[0] + '\n');
  const records: ExportRecord[] = [];
  const seen = new Set<string>();
  for (let i = 1; i < lines.length - 1; i++) {
    const n = i + 1;
    const parsed = parseLine(lines[i], n);
    if (isPlainObject(parsed) && parsed.end === true) refuse(`Line ${n} is a footer before the end of the file.`);
    const record = checkRecord(parsed, n);
    if (seen.has(record.key)) refuse(`Line ${n} repeats ${record.key}.`);
    seen.add(record.key);
    // The raw line, exactly as read: re-serializing could reorder hash fields.
    hash.update(lines[i] + '\n');
    records.push(record);
  }

  if (footer.keys !== records.length) {
    refuse(`Footer says ${JSON.stringify(footer.keys)} keys but the file holds ${records.length}.`);
  }
  if (footer.sha256 !== hash.digest('hex')) refuse('Checksum mismatch: the file was damaged or edited.');
  if (!Array.isArray(footer.unsupported) || footer.unsupported.length > 0) {
    refuse('The export could not carry some keys (see the footer), so restoring it would lose them.');
  }

  // Every container the archive's keys live in must be in its own registry:
  // otherwise it would restore data under a container that, once restored,
  // does not exist.
  const registry = archiveRegistry(records);
  for (const record of records) {
    const { container } = splitScoped(record.key);
    if (container && !registry?.has(container)) {
      refuse(`${record.key} is in container ${container}, which the archive's registry does not list.`);
    }
  }

  return { header: header as ExportHeader, records };
}

/** The key the container registry lives at, relative to the prefix (see
 *  lib/containers.ts; environment-wide, so never inside a container). */
const REGISTRY = 'containers';

/** The container ids in an archive's registry, or null if it has none. */
export function archiveRegistry(records: ExportRecord[]): Set<string> | null {
  const r = records.find((x) => x.key === REGISTRY);
  return r && r.type === 'hash' ? new Set(Object.keys(r.value)) : null;
}

/** The container ids in the target's registry, or null if it has none. */
export async function targetRegistry(client: ExportClient): Promise<Set<string> | null> {
  const ids = new Set<string>();
  let cursor: string | number = 0;
  do {
    const [next, flat] = await client.hscan(kEnv('containers'), cursor, { count: 200 });
    for (let i = 0; i + 1 < flat.length; i += 2) ids.add(String(flat[i]));
    cursor = next;
  } while (String(cursor) !== '0');
  return ids.size > 0 ? ids : null;
}

/**
 * A restore replaces the container registry along with everything else. That
 * is only safe when the archive's registry lists the same containers as the
 * target's: deployments name their container in CONTAINER_ID, and after a
 * restore that dropped it (an archive from before containers existed, or from
 * another environment) every one of them would name a container that no
 * longer exists. Refused unless `replaceRegistry`, after which CONTAINER_ID
 * must be set again to a container the restored registry lists (or a new one
 * created).
 */
export function checkRegistry(archive: Set<string> | null, target: Set<string> | null, replaceRegistry: boolean): void {
  if (!target || replaceRegistry) return;
  const same = archive !== null && archive.size === target.size && [...target].every((id) => archive.has(id));
  if (same) return;
  const had = [...target].join(', ');
  refuse(
    archive
      ? `The archive's containers (${[...archive].join(', ')}) are not the target's (${had}). Deployments name their container in CONTAINER_ID, which would then name one that does not exist. Pass --replace-registry to restore anyway, then set CONTAINER_ID to a container the archive lists.`
      : `The archive has no container registry (it predates containers), so restoring it would remove the target's (${had}), and CONTAINER_ID would name a container that does not exist. Pass --replace-registry to restore anyway, then create a container again and set CONTAINER_ID.`
  );
}

/** The storage commands a restore needs, on top of reading everything back. */
export type RestoreClient = ExportClient & {
  set(key: string, value: string, opts?: { ex: number }): Promise<unknown>;
  hset(key: string, fields: Record<string, string>): Promise<unknown>;
  expire(key: string, seconds: number): Promise<unknown>;
  del(...keys: string[]): Promise<unknown>;
};

/** Every key under this process's prefix, found by scanning. */
async function keysUnderPrefix(client: RestoreClient): Promise<string[]> {
  const prefix = k('');
  const keys = new Set<string>();
  let cursor: string | number = 0;
  do {
    const [next, page] = await client.scan(cursor, { match: `${prefix}*`, count: 200 });
    for (const key of page) {
      if (!key.startsWith(prefix)) throw new Error(`Scan returned a key outside ${prefix}`);
      keys.add(key);
    }
    cursor = next;
  } while (String(cursor) !== '0');
  return [...keys];
}

/**
 * Keys that make the target count as holding data. Rate-limit counters do not:
 * they appear the moment anyone tries to log in, and are not data.
 */
export async function targetKeys(client: RestoreClient): Promise<string[]> {
  const prefix = k('');
  return (await keysUnderPrefix(client)).filter((key) => !key.slice(prefix.length).startsWith(PRESERVED_PREFIX));
}

/**
 * Confirm the operator is pointing at the namespace they think they are.
 *
 * The prefix comes from the environment (REDIS_PREFIX), never the command line,
 * the same rule as the export. The command line must NAME it too, so a stale
 * shell variable cannot quietly aim a restore somewhere else. Production needs
 * a separate, explicit confirmation on top.
 */
export function checkTarget(named: string | undefined, confirmProduction: boolean): string {
  const actual = k('').replace(/:$/, '');
  if (!named) refuse(`Name the target with --target. This process would write to "${actual}".`);
  if (named !== actual) {
    refuse(`--target is "${named}" but REDIS_PREFIX resolves to "${actual}". Nothing was written.`);
  }
  if (actual === 'production' && !confirmProduction) {
    refuse('Restoring into production also needs --confirm-production.');
  }
  return actual;
}

/** Split a hash into HSET-sized chunks by payload size. */
function chunkFields(value: Record<string, string>): Record<string, string>[] {
  const chunks: Record<string, string>[] = [];
  let current: Record<string, string> = Object.create(null);
  let size = 0;
  for (const [field, v] of Object.entries(value)) {
    const cost = field.length + v.length;
    if (size > 0 && size + cost > HSET_CHUNK_CHARS) {
      chunks.push(current);
      current = Object.create(null);
      size = 0;
    }
    current[field] = v;
    size += cost;
  }
  if (size > 0) chunks.push(current);
  return chunks;
}

/**
 * A record's comparable form. TTLs count down, so only their presence is
 * compared. Hash fields are compared as a sorted list of pairs: Redis promises
 * no field order, so a correctly restored hash can come back in a different
 * order, and comparing objects as serialized would call that a mismatch. Pairs
 * rather than an object also keep a "__proto__" field in the comparison.
 */
function comparable(record: ExportRecord): string {
  const ttl = record.ttl === null ? null : 'set';
  if (record.type === 'string') return JSON.stringify([record.key, 'string', ttl, record.value]);
  const pairs = Object.entries(record.value).sort(([a], [b]) => byCodePoint(a, b));
  return JSON.stringify([record.key, 'hash', ttl, pairs]);
}

export type RestoreResult = { written: number; deleted: number };

/**
 * Write a verified archive into this process's namespace.
 *
 * The target must be empty unless `overwrite` is set. When it holds anything,
 * `backedUp` must list exactly the keys the caller saved before calling, and
 * the target must still hold exactly those: only keys that are in a backup are
 * ever deleted. A key written after the backup, or a target that filled up
 * after being checked empty, is refused rather than lost. Throws on any write
 * failure and on any difference found reading it back.
 */
export async function restoreArchive(
  client: RestoreClient,
  archive: VerifiedArchive,
  opts: { overwrite: boolean; backedUp?: string[]; replaceRegistry?: boolean }
): Promise<RestoreResult> {
  const prefix = k('');
  const existing = await targetKeys(client);
  if (existing.length > 0 && !opts.overwrite) {
    refuse(`The target holds ${existing.length} keys. Pass --overwrite to replace them.`);
  }
  if (existing.length > 0) {
    if (!opts.backedUp) refuse('The target holds data and no backup of it was taken.');
    const saved = new Set(opts.backedUp);
    if (existing.length !== saved.size || existing.some((key) => !saved.has(key))) {
      refuse('The target changed after it was backed up. Nothing was deleted; run the restore again.');
    }
  }

  checkRegistry(archiveRegistry(archive.records), await targetRegistry(client), opts.replaceRegistry ?? false);

  // Delete first: replace, don't merge. Includes caches, which would otherwise
  // show numbers computed from the data being replaced.
  const BATCH = 100;
  for (let i = 0; i < existing.length; i += BATCH) {
    await client.del(...existing.slice(i, i + BATCH));
  }

  for (const record of archive.records) {
    const full = prefix + record.key;
    if (record.type === 'string') {
      await client.set(full, record.value, record.ttl ? { ex: Math.max(record.ttl, MIN_RESTORED_TTL) } : undefined);
    } else {
      for (const chunk of chunkFields(record.value)) await client.hset(full, chunk);
      if (record.ttl) await client.expire(full, Math.max(record.ttl, MIN_RESTORED_TTL));
    }
  }

  // Read back through the same code the export uses, so "identical" means
  // "a fresh export of the target would reproduce this archive".
  const expected = archive.records.map(comparable);
  const actual: string[] = [];
  let footerSeen = false;
  for await (const line of exportLines(client)) {
    const parsed = JSON.parse(line);
    if ('nya_export' in parsed) continue;
    if (parsed.end === true) {
      footerSeen = true;
      if (parsed.unsupported.length > 0) throw new Error('Read-back found keys of an unsupported type.');
      continue;
    }
    actual.push(comparable(parsed));
  }
  if (!footerSeen) throw new Error('Read-back did not complete.');

  // Export sorts by key; the archive was sorted the same way when taken, but
  // sort both rather than trust that.
  expected.sort();
  actual.sort();
  if (expected.length !== actual.length || expected.some((e, i) => e !== actual[i])) {
    const missing = expected.filter((e) => !actual.includes(e)).length;
    const extra = actual.filter((a) => !expected.includes(a)).length;
    throw new Error(
      `Read-back does not match the archive (${missing} records missing or different, ${extra} unexpected). The target is in an unknown state; restore from the pre-restore export.`
    );
  }

  return { written: archive.records.length, deleted: existing.length };
}
