import { describe, expect, test } from 'bun:test';
import { historyPausedSince } from '@/lib/history-status';

const r = (date: string) => ({ date });
const e = (date: string) => ({ date, estimated: true });

describe('historyPausedSince', () => {
  test('quiet while yesterday is the newest real day', () => {
    expect(historyPausedSince([r('2026-09-22'), r('2026-09-23')], '2026-09-24T09:00:00.000Z')).toBeNull();
  });

  test('names the last real day once two days have gone by', () => {
    expect(historyPausedSince([r('2026-08-31')], '2026-09-02T00:30:00.000Z')).toBe('2026-08-31');
  });

  // Estimates are not recordings: a trailing dashed stretch must not hide a stall.
  test('ignores estimated points after the last real one', () => {
    expect(historyPausedSince([r('2026-08-31'), e('2026-09-23')], '2026-09-24T09:00:00.000Z')).toBe('2026-08-31');
  });

  // An old localStorage snapshot carries its own as_of, so it is judged as of then.
  test('measures against as_of, not the clock', () => {
    expect(historyPausedSince([r('2020-01-01')], '2020-01-01T12:00:00.000Z')).toBeNull();
  });

  test('says nothing without a real point or an as_of', () => {
    expect(historyPausedSince([e('2026-09-01')], '2026-09-24T09:00:00.000Z')).toBeNull();
    expect(historyPausedSince([r('2026-08-31')], null)).toBeNull();
  });
});
