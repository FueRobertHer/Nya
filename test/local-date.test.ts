import { describe, expect, test } from 'bun:test';
import { instantDay, localDate, localMonth } from '@/lib/local-date';
import { upcomingBills, type RecurringBill } from '@/lib/recurring';

// "Today" and "this month" are the viewer's, not UTC's. Every Date below is built
// from local components, so these hold in whatever zone the tests run in.

describe('the viewer\'s own day and month', () => {
  test('a late evening is still that day, whatever UTC says', () => {
    expect(localDate(new Date(2026, 8, 28, 22, 30))).toBe('2026-09-28');
    expect(localDate(new Date(2026, 8, 28, 0, 5))).toBe('2026-09-28');
  });

  test('the last evening of a month is still that month', () => {
    expect(localMonth(new Date(2026, 8, 30, 23, 45))).toBe('2026-09');
    expect(localMonth(new Date(2026, 0, 1, 0, 10))).toBe('2026-01');
  });

  test('pads single digits', () => {
    expect(localDate(new Date(2026, 0, 5, 12))).toBe('2026-01-05');
  });
});

describe('the local day of an instant', () => {
  const at = '2026-09-29T03:19:00.000Z';

  test('is the day it was where the viewer is, not the UTC day', () => {
    // 03:19 UTC on the 29th is still the evening of the 28th in California...
    expect(instantDay(at, 'America/Los_Angeles')).toBe('Sep 28');
    expect(instantDay(at, 'Pacific/Pago_Pago')).toBe('Sep 28');
    // ...already the 29th in London and Auckland.
    expect(instantDay(at, 'Europe/London')).toBe('Sep 29');
    expect(instantDay(at, 'Pacific/Auckland')).toBe('Sep 29');
  });

  test('with no zone given, follows the machine it runs on', () => {
    expect(instantDay(at)).toBe(new Date(at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }));
  });

  test('is null for something that is not a time', () => {
    expect(instantDay('not a date')).toBeNull();
  });
});

describe('upcoming bills', () => {
  const bill = (name: string, nextDate: string) => ({ name, nextDate }) as unknown as RecurringBill;
  const bills = [bill('yesterday', '2026-09-27'), bill('today', '2026-09-28'), bill('in a week', '2026-10-05'), bill('later', '2026-10-06')];

  test('are counted from the day it is where the viewer is', () => {
    expect(upcomingBills(bills, 7, '2026-09-28').map((b) => b.name)).toEqual(['today', 'in a week']);
    expect(upcomingBills(bills, 7, '2026-09-27').map((b) => b.name)).toEqual(['yesterday', 'today']);
  });
});
