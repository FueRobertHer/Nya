// lib/share-rules.ts
//
// What both sides of sharing (#45) go by: the ladder an account is shared at,
// how far ahead a share can end, and how long the access log keeps when someone
// looked. Its own module, free of server imports, because the server
// (lib/sharing.ts, lib/access-log.ts) and the Sharing drawer
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

/** How many days the access log keeps (lib/access-log.ts). */
export const ACCESS_LOG_DAYS = 90;

/**
 * How far ahead a share's end can be, in days. The drawer's date picker goes
 * up to two years from today, and a share runs to the end of the day chosen;
 * two years with a leap day in them and that last day come to 732 days, and a
 * day more covers a change to or from daylight saving and a device clock a
 * little ahead of the server's.
 */
export const SHARE_END_MAX_DAYS = 733;
