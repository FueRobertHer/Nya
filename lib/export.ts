// lib/export.ts
//
// A complete, restorable copy of this environment's data, as NDJSON.
//
// The data here cannot be re-fetched: Plaid won't re-serve transactions a bank
// has aged out, and no institution serves daily balance history at all, because
// nothing but this app records it. So a copy must exist, and be shown to
// restore, before any risky change (key renames, a cipher format change).
//
// THREE RULES:
//
// 1. CIPHERTEXT VERBATIM, NEVER DECRYPTED. Decrypting would put years of
//    financial data in plaintext in function memory and possibly logs, and make
//    a restore re-encrypt rather than reproduce. The cost is that the archive is
//    useless without the keys: PLAID_ENCRYPTION_KEY for values still under k0,
//    and MASTER_KEY for everything under a data key (the data keys travel in the
//    archive, wrapped). Keep those somewhere the database is not.
//
// 2. EXACT BYTES. Values are read through rawRedis(), not redis(): the default
//    client JSON-parses on the way out, so a stored "1" would be archived as the
//    number 1 and restore would write back something the app never wrote.
//
// 3. PROVABLY COMPLETE. The last line is a footer with a key count and a SHA-256
//    over the header and every record line. A download cut off mid-stream has no
//    footer, and one damaged in storage or transit fails the hash; restore
//    refuses both, since a partial archive restored over real data is worse than
//    none. The hash catches accidents, not a deliberate edit (anyone can
//    recompute it).
//
// NOT A POINT-IN-TIME SNAPSHOT. Keys are read a batch at a time, so a write
// landing mid-export can leave two keys from different moments. Avoid running it
// around 13:00 UTC, when the snapshot cron writes.
//
// Format:
//   {"nya_export":1,"schema_era":"unscoped","env_prefix":"production",...}
//   {"key":"budgets","type":"string","ttl":null,"value":"<ciphertext>"}
//   {"key":"history:net-worth","type":"hash","ttl":null,"value":{"2026-01-01":"<ciphertext>",...}}
//   {"end":true,"keys":2,"sha256":"<hex>","unsupported":[]}
//
// The sha256 covers the UTF-8 bytes of the header line and every record line,
// each including its trailing "\n", in file order (not the footer). Restore
// recomputes it over the lines exactly as read, never over re-serialized JSON,
// which can reorder keys.
//
// Keys are stored WITHOUT the environment prefix and the header records which
// prefix they came from, so restore can write them into a different namespace
// (a restore-test copy) without rewriting every line.

import { createHash } from 'node:crypto';
import { envPrefix } from './storage';
import { splitScoped } from './containers';

export const EXPORT_FORMAT_VERSION = 1;

/**
 * Which key layout the archive was taken under. "containers": stored data is
 * inside containers (#53). An archive from before that ("unscoped") restored
 * now would repopulate keys nothing reads any more, so restore compares this
 * against the running code and refuses a mismatch.
 */
export const SCHEMA_ERA = 'containers';

/**
 * Deliberately left out. None is data, and each would be wrong after a restore:
 *   - cache entries would show numbers from the moment of export as current;
 *   - rate-limit counters would lock out a login they were never about;
 *   - sync and account-link locks would block work that isn't running;
 *   - an old session epoch would bring back sessions revoked since
 *     (lib/sessions.ts);
 *   - the snapshot cron's log and lock describe the cron that wrote them
 *     (lib/snapshot-job.ts);
 *   - the data move's record would vouch for values it never copied, and a later
 *     move could overwrite them (lib/move.ts);
 *   - a forget's progress names points of a fold the restored data may not match
 *     (lib/history.ts foldHiddenAccount);
 *   - the nightly backup's last outcome would describe backups of another moment
 *     (lib/backup.ts);
 *   - unused invite links last hours, and a restored one would work again
 *     (lib/sharing.ts).
 */
export const EXCLUDED_PREFIXES = ['cache:', 'ratelimit:', 'invtxns-lock:', 'sessions:', 'snapshot:', 'move:', 'account-links:lock', 'history:forgetting:', 'backups:', 'invites:'] as const;

/** Page size for HSCAN. history:accounts gains a field every day, and one
 *  HGETALL of years of it would be one oversized response. */
const PAGE = 200;

/** Page size for SCAN. Larger than PAGE because SCAN returns only names, and
 *  it walks every environment in the shared database (the match filters after
 *  the walk), so the page count is set by the whole database, not this
 *  environment. */
const SCAN_PAGE = 1000;

/**
 * Keys read together. Every command is its own HTTPS request to Upstash, so
 * reading key by key (TYPE, GET or HSCAN, TTL) cost three or more round trips
 * per key and the nightly backup outgrew its time limit. A batch costs a
 * handful of pipelines instead: TYPE, STRLEN, the values, one per extra page of
 * its largest hash, and TTL.
 */
const BATCH = 100;

/** Most string bytes one pipeline fetches. One Item's transaction blob alone
 *  can be 8 MiB, and a batch holding several would be one oversized response;
 *  a string larger than this is fetched on its own. */
