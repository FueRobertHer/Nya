// lib/move.ts
//
// Moves the stored data from its keys before containers ("<env>:budgets") to
// its keys inside a container ("<env>:c:<id>:budgets"), once, at the cutover
// (#53). Run with `bun run move-data` (scripts/move-data.ts); see "Moving the
// data into containers" in the README for the order of steps.
//
// A COPY, never a move: the old keys stay exactly as they were, so rolling
// back is redeploying the previous release, which reads only them. They are
// deleted weeks later, separately, after a verified export.
//
// Driven by an explicit list (MOVED_KEYS, MOVED_PREFIXES), not a wildcard: a
// wildcard would also match the copies, and a re-run would copy them again
// into "c:<id>:c:<id>:...". The list is checked against every key the code
// builds inside a container (test/move.test.ts), so a key cannot be forgotten.
//
// Byte for byte: values are read and written raw (no JSON parsing), strings
// with SET and hashes rebuilt under a temporary key and swapped in with one
// RENAME, so a reader never sees half a hash.
//
// Safe to run again, and meant to be: once to copy, once more right before
// deploying to pick up anything written since, and after deploying to prove
// nothing was left behind. What was copied is recorded (a digest per key, in
// the container at "move:copied"), so each key can be judged by which side
// changed since it was copied:
//   - neither: up to date;
//   - only the old key: copied again ("refresh"), or, if it was deleted,
//     the container's copy is deleted too (only with --propagate-deletes,
//     and never many at once: that looks like the old keys being retired);
//   - only the container key (the new release wrote or deleted it): kept;
//   - both: a CONFLICT, a write on each side that one of them would lose.
//     The whole run is refused, nothing written, and the report names the
//     keys to reconcile by hand before the old keys are ever deleted.
// A container key that exists with no record, and differs, is a conflict too.
//
// Every write is a compare-and-set, done in one step with its record (Lua):
// the container key is written, replaced or deleted only if it still holds
// what the plan saw, and the record changes with it. So a write the new
// release makes during a run is never overwritten (the run stops instead),
// and a run that dies leaves every key either copied and recorded or not
// touched at all.
//
// Once the old keys are to be deleted, --retire marks the container: every
// later run is refused, so a run can never mistake the missing old keys for
// deletions to copy across. One run at a time (a lock in the container).
// Without --run it only reports.

import { createHash } from 'node:crypto';
import type { Ctx } from './containers';
import { envPrefix, kc } from './storage';

/** Every key moved as is. Each is also classified in lib/reencrypt.ts. */
export const MOVED_KEYS = [
  'budgets',
  'goals',
  'txn-vendor-renames',
  'txn-category-overrides',
  'hidden:accounts',
  'manual:accounts',
  'accounts:vanished',
  'accounts:meta',
  'accounts:directory',
  'account-links',
  'account-links:dismissed',
  'plaid:items',
  'history:net-worth',
  'history:net-worth:est',
  'history:accounts',
  'history:accounts:est',
  'history:accounts:est:ext',
  'history:accounts:partial',
  'history:accounts:est:flatd',
  'history:accounts:est:flat',
  'history:backfill-done',
  'history:backfill-pending',
] as const;

/** Per-Item keys, moved for every Item found. */
export const MOVED_PREFIXES = ['txns:', 'txns-blocked:', 'invtxns:'] as const;

/**
 * Keys inside a container that are deliberately NOT moved: disposable or
 * belonging to the running environment, rebuilt by the new release as needed.
 * test/move.test.ts checks every container key the code builds is on one list
 * or the other.
 */
export const NOT_MOVED_PREFIXES = [
  'cache:', // 15-minute payloads; rebuilt on the next load
  'invtxns-lock:', // a sync's lock, seconds long
  'sessions:', // the session epoch: new per container (lib/sessions.ts)
  'snapshot:', // the cron's own log and lock (lib/snapshot-job.ts)
  'move:', // this module's own record
] as const;

export function isMoved(key: string): boolean {
  return (MOVED_KEYS as readonly string[]).includes(key) || MOVED_PREFIXES.some((p) => key.startsWith(p) && key.length > p.length);
}

