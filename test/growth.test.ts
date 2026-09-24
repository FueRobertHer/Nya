import { describe, expect, test } from 'bun:test';
import { contributionBaseline } from '@/lib/growth';

const r = (date: string, value: number) => ({ date, value });
const e = (date: string, value: number) => ({ date, value, estimated: true });

describe('contributionBaseline', () => {
  test('the starting balance plus money added since, per point', () => {
    const points = [r('2026-09-01', 1000), r('2026-09-02', 1010), r('2026-09-03', 1600), r('2026-09-04', 1650)];
    const flows = [{ date: '2026-09-03', amount: 500 }];
    expect(contributionBaseline(points, flows, '2026-01-01')).toEqual([
      r('2026-09-01', 1000),
      r('2026-09-02', 1000),
      r('2026-09-03', 1500),
      r('2026-09-04', 1500),
    ]);
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

  // Already in the starting balance, or it would be counted twice.
  test('a flow dated on the start day is not added again', () => {
    expect(contributionBaseline([r('2026-09-01', 1000), r('2026-09-02', 1000)], [{ date: '2026-09-01', amount: 500 }], '2026-01-01'))
      .toEqual([r('2026-09-01', 1000), r('2026-09-02', 1000)]);
  });

  test('withdrawals bring it down', () => {
    expect(contributionBaseline([r('2026-09-01', 1000), r('2026-09-02', 700)], [{ date: '2026-09-02', amount: -300 }], '2026-01-01'))
      .toEqual([r('2026-09-01', 1000), r('2026-09-02', 700)]);
  });

  test('nothing to draw without flows or without a real point in the window', () => {
    expect(contributionBaseline([r('2026-09-01', 1)], null, '2026-01-01')).toBeNull();
    expect(contributionBaseline([r('2026-09-01', 1)], [], undefined)).toBeNull();
    expect(contributionBaseline([e('2026-09-01', 1)], [], '2026-01-01')).toBeNull();
  });
});
