// lib/snapshot-job.ts
//
// The daily snapshot, run once per container (#57). The cron (/api/snapshot)
// reads the registry and runs each active container on its own: one
// container's failure is reported for that container and costs the others
// nothing. At most CONCURRENCY run at once.
//
// Each run's outcome is kept in its container at "snapshot:runs", a hash of
// date -> {status, reason?, at, attempts}, and read back by /api/snapshot-runs.
// A container already recorded for the date is not run again, so a second
// delivery of the cron, or the later catch-up run in vercel.json, only does
// the containers that failed, came back unclean, or were never started.
//
// Until the data moves into containers (PRs 10 to 13), the app's data still
// lives under unscoped keys, and those belong to one container: this
// deployment's, by the rule sessions use (lib/sessions.ts). Only that one is
// snapshotted. Any other active container is reported as skipped, never run
// against the unscoped data, and if this deployment's container cannot be
// worked out, every container fails with the reason: a guess that turned out
// wrong would write one container's history into another's.
//
// If the registry cannot be read it is tried once more, then the cron fails
// loudly. It never falls back to a default container or to unscoped keys.
//
// Deferred: spreading the runs across a window. The job takes the date it is
// for (scheduledFor), which is the seam that needs.

import { redis, kc } from './storage';
import { CONTAINER_ENV, ContainerError, listContainers, type ContainerId, type ContainerRecord, type Ctx } from './containers';
import { pickDeployment } from './sessions';
import { computeNetWorth, recordFetch, isRecordable } from './networth';
import { rememberAccounts } from './last-known';
import { recordDirectory } from './links';
import { clearCaches } from './cache';

export const CONCURRENCY = 3;
export const REGISTRY_RETRY_MS = 1000;
/** No container is started after this long, so a run fits the route's
 *  maxDuration (300 s) with room for the slowest Plaid call (45 s) to finish.
 *  One not started is reported as deferred, for the catch-up run. */
export const START_BUDGET_MS = 200_000;
/** False until the data moves into containers (PRs 10 to 13): until then only
 *  the container the unscoped data belongs to is run (see the header). The
 *  PR that moves the last of it flips this, and every active container runs. */
export const DATA_IN_CONTAINERS = false;

export type RunStatus = 'recorded' | 'unclean' | 'failed';
export type RunRecord = { status: RunStatus; reason?: string; at: string; attempts: number };

export type ContainerOutcome = { container: ContainerId } & (
  | { status: RunStatus; reason?: string; ms: number }
  | { status: 'already' } // recorded earlier for this date
  | { status: 'skipped'; reason: string } // not run, and nothing written
  | { status: 'deferred' } // not started in time; the catch-up run does it
);

export type SnapshotReport = { scheduled_for: string; results: ContainerOutcome[]; failed: number };

type Registry = (ContainerRecord & { id: ContainerId })[];

function runsKey(ctx: Ctx): string {
  return kc(ctx, 'snapshot:runs');
}

/** The date a snapshot taken now is recorded under (lib/history.ts). */
export function snapshotDate(now: number = Date.now()): string {
  return new Date(now).toISOString().slice(0, 10);
}

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** The registry, read a second time if the first read fails. A damaged
 *  registry is not retried: it would read the same. */
export async function readRegistry(sleep: (ms: number) => Promise<void> = wait): Promise<Registry> {
  try {
    return await listContainers();
  } catch (err) {
    if (err instanceof ContainerError) throw err;
    console.error('Snapshot: the registry could not be read; trying once more.', errorName(err));
    await sleep(REGISTRY_RETRY_MS);
    return await listContainers();
  }
}

function errorName(err: unknown): string {
  return err instanceof Error ? err.name : typeof err;
}

/** A short reason safe to store and return. Upstash errors end with the
 *  command and its arguments, which can include stored values: cut there. */
export function reasonOf(err: unknown): string {
  if (err instanceof ContainerError) return err.message;
  const message = err instanceof Error ? err.message : '';
  const cut = message.split(', command was')[0].slice(0, 160);
  return cut ? `${errorName(err)}: ${cut}` : errorName(err);
}

function parseRun(value: unknown): RunRecord | null {
  let r: any = value;
  if (typeof value === 'string') {
    try {
      r = JSON.parse(value);
    } catch {
      return null;
    }
  }
  if (!r || typeof r !== 'object' || !['recorded', 'unclean', 'failed'].includes(r.status)) return null;
  if (typeof r.at !== 'string' || !Number.isSafeInteger(r.attempts)) return null;
  return { status: r.status, ...(typeof r.reason === 'string' ? { reason: r.reason } : {}), at: r.at, attempts: r.attempts };
}

export async function readRun(ctx: Ctx, date: string): Promise<RunRecord | null> {
  return parseRun(await redis().hget(runsKey(ctx), date));
}

/** The container's recorded runs, newest first. An unreadable entry is left
 *  out rather than failing the list. */
