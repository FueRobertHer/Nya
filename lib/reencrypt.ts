// lib/reencrypt.ts
//
// The re-encryption pass: moves every stored value that is not under the
// active data key (all of k0, and any older data key) to it.
//
// WHY. Until this runs, everything written before data keys existed is still
// under k0 (PLAID_ENCRYPTION_KEY). Moving it is what lets a data key be
// replaced after a leak, and what would let k0 be retired one day. The same
// pass does both: whatever is not under the active key gets moved.
//
// HOW IT STAYS SAFE WHILE THE APP IS RUNNING:
//
//   - EXPLICIT LIST, NOT GUESSWORK. Every key is classified below: a string or
//     hash of ciphertext, the Plaid items (whose access token is one field of
//     a JSON value), or known plaintext. A key that is not listed is reported
//     and left alone, so a store added later cannot be missed silently; a
//     test checks every key name in lib/ is listed.
//   - COMPARE-AND-SET. Each value is written back by a small Lua script only if
//     it still hashes to what was read. A save landing mid-pass wins; the pass
//     reports that value as changed meanwhile and picks it up next time.
//   - SAME PLAINTEXT, SAME READERS. Only the encryption changes. Every reader
//     already handles both formats and every key.
//   - NEVER k0. It writes with the active key only (activeKeyForReencryption),
//     never through encrypt(), which could fall back.
//   - RESUMABLE. It keeps no state: each call walks from the start, skips what
//     is already done cheaply, and stops at a time limit. Call it until it
//     reports complete.
//
// "Complete" is a snapshot. An instance that cannot get the active key writes
// k0 (and logs it), and one that has not yet noticed a change of active key
// keeps writing the old one for up to a minute; either shows up on the next
// call. Values are never decrypted into the report: it carries key names,
// field names, counts and error types only.

import { createHash } from 'node:crypto';
import { rawRedis, k } from './storage';
import {
  activeKeyForReencryption,
  decrypt,
  encryptV2,
  formatOf,
  DecryptFailedError,
  MalformedCiphertextError,
  MasterKeyError,
  UnknownKeyError,
} from './crypto';

/** How a key's values are stored. */
export type Kind =
  | 'string' // the whole value is ciphertext
  | 'hash' // every field's value is ciphertext
  | 'items' // plaid:items: JSON values whose encrypted_access_token is ciphertext
  | 'plain'; // no ciphertext

const EXACT: Record<string, Kind> = {
  goals: 'string',
  budgets: 'string',
  'history:accounts:est:flat': 'string',

  'history:net-worth': 'hash',
  'history:net-worth:est': 'hash',
  'history:accounts': 'hash',
  'history:accounts:est': 'hash',
  'history:accounts:est:ext': 'hash',
  'history:accounts:partial': 'hash',
  'history:accounts:est:flatd': 'hash',
  'accounts:vanished': 'hash',
  'accounts:meta': 'hash',
  'accounts:directory': 'hash',
  'account-links': 'hash',
  'txn-category-overrides': 'hash',
  'txn-vendor-renames': 'hash',
  'manual:accounts': 'hash',
  'hidden:accounts': 'hash',

  'plaid:items': 'items',

  'history:backfill-done': 'plain',
  'history:backfill-pending': 'plain',
  'account-links:dismissed': 'plain',
};

const PREFIXES: [string, Kind][] = [
  ['txns:', 'string'],
  ['invtxns:', 'string'],
  ['txns-blocked:', 'plain'],
  ['invtxns-lock:', 'plain'],
  ['ratelimit:', 'plain'],
  ['cache:', 'plain'], // disposable, and gone within minutes
  ['crypto:', 'plain'], // the key store itself: wrapped keys, not data
];

/** How a key (without the environment prefix) is stored, or null if it is not
 *  on the list. */
export function classify(key: string): Kind | null {
  if (Object.hasOwn(EXACT, key)) return EXACT[key];
  for (const [prefix, kind] of PREFIXES) if (key.startsWith(prefix)) return kind;
  return null;
}

// The compare-and-set scripts. The value read is compared by SHA-1, so an
// 8 MiB transaction blob is not sent twice. The first line names the script
// for the test double. A key's expiry is kept.
export const CAS_STRING = `-- nya:cas-string
local cur = redis.call('GET', KEYS[1])
if not cur or redis.sha1hex(cur) ~= ARGV[1] then return 0 end
local ttl = redis.call('PTTL', KEYS[1])
redis.call('SET', KEYS[1], ARGV[2])
if ttl > 0 then redis.call('PEXPIRE', KEYS[1], ttl) end
return 1`;

