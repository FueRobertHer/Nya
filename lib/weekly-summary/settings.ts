// lib/weekly-summary/settings.ts
//
// What the person chose about the weekly summary (lib/weekly-summary/): whether
// it comes at all, the day of the week it comes on, and the time zone their
// week is counted in. Off until they turn it on. The shape, the strict check a
// save goes through, and the words for a day. Pure, safe to import from client
// code; the store is lib/weekly-summary/store.ts, the route
// app/api/weekly-summary.
//
// THE TIME ZONE is the person's own, taken from their browser when they turn
// the summary on and editable after: the week is the seven days on their
// calendar before the day it comes, and "today" is their day. It is stored as
// the IANA name this runtime gives it ("America/New_York"). A stored one is
// checked for its form only (isWeeklySetting): a name another runtime's
// time-zone data doesn't know must still read, and the daily job then says it
// can't place it rather than guessing (lib/weekly-summary/job.ts). A save
// checks that this runtime knows it (parseWeeklyChoice).

import { canonicalTimeZone } from '../report/period';

export const WEEKLY_SETTING_VERSION = 1;

/** A day of the week, as Date.getUTCDay counts them: 0 is Sunday. */
export type Weekday = 0 | 1 | 2 | 3 | 4 | 5 | 6;

/** The day it comes on until the person picks another. */
export const DEFAULT_WEEKDAY: Weekday = 1;

/** "Send me one now" in a day (lib/weekly-summary/send-now.ts): enough to see
 *  one arrive, and try again. Here, where the settings card can read it. */
export const SENDS_NOW_PER_DAY = 3;

export const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'] as const;

export type WeeklySetting = {
  v: typeof WEEKLY_SETTING_VERSION;
  enabled: boolean;
  weekday: Weekday;
  /** An IANA time zone (see the header). */
  time_zone: string;
  /** When it was last changed (an ISO time). */
  updated_at: string;
};

/** What a save sets: the rest is filled in by the route. */
export type WeeklyChoice = Pick<WeeklySetting, 'enabled' | 'weekday' | 'time_zone'>;

const KEYS: readonly string[] = ['v', 'enabled', 'weekday', 'time_zone', 'updated_at'];
/** An IANA name's form, as lib/report/period.ts checks it before asking the
 *  runtime: letters first, at most three parts. */
const ZONE_FORM = /^[A-Za-z][A-Za-z0-9_+\-]*(?:\/[A-Za-z0-9_+\-]+){0,2}$/;

export const isWeekday = (v: unknown): v is Weekday => typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 6;

/** A time zone's name in the form one is written, whether or not this
 *  runtime knows it (see the header). */
export const isZoneName = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 64 && ZONE_FORM.test(v);

const isInstant = (v: unknown): v is string => typeof v === 'string' && v.length <= 64 && Number.isFinite(Date.parse(v));

/** The stored shape, CLOSED: a field this version doesn't know makes it
 *  unrecognised, never read as off (lib/repo.ts). */
export function isWeeklySetting(v: unknown): v is WeeklySetting {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
  const s = v as Record<string, unknown>;
  return (
    Object.keys(s).every((k) => KEYS.includes(k)) &&
    s.v === WEEKLY_SETTING_VERSION &&
    typeof s.enabled === 'boolean' &&
    isWeekday(s.weekday) &&
    isZoneName(s.time_zone) &&
    isInstant(s.updated_at)
  );
}

/**
 * A save's body, checked field by field: `enabled` a boolean, `weekday` a
 * whole number from 0 (Sunday) to 6, `time_zone` a zone this runtime knows,
 * which is kept as the runtime names it. Nothing else may be in it.
 */
export function parseWeeklyChoice(raw: unknown): { choice: WeeklyChoice } | { error: string } {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { error: 'Send the setting as an object.' };
  const body = raw as Record<string, unknown>;
  const extra = Object.keys(body).filter((k) => k !== 'enabled' && k !== 'weekday' && k !== 'time_zone');
  if (extra.length > 0) return { error: 'Only enabled, weekday and time_zone can be set.' };
  if (typeof body.enabled !== 'boolean') return { error: 'enabled must be true or false.' };
  if (!isWeekday(body.weekday)) return { error: 'weekday must be a whole number from 0 (Sunday) to 6 (Saturday).' };
  const zone = canonicalTimeZone(body.time_zone);
  if (zone === null) return { error: 'time_zone must be a time zone such as America/New_York.' };
  return { choice: { enabled: body.enabled, weekday: body.weekday, time_zone: zone } };
}

/** The setting before the person has saved one: off, on Mondays, in `zone`. */
export function defaultSetting(zone: string, now: number = Date.now()): WeeklySetting {
  return { v: WEEKLY_SETTING_VERSION, enabled: false, weekday: DEFAULT_WEEKDAY, time_zone: zone, updated_at: new Date(now).toISOString() };
}
