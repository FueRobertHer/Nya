import { describe, expect, test } from 'bun:test';
import { returnsRate, totalReturn, type RateLeg } from '@/lib/returns-rate';

// The rate of return Accounts > Investments gives (lib/returns-rate.ts):
// money-weighted over a range, each account a leg from its own first day,
// and given a year past a year.

const leg = (from: string, to: string, begin: number, end: number, flows: RateLeg['flows'] = []): RateLeg => ({ from, to, begin, end, flows });

describe('over a year or less', () => {
  test('with nothing in or out, the returns over the beginning balance', () => {
    expect(returnsRate([leg('2026-01-01', '2026-04-11', 100, 110)])).toEqual({ value: 0.1, annual: false });
  });

  // A deposit on Jan 5 is in the balance from Jan 6: invested for 5 of the
  // range's 10 days, so half of it counts.
  test('a deposit counts for the share of the range it was invested', () => {
    const r = returnsRate([leg('2026-01-01', '2026-01-11', 100, 210, [{ date: '2026-01-05', amount: 100 }])]);
    expect(r?.annual).toBe(false);
    expect(r?.value).toBeCloseTo(10 / 150, 10);
  });

  test('a withdrawal counts the same way, taken off', () => {
    const r = returnsRate([leg('2026-01-01', '2026-01-11', 200, 105, [{ date: '2026-01-05', amount: -100 }])]);
    expect(r?.value).toBeCloseTo(5 / 150, 10);
  });

  test('an account counted from a later day joins with its balance then', () => {
    const r = returnsRate([leg('2026-01-01', '2026-01-11', 100, 110), leg('2026-01-06', '2026-01-11', 100, 105)]);
    expect(r?.value).toBeCloseTo(15 / 150, 10);
  });

  test('one that stops early leaves with its balance on its last day', () => {
    const r = returnsRate([leg('2026-01-01', '2026-01-11', 100, 110), leg('2026-01-01', '2026-01-06', 100, 105)]);
    expect(r?.value).toBeCloseTo(15 / 147.5, 10);
  });

  test('the rate and the returns agree in sign', () => {
    expect(returnsRate([leg('2026-01-01', '2026-04-11', 100, 90)])!.value).toBeCloseTo(-0.1, 10);
  });
});

describe('past a year', () => {
  test('given a year, compounding', () => {
    const r = returnsRate([leg('2025-01-01', '2027-01-01', 100, 121)]);
    expect(r?.annual).toBe(true);
    expect(r?.value).toBeCloseTo(0.1, 8);
  });

  // $100 for two years and $100 for one, both at 10% a year: $121 + $110.
  test('each deposit grows from the day it is in', () => {
    const r = returnsRate([leg('2025-01-01', '2027-01-01', 100, 231, [{ date: '2025-12-31', amount: 100 }])]);
    expect(r?.value).toBeCloseTo(0.1, 8);
  });

  test('a loss past a year', () => {
    const r = returnsRate([leg('2025-01-01', '2027-01-01', 100, 81)]);
    expect(r?.value).toBeCloseTo(-0.1, 8);
  });
});

describe('no rate', () => {
  test('no accounts, or a range of no days', () => {
    expect(returnsRate([])).toBeNull();
    expect(returnsRate([leg('2026-01-01', '2026-01-01', 100, 110)])).toBeNull();
  });

  test('nothing invested to measure against', () => {
    expect(returnsRate([leg('2026-01-01', '2026-04-11', 0, 0)])).toBeNull();
    // Everything out on the first day.
    expect(returnsRate([leg('2026-01-01', '2026-01-11', 100, 0, [{ date: '2025-12-31', amount: -100 }])])).toBeNull();
  });
});

// For all time from typed totals, which say how much went in but not when.
describe('the total return', () => {
  test('the returns as a share of what was deposited, withdrawals not taken off', () => {
    expect(totalReturn(42_520.4, 154_000)).toEqual({ value: 42_520.4 / 154_000, deposited: 154_000 });
    // More came out than went in: still a share of what went in.
    expect(totalReturn(40_000, 50_000)?.value).toBe(0.8);
    expect(totalReturn(-500, 10_000)?.value).toBe(-0.05);
    // To the cent.
    expect(totalReturn(1, 1000.004)?.deposited).toBe(1000);
  });

  test('none with nothing deposited, a cent as good as nothing', () => {
    expect(totalReturn(100, 0)).toBeNull();
    expect(totalReturn(100, 0.005)).toBeNull();
    expect(totalReturn(100, -20)).toBeNull();
    expect(totalReturn(1, 0.01)).toEqual({ value: 100, deposited: 0.01 });
  });
});