const PIPELINE_BYTES = 8 * 1024 * 1024;

export type ExportHeader = {
  nya_export: typeof EXPORT_FORMAT_VERSION;
  schema_era: string;
  env_prefix: string;
  /** Always null; present so the field need not be added to a format that
   *  archives already use. */
  container_id: string | null;
  taken_at: string;
  excluded: string[];
};

export type ExportRecord =
  | { key: string; type: 'string'; ttl: number | null; value: string }
  | { key: string; type: 'hash'; ttl: number | null; value: Record<string, string> };

export type ExportFooter = {
  end: true;
  keys: number;
  sha256: string;
  /** Keys of a type this format cannot carry. None exist today; listed rather
   *  than skipped silently, so a future list or set cannot vanish from backups
   *  without anyone noticing. */
  unsupported: { key: string; type: string }[];
};

/** The subset of the Upstash client this walks. Kept narrow so the fake used
 *  in tests and the real raw client both satisfy it. */
export type ExportClient = {
  scan(cursor: string | number, opts: { match: string; count: number }): Promise<[string | number, string[]]>;
  hscan(key: string, cursor: string | number, opts: { count: number }): Promise<[string | number, unknown[]]>;
  type(key: string): Promise<string>;
  get(key: string): Promise<unknown>;
  ttl(key: string): Promise<number>;
  pipeline(): ExportPipeline;
};

/** Upstash's pipeline, narrowed to what the export queues. Commands run in
 *  order in one request; exec throws if any of them failed. */
export type ExportPipeline = {
  type(key: string): unknown;
  get(key: string): unknown;
  strlen(key: string): unknown;
  hscan(key: string, cursor: string | number, opts: { count: number }): unknown;
  ttl(key: string): unknown;
  exec(): Promise<unknown[]>;
};

/** One command per key in a single pipeline, answers in key order. Nothing is
 *  sent for no keys: Upstash refuses an empty pipeline. */
async function pipelined(client: ExportClient, keys: string[], queue: (p: ExportPipeline, key: string) => void): Promise<unknown[]> {
  if (keys.length === 0) return [];
  const p = client.pipeline();
  for (const key of keys) queue(p, key);
  return p.exec();
}

/** Whether a key (relative to the environment prefix) is left out, judged by
 *  the key inside its container if it is in one: a container's cache is as
 *  disposable as any other. Restore refuses the same keys. */
export function isExcluded(relative: string): boolean {
  const { key } = splitScoped(relative);
  return EXCLUDED_PREFIXES.some((p) => key.startsWith(p));
}

/**
 * A raw value that is not a string means the client is deserializing, and the
 * archive would not be byte-exact. Thrown rather than coerced: the stream then
 * ends without a footer, and restore refuses it.
 */
function mustBeString(value: unknown, key: string): string {
  if (typeof value !== 'string') {
    throw new Error(`Export read a non-string value for ${key}; is the client deserializing?`);
  }
  return value;
}

async function listKeys(client: ExportClient, prefix: string): Promise<string[]> {
  // A Set because SCAN may return the same key more than once.
  const keys = new Set<string>();
  let cursor: string | number = 0;
  do {
    // lib/storage.ts guarantees the prefix is a plain segment with no glob
    // characters, so this pattern matches it literally.
    const [next, page] = await client.scan(cursor, { match: `${prefix}*`, count: SCAN_PAGE });
    for (const key of page) {
      // Checked rather than trusted: a key outside the prefix would be archived
      // under a wrong name by the slice in exportLines. Thrown, not skipped, since
      // a pattern matching something unexpected means the walk can't be trusted.
      if (!key.startsWith(prefix)) throw new Error(`Scan returned a key outside ${prefix}`);
      keys.add(key);
    }
    cursor = next;
  } while (String(cursor) !== '0');
  // Sorted, with hash fields sorted too (sortedFields), so two exports of unchanged
  // data are identical, which makes them diffable.
  return [...keys].sort(byCodePoint);
}

