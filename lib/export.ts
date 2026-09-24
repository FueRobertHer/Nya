// lib/export.ts
//
// A complete, restorable copy of this environment's data, as NDJSON.
//
// WHY THIS EXISTS BEFORE ANY MIGRATION. The data here cannot be re-fetched.
// Plaid will not re-serve transactions a bank has aged out, and no institution
// serves daily balance history at all, because nothing but this app records it.
// Phase 0 renames every key and changes the cipher format. Neither is safe to
// attempt over irreplaceable data until a copy exists and has been shown to
// restore.
//
// THREE RULES, each for a reason:
//
// 1. CIPHERTEXT VERBATIM, NEVER DECRYPTED. Decrypting would put years of
//    financial data in plaintext in function memory and possibly in logs, and
//    would make a restore re-encrypt rather than reproduce. The cost is that
//    the archive is useless without the keys: PLAID_ENCRYPTION_KEY for values
//    still under k0, and MASTER_KEY for everything under a data key (the data
//    keys themselves travel in the archive, wrapped). Keep those somewhere the
//    database is not.
//
// 2. EXACT BYTES. Values are read through rawRedis(), not redis(). The default
//    client JSON-parses on the way out, so a stored "1" would be archived as
//    the number 1 and restore would write back something the app never wrote.
//
// 3. PROVABLY COMPLETE. The last line is a footer with a key count and a
//    SHA-256 over the header and every record line. A download cut off
//    mid-stream has no footer, and one damaged in storage or transit fails the
//    hash. Restore refuses both, because a partial archive restored over real
//    data is worse than no archive. The hash is an integrity check, not a
//    signature: it catches accidents, and anyone deliberately editing the file
//    can recompute it.
//
// NOT A POINT-IN-TIME SNAPSHOT. Keys are read one after another, so a write
// landing mid-export can leave two keys from different moments. Avoid running
// it around 13:00 UTC, when the snapshot cron writes.
//
// Format:
//   {"nya_export":1,"schema_era":"unscoped","env_prefix":"production",...}
//   {"key":"budgets","type":"string","ttl":null,"value":"<ciphertext>"}
//   {"key":"history:net-worth","type":"hash","ttl":null,"value":{"2026-01-01":"<ciphertext>",...}}
//   {"end":true,"keys":2,"sha256":"<hex>","unsupported":[]}
//
// The sha256 covers the UTF-8 bytes of the header line and every record line,
// each including its trailing "\n", in file order. Not the footer. Restore
// recomputes it over the lines exactly as read, never over re-serialized JSON,
// since re-serializing can reorder keys.
//
// Keys are stored WITHOUT the environment prefix, and the header records which
// prefix they came from, so restore can write them into a different namespace
// (a restore-test copy) without rewriting every line.

import { createHash } from 'node:crypto';
import { k } from './storage';

export const EXPORT_FORMAT_VERSION = 1;

/**
 * Which key layout the archive was taken under. The container-scoping work
 * (#53) moves every key; an archive from before that restored after it would
 * silently repopulate keys nothing reads any more. Restore compares this against
 * the running code and refuses a mismatch.
 */
export const SCHEMA_ERA = 'unscoped';

/**
 * Deliberately left out. Both are disposable and both would be wrong after a
 * restore: a cache entry would show numbers from the moment of export as if
 * current, and a rate-limit counter would lock out a login it was never about.
 */
export const EXCLUDED_PREFIXES = ['cache:', 'ratelimit:'] as const;

/** Page size for SCAN and HSCAN. history:accounts gains a field every day, and
 *  one HGETALL of years of it would be one oversized response. */
const PAGE = 200;

export type ExportHeader = {
  nya_export: typeof EXPORT_FORMAT_VERSION;
  schema_era: string;
  env_prefix: string;
  /** Always null until containers exist (#53); present now so the field does
   *  not have to be added to a format that archives already use. */
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
};

