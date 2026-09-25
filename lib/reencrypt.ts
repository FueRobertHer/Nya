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
//   - ONLY WHILE THE KEY STILL EXISTS. Each write also checks, in the same
//     step, that the key it encrypts with is still the active one and still
//     in the key store. A restore that replaced the key store mid-pass stops
//     the pass instead of leaving values under a key that exists nowhere.
//     (Don't run it during a restore anyway.)
//   - A CHECK WRITES NOTHING. Not even the first data key: that is only
//     created by a run, after the database has been shown to support the
//     scripts.
//
// "Complete" is a snapshot. An instance that cannot get the active key writes
// k0 (and logs it), and one that has not yet noticed a change of active key
// keeps writing the old one for up to a minute; either shows up on the next
// call. Values are never decrypted into the report: it carries key names,
// field names, counts and error types only.

import { createHash } from 'node:crypto';
import { rawRedis, k } from './storage';
import { splitScoped, isEnvWide } from './containers';
import {
  activeKeyForReencryption,
  activeKeyName,
  activeKeyStatus,
  keysHashKey,
  legacyKeyProblem,
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
  | 'cipher' // either of those, whichever type the key has (the caches)
  | 'items' // plaid:items: JSON values whose encrypted_access_token is ciphertext
  | 'plain'; // no ciphertext (checked: a v2 value in one is reported)

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

  containers: 'plain', // the container registry
};

const PREFIXES: [string, Kind][] = [
  ['txns:', 'string'],
  ['invtxns:', 'string'],
  ['txns-blocked:', 'plain'],
  ['invtxns-lock:', 'plain'],
  ['ratelimit:', 'plain'],
  ['sessions:', 'plain'], // a container's session epoch (lib/sessions.ts)
  ['cache:', 'cipher'], // disposable, but moved too so "complete" means every value
  ['crypto:', 'plain'], // the key store itself: wrapped keys, not data
];

/** How a key (without the environment prefix) is stored, or null if it is not
 *  on the list. */
export function classify(key: string): Kind | null {
  // A key inside a container is stored like the same key outside one, except
  // that environment-wide stores never belong in one, and containers never
  // nest: either means a key was built wrongly, so it is reported.
  const scoped = splitScoped(key);
  if (scoped.container) {
    if (scoped.key.startsWith('c:') || isEnvWide(scoped.key)) return null;
    return classify(scoped.key);
  }
  if (Object.hasOwn(EXACT, key)) return EXACT[key];
  for (const [prefix, kind] of PREFIXES) if (key.startsWith(prefix)) return kind;
  return null;
}

// The compare-and-set scripts. The value read is compared by SHA-1, so an
// 8 MiB transaction blob is not sent twice. The first line names the script
// for the test double. A key's expiry is kept.
//
// KEYS[2] and KEYS[3] are crypto:active and crypto:keys: the write happens only
// if the key it was encrypted with is still active and still stored.
//
// Answers: 1 written; 0 the value changed; -1 the value is gone; -2 the key it
// was encrypted with is no longer the active one, or no longer stored.
export const CAS_STRING = `-- nya:cas-string
if redis.call('GET', KEYS[2]) ~= ARGV[3] or redis.call('HEXISTS', KEYS[3], ARGV[3]) == 0 then return -2 end
local cur = redis.call('GET', KEYS[1])
if not cur then return -1 end
if redis.sha1hex(cur) ~= ARGV[1] then return 0 end
local ttl = redis.call('PTTL', KEYS[1])
redis.call('SET', KEYS[1], ARGV[2])
if ttl > 0 then redis.call('PEXPIRE', KEYS[1], ttl) end
return 1`;

export const CAS_HASH = `-- nya:cas-hash
if redis.call('GET', KEYS[2]) ~= ARGV[4] or redis.call('HEXISTS', KEYS[3], ARGV[4]) == 0 then return -2 end
local cur = redis.call('HGET', KEYS[1], ARGV[1])
if not cur then return -1 end
if redis.sha1hex(cur) ~= ARGV[2] then return 0 end
redis.call('HSET', KEYS[1], ARGV[1], ARGV[3])
return 1`;