const recordKey = (ctx: Ctx) => kc(ctx, 'move:copied');
const lockKey = (ctx: Ctx) => kc(ctx, 'move:lock');
const retiredKey = (ctx: Ctx) => kc(ctx, 'move:retired');
const tempKey = (ctx: Ctx, run: string, key: string) => kc(ctx, `move:tmp:${run}:${key}`);
/** Long enough for any run; a run that dies frees it by then. */
export const MOVE_LOCK_SECONDS = 3600;
/** More deletions than this in one run looks like the old keys being
 *  retired, not like the old release deleting a few: refused, flag or not. */
export const MAX_DELETES = 5;

/** Keys every environment in use has. Neither among the old keys usually
 *  means the wrong database or prefix, or old keys already deleted. */
const EXPECTED = ['plaid:items', 'history:net-worth'] as const;

// The digest of a key, computed the same way here and in Lua, so a write can
// check the container key still holds what the plan saw. Hashes are digested
// without depending on field order (Lua's sort would depend on the locale):
// each field and value is digested, and the sorted hex digests, which are
// plain ASCII, digested together.
const DIGEST_LUA = `
local function digest(key)
  local t = redis.call('TYPE', key)['ok']
  if t == 'none' then return '' end
  if t == 'string' then return redis.sha1hex('S' .. redis.call('GET', key)) end
  if t == 'hash' then
    local flat = redis.call('HGETALL', key)
    local parts = {}
    for i = 1, #flat, 2 do parts[#parts + 1] = redis.sha1hex(flat[i] .. '\\0' .. flat[i + 1]) end
    table.sort(parts)
    return redis.sha1hex('H' .. table.concat(parts))
  end
  return 'type:' .. t
end`;

// Each write script answers 1 when the write is done, including when it was
// done already (a retried request whose first answer was lost), 0 when the
// container key no longer holds what the run expected, and -1 when the run
// no longer holds the lock (it ran past the lock's expiry and another run may
// have taken over), in which case nothing is written.

/** Returns the digest of KEYS[1]: to check, before anything is written, that
 *  Redis computes digests as this file does. */
export const MOVE_PROBE = `-- nya:move-probe${DIGEST_LUA}
return digest(KEYS[1])`;

/** Writes a string if the target still has the expected digest ('' for
 *  none), and records it, in one step. KEYS: target, record, lock. ARGV:
 *  expected, value, ttl, field, new digest, token. The first line names the
 *  script for the test double. */
export const MOVE_SET = `-- nya:move-set${DIGEST_LUA}
if redis.call('GET', KEYS[3]) ~= ARGV[6] then return -1 end
local now = digest(KEYS[1])
if now == ARGV[5] and redis.call('HGET', KEYS[2], ARGV[4]) == ARGV[5] then return 1 end
if now ~= ARGV[1] then return 0 end
if tonumber(ARGV[3]) > 0 then redis.call('SET', KEYS[1], ARGV[2], 'EX', ARGV[3]) else redis.call('SET', KEYS[1], ARGV[2]) end
redis.call('HSET', KEYS[2], ARGV[4], ARGV[5])
return 1`;

/** Swaps a hash built aside into place, the same way, and only if the hash
 *  built aside is exactly what it should be. KEYS: target, record, temporary,
 *  lock. ARGV: expected, field, new digest, token. */
export const MOVE_SWAP = `-- nya:move-swap${DIGEST_LUA}
if redis.call('GET', KEYS[4]) ~= ARGV[4] then return -1 end
local now = digest(KEYS[1])
if now == ARGV[3] and redis.call('HGET', KEYS[2], ARGV[2]) == ARGV[3] then return 1 end
if now ~= ARGV[1] then return 0 end
if digest(KEYS[3]) ~= ARGV[3] then return -2 end
redis.call('RENAME', KEYS[3], KEYS[1])
redis.call('HSET', KEYS[2], ARGV[2], ARGV[3])
return 1`;

/** Deletes a key and its record, the same way. KEYS: target, record, lock.
 *  ARGV: expected, field, token. */
