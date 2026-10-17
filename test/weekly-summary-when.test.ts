import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { DAILY_RUN_UTC_HOUR, RUN_TEXT, clockText, deliveryText, nextDelivery, sameClock } from '@/lib/weekly-summary/when';
import { dueSendDay, todayIn, weekdayOf } from '@/lib/weekly-summary/week';
import type { Weekday } from '@/lib/weekly-summary/settings';

// When a weekly summary comes, in the person's own time (lib/weekly-summary/
// when.ts): the hour the card and the sheet say is the hour the daily job's
// run falls at in the zone, and in every zone that run falls on the day
// chosen, so a summary is never a day late, east of UTC included. That the
// job sends it at that run, and its catch-up two hours later never sooner,
// with the record carried from run to run in every band of zones, is
// test/weekly-summary-job.test.ts ("through the daily job").

const crons = (JSON.parse(readFileSync(new URL('../vercel.json', import.meta.url), 'utf8')) as { crons: { path: string; schedule: string }[] }).crons;

describe('the daily run', () => {
  test('is the hour vercel.json runs the snapshot at, with the catch-up two hours later', () => {
    expect(crons.find((c) => c.path === '/api/snapshot')?.schedule).toBe(`0 ${DAILY_RUN_UTC_HOUR} * * *`);
    expect(crons.find((c) => c.path === '/api/snapshot/catchup')?.schedule).toBe(`0 ${DAILY_RUN_UTC_HOUR + 2} * * *`);
    expect(RUN_TEXT).toBe('1 p.m. UTC');
  });

  test('times of day as the card says them', () => {
    expect(clockText(9, 0)).toBe('9 a.m.');
    expect(clockText(18, 30)).toBe('6:30 p.m.');
    expect(clockText(0, 0)).toBe('midnight');
    expect(clockText(12, 0)).toBe('noon');
    expect(clockText(0, 45)).toBe('12:45 a.m.');
  });
});

describe('when a summary comes', () => {
  const OCT = Date.parse('2026-10-14T12:00:00.000Z');

  test('at the hour the run falls at in the zone, on the day chosen', () => {
    expect(deliveryText(1, 'America/New_York', OCT)).toBe('Mondays at about 9 a.m.');
    expect(deliveryText(1, 'Europe/London', OCT)).toBe('Mondays at about 2 p.m.');
    expect(deliveryText(1, 'Asia/Tokyo', OCT)).toBe('Mondays at about 10 p.m.');
    expect(deliveryText(1, 'Australia/Brisbane', OCT)).toBe('Mondays at about 11 p.m.');
    expect(deliveryText(1, 'Australia/Sydney', OCT)).toBe('Mondays just after midnight, as the day begins');
    expect(deliveryText(1, 'Pacific/Auckland', OCT)).toBe('Mondays at about 2 a.m.');
    expect(deliveryText(1, 'Pacific/Kiritimati', OCT)).toBe('Mondays at about 3 a.m.');
    expect(deliveryText(1, 'Asia/Kathmandu', OCT)).toBe('Mondays at about 6:45 p.m.');
    expect(deliveryText(1, 'Mars/Olympus_Mons', OCT)).toBeNull();
  });

  test('in every zone, on every day of the week, summer and winter: the run it comes with is on that day there, and the job finds it due then', () => {
    const zones = (Intl as unknown as { supportedValuesOf: (k: string) => string[] }).supportedValuesOf('timeZone');
    expect(zones.length).toBeGreaterThan(300);
    for (const now of [Date.parse('2026-01-14T12:00:00.000Z'), Date.parse('2026-07-15T12:00:00.000Z')]) {
      for (const zone of zones) {
        for (const weekday of [0, 1, 2, 3, 4, 5, 6] as Weekday[]) {
          const d = nextDelivery(weekday, zone, now);
          expect([zone, weekday, d !== null]).toEqual([zone, weekday, true]);
          // On the day chosen, there, within the next eight days.
          expect([zone, weekdayOf(d!.day)]).toEqual([zone, weekday]);
          expect(d!.at - now).toBeLessThan(8 * 86_400_000);
          // And at that run the job finds that day's summary due, on time.
          const today = todayIn(d!.at, zone)!;
          expect([zone, today]).toEqual([zone, d!.day]);
          expect([zone, dueSendDay(today, weekday, null, '2025-01-01')]).toEqual([zone, d!.day]);
        }
      }
    }
  });
});

describe('two zones the same for a summary', () => {
  const NOW = Date.parse('2026-10-14T12:00:00.000Z');
  test('when they keep the same clock every day of the coming year', () => {
    expect(sameClock('America/New_York', 'America/New_York', NOW)).toBe(true);
    expect(sameClock('Asia/Kolkata', 'Asia/Calcutta', NOW)).toBe(true);
    expect(sameClock('Europe/Kyiv', 'Europe/Kiev', NOW)).toBe(true);
    expect(sameClock('Europe/Paris', 'Europe/Berlin', NOW)).toBe(true);
    // Not when their clocks change on other days, or never meet.
    expect(sameClock('America/New_York', 'Europe/London', NOW)).toBe(false);
    expect(sameClock('Europe/London', 'Africa/Abidjan', NOW)).toBe(false);
    expect(sameClock('America/Phoenix', 'America/Denver', NOW)).toBe(false);
    expect(sameClock('Mars/Olympus_Mons', 'UTC', NOW)).toBe(false);
  });
});
