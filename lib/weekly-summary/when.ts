// lib/weekly-summary/when.ts
//
// When a weekly summary comes, in the person's own time, for the card and the
// sheet to say (components/WeeklySummaryCard.tsx). Pure, safe in the browser.
//
// The daily job (lib/snapshot-job.ts) runs once a day for everyone, at
// DAILY_RUN_UTC_HOUR (vercel.json's /api/snapshot cron), and sends each
// summary at the run that falls on its day on the person's calendar
// (week.ts). Every calendar has one such run a day, so a summary always comes
// on the day chosen, but at an hour that depends on the time zone: about
// 9 a.m. in New York in summer, 2 p.m. in London, 10 p.m. in Tokyo, 11 p.m.
// in Brisbane, and in Sydney's summer, in Auckland and in Kiritimati, in the
// first hours of the day, as it begins (the run of the UTC day before).
// Where a change of clocks takes away the day's run, it comes with the next
// day's (week.ts CATCH_UP_DAYS). With the catch-up run, two hours later, when
// the day's update was held up.

import { dayIn } from '../report/period';
import { WEEKDAY_NAMES, type Weekday } from './settings';
import { weekdayOf } from './week';

/** The hour, in UTC, the daily job runs (vercel.json, test/weekly-summary-when.test.ts). */
export const DAILY_RUN_UTC_HOUR = 13;

const DAY_MS = 86_400_000;

/** "9 a.m.", "6:30 p.m.", "noon", "midnight": an hour and minute as the
 *  card says them. */
export function clockText(hour: number, minute: number): string {
  if (minute === 0 && hour === 0) return 'midnight';
  if (minute === 0 && hour === 12) return 'noon';
  const h = hour % 12 === 0 ? 12 : hour % 12;
  return `${h}${minute === 0 ? '' : `:${String(minute).padStart(2, '0')}`} ${hour < 12 ? 'a.m.' : 'p.m.'}`;
}

/** The daily run, as the person reads it: "1 p.m. UTC". */
export const RUN_TEXT = `${clockText(DAILY_RUN_UTC_HOUR, 0)} UTC`;

export type Delivery = {
  /** When the run is (epoch ms). */
  at: number;
  /** The day it is on the person's calendar (YYYY-MM-DD), a `weekday`. */
  day: string;
  /** Its time of day there. */
  hour: number;
  minute: number;
};

/**
 * The next daily run that falls on `weekday` in `zone`, from `now`: when the
 * next summary comes. Null for a zone this runtime doesn't know.
 */
export function nextDelivery(weekday: Weekday, zone: string, now: number = Date.now()): Delivery | null {
  const today = new Date(now);
  const base = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate(), DAILY_RUN_UTC_HOUR);
  let parts: Intl.DateTimeFormat;
  try {
    parts = new Intl.DateTimeFormat('en-US', { timeZone: zone, hour: 'numeric', minute: 'numeric', hourCycle: 'h23' });
  } catch {
    return null;
  }
  // Each calendar has one run a day, so a week and a day hold the next one,
  // but where a change of clocks takes a day's away.
  for (let k = 0; k <= 15; k++) {
    const at = base + k * DAY_MS;
    if (at < now) continue;
    const day = dayIn(at, zone);
    if (day === null) return null;
    if (weekdayOf(day) !== weekday) continue;
    const of = (type: string) => Number(parts.formatToParts(at).find((p) => p.type === type)?.value ?? NaN);
    return { at, day, hour: of('hour') % 24, minute: of('minute') };
  }
  return null;
}

/** When it comes, after the day: "at about 9 a.m.", "just after midnight, as
 *  the day begins" (`brief`: "just after midnight"). */
export function timeOfDay(d: Pick<Delivery, 'hour' | 'minute'>, brief = false): string {
  if (d.hour === 0 && d.minute < 30) return brief ? 'just after midnight' : 'just after midnight, as the day begins';
  return `at about ${clockText(d.hour, d.minute)}`;
}

/** "Mondays at about 9 a.m.", or null for a zone this runtime doesn't know. */
export function deliveryText(weekday: Weekday, zone: string, now: number = Date.now()): string | null {
  const d = nextDelivery(weekday, zone, now);
  return d ? `${WEEKDAY_NAMES[weekday]}s ${timeOfDay(d)}` : null;
}

/**
 * Whether two time zones keep the same clock every day of the coming year,
 * so a summary comes and counts its week alike in either: true of two names
 * for one zone, which runtimes spell differently (a browser calls
 * Asia/Kolkata Asia/Calcutta), and of zones that share their rules.
 */
export function sameClock(a: string, b: string, now: number = Date.now()): boolean {
  if (a === b) return true;
  let fa: Intl.DateTimeFormat;
  let fb: Intl.DateTimeFormat;
  try {
    const opts: Intl.DateTimeFormatOptions = { year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', hourCycle: 'h23' };
    fa = new Intl.DateTimeFormat('en-US', { ...opts, timeZone: a });
    fb = new Intl.DateTimeFormat('en-US', { ...opts, timeZone: b });
  } catch {
    return false;
  }
  for (let i = 0; i <= 366; i++) {
    const t = now + i * DAY_MS;
    if (fa.format(t) !== fb.format(t)) return false;
  }
  return true;
}
