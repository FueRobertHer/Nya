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
//     the container's copy is deleted too;
//   - only the container key (the new release wrote or deleted it): kept;
//   - both: a CONFLICT, a write on each side that one of them would lose.
//     The whole run is refused, nothing written, and the report names the
//     keys to reconcile by hand before the old keys are ever deleted.
// A container key that exists with no record, and differs, is a conflict too.
// A write is recorded as pending before it is made, so a run that dies midway
// is recognized and finished by the next, not mistaken for the new release.
//
// One run at a time (a lock in the container). Without --run it only reports.

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
const pendingKey = (ctx: Ctx) => kc(ctx, 'move:pending');
const lockKey = (ctx: Ctx) => kc(ctx, 'move:lock');
const tempKey = (ctx: Ctx, key: string) => kc(ctx, `move:tmp:${key}`);
/** Long enough for any run; a run that dies frees it by then. */
export const MOVE_LOCK_SECONDS = 3600;

/** Keys every environment in use has. Neither among the old keys usually
 *  means the wrong database or prefix, not an empty one. */
const EXPECTED = ['plaid:items', 'history:net-worth'] as const;

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
  rename(from: string, to: string): Promise<unknown>;
  ttl(key: string): Promise<number>;
  expire(key: string, seconds: number): Promise<unknown>;
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
    return { kind: 'hash', fields: [...fields.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)) };
  }
  throw new MoveRefused(`${key} is a ${type}, which nothing here stores.`);
}

function digest(v: Value): string | null {
  if (v === null) return null;
  const body = v.kind === 'string' ? `S${v.value}` : `H${JSON.stringify(v.fields)}`;
  return createHash('sha256').update(body, 'utf8').digest('hex');
}

async function writeValue(client: MoveClient, ctx: Ctx, key: string, target: string, v: Exclude<Value, null>, ttl: number): Promise<void> {
  if (v.kind === 'string') {
    // One request, expiry included: a run that dies cannot leave it without one.
    await client.set(target, v.value, ttl > 0 ? { ex: ttl } : undefined);
    return;
  }
  // Built aside, under a name of its own, and swapped in whole: RENAME
  // replaces the target in one step, expiry and all.
  const tmp = tempKey(ctx, key);
  try {
    await client.del(tmp);
    for (let i = 0; i < v.fields.length; i += PAGE) {
      await client.hset(tmp, Object.fromEntries(v.fields.slice(i, i + PAGE)));
    }
    if (ttl > 0) await client.expire(tmp, ttl);
    await client.rename(tmp, target);
  } finally {
    await client.del(tmp).catch(() => {});
  }
}

/** Every key to judge: the old keys on the list, and every key this tool has
 *  copied or begun to (so a deletion on either side is seen). */
async function keysToJudge(client: MoveClient, ctx: Ctx): Promise<string[]> {
  const prefix = envPrefix();
  const found = new Set<string>();
  let cursor: string | number = 0;
  do {
    const [next, page] = await client.scan(cursor, { match: `${prefix}*`, count: PAGE });
    for (const full of page) {
      if (!full.startsWith(prefix)) continue;
      const key = full.slice(prefix.length);
      if (isMoved(key)) found.add(key); // never "c:...": not on the list
    }
    cursor = next;
  } while (String(cursor) !== '0');
  for (const key of await client.hkeys(recordKey(ctx))) if (isMoved(key)) found.add(key);
  for (const key of await client.hkeys(pendingKey(ctx))) if (isMoved(key)) found.add(key);
  return [...found].sort();
}

type Planned = { key: string; action: MoveAction; source: Value; digest: string | null; reason?: string };

