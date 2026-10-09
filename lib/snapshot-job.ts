// lib/snapshot-job.ts
//
// The daily snapshot, run once per container (#57). The cron (/api/snapshot)
// reads the registry and runs each active container on its own: one
// container's failure is reported for that container and costs the others
// nothing. At most CONCURRENCY run at once.
//
// Each run's outcome is kept in its container at "snapshot:runs", a hash of
// date -> {status, reason?, at, attempts, holdings_failed?}, and read back by
// /api/snapshot-runs. `holdings_failed` counts the accounts whose positions
// could not be written to holdings history (lib/holdings-history.ts): counted
// beside the outcome, never part of it, since the snapshot is the net worth.
// A run is marked "running" before it starts, so one the platform killed
// shows as that rather than as nothing. A container already recorded for the
// date is not run again (checked again once its lock is held, and a recorded
// day is never overwritten by a worse outcome), and one being run elsewhere
// (a second delivery of the cron) is left to it, so the catch-up cron
// (/api/snapshot/catchup) only does the containers that failed, came back
// unclean, were deferred, or had nothing linked (in case something was linked
// since; no Plaid calls), and those recorded with `holdings_failed`: a day's
// positions can't be fetched later, so the catch-up runs the day again for
// them. That fetch is the free one a dashboard load makes (Plaid bills
// holdings per Item per month), and the day's total it records again is as
// measured as the first.
// `attempts` counts the runs started; a run refused before starting (its
// container no longer active) is stored as failed without adding one.
// Entries older than RUNS_KEEP_DAYS are pruned.
//
// Each run also prunes the container's records of showings (lib/access-log.ts):
// the nightly pass that holds them to ACCESS_LOG_DAYS even where nothing is
// shown again, and deletes those whose connection has ended, going by the
// connections as they are when each container's records have been read
// (lib/sharing.ts nightlyLogIds, one per run, so a connection field that
// can't be read is logged once a run). It goes first in the container's run,
// before the snapshot, so it is over before the emails start; it takes on no
// more after PRUNE_BUDGET_MS, and never throws, so it costs the snapshot
// nothing but that time, and the emails at most that much of theirs, never
// the run past MAIL_DEADLINE_MS or maxDuration.
//
// "snapshot:" keys describe this environment's cron, not the data: exports
// leave them out and a restore keeps the target's own (lib/export.ts,
// lib/restore.ts).
//
// Each container's snapshot reads and writes only that container's data
// (#53). A container that is not active is skipped before anything is read
// or written, and its status is read again once its lock is held, since the
// registry was read up to minutes before. A restore that starts after that,
// mid-run, is not excluded: restore does not look at the lock.
//
// If the registry cannot be read it is tried once more, then the cron fails
// loudly. It never falls back to a default container or to unscoped keys.
//
// The emails about bank connections (#51) go once every container has run:
// each container's run decides what is due about its own connections, and
// they are sent together afterwards, within a deadline of their own
// (MAIL_DEADLINE_MS), so a fault many containers share is seen before anybody
// is written to (lib/connection-notices.ts).
//
// Deferred: spreading the runs across a window. The job takes the date it is
// for (scheduledFor), which is the seam that needs.

import { redis, kc } from './storage';
import { randomUUID } from 'node:crypto';
import { ContainerError, getContainer, listContainers, type ContainerId, type ContainerRecord, type Ctx } from './containers';
import { computeNetWorth, recordFetch, isRecordable } from './networth';
import { rememberAccounts } from './last-known';
import { recordDirectory } from './links';
import { clearCaches } from './cache';
import { pruneAccessLog } from './access-log';
import { nightlyLogIds } from './sharing';
import { MAIL_BUDGET_MS, prepareNotices, sendNotices, type PendingNotices, type SendOptions } from './connection-notices';

export const CONCURRENCY = 3;
export const REGISTRY_RETRY_MS = 1000;
/**
 * No container is started later than this after the request began. The route
 * may run 300 s (maxDuration), and one container's run can take two Plaid
 * calls in series at up to 45 s each (balances, then holdings and liabilities
 * together). A rate-limited balance call adds at most one more try (a 429
 * that took up to 10 s, a 1 s wait, then up to 45 s: lib/rate-limit-retry.ts),
 * so about 101 s at worst, and the rest is margin for the database: the
 * snapshot, the day's positions for holdings history (a few round trips per
 * container, beside the snapshot), the connections' records, and the nightly
 * pass over the records of showings (PRUNE_BUDGET_MS at most). One not
 * started is deferred to the catch-up run. The emails about connections are
 * not in it: they go once every container has run, within MAIL_DEADLINE_MS.
 */
