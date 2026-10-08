// lib/access-log.ts
//
// The access log of sharing (#45 step 2): for each person I share with, when
// they looked at what I share and what they were shown. It is mine: kept in my
// container, encrypted, as a map store on the storage seam (lib/repo.ts) with
// one entry per connection under the connection's id, and in my data download.
// It never holds who they are: the Sharing drawer names a connection by what I
// call them, read when it is shown.
//
// WRITTEN FROM THE OTHER PERSON'S REQUEST, by one named function in
// lib/sharing.ts (recordView), the only code that holds my Ctx on their behalf.
// It is the one write their request makes in my container, and all it writes is
// this: an hour, a count, and the accounts and levels the read returned, under
// the connection's id. Best effort: a failure is logged and never fails their
// read. My own preview of what they see records nothing.
//
// AGGREGATED BY THE HOUR. One row per connection per UTC hour, with how many
// times they looked in it and, for each account, the widest level it was shown
// at in that hour: someone refreshing ten times makes one row. Hours rather than
// days so the drawer can group them into my own days, in my time zone
// (components/Sharing.tsx), which the server doesn't know.
//
// KEPT FOR ACCESS_LOG_DAYS. Every write drops the hours older than that, and the
// hours from before the connection began (two people who connect again get the
// same connection id, and a new connection starts a new record). The nightly
// snapshot prunes every entry in the container the same way (pruneAccessLog,
// from lib/snapshot-job.ts) and removes those with nothing left, so the record
// of a connection nobody looks at any more, or one since removed, is gone within
// a day of its last hour passing ACCESS_LOG_DAYS. The drawer shows only what is
// kept, whenever the pruning last ran.
//
// READS. The drawer reads with getAllReport: an entry that can't be read shows
// as that, never as "they never looked". An unreadable one (damaged bytes) can
// be cleared, and only on the person's say-so (clearUnreadableAccessLog); an
// unrecognised one is left alone. A write reads its entry strictly (update), so
// it never replaces one it couldn't read; while an entry can't be read, looks
// on that connection go unrecorded, and the drawer says so.

import { defineMapStore, UnreadableEntriesError } from './repo';
import type { Ctx } from './containers';
import { ACCESS_LOG_DAYS, isLevel, widerLevel, type Level } from './share-rules';

export type LoggedHour = {
  /** The start of the UTC hour: "2026-10-04T13:00:00.000Z". */
  hour: string;
  /** How many times they looked in that hour: 1 or more. */
  views: number;
  /** What they were shown: each account's id, at the widest level it was
   *  shown at in that hour. */
  read: Record<string, Level>;
};

/** One connection's record: its hours, oldest first. */
export type AccessLog = { hours: LoggedHour[] };

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
/** The most hours a record can keep: every hour of ACCESS_LOG_DAYS, and the
 *  one the window starts in. */
const MAX_HOURS = ACCESS_LOG_DAYS * 24 + 1;
const HOUR = /^\d{4}-\d{2}-\d{2}T\d{2}:00:00\.000Z$/;

function isRead(v: unknown): v is Record<string, Level> {
  return typeof v === 'object' && v !== null && !Array.isArray(v) && Object.values(v).every(isLevel);
}

function isLoggedHour(v: unknown): v is LoggedHour {
  if (typeof v !== 'object' || v === null) return false;
  const h = v as LoggedHour;
  return typeof h.hour === 'string' && HOUR.test(h.hour) && Number.isSafeInteger(h.views) && h.views >= 1 && isRead(h.read);
}

/** The current shape: what every write stores, and every read checks. */
export function isAccessLog(v: unknown): v is AccessLog {
  return typeof v === 'object' && v !== null && Array.isArray((v as AccessLog).hours) && (v as AccessLog).hours.every(isLoggedHour);
}

export const accessLogStore = defineMapStore<AccessLog>('sharing-access-log', {
  what: 'records of when people you share with looked',
  isValid: isAccessLog,
  exportable: true, // mine: who looked at what I share, and when
  compress: true, // ninety days of hours, each naming what was read
});

/** The start of the UTC hour `t` falls in, as stored. */
export function hourOf(t: number): string {
  return new Date(Math.floor(t / HOUR_MS) * HOUR_MS).toISOString();
}

/**
 * The hours of a record still kept at `now`: those reaching into the last
 * ACCESS_LOG_DAYS and, given `since` (when the connection began, in ms), not
 * over before it. An hour is kept while any of it is inside, so a look is
 * never dropped early.
 */
export function keptHours(log: AccessLog, now: number, since?: number): LoggedHour[] {
  const window = now - ACCESS_LOG_DAYS * DAY_MS;
  const from = since !== undefined && Number.isFinite(since) ? Math.max(window, since) : window;
  return log.hours.filter((h) => Date.parse(h.hour) + HOUR_MS > from);
}

