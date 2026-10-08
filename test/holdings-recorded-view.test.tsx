import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { HoldingsRecordedLine } from '@/components/HoldingsRecorded';

// The line under an investment account's chart that says since when its
// holdings have been kept. It must never claim they are still being recorded
// once recording has stopped.

const line = (first_recorded: string | null, last_recorded: string | null, today = '2026-10-08') =>
  renderToStaticMarkup(<HoldingsRecordedLine span={{ first_recorded, last_recorded }} today={today} />);
const day = (iso: string) => new Date(`${iso}T00:00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });

describe('HoldingsRecordedLine', () => {
  test('says since when, while recording is current', () => {
    expect(line('2026-09-12', '2026-10-08')).toBe(`<p class="as-of">Holdings recorded daily since ${day('2026-09-12')}.</p>`);
    // Before today's snapshot has run, yesterday's record is current.
    expect(line('2026-09-12', '2026-10-07')).toContain('since');
  });

  test('says when it stopped, once it has', () => {
    expect(line('2026-09-12', '2026-10-06')).toBe(
      `<p class="as-of">Holdings recorded daily from ${day('2026-09-12')} to ${day('2026-10-06')}.</p>`
    );
    // Across a month and a year.
    expect(line('2025-12-01', '2025-12-31', '2026-01-02')).toContain(`to ${day('2025-12-31')}`);
    expect(line('2025-12-01', '2025-12-31', '2026-01-01')).toContain('since');
  });

  test('says so when nothing has been recorded', () => {
    expect(line(null, null)).toBe('<p class="as-of">No holdings recorded for this account yet.</p>');
  });

  test('shows the day recorded, wherever the viewer is', () => {
    // A recorded UTC day is a calendar date: read as a UTC instant it would
    // show as August 31 in Los Angeles.
    const tz = process.env.TZ;
    try {
      for (const zone of ['America/Los_Angeles', 'Pacific/Auckland', 'UTC']) {
        process.env.TZ = zone;
        expect([zone, line('2026-09-01', '2026-10-08')]).toEqual([zone, '<p class="as-of">Holdings recorded daily since Sep 1, 2026.</p>']);
      }
    } finally {
      if (tz === undefined) delete process.env.TZ;
      else process.env.TZ = tz;
    }
  });
});