export const START_BUDGET_MS = 180_000;
/** How long the nightly pass over a container's records of showings may go
 *  on taking on more (lib/access-log.ts pruneAccessLog): what is left waits
 *  for the next night. With START_BUDGET_MS and the slowest Plaid calls it
 *  still leaves the run within MAIL_DEADLINE_MS. */
export const PRUNE_BUDGET_MS = 3_000;
/**
 * The emails about connections (lib/connection-notices.ts) are all over by
 * this long after the request began. Each one is started only if finding whom
 * to write to and the send can both end by then, each with a short timeout of
 * its own, so however slow the email service, mail never pushes the run past
 * maxDuration: what doesn't fit waits for the next run, unmarked. They also
 * get no more than MAIL_BUDGET_MS in all. Whatever the containers' runs take
 * (Plaid, the snapshot, holdings history, a catch-up run again for positions)
 * only starts the emails later, so it can shorten their time, never extend
 * the run past this.
 */
export const MAIL_DEADLINE_MS = 285_000;
/** How long a run holds its container's lock: the route's maxDuration, so a
 *  run the platform killed releases it by the catch-up run. The lock holds a
 *  token only its taker releases, so a run that outlives it (anywhere the
 *  platform does not end the function at maxDuration) cannot free another's. */
export const LOCK_SECONDS = 300;
/** How many days of outcomes are kept. */
export const RUNS_KEEP_DAYS = 90;

/** Deletes the lock only if it still holds this run's token. The first line
 *  names the script for the test double. */
export const RELEASE_LOCK = `-- nya:release-lock
if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end
return 0`;

/** "empty": nothing is linked, so there is nothing to snapshot; not a
 *  failure. "unclean": something could not be read, so no total. */
export type RunStatus = 'recorded' | 'empty' | 'unclean' | 'failed';
/** What is stored: a finished run's status, or "running" (started, not yet
 *  finished, or killed) or "deferred" (not started in time). */
export type StoredStatus = RunStatus | 'running' | 'deferred';
export type RunRecord = { status: StoredStatus; reason?: string; at: string; attempts: number; holdings_failed?: number };

/** What one container's snapshot came to. `holdings_failed`, when set, counts
 *  the accounts whose positions could not be written to holdings history:
 *  beside the status, which it never changes. */
export type WorkOutcome = { status: RunStatus; reason?: string; holdings_failed?: number };

export type ContainerOutcome = { container: ContainerId } & (
  | (WorkOutcome & { ms: number })
  // Recorded earlier for this date. With holdings_failed: run again for its
  // positions, which still could not all be written.
  | { status: 'already'; holdings_failed?: number }
  | { status: 'running' } // being run by another invocation
  | { status: 'skipped'; reason: string } // not run, and nothing written
  | { status: 'deferred' } // not started in time; the catch-up run does it
);

export type SnapshotReport = { scheduled_for: string; results: ContainerOutcome[]; failed: number };

type Registry = (ContainerRecord & { id: ContainerId })[];

const STORED = new Set<string>(['recorded', 'empty', 'unclean', 'failed', 'running', 'deferred']);

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
  return {
    status: r.status,
    ...(typeof r.reason === 'string' ? { reason: r.reason } : {}),
    at: r.at,
    attempts: r.attempts,
    ...(Number.isSafeInteger(r.holdings_failed) && r.holdings_failed > 0 ? { holdings_failed: r.holdings_failed } : {}),
  };
}

export async function readRun(ctx: Ctx, date: string): Promise<RunRecord | null> {
  return parseRun(await redis().hget(runsKey(ctx), date));
}

/** Whether the date needs no run: recorded, positions and all. A day recorded
 *  with `holdings_failed` is run again for them (see the header). */
