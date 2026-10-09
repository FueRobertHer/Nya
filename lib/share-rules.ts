// lib/share-rules.ts
//
// What both sides of sharing (#45) go by: the ladder an account is shared at,
// how far ahead a share can end, and how the access log counts and how long
// it keeps what it counted. Its own module, free of server imports, because
// the server (lib/sharing.ts, lib/access-log.ts) and the Sharing drawer
// (components/Sharing.tsx) need the same values, and because the store
// catalogue (lib/stores.ts) loads the access log without loading
// lib/sharing.ts, and the Plaid client with it.

/** What an account's share shows, narrowest first: that it exists, its
 *  balance, or its balance and recent transactions. */
export const LEVELS = ['exists', 'balance', 'transactions'] as const;
export type Level = (typeof LEVELS)[number];

export function isLevel(v: unknown): v is Level {
  return (LEVELS as readonly unknown[]).includes(v);
}

/** The wider of two levels: the one that shows more. */
export function widerLevel(a: Level, b: Level): Level {
  return LEVELS.indexOf(a) >= LEVELS.indexOf(b) ? a : b;
}

/** The most days the access log keeps a showing (lib/access-log.ts). */
export const ACCESS_LOG_DAYS = 90;

/** How finely the access log counts: by the quarter hour, in UTC. Every time
 *  zone in use is a whole number of quarter hours from UTC, so each quarter
 *  hour falls inside one day wherever its reader is, and every showing can be
 *  put in the reader's own day exactly. */
export const ACCESS_LOG_SLOT_MINUTES = 15;

/** One day of a record of showings, in its reader's own time zone, as the
 *  drawer gets it (lib/sharing.ts connectionRecords): how many times it was
 *  shown that day, and how many accounts were shown at each level, each
 *  account once, at the widest level shown that day. Counts, not ids, so a
 *  day is the same small size however many accounts were shown. */
export type ShownDay = { day: string; times: number; levels: Record<Level, number> };

/** How many of a record's days the drawer shows before "Show all", and so
 *  asks for first. */
export const RECORD_FIRST_DAYS = 5;

/** Why a record of showings can't be had: "unreadable" (damaged),
 *  "unrecognised" (intact, but not understood), "unavailable" (couldn't be
 *  reached just now), or "record_id_unreadable" (the connection's log field
 *  is damaged, so which record is its can't be known). */
export type RecordProblem = 'unreadable' | 'unrecognised' | 'unavailable' | 'record_id_unreadable';

/** One record of showings as the drawer gets it: the days it has, in the
 *  reader's own time zone, newest first, and how many there are in all; or
 *  why it can't be shown. */
export type RecordSummary = { days: ShownDay[]; total_days: number } | { days: null; problem: RecordProblem };

/**
 * How far ahead a share's end can be, in days. The drawer's date picker goes
 * up to two years from today, and a share runs to the end of the day chosen;
 * two years with a leap day in them and that last day come to 732 days, and a
 * day more covers a change to or from daylight saving and a device clock a
 * little ahead of the server's.
 */
export const SHARE_END_MAX_DAYS = 733;