/** Which side changed since the copy (see the header). */
function judge(key: string, source: Value, target: Value, recorded: string | null): Planned {
  const s = digest(source);
  const t = digest(target);
  const p = (action: MoveAction, reason?: string): Planned => ({ key, action, source, digest: s, ...(reason ? { reason } : {}) });
  if (recorded === null) {
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

/**
 * Plans the move and, with `run`, carries it out. Refuses (MoveRefused), with
 * nothing written, if any key conflicts, if another run holds the lock, or if
 * the old keys look like the wrong environment (unless `allowEmpty`).
 */
export async function moveData(client: MoveClient, ctx: Ctx, opts: { run: boolean; allowEmpty?: boolean }): Promise<MoveReport> {
  const token = crypto.randomUUID();
  if (opts.run) {
    if ((await client.set(lockKey(ctx), token, { nx: true, ex: MOVE_LOCK_SECONDS })) === null) {
      throw new MoveRefused('Another run is in progress for this container. Wait for it to finish, then run again.');
    }
  }
  try {
    return await plannedMove(client, ctx, opts);
  } finally {
    if (opts.run && (await client.get(lockKey(ctx))) === token) await client.del(lockKey(ctx));
  }
}

async function plannedMove(client: MoveClient, ctx: Ctx, opts: { run: boolean; allowEmpty?: boolean }): Promise<MoveReport> {
  const prefix = envPrefix();
  const keys = await keysToJudge(client, ctx);
  const plan: Planned[] = [];
  let sawExpected = false;
  for (const key of keys) {
    const source = await readValue(client, prefix + key);
    if (source !== null && (EXPECTED as readonly string[]).includes(key)) sawExpected = true;
    const target = await readValue(client, kc(ctx, key));
    const recorded = await client.hget(recordKey(ctx), key);
    const pending = await client.hget(pendingKey(ctx), key);
    // A write that landed but was never confirmed: the run died after it.
    const t = digest(target);
    const effective = typeof pending === 'string' && pending === t ? pending : typeof recorded === 'string' ? recorded : null;
    if (source === null && target === null && effective === null) continue;
    plan.push(judge(key, source, target, effective));
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
  const recordedAny = (await client.hkeys(recordKey(ctx))).length > 0;
  if (!sawExpected && !recordedAny && !opts.allowEmpty) {
    const why = `None of ${EXPECTED.join(', ')} exists under "${prefix}". Check .env.local and REDIS_PREFIX point at the environment you mean; pass --allow-empty if it really holds no data.`;
    if (opts.run) throw new MoveRefused(why);
    console.warn(`Warning: ${why}`);
  }
  if (!opts.run) return report;
  if (conflicts.length > 0) {
    throw new MoveRefused(
      `${conflicts.length} key(s) changed on both sides since they were copied (${conflicts.map((c) => c.key).join(', ')}): ` +
        'copying either way would lose a write. Nothing was written. Reconcile them by hand (see the README).'
    );
  }

  for (const p of plan) {
    const target = kc(ctx, p.key);
    if (p.action === 'kept') continue;
    if (p.action === 'up-to-date') {
      if (p.digest === null) await client.hdel(recordKey(ctx), p.key);
      else if ((await client.hget(recordKey(ctx), p.key)) !== p.digest) await client.hset(recordKey(ctx), { [p.key]: p.digest });
      await client.hdel(pendingKey(ctx), p.key);
      continue;
    }
    if (p.action === 'delete') {
      await client.del(target);
      await client.hdel(recordKey(ctx), p.key);
      await client.hdel(pendingKey(ctx), p.key);
      continue;
    }
    // copy or refresh. Pending first, so a run that dies after the write is
    // recognized by the next one rather than taken for the new release.
    await client.hset(pendingKey(ctx), { [p.key]: p.digest! });
    await writeValue(client, ctx, p.key, target, p.source as Exclude<Value, null>, await client.ttl(prefix + p.key));
    const back = digest(await readValue(client, target));
    if (back !== p.digest) {
      throw new MoveRefused(`${p.key} did not read back as written. Run again: a run that stops here is safe to repeat.`);
    }
    await client.hset(recordKey(ctx), { [p.key]: p.digest! });
    await client.hdel(pendingKey(ctx), p.key);
  }
  return report;
}

/** The environment to write, named twice (REDIS_PREFIX and --target), and
 *  production confirmed on top: the same rule as restore. */
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