function finished(run: RunRecord | null): boolean {
  return run?.status === 'recorded' && !run.holdings_failed;
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

/**
 * Stores the outcome for the date. `attempts` counts the runs started, so
 * only "running" adds one (a read then a write: two writers at once can lose
 * one, which only miscounts). A recorded day is never overwritten. An outcome
 * reached without the lock (a deferral, or a refusal before it was taken) is
 * stored only when the day has no record yet: another invocation may hold the
 * lock and be running, and an earlier outcome's reason says more. Never
 * throws: the record is best effort.
 */
async function writeRun(
  ctx: Ctx,
  date: string,
  status: StoredStatus,
  reason: string | undefined,
  now: number,
  opts: { onlyIfNew?: boolean; holdingsFailed?: number } = {}
): Promise<void> {
  try {
    const prev = await readRun(ctx, date);
    if (prev?.status === 'recorded' && status !== 'recorded') return;
    if (prev && opts.onlyIfNew) return;
    const attempts = (prev?.attempts ?? 0) + (status === 'running' ? 1 : 0);
    const record: RunRecord = {
      status,
      ...(reason ? { reason } : {}),
      at: new Date(now).toISOString(),
      attempts,
      ...(opts.holdingsFailed ? { holdings_failed: opts.holdingsFailed } : {}),
    };
    await redis().hset(runsKey(ctx), { [date]: JSON.stringify(record) });
  } catch (err) {
    console.error('Snapshot: the outcome could not be recorded.', reasonOf(err));
    return;
  }
  await pruneRuns(ctx, now);
}

/** Drops outcomes older than RUNS_KEEP_DAYS. After every write, so a
 *  container that is only ever refused is pruned too. Never throws. */
async function pruneRuns(ctx: Ctx, now: number): Promise<void> {
  try {
    const cutoff = snapshotDate(now - RUNS_KEEP_DAYS * 24 * 60 * 60 * 1000);
    const old = (await redis().hkeys(runsKey(ctx))).filter((date) => date < cutoff);
    if (old.length > 0) await redis().hdel(runsKey(ctx), ...old);
  } catch (err) {
    console.error('Snapshot: old outcomes could not be pruned.', reasonOf(err));
  }
}

/**
 * The snapshot itself, for one container, from that container's data. The
 * same rule as the dashboard: only a clean, non-empty read records a total. A
 * partly failed one still records the accounts that answered, for their own
 * charts: on a day the app is not opened this is the only fetch. Positions go
 * to holdings history the same way (recordFetch), and a failed holdings write
 * is only counted beside the status.
 */
export async function snapshotData(ctx: Ctx, outbox?: PendingNotices[], live = nightlyLogIds()): Promise<WorkOutcome> {
  // The records of showings first (see the header): never throws, and stops
  // taking on more after PRUNE_BUDGET_MS.
  await pruneAccessLog(ctx, Date.now(), live, { until: Date.now() + PRUNE_BUDGET_MS });
  const { institutions, netWorth } = await computeNetWorth(ctx);
  const { date: recorded, holdings } = await recordFetch(ctx, institutions, netWorth);
  const counted = holdings.failed > 0 ? { holdings_failed: holdings.failed } : {};
  // Each connection's last good sync, and what is due about a connection that
  // broke or will end soon (lib/connection-notices.ts), whose email goes into
  // the run's outbox, sent once every container has run. After the snapshot
  // and its positions are recorded, and before the returns below: an unclean
  // run is exactly when a connection is broken. It never costs the snapshot:
  // a failure is logged, and the next run tries again.
  try {
    const pending = await prepareNotices(ctx, institutions);
    if (outbox) outbox.push(pending);
    else await sendNotices([pending]);
  } catch (err) {
    console.error(`Connection notices failed for container ${ctx.container}:`, reasonOf(err));
  }
  if (institutions.length === 0) return { status: 'empty', reason: 'Nothing is linked.' };
  if (!institutions.every(isRecordable)) return { status: 'unclean', reason: 'Not every account could be read.', ...counted };

  // Record how to draw these accounts, alongside the balances. On a day the
  // app is never opened this is the only clean fetch there is, so without it
  // an account added since the last dashboard load would be in the snapshot
  // with nothing to render it from, and recovery would draw its institution
  // short (lib/last-known.ts reports the shortfall but cannot undo it).
  await rememberAccounts(ctx, institutions);
  await recordDirectory(ctx, institutions);
  await clearCaches(ctx); // cached payloads now have yesterday's history
  if (recorded === null) return { status: 'failed', reason: 'The snapshot could not be written.', ...counted };
  return { status: 'recorded', ...counted };
}

export type RunOptions = {
  scheduledFor: string;
  /** When the request began, for the start budget. */
  startedAt?: number;
  /** For tests. */
  clock?: () => number;
  /** The container's run; whatever it puts in the outbox is emailed once
   *  every container has run. */
  work?: (ctx: Ctx, outbox: PendingNotices[]) => Promise<WorkOutcome>;
  concurrency?: number;
  budgetMs?: number;
  /** For tests: how the emails reach Resend and whom they go to. */
  mail?: Omit<SendOptions, 'clock' | 'deadline'>;
};

/** Runs every container in the registry for the date (see the header). */
export async function runSnapshots(registry: Registry, opts: RunOptions): Promise<SnapshotReport> {
  const clock = opts.clock ?? Date.now;
  const live = nightlyLogIds();
  const work = opts.work ?? ((ctx: Ctx, outbox: PendingNotices[]) => snapshotData(ctx, outbox, live));
  const budget = opts.budgetMs ?? START_BUDGET_MS;
  const date = opts.scheduledFor;
  const started = opts.startedAt ?? clock();
  const outbox: PendingNotices[] = [];

  const one = async (c: Registry[number]): Promise<ContainerOutcome> => {
    const container = c.id;
    const ctx: Ctx = { container };
    // Filtered here, before anything is read or written: a container being
    // restored would get a snapshot of half-restored data.
    if (c.status !== 'active') return { container, status: 'skipped', reason: `The container is ${c.status}.` };

    const t0 = clock();
    const token = randomUUID();
    let locked = false;
    let outcome: WorkOutcome;
    // The date's record as last read. A day recorded already is run again
    // only for its positions, and is reported as recorded whatever that run
    // comes to: a worse outcome never replaces its record (writeRun).
    let prior: RunRecord | null = null;
    const already = (run: RunRecord): ContainerOutcome => ({
      container,
      status: 'already',
      ...(run.holdings_failed ? { holdings_failed: run.holdings_failed } : {}),
    });
    try {
      prior = await readRun(ctx, date);
      if (finished(prior)) return { container, status: 'already' };
      if (clock() - started > budget) {
        if (prior?.status === 'recorded') return already(prior);
        await writeRun(ctx, date, 'deferred', undefined, clock(), { onlyIfNew: true });
        return { container, status: 'deferred' };
      }
      locked = (await redis().set(lockKey(ctx), token, { nx: true, ex: LOCK_SECONDS })) !== null;
      if (!locked) return { container, status: 'running' };
      // With the lock held: another run may have finished between the check
      // above and taking the lock.
      prior = await readRun(ctx, date);
      if (finished(prior)) {
        await release(ctx, token);
        return { container, status: 'already' };
      }
      // And the registry again: it was read up to minutes ago, and a restore
      // may have started since.
      await recheck(container);
      await writeRun(ctx, date, 'running', undefined, clock());
      outcome = await work(ctx, outbox);
    } catch (err) {
      console.error(`Snapshot failed for container ${container}:`, reasonOf(err));
      outcome = { status: 'failed', reason: reasonOf(err) };
    }
    await writeRun(ctx, date, outcome.status, outcome.reason, clock(), { onlyIfNew: !locked, holdingsFailed: outcome.holdings_failed });
    if (locked) await release(ctx, token);
    if (prior?.status === 'recorded' && outcome.status !== 'recorded') return already(prior);
    return { container, ...outcome, ms: clock() - t0 };
  };

  const results = await inPool(registry, opts.concurrency ?? CONCURRENCY, one);
  // The emails, once every container has run: a fault many containers share is
  // seen before anybody is written to, and mail has a deadline of its own,
  // never the snapshots' time (lib/connection-notices.ts).
  if (outbox.length > 0) {
    const deadline = Math.min(started + MAIL_DEADLINE_MS, clock() + MAIL_BUDGET_MS);
    await sendNotices(outbox, { ...opts.mail, clock, deadline }).catch((err) => console.error('Connection notices: the emails could not be sent.', reasonOf(err)));
  }
  return { scheduled_for: date, results, failed: results.filter((r) => r.status === 'failed').length };
}

/** The container is still active. */
async function recheck(container: ContainerId): Promise<void> {
  const rec = await getContainer(container);
  if (rec?.status !== 'active') throw new ContainerError(`The container is ${rec?.status ?? 'gone from the registry'}.`);
}

/** Frees the lock if it is still this run's. Never throws: it expires. */
async function release(ctx: Ctx, token: string): Promise<void> {
  try {
    await redis().eval(RELEASE_LOCK, [lockKey(ctx)], [token]);
  } catch (err) {
    console.error('Snapshot: the lock could not be released; it will expire.', reasonOf(err));
  }
}

const SNAPSHOTTED = new Set<string>(['recorded', 'already', 'running']);

/** Whether no container has a snapshot for the date, or is getting one: every
 *  container failed, came back unclean, was deferred, was skipped (the only
 *  one restoring or archived, say), or had nothing linked. Nothing was
 *  recorded, and the cron says so with its status, not only in its body.
 *  Nothing linked is neutral: all of them empty is a quiet day, not a failure,
 *  but one empty container does not hide every other one failing. */
export function nothingSnapshotted(report: SnapshotReport): boolean {
  if (report.results.some((r) => SNAPSHOTTED.has(r.status))) return false;
  return !report.results.every((r) => r.status === 'empty');
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
