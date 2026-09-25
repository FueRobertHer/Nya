// lib/snapshot-job.ts
//
// The daily snapshot, run once per container (#57). The cron (/api/snapshot)
// reads the registry and runs each active container on its own: one
// container's failure is reported for that container and costs the others
// nothing. At most CONCURRENCY run at once.
//
// Each run's outcome is kept in its container at "snapshot:runs", a hash of
// date -> {status, reason?, at, attempts}, and read back by /api/snapshot-runs.
// A run is marked "running" before it starts, so one the platform killed
// shows as that rather than as nothing. A container already recorded for the
// date is not run again, and one being run elsewhere (a second delivery of
// the cron) is left to it, so the catch-up cron (/api/snapshot/catchup) only
// does the containers that failed, came back unclean, or were deferred.
//
// "snapshot:" keys describe this environment's cron, not the data: exports
// leave them out and a restore keeps the target's own (lib/export.ts,
// lib/restore.ts).
//
// Until the data moves into containers (PRs 10 to 13), the app's data still
// lives under unscoped keys, and those belong to one container: this
// deployment's, by the rule sessions use (lib/sessions.ts). Only that one is
// snapshotted. Any other active container is reported as skipped, never run
// against the unscoped data. If this deployment's container cannot be worked
// out, or any container is being restored, every container fails with the
// reason: a guess that turned out wrong would write one container's history
// into another's, and a restore may be writing the very keys a snapshot would.
//
// If the registry cannot be read it is tried once more, then the cron fails
// loudly. It never falls back to a default container or to unscoped keys.
//
// Deferred: spreading the runs across a window. The job takes the date it is
// for (scheduledFor), which is the seam that needs.

import { redis, kc } from './storage';
import { CONTAINER_ENV, ContainerError, getContainer, listContainers, type ContainerId, type ContainerRecord, type Ctx } from './containers';
import { pickDeployment } from './sessions';
import { computeNetWorth, recordFetch, isRecordable } from './networth';
import { rememberAccounts } from './last-known';
import { recordDirectory } from './links';
import { clearCaches } from './cache';

export const CONCURRENCY = 3;
export const REGISTRY_RETRY_MS = 1000;
/**
 * No container is started later than this after the request began. The route
 * may run 300 s (maxDuration), and one container's run can take two Plaid
 * calls in series at up to 45 s each (balances, then holdings and liabilities
 * together), plus up to 3 s waiting out rate limits: 93 s, and the rest is
 * margin for the database. One not started is deferred to the catch-up run.
 */
export const START_BUDGET_MS = 180_000;
/** How long a run holds its container's lock: the route's maxDuration, so a
 *  run the platform killed releases it by the catch-up run. */
export const LOCK_SECONDS = 300;
/** False until the data moves into containers (PRs 10 to 13): until then only
 *  the container the unscoped data belongs to is run (see the header). Flip it
 *  only with a snapshot that reads each container's own data: the default one
 *  refuses to run while it is set. */
export const DATA_IN_CONTAINERS = false;

export type RunStatus = 'recorded' | 'unclean' | 'failed';
/** What is stored: a finished run's status, or "running" (started, not yet
 *  finished, or killed) or "deferred" (not started in time). */
export type StoredStatus = RunStatus | 'running' | 'deferred';
export type RunRecord = { status: StoredStatus; reason?: string; at: string; attempts: number };

export type ContainerOutcome = { container: ContainerId } & (
  | { status: RunStatus; reason?: string; ms: number }
  | { status: 'already' } // recorded earlier for this date
  | { status: 'running' } // being run by another invocation
  | { status: 'skipped'; reason: string } // not run, and nothing written
  | { status: 'deferred' } // not started in time; the catch-up run does it
);

export type SnapshotReport = { scheduled_for: string; results: ContainerOutcome[]; failed: number };

type Registry = (ContainerRecord & { id: ContainerId })[];

const STORED = new Set<string>(['recorded', 'unclean', 'failed', 'running', 'deferred']);

function runsKey(ctx: Ctx): string {
  return kc(ctx, 'snapshot:runs');
}

function lockKey(ctx: Ctx): string {
  return kc(ctx, 'snapshot:lock');
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
    console.error('Snapshot: the registry could not be read; trying once more.', reasonOf(err));
    await sleep(REGISTRY_RETRY_MS);
    return await listContainers();
  }
}

function errorName(err: unknown): string {
  return err instanceof Error ? err.name : typeof err;
}

/** A short reason safe to store, return and log. Upstash errors end with the
 *  command and its arguments, which can include stored values: cut there.
 *  Plaid's error code is kept; its response body is not. */
