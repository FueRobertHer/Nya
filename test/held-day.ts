// test/held-day.ts
//
// A day for tests whose rows have fixed dates in 2026. A day reads without its
// year only in its own year (formatDay in lib/format.ts), and windows read back
// from today, so on the real clock those tests say "Oct 5, 2026" from New Year
// on and lose rows as they age.

import { afterAll, beforeEach, setSystemTime } from 'bun:test';

export const HELD_DAY = new Date('2026-11-06T12:00:00.000Z');

/** Holds the clock on that day from where this is called to the file's end, so
 *  call it at a test file's top level, before anything reads the clock: what the
 *  file builds as it loads is on that day too. It doesn't move, so it isn't for
 *  tests that stamp things and compare them. A file on fakeClock passes HELD_DAY
 *  as `now` as well, since switching timers forgets this. */
export function holdDay(): void {
  setSystemTime(HELD_DAY);
  beforeEach(() => {
    setSystemTime(HELD_DAY);
  });
  afterAll(() => {
    setSystemTime();
  });
}
