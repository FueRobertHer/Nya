import { describe, expect, test } from 'bun:test';
import { contributionBaseline } from '@/lib/growth';

const r = (date: string, value: number) => ({ date, value });
const e = (date: string, value: number) => ({ date, value, estimated: true });

describe('contributionBaseline', () => {
  // A flow counts from the day after its date: the 13:00 UTC snapshot on the
  // flow's own date is taken before investment balances update.
  test('the starting balance plus money added before each point', () => {
    const points = [r('2026-09-01', 1000), r('2026-09-02', 1010), r('2026-09-03', 1015), r('2026-09-04', 1600)];
    const flows = [{ date: '2026-09-03', amount: 500 }];
    expect(contributionBaseline(points, flows, '2026-01-01')).toEqual([
      r('2026-09-01', 1000),
      r('2026-09-02', 1000),
      r('2026-09-03', 1000),
      r('2026-09-04', 1500),
    ]);
  });

  // An account opened by a rollover: the first snapshot predates the money, so
  // assuming it was already in the starting balance would call it all growth.
  test('a flow dated on the start day is counted', () => {
    expect(contributionBaseline([r('2026-09-01', 0), r('2026-09-02', 60_000)], [{ date: '2026-09-01', amount: 60_000 }], '2026-01-01'))
      .toEqual([r('2026-09-01', 0), r('2026-09-02', 60_000)]);
  });

  test('flows before the start are already in the starting balance', () => {
    expect(contributionBaseline([r('2026-09-01', 1000), r('2026-09-02', 1000)], [{ date: '2026-08-20', amount: 500 }], '2026-01-01'))
      .toEqual([r('2026-09-01', 1000), r('2026-09-02', 1000)]);
  });

  // The backfilled region has no market movement in it: growth measured across
  // it would be whatever the walk left there.
  test('starts at the first real point, never in the estimated region', () => {
    const out = contributionBaseline([e('2026-08-01', 1), r('2026-09-01', 1000), r('2026-09-02', 1000)], [], '2026-01-01');
    expect(out?.[0]).toEqual(r('2026-09-01', 1000));
    expect(out).toHaveLength(2);
  });

  // Flows before the window start are unknown, so the start must be inside it.
  test('starts inside the flows window', () => {
    const out = contributionBaseline([r('2025-01-01', 5), r('2026-09-01', 1000)], [], '2025-09-24');
    expect(out).toEqual([r('2026-09-01', 1000)]);
  });

  test('withdrawals bring it down', () => {
    expect(
      contributionBaseline([r('2026-09-01', 1000), r('2026-09-02', 1000), r('2026-09-03', 700)], [{ date: '2026-09-02', amount: -300 }], '2026-01-01')
    ).toEqual([r('2026-09-01', 1000), r('2026-09-02', 1000), r('2026-09-03', 700)]);
  });

  test('nothing to draw without flows, a window, or a real point in it', () => {
    expect(contributionBaseline([r('2026-09-01', 1)], null, '2026-01-01')).toBeNull();
    expect(contributionBaseline([r('2026-09-01', 1)], [], null)).toBeNull();
    expect(contributionBaseline([e('2026-09-01', 1)], [], '2026-01-01')).toBeNull();
  });
});

describe('contributionBaseline start day', () => {
  // A flow two days before the first recorded day may or may not be in that
  // day's balance. Starting after a quiet spell avoids guessing.
  test('skips a first day whose balance may not include a recent flow', () => {
    const points = [r('2026-09-01', 1000), r('2026-09-02', 1500), r('2026-09-05', 1500), r('2026-09-06', 1510)];
    const out = contributionBaseline(points, [{ date: '2026-08-30', amount: 500 }], '2026-01-01');
    expect(out?.[0]).toEqual(r('2026-09-05', 1500));
  });

  // Nothing better available: the first real point it is.
  test('falls back to the first real point when every candidate has a recent flow', () => {
    const points = [r('2026-09-01', 1000), r('2026-09-02', 1100)];
    const flows = [{ date: '2026-08-31', amount: 100 }, { date: '2026-09-01', amount: 100 }];
    expect(contributionBaseline(points, flows, '2026-01-01')?.[0]).toEqual(r('2026-09-01', 1000));
  });
});
