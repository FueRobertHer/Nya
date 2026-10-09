// lib/access-log.ts
//
// The access log of sharing (#45 step 2): each time what one person shares
// was shown to the other, and what it showed. There is one record per
// connection on each side: in my container, when what I share was shown to
// them; in theirs, when what they share was shown to me. Each is kept
// encrypted, as a map store on the storage seam (lib/repo.ts), under the
// connection's log id: a random id made for the connection (lib/sharing.ts),
// so no field name can be traced back to who is connected, and two people who
// connect again start new records.
//
// IT LIVES AS LONG AS THE CONNECTION. Ending a share keeps it. Removing or
// blocking the person, or either account being deleted, deletes it on both
// sides at once, by id, without reading it (lib/sharing.ts forgetShowings).
// Both people see it: I see when what I share was shown to them, and they see
// the same record (read through lib/sharing.ts). It is in both people's data
// downloads, inside "sharing" (lib/user-export.ts).
//
// WRITTEN FROM THE OTHER PERSON'S REQUEST, by one function in lib/sharing.ts
// (recordShowing), the only code that holds a Ctx on someone else's behalf:
// each time their app loads what I share, it is counted here. Best effort: a
// failure is logged and never fails their read. My own preview of what they
// see counts nothing.
//
// COUNTED BY THE QUARTER HOUR (ACCESS_LOG_SLOT_MINUTES), in UTC: one row per
// quarter hour, with how many times it was shown in it and, for each account,
// the widest level it was shown at. Ten loads in a quarter hour are one row.
// Every time zone in use is a whole number of quarter hours from UTC, so each
// row falls in exactly one of its reader's days: the drawer gets a record as
// days in the reader's own time zone, grouped here (shownByDay), a few at a
// time, never the rows themselves, so what it is sent stays small however
// much a record holds.
//
// KEPT FOR ACCESS_LOG_DAYS AT MOST. Every write drops what is older, and every
// night the snapshot (lib/snapshot-job.ts) prunes each record in the
// container, deleting those left empty and those whose connection has ended
// (in case a removal stopped part way): pruneAccessLog. Nightly backups keep a
// copy for as long as they keep everything else.
//
// READS are strict about each entry: one that can't be used is named as such,
// never shown as nothing. An unreadable one (damaged bytes) can be cleared
// once the person confirms (clearUnreadableAccessLog), whether or not its
// connection is still there; an unrecognised one is left alone. While either
// is there, showings on that connection go unrecorded: a write reads its entry
// strictly first (update), and refuses.

import { defineMapStore, UnreadableEntriesError } from './repo';
import type { Ctx } from './containers';
import { ACCESS_LOG_DAYS, ACCESS_LOG_SLOT_MINUTES, LEVELS, isLevel, widerLevel, type Level, type ShownDay } from './share-rules';

/** One quarter hour of a record. */
export type Showing = {
  /** The start of the quarter hour, UTC: "2026-10-04T13:15:00.000Z". */
  at: string;
  /** How many times it was shown in that quarter hour: 1 or more. */
  times: number;
  /** What was shown: each account's id, at the widest level it was shown at
   *  in that quarter hour. */
  read: Record<string, Level>;
};

/** One side's record on one connection: its quarter hours, oldest first. */
export type AccessLog = { shown: Showing[] };

const SLOT_MS = ACCESS_LOG_SLOT_MINUTES * 60_000;
const DAY_MS = 86_400_000;
/** The most quarter hours a record can keep: every one of ACCESS_LOG_DAYS,
 *  and the one the window starts in. */
const MAX_SLOTS = (ACCESS_LOG_DAYS * DAY_MS) / SLOT_MS + 1;
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00\.000Z$/;

/** The start of a quarter hour, exactly as slotOf writes it. */
function isSlot(v: unknown): v is string {
  if (typeof v !== 'string' || !INSTANT.test(v)) return false;
  const t = Date.parse(v);
  return Number.isFinite(t) && t % SLOT_MS === 0 && new Date(t).toISOString() === v;
}

function isRead(v: unknown): v is Record<string, Level> {
  return typeof v === 'object' && v !== null && !Array.isArray(v) && Object.values(v).every(isLevel);
}

function isShowing(v: unknown): v is Showing {
  if (typeof v !== 'object' || v === null) return false;
  const s = v as Showing;
  return isSlot(s.at) && Number.isSafeInteger(s.times) && s.times >= 1 && isRead(s.read);
}

/** The current shape: what every write stores, and every read checks. */
export function isAccessLog(v: unknown): v is AccessLog {
  return typeof v === 'object' && v !== null && Array.isArray((v as AccessLog).shown) && (v as AccessLog).shown.every(isShowing);
}

export const accessLogStore = defineMapStore<AccessLog>('sharing-access-log', {
  what: 'records of when what you share was shown',
  isValid: isAccessLog,
  // In the download, inside "sharing", beside the connection each belongs to
  // (lib/user-export.ts covers it there), with the other side's record of the
  // same connection.
  exportable: true,
  compress: true, // ninety days of quarter hours, each naming what was read
});

/** The start of the quarter hour `t` falls in, as stored. */
export function slotOf(t: number): string {
  return new Date(Math.floor(t / SLOT_MS) * SLOT_MS).toISOString();
}

/** The quarter hours of a record still kept at `now`: those reaching into the
 *  last ACCESS_LOG_DAYS. One is kept while any of it is inside, so nothing is
 *  dropped early. */
export function keptShowings(log: AccessLog, now: number): Showing[] {
  const from = now - ACCESS_LOG_DAYS * DAY_MS;
  return log.shown.filter((s) => Date.parse(s.at) + SLOT_MS > from);
}

