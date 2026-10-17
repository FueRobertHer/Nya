// lib/weekly-summary/week.ts
//
// Which week a summary covers, and when one is due: calendar days on the
// person's own calendar (their time zone, lib/weekly-summary/settings.ts),
// never UTC's. Pure.
//
// THE WEEK of a summary is the seven days before the day it comes on (its send
// day): sent on Monday, October 12, it covers Monday, October 5 through Sunday,
// October 11. A week is known by its send day, which the record of what was
// sent keeps (lib/weekly-summary/store.ts), so a week never goes twice.
//
// WHEN ONE IS DUE. The daily job runs at a fixed UTC time, which is a
// different hour on each person's calendar, and from one day to the next is
// always the next day there, with one exception: a change of clocks near
// midnight on the person's calendar can skip a day there (Sydney's clocks go
// forward at 2 a.m., which moves the job from 11 p.m. on Saturday to midnight
// on Monday), or give one twice. Given twice, the record keeps it to one. So a
// summary still goes on any of the CATCH_UP_DAYS after its send day if it
// hasn't gone, as long as the setting was chosen before that day began, which
// also covers a day the job couldn't reach (no time left, a snapshot that
// failed until the next day). A setting changed since the day began waits for
// the next send day instead: turning it on, or moving it, never brings a late
// one at once.
//
// NEVER A WEEK OVER AGAIN. Moving the day can bring a send day only days after
// the last summary went: Monday's sent, then moved to Tuesday, would send
// six of the same days again the next day. So a summary goes only when at
// least MIN_NEW_DAYS of its seven days weren't in the one before; otherwise
// the first to go is the next week's.

import { addDays } from '../recurring';
import { dayIn, daysFrom } from '../report/period';
import type { Weekday } from './settings';

/** Days after its send day a summary may still go (see the header). */
export const CATCH_UP_DAYS = 2;
/** The fewest of a summary's seven days that weren't in the one before it
 *  (see NEVER A WEEK OVER AGAIN). */
export const MIN_NEW_DAYS = 4;

/** The day of the week of a calendar day (YYYY-MM-DD), 0 for Sunday. */
export function weekdayOf(day: string): Weekday {
  return new Date(`${day}T00:00:00Z`).getUTCDay() as Weekday;
}

/** The latest `weekday` on or before `today`: the send day of the summary
 *  that is this week's. */
export function sendDayOn(today: string, weekday: Weekday): string {
  return addDays(today, -((weekdayOf(today) - weekday + 7) % 7));
}

/** The seven days a summary sent on `sendDay` covers. */
export function weekBefore(sendDay: string): { first: string; last: string } {
  return { first: addDays(sendDay, -7), last: addDays(sendDay, -1) };
}

/** The day `now` is on in `zone`, or null for a zone this runtime doesn't know. */
export function todayIn(now: number, zone: string): string | null {
  return dayIn(now, zone);
}

/**
 * The send day of the summary due today, or null when none is (see WHEN ONE
 * IS DUE): today is the person's send day, or one of the CATCH_UP_DAYS after
 * it with the setting chosen before it began; and no summary went for it, or
 * for a send day fewer than MIN_NEW_DAYS before it (`sent`), which covers a
 * later one too. `chosenOn` is the day, on the person's calendar, the setting
 * was last changed.
 */
export function dueSendDay(today: string, weekday: Weekday, sent: string | null, chosenOn: string | null): string | null {
  const day = sendDayOn(today, weekday);
  const late = daysFrom(day, today);
  if (late > CATCH_UP_DAYS) return null;
  if (late > 0 && (chosenOn === null || chosenOn >= day)) return null;
  if (sent !== null && daysFrom(sent, day) < MIN_NEW_DAYS) return null;
  return day;
}