export async function readRuns(ctx: Ctx, limit: number = 30): Promise<({ date: string } & RunRecord)[]> {
  const all = ((await redis().hgetall(runsKey(ctx))) ?? {}) as Record<string, unknown>;
  return Object.entries(all)
    .map(([date, value]) => ({ date, run: parseRun(value) }))
    .filter((e): e is { date: string; run: RunRecord } => e.run !== null)
    .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0))
    .slice(0, limit)
    .map(({ date, run }) => ({ date, ...run }));
}

async function writeRun(ctx: Ctx, date: string, status: RunStatus, reason: string | undefined, now: number): Promise<void> {
  try {
    const prev = await readRun(ctx, date);
    const record: RunRecord = { status, ...(reason ? { reason } : {}), at: new Date(now).toISOString(), attempts: (prev?.attempts ?? 0) + 1 };
    await redis().hset(runsKey(ctx), { [date]: JSON.stringify(record) });
  } catch (err) {
    // The snapshot itself is done or not either way; only the record is lost.
    console.error('Snapshot: the outcome could not be recorded.', errorName(err));
  }
}

/**
 * The snapshot itself, for the container the unscoped data belongs to. The
 * same rule as the dashboard: only a clean, non-empty read records a total. A
 * partly failed one still records the accounts that answered, for their own
 * charts: on a day the app is not opened this is the only fetch.
 */
export async function snapshotData(ctx: Ctx): Promise<{ status: RunStatus; reason?: string }> {
  const { institutions, netWorth } = await computeNetWorth();
  const recorded = await recordFetch(institutions, netWorth);
  if (institutions.length === 0) return { status: 'unclean', reason: 'Nothing is linked.' };
  if (!institutions.every(isRecordable)) return { status: 'unclean', reason: 'Not every account could be read.' };

  // Record how to draw these accounts, alongside the balances. On a day the
  // app is never opened this is the only clean fetch there is, so without it
  // an account added since the last dashboard load would be in the snapshot
  // with nothing to render it from, and recovery would draw its institution
  // short (lib/last-known.ts reports the shortfall but cannot undo it).
  await rememberAccounts(institutions);
  await recordDirectory(institutions);
  await clearCaches(ctx); // cached payloads now have yesterday's history
  if (recorded === null) return { status: 'failed', reason: 'The snapshot could not be written.' };
  return { status: 'recorded' };
}

export type RunOptions = {
  scheduledFor: string;
  /** For tests. */
  clock?: () => number;
  work?: (ctx: Ctx) => Promise<{ status: RunStatus; reason?: string }>;
  concurrency?: number;
  budgetMs?: number;
  /** Whether the app's data lives in containers yet (DATA_IN_CONTAINERS). */
  scopedData?: boolean;
};

/** Runs every container in the registry for the date (see the header). */
export async function runSnapshots(registry: Registry, opts: RunOptions): Promise<SnapshotReport> {
  const clock = opts.clock ?? Date.now;
  const work = opts.work ?? snapshotData;
  const budget = opts.budgetMs ?? START_BUDGET_MS;
  const date = opts.scheduledFor;
  const started = clock();
  const scoped = opts.scopedData ?? DATA_IN_CONTAINERS;

  const dep = scoped ? null : pickDeployment(registry, process.env[CONTAINER_ENV] ?? '');
  if (dep?.kind === 'unusable') console.error(`Snapshot: no container can be snapshotted: ${dep.reason}`);

  const one = async (c: Registry[number]): Promise<ContainerOutcome> => {
    const container = c.id;
    // Filtered here, before anything is read or written: a container being
    // restored would get a snapshot of half-restored data.
    if (c.status !== 'active') return { container, status: 'skipped', reason: `The container is ${c.status}.` };
    if (dep?.kind === 'container' && dep.container !== container) {
      return { container, status: 'skipped', reason: 'Its data is not in containers yet.' };
    }
    if (clock() - started > budget) return { container, status: 'deferred' };

    const ctx: Ctx = { container };
    const t0 = clock();
    let outcome: { status: RunStatus; reason?: string };
    try {
      if ((await readRun(ctx, date))?.status === 'recorded') return { container, status: 'already' };
      if (dep && dep.kind !== 'container') throw new ContainerError(dep.kind === 'unusable' ? dep.reason : 'No container is set up.');
      outcome = await work(ctx);
    } catch (err) {
      console.error(`Snapshot failed for container ${container}:`, (err as any)?.response?.data || err);
      outcome = { status: 'failed', reason: reasonOf(err) };
    }
    await writeRun(ctx, date, outcome.status, outcome.reason, clock());
    return { container, ...outcome, ms: clock() - t0 };
  };

  const results = await inPool(registry, opts.concurrency ?? CONCURRENCY, one);
  return { scheduled_for: date, results, failed: results.filter((r) => r.status === 'failed').length };
}

/** `fn` over every item, at most `limit` at a time, results in order. `fn`
 *  must not throw: each container's failure is its own result. */
async function inPool<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const lane = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, lane));
  return out;
}