/**
 * The record with one more showing at `now`, of `read`: counted in its
 * quarter hour, with each account at the widest level shown in it, and what
 * is no longer kept dropped (keptShowings). Computes only, without changing
 * `current`, since update() may run it more than once.
 */
export function withShowing(current: AccessLog | null, now: number, read: Record<string, Level>): AccessLog {
  const at = slotOf(now);
  const kept = keptShowings(current ?? { shown: [] }, now);
  const before = kept.find((s) => s.at === at);
  const shown = kept.filter((s) => s !== before);
  const merged: Record<string, Level> = { ...before?.read };
  for (const [id, level] of Object.entries(read)) merged[id] = merged[id] ? widerLevel(merged[id], level) : level;
  shown.push({ at, times: (before?.times ?? 0) + 1, read: merged });
  // In order even when two servers' clocks disagree about which is newer.
  shown.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
  return { shown: shown.slice(-MAX_SLOTS) };
}

/** A time zone a device sent, or null: an IANA name ("Asia/Kolkata") or
 *  another name or offset the server's time zone data knows, never anything
 *  it would have to guess at. */
export function timeZoneOf(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 64 || !/^[A-Za-z0-9_+\-/:]+$/.test(raw)) return null;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: raw });
    return raw;
  } catch {
    return null;
  }
}

/**
 * A record's quarter hours as days in `timeZone` (timeZoneOf), newest first:
 * for each day, how many times it was shown, and how many accounts at each
 * level, each account once, at the widest level shown that day. Every time
 * zone in use is a whole number of quarter hours from UTC, so a quarter hour
 * never straddles two days.
 */
export function shownByDay(shown: Showing[], timeZone: string): ShownDay[] {
  const format = new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
  const days = new Map<string, { times: number; read: Record<string, Level> }>();
  for (const s of shown) {
    const parts: Record<string, string> = {};
    for (const p of format.formatToParts(new Date(s.at))) parts[p.type] = p.value;
    const day = `${parts.year}-${parts.month}-${parts.day}`;
    const d = days.get(day) ?? { times: 0, read: {} };
    d.times += s.times;
    for (const [id, level] of Object.entries(s.read)) d.read[id] = d.read[id] ? widerLevel(d.read[id], level) : level;
    days.set(day, d);
  }
  return [...days.entries()]
    .sort(([a], [b]) => (a < b ? 1 : a > b ? -1 : 0))
    .map(([day, d]) => {
      const levels = Object.fromEntries(LEVELS.map((l) => [l, 0])) as Record<Level, number>;
      for (const level of Object.values(d.read)) levels[level]++;
      return { day, times: d.times, levels };
    });
}

/**
 * Removes my record under `id`, only if it is unreadable (damaged bytes, so
 * nothing readable is lost), for the drawer's "Clear", which the person
 * confirms first. Its connection may be gone. False, with nothing removed,
 * when it reads, isn't there, or is unrecognised (intact data a later release
 * may read). Nothing can make an unreadable entry readable in between: a write
 * reads its entry strictly first, and refuses.
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
 * The nightly pass over one container's records. Deletes each record whose
 * connection has ended, whole, by id, readable or not: the same rule as a
 * removal (lib/sharing.ts forgetShowings), for one that stopped part way.
 * Then drops, from each record left, the quarter hours no longer kept, and
 * deletes a record with none left; each change goes through update(), which
 * reads the entry strictly and writes only if it is still what was read, so a
 * showing recorded meanwhile is kept. Unreadable and unrecognised records of a
 * connection that is still there are left alone.
 *
 * `live` gives the log ids of the connections there are, or null when a record
 * in this container could belong to a connection whose fields can't be read
 * (lib/sharing.ts nightlyLogIds): then no record is deleted for its
 * connection, and only the quarter hours past ACCESS_LOG_DAYS go. It is read
 * after the records, so a record is only ever judged by connections read after
 * it was: a new connection's log id is saved before anything is written under
 * it. Never throws: a failure is logged, and the next night tries again.
 *
 * `until` (by the wall clock) bounds the time it takes: once it has passed,
 * nothing more is taken on (no further step, and no further record), and
 * what is left waits for the next night (lib/snapshot-job.ts PRUNE_BUDGET_MS).
 */
export async function pruneAccessLog(
  ctx: Ctx,
  now: number,
  live: (ctx: Ctx) => Promise<ReadonlySet<string> | null>,
  opts: { until?: number } = {}
): Promise<void> {
  const late = () => {
    if (opts.until === undefined || Date.now() < opts.until) return false;
    console.error('Sharing: the nightly pass over the records of showings stopped at its time limit; the next night goes on');
    return true;
  };
  try {
    const report = await accessLogStore.getAllReport(ctx);
    if (late()) return;
    const known = await live(ctx);
    if (known) {
      const ended = [...report.entries.keys(), ...report.unreadable, ...report.unrecognised].filter((id) => !known.has(id));
      if (ended.length > 0) await accessLogStore.remove(ctx, ...ended);
      for (const id of ended) report.entries.delete(id);
    }
    for (const [id, log] of report.entries) {
      if (keptShowings(log, now).length === log.shown.length) continue;
      if (late()) return;
      try {
        await accessLogStore.update(ctx, id, (current) => {
          if (!current) return null;
          const shown = keptShowings(current, now);
          return shown.length > 0 ? { shown } : null;
        });
      } catch (err) {
        console.error('Sharing: an access log entry could not be pruned', err instanceof Error ? err.name : err);
      }
    }
  } catch (err) {
    console.error('Sharing: the access log could not be pruned', err instanceof Error ? err.name : err);
  }
}