function isExcluded(relative: string): boolean {
  return EXCLUDED_PREFIXES.some((p) => relative.startsWith(p));
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
    const [next, page] = await client.scan(cursor, { match: `${prefix}*`, count: PAGE });
    for (const key of page) {
      // Checked rather than trusted. A key outside the prefix would otherwise
      // be archived under a wrong name by the slice in exportLines. Thrown, not
      // skipped: a pattern that matched something unexpected means the walk
      // cannot be trusted at all.
      if (!key.startsWith(prefix)) throw new Error(`Scan returned a key outside ${prefix}`);
      keys.add(key);
    }
    cursor = next;
  } while (String(cursor) !== '0');
  // Sorted, with hash fields sorted too (readHash), so two exports of unchanged
  // data are identical, which makes them diffable.
  return [...keys].sort(byCodePoint);
}

/** Plain code-point order: stable across machines, unlike localeCompare. */
export function byCodePoint(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

async function readHash(client: ExportClient, key: string): Promise<Record<string, string>> {
  // No prototype: on a plain {} a field named "__proto__" would be swallowed by
  // the setter instead of stored, and the archive would drop it silently.
  const fields = new Map<string, string>(); // a Map, so a repeated field is kept once
  let cursor: string | number = 0;
  do {
    const [next, flat] = await client.hscan(key, cursor, { count: PAGE });
    for (let i = 0; i + 1 < flat.length; i += 2) {
      fields.set(mustBeString(flat[i], key), mustBeString(flat[i + 1], key));
    }
    cursor = next;
  } while (String(cursor) !== '0');

  // Sorted, because Redis promises no field order: two HSCANs of an unchanged
  // hash can disagree, and a hash written back in one order can scan out in
  // another. Without this, two exports of the same data would differ and a
  // restore's read-back would see a correctly restored hash as changed.
  // (Integer-like field names still serialize first, in numeric order, since
  // that is how JS orders object keys. Deterministic either way.)
  const out: Record<string, string> = Object.create(null);
  for (const field of [...fields.keys()].sort(byCodePoint)) out[field] = fields.get(field)!;
  return out;
}

/** Seconds left, or null for a key with no expiry. -2 means it is gone. */
async function readTtl(client: ExportClient, key: string): Promise<number | null | 'gone'> {
  const ttl = await client.ttl(key);
  if (ttl === -2) return 'gone';
  return ttl > 0 ? ttl : null;
}

/**
 * The archive, one line at a time, each ending in "\n".
 *
 * A generator so the route can stream it: one Item's transaction blob alone can
 * be 8 MiB, and holding every key before sending the first byte would scale the
 * function's memory with the database.
 *
 * Throws mid-stream on any read failure. That is intended: the consumer sees a
 * truncated archive with no footer, which restore rejects, rather than a
 * complete-looking one with a key missing.
 */
export async function* exportLines(
  client: ExportClient,
  now: Date = new Date()
): AsyncGenerator<string> {
  const prefix = k('');

  const header: ExportHeader = {
    nya_export: EXPORT_FORMAT_VERSION,
    schema_era: SCHEMA_ERA,
    env_prefix: prefix.replace(/:$/, ''),
    container_id: null,
    taken_at: now.toISOString(),
    excluded: EXCLUDED_PREFIXES.map((p) => `${p}*`),
  };
  const hash = createHash('sha256');
  const headerLine = JSON.stringify(header) + '\n';
  // Hashed so the era and prefix restore relies on are covered too.
  hash.update(headerLine);
  yield headerLine;

  const unsupported: ExportFooter['unsupported'] = [];
  let count = 0;

  for (const full of await listKeys(client, prefix)) {
    const key = full.slice(prefix.length);
    if (isExcluded(key)) continue;

    const type = await client.type(full);
    let record: ExportRecord;

    if (type === 'string') {
      const value = await client.get(full);
      if (value === null) continue; // deleted since the scan
      record = { key, type, ttl: null, value: mustBeString(value, key) };
    } else if (type === 'hash') {
      const value = await readHash(client, full);
      if (Object.keys(value).length === 0) continue; // deleted since the scan
      record = { key, type, ttl: null, value };
    } else if (type === 'none') {
      continue; // deleted since the scan
    } else {
      unsupported.push({ key, type });
      continue;
    }

    const ttl = await readTtl(client, full);
    if (ttl === 'gone') continue; // expired while being read
    record.ttl = ttl;

    const line = JSON.stringify(record) + '\n';
    hash.update(line);
    count++;
    yield line;
  }

  const footer: ExportFooter = { end: true, keys: count, sha256: hash.digest('hex'), unsupported };
  yield JSON.stringify(footer) + '\n';
}