export const MOVE_DELETE = `-- nya:move-delete${DIGEST_LUA}
if redis.call('GET', KEYS[3]) ~= ARGV[3] then return -1 end
local now = digest(KEYS[1])
if now == '' and not redis.call('HGET', KEYS[2], ARGV[2]) then return 1 end
if now ~= ARGV[1] then return 0 end
redis.call('DEL', KEYS[1])
redis.call('HDEL', KEYS[2], ARGV[2])
return 1`;

/** Frees the lock only if it is still this run's (as lib/snapshot-job.ts). */
export const MOVE_RELEASE = `-- nya:release-lock
if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end
return 0`;

export type MoveClient = {
  scan(cursor: string | number, opts: { match: string; count: number }): Promise<[string | number, string[]]>;
  hscan(key: string, cursor: string | number, opts: { count: number }): Promise<[string | number, unknown[]]>;
  type(key: string): Promise<string>;
  get(key: string): Promise<unknown>;
  set(key: string, value: string, opts?: { ex?: number; nx?: boolean }): Promise<unknown>;
  hset(key: string, fields: Record<string, string>): Promise<unknown>;
  hget(key: string, field: string): Promise<unknown>;
  hkeys(key: string): Promise<string[]>;
  hdel(key: string, ...fields: string[]): Promise<unknown>;
  del(...keys: string[]): Promise<unknown>;
  ttl(key: string): Promise<number>;
  expire(key: string, seconds: number): Promise<unknown>;
  eval(script: string, keys: string[], args: string[]): Promise<unknown>;
};

export type MoveAction = 'copy' | 'refresh' | 'delete' | 'up-to-date' | 'kept' | 'conflict';
export type MoveEntry = { key: string; action: MoveAction; reason?: string };
export type MoveReport = {
  run: boolean;
  container: string;
  copied: number;
  refreshed: number;
  deleted: number;
  up_to_date: number;
  kept: number;
  conflicts: MoveEntry[];
  entries: MoveEntry[];
};

export class MoveRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MoveRefused';
  }
}

const PAGE = 200;

type Value = { kind: 'string'; value: string } | { kind: 'hash'; fields: [string, string][] } | null;

function mustBeString(value: unknown, key: string): string {
  if (typeof value !== 'string') throw new MoveRefused(`${key} did not read back as raw text; the client must not deserialize.`);
  return value;
}

async function readValue(client: MoveClient, key: string): Promise<Value> {
  const type = await client.type(key);
  if (type === 'none') return null;
  if (type === 'string') {
    const value = await client.get(key);
    return value === null || value === undefined ? null : { kind: 'string', value: mustBeString(value, key) };
  }
  if (type === 'hash') {
    const fields = new Map<string, string>();
    let cursor: string | number = 0;
    do {
      const [next, flat] = await client.hscan(key, cursor, { count: PAGE });
      for (let i = 0; i + 1 < flat.length; i += 2) fields.set(mustBeString(flat[i], key), mustBeString(flat[i + 1], key));
      cursor = next;
    } while (String(cursor) !== '0');
    if (fields.size === 0) return null; // deleted while being read
    return { kind: 'hash', fields: [...fields.entries()] };
  }
  throw new MoveRefused(`${key} is a ${type}, which nothing here stores.`);
}

const sha1 = (s: string) => createHash('sha1').update(s, 'utf8').digest('hex');

/** The digest DIGEST_LUA computes for the same value; null for none. */
export function digest(v: Value): string | null {
  if (v === null) return null;
  if (v.kind === 'string') return sha1(`S${v.value}`);
  return sha1('H' + v.fields.map(([f, val]) => sha1(`${f}\0${val}`)).sort().join(''));
}

/** Runs one compare-and-set script (see above for its answers). */
async function cas(client: MoveClient, key: string, script: string, keys: string[], args: string[]): Promise<void> {
  const answer = Number(await client.eval(script, keys, args));
  if (answer === 1) return;
  if (answer === -1) {
    throw new MoveRefused(`This run no longer holds its lock (it ran longer than ${MOVE_LOCK_SECONDS / 60} minutes, and another run may have started): stopped before ${key}, nothing more was written. Run again.`);
  }
  if (answer === -2) {
    throw new MoveRefused(`${key} was not built in full before being swapped in (another run using the same key?): nothing was written for it. Run again.`);
  }
  throw new MoveRefused(`${key} changed in the container while this run was going: nothing more was written. Run again to see what changed.`);
}

