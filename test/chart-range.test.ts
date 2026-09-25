import { describe, expect, test } from 'bun:test';
import {
  availableRanges,
  axisTicks,
  initialRange,
  monthsBefore,
  rangeStart,
  sliceRange,
} from '@/lib/chart-range';

/** One point a day from `first` to `last` inclusive. */
function daily(first: string, last: string) {
  const out: { date: string; value: number }[] = [];
  for (let t = Date.parse(`${first}T00:00:00Z`); t <= Date.parse(`${last}T00:00:00Z`); t += 86_400_000) {
    out.push({ date: new Date(t).toISOString().slice(0, 10), value: out.length });
  }
  return out;
}

describe('range starts', () => {
  test('months back clamp to the end of a shorter month', () => {
    expect(monthsBefore('2026-03-31', 1)).toBe('2026-02-28');
    expect(monthsBefore('2028-03-31', 1)).toBe('2028-02-29');
    expect(monthsBefore('2026-01-15', 3)).toBe('2025-10-15');
  });

  test('YTD starts on January 1 of the last day', () => {
    expect(rangeStart('YTD', '2026-09-24')).toBe('2026-01-01');
    expect(rangeStart('1Y', '2026-09-24')).toBe('2025-09-24');
    expect(rangeStart('ALL', '2026-09-24')).toBeNull();
  });

  test('a range keeps the points on and after its start', () => {
    const shown = sliceRange(daily('2026-07-01', '2026-09-24'), '1M');
    expect(shown[0].date).toBe('2026-08-24');
    expect(shown[shown.length - 1].date).toBe('2026-09-24');
  });
});

describe('which ranges are offered', () => {
  // About 14 months of history, like the app has today.
  const points = daily('2025-08-03', '2026-09-24');

  test('balances get months, investments get years', () => {
    expect(availableRanges(points, 'balance')).toEqual(['1M', '3M', '6M', 'YTD', '1Y', 'ALL']);
    expect(availableRanges(points, 'investment')).toEqual(['1M', '3M', 'YTD', '1Y', 'ALL']);
  });

  // 3Y and 5Y would draw exactly what All draws.
  test('a range longer than the history is not offered', () => {
    // Starting in July, YTD would be All too.
    expect(availableRanges(daily('2026-07-12', '2026-09-24'), 'balance')).toEqual(['1M', 'ALL']);
  });

  test('a range with fewer than two points is not offered', () => {
    expect(availableRanges(daily('2025-06-01', '2026-01-01'), 'investment')).not.toContain('YTD');
  });

  test('too little history offers All alone', () => {
    expect(availableRanges([{ date: '2026-09-24' }], 'balance')).toEqual(['ALL']);
  });

  test('opens on the usual range, else the next longer one, else All', () => {
    expect(initialRange(['1M', '3M', '6M', 'YTD', '1Y', 'ALL'], 'balance')).toBe('6M');
    expect(initialRange(['1M', '3M', '1Y', 'ALL'], 'investment')).toBe('1Y'); // January: no YTD yet
    expect(initialRange(['1M', 'ALL'], 'balance')).toBe('ALL');
  });
});

describe('time axis labels', () => {
  test('a month is labelled by week, ending on the last day', () => {
    expect(axisTicks('2026-08-24', '2026-09-24').map((t) => t.label)).toEqual([
      'Aug 27',
      'Sep 3',
      'Sep 10',
      'Sep 17',
      'Sep 24',
    ]);
  });

  test('months are labelled by month, January as its year', () => {
    expect(axisTicks('2025-09-24', '2026-09-24').map((t) => t.label)).toEqual(['Oct', '2026', 'Apr', 'Jul']);
    expect(axisTicks('2026-03-24', '2026-09-24').map((t) => t.label)).toEqual(['May', 'Jul', 'Sep']);
  });

  test('years are labelled by year', () => {
    expect(axisTicks('2021-09-24', '2026-09-24').map((t) => t.label)).toEqual([
      '2022',
      '2023',
      '2024',
      '2025',
      '2026',
    ]);
  });

  test('never more than about five', () => {
    for (const first of ['2026-07-24', '2026-06-24', '2025-12-01', '2023-09-24', '2016-01-01']) {
      expect(axisTicks(first, '2026-09-24').length).toBeLessThanOrEqual(6);
    }
  });
});