/**
 * The record with one more look at `now`, which was shown `read`: counted in
 * its hour, with each account at the widest level shown in that hour, and the
 * hours no longer kept dropped (see keptHours). Computes only, without changing
 * `current`, since update() may run it more than once.
 */
export function withView(current: AccessLog | null, now: number, read: Record<string, Level>, since?: number): AccessLog {
  const hour = hourOf(now);
  const kept = keptHours(current ?? { hours: [] }, now, since);
  const before = kept.find((h) => h.hour === hour);
  const hours = kept.filter((h) => h !== before);
  const merged: Record<string, Level> = { ...before?.read };
  for (const [id, level] of Object.entries(read)) merged[id] = merged[id] ? widerLevel(merged[id], level) : level;
  hours.push({ hour, views: (before?.views ?? 0) + 1, read: merged });
  // In order even when two servers' clocks disagree about which hour is newer.
  hours.sort((a, b) => (a.hour < b.hour ? -1 : a.hour > b.hour ? 1 : 0));
  return { hours: hours.slice(-MAX_HOURS) };
}

/** When one connection looked, for the drawer, or why that can't be shown:
 *  "unreadable" (damaged, and may be cleared), "unrecognised" (intact but not
 *  understood: left alone) or "unavailable" (the record couldn't be reached). */
export type LookedField = { views: LoggedHour[] } | { views: null; views_problem: 'unreadable' | 'unrecognised' | 'unavailable' };

/**
 * For my Sharing drawer: when each of my connections looked, by the hour,
 * oldest first, kept hours only (keptHours, from when each connection began).
 * Strict about each entry: one that can't be used is named as such, never
 * shown as no looks. A record that can't be reached at all is "unavailable" for
 * every connection rather than failing the drawer: it is only shown, and
 * nothing is written or removed on what this returns.
 */
export async function whenTheyLooked(
  ctx: Ctx,
  connections: readonly { id: string; since: string }[],
  now: number = Date.now()
): Promise<Map<string, LookedField>> {
  let report: Awaited<ReturnType<typeof accessLogStore.getAllReport>>;
  try {
    report = await accessLogStore.getAllReport(ctx);
  } catch (err) {
    console.error('Sharing: the access log could not be read', err instanceof Error ? err.name : err);
    return new Map(connections.map((c) => [c.id, { views: null, views_problem: 'unavailable' }]));
  }
  const unreadable = new Set(report.unreadable);
  const unrecognised = new Set(report.unrecognised);
  return new Map(
    connections.map((c): [string, LookedField] => {
      if (unreadable.has(c.id)) return [c.id, { views: null, views_problem: 'unreadable' }];
      if (unrecognised.has(c.id)) return [c.id, { views: null, views_problem: 'unrecognised' }];
      const log = report.entries.get(c.id);
      return [c.id, { views: log ? keptHours(log, now, Date.parse(c.since)) : [] }];
    })
  );
}

/**
 * Removes my record for a connection, only if it is unreadable (damaged bytes,
 * so nothing readable is lost), for the drawer's "Clear it", which the person
 * confirms first. False, with nothing removed, when it reads, isn't there, or
 * is unrecognised (intact data a later release may read). Nothing can make an
 * unreadable entry readable in between: a write reads its entry strictly
 * first, and refuses.
 */
export async function clearUnreadableAccessLog(ctx: Ctx, id: string): Promise<boolean> {
  try {
    await accessLogStore.get(ctx, id);
    return false; // it reads, or isn't there
  } catch (err) {
    if (!(err instanceof UnreadableEntriesError)) throw err; // says nothing about the entry
    if (!err.unreadable.includes(id)) return false; // unrecognised: intact, so never removed
  }
  await accessLogStore.remove(ctx, id);
  return true;
}

/**
 * Drops, from every entry of the container's record, the hours no longer kept
 * (keptHours), removing an entry with none left: the nightly pass that keeps the
 * record of a connection nobody looks at any more, or one since removed, to
 * ACCESS_LOG_DAYS. Each change goes through update(), which reads the entry
 * strictly and writes only if it is still what was read, so a look recorded
 * meanwhile is kept. Unreadable and unrecognised entries are left alone (only
 * the person may clear one). Never throws: a failure is logged, and the next
 * night tries again.
 */
export async function pruneAccessLog(ctx: Ctx, now: number = Date.now()): Promise<void> {
  let entries: Map<string, AccessLog>;
  try {
    ({ entries } = await accessLogStore.getAllReport(ctx));
  } catch (err) {
    console.error('Sharing: the access log could not be pruned', err instanceof Error ? err.name : err);
    return;
  }
  for (const [id, log] of entries) {
    if (keptHours(log, now).length === log.hours.length) continue;
    try {
      await accessLogStore.update(ctx, id, (current) => {
        if (!current) return null;
        const hours = keptHours(current, now);
        return hours.length > 0 ? { hours } : null;
      });
    } catch (err) {
      console.error('Sharing: an access log entry could not be pruned', err instanceof Error ? err.name : err);
    }
  }
}