type Run = { ctx: Ctx; token: string };

/** Writes a planned copy or refresh, checked against what the plan saw. */
async function writeValue(client: MoveClient, run: Run, key: string, v: Exclude<Value, null>, expected: string | null, d: string, ttl: number): Promise<void> {
  const { ctx, token } = run;
  const target = kc(ctx, key);
  if (v.kind === 'string') {
    await cas(client, key, MOVE_SET, [target, recordKey(ctx), lockKey(ctx)], [expected ?? '', v.value, String(Math.max(0, ttl)), key, d, token]);
    return;
  }
  // Built aside, under a name of this run's own, and swapped in whole only if
  // complete: RENAME replaces the target in one step, expiry and all.
  const tmp = tempKey(ctx, token, key);
  try {
    await client.del(tmp);
    for (let i = 0; i < v.fields.length; i += PAGE) {
      await client.hset(tmp, Object.fromEntries(v.fields.slice(i, i + PAGE)));
    }
    if (ttl > 0) await client.expire(tmp, ttl);
    await cas(client, key, MOVE_SWAP, [target, recordKey(ctx), tmp, lockKey(ctx)], [expected ?? '', key, d, token]);
  } finally {
    await client.del(tmp).catch(() => {});
  }
}

/**
 * Checks, before anything is read for real, that Redis digests a value as
 * this file does (the scripts depend on it), on one key every environment in
 * use has. Refuses on any difference or script failure, writing nothing.
 */
async function probe(client: MoveClient, oldKeys: Set<string>): Promise<void> {
  const key = EXPECTED.find((k) => oldKeys.has(k));
  if (!key) return;
  const full = envPrefix() + key;
  let theirs: unknown;
  try {
    theirs = await client.eval(MOVE_PROBE, [full], []);
  } catch (err) {
    throw new MoveRefused(`This database could not run the move's script (${err instanceof Error ? err.message.split(', command was')[0].slice(0, 160) : 'error'}). Nothing was written.`);
  }
  const ours = digest(await readValue(client, full)) ?? '';
  if (theirs !== ours) {
    throw new MoveRefused(`This database digests ${key} differently from this tool, so its checks could not be trusted. Nothing was written.`);
  }
}

/** Every key to judge: the old keys on the list, and every key this tool has
 *  copied (so a deletion on either side is seen). */
async function keysToJudge(client: MoveClient, ctx: Ctx): Promise<{ keys: string[]; oldKeys: Set<string> }> {
  const prefix = envPrefix();
  const oldKeys = new Set<string>();
  let cursor: string | number = 0;
  do {
    const [next, page] = await client.scan(cursor, { match: `${prefix}*`, count: PAGE });
    for (const full of page) {
      if (!full.startsWith(prefix)) continue;
      const key = full.slice(prefix.length);
      if (isMoved(key)) oldKeys.add(key); // never "c:...": not on the list
    }
    cursor = next;
  } while (String(cursor) !== '0');
  const all = new Set(oldKeys);
  for (const key of await client.hkeys(recordKey(ctx))) if (isMoved(key)) all.add(key);
  return { keys: [...all].sort(), oldKeys };
}

type Planned = { key: string; action: MoveAction; source: Value; digest: string | null; target: string | null; reason?: string };