export const CAS_HASH = `-- nya:cas-hash
local cur = redis.call('HGET', KEYS[1], ARGV[1])
if not cur or redis.sha1hex(cur) ~= ARGV[2] then return 0 end
redis.call('HSET', KEYS[1], ARGV[1], ARGV[3])
return 1`;

/** Checked before anything is written: the scripts depend on redis.sha1hex. */
export const PROBE = `-- nya:probe
return redis.sha1hex('nya')`;
const PROBE_ANSWER = sha1('nya');

function sha1(s: string): string {
  return createHash('sha1').update(s, 'utf8').digest('hex');
}

/** The part of the raw Upstash client this uses. Values come back exactly as
 *  stored, never JSON-parsed, so the comparison is byte for byte. */
export type ReencryptClient = {
  scan(cursor: string | number, opts: { match: string; count: number }): Promise<[string | number, string[]]>;
  hscan(key: string, cursor: string | number, opts: { count: number }): Promise<[string | number, unknown[]]>;
  type(key: string): Promise<string>;
  get(key: string): Promise<unknown>;
  getrange(key: string, start: number, end: number): Promise<unknown>;
  eval(script: string, keys: string[], args: string[]): Promise<unknown>;
};

export type ReencryptReport = {
  active_key: string;
  dry_run: boolean;
  /** Reached the end of the database before the time limit. */
  walked_all: boolean;
  /** Values moved to the active key by this call. */
  moved: number;
  /** Values still under another key, by key id (k0 is the legacy key). */
  to_move: Record<string, number>;
  /** Values that changed while being moved, so were left for next time. */
  changed_meanwhile: number;
  /** Values that could not be read, so were left alone. Listed up to a limit. */
  unreadable: { key: string; field?: string; reason: string }[];
  unreadable_count: number;
  /** Keys not on the list in this file. Nothing was done with them. */
  unclassified: string[];
  /** Every value is under the active key: walked_all, and nothing to move,
   *  changed, unreadable or unclassified. */
  complete: boolean;
};

const PAGE = 100;
const PARALLEL = 16;
const MAX_LISTED = 50;
/** Enough of a string value to see its header without reading the rest. */
const PEEK = 64;

/** Why a value could not be read, in words that never quote the value. */
function reasonFor(err: unknown): string {
  if (
    err instanceof UnknownKeyError ||
    err instanceof MasterKeyError ||
    err instanceof DecryptFailedError ||
    err instanceof MalformedCiphertextError
  ) {
    return `${err.name}: ${err.message}`;
  }
  return err instanceof Error ? err.name : 'Error';
}

class Unreadable extends Error {
  constructor(reason: string) {
    super(reason);
  }
}

/** The ciphertext re-encrypted under `active`, or null if it already is.
 *  Throws Unreadable for a value that cannot be moved. */
async function moved(ciphertext: string, active: string, dryRun: boolean): Promise<{ from: string; next: string | null } | null> {
  let format;
  try {
    format = formatOf(ciphertext);
  } catch (err) {
    throw new Unreadable(reasonFor(err));
  }
  if (format.keyId === active) return null;
  // Bound values need their context to be read, which only their owner knows.
  // None exist yet; when they do, their owner moves them.
  if (format.flags.includes('c')) throw new Unreadable('bound to a context; its owner must move it');
  let plain: string;
  try {
    plain = await decrypt(ciphertext);
  } catch (err) {
    throw new Unreadable(reasonFor(err));
  }
  return { from: format.keyId, next: dryRun ? null : await encryptV2(plain, active) };
}

async function inBatches<T>(items: T[], fn: (item: T) => Promise<void>): Promise<void> {
  for (let i = 0; i < items.length; i += PARALLEL) await Promise.all(items.slice(i, i + PARALLEL).map(fn));
}

async function listKeys(client: ReencryptClient, prefix: string): Promise<string[]> {
  const keys = new Set<string>();
  let cursor: string | number = 0;
  do {
    const [next, page] = await client.scan(cursor, { match: `${prefix}*`, count: 200 });
    for (const key of page) if (key.startsWith(prefix)) keys.add(key);
    cursor = next;
  } while (String(cursor) !== '0');
  return [...keys].sort();
}

/**
 * One call of the pass: walk every key until done or `budgetMs` runs out.
 * With `dryRun`, reads and checks everything and writes nothing.
 */
