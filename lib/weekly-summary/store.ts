// lib/weekly-summary/store.ts
//
// What Nya keeps for the weekly summary (lib/weekly-summary/), inside the
// person's container on the storage seam (lib/repo.ts), so deleting the
// account deletes it with the rest and the emails stop:
//
//   weekly-summary               what the person chose (settings.ts): on or
//                                off, the day, the time zone. A value store,
//                                edited by one person at a time; the one-click
//                                link to turn it off changes it too, through
//                                update(), which never builds on a value it
//                                couldn't read. Encrypted, and in the data
//                                download: it is the person's choice.
//   weekly-summary-state         the service's bookkeeping: the key the links
//                                to turn the summary off are signed with; the
//                                last week a summary went for, which keeps a
//                                week from going twice; a week whose summary
//                                got no answer from the email service, which
//                                is what lets a later refusal of its key count
//                                as sent (job.ts); and the goals the last one
//                                said were at their target, so each is told of
//                                once (content.ts GOALS). Encrypted, and never
//                                in the download: the key is credential
//                                material, and the week is the job's record.
//                                Backed up, so a restored copy doesn't send a
//                                week again; a restore that brings back an
//                                older key only means links in emails sent
//                                since stop working (the app turns it off too).
//   weekly-summary-sends         "Send me one now", counted in a day's window,
//                                so it never makes a burst of email.
//   weekly-summary-unsubscribes  the links that checked out, counted in an
//                                hour's window, so one link can't be hammered.
//
// Reads are strict: a setting that was saved but can't be used throws, never
// reads as off (which a save would then write over), and a state that can't be
// read stops the daily job from sending at all for that person, rather than
// risk a week twice. This module only declares the stores, so lib/stores.ts can
// load it without pulling in anything else.

import { defineCounterStore, defineValueStore } from '../repo';
import { isWeeklySetting, SENDS_NOW_PER_DAY, type WeeklySetting } from './settings';

export { SENDS_NOW_PER_DAY };

/** The bookkeeping kept with a person's summary (see the header). */
export type WeeklyState = {
  v: 1;
  /** The key the links to turn the summary off are signed with: 32 random
   *  bytes, base64url. Made the first time the summary is turned on, and made
   *  anew whenever it is turned on after being off, so a link from before
   *  never turns off a summary turned on since. */
  key: string;
  /** The day (YYYY-MM-DD, on the person's calendar) of the last week a
   *  summary went for, whether the daily job sent it or the person asked for
   *  it; null before the first. A week is known by the day its summary comes. */
  sent: string | null;
  /** When that summary was accepted by the email service, or null. */
  sent_at: string | null;
  /** A week (its send day) whose summary was sent and got no answer at all:
   *  it may have gone. Cleared once a week is recorded. Absent, or null, for
   *  none. */
  unanswered?: string | null;
  /** The goals, by id, the last summary that went said were at their target
   *  (or that were there when it went), so a goal is told of once. Absent
   *  before the first. */
  goals_told?: string[];
};

const STATE_KEYS: readonly string[] = ['v', 'key', 'sent', 'sent_at', 'unanswered', 'goals_told'];
/** Goals a person can have (lib/goal-model.ts MAX_GOALS), with room. */
const MAX_GOALS_TOLD = 100;
const KEY = /^[A-Za-z0-9_-]{43}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const isInstant = (v: unknown): v is string => typeof v === 'string' && v.length <= 64 && Number.isFinite(Date.parse(v));

/** The stored bookkeeping's shape, closed (see lib/repo.ts). */
export function isWeeklyState(v: unknown): v is WeeklyState {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
  const s = v as Record<string, unknown>;
  return (
    Object.keys(s).every((k) => STATE_KEYS.includes(k)) &&
    s.v === 1 &&
    typeof s.key === 'string' &&
    KEY.test(s.key) &&
    (s.sent === null || (typeof s.sent === 'string' && DAY.test(s.sent))) &&
    (s.sent_at === null || isInstant(s.sent_at)) &&
    (s.unanswered === undefined || s.unanswered === null || (typeof s.unanswered === 'string' && DAY.test(s.unanswered))) &&
    (s.goals_told === undefined ||
      (Array.isArray(s.goals_told) && s.goals_told.length <= MAX_GOALS_TOLD && s.goals_told.every((id) => typeof id === 'string' && id.length > 0 && id.length <= 40)))
  );
}

/** The window "Send me one now" is counted in (SENDS_NOW_PER_DAY, settings.ts). */
export const SENDS_NOW_WINDOW_SECONDS = 24 * 60 * 60;
/** Links that checked out, per container in an hour. */
export const UNSUBSCRIBES_PER_HOUR = 10;
export const UNSUBSCRIBE_WINDOW_SECONDS = 60 * 60;

export const weeklySettingStore = defineValueStore<WeeklySetting>('weekly-summary', {
  what: 'weekly summary settings',
  isValid: isWeeklySetting,
  exportable: true, // what the person chose
});

export const weeklyStateStore = defineValueStore<WeeklyState>('weekly-summary-state', {
  what: 'weekly summary records',
  isValid: isWeeklyState,
  exportable: false, // a signing key and the job's record, not the person's data
});

export const sendNowCount = defineCounterStore('weekly-summary-sends', {
  what: 'weekly summary send counts',
  windowSeconds: SENDS_NOW_WINDOW_SECONDS,
});

export const unsubscribeCount = defineCounterStore('weekly-summary-unsubscribes', {
  what: 'weekly summary unsubscribe counts',
  windowSeconds: UNSUBSCRIBE_WINDOW_SECONDS,
});