/** Which side changed since the copy (see the header). */
function judge(key: string, source: Value, target: Value, recorded: string | null): Planned {
  const s = digest(source);
  const t = digest(target);
  const p = (action: MoveAction, reason?: string): Planned => ({ key, action, source, digest: s, target: t, ...(reason ? { reason } : {}) });
  if (recorded === null) {
    if (s === null) return t === null ? p('up-to-date') : p('kept', 'only in the container: the new release wrote it');
    if (t === null) return p('copy');
    if (t === s) return p('up-to-date');
    return p('conflict', 'the container already holds this key, and this tool did not write it');
  }
  if (s === null) {
    if (t === null) return p('up-to-date'); // deleted on both sides
    if (t === recorded) return p('delete');
    return p('conflict', 'deleted from the old key, but changed in the container since it was copied');
  }
  if (t === s) return p('up-to-date');
  if (t === null) {
    return s === recorded ? p('kept', 'deleted in the container since it was copied') : p('conflict', 'changed in the old key, but deleted in the container since it was copied');
  }
  if (t === recorded) return p('refresh');
  if (s === recorded) return p('kept', 'changed in the container since it was copied');
  return p('conflict', 'changed in both places since it was copied');
}

async function judgeKey(client: MoveClient, ctx: Ctx, key: string): Promise<Planned> {
  const source = await readValue(client, envPrefix() + key);
  const target = await readValue(client, kc(ctx, key));
  const recorded = await client.hget(recordKey(ctx), key);
  return judge(key, source, target, typeof recorded === 'string' ? recorded : null);
}

export type MoveOptions = {
  run: boolean;
  /** Go ahead in an environment with none of the EXPECTED old keys and
   *  nothing copied yet: one that really holds no data. */
  allowEmpty?: boolean;
  /** Carry deletions of old keys across (a few at most, MAX_DELETES). */
  propagateDeletes?: boolean;
};

/**
 * Plans the move and, with `run`, carries it out. Refuses (MoveRefused), with
 * nothing written, if the container is retired, another run holds the lock,
 * the environment looks wrong, any key conflicts, or deletions are not
 * allowed or too many.
 */
export async function moveData(client: MoveClient, ctx: Ctx, opts: MoveOptions): Promise<MoveReport> {
  const retired = await client.get(retiredKey(ctx));
  if (retired !== null && retired !== undefined) {
    throw new MoveRefused(`This container was retired from the move on ${retired}: the old keys are being or have been deleted, so there is nothing left to move. Nothing was written.`);
  }
  const token = crypto.randomUUID();
  if (opts.run && (await client.set(lockKey(ctx), token, { nx: true, ex: MOVE_LOCK_SECONDS })) === null) {
    throw new MoveRefused('Another run is in progress for this container. Wait for it to finish, then run again.');
  }
  try {
    return await plannedMove(client, { ctx, token }, opts);
  } finally {
    if (opts.run) await client.eval(MOVE_RELEASE, [lockKey(ctx)], [token]).catch(() => {}); // else it expires
  }
}