export async function reencrypt(
  opts: { dryRun: boolean; budgetMs: number; now?: () => number; client?: ReencryptClient }
): Promise<ReencryptReport> {
  const client = opts.client ?? (rawRedis() as unknown as ReencryptClient);
  const now = opts.now ?? Date.now;
  const deadline = now() + opts.budgetMs;
  const active = await activeKeyForReencryption();

  if (!opts.dryRun) {
    let answer: unknown;
    try {
      answer = await client.eval(PROBE, [], []);
    } catch {
      answer = null;
    }
    if (answer !== PROBE_ANSWER) {
      throw new MasterKeyError('The database does not support the scripts this pass needs (redis.sha1hex), so nothing was changed.');
    }
  }

  const report: ReencryptReport = {
    active_key: active,
    dry_run: opts.dryRun,
    walked_all: false,
    moved: 0,
    to_move: {},
    changed_meanwhile: 0,
    unreadable: [],
    unreadable_count: 0,
    unclassified: [],
    complete: false,
  };
  const unreadable = (key: string, field: string | undefined, reason: string) => {
    report.unreadable_count++;
    if (report.unreadable.length < MAX_LISTED) report.unreadable.push(field === undefined ? { key, reason } : { key, field, reason });
  };
  const pending = (from: string) => {
    report.to_move[from] = (report.to_move[from] ?? 0) + 1;
  };
  /** Counts a compare-and-set: moved, or left because the value changed. */
  const settle = (wrote: unknown) => {
    if (wrote === 1) report.moved++;
    else report.changed_meanwhile++;
  };

  const prefix = k('');
  const keys = await listKeys(client, prefix);
  for (const full of keys) {
    if (now() >= deadline) return finish(report);
    const key = full.slice(prefix.length);
    const kind = classify(key);
    if (kind === null) {
      report.unclassified.push(key);
      continue;
    }
    if (kind === 'plain') continue;

    const type = await client.type(full);
    if (type === 'none') continue; // deleted since the scan
    const expected = kind === 'string' ? 'string' : 'hash';
    if (type !== expected) {
      unreadable(key, undefined, `expected a ${expected}, found a ${type}`);
      continue;
    }

    if (kind === 'string') {
      const peek = await client.getrange(full, 0, PEEK - 1);
      if (typeof peek === 'string' && peek.startsWith(`v2.${active}.`)) continue;
      const value = await client.get(full);
      if (value === null || value === undefined) continue;
      if (typeof value !== 'string') {
        unreadable(key, undefined, 'not stored as text');
        continue;
      }
      try {
        const m = await moved(value, active, opts.dryRun);
        if (!m) continue;
        if (opts.dryRun) pending(m.from);
        else settle(await client.eval(CAS_STRING, [full], [sha1(value), m.next!]));
      } catch (err) {
        if (!(err instanceof Unreadable)) throw err;
        unreadable(key, undefined, err.message);
      }
      continue;
    }

    let cursor: string | number = 0;
    do {
      if (now() >= deadline) return finish(report);
      const [next, flat] = await client.hscan(full, cursor, { count: PAGE });
      const fields: [string, unknown][] = [];
      for (let i = 0; i + 1 < flat.length; i += 2) fields.push([String(flat[i]), flat[i + 1]]);
      await inBatches(fields, async ([field, value]) => {
        if (typeof value !== 'string') return unreadable(key, field, 'not stored as text');
        try {
          if (kind === 'hash') {
            const m = await moved(value, active, opts.dryRun);
            if (!m) return;
            if (opts.dryRun) pending(m.from);
            else settle(await client.eval(CAS_HASH, [full], [field, sha1(value), m.next!]));
            return;
          }
          // An item: only its access token is ciphertext.
          let item: Record<string, unknown>;
          try {
            item = JSON.parse(value);
          } catch {
            throw new Unreadable('not valid JSON');
          }
          const token = item?.encrypted_access_token;
          if (typeof token !== 'string') throw new Unreadable('has no encrypted_access_token');
          const m = await moved(token, active, opts.dryRun);
          if (!m) return;
          if (opts.dryRun) pending(m.from);
          else {
            const rewritten = JSON.stringify({ ...item, encrypted_access_token: m.next });
            settle(await client.eval(CAS_HASH, [full], [field, sha1(value), rewritten]));
          }
        } catch (err) {
          if (!(err instanceof Unreadable)) throw err;
          unreadable(key, field, err.message);
        }
      });
      cursor = next;
    } while (String(cursor) !== '0');
  }
  report.walked_all = true;
  return finish(report);
}

function finish(report: ReencryptReport): ReencryptReport {
  const toMove = Object.values(report.to_move).reduce((a, b) => a + b, 0);
  report.complete =
    report.walked_all &&
    toMove === 0 &&
    report.changed_meanwhile === 0 &&
    report.unreadable_count === 0 &&
    report.unclassified.length === 0;
  return report;
}