/** Checked before anything is written or counted: the scripts depend on
 *  redis.sha1hex. */
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
  hget(key: string, field: string): Promise<unknown>;
  getrange(key: string, start: number, end: number): Promise<unknown>;
  eval(script: string, keys: string[], args: string[]): Promise<unknown>;
};

export type ReencryptReport = {
  /** The key values are moved to. Null in a check made before the first data
   *  key exists: then everything counts as still to move. */
  active_key: string | null;
  dry_run: boolean;
  /** Reached the end of the database before the time limit. */
  walked_all: boolean;
  /** Values moved to the active key by this call. */
  moved: number;
  /** In a check: values still under another key, by key id (k0 is the legacy
   *  key). A run moves them instead. */
  to_move: Record<string, number>;
  /** Values the app saved while they were being moved, so were left for next
   *  time. */
  changed_meanwhile: number;
  /** Values deleted while being moved. Nothing to do. */
  deleted_meanwhile: number;
  /** Values left alone because they cannot be moved: not decryptable, a key
   *  of the wrong type, bound to a context, an item that is not JSON, and so
   *  on. Listed up to a limit, with the reason. */
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
 *  With no active key (a check before the first one exists), everything is
 *  still to move. Throws Unreadable for a value that cannot be moved. */
async function moved(
  ciphertext: string,
  active: string | null,
  dryRun: boolean,
  legacyProblem: string | null
): Promise<{ from: string; next: string | null } | null> {
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
  if (format.keyId === 'k0' && legacyProblem) throw new Unreadable(legacyProblem);
  let plain: string;
  try {
    plain = await decrypt(ciphertext);
  } catch (err) {
    throw new Unreadable(reasonFor(err));
  }
  if (dryRun || active === null) return { from: format.keyId, next: null };
  const next = await encryptV2(plain, active);
  // Proven before it is written: the new value must read back as the old one.
  if ((await decrypt(next)) !== plain) throw new Error('A re-encrypted value did not read back.');
  return { from: format.keyId, next };
}

/** The database must run the scripts; anything else it answers is an error
 *  about something else (a network or auth failure), and is thrown as is. */
async function probe(client: ReencryptClient): Promise<void> {
  let answer: unknown;
  try {
    answer = await client.eval(PROBE, [], []);
  } catch (err) {
    // Upstash appends ", command was: <the command>" to every error, and the
    // command here names sha1hex, so only the part before it is looked at.
    const message = (err instanceof Error ? err.message : String(err)).replace(/, command was: [\s\S]*$/, '');
    if (!/attempt to call field 'sha1hex'|a nil value|unknown command|NOSCRIPT/i.test(message)) throw err;
    answer = null;
  }
  if (answer !== PROBE_ANSWER) {
    throw new MasterKeyError('The database does not support the scripts this pass needs (redis.sha1hex), so nothing was changed.');
  }
}

/**
 * A value in a key listed as plaintext that looks like ciphertext: v2, or v1
 * (base64 of at least a 12-byte IV and a 16-byte tag, so 40+ characters). No
 * plaintext store holds either: they keep dates, counters, JSON, ids and lock
 * tokens, none of which is long unbroken base64.
 */
const looksEncrypted = (v: unknown) =>
  typeof v === 'string' && (/^v2\.k[0-9]/.test(v) || (v.length >= 40 && v.length % 4 === 0 && /^[A-Za-z0-9+/]+={0,2}$/.test(v)));

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
 * With `dryRun`, reads and checks everything and writes nothing at all.
 */
export async function reencrypt(
  opts: { dryRun: boolean; budgetMs: number; now?: () => number; client?: ReencryptClient }
): Promise<ReencryptReport> {
  const client = opts.client ?? (rawRedis() as unknown as ReencryptClient);
  const now = opts.now ?? Date.now;
  const deadline = now() + opts.budgetMs;

  await probe(client);
  // A check only reads the active key; a run creates the first one if needed.
  let active: string | null;
  if (opts.dryRun) {
    const status = await activeKeyStatus();
    if (status.active_key_problem) throw new MasterKeyError(status.active_key_problem);
    active = status.active_key;
  } else {
    active = await activeKeyForReencryption();
  }
  const guard = [activeKeyName(), keysHashKey()];
  const legacyProblem = await legacyKeyProblem();

  const report: ReencryptReport = {
    active_key: active,
    dry_run: opts.dryRun,
    walked_all: false,
    moved: 0,
    to_move: {},
    changed_meanwhile: 0,
    deleted_meanwhile: 0,
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
  /**
   * Counts one compare-and-set. `reread` fetches the value again: when the
   * script said it changed but it reads back identical, either it changed and
   * changed back, or the two sides hash different bytes (a value that is not
   * valid UTF-8), which would never move. Reported rather than counted as a
   * plain change, so a value stuck that way is visible.
   */
  const settle = async (answer: unknown, key: string, field: string | undefined, read: string, reread: () => Promise<unknown>) => {
    if (answer === 1) report.moved++;
    else if (answer === -1) report.deleted_meanwhile++;
    else if (answer === -2) {
      throw new MasterKeyError(
        'The active data key changed or left the key store during the pass (a restore?), so it stopped. Whatever was moved stays moved; call it again.'
      );
    } else if ((await reread()) === read) {
      unreadable(key, field, 'could not be compared (it changed and changed back, or is not valid UTF-8 text); tried again next call');
    }
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

    const type = await client.type(full);
    if (type === 'none') continue; // deleted since the scan

    if (kind === 'plain') {
      // Checked, not trusted: a v2 value here means the list is wrong.
      if (type === 'string') {
        // Plaintext values are small (markers, counters), so read whole.
        if (looksEncrypted(await client.get(full))) unreadable(key, undefined, 'listed as plaintext but holds encrypted data');
      } else if (type === 'hash') {
        let cursor: string | number = 0;
        do {
          const [next, flat] = await client.hscan(full, cursor, { count: PAGE });
          for (let i = 0; i + 1 < flat.length; i += 2) {
            if (looksEncrypted(flat[i + 1])) unreadable(key, String(flat[i]), 'listed as plaintext but holds encrypted data');
          }
          cursor = next;
        } while (String(cursor) !== '0');
      }
      continue;
    }

    const expected = kind === 'string' ? 'string' : kind === 'cipher' ? type : 'hash';
    if (type !== expected || (type !== 'string' && type !== 'hash')) {
      unreadable(key, undefined, `expected a ${kind === 'cipher' ? 'string or hash' : expected}, found a ${type}`);
      continue;
    }

    if (type === 'string') {
      const peek = await client.getrange(full, 0, PEEK - 1);
      if (active && typeof peek === 'string' && peek.startsWith(`v2.${active}.`)) continue;
      const value = await client.get(full);
      if (value === null || value === undefined) continue;
      if (typeof value !== 'string') {
        unreadable(key, undefined, 'not stored as text');
        continue;
      }
      try {
        const m = await moved(value, active, opts.dryRun, legacyProblem);
        if (!m) continue;
        if (opts.dryRun) pending(m.from);
        else {
          const answer = await client.eval(CAS_STRING, [full, ...guard], [sha1(value), m.next!, active!]);
          await settle(answer, key, undefined, value, () => client.get(full));
        }
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
        const write = async (rewritten: string) => {
          const answer = await client.eval(CAS_HASH, [full, ...guard], [field, sha1(value), rewritten, active!]);
          await settle(answer, key, field, value, () => client.hget(full, field));
        };
        try {
          if (kind !== 'items') {
            const m = await moved(value, active, opts.dryRun, legacyProblem);
            if (!m) return;
            if (opts.dryRun) pending(m.from);
            else await write(m.next!);
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
          const m = await moved(token, active, opts.dryRun, legacyProblem);
          if (!m) return;
          if (opts.dryRun) pending(m.from);
          else await write(JSON.stringify({ ...item, encrypted_access_token: m.next }));
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
