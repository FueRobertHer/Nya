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
// deploying to pick up anything written since. What was copied is recorded
// (a digest per key, in the container at "move:copied"). On a later run a
// container key is:
//   - up to date when it already equals the old key: nothing to do;
//   - refreshed when it still holds what was copied (nothing has written it
//     since) but the old key changed: copied again;
//   - a CONFLICT when it holds anything else, meaning the new release has
//     already written it. Overwriting it would lose that write, so the whole
//     run is refused, nothing written.
// A container key that exists with no record at all is a conflict too.
//
// Without --run it only reports what it would do.

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
const tempKey = (ctx: Ctx) => kc(ctx, 'move:tmp');

export type MoveClient = {
  scan(cursor: string | number, opts: { match: string; count: number }): Promise<[string | number, string[]]>;
  hscan(key: string, cursor: string | number, opts: { count: number }): Promise<[string | number, unknown[]]>;
  type(key: string): Promise<string>;
  get(key: string): Promise<unknown>;
  set(key: string, value: string): Promise<unknown>;
  hset(key: string, fields: Record<string, string>): Promise<unknown>;
  hget(key: string, field: string): Promise<unknown>;
  del(...keys: string[]): Promise<unknown>;
  rename(from: string, to: string): Promise<unknown>;
  ttl(key: string): Promise<number>;
  expire(key: string, seconds: number): Promise<unknown>;
};

export type MoveAction = 'copy' | 'refresh' | 'up-to-date' | 'conflict';
export type MoveEntry = { key: string; action: MoveAction; reason?: string };
export type MoveReport = {
  run: boolean;
  container: string;
  copied: number;
  refreshed: number;
  up_to_date: number;
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
  if (type === 'string') return { kind: 'string', value: mustBeString(await client.get(key), key) };
  if (type === 'hash') {
    const fields = new Map<string, string>();
    let cursor: string | number = 0;
    do {
      const [next, flat] = await client.hscan(key, cursor, { count: PAGE });
      for (let i = 0; i + 1 < flat.length; i += 2) fields.set(mustBeString(flat[i], key), mustBeString(flat[i + 1], key));
      cursor = next;
    } while (String(cursor) !== '0');
    return { kind: 'hash', fields: [...fields.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)) };
  }
  throw new MoveRefused(`${key} is a ${type}, which nothing here stores.`);
}

function digest(v: Value): string {
  if (v === null) return 'none';
  const body = v.kind === 'string' ? `S${v.value}` : `H${JSON.stringify(v.fields)}`;
  return createHash('sha256').update(body, 'utf8').digest('hex');
}

async function writeValue(client: MoveClient, ctx: Ctx, target: string, v: Exclude<Value, null>, ttl: number): Promise<void> {
  if (v.kind === 'string') {
    await client.set(target, v.value);
  } else {
    // Built aside and swapped in whole: RENAME replaces the target in one step.
    const tmp = tempKey(ctx);
    await client.del(tmp);
    for (let i = 0; i < v.fields.length; i += PAGE) {
      await client.hset(tmp, Object.fromEntries(v.fields.slice(i, i + PAGE)));
    }
    if (v.fields.length === 0) await client.del(target);
    else await client.rename(tmp, target);
  }
  if (ttl > 0) await client.expire(target, ttl);
}

/** The old keys that exist and are on the list, relative to the environment. */
async function sourceKeys(client: MoveClient): Promise<string[]> {
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
  return [...found].sort();
}

/**
 * Plans the move and, with `run`, carries it out. Refuses (MoveRefused), with
 * nothing written, if any container key conflicts.
 */
export async function moveData(client: MoveClient, ctx: Ctx, opts: { run: boolean }): Promise<MoveReport> {
  const prefix = envPrefix();
  const keys = await sourceKeys(client);
  const plan: { key: string; action: MoveAction; source: Exclude<Value, null>; digest: string; reason?: string }[] = [];

  for (const key of keys) {
    const source = await readValue(client, prefix + key);
    if (source === null) continue; // deleted since the scan
    const target = await readValue(client, kc(ctx, key));
    const d = digest(source);
    const t = digest(target);
    const recorded = await client.hget(recordKey(ctx), key);
    if (target === null) plan.push({ key, action: 'copy', source, digest: d });
    else if (t === d) plan.push({ key, action: 'up-to-date', source, digest: d });
    else if (typeof recorded === 'string' && recorded === t) plan.push({ key, action: 'refresh', source, digest: d });
    else
      plan.push({
        key,
        action: 'conflict',
        source,
        digest: d,
        reason: recorded === null || recorded === undefined ? 'the container already holds this key, and this tool did not write it' : 'the container key was written after it was copied',
      });
  }

  const entries: MoveEntry[] = plan.map(({ key, action, reason }) => ({ key, action, ...(reason ? { reason } : {}) }));
  const conflicts = entries.filter((e) => e.action === 'conflict');
  const report: MoveReport = {
    run: opts.run,
    container: ctx.container,
    copied: plan.filter((p) => p.action === 'copy').length,
    refreshed: plan.filter((p) => p.action === 'refresh').length,
    up_to_date: plan.filter((p) => p.action === 'up-to-date').length,
    conflicts,
    entries,
  };
  if (!opts.run) return report;
  if (conflicts.length > 0) {
    throw new MoveRefused(
      `${conflicts.length} container key(s) hold data this tool did not copy (${conflicts.map((c) => c.key).join(', ')}). ` +
        'The new release has probably already written them; copying over them would lose that. Nothing was written.'
    );
  }

  for (const p of plan) {
    if (p.action === 'up-to-date') {
      await client.hset(recordKey(ctx), { [p.key]: p.digest });
      continue;
    }
    const target = kc(ctx, p.key);
    await writeValue(client, ctx, target, p.source, await client.ttl(prefix + p.key));
    // Read back: the copy is only recorded once it is known to be exact.
    const back = digest(await readValue(client, target));
    if (back !== p.digest) throw new MoveRefused(`${p.key} did not read back as written. Run again; it is safe.`);
    await client.hset(recordKey(ctx), { [p.key]: p.digest });
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
