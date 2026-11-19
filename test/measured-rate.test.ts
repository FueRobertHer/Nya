import { describe, expect, test } from 'bun:test';
import { afterInflation, measuredRate } from '@/lib/fire/measured-rate';
import { ACTIVITY_STILL_LOADING, type GrowthActivity } from '@/lib/growth-summary';
import type { BalancePoint, Flow } from '@/lib/growth';

const DAY = 86_400_000;
const day = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);

/** A balance on the 1st of each month from `from` to `to`, growing `yearly`
 *  a year, and `deposit` put in the day before each 1st after the first. */
function history(from: string, to: string, yearly: number, deposit = 0): { points: BalancePoint[]; flows: Flow[] } {
  const points: BalancePoint[] = [];
  const flows: Flow[] = [];
  let value = 100_000;
  for (let d = from; d <= to; ) {
    points.push({ date: d, value: Math.round(value * 100) / 100 });
    const [y, m] = d.split('-').map(Number);
    const next = `${m === 12 ? y + 1 : y}-${String(m === 12 ? 1 : m + 1).padStart(2, '0')}-01`;
    const days = (Date.parse(`${next}T00:00:00Z`) - Date.parse(`${d}T00:00:00Z`)) / DAY;
    value = value * (1 + yearly) ** (days / 365) + deposit;
    if (deposit > 0 && next <= to) flows.push({ date: day(next, -1), amount: deposit });
    d = next;
  }
  return { points, flows };
}

const activity = (flows: Flow[], from: string, to: string, over: Partial<GrowthActivity> = {}): GrowthActivity => ({ flows, flows_from: from, flows_to: to, note: null, txns: [], ...over });

describe('an account’s own rate of return', () => {
  test('the longest range it offers, as Investments counts it: 5Y, a year’s rate, from its start', () => {
    const { points, flows } = history('2020-06-01', '2026-11-01', 0.091);
    const r = measuredRate(points, activity(flows, '2020-06-01', '2026-11-01'), null);
    expect(r.kind).toBe('rate');
    if (r.kind !== 'rate') return;
    expect(r.rate).toBeCloseTo(0.091, 3);
    expect(r.since).toBe('2021-11-01');
    expect(r.to).toBe('2026-11-01');
  });

  test('money put in is not a return: deposits each month still read the rate it grew at', () => {
    const { points, flows } = history('2020-06-01', '2026-11-01', 0.07, 1_000);
    const r = measuredRate(points, activity(flows, '2020-06-01', '2026-11-01'), null);
    expect(r.kind === 'rate' && r.rate).toBeCloseTo(0.07, 2);
  });

  test('3Y when that is the longest, and activity that starts later in it counts from then', () => {
    const { points, flows } = history('2022-06-01', '2026-11-01', 0.05);
    expect(measuredRate(points, activity(flows, '2022-06-01', '2026-11-01'), null)).toMatchObject({ kind: 'rate', since: '2023-11-01' });
    const late = measuredRate(points, activity(flows, '2024-03-01', '2026-11-01'), null);
    expect(late).toMatchObject({ kind: 'rate', since: '2024-03-01' });
    expect(late.kind === 'rate' && late.rate).toBeCloseTo(0.05, 3);
  });

  test('1Y is a year’s return only when it is counted from the range’s start', () => {
    const { points, flows } = history('2025-09-01', '2026-11-01', 0.091);
    const full = measuredRate(points, activity(flows, '2025-09-01', '2026-11-01'), null);
    expect(full).toMatchObject({ kind: 'rate', since: '2025-11-01' });
    expect(full.kind === 'rate' && full.rate).toBeCloseTo(0.091, 3);
    // Its activity starts 300 days into the year: a part year's return, not given.
    expect(measuredRate(points, activity(flows, day('2025-11-01', 300), '2026-11-01'), null)).toEqual({ kind: 'none' });
  });

  test('a year’s rate only: activity that ends before its last day, or counts under a year of a longer range, has none', () => {
    const year = history('2025-09-01', '2026-11-01', 0.091);
    expect(measuredRate(year.points, activity(year.flows, '2025-09-01', '2026-11-01'), null).kind).toBe('rate');
    // Its activity stops 3 days before the last balance: not the whole year.
    expect(measuredRate(year.points, activity(year.flows, '2025-09-01', day('2026-11-01', -3)), null)).toEqual({ kind: 'none' });
    // 3Y is offered, but its activity covers the last 300 days only: a part
    // year's return, under 3Y and 1Y alike.
    const three = history('2022-06-01', '2026-11-01', 0.05);
    expect(measuredRate(three.points, activity(three.flows, day('2026-11-01', -300), '2026-11-01'), null)).toEqual({ kind: 'none' });
  });

  test('under a year of history, or no investment activity, has none', () => {
    const { points, flows } = history('2026-02-01', '2026-11-01', 0.091);
    expect(measuredRate(points, activity(flows, '2026-02-01', '2026-11-01'), null)).toEqual({ kind: 'none' });
    const long = history('2020-06-01', '2026-11-01', 0.091).points;
    expect(measuredRate(long, { flows: null, flows_from: null, note: null, txns: [] }, null)).toEqual({ kind: 'none' });
    expect(measuredRate([], activity([], '2020-06-01', '2026-11-01'), null)).toEqual({ kind: 'none' });
  });

  test('activity that couldn’t be read, or is still being fetched, is said apart from none', () => {
    const { points } = history('2020-06-01', '2026-11-01', 0.091);
    expect(measuredRate(points, { flows: null, note: 'Investment activity could not be loaded', txns: [] }, null)).toEqual({ kind: 'failed' });
    expect(measuredRate(points, { flows: null, note: `${ACTIVITY_STILL_LOADING}.`, txns: [] }, null)).toEqual({ kind: 'busy' });
  });

  test('after inflation as the plan’s rates are', () => {
    expect(afterInflation(0.091, 0.03)).toBeCloseTo(1.091 / 1.03 - 1, 12);
    expect(afterInflation(0.03, 0.03)).toBe(0);
  });
});