/** Plain code-point order: stable across machines, unlike localeCompare. */
export function byCodePoint(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * A hash's fields as a record, sorted, because Redis promises no field order:
 * without it two exports of the same data would differ, and a restore's
 * read-back would see a correctly restored hash as changed. No prototype: on
 * a plain {} a field named "__proto__" would be swallowed by the setter
 * instead of stored, and the archive would drop it silently.
 */
function sortedFields(fields: Map<string, string>): Record<string, string> {
  const out: Record<string, string> = Object.create(null);
  for (const field of [...fields.keys()].sort(byCodePoint)) out[field] = fields.get(field)!;
  return out;
}

/** Groups strings, in order, so no group asks for more than PIPELINE_BYTES
 *  (a string larger than that gets a group of its own). */
function byBytes(keys: string[], lengths: unknown[]): string[][] {
  const groups: string[][] = [];
  let group: string[] = [];
  let bytes = 0;
  keys.forEach((key, i) => {
    const n = Number(lengths[i]) || 0;
    if (group.length > 0 && bytes + n > PIPELINE_BYTES) {
      groups.push(group);
      group = [];
      bytes = 0;
    }
    group.push(key);
    bytes += n;
  });
  if (group.length > 0) groups.push(group);
  return groups;
}

/**
 * The records for one batch of keys (full names, sorted), in the same order.
 * A key deleted or expired since the scan is left out; one of a type the
 * format cannot carry is added to `unsupported`. Any failed read throws.
 */
async function readBatch(
  client: ExportClient,
  prefix: string,
  batch: string[],
  unsupported: ExportFooter['unsupported']
): Promise<ExportRecord[]> {
  const types = await pipelined(client, batch, (p, key) => p.type(key));
  const strings: string[] = [];
  const hashes: string[] = [];
  batch.forEach((full, i) => {
    const type = types[i];
    if (type === 'string') strings.push(full);
    else if (type === 'hash') hashes.push(full);
    else if (type !== 'none') unsupported.push({ key: full.slice(prefix.length), type: String(type) });
    // 'none': deleted since the scan
  });

  const values = new Map<string, string | Record<string, string>>();

  const lengths = await pipelined(client, strings, (p, key) => p.strlen(key));
  for (const group of byBytes(strings, lengths)) {
    const got = await pipelined(client, group, (p, key) => p.get(key));
    group.forEach((full, i) => {
      if (got[i] === null) return; // deleted since the scan
      values.set(full, mustBeString(got[i], full.slice(prefix.length)));
    });
  }

  // One page of every unfinished hash per pipeline, until all are read through.
  // A Map per hash, so a field SCAN repeats is kept once.
  const fields = new Map(hashes.map((full) => [full, new Map<string, string>()]));
  let cursors = new Map<string, string | number>(hashes.map((full) => [full, 0]));
  while (cursors.size > 0) {
    const open = [...cursors.keys()];
    const pages = await pipelined(client, open, (p, key) => p.hscan(key, cursors.get(key)!, { count: PAGE }));
    const next = new Map<string, string | number>();
    open.forEach((full, i) => {
      const [cursor, flat] = pages[i] as [string | number, unknown[]];
      const key = full.slice(prefix.length);
      const map = fields.get(full)!;
      for (let j = 0; j + 1 < flat.length; j += 2) map.set(mustBeString(flat[j], key), mustBeString(flat[j + 1], key));
      if (String(cursor) !== '0') next.set(full, cursor);
    });
    cursors = next;
  }
  for (const [full, map] of fields) {
    if (map.size > 0) values.set(full, sortedFields(map)); // empty: deleted since the scan
  }

  // Read after the values, so a key that expired while they were read is caught.
  const present = batch.filter((full) => values.has(full));
  const ttls = await pipelined(client, present, (p, key) => p.ttl(key));
  const records: ExportRecord[] = [];
  present.forEach((full, i) => {
    const ttl = Number(ttls[i]);
    if (ttl === -2) return; // expired while being read
    const key = full.slice(prefix.length);
    const value = values.get(full)!;
    // Seconds left, or null for a key with no expiry.
    records.push(
      typeof value === 'string'
        ? { key, type: 'string', ttl: ttl > 0 ? ttl : null, value }
        : { key, type: 'hash', ttl: ttl > 0 ? ttl : null, value }
    );
  });
  return records;
}

/**
 * The archive, one line at a time, each ending in "\n".
 *
 * A generator so the route can stream it: one Item's transaction blob alone can
 * be 8 MiB, and holding every key before sending the first byte would scale the
 * function's memory with the database. Only one batch (BATCH keys) is held.
 *
 * Throws mid-stream on any read failure. That is intended: the consumer sees a
 * truncated archive with no footer, which restore rejects, rather than a
 * complete-looking one with a key missing.
 */
export async function* exportLines(
  client: ExportClient,
  now: Date = new Date()
): AsyncGenerator<string> {
  const prefix = envPrefix();

  const header: ExportHeader = {
    nya_export: EXPORT_FORMAT_VERSION,
    schema_era: SCHEMA_ERA,
    env_prefix: prefix.replace(/:$/, ''),
    container_id: null,
    taken_at: now.toISOString(),
    // Inside a container too (isExcluded).
    excluded: EXCLUDED_PREFIXES.flatMap((p) => [`${p}*`, `c:*:${p}*`]),
  };
  const hash = createHash('sha256');
  const headerLine = JSON.stringify(header) + '\n';
  // Hashed so the era and prefix restore relies on are covered too.
  hash.update(headerLine);
  yield headerLine;

  const unsupported: ExportFooter['unsupported'] = [];
  let count = 0;

  const keys = (await listKeys(client, prefix)).filter((full) => !isExcluded(full.slice(prefix.length)));
  for (let i = 0; i < keys.length; i += BATCH) {
    for (const record of await readBatch(client, prefix, keys.slice(i, i + BATCH), unsupported)) {
      const line = JSON.stringify(record) + '\n';
      hash.update(line);
      count++;
      yield line;
    }
  }

  const footer: ExportFooter = { end: true, keys: count, sha256: hash.digest('hex'), unsupported };
  yield JSON.stringify(footer) + '\n';
}