async function plannedMove(client: MoveClient, run: Run, opts: MoveOptions): Promise<MoveReport> {
  const { ctx } = run;
  const prefix = envPrefix();
  const { keys, oldKeys } = await keysToJudge(client, ctx);
  await probe(client, oldKeys);
  const plan: Planned[] = [];
  for (const key of keys) {
    const p = await judgeKey(client, ctx, key);
    // Gone from both sides before it was ever copied: nothing to say.
    if (p.source === null && p.target === null && (await client.hget(recordKey(ctx), key)) === null) continue;
    plan.push(p);
  }

  const entries: MoveEntry[] = plan.map(({ key, action, reason }) => ({ key, action, ...(reason ? { reason } : {}) }));
  const count = (a: MoveAction) => plan.filter((p) => p.action === a).length;
  const conflicts = entries.filter((e) => e.action === 'conflict');
  const report: MoveReport = {
    run: opts.run,
    container: ctx.container,
    copied: count('copy'),
    refreshed: count('refresh'),
    deleted: count('delete'),
    up_to_date: count('up-to-date'),
    kept: count('kept'),
    conflicts,
    entries,
  };

  // The environment: a wrong .env.local or prefix, or old keys already gone.
  const sawExpected = EXPECTED.some((k) => oldKeys.has(k));
  const recordedAny = (await client.hkeys(recordKey(ctx))).length > 0;
  const refusals: string[] = [];
  if (!sawExpected && recordedAny) {
    refusals.push(`None of ${EXPECTED.join(', ')} exists under "${prefix}" any more, though this container was copied into: the old keys look deleted. Moving now would delete the container's copies.`);
  } else if (!sawExpected && !opts.allowEmpty) {
    refusals.push(`None of ${EXPECTED.join(', ')} exists under "${prefix}". Check .env.local and REDIS_PREFIX point at the environment you mean; pass --allow-empty if it really holds no data.`);
  }
  if (report.deleted > MAX_DELETES) {
    refusals.push(`${report.deleted} old keys were deleted since they were copied; more than ${MAX_DELETES} at once looks like the old keys being retired, not the old release deleting a few, so nothing is deleted from the container this way. If they should go, delete them by hand (see the README): ${entries.filter((e) => e.action === 'delete').map((e) => e.key).join(', ')}.`);
  } else if (report.deleted > 0 && !opts.propagateDeletes) {
    refusals.push(`${report.deleted} old key(s) were deleted since they were copied (${entries.filter((e) => e.action === 'delete').map((e) => e.key).join(', ')}). Check they should be, then pass --propagate-deletes to delete the container's copies too.`);
  }
  if (conflicts.length > 0) {
    refusals.push(
      `${conflicts.length} key(s) changed on both sides since they were copied (${conflicts.map((c) => c.key).join(', ')}): copying either way would lose a write. Reconcile them by hand (see the README).`
    );
  }
  if (!opts.run) {
    for (const r of refusals) console.warn(`Warning: ${r}`);
    return report;
  }
  if (refusals.length > 0) throw new MoveRefused(`${refusals.join(' ')} Nothing was written.`);

  for (const planned of plan) {
    if (planned.action === 'kept') continue;
    // Judged again right before writing: a key that changed since the plan
    // was made is left for the next run to see, never written over.
    const p = await judgeKey(client, ctx, planned.key);
    if (p.action !== planned.action || p.digest !== planned.digest || p.target !== planned.target) {
      throw new MoveRefused(`${planned.key} changed while this run was going: nothing more was written. Run again to see what changed.`);
    }
    if (p.action === 'up-to-date') {
      if (p.digest === null) await client.hdel(recordKey(ctx), p.key);
      else if ((await client.hget(recordKey(ctx), p.key)) !== p.digest) await client.hset(recordKey(ctx), { [p.key]: p.digest });
    } else if (p.action === 'delete') {
      await cas(client, p.key, MOVE_DELETE, [kc(ctx, p.key), recordKey(ctx), lockKey(ctx)], [p.target!, p.key, run.token]);
    } else {
      await writeValue(client, run, p.key, p.source as Exclude<Value, null>, p.target, p.digest!, await client.ttl(prefix + p.key));
    }
  }
  return report;
}

/**
 * Marks the container retired from the move, before its old keys are
 * deleted: every later run is refused. Only when a report shows nothing left
 * to copy, refresh or delete, and no conflicts, which is the proof nothing
 * written to the old keys is left behind.
 */
export async function retireMove(client: MoveClient, ctx: Ctx, now: Date = new Date()): Promise<void> {
  const report = await moveData(client, ctx, { run: false });
  const pending = report.copied + report.refreshed + report.deleted + report.conflicts.length;
  if (pending > 0) {
    throw new MoveRefused(
      `Not retired: the move still has ${report.copied} to copy, ${report.refreshed} to refresh, ${report.deleted} to delete and ${report.conflicts.length} conflict(s). Finish it first, so nothing written to the old keys is left behind.`
    );
  }
  await client.set(retiredKey(ctx), now.toISOString());
}

export function checkMoveTarget(
  named: string | undefined,
  confirmProduction: boolean,
  actual: string = envPrefix().replace(/:$/, '')
): string {
  if (!named) throw new MoveRefused(`Name the environment with --target. This process would write to "${actual}".`);
  if (named !== actual) throw new MoveRefused(`--target is "${named}" but REDIS_PREFIX resolves to "${actual}". Nothing was written.`);
  if (actual === 'production' && !confirmProduction) throw new MoveRefused('Moving production data also needs --confirm-production.');
  return actual;
}