export function reasonOf(err: unknown): string {
  if (err instanceof ContainerError) return err.message;
  const plaid = (err as any)?.response?.data?.error_code;
  if (typeof plaid === 'string') return `Plaid: ${plaid.slice(0, 80)}`;
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
  if (!r || typeof r !== 'object' || !STORED.has(r.status)) return null;
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

/** Stores the outcome for the date. `attempts` counts the runs started, so
 *  only "running" adds one. Never throws: the record is best effort. */
async function writeRun(ctx: Ctx, date: string, status: StoredStatus, reason: string | undefined, now: number): Promise<void> {
  try {
    const prev = await readRun(ctx, date);
    const attempts = (prev?.attempts ?? 0) + (status === 'running' ? 1 : 0);
    const record: RunRecord = { status, ...(reason ? { reason } : {}), at: new Date(now).toISOString(), attempts };
    await redis().hset(runsKey(ctx), { [date]: JSON.stringify(record) });
  } catch (err) {
    console.error('Snapshot: the outcome could not be recorded.', reasonOf(err));
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

/** snapshotData reads the unscoped data. Run once per container, it would
 *  fetch and record that same data for each, and mark each one recorded. */
async function refuseScoped(): Promise<never> {
  throw new ContainerError('The snapshot does not read data from containers yet.');
}

export type RunOptions = {
  scheduledFor: string;
  /** When the request began, for the start budget. */
  startedAt?: number;
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
  const scoped = opts.scopedData ?? DATA_IN_CONTAINERS;
  const work = opts.work ?? (scoped ? refuseScoped : snapshotData);
  const budget = opts.budgetMs ?? START_BUDGET_MS;
  const date = opts.scheduledFor;
  const started = opts.startedAt ?? clock();

  // While the data is unscoped, one container owns it, and nothing may run
  // while that cannot be worked out or while any container is being restored.
  let dep: { container: ContainerId } | null = null;
  let blocked: string | null = null;
  if (!scoped) {
    const d = pickDeployment(registry, process.env[CONTAINER_ENV] ?? '');
    if (registry.some((c) => c.status === 'restoring')) blocked = 'A container is being restored.';
    else if (d.kind === 'container') dep = { container: d.container };
    else blocked = d.kind === 'unusable' ? d.reason : 'No container is set up.';
    if (blocked) console.error(`Snapshot: no container can be snapshotted: ${blocked}`);
  }

  const one = async (c: Registry[number]): Promise<ContainerOutcome> => {
    const container = c.id;
    const ctx: Ctx = { container };
    // Filtered here, before anything is read or written: a container being
    // restored would get a snapshot of half-restored data.
    if (c.status !== 'active') return { container, status: 'skipped', reason: `The container is ${c.status}.` };
    if (dep && dep.container !== container) return { container, status: 'skipped', reason: 'Its data is not in containers yet.' };

    const t0 = clock();
    let locked = false;
    let outcome: { status: RunStatus; reason?: string };
    try {
      if ((await readRun(ctx, date))?.status === 'recorded') return { container, status: 'already' };
      if (clock() - started > budget) {
        await writeRun(ctx, date, 'deferred', undefined, clock());
        return { container, status: 'deferred' };
      }
      if (blocked) throw new ContainerError(blocked);
      locked = (await redis().set(lockKey(ctx), date, { nx: true, ex: LOCK_SECONDS })) !== null;
      if (!locked) return { container, status: 'running' };
      // Checked again with the lock held: the registry was read up to minutes
      // ago, and a restore may have started since.
      const now = await getContainer(container);
      if (now?.status !== 'active') throw new ContainerError(`The container is ${now?.status ?? 'gone from the registry'}.`);
      await writeRun(ctx, date, 'running', undefined, clock());
      outcome = await work(ctx);
    } catch (err) {
      console.error(`Snapshot failed for container ${container}:`, reasonOf(err));
      outcome = { status: 'failed', reason: reasonOf(err) };
    }
    await writeRun(ctx, date, outcome.status, outcome.reason, clock());
    if (locked) await redis().del(lockKey(ctx)).catch(() => {}); // else it expires
    return { container, ...outcome, ms: clock() - t0 };
  };

  const results = await inPool(registry, opts.concurrency ?? CONCURRENCY, one);
  return { scheduled_for: date, results, failed: results.filter((r) => r.status === 'failed').length };
}

/** Whether every container that ran failed: then nothing was snapshotted and
 *  the cron should say so with its status, not only in its body. */
export function nothingSucceeded(report: SnapshotReport): boolean {
  return report.failed > 0 && report.results.every((r) => r.status === 'failed' || r.status === 'skipped' || r.status === 'deferred');
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
